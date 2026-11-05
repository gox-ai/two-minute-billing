import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
  bigserial,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";
import { customers } from "./customers";
import { subscriptions } from "./subscriptions";
import { prices } from "./catalog";

/**
 * An invoice is a finalized bill for a customer (usually one subscription period).
 * Amounts are integer minor units. The ledger (not these columns) is the money
 * source of truth; invoice totals are a convenience snapshot.
 */
export const invoices = pgTable(
  "invoices",
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
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    publicId: text("public_id").notNull(), // inv_…
    // Human-readable sequential number ("INV-42"), assigned at creation from the
    // business's invoice_prefix + invoice_next_number. Unique per business.
    number: text("number"),
    // Committed by a renewal without a number; the batch numbering job assigns it (0349).
    awaitingNumber: boolean("awaiting_number").notNull().default(false),
    // Due for its first collection (batch numbering); the collect workers lease it forward (0349).
    collectDueAt: timestamp("collect_due_at", { withTimezone: true }),
    // The trace of the tick that set `collectDueAt`, so the collect workers charge under it.
    collectTraceId: text("collect_trace_id"),
    // Invoice status vocabulary (E1/INV-2). The canonical list is the `InvoiceStatus`
    // union in `modules/invoicing/status.ts`, which also carries the state machine;
    // `invoices_status_ck` (0218) enforces exactly these six in the database.
    //   pending      — open, still accreting lines (metered / create_pending_invoices)
    //   posted       — finalized, awaiting payment, due date not yet passed (Net-D / send-invoice)
    //   payment_due  — DUE NOW and unpaid. Reached two ways: an invoice with no due date is
    //                  BORN here, and a retriable charge failure returns here with
    //                  dunning_status='in_progress'|'parked'.
    //   not_paid     — dunning exhausted / stopped, or an offline invoice past due — still owed
    //   paid         — settled (charge, offline payment, or fully covered by credit)
    //   voided       — cancelled, no longer owed (ledger reversed)
    // `credited` was here until 2026-08-28 and is GONE: zero writers, eight readers, five
    // of which filtered on it as though that were protection. See `status.ts` for the full
    // account; 0218 now makes it unwritable rather than merely undocumented.
    status: text("status").notNull().default("posted"),
    // Dunning sub-state (E1): null (never dunned) | in_progress | parked | success |
    // exhausted | stopped. `parked` was missing HERE until 2026-08-30, outliving the fix to
    // the `DunningStatus` union itself — see `status.ts:44`, which records the same omission
    // on a value the engine writes every day. `invoices_dunning_status_ck` (0218) enforces
    // these five, and NULL.
    dunningStatus: text("dunning_status"),
    currency: char("currency", { length: 3 }).notNull(),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull(),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    // ISSUE-TIME collectible: the amount due after applying any customer_balance credit
    // AT GENERATION (null = total). **Never decremented as payments land** — a `paid`
    // invoice keeps the figure it was raised with, and the majority of paid rows here
    // carry a non-zero value. The LIVE outstanding balance is derived in
    // `invoicing/serialize.ts` (`remainingDue`, which is what the API's `amount_due_minor`
    // returns, and which is 0 once paid). Read this column and you will
    // conclude a settled invoice is still owed; that misreading has happened.
    amountDueMinor: bigint("amount_due_minor", { mode: "bigint" }),
    // Tax withheld by the payer (TDS) — reduces the collectible amount; 0 = none.
    withholdingMinor: bigint("withholding_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // Customer-balance credit applied at generation (D1 balance split) — recorded
    // per bucket so void/write-off can restore exactly the right liability.
    // Promotional was applied PRE-tax (reduced the taxable base); refundable +
    // excess POST-tax. amount_due = total − withholding − (these three).
    promotionalCreditsAppliedMinor: bigint("promotional_credits_applied_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    refundableCreditsAppliedMinor: bigint("refundable_credits_applied_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    excessPaymentsAppliedMinor: bigint("excess_payments_applied_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // Credit grants applied (0466): pre-tax (promotional, taxed at purchase) and post-tax
    // (taxed at use). Both also come off amount_due.
    grantCreditsPreTaxMinor: bigint("grant_credits_pre_tax_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    grantCreditsPostTaxMinor: bigint("grant_credits_post_tax_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // Tax determination SNAPSHOT. The seller's own state at issue time is what decides
    // intra-state (CGST+SGST) vs inter-state (IGST), so it must be frozen here: once
    // the seller re-registers in another state, re-deriving it from current config
    // would silently change a historical invoice's tax breakdown.
    sellerStateCode: text("seller_state_code"),
    /** The customer's place of supply used for this invoice (their state at issue). */
    placeOfSupplyCode: text("place_of_supply_code"),
    /** `customers.tax_treatment` as it stood at issue: default · sez_* · export_* · reverse_charge. */
    taxTreatment: text("tax_treatment"),
    /** Rendered tax note (reverse-charge / SEZ / export text), snapshotted for the PDF. */
    taxNote: text("tax_note"),
    /**
     * FX SNAPSHOT (0228) — units of THIS invoice's currency per 1 unit of
     * `exchangeRateBase`, frozen at finalize.
     *
     * `numeric` maps to a STRING here, and it must stay one: a rate is exact input to
     * money arithmetic, and `Number("94.953741")` is where an exact rate becomes
     * 94.95374099999999. Null = no rate was recorded (pre-0228 rows, or no rate
     * configured for the currency) — NEVER coerce that to 1, which would assert parity
     * with the base currency.
     *
     * Reporting/audit only. Nothing in the billing path may read it: a rate that decided
     * what a customer is charged would put a third-party feed inside a bill.
     */
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }),
    /** The currency `exchangeRate` is measured against — stored per row so a later
     *  change of the business default cannot silently re-base history. */
    exchangeRateBase: char("exchange_rate_base", { length: 3 }),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    // The billing clock's one invoice that OPENS `period_start` (renewal, skipped renewal,
    // first period, first-period heal). `invoices_opens_period_uq` allows one live such
    // invoice per (subscription, period_start) — the backstop against billing a period twice
    // (0370). Request paths (signup, reactivate, resume, regenerate) and the term-end arrears
    // invoice leave it false: they may legitimately share a period_start with it.
    opensPeriod: boolean("opens_period").notNull().default(false),
    // Net-D payment terms: when payment is due (null = due on issue).
    dueDate: timestamp("due_date", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    // When dunning should next retry an unpaid invoice (null = no retry scheduled
    // / not applicable / exhausted). The billing clock scans this.
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    // When dunning last PARKED this invoice (0232). A park never retries, so
    // `next_attempt_at` is null and nothing here counts down; this is the anchor
    // `parkedDunningDeadline` measures its window from. Only meaningful while
    // `dunning_status='parked'` — every park site overwrites it, so it is never
    // cleared on the way out.
    dunningParkedAt: timestamp("dunning_parked_at", { withTimezone: true }),
    /**
     * When dunning GAVE UP on this invoice (0282) — the instant `dunning_status`
     * became `exhausted`, whichever of the five writers got there.
     *
     * ⚠️ NULL means UNKNOWN, never "not exhausted". `dunning_status` answers whether;
     * this answers only when, and it was added late deliberately unbackfilled, so every
     * invoice exhausted before 0282 carries an exhausted status and no date. Read the
     * two as one question and you will count a decade of exhaustions as zero.
     *
     * Exists so a recovery RATE can be dated: recovery has carried `paid_at` all along
     * and exhaustion carried nothing, so the two halves could never be put in the same
     * period. Only meaningful while `dunning_status='exhausted'`; not cleared if an
     * invoice somehow leaves that state, for the same reason `dunning_parked_at` is not.
     */
    dunningExhaustedAt: timestamp("dunning_exhausted_at", { withTimezone: true }),
    /**
     * The decline code that exhausted dunning, written by the failed-charge writers only
     * (0481). Read by `applyDunningFinalAction` for `billing_rules_config.mandate_revoked`.
     */
    dunningExhaustedCode: text("dunning_exhausted_code"),
    /**
     * `failed_change_charge = next_renewal` (0481): a failed charge on this invoice holds
     * its first retry until this instant, as a dunning pause.
     */
    retryHoldUntil: timestamp("retry_hold_until", { withTimezone: true }),
    /**
     * When to next REMIND a parked customer (0283) — the contact ladder a park never had.
     *
     * ⚠️ NOT `next_attempt_at`, and the separation is load-bearing. A parked invoice is
     * auto-collect-ON, so a reminder instant written into that column would make
     * `runDunningPass` charge the invoice — re-presenting the very debit parking exists to
     * stop — and would simultaneously hide the row from `sweepExpiredParkedDunning`, which
     * scans `next_attempt_at IS NULL`, so the window would never close. One column cannot
     * mean "retry then" and "write to them then".
     *
     * Re-derived from `dunning_parked_at` by `nextParkedReminderAt` on each advance, never
     * counted. Null = no further reminder (ladder spent, or not parked).
     */
    dunningNextReminderAt: timestamp("dunning_next_reminder_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // True when the invoice was cleared as bad debt via a write-off adjustment CN
    // (INV-4): status reads `paid` (zeroed) but the balance was never collected.
    writtenOff: boolean("written_off").notNull().default(false),
    // When the invoice was voided. `status='voided'` says THAT it happened; the invoice
    // list needs WHEN, and `created_at` was the only timestamp we kept.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    // Why it was voided (0308). Free text, like `subscriptions.cancel_reason_code`.
    voidReasonCode: text("void_reason_code"),
    // The schedule a paused dunning run had (0308): `{ until, next_attempt_at,
    // dunning_status }`. `resume_dunning` restores it while `next_attempt_at` still
    // equals `until`; null when never paused.
    dunningPause: jsonb("dunning_pause").$type<{
      until: string;
      next_attempt_at: string | null;
      dunning_status: string | null;
    }>(),
    // Total time a customer exclusion froze this invoice's dunning (0373). Every step
    // measured from the due date is measured from `due_date + dunning_held_ms` instead
    // (`dunningAnchor`); the due date itself never moves.
    dunningHeldMs: bigint("dunning_held_ms", { mode: "number" }).notNull().default(0),
    // Buyer's purchase-order reference. Free text, no engine behaviour — it is printed
    // on the invoice and searchable.
    poNumber: text("po_number"),
    // Expected payment date: a COLLECTIONS FORECAST, deliberately
    // distinct from `due_date`. `due_date` is the contractual Net-D term and drives
    // dunning; this is the date collections actually expects the money, set by a
    // human after talking to the customer. Nothing in the engine reads it — moving
    // it must never silently change when we dun.
    expectedPaymentDate: timestamp("expected_payment_date", { withTimezone: true }),
    // How the invoice came to exist. Derived from the
    // request/job provenance at creation (see EventSource): api | dashboard |
    // system (billing clock) | import. Null for rows predating the column.
    channel: text("channel"),
    // Address SNAPSHOT taken at invoice time, in the same shape as the customer's
    // (see `addressBody` in src/api/customer-routes.ts). Edited on the invoice
    // itself, independently of the customer, because a customer moving house must
    // not silently rewrite the address on invoices already issued.
    // Null = never snapshotted; fall back to the customer's current address.
    billingAddress: jsonb("billing_address"),
    shippingAddress: jsonb("shipping_address"),
    // The buyer's tax registration (GSTIN, else VAT id) as it stood at issue (0335). Null =
    // none on file then, or issued before 0335; readers fall back to the customer.
    customerTaxId: text("customer_tax_id"),
    // Frozen at issue too (0336/0337): the seller the document printed (name, address,
    // registration and its country),
    // whether prices included tax, the printed notes, and the net terms behind `due_date`.
    // `''` = recorded as none; NULL = issued before 0336, readers fall back to live settings.
    sellerName: text("seller_name"),
    sellerAddress: jsonb("seller_address"),
    sellerTaxId: text("seller_tax_id"),
    sellerTaxCountry: char("seller_tax_country", { length: 2 }),
    priceType: text("price_type"),
    notes: text("notes"),
    netTermDays: integer("net_term_days"),
    /** When it stopped being a draft. A pending draft's `created_at` is its draft date. */
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    // True for rows imported from an external system as
    // archival history: settled ones carry no ledger postings and reject
    // lifecycle ops; open ones are real collectible AR (opening ledger entry).
    imported: boolean("imported").notNull().default(false),
    // Free-form annotations; imported rows carry { source, source_id, source_payload }.
    metadata: jsonb("metadata"),
    // Post-H (#5): dedicated per-operation idempotency token for invoices raised by
    // a delta operation (change_term_end extension). Derived from the request
    // Idempotency-Key so a crash-retry reuses this invoice while a genuinely-new
    // operation raises a fresh charge (the old description-match false-matched on
    // extend→shrink→extend-again). Unique per business (partial index).
    originToken: text("origin_token"),
    // 0474: usage_interim | credit_purchase (CHECK). NULL = an ordinary invoice.
    purpose: text("purpose").$type<"usage_interim" | "credit_purchase">(),
    // Set while a collection attempt is IN FLIGHT, claimed by conditional UPDATE so
    // exactly one collector proceeds (0162). Several callers reach `collectInvoice` from
    // separate queues — the clock's auto-collection, an operator's manual collect, and
    // (until its removal) the shadow poller's replay — and every guard inside it is a
    // read-then-act, so two arrivals inside the same window both charged.
    // Cleared in a `finally`; a value older than COLLECTION_CLAIM_STALE_MS counts as
    // abandoned and may be re-claimed, so a crashed worker cannot strand an invoice.
    collectingAt: timestamp("collecting_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    // Maintained by the `invoices_touch` trigger (0336) on EVERY update, so no write path
    // can forget them — there are dozens. Never set them from application code.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
    resourceVersion: bigint("resource_version", { mode: "number" }).notNull().default(1),
  },
  (t) => [
    uniqueIndex("invoices_public_id_uq").on(t.publicId),
    index("invoices_customer_idx").on(t.customerId),
    index("invoices_subscription_idx").on(t.subscriptionId),
    index("invoices_status_idx").on(t.status),
    // Retries screen + nav badge: UNDER_RETRY's outer shape (0280).
    index("invoices_retry_idx")
      .on(t.businessId, t.nextAttemptAt, t.publicId)
      .where(
        sql`${t.status} in ('payment_due', 'not_paid') or (${t.dunningStatus} is not null and ${t.status} <> 'voided')`,
      ),
    // Keyset pagination for the invoices list — the fastest-growing table here.
    index("invoices_business_created_idx").on(t.businessId, t.createdAt.desc(), t.publicId.desc()),
    index("invoices_awaiting_number_idx")
      .on(t.businessId, t.createdAt, t.id)
      .where(sql`awaiting_number`),
    index("invoices_collect_due_idx")
      .on(t.collectDueAt)
      .where(sql`collect_due_at is not null`),
    index("invoices_usage_interim_idx")
      .on(t.subscriptionId, t.periodStart)
      .where(sql`purpose = 'usage_interim'`),
    uniqueIndex("invoices_origin_token_uq")
      .on(t.businessId, t.originToken)
      .where(sql`origin_token IS NOT NULL`),
    // A voided invoice bills nothing, so it never blocks a re-raise of its period.
    uniqueIndex("invoices_opens_period_uq")
      .on(t.subscriptionId, t.periodStart)
      .where(sql`opens_period AND status <> 'voided'`),
  ],
);

export const invoiceLineItems = pgTable(
  "invoice_line_items",
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
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // il_…
    description: text("description").notNull(),
    priceId: uuid("price_id").references(() => prices.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull().default(1),
    /**
     * 0454: the line's true quantity and rate (minor units), up to 12 dp. A trigger fills both
     * from `quantity` / `unitAmountMinor` when left null; meter lines write them directly.
     * Null only on rows written before 0454: read the integer fields then.
     */
    quantityDecimal: numeric("quantity_decimal", { precision: 38, scale: 12 }),
    unitAmountDecimal: numeric("unit_amount_decimal", { precision: 38, scale: 12 }),
    /**
     * The CONTRACTED RATE per unit — what one unit of this supply costs, NOT this line's
     * amount divided by its quantity.
     *
     * ⚠️ `unit × quantity ≠ amount` on a prorated line, BY DESIGN: the amount is the slice
     * actually charged and `periodStart`/`periodEnd` explain the difference. The importer
     * reads it as an independent field (`unit_amount ?? amount`) rather than deriving it.
     *
     * ⚠️ NOBODY DOCUMENTED THIS COLUMN UNTIL 2026-09-01, and that is precisely why it
     * drifted into carrying three different things at once: `amount ÷ quantity` on renewal
     * and prorated-charge lines, `= amount` on "Unused time on X ×qty" and discount/tax/
     * rounding rows, and a real contracted rate on every imported invoice. A credit that
     * needs to know what a customer was billed at could not cite it, which is half of the
     * ₹16,920 mis-rating in docs/PROGRESS.md.
     *
     * Redefined FORWARD ONLY. Rows written before that date are mixed and cannot be
     * back-derived — a prorated line does not record its own rate, and the subscription
     * item's snapshot has often moved since. A known cut-over beats an invented history.
     * A caller that knows the rate passes it; where it cannot, `createLineItems` falls back
     * to `amount ÷ quantity` and says so.
     */
    unitAmountMinor: bigint("unit_amount_minor", { mode: "bigint" }).notNull(),
    // GROSS, before any discount. The discount sits beside it in `discountMinor`,
    // never subtracted from here.
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    // Total discount attributed to this line across BOTH waterfall stages (0169).
    // Denormalised from `invoiceLineDiscounts` for the renderers; the per-stage split
    // lives there, because only the item-level part
    // nets into `invoices.subtotalMinor`.
    discountMinor: bigint("discount_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    /**
     * Insertion order within the invoice — the order the lines were billed, and the order the
     * document must always render them in.
     *
     * Filled by the DATABASE, not by callers. There are nine insert sites; a `position` column
     * every one of them had to remember to stamp is a rule that gets missed, which is exactly
     * how the 2026-08-25 trial/term change shipped with five write paths still stamping a term.
     * Nothing here can forget it.
     *
     * It exists because nothing else could order these rows: `public_id` is a nanoid, and
     * `created_at` is transaction time so every line of one billing run ties. Postgres was
     * therefore free to return an invoice's lines in any order, and did — one run read
     * [plan, addon] and the next [addon, plan], for the same invoice.
     */
    seq: bigserial("seq", { mode: "bigint" }),
    kind: text("kind").notNull(), // recurring | proration | usage | one_time | discount | tax | rounding
    // SNAPSHOT of the HSN/SAC code that classified this line at issue — resolved from
    // the product, else the business default. Snapshotted for the same reason
    // `seller_state_code` is: the invoice is a legal document that must keep saying what
    // it said, and re-deriving it later would silently rewrite history the first time
    // someone recatalogues a product. Null on lines raised before this shipped, and on
    // lines with no product behind them (discount / tax / rounding).
    taxCode: text("tax_code"),
    // For kind='discount' lines: the applied_coupon whose period this line consumed.
    // Lets voidInvoice refund the exact redemption (restore remaining_periods) so a
    // regenerate re-applies the coupon instead of billing at full price (G backlog).
    appliedCouponId: uuid("applied_coupon_id"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    /** How a `usage` line was rated (0380, `LineRating`). Immutable; null on other lines. */
    rating: jsonb("rating"),
    /** 0458: cost of a usage line in the line's currency, fixed at rating. Null = no cost. */
    costMinor: bigint("cost_minor", { mode: "bigint" }),
    /** 0458: event | price_list | mixed | partial | none | no_rate */
    costBasis: text("cost_basis"),
    /** 0385: a true-up line — 'minimum_spend' | 'commitment'. Null on every other line. */
    adjustment: text("adjustment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("invoice_line_items_public_id_uq").on(t.publicId),
    index("invoice_line_items_invoice_idx").on(t.invoiceId),
  ],
);

/**
 * One discount share, attributed to one line (0169).
 *
 * ── THE TWO-STAGE WATERFALL ──────────────────────────────────────────────────────────
 * An invoice is discounted in two stages, and `scope` is which one this share is:
 *
 *   subtotal_minor = Σ(line.amountMinor) − Σ(shares WHERE scope = 'item_level')
 *   total_minor    = subtotal_minor − Σ(shares WHERE scope = 'document_level') + tax
 *
 * ⚠️ `scope` is NOT "was this attributed to a line" — every share here is, including the
 * document-level ones: a document-level discount carries a `line_item_id` and shows up
 * in the line's discount total, yet leaves the subtotal untouched. Attribution and stage
 * are independent, and conflating them makes the stored subtotal unreproducible from the
 * rows beneath it.
 *
 * The engine has always computed both stages — `computeStackedDiscounts` returns
 * `lineDiscountByIndex` (item-level, per line) and the proportional spread it applies for
 * invoice-level coupons — and the tax pass consumes them separately so line-level
 * discounts are line-accurate. This table is where that attribution is finally kept
 * instead of recomputed or lost.
 */
export const invoiceLineDiscounts = pgTable(
  "invoice_line_discounts",
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
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    invoiceLineItemId: uuid("invoice_line_item_id")
      .notNull()
      .references(() => invoiceLineItems.id, { onDelete: "cascade" }),
    /**
     * Nullable on purpose: an imported invoice can carry a discount with no coupon behind
     * it at all — an ad-hoc document-level discount. Refusing those would drop
     * money out of the document rather than record it.
     */
    appliedCouponId: uuid("applied_coupon_id"),
    /** What to print when there is no coupon to name. */
    label: text("label"),
    /** item_level (inside the subtotal) | document_level (applied to it). */
    scope: text("scope").notNull(),
    /**
     * Always POSITIVE — the amount taken off. The negative sign convention belongs to the
     * aggregate `kind='discount'` line items; two sign conventions for one concept is how
     * a subtotal ends up off by exactly twice a discount.
     */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    index("invoice_line_discounts_invoice_idx").on(t.invoiceId),
    index("invoice_line_discounts_line_idx").on(t.invoiceLineItemId, t.scope),
    index("invoice_line_discounts_coupon_idx").on(t.appliedCouponId),
  ],
);
