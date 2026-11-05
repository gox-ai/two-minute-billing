import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { ownedByCustomer } from "@/modules/events/resource-scope";
import { currentEventContext } from "@/platform/event-context";
import { businessTimezone } from "@/platform/business-tz";
import {
  clampLimit,
  filterConditions,
  keysetCondition,
  opsFromSpecs,
  pageOrder,
  parseCursor,
  isUuidCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
  cappedTotal,
} from "@/platform/list-query";
import { getTraceId } from "@/platform/trace";
import { auditLogs, auditLogSnapshots, businesses } from "@db/schema";
import { auditSnapshot, changedFields } from "./snapshot";
import { createLogger } from "@/platform/logger";

const log = createLogger("audit");

/**
 * H2 (LOG-3): write one append-only audit row. Actor + source are taken from the
 * request/job EventContext (same provenance as events) unless overridden. `before`
 * / `after` should carry ONLY the changed fields (a diff), not whole rows.
 *
 * Pass a `tx` to join the caller's transaction (so the audit row commits atomically
 * with the state change it records); omit it to write in its own tenant tx.
 *
 * `beforeFull` / `afterFull` (0149) are the OPTIONAL full record bodies, stored in
 * `audit_log_snapshots` so the reader can see the change in the context of the
 * whole record ("Show Diff") and see a creation as a snapshot rather
 * than a half-empty diff ("Show Content"). Omit them and the row still works
 * exactly as before — the diff simply has no surrounding context.
 */
export async function writeAuditLog(
  input: {
    organizationId: string;
    businessId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    before?: unknown;
    after?: unknown;
    /**
     * The whole record as it was, or `null`/omitted when it did not exist yet.
     * Passing `null` EXPLICITLY is how a creation is recorded: it makes the
     * snapshot row exist with a null before-side, which is what tells the reader
     * "this record was created" rather than "no snapshot was captured".
     */
    beforeFull?: unknown;
    /** The whole record as it is now, or `null` when it was deleted. */
    afterFull?: unknown;
    actor?: string | null;
    source?: string | null;
    /**
     * P4: overrides the ambient request IP. Callers virtually never pass this —
     * it exists for the verify suites. Note the deliberate asymmetry with
     * actor/source: those fall back to the string 'system', the IP falls back to
     * NULL, because "no request" has an honest representation for an address and
     * an invented one would be a claim about an origin.
     */
    ip?: string | null;
  },
  tx?: Tx,
): Promise<void> {
  const ctx = currentEventContext();
  const row = {
    organizationId: input.organizationId,
    businessId: input.businessId ?? null,
    actor: input.actor ?? ctx?.actor ?? "system",
    source: input.source ?? ctx?.source ?? "system",
    action: input.action,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    actorIp: input.ip ?? ctx?.ip ?? null,
    // 0149: groups the rows one action wrote across several resources. Derived from
    // the ambient trace for the same reason actor/source are — a parameter every
    // call site had to remember would be blank on the one that forgot.
    traceId: getTraceId() ?? null,
  };
  // A snapshot is written only when the caller captured one. `'beforeFull' in input`
  // rather than a truthiness test: `beforeFull: null` is the meaningful "did not
  // exist yet" case and must still produce a row.
  const hasSnapshot = "beforeFull" in input || "afterFull" in input;
  const write = async (t: Tx) => {
    const [written] = await t.insert(auditLogs).values(row).returning({ id: auditLogs.id });
    if (!hasSnapshot || !written) return;
    await t.insert(auditLogSnapshots).values({
      auditId: written.id,
      organizationId: input.organizationId,
      beforeFull: input.beforeFull ?? null,
      afterFull: input.afterFull ?? null,
    });
  };
  if (tx) {
    await write(tx);
    return;
  }
  await withTenant(input.organizationId, write);
}

/** Columns every UPDATE moves (trigger-bumped); a diff of only these is no change. */
const BOOKKEEPING = new Set(["updated_at", "resource_version"]);

/**
 * Audit one row's create / update / archive from its before and after states: the
 * snapshots and the changed-field diff are derived here so call sites cannot drift.
 * `before: null` records a creation. An update that moved nothing but bookkeeping
 * columns writes no row.
 */
export async function auditRowChange(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
    /** Merged into both snapshots (e.g. a coupon's code as `id`). */
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const afterFull = auditSnapshot(input.after, input.extra);
  if (input.before === null) {
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        after: afterFull,
        beforeFull: null,
        afterFull,
      },
      tx,
    );
    return;
  }
  const beforeFull = auditSnapshot(input.before, input.extra);
  const changed = changedFields(beforeFull, afterFull);
  const moved = [...Object.keys(changed.before), ...Object.keys(changed.after)];
  if (moved.every((k) => BOOKKEEPING.has(k))) return;
  await writeAuditLog(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: changed.before,
      after: changed.after,
      beforeFull,
      afterFull,
    },
    tx,
  );
}

