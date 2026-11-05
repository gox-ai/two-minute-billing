import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businessTimezone } from "@/platform/business-tz";
import {
  filterConditions,
  keysetCondition,
  kindsFromSpecs,
  opsFromSpecs,
  parseCursor,
  searchCondition,
  splitMulti,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedPageTotal,
  cappedTotal,
} from "@/platform/list-query";
import { ownedByCustomer } from "@/modules/events/resource-scope";
import { events, importedEvents, webhookDeliveries, webhookEndpoints } from "@db/schema";

export interface EventFilters {
  businessId?: string;
  /** Legacy multi-value filter (repeated `?type=`), kept for existing API callers. */
  types?: string[];
  resourceType?: string;
  resourceId?: string;
  /**
   * Scope to ONE customer's whole footprint — the customer record plus every
   * subscription, invoice, credit note, transaction, payment, refund, payment
   * method/intent/attempt and dispute that belongs to it (`ownedByCustomer`).
   * A customer public id, not a uuid. Native-only: an imported row has no
   * resource pointer to match.
   */
  customer?: string;
  source?: string;
  occurredAfter?: Date;
  occurredBefore?: Date;
  /** `field[op]=value` filters (the shared list-query grammar, ListPage-driven). */
  filters?: ListFilter[];
  /** Free-text search (id / type / resource / actor), for `listEventsUnified` only. */
  search?: string;
  /** Cursor: return events strictly older than this event public id (opaque `k:<id>` or a bare id). */
  startingAfter?: string;
  limit?: number;
  /** Defaults to true (newest-first) — `listEventsUnified` only. */
  sortDesc?: boolean;
}

// ── Paginated list grammar (see docs/GUIDE.md §3.4) ─────────────────────────
//
// TWO maps for ONE list, because the list UNIONS `events` with `imported_events`
// (see `listEventsUnified`). A field is only safe to add to both when the two
// tables can answer it the SAME way — the id and the event type can, and the
// occurrence instant can (`created_at` here, `occurred_at` there). Everything
// else about an imported row lives inside its archived `payload` json, where the
// serializer digs it out per row (`serializeImportedEvent`): a SQL filter would
// have to re-derive those fallbacks, and a filter that derives a value slightly
// differently from the renderer is the "list lies about being filtered" bug.
//
// So the rest are NATIVE-ONLY and handled explicitly rather than silently: any
// filter naming one of `NATIVE_ONLY_FILTER_FIELDS` drops the imported side out of
// the union entirely (`importedApplicable`), for the page AND the total. That is
// honest — an imported event has no `resource_type` at all, so it cannot satisfy
// such a filter — and it is the pre-existing behaviour of resource_type /
// resource_id / source, now stated once instead of open-coded.
const NATIVE_EVENT_FILTERS: Record<string, FilterSpec> = {
  // Both sides: each table has its own `public_id` (`evt_…` / `ievt_…`), and the
  // serializer prints it as `id` for both.
  id: { column: events.publicId, kind: "text" },
  type: { column: events.type, kind: "enum" },
  resource_type: { column: events.resourceType, kind: "text" },
  resource_id: { column: events.resourceId, kind: "text" },
  source: { column: events.source, kind: "enum" },
  // WHO. Serialized as both `actor` and `user`; native-only, because an imported
  // row's actor is `payload->>'user'` with an `import:<source>` fallback.
  actor: { column: events.actor, kind: "text" },
  // WHICH RUN — the trace shared with `audit_logs` and `gateway_request_logs`, so a
  // clock tick can list exactly the events it caused instead of a created_at window
  // that a concurrent tick poisons. Always null on an imported row (0148/0149).
  trace_id: { column: events.traceId, kind: "text" },
  // The envelope schema version, for a consumer replaying a specific generation.
  api_version: { column: events.apiVersion, kind: "enum" },
  occurred_at: { column: events.createdAt, kind: "date" },
};
/**
 * `webhook_status` — the same worst-wins rollup the list prints (`rollupStatus`), as SQL, so
 * the filter and the rendered value cannot disagree. Imported events always print
 * `not_configured`, so they are kept exactly when the filter accepts that value.
 */
