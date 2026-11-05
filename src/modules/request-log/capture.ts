import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { uuidv7 } from "@/platform/ids";
import { pushRequestLog } from "./flush";

/**
 * Request-log capture: Fastify hooks plus the setters that auth, idempotency and business
 * resolution call. Every hook copies references and returns; parsing and redaction happen
 * in the flusher. Nothing here may throw into a request or change its reply.
 */

export type IdempotencyOutcome = "new" | "replayed" | "mismatch" | "in_progress" | "missing";

interface RequestLogSlot {
  id: string;
  startedAt: Date;
  organizationId?: string;
  source?: "api" | "dashboard";
  apiKeyId?: string | null;
  memberUserId?: string | null;
  keyMode?: string;
  businessId?: string;
  livemode?: string;
  idempotencyOutcome?: IdempotencyOutcome;
  /** Set at onSend: the stored form of the response (string, marker, or null). */
  response?: unknown;
  responseBytes?: number;
  errorType?: string | null;
  /** The client closed the connection before the reply. */
  aborted?: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    requestLog?: RequestLogSlot;
  }
  interface FastifyContextConfig {
    /**
     * Request-log treatment of this route:
     * - `off`: never logged (the request log's own reads);
     * - `meta`: logged, bodies kept only when the status is 400 or higher (bulk ingestion);
     * - `no_response`: the response carries a one-time secret and is never stored
     *   (`idempotentNoStore` routes are treated the same way).
     */
    requestLog?: "off" | "meta" | "no_response";
  }
}

/** `req_` + the uuid's 32 hex digits. */
export function publicRequestId(id: string): string {
  return `req_${id.replace(/-/g, "")}`;
}

