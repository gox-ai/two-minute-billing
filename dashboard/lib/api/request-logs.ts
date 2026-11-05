/**
 * Typed fetchers for the API request log (org-wide). Server-only.
 *   GET /v1/request_logs      — cursor list (docs/GUIDE.md §3.4), newest first, no bodies
 *   GET /v1/request_logs/:id  — one row with its bodies and `related`
 */
import { apiGet, apiGetOrNull, listQuery, type ListParams, type PagedList } from "@/lib/api";
import type { RequestLogSummary, RequestLogDetail } from "@/lib/request-log-types";

export type { RequestLogSummary, RequestLogDetail } from "@/lib/request-log-types";

/**
 * `api_key` and `business` are bare exact-match params, not filter columns: a
 * `api_key[is]=` row would be refused, so an `is` row on either moves to the scope.
 */
const BARE_ONLY = new Set(["api_key", "business"]);

export function listRequestLogs(params: ListParams = {}): Promise<PagedList<RequestLogSummary>> {
  const scope: Record<string, string | undefined> = { ...params.scope };
  const filters = (params.filters ?? []).filter((f) => {
    if (!BARE_ONLY.has(f.field)) return true;
    if (f.op === "is") scope[f.field] = f.value;
    return false;
  });
  // The endpoint orders newest first and takes no sort.
  const q = listQuery({ ...params, sort: undefined, filters, scope });
  return apiGet<PagedList<RequestLogSummary>>(`/v1/request_logs${q ? `?${q}` : ""}`);
}

/** Null on 404: an id from a toast or a link can name a row that aged out or was never kept. */
export function getRequestLog(id: string): Promise<RequestLogDetail | null> {
  return apiGetOrNull<RequestLogDetail>(`/v1/request_logs/${encodeURIComponent(id)}`);
}
