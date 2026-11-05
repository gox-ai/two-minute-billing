/**
 * Cancellation credits (E5) — the helper Phase F's cancel/downgrade flows call to
 * credit a customer for the UNUSED portion of a term.
 *
 *  - `prorate` → credit the time-remaining fraction of the period's charge,
 *  - `full`    → credit the whole period's charge,
 *  - `none`    → no credit.
 *
 * Delivery, refined by the F review:
 *  - The base is the invoice THAT BILLED THE CURRENT TERM (period match), never
 *    just "the latest invoice" — an unbilled-charges or proration invoice created
 *    seconds earlier must not become the credit base. Pending drafts never
 *    qualify (nothing was charged).
 *  - UNPAID term → an ADJUSTMENT credit note (reduces the amount still due).
 *  - PAID term → the credit is split by HOW the invoice was paid: the slice that
 *    was covered by promotional / excess / refundable bucket draws goes back to
 *    its own bucket (promotional credit must never become cashable), and only
 *    the cash-paid slice becomes a refundable credit note.
 *  - Idempotent per invoice (reason-coded CN + restore ledger marker), so a
 *    partially-failed cancel can re-run without double-crediting.
 *
 * The decision is split in two: `planCancellationCredit` READS and DECIDES,
 * `issueProratedCreditForUnusedTerm` WRITES what the plan says. `estimateCancel`
 * (subscriptions/estimate.ts) previews a cancellation by calling the same planner,
 * so the preview cannot drift from the credit it predicts — the failure mode this
 * module's own header warns about, applied to itself.
 */
import { businessNow } from "@/platform/clock";
import { and, asc, desc, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import {
  billingModeFor,
  prorationBoundary,
  prorationWindowStart,
} from "@/modules/subscriptions/billing-mode";
import { prorate } from "./proration";
import { isOpenInvoiceStatus } from "@/modules/invoicing/status";
import { postEntries } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { loadCustomerPublicId } from "@/modules/customers/serialize";
import {
  PROMOTIONAL_CREDIT,
  EXCESS_PAYMENT,
  lockCustomerBalances,
  emitPromotionalCreditMovement,
} from "@/modules/customers/balances";
import {
  issueAdjustmentCreditNote,
  createRefundableCreditNote,
  refundableCapacityForInvoice,
  type CreditNoteDiscountInput,
} from "@/modules/credit-notes/service";

import { createLogger } from "@/platform/logger";

/**
 * This module decides — and issues — the money a customer gets back when a
 * subscription is cancelled mid-term. It had NO logging at all, which is how a
 * failure here reached the caller as a `warnings[]` string and nothing else
 * (see subscriptions/service.ts § cancelSubscriptionWithOptions). The lines below
 * are the ops record of a credit that was, or was not, delivered.
 */
const log = createLogger("subscriptions");
import {
  invoices,
  subscriptions,
  payments,
  creditNotes,
  creditNoteDiscounts,
  ledgerEntries,
} from "@db/schema";

export type CreditOption = "prorate" | "full" | "none";

const CANCELLATION_REASON = "subscription_cancellation";
const RESTORE_SOURCE = "cancellation_credit_restore";

/**
 * Reason codes of the notes that hand back UNUSED TIME on an invoice — a mid-term
 * change / removal / term reset (`subscription_change`, proration.ts + items.ts) and a
 * term shortening (`term_change`, `prorateTermChange`). A cancellation's own notes are
 * NOT here: re-running a cancel is guarded by `priorCreditNote` / `priorRestore`, and
 * counting them would turn that idempotent replay into a silent no-op instead.
 */
const TERM_CREDIT_REASONS = new Set(["subscription_change", "term_change"]);

/**
 * What a cancellation credit WOULD do — every read and every arithmetic decision,
 * with no writes. Consumed by the issuer below and by `estimateCancel`.
 *
 * `null` from the planner means "no credit at all": option `none`, no invoice ever
 * billed this term, a zero-total invoice, or a credit that prorates to nothing.
 */
export interface CancellationCreditPlan {
  invoiceId: string;
  invoicePublicId: string;
  /**
   * The invoice's DOCUMENT number (`INV-7835`), for anything a person reads. Null until
   * the invoice is numbered, which is why every consumer falls back to the public id
   * rather than printing an empty string.
   */
  invoiceNumber: string | null;
  invoiceStatus: string;
  customerId: string;
  currency: string;
  /** The credit base — the term invoice's total. */
  baseMinor: bigint;
  /** The full credit before delivery-specific caps (`full` → base, else prorated). */
  creditMinor: bigint;
  /** The boundary the proration was taken at (whole-day businesses round it up). */
  prorationAt: Date;
  /**
   * The window this credit HANDS BACK, stamped on the note's items.
   *
   * `[prorationAt, the invoice's period end)` for a prorated cancellation — the unused
   * tail. For `creditOption: 'full'` it is the WHOLE billed window, because that option
   * hands back the entire invoice rather than a slice of it, and a note claiming only the
   * tail would understate what it reversed.
   *
   * Why it is stamped at all: without it every cancellation note's item carried
   * `period_start`/`period_end` NULL — measured on sub_XXXXXXXXXXXXXXXXXXXXXX01 (CN-1701,
   * CN-1704) — so the document could not say which service it reversed. CHANGE notes
   * carry the credited window, and the cancellation path follows that same rule.
   */
  creditedFrom: Date;
  creditedTo: Date;
  /** UNPAID term → adjustment against the invoice; PAID term → bucket/cash split. */
  delivery: "adjustment" | "split";
  /** `adjustment` only: the credit after the amount-due cap. Zero means nothing to issue. */
  adjustmentMinor: bigint;
  /**
   * Bucket-funded slices, returned to their own buckets.
   *
   * `split` sets both. `adjustment` sets `promotionalRestoreMinor` alone, for the credit
   * that runs PAST the invoice's taxed base: beyond it there is no retained supply for
   * the promotional credit to fund, so the overflow the amount-due cap would swallow is
   * given back to the promotional bucket instead (2026-08-25). `excessRestoreMinor` stays
   * zero there — the excess bucket is applied POST-tax, so it funds the same slice the
   * amount due does and never overflows it.
   */
  promotionalRestoreMinor: bigint;
  excessRestoreMinor: bigint;
  /** `split` only: the credit-grant-funded slice, given back to the grants (G3). */
  grantRestoreMinor?: bigint;
  /** `split` only: the cash-funded slice, after the retained-cash+refundable cap. */
  refundableCreditNoteMinor: bigint;
  /**
   * A prior, non-voided cancellation credit note for this invoice. The issuer
   * returns it instead of crediting again, so a preview must report that THIS
   * INVOICE'S share adds nothing rather than promising the amount above a second time.
   *
   * ⚠️ Scoped to the invoice on purpose. This used to say "this cancellation grants
   * nothing further", and `estimateCancel` wrote exactly that — true only when EVERY
   * plan is spent (`planAlreadyCredited` on all of them). A term with one fresh invoice
   * among three showed the sentence twice above a credit the fresh one legitimately
   * owed, and the panel read as self-contradicting.
   */
  priorCreditNote: typeof creditNotes.$inferSelect | null;
  /**
   * `split` only: a prior bucket-restore ledger marker for this invoice. Same
   * meaning as `priorCreditNote` — already credited, nothing further happens.
   */
  priorRestore: boolean;
}

/** True when this plan would move nothing, because a prior run already credited it. */
export function planAlreadyCredited(plan: CancellationCreditPlan): boolean {
  return plan.priorCreditNote != null || (plan.delivery === "split" && plan.priorRestore);
}

/**
 * The one plan a SINGULAR field must describe when a term is billed across several
 * invoices — `estimateCancel`'s `delivery` / `invoice`, which cannot be widened without
 * an SDK change.
 *
 * It is the first plan that actually DELIVERS something, not `plans[0]`.
 *
 * Why: `already_credited` is `plans.every(planAlreadyCredited)` — right, because one
 * fresh part still delivers credit — while `invoice` used to be `plans[0]`, which is the
 * OLDEST term invoice. Measured on sub_XXXXXXXXXXXXXXXXXXXXXX01 (2026-09-03, #19): the
 * estimate returned `already_credited: false` alongside `invoice: inv_95yib…` and a
 * warning naming that same invoice as already credited for cancellation. Both fields were
 * individually defensible and the object as a whole asserted two contradictory things, so
 * neither could be acted on. Picking the first DELIVERING plan makes `delivery`,
 * `invoice` and `already_credited` describe the same invoice by construction.
 *
 * Falls back to `plans[0]` when every plan is already credited — there is no delivering
 * plan to name, `already_credited` is then `true`, and the pair is consistent again.
 */
export function representativePlan(plans: CancellationCreditPlan[]): CancellationCreditPlan | null {
  return plans.find((p) => !planAlreadyCredited(p)) ?? plans[0] ?? null;
}

/**
 * The amount a plan actually delivers to the customer, after caps and idempotency.
 *
 * An adjustment delivers what it takes off the bill PLUS whatever promotional credit it
 * frees (2026-08-25) — both reach the customer, one as debt they no longer owe and one as
 * balance they can spend, and a preview that reported only the first would understate a
 * cancellation that runs past the invoice's taxed base. Zero for every plan that frees
 * none, so the figure is unchanged wherever no promotional credit was applied.
 */
export function planDeliveredMinor(plan: CancellationCreditPlan): bigint {
  if (planAlreadyCredited(plan)) return 0n;
  return plan.delivery === "adjustment"
    ? // `refundableCreditNoteMinor` BELONGS HERE (#19, 2026-09-03). The adjustment branch
      // has been able to issue a refundable note since 2026-08-26 — the slice the
      // amount-due cap cuts that is not debt but the customer's own funding — and
      // `issueOneInvoice` really writes it (`createRefundableCreditNote`, same
      // transaction as the adjustment). This sum omitted it, so `delivered_minor` reported
      // only the debt relief and understated a part-funded cancellation by the whole cash
      // slice. Caught by an invariant fixture: on an invoice of
      // 3000 with 1000 due and 2000 of recycled refundable credit, the writer issues
      // 1000 + 2000 and this function said 1000.
      plan.adjustmentMinor + plan.promotionalRestoreMinor + plan.refundableCreditNoteMinor
    : plan.promotionalRestoreMinor +
        plan.excessRestoreMinor +
        (plan.grantRestoreMinor ?? 0n) +
        plan.refundableCreditNoteMinor;
}

const CREDITABLE = (r: typeof invoices.$inferSelect) =>
  !["voided", "pending"].includes(r.status) && r.totalMinor > 0n;

/**
 * The invoice that billed the CURRENT TERM: period_start must match the sub's
 * current period (F review blocker — "latest invoice" picked up unbilled-charge
 * and proration invoices). Pending drafts billed nothing → excluded.
 *
 * This is the PRIMARY invoice, and picking it is unchanged behaviour on purpose —
 * see `termInvoices` for the ones this misses.
 */
async function primaryTermInvoice(
  tx: Tx,
  businessId: string,
  sub: typeof subscriptions.$inferSelect,
): Promise<typeof invoices.$inferSelect | null> {
  const rows = await tx
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.businessId, businessId),
        eq(invoices.subscriptionId, sub.id),
        // A trialling subscription has no term and so no term invoice (2026-08-25); the
        // caller treats an empty result as 'nothing to credit', which is correct.
        eq(invoices.periodStart, sub.currentPeriodStart ?? new Date(0)),
      ),
    )
    .orderBy(desc(invoices.createdAt));
  return rows.find(CREDITABLE) ?? null;
}

