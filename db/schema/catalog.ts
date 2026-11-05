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
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { meters } from "./meters";
import type { PriceGrantsCredit } from "./credits";

/**
 * A Product Group sub-groups a business's products (plans/addons/charges).
 * Purely an organizational layer: it carries no billing semantics. Every
 * product belongs to exactly one group
 * (a per-business "Default" group exists so the layer is invisible until used).
 */
export const productGroups = pgTable(
  "product_groups",
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
    // Human-readable slug id (unique per business).
    publicId: text("public_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    // Slug unique per business (not globally); same slug may exist in different businesses.
    uniqueIndex("product_groups_biz_slug_uq").on(t.businessId, t.publicId),
    index("product_groups_business_idx").on(t.businessId),
  ],
);

/**
 * Catalog is BUSINESS-scoped (each business is independent — own products,
 * currencies, pricing). Products are the sellable things; Prices attach to a
 * product and encode how it's charged.
 */
export const products = pgTable(
  "products",
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
    // The product's group (Phase 13). NO ACTION on delete: groups are soft-archived,
    // never hard-deleted; business-delete cascades both tables (checked at stmt end).
    productGroupId: uuid("product_group_id")
      .notNull()
      .references(() => productGroups.id),
    // Human-readable slug id (unique per business).
    publicId: text("public_id").notNull(),
    // Type discriminator: a product IS a plan, addon, or charge.
    // Its prices are one per currency/frequency. Drives subscription assembly.
    kind: text("kind").notNull().default("plan"), // plan | addon | charge
    name: text("name").notNull(), // internal name
    externalName: text("external_name"), // customer-facing (self-serve portal / checkout) (CP-5)
    description: text("description"),
    unitOfMeasure: text("unit_of_measure"), // e.g. "agent" → "$10/agent" (CP-5)
    metered: boolean("metered").notNull().default(false), // usage-metered product (CP-5)
    enabledForCheckout: boolean("enabled_for_checkout").notNull().default(false), // Display in Checkout (CP-5)
    enabledInPortal: boolean("enabled_in_portal").notNull().default(false), // Display in Self-Serve Portal (CP-5)
    redirectUrl: text("redirect_url"), // post-checkout redirect (CP-5)
    imageUrl: text("image_url"), // buyer-facing picture; a URL we stored (0347)
    // For addon products: whether the addon applies to every plan in the business
    // (vs. the explicit attached_items links). Ignored for non-addons.
    addonAppliesToAll: boolean("addon_applies_to_all").notNull().default(false),
    // Which tax profile's rates apply to this product. null = the business's default
    // profile, so a single-rate business never sets it. A BARE uuid, not a drizzle
    // `.references()`: `tax_profiles` lives in db/schema/tax.ts, which already imports
    // `invoices` — declaring the FK here would close an import cycle
    // catalog → tax → invoices → catalog. The real FK (ON DELETE SET NULL) is attached
    // in the migration instead.
    taxProfileId: uuid("tax_profile_id"),
    // HSN/SAC classification for this product, overriding `businesses.default_tax_code`.
    // Deliberately NOT on `tax_profiles`: a profile groups products by the RATES that
    // apply to them, and two services can share a rate while carrying different codes
    // (SaaS 998314 and consulting 998311 are both 18% GST). Hanging the code off the
    // profile would force a duplicate profile, identical in every rate, purely to say a
    // different four digits on the invoice.
    taxCode: text("tax_code"),
    metadata: jsonb("metadata"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    // Slug unique per business.
    uniqueIndex("products_biz_slug_uq").on(t.businessId, t.publicId),
    index("products_business_idx").on(t.businessId),
  ],
);

/**
 * Attached items (CAT-4): which add-ons and charges attach to a plan and how they're
 * charged. An add-on with `addonAppliesToAll` skips these rows (applies to every plan).
 * A charge is one-time by nature: always `chargeOnce`, never `recommended`.
 *   - `applicability`: mandatory (auto-attach, can't remove) | recommended | optional
 *   - `chargeOnEvent`: subscription_creation | trial_start | activation | on_demand
 *      (on_demand fires only via `trigger_charge`)
 *   - `chargeOnce`: bill one time at the event (vs a persistent recurring item)
 *   - `defaultQuantity`: quantity when auto-attached
 *   - `billingCycles`: cap the recurring cycles (carried onto the sub item)
 */