export const WEBHOOK_STATUSES = ["not_configured", "pending", "failed", "delivered"] as const;
const WEBHOOK_STATUS_FIELD = "webhook_status";
const WEBHOOK_STATUS_OPS = ["is", "is_not", "in", "not_in"] as const;

const webhookStatusExpr = sql<string>`(CASE
  WHEN NOT EXISTS (SELECT 1 FROM ${webhookDeliveries} d WHERE d.event_id = ${events.id}) THEN 'not_configured'
  WHEN EXISTS (SELECT 1 FROM ${webhookDeliveries} d WHERE d.event_id = ${events.id} AND d.status = 'failed') THEN 'failed'
  WHEN EXISTS (SELECT 1 FROM ${webhookDeliveries} d WHERE d.event_id = ${events.id} AND d.status = 'pending') THEN 'pending'
  ELSE 'delivered' END)`;

function webhookStatusValues(f: ListFilter): string[] {
  return f.op === "is" || f.op === "is_not" ? [f.value.trim()] : splitMulti(f.value);
}

/** Why a `webhook_status` filter is refused, or null. */
export function webhookStatusFilterError(filters: ListFilter[]): string | null {
  for (const f of filters) {
    if (f.field !== WEBHOOK_STATUS_FIELD) continue;
    const vals = webhookStatusValues(f);
    const bad = vals.filter((v) => !(WEBHOOK_STATUSES as readonly string[]).includes(v));
    if (!vals.length || bad.length)
      return `Invalid value for 'webhook_status[${f.op}]': expected ${WEBHOOK_STATUSES.join(", ")}`;
  }
  return null;
}

function webhookStatusMatches(f: ListFilter, value: string): boolean {
  const hit = webhookStatusValues(f).includes(value);
  return f.op === "is" || f.op === "in" ? hit : !hit;
}

function webhookStatusCondition(f: ListFilter): SQL {
  const vals = webhookStatusValues(f);
  return f.op === "is" || f.op === "in"
    ? inArray(webhookStatusExpr, vals)
    : sql`NOT ${inArray(webhookStatusExpr, vals)}`;
}

export const EVENT_FILTER_OPS = {
  ...opsFromSpecs(NATIVE_EVENT_FILTERS),
  [WEBHOOK_STATUS_FIELD]: WEBHOOK_STATUS_OPS,
};
export const EVENT_FILTER_KINDS = kindsFromSpecs(NATIVE_EVENT_FILTERS);

const IMPORTED_EVENT_FILTERS: Record<string, FilterSpec> = {
  id: { column: importedEvents.publicId, kind: "text" },
  type: { column: importedEvents.eventType, kind: "enum" },
  occurred_at: { column: importedEvents.occurredAt, kind: "date" },
};

/**
 * Fields only the native table can answer. Filtering on any of them scopes the
 * unified stream to native events — the imported side is left out of both reads.
 *
 * ⚠ `source` is here even though `imported_events` HAS a `source` column: that one
 * names the SYSTEM the row came from, while the serialized
 * `source` of an imported event is the source system's own value out of the payload
 * (`payload->>'source'`, falling back to `'imported'`). Same field name, different
 * meaning — matching them would silently answer a different question.
 */
const NATIVE_ONLY_FILTER_FIELDS = [
  "resource_type",
  "resource_id",
  "source",
  "actor",
  "trace_id",
  "api_version",
];

/** The unified stream only ever sorts on time; there is no sort control. */
export const EVENT_SORT_FIELDS = ["occurred_at"] as const;

export type EventWithStatus = typeof events.$inferSelect & { webhookStatus: string };