/**
 * EVERY invoice that charged for time inside the current term — primary first.
 *
 * ── WHY THIS EXISTS (measured 2026-08-24, scripts/probe-cancel-multi-invoice.ts) ──
 * `primaryTermInvoice` matches `period_start` EXACTLY, and a mid-term charge does not
 * have the term's period_start: adding an add-on on Aug 16 of an Aug 1–Sep 1 term
 * raises an invoice with period_start Aug 16. Cancelling on Aug 21 then credited
 * ₹425.81 — precisely 11/31 of the ₹1,200 base invoice — and the ₹309.68 add-on
 * invoice, paid in cash, was never looked at. The customer silently lost the unused
 * part of it, because `cnCap` clamps without erroring.
 *
 * `proration.ts` already fixed the same defect for term resets (its D1 comment: "This
 * used to credit a single invoice … A term billed across several invoices then could
 * not be credited at all"); it was never ported here. The whole term must be credited.
 *
 * THE PERIOD TEST: the invoice's window must START inside the term. Not equality — that
 * would throw the add-on above straight back out — and not OVERLAP either.
 *
 * ── WHY OVERLAP WAS WRONG (#19, measured 2026-09-03 on sub_XXXXXXXXXXXXXXXXXXXXXX01) ──
 * This test used to be `periodEnd > termStart && periodStart < termEnd`, and its docblock
 * justified that as still excluding the previous term "because its period_end equals this
 * term's period_start, and the test is strict". That is true only when terms tile
 * end-to-start. A MID-TERM PLAN CHANGE is exactly the thing that breaks the tiling: it
 * starts a new term at the change instant while the old invoice keeps a billing window
 * that runs PAST it, so the overlap holds and the superseded invoice stayed in the set.
 *
 * Measured on that subscription: 26 invoices overlapped the 02-Sep → 02-Oct term
 * (₹12,38,832.22 of charge), only 8 had a window starting inside it, and cancelling
 * offered ₹81,419.20 full / ₹67,605.97 prorated where ₹32,943.24 was owed — ₹59,235.20 of
 * it as REFUNDABLE credit against ₹10,759.24 that existed. The chosen primary invoice was
 * three plan changes old.
 *
 * ── AND WHY AN "ALREADY CREDITED?" TEST CANNOT REPLACE IT ────────────────────────────
 * The obvious cheaper fix is to drop invoices with no uncredited charge left, on the
 * theory that a superseded invoice is superseded precisely because the change credited it
 * in full. Measured, and false: `alreadyReturned` below ALREADY does that subtraction, and
 * 4 of the 26 still had a positive remainder (₹40,254.97, ₹16,192.44, ₹2,787.79 and
 * INV-7826's own ₹32,943.24). The remainder on a superseded invoice is the charge for time
 * the customer USED before the change — real, uncredited, and correctly not credited. Only
 * the period test can tell it apart from unused time, so this is where the fix belongs.
 *
 * What the rule says, positively: an invoice belongs to this term when it billed time that
 * BEGINS in this term. A mid-term add-on does (period_start 16-Aug of an Aug 1–Sep 1
 * term); the previous term's invoice does not (period_start 30-Aug of a term starting
 * 02-Sep), whatever its period_end says. The change path does the same: it credits the
 * new invoice and leaves the superseded one alone.
 *
 * Still narrower than proration.ts's set, which applies no period filter at all.
 */
