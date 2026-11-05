import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";
import { subscriptions } from "./subscriptions";

/**
 * A coupon definition (business-scoped). Either percentage-off (basis points) or
 * a fixed amount-off in a currency. Duration controls how many invoices it
 * applies to: once | forever | repeating (N periods).
 */
export const coupons = pgTable(
  "coupons",
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
    // The coupon id IS the code (e.g. 'SAVE10'): slug and code are one field.
    code: text("code").notNull(),
    name: text("name"),
    kind: text("kind").notNull(), // percentage | fixed_amount
    percentOffBps: integer("percent_off_bps"), // e.g. 2000 = 20%
    amountOffMinor: bigint("amount_off_minor", { mode: "bigint" }),
    currency: char("currency", { length: 3 }), // for fixed_amount
    // CAT-2: how the discount is scoped. invoice_amount = whole invoice subtotal
    // (running-reduced, proportional tax); each_specified_item = only the lines
    // matched by `coupon_item_constraints`, discounted per-line (line-accurate tax).
    applyOn: text("apply_on").notNull().default("invoice_amount"), // invoice_amount | each_specified_item
    durationType: text("duration_type").notNull().default("once"), // once | forever | repeating
    durationInPeriods: integer("duration_in_periods"), // for repeating
    maxRedemptions: integer("max_redemptions"),
    // Cap on redemptions by ONE customer, across their subscriptions (0302). Null = no cap.
    maxRedemptionsPerCustomer: integer("max_redemptions_per_customer"),
    timesRedeemed: integer("times_redeemed").notNull().default(0),
    redeemBy: timestamp("redeem_by", { withTimezone: true }),
    // CAT-5: coupon becomes applicable at valid_from (null = immediately).
    validFrom: timestamp("valid_from", { withTimezone: true }),
    // CAT-5: label shown on the invoice's discount line (falls back to code/name).
    invoiceName: text("invoice_name"),
    // Free-form annotations; imported rows carry { source, source_id }.
    metadata: jsonb("metadata"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    // code IS the id — unique per business.
    uniqueIndex("coupons_code_uq").on(t.businessId, t.code),
  ],
);

/**
 * CAT-2: per-item-kind scoping for a coupon. One row
 * per item kind (plan | addon | charge). `constraint_type`:
 *   - `all`      → every product of that kind is eligible
 *   - `specific` → only the products in `product_ids` (product slug ids)
 *   - `none`     → no product of that kind (the default when no row exists)
 * A coupon with `apply_on='each_specified_item'` discounts only the invoice lines
 * whose product matches one of these rows. `invoice_amount` coupons ignore them.
 */
export const couponItemConstraints = pgTable(
  "coupon_item_constraints",
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
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    itemKind: text("item_kind").notNull(), // plan | addon | charge
    constraintType: text("constraint_type").notNull(), // all | specific | none
    productIds: jsonb("product_ids"), // string[] of product slug ids (for 'specific')
    priceIds: jsonb("price_ids"), // 0315: string[] of price slug ids (for 'specific')
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("coupon_item_constraints_uq").on(t.couponId, t.itemKind),
    index("coupon_item_constraints_coupon_idx").on(t.couponId),
  ],
);

/**
 * A coupon set: a bag of many unique, single-use redemption codes that all inherit
 * one parent coupon's discount rules — for bulk promo codes.
 */
export const couponSets = pgTable(
  "coupon_sets",
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
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "restrict" }), // parent rules
    publicId: text("public_id").notNull(), // cpset_…
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // 0315: archived sets redeem nothing (their unredeemed codes are archived too).
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // 0315: caller key/values, stored verbatim and returned.
    metadata: jsonb("metadata"),
  },
  (t) => [
    // Slug unique per business.
    uniqueIndex("coupon_sets_biz_slug_uq").on(t.businessId, t.publicId),
    index("coupon_sets_business_idx").on(t.businessId),
  ],
);

/**
 * One redeemable code inside a coupon set. Single-use: `not_redeemed → redeemed`
 * (or `archived`). On redemption it links to the created `applied_coupons` row.
 */
