/**
 * Typed API fetchers for the audit log.
 *   GET /v1/audit_logs                 — org-level audit log
 *   GET /v1/businesses/:biz/audit_logs — business-scoped audit log
 */
import { apiGet, listQuery, type ListParams, type PagedList } from "@/lib/api";

// 'dashboard' is a person working in this UI (actor = their email); 'system' is the
// narrower "no human, no request" — seeds, verify runs. They are not interchangeable.
// See `src/platform/event-context.ts` § EventSource.
export type AuditSource = "api" | "dashboard" | "billing_clock" | "migration" | "system";

export interface AuditLog {
  object: "audit_log";
  id: string;
  actor: string | null;
  source: AuditSource | string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  /** The serialized `before` snapshot — arbitrary JSON. */
  before: unknown;
  /** The serialized `after` snapshot — arbitrary JSON. */
  after: unknown;
  created_at: string;
  /** Only present on org-level listing (includes the business the log belongs to). */
  business_id?: string | null;
}

/**
 * LOG-4: both audit log routes are cursor-paginated — same shared contract as
 * customers/transactions (`ListParams` → `PagedList`, docs/GUIDE.md §3.4).
 * Filterable/sortable fields: `action`, `actor`, `resource_type`, `resource_id`,
 * `created_at` (see `AUDIT_FILTER_OPS` / `AUDIT_SORT_FIELDS` in
 * src/modules/audit/service.ts).
 */
export function listAuditLogs(params: ListParams = {}): Promise<PagedList<AuditLog>> {
  const q = listQuery(params);
  return apiGet<PagedList<AuditLog>>(`/v1/audit_logs${q ? `?${q}` : ""}`);
}

export function listBusinessAuditLogs(
  biz: string,
  params: ListParams = {},
): Promise<PagedList<AuditLog>> {
  const q = listQuery(params);
  return apiGet<PagedList<AuditLog>>(`/v1/businesses/${biz}/audit_logs${q ? `?${q}` : ""}`);
}