async function termInvoices(
  tx: Tx,
  businessId: string,
  sub: typeof subscriptions.$inferSelect,
): Promise<Array<typeof invoices.$inferSelect>> {
  const primary = await primaryTermInvoice(tx, businessId, sub);
  const termStart = sub.currentPeriodStart;
  const termEnd = sub.currentPeriodEnd;
  if (!termStart || !termEnd) return primary ? [primary] : [];

  const rows = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.businessId, businessId), eq(invoices.subscriptionId, sub.id)))
    .orderBy(asc(invoices.createdAt));
  const others = rows.filter(
    (r) =>
      r.id !== primary?.id &&
      CREDITABLE(r) &&
      r.periodStart != null &&
      r.periodEnd != null &&
      // `>=`, so the term's own invoice (period_start === termStart) and every mid-term
      // charge raised after it qualify, while an invoice that began before this term
      // started — i.e. billed a term this one superseded — does not.
      r.periodStart >= termStart &&
      r.periodStart < termEnd,
  );
  // OLDEST FIRST, including the primary. The set is what matters for money — each invoice
  // owes back the unused fraction of what IT charged, so the amounts do not depend on the
  // order — but the ORDER decides the sequence the credit notes are created in, and pinning
  // `primary` at the head made that sequence depend on which invoice `primaryTermInvoice`
  // happened to pick (the newest live one).
  //
  // Measured 2026-08-25: cancelling a term billed across a 29700 plan invoice and an 8000
  // add-on invoice created the notes 8000-then-29700 rather than oldest-first, so notes that
  // were individually correct arrived in an unstable order and a consumer reading
  // creditNotes[0] saw eight fields move. `proration.ts` already sorts its own credit split
  // ascending (:413, :707); this is the one path that did not.
  const all = primary ? [primary, ...others] : others;
  return all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/**
 * Split a credit against a PAID invoice by HOW that invoice was actually funded.
 *
 * Pro-rata across the funding sources (floor each bucket share; the cash slice takes the
 * remainder so the parts sum exactly). Bucket-funded slices must go back to their OWN
 * buckets — promotional credit must never become cashable — and only the cash + recycled
 * refundable slice may become a refundable credit note, capped at `cashAvailable +
 * refundableApplied` so withholding cannot mint credit beyond what funded the invoice.
 *
 * `cashAvailable` is cash STILL RETAINED, not cash ever collected — it must come from
 * `refundableCapacityForInvoice`, which subtracts gateway refunds and live refundable notes.
 * Passing a raw payments sum minted cashable credit against money already returned to the
 * card: measured 2026-08-25, refund 1000.00 in full then cancel on day 16 of 31 and the
 * cancellation still wrote a 516.13 refundable note, after which the capacity function
 * itself reported AVAILABLE -516.13. The system carried its own detector for the state and
 * nothing consulted it.
 *
 * EXPORTED because `proration.ts`'s `creditOneInvoice` owes the identical split on the
 * CHANGE path. It used to issue a refundable CN for the WHOLE credit regardless of
 * funding, so an invoice settled with credit hit the cash-only cap and refused the entire
 * subscription change. The change must apply, with the promotional slice going back to
 * the balance (D-cn-cap in docs/PROGRESS.md).
 */
export function splitCreditByFunding(input: {
  creditMinor: bigint;
  /** The invoice's own total — the denominator every share is taken against. */
  baseMinor: bigint;
  invoice: Pick<
    typeof invoices.$inferSelect,
    | "promotionalCreditsAppliedMinor"
    | "excessPaymentsAppliedMinor"
    | "refundableCreditsAppliedMinor"
  > &
    Partial<
      Pick<typeof invoices.$inferSelect, "grantCreditsPreTaxMinor" | "grantCreditsPostTaxMinor">
    >;
  cashAvailable: bigint;
  /** Credit-grant money this invoice drew and has not given back (`grantDrawnOutstanding`). */
  grantOutstandingMinor?: bigint;
  /**
   * Promotional credit this invoice has ALREADY handed back — by a cash refund's own
   * proportional restore, or by an earlier credit against the same invoice.
   *
   * Without it the two restores draw from the same pool independently and overshoot.
   * Measured 2026-08-28: a 500 refund returned 236 promo, then the mid-term
   * change's credit restored `3113824 × 1000000/3114324 = 999839` — 1,000,075 returned
   * against 1,000,000 ever consumed, an overshoot of +75. The invoice cannot give back more promotional credit than it took.
   */
  promoAlreadyRestoredMinor?: bigint;
}): { promotional: bigint; excess: bigint; refundable: bigint; grants: bigint } {
  const { creditMinor, baseMinor } = input;
  if (creditMinor <= 0n || baseMinor <= 0n)
    return { promotional: 0n, excess: 0n, refundable: 0n, grants: 0n };
  const promoAppliedRaw = input.invoice.promotionalCreditsAppliedMinor ?? 0n;
  const restored = input.promoAlreadyRestoredMinor ?? 0n;
  const promoApplied = promoAppliedRaw > restored ? promoAppliedRaw - restored : 0n;
  const excessApplied = input.invoice.excessPaymentsAppliedMinor ?? 0n;
  const refundableApplied = input.invoice.refundableCreditsAppliedMinor ?? 0n;
  const promotional = (creditMinor * promoApplied) / baseMinor;
  const excess = (creditMinor * excessApplied) / baseMinor;
  // Credit grants (G3): their slice goes back to the grants, never into cash.
  const grantApplied =
    (input.invoice.grantCreditsPreTaxMinor ?? 0n) + (input.invoice.grantCreditsPostTaxMinor ?? 0n);
  const grantShare = (creditMinor * grantApplied) / baseMinor;
  const grantCap = input.grantOutstandingMinor ?? grantApplied;
  const grants = grantShare < grantCap ? grantShare : grantCap;
  let refundable = creditMinor - promotional - excess - grantShare;
  const cap = input.cashAvailable + refundableApplied;
  if (refundable > cap) refundable = cap;
  return { promotional, excess, refundable: refundable > 0n ? refundable : 0n, grants };
}

/**
 * Promotional credit this invoice has ALREADY handed back, read from the ledger.
 *
 * Every restore path posts through `restoreBucketFundedSlices`, which stamps the INVOICE's
 * public id as `sourceId` whatever the caller's `sourceType` — so one read covers a cash
 * refund's proportional restore and a credit note's split alike. That is the property that
 * makes a cap possible without a column to maintain.
 *
 * CREDITS ONLY. `credit_applied` DEBITS this same account under the same `sourceId` when the
 * invoice DRAWS promo, so a signed net would subtract the original application and report a
 * nonsense figure. A restore is always the credit leg. (That mistake was made first and cost
 * a round trip.)
 *
 * Lives here rather than inline at a call site because two independent paths cap against it —
 * `creditOneInvoice` and the cash refund's promotional slice — and a cap that disagreed
 * between them would let the pool overshoot in exactly the direction it is meant to prevent.
 */
