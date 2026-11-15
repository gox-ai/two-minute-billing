import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  smallint,
  boolean,
  integer,
  jsonb,
  numeric,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { invoices } from "./invoices";
import { subscriptionItems, subscriptions } from "./subscriptions";
import { products } from "./catalog";
import { meters } from "./meters";
import { users } from "./users";

/**
 * Ledger accounts for credit grants. Accounts are plain strings (no DDL); these are the names.
 *  - pending:      sold, invoice not yet paid
 *  - paid:         deferred revenue at cost basis
 *  - promotional:  granted face value
 *  - discount:     contra-revenue, face above cost basis
 *  - breakage:     revenue from expired paid credit
 */
export const CREDIT_LEDGER_ACCOUNTS = {
  pending: "credit_grants_pending",
  paid: "credit_grants_paid",
  promotional: "credit_grants_promotional",
  discount: "credit_grant_discount",
  breakage: "credit_breakage",
} as const;

export type CreditOnExhausted = "block" | "bill";
export type CreditTaxTreatment = "taxed_at_purchase" | "taxed_at_use";

/**
 * Which invoice lines a grant may pay: every usage line, the usage lines of these prices, or
 * of these meters (by key; every price that bills the meter, resolved when the grant draws).
 */
export type CreditApplicability =
  | { kind: "metered" }
  | { kind: "prices"; prices: string[] }
  | { kind: "meters"; meters: string[] };

export const IN_FLIGHT_APPLIES = ["always", "other_holds_open"] as const;
export type InFlightApplies = (typeof IN_FLIGHT_APPLIES)[number];

/** Usage past the credits in a free trial. `refuse` (absent) is the rule before the key. */
export const TRIAL_USAGE = ["refuse", "overdraft_only", "as_paid"] as const;
export type TrialUsage = (typeof TRIAL_USAGE)[number];
/** Usage past the credits of a customer with no live subscription. */
export const NO_SUBSCRIPTION_USAGE = ["block", "as_subscriber"] as const;
export type NoSubscriptionUsage = (typeof NO_SUBSCRIPTION_USAGE)[number];
/** When such a customer may go below zero, inside the overdraft limit. */
export const NO_SUBSCRIPTION_OVERDRAFT = ["needs_payment_method", "always", "never"] as const;
export type NoSubscriptionOverdraft = (typeof NO_SUBSCRIPTION_OVERDRAFT)[number];
/** What a hard decline does to an automatic top-up. */
export const AUTO_TOPUP_ON_HARD_DECLINE = ["disable", "keep_enabled"] as const;
export type AutoTopupOnHardDecline = (typeof AUTO_TOPUP_ON_HARD_DECLINE)[number];
/** A capture of a hold in units that uses more than the hold. */
export const CAPTURE_OVER_HOLD = ["debt", "cap_at_hold"] as const;
export type CaptureOverHold = (typeof CAPTURE_OVER_HOLD)[number];

