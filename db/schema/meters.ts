import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";

/**
 * What to count from usage events (0450). A read-time view: events are never linked to a meter
 * at ingest, so a meter created later still counts every retained event (backfill).
 * `key` is the catalog-family slug id: unique per business, immutable.
 */
export const meters = pgTable(
  "meters",
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
    key: text("key").notNull(),
    name: text("name").notNull(),
    eventName: text("event_name").notNull(),
    /** sum | count | min | max | avg | last | unique | weighted_sum */
    aggregation: text("aggregation").notNull(),
    valueProperty: text("value_property"),
    /** `unique` only. */
    uniqueProperty: text("unique_property"),
    /** sum, last, max, unique only. */
    recurring: boolean("recurring").notNull().default(false),
    /** `weighted_sum` only: hour | day. */
    timeUnit: text("time_unit"),
    /** {property: [values…]}: an event counts only when every listed property has one of them. */
    filters: jsonb("filters")
      .$type<Record<string, Array<string | number | boolean>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** ≤ 5 property names, ordered; rollup group values follow this order. */
    groupBy: text("group_by")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** 0475: ≤ 3 properties a spend limit may be scoped by; rollups group by these too. */
    limitDimensions: text("limit_dimensions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** active | archived */
    status: text("status").notNull().default("active"),
    /** The business fold watermark at create; older events are backfilled for this meter. */
    foldedFrom: timestamp("folded_from", { withTimezone: true }),
    /** Set once the backfill is done; until then reads of this meter go raw. */
    backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
    /** 0457: maps the meter to a model price list key. NULL = not mapped. */
    priceList: jsonb("price_list").$type<{
      provider?: string;
      provider_key?: string;
      model_key?: string;
      token_type?: string;
      token_type_key?: string;
    }>(),
    /** 0457: currency of event cost for events that name none. NULL = the price's currency. */
    costCurrency: char("cost_currency", { length: 3 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("meters_business_key_uq").on(t.businessId, t.key),
    index("meters_business_event_active_idx")
      .on(t.businessId, t.eventName)
      .where(sql`status = 'active'`),
  ],
);