export async function promoRestoredForInvoice(
  tx: Tx,
  businessId: string,
  invoicePublicId: string,
): Promise<bigint> {
  const rows = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.businessId, businessId),
        eq(ledgerEntries.sourceId, invoicePublicId),
        eq(ledgerEntries.account, PROMOTIONAL_CREDIT),
      ),
    );
  return rows.reduce((sum, e) => sum + (e.direction === "credit" ? e.amountMinor : 0n), 0n);
}

/**
 * Post bucket-funded slices back to their own buckets, and say so.
 *
 * `sourceType` is the caller's: cancellation uses `cancellation_credit_restore` and
 * treats its presence on an invoice as an idempotency marker (one cancellation per
 * invoice). The CHANGE path must NOT reuse that marker — a subscription can legitimately
 * be changed many times in one term, so a per-invoice marker would suppress every restore
 * after the first. It relies instead on the enclosing transaction and the API's
 * `Idempotency-Key`, exactly as the credit note issued alongside it does.
 */
export async function restoreBucketFundedSlices(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    currency: string;
    invoicePublicId: string;
    promotional: bigint;
    excess: bigint;
    sourceType: string;
    reasonCode: string;
  },
): Promise<void> {
  const lines: Array<{
    account: string;
    direction: "debit" | "credit";
    amountMinor: bigint;
    currency: string;
  }> = [];
  if (input.promotional > 0n) {
    lines.push(
      {
        account: "promotional_credit",
        direction: "debit",
        amountMinor: input.promotional,
        currency: input.currency,
      },
      {
        account: PROMOTIONAL_CREDIT,
        direction: "credit",
        amountMinor: input.promotional,
        currency: input.currency,
      },
    );
  }
  if (input.excess > 0n) {
    lines.push(
      {
        account: "credit_adjustments",
        direction: "debit",
        amountMinor: input.excess,
        currency: input.currency,
      },
      {
        account: EXCESS_PAYMENT,
        direction: "credit",
        amountMinor: input.excess,
        currency: input.currency,
      },
    );
  }
  if (lines.length === 0) return;
  await postEntries(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
      sourceType: input.sourceType,
      sourceId: input.invoicePublicId,
      lines,
    },
    tx,
  );
  /**
   * `customer:` is what makes this event enrichable, and it is not decoration.
   * `resourceTypeOf("customer_credits_restored")` is `customer`, `deriveResourceId` reads
   * `data.customer`, and without it `buildEventContent` returns before its switch — so a
   * customer-balance event shipped with no customer, no invoice and no subscription on it.
   * PUBLIC id: `loadCustomerSnapshot` matches `customers.public_id`, and `input.customerId`
   * is the internal uuid, which resolves to nothing just as quietly.
   *
   * Added ALONGSIDE `invoice`, never replacing it — consumers key this event on the invoice.
   */
  const customerPublicId = await loadCustomerPublicId(tx, input.customerId);
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "customer_credits_restored",
    data: {
      customer: customerPublicId,
      invoice: input.invoicePublicId,
      promotional_minor: Number(input.promotional),
      excess_minor: Number(input.excess),
      currency: input.currency,
      reason: input.reasonCode,
    },
  });
  // ADDITIONALLY, not instead: `customer_credits_restored` is our own multi-bucket
  // summary (promotional + excess in one payload, keyed on the invoice) and existing
  // consumers rely on it, but it is not the promotional-credit movement event. A
  // consumer tracking the promo balance needs the same `_added` event the manual grant
  // emits. The excess bucket gets no twin: there is no per-bucket event type
  // for it, only `customer_excess_payment_recorded`, which means something else
  // (offline money received), so reusing it here would misreport a restore as income.
  await emitPromotionalCreditMovement(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: input.customerId,
    amountMinor: input.promotional,
    currency: input.currency,
    direction: "added",
    description: `Restored from invoice ${input.invoicePublicId} (${input.reasonCode})`,
    invoicePublicId: input.invoicePublicId,
  });
}

/**
 * Read-and-decide half of `issueProratedCreditForUnusedTerm` — no writes.
 *
 * Pass `tx` to run inside a caller's transaction (the issuer does, under
 * `lockCustomerBalances`, so the figures it acts on are the locked ones). Without
 * `tx` it opens its own read-only tenant scope, which is what a preview wants.
 */
