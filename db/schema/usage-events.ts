import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  integer,
  boolean,
  jsonb,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { subscriptions } from "./subscriptions";
import { meters } from "./meters";

/** The app's own key for a customer (0450). A key maps to one customer; a customer has many. */
export const customerUsageKeys = pgTable(
  "customer_usage_keys",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Set when the key is attached; the fold pass matches the stored unmatched events. */
    matchPending: boolean("match_pending").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("customer_usage_keys_business_key_uq").on(t.businessId, t.key),
    index("customer_usage_keys_customer_idx").on(t.customerId),
    index("customer_usage_keys_match_pending_idx")
      .on(t.businessId)
      .where(sql`match_pending`),
  ],
);

/**
 * Usage ingest requests per organization per 1-second window (0450). One limit for every key
 * of the org. Upserted in its own statement, never inside the ingest transaction.
 */
export const ingestRateCounters = pgTable(
  "ingest_rate_counters",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.windowStart] }),
    index("ingest_rate_counters_window_idx").on(t.windowStart),
  ],
);

/**
 * Usage events (0451). The parent of a table range-partitioned by `timestamp`, one partition
 * per UTC month (`usage_events_yYYYYmMM`, made by `usage_create_partition`). No default
 * partition and no foreign keys. `id` is uuid_v7 at insert, so id order is receive order.
 * Dedup is in `usageEventDedup`. Values are unconstrained numeric (strings here).
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .notNull(),
    organizationId: uuid("organization_id").notNull(),
    businessId: uuid("business_id").notNull(),
    /** Null = unmatched: no customer holds `customerKey` yet. */
    customerId: uuid("customer_id"),
    customerKey: text("customer_key").notNull(),
    eventName: text("event_name").notNull(),
    properties: jsonb("properties")
      .$type<Record<string, string | number | boolean>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    /** The per-event idempotency key. */
    key: text("key").notNull(),
    /** Major units. */
    amount: numeric("amount"),
    /** Major units. */
    cost: numeric("cost"),
    currency: char("currency", { length: 3 }),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    primaryKey({ name: "usage_events_pkey", columns: [t.id, t.timestamp] }),
    index("usage_events_customer_event_time_idx").on(
      t.businessId,
      t.customerId,
      t.eventName,
      t.timestamp,
    ),
    index("usage_events_business_key_idx").on(t.businessId, t.key),
    index("usage_events_unmatched_idx")
      .on(t.businessId, t.customerKey)
      .where(sql`customer_id IS NULL`),
    // Only events matched after ingest (late detection reads them by match time).
    index("usage_events_late_match_idx")
      .on(t.businessId, t.customerId, t.matchedAt)
      .where(sql`matched_at IS NOT NULL`),
  ],
);

/** Event dedup by (business, key), no timestamp (0451). Kept 35 days. Insert-only for the app. */
export const usageEventDedup = pgTable(
  "usage_event_dedup",
  {
    organizationId: uuid("organization_id").notNull(),
    businessId: uuid("business_id").notNull(),
    key: text("key").notNull(),
    eventId: uuid("event_id").notNull(),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: "usage_event_dedup_pkey", columns: [t.businessId, t.key] }),
    index("usage_event_dedup_created_idx").on(t.createdAt),
  ],
);

/** One row per archived event partition (0451). Platform table: no RLS, no app-role privilege. */
export const usageArchives = pgTable(
  "usage_archives",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    partitionName: text("partition_name").notNull(),
    month: date("month").notNull(),
    rowCount: bigint("row_count", { mode: "bigint" }).notNull(),
    byteCount: bigint("byte_count", { mode: "bigint" }).notNull(),
    sha256: text("sha256").notNull(),
    objectKey: text("object_key").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).defaultNow().notNull(),
    droppedAt: timestamp("dropped_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("usage_archives_partition_uq").on(t.partitionName)],
);

/**
 * 15-minute usage buckets per customer, meter, group values and currency (0452). The parent of
 * a table range-partitioned by `bucket_start`, monthly. Derived from events by the fold pass.
 */
export const usageRollups = pgTable(
  "usage_rollups",
  {
    organizationId: uuid("organization_id").notNull(),
    businessId: uuid("business_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    meterId: uuid("meter_id").notNull(),
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    /** In the meter's `group_by` order. */
    groupValues: text("group_values")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The events' currency; '' = none sent (bills in the price's currency). */
    currency: text("currency").notNull().default(""),
    /** `customer_meter_billing.generation` at fold time. */
    generation: bigint("generation", { mode: "bigint" }).notNull(),
    eventCount: bigint("event_count", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    valueSum: numeric("value_sum").notNull().default("0"),
    valueMin: numeric("value_min"),
    valueMax: numeric("value_max"),
    lastValue: numeric("last_value"),
    lastAt: timestamp("last_at", { withTimezone: true }),
    lastEventId: uuid("last_event_id"),
    amountSum: numeric("amount_sum").notNull().default("0"),
    costSum: numeric("cost_sum").notNull().default("0"),
    /** Quantity of events with no cost, so an absent cost never reads as 0. */
    uncostedQuantity: numeric("uncosted_quantity").notNull().default("0"),
  },
  (t) => [
    primaryKey({
      name: "usage_rollups_pkey",
      columns: [t.customerId, t.meterId, t.bucketStart, t.groupValues, t.currency, t.generation],
    }),
  ],
);

/** Fold progress per business (0452): events received before `watermark` are in the rollups. */
export const usageRollupState = pgTable("usage_rollup_state", {
  businessId: uuid("business_id")
    .primaryKey()
    .references(() => businesses.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  watermark: timestamp("watermark", { withTimezone: true }).notNull(),
  /** Set from usage_rollup_version_seq by every change to the business's rollups (0468): the rollup read cache key. */
  rollupVersion: bigint("rollup_version", { mode: "bigint" })
    .notNull()
    .default(sql`0`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Recurring meters: the level at each cutoff (0452). The next window carries in from it. */
export const usageMeterLevels = pgTable(
  "usage_meter_levels",
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
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
    groupValues: text("group_values")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    at: timestamp("at", { withTimezone: true }).notNull(),
    level: numeric("level").notNull(),
    /** `unique` meters only: the distinct values active at `at`. */
    activeKeys: text("active_keys").array(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("usage_meter_levels_point_uq").on(t.customerId, t.meterId, t.groupValues, t.at),
    index("usage_meter_levels_meter_idx").on(t.meterId),
  ],
);

/**
 * The one live subscription that bills a meter for a customer, and its billing pointer (0454).
 * `subscriptionId` null = no owner (usage kept, shown as not billed).
 */
export const customerMeterBilling = pgTable(
  "customer_meter_billing",
  {
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    /** Rollups are written at this generation; a cutoff reads it and moves it on by one. */
    generation: bigint("generation", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Exact end of the last billed window. */
    usageThrough: timestamp("usage_through", { withTimezone: true }),
    cutoffGeneration: bigint("cutoff_generation", { mode: "bigint" }),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    primaryKey({ name: "customer_meter_billing_pkey", columns: [t.customerId, t.meterId] }),
    index("customer_meter_billing_subscription_idx")
      .on(t.subscriptionId)
      .where(sql`subscription_id IS NOT NULL`),
    index("customer_meter_billing_meter_idx").on(t.meterId),
  ],
);
