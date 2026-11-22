import { AsyncLocalStorage } from "node:async_hooks";
import { newTraceId, traceIdFromHeaders, withTraceContext } from "./trace";

/**
 * Request/job-scoped provenance for emitted events (plan §A2). Threaded via
 * AsyncLocalStorage so `emitEvent` can stamp `source`/`actor` without every
 * service function having to forward them as parameters.
 *
 *  - `api`           — an integration's API-key request (actor = api key public id)
 *  - `dashboard`     — a person working in our own UI (actor = their email, from the
 *                      session the dashboard forwards; `dashboard` when no session
 *                      accompanied the request). Carries the operator's `ip`.
 *  - `scheduled_job` — the billing clock / background jobs (actor = 'billing_clock')
 *  - `migration`     — the JSON importer
 *  - `portal` / `checkout` — the buyer, on a /portal/v1 or /checkout/v1 route
 *  - `webhook`       — an inbound gateway or email-provider notification
 *  - `mcp`           — an OAuth access token (an AI agent), not an API key
 *  - `system`        — no human and no request: seeds, verify runs, programmatic
 *                      contexts (actor = 'system').
 *
 * `dashboard` and `system` are NOT interchangeable, and for one commit (0150) they
 * were conflated: dashboard traffic was recorded as `system` because the credential it
 * used was called that. An operator clicking Void is a person doing a thing at a
 * keyboard; a seed is not. Collapsing them loses the only distinction the audit trail
 * is for — who did this.
 */
export type EventSource =
  | "api"
  | "dashboard"
  | "scheduled_job"
  | "migration"
  | "system"
  | "hubspot"
  /** A change the member confirmed in the assistant (actor = the member). */
  | "assistant"
  /** The buyer, in the customer portal (actor = the portal session). */
  | "portal"
  /** The buyer, on hosted checkout (actor = the checkout session). */
  | "checkout"
  /** A gateway or email-provider notification (actor = the gateway key, e.g. "stripe"). */
  | "webhook"
  /** An AI agent connected over OAuth/MCP (actor = the grant's API key id). */
  | "mcp";

export interface EventContext {
  source: EventSource;
  actor?: string | null;
  /**
   * P4: the client IP the request came from, for `audit_logs.actor_ip` (shown on
   * the audit detail page). Rides here for exactly the same reason as
   * `actor`: threading it through every service signature would mean one forgotten
   * parameter = a silently blank audit row.
   *
   * Absent (undefined/null) for every non-request context — the billing clock,
   * the importer, seeds, verify scripts. That blank is meaningful: it says "no
   * request", which is why nothing ever substitutes a placeholder.
   */
  ip?: string | null;
  /**
   * Drop every domain event emitted in this context (no `events` row, no sinks, so no
   * webhook delivery and no customer mail).
   *
   * For bulk backfills where the events describe our own writing rather than anything
   * that happened to the customer: importing 5,043 coupons is not 5,043 things a
   * subscriber needs to hear about. The audit trail of an import is `import_records`.
   *
   * Deliberately NOT the default for imports — an event nobody wanted is recoverable,
   * an event nobody got is not, so silence has to be asked for.
   */
  suppressEvents?: boolean;
}

const storage = new AsyncLocalStorage<EventContext>();

/** Run `fn` with the given event context bound for its entire async subtree. */
export function runWithEventContext<T>(ctx: EventContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Bind the event context for the remainder of the current async execution
 * (used from Fastify preHandlers, where there is no wrapping callback to run).
 */
export function enterEventContext(ctx: EventContext): void {
  storage.enterWith(ctx);
}

/** The active event context, or undefined outside any request/job. */
export function currentEventContext(): EventContext | undefined {
  return storage.getStore();
}

/**
 * Provenance stamped onto a record at creation — the "Channel" column on invoices
 * and credit notes.
 *
 * Derived from the ambient `EventSource` rather than passed by callers, for the
 * same reason `emitEvent` derives `source`: every creation path would otherwise
 * have to remember to forward it, and the one that forgot would silently record
 * the wrong origin. Returns null outside any context so we store "unknown"
 * rather than guessing a default — a wrong channel is worse than a blank one.
 *
 * `dashboard` means created by a person in our UI. It is reachable now — before 0151
 * nothing produced the source it maps from, so no stored row carries it yet.
 */
export type Channel = "api" | "dashboard" | "system" | "import";

export function currentChannel(): Channel | null {
  const source = storage.getStore()?.source;
  if (!source) return null;
  switch (source) {
    case "api":
    // An integration calling us on the merchant's behalf.
    case "hubspot":
    // The buyer in the portal or checkout, a gateway notification, an AI agent: API
    // requests, as before these sources existed. Stored channel values do not change.
    case "portal":
    case "checkout":
    case "webhook":
    case "mcp":
      return "api";
    case "dashboard":
    // A change the member confirmed in the assistant: still a person in our UI.
    case "assistant":
      return "dashboard";
    case "migration":
      return "import";
    // The billing clock and programmatic contexts are both "not a human or an
    // integration" from the reader's point of view.
    case "scheduled_job":
    case "system":
      return "system";
  }
}

/**
 * Patch the active event context in place (same store reference). Used to fill in
 * the actor once authentication resolves it, after the request-scoped store was
 * established at onRequest. No-op outside a context.
 */
export function updateEventContext(patch: Partial<EventContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, patch);
}