/**
 * GDPR erasure hook (0149). Drops the snapshot BODIES for one resource's audit
 * rows; the audit rows themselves are untouched and untouchable.
 *
 * Called by `clearPersonalData`, because a full customer snapshot carries name,
 * email and billing address. This is the only DELETE anywhere in the audit schema
 * and the reason `audit_log_snapshots` is a separate table at all: `audit_logs`
 * grants no DELETE, so a snapshot stored there could never have been erased.
 *
 * Returns how many were dropped so the caller can record it — an erasure that
 * silently found nothing is indistinguishable from one that failed.
 */
export async function eraseAuditSnapshotsForResource(
  organizationId: string,
  resourceType: string,
  resourceId: string,
  tx?: Tx,
): Promise<number> {
  const run = async (t: Tx) => {
    const dropped = await t
      .delete(auditLogSnapshots)
      .where(
        sql`${auditLogSnapshots.auditId} IN (
          SELECT id FROM audit_logs
          WHERE resource_type = ${resourceType} AND resource_id = ${resourceId}
        )`,
      )
      .returning({ auditId: auditLogSnapshots.auditId });
    // Erasure is the one operation that REMOVES audit evidence (GDPR deletion).
    // The audit log can no longer be its own witness here, so the log line is.
    log.warn("audit snapshots erased", { resourceType, resourceId, dropped: dropped.length });
    return dropped.length;
  };
  if (tx) return run(tx);
  return withTenant(organizationId, run);
}

/**
 * uuid → public id for a set of businesses, for the org-level audit list.
 *
 * The list spans businesses, so each row has to name its own — and it is the PUBLIC
 * id that is useful: it addresses the business over the API and it is the path
 * segment the dashboard's business-scoped routes take, so a row can link straight to
 * its record page. Resolved in one query for the whole page rather than joined into
 * `listAuditLogsPage`, which three other screens share and which does not otherwise
 * need a join. Empty input short-circuits — `inArray(x, [])` is invalid SQL.
 */
export async function businessPublicIds(
  organizationId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ id: businesses.id, publicId: businesses.publicId })
      .from(businesses)
      .where(inArray(businesses.id, ids));
    return new Map(rows.map((r) => [r.id, r.publicId]));
  });
}

/** One resource's slice of an audit record: the row, plus its snapshot bodies. */
export interface AuditBlock {
  row: typeof auditLogs.$inferSelect;
  /**
   * 'available' — both sides captured, render the contextual diff.
   * 'created'   — the snapshot exists with a NULL before-side: the record did not
   *               exist yet, so this is a creation and reads as a single-column
   *               snapshot, not a diff against nothing.
   * 'none'      — no snapshot row: either the action never captured one, or GDPR
   *               erasure dropped it. Deliberately NOT split into two: we cannot
   *               tell them apart, and guessing which would put a claim on screen
   *               that the data does not support. The erasure writes its own audit
   *               row, so the reason is visible in the log itself.
   */
  snapshot: "available" | "created" | "none";
  beforeFull: unknown;
  afterFull: unknown;
}

/**
 * One audit RECORD — every resource that one action changed (0149).
 *
 * The unit of audit is the ACTION, not the row: activating a subscription
 * is a single record holding the subscription that changed AND the invoice it
 * raised, and it appears on both records' Activity Log. We write a row per
 * resource, so the record is the set of rows sharing a `trace_id`.
 *
 * `blocks` is ordered oldest-first (the order the action touched things), except
 * that the block matching `source` — the resource whose page you came from — is
 * hoisted to the front, per the `?source=` parameter. The reader's own
 * record should lead; the rest is what else the action did.
 *
 * A row with a NULL trace (written before 0149, or outside any trace context) is a
 * record of exactly one block. It never merges with anything, which is the correct
 * degradation — merging on a null key would fuse unrelated actions.
 */
export interface AuditRecord {
  id: string;
  traceId: string | null;
  occurredAt: Date;
  actor: string;
  source: string;
  actorIp: string | null;
  blocks: AuditBlock[];
}

