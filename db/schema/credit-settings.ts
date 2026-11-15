import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { products } from "./catalog";
import { users } from "./users";
import { creditUnits, creditGrants } from "./credits";

/** What happens to a negative balance that no invoice billed, when a plan's credits renew. */
export const NEGATIVE_AT_RESET = ["carry", "forgive"] as const;
export type NegativeAtReset = (typeof NEGATIVE_AT_RESET)[number];

/**
 * Policies of a credit unit for usage past its credits (0528). No row = no overage price and
 * `carry`. Unlike the rate, these are not locked by the first grant.
 */
export const creditUnitPolicies = pgTable(
  "credit_unit_policies",
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
    unitId: uuid("unit_id")
      .notNull()
      .references(() => creditUnits.id, { onDelete: "cascade" }),
    /** Money for one credit past the balance, minor units × 10^12. Null = none. */
    overageMinorPerUnitE12: bigint("overage_minor_per_unit_e12", { mode: "bigint" }),
    negativeAtReset: text("negative_at_reset").$type<NegativeAtReset>().notNull().default("carry"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [uniqueIndex("credit_unit_policies_unit_uq").on(t.unitId)],
);

/**
 * The overdraft limit of a credit unit, in its smallest step (0528): how far below 0 the
 * balance may go. Three layers, the most specific wins: a customer row, then a plan
 * (`product_id`) row, then the unit's own row (both NULL). None = 0.
 */
export const creditOverdraftLimits = pgTable(
  "credit_overdraft_limits",
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
    unitId: uuid("unit_id")
      .notNull()
      .references(() => creditUnits.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    limitSteps: bigint("limit_steps", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_overdraft_limits_unit_uq")
      .on(t.unitId)
      .where(sql`product_id IS NULL AND customer_id IS NULL`),
    uniqueIndex("credit_overdraft_limits_product_uq")
      .on(t.unitId, t.productId)
      .where(sql`product_id IS NOT NULL`),
    uniqueIndex("credit_overdraft_limits_customer_uq")
      .on(t.unitId, t.customerId)
      .where(sql`customer_id IS NOT NULL`),
    index("credit_overdraft_limits_customer_idx").on(t.customerId),
  ],
);

/** Why an operator voided credit (0529). A closed list; `other` needs a note. */
export const CREDIT_VOID_REASONS = [
  "customer_request",
  "fraud",
  "goodwill_reversal",
  "billing_error",
  "migration",
  "other",
] as const;
export type CreditVoidReason = (typeof CREDIT_VOID_REASONS)[number];

/** One row per voided grant, written in the void's transaction. Append-only. */
export const creditGrantVoidReasons = pgTable(
  "credit_grant_void_reasons",
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
    grantId: uuid("grant_id")
      .notNull()
      .references(() => creditGrants.id, { onDelete: "cascade" }),
    reason: text("reason").$type<CreditVoidReason>().notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [uniqueIndex("credit_grant_void_reasons_grant_uq").on(t.grantId)],
);
