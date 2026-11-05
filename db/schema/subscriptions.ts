import {
  pgTable,
  uuid,
  text,
  char,
  integer,
  bigint,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";
import { customers, customerAddresses } from "./customers";
import { prices, products } from "./catalog";
import { paymentMethods } from "./payment-methods";

/** `subscriptions.reset_state` (G3b, 0497). */
export type SubscriptionResetState = {
  /** The pause that is open now (ISO). */
  paused_at?: string | null;
  /** Σ paused time the subscription-anchored windows moved on by (`on_pause: shift`). */
  shift_ms?: number;
  /**
   * Item id → the window open at the last shifted pause, with its moved end (ISO; both anchors),
   * for the price it was cut for. Absent on a resume written before this key (`calendar_shifts`).
   */
  pause_windows?: Record<string, { price_id: string; start: string; end: string }>;
  /** The old name of `pause_windows` (calendar items only). Read, never written. */
  calendar_shifts?: Record<string, { price_id: string; start: string; end: string }>;
  /**
   * Meter feature id → its allowance window open at the last shifted pause, with its moved end
   * (ISO). `reset` is the `resetKey` it was cut for; another reset ignores it.
   */
  allowance_shifts?: Record<string, { reset: string; start: string; end: string }>;
  /** Meter feature id → the last upgrade that changed its allowance mid-window. */
  allowance_changes?: Record<string, { at: string; old_value: string; mode: string }>;
  /** `plan_credits.on_pause` sent with the open pause; absent = the business rule. */
  pause_rule?: "skip" | "keep_granting" | "shift" | null;
  /**
   * `plan_credits.on_cancel_at_period_end` sent with the pending cancel. Applies only while
   * `cancel_booked_at` still equals `booked_at` (ISO), so a later cancel does not inherit it.
   */
  cancel_rule?: {
    value: "grant_started_window" | "stop_at_request";
    booked_at: string;
  } | null;
};

/**
 * A subscription belongs to a customer. Status is an explicit state machine
 * (BLUEPRINT §5): trialing → active → past_due → canceled, plus paused.
 * The engine owns period boundaries; the billing clock advances them (Phase 2.2).
 */
export const subscriptions = pgTable(
  "subscriptions",
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
    publicId: text("public_id").notNull(), // sub_…
    /**
     * STORED status: future | in_trial | active | paused | cancelled.
     * See `StoredSubscriptionStatus` in modules/subscriptions/serialize.ts, which is the
     * authority; `non_renewing` is API-only, folded over `active` at serialize time.
     *
     * This comment used to read `trialing | active | past_due | paused | canceled` — every
     * one of those four wrong (no `trialing`, no `past_due`, `cancelled` has two Ls, and
     * `future` was missing). A guard in modules/coupons/service.ts was written against it
     * and compared this column to `'trialing'`, which it never holds, so every manual
     * discount on an in-trial subscription was refused. Keep this in step with the type.
     */
    status: text("status").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    /**
     * The BILLING TERM. NULL while the subscription is in trial: a trial is not a term, and
     * the two are mutually exclusive — `current_term_*` is absent on a trialling
     * subscription and `trial_*` is absent once billing starts. We carried both, which also
     * left a cancelled trial holding a term that never existed.
     *
     * Nullable is deliberate rather than convenient: it makes every read that assumes a term
     * a COMPILE error, which is the only safe way to change a field the billing clock
     * selects on. See `renewal.ts` — a trialling subscription is due by `trial_end`, an
     * active one by `current_period_end`.
     */
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    defaultPaymentMethodId: uuid("default_payment_method_id").references(() => paymentMethods.id, {
      onDelete: "set null",
    }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    // A `specific_date` cancel that has not fired yet. The SECOND way a
    // cancellation can be pending — `cancel_at_period_end` is the first — and
    // like it, this derives the API-facing `non_renewing` status (and supplies
    // `canceled_at`, which for a scheduled cancel IS this instant). The
    // executing `scheduled_changes` row remains the source of truth for the
    // money-handling options; this is its projection onto the subscription, so
    // list serialization and filtering don't have to join (0159).
    cancelScheduledAt: timestamp("cancel_scheduled_at", { withTimezone: true }),
    // When a term-end stop was booked, written by the cancel that clears the two columns above
    // so point-in-time CMRR keeps dating it (`frozenStopBooking`). Null on a live row (0295).
    cancelBookedAt: timestamp("cancel_booked_at", { withTimezone: true }),
    // Timeline (CP-4): scheduled/actual lifecycle timestamps.
    startDate: timestamp("start_date", { withTimezone: true }), // scheduled start (may be future)
    startedAt: timestamp("started_at", { withTimezone: true }), // when it actually started
    activatedAt: timestamp("activated_at", { withTimezone: true }), // trial→active moment
    trialStart: timestamp("trial_start", { withTimezone: true }),
    // Billing period snapshot + remaining fixed cycles (CP-4).
    billingPeriod: integer("billing_period"), // e.g. 1
    billingPeriodUnit: text("billing_period_unit"), // day | week | month | year
    // Calendar-billing anchor day-of-month (1–31, the INTENDED day even if a
    // short month clamps it). Persisted so every renewal re-aligns to this day
    // instead of drifting forward after a short month (CUST-5 review fix).
    billingAnchorDay: integer("billing_anchor_day"),
    remainingBillingCycles: integer("remaining_billing_cycles"), // null = forever
    // Pending invoices (E2/INV-1): renewals create a `pending` invoice that accretes
    // usage until closed (null = inherit the business default).
    createPendingInvoices: boolean("create_pending_invoices"),
    // 0384: monthly usage billing inside a longer term. The sub-period is
    // `[current_sub_period_start, current_sub_period_end)`; its start is the usage cursor
    // (usage before it is billed) and moves forward only. NULL when the flag is off.
    billUsageMonthly: boolean("bill_usage_monthly").notNull().default(false),
    currentSubPeriodStart: timestamp("current_sub_period_start", { withTimezone: true }),
    currentSubPeriodEnd: timestamp("current_sub_period_end", { withTimezone: true }),
    // 0384: minimum commitment per full term (NULL = none) and its time-weighted segments
    // `[{from, amount_minor}]` for the current term.
    commitmentAmountMinor: bigint("commitment_amount_minor", { mode: "bigint" }),
    commitmentSegments: jsonb("commitment_segments"),
    // Collection + commercial fields (CP-1/CP-4).
    autoCollection: text("auto_collection"), // on | off | null (inherit customer)
    netTermDays: integer("net_term_days"),
    poNumber: text("po_number"),
    // Ship-to (0360): one of the customer's address-book rows; null = the customer's default.
    shippingAddressId: uuid("shipping_address_id").references(() => customerAddresses.id, {
      onDelete: "set null",
    }),
    invoiceNotes: text("invoice_notes"),
    cancelReason: text("cancel_reason"), // SUB-8: SYSTEM reason (not_paid, no_card, …)
    cancelReasonCode: text("cancel_reason_code"), // SUB-8: MERCHANT-supplied reason code
    /** Who started the current pause (0493): `operator` | `retention_offer`; null = before 0493. */
    pauseSource: text("pause_source").$type<"operator" | "retention_offer">(),
    /** G3b (0497): reset clock state (pause start and shift, allowance changes). */
    resetState: jsonb("reset_state").$type<SubscriptionResetState>(),
    mrr: bigint("mrr", { mode: "bigint" }), // cached monthly-recurring-revenue (minor units)
    /**
     * The netted MRR this subscription last carried while it was EARNING (0271).
     *
     * `mrr` above says what it earns NOW, and that is deliberately 0 once the row is
     * `cancelled`, `paused` or `in_trial`. The historical series needs the other number —
     * the rate the subscription carried in the buckets it was live in — and that used to
     * be reconstructed on read by re-rating the surviving items against the still-active
     * discounts. The items survive a cancellation; THE DISCOUNTS DO NOT, so the re-rate
     * returned gross list price for a comped subscription that had been billed almost
     * nothing.
     *
     * Written by `recomputeSubscriptionMrr` on every recompute that lands in an earning
     * status, so the figure is stored while it is still knowable, and left untouched by the
     * recompute that zeroes the column — a pause must not erase what the subscription was
     * worth before it.
     *
     * History only: nothing filters, sorts or sums it as current revenue. NULL means no
     * earning rate was ever recorded, and readers fall back to the item re-rate there.
     */
    lastEarningMrr: bigint("last_earning_mrr", { mode: "bigint" }),
    // Credits Flexibility (0219), subscription half. The MOST of each bucket that may be
    // AUTO-applied to one invoice raised for this subscription, in minor units. NULL = no
    // subscription cap (the default, and today's behaviour); 0 = never auto-apply to this
    // subscription. Combined with the business's `credits_flexibility` by taking the
    // TIGHTER of the two — a subscription cap can narrow the business setting but never
    // re-enable a bucket the business switched off.
    maxRefundableCreditsUsageMinor: bigint("max_refundable_credits_usage_minor", {
      mode: "bigint",
    }),
    maxExcessPaymentUsageMinor: bigint("max_excess_payment_usage_minor", { mode: "bigint" }),
    metadata: jsonb("metadata"),
    // Custom-field values (SET-4) — DISTINCT from `metadata`: keyed by definition
    // `api_name`, typed + validated against custom_field_definitions on write.
    customFields: jsonb("custom_fields"),
    /**
     * Soft delete. A deleted subscription keeps its row, its invoices, its payments and
     * every ledger entry it produced — the ledger is append-only and an invoice may be
     * paid, so nothing here may be undone by removing it. What the stamp does is make the
     * subscription unreachable: reads 404, lists omit it, and every billing-clock scan
     * skips it, so an ACTIVE subscription stops billing the moment it is stamped WITHOUT
     * producing a cancellation, a final invoice or a credit.
     *
     * That is the whole difference from cancel, and the reason `status` is left untouched:
     * a deleted row records the state it was in when it was deleted, rather than claiming
     * an ending that never happened.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /**
     * The actor string from the audit log's vocabulary (api key public id / dashboard
     * user / 'system') — NOT a user id, because an API caller has no user row. The audit
     * log is the full record; this is here so the row itself says who removed it.
     */
    deletedBy: text("deleted_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    // Bugs #11: public-id uniqueness is PER BUSINESS (see customers.ts) — the
    // id-stable importer carries the source system's subscription id verbatim, and
    // those are unique per source account, not globally. Lookups by public_id must
    // scope by business_id too.
    uniqueIndex("subscriptions_biz_public_id_uq").on(t.businessId, t.publicId),
    index("subscriptions_customer_idx").on(t.customerId),
    // The billing clock scans by status + period end.
    index("subscriptions_due_idx").on(t.status, t.currentPeriodEnd),
    // Per business, for the clock's fair-share renewal fan-out (0348).
    index("subscriptions_business_due_idx")
      .on(t.businessId, t.status, t.currentPeriodEnd)
      .where(sql`deleted_at IS NULL`),
    index("subscriptions_business_trial_due_idx")
      .on(t.businessId, t.status, t.trialEnd)
      .where(sql`deleted_at IS NULL`),
    index("subscriptions_business_sub_period_due_idx")
      .on(t.businessId, t.currentSubPeriodEnd)
      .where(sql`current_sub_period_end IS NOT NULL AND deleted_at IS NULL`),
    // Keyset pagination for the subscriptions list (see listSubscriptionsPage).
    index("subscriptions_business_created_idx").on(
      t.businessId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
    // Deleted rows are a small minority, so the scans above stay on their own indexes and
    // simply filter `deleted_at IS NULL`. This one serves the opposite question — "what
    // was deleted here" — which only the audit trail asks.
    index("subscriptions_deleted_idx")
      .on(t.businessId, t.deletedAt)
      .where(sql`deleted_at IS NOT NULL`),
  ],
);

export const subscriptionItems = pgTable(
  "subscription_items",
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
    publicId: text("public_id").notNull(), // si_…
    priceId: uuid("price_id")
      .notNull()
      .references(() => prices.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull().default(1),
    // CP-4 item depth: units billed at 0 before rating, fixed cycle cap, item metadata.
    // (The unit-price override is snapshot-based — stored in `price_snapshot`, not a column.)
    freeQuantity: integer("free_quantity"),
    billingCycles: integer("billing_cycles"),
    // Periods this item has actually been billed (G review fix: billing skips the
    // item once cycles_billed reaches billing_cycles; incremented at finalize).
    cyclesBilled: integer("cycles_billed").notNull().default(0),
    metadata: jsonb("metadata"),
    // Immutable snapshot of the price's rating fields, captured at create/change.
    // Billing rates from this — so editing the catalog price never retroactively
    // re-rates a live subscription. Shape mirrors the `prices` row's money fields.
    priceSnapshot: jsonb("price_snapshot"),
    // 0474: the instant usage was last billed on an interim (threshold) invoice.
    usageBilledThrough: timestamp("usage_billed_through", { withTimezone: true }),
    // G3b (0497): when this item's next credit window starts (the `plan_credit_resets` scan).
    nextCreditResetAt: timestamp("next_credit_reset_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("subscription_items_public_id_uq").on(t.publicId),
    index("subscription_items_sub_idx").on(t.subscriptionId),
    index("subscription_items_next_credit_reset_idx")
      .on(t.nextCreditResetAt)
      .where(sql`next_credit_reset_at IS NOT NULL`),
    // G backlog: at most one AUTO-INCLUDED MANDATORY item per (subscription, price)
    // — concurrent changes / activation hooks can't double-insert a mandatory
    // add-on. Partial (a manual item may coexist at the same price).
    uniqueIndex("subscription_items_mandatory_uq")
      .on(t.subscriptionId, t.priceId)
      .where(sql`(metadata->>'auto_included') = 'mandatory'`),
  ],
);

/**
 * Fire-once ledger for event-driven attached-item charges (G backlog + Phase H).
 * One row per (subscription, attached add-on or charge, charge_event) — the unique index
 * makes activation / trial_start / charge_once on_demand charges idempotent, so a time
 * travel re-run (or a retried clock tick) never bills the same event twice.
 * Append-only; recurring on_demand charges (charge_once=false) don't record here.
 */
export const subscriptionChargeLog = pgTable(
  "subscription_charge_log",
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
    itemProductId: uuid("item_product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    chargeEvent: text("charge_event").notNull(), // activation | trial_start | subscription_creation | on_demand
    invoiceId: uuid("invoice_id"), // the raised invoice/charge (nullable — recurring items carry none)
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("subscription_charge_log_uq").on(t.subscriptionId, t.itemProductId, t.chargeEvent),
    index("subscription_charge_log_sub_idx").on(t.subscriptionId),
  ],
);