export interface EventListPage {
  data: EventWithStatus[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Worst-wins rollup of an event's per-endpoint delivery statuses (WH-4). */
function rollupStatus(statuses: string[]): string {
  if (statuses.length === 0) return "not_configured";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("pending")) return "pending";
  return "delivered";
}

/**
 * List events for an org (newest first) with `field[op]=value` filters + cursor
 * pagination. Ordered by (created_at DESC, id DESC) for a stable cursor.
 */
export async function listEventsFiltered(
  organizationId: string,
  filters: EventFilters,
): Promise<EventListPage> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  return withTenant(organizationId, async (tx) => {
    const conds = [];
    if (filters.businessId) conds.push(eq(events.businessId, filters.businessId));
    if (filters.types?.length) conds.push(inArray(events.type, filters.types));
    if (filters.resourceType) conds.push(eq(events.resourceType, filters.resourceType));
    if (filters.resourceId) conds.push(eq(events.resourceId, filters.resourceId));
    if (filters.customer)
      conds.push(ownedByCustomer(events.resourceId, filters.customer, filters.businessId));
    if (filters.source) conds.push(eq(events.source, filters.source));
    if (filters.occurredAfter) conds.push(gte(events.createdAt, filters.occurredAfter));
    if (filters.occurredBefore) conds.push(lte(events.createdAt, filters.occurredBefore));

    if (filters.startingAfter) {
      const [cursor] = await tx
        .select({ createdAt: events.createdAt, id: events.id })
        .from(events)
        .where(eq(events.publicId, filters.startingAfter))
        .limit(1);
      if (cursor) {
        conds.push(
          or(
            lt(events.createdAt, cursor.createdAt),
            and(eq(events.createdAt, cursor.createdAt), lt(events.id, cursor.id)),
          )!,
        );
      }
    }

    const rows = await tx
      .select()
      .from(events)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(events.createdAt), desc(events.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // WH-4: derive each event's webhook_status (worst delivery status wins).
    const ids = page.map((e) => e.id);
    const byEvent = new Map<string, string[]>();
    if (ids.length) {
      const drows = await tx
        .select({ eventId: webhookDeliveries.eventId, status: webhookDeliveries.status })
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.eventId, ids));
      for (const r of drows) byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), r.status]);
    }
    const data: EventWithStatus[] = page.map((e) => ({
      ...e,
      webhookStatus: rollupStatus(byEvent.get(e.id) ?? []),
    }));
    return { data, hasMore, nextCursor: hasMore ? data[data.length - 1]!.publicId : null };
  });
}

export type ImportedEventRow = typeof importedEvents.$inferSelect;

/**
 * `at` is a fixed-width, UTC-normalised, MICROSECOND-precision string sort key
 * (`to_char(… , 'YYYY-MM-DD HH24:MI:SS.US')`), not a JS `Date` — a `Date` only
 * holds milliseconds while Postgres `timestamptz` holds microseconds, so
 * sorting on `+date` silently disagreed with SQL's own ordering whenever rows
 * shared a millisecond (routine: an import batch, or one transaction emitting
 * several events). The string format sorts lexicographically = chronologically,
 * so `Array.prototype.sort` on it can't reintroduce that bug. Only used to
 * order/merge the two streams — every consumer that needs the real timestamp
 * reads it off `row.createdAt` / `row.occurredAt`.
 */
export type UnifiedEventRow =
  | { kind: "native"; at: string; row: EventWithStatus }
  | { kind: "imported"; at: string; row: ImportedEventRow };

export type UnifiedEventListPage = ListPage<UnifiedEventRow>;