export async function getAuditRecord(
  organizationId: string,
  businessId: string,
  id: string,
  sourceResourceType?: string,
): Promise<AuditRecord | null> {
  if (!isUuidCursor(id)) return null;
  return withTenant(organizationId, async (tx) => {
    const [primary] = await tx
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.id, id), eq(auditLogs.businessId, businessId)))
      .limit(1);
    if (!primary) return null;

    // Same business as well as same trace: a trace can legitimately span businesses
    // (an org-level admin action), and a manager of business A must not see B's rows
    // just because one execution touched both.
    const rows = primary.traceId
      ? await tx
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.traceId, primary.traceId), eq(auditLogs.businessId, businessId)))
          .orderBy(auditLogs.createdAt)
      : [primary];

    const snaps = await tx
      .select()
      .from(auditLogSnapshots)
      .where(
        inArray(
          auditLogSnapshots.auditId,
          rows.map((r) => r.id),
        ),
      );
    const byId = new Map(snaps.map((s) => [s.auditId, s]));

    const blocks: AuditBlock[] = rows.map((row) => {
      const s = byId.get(row.id);
      return {
        row,
        snapshot: !s ? "none" : s.beforeFull === null ? "created" : "available",
        beforeFull: s?.beforeFull ?? null,
        afterFull: s?.afterFull ?? null,
      };
    });
    // Hoist the caller's own resource, preserving the rest of the order.
    if (sourceResourceType) {
      const i = blocks.findIndex((b) => b.row.resourceType === sourceResourceType);
      if (i > 0) blocks.unshift(...blocks.splice(i, 1));
    }

    return {
      id: primary.id,
      traceId: primary.traceId,
      // The action's time is when it STARTED — the first row it wrote. The blocks
      // are milliseconds apart (one transaction), but leading with the primary
      // row's own time would make the same record show two different times
      // depending on which page you opened it from.
      occurredAt: rows[0]!.createdAt,
      actor: primary.actor,
      source: primary.source,
      actorIp: primary.actorIp ?? null,
      blocks,
    };
  });
}

export interface AuditLogFilters {
  businessId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  /** One customer's whole footprint — see `EventFilters.customer`. A public id. */
  customer?: string;
  actor?: string;
  limit?: number;
  before?: Date; // cursor: created_at strictly before this
  /**
   * Post-H (#9): mode gate for the org-level read — 'test' | 'live'. Only rows whose
   * business matches this livemode (plus org-global rows with no business) are
   * returned, so a test key can't read LIVE businesses' settings/void/cancel history.
   * Omit (or pass 'all') to see every mode.
   */
  livemode?: string;
}

/** List audit rows (newest first) with simple filters + created_at cursor. */
export async function listAuditLogs(
  organizationId: string,
  filters: AuditLogFilters = {},
): Promise<Array<typeof auditLogs.$inferSelect>> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  return withTenant(organizationId, async (tx) => {
    const conds = [];
    if (filters.businessId) conds.push(eq(auditLogs.businessId, filters.businessId));
    if (filters.action) conds.push(eq(auditLogs.action, filters.action));
    if (filters.resourceType) conds.push(eq(auditLogs.resourceType, filters.resourceType));
    if (filters.resourceId) conds.push(eq(auditLogs.resourceId, filters.resourceId));
    if (filters.customer)
      conds.push(ownedByCustomer(auditLogs.resourceId, filters.customer, filters.businessId));
    if (filters.actor) conds.push(eq(auditLogs.actor, filters.actor));
    if (filters.before) conds.push(lt(auditLogs.createdAt, filters.before));
    // Post-H (#9): mode gate — business rows must match the key's livemode; org-global
    // rows (no business) are always visible. RLS already scopes to the org.
    if (filters.livemode && filters.livemode !== "all") {
      conds.push(
        sql`(${auditLogs.businessId} IS NULL OR ${auditLogs.businessId} IN (SELECT id FROM businesses WHERE livemode = ${filters.livemode}))`,
      );
    }
    return tx
      .select()
      .from(auditLogs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
  });
}

// ── Paginated list (see docs/GUIDE.md §3.4 for the shared contract) ────────────
// LOG-4: cursor pagination for the API read routes, mirroring
// `listCustomersPage` (src/modules/customers/service.ts) — `listAuditLogs`
// above stays as-is for internal (unpaginated) callers (scripts, verify).

/**
 * Action prefixes of the security trail: credentials, access and data leaving the system.
 * `category[is]=security` on the list routes matches exactly these.
 */
export const SECURITY_ACTION_PREFIXES = [
  "api_key.",
  "webhook_endpoint.",
  "gateway_account.",
  "integration.",
  "mail_transport.",
  "team.",
  "role.",
  "organization.two_factor.",
  "data.export",
] as const;

/** `security` | `other`, derived from the action. A virtual column, so every enum op works. */
const categoryColumn = sql`(CASE WHEN ${sql.join(
  SECURITY_ACTION_PREFIXES.map((p) => sql`starts_with(${auditLogs.action}, ${p})`),
  sql` OR `,
)} THEN 'security' ELSE 'other' END)`;