export const couponSetCodes = pgTable(
  "coupon_set_codes",
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
    couponSetId: uuid("coupon_set_id")
      .notNull()
      .references(() => couponSets.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    status: text("status").notNull().default("not_redeemed"), // not_redeemed | redeemed | archived
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    appliedCouponId: uuid("applied_coupon_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Codes are unique per business (across all sets).
    uniqueIndex("coupon_set_codes_code_uq").on(t.businessId, t.code),
    index("coupon_set_codes_set_idx").on(t.couponSetId, t.status),
  ],
);

/**
 * A coupon applied to a subscription (Stripe-style: at most one active discount
 * per subscription). `remainingPeriods` counts down for `repeating` duration;
 * status goes active → exhausted when consumed.
 */
export const appliedCoupons = pgTable(
  "applied_coupons",
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
    // Null for manual (couponless) discounts — see `source` below.
    couponId: uuid("coupon_id").references(() => coupons.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // disc_…
    status: text("status").notNull().default("active"), // active | exhausted | removed
    remainingPeriods: integer("remaining_periods"), // null = unlimited (forever)

    /**
     * The START of the billing period that `periodUsedMinor` refers to (0247), or null
     * before this discount has touched any invoice.
     *
     * A fixed-amount coupon is an allowance PER PERIOD, so the question every invoice asks
     * is "am I in the same period as the last one?" — which is a timestamp comparison, not
     * a counter. Renewals anchor to the period they bill (`BillSubscriptionPeriodInput
     * .periodStart`); mid-term invoices anchor to `subscriptions.current_period_start`.
     */
    periodAnchor: timestamp("period_anchor", { withTimezone: true }),
    /**
     * How much of THIS period's allowance is already spent, in minor units (0247). Reset
     * when the period advances, so it is never a lifetime total — a period can never give
     * more than the coupon's face value, which is what makes over-delivery impossible.
     * CHECK-constrained non-negative; see the migration.
     */
    periodUsedMinor: bigint("period_used_minor", { mode: "bigint" }).notNull().default(0n),
    // The span the discount was created with, in BILLING periods — null =
    // unlimited. Unlike `remainingPeriods` this never moves, which is what lets
    // MRR ask "does this discount recur?" (`total_periods IS NULL OR > 1`) without
    // the answer changing on every renewal. See `discountsForMrr` in
    // subscriptions/service.ts.
    totalPeriods: integer("total_periods"),
    // Discount source discriminator — a manual discount has no coupon object:
    // 'coupon' rows carry couponId + look up their rules from
    // `coupons`; 'manual' rows are self-contained (manual* columns below) and
    // couponId is null. Every other mechanism (stacking math, invoicing,
    // consume/restore-period) is source-agnostic — it only reads the fields on
    // this row (via the StackCoupon projection built in `peekDiscounts`).
    source: text("source").notNull().default("coupon"), // coupon | manual
    // 0495: the customer entered this code (portal or checkout), not an operator.
    enteredByCustomer: boolean("entered_by_customer").notNull().default(false),
    manualKind: text("manual_kind"), // percentage | fixed_amount (source='manual' only)
    manualPercentOffBps: integer("manual_percent_off_bps"),
    manualAmountOffMinor: bigint("manual_amount_off_minor", { mode: "bigint" }),
    manualCurrency: char("manual_currency", { length: 3 }),
    manualNote: text("manual_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("applied_coupons_public_id_uq").on(t.publicId),
    index("applied_coupons_sub_idx").on(t.subscriptionId, t.status),
    index("applied_coupons_coupon_created_idx").on(
      t.couponId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
    // At most ONE active application of a given coupon to a given subscription
    // (G backlog: max_redemptions / double-stack race backstop). Partial: only
    // 'active' rows are constrained — removed/exhausted history can repeat.
    // (couponId is null for manual rows, so this never constrains them.)
    uniqueIndex("applied_coupons_active_uq")
      .on(t.couponId, t.subscriptionId)
      .where(sql`status = 'active' AND coupon_id IS NOT NULL`),
    // At most ONE active manual discount per subscription (concurrency
    // backstop for the app-level "a discount already exists" guard).
    uniqueIndex("applied_coupons_active_manual_uq")
      .on(t.subscriptionId)
      .where(sql`status = 'active' AND source = 'manual'`),
  ],
);
