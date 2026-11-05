import {
  pgTable,
  uuid,
  text,
  char,
  bigint,
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
import { invoices, invoiceLineItems } from "./invoices";

/**
 * A formal credit note against an invoice. The credit is delivered either as a
 * REFUND (money back to the card, via the refund flow) or as customer BALANCE
 * (added to customer_balance for future invoices).
 *
 * ── THE CUMULATIVE CEILING (corrected 2026-09-01) ────────────────────────────
 * This comment used to say "cumulative credit notes can never exceed the invoice
 * total (enforced in the service)". Both halves were wrong.
 *
 * It was not enforced at any WRITER. `issueRefundableCreditNote` capped only at
 * `refundableCapacityForInvoice`, which nets out what a note has since had
 * ALLOCATED — so allocating a full-value note re-opened the invoice's capacity and
 * a second full-value note was accepted, leaving the invoice carrying twice its
 * own value (`scripts/probe-cn-writer-ceiling.ts`). Four READERS clamped at the
 * ceiling; the writers never did.
 *
 * And the rule is tighter than "the invoice total":
 *
 *   REFUNDABLE notes are capped, cumulatively and at their FULL totals, by the cash
 *   the invoice actually COLLECTED — not by its total, and not netted by allocation
 *   or refund. On a 7.00 invoice with 3.50 paid, a 7.00 refundable note is refused
 *   ("should not be more than USD 3.50") and a 3.50 one accepted.
 *
 *   ADJUSTMENT notes are bounded separately, by the debt still OWED. A 3.50 adjustment
 *   and then a 3.50 refundable are both accepted on that same invoice — cumulative
 *   7.00 from two notes with two different bounds.
 *
 * The two bounds are disjoint (debt + cash = total), so their sum still cannot pass
 * the invoice total; that remains true, it is just no longer the binding rule.
 * Enforced in `credit-notes/service.ts` at both writers, inside `lockInvoiceCredit`:
 * `refundableCreditCeilingForInvoice` for the cash cap, `owed` +
 * `remainingCreditableAgainstInvoice` for the debt cap.
 */
export const creditNotes = pgTable(
  "credit_notes",
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
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    publicId: text("public_id").notNull(), // cn_…
    // SET-3: human-readable sequential number ("CN-42"), assigned at creation from
    // the business's credit_note_prefix + credit_note_next_number. Unique per business.
    number: text("number"),
    creditMethod: text("credit_method").notNull(), // legacy: refund | balance (superseded by `kind`)
    // E4/CN-1..2: adjustment (reduces an unpaid invoice) | refundable (credits the
    // refundable bucket; can be refunded to the card / allocated to invoices).
    kind: text("kind").notNull().default("refundable"),
    // adjusted | refund_due | refunded | voided
    status: text("status").notNull().default("refund_due"),
    // write_off | subscription_change | subscription_cancellation | chargeback | other
    reasonCode: text("reason_code"),
    // The note's `sub_total` (0186): the GROSS reversal, PRE-TAX, before any slice
    // is routed back to a credit bucket as a `credit_note_discounts` row.
    //   total_minor = subtotal_minor − Σ credit_note_discounts.amount_minor + tax
    // NULL means "gross not recorded; it equals total_minor" — the same convention `channel`
    // and `number` use for rows predating their column.
    //
    // ⚠ PRE-TAX is the whole of it. 0186's backfill set this to `total_minor` for every
    // historical row, which is tax-INCLUSIVE on a note carrying a `kind='tax'` item and so
    // fails the identity by exactly that tax. 0187 repaired those rows to `total − tax` where
    // the note's own lines prove the figure, and set the rest back to NULL — absent beats a
    // gross nobody derived.
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }),
    // The CASHABLE claim — NOT the gross. This is what `createRefundableCreditNote` credits
    // to REFUNDABLE_CREDIT; sizing it gross would hand the customer the returned promotional
    // slice a second time.
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    // Invariant (enforced in the service): total = allocated + refunded + available.
    allocatedMinor: bigint("allocated_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    refundedMinor: bigint("refunded_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // Money ACTUALLY paid out via gateway refunds (G review fix: `refunded_minor`
    // books the bucket draw into refunds_payable; this tracks what cleared it to
    // cash — a declined payout leaves paid_out < refunded, retried by the sweep).
    paidOutMinor: bigint("paid_out_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // 0491: a payout refund the gateway could not confirm; a person marks it paid or
    // returns it as credit (`resolveUnconfirmedCnPayout`). 0 = nothing to resolve.
    payoutUnconfirmedMinor: bigint("payout_unconfirmed_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // 0491: refunds returned as credit that the gateway later confirmed paid out.
    payoutDuplicatedMinor: bigint("payout_duplicated_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // 0491: refunds the gateway reported failed and then paid (answers out of order).
    payoutOutOfOrderMinor: bigint("payout_out_of_order_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    // 0487: the gateway refund a `refunded` note documents. A declined refund under
    // `declined_refund = issue_credit` reopens exactly this note.
    refundId: uuid("refund_id"),
    currency: char("currency", { length: 3 }).notNull(),
    /**
     * FX SNAPSHOT (0228), INHERITED from the invoice this note credits rather than
     * resolved fresh — a reversal converted at today's rate would not net to zero
     * against the document it reverses. Same direction and string-not-float rule as
     * `invoices.exchangeRate`; null when the credited invoice carried no rate.
     */
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 10 }),
    exchangeRateBase: char("exchange_rate_base", { length: 3 }),
    reason: text("reason"),
    // Note to the customer, set at creation (0309).
    customerNotes: text("customer_notes"),
    // When the note was voided. `status` records THAT it was voided; this records when.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    // Provenance at creation: api | dashboard | system |
    // import. Null for rows predating the column.
    channel: text("channel"),
    // Archival rows imported from an external system (no ledger postings).
    imported: boolean("imported").notNull().default(false),
    metadata: jsonb("metadata"),
    /**
     * A payout is IN FLIGHT — stamped in the same write as the refund earmark, cleared when
     * the payout settles or the earmark is reversed.
     *
     * Without it `sweepOutstandingCnPayouts` could not tell a STRANDED payable from one that
     * is simply mid-gateway-call: both read `refunded_minor > paid_out_minor`. On 2026-08-25
     * the clock re-attempted a refund 1.4 seconds after it had already succeeded, and Stripe
     * answered "charge has already been refunded" — it was a FULL refund, so there was
     * nothing left to send. A partial one would have gone through twice.
     *
     * A LEASE, not a lock: a process that dies mid-payout must not strand the payable
     * forever, so the sweep reclaims the row once the stamp ages past `CN_PAYOUT_LEASE`.
     * Reclaiming stranded payables is the sweep's whole purpose — a lock would defeat it.
     */
    payoutAttemptAt: timestamp("payout_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("credit_notes_public_id_uq").on(t.publicId),
    index("credit_notes_invoice_idx").on(t.invoiceId),
    index("credit_notes_refund_idx")
      .on(t.refundId)
      .where(sql`refund_id IS NOT NULL`),
    // Keyset pagination for the credit-notes list.
    index("credit_notes_business_created_idx").on(
      t.businessId,
      t.createdAt.desc(),
      t.publicId.desc(),
    ),
    // Post-H (#12): the human-readable number is unique per business (partial —
    // pre-H archival CNs may lack one until the 0109 backfill assigns it).
    uniqueIndex("credit_notes_number_uq")
      .on(t.businessId, t.number)
      .where(sql`number IS NOT NULL`),
  ],
);

/**
 * Allocation of a credit note's amount to an invoice (E4/CN-2). Adjustment CNs
 * self-allocate to the invoice they reduce; refundable CNs are FIFO-allocated as
 * their credit is drawn against invoices at generation. Σ allocations for a CN =
 * its `allocated_minor`.
 */
export const creditNoteAllocations = pgTable(
  "credit_note_allocations",
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
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => creditNotes.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    index("credit_note_allocations_cn_idx").on(t.creditNoteId),
    index("credit_note_allocations_invoice_idx").on(t.invoiceId),
  ],
);

/**
 * The note's `discounts[]` (0186): what was taken off its GROSS reversal
 * (`credit_notes.subtotal_minor`) and which bucket it went back to, so the document can
 * express "reversed 41899.00, returned 41899.00 to promotional credits, 0.00 cashable".
 * The gap is a typed DISCOUNT rather than a `*_credits_applied` field, and a table rather
 * than columns, because one note may carry several and each has its own type.
 * The invoice-side twin is `invoiceLineDiscounts` (0169).
 *
 * Nothing populates this yet.
 */
export const creditNoteDiscounts = pgTable(
  "credit_note_discounts",
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
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => creditNotes.id, { onDelete: "cascade" }),
    // What kind of deduction this is. DB-constrained to promotional_credits |
    // excess_payments | item_level_coupon | document_level_coupon | prorated_credits;
    // the last three are reserved for the importer.
    type: text("type").notNull(),
    // Always POSITIVE — the amount taken off the gross.
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    // Free text, e.g. "Promotional Credits Returned".
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [index("credit_note_discounts_cn_idx").on(t.creditNoteId)],
);