/** Filterable columns, keyed by their public (API) name. */
const FILTERS: Record<string, FilterSpec> = {
  category: { column: categoryColumn, kind: "enum" },
  action: { column: auditLogs.action, kind: "text" },
  actor: { column: auditLogs.actor, kind: "text" },
  resource_type: { column: auditLogs.resourceType, kind: "text" },
  resource_id: { column: auditLogs.resourceId, kind: "text" },
  created_at: { column: auditLogs.createdAt, kind: "date" },
};

/** field → operators it accepts; the route validates the request against this. */
export const AUDIT_FILTER_OPS: Record<string, readonly string[]> = opsFromSpecs(FILTERS);

/** Sortable columns. `created_at` is the only sort — always the indexed keyset path. */
const SORTS = { created_at: auditLogs.createdAt } as const;
export type AuditSortField = keyof typeof SORTS;
export const AUDIT_SORT_FIELDS = Object.keys(SORTS) as AuditSortField[];

export interface AuditLogPageFilters {
  businessId?: string;
  /** One customer's whole footprint — see `EventFilters.customer`. A public id. */
  customer?: string;
  /** Post-H (#9): mode gate — see `listAuditLogs`'s `livemode`. Org-level route only. */
  livemode?: string;
  search?: string;
  filters?: ListFilter[];
  sortField?: string;
  sortDesc?: boolean;
  startingAfter?: string;
  limit?: number;
}

/**
 * One page of audit rows — what the API list routes serve. Keyset on
 * `(created_at, id)` (audit rows have no public id; the uuid PK is a fine
 * tiebreak — it only needs to be unique and deterministic, not sequential).
 * `total` is the filtered count, computed for the first page only.
 */
export async function listAuditLogsPage(
  organizationId: string,
  f: AuditLogPageFilters = {},
): Promise<ListPage<typeof auditLogs.$inferSelect>> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? true;

  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [];
    if (f.businessId) conds.push(eq(auditLogs.businessId, f.businessId));
    if (f.customer) conds.push(ownedByCustomer(auditLogs.resourceId, f.customer, f.businessId));
    // Date filters bucket by the BUSINESS day for a business-scoped list; the
    // org-level list spans businesses and has no single zone (business-tz.ts).
    const tz = f.businessId ? await businessTimezone(tx, f.businessId) : "UTC";
    conds.push(...filterConditions(FILTERS, f.filters, tz));
    const search = searchCondition(
      [auditLogs.action, auditLogs.actor, auditLogs.resourceType, auditLogs.resourceId],
      f.search,
    );
    if (search) conds.push(search);
    // Post-H (#9): mode gate — business rows must match the key's livemode; org-global
    // rows (no business) are always visible. RLS already scopes to the org.
    if (f.livemode && f.livemode !== "all") {
      conds.push(
        sql`(${auditLogs.businessId} IS NULL OR ${auditLogs.businessId} IN (SELECT id FROM businesses WHERE livemode = ${f.livemode}))`,
      );
    }

    // The total covers the filtered set, before the cursor narrows it.
    const filterWhere = conds.length ? and(...conds)! : sql`true`;
    let total: number | null = null;
    if (!f.startingAfter) {
      total = await cappedTotal(
        tx,
        tx
          .select({ one: sql`1` })
          .from(auditLogs)
          .where(filterWhere),
      );
    }

    const pageConds = [...conds];
    const { keysetId } = parseCursor(f.startingAfter);
    // A non-uuid keyset id would make Postgres throw 22P02 on the lookup
    // below (these tables tiebreak on the raw uuid PK, not a public id),
    // which surfaced as a 500. Ignoring it degrades to the first page.
    if (keysetId && isUuidCursor(keysetId)) {
      const [cursor] = await tx
        // `::text`, not the typed column: a typed timestamptz comes back as a JS
        // Date and loses microseconds, which drops same-millisecond rows from the
        // next page. See keysetCondition.
        .select({ createdAt: sql<string>`${auditLogs.createdAt}::text`, id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.id, keysetId))
        .limit(1);
      const seek = keysetCondition(
        auditLogs.createdAt,
        auditLogs.id,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.id } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      .select()
      .from(auditLogs)
      .where(pageConds.length ? and(...pageConds) : undefined)
      .orderBy(
        ...pageOrder(
          SORTS[(f.sortField as AuditSortField) ?? "created_at"],
          auditLogs.id,
          descending,
          true,
        ),
      )
      .limit(limit + 1);

    return toPage(rows, limit, { keyset: true, offset: 0, keyOf: (r) => r.id, total });
  });
}
