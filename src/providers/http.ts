/**
 * Outbound gateway-activity capture ("Gateway Activity", LOG-1 stage 2). Every
 * adapter routes its HTTP calls through `providerFetch` so a redacted
 * request/response row lands in `gateway_request_logs` (db/schema/gateway.ts) —
 * regardless of outcome, and without ever blocking or failing the payment path
 * (the insert is fire-and-forget).
 */
import { createHash } from "node:crypto";
import { systemDb } from "@/platform/db";
import { gatewayRequestLogs } from "@db/schema";
import { currentGatewayLogContext } from "./log-context";
import { currentEventContext } from "@/platform/event-context";
import { createLogger } from "@/platform/logger";
import { getSpanId, getTraceId } from "@/platform/trace";

const log = createLogger("providers");

/**
 * Fit our idempotency key into a gateway's length cap for the merchant-supplied
 * reference it echoes back.
 *
 * Both caps we have hit are UNDOCUMENTED and sit below the engine's key length
 * (`collectInvoice` builds `inv_<invoice>_attempt_<n>_<pm>`, ~69 chars):
 *   - RazorPay `receipt`          → 40; 400 "receipt: the length must be no more than 40"
 *   - PayPal `PayPal-Request-Id`  → 65; 422 UNPROCESSABLE_ENTITY with no detail at all
 *     (PayPal's docs claim 108 — measured live 2026-07-27: 65 passes, 66 fails)
 *
 * Passing the raw key therefore broke EVERY engine-driven charge on those gateways,
 * while the short hand-made keys in adapter-level tests sailed through — the bug
 * lived exactly in the gap between an adapter test and the engine. Assume the next
 * gateway has its own silent cap; route its reference through here too.
 *
 * Short keys pass unchanged (so they stay readable in the gateway's dashboard);
 * longer ones are deterministically compressed, so the same attempt always maps to
 * the same reference and retries still dedupe on it.
 */
export function boundedProviderKey(idempotencyKey: string, maxLen: number): string {
  if (idempotencyKey.length <= maxLen) return idempotencyKey;
  const hex = createHash("sha256").update(idempotencyKey).digest("hex");
  return `tm_${hex.slice(0, Math.max(8, Math.min(36, maxLen - 3)))}`;
}

const SECRET_KEY_RE = /authorization|api-key|signature|secret|cookie/i;
const SECRET_BODY_KEY_RE = /number|cvv|cvc|secret|password|token|key|account/i;
const MAX_STORED_CHARS = 16 * 1024;

function truncate(s: string): string {
  return s.length > MAX_STORED_CHARS ? s.slice(0, MAX_STORED_CHARS) : s;
}

/** Redact sensitive header values (auth/signature/cookie/etc). Non-secret values are stringified. */
export function redactHeaders(h: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SECRET_KEY_RE.test(k) ? "****" : String(v);
  }
  return out;
}

/**
 * A plain object — something whose every leaf still has a KEY to be judged by. An ARRAY is
 * deliberately not one: its elements are positional, so a secret string sitting in
 * `keys: ['sk_live_…']` would walk straight through the recursion with no key to catch it.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep-walk mask any value whose KEY matches the secret-body regex. Preserves structure. */
function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // ── A STRUCTURE UNDER A SECRET-LOOKING KEY IS RECURSED, NOT BLANKED (2026-08-31) ──
      // `SECRET_BODY_KEY_RE` matches KEY NAMES, and one of them is `token`. RazorPay's
      // mandate registration nests the whole mandate under exactly that key:
      //
      //   { token: { max_amount: 6336305, expire_at: 2093…, frequency: 'as_presented' } }
      //
      // so blanking the value wholesale wrote `"token":"****"` and the MANDATE TERMS never
      // reached `gateway_request_logs`. Those are terms, not secrets — the ceiling and the
      // expiry are exactly what you need to read when a mandate misbehaves, and their
      // absence cost a full investigation that could only infer what we had SENT from what
      // RazorPay echoed back (2026-08-31, chasing a mandate that appeared to expire in 24h).
      //
      // Recursing loses nothing, and that is a property of the scheme rather than a hope:
      // masking is keyed on NAMES and applied at every level, so a genuine secret nested
      // under a secret-looking key is still caught by its OWN key — `token: { number: … }`
      // masks `number` on the way down. Only leaves whose names say nothing secret become
      // visible.
      //
      // ⚠ PLAIN OBJECTS ONLY. An array's elements are positional and have no key to be
      // judged by, so `keys: ['sk_live_…']` would walk the recursion untouched. Arrays
      // under a secret-looking key stay blanked — over-cautious for an array of objects,
      // and the right way to be wrong here.
      out[k] = SECRET_BODY_KEY_RE.test(k) && !isPlainObject(v) ? "****" : maskDeep(v);
    }
    return out;
  }
  return value;
}