/**
 * Unified event stream: native events + the imported source
 * history (`ievt_…` rows archived at migration) merged into ONE newest-first
 * list, so a migrated site's past reads like it happened here.
 *
 * Two fixes over the original merge (docs/PROGRESS.md, 2026-08-01):
 *  1. **Cursor seek** stays on the raw indexed column — the cursor row's
 *     timestamp is selected as `::text` and cast back to `::timestamptz`
 *     inside SQL (`keysetCondition`), so the WHERE clause never wraps the
 *     indexed column in a function.
 *  2. **Merge key** is the projected microsecond-precision string above,
 *     so the JS merge can no longer disagree with SQL's own ordering.
 *
 * Imported rows are archived source history, not live domain events: the only
 * things they can be filtered by are their id, their event type and their
 * occurrence instant. Any filter naming a native-only field — a legacy flat
 * `resource_type`/`resource_id`/`source` param, or `field[op]` on one of
 * `NATIVE_ONLY_FILTER_FIELDS` — scopes the list to native events only, in the page
 * read AND in `total`, so the count never promises rows the page cannot show.
 */
export async function listEventsUnified(
  organizationId: string,
  filters: EventFilters,
): Promise<UnifiedEventListPage> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const descending = filters.sortDesc ?? true;
  return withTenant(organizationId, async (tx) => {
    const tz = filters.businessId ? await businessTimezone(tx, filters.businessId) : "UTC";

    // ── Cursor: ONE lookup regardless of which table the anchor row lives in;
    // both branches below seek past the same (time, public id) pair. Selected
    // as `::text` — not the typed Date column — to keep full precision.
    const { keysetId } = parseCursor(filters.startingAfter);
    let cursor: { at: string; publicId: string } | null = null;
    if (keysetId) {
      if (keysetId.startsWith("ievt_")) {
        const [c] = await tx
          .select({
            at: sql<string>`${importedEvents.occurredAt}::text`,
            publicId: importedEvents.publicId,
          })
          .from(importedEvents)
          .where(eq(importedEvents.publicId, keysetId))
          .limit(1);
        cursor = c ?? null;
      } else {
        const [c] = await tx
          .select({ at: sql<string>`${events.createdAt}::text`, publicId: events.publicId })
          .from(events)
          .where(eq(events.publicId, keysetId))
          .limit(1);
        cursor = c ?? null;
      }
    }
    const cursorRow = cursor ? { sortValue: cursor.at, tiebreak: cursor.publicId } : undefined;

    // ── Native `events` conditions (filters only — the seek is added after `total`) ──
    const conds: SQL[] = [];
    if (filters.businessId) conds.push(eq(events.businessId, filters.businessId));
    if (filters.types?.length) conds.push(inArray(events.type, filters.types));
    if (filters.resourceType) conds.push(eq(events.resourceType, filters.resourceType));
    if (filters.resourceId) conds.push(eq(events.resourceId, filters.resourceId));
    if (filters.customer)
      conds.push(ownedByCustomer(events.resourceId, filters.customer, filters.businessId));
    if (filters.source) conds.push(eq(events.source, filters.source));
    if (filters.occurredAfter) conds.push(gte(events.createdAt, filters.occurredAfter));
    if (filters.occurredBefore) conds.push(lte(events.createdAt, filters.occurredBefore));
    const search = filters.search
      ? searchCondition(
          [
            events.publicId,
            events.type,
            events.resourceType,
            events.resourceId,
            events.source,
            events.actor,
          ],
          filters.search,
        )
      : undefined;
    if (search) conds.push(search);
    conds.push(...filterConditions(NATIVE_EVENT_FILTERS, filters.filters, tz));
    const statusFilters = (filters.filters ?? []).filter((f) => f.field === WEBHOOK_STATUS_FIELD);
    for (const f of statusFilters) conds.push(webhookStatusCondition(f));

    const filtersTargetNativeOnly =
      (filters.filters ?? []).some((f) => NATIVE_ONLY_FILTER_FIELDS.includes(f.field)) ||
      statusFilters.some((f) => !webhookStatusMatches(f, "not_configured"));
    const importedApplicable =
      !filters.resourceType &&
      !filters.resourceId &&
      // An imported row carries no resource pointer, so it can't be attributed to a
      // customer — same rule as `resource_id`, and it keeps `total` honest.
      !filters.customer &&
      !filters.source &&
      !filtersTargetNativeOnly;

    const iconds: SQL[] = [];
    if (importedApplicable) {
      if (filters.businessId) iconds.push(eq(importedEvents.businessId, filters.businessId));
      if (filters.types?.length) iconds.push(inArray(importedEvents.eventType, filters.types));
      if (filters.occurredAfter) iconds.push(gte(importedEvents.occurredAt, filters.occurredAfter));
      if (filters.occurredBefore)
        iconds.push(lte(importedEvents.occurredAt, filters.occurredBefore));
      const isearch = filters.search
        ? searchCondition([importedEvents.publicId, importedEvents.eventType], filters.search)
        : undefined;
      if (isearch) iconds.push(isearch);
      iconds.push(...filterConditions(IMPORTED_EVENT_FILTERS, filters.filters, tz));
    }

    // ── total (first page only — counts BOTH tables, docs/GUIDE.md §3.4) ────
    let total: number | null = null;
    if (!filters.startingAfter) {
      const nativeCount = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(events)
          .where(conds.length ? and(...conds) : undefined),
      );
      let importedCount = 0;
      if (importedApplicable) {
        importedCount = await cappedTotal(
          tx,
          tx
            .select({ one: sql`1` })
            .from(importedEvents)
            .where(iconds.length ? and(...iconds) : undefined),
        );
      }
      total = nativeCount + importedCount;
    }

    // ── seek (now that `total` is settled) + the page reads ─────────────────
    const nativeSeek = keysetCondition(events.createdAt, events.publicId, cursorRow, descending);
    if (nativeSeek) conds.push(nativeSeek);
    const NATIVE_SORT_KEY = sql<string>`to_char(${events.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
    const nativeRows = await tx
      .select({ ...getTableColumns(events), sortKey: NATIVE_SORT_KEY })
      .from(events)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(
        descending ? desc(events.createdAt) : asc(events.createdAt),
        descending ? desc(events.publicId) : asc(events.publicId),
      )
      .limit(limit + 1);

    let importedRows: Array<ImportedEventRow & { sortKey: string }> = [];
    if (importedApplicable) {
      const importedSeek = keysetCondition(
        importedEvents.occurredAt,
        importedEvents.publicId,
        cursorRow,
        descending,
      );
      if (importedSeek) iconds.push(importedSeek);
      const IMPORTED_SORT_KEY = sql<string>`to_char(${importedEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;
      importedRows = await tx
        .select({ ...getTableColumns(importedEvents), sortKey: IMPORTED_SORT_KEY })
        .from(importedEvents)
        .where(iconds.length ? and(...iconds) : undefined)
        .orderBy(
          descending ? desc(importedEvents.occurredAt) : asc(importedEvents.occurredAt),
          descending ? desc(importedEvents.publicId) : asc(importedEvents.publicId),
        )
        .limit(limit + 1);
    }

    const ids = nativeRows.map((e) => e.id);
    const byEvent = new Map<string, string[]>();
    if (ids.length) {
      const drows = await tx
        .select({ eventId: webhookDeliveries.eventId, status: webhookDeliveries.status })
        .from(webhookDeliveries)
        .where(inArray(webhookDeliveries.eventId, ids));
      for (const r of drows) byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), r.status]);
    }

    // Stable merge — deliberately does NOT re-derive a tiebreak in JS. Each of
    // `nativeRows`/`importedRows` already arrives from Postgres in the correct
    // (createdAt, publicId) order, using whatever collation the `public_id`
    // column actually has; a plain JS `<` on the id strings is NOT guaranteed to
    // agree with that collation (Postgres's default is locale-aware — e.g. it
    // ranked `TE3by…` ahead of `jF5Tck…` in one repro, the opposite of a byte
    // comparison), so re-comparing ids here silently reordered same-timestamp
    // rows and dropped/duplicated them across the page boundary. `Array.sort` is
    // spec-guaranteed stable, so returning 0 on a tie preserves each table's own
    // SQL-correct order — only the (rare) cross-table tie has no natural
    // tiebreak at all, and stability just means native wins it deterministically.
    const merged: UnifiedEventRow[] = [
      ...nativeRows.map((e): UnifiedEventRow => {
        const { sortKey, ...ev } = e;
        return {
          kind: "native",
          at: sortKey,
          row: { ...ev, webhookStatus: rollupStatus(byEvent.get(ev.id) ?? []) },
        };
      }),
      ...importedRows.map((e): UnifiedEventRow => {
        const { sortKey, ...ev } = e;
        return { kind: "imported", at: sortKey, row: ev };
      }),
    ].sort((a, b) => {
      if (a.at === b.at) return 0;
      return descending ? (a.at < b.at ? 1 : -1) : a.at < b.at ? -1 : 1;
    });

    const hasMore = merged.length > limit;
    const data = hasMore ? merged.slice(0, limit) : merged;
    return {
      data,
      hasMore,
      nextCursor: hasMore ? `k:${data[data.length - 1]!.row.publicId}` : null,
      ...cappedPageTotal(total),
    };
  });
}