export const attachedItems = pgTable(
  "attached_items",
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
    // The attached add-on or charge.
    itemProductId: uuid("item_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    planProductId: uuid("plan_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    // CP-6: how the item relates to the plan. mandatory items auto-attach and
    // can't be removed; recommended surfaces a badge; optional is the default.
    applicability: text("applicability").notNull().default("optional"), // mandatory | recommended | optional
    // CAT-4 charge semantics.
    chargeOnEvent: text("charge_on_event").notNull().default("subscription_creation"),
    chargeOnce: boolean("charge_once").notNull().default(false),
    defaultQuantity: integer("default_quantity").notNull().default(1),
    billingCycles: integer("billing_cycles"), // null = no cap
    // Portal-only quantity limits (staff may set any quantity). null = no limit.
    minQuantity: integer("min_quantity"),
    maxQuantity: integer("max_quantity"),
    quantityStep: integer("quantity_step").notNull().default(1),
    customerCanChangeQuantity: boolean("customer_can_change_quantity").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("attached_items_uq").on(t.itemProductId, t.planProductId),
    index("attached_items_item_idx").on(t.itemProductId),
  ],
);

/**
 * A Price expresses one of the billing models:
 *  - flat:     fixed amount per period
 *  - per_unit: amount × quantity per period (per-seat)
 *  - tiered:   graduated tiers (tiers[])
 *  - volume:   volume tiers (tiers[])
 *  - stairstep: flat price of the tier the quantity lands in (tiers[].flatAmountMinor)
 *  - usage:    metered — rated from aggregated usage at period close
 * Orthogonally, `type` is recurring (has interval) or one_time (add-ons/setup fees).
 * Amounts are integer minor units. A price belongs to its product,
 * addressed by (currency, interval) in the catalog UI's pricing matrix.
 */
