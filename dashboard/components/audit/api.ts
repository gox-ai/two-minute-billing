/**
 * P4 — audit-log reads for the Activity Log drill-in.
 *
 * Deliberately NOT added to `lib/api/audit.ts` (which owns the audit LIST fetchers):
 * `actor_ip` is new and this module is the only consumer, so the field is declared
 * here as an extension of the shared `AuditLog` type rather than by editing a file
 * three other screens share. If a second consumer appears, fold both into
 * `lib/api/audit.ts` in one move.
 *
 * Backend routes:
 *   GET /v1/businesses/:biz/audit_logs      — list (src/api/audit-routes.ts)
 *   GET /v1/businesses/:biz/audit_logs/:id  — one row, with the before/after diff
 */
import { apiGet, listQuery, type ListParams, type PagedList } from "@/lib/api";
import type { AuditLog } from "@/lib/api/audit";

/**
 * An audit row including the actor's origin IP (`audit_logs.actor_ip`,
 * migration 0142).
 *
 * NULLABLE and it matters: the billing clock, the importer and seeds write audit
 * rows with no request behind them, so a blank here means "no request", never
 * "we lost it". Render it as such — never substitute a placeholder address.
 */
export type AuditRow = AuditLog & { actor_ip: string | null; trace_id: string | null };

/** One resource's block of an audit record — the row plus its snapshot bodies. */
export interface AuditRecordBlock extends AuditRow {
  /**
   * 'available' — full record captured on both sides; render the contextual diff.
   * 'created'   — no before-state: the record was created, render its body.
   * 'none'      — no snapshot: never captured, or erased by a GDPR clear. The two
   *               are indistinguishable in the data, so the UI must not claim which.
   */
  snapshot: "available" | "created" | "none";
  before_full: unknown;
  after_full: unknown;
}

/**
 * ONE ACTION, every resource it changed. The unit of audit is the action, not the
 * row: activating a subscription is one record holding the subscription AND the
 * invoice it raised, and it appears on both records' Activity Log.
 */
export interface AuditRecord {
  object: "audit_record";
  id: string;
  trace_id: string | null;
  occurred_at: string;
  actor: string;
  source: string;
  actor_ip: string | null;
  blocks: AuditRecordBlock[];
}

/**
 * One audit RECORD by uuid — every resource the action changed (0149).
 *
 * `source` is the resource_type the reader arrived from; it hoists that block to the
 * front. It only reorders — every block is always returned, so the page can show what
 * else the action did.
 *
 * Throws (404) when the record isn't in this business.
 */
export function getBusinessAuditRecord(
  biz: string,
  id: string,
  source?: string,
): Promise<AuditRecord> {
  const q = source ? `?source=${encodeURIComponent(source)}` : "";
  return apiGet<AuditRecord>(`/v1/businesses/${biz}/audit_logs/${id}${q}`);
}

/**
 * Every audit row on ONE CUSTOMER's footprint — the customer record and everything
 * that hangs off it. `customer=` is a bare param the engine resolves server-side
 * (`ownedByCustomer`), not a `field[op]` filter: the id set is a join, not a column.
 */
export function listAuditLogsForCustomer(
  biz: string,
  customer: string,
  params: ListParams = {},
): Promise<PagedList<AuditRow>> {
  const q = [listQuery(params), `customer=${encodeURIComponent(customer)}`]
    .filter(Boolean)
    .join("&");
  return apiGet<PagedList<AuditRow>>(`/v1/businesses/${biz}/audit_logs?${q}`);
}

/**
 * The audit rows recorded against ONE resource — the operator-action side of a
 * record's history, which the Activity Log merges with the event stream.
 */
export function listAuditLogsForResource(
  biz: string,
  resourceType: string,
  resourceId: string,
  params: ListParams = {},
): Promise<PagedList<AuditRow>> {
  const q = listQuery({
    ...params,
    filters: [
      { field: "resource_type", op: "is", value: resourceType },
      { field: "resource_id", op: "is", value: resourceId },
      ...(params.filters ?? []),
    ],
  });
  return apiGet<PagedList<AuditRow>>(`/v1/businesses/${biz}/audit_logs${q ? `?${q}` : ""}`);
}