/** Fetch one imported (ievt_…) event by public id. */
export async function getImportedEvent(
  organizationId: string,
  publicId: string,
  opts?: { businessId?: string },
): Promise<ImportedEventRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(importedEvents)
      .where(
        opts?.businessId
          ? and(
              eq(importedEvents.publicId, publicId),
              eq(importedEvents.businessId, opts.businessId),
            )
          : eq(importedEvents.publicId, publicId),
      )
      .limit(1);
    return row ?? null;
  });
}

export interface EventDeliveryView {
  endpoint: string; // whe_…
  endpointName: string | null; // endpoint description (rendered as the card heading)
  enabled: string; // 'true' | 'false'
  deliveryId: string; // webhook_deliveries.id — needed to redeliver from the event page
  url: string;
  status: string;
  attempts: number;
  lastResponseStatus: number | null;
  /** The receiver's reply on the last failed attempt, clipped (0278). */
  lastError: string | null;
  lastAttemptAt: Date | null;
  /**
   * When the delivery ROW was created — the only stable way to order attempts on one endpoint.
   * `lastAttemptAt` cannot do it: it is null on a row that has not been tried yet (a
   * circuit-broken endpoint, or a retry still waiting out its backoff), and the untried row is
   * usually the NEWEST one, so ordering on it puts the freshest attempt last.
   */
  createdAt: Date;
}