/**
 * Resolve the client IP of an inbound request for the audit trail.
 *
 * WE USE FASTIFY'S OWN `request.ip` AND NEVER READ `x-forwarded-for` OURSELVES.
 * `req.ip` is `proxy-addr`-backed: with the app's `trustProxy` unset it is the
 * socket peer, and with `trustProxy` configured it walks the forwarded chain from
 * the RIGHT, discarding hops the operator has declared trusted and stopping at the
 * first untrusted one. Hand-parsing `x-forwarded-for[0]` instead takes the value a
 * caller typed, so anyone could forge the IP on their own audit row with one
 * header — an audit log that can be edited by its subject is worse than one with
 * no IP at all. Deployments behind a load balancer therefore turn on Fastify's
 * `trustProxy` (in `buildApp`) and this function needs no change.
 *
 * Normalization exists to protect the `inet` column, which the audit row shares a
 * transaction with (a type error here would roll back the money op it records):
 *  - `::ffff:203.0.113.7` → `203.0.113.7`. Node hands back the IPv4-mapped form on
 *    a dual-stack socket, and `inet` treats it as a DIFFERENT address from the
 *    dotted quad, so grouping "actions from this IP" would split in two.
 *  - `fe80::1%eth0` → `fe80::1`. Postgres `inet` rejects the `%zone` suffix
 *    outright; the address is the auditable part, the interface name is not.
 *  - anything else that is not a well-formed address → null, never a guess.
 */
export function clientIp(req: unknown): string | null {
  const r = req as { ip?: unknown; socket?: { remoteAddress?: unknown } } | undefined;
  const raw = typeof r?.ip === "string" && r.ip ? r.ip : r?.socket?.remoteAddress;
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Strip an IPv6 zone index — informative to an OS, invalid to `inet`.
  const bare = raw.includes("%") ? raw.slice(0, raw.indexOf("%")) : raw;
  // Unwrap IPv4-mapped IPv6 so one client is one address.
  const unwrapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)?.[1] ?? bare;
  return isIpAddress(unwrapped) ? unwrapped : null;
}

/** Well-formed IPv4 (dotted quad, each octet ≤ 255) or IPv6 (hex groups, `::` allowed once). */
function isIpAddress(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((o) => Number(o) <= 255 && (o === "0" || !o.startsWith("0")));
  }
  if (!value.includes(":")) return false;
  // At most one '::' elision, only hex groups (or a trailing IPv4 tail) otherwise.
  if ((value.match(/::/g) ?? []).length > 1) return false;
  const [head, tail] = value.split("::") as [string, string | undefined];
  const groups = [...head.split(":"), ...(tail != null ? tail.split(":") : [])].filter(
    (g) => g !== "",
  );
  if (groups.length === 0) return value === "::";
  const last = groups[groups.length - 1]!;
  const ipv4Tail = last.includes(".");
  if (ipv4Tail && !isIpAddress(last)) return false;
  const hexGroups = ipv4Tail ? groups.slice(0, -1) : groups;
  if (!hexGroups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  const width = hexGroups.length + (ipv4Tail ? 2 : 0);
  return tail != null ? width <= 7 : width === 8;
}

/**
 * Fastify onRequest hook: run the entire request lifecycle inside a fresh event
 * context (source by route family, `api` by default; actor filled in by `authenticate`) AND a fresh trace
 * context, so every log line of the request shares one traceId. Uses `run(store,
 * done)` — the reliable propagation pattern — rather than `enterWith`, which does
 * not consistently reach the route handler from a preHandler.
 *
 * The traceId is ADOPTED from the caller when they send one (`x-trace-id` /
 * `x-request-id` / W3C `traceparent`), so an execution spanning
 * tmr_data_service → tmbilling is one trace in both services' logs; otherwise a
 * fresh `api-` id is minted. It's echoed back as `x-trace-id` so a caller (or a
 * human with curl) can find the request in the logs.
 */
/**
 * The source a request starts with, by route family. Set here, once, so every route of a
 * family gets it: authenticated requests (API key, dashboard, OAuth) refine it later.
 * A webhook's actor is the gateway key from the path.
 */
export function initialContextFor(url: unknown): Pick<EventContext, "source" | "actor"> {
  const path = typeof url === "string" ? (url.split("?")[0] ?? "") : "";
  if (path.startsWith("/portal/v1/")) return { source: "portal", actor: null };
  if (path.startsWith("/checkout/v1/")) return { source: "checkout", actor: null };
  const gw = /^\/v1\/gateway_webhooks\/([a-z0-9_-]{1,40})(?:\/|$)/.exec(path)?.[1];
  if (gw) return { source: "webhook", actor: gw };
  if (path.startsWith("/v1/email_webhooks/ses")) return { source: "webhook", actor: "ses" };
  return { source: "api", actor: null };
}

export function eventContextHook(req: unknown, reply: unknown, done: () => void): void {
  const headers = (req as { headers?: Record<string, unknown> } | undefined)?.headers;
  const inbound = traceIdFromHeaders(headers);
  const traceId = inbound ?? newTraceId("api");
  // Best-effort: a missing/odd reply object must never break the request.
  const setHeader = (reply as { header?: (k: string, v: string) => unknown } | undefined)?.header;
  if (typeof setHeader === "function") {
    try {
      setHeader.call(reply, "x-trace-id", traceId);
    } catch {
      /* header already sent / not settable — the trace still stands */
    }
  }
  // The IP is resolved ONCE here, not per audit write: one request is one origin,
  // and `req` is not reachable from the service layer.
  const initial = initialContextFor((req as { url?: unknown } | undefined)?.url);
  storage.run({ ...initial, ip: clientIp(req) }, () => {
    withTraceContext({ traceId, ...(inbound ? { inherited: true } : {}) }, done);
  });
}
