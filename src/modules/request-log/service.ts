import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { apiKeys, apiRequestLogs, auditLogs, businesses, events, users } from "@db/schema";
import {
  cappedTotal,
  clampLimit,
  filterConditions,
  isUuidCursor,
  kindsFromSpecs,
  keysetCondition,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { requestIdToUuid } from "./capture";

export type RequestLogRow = typeof apiRequestLogs.$inferSelect;

const FILTERS: Record<string, FilterSpec> = {
  created_at: { column: apiRequestLogs.createdAt, kind: "date" },
  status: { column: apiRequestLogs.status, kind: "number" },
  duration_ms: { column: apiRequestLogs.durationMs, kind: "number" },
  method: { column: apiRequestLogs.method, kind: "enum" },
  kind: { column: apiRequestLogs.kind, kind: "enum" },
  source: { column: apiRequestLogs.source, kind: "enum" },
  livemode: { column: apiRequestLogs.livemode, kind: "enum" },
  path: { column: apiRequestLogs.path, kind: "text" },
  route: { column: apiRequestLogs.route, kind: "text" },
  idempotency_key: { column: apiRequestLogs.idempotencyKey, kind: "text" },
  trace_id: { column: apiRequestLogs.traceId, kind: "text" },
  error_type: { column: apiRequestLogs.errorType, kind: "text" },
  customer: { column: apiRequestLogs.customerId, kind: "text" },
};

export const REQUEST_LOG_FILTER_OPS = opsFromSpecs(FILTERS);
export const REQUEST_LOG_FILTER_KINDS = kindsFromSpecs(FILTERS);
export const REQUEST_LOG_SORT_FIELDS = ["created_at"] as const;

export interface RequestLogListOptions {
  search?: string;
  filters?: ListFilter[];
  startingAfter?: string;
  limit?: number;
  /** The reading key's mode: a test key sees test rows only. `all` sees both. */
  keyMode?: string;
  /** Public ids, resolved here. An unknown one matches nothing. */
  apiKey?: string;
  business?: string;
  customer?: string;
  traceId?: string;
  idempotencyKey?: string;
}

/** Display fields the rows reference: key names, member emails, business public ids. */
export interface RequestLogRefs {
  keys: Map<string, { id: string; name: string | null; revoked: boolean }>;
  members: Map<string, { id: string; email: string }>;
  businesses: Map<string, string>;
}

function modeCondition(keyMode?: string): SQL | undefined {
  return keyMode === "test" || keyMode === "live"
    ? eq(apiRequestLogs.livemode, keyMode)
    : undefined;
}

async function idOf(tx: Tx, table: typeof apiKeys | typeof businesses, publicId: string) {
  const [row] = await tx
    .select({ id: table.id })
    .from(table)
    .where(eq(table.publicId, publicId))
    .limit(1);
  return row?.id ?? null;
}

const NONE = sql`false`;

export async function listRequestLogsPage(
  organizationId: string,
  f: RequestLogListOptions = {},
): Promise<ListPage<RequestLogRow>> {
  const limit = clampLimit(f.limit);
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(apiRequestLogs.organizationId, organizationId)];
    const mode = modeCondition(f.keyMode);
    if (mode) conds.push(mode);
    if (f.apiKey) {
      const id = await idOf(tx, apiKeys, f.apiKey);
      conds.push(id ? eq(apiRequestLogs.apiKeyId, id) : NONE);
    }
    if (f.business) {
      const id = await idOf(tx, businesses, f.business);
      conds.push(id ? eq(apiRequestLogs.businessId, id) : NONE);
    }
    if (f.customer) conds.push(eq(apiRequestLogs.customerId, f.customer));
    if (f.traceId) conds.push(eq(apiRequestLogs.traceId, f.traceId));
    if (f.idempotencyKey) conds.push(eq(apiRequestLogs.idempotencyKey, f.idempotencyKey));
    if (f.search) {
      const uuid = requestIdToUuid(f.search.trim());
      if (uuid) conds.push(eq(apiRequestLogs.id, uuid));
      else
        conds.push(
          searchCondition(
            [
              apiRequestLogs.path,
              apiRequestLogs.route,
              apiRequestLogs.idempotencyKey,
              apiRequestLogs.traceId,
            ],
            f.search,
          )!,
        );
    }
    conds.push(...filterConditions(FILTERS, f.filters, "UTC"));

    const total = f.startingAfter
      ? null
      : await cappedTotal(
          tx,
          tx
            .select({ one: sql`1` })
            .from(apiRequestLogs)
            .where(and(...conds)),
        );

    const pageConds = [...conds];
    const { keysetId } = parseCursor(f.startingAfter);
    if (keysetId && isUuidCursor(keysetId)) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${apiRequestLogs.createdAt}::text`,
          id: apiRequestLogs.id,
        })
        .from(apiRequestLogs)
        .where(eq(apiRequestLogs.id, keysetId))
        .limit(1);
      const seek = keysetCondition(
        apiRequestLogs.createdAt,
        apiRequestLogs.id,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.id } : undefined,
        true,
      );
      if (seek) pageConds.push(seek);
    }
    const rows = await tx
      .select()
      .from(apiRequestLogs)
      .where(and(...pageConds))
      .orderBy(...pageOrder(apiRequestLogs.createdAt, apiRequestLogs.id, true, true))
      .limit(limit + 1);
    return toPage(rows, limit, { keyset: true, offset: 0, keyOf: (r) => r.id, total });
  });
}

/** Key names, member emails and business ids for a page of rows, in three queries. */
export async function requestLogRefs(
  organizationId: string,
  rows: RequestLogRow[],
): Promise<RequestLogRefs> {
  const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
  const keyIds = uniq(rows.map((r) => r.apiKeyId));
  const userIds = uniq(rows.map((r) => r.memberUserId));
  const bizIds = uniq(rows.map((r) => r.businessId));
  return withTenant(organizationId, async (tx) => {
    const [k, u, b] = await Promise.all([
      keyIds.length
        ? tx
            .select({
              id: apiKeys.id,
              publicId: apiKeys.publicId,
              name: apiKeys.name,
              revokedAt: apiKeys.revokedAt,
            })
            .from(apiKeys)
            .where(inArray(apiKeys.id, keyIds))
        : [],
      userIds.length
        ? tx
            .select({ id: users.id, publicId: users.publicId, email: users.email })
            .from(users)
            .where(inArray(users.id, userIds))
        : [],
      bizIds.length
        ? tx
            .select({ id: businesses.id, publicId: businesses.publicId })
            .from(businesses)
            .where(inArray(businesses.id, bizIds))
        : [],
    ]);
    return {
      keys: new Map(
        k.map((r) => [r.id, { id: r.publicId, name: r.name, revoked: r.revokedAt != null }]),
      ),
      members: new Map(u.map((r) => [r.id, { id: r.publicId, email: r.email }])),
      businesses: new Map(b.map((r) => [r.id, r.publicId])),
    };
  });
}

export interface RequestLogRelated {
  sameIdempotencyKey: Array<RequestLogRow & { original: boolean }>;
  events: { count: number; ids: string[] };
  auditLogs: { count: number; ids: string[] };
  gatewayRequests: { count: number; ids: string[] };
}

const RELATED_IDS = 20;

/**
 * One row by its public id (`req_…`), plus what it links to. A trace id we minted is unique
 * to its request; one a caller sent may be reused, so those links are bounded to the request's
 * own time window.
 */
export async function getRequestLog(
  organizationId: string,
  publicId: string,
  keyMode?: string,
): Promise<{ row: RequestLogRow; related: RequestLogRelated } | null> {
  const uuid = requestIdToUuid(publicId);
  if (!uuid) return null;
  return withTenant(organizationId, async (tx) => {
    const conds = [eq(apiRequestLogs.id, uuid)];
    const mode = modeCondition(keyMode);
    if (mode) conds.push(mode);
    const [row] = await tx
      .select()
      .from(apiRequestLogs)
      .where(and(...conds))
      .limit(1);
    if (!row) return null;

    const same = row.idempotencyKey
      ? await tx
          .select()
          .from(apiRequestLogs)
          .where(
            and(
              eq(apiRequestLogs.organizationId, organizationId),
              eq(apiRequestLogs.idempotencyKey, row.idempotencyKey),
              ...(mode ? [mode] : []),
            ),
          )
          .orderBy(asc(apiRequestLogs.createdAt), asc(apiRequestLogs.id))
          .limit(50)
      : [];

    const related: RequestLogRelated = {
      sameIdempotencyKey: same.map((r, i) => ({ ...r, original: i === 0 })),
      events: { count: 0, ids: [] },
      auditLogs: { count: 0, ids: [] },
      gatewayRequests: { count: 0, ids: [] },
    };
    if (!row.traceId) return { row, related };

    const ours = row.traceId.startsWith("api-");
    const from = new Date(row.createdAt.getTime() - 1_000).toISOString();
    const to = new Date(row.createdAt.getTime() + (row.durationMs ?? 0) + 5_000).toISOString();
    const inWindow = (col: SQL) =>
      ours ? sql`true` : sql`${col} between ${from}::timestamptz and ${to}::timestamptz`;

    const [ev, au, gw] = await Promise.all([
      tx
        .select({ id: events.publicId, n: sql<number>`count(*) over ()::int` })
        .from(events)
        .where(
          and(
            eq(events.organizationId, organizationId),
            eq(events.traceId, row.traceId),
            inWindow(sql`${events.createdAt}`),
          ),
        )
        .orderBy(asc(events.createdAt))
        .limit(RELATED_IDS),
      tx
        .select({ id: auditLogs.id, n: sql<number>`count(*) over ()::int` })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.traceId, row.traceId),
            inWindow(sql`${auditLogs.createdAt}`),
          ),
        )
        .orderBy(asc(auditLogs.createdAt))
        .limit(RELATED_IDS),
      // Platform-global table, no app-role grant: read on the system connection, scoped
      // through this organization's businesses.
      systemDb.execute(sql`
        select g.id::text as id, count(*) over ()::int as n
        from gateway_request_logs g
        where g.trace_id = ${row.traceId}
          and g.business_id in (select b.id from businesses b where b.organization_id = ${organizationId})
          and ${inWindow(sql`g.created_at`)}
        order by g.created_at
        limit ${RELATED_IDS}`) as unknown as Promise<Array<{ id: string; n: number }>>,
    ]);
    related.events = { count: ev[0]?.n ?? 0, ids: ev.map((r) => r.id) };
    related.auditLogs = { count: au[0]?.n ?? 0, ids: au.map((r) => r.id) };
    related.gatewayRequests = { count: gw[0]?.n ?? 0, ids: gw.map((r) => r.id) };
    return { row, related };
  });
}

/** Erasure: the customer's rows go with the customer (`clearPersonalData`). */
export async function deleteCustomerRequestLogs(
  tx: Tx,
  organizationId: string,
  customerPublicId: string,
): Promise<number> {
  const gone = await tx
    .delete(apiRequestLogs)
    .where(
      and(
        eq(apiRequestLogs.organizationId, organizationId),
        eq(apiRequestLogs.customerId, customerPublicId),
      ),
    )
    .returning({ id: apiRequestLogs.id });
  return gone.length;
}
