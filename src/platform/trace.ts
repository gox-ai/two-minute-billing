import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * Per-execution trace context — the thing that stitches every log line of one
 * execution together across the API, the durable job queue, and the migration
 * importer. A traceId minted upstream can be handed to tmbilling and both
 * services' logs line up under one id.
 *
 * Deliberately SEPARATE from `event-context.ts`, which answers "who did this"
 * (source/actor). This answers "which execution was this", and must also survive
 * a trip through the job queue (see `stampTracePayload`). Both are established at
 * the same boundaries.
 *
 * Trace = one execution: an API request, a clock tick, a webhook, an import.
 * Span = one unit inside it: an invoice collection, a payment-intent attempt.
 * A unit mints a span, never a new trace, so trace-wide lookups keep seeing it.
 * Both are stamped on the rows that link to gateway calls (`gateway_request_logs`,
 * `transactions`, `payment_attempts`); the trace alone on events, audit and request logs.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TRACE_ID_LENGTH = 21;

/**
 * A unique, URL-safe, purely alphanumeric trace id: a short prefix naming the
 * originating surface + 21 base62 chars (~125 bits, collision-safe), from
 * crypto-strong bytes. The prefix means a glance at a log line says where the id
 * was minted (`trace-` = generic/fallback, `api-`, `job-`, `mig-`).
 *
 * Bitmask + rejection sampling (the nanoid approach): each byte is masked to 6
 * bits and the two out-of-range values are skipped, so every symbol is equally
 * likely — `byte % 62` would bias the first two symbols.
 */
export function newTraceId(prefix = "trace"): string {
  let id = "";
  while (id.length < TRACE_ID_LENGTH) {
    const bytes = randomBytes(TRACE_ID_LENGTH);
    for (let i = 0; i < bytes.length && id.length < TRACE_ID_LENGTH; i++) {
      const v = bytes[i]! & 63;
      if (v < 62) id += BASE62[v];
    }
  }
  return `${prefix}-${id}`;
}

export interface TraceContext {
  /** Correlates every log line of one execution. Never empty inside a context. */
  traceId: string;
  /**
   * True when the traceId arrived from the caller rather than being minted here
   * — i.e. this execution is a continuation of an upstream trace.
   * Logged so a cross-service trace is distinguishable from a local one.
   */
  inherited?: boolean;
  /**
   * One unit of work inside the trace (`withSpan`). A billing-clock tick charges many
   * invoices under one trace; the span tells one invoice's gateway calls from the rest.
   */
  spanId?: string;
  /** Filled in once auth resolves them; hugely useful on a multi-tenant log line. */
  organizationId?: string | null;
  businessId?: string | null;
}

const storage = new AsyncLocalStorage<TraceContext>();

/**
 * Run `fn` inside a trace context. Everything executed synchronously or
 * asynchronously within `fn` reads the same traceId. Wrap entry points: API
 * requests, job processors, importer runs, scripts.
 *
 * A missing traceId must never become a silent `undefined`, so one is minted
 * when the caller doesn't supply it.
 */
export function withTraceContext<T>(
  ctx: Partial<TraceContext> & { traceId?: string },
  fn: () => T,
): T {
  return storage.run({ ...ctx, traceId: ctx.traceId || newTraceId() }, fn);
}

/**
 * Bind a trace context for the remainder of the current async execution, with no
 * wrapping callback (a one-liner at the top of an entry function).
 *
 * ⚠️ Prefer `withTraceContext` at request boundaries: `enterWith` does not
 * reliably reach a Fastify route handler from a preHandler — the same reason
 * `eventContextHook` uses `run(store, done)`.
 */
export function enterTraceContext(ctx: Partial<TraceContext> & { traceId?: string }): TraceContext {
  const full: TraceContext = { ...ctx, traceId: ctx.traceId || newTraceId() };
  storage.enterWith(full);
  return full;
}

/**
 * The context for one unit of work: the active trace (org/business carry over), or a
 * fresh one outside any, with `spanId` as its span. Pass it to `withTraceContext`.
 */
export function spanContext(spanId: string = newTraceId("span")): TraceContext {
  const parent = storage.getStore();
  return { ...parent, traceId: parent?.traceId ?? newTraceId(), spanId };
}

/** Run `fn` as a new span of the active trace (see `spanContext`). */
export function withSpan<T>(fn: () => T): T {
  return storage.run(spanContext(), fn);
}

/** `withSpan` unless a span is already active: a refund inside a collection stays in it. */
export function ensureSpan<T>(fn: () => T): T {
  return storage.getStore()?.spanId ? fn() : withSpan(fn);
}