/** `businesses.credit_config` (0464). Absent keys take the API's defaults. */
export type BusinessCreditConfig = {
  hold_default_seconds?: number;
  in_flight_share_bps?: number;
  /** When the share caps a hold: every hold (absent), or only while other holds are open. */
  in_flight_applies?: InFlightApplies;
  blocking_enabled?: boolean;
  /**
   * The buyer may turn an automatic top-up of a unit with no rate on and off in the portal.
   * Absent = no: only an operator can.
   */
  portal_auto_topup?: boolean;
  on_exhausted_default?: CreditOnExhausted;
  overdraft_limit_minor?: Record<string, number>;
  top_up_limits?: Record<string, { min_minor?: number; max_minor?: number }>;
  /** Free credit an operator gives, per grant: refuse above `max_minor`, alert above the other. */
  grant_limits?: Record<string, { max_minor?: number; alert_above_minor?: number }>;
  /**
   * The same two limits for free credit in a unit with no rate, per unit key, in the unit's
   * smallest step (as a grant's `amount`). Such a unit has no money value, so `grant_limits`
   * does not apply to it.
   */
  unit_grant_limits?: Record<string, { max_units?: number; alert_above_units?: number }>;
  default_tax_treatment?: CreditTaxTreatment | null;
  /** Credit scope (2.55): narrows every grant scoped to all usage. Absent = no narrowing. */
  credit_scope?: Exclude<CreditApplicability, { kind: "metered" }> | null;
  /**
   * Usage paid in credits: how late an event may arrive and still be paid by the grant that
   * was live at its timestamp. Absent = 12 hours. 0 = the balance at receipt always pays.
   */
  late_event_grace_hours?: number;
  /**
   * Automatic top-up (0530): try a soft decline again. Absent = on; false = the first decline
   * turns the top-up off.
   */
  auto_topup_retries?: boolean;
  /** Retry delays in hours, each from the try before: at most 4, at most 72 in total. Absent = [4, 12]. */
  auto_topup_retry_hours?: number[];
  /** The same list per payment method kind; a kind with none uses `auto_topup_retry_hours`. */
  auto_topup_retry_hours_by_method?: Partial<Record<"card" | "bank_debit", number[]>>;
  /** Absent = `refuse`: a free trial never goes below zero and never bills usage in money. */
  trial_usage?: TrialUsage;
  /** Absent = `block`: no live subscription, so the usage past the credits is refused. */
  no_subscription_usage?: NoSubscriptionUsage;
  /** Absent = `needs_payment_method`: a chargeable method and no unpaid overage invoice. */
  no_subscription_overdraft?: NoSubscriptionOverdraft;
  /** Days before the overshoot of a customer with no subscription is invoiced. Absent = 30. */
  no_subscription_invoice_after_days?: number;
  /** Expiry of credit given back after a correction or an invoice give-back. Absent = 12. */
  restore_expiry_months?: number | "never";
  /** Absent = `disable`. */
  auto_topup_on_hard_decline?: AutoTopupOnHardDecline;
  /** Absent = `debt`: the units past the hold are billed or taken below zero. */
  capture_over_hold?: CaptureOverHold;
};

/** `customers.credit_settings` (0464): operator override, ignored after `override_expires_at`. */
export type CustomerCreditSettings = {
  on_exhausted?: CreditOnExhausted | null;
  overdraft_limit_minor?: Record<string, number>;
  override_expires_at?: string | null;
};

/** When credits or an allowance renew (G3b, 0497). Absent = once per billing term. */
export type CreditReset = {
  every: "hour" | "day" | "week" | "month" | "quarter" | "half_year" | "year" | "term" | "never";
  count?: number;
  anchor?: "subscription" | "calendar";
};

/** An allowance's reset; `{ same_as_credits: true }` follows the subscription's plan credits. */
export type AllowanceReset = CreditReset | { same_as_credits: true };

/** `prices.grants_credit` (0465): a pack on a one-time price, credits per cycle on a recurring one. */
export type PriceGrantsCredit =
  | {
      kind: "pack";
      unit: string | null;
      amount: number;
      category: "paid";
      priority?: number;
      expires_after: { days: number } | null;
      applicability?: CreditApplicability;
      tax_treatment?: CreditTaxTreatment | null;
      on_exhausted?: CreditOnExhausted | null;
    }
  | {
      kind: "per_cycle";
      unit: string | null;
      amount: number;
      priority?: number;
      applicability?: CreditApplicability;
      on_exhausted?: CreditOnExhausted | null;
      /**
       * 0530: money per whole credit (a decimal, major units) for a unit with no rate. The
       * grant is then paid credit: that share of the plan fee is deferred and recognised on use.
       */
      unit_cost_basis?: string;
      rollover?: {
        mode: "none" | "carry";
        percent?: number;
        cap?: number | null;
        expire_after_cycles?: number | null;
      };
      /** G3b: renew on this clock instead of each term (no hourly credits). */
      reset?: CreditReset;
      /** G3b: a partial first window; null = the business setting. */
      first_window?: "full" | "prorated" | "next_full_window" | null;
    };

