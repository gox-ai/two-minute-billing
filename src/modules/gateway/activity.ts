/**
 * Gateway request/activity log inspector (LOG-1).
 *
 * `gateway_request_logs` records every outbound HTTP call an adapter makes
 * to a payment gateway (charge, refund, vault, webhook normalization, …).
 * This module exposes the read-only inspector API for it, mirroring the
 * inbound gateway-webhook inspector in `./inbound.ts`.
 */
import { and, desc, eq, lt, sql, type SQL } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { businesses, gatewayRequestLogs } from "@db/schema";
import {
  clampLimit,
  filterConditions,
  keysetCondition,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  isUuid,
  isUuidCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import { businessTimezone } from "@/platform/business-tz";

export type GatewayRequestLogRow = typeof gatewayRequestLogs.$inferSelect;

/** List gateway request logs for a business (inspector). Base connection — platform-global log. */
export async function listGatewayRequestLogs(
  organizationId: string,
  businessId: string,
  opts?: { limit?: number; gatewayKey?: string; source?: string; before?: Date },
): Promise<GatewayRequestLogRow[]> {
  // Guard the business belongs to the caller's org (RLS-scoped lookup).
  const ok = await withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return !!b;
  });
  if (!ok) return [];
  const conds = [eq(gatewayRequestLogs.businessId, businessId)];
  if (opts?.gatewayKey) conds.push(eq(gatewayRequestLogs.gatewayKey, opts.gatewayKey));
  if (opts?.source) conds.push(eq(gatewayRequestLogs.source, opts.source));
  if (opts?.before) conds.push(lt(gatewayRequestLogs.createdAt, opts.before));
  return systemDb
    .select()
    .from(gatewayRequestLogs)
    .where(and(...conds))
    .orderBy(desc(gatewayRequestLogs.createdAt))
    .limit(Math.min(opts?.limit ?? 50, 200));
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────

const GATEWAY_REQUEST_FILTERS: Record<string, FilterSpec> = {
  id: { column: gatewayRequestLogs.id, kind: "text" },
  gateway_key: { column: gatewayRequestLogs.gatewayKey, kind: "enum" },
  method: { column: gatewayRequestLogs.method, kind: "enum" },
  operation: { column: gatewayRequestLogs.operation, kind: "text" },
  source: { column: gatewayRequestLogs.source, kind: "text" },
  url: { column: gatewayRequestLogs.url, kind: "text" },
  status: { column: gatewayRequestLogs.status, kind: "number" },
  duration_ms: { column: gatewayRequestLogs.durationMs, kind: "number" },
  error: { column: gatewayRequestLogs.error, kind: "text" },
  // Filterable so "show me every gateway call this operation made" is one query.
  trace_id: { column: gatewayRequestLogs.traceId, kind: "text" },
  // One invoice collection inside that trace (a transaction's own calls).
  span_id: { column: gatewayRequestLogs.spanId, kind: "text" },
  created_at: { column: gatewayRequestLogs.createdAt, kind: "date" },
};

export const GATEWAY_REQUEST_FILTER_OPS = opsFromSpecs(GATEWAY_REQUEST_FILTERS);

const GATEWAY_REQUEST_SORTS = {
  created_at: gatewayRequestLogs.createdAt,
  duration_ms: gatewayRequestLogs.durationMs,
  status: gatewayRequestLogs.status,
} as const;

export type GatewayRequestSortField = keyof typeof GATEWAY_REQUEST_SORTS;
export const GATEWAY_REQUEST_SORT_FIELDS = Object.keys(
  GATEWAY_REQUEST_SORTS,
) as GatewayRequestSortField[];

