import { sql } from "drizzle-orm";
import { pgTable, uuid, text, bigint, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { subscriptionItems, subscriptions } from "./subscriptions";
import { prices } from "./catalog";

/**
 * A metered usage event for a usage-model subscription item. Aggregated at period
 * close (sum/max/last) and rated into the invoice (billed in ARREARS, unlike
 * fixed recurring charges which bill in advance).
 *
 * `idempotencyKey` (optional) dedups repeated ingestion of the same event.
 */
export const usageRecords = pgTable(
  "usage_records",
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
    // Null once the item is removed. The record stays (an invoice line may have been rated
    // from it): the `subscription_items_detach_usage` trigger (0371) first copies the item's
    // subscription and price below. A whole-subscription delete still deletes its usage.
    subscriptionItemId: uuid("subscription_item_id").references(() => subscriptionItems.id, {
      onDelete: "set null",
    }),
    /** Set only on a detached record (0371); a live record reads it from its item. */
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    /** Set only on a detached record (0371); a live record reads it from its item. */
    priceId: uuid("price_id").references(() => prices.id, { onDelete: "set null" }),
    publicId: text("public_id").notNull(), // ur_…
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    // `unique` aggregation counts distinct values of this key in the window
    // (e.g. distinct active user ids). Null for plain quantity metrics.
    uniqueKey: text("unique_key"),
    /** add | remove (0379). `remove` takes `unique_key` off a `unique` metric. */
    operation: text("operation").notNull().default("add"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(), // when usage occurred
    idempotencyKey: text("idempotency_key"),
    /** Operator note (0305). Returned by the API only; never on a customer document. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("usage_records_public_id_uq").on(t.publicId),
    // Dedup repeated ingestion (nullable key → multiple NULLs allowed in Postgres).
    uniqueIndex("usage_records_idem_uq").on(t.subscriptionItemId, t.idempotencyKey),
    // The aggregation query scans by item + time window.
    index("usage_records_item_time_idx").on(t.subscriptionItemId, t.timestamp),
    index("usage_records_detached_sub_idx")
      .on(t.subscriptionId, t.timestamp)
      .where(sql`subscription_id IS NOT NULL`),
  ],
);
