/**
 * API request log shapes (`GET /v1/request_logs[/:id]`). A plain module, so client
 * components can import the helpers below; the fetchers live in `lib/api/request-logs`.
 */

export interface RequestLogSummary {
  object: "request_log";
  /** `req_` + 32 hex — the value of the `Request-Id` response header. */
  id: string;
  created_at: string;
  method: string;
  /** No query string. */
  path: string;
  /** Route pattern, e.g. `/v1/businesses/:biz/customers`. */
  route: string | null;
  /** Redacted query string, without "?". */
  query: string | null;
  api_version: string;
  kind: "read" | "write";
  /** Null: the client closed the connection before a reply. */
  status: number | null;
  duration_ms: number | null;
  source: "api" | "dashboard";
  api_key: { id: string; name: string | null; revoked: boolean } | null;
  /** The signed-in person behind a dashboard write. */
  member: { id: string; email: string } | null;
  business: string | null;
  livemode: "test" | "live" | null;
  idempotency_key: string | null;
  idempotency_outcome: "new" | "replayed" | "mismatch" | "in_progress" | "missing" | null;
  error_type: string | null;
  trace_id: string | null;
  customer: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface RequestLogRelatedRow {
  id: string;
  created_at: string;
  method: string;
  path: string;
  status: number | null;
  idempotency_outcome: string | null;
  /** The oldest row with this key. */
  original: boolean;
  /** The row being viewed. */
  current: boolean;
}

export interface RequestLogDetail extends RequestLogSummary {
  request_body: unknown;
  /** Kept for writes and for status >= 400 only. */
  response_body: unknown;
  related: {
    /** Oldest first; empty when the request had no key. */
    same_idempotency_key: RequestLogRelatedRow[];
    events: { count: number; ids: string[] };
    audit_logs: { count: number; ids: string[] };
    gateway_requests: { count: number; ids: string[] };
  };
}

export type StatusTone = "green" | "tan" | "red" | "gray";

/** 2xx green, 4xx amber, 5xx red; no status (client closed) neutral. */
export function statusTone(status: number | null): StatusTone {
  if (status == null) return "gray";
  if (status >= 500) return "red";
  if (status >= 400) return "tan";
  if (status >= 200 && status < 300) return "green";
  return "gray";
}

/** Who sent it: the key's name (or id), else the member's email. */
export function callerLabel(r: Pick<RequestLogSummary, "api_key" | "member" | "source">): string {
  if (r.api_key) return r.api_key.name ?? r.api_key.id;
  if (r.member) return r.member.email;
  return r.source === "dashboard" ? "Dashboard" : "—";
}