/** Parse + redact a raw request/response body for storage. Never throws. */
export function redactBody(raw: string | undefined): unknown {
  if (raw == null) return undefined;
  try {
    // Authorize.net starts every JSON body with a BOM; unparsed, it would be stored unredacted.
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return maskDeep(parsed);
  } catch {
    // Not JSON. Stripe sends **form-encoded** bodies, and storing those raw would
    // write values like `source=tok_…` / `card[number]=…` verbatim into the log — the
    // JSON path masks those by key, so the encoding must not decide whether we redact.
    const form = parseFormEncoded(raw);
    if (form) return maskDeep(form);
    return truncate(raw);
  }
}

/**
 * Parse an `a=b&c[d]=e` body into an object, or null when it clearly isn't one.
 * Deliberately strict: a stray "=" inside prose must not turn a text body into a
 * bag of fake keys.
 */
function parseFormEncoded(raw: string): Record<string, string> | null {
  const s = truncate(raw);
  if (!s || /\s/.test(s.slice(0, 200).trim()) || !s.includes("=")) return null;
  const out: Record<string, string> = {};
  for (const pair of s.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    try {
      out[decodeURIComponent(pair.slice(0, eq).replace(/\+/g, " "))] = decodeURIComponent(
        pair.slice(eq + 1).replace(/\+/g, " "),
      );
    } catch {
      return null;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Mask query-string parameter values whose key looks secret, for storage in the log's `url`. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of Array.from(u.searchParams.keys())) {
      if (SECRET_KEY_RE.test(key) || SECRET_BODY_KEY_RE.test(key)) u.searchParams.set(key, "****");
    }
    return u.toString();
  } catch {
    return url;
  }
}

export interface GatewayLogInsert {
  gatewayKey: string;
  operation: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  requestHeaders?: unknown;
  requestBody?: unknown;
  responseHeaders?: unknown;
  responseBody?: unknown;
  error?: string | null;
  /**
   * Explicit provenance override. When omitted, falls back to the ambient
   * ALS context (`currentGatewayLogContext`/`currentEventContext`). Callers
   * whose HTTP call happens outside the calling async chain (e.g. an SDK's
   * own `request`/`response` event emitters, which may fire detached from
   * the ALS subtree that issued the call) should capture the context
   * up-front and pass it here explicitly.
   */
  businessId?: string | null;
  gatewayAccountId?: string | null;
  source?: string | null;
  actor?: string | null;
}

/**
 * Log inserts still in flight.
 *
 * The insert is deliberately not awaited — an observability row must never delay or
 * fail a charge — but "not awaited" and "unobservable" are different things. A caller
 * that needs to READ the rows it just caused (a verify suite asserting on the log, a
 * shutdown path that would rather not drop them) has no other handle on them, and
 * polling a table for a row that may never arrive cannot distinguish slow from lost.
 * So each insert registers here for the lifetime of the promise and
 * `flushGatewayRequestLogs()` awaits whatever is outstanding.
 */
const inFlightLogInserts = new Set<Promise<unknown>>();

/**
 * Await every gateway-log insert issued so far. Returns once they have settled —
 * failures are already swallowed and logged by the insert itself, so this resolves
 * rather than rejecting.
 *
 * For readers of the log, not for writers: nothing on the money path should call it.
 * New inserts issued after it starts are not waited on, which is exactly right for
 * "flush what I caused" and would be wrong for "quiesce the process".
 */
export async function flushGatewayRequestLogs(): Promise<void> {
  await Promise.allSettled([...inFlightLogInserts]);
}

/**
 * Fire-and-forget insert into gateway_request_logs. Never blocks/fails the
 * caller. Exported so SDK-based adapters (e.g. stripe.ts, which can't route
 * through `providerFetch` since the `stripe` npm package owns its own HTTP
 * transport) can log a row per completed call directly.
 *
 * Fire-and-forget, but not untrackable — see `flushGatewayRequestLogs`.
 */