export const creditNoteItems = pgTable(
  "credit_note_items",
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
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => creditNotes.id, { onDelete: "cascade" }),
    publicId: text("public_id").notNull(), // cni_…
    description: text("description").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    // The invoice's line vocabulary, verbatim (0188): recurring | proration | usage | one_time |
    // discount | tax | rounding. A credit note reverses invoice lines, so a second vocabulary
    // for the same concept would make `kind === 'tax'` — the one test both documents need —
    // stop being the same test on both. Same constraint style as `invoiceLineItems.kind`:
    // plain text, no CHECK, the values documented here.
    //
    // What it buys: the document can exclude the tax item from the item table the way the
    // invoice's does, instead of matching `description = 'Tax reversal on credited time'` —
    // the only handle a credit note ever had, since `applied_taxes` is invoice-scoped and the
    // tax item carries no `invoiceLineItemId`.
    //
    // NULL = "line kind not recorded". Nullable with NO default on purpose: nothing writes it
    // yet, so NOT NULL would reject every insert the engine makes, and the only defaultable
    // value (the supply one) would label future TAX lines as supply — the exact falsehood the
    // column exists to prevent. Readers must fall back, not trust a value nobody set.
    kind: text("kind"),
    // Service period this credit covers, printed under each credit-note item
    // ("Jul 13 - Aug 12, 2026"). We only had a description, so a prorated
    // credit gave no clue which period it reversed. Copied from the invoice line
    // being credited (`invoice_line_item_id`), so it always agrees with the invoice.
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    // The invoice line this item credits. Also what lets the UI show the credit
    // against the original charge instead of a free-floating description.
    invoiceLineItemId: uuid("invoice_line_item_id").references(() => invoiceLineItems.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`app_now()`)
      .notNull(),
  },
  (t) => [
    uniqueIndex("credit_note_items_public_id_uq").on(t.publicId),
    index("credit_note_items_invoice_line_idx").on(t.invoiceLineItemId),
  ],
);