export const prices = pgTable(
  "prices",
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
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // price_…
    name: text("name"), // internal price label, e.g. "Monthly USD" (optional)
    externalName: text("external_name"), // customer-facing price name (CP-5)
    description: text("description"), // CP-5
    type: text("type").notNull().default("recurring"), // recurring | one_time
    model: text("model").notNull(), // flat | per_unit | tiered | volume | stairstep | usage | package | percentage | graduated_percentage
    currency: char("currency", { length: 3 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }), // flat / per_unit
    interval: text("interval"), // day | week | month | year (null for one_time)
    intervalCount: integer("interval_count").notNull().default(1),
    // sum | max | last | count | min | avg | unique | weighted_sum. Set = the price is metered
    // (usage, percentage, graduated_percentage, tiered, volume, stairstep, package).
    usageAggregation: text("usage_aggregation"),
    // 0378: the measured level carries into later periods (seats, storage).
    usageRecurring: boolean("usage_recurring").notNull().default(false),
    // 0378: hour | day — the unit of a `weighted_sum` quantity (unit-hours). Null otherwise.
    usageTimeUnit: text("usage_time_unit"),
    tiers: jsonb("tiers"), // tiered / volume / stairstep: [{ upToMinor, unitAmountMinor, flatAmountMinor }]; graduated_percentage: [{ upToMinor, rateBps, flatAmountMinor }]
    packageSize: integer("package_size"), // package model: units per package
    freeUnits: integer("free_units"), // package/percentage model: units (or value) billed at 0 first
    percentageBps: integer("percentage_bps"), // percentage model: rate in basis points (250 = 2.5%)
    // Minimum spend for one billing period (0372). A recurring line below it gets a true-up
    // line at period billing; prorated on a partial period. NULL = no minimum.
    minimumAmountMinor: bigint("minimum_amount_minor", { mode: "bigint" }),
    // 0383, plan recurring prices only: bill metered usage every month inside a longer term
    // (default for new subscriptions), and the minimum commitment per term. NULL = none.
    billUsageMonthly: boolean("bill_usage_monthly").notNull().default(false),
    commitmentAmountMinor: bigint("commitment_amount_minor", { mode: "bigint" }),
    // 0453, meter prices. Set = the price bills from this meter's events; its usage_* fields
    // are copied from the meter.
    meterId: uuid("meter_id").references(() => meters.id),
    // Minor units per `quantityDivisor` units, ≤ 12 dp. "$3 per 1M" = "300" per 1000000.
    unitAmountDecimal: numeric("unit_amount_decimal", { precision: 38, scale: 12 }),
    quantityDivisor: bigint("quantity_divisor", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    // rate | event_amount | event_cost. Open set, validated by the API.
    amountSource: text("amount_source").notNull().default("rate"),
    // event_cost: line = Σ cost × (1 + markup ÷ 100). model_price_list: markup over markupBase.
    markupPercent: numeric("markup_percent", { precision: 12, scale: 6 }),
    // 0457, model_price_list only: list | cost. NULL reads as list.
    markupBase: text("markup_base"),
    // 0465: a pack (one-time) or credits per cycle (recurring). NULL = grants nothing.
    grantsCredit: jsonb("grants_credit").$type<PriceGrantsCredit>(),
    // Real trial (CP-5) — replaces the bare `trial_days`. trial_period in units of
    // trial_period_unit; trial_end_action decides what happens when the trial ends.
    trialPeriod: integer("trial_period"),
    trialPeriodUnit: text("trial_period_unit"), // day | week | month | year
    trialEndAction: text("trial_end_action"), // activate_subscription | cancel_subscription
    billingCycles: integer("billing_cycles"), // fixed number of cycles then stop; null = forever (CP-5)
    freeQuantity: integer("free_quantity"), // generalized free units on this price (CP-5)
    // Portal-only seat limits for a per-unit plan; null = the business's seat_min/seat_max.
    portalMinQuantity: integer("portal_min_quantity"),
    portalMaxQuantity: integer("portal_max_quantity"),
    invoiceNotes: text("invoice_notes"), // CP-5
    showDescriptionInInvoices: boolean("show_description_in_invoices").notNull().default(false), // CP-5
    // The quotes half of the pair. Stored per price, same as its sibling.
    showDescriptionInQuotes: boolean("show_description_in_quotes").notNull().default(false),
    // HSN/SAC for this price, the FINEST level of the classification chain
    // price → product → business default (`__taxCodeForLine`). The code genuinely varies
    // per price: the same product sold as a subscription (a service, 9983…) and as
    // a shipped licence key (goods, an 8-digit HSN) is one product with two codes.
    // Nullable — null means "ask the product".
    taxCode: text("tax_code"),
    // ── Accounting metadata ───────────────────────────────────────────────────────────
    // DESCRIPTIVE ONLY. Nothing in the engine reads these three: they are not the ledger's
    // account codes (see `db/schema/ledger.ts` — accounts are ours, not the customer's),
    // they do not affect rating, tax or revenue recognition, and no export consumes them
    // yet. They exist so a business can round-trip its own ERP/GL handles through us.
    // Do NOT wire billing behaviour onto them — if the engine ever needs a real account
    // dimension, that is a modelled field, not free text.
    sku: text("sku"), // SKU / alternative name
    accountingCode: text("accounting_code"), // GL account name
    accountingCategoryCode: text("accounting_category_code"), // GL class
    // Whether this price is subject to tax (Phase 10). false → its invoice lines
    // are excluded from the taxable base and recorded with reason 'product_exempt'.
    isTaxable: boolean("is_taxable").notNull().default(true),
    // exclusive (default): tax added on top. inclusive: the price already includes
    // tax, which is backed out (net revenue + tax_payable) rather than added.
    taxBehavior: text("tax_behavior").notNull().default("exclusive"), // exclusive | inclusive
    metadata: jsonb("metadata"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    // Slug unique per business.
    uniqueIndex("prices_biz_slug_uq").on(t.businessId, t.publicId),
    index("prices_business_idx").on(t.businessId),
    index("prices_product_idx").on(t.productId),
    index("prices_meter_idx")
      .on(t.meterId)
      .where(sql`meter_id IS NOT NULL`),
  ],
);

/**
 * A meter price's rate card (0453): a rate per combination of group values. The match naming
 * the most properties wins, then the oldest; no match bills at the price's own numbers.
 */
export const priceRates = pgTable(
  "price_rates",
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
    priceId: uuid("price_id")
      .notNull()
      .references(() => prices.id, { onDelete: "cascade" }),
    /** {property: value} over a subset of the meter's group_by. */
    match: jsonb("match").$type<Record<string, string>>().notNull(),
    unitAmountDecimal: numeric("unit_amount_decimal", { precision: 38, scale: 12 }),
    /** Tiers in the price's model: [{ up_to, unit_amount_decimal, flat_amount_minor }]. */
    tiers: jsonb("tiers"),
    /** 0457: percent over the price's markup base. Set in place of a fixed rate, never with one. */
    markupPercent: numeric("markup_percent", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [uniqueIndex("price_rates_price_match_uq").on(t.priceId, t.match)],
);

/**
 * Differential pricing (CP-6) — an add-on's price when attached to a specific
 * plan differs from its base price. Resolved at rating/estimate time: when an
 * addon line is attached to `plan_product_id`, use this amount for (currency,
 * interval) instead of the addon's base price. Falls back to base if absent.
 */
export const differentialPrices = pgTable(
  "differential_prices",
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
    addonProductId: uuid("addon_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    planProductId: uuid("plan_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // dprice_…
    currency: char("currency", { length: 3 }).notNull(),
    interval: text("interval"), // day | week | month | year (match the addon price)
    // CAT-7: a differential overrides the addon's price for a plan by EITHER a flat/
    // per-unit `amount_minor` OR a `tiers` array (tiered/volume). Exactly one is set.
    amountMinor: bigint("amount_minor", { mode: "bigint" }),
    tiers: jsonb("tiers"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("differential_prices_public_id_uq").on(t.publicId),
    uniqueIndex("differential_prices_uq").on(
      t.addonProductId,
      t.planProductId,
      t.currency,
      t.interval,
    ),
    index("differential_prices_addon_idx").on(t.addonProductId),
  ],
);