export function logGatewayRequest(entry: GatewayLogInsert): void {
  const logCtx = currentGatewayLogContext();
  const evtCtx = currentEventContext();
  const pending = systemDb
    .insert(gatewayRequestLogs)
    .values({
      businessId: entry.businessId !== undefined ? entry.businessId : (logCtx?.businessId ?? null),
      gatewayAccountId:
        entry.gatewayAccountId !== undefined
          ? entry.gatewayAccountId
          : (logCtx?.gatewayAccountId ?? null),
      gatewayKey: entry.gatewayKey,
      method: entry.method,
      url: redactUrl(entry.url),
      status: entry.status,
      durationMs: entry.durationMs,
      operation: entry.operation,
      source: entry.source !== undefined ? entry.source : (evtCtx?.source ?? null),
      actor: entry.actor !== undefined ? entry.actor : (evtCtx?.actor ?? null),
      requestHeaders: entry.requestHeaders ?? null,
      requestBody: entry.requestBody ?? null,
      responseHeaders: entry.responseHeaders ?? null,
      responseBody: entry.responseBody ?? null,
      error: entry.error ?? null,
      // Ambient, never threaded through call sites — adapters must not have to know
      // about tracing to be traceable.
      traceId: getTraceId() ?? null,
      spanId: getSpanId() ?? null,
    })
    .catch((err: unknown) => {
      log.warn("gateway_request_logs insert failed:", err);
    });
  inFlightLogInserts.add(pending);
  // `finally` on the already-caught promise, so the registry drains on failure too.
  void pending.finally(() => inFlightLogInserts.delete(pending));
}