export interface GatewayRequestListFilters {
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of the outbound gateway request/response log, newest-first by
 * default. Keyset on `(created_at DESC, id DESC)` — this log is unbounded
 * provider traffic (every charge/refund/vault/webhook-normalize call), so it
 * must never be shipped to the browser wholesale (docs/GUIDE.md §3.4).
 */
export async function listGatewayRequestLogsPage(
  organizationId: string,
  businessId: string,
  f: GatewayRequestListFilters = {},
): Promise<ListPage<GatewayRequestLogRow>> {
  const limit = clampLimit(f.limit);
  const sortField = (f.sortField ?? "created_at") as GatewayRequestSortField;
  const descending = f.sortDesc ?? true;
  const keyset = sortField === "created_at";

  // Guard the business belongs to the caller's org (RLS-scoped lookup) — same
  // guard as the legacy `listGatewayRequestLogs` above; `gateway_request_logs`
  // has no `organization_id` column of its own to scope on directly. Grabs the
  // business's IANA zone in the same tenant-scoped round trip, for `date`-kind
  // day bucketing (created_at filters bucket by the business day, not UTC).
  const guard = await withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!b) return null;
    return { tz: await businessTimezone(tx, businessId) };
  });
  if (!guard) return { data: [], hasMore: false, nextCursor: null, total: 0 };

  const conds: SQL[] = [eq(gatewayRequestLogs.businessId, businessId)];
  const search = searchCondition(
    [
      gatewayRequestLogs.id,
      gatewayRequestLogs.gatewayKey,
      gatewayRequestLogs.method,
      gatewayRequestLogs.operation,
      gatewayRequestLogs.source,
      gatewayRequestLogs.url,
      gatewayRequestLogs.error,
    ],
    f.search,
  );
  if (search) conds.push(search);
  conds.push(...filterConditions(GATEWAY_REQUEST_FILTERS, f.filters, guard.tz));

  let total: number | null = null;
  if (!f.startingAfter) {
    total = await cappedTotal(
      systemDb,
      systemDb
        .select({ one: sql`1` })
        .from(gatewayRequestLogs)
        .where(and(...conds)),
    );
  }

  const { keysetId, offset } = parseCursor(f.startingAfter);
  const pageConds = [...conds];
  // A non-uuid keyset id would make Postgres throw 22P02 on the lookup below
  // (this table tiebreaks on the raw uuid PK, not a public id), which surfaced
  // as a 500. Ignoring it degrades to the first page.
  if (keyset && keysetId && isUuidCursor(keysetId)) {
    const [cursor] = await systemDb
      .select({
        createdAt: sql<string>`${gatewayRequestLogs.createdAt}::text`,
        id: gatewayRequestLogs.id,
      })
      .from(gatewayRequestLogs)
      .where(
        and(eq(gatewayRequestLogs.businessId, businessId), eq(gatewayRequestLogs.id, keysetId)),
      )
      .limit(1);
    const seek = keysetCondition(
      gatewayRequestLogs.createdAt,
      gatewayRequestLogs.id,
      cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.id } : undefined,
      descending,
    );
    if (seek) pageConds.push(seek);
  }

  const rows = await systemDb
    .select()
    .from(gatewayRequestLogs)
    .where(and(...pageConds))
    .orderBy(
      ...pageOrder(GATEWAY_REQUEST_SORTS[sortField], gatewayRequestLogs.id, descending, keyset),
    )
    .limit(limit + 1)
    .offset(keyset ? 0 : offset);

  return toPage(rows, limit, { keyset, offset, keyOf: (r) => r.id, total });
}

export async function getGatewayRequestLog(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<GatewayRequestLogRow | null> {
  // Raw uuid PK — a non-uuid id is "not found", not a 500. See isUuid.
  if (!isUuid(id)) return null;
  const ok = await withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return !!b;
  });
  if (!ok) return null;
  const [row] = await systemDb
    .select()
    .from(gatewayRequestLogs)
    .where(and(eq(gatewayRequestLogs.id, id), eq(gatewayRequestLogs.businessId, businessId)))
    .limit(1);
  return row ?? null;
}

export function serializeGatewayRequestLog(r: GatewayRequestLogRow) {
  return {
    object: "gateway_request_log",
    id: r.id,
    gateway_key: r.gatewayKey,
    method: r.method,
    url: r.url,
    status: r.status,
    duration_ms: r.durationMs,
    operation: r.operation,
    source: r.source,
    actor: r.actor,
    request_headers: r.requestHeaders ?? null,
    request_body: r.requestBody ?? null,
    response_headers: r.responseHeaders ?? null,
    response_body: r.responseBody ?? null,
    error: r.error,
    // Correlates this call with the rest of the traced operation.
    trace_id: r.traceId,
    span_id: r.spanId,
    created_at: r.createdAt,
  };
}
