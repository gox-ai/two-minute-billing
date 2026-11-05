import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, index, inet } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * H2 (LOG-3): the audit log — WHO did WHAT (events record what happened to the
 * domain; audit records the actor + a changed-field diff, including read-sensitive
 * ops like key rotation and no-op-visible ones like settings changes).
 *
 * APPEND-ONLY: the RLS migration grants SELECT + INSERT only (no UPDATE/DELETE),
 * so a row can never be altered or removed. Read-scoped by organization_id.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(), // api key public id / portal user / 'billing_clock' / 'system'
    source: text("source").notNull(), // api | dashboard | scheduled_job | migration | system
    /**
     * P4: the IP address the actor acted from. `inet` (validated +
     * subnet-queryable, migration 0142) and
     * NULLABLE with no default: the billing clock, the importer, seeds and the
     * verify suites have no request behind them, and a placeholder would claim an
     * origin that never existed. Resolved once per request in
     * `src/platform/event-context.ts` and carried on the ambient EventContext, so
     * no service function has to forward it.
     */
    actorIp: inet("actor_ip"),
    action: text("action").notNull(), // 'invoice.void', 'price.update', 'business.settings_update', …
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    before: jsonb("before"), // changed-field diff only (prior values)
    after: jsonb("after"), // changed-field diff only (new values)
    /**
     * The execution that produced this row (migration 0149) — the ambient
     * `getTraceId()`, the same value `events.trace_id` and
     * `gateway_request_logs.trace_id` carry.
     *
     * ONE action can change several resources: activating a subscription changes
     * the subscription AND raises an invoice. We write a row per resource, so the
     * trace is what groups them back into one record — and it makes "the events of
     * this same act" an exact join rather than the ±60s created_at window the
     * Activity Log card used to pair on.
     *
     * NULL for rows written before 0149 and for any path outside a trace context;
     * a NULL trace groups with nothing, which is the safe degradation (a row shows
     * alone rather than merging into someone else's action).
     */
    traceId: text("trace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("audit_logs_org_idx").on(t.organizationId, t.createdAt),
    index("audit_logs_resource_idx").on(t.businessId, t.resourceType, t.resourceId),
    index("audit_logs_trace_idx").on(t.organizationId, t.traceId),
  ],
);

/**
 * The full before/after record bodies for one audit row (migration 0149).
 *
 * "Show Diff" renders the WHOLE record on both sides with unchanged fields as
 * context, and "Show Content" renders the full snapshot of a record that was just
 * created. `audit_logs.before/after` are changed-field maps, so neither view could
 * be reconstructed from them.
 *
 * SEPARATE TABLE ON PURPOSE. `audit_logs` is append-only by GRANT (SELECT + INSERT
 * only), and a full customer snapshot carries name, email and billing address —
 * which `clearPersonalData` would then be structurally unable to erase. Here DELETE
 * is granted (and UPDATE still is not), so:
 *   - the audit RECORD stays immutable: who, what, when, from where, fields moved;
 *   - the snapshot BODY can be dropped by GDPR erasure.
 * After an erasure the diff falls back to changed-fields-only and says the snapshot
 * was erased — it never renders as an empty record.
 */
export const auditLogSnapshots = pgTable("audit_log_snapshots", {
  auditId: uuid("audit_id")
    .primaryKey()
    .references(() => auditLogs.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * NULL means the resource did not exist yet — that is what makes the reader see
   * a single-column "content" view of a creation instead of a half-empty diff. It
   * is NOT the same as the row being absent, which means "no snapshot recorded or
   * it was erased".
   */
  beforeFull: jsonb("before_full"),
  afterFull: jsonb("after_full"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