export async function planCancellationCredit(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  creditOption: CreditOption;
  /** "Now" for the proration boundary (defaults to the current time). */
  now?: Date;
  /** Leave the cancellation day unbilled (credit it). Whole-day proration only. */
  excludeCancellationDay?: boolean;
  tx?: Tx;
  /**
   * Plan for THIS invoice instead of resolving the term's primary one. Set by
   * `planCancellationCredits` so one term can yield one plan per invoice; omitted
   * everywhere else, which keeps the single-invoice behaviour byte-for-byte.
   */
  invoice?: typeof invoices.$inferSelect;
}): Promise<CancellationCreditPlan | null> {
  const { organizationId, businessId, subscription: sub } = input;
  if (input.creditOption === "none") return null;
  const now = input.now ?? businessNow(businessId);

  const run = async (tx: Tx): Promise<CancellationCreditPlan | null> => {
    const inv = input.invoice ?? (await primaryTermInvoice(tx, businessId, sub));
    if (!inv || inv.totalMinor <= 0n) return null;

    const base = inv.totalMinor;
    // THE INVOICE'S OWN window, falling back to the subscription's — not the other way
    // round. An invoice is owed back the unused fraction of what IT charged for, and a
    // mid-term charge covers only part of the term: the ₹309.68 add-on invoice above
    // billed Aug 16–Sep 1, so cancelling on Aug 21 leaves 11 of ITS 16 days unused
    // (₹212.90), not 11/31 of it (₹109.89). Reading the subscription's window first
    // would prorate every invoice as though it had covered the whole term.
    //
    // For the primary invoice the two windows are the same, so this is a no-op on the
    // single-invoice path that every existing scenario exercises.
    const periodStart = inv.periodStart ?? sub.currentPeriodStart ?? now;
    const periodEnd = inv.periodEnd ?? sub.currentPeriodEnd ?? now;
    // With WHOLE-DAY proration the term is credited by whole days (the
    // customer keeps the billing day they are in). Advancing the proration boundary to the
    // end of that day makes the existing time-fraction prorate() collapse to a whole-day
    // credit; `exact` businesses prorate as-of `now` unchanged.
    // `billingModeFor(tx, …)` rather than `loadBillingMode(org, …)`: the issuer runs
    // this inside a transaction that already holds `lockCustomerBalances`, and the
    // org-scoped variant would open a SECOND pool connection while that row lock is
    // held. Same read, same tenant scope, no extra connection.
    // `excludeCancellationDay` credits the billing day of the cancellation too (whole-day
    // proration only; the route refuses it elsewhere).
    const mode = await billingModeFor(tx, businessId);
    const prorationAt = input.excludeCancellationDay
      ? prorationWindowStart(now, periodStart, mode)
      : prorationBoundary(now, periodStart, mode);

    // ── WHICH BASE THE UNUSED TIME IS PRORATED OFF (D-cn-cap, 2026-08-25) ────────────
    // `base` is the invoice's tax-INCLUSIVE total, and for a PAID invoice that is right:
    // the whole gross is reversed and `splitCreditByFunding` sends each funding slice —
    // promotional included — back where it came from, so the promo slice is credited at
    // its own (untaxed) value.
    //
    // An UNPAID invoice is the other case. Its note is an ADJUSTMENT: it reduces amount
    // DUE and hands nothing back to the promotional bucket, so the promo goes on funding
    // the supply the customer KEEPS and every credited unit comes off the TAXED slice.
    // Prorating the gross then credits a fraction of the untaxed promo slice as if it
    // were money, while reversing only that same fraction of the tax — and the customer
    // is left owing for supply they gave back. Measured
    // (`scripts/probe-cancel-unpaid-promo-basis.ts`): the ₹27,918 promo-funded term
    // (supply 2791800, promo 1000000 pre-tax ⇒ taxable base 1791800, IGST 322524, total
    // 3114324, due 2114324) cancelled mid-term credited 15/31 × 3114324 = 1506931 and left
    // **607393** due, where the retained 1440929 of supply owes 440929 of taxable base plus
    // 79367 of tax = **520296**. 87097 short — exactly `rate × promo × unused/term`, the
    // same residual the CHANGE path shed in b4dc962, reached from the other side.
    //
    // So an open invoice prorates the SUPPLY and grosses it up at the STATUTORY rate
    // `bookedTax / (netBase − promo)` on the base actually released — the identical basis
    // `proration.ts`'s `creditOneInvoice` uses, which is what makes a cancel and a change
    // land on the SAME number for the same unused time. Only when promotional credit was
    // actually applied: with promo = 0 the two are the same fraction of the same money, so
    // every existing fixture keeps `prorate(base)` byte-for-byte, rounding included.
    const promoApplied = inv.promotionalCreditsAppliedMinor ?? 0n;
    const openWithPromo = isOpenInvoiceStatus(inv.status) && promoApplied > 0n;
    // Only meaningful in the `openWithPromo` case; zero elsewhere keeps the overflow
    // arithmetic in the adjustment branch below inert.
    let unusedSupply = 0n;
    let taxedBase = 0n;
    let gross: bigint;
    // The tax the invoice actually booked, off its own ledger — drift-proof for
    // inclusive / additive / discounted invoices, the same read both credit-note splits
    // make. Needed by BOTH branches below since 2026-08-25 (see the component note).
    const bookedTax = (
      await tx
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.businessId, businessId),
            eq(ledgerEntries.sourceType, "invoice"),
            eq(ledgerEntries.sourceId, inv.publicId),
            eq(ledgerEntries.account, "tax_payable"),
          ),
        )
    ).reduce((s, e) => s + (e.direction === "credit" ? e.amountMinor : -e.amountMinor), 0n);
    if (openWithPromo) {
      const netBase = base - bookedTax;
      taxedBase = netBase - promoApplied > 0n ? netBase - promoApplied : 0n;
      unusedSupply =
        input.creditOption === "full"
          ? netBase
          : prorate(netBase, prorationAt, periodStart, periodEnd);
      // No more taxable base can be released than the invoice ever had; past it the
      // overflow frees promotional credit instead (the adjustment branch below).
      const releasedBase = unusedSupply < taxedBase ? unusedSupply : taxedBase;
      // round half up, integer minor units — mirrors both credit-note tax splits.
      const taxPart =
        taxedBase > 0n && bookedTax > 0n
          ? (releasedBase * bookedTax + taxedBase / 2n) / taxedBase
          : 0n;
      gross = unusedSupply + taxPart;
    } else if (input.creditOption === "full") {
      gross = base;
    } else {
      // PRORATE THE COMPONENTS, then add — not the tax-inclusive lump.
      //
      // The comment above used to claim that with promo = 0 "the two are the same fraction
      // of the same money, so every existing fixture keeps `prorate(base)` byte-for-byte,
      // rounding included". Same fraction, yes; same ANSWER, no — rounding happens in a
      // different place. Measured 2026-08-25, a 5,435.08 invoice (supply 4,606.00 +
      // 18% tax 829.08) credited for 30 of 31 days:
      //
      //     lump : 543508 × 30/31 = 525975.48 → 525975   (one unit short)
      //     parts: 460600 × 30/31 = 445741.9 → 445742
      //             82908 × 30/31 =  80233.5 →  80234
      //                                sum   = 525976    (correct)
      //
      // The sibling note on the same cancellation agrees on both sides (1075924 → 1041217
      // either way), which is why this hid: it only shows when the lump lands just under a
      // half and the parts do not.
      //
      // Components are also the shape the note itself carries — supply items plus a
      // `Tax reversal on credited time` line — so rounding each is what the document says
      // happened, and `prorate` is half-up on both.
      const supplyPart = prorate(base - bookedTax, prorationAt, periodStart, periodEnd);
      const taxPart = bookedTax > 0n ? prorate(bookedTax, prorationAt, periodStart, periodEnd) : 0n;
      gross = supplyPart + taxPart;
    }
    if (gross <= 0n) return null;

    const priorNotes = await tx.select().from(creditNotes).where(eq(creditNotes.invoiceId, inv.id));
    const priorCreditNote =
      priorNotes
        .filter((c) => c.reasonCode === CANCELLATION_REASON)
        .find((c) => c.status !== "voided") ?? null;

    // ── UNUSED TIME ALREADY HANDED BACK (2026-08-25) ─────────────────────────────
    // `gross` above is the unused fraction of what this invoice CHARGED, with no memory
    // of unused time already returned against it. A mid-term change credits an invoice's
    // whole remaining term and bills the rest of it on a NEW invoice, and both stay in
    // the term set — so cancelling afterwards credited the first one all over again.
    // Measured 2026-08-25 (scripts/probe-cancel-after-change-credit.ts):
    // a ₹27,918 promo-funded term swapped to ₹9,118 on day 0 fully credits invoice #1
    // (3114324 = 1000000 promo + 2114324 cash) and bills invoice #2 for 911800.
    // Cancelling an hour later credited invoice #2 its 30/31 = 882387 (right) AND
    // invoice #1 another 3013862, restoring 967741 of promotional credit the customer
    // had already been given back and minting a 2046121 refundable note against cash
    // that was already committed. Only ONE note belongs there — 882387 against invoice
    // #2, zero cashable — and invoice #1 is left alone.
    //
    // Subtracting what was returned makes the rule monotone in `now`: an earlier change
    // credited `prorate(base, changeDate) ≥ prorate(base, now)`, so a later cancel can
    // only reach zero, never claw value back. It is deliberately compared against the
    // credit rather than the base — clamping to "the invoice's uncredited remainder"
    // would still over-credit whenever the change happened mid-term (a day-11 change on
    // a 31-day term leaves 426 of a 1200 invoice uncredited, and a day-20 cancel would
    // hand back 425 of it for time the customer had already been paid for).
    //
    // What a note actually returned is its CASHABLE total plus the bucket slices it
    // routed back (0186's typed discounts) — the same tax-inclusive units as `base`,
    // since `creditOneInvoice` reverses the invoice's tax into the note's own items.
    let alreadyReturned = 0n;
    for (const c of priorNotes) {
      if (c.status === "voided" || !TERM_CREDIT_REASONS.has(c.reasonCode ?? "")) continue;
      const ds = await tx
        .select()
        .from(creditNoteDiscounts)
        .where(eq(creditNoteDiscounts.creditNoteId, c.id));
      const returnedToBuckets = ds
        .filter(
          (d) =>
            d.type === "promotional_credits" ||
            d.type === "excess_payments" ||
            d.type === "credit_grants",
        )
        .reduce((s, d) => s + d.amountMinor, 0n);
      alreadyReturned += c.totalMinor + returnedToBuckets;
    }
    const creditAmount = gross - alreadyReturned;
    if (creditAmount <= 0n) return null;

    const common = {
      invoiceId: inv.id,
      invoicePublicId: inv.publicId,
      invoiceNumber: inv.number,
      invoiceStatus: inv.status,
      customerId: inv.customerId,
      currency: inv.currency,
      baseMinor: base,
      creditMinor: creditAmount,
      prorationAt,
      // `full` reverses the whole billed window; anything else reverses the unused tail.
      creditedFrom: input.creditOption === "full" ? periodStart : prorationAt,
      creditedTo: periodEnd,
      priorCreditNote,
    };

    if (isOpenInvoiceStatus(inv.status)) {
      // Unpaid term → reduce what's still owed (never below the amount due).
      // Cash-net: the column never has payments subtracted from it, so capping on it let
      // the adjustment relieve a debt that was already settled in cash and absorb the
      // customer's money as a write-down. `owed` is the real debt; anything past it is
      // theirs. Dynamic import to keep this module off invoicing/service's import graph,
      // which already reaches credit-notes/service.
      const { invoiceOutstanding } = await import("@/modules/invoicing/service");
      const { remainingMinor: due } = await invoiceOutstanding(tx, inv);
      const amount = creditAmount < due ? creditAmount : due;
      // ── PAST THE TAXED BASE, THE CAP IS FREEING PROMOTIONAL CREDIT (2026-08-25) ──
      // The cap above is right about the DUE — an adjustment cannot relieve more than is
      // owed — but silently dropping what it cuts is not. Once the credit runs past the
      // invoice's taxed base there is no retained supply left for the promotional credit
      // to fund, and the units being credited are ones that credit paid for; the honest
      // answer is to give it back rather than to clamp. Measured on the same probe: the
      // ₹27,918 term cancelled on day 2 credits 2611684 of supply against a 1791800 taxed
      // base, leaving 180116 of supply the promo covers on its own — so 819884 of the
      // ₹10,000 grant is funding nothing, and was simply lost to the cap.
      //
      // Bounded three ways, smallest wins: `baseOverflow` (the supply credited beyond the
      // taxed base — the amount the promo actually stops funding), what the cap cut, and
      // the promo the invoice ever applied. Every one of them is 0 whenever no promotional
      // credit was applied, so a non-promo cancellation is untouched.
      //
      // Anything the cap cuts BEYOND that is cash already paid into a part-paid invoice.
      // It is now RETURNED rather than clamped (2026-08-26). Clamping silently kept money
      // that was the customer's; the older behaviour of adjusting it away booked their cash
      // as a debt relief. Neither is honest, and the change path already had the answer —
      // `creditOneInvoice` splits the identical situation into an adjustment plus a
      // refundable note, so this mirrors it rather than inventing a second convention.
      //
      // Capacity comes from `refundableCapacityForInvoice`, NOT a local payments sum:
      // that helper is the one definition of cash-still-available and is the only one that
      // subtracts gateway refunds and live refundable notes. Summing payments here would
      // have minted a note against cash already returned.
      const baseOverflow = unusedSupply > taxedBase ? unusedSupply - taxedBase : 0n;
      const cut = creditAmount - amount > 0n ? creditAmount - amount : 0n;
      const overflow = baseOverflow < cut ? baseOverflow : cut;
      // A restore is only representable ON a note (as its `promotional_credits` discount
      // row), and no note is written when there is nothing to adjust.
      const promotionalRestoreMinor =
        amount > 0n && overflow > 0n ? (overflow < promoApplied ? overflow : promoApplied) : 0n;
      const cashCut = cut - overflow > 0n ? cut - overflow : 0n;
      const { available: cashAvailable } = await refundableCapacityForInvoice(tx, inv.id);
      // ── THE CAP IS CASH *PLUS RECYCLED REFUNDABLE CREDIT* (#19, 2026-09-03) ──────
      // It was `cashAvailable` alone, which is the cap for an invoice funded by cash and
      // nothing else. An invoice can also be funded by a refundable credit note applied
      // forward to it — which is what a chain of mid-term changes produces, each change
      // crediting the old invoice and applying that note to the next — and that credit is
      // the customer's value sitting INSIDE the invoice. Reverse the invoice and it must
      // come back out; capping on cash alone silently kept it.
      //
      // Measured on INV-7826 (sub_XXXXXXXXXXXXXXXXXXXXXX01): total ₹32,943.24 = ₹22,184.00
      // still due + ₹10,759.24 of `refundable_credits_applied_minor`, no cash at all. The
      // adjustment can only relieve the ₹22,184.00 of debt; the remaining ₹10,759.24 was
      // cut to ₹0 by a `cashAvailable` of ₹0, so a full cancellation delivered ₹22,184.00
      // where ₹32,943.24 was owed — an UNDER-credit of exactly the recycled note, hidden
      // underneath #19's much larger over-credit from the selection bug above.
      //
      // This is the SAME cap `splitCreditByFunding` applies on the paid branch
      // (`cashAvailable + refundableApplied`, :319-323) — deliberately, because the two
      // branches owe the customer the same money and a cap that disagreed between them
      // would make the answer depend on whether the invoice happened to be settled. That
      // formula was briefly suspected of double-counting when summed across this
      // subscription's 26 invoices (₹2,34,168.30 ≈ 22 × ₹10,759.24); it is not — the sum
      // was over a CHAIN of superseded invoices, which is the selection bug, not this.
      //
      // It cannot mint credit: `refundableApplied` is what the invoice actually consumed,
      // and re-running is guarded by `priorCreditNote` on the note this writes.
      const refundableApplied = inv.refundableCreditsAppliedMinor ?? 0n;
      const refundableCap = cashAvailable + refundableApplied;
      const refundableCut = cashCut < refundableCap ? cashCut : refundableCap;
      return {
        ...common,
        delivery: "adjustment",
        adjustmentMinor: amount > 0n ? amount : 0n,
        promotionalRestoreMinor,
        excessRestoreMinor: 0n,
        refundableCreditNoteMinor: refundableCut > 0n ? refundableCut : 0n,
        priorRestore: false,
      };
    }

    // Paid term → split the credit by HOW the term was paid (F review blockers: an
    // invoice paid by promo credits used to make the refundable-CN cap throw AFTER
    // the sub was already cancelled — credit lost forever — and bucket-paid slices
    // must go back to their buckets, not become cashable refundable credit).
    const [priorRestoreRow] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.businessId, businessId),
          eq(ledgerEntries.sourceType, RESTORE_SOURCE),
          eq(ledgerEntries.sourceId, inv.publicId),
        ),
      )
      .limit(1);

    // The OWNER of this rule, not a local payments sum. `refundableCapacityForInvoice`
    // computes `paid − gatewayRefunded − (liveRefundableCNs − paidOut)`, and its own comment
    // says why there must be exactly one definition: "One definition, or the allocator and
    // the guard disagree." This path was the disagreement.
    const { available: cashAvailable } = await refundableCapacityForInvoice(tx, inv.id);
    const { grantDrawnOutstanding } = await import("@/modules/credits/service");
    const {
      promotional: promoShare,
      excess: excessShare,
      refundable: cnAmount,
      grants: grantShare,
    } = splitCreditByFunding({
      creditMinor: creditAmount,
      baseMinor: base,
      invoice: inv,
      cashAvailable,
      grantOutstandingMinor: await grantDrawnOutstanding(tx, inv.businessId, inv.id),
    });

    return {
      ...common,
      delivery: "split",
      adjustmentMinor: 0n,
      promotionalRestoreMinor: promoShare,
      excessRestoreMinor: excessShare,
      grantRestoreMinor: grantShare,
      refundableCreditNoteMinor: cnAmount > 0n ? cnAmount : 0n,
      priorRestore: priorRestoreRow != null,
    };
  };

  return input.tx ? run(input.tx) : withTenant(organizationId, run);
}