/**
 * A business's own unit of credit (0460). Money is the implicit unit (`unit_id` NULL on a
 * grant). `key` is the catalog-family slug id. `locked_at` freezes currency, rate (and
 * whether there is one) and decimals.
 */
export const creditUnits = pgTable(
  "credit_units",
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
    pluralName: text("plural_name").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /** Minor units per unit × 10^12. NULL = no money rate: the credits are counted in units only. */
    minorPerUnitE12: bigint("minor_per_unit_e12", { mode: "bigint" }),
    /** 0–4: grant amounts are integers in 10^-decimals steps. */
    decimals: smallint("decimals").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [uniqueIndex("credit_units_business_key_uq").on(t.businessId, t.key)],
);

/**
 * One lot of credit for one customer (0461). Remaining = Σ its movements, never a column;
 * `status` is lifecycle: pending → active → expired | voided.
 * CHECKs: a paid grant has a tax treatment and an invoice (or restores one); `taxed_at_use`
 * only with money; source `restore` ⇔ `restored_from_id`.
 */
export const creditGrants = pgTable(
  "credit_grants",
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
    publicId: text("public_id").notNull(), // cgr_…
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    /** NULL = money. */
    unitId: uuid("unit_id").references(() => creditUnits.id),
    /** Units in the unit's smallest step (money: minor units). */
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    /** 0 exactly when the unit has no rate (CHECK). */
    faceMinor: bigint("face_minor", { mode: "bigint" }).notNull(),
    /** The unit has a money rate (money: always). Copied from the unit at insert (0525). */
    unitRated: boolean("unit_rated").notNull().default(true),
    /**
     * No rate only: the grant's units are not in `credit_unit_balances` (0526). It has not
     * started, or it ended and its renewal has not closed it yet.
     */
    outOfBalance: boolean("out_of_balance").notNull().default(false),
    costBasisMinor: bigint("cost_basis_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** paid | promotional */
    category: text("category").notNull(),
    /** 0–100, lower draws first. */
    priority: smallint("priority").notNull().default(50),
    effectiveAt: timestamp("effective_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    applicability: jsonb("applicability")
      .$type<CreditApplicability>()
      .notNull()
      .default(sql`'{"kind": "metered"}'::jsonb`),
    /** purchase | plan_cycle | manual | restore | auto_top_up (API refuses until PR 3) */
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    subscriptionItemId: uuid("subscription_item_id").references(() => subscriptionItems.id, {
      onDelete: "set null",
    }),
    restoredFromId: uuid("restored_from_id"),
    taxTreatment: text("tax_treatment").$type<CreditTaxTreatment>(),
    onExhausted: text("on_exhausted").$type<CreditOnExhausted>(),
    /** pending | active | expired | voided */
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_grants_public_id_uq").on(t.publicId),
    uniqueIndex("credit_grants_source_ref_uq")
      .on(t.businessId, t.source, t.sourceRef)
      .where(sql`source_ref IS NOT NULL`),
    index("credit_grants_customer_live_idx")
      .on(t.customerId, t.currency)
      .where(sql`status IN ('active', 'expired')`),
    index("credit_grants_pending_idx")
      .on(t.status)
      .where(sql`status = 'pending'`),
    index("credit_grants_invoice_idx")
      .on(t.invoiceId)
      .where(sql`invoice_id IS NOT NULL`),
    index("credit_grants_expiry_idx")
      .on(t.expiresAt)
      .where(sql`status = 'active' AND expires_at IS NOT NULL`),
    index("credit_grants_out_of_balance_idx")
      .on(t.customerId, t.unitId)
      .where(sql`out_of_balance AND status = 'active'`),
    index("credit_grants_unit_expiry_idx")
      .on(t.customerId, t.unitId, t.expiresAt)
      .where(sql`status = 'active' AND NOT unit_rated AND expires_at IS NOT NULL`),
  ],
);

/**
 * Every change to a grant's units and money (0462). Append-only: the app role holds SELECT and
 * INSERT only. Into the grant (grant, restore, rollover_in) ≥ 0; out of it ≤ 0 (CHECK).
 */
export const creditGrantMovements = pgTable(
  "credit_grant_movements",
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
    publicId: text("public_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => creditGrants.id, { onDelete: "cascade" }),
    /** grant | draw | expire | void | restore | rollover_in | rollover_out | activate */
    kind: text("kind").notNull(),
    units: bigint("units", { mode: "bigint" }).notNull(),
    faceMinor: bigint("face_minor", { mode: "bigint" }).notNull(),
    costMinor: bigint("cost_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    invoiceId: uuid("invoice_id"),
    /** A draw made by a usage settlement (0526). CHECK: a draw names an invoice or a settlement. */
    settlementId: uuid("settlement_id"),
    ledgerTransactionId: uuid("ledger_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("credit_grant_movements_public_id_uq").on(t.publicId),
    index("credit_grant_movements_grant_idx").on(t.grantId),
    index("credit_grant_movements_customer_created_idx").on(t.customerId, t.createdAt.desc()),
    index("credit_grant_movements_invoice_idx")
      .on(t.invoiceId)
      .where(sql`invoice_id IS NOT NULL`),
  ],
);

/**
 * An estimated cost reserved before a call (0463). A `held` row stops counting at
 * `expires_at`, before the pass marks it expired. `captured_minor` may exceed the hold.
 */
export const creditHolds = pgTable(
  "credit_holds",
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
    publicId: text("public_id").notNull(), // chd_…
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    currency: char("currency", { length: 3 }).notNull(),
    /** 0 for a hold in units. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    /** A hold in a unit with no rate (0527): the unit and the steps it reserves. */
    unitId: uuid("unit_id").references(() => creditUnits.id),
    amountUnits: bigint("amount_units", { mode: "bigint" }),
    /** What the captured events took, in steps. */
    capturedUnits: bigint("captured_units", { mode: "bigint" }),
    /** What the hold still reserves (a lease is captured in steps). 0 once it is closed. */
    remainingUnits: bigint("remaining_units", { mode: "bigint" }),
    meterId: uuid("meter_id").references(() => meters.id, { onDelete: "set null" }),
    /** {property: value}, as the access check's scope. */
    scope: jsonb("scope").$type<Record<string, string>>(),
    /** held | captured | released | expired */
    status: text("status").notNull().default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    capturedMinor: bigint("captured_minor", { mode: "bigint" }),
    /** usage_events is partitioned: no foreign key. */
    usageEventId: uuid("usage_event_id"),
    overdraft: boolean("overdraft").notNull().default(false),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("credit_holds_public_id_uq").on(t.publicId),
    index("credit_holds_customer_held_idx")
      .on(t.customerId)
      .where(sql`status = 'held'`),
    index("credit_holds_expiry_idx")
      .on(t.expiresAt)
      .where(sql`status = 'held'`),
    index("credit_holds_unit_held_idx")
      .on(t.customerId, t.unitId, t.expiresAt)
      .where(sql`status = 'held' AND unit_id IS NOT NULL`),
  ],
);

/**
 * The real-time balance of a unit with no rate (0525): one row per customer and unit, the sum
 * of what is left on the customer's grants in it. Moved by every grant movement, in its
 * transaction. The grants and their movements stay the book of record.
 */
export const creditUnitBalances = pgTable(
  "credit_unit_balances",
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
    unitId: uuid("unit_id")
      .notNull()
      .references(() => creditUnits.id),
    /** In the unit's smallest step. */
    availableSteps: bigint("available_steps", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Σ open holds in the unit (0527). The gate offers available − held. */
    heldSteps: bigint("held_steps", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** The part of `heldSteps` that closed grants back from their grace rows. */
    pinnedSteps: bigint("pinned_steps", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** The active automatic top-up's threshold, and the gate's mark at or below it. */
    topupThresholdSteps: bigint("topup_threshold_steps", { mode: "bigint" }),
    topupDueAt: timestamp("topup_due_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("credit_unit_balances_customer_unit_uq").on(t.customerId, t.unitId),
    index("credit_unit_balances_business_idx").on(t.businessId),
  ],
);

/**
 * What one unit of a meter costs in credits of a unit with no rate (0526). Three layers, the
 * most specific wins: a subscription's row, then a plan's (`product_id`), then the meter's own
 * (both NULL). Every row of a meter names the same unit.
 */
export const meterCreditCosts = pgTable(
  "meter_credit_costs",
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
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => creditUnits.id),
    creditsPerUnit: numeric("credits_per_unit", { precision: 20, scale: 6 }).notNull(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "cascade",
    }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("meter_credit_costs_meter_uq")
      .on(t.meterId)
      .where(sql`product_id IS NULL AND subscription_id IS NULL`),
    uniqueIndex("meter_credit_costs_product_uq")
      .on(t.meterId, t.productId)
      .where(sql`product_id IS NOT NULL`),
    uniqueIndex("meter_credit_costs_subscription_uq")
      .on(t.meterId, t.subscriptionId)
      .where(sql`subscription_id IS NOT NULL`),
    index("meter_credit_costs_business_idx").on(t.businessId),
  ],
);

/**
 * One settled window of a customer and meter (0526): the draws it made carry its id.
 * Append-only: the app role has SELECT and INSERT only. `seq` counts per customer and meter.
 */
export const creditUsageSettlements = pgTable(
  "credit_usage_settlements",
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
    publicId: text("public_id").notNull(), // cus_… is the customer: settlements are cst_…
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => creditUnits.id),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    seq: integer("seq").notNull(),
    /**
     * usage | late (late events paid by one closed grant in its grace window) | correction
     * (what a voided event's settlement drew, given back: `unitsDrawn` and `revenueMinor` are
     * the amounts returned) | redraw (usage a fully refunded pack paid, drawn again from other
     * grants; `correctsSettlementId` names the settlement that drew the pack).
     */
    kind: text("kind").notNull().default("usage"),
    /** A correction: the voided usage event (0530). */
    correctsEventId: uuid("corrects_event_id"),
    correctsSettlementId: uuid("corrects_settlement_id"),
    graceGrantId: uuid("grace_grant_id").references(() => creditGrants.id, {
      onDelete: "set null",
    }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    events: integer("events").notNull().default(0),
    quantity: numeric("quantity").notNull().default("0"),
    /** In the unit's smallest step. */
    unitsDue: bigint("units_due", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    unitsDrawn: bigint("units_drawn", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    quantityUncovered: numeric("quantity_uncovered").notNull().default("0"),
    currency: char("currency", { length: 3 }).notNull(),
    /** Cost of the paid credit drawn: the revenue this settlement posted. */
    revenueMinor: bigint("revenue_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    status: text("status").notNull().default("settled"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("credit_usage_settlements_public_id_uq").on(t.publicId),
    uniqueIndex("credit_usage_settlements_seq_uq").on(t.customerId, t.meterId, t.seq),
    index("credit_usage_settlements_customer_idx").on(t.customerId, t.windowEnd.desc()),
    index("credit_usage_settlements_business_idx").on(t.businessId),
  ],
);

/**
 * `billed` and `forgiven` (0530) are for an overshoot part only (`source` overdraft): moved
 * to a one-off invoice, or written off with `zeroReason`.
 */
export type CreditUsageStatus =
  | "taken"
  | "pending"
  | "settled"
  | "refused"
  | "skipped"
  | "billed"
  | "forgiven";
export type CreditUsageReason =
  | "insufficient_credit"
  | "backfill"
  | "unmatched_customer"
  | "voided";
/** `balance` and `grace` are paid by credits; `overdraft` is an overshoot below zero (0530). */
export type CreditUsageSource = "balance" | "grace" | "overdraft";
/** Why units were written off or zeroed out (0530). */
export type CreditZeroReason =
  | "plan_reset"
  | "invoice_voided"
  | "event_voided"
  | "full_refund"
  | "manual"
  /** A capture took no more than its hold (`capture_over_hold: cap_at_hold`). */
  | "hold_cap";

/**
 * What the gate decided for one usage event on a meter with a credit cost (0526). `taken`
 * rows are out of `credit_unit_balances` and wait for settlement; `pending` rows are out of a
 * closed grant's grace row and wait for its window to end. `refused` and `skipped` rows spend
 * nothing and are never settled.
 */
export const creditUsageEvents = pgTable(
  "credit_usage_events",
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
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    meterId: uuid("meter_id")
      .notNull()
      .references(() => meters.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => creditUnits.id),
    /** usage_events is partitioned: no foreign key. */
    eventId: uuid("event_id").notNull(),
    eventKey: text("event_key").notNull(),
    eventTimestamp: timestamp("event_timestamp", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    part: smallint("part").notNull().default(0),
    /** The event's quantity on the meter; on part 0 only, as `units_due` and `units_uncovered`. */
    quantity: numeric("quantity").notNull().default("0"),
    creditsPerUnit: numeric("credits_per_unit", { precision: 20, scale: 6 }).notNull(),
    /** meter | plan | subscription */
    costSource: text("cost_source").notNull().default("meter"),
    unitsDue: bigint("units_due", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    unitsUncovered: bigint("units_uncovered", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** Taken by this part, in the unit's smallest step. */
    units: bigint("units", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /** balance | grace | overdraft */
    source: text("source").$type<CreditUsageSource>().notNull().default("balance"),
    graceGrantId: uuid("grace_grant_id").references(() => creditGrants.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<CreditUsageStatus>().notNull(),
    reason: text("reason").$type<CreditUsageReason>(),
    coveredByHold: boolean("covered_by_hold").notNull().default(false),
    settlementId: uuid("settlement_id").references(() => creditUsageSettlements.id),
    /** How `unitsUncovered` is billed in money: the meter's usage price, or the unit's price. */
    overageBasis: text("overage_basis").$type<"meter" | "unit">(),
    /** `unit` basis: money per credit at the gate, fixed-12 minor units. */
    overageRateE12: bigint("overage_rate_e12", { mode: "bigint" }),
    /** `meter` basis: the meter price that bills the uncovered units, fixed at the gate. */
    overagePriceId: uuid("overage_price_id"),
    overageChargeId: uuid("overage_charge_id"),
    /** A `billed` overshoot part: its one-off invoice. */
    overageInvoiceId: uuid("overage_invoice_id"),
    zeroReason: text("zero_reason").$type<CreditZeroReason>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("credit_usage_events_event_uq").on(t.eventId, t.meterId, t.part),
    index("credit_usage_events_open_idx")
      .on(t.customerId, t.unitId)
      .where(sql`status = 'taken'`),
    index("credit_usage_events_pending_idx")
      .on(t.graceGrantId)
      .where(sql`status = 'pending'`),
    index("credit_usage_events_due_idx")
      .on(t.receivedAt)
      .where(sql`status = 'taken'`),
    index("credit_usage_events_customer_received_idx").on(t.customerId, t.meterId, t.receivedAt),
    index("credit_usage_events_key_idx").on(t.businessId, t.eventKey),
  ],
);

/**
 * What a closed grant in a unit with no rate still has for late events dated inside its life
 * (0526). The units leave `credit_unit_balances` at the close and are booked out of the grant
 * when the grace window ends (`locked_at`).
 */
export const creditGrantGrace = pgTable(
  "credit_grant_grace",
  {
    grantId: uuid("grant_id")
      .primaryKey()
      .references(() => creditGrants.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => creditUnits.id),
    availableSteps: bigint("available_steps", { mode: "bigint" }).notNull(),
    /** Kept for open holds: no late event takes it. */
    heldSteps: bigint("held_steps", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    locksAt: timestamp("locks_at", { withTimezone: true }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    index("credit_grant_grace_open_idx")
      .on(t.customerId, t.unitId)
      .where(sql`locked_at IS NULL`),
    index("credit_grant_grace_due_idx")
      .on(t.locksAt)
      .where(sql`locked_at IS NULL`),
    index("credit_grant_grace_business_idx").on(t.businessId),
  ],
);
