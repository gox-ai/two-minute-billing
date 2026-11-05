import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  bigint,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { subscriptions } from "./subscriptions";

/**
 * A future-dated subscription action the billing clock applies when due. Covers
 * scheduled cancel, pause, auto-resume, and plan/quantity change (§4). The
 * durable clock owns execution
 * (BLUEPRINT ADR-006), never an in-memory timer.
 */
export const scheduledChanges = pgTable(
  "scheduled_changes",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // sch_…
    type: text("type").notNull(), // cancel | pause | resume | change
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload"), // change: { changes: ItemChange[] }
    /**
     * Expected MRR movement when this change lands, positive = upgrade. Priced ONCE, at
     * schedule time — the payload alone would mean re-estimating every pending row on
     * every page load.
     *
     * GROSS and approximate by construction: no coupons or manual discounts, added and
     * repriced items rated from the catalog price of the moment rather than the snapshot
     * apply time will freeze, one-time and usage prices excluded, and never restated if
     * the subscription or the catalog moves before the change lands. Null for
     * cancel/pause/resume, which move no rate by scheduling.
     */
    mrrDeltaMinor: bigint("mrr_delta_minor", { mode: "bigint" }),
    // scheduled | applied | canceled | failed. `canceled` = the merchant withdrew it;
    // `failed` = the clock gave up after `attempts` hit its cap (see lastError).
    status: text("status").notNull().default("scheduled"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    // Retry accounting (0159). Without these a row whose apply threw stayed
    // `scheduled` and was re-tried every tick forever, with nothing recorded
    // anywhere — a scheduled cancel could silently never happen.
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("scheduled_changes_public_id_uq").on(t.publicId),
    // The clock scans by status + due time.
    index("scheduled_changes_due_idx").on(t.status, t.effectiveAt),
    index("scheduled_changes_sub_idx").on(t.subscriptionId),
  ],
);