/**
 * One plan per invoice that charged for time in the current term — the term-wide
 * planner. `planCancellationCredit` above is the single-invoice one and returns only
 * the primary; this is what the issuer and the estimate use, so neither under-credits
 * nor under-previews a term billed across several invoices.
 *
 * Order is primary-first, so a caller that must pick one credit note (the issuer's
 * return value, kept for its existing callers) still returns the term invoice's.
 */
export async function planCancellationCredits(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  creditOption: CreditOption;
  now?: Date;
  excludeCancellationDay?: boolean;
  tx?: Tx;
}): Promise<CancellationCreditPlan[]> {
  if (input.creditOption === "none") return [];
  const run = async (tx: Tx): Promise<CancellationCreditPlan[]> => {
    const invs = await termInvoices(tx, input.businessId, input.subscription);
    const plans: CancellationCreditPlan[] = [];
    for (const inv of invs) {
      const plan = await planCancellationCredit({ ...input, invoice: inv, tx });
      if (plan) plans.push(plan);
    }
    return plans;
  };
  return input.tx ? run(input.tx) : withTenant(input.organizationId, run);
}

export async function issueProratedCreditForUnusedTerm(input: {
  organizationId: string;
  businessId: string;
  subscription: typeof subscriptions.$inferSelect;
  creditOption: CreditOption;
  /** "Now" for the proration boundary (defaults to the current time). */
  now?: Date;
  excludeCancellationDay?: boolean;
  reason?: string;
}): Promise<typeof import("@db/schema").creditNotes.$inferSelect | null> {
  const { organizationId, businessId } = input;
  if (input.creditOption === "none") return null;
  const reason = input.reason ?? "Cancellation credit for unused term";

  // ONE CREDIT NOTE PER TERM INVOICE. Tax reversal, adjustment-vs-refundable and the
  // cash cap are all per-invoice, so a term billed across several invoices needs a note
  // per invoice — see `planCancellationCredits` for the under-credit this fixes. The
  // return value stays the PRIMARY invoice's note (parts[0]), which is what every
  // existing caller reads.
  const parts = await planCancellationCredits(input);
  if (parts.length === 0) {
    // A real outcome, not a no-op: the caller asked for a credit and none is owed
    // (nothing billed the term, it was already credited, or it prorates to zero).
    // Logged because "why did my customer get nothing back" is a support question.
    log.info("cancellation credit: nothing to credit", {
      event: "cancel_credit_none",
      subscription: input.subscription.publicId,
      businessId,
      creditOption: input.creditOption,
    });
    return null;
  }
  const notes: Array<typeof creditNotes.$inferSelect | null> = [];
  for (const probe of parts) notes.push(await issueOneInvoice(probe));
  const issued = notes.filter((n): n is NonNullable<typeof n> => n != null);
  log.info("cancellation credit issued", {
    event: "cancel_credit_issued",
    subscription: input.subscription.publicId,
    businessId,
    creditOption: input.creditOption,
    invoices: parts.length,
    notes: issued.map((n) => n.publicId),
    totalMinor: String(issued.reduce((sum, n) => sum + n.totalMinor, 0n)),
    currency: parts[0]?.currency ?? null,
  });
  return notes[0] ?? null;

  // The ADJUSTMENT path writes through `issueAdjustmentCreditNote`, which opens its
  // own transaction — so it plans outside one, exactly as before.
  async function issueOneInvoice(
    probe: CancellationCreditPlan,
  ): Promise<typeof creditNotes.$inferSelect | null> {
    if (probe.delivery === "adjustment") {
      // Idempotency: one cancellation CN per invoice.
      if (probe.priorCreditNote) return probe.priorCreditNote;
      if (probe.adjustmentMinor <= 0n && probe.refundableCreditNoteMinor <= 0n) return null;
      const freed = probe.promotionalRestoreMinor;
      // The fast path stays byte-identical for the common case — an unpaid invoice with no
      // promotional funding. A part-paid one needs the adjustment and the refundable note in
      // ONE transaction, so it takes the locked path below.
      if (freed <= 0n && probe.refundableCreditNoteMinor <= 0n) {
        return issueAdjustmentCreditNote({
          organizationId,
          businessId,
          invoicePublicId: probe.invoicePublicId,
          items: [
            {
              description: reason,
              amountMinor: Number(probe.adjustmentMinor),
              periodStart: probe.creditedFrom,
              periodEnd: probe.creditedTo,
            },
          ],
          reasonCode: CANCELLATION_REASON,
          reason,
        });
      }
      // ── THE CREDIT RAN PAST THE TAXED BASE (2026-08-25) ──────────────────────────
      // The overflow the amount-due cap cut is promotional credit that is no longer funding
      // anything, so it goes back to its bucket — the SAME mechanism and the same document
      // shape the paid branch below uses (`restoreBucketFundedSlices` + typed discount
      // rows), because the two paths owe the customer the same money. One transaction, so
      // the bucket movement and the note that declares it cannot come apart.
      //
      // The plan is RE-READ inside the customer lock, for the reason the paid branch
      // re-reads: the probe was taken without it, and the idempotency marker has to be
      // checked against the state this transaction actually writes against — otherwise two
      // concurrent cancels each pass a stale "no prior note" and restore the slice twice.
      // The no-restore case above skips all of this and stays byte-identical to before.
      //
      // `promotional_credits_applied_minor` is deliberately NOT reduced: the invoice is a
      // finalized tax document, corrected by a credit note rather than restated. See
      // `proration.ts`'s `creditOneInvoice`, which writes the identical shape on the change
      // path.
      return withTenant(organizationId, async (tx) => {
        await lockCustomerBalances(tx, probe.customerId);
        const [row] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, probe.invoiceId))
          .limit(1);
        if (!row) return null;
        const plan = await planCancellationCredit({ ...input, invoice: row, tx });
        if (!plan || plan.delivery !== "adjustment") return null;
        if (plan.priorCreditNote) return plan.priorCreditNote;
        if (plan.adjustmentMinor <= 0n && plan.refundableCreditNoteMinor <= 0n) return null;
        const restore = plan.promotionalRestoreMinor;
        if (restore > 0n) {
          await restoreBucketFundedSlices(tx, {
            organizationId,
            businessId,
            customerId: plan.customerId,
            currency: plan.currency,
            invoicePublicId: plan.invoicePublicId,
            promotional: restore,
            excess: 0n,
            sourceType: RESTORE_SOURCE,
            reasonCode: CANCELLATION_REASON,
          });
        }
        const adj =
          plan.adjustmentMinor > 0n
            ? await issueAdjustmentCreditNote({
                organizationId,
                businessId,
                invoicePublicId: plan.invoicePublicId,
                items: [
                  {
                    description: reason,
                    amountMinor: Number(plan.adjustmentMinor),
                    periodStart: plan.creditedFrom,
                    periodEnd: plan.creditedTo,
                  },
                ],
                subtotalMinor: restore > 0n ? plan.adjustmentMinor + restore : undefined,
                discounts:
                  restore > 0n
                    ? [
                        {
                          type: "promotional_credits",
                          amountMinor: restore,
                          description: "Promotional Credits Returned",
                        },
                      ]
                    : undefined,
                reasonCode: CANCELLATION_REASON,
                reason,
                tx,
              })
            : null;
        // The cash slice the debt cap cut comes back as REFUNDABLE credit, in the same
        // transaction as the adjustment: they are one reversal of one term and must not be
        // able to come apart. An adjustment cannot carry it — an adjustment relieves a debt,
        // and this money is not debt, it is the customer's cash.
        if (plan.refundableCreditNoteMinor <= 0n) return adj;
        const cashNote = await createRefundableCreditNote(tx, {
          organizationId,
          businessId,
          customerId: plan.customerId,
          invoiceId: plan.invoiceId,
          invoicePublicId: plan.invoicePublicId,
          currency: plan.currency,
          items: [
            {
              description: `${reason} (paid portion)`,
              amountMinor: Number(plan.refundableCreditNoteMinor),
              periodStart: plan.creditedFrom,
              periodEnd: plan.creditedTo,
            },
          ],
          subtotalMinor: plan.refundableCreditNoteMinor,
          discounts: [],
          reasonCode: CANCELLATION_REASON,
          reason,
        });
        // The adjustment stays the PRIMARY note every existing caller reads; the cash note is
        // returned only when there was no adjustment to report.
        return adj ?? cashNote;
      });
    }

    // Paid term → all in one customer-locked, idempotent transaction. The plan is
    // recomputed INSIDE the lock: the probe above was read without it, so acting on
    // its figures could double-credit against a concurrent draw.
    return withTenant(organizationId, async (tx) => {
      await lockCustomerBalances(tx, probe.customerId);
      // Re-plan for THIS invoice (the probe was read without the lock). Fetching the row
      // by id and passing it keeps the re-plan on the same invoice — resolving the term's
      // primary again would re-plan the wrong one for every sibling.
      const [row] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, probe.invoiceId))
        .limit(1);
      if (!row) return null;
      const plan = await planCancellationCredit({ ...input, invoice: row, tx });
      if (!plan || plan.delivery !== "split") return null;

      // Idempotency guards (either marker means a prior run already credited).
      if (plan.priorCreditNote) return plan.priorCreditNote;
      if (plan.priorRestore) return null;

      await restoreBucketFundedSlices(tx, {
        organizationId,
        businessId,
        customerId: plan.customerId,
        currency: plan.currency,
        invoicePublicId: plan.invoicePublicId,
        promotional: plan.promotionalRestoreMinor,
        excess: plan.excessRestoreMinor,
        // Cancellation's marker doubles as its idempotency guard (`priorRestore`).
        sourceType: RESTORE_SOURCE,
        reasonCode: CANCELLATION_REASON,
      });

      // ── THE NOTE DOCUMENTS THE WHOLE REVERSAL, NOT JUST ITS CASHABLE SLICE (0186) ──
      // Same shape `creditOneInvoice` writes on the CHANGE path, and for the same reason:
      // `total = sub_total − discounts + tax`, so a cancellation credit whose
      // gross went back to the promotional / excess buckets is a note with those buckets
      // as typed DISCOUNTS and a zero cashable total — CN-188's shape — rather than no
      // note at all. Cancellation credits carry no tax line of their own (the credit is
      // prorated off the invoice's tax-INCLUSIVE total, `planCancellationCredit`), so the
      // `+ tax` term is nil here and the gross is simply cashable + returned.
      //
      // DOCUMENTARY ONLY: `restoreBucketFundedSlices` above has already booked the bucket
      // movement. Nothing below posts it again.
      const grantReturned =
        (plan.grantRestoreMinor ?? 0n) > 0n
          ? await (
              await import("@/modules/credits/service")
            ).restoreGrantDraws(tx, {
              organizationId,
              businessId,
              customerId: plan.customerId,
              invoiceId: plan.invoiceId,
              invoicePublicId: plan.invoicePublicId,
              faceMinor: plan.grantRestoreMinor!,
              ledger: true,
              sourceType: RESTORE_SOURCE,
            })
          : 0n;
      const bucketReturned = plan.promotionalRestoreMinor + plan.excessRestoreMinor + grantReturned;
      if (plan.refundableCreditNoteMinor <= 0n && bucketReturned <= 0n) return null;
      const bucketDiscounts: CreditNoteDiscountInput[] = [];
      if (plan.promotionalRestoreMinor > 0n)
        bucketDiscounts.push({
          type: "promotional_credits",
          amountMinor: plan.promotionalRestoreMinor,
          description: "Promotional Credits Returned",
        });
      if (plan.excessRestoreMinor > 0n)
        bucketDiscounts.push({
          type: "excess_payments",
          amountMinor: plan.excessRestoreMinor,
          description: "Excess Payments Returned",
        });
      if (grantReturned > 0n)
        bucketDiscounts.push({
          type: "credit_grants",
          amountMinor: grantReturned,
          description: "Credit Grants Returned",
        });
      return createRefundableCreditNote(tx, {
        organizationId,
        businessId,
        customerId: plan.customerId,
        invoiceId: plan.invoiceId,
        invoicePublicId: plan.invoicePublicId,
        currency: plan.currency,
        // Items are the CASHABLE lines, so a wholly bucket-funded reversal has none.
        items:
          plan.refundableCreditNoteMinor > 0n
            ? [
                {
                  description: reason,
                  amountMinor: Number(plan.refundableCreditNoteMinor),
                  periodStart: plan.creditedFrom,
                  periodEnd: plan.creditedTo,
                },
              ]
            : [],
        // Credit grants returned: print the credited line at its gross, as the
        // refundable note does; the discount rows take the returned parts off.
        ...(grantReturned > 0n
          ? {
              documentItems: [
                {
                  description: reason,
                  amountMinor: Number(plan.refundableCreditNoteMinor + bucketReturned),
                  periodStart: plan.creditedFrom,
                  periodEnd: plan.creditedTo,
                },
              ],
            }
          : {}),
        subtotalMinor: plan.refundableCreditNoteMinor + bucketReturned,
        discounts: bucketDiscounts,
        reasonCode: CANCELLATION_REASON,
        reason,
      });
    });
  }
}