export interface ProviderFetchRequest {
  gatewayKey: string;
  operation: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ProviderFetchResult {
  status: number;
  headers: Headers;
  text: string;
  durationMs: number;
}

/**
 * Client-side ceiling on ONE gateway round trip.
 *
 * 80_000ms is not a new number: it is `stripe-node`'s own `DEFAULT_TIMEOUT`
 * (`node_modules/stripe/cjs/stripe.core.js`), which the Stripe adapter has always
 * had because the SDK owns its transport. Every other adapter (RazorPay, PayPal)
 * calls out through `providerFetch`, and `fetch` has **no** default timeout — so a
 * hung gateway socket had no upper bound at all: it held the worker's request open,
 * and with it the `Idempotency-Key` lock, indefinitely.
 *
 * Matching Stripe's value rather than inventing a better one is deliberate. It is the
 * bound `IDEMPOTENCY_STALE_MS` (`platform/idempotency.ts`, 5 min ≈ 4x this) was
 * derived from, and that derivation only held for Stripe until now — one number keeps
 * the staleness reaper correct for every gateway instead of one of them.
 */
export const PROVIDER_FETCH_TIMEOUT_MS = 80_000;

/**
 * Perform the outbound gateway HTTP call, timing it and logging a redacted
 * request/response row (success or failure) into `gateway_request_logs`.
 * On a network error, the row is logged (status=null, error message) and the
 * original error is rethrown unchanged (a timeout is restated — see below —
 * but stays a plain Error and carries the original as `cause`).
 *
 * A timeout is just another network error here, exactly as it is for Stripe (whose
 * SDK raises `StripeConnectionError` on the same bound): the log row is written
 * first — so a timed-out attempt is still visible in Gateway Activity with its
 * gateway, operation, URL and duration — and then it throws. No new error class, and
 * no synthesized `ChargeResult`: the adapters deliberately do NOT turn a lost
 * connection into a `failed` charge, because a timed-out debit may well have gone
 * through, and only the unknown-outcome paths (`timeout` transaction status, inbound
 * reconciliation) may decide that. Guessing "failed" here would be the one classification
 * that can drop a real payment on the floor.
 */
/**
 * How this engine identifies itself to a gateway.
 *
 * Gateways have no request FIELD for "which app is calling": RazorPay's payment entity
 * carries no `app_id`/`app_name` and `/payments/create/recurring` accepts none. The
 * channel their own SDKs use is the **User-Agent** — `razorpay-python`'s
 * `set_app_details({title, version})` appends `Title/Version` to it, `razorpay-node`
 * sends `razorpay-node@<version>`, and Stripe's `appInfo` does the same thing one layer
 * up. We hand-roll the transport, so we send ours the same way.
 *
 * No version suffix on purpose: `package.json` says `0.0.0`, and a version string that
 * is always the same is worse than none — it looks like information.
 *
 * ⚠️ This does NOT populate the "App Name" / "App ID" rows on a RazorPay payment. Those
 * belong to a registered RazorPay *application* (a Partner OAuth `client_id`), and a
 * key-secret integration has none — they stay `--` no matter what we send. What this
 * does buy is that our calls are identifiable in the gateway's own request logs, which
 * is what a support ticket needs.
 */
export const PROVIDER_APP_NAME = "tmbilling";

export async function providerFetch(req: ProviderFetchRequest): Promise<ProviderFetchResult> {
  const start = Date.now();
  // Ours first so a caller can still override it; every adapter on this transport
  // (RazorPay, PayPal) is identified without having to remember to be. Built once and
  // used for BOTH the call and the log row — logging `req.headers` instead would make
  // Gateway Activity misreport what we actually sent.
  const headers = { "User-Agent": PROVIDER_APP_NAME, ...req.headers };
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body,
      signal: AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS),
      // Never follow: the credentials in `headers` would travel to whatever host a 3xx names.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400)
      throw new Error(
        `${req.gatewayKey} ${req.operation} (${req.method} ${req.url}) answered ${res.status} ` +
          `to ${res.headers.get("location") ?? "(no location)"}. Redirects are not followed. ` +
          `The outcome is UNKNOWN, not failed`,
      );
    const text = await res.text();
    const durationMs = Date.now() - start;
    logGatewayRequest({
      gatewayKey: req.gatewayKey,
      operation: req.operation,
      method: req.method,
      url: req.url,
      status: res.status,
      durationMs,
      requestHeaders: redactHeaders(headers),
      requestBody: redactBody(req.body),
      // Redacted like request headers: responses carry `set-cookie` and, on Stripe,
      // `report-to` / `reporting-endpoints`.
      responseHeaders: redactHeaders(Object.fromEntries(res.headers)),
      responseBody: redactBody(text),
    });
    return { status: res.status, headers: res.headers, text, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    // `AbortSignal.timeout` rejects with a DOMException named 'TimeoutError' whose
    // message ("The operation was aborted due to timeout") names neither the gateway
    // nor the call. Restate it the way stripe-node does — self-describing, with the
    // bound in it — so a 500 or a log line identifies the hung call on its own.
    // Still a plain Error, and the original is kept as `cause`.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const error = timedOut
      ? new Error(
          `${req.gatewayKey} ${req.operation} (${req.method} ${req.url}) timed out after ` +
            `${PROVIDER_FETCH_TIMEOUT_MS}ms. The outcome is UNKNOWN, not failed`,
          { cause: err },
        )
      : err;
    // Transport-level only: no response at all (timeout, DNS, TLS, connection reset).
    // A decline is a RESPONSE and belongs to the caller's outcome handling, not here —
    // logging those would drown the sink in ordinary billing life. This one is
    // infrastructure, and it carries the trace so it lines up with the charge it broke.
    log.warn("gateway call failed at the transport layer — outcome UNKNOWN", {
      gateway: req.gatewayKey,
      operation: req.operation,
      method: req.method,
      timedOut,
      durationMs,
    });
    logGatewayRequest({
      gatewayKey: req.gatewayKey,
      operation: req.operation,
      method: req.method,
      url: req.url,
      status: null,
      durationMs,
      requestHeaders: redactHeaders(headers),
      requestBody: redactBody(req.body),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * For adapters with no real outbound HTTP call (tmtest): log one synthetic
 * row per operation so the Gateway Activity log stays complete in dev/test.
 */
export function logSyntheticGatewayRequest(opts: {
  gatewayKey: string;
  operation: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
  error?: string;
}): void {
  logGatewayRequest({
    gatewayKey: opts.gatewayKey,
    operation: opts.operation,
    method: "POST",
    url: `tmtest://${opts.operation}`,
    status: opts.status,
    durationMs: 0,
    requestBody: opts.requestBody ?? null,
    responseBody: opts.responseBody ?? null,
    error: opts.error ?? null,
  });
}