/** `req_<32 hex>` → uuid, or null when it is not one. */
export function requestIdToUuid(publicId: string): string | null {
  const m = /^req_([0-9a-f]{32})$/i.exec(publicId);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Credential resolved: from here on the request belongs to an organization and is loggable. */
export function noteRequestLogAuth(
  req: FastifyRequest,
  a: {
    organizationId: string;
    source: "api" | "dashboard";
    apiKeyId: string | null;
    memberUserId: string | null;
    keyMode: string;
  },
): void {
  const slot = req.requestLog;
  if (!slot) return;
  slot.organizationId = a.organizationId;
  slot.source = a.source;
  slot.apiKeyId = a.apiKeyId;
  slot.memberUserId = a.memberUserId;
  slot.keyMode = a.keyMode;
}

export function noteRequestLogBusiness(
  req: FastifyRequest,
  b: { id: string; livemode: string },
): void {
  const slot = req.requestLog;
  if (!slot) return;
  slot.businessId = b.id;
  slot.livemode = b.livemode;
}

export function noteIdempotencyOutcome(req: FastifyRequest, outcome: IdempotencyOutcome): void {
  if (req.requestLog) req.requestLog.idempotencyOutcome = outcome;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_HELD_REQUEST = 256 * 1024;
const MAX_HELD_RESPONSE = 64 * 1024;

type KindOf = (method: string, route: string) => "read" | "write";
let kindOf: KindOf = (method) => (SAFE_METHODS.has(method) ? "read" : "write");

/** Whether this request is logged, once its credential is known. */
function loggable(req: FastifyRequest): "read" | "write" | null {
  const slot = req.requestLog;
  if (!slot?.organizationId) return null;
  const route = req.routeOptions?.url;
  if (!route || !route.startsWith("/v1/") || req.method === "OPTIONS") return null;
  if (req.routeOptions.config?.requestLog === "off") return null;
  const kind = kindOf(req.method, route);
  // Dashboard page loads are not integration traffic; its writes are.
  if (slot.source === "dashboard" && kind === "read") return null;
  return kind;
}

const ERROR_TYPE_RE = /"error"\s*:\s*\{[^{}]*?"type"\s*:\s*"([A-Za-z0-9_.-]{1,100})"/;

function captureResponse(req: FastifyRequest, reply: FastifyReply, payload: unknown): void {
  const kind = loggable(req);
  if (!kind) return;
  const slot = req.requestLog!;
  const config = req.routeOptions.config;
  const status = reply.statusCode;
  const text = typeof payload === "string" ? payload : null;
  if (status >= 400 && text) slot.errorType = ERROR_TYPE_RE.exec(text.slice(0, 1_024))?.[1] ?? null;

  if (config?.idempotencyNoStore === true || config?.requestLog === "no_response") {
    slot.response = { _omitted: "secret" };
    return;
  }
  if (config?.requestLog === "meta" && status < 400) {
    slot.response = { _omitted: "body" };
    return;
  }
  // Read responses are kept only when they fail: lists of customers are PII we do not copy.
  if (kind === "read" && status < 400) return;
  if (payload == null) return;
  if (text !== null) {
    if (text.length > MAX_HELD_RESPONSE) {
      slot.response = { _omitted: "too_large", bytes: Buffer.byteLength(text) };
      return;
    }
    slot.response = text;
    slot.responseBytes = text.length;
    return;
  }
  const type = String(reply.getHeader("content-type") ?? "unknown").split(";")[0];
  const bytes = Buffer.isBuffer(payload) ? payload.length : null;
  slot.response = { _omitted: "content_type", type, ...(bytes != null ? { bytes } : {}) };
}

function requestBody(req: FastifyRequest, meta: boolean): { body: unknown; bytes: number } {
  if (SAFE_METHODS.has(req.method)) return { body: null, bytes: 0 };
  const length = Number(req.headers["content-length"] ?? 0) || 0;
  if (req.body === undefined || req.body === null) return { body: null, bytes: 0 };
  if (meta) return { body: { _omitted: "body" }, bytes: 0 };
  if (length > MAX_HELD_REQUEST)
    return { body: { _omitted: "too_large", bytes: length }, bytes: 0 };
  const type = String(req.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim();
  if (!/json/i.test(type))
    return { body: { _omitted: "content_type", type: type || "unknown", bytes: length }, bytes: 0 };
  return { body: req.body, bytes: length };
}

function header(req: FastifyRequest, name: string, max: number): string | null {
  const v = req.headers[name];
  return typeof v === "string" && v.length ? v.slice(0, max) : null;
}

function captureRequest(req: FastifyRequest, reply: FastifyReply): void {
  const kind = loggable(req);
  if (!kind) return;
  const slot = req.requestLog!;
  const status = slot.aborted ? null : reply.statusCode;
  const meta = req.routeOptions.config?.requestLog === "meta" && (status ?? 0) < 400;
  const { body, bytes } = requestBody(req, meta);
  const [path, query] = splitUrl(req.url);
  const params = (req.params ?? {}) as Record<string, unknown>;
  const q = (req.query ?? {}) as Record<string, unknown>;
  const customer =
    typeof params.cus === "string"
      ? params.cus
      : typeof q.customer === "string" && q.customer.length <= 50
        ? q.customer
        : null;
  const keyMode = slot.keyMode === "test" || slot.keyMode === "live" ? slot.keyMode : null;
  const trace = reply.getHeader("x-trace-id");
  pushRequestLog({
    id: slot.id,
    startedAt: slot.startedAt,
    organizationId: slot.organizationId!,
    businessId: slot.businessId ?? null,
    livemode: slot.livemode ?? keyMode,
    source: slot.source ?? "api",
    apiKeyId: slot.apiKeyId ?? null,
    memberUserId: slot.memberUserId ?? null,
    method: req.method,
    path,
    route: req.routeOptions.url ?? null,
    query,
    kind,
    status,
    durationMs: Math.round(reply.elapsedTime),
    idempotencyKey: kind === "write" ? header(req, "idempotency-key", 255) : null,
    idempotencyOutcome: slot.idempotencyOutcome ?? null,
    errorType: slot.errorType ?? null,
    traceId: typeof trace === "string" ? trace.slice(0, 200) : null,
    customerId: customer,
    ip: req.ip ?? null,
    userAgent: header(req, "user-agent", 256),
    requestBody: body,
    responseBody: slot.response ?? null,
    bytes: bytes + (slot.responseBytes ?? 0) + 512,
  });
}

function splitUrl(url: string): [string, string | null] {
  const i = url.indexOf("?");
  return i < 0 ? [url, null] : [url.slice(0, i), url.slice(i + 1) || null];
}

/**
 * Install the hooks. `kind` is the read/write rule the read scope uses (`platform/auth.ts`),
 * passed in so this module does not import auth.
 */
export function registerRequestLog(app: FastifyInstance, opts: { kindOf?: KindOf } = {}): void {
  if (opts.kindOf) kindOf = opts.kindOf;
  app.addHook("onRequest", (req, reply, done) => {
    try {
      const id = uuidv7();
      req.requestLog = { id, startedAt: new Date() };
      reply.header("Request-Id", publicRequestId(id));
    } catch {
      /* the request goes on unlogged */
    }
    done();
  });
  app.addHook("onSend", (req, reply, payload, done) => {
    try {
      captureResponse(req, reply, payload);
    } catch {
      /* never changes the reply */
    }
    done(null, payload);
  });
  app.addHook("onRequestAbort", (req, done) => {
    if (req.requestLog) req.requestLog.aborted = true;
    done();
  });
  app.addHook("onResponse", (req, reply, done) => {
    try {
      captureRequest(req, reply);
    } catch {
      /* never fails the request */
    }
    done();
  });
}