/** Fetch one event by public id + its webhook deliveries (status per endpoint). */
export async function getEventWithDeliveries(
  organizationId: string,
  eventPublicId: string,
  opts?: { businessId?: string },
): Promise<{ event: typeof events.$inferSelect; deliveries: EventDeliveryView[] } | null> {
  return withTenant(organizationId, async (tx) => {
    const [ev] = await tx
      .select()
      .from(events)
      .where(
        opts?.businessId
          ? and(eq(events.publicId, eventPublicId), eq(events.businessId, opts.businessId))
          : eq(events.publicId, eventPublicId),
      )
      .limit(1);
    if (!ev) return null;
    const rows = await tx
      .select({
        endpoint: webhookEndpoints.publicId,
        endpointName: webhookEndpoints.description,
        enabled: webhookEndpoints.enabled,
        deliveryId: webhookDeliveries.id,
        url: webhookEndpoints.url,
        status: webhookDeliveries.status,
        attempts: webhookDeliveries.attempts,
        lastResponseStatus: webhookDeliveries.lastResponseStatus,
        lastError: webhookDeliveries.lastError,
        lastAttemptAt: webhookDeliveries.lastAttemptAt,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookDeliveries.endpointId, webhookEndpoints.id))
      .where(eq(webhookDeliveries.eventId, ev.id));
    return { event: ev, deliveries: rows };
  });
}