/**
 * Run a later call on an existing record inside that record's span (a status check on a
 * pending charge joins the charge), under the active trace. A fresh span when it has none.
 */
export function joinSpan<T>(spanId: string | null | undefined, fn: () => T): T {
  return storage.run(spanContext(spanId ?? undefined), fn);
}

/** The active span id, or undefined outside a span. */
export function getSpanId(): string | undefined {
  return storage.getStore()?.spanId;
}

/** The active trace context, or undefined outside any. */
export function getTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

/** The active traceId, or undefined outside any trace context. */
export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

/**
 * Patch the active context in place (same store reference) — used to fill in the
 * org/business once authentication resolves them, after the request-scoped store
 * was established at onRequest. Mirrors `updateEventContext`. No-op outside a context.
 */
export function updateTraceContext(patch: Partial<TraceContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

// ── Inbound propagation (cross-service) ──────────────────────────────────────

/**
 * A trace id we're willing to adopt from a caller. Deliberately strict: the id
 * lands in log lines (and is echoed back in a response header), so an untrusted
 * header must not be able to inject newlines, spaces, control characters or
 * unbounded length into the logs. Alphanumeric + `-`/`_`, 8..128 chars — which
 * accepts both our own `prefix-base62` ids and a bare W3C trace-id hex string.
 */
const SAFE_TRACE_ID = /^[A-Za-z0-9_-]{8,128}$/;

export function isValidTraceId(value: unknown): value is string {
  return typeof value === "string" && SAFE_TRACE_ID.test(value);
}

/**
 * Resolve an inbound trace id from request headers, so one execution spanning
 * an upstream service → tmbilling shares an id. Checked in order:
 *   1. `x-trace-id`   — our own convention
 *   2. `x-request-id` — common proxy/ingress convention
 *   3. `traceparent`  — W3C Trace Context; the 32-hex trace-id field is extracted
 *
 * Returns null when nothing usable is present (caller mints a fresh id).
 * A malformed or oversized value is IGNORED rather than sanitized — quietly
 * accepting half of a bad header would produce ids that don't correlate anyway.
 */
export function traceIdFromHeaders(headers: Record<string, unknown> | undefined): string | null {
  if (!headers) return null;
  const pick = (name: string): string | null => {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return isValidTraceId(value) ? value : null;
  };
  const direct = pick("x-trace-id") ?? pick("x-request-id");
  if (direct) return direct;
  // traceparent: version-traceid-spanid-flags, e.g.
  // 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
  const rawTp = headers["traceparent"];
  const tp = Array.isArray(rawTp) ? rawTp[0] : rawTp;
  if (typeof tp === "string") {
    const traceId = tp.split("-")[1];
    // Reject the all-zero trace-id the spec defines as invalid.
    if (traceId && /^[0-9a-f]{32}$/.test(traceId) && !/^0{32}$/.test(traceId)) return traceId;
  }
  return null;
}

// ── Job-queue propagation ────────────────────────────────────────────────────

/** The key `stampTracePayload` writes and `traceContextFromPayload` reads. */
const TRACE_KEY = "_trace";

/**
 * Stamp the active traceId onto a job payload so the trace spine survives the
 * durable queue (the payload is JSON in Postgres — the ALS context cannot cross
 * that boundary). Returns the payload to keep call sites one-liners.
 *
 * No-op when there is no active trace or the payload isn't a plain object.
 */
export function stampTracePayload<T>(payload: T): T {
  const traceId = getTraceId();
  if (!traceId || payload == null || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const target = payload as Record<string, unknown>;
  const existing = (target[TRACE_KEY] ?? {}) as Record<string, unknown>;
  target[TRACE_KEY] = { ...existing, traceId };
  return payload;
}

/**
 * Resolve a job's trace context: the stamped traceId when the enqueuer had one,
 * otherwise a fresh `job-` id. A job that lost its trace is flagged `inherited:
 * false` so a propagation gap is visible in the logs rather than silent.
 */
export function traceContextFromPayload(payload: unknown): TraceContext {
  const stamped =
    payload && typeof payload === "object"
      ? ((payload as Record<string, unknown>)[TRACE_KEY] as { traceId?: unknown } | undefined)
      : undefined;
  const traceId = isValidTraceId(stamped?.traceId) ? stamped.traceId : null;
  return traceId ? { traceId, inherited: true } : { traceId: newTraceId("job"), inherited: false };
}
