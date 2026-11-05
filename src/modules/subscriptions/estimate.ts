/**
 * Estimates — dry-run cost previews. No DB writes, no charges; pure computation
 * that mirrors what billing/proration WOULD do, so a UI can show "you'll be
 * charged $X now" before committing.
 */
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { closingCommitment } from "./commitment";
import { randomUUID } from "node:crypto";
import { couponsLeftBehind } from "./plan-change-coupons";
import { resolveLifecycleConfig, type PlanChangeCoupons } from "./lifecycle-config";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { withTenant } from "@/platform/db";
/**
 * Warnings are read by a HUMAN in the cancel dialog, so amounts are rendered, not dumped.
 * All four used to interpolate raw minor units — "2218400 INR (minor units)" — in the same
 * dialog that formats every other figure as ₹22,184.00 (measured 2026-09-03). `formatMoney`
 * pins the locale to 'en' and honours the currency exponent, so a zero-decimal currency does
 * not grow fake paise.
 */
import { formatMoney } from "@/platform/currency";
import { usageWindowForNextInvoice } from "./usage-window";
import { localDatePartsInTz } from "@/platform/clock";
import {
  computeLineAmount,
  fixedChargeMinor,
  ratableFromSnapshot,
  ratableForItem,
  snapshotPrice,
  isOverridable,
  isCycleCapExhausted,
  priceLabel,
  makePriceLabeller,
  alignSnapshotToCycle,
  type PriceSnapshot,
  realignSnapshotToCycle,
  isMeteredPrice,
} from "@/modules/catalog/pricing";
import {
  getTaxProvider,
  inclusiveTaxMinorFor,
  taxMinorFor,
  taxLinesForBase,
  taxLinesFromRows,
  type TaxTreatment,
} from "@/modules/tax/service";
import {
  applyExplicitDifferentials,
  findMandatoryItemIds,
  resolveMandatoryAttachedItems,
} from "@/modules/catalog/service";
import {
  peekDiscounts,
  peekCouponCodes,
  refusePendingCouponCodes,
  type DiscountLine,
} from "@/modules/coupons/service";
import {
  prorate,
  nonResetItemProration,
  basisWasEverCharged,
  ProrationError,
  billsAtTrialEnd,
  planRemovedItemUnbilledSettlements,
  grossCreditOnInvoice,
  preTaxCreditFitting,
  type InvoiceCreditBasis,
  type ItemAdd,
  type ItemChange,
} from "./proration";
import {
  planSubscriptionPeriodInvoice,
  type PeriodItemRow,
  invoiceOutstanding,
  pendingPaymentsForInvoices,
  isAutoCollectOn,
} from "@/modules/invoicing/service";
import {
  findInTermReactivation,
  sameItemSet,
  IN_TERM_REFUSAL,
  type ReactivationTerm,
  type ChargeFailureChoice,
  requiresChargeOnReactivation,
} from "./in-term-reactivation";
import { creditNoteSpendable } from "@/modules/credit-notes/serialize";
// The arithmetic of WHERE a term credit goes — distribution across the term's invoices and
// the per-invoice split — lives in ONE pure module that `proration.ts` books from and this
// file predicts from, so the preview and the booking agree by construction. Modelling it
// here a second time is what produced the ₹17,010.12 of balance credit a change could not
// deliver (2026-08-31). See `credit-routing.ts`'s header.
import {
  FINAL_PERIOD_CREDIT_OPTION,
  resolveBillingRulesConfig,
  type PlanCreditCancelAtPeriodEnd,
  type SpecificDateFinalPeriod,
} from "./billing-rules-config";
import {
  distributeCreditAcrossInvoices,
  planOpenInvoiceCreditRouting,
  routingFromFundingSplit,
  totalRouting,
  type InvoiceCreditRouting,
} from "./credit-routing";
import {
  addInterval,
  advancePeriod,
  cadenceMismatch,
  cancellationDayProblem,
  cancelOverrideProblem,
  nextBillingBoundary,
  requireTerm,
  type Interval,
} from "./service";
import type {
  CancelOption,
  CreditOptionForTerm,
  UnbilledChargesOption,
  ArHandling,
  RefundableCreditsHandling,
} from "./service";
// The issuer's own read half — see estimateCancel. Importing the PLANNER (not the
// issuer) is what keeps the preview and the credit it predicts from drifting apart.
import {
  planCancellationCredits,
  planAlreadyCredited,
  planDeliveredMinor,
  representativePlan,
  type CreditOption,
} from "./cancellation-credit";
import { OPEN_INVOICE_STATUSES } from "@/modules/invoicing/status";
import {
  effectiveAddSnapshotTx,
  resolveDifferentialAgainstPlanTx,
  resolveDifferentialForAddTx,
  snapshotWithDifferential,
} from "./items";
import {
  alignTermStart,
  alignTrialEnd,
  billingModeFor,
  normalizeTermEnd,
  prorationWindowStart,
} from "@/modules/subscriptions/billing-mode";
import {
  subscriptions,
  subscriptionItems,
  prices,
  products,
  customers,
  invoices,
  invoiceLineItems,
  paymentMethods,
  businesses,
  unbilledCharges,
  creditNotes,
  ledgerEntries,
  scheduledChanges,
} from "@db/schema";
import {
  bucketBalancesForCurrency,
  type CustomerBalances,
} from "@/modules/customers/balances-read";
import {
  largestRecurringDebit,
  mandateFallbackCeiling,
  withMandateHeadroom,
  resolveMandateHeadroomConfig,
} from "@/modules/payment-methods/service";
// From the LEAF module — see mandate-afa.ts. Importing the predicate from
// payment-methods/service is fine HERE (no cycle), but keeping both on the leaf
// keeps one obvious source for the rule.
import { debitNeedsBuyerAuthentication } from "@/modules/payment-methods/mandate-afa";
import { planCreditApplication } from "@/modules/customers/balances";
import { loadCreditApplicationLimits } from "@/modules/customers/credits-flexibility";
import { createLogger } from "@/platform/logger";
import type { Tx } from "@/platform/db";

const log = createLogger("estimate");

export interface EstimateLine {
  description: string;
  amount_minor: number;
}

/**
 * One tax row, labelled exactly as the invoice labels it — `CGST (9.00%)`, `IGST (18.00%)`,
 * `VAT (20.00%)`.
 *
 * An estimate used to carry `tax_minor` alone, so every preview rendered a single row
 * called "Tax". On an Indian invoice that is not what the document says: the buyer is
 * quoted one figure here and sent CGST + SGST lines later, with nothing connecting them.
 * Empty when there is no tax to name.
 */
export interface EstimateTaxLine {
  label: string;
  amount_minor: number;
}

/**
 * The renewal invoice a change previews forward to — see `Estimate.next_renewal`.
 *
 * Deliberately the same field names as `Estimate` itself so a UI can render either
 * with one formatter, and deliberately NOT an `Estimate`: it has no lines-vs-credit
 * duality, no balance simulation beyond the credit this very change hands forward,
 * and `object: 'estimate'` on a nested forward-looking block would invite a caller
 * to treat it as one it could have fetched.
 */
export interface RenewalPreview {
  /** ISO timestamp the renewal invoice would be raised on. */
  date: string | null;
  lines: EstimateLine[];
  subtotal_minor: number;
  /** Coupons/discounts, peeked — no redemption is consumed. */
  discount_minor: number;
  tax_minor: number;
  tax_lines: EstimateTaxLine[];
  /** `subtotal − discount + tax`. The identity DOES hold here: one document, no credit note. */
  total_minor: number;
  /**
   * `refundable_credit_added_minor` — the credit THIS change hands forward — capped at
   * `total_minor`. The same figure appears on the same screen ("₹887.36 refundable
   * credits applied") because a downgrade's leftover credit is spent at the next renewal.
   *
   * Only that credit. The customer's EXISTING balance is not simulated here: what it holds
   * a month from now is not knowable from a read-only preview, and quoting it would be the
   * forward-looking version of the lie this whole block exists to stop telling.
   */
  credits_applied_minor: number;
  /** `total_minor − credits_applied_minor`, floored at 0 — the headline figure. */
  amount_due_minor: number;
}

/**
 * Estimate-side tax: resolve the customer's component vector and total it on `base`.
 *
 * Honors `tax_exempt` and `tax_treatment`, which the previous scalar version did not —
 * it passed only country/state, so an exempt or zero-rated-export customer was quoted
 * tax they would never be invoiced. An estimate that disagrees with the invoice it
 * predicts is worse than no estimate.
 */
async function estimateTax(
  organizationId: string,
  businessId: string,
  cus:
    | {
        country?: string | null;
        stateCode?: string | null;
        taxTreatment?: string | null;
        taxExempt?: boolean;
        taxBehavior?: string | null;
      }
    | undefined,
  base: bigint,
  /** The taxed lines' amounts, so per-line rounding rounds as the invoice will. */
  lineAmounts?: bigint[],
): Promise<{
  /** Tax ADDED on top — what totals use. */
  taxMinor: bigint;
  taxLines: EstimateTaxLine[];
  /** Tax already inside the amounts (an inclusive customer): reported, never added. */
  inclusiveTaxMinor: bigint;
}> {
  if (base <= 0n) return { taxMinor: 0n, taxLines: [], inclusiveTaxMinor: 0n };
  const resolution = await getTaxProvider().resolve({
    organizationId,
    businessId,
    country: cus?.country,
    stateCode: cus?.stateCode,
    treatment: (cus?.taxTreatment as TaxTreatment | undefined) ?? undefined,
    customerExempt: cus?.taxExempt === true,
    customerTaxBehavior: cus?.taxBehavior,
  });
  // A customer whose prices include tax: nothing is added on top, and the tax inside is
  // reported as the invoice books it. No tax lines: they are added rows, as on the invoice.
  if (resolution.customerBehavior === "inclusive")
    return {
      taxMinor: 0n,
      taxLines: [],
      inclusiveTaxMinor: inclusiveTaxMinorFor(resolution, base, lineAmounts),
    };
  return {
    inclusiveTaxMinor: 0n,
    taxMinor: taxMinorFor(resolution, base, lineAmounts),
    taxLines: taxLinesForBase(resolution, base, lineAmounts).map((l) => ({
      label: l.label,
      amount_minor: Number(l.amountMinor),
    })),
  };
}
/**
 * The line amounts an invoice pools for tax: taxed lines only, each net of its own
 * item-level discount (a charge never below 0; a credit line keeps its sign). Per-line
 * tax rounding needs exactly this split, or the estimate and the invoice round apart.
 */
function taxedLineAmounts(
  amounts: bigint[],
  lineDiscounts?: readonly bigint[],
  taxable?: readonly boolean[],
): bigint[] {
  return amounts.flatMap((a, i) => {
    if (taxable && taxable[i] === false) return [];
    if (a <= 0n) return [a];
    const n = a - (lineDiscounts?.[i] ?? 0n);
    return [n > 0n ? n : 0n];
  });
}

/**
 * One destination of a term credit, with the credit TYPE that destination implies.
 *
 *   adjustment      → an ADJUSTMENT note against an open invoice: the debt is cancelled.
 *   refundable      → a REFUNDABLE note: `this_invoice` offsets the proration invoice,
 *                     `balance` lands on the customer's refundable balance.
 *   bucket_restore  → returned to the promotional / excess bucket it was funded from.
 *                     Real value, never cashable.
 *   stranded        → reaches nobody. Credit no invoice ever received, so handing it over
 *                     would be inventing money. Named rather than hidden, because a
 *                     silently-omitted slice is how a total stops adding up.
 */
export interface CreditDestination {
  kind: "adjustment" | "refundable" | "bucket_restore" | "stranded";
  /** Where it landed. `open_invoice` pairs with `invoice`. */
  destination: "open_invoice" | "this_invoice" | "balance" | "payment_method" | "buckets" | "none";
  amount_minor: number;
  /** The printed invoice number an `adjustment` was applied against. */
  invoice?: string;
}

export interface Estimate {
  object: "estimate";
  currency: string;
  lines: EstimateLine[];
  subtotal_minor: number;
  /**
   * Every discount off `subtotal_minor` — coupons/manual discount PLUS
   * `promotional_discount_minor`. The same role `document_level_discount_minor` plays
   * on the serialized invoice, so `subtotal − discount + tax = total` holds on both.
   */
  discount_minor: number;
  tax_minor: number;
  /**
   * `tax_minor` broken into the rows the invoice will print (CGST + SGST, or IGST, or a
   * single row). Sums exactly to `tax_minor`. Absent/empty means no tax to name.
   */
  tax_lines?: EstimateTaxLine[];
  /**
   * `discount_minor` broken into NAMED rows — the discount twin of `tax_lines`, and the
   * same job: the buyer's portal quoted a next payment that was already discounted while
   * its line items summed to the UNdiscounted subtotal, so the figures disagreed by the
   * discount with nothing on the page naming it. Sums to `discount_minor`. Absent/empty
   * means nothing was discounted.
   */
  discount_lines?: Array<{ label: string; amount_minor: number }>;
  /**
   * `subtotal_minor − discount_minor + tax_minor` — the NET quote for this change, over
   * lines already net of any credit it raises. NET of the promotional slice too, which is
   * a pre-tax discount and never a post-tax credit. **Goes NEGATIVE on a downgrade**, which
   * is deliberate: it is the figure quoted for a change, and `verify:estimates` pins it
   * in fourteen assertions.
   *
   * ⚠️ **NOT the figure `serializeInvoice` reports for the invoice this predicts.** This
   * docstring said that until 2026-09-01 and it was false for any change that raises a
   * credit note — it described `invoice_total_minor`, a different field added later. That
   * one clause caused three separate errors across two sessions: a gross-vs-net defect
   * reported that did not exist, a timezone misalignment blamed for it, and a wrong
   * identity written into a test spec as an instruction. It was also established
   * empirically the hard way — making this field gross broke fourteen `verify:estimates`
   * assertions (`8cf0ec43`) — and the docstring never caught up.
   *
   * The ladder the buyer- and operator-facing surfaces actually render is:
   *   `invoice_total_minor` − `credit_applied_to_this_invoice_minor` − pre-existing
   *   balance applied  =  `amount_due_minor`
   * Compare a preview against a booked INVOICE with `invoice_total_minor`; compare the
   * cash a customer will be asked for with `amount_due_minor`; use this field for the
   * change's net effect and for `immediate_charge`.
   */
  total_minor: number;
  /** For a change: whether net>0 (charged now) vs net<0 (credited to balance). */
  immediate_charge: boolean;
  /**
   * POST-tax customer-balance application — read-only, no ledger
   * writes. `credits_applied_minor` is refundable + excess ONLY: the promotional
   * bucket is applied pre-tax and is reported as `promotional_discount_minor`, already
   * inside `total_minor`. Counting it here too would subtract it twice — the same
   * split `serializeInvoice` makes (30fcbd6).
   */
  credits_applied_minor?: number;
  /**
   * The promotional draw this preview simulates, seen from the BALANCE side — the
   * mirror of the `invoices.promotional_credits_applied_minor` column. Same money as
   * `promotional_discount_minor`, which is the DOCUMENT side of it; both are reported
   * because a caller previewing a balance draw and a caller previewing a document
   * need different names for it, exactly as the invoice row and its serialization do.
   */
  promotional_credits_applied_minor?: number;
  /**
   * The promotional slice as the document states it: a PRE-TAX discount that shrank
   * the taxable base — `discounts[].entity_type = "promotional_credits"`,
   * and `serializeInvoice`'s field of the same name. Included in `discount_minor`;
   * already subtracted from `total_minor`.
   */
  promotional_discount_minor?: number;
  refundable_credits_applied_minor?: number;
  excess_payments_applied_minor?: number;
  /** Credit grants drawn before tax (in `discount_minor`) and after it (in `credits_applied_minor`). */
  grant_credits_pre_tax_minor?: number;
  grant_credits_post_tax_minor?: number;
  /**
   * The CREDIT NOTE's own **total**, tax INCLUDED — the figure the document prints, and
   * therefore the sum of the notes this change will actually raise. Absent when the change
   * credits nothing.
   *
   * ⚠ NOT the note's GROSS. A slice returned to the promotional or excess bucket is
   * written as a DISCOUNT row on the note (`total = sub_total − discounts + tax`; a note
   * with sub_total ₹41,899.00 and one `promotional_credits` discount of ₹41,899.00 has
   * total ₹0.00), so the note's total EXCLUDES that slice. The gross is
   * `credit_note_total_minor + credit_returned_to_buckets_minor`, and it is the gross the
   * five legs below sum to. This field reported the gross until 2026-09-01, which
   * over-quoted a promo-funded change's refund by the returned grant on every preview —
   * asserted by `verify-credit-chain-gateway` ("credit_note_total_minor == Σ the notes this change
   * actually raised").
   *
   * `total_minor` cannot answer this. "TAX THE CHARGES, NOT THE NET" (below) is right and
   * stays: on apply the negative lines never reach the invoice — `issueCurrentTermCredit`
   * turns them into a credit note that reverses its own booked tax. But the consequence is
   * that a pure removal previews `subtotal −4606, tax 0, total −4606` while the credit note
   * it produces is ₹5,435.08 — the fee AND the 18% GST. Quote `total_minor` at a buyer and
   * you promise 4606 and pay 5435.08.
   *
   * So the tax is not netted into the base (which would re-break the partial-offset case
   * that reasoning was written for); it is REPORTED separately, on the credit side only.
   */
  credit_note_total_minor?: number;
  /**
   * The slice of `credit_note_total_minor` the proration invoice CANNOT absorb, which
   * therefore lands back on the customer's balance as refundable credit: "₹887.36
   * refundable credits will be added back to the customer's account".
   *
   * Non-zero only when the credit outweighs the charge, i.e. a downgrade. Absent means
   * the invoice swallowed the whole note. This is the money `total_minor` reports as a
   * negative, named from the BALANCE side rather than the document side — the same
   * pairing `promotional_discount_minor` / `promotional_credits_applied_minor` makes.
   */
  refundable_credit_added_minor?: number;
  /** `downgrade_credit: refund`: the part of the credit paid back to the card or bank payments. */
  refunded_to_payment_method_minor?: number;
  /** The slice given back to the credit grants the source invoices drew (G3). Inside `credit_returned_to_buckets_minor`. */
  credit_returned_to_grants_minor?: number;
  /**
   * The slice of `credit_note_total_minor` spent relieving what the customer STILL OWES on
   * the term's own invoices, before any of it can reach the balance.
   *
   * A change credits the unused term against the invoices that billed it. When one of those
   * is unpaid, `creditOneInvoice` raises an ADJUSTMENT note for the outstanding amount — the
   * debt is cancelled rather than refunded — and only the overflow becomes refundable. This
   * field is that first slice, so a caller can render where the credit actually went instead
   * of quoting it twice.
   *
   * Absent when the term is fully paid, which is every previously-tested shape.
   */
  credit_applied_to_open_invoices_minor?: number;
  /**
   * The slice of `credit_note_total_minor` that offsets THIS proration invoice —
   * `invoice_estimate.credits_applied`, and the row the ladder subtracts:
   *
   *     Invoice total   71,654.32
   *     Credit applied −66,566.31   ← this field
   *     Total due now    5,088.01   ← `amount_due_minor`
   *
   * ⚠ NOT DERIVABLE BY A CALLER, and the near-miss is the dangerous part.
   * `credit_note_total_minor − credit_applied_to_open_invoices_minor` gives exactly this
   * figure on the unpaid-term shape above — because `refundable_credit_added_minor` and both
   * stranding legs happen to be 0 there — and is wrong the moment any of them is not. A
   * downgrade whose credit outruns the new invoice pushes the excess to the balance; a
   * bucket-funded source invoice returns slices to their buckets; `distributeCreditAcrossInvoices`
   * and `planOpenInvoiceCreditRouting` can each strand a residue. So it is reported from the
   * routing rather than left to subtraction — the same rule `credit-routing.ts`'s header sets
   * for this file ("Neither may re-implement them"), which a caller's arithmetic would breach
   * as a fourth definition of the split.
   *
   * Distinct from `credits_applied_minor`, which is PRE-EXISTING balance (refundable +
   * excess) applied to the same invoice. Both reduce what is due; only this one comes from
   * the note this change creates.
   */
  credit_applied_to_this_invoice_minor?: number;
  /**
   * WHERE EVERY SLICE OF THE NOTE WENT, one entry per destination, each LABELLED WITH ITS
   * CREDIT TYPE. The scalars above are the same money summed by leg; this is what prose can
   * read without inferring anything.
   *
   * ⚠ THE TYPE IS NOT INFERABLE FROM WHICH SCALAR IS NON-ZERO. The wording turns on it —
   * "Prorated **Adjustment** Credits" means the debt is cancelled, where a refundable
   * note means spendable balance — and one change can produce BOTH (the partially-paid
   * shape: an adjustment note for the outstanding amount AND a refundable note for the
   * rest). A consumer that guessed from the non-zero leg would mislabel exactly that
   * mixed case.
   *
   * `invoice` is set only on `adjustment` entries — the document the credit was applied
   * against, by its printed number, because that is what the customer can reconcile.
   *
   * The entries sum to `credit_note_total_minor` by construction, so prose built from them
   * cannot leave an unnamed remainder.
   */
  credit_destinations?: CreditDestination[];
  /**
   * The unused period this credit covers — stated twice in one sentence ("will be
   * created for the unused period of 31-Aug-2025 00:00 - 29-Sep-2025 23:59"), and it is what
   * lets a customer match the sentence to a document. ISO instants, absent when nothing is
   * credited.
   */
  credited_period_start?: string;
  credited_period_end?: string;
  /**
   * The proration invoice's OWN total — the ladder's top figure, before any credit
   * touches it: `Invoice total 71,654.32 → Credit applied −66,566.31 → Total due now 5,088.01`.
   *
   * ⚠ NOT `subtotal_minor + tax_minor`. `subtotal_minor` reports the NET of the charge and
   * credit lines — on a downgrade it is negative (−752.00 against an invoice of ₹52,354.24) —
   * so the obvious reconstruction is not merely imprecise, it has the wrong sign. And
   * `total_minor` is already net of the credit that offsets this document. Neither answers
   * "what would this invoice have been", so it is reported rather than inferred.
   */
  invoice_total_minor?: number;
  /**
   * The proration invoice's own PRE-TAX subtotal — the row directly above the tax rows, so a
   * pure charges table reads `lines → subtotal → tax → invoice total` with nothing to derive.
   *
   * ⚠ Not `invoice_total_minor − tax_minor`: that is only equal while
   * `promotional_discount_minor` is 0, and it is exactly the reconstruction three separate
   * surfaces would each get subtly wrong. Also NOT `subtotal_minor`, which is the net of
   * charge AND credit lines (negative on a downgrade). Post-discount, matching what
   * `serializeInvoice` puts on the real document.
   */
  invoice_subtotal_minor?: number;
  /**
   * The slice returned to the promotional and excess buckets it was originally funded from.
   *
   * Real money for the customer, but a BUCKET balance — never cashable, and it cannot offset
   * this invoice. The two legs are reported together because the note renders them as one
   * sentence; the distinction that matters (promotional credit never becomes refundable) is
   * enforced in `credit-routing.ts`, not here.
   */
  credit_returned_to_buckets_minor?: number;
  /**
   * The slice that reaches NOBODY: `planOpenInvoiceCreditRouting`'s `strandedMinor` plus
   * `distributeCreditAcrossInvoices`'s `unplacedMinor`, which no caller could otherwise see.
   *
   * Deliberate, not a leak — it is credit no invoice ever received, so handing it over would
   * be inventing money. Reported so that the five legs account for 100% of the note's GROSS
   * — the note's printed total PLUS the bucket slices it states as discount rows (see
   * `credit_note_total_minor`, which since 2026-09-01 is the printed total):
   *
   *     credit_note_total_minor + credit_returned_to_buckets_minor
   *       = credit_applied_to_this_invoice_minor
   *       + refundable_credit_added_minor
   *       + credit_applied_to_open_invoices_minor
   *       + credit_returned_to_buckets_minor
   *       + credit_stranded_minor
   *
   * `verify:estimates` asserts exactly that, so a note can never render with an unnamed
   * remainder.
   */
  credit_stranded_minor?: number;
  /**
   * The routing claimed MORE than the credit note is worth — always absent in a correct
   * result. Present only when the five legs over-account, which is a defect in the routing
   * rather than a fact about the credit; see `strandedResidual` at the computation. Added
   * 2026-09-01 after a double-counted leg went unnoticed because nothing summed them.
   */
  credit_routing_over_claimed_minor?: number;
  /**
   * ⚠️ THERE IS NO `credit_routing_unconserved_minor`, and the reason is worth keeping.
   *
   * Deriving `credit_stranded_minor` as a residual makes `Σ legs == credit_note_total_minor`
   * hold by construction whenever the residual is ≥ 0, so an UNDER-claiming routing is
   * absorbed silently where it used to break that sum loudly. The obvious replacement — check
   * per share that `adjustment + cashable + freedPromo + freedExcess + stranded == share` — was
   * written, and it is WRONG: `distribution.shares` are PRE-TAX list units while every routing
   * component is GROSS, so it reported a violation on every fixture equal to the tax gross-up
   * (step 2: unconserved 324,209 against a note of 2,125,370 on a pre-tax credit of 1,801,161 —
   * exactly the tax). Comparing across that boundary measures the gross-up, not conservation.
   *
   * So the under-claim direction is covered by FIXTURES, not by an invariant field, and until
   * one exists it is a known blind spot rather than a solved problem. `credit_routing_over_claimed_minor`
   * above is the half that IS checkable here, and both suites assert it absent.
   */
  /** total_minor − credits_applied_minor, floored at 0 — what would actually be collected. */
  amount_due_minor?: number;
  /**
   * The NEXT RENEWAL INVOICE as it will look AFTER this change — "Next invoice of
   * ₹89,845.20 INR will be raised on 30-Sep-2026", and the "Renewal Charges" table
   * behind it.
   *
   * It exists because the dashboard was answering that question itself, as a bare
   * `Σ unit_price × quantity` over the post-change rows: no tax, no coupons, no credit.
   * On an 18%-GST sub that understated the renewal by the entire tax amount (₹76,892
   * where the real figure is ₹89,845.20) — the SAME defect `estimateRenewal`'s docstring
   * was written about, re-committed one screen over.
   *
   * `estimateRenewal` cannot answer it: that reads the item set from the database, and
   * the whole point here is the composition the caller has NOT applied yet. So this is
   * rated by `rateFullTermComposition`, the shared helper the in-trial branch already
   * used for exactly this job — same snapshot rating, same cycle caps, same metered
   * exclusion, same `peekDiscounts`.
   *
   * Null when there is no next term to bill (cancelled / non-renewing / ending at
   * period end), and on the in-trial branch, where `due_at_trial_end` already describes
   * the invoice the conversion raises.
   */
  next_renewal?: RenewalPreview | null;
  /** Whether this change would trigger a TERM RESET (see changeSubscription). */
  term_reset: boolean;
  /** ISO timestamp of the would-be new `current_period_end` when `term_reset` is true, else null. */
  new_period_end: string | null;
  /**
   * IN-TRIAL change (see `billsAtTrialEnd`): set to the ISO trial
   * end when NOTHING is charged now and this estimate describes the invoice the
   * trial-end conversion will raise instead. Null/absent on every other estimate.
   *
   * When set: `amount_due_minor` and the `*_credits_applied_minor` family are all 0
   * (no money moves today, and the customer's balance at trial end is unknowable),
   * while `subtotal/discount/tax/total_minor` describe the FULL post-change
   * composition as it will be billed at trial end. `immediate_charge` is false.
   */
  due_at_trial_end?: string | null;
  /**
   * Reactivation only: set when the subscription continues its current term instead of
   * opening a fresh one (`findInTermReactivation`). Nothing is invoiced; `amount_due_minor`
   * is what collecting the term's open invoice takes now, which happens only when the
   * business requires a successful charge to reactivate (`collects_now`).
   */
  in_term_reactivation?: {
    current_period_end: string;
    invoice: { id: string; number: string | null; status: string; outstanding_minor: number };
    collects_now: boolean;
  } | null;
  /** Reactivation only: whether this request could continue the current term (`term`). */
  in_term_available?: boolean;
  /**
   * Set when this charge would be REFUSED by the instrument's mandate before it
   * ever reaches the gateway — i.e. the amount exceeds the per-debit ceiling the
   * buyer authorised. Absent means no known obstacle, never "checked and fine":
   * a customer with no mandate rail has no ceiling to exceed.
   *
   * It exists because the ceiling is derived ONCE, at vault time, and nothing on
   * the change path re-reads it. Measured 2026-08-18: a ₹5,000/mo customer whose
   * mandate was registered at the ₹15,000 fallback upgraded to ₹28,215/mo, the
   * change was accepted, MRR was updated — and the proration invoice it raised was
   * refused on the spot with `mandate_ceiling_exceeded`. The customer was on the
   * expensive plan, being served, with an unpayable invoice and nothing said so.
   */
  mandate_shortfall?: MandateShortfall;
  /**
   * Invoices this edit will credit that still have a debit live at the gateway. Absent when
   * there are none. See {@link DebitInFlight}.
   */
  debits_in_flight?: DebitInFlight[];
  /** Renewal estimate only: the scheduled change this renewal is priced after. */
  scheduled_change?: { id: string; type: "change"; effective_at: string };
}

/** Why a mandate cannot carry a charge, and what would fix it. */
/**
 * An invoice this edit is about to CREDIT that still has a debit live at the gateway.
 *
 * Shared by BOTH lifecycle estimates since 2026-09-03 (#22): a cancellation relieves the
 * same invoices the same way — its term credit, or an AR write-off — so it ran the same
 * race with the operator told nothing. See {@link CancelEstimate.debits_in_flight}.
 *
 * Crediting it does not cancel the debit, and on some rails nothing can: `voidIntent`
 * takes an INTENT id, and an authorized recurring charge is captured or left to lapse
 * (RazorPay documents this; measured 2026-09-03, no in-flight debit in this database
 * carries an intent id on ANY provider). So the debit may still settle, for a debt the
 * credit note has already cleared.
 *
 * ⚠️ It also covers a buyer's own CHECKOUT, since 2026-09-03, and that is the case this
 * warning was blind to on the day it shipped. `pendingPaymentsForInvoices` selected
 * `payments.status = 'pending'`, and a buyer-initiated intent has no payments row at all
 * until its capture settles — so on INV-7824 the operator was shown nothing while
 * ₹22,184.00 sat live at RazorPay, applied a downgrade 47 seconds later, and the money
 * had to be captured and refunded. See {@link DebitInFlight.kind}: the two shapes need
 * different advice, so they are named rather than merged.
 *
 * The money is handled — booked, detached from the invoice, refunded automatically, and
 * alerted (`auto_refunded_unapplied_money`). But the operator can avoid the whole detour by
 * having the customer release the debit from their portal first, and only they can decide
 * that. Naming it here makes the choice theirs instead of a surprise.
 *
 * ⚠️ Since #27, the cancel estimate also reuses this SAME type for
 * `account_receivables_handling = schedule_payment_collection` — the opposite shape, a
 * SECOND debit dispatched against an invoice already carrying one, so the risk is a
 * double charge rather than a stranded credit. No new field distinguishes the two:
 * {@link CancelEstimate.debits_in_flight} says how a caller tells them apart.
 */
export interface DebitInFlight {
  /** The printed invoice number this action is about to credit — or, since #27, collect against. */
  invoice: string;
  /**
   * True when the rail has paused the debit for the payer's own additional-factor step, so
   * it is waiting on THEM. That is the case a portal release can clear, and the only one
   * where telling the operator to ask the customer is useful advice rather than noise.
   *
   * No amount: `pendingPaymentsForInvoices` reports the KIND of wait and not the figure,
   * and widening that contract — the portal reads it too — to decorate one warning is the
   * wrong trade. The invoice page one click away carries the number.
   */
  awaiting_buyer: boolean;
  /**
   * `payment` — a debit we booked and dispatched to the rail. The customer can END it
   * from their portal, which is the advice worth giving when `awaiting_buyer` is set.
   *
   * `intent` — a checkout the BUYER opened (portal "Pay now"). There is no payments row
   * and no transaction row behind it, so the portal's release control cannot see it and
   * cannot act on it; what clears an intent is the buyer finishing or abandoning the
   * gateway's own sheet, or the sweep voiding it once the invoice owes nothing
   * (`releaseZeroDueIntents`). Rendering a debit's advice over it would point an operator
   * at a button that does nothing.
   */
  kind: "payment" | "intent";
}

export interface MandateShortfall {
  /**
   * The instrument this verdict is about — the subscription's default, or the customer's
   * newest valid one, resolved exactly as `resolveChargeCandidates` would.
   *
   * Carried because a customer can hold several cards and only one of them is short: the
   * portal renders the ceiling per ROW, so without this it could only put the warning on
   * every row or on none. Added 2026-09-04 with the payment-methods notice.
   */
  payment_method: string;
  /** The per-debit ceiling stored on the instrument, in minor units. */
  ceiling_minor: number;
  /** The amount that would be charged — larger than the ceiling, or this is absent. */
  amount_minor: number;
  currency: string;
  /** `card` | `upi` | `emandate` … — decides which remedy is worth offering. */
  rail: string | null;
  /**
   * What a fresh authorisation would register today (`deriveMandateCeiling`), so a
   * UI can say what re-authorising buys rather than just that something is wrong.
   */
  reauthorized_ceiling_minor: number;
  /**
   * True when the amount is also above the RBI additional-factor threshold, i.e.
   * re-authorising on THIS rail buys a bigger ceiling and an OTP on every debit.
   * Netbanking is the only rail that clears both.
   */
  needs_authentication_even_if_raised: boolean;
}

/**
 * ── PROMOTIONAL CREDIT IS A PRE-TAX DISCOUNT, NOT A POST-TAX CREDIT ──────────────
 *
 * PHASE 1 of the SAME balance split the real invoice path applies
 * (`resolvePeriodInvoiceMoney`'s D1 block, `invoicing/service.ts`): promotional
 * credit is capped at the discounted subtotal and applied BEFORE tax, so the invoice
 * charges tax on `discountedSubtotal − promo`. Read-only — no `lockCustomerBalances`,
 * no ledger writes; this is a preview, not a draw.
 *
 * It has to be its own phase because the tax base depends on its answer. Rolled into
 * one call (as it was until 2026-08-25) the estimate taxed the FULL subtotal and then
 * subtracted the promo afterwards, which is a different number: measured on an
 * IGST-18% mid-term add of ₹27,918 against a ₹10,000 grant, the preview quoted tax
 * 502,524 where the invoice charged 322,524 (18% of 17,918.00) — and quoted an
 * `amount_due` of 2,294,324 against the invoice's 2,114,324.
 *
 * The balances come back with it so PHASE 2 (`planCreditApplication`, post-tax:
 * refundable then excess) needs no second read.
 */
async function simulatePromotionalDiscount(
  tx: Tx,
  organizationId: string,
  customerId: string,
  currency: string,
  /** subtotal − coupon discount: the promo cap, exactly `resolvePeriodInvoiceMoney`'s `promoCap`. */
  discountedSubtotal: bigint,
  /**
   * PROMOTIONAL CREDIT THE SAME CHANGE HANDS BACK BEFORE THIS INVOICE IS RAISED — not
   * yet on the balance this function reads, and therefore invisible to it.
   *
   * A change that credits an invoice which promotional credit part-funded returns that
   * slice to the promotional bucket (`creditOneInvoice` → `restoreBucketFundedSlices`,
   * `InvoiceCreditRouting.freedPromoMinor`) and only THEN raises the proration invoice,
   * which draws on the restored bucket pre-tax. The stored balance at preview time is
   * `0`, so a simulation that read it alone quoted the charge with no promotional
   * discount at all while the apply discounted it — see the call site in
   * `estimateChange` for the measurement.
   *
   * `balances` is returned UNCHANGED: this widens what THIS invoice may draw, not what
   * the customer holds, and `planCreditApplication`'s post-tax phase must keep seeing
   * the real stored buckets.
   */
  freedByThisChangeMinor: bigint = 0n,
): Promise<{ promotional: bigint; balances: CustomerBalances }> {
  const balances = await bucketBalancesForCurrency(organizationId, customerId, currency, tx);
  const cap = discountedSubtotal > 0n ? discountedSubtotal : 0n;
  const available =
    balances.promotional + (freedByThisChangeMinor > 0n ? freedByThisChangeMinor : 0n);
  return { promotional: available < cap ? available : cap, balances };
}

/**
 * Would the instrument's mandate refuse a charge of this size?
 *
 * Deliberately mirrors `mandateRefusal` (invoicing/collection.ts) rather than
 * re-deriving the rule: same null-ceiling-means-unknown, same currency guard, same
 * `<=` boundary. If those ever diverge, an estimate would promise a charge the
 * collection path refuses — which is the whole defect this exists to surface.
 *
 * Returns null when there is nothing to warn about: no default instrument, no
 * mandate rail, an unknown ceiling, a currency mismatch, or an amount that fits.
 */
/**
 * The business's mandate sizing, resolved per call.
 *
 * Loaded rather than imported as a constant since 0221: the headroom multiple and the
 * smallest-rail cap are per-business, and a merchant who has set neither resolves to the
 * exact engine defaults — so an unset business sizes identically to before the column
 * existed. Read here rather than threaded from the callers because both consumers already
 * open a tenant transaction, and a ceiling quoted from a stale config is the one failure
 * that would be invisible (the number still looks plausible).
 */
async function mandateConfigFor(organizationId: string, businessId: string) {
  const [biz] = await withTenant(organizationId, (tx) =>
    tx
      .select({ mandateConfig: businesses.mandateConfig })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  return resolveMandateHeadroomConfig(biz ?? null);
}

export async function mandateShortfallFor(
  organizationId: string,
  businessId: string,
  sub: { id: string; customerId: string; currency: string; defaultPaymentMethodId: string | null },
  amountMinor: bigint,
): Promise<MandateShortfall | null> {
  if (amountMinor <= 0n) return null;
  const pm = await withTenant(organizationId, async (tx) => {
    // The instrument the charge will actually use: the subscription's default,
    // falling back to the customer's primary exactly as `resolveChargeCandidates`
    // does — warning about a ceiling on a card we would not have charged is noise.
    if (sub.defaultPaymentMethodId) {
      const [row] = await tx
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.id, sub.defaultPaymentMethodId))
        .limit(1);
      if (row) return row;
    }
    const [primary] = await tx
      .select()
      .from(paymentMethods)
      .where(and(eq(paymentMethods.customerId, sub.customerId), eq(paymentMethods.status, "valid")))
      .orderBy(desc(paymentMethods.createdAt))
      .limit(1);
    return primary ?? null;
  });
  if (!pm) return null;
  const ceiling = pm.mandateMaxAmountMinor;
  if (ceiling == null) return null;
  if (pm.mandateCurrency && pm.mandateCurrency.toUpperCase() !== sub.currency.toUpperCase())
    return null;
  if (amountMinor <= ceiling) return null;
  return {
    payment_method: pm.publicId,
    ceiling_minor: Number(ceiling),
    amount_minor: Number(amountMinor),
    currency: sub.currency,
    rail: pm.mandateRail,
    // What a fresh authorisation would register FOR THIS CHARGE — headroom over the
    // amount in hand, which is already the tax-inclusive figure the collection path
    // will present. Deliberately NOT `deriveMandateCeiling`: that answers a
    // customer-wide question by planning an invoice per subscription, and before an
    // upgrade lands it answers with the OLD plan (the first version of this field told
    // a ₹28,215 upgrade that re-authorising would buy it ₹15,000). It could also only
    // ever come back LARGER, by picking up some other subscription — and quoting the
    // buyer a bigger number than their own charge needs is the shock
    // `MANDATE_HEADROOM_BPS` exists to avoid.
    reauthorized_ceiling_minor: Number(
      withMandateHeadroom(amountMinor, await mandateConfigFor(organizationId, businessId)),
    ),
    needs_authentication_even_if_raised: debitNeedsBuyerAuthentication(
      pm,
      sub.currency,
      amountMinor,
    ),
  };
}

/**
 * How many of a customer's subscriptions get a full renewal estimate when sizing a
 * mandate. Each one plans an invoice (lines → discounts → tax → credit), and this runs
 * on an add-card request, so an unbounded loop would put a customer's whole book on the
 * critical path of a button press. Ordered by cached MRR, so the largest — the one that
 * decides the ceiling — is always inside the window, and anything dropped is LOGGED
 * rather than silently ignored.
 */
const MANDATE_SIZING_SUBSCRIPTION_LIMIT = 10;

/**
 * Per-debit ceiling to register a mandate with, in minor units of `currency`.
 *
 * Mandate rails (RazorPay e-mandate/UPI/card, SEPA, ACH) demand an upper bound up front
 * and enforce it at debit time, so a ceiling unrelated to the real invoice is a renewal
 * failure waiting to happen. It is sized from **what the next renewal invoice will
 * actually present for collection** — `estimateRenewal`'s `total_minor`, tax included and
 * discounts applied — plus `MANDATE_HEADROOM_BPS`.
 *
 * ⚠️ `total_minor`, NOT `amount_due_minor`, and the difference is load-bearing.
 * `amount_due` is net of the customer's credit balance, which is a ONE-OFF: size a
 * mandate against a renewal that a ₹5,000 credit happens to be paying down, and the
 * renewal after it — full price, no credit left — is refused. `total_minor` is the
 * repeatable figure. (The shortfall WARNING is the opposite case and correctly uses
 * `amount_due`: it asks what this particular charge will be.)
 *
 * Lives here rather than in `payment-methods/service.ts` because it is a billing
 * projection: the old version summed `prices.amount_minor × quantity`, which missed tax
 * entirely and read 0 for every tiered, volume, stairstep and percentage price.
 *
 * What it still cannot see: **metered usage**, which does not exist until the period is
 * rated (`planSubscriptionPeriodInvoice` skips usage items with no window, exactly as a
 * renewal preview must). A usage-heavy subscription is therefore sized on its fixed
 * component; `mandateRefusal` remains the backstop, and `mandate_shortfall` names it on
 * the next estimate.
 *
 * ⚠️ INR + cards: RBI's e-mandate framework auto-debits without re-authentication only up
 * to ₹15,000. A ceiling above that is legal to register but every debit over ₹15,000
 * triggers AFA and stops being off-session — so an expensive INR plan cannot renew
 * unattended on cards no matter what we set here. Left unclamped deliberately: silently
 * lowering the ceiling would guarantee the debit is refused, which is strictly worse than
 * a debit that asks the buyer to authenticate.
 */
export async function deriveMandateCeiling(
  organizationId: string,
  businessId: string,
  customerId: string,
  currency: string,
): Promise<bigint> {
  const cur = currency.toUpperCase();
  const largestRenewal = await largestRenewalTotal(organizationId, businessId, customerId, cur);
  const mandateCfg = await mandateConfigFor(organizationId, businessId);
  if (largestRenewal > 0n) return withMandateHeadroom(largestRenewal, mandateCfg);

  // No estimate could be produced — a subscription that is `future`/`paused`, or one
  // whose renewal planner declined. The pre-tax catalog proxy is worse (see its own
  // docstring) but it is a real amount, and being proportional to the plan beats a
  // currency-blind constant.
  const proxy = await largestRecurringDebit(organizationId, businessId, customerId, cur);
  if (proxy > 0n) return withMandateHeadroom(proxy, mandateCfg);

  // Nothing to infer from at all — the ordinary signup order (vault, THEN subscribe)
  // lands here every time.
  return mandateFallbackCeiling(cur);
}

/**
 * The largest single renewal this customer will actually be presented with, tax and
 * discounts in — `estimateRenewal`'s own total, which is what the gateway debits.
 *
 * Two callers, and they must agree: the mandate ceiling sizes from it, and the buyer's
 * AFA advice compares it to ₹15,000. Answering those from different numbers is how a
 * customer gets told a debit clears the ceiling while the mandate is sized as though it
 * does not.
 *
 * 0n when nothing can be estimated — `future`/`paused` subscriptions, or a renewal
 * planner that declined. Callers decide what to fall back to.
 */
export async function largestRenewalTotal(
  organizationId: string,
  businessId: string,
  customerId: string,
  currency: string,
): Promise<bigint> {
  const cur = currency.toUpperCase();
  // Only the statuses `estimateRenewal` can answer for — it returns null for anything
  // else, and each null would have cost an invoice plan to discover. `paused` and
  // `future` subscriptions fall to the proxy below instead.
  const subs = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: subscriptions.id, publicId: subscriptions.publicId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.businessId, businessId),
          eq(subscriptions.customerId, customerId),
          eq(subscriptions.currency, cur),
          inArray(subscriptions.status, ["active", "in_trial"]),
        ),
      )
      .orderBy(desc(subscriptions.mrr))
      .limit(MANDATE_SIZING_SUBSCRIPTION_LIMIT + 1),
  );

  const sized = subs.slice(0, MANDATE_SIZING_SUBSCRIPTION_LIMIT);
  if (subs.length > sized.length) {
    log.warn("mandate ceiling sized from the largest subscriptions only", {
      event: "mandate_sizing_truncated",
      customerId,
      currency: cur,
      considered: sized.length,
      skipped: subs.length - sized.length,
    });
  }

  // The LARGEST single renewal, not the sum: each renewal debits one subscription, and
  // a mandate sized for the total would ask the buyer to authorise money no one debit
  // will ever carry.
  let largestRenewal = 0n;
  for (const sub of sized) {
    const est = await estimateRenewalCeiling(
      { organizationId, businessId, subscriptionId: sub.id },
      "total",
    );
    if (!est) continue; // not renewing (cancelling, cycle cap exhausted) — nothing to size for
    const total = BigInt(est.total_minor);
    if (total > largestRenewal) largestRenewal = total;
  }
  return largestRenewal;
}

/**
 * The renewal a debit NOTICE or a mandate must cover: today's items or the items a
 * scheduled change leaves, whichever debits more. The change can still fail or be
 * withdrawn after the notice, and the renewal then bills today's items; a notice must
 * never state less than the debit. Display surfaces use `estimateRenewal`.
 */
export async function estimateRenewalCeiling(
  input: Parameters<typeof estimateRenewal>[0],
  by: "amount_due" | "total" = "amount_due",
): Promise<Estimate | null> {
  const expected = await estimateRenewal(input);
  if (expected && !expected.scheduled_change) return expected;
  const today = await estimateRenewal({ ...input, ignoreScheduledChanges: true });
  if (!expected || !today) return expected ?? today;
  const amount = (e: Estimate) =>
    by === "total" ? e.total_minor : (e.amount_due_minor ?? e.total_minor);
  return amount(today) > amount(expected) ? today : expected;
}

/**
 * What this buyer's next renewal will really debit — the number the portal and checkout
 * compare to the ₹15,000 AFA ceiling.
 *
 * Prefers the real estimate (tax in). Falls back to the pre-tax catalog proxy only when
 * no renewal can be estimated, which is the same order `deriveMandateCeiling` uses, so
 * the advice and the ceiling never disagree about the amount.
 */
export async function expectedRecurringDebit(
  organizationId: string,
  businessId: string,
  customerId: string,
  currency: string,
): Promise<bigint> {
  const real = await largestRenewalTotal(organizationId, businessId, customerId, currency);
  if (real > 0n) return real;
  return largestRecurringDebit(organizationId, businessId, customerId, currency);
}

/** The item operations `estimateChange` resolved for an edit, before any money. */
interface ChangeItemPlan {
  sub: typeof subscriptions.$inferSelect;
  rows: Array<{ item: typeof subscriptionItems.$inferSelect; price: typeof prices.$inferSelect }>;
  removedItemIds: Set<string>;
  changed: Array<{
    current: { item: typeof subscriptionItems.$inferSelect; price: typeof prices.$inferSelect };
    newPrice: typeof prices.$inferSelect;
    newQty: number;
    newSnapshot: PriceSnapshot;
  }>;
  reratedByItemId: Map<string, PriceSnapshot>;
  postCycle: { interval: string; intervalCount: number };
  addResolved: Array<{ price: typeof prices.$inferSelect; qty: number; snapshot: PriceSnapshot }>;
  resetTerm: boolean;
}

/** Thrown by the renewal planner's `onPlan` to stop `estimateChange` once it has the plan. */
class PlanCaptured extends Error {}

/**
 * The items a scheduled change leaves, read-only: what `changeSubscription` writes when
 * the applier runs it at `effectiveAt`. The same item resolution as `estimateChange`,
 * plus the CAT-3 mandatory add-ons the booking adds and removes on a plan change.
 *
 * Null when the renewal cannot be priced from it: the change resets the term (its own
 * invoice bills the new term) or the applier would refuse it.
 */
async function itemsAfterScheduledChange(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  effectiveAt: Date;
  work: { changes?: ItemChange[]; adds?: ItemAdd[]; removes?: string[] };
}): Promise<PeriodItemRow[] | null> {
  const { organizationId, businessId } = input;
  const adds = input.work.adds ?? [];
  let plan: ChangeItemPlan | undefined;
  try {
    await estimateChange({
      organizationId,
      businessId,
      subscriptionId: input.subscriptionId,
      now: input.effectiveAt,
      changes: input.work.changes ?? [],
      adds,
      removes: input.work.removes ?? [],
      onPlan: (p) => {
        plan = p;
        throw new PlanCaptured();
      },
    });
  } catch (e) {
    if (e instanceof ProrationError) return null;
    if (!(e instanceof PlanCaptured)) throw e;
  }
  if (!plan || plan.resetTerm) return null;
  const p = plan;
  return withTenant(organizationId, async (tx) => {
    const changed = new Map(p.changed.map((c) => [c.current.item.id, c]));
    const kept = p.rows.filter((r) => !p.removedItemIds.has(r.item.id));
    const post = kept.map((r) => {
      const c = changed.get(r.item.id);
      const rerated = p.reratedByItemId.get(r.item.id);
      const price = c?.newPrice ?? r.price;
      return {
        item: {
          ...r.item,
          priceId: price.id,
          quantity: c?.newQty ?? r.item.quantity,
          priceSnapshot: rerated
            ? alignSnapshotToCycle(rerated, p.postCycle)
            : (c?.newSnapshot ?? r.item.priceSnapshot),
        },
        price,
      };
    });
    const newItem = (
      price: typeof prices.$inferSelect,
      quantity: number,
      snapshot: PriceSnapshot,
      billingCycles: number | null,
      autoIncluded: boolean,
    ): (typeof post)[number] => ({
      item: {
        id: randomUUID(),
        organizationId,
        businessId,
        subscriptionId: p.sub.id,
        publicId: "",
        priceId: price.id,
        quantity,
        freeQuantity: null,
        billingCycles,
        cyclesBilled: 0,
        metadata: autoIncluded ? { auto_included: "mandatory" } : null,
        priceSnapshot: snapshot,
        usageBilledThrough: null,
        nextCreditResetAt: null,
        createdAt: input.effectiveAt,
      },
      price,
    });
    p.addResolved.forEach((a, i) =>
      post.push(
        newItem(
          a.price,
          a.qty,
          a.snapshot,
          adds[i]?.billingCycles ?? null,
          !!adds[i]?.autoIncluded,
        ),
      ),
    );

    // CAT-3, as the booking does it: the plan's mandatory add-ons join, and an
    // auto-included one the plan no longer requires leaves.
    const productIds = [...new Set(post.map((r) => r.price.productId))];
    const kinds = await tx
      .select({ id: products.id, kind: products.kind })
      .from(products)
      .where(inArray(products.id, productIds));
    const planIds = kinds.filter((k) => k.kind === "plan").map((k) => k.id);
    // The booking refuses to remove a mandatory add-on of the plan; so does this preview.
    const removedProducts = [
      ...new Set(
        p.rows.filter((r) => p.removedItemIds.has(r.item.id)).map((r) => r.price.productId),
      ),
    ];
    if (
      removedProducts.length > 0 &&
      (await findMandatoryItemIds(tx, businessId, planIds, removedProducts)).size > 0
    )
      return null;
    const mandatory = await resolveMandatoryAttachedItems(tx, {
      businessId,
      planProductIds: planIds,
      currency: p.sub.currency,
      interval: p.sub.billingPeriodUnit,
      intervalCount: p.sub.billingPeriod ?? 1,
      // No organizationId/subscriptionId: with them a skip writes an audit row.
      existingProductIds: productIds,
    });
    for (const m of mandatory) {
      if (m.chargeOnce) continue;
      const snapshot = alignSnapshotToCycle(
        snapshotPrice(
          m.price,
          m.differentialAmountMinor ?? undefined,
          m.differentialTiers ?? undefined,
        ),
        p.postCycle,
      );
      post.push(newItem(m.price, m.quantity, snapshot, m.billingCycles, true));
    }
    const autoIncluded = post.filter(
      (r) =>
        (r.item.metadata as { auto_included?: string } | null)?.auto_included === "mandatory" &&
        p.rows.some((x) => x.item.id === r.item.id) &&
        !changed.has(r.item.id),
    );
    const stillMandatory = autoIncluded.length
      ? await findMandatoryItemIds(tx, businessId, planIds, [
          ...new Set(autoIncluded.map((r) => r.price.productId)),
        ])
      : new Set<string>();
    const dropped = new Set(
      autoIncluded.filter((r) => !stillMandatory.has(r.price.productId)).map((r) => r.item.id),
    );

    const allProducts = [...new Set(post.map((r) => r.price.productId))];
    const prodRows = await tx
      .select({
        id: products.id,
        name: products.name,
        kind: products.kind,
        publicId: products.publicId,
      })
      .from(products)
      .where(inArray(products.id, allProducts));
    const prod = new Map(prodRows.map((r) => [r.id, r]));
    return post
      .filter((r) => !dropped.has(r.item.id))
      .map((r) => ({
        item: r.item,
        price: r.price,
        productName: prod.get(r.price.productId)?.name ?? "",
        productKind: prod.get(r.price.productId)?.kind ?? null,
        productPublicId: prod.get(r.price.productId)?.publicId ?? "",
      }))
      .sort((a, b) => Number(a.productKind !== "plan") - Number(b.productKind !== "plan"));
  });
}

/** Preview the proration for a subscription change without applying it. */
/**
 * Rate the FULL post-change composition for one whole term — every surviving item at
 * its full term price, plus the items being added, minus the items being removed.
 *
 * Two callers need exactly this and must not drift apart:
 *   1. the IN-TRIAL branch of `estimateChange`, previewing the invoice the trial-end
 *      conversion will raise (nothing is prorated inside a trial), and
 *   2. `next_renewal`, previewing the renewal invoice that follows the change.
 * It was written for (1) and inlined there; (2) is the same question asked about a
 * later date, and the dashboard answering it on its own — `Σ unit_price × quantity`,
 * no tax, no coupons — is the defect `Estimate.next_renewal` documents.
 *
 * Deliberately NOT routed through `planSubscriptionPeriodInvoice` (which
 * `estimateRenewal` uses): that reads the item set from the database, and the whole
 * point here is the composition the caller has NOT applied yet. The rating rules below
 * are kept in step with it — snapshot-rated, exhausted item-level cycle caps skipped,
 * metered items excluded (usage for a period that has not happened is unknown;
 * `estimateNewSubscription` draws the same line).
 *
 * Pure and synchronous: every lookup it needs has already been resolved by the caller.
 * `discountLines` comes back alongside the lines so the caller can hand them straight
 * to `peekDiscounts`, whose coupon item-constraints match on the product slug.
 */
function rateFullTermComposition(input: {
  rows: Array<{ item: typeof subscriptionItems.$inferSelect; price: typeof prices.$inferSelect }>;
  removedItemIds: Set<string>;
  changedByItemId: Map<
    string,
    { newPrice: typeof prices.$inferSelect; newQty: number; newSnapshot: PriceSnapshot }
  >;
  reratedByItemId: Map<string, PriceSnapshot>;
  postCycle: { interval: string; intervalCount: number };
  addResolved: Array<{ price: typeof prices.$inferSelect; qty: number; snapshot: PriceSnapshot }>;
  prodById: Map<string, { kind: string | null; publicId: string }>;
}): {
  lines: EstimateLine[];
  discountLines: DiscountLine[];
  /** Per line, in `lines` order: does its price take tax. */
  taxable: boolean[];
  subtotal: bigint;
} {
  const {
    rows,
    removedItemIds,
    changedByItemId,
    reratedByItemId,
    postCycle,
    addResolved,
    prodById,
  } = input;
  const lines: EstimateLine[] = [];
  const discountLines: DiscountLine[] = [];
  const taxable: boolean[] = [];
  for (const r of rows) {
    if (removedItemIds.has(r.item.id)) continue;
    const chg = changedByItemId.get(r.item.id);
    const priceForCharge = chg ? chg.newPrice : r.price;
    const qty = chg ? chg.newQty : r.item.quantity;
    // `rerated` first: it is populated only for items NOT handled upstream, which
    // includes a quantity-only change whose `newSnapshot` deliberately preserves the
    // OLD rate — the very case the booking re-rates.
    const reratedRaw = reratedByItemId.get(r.item.id);
    const snapshot = reratedRaw
      ? alignSnapshotToCycle(reratedRaw, postCycle)
      : chg
        ? chg.newSnapshot
        : ((r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price));
    // Same cap the planner enforces (`invoicing/service.ts`) — an EXPLICIT
    // `billing_cycles`, or else an IMPLICIT 1 for a `one_time` snapshot, so a
    // one-off fee attached in-trial doesn't preview as billed again at the NEXT
    // renewal after the trial-end conversion has already billed it once. Shared
    // via `isCycleCapExhausted` (catalog/pricing.ts) — not re-derived here.
    if (isCycleCapExhausted(r.item.billingCycles, snapshot.type, r.item.cyclesBilled)) continue;
    const model = snapshot.model ?? priceForCharge.model;
    const agg = snapshot.usageAggregation ?? priceForCharge.usageAggregation ?? null;
    if (isMeteredPrice({ model, usageAggregation: agg })) continue;
    const amount = computeLineAmount(ratableFromSnapshot(snapshot, r.item.freeQuantity), qty);
    if (amount <= 0n) continue;
    const prod = prodById.get(priceForCharge.productId);
    discountLines.push({
      index: discountLines.length,
      amountMinor: amount,
      productKind: prod?.kind ?? null,
      productPublicId: prod?.publicId ?? null,
      pricePublicId: priceForCharge.publicId,
    });
    lines.push({
      description: `${priceLabel(priceForCharge)} ×${qty}`,
      amount_minor: Number(amount),
    });
    taxable.push(priceForCharge.isTaxable);
  }
  // Added items join the composition at their FULL term price. Same rating rules as the
  // existing rows above, so an added metered item is excluded here too.
  for (const a of addResolved) {
    const model = a.snapshot.model ?? a.price.model;
    const agg = a.snapshot.usageAggregation ?? a.price.usageAggregation ?? null;
    if (isMeteredPrice({ model, usageAggregation: agg })) continue;
    const amount = computeLineAmount(ratableFromSnapshot(a.snapshot, null), a.qty);
    if (amount <= 0n) continue;
    const prod = prodById.get(a.price.productId);
    discountLines.push({
      index: discountLines.length,
      amountMinor: amount,
      productKind: prod?.kind ?? null,
      productPublicId: prod?.publicId ?? null,
      pricePublicId: a.price.publicId,
    });
    lines.push({ description: `${priceLabel(a.price)} ×${a.qty}`, amount_minor: Number(amount) });
    taxable.push(a.price.isTaxable);
  }
  return {
    lines,
    discountLines,
    taxable,
    subtotal: lines.reduce((s, l) => s + BigInt(l.amount_minor), 0n),
  };
}

export async function estimateChange(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  changes: ItemChange[];
  /**
   * Items the caller will ADD (booked by `addSubscriptionItem`, i.e. `POST …/items`).
   * The dashboard applies a composition edit as up to three API calls — `/change` for
   * modified lines, `POST /items` per add, `DELETE /items/:id` per remove — so a
   * preview that covered only `changes` priced part of what the operator was about to
   * confirm and reported "no immediate charge" for the rest.
   */
  adds?: Array<{ priceId: string; quantity?: number; customAmountMinor?: number | null }>;
  /** Public ids of subscription items the caller will REMOVE (`DELETE …/items/:id`). */
  removes?: string[];
  /** Mirrors `changeSubscription`'s `resetTerm` — forces a term reset even without a frequency change. */
  resetTerm?: boolean;
  /**
   * A coupon the operator has added ON the change screen but which is not applied yet.
   *
   * The dashboard posts it as its own call (`POST …/discount`) AFTER the change, exactly
   * as it posts `adds`/`removes` separately — and those two parameters exist for precisely
   * this reason (see their notes above). Without this one the preview priced part of what
   * the operator was about to confirm: they added a coupon, the estimate did not move, and
   * the confirm charged a different number.
   */
  couponCodes?: string[];
  /**
   * Same, for `+ Add manual discount` (`POST …/manual_discount`).
   *
   * The dashboard is the only caller: a CHECKOUT session has no manual discount to be
   * pending — `checkout_sessions` carries `coupon_codes` and nothing else, and there is
   * no API to set one. Adding it would be a feature (column + mint parameter + buyer
   * surface), not a wiring job.
   */
  manualDiscount?: {
    kind: "percentage" | "fixed_amount";
    percentOffBps?: number;
    amountOffMinor?: bigint;
  };
  /**
   * Mirrors `changeSubscription`'s `removeDiscount`: the active discount is gone before
   * the proration is billed, the renewal is quoted without it, and a pending
   * `couponCodes`/`manualDiscount` is priced as its replacement.
   */
  removeDiscount?: boolean;
  /** The customer's selection under `downgrade_credit: customer_chooses` (portal). */
  creditChoice?: "credit_balance" | "refund";
  /** Mirrors `changeSubscription`'s `downgradeCredit`: the operator's choice, over the rule. */
  downgradeCredit?: "credit_balance" | "refund";
  /** Mirrors `changeSubscription`'s `planChangeCoupons`. */
  planChangeCoupons?: PlanChangeCoupons;
  /**
   * Mirrors `changeSubscription`'s `prorate`. Default true.
   * MUST stay in lockstep with the booking or the preview quotes a total the confirm
   * will not charge — `verify:estimates` asserts estimate == applied booking, which is
   * what caught this file being left behind when the reset rule changed.
   */
  prorate?: boolean;
  /** Receives the item plan before any money is priced. May throw to stop the estimate. */
  onPlan?: (plan: ChangeItemPlan) => void;
}): Promise<Estimate> {
  const { organizationId, businessId, now } = input;
  /**
   * Filled inside the tenant block, read after it. The open-invoice credit shares carry the
   * invoice's internal id, while `credit_destinations` prints only its NUMBER — so without
   * capturing them here the enrichment below would have to map numbers back to ids.
   */
  const creditedOpenInvoices: Array<{ id: string; label: string }> = [];
  const estimate = await withTenant(organizationId, async (tx): Promise<Estimate> => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new ProrationError("Subscription not found");
    // Cancelled subs have no live term — editing them is a reactivation, not a change.
    if (sub.status === "cancelled")
      throw new ProrationError(
        "You cannot estimate a change on a cancelled subscription. Reactivate it instead.",
      );
    // Mirror changeSubscription's term anchoring EXACTLY so the preview matches the
    // actual booking — resetStart from the anchor axis, prorationNow from the
    // proration axis (see billing-mode.ts). Any divergence here shows the customer a
    // number we then do not charge.
    // `prorationWindowStart`, in lockstep with `changeSubscription` — see the note
    // there. These two lines are the pair the README warns about: letting them drift
    // puts every preview a day off the invoice.
    const bizMode = await billingModeFor(tx, businessId);
    const resetStart = alignTermStart(now, bizMode);
    const prorationNow = prorationWindowStart(now, sub.currentPeriodStart, bizMode);
    const rows = await tx
      .select({ item: subscriptionItems, price: prices })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(eq(subscriptionItems.subscriptionId, sub.id));

    const existingProductIds = [...new Set(rows.map((r) => r.price.productId))];
    // publicId as well as kind: the in-trial branch below rates the post-change
    // composition through `peekDiscounts`, which matches coupon item-constraints on
    // the product slug.
    const existingKinds = await tx
      .select({ id: products.id, kind: products.kind, publicId: products.publicId })
      .from(products)
      .where(inArray(products.id, existingProductIds));
    const prodById = new Map(
      existingKinds.map((k) => [k.id, { kind: k.kind, publicId: k.publicId }]),
    );
    const kindById = {
      get: (id: string) => prodById.get(id)?.kind,
      has: (id: string) => prodById.has(id),
    };

    // The SAME labeller `changeSubscription` books with — the preview and the booking must
    // name a line identically, and the preview cannot lean on the substitution layers to do
    // it: both (`humanizeLineDescriptions`, `dashboard/lib/estimate-lines.ts`) resolve
    // `external_name ?? name` with NO product step, so on a platform price — which carries
    // neither — they leave the internal handle byte-for-byte and the buyer read it on the
    // hosted checkout. Resolving here makes those two substitutions harmless no-ops.
    const labelFor = makePriceLabeller(tx);

    const lines: EstimateLine[] = [];
    /**
     * The product behind each emitted line, positionally. Coupons can be constrained to
     * specific items (`each_specified_item`), and `computeStackedDiscounts` matches on
     * product kind + slug — so a discount priced against lines with no product identity
     * silently under-discounts every constrained coupon. `null` where the line has no
     * single product (an unbilled-charge settlement).
     */
    const lineProducts: Array<{
      kind: string | null;
      publicId: string;
      pricePublicId: string;
    } | null> = [];
    /** Per line: does it take tax. A line with no price is taxed, as on the invoice. */
    const lineTaxable: boolean[] = [];
    /** `lines.push` + the price (and so product) that line belongs to. Keep them in lockstep. */
    const pushLine = (
      line: EstimateLine,
      price?: { productId: string; publicId: string; isTaxable?: boolean } | null,
    ) => {
      lines.push(line);
      lineTaxable.push(price?.isTaxable !== false);
      const prod = price ? prodById.get(price.productId) : undefined;
      lineProducts.push(
        prod && price
          ? { kind: prod.kind, publicId: prod.publicId, pricePublicId: price.publicId }
          : null,
      );
    };
    /**
     * THE PRICES THIS CHANGE HANDS BACK — `issueCurrentTermCredit.targetPriceIds`, from
     * the preview's side (2026-09-01).
     *
     * Every negative line the loops below emit is a credit for the unused time of ONE
     * price, and the booking books that credit against the invoices which actually
     * CHARGED that price — not against every invoice on the term. Without this the two
     * sides distributed one credit over different invoice sets, and since each invoice
     * grosses the credit up on its own booked tax, different sets means a different
     * total. Measured on `probe-estimate-vs-booked-change-chain` step 3: the booking
     * credited one invoice and the preview spread the same ₹27,918 base over three.
     *
     * INTERNAL price ids (`prices.id`), because that is what `invoiceLineItems.price_id`
     * holds and what `invoicesChargingPrices` matches on.
     */
    const creditedPriceIds = new Set<string>();
    let frequencyChanged = false;
    let isPlanSwap = false; // a change to a different plan price → term reset (mirrors changeSubscription)
    /** The plan price this change moves onto, for `plan_change_coupons`. */
    let movedPlan: typeof prices.$inferSelect | null = null;
    let newInterval = (sub.billingPeriodUnit ?? "month") as Interval;
    let newIntervalCount = sub.billingPeriod ?? 1;
    const resolved: Array<{
      current: (typeof rows)[number];
      newPrice: typeof prices.$inferSelect;
      newQty: number;
      newSnapshot: PriceSnapshot;
    }> = [];

    // ── FIRST PASS: which cycle are these items landing on? ────────────────────
    // Mirrors `changeSubscription`'s first pass exactly (see the long note there) —
    // and it has to, because this function's whole contract is that the preview
    // refuses what the apply refuses and quotes what the apply charges.
    //
    // The cycle a non-plan item must divide is the PLAN's cadence AFTER this batch of
    // changes, not the cadence the subscription happens to hold right now. Reading
    // the stored cadence made a legal two-axis edit (plan monthly→yearly AND each
    // add-on onto its own yearly price) look illegal per item, and made the answer
    // depend on the order of the `changes` array — the guard could be standing in
    // front of an element that a LATER element was about to make valid.
    //
    // Prices are resolved once here and reused below, so this costs no extra
    // queries, and it raises nothing: the loop below still reports a bad item id, an
    // unknown price and a currency clash in the caller's own array order.
    const priceByPublicId = new Map<string, typeof prices.$inferSelect>();
    for (const change of input.changes) {
      if (!change.newPriceId || priceByPublicId.has(change.newPriceId)) continue;
      const [p] = await tx
        .select()
        .from(prices)
        .where(and(eq(prices.businessId, businessId), eq(prices.publicId, change.newPriceId)))
        .limit(1);
      if (!p) continue; // the loop below raises `No such price`, in the caller's order
      priceByPublicId.set(change.newPriceId, p);
      if (!prodById.has(p.productId)) {
        const [prod] = await tx
          .select({ kind: products.kind, publicId: products.publicId })
          .from(products)
          .where(eq(products.id, p.productId))
          .limit(1);
        if (prod) prodById.set(p.productId, { kind: prod.kind, publicId: prod.publicId });
      }
    }
    // ── ONE CYCLE, AND ARRAY ORDER MUST NOT DECIDE IT (2026-08-26) ─────────────────
    // This pass used to ASSIGN on every plan-kind change, so the LAST plan in the array
    // won. The comment above promises the opposite, and for a single plan item it
    // delivers — but `items.ts` states plainly that a sub can carry several plans, and 103
    // of 5,624 subscriptions in the local book have two. Measured: two monthly plans moved
    // to yearly and quarterly in ONE call estimated 175000 or 400000 depending on array
    // order — 2.3x, a different resulting cycle, and in one order the quarterly plan item
    // itself folded x4.
    //
    // A subscription HAS one billing cycle, so two plan items landing on different
    // cadences has no correct answer to pick — which is why `createSubscription` already
    // refuses exactly this, for the reason it states: "picking the cadence off the first
    // recurring price only makes sense once they all match: otherwise the subscription's
    // cycle depends on the order the caller happened to list its items in, and every item
    // that disagrees is silently re-cadenced to it." This is that rule, on the change path.
    const planCadences = new Map<string, { interval: Interval; intervalCount: number }>();
    // Which plan product the subscription LANDS on, for differential resolution below.
    const planProductIds = new Set<string>();
    for (const change of input.changes) {
      const current = rows.find((r) => r.item.publicId === change.itemId);
      if (!current) continue;
      const candidate = change.newPriceId ? priceByPublicId.get(change.newPriceId) : undefined;
      if (change.newPriceId && !candidate) continue;
      if (kindById.get((candidate ?? current.price).productId) !== "plan") continue;
      planProductIds.add((candidate ?? current.price).productId);
      // Cadence-wise, the snapshot the loop below will freeze: a new price (with or
      // without a custom amount) carries its own interval, while a quantity-only
      // change PRESERVES the item's snapshot and therefore its cadence.
      const preserved = current.item.priceSnapshot as PriceSnapshot | null;
      const cadence = candidate
        ? { interval: candidate.interval, intervalCount: candidate.intervalCount }
        : preserved
          ? { interval: preserved.interval, intervalCount: preserved.intervalCount }
          : { interval: current.price.interval, intervalCount: current.price.intervalCount };
      const resolved = {
        interval: (cadence.interval ?? "month") as Interval,
        intervalCount: cadence.intervalCount ?? 1,
      };
      // Keyed by the cadence itself, so two plan items moving to the SAME cadence collapse
      // to one entry and remain legal — it is disagreement that is refused, not plurality.
      planCadences.set(`${resolved.interval}:${resolved.intervalCount}`, resolved);
    }
    if (planCadences.size > 1) {
      // SORTED, so the message is order-independent too. The decision already was; the
      // text was not, and a caller matching on it would have seen two spellings of one
      // refusal depending on how it happened to order its array.
      const shown = [...planCadences.keys()]
        .sort()
        .map((k) => planCadences.get(k)!)
        .map((c) => `${c.intervalCount} ${c.interval}`)
        .join(" and ");
      throw new ProrationError(
        `A subscription has one billing cycle, but this change puts its plan items on ${shown}. ` +
          `Move them to the same cadence, or apply the changes in separate calls.`,
      );
    }
    let postCycleInterval = (sub.billingPeriodUnit ?? "month") as Interval;
    let postCycleIntervalCount = sub.billingPeriod ?? 1;
    const resolvedPlanCadence = [...planCadences.values()][0];
    if (resolvedPlanCadence) {
      postCycleInterval = resolvedPlanCadence.interval;
      postCycleIntervalCount = resolvedPlanCadence.intervalCount;
    }
    // The plan an add-on's differential is priced against, AFTER this change. Only when the
    // change lands on exactly one plan product; otherwise null, and the resolver falls back
    // to the plan the subscription has now — which is the right answer whenever this call
    // leaves the plan alone, and that is the case F-16 was measured on.
    const postPlanProductId = planProductIds.size === 1 ? [...planProductIds][0]! : null;
    // The cycle every non-plan item in this change is rated and validated against.
    const postCycle = { interval: postCycleInterval, intervalCount: postCycleIntervalCount };
    // Did the plan cadence actually move? Only then does anything below diverge from
    // the subscription's stored cycle — every same-cadence preview is untouched.
    const cycleMoved =
      postCycle.interval !== (sub.billingPeriodUnit ?? "month") ||
      postCycle.intervalCount !== (sub.billingPeriod ?? 1);

    for (const change of input.changes) {
      const current = rows.find((r) => r.item.publicId === change.itemId);
      if (!current)
        throw new ProrationError(`We could not find the subscription item ${change.itemId}.`);
      let newPrice = current.price;
      if (change.newPriceId) {
        // Resolved (with its product's kind + slug) in the first pass above.
        const p = priceByPublicId.get(change.newPriceId);
        if (!p) throw new ProrationError(`We could not find the price ${change.newPriceId}.`);
        if (p.currency !== sub.currency)
          throw new ProrationError("You cannot change to a price in a different currency");
        newPrice = p;
      }
      const newQty = change.newQuantity ?? current.item.quantity;
      if (change.customAmountMinor != null && !isOverridable(newPrice.model)) {
        throw new ProrationError(
          `You can set a custom price only on a flat or per_unit price. This price is ${newPrice.model}.`,
        );
      }
      // Effective new snapshot mirrors changeSubscription: override > differential-resolved
      // new price > preserved snapshot.
      //
      // The differential resolution has to be here too, and in the SAME change as the
      // booking path (F-16, 2026-08-26). The two were consistently wrong together — both
      // froze the catalog 0 — so preview equalled booking and every check comparing them
      // passed while both billed nothing. Fixing one alone would have turned a silent money
      // bug into a loud preview/booking drift; fixing neither is how it survived.
      const differential = change.newPriceId
        ? postPlanProductId
          ? await resolveDifferentialAgainstPlanTx(tx, postPlanProductId, newPrice)
          : await resolveDifferentialForAddTx(tx, sub.id, newPrice)
        : null;
      const rawSnapshot: PriceSnapshot =
        change.customAmountMinor != null
          ? snapshotPrice(newPrice, change.customAmountMinor)
          : change.newPriceId
            ? snapshotWithDifferential(newPrice, differential)
            : ((current.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(newPrice));

      const postKind = change.newPriceId
        ? kindById.get(newPrice.productId)
        : kindById.get(current.price.productId);
      // Same split as changeSubscription: fold a non-plan item into the cycle; leave
      // the plan un-aligned so its own interval can still signal a frequency change.
      const newSnapshot: PriceSnapshot =
        postKind === "plan" ? rawSnapshot : alignSnapshotToCycle(rawSnapshot, postCycle);
      // `changeSubscription` refuses a non-plan item whose cadence the post-change
      // cycle cannot absorb; this preview did not check at all, so it quoted a number
      // the confirm then threw on. Measured on the live API before this landed: a
      // yearly add-on swapped onto a MONTHLY subscription previewed HTTP 200 with a
      // line "Remaining time on …-Yearly ×1  4606000" — a whole year rated inside a
      // monthly term, 12× the truth — and the apply raised `Billing period mismatch`.
      // Same shape as the booking's guard, deliberately: only an actual price SWAP is
      // validated, because a quantity-only change preserves the existing snapshot and
      // re-validating there would refuse items that predate this rule.
      if (postKind !== "plan" && change.newPriceId) {
        const reason = cadenceMismatch(newPrice, postCycle.interval, postCycle.intervalCount);
        if (reason) throw new ProrationError(reason);
      }
      if (postKind === "plan") {
        const effInterval = (newSnapshot.interval ?? "month") as Interval;
        const effIntervalCount = newSnapshot.intervalCount ?? 1;
        if (
          effInterval !== (sub.billingPeriodUnit ?? "month") ||
          effIntervalCount !== (sub.billingPeriod ?? 1)
        ) {
          frequencyChanged = true;
        }
        newInterval = effInterval;
        newIntervalCount = effIntervalCount;
        // A plan SWAP (change to a different plan price, up or down) → term reset.
        if (change.newPriceId != null && newPrice.id !== current.item.priceId) {
          isPlanSwap = true;
          movedPlan = newPrice;
        }
      }
      resolved.push({ current, newPrice, newQty, newSnapshot });
    }

    // ── ADDS / REMOVES ────────────────────────────────────────────────────────
    // These are booked by items.ts, NOT by changeSubscription. Both now prorate from
    // `prorationWindowStart` (the start of the current billing day): items.ts always did,
    // and a CHANGE moved onto it 2026-08-23, since a mid-term change counts the change
    // day (see the note in changeSubscription). Kept as a separate local rather than
    // reusing `prorationNow` so this stays honest if the two ever diverge again — the
    // README's warning still stands, a preview a day off the booking is the failure mode.
    const itemWindowStart = prorationWindowStart(now, sub.currentPeriodStart, bizMode);
    const removedRows = (input.removes ?? []).map((pid) => {
      const row = rows.find((r) => r.item.publicId === pid);
      if (!row) throw new ProrationError(`We could not find the subscription item ${pid}.`);
      return row;
    });
    const removedItemIds = new Set(removedRows.map((r) => r.item.id));

    // ── THE DIFFERENTIAL RE-RATE, MIRRORED FROM `proration.ts` ────────────────────
    // F-16's rule is that this resolution lives in BOTH paths or they drift, and until now
    // only the booking had it: the estimate reproduced the three upstream snapshot branches
    // and had NO re-rating pass at all, so an untouched — or quantity-only-changed — add-on
    // was previewed at the OUTGOING plan's rate while the booking charged the incoming
    // plan's. The change-checkout page quoted ₹752 against an invoice of ₹470.
    //
    // The gap widened when the booking side started BILLING the move (add-ons re-rated by a
    // plan change now get their own credit and charge lines), so closing it here is
    // finishing that work rather than starting new work.
    //
    // ⚠️ ALIGN, NOT REALIGN. `proration.ts` applies `alignSnapshotToCycle` to a FRESHLY
    // resolved snapshot; this file applies `realignSnapshotToCycle` to snapshots that were
    // already folded against the old cycle. Folding a fresh resolve through `realign` would
    // scale it twice and mis-rate a cadence change. Safe here because the loops that consume
    // this map compute straight from the snapshot and do not realign — unlike the ADD path
    // above, which does.
    const handledUpstream = new Set(
      input.changes.filter((c) => c.newPriceId || c.customAmountMinor != null).map((c) => c.itemId),
    );
    const reratedByItemId = new Map<string, PriceSnapshot>();
    if (postPlanProductId) {
      for (const r of rows) {
        if (removedItemIds.has(r.item.id)) continue;
        if (handledUpstream.has(r.item.publicId)) continue;
        if (kindById.get(r.price.productId) !== "addon") continue;
        const diff = await resolveDifferentialAgainstPlanTx(tx, postPlanProductId, r.price);
        if (!diff || (diff.amountMinor == null && diff.tiers == null)) continue;
        const before = (r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price);
        if (before.type !== "recurring") continue;
        // RAW, unaligned. Each consumer below folds it onto the cycle IT uses, exactly
        // once — one loop prices against `postCycle`, the other against
        // `newInterval`/`newIntervalCount`, and storing a pre-folded snapshot would either
        // scale it twice or fold it onto the wrong cadence.
        const raw = snapshotWithDifferential(r.price, diff);
        const after = alignSnapshotToCycle(raw, postCycle);
        if (
          after.amountMinor === before.amountMinor &&
          JSON.stringify(after.tiers ?? null) === JSON.stringify(before.tiers ?? null)
        )
          continue;
        reratedByItemId.set(r.item.id, raw);
      }
    }
    /**
     * What the booking will CANCEL rather than credit: the part of a still-pending
     * deferred charge, booked under `priceId`, that covers time after `heldUntil`
     * (money bug, 2026-08-24 — see planRemovedItemUnbilledSettlements). Subtracted from
     * every unused-time credit this preview quotes, exactly as `changeSubscription`
     * subtracts it, or the preview promises a credit the booking will not issue.
     *
     * Deduplicated on the same rows the booking dedupes, so a price reached by two
     * loops is counted once here too.
     */
    const clawedBackIds = new Set<string>();
    const clawback = async (priceId: string, heldUntil: Date): Promise<bigint> => {
      const found = await planRemovedItemUnbilledSettlements(tx, {
        subscriptionId: sub.id,
        priceIds: [priceId],
        heldUntil,
      });
      let total = 0n;
      for (const s of found) {
        if (clawedBackIds.has(s.row.id)) continue;
        clawedBackIds.add(s.row.id);
        total += s.droppedMinor;
      }
      return total;
    };
    const addResolved: Array<{
      price: typeof prices.$inferSelect;
      qty: number;
      snapshot: PriceSnapshot;
    }> = [];
    for (const add of input.adds ?? []) {
      const [p] = await tx
        .select()
        .from(prices)
        .where(and(eq(prices.businessId, businessId), eq(prices.publicId, add.priceId)))
        .limit(1);
      if (!p) throw new ProrationError(`We could not find the price ${add.priceId}.`);
      // Mirror addSubscriptionItem's guards so the preview surfaces the same refusal
      // the apply would, instead of quoting a number for a change that cannot happen.
      if (p.currency !== sub.currency)
        throw new ProrationError("Item currency must match the subscription currency");
      // Against the POST-change cycle: the dashboard applies a composition edit as
      // `/change` then `POST …/items`, so an add in the same edit joins the cycle the
      // plan change has already established — refusing it against the outgoing cadence
      // blocked a legal edit (and, in the other direction, let an illegal one through).
      const cadenceReason = cadenceMismatch(p, postCycle.interval, postCycle.intervalCount);
      if (cadenceReason) throw new ProrationError(cadenceReason);
      if (add.customAmountMinor != null && !isOverridable(p.model)) {
        throw new ProrationError(
          `You can set a custom price only on a flat or per_unit price. This price is ${p.model}.`,
        );
      }
      // `effectiveAddSnapshotTx` is the booking's own resolver, so the differential /
      // override / catalog decision cannot drift — but it folds the item into the
      // cycle it reads from the DB, i.e. the OUTGOING one. When this same request also
      // moves the plan's cadence, `addSubscriptionItem` will run AFTER the change and
      // fold against the NEW cycle, so re-express it here. `realignSnapshotToCycle`
      // (not `alignSnapshotToCycle`) because the forward scale is not idempotent
      // across a change of cycle — it rewinds through the recorded `cadenceMultiple`
      // first. Gated on `cycleMoved` so a same-cadence preview is byte-identical.
      // POST-CHANGE PLAN, not the stored one: this same call may be moving the plan, and
      // the differential must resolve against the plan the item will actually live under.
      // Passing nothing here priced an add-on added in the same edit at the OUTGOING plan's
      // rate — `verify:proration` § G, both directions, and it recurred through the frozen
      // snapshot. Null when the plan is not moving, which restores the stored-plan lookup.
      const rawAddSnapshot = await effectiveAddSnapshotTx(
        tx,
        sub.id,
        p,
        add.customAmountMinor,
        postPlanProductId,
      );
      const snapshot = cycleMoved
        ? realignSnapshotToCycle(rawAddSnapshot, postCycle)
        : rawAddSnapshot;
      if (!prodById.has(p.productId)) {
        const [prod] = await tx
          .select({ kind: products.kind, publicId: products.publicId })
          .from(products)
          .where(eq(products.id, p.productId))
          .limit(1);
        if (prod) prodById.set(p.productId, { kind: prod.kind, publicId: prod.publicId });
      }
      addResolved.push({ price: p, qty: add.quantity ?? 1, snapshot });
    }

    const resetTerm = input.resetTerm === true || frequencyChanged;
    // ⚠ THE PREVIEW HALF OF `proration.ts`'s reset boundary — see the note there. These two
    // lines must stay identical: this one quotes `new_period_end` to the operator, that one
    // books it. `advancePeriod` (business calendar) not `addInterval` (UTC calendar).
    //
    // ── AND THE ANCHOR IS THE RESET'S OWN, NOT THE SUBSCRIPTION'S (money bug, 2026-08-31) ──
    // Both halves passed `sub.billingAnchorDay` — the PRE-reset day of the month — while
    // `proration.ts` separately PERSISTED the post-reset one. `advancePeriod` takes
    // day-of-month entirely from that argument, so the new term end landed on the OLD day:
    // measured on `verify:renewal-matrix`'s 08→23 monthly→yearly swap, the reset minted
    // 2026-08-23 → 2027-08-08, a 350-day "year", and the first renewal ran 381 days.
    //
    // Being wrong IDENTICALLY on both sides is why it survived: the preview and the booking
    // agreed, so no estimate assertion could see it, and `verify:estimates` still passes with
    // only one side fixed because it has no fixture where a reset MOVES the anchor. That
    // fixture now exists — `verify:estimates` § reset-anchor asserts the previewed
    // `new_period_end` equals the booked `current_period_end` on an anchor-moving reset,
    // which is the only thing that can catch these two lines drifting again.
    const resetAnchorDay =
      newInterval === "month" || newInterval === "year"
        ? localDatePartsInTz(resetStart, bizMode.timezone).day
        : null;
    const newPeriodEnd = resetTerm
      ? advancePeriod(resetStart, newInterval, newIntervalCount, resetAnchorDay, bizMode)
      : null;

    // Coupons the plan change removes before it bills, as `changeSubscription` does.
    const dropCodes = movedPlan
      ? await couponsLeftBehind(tx, {
          businessId,
          subscriptionId: sub.id,
          newPlan: { productId: movedPlan.productId, pricePublicId: movedPlan.publicId },
          ...(input.planChangeCoupons ? { rule: input.planChangeCoupons } : {}),
        })
      : [];

    // ── IN TRIAL: mirror changeSubscription's trial gate EXACTLY ──────────────
    // `changeSubscription` charges and credits NOTHING while the subscription is in
    // trial (see proration.billsAtTrialEnd), so previewing a proration here would
    // show a number we will not charge — the exact defect this pair keeps hitting.
    // Instead preview the invoice the trial-end conversion WILL raise: the full
    // post-change composition, discounted by the subscription's coupons and taxed,
    // flagged `due_at_trial_end`.
    //
    // Deliberately NOT routed through `planSubscriptionPeriodInvoice` (which
    // estimateRenewal uses): that reads the item set from the database, and the
    // whole point here is the composition the caller has NOT applied yet. The
    // rating rules below are kept in step with it — snapshot-rated, exhausted
    // item-level cycle caps skipped, metered items excluded (usage for a period
    // that has not happened is unknown; `estimateNewSubscription` draws the same line).
    input.onPlan?.({
      sub,
      rows,
      removedItemIds,
      changed: resolved,
      reratedByItemId,
      postCycle,
      addResolved,
      resetTerm,
    });

    if (billsAtTrialEnd(sub)) {
      const {
        lines: trialLines,
        discountLines,
        taxable: trialTaxable,
        subtotal: trialSubtotal,
      } = rateFullTermComposition({
        rows,
        removedItemIds,
        reratedByItemId,
        postCycle,
        addResolved,
        prodById,
        changedByItemId: new Map(resolved.map((r) => [r.current.item.id, r])),
      });
      // Peek-only (no redemption is consumed): a welcome coupon on a trial sub is
      // the common case, and quoting the undiscounted list price at trial end is
      // just as much a lie as quoting a proration.
      // A discount removed on this screen is gone before the trial-end invoice is raised.
      const disc = await peekDiscounts(
        tx,
        sub.id,
        discountLines,
        sub.currency,
        input.removeDiscount || dropCodes.length
          ? {
              organizationId,
              businessId,
              ...(input.removeDiscount ? { removeActive: true } : {}),
              ...(dropCodes.length ? { dropCodes } : {}),
            }
          : undefined,
      );
      const discounted =
        trialSubtotal - disc.totalMinor > 0n ? trialSubtotal - disc.totalMinor : 0n;
      const [cus] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, sub.customerId))
        .limit(1);
      const trialTax = await estimateTax(
        organizationId,
        businessId,
        cus,
        discounted,
        taxedLineAmounts(
          discountLines.map((l) => l.amountMinor),
          disc.lineDiscountByIndex,
          trialTaxable,
        ),
      );
      return {
        object: "estimate",
        currency: sub.currency,
        lines: trialLines,
        subtotal_minor: Number(trialSubtotal),
        discount_minor: Number(disc.totalMinor),
        tax_minor: Number(trialTax.taxMinor + trialTax.inclusiveTaxMinor),
        tax_lines: trialTax.taxLines,
        total_minor: Number(discounted + trialTax.taxMinor),
        // Nothing moves today. The credit buckets are reported as zero rather than
        // simulated: no draw happens now, and what the customer's balance will be
        // at trial end is not knowable from here.
        immediate_charge: false,
        credits_applied_minor: 0,
        promotional_credits_applied_minor: 0,
        promotional_discount_minor: 0,
        refundable_credits_applied_minor: 0,
        excess_payments_applied_minor: 0,
        amount_due_minor: 0,
        // A trial change never re-anchors the term (changeSubscription keeps the
        // trial window intact even on a term reset), so the renewal date the caller
        // should show is the unchanged trial end — reported via due_at_trial_end.
        term_reset: false,
        new_period_end: null,
        // Straight off `trial_end`: a trialling subscription has no term since 2026-08-25,
        // and this field is the trial's end by definition.
        due_at_trial_end: sub.trialEnd?.toISOString() ?? null,
      };
    }

    // See `changeSubscription`'s `prorate` for why one flag behaves differently on the
    // two paths — it suppresses the PRORATED artefacts, and a full new-term charge is
    // not one of them.
    const prorate_ = input.prorate !== false;

    if (!resetTerm) {
      // Items that already produced their own change lines above — a re-rate must not
      // double-book one of them.
      const changedByItemIdForLines = new Set(resolved.map((r) => r.current.item.id));
      for (const { current, newPrice, newQty, newSnapshot } of resolved) {
        if (!prorate_) continue;
        const newRatable = ratableFromSnapshot(newSnapshot, current.item.freeQuantity);
        const oldSnap = current.item.priceSnapshot as PriceSnapshot | null;
        const oldRatable = ratableForItem(current.item, current.price);
        // A ONE-TIME item is charged once, prorated never, credited never — the
        // booking's own decider (`nonResetItemProration`, proration.ts) is called
        // here rather than re-derived, so this preview cannot drift from it.
        // SAME GATE AS THE BOOKING, and it has to be here or the two drift. `oldFullMinor`
        // is rated from the snapshot, which is right wherever the change that installed it
        // also billed the move — `prorate: false` being the one that does not. The booking
        // withholds the credit in that case (deliberate — see
        // `basisWasEverCharged`), so a preview that still quoted it would promise a credit
        // the confirm does not give. The decider stays shared; only its input is gated,
        // identically on both sides.
        // ONLY WHEN THE PRICE ACTUALLY SWAPS. A quantity-only move keeps the same price, so
        // its basis was self-evidently charged, and zeroing the credit there destroys the
        // added-units decomposition — measured: it broke 5 `verify:estimates` assertions and
        // three suites before this narrowing. The defect this gate exists for needs a price
        // swap to arise at all: it is the OUTGOING PRICE whose basis may never have been
        // billed.
        const oldBasisCharged =
          newPrice.id === current.price.id ||
          (await basisWasEverCharged(tx, sub.id, current.price.id));
        const { creditMinor, chargeMinor, chargeIsOneTime } = nonResetItemProration({
          oldSnapshotType: oldSnap?.type ?? current.price.type,
          newSnapshotType: newSnapshot.type,
          oldFullMinor: oldBasisCharged
            ? fixedChargeMinor(oldSnap ?? current.price, oldRatable, current.item.quantity)
            : 0n,
          newFullMinor: fixedChargeMinor(newSnapshot, newRatable, newQty),
          billingCycles: current.item.billingCycles,
          cyclesBilled: current.item.cyclesBilled,
          now: prorationNow,
          periodStart: requireTerm(sub).start,
          periodEnd: requireTerm(sub).end,
        });
        // Netted by what the booking will CANCEL instead of credit (the partial case:
        // a quantity reduced on an item whose charge is still only queued). Targeted at
        // the OLD price, the one that charge was booked under.
        const netCreditMinor = creditMinor - (await clawback(current.price.id, prorationNow));
        // MIRRORS the booking's line shape (proration.ts, same-price quantity move bills
        // the ADDED UNITS; a change that moved nothing books nothing). This preview is
        // what the customer actually reads before confirming — a ×21 → ×22 add-on
        // previewed as `Unused time ×21 -15,792.00` + `Remaining time ×22 +16,544.00`
        // instead of one `Additional Connections - Prorated Charges 1 ₹752.00`.
        // Same ₹752 either way, but the pair reads like a re-bill of the whole add-on.
        // Kept beside the booking's copy deliberately: these two blocks are duplicated
        // by design (see `nonResetItemProration`'s note above) and MUST move together.
        const qtyDelta = newQty - current.item.quantity;
        const netMinor = chargeMinor - netCreditMinor;
        const priceSwapped = newPrice.id !== current.price.id;
        if (!priceSwapped && !chargeIsOneTime && qtyDelta === 0 && netMinor === 0n) {
          // Nothing moved — no lines, matching the booking.
        } else if (
          !priceSwapped &&
          !chargeIsOneTime &&
          qtyDelta > 0 &&
          netCreditMinor > 0n &&
          netMinor > 0n
        ) {
          pushLine(
            {
              description: `${await labelFor(newPrice)} - Prorated Charges ×${qtyDelta}`,
              amount_minor: Number(netMinor),
            },
            newPrice,
          );
        } else if (
          // ── THE MIRROR OF THE INCREASE ABOVE — see `proration.ts` for the measurement ──
          // A same-price quantity DECREASE credits the REMOVED UNITS ONLY and raises no
          // invoice — measured: 0 new invoices raised by the change, 1 credit note (CN-722
          // adjustment USD 100.00, qty=2). The booking collapses the unused/remaining pair
          // into one negative line for exactly that reason, and this block is its declared
          // twin — "these two blocks are duplicated by design and MUST move together".
          //
          // It is not only the document count that moves, which is why this side cannot
          // be left behind. With a coupon applied AFTER the term was billed, the gross
          // shape lets the percentage land on a re-charge that is never raised: measured on
          // `verify:estimates`' own fixture (qty 10 → 6, 10%), the preview quoted −542800
          // against an apply of −472000 — 70800 apart, not a rounding difference. Leaving
          // the pair here would have reinstated that gap from the preview side.
          !priceSwapped &&
          !chargeIsOneTime &&
          qtyDelta < 0 &&
          netCreditMinor > 0n &&
          chargeMinor > 0n &&
          netMinor < 0n
        ) {
          creditedPriceIds.add(current.price.id);
          pushLine(
            {
              description: `Unused time on ${await labelFor(current.price)} ×${-qtyDelta}`,
              amount_minor: Number(netMinor),
            },
            current.price,
          );
        } else {
          if (netCreditMinor > 0n) {
            creditedPriceIds.add(current.price.id);
            pushLine(
              {
                description: `Unused time on ${await labelFor(current.price)} ×${current.item.quantity}`,
                amount_minor: -Number(netCreditMinor),
              },
              current.price,
            );
          }
          if (chargeMinor > 0n) {
            pushLine(
              {
                description: chargeIsOneTime
                  ? await labelFor(newPrice)
                  : `Remaining time on ${await labelFor(newPrice)} ×${newQty}`,
                amount_minor: Number(chargeMinor),
              },
              newPrice,
            );
          }
        }
      }
      // ── AND THE RE-RATED ADD-ONS, mirroring `proration.ts` ────────────────────────
      // The map above fixes what an item is PRICED at; these are the lines the change
      // itself books for moving it. Without them the preview quoted a total the booking
      // did not charge — caught by `verify:differential-on-plan-change`, PRO → BUSINESS
      // with 2 seats: estimate 2,820,000 against booked 2,763,600, exactly the
      // 2 × (75200 − 47000) the re-rate is worth.
      //
      // Same align-once rule as above: the raw differential is folded onto the term's
      // cycle here and never passed through `realign`.
      /**
       * SAME OUTGOING-PLAN GATE AS THE BOOKING's re-rate loop, and here for the same reason
       * the changed-item gate is: the booking withholds this credit when the outgoing plan's
       * price was never charged (a `prorate: false` change installed the differential without
       * billing it), so a preview that still quoted it would promise a credit the confirm does
       * not give. Computed once — it is a question about the PLAN, not about each add-on.
       */
      const outgoingPlanPriceIdsE = rows
        .filter((x) => kindById.get(x.price.productId) === "plan")
        .map((x) => x.price.id);
      let outgoingPlanChargedE = true;
      if (prorate_ && reratedByItemId.size > 0 && outgoingPlanPriceIdsE.length > 0) {
        const checksE = await Promise.all(
          outgoingPlanPriceIdsE.map((id) => basisWasEverCharged(tx, sub.id, id)),
        );
        outgoingPlanChargedE = checksE.some(Boolean);
      }
      for (const [itemId, raw] of reratedByItemId) {
        if (!prorate_) break;
        const r = rows.find((x) => x.item.id === itemId);
        if (!r || changedByItemIdForLines.has(itemId)) continue;
        const before = (r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price);
        const after = alignSnapshotToCycle(raw, postCycle);
        const qty = r.item.quantity;
        const { creditMinor, chargeMinor } = nonResetItemProration({
          oldSnapshotType: before.type,
          newSnapshotType: after.type,
          oldFullMinor: outgoingPlanChargedE
            ? fixedChargeMinor(before, ratableFromSnapshot(before, r.item.freeQuantity), qty)
            : 0n,
          newFullMinor: fixedChargeMinor(
            after,
            ratableFromSnapshot(after, r.item.freeQuantity),
            qty,
          ),
          billingCycles: r.item.billingCycles,
          cyclesBilled: r.item.cyclesBilled,
          now: prorationNow,
          periodStart: requireTerm(sub).start,
          periodEnd: requireTerm(sub).end,
        });
        const netCredit = creditMinor - (await clawback(r.price.id, prorationNow));
        if (netCredit > 0n) {
          creditedPriceIds.add(r.price.id);
          pushLine(
            {
              description: `Unused time on ${await labelFor(r.price)} ×${qty}`,
              amount_minor: -Number(netCredit),
            },
            r.price,
          );
        }
        if (chargeMinor > 0n)
          pushLine(
            {
              description: `Remaining time on ${await labelFor(r.price)} ×${qty}`,
              amount_minor: Number(chargeMinor),
            },
            r.price,
          );
      }
      // Adds and removes, prorated from the ITEM window (see itemWindowStart above).
      // Mirrors addSubscriptionItem / removeSubscriptionItem exactly, including the
      // consequence that a same-day add-then-remove nets to zero.
      for (const a of addResolved) {
        // A ONE-TIME price is not prorated by `addSubscriptionItem` — it buys no span
        // of time, so the whole fee is due (bug fixed 2026-08-03, items.ts). Mirrored
        // here, label included, or the preview under-quotes exactly the amount the
        // booking will charge: a 5000 one-off added mid-month previewed 2500.
        const full = fixedChargeMinor(a.snapshot, ratableFromSnapshot(a.snapshot, null), a.qty);
        const isOneTime = a.snapshot.type === "one_time";
        const charge = isOneTime
          ? full
          : prorate(full, itemWindowStart, requireTerm(sub).start, requireTerm(sub).end);
        if (charge > 0n) {
          pushLine(
            {
              description: isOneTime
                ? `${priceLabel(a.price)} ×${a.qty}`
                : `${priceLabel(a.price)} - Prorated Charges ×${a.qty}`,
              amount_minor: Number(charge),
            },
            a.price,
          );
        }
      }
      for (const r of removedRows) {
        // A ONE-TIME item is credited NOTHING on removal, billed or not (bug,
        // 2026-08-03, `removeSubscriptionItem`/items.ts) — it bought no span of time,
        // so there is no unused remainder to hand back; an invoiced one-off fee is
        // refunded only by an explicit credit note, not by detaching the item.
        // Unconditional on `cyclesBilled`, mirroring the booking exactly.
        const snapType = (r.item.priceSnapshot as PriceSnapshot | null)?.type ?? r.price.type;
        if (snapType === "one_time") continue;
        const ratable = r.item.priceSnapshot
          ? ratableFromSnapshot(r.item.priceSnapshot as PriceSnapshot, r.item.freeQuantity)
          : null;
        if (!ratable) continue;
        const credit = prorate(
          fixedChargeMinor(r.item.priceSnapshot as PriceSnapshot, ratable, r.item.quantity),
          itemWindowStart,
          requireTerm(sub).start,
          requireTerm(sub).end,
        );
        // The booking hands the unused remainder back ONCE: the part still sitting as a
        // pending deferred charge is cancelled rather than credited (money bug,
        // 2026-08-24 — see planRemovedItemUnbilledSettlements). Netted here too, or the
        // preview quotes a credit the booking will not issue, which is exactly the
        // divergence this function exists to prevent.
        const netCredit = credit - (await clawback(r.price.id, itemWindowStart));
        if (netCredit > 0n) {
          creditedPriceIds.add(r.price.id);
          pushLine(
            {
              description: `${r.price.publicId} — prorated credit for unused time`,
              amount_minor: -Number(netCredit),
            },
            r.price,
          );
        }
      }
    } else {
      // TERM RESET preview: credit unused time on ALL current items, then charge
      // the FULL new-term price for every post-change item (mirrors changeSubscription).
      //
      // The credit is previewed ONLY when this term was actually invoiced.
      // `changeSubscription` DROPS the reset credit outright on a never-billed
      // subscription — no money was ever taken for that term, so there is nothing to
      // hand back and crediting it would invent money (`proration.ts`, the
      // `resetCreditDropped` branch). Previewing a credit the booking then discards is
      // precisely the divergence this function's header warns about, and it reaches
      // the customer as a discount the change-plan screen promises and the invoice
      // never gives.
      const [everBilled] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.subscriptionId, sub.id)))
        .limit(1);
      if (everBilled) {
        // ── A CREDIT NOTE MAY NOT EXCEED WHAT THE TERM CAN GIVE BACK (F-40, 2026-08-26) ──
        // These lines do NOT net inside an invoice: on apply, `issueCurrentTermCredit` turns
        // them into a CREDIT NOTE, and a credit note is bounded by what the term's invoices
        // can still fund. This gated only on WHETHER the subscription was ever billed, never
        // on how much of that invoice survives — so after a partial refund it previewed the
        // whole old term while the booking, which asks `refundableCapacityForInvoice`,
        // credited only the remainder.
        //
        // Scoped to the RESET branch deliberately. The non-reset branch's negative lines fold
        // into the SAME invoice as the charge that offsets them, so they need no refund
        // capacity at all — capping those broke `estimates` and `trial-change`, which is the
        // signal that the two credit shapes are not interchangeable.
        //
        // Same capacity formula as `creditAcrossInvoices`: due (open invoices only) +
        // CREDITABLE headroom + bucket-funded slices an invoice settled with the customer's
        // own credit can still return.
        //
        // ⚠ CREDITABLE, NOT REFUNDABLE — and this line was wrong until 2026-08-31 while the
        // comment above it asserted the equality it was breaking. The two capacity functions
        // differ on ALLOCATED credit, and the difference is not cosmetic:
        //
        //   refundableCapacityForInvoice   subtracts each note's OUTSTANDING claim
        //                                  (total − allocated − refunded)  — the CASH question
        //   creditableCapacityForInvoice   subtracts EVERY non-voided note's FULL total
        //                                  — the CREDIT question
        //
        // so `creditable.available <= refundable.available` always, and this cap was reading
        // the WIDER figure while the booking (`creditAcrossInvoices`) asks the narrower one.
        // `granted = min(wanted, termCapacity)` then granted more than the booking can place:
        // the preview over-quotes the credit, the same customer-facing direction as the
        // debt-relief defect above.
        //
        // The shape that binds is the one measured 2026-08-28: an invoice already credited in
        // FULL whose note was ALLOCATED to a later invoice reports its entire value as still
        // available, because an allocated note contributes nothing to the outstanding claim —
        // INV-3288 reporting ₹57,012.88 available after CN-564 had credited it in full.
        //
        // ⚠ DO NOT "fix" this by widening `creditableCapacityForInvoice` or narrowing
        // `refundableCapacityForInvoice`. The cash rule is deliberate and correct: counting a
        // note's whole total made an invoice's cash permanently unreachable, blocking a
        // payout of exactly the amount we could not reach. Two questions, two functions;
        // this call site was simply asking the wrong one.
        const { creditableCapacityForInvoice, remainingCreditableAgainstInvoice } =
          await import("@/modules/credit-notes/service");
        const { isOpenInvoiceStatus } = await import("@/modules/invoicing/status");
        const termInvoices = (
          await tx
            .select()
            .from(invoices)
            .where(and(eq(invoices.businessId, businessId), eq(invoices.subscriptionId, sub.id)))
        ).filter((r) => !["voided", "pending"].includes(r.status) && r.totalMinor > 0n);
        let termCapacity = 0n;
        for (const ti of termInvoices) {
          const { available } = await creditableCapacityForInvoice(tx, ti.id);
          // Live outstanding, as the booking's `invoiceOutstandingDue`: the stored column never
          // has cash taken off, and `available` already holds that cash.
          const due = isOpenInvoiceStatus(ti.status)
            ? (await invoiceOutstanding(tx, ti)).remainingMinor
            : 0n;
          const room = (due > 0n ? due : 0n) + (available > 0n ? available : 0n);
          const recycled =
            (ti.promotionalCreditsAppliedMinor ?? 0n) +
            (ti.excessPaymentsAppliedMinor ?? 0n) +
            (ti.refundableCreditsAppliedMinor ?? 0n);
          // ── AND THE SAME CEILING (M1, 2026-09-01) ─────────────────────────────
          // A term-wide gate built on the same `room + recycled` as the allocator has
          // to carry the same clamp, or it grants a reset credit the allocator will not
          // place. See `remainingCreditableAgainstInvoice`.
          const ceiling = await remainingCreditableAgainstInvoice(tx, ti);
          termCapacity += room + recycled < ceiling ? room + recycled : ceiling;
        }
        const resetCredits: Array<{ description: string; amount: bigint }> = [];
        for (const r of rows) {
          // A ONE-TIME item has NO unused time (bug, 2026-08-03, `proration.ts`'s reset
          // branch) — it bought no span of time, so there is nothing to hand back.
          // Unconditional on `cyclesBilled`: an already-paid fee isn't unused time, and
          // a never-billed one has nothing paid to credit (the charge loop below is
          // where the never-billed case is settled, in full).
          const oldSnap = r.item.priceSnapshot as PriceSnapshot | null;
          if ((oldSnap?.type ?? r.price.type) === "one_time") continue;
          const oldRatable = ratableForItem(r.item, r.price);
          // Reset credits the unused OLD term from resetStart (same as changeSubscription):
          // a same-day swap credits the full old term (0 days used).
          const creditUnused = prorate_
            ? prorate(
                fixedChargeMinor(oldSnap ?? r.price, oldRatable, r.item.quantity),
                resetStart,
                requireTerm(sub).start,
                requireTerm(sub).end,
              )
            : 0n;
          // Same netting as the non-reset branch, on the reset's own boundary — the
          // booking cancels a removed item's still-queued deferred charge instead of
          // crediting that span twice.
          const touched =
            removedItemIds.has(r.item.id) || resolved.some((x) => x.current.item.id === r.item.id);
          const netCreditUnused = touched
            ? creditUnused - (await clawback(r.price.id, resetStart))
            : creditUnused;
          if (netCreditUnused > 0n)
            resetCredits.push({
              description: `Unused time on ${await labelFor(r.price)} ×${r.item.quantity}`,
              amount: netCreditUnused,
            });
        }
        // Largest-remainder scale-down, so the lines still sum to exactly what is granted —
        // the same discipline the booking's allocator uses to split across invoices.
        const wanted = resetCredits.reduce((s, c) => s + c.amount, 0n);
        const granted = wanted > termCapacity ? (termCapacity > 0n ? termCapacity : 0n) : wanted;
        let amounts: bigint[];
        if (granted === wanted || wanted <= 0n) {
          amounts = resetCredits.map((c) => c.amount);
        } else {
          amounts = resetCredits.map((c) => (c.amount * granted) / wanted);
          let leftover = granted - amounts.reduce((s, v) => s + v, 0n);
          const order = resetCredits
            .map((c, k) => ({ k, rem: c.amount * granted - amounts[k]! * wanted }))
            .sort((a, b) => (a.rem === b.rem ? a.k - b.k : a.rem > b.rem ? -1 : 1));
          for (const o of order) {
            if (leftover <= 0n) break;
            amounts[o.k] = amounts[o.k]! + 1n;
            leftover -= 1n;
          }
        }
        resetCredits.forEach((c, k) => {
          const amt = amounts[k] ?? 0n;
          if (amt > 0n) pushLine({ description: c.description, amount_minor: -Number(amt) });
        });
      }
      const changedByItemId = new Map(resolved.map((r) => [r.current.item.id, r]));
      for (const r of rows) {
        // A removed item's unused OLD term is credited above, but it must not be
        // charged for the new one — it will not exist in the post-change composition.
        if (removedItemIds.has(r.item.id)) continue;
        const chg = changedByItemId.get(r.item.id);
        const priceForCharge = chg ? chg.newPrice : r.price;
        const qtyForCharge = chg ? chg.newQty : r.item.quantity;
        const reratedRaw = reratedByItemId.get(r.item.id);
        const baseSnapshot = chg
          ? chg.newSnapshot
          : ((r.item.priceSnapshot as PriceSnapshot | null) ?? snapshotPrice(r.price));
        // Annualise onto the new cycle, exactly as `changeSubscription` now books it —
        // a monthly add-on on a yearly term costs 12× its monthly price. This mirror is
        // not optional: without it the preview quoted $650 where the apply charged $1,200
        // on a $50→$600/yr swap carrying ten $5/month seats. `verify:estimates` asserts
        // estimate == booking but had no cadence-change case, so the drift was invisible.
        // A re-rated item takes `alignSnapshotToCycle` on the FRESH differential and skips
        // the realign below — `realign` re-expresses a snapshot already folded against the
        // OLD cycle, so putting a fresh resolve through it scales twice and mis-rates a
        // cadence change. This is the trap PROGRESS :173 records for exactly this work.
        const snapshotForCharge = reratedRaw
          ? alignSnapshotToCycle(reratedRaw, {
              interval: newInterval as string,
              intervalCount: newIntervalCount,
            })
          : baseSnapshot.type === "recurring"
            ? realignSnapshotToCycle(baseSnapshot, {
                interval: newInterval as string,
                intervalCount: newIntervalCount,
              })
            : baseSnapshot;
        // A ONE-TIME item is charged ONCE, EVER (bug, 2026-08-03) — a reset term is a
        // whole new term for a RECURRING item, but a one-time fee doesn't belong to a
        // term at all. Gate on the SHARED cap rule (not the price type alone): a fee
        // attached but not yet billed is still legitimately owed in full by this reset.
        const isOneTime = snapshotForCharge.type === "one_time";
        if (
          isOneTime &&
          isCycleCapExhausted(r.item.billingCycles, snapshotForCharge.type, r.item.cyclesBilled)
        )
          continue;
        const fullNewTerm = fixedChargeMinor(
          snapshotForCharge,
          ratableFromSnapshot(snapshotForCharge, r.item.freeQuantity),
          qtyForCharge,
        );
        if (fullNewTerm > 0n)
          pushLine(
            {
              description: `${priceForCharge.publicId} ×${qtyForCharge} (new term)`,
              amount_minor: Number(fullNewTerm),
            },
            priceForCharge,
          );
      }
      // An added item joins the reset term at its full price — the new term starts
      // today, so prorating it from the item window would yield the same number.
      for (const a of addResolved) {
        const fullNewTerm = fixedChargeMinor(
          a.snapshot,
          ratableFromSnapshot(a.snapshot, null),
          a.qty,
        );
        if (fullNewTerm > 0n)
          pushLine(
            {
              description: `${priceLabel(a.price)} ×${a.qty} (new term)`,
              amount_minor: Number(fullNewTerm),
            },
            a.price,
          );
      }
    }

    const net = lines.reduce((s, l) => s + BigInt(l.amount_minor), 0n);
    // TAX THE CHARGES, NOT THE NET. The negative lines here are unused-time credits,
    // and on apply they do NOT land on the invoice — `issueCurrentTermCredit` turns them
    // into a CREDIT NOTE that reverses its own booked tax, and `createInvoiceFromLines`
    // refuses a negative subtotal outright, so the shape this used to preview cannot even
    // exist as an invoice. Netting first therefore under-quoted the tax the INVOICE
    // charges whenever the credit only PARTLY offset it: charges 9118 against a 5000
    // credit quoted 18% of 4118 (741) where the invoice charges 18% of 9118 (1641) and
    // applies the credit post-tax.
    //
    // ⚠ THAT IS A CLAIM ABOUT `tax_minor` ONLY, AND IT COST US ONCE ALREADY. The version
    // of this note that shipped with the gross tax base also asserted "`total` still nets,
    // so `amount_due` is unchanged and correct — only the tax base moves". It did not:
    // `total` was `net + tax`, and moving `tax` from the net base to the gross one pushed
    // `total` up by exactly the CREDIT's tax, on every credited change. Measured 2026-08-30
    // on an imported INR sub, add-on qty 60 → 59 at ₹752 (GST 18%, factor 1.0): charges
    // 44368, credit 45120, quoted `total` 7234.24 "chargeable immediately" for a DOWNGRADE
    // that owes ₹887.36 back. 7234.24 − 8121.60 (the credit's tax) = −887.36.
    //
    // So the two sides are now measured on their own gross bases and `total` is the
    // DIFFERENCE OF THE TWO DOCUMENTS, never a lone subtotal plus a lone tax:
    //
    //     total = (invoice: chargeBase − promo + chargeTax) − (credit note: creditBase + creditTax)
    //
    // which also happens to be exactly right for `fallbackCreditLines` (proration.ts) —
    // the shape the old note flagged as over-quoted. There the credit really is booked as
    // negative invoice lines and really does reduce the base, and for a flat rate r
    // `r·chargeBase − r·creditBase = r·net`, so this formula collapses onto that invoice's
    // own total with no special case. A component vector (CGST+SGST) can round the two
    // sides apart by a minor unit or two; that is the whole remaining error, and it is
    // smaller than the one the special case would introduce.
    //
    // `tax_minor` / `tax_lines` keep their documented meaning throughout: the rows the
    // INVOICE will print. The credit note's own face value is `credit_note_total_minor`,
    // so a caller that needs the second document has both.
    const chargeBase = lines.reduce(
      (s, l) => (l.amount_minor > 0 ? s + BigInt(l.amount_minor) : s),
      0n,
    );

    // ── COUPONS AND MANUAL DISCOUNTS APPLY TO A PRORATION. THIS DID NOT PRICE THEM. ──
    // The apply does: the proration invoice resolves the subscription's live discount
    // stack, and `creditOneInvoice` scales the credit note by the discount its SOURCE
    // invoice booked. The estimate priced neither, so a discounted subscription was
    // quoted the list-price proration. Measured 2026-08-30, a 10%-coupon subscription
    // dropping an add-on 10 → 6 under 18% GST:
    //
    //   estimate  invoice 708000  note 1180000  → total −472000
    //   apply     invoice 637200  note 1062000  → net   −424800     (both ×0.9)
    //
    // Both sides are discounted because both documents are. The CREDIT side takes the
    // STORED stack only — it reverses time billed under the discounts that were live
    // then, which a coupon being added today was not.
    const toDiscountLines = (want: (amount: number) => boolean): DiscountLine[] => {
      const out: DiscountLine[] = [];
      lines.forEach((l, i) => {
        if (!want(l.amount_minor)) return;
        out.push({
          index: out.length,
          amountMinor: BigInt(Math.abs(l.amount_minor)),
          productKind: lineProducts[i]?.kind ?? null,
          productPublicId: lineProducts[i]?.publicId ?? null,
          pricePublicId: lineProducts[i]?.pricePublicId ?? null,
        });
      });
      return out;
    };
    /**
     * A PENDING DISCOUNT DOES DISCOUNT THIS PRORATION — because `changeSubscription` now
     * applies it inside its own transaction, before the proration invoice is raised.
     *
     * That ordering is not a preference: the new BUSINESS charge must be discounted 10%,
     * because the coupon is active by the time the change invoice is raised.
     *
     * An earlier cut of this previewed the pending discount on the RENEWAL only, because
     * the dashboard then posted `/discount` AFTER `/change` and the proration really was
     * billed at list price. The preview was right about the booking and the booking was
     * wrong; both are fixed together, or this function starts lying again.
     */
    const pendingDiscount =
      input.couponCodes?.length || input.manualDiscount || input.removeDiscount || dropCodes.length
        ? {
            organizationId,
            businessId,
            now: input.now,
            ...(input.couponCodes?.length ? { codes: input.couponCodes } : {}),
            ...(input.manualDiscount ? { manual: input.manualDiscount } : {}),
            ...(input.removeDiscount ? { removeActive: true } : {}),
            ...(dropCodes.length ? { dropCodes } : {}),
          }
        : undefined;
    // Up front, not inside the peeks: a change with no charge and no renewal quote never
    // prices the codes, and must still refuse one the apply would.
    if (input.couponCodes?.length) {
      await refusePendingCouponCodes(tx, {
        organizationId,
        businessId,
        codes: input.couponCodes,
        now: input.now,
        customerId: sub.customerId,
      });
    }
    const chargeDiscount =
      chargeBase > 0n
        ? await peekDiscounts(
            tx,
            sub.id,
            toDiscountLines((a) => a > 0),
            sub.currency,
            pendingDiscount,
          )
        : null;
    const discountMinor = chargeDiscount?.totalMinor ?? 0n;
    const charges = lines.flatMap((l, i) =>
      l.amount_minor > 0 ? [{ amount: BigInt(l.amount_minor), taxable: lineTaxable[i]! }] : [],
    );
    const discountedChargeBase = chargeBase - discountMinor > 0n ? chargeBase - discountMinor : 0n;
    // …AND THE PROMOTIONAL SLICE COMES OFF THAT BASE BEFORE IT IS TAXED — but it can only
    // be priced once the CREDIT this change issues has been routed, because part of the
    // promotional credit it draws is released BY that credit. So `promoCap`, `promotional`,
    // `tax` and `invoiceTotal` are computed below, immediately after `routed`; see the
    // block headed "THE PROMOTIONAL SLICE, PRICED AFTER THE CREDIT IT COMES OUT OF".
    // Nothing between here and there reads them (checked symbol by symbol), so the move is
    // a reordering and not a change of meaning.
    //
    // THE CREDIT SIDE, taxed the same way. `chargeBase` deliberately ignores negative
    // lines; this is their mirror, so a caller can quote the refund instead of inferring
    // it. Same `estimateTax` resolver as the charges — a credit reverses the tax that was
    // charged, so it must be measured on the same rates and the same place of supply.
    const rawCreditBase = lines.reduce(
      (s2, l) => (l.amount_minor < 0 ? s2 - BigInt(l.amount_minor) : s2),
      0n,
    );

    // ── WHAT THE CREDIT NOTE IS ACTUALLY WORTH ──────────────────────────────────
    // The credit LINES are in list-price units. `creditOneInvoice` converts them to a
    // real credit note with the exact expression documented on `termInvoiceCanAbsorb`:
    //
    //     gross = preTax × inv.total / listBase        listBase = (inv.total − tax) + discount
    //
    // and that one ratio carries BOTH the tax the note reverses and the discount the
    // source invoice booked — which is why it is used here instead of re-deriving each.
    //
    // ⚠ IT MUST BE THE SOURCE INVOICE'S BOOKED DISCOUNT, NOT THE CURRENT ONE. The first
    // cut of this asked `peekDiscounts` for the subscription's live stack, which is right
    // only when the discount predates the term invoice — and every test I had built it
    // that way, so it passed. A coupon applied AFTER the term is billed caught it on its
    // first live run: we shrank the note to 53730 where our own apply keeps it at 59700 —
    // full credit for the undiscounted term. The customer really did pay the undiscounted
    // amount; the refund owes them all of it.
    const creditRatio =
      rawCreditBase > 0n
        ? await (async () => {
            const {
              refundableCapacityForInvoice,
              creditableCapacityForInvoice,
              remainingCreditableAgainstInvoice,
            } = await import("@/modules/credit-notes/service");
            const { isOpenInvoiceStatus } = await import("@/modules/invoicing/status");
            const { splitCreditByFunding, promoRestoredForInvoice } =
              await import("./cancellation-credit");
            // The same target set `issueCurrentTermCredit` credits against.
            // ORDERED, and it must stay ordered: `distributeCreditAcrossInvoices` places the
            // credit NEWEST FIRST, so the preview and the booking only agree while both read
            // the invoices in the same order. Until 2026-09-02 this select had none — the
            // booking sorted (`proration.ts`) and the preview took Postgres row order, which
            // was harmless only while the allocator was proportional and therefore
            // order-independent. In the query rather than a post-hoc sort, so the guarantee
            // lives where the rows come from.
            const live = await tx
              .select()
              .from(invoices)
              .where(eq(invoices.subscriptionId, sub.id))
              .orderBy(asc(invoices.createdAt));
            const term = live.filter(
              (r) => !["voided", "pending"].includes(r.status) && r.totalMinor > 0n,
            );
            if (term.length === 0) return null;
            // ── AND *WHICH* OF THEM (2026-09-01) ─────────────────────────────────────
            // This used to take the whole term. `issueCurrentTermCredit` does not: given
            // `targetPriceIds` it books against `invoicesChargingPrices` — the invoices
            // that actually charged the credited prices, each weighted by what IT billed
            // for them — and only a term reset (`wholeTerm`) spreads over every invoice.
            //
            // Not a presentation detail, because the gross-up below is PER INVOICE. Two
            // sides distributing one pre-tax credit over different invoice sets gross it
            // on different ledgers and reach different totals. Measured on
            // `probe-estimate-vs-booked-change-chain` step 3 (PRO → LITE): the booking
            // credited ONE invoice for the full ₹32,943.24 while the preview spread the
            // same ₹27,918 base over three and quoted ₹32,943.23.
            //
            // `creditedPriceIds` is empty on a term reset — the reset branch emits its
            // credit lines without registering a price, precisely so this falls through
            // to the whole term, which is what `wholeTerm: true` credits. It is also
            // empty when nothing was credited at all, and the fallthrough is then
            // `issueCurrentTermCredit`'s own ("nothing on this term ever charged these
            // prices … fall through to the term default").
            //
            // `base` mirrors `invoicesChargingPrices` exactly: the NET of that invoice's
            // lines for those prices, negatives included, requiring at least one positive
            // line — a quantity upgrade bills +20000 beside a −500 unused-time line on one
            // document, and 19500 is what it collected and what it can fund.
            const chargedBase = new Map<string, bigint>();
            if (creditedPriceIds.size > 0) {
              for (const inv of term) {
                const rawLines = await tx
                  .select()
                  .from(invoiceLineItems)
                  .where(eq(invoiceLineItems.invoiceId, inv.id));
                const mine = rawLines.filter(
                  (l) =>
                    l.priceId != null &&
                    creditedPriceIds.has(l.priceId) &&
                    !["tax", "discount", "rounding"].includes(l.kind ?? ""),
                );
                if (mine.length === 0) continue;
                const base = mine.reduce((sum, l) => sum + l.amountMinor, 0n);
                if (base <= 0n || !mine.some((l) => l.amountMinor > 0n)) continue;
                chargedBase.set(inv.id, base);
              }
            }
            const targeted = chargedBase.size > 0;
            const eligible = targeted ? term.filter((r) => chargedBase.has(r.id)) : term;
            if (eligible.length === 0) return null;
            let totalSum = 0n;
            let listSum = 0n;
            // DEBT THIS CREDIT WILL RELIEVE BEFORE ANY OF IT REACHES THE BALANCE.
            // `creditOneInvoice` takes its OPEN branch whenever `invoiceOutstanding` is
            // positive: it raises an ADJUSTMENT note for what the customer still owes and
            // only the overflow becomes refundable. Summed over the same invoices the ratio
            // is taken across, because those are the ones being credited.
            // Everything the pure router needs, per invoice, gathered in the ONE pass that
            // already reads each invoice's ledger. `creditable…` answers "is this invoice's
            // value already spent" (the credit question, what `creditAcrossInvoices` asks)
            // and `refundable…` answers "is this money still a claim on cash" (the payout
            // question, what the cashable leg caps against) — deliberately two functions.
            const parts: Array<{ id: string; baseMinor: bigint; capacityMinor: bigint }> = [];
            const routingInputs = new Map<
              string,
              {
                invTotal: bigint;
                bookedTax: bigint;
                /**
                 * Everything the gross-up needs, in the ONE shape `proration.ts` defines —
                 * so the preview cannot hold a different idea of what an invoice is worth
                 * than the booking does (2026-09-01).
                 */
                basis: InvoiceCreditBasis;
                due: bigint;
                promoApplied: bigint;
                excessApplied: bigint;
                refundableApplied: bigint;
                cashAvailable: bigint;
                promoRestored: bigint;
                /** Credit grants drawn (G3), and what the invoice has not given back yet. */
                grantPre: bigint;
                grantPost: bigint;
                grantOutstanding: bigint;
                open: boolean;
              }
            >();
            for (const inv of eligible) {
              const entries = await tx
                .select()
                .from(ledgerEntries)
                .where(
                  and(
                    eq(ledgerEntries.sourceType, "invoice"),
                    eq(ledgerEntries.sourceId, inv.publicId),
                  ),
                );
              const signed = (account: string, positive: "debit" | "credit") =>
                entries
                  .filter((e) => e.account === account)
                  .reduce(
                    (acc, e) => acc + (e.direction === positive ? e.amountMinor : -e.amountMinor),
                    0n,
                  );
              const listBase =
                inv.totalMinor - signed("tax_payable", "credit") + signed("discounts", "debit");
              if (listBase <= 0n) continue;
              totalSum += inv.totalMinor;
              listSum += listBase;
              const due = (await invoiceOutstanding(tx, inv)).remainingMinor;
              const promoApplied = inv.promotionalCreditsAppliedMinor ?? 0n;
              const excessApplied = inv.excessPaymentsAppliedMinor ?? 0n;
              const refundableApplied = inv.refundableCreditsAppliedMinor ?? 0n;
              const creditable = (await creditableCapacityForInvoice(tx, inv.id)).available;
              const cash = await refundableCapacityForInvoice(tx, inv.id);
              const cashAvailable = cash.available;
              // ── NEVER PAST WHAT THE INVOICE IS WORTH (M1, 2026-09-01) ───────────
              // The identical unguarded `recycled` term `creditAcrossInvoices` carried,
              // and it has to move with it: clamping the booking alone would leave the
              // preview quoting credit the booking then refuses to place. Ceiling and
              // rationale: `remainingCreditableAgainstInvoice`.
              //
              // ── AND IN PRE-TAX UNITS, for the reason `preTaxCreditFitting` documents:
              // this capacity is compared against a share of the PRE-TAX credit, while
              // every term in it is GROSS. The booking's copy of this line had the same
              // mismatch and over-credited by the tax fraction; both are converted by the
              // one inverse so the two sides still agree invoice for invoice.
              const recycled = promoApplied + excessApplied + refundableApplied;
              const roomHere = due + (creditable > 0n ? creditable : 0n) + recycled;
              const ceiling = await remainingCreditableAgainstInvoice(tx, inv);
              const basis: InvoiceCreditBasis = {
                totalMinor: inv.totalMinor,
                bookedTaxMinor: signed("tax_payable", "credit"),
                bookedDiscountMinor: signed("discounts", "debit"),
                refundedMinor: cash.refundedMinor,
                promoAppliedMinor: promoApplied,
                open: isOpenInvoiceStatus(inv.status),
              };
              parts.push({
                id: inv.id,
                // The distribution WEIGHT — what this invoice billed for the credited
                // prices when the credit is targeted, the whole list base when it is a
                // term-wide one. Same two bases `invoicesChargingPrices` and the
                // `wholeTerm` branch hand to `creditAcrossInvoices`.
                baseMinor: chargedBase.get(inv.id) ?? listBase,
                capacityMinor: preTaxCreditFitting(roomHere < ceiling ? roomHere : ceiling, basis),
              });
              routingInputs.set(inv.id, {
                invTotal: inv.totalMinor,
                bookedTax: signed("tax_payable", "credit"),
                basis,
                due,
                promoApplied,
                excessApplied,
                refundableApplied,
                cashAvailable: cashAvailable > 0n ? cashAvailable : 0n,
                promoRestored: await promoRestoredForInvoice(tx, businessId, inv.publicId),
                grantPre: inv.grantCreditsPreTaxMinor ?? 0n,
                grantPost: inv.grantCreditsPostTaxMinor ?? 0n,
                grantOutstanding: await (
                  await import("@/modules/credits/service")
                ).grantDrawnOutstanding(tx, businessId, inv.id),
                open: isOpenInvoiceStatus(inv.status),
              });
            }
            // The human-facing label for each source invoice. Our prose names the document
            // ("An unpaid invoice #58 is present…") and a uuid cannot be reconciled against
            // anything the customer holds; `number` is the printed one, `publicId` the
            // fallback for an invoice that has not been numbered yet.
            const invoiceLabels = new Map(
              eligible.map((inv) => [inv.id, inv.number ?? inv.publicId] as const),
            );
            return listSum > 0n
              ? { totalSum, listSum, parts, routingInputs, splitCreditByFunding, invoiceLabels }
              : null;
          })()
        : null;
    // ── GROSS UP PER INVOICE, NOT ON ONE BLENDED RATIO (2026-09-01) ─────────────
    // This used to be `rawCreditBase × Σ inv.total / Σ listBase` — ONE ratio blended
    // over every eligible invoice — and then it distributed that GROSS figure. The
    // booking does the opposite order: `creditAcrossInvoices` distributes the PRE-TAX
    // list total and only then hands each share to `creditOneInvoice`, which grosses it
    // on the ledger of the invoice it belongs to (`gross = preTax × inv.total / listBase`,
    // the expression documented on `termInvoiceCanAbsorb`).
    //
    // The two are not the same number, because an invoice's booked tax is a COMPONENT
    // VECTOR, not a rate. Under India GST ₹8,814.07 of base is CGST 9% + SGST 9%, each
    // rounded half-up: 79327 + 79327 = 158654, where one blended 18% gives 158653. Blend
    // that invoice with two others whose components land exactly on .00 and its extra
    // paisa is averaged away.
    //
    // Measured on `scripts/probe-estimate-vs-booked-change-chain.ts` step 4 (LITE →
    // BUSINESS, all three plans on one term): booked note ₹10,400.61 against a quoted
    // ₹10,400.60, which propagated into `credits_applied` and left the preview asking
    // for 1 paisa of cash the booking never wanted.
    //
    // ⚠ NOT A ROUNDING MODE. Half-up on the blended ratio was tried and measured first
    // and does NOT fix it — the blended fraction is below .5, so half-up rounds it the
    // same way truncation does. The loss is the blend itself.
    //
    // `creditRatio.totalSum / listSum` survives for exactly one figure below: credit that
    // NO invoice could absorb (`unplacedMinor`). That money belongs to no ledger, so
    // there is no per-invoice ratio to gross it on and the blend is the only answer left.
    const distribution = creditRatio
      ? distributeCreditAcrossInvoices({
          totalMinor: rawCreditBase,
          parts: creditRatio.parts,
        })
      : { shares: [], unplacedMinor: 0n };
    // Each share, in the same list-price units the booking's items carry, grossed on ITS
    // OWN invoice's booked tax and discount. `parts[].baseMinor` IS that invoice's
    // `listBase` and `routingInputs[].invTotal` its `inv.total_minor`, both already read
    // from the one ledger pass above — so this re-derives nothing.
    // Each share, in the same list-price units the booking's items carry, grossed on ITS
    // OWN invoice's ledger by the ONE function the booking grosses with —
    // `grossCreditOnInvoice`, which is `creditOneInvoice`'s three rounded steps extracted so
    // that preview and booking cannot hold two versions of them. This file carried its own
    // copy for a day (2026-09-01) and it was already the second copy of the arithmetic; the
    // third would have been `preTaxCreditFitting`'s inverse, which is what forced the
    // extraction.
    const grossShares: Array<{ id: string; shareMinor: bigint }> = creditRatio
      ? distribution.shares.map((s) => {
          const r = creditRatio.routingInputs.get(s.id);
          return r ? { id: s.id, shareMinor: grossCreditOnInvoice(s.shareMinor, r.basis) } : s;
        })
      : [];
    const creditNoteTotal = creditRatio
      ? grossShares.reduce((s2, g) => s2 + g.shareMinor, 0n)
      : rawCreditBase > 0n
        ? await (async () => {
            // NO ELIGIBLE SOURCE INVOICE — an unbilled term. `issueCurrentTermCredit`
            // credits nothing and the apply falls to `fallbackCreditLines`, which books
            // the credit as NEGATIVE INVOICE LINES. So the credit still reduces what is
            // owed; it is simply not a separate document.
            //
            // ⚠ This branch returned 0n for one commit and `verify:estimates` caught it
            // immediately: the plan-swap case quoted 3000 against a booking of 2000,
            // because the whole 1000 credit vanished from the total. On that path the
            // invoice's tax is charged on the NET, so the figure that has to come off is
            // the credit plus the tax it removes from the base — which is what this is.
            const [cus] = await tx
              .select()
              .from(customers)
              .where(eq(customers.id, sub.customerId))
              .limit(1);
            const credits = lines.flatMap((l, i) =>
              l.amount_minor < 0
                ? [{ amount: BigInt(-l.amount_minor), taxable: lineTaxable[i]! }]
                : [],
            );
            const t = await estimateTax(
              organizationId,
              businessId,
              cus,
              rawCreditBase,
              taxedLineAmounts(
                credits.map((c) => c.amount),
                undefined,
                credits.map((c) => c.taxable),
              ),
            );
            return rawCreditBase + t.taxMinor;
          })()
        : 0n;

    // ── THE CREDIT PAYS OFF DEBT BEFORE IT REACHES THE BALANCE (2026-08-31) ──────
    // This used to be `invoiceTotal - creditNoteTotal`, which modelled the whole note as
    // available to offset the NEW invoice. It is not: `creditOneInvoice` spends it on the
    // OLD invoice's outstanding first, as an adjustment note, and only the overflow carries
    // forward. On an unpaid term every such unit was therefore promised TWICE — once as
    // relief on the old invoice (where it really goes) and once as balance credit here.
    //
    // Measured on the buyer-facing checkout, 2026-08-31: it quoted "₹17,010.12 credited to
    // your balance" where the apply credited ₹0 and still wanted ₹5,088.01, because
    // ₹22,098.13 of the credit was owed on the open invoice.
    //
    // ⚠ NOT A CHANGE TO `credit_note_total_minor`. The note really is worth the whole
    // unused term — the customer is not getting less, they are getting it as debt relief
    // instead of balance. So the note stays whole and the DESTINATION is reported: the
    // relieved slice as its own field, the remainder against this invoice. That is also why
    // the net-cash identity `total == invoice − Σ notes` could not see the defect, and why
    // `verify-estimates` § 11 asserts the customer's bucket instead.
    //
    // WHAT IS AND IS NOT BYTE-IDENTICAL — checked, because the first draft of this comment
    // claimed "every paid term is unaffected" and that is not true.
    //
    // A CASH-paid invoice is unaffected: `splitCreditByFunding` returns promotional 0 and
    // excess 0, so `cashable` is the whole note clamped to cash still retained, which for an
    // unrefunded invoice exceeds the note. Every figure in `verify-estimates` § 8/§ 9 and
    // `verify-checkout` is therefore unmoved, and measured to be (228/0, 338/0).
    //
    // A PROMO- or EXCESS-funded PAID invoice DOES move: `cashable < note`, so
    // `refundable_credit_added_minor` drops by the bucket-funded slice. That is the fix, not
    // a regression — those slices go back to the bucket they came from and were never
    // spendable as refundable credit — but it is a deliberate behaviour change and NO test
    // covers that shape today, which is why it is written down here rather than implied.
    // (The lesson is borrowed: `lockInvoiceCredit`'s docblock asserted that `proration.ts`
    // took `lockCustomerBalances` first, `proration.ts` never took it at all, and a real
    // money bug survived review because readers trusted the paragraph. A load-bearing
    // comment is a claim to verify, including this one.)
    //
    // WHERE THE CREDIT ACTUALLY GOES, from the one pure module `proration.ts` books from.
    // The overflow past a term invoice's debt has FOUR destinations and only ONE of them is
    // refundable credit:
    //
    //   adjustment note against the open invoice   → the debt is CANCELLED, not refunded
    //   promotional / excess bucket restore        → back to the bucket it came from, and
    //                                                spendable only as a bucket balance
    //   cashable refundable note                   → THIS is refundable credit added
    //   stranded / unplaced                        → reaches nobody at all
    //
    // Predicting that here by hand is what produced the ₹17,010.12 of balance credit a
    // change could not deliver, and then — after subtracting the debt — still over-quoted by
    // the bucket restores, which is the COMMON case (the excess leg needs nothing more than
    // `excess_payments_applied_minor > 0`). So the arithmetic is not re-derived: distribution
    // and split both come from `credit-routing.ts`, and this file supplies only the row
    // reads that a pure function cannot do.
    //
    // OPEN vs PAID must take different routers. An open invoice's credit is an ADJUSTMENT
    // first; a paid one has no debt, and its promotional slice is found by
    // `splitCreditByFunding`'s pro-rata rule rather than by the overflow-past-the-taxed-base
    // rule. Handing a paid invoice to the open router would report `freedPromo = 0` (it
    // requires `outstanding > 0`) and count the promo slice as CASHABLE — over-quoting
    // refundable credit on exactly the promo-funded invoice that CN-188 documents.
    // The distribution is held rather than consumed inline: its `unplacedMinor` is the one
    // stranding leg NO caller can see (the routing's own `strandedMinor` is the other), and
    // dropping it here is what made `credit_note_total_minor` unaccountable — a note that
    // renders with an unnamed remainder. It is computed ABOVE now, because the gross-up
    // reads its shares (2026-09-01) — the router still consumes the GROSSED share, which is
    // what `grossShares` carries.
    //
    // Kept PER INVOICE, then totalled — the total alone cannot say WHICH document an
    // adjustment landed on, and our prose names it ("An unpaid invoice #58 is present…").
    const perShare: Array<{ id: string; routing: InvoiceCreditRouting }> = creditRatio
      ? grossShares.map((share) => ({
          id: share.id,
          routing: ((): InvoiceCreditRouting => {
            const r = creditRatio.routingInputs.get(share.id);
            if (!r)
              return routingFromFundingSplit(0n, { promotional: 0n, excess: 0n, refundable: 0n });
            if (!r.open) {
              return routingFromFundingSplit(
                share.shareMinor,
                creditRatio.splitCreditByFunding({
                  creditMinor: share.shareMinor,
                  baseMinor: r.invTotal,
                  invoice: {
                    promotionalCreditsAppliedMinor: r.promoApplied,
                    excessPaymentsAppliedMinor: r.excessApplied,
                    refundableCreditsAppliedMinor: r.refundableApplied,
                    grantCreditsPreTaxMinor: r.grantPre,
                    grantCreditsPostTaxMinor: r.grantPost,
                  },
                  cashAvailable: r.cashAvailable,
                  promoAlreadyRestoredMinor: r.promoRestored,
                  grantOutstandingMinor: r.grantOutstanding,
                }),
              );
            }
            // The share arrives tax-INCLUSIVE (the ratio grossed it up by this invoice's
            // booked tax). The router's promo rule measures the pre-tax gross against the
            // taxed base, so back that same gross-up out — the exact inverse, so the two
            // sides cannot drift on the rounding.
            const netBase = r.invTotal - r.bookedTax;
            const preTax =
              r.invTotal > 0n ? (share.shareMinor * netBase) / r.invTotal : share.shareMinor;
            return planOpenInvoiceCreditRouting({
              creditMinor: share.shareMinor,
              outstandingMinor: r.due,
              discountedTotalMinor: preTax,
              taxedBaseMinor: netBase - r.promoApplied,
              promoAppliedMinor: r.promoApplied,
              excessAppliedMinor: r.excessApplied,
              refundableAppliedMinor: r.refundableApplied,
              cashAvailableMinor: r.cashAvailable,
            });
          })(),
        }))
      : [];
    const routed: InvoiceCreditRouting = creditRatio
      ? totalRouting(perShare.map((p) => p.routing))
      : {
          // No eligible source invoice: the apply falls to `fallbackCreditLines`, which books
          // the credit as NEGATIVE INVOICE LINES on this very invoice. Nothing is adjusted and
          // nothing lands on a balance — the whole credit offsets the charge, which is what
          // `creditNoteTotal` already carries on that branch.
          adjustmentMinor: 0n,
          freedPromoMinor: 0n,
          freedExcessMinor: 0n,
          cashableMinor: creditNoteTotal,
          strandedMinor: 0n,
        };
    const debtRelieved = routed.adjustmentMinor;
    /**
     * ── THE PROMOTIONAL SLICE, PRICED AFTER THE CREDIT IT COMES OUT OF (2026-09-01) ──
     *
     * This block used to sit ABOVE the credit side and read only the STORED promotional
     * balance. On the one shape where a change credits an invoice that promotional credit
     * part-funded, that balance is 0 — the grant was spent on the source invoice — and the
     * preview therefore quoted the new charge with NO promotional discount while the apply
     * discounted it in full. The apply can, because `creditOneInvoice` returns the
     * promo-funded slice of the credit to the promotional bucket
     * (`restoreBucketFundedSlices`, surfaced here as `routed.freedPromoMinor`) BEFORE the
     * proration invoice is raised, and that invoice then draws on the restored bucket
     * pre-tax. The old comment here called that money "invisible to a read-only preview" —
     * it is not: it is `routed.freedPromoMinor`, computed a few lines up, and the only
     * reason the preview could not see it was that it was priced too early.
     *
     * Measured on a LITE-INR subscription part-funded by a ₹3,647.20 grant, then three
     * chained changes; the same chain with the grant removed is the control and was clean
     * throughout. Every one of the three previews, before:
     *
     *   discountMinor   owed 364720, quoted 0   ← the restored grant, undiscounted here
     *   taxMinor        ours high by  65650      = 18% IGST on 364720
     *   totalMinor      ours high by 430370      = the grant grossed up
     *
     * i.e. we quoted ₹4,303.70 MORE than owed on a charge and returned ₹4,303.70 LESS on a
     * credit. OUR BOOKING was already correct, which is why only the preview moved.
     *
     * ⚠ THE CAP IS THE INVOICE'S OWN DISCOUNTED SUBTOTAL, NOT `net`. It was
     * `net − discountMinor`, i.e. the charge lines MINUS the credit lines, on the reasoning
     * that "a change whose unused-time credits outweigh its charges collects nothing here".
     * That is the wrong quantity: the negative lines never reach the invoice (they become a
     * credit note — see "TAX THE CHARGES, NOT THE NET"), so the real invoice's promo cap is
     * `resolvePeriodInvoiceMoney`'s, which is the CHARGE subtotal after coupons. Measured:
     * BUSINESS → LITE credits ₹61,915.54 against a ₹9,118.00 charge, so `net` was deeply
     * negative and the cap collapsed to 0, yet our own booking still discounted that
     * charge by the full ₹3,647.20.
     *
     * Safe for `planCreditApplication` below, which takes the same figure as
     * `discountedSubtotal`: that argument bounds only the `promotional` field of its
     * result, and this call site discards it (`{ refundable, excess }`). The post-tax legs
     * are bounded by `postTaxRemaining`, which is unchanged.
     */
    const promoCap = discountedChargeBase;
    const { promotional, balances }: { promotional: bigint; balances: CustomerBalances | null } =
      promoCap > 0n
        ? await simulatePromotionalDiscount(
            tx,
            organizationId,
            sub.customerId,
            sub.currency,
            promoCap,
            routed.freedPromoMinor,
          )
        : { promotional: 0n, balances: null };
    const taxBase = discountedChargeBase - promotional;
    const tax =
      taxBase > 0n
        ? await (async () => {
            const [cus] = await tx
              .select()
              .from(customers)
              .where(eq(customers.id, sub.customerId))
              .limit(1);
            return estimateTax(
              organizationId,
              businessId,
              cus,
              taxBase,
              // Charge lines, in the order `toDiscountLines` priced them.
              taxedLineAmounts(
                charges.map((c) => c.amount),
                chargeDiscount?.lineDiscountByIndex,
                charges.map((c) => c.taxable),
              ),
            );
          })()
        : { taxMinor: 0n, taxLines: [] as EstimateTaxLine[], inclusiveTaxMinor: 0n };
    // GROSS is what `invoices.total_minor` stores; `total` is what the DOCUMENT says,
    // net of the pre-tax promotional discount — the same derivation `serializeInvoice`
    // makes at its own edge (30fcbd6), so preview and invoice quote one number.
    //
    // The two documents this change raises, each stated the way its own edge states it.
    // `invoiceTotal` is what `invoices.total_minor` will hold, net of the pre-tax
    // promotional discount — the same derivation `serializeInvoice` makes (30fcbd6),
    // so preview and invoice quote one number.
    const invoiceTotal = discountedChargeBase - promotional + tax.taxMinor;
    // ONLY the cashable leg can offset this invoice. Bucket restores are real money for the
    // customer but they are bucket balances, not something this document can absorb.
    const total = invoiceTotal - routed.cashableMinor;
    const postTaxRemaining = total > 0n ? total : 0n;
    /**
     * ── THE FREED **EXCESS** SLICE, POST-TAX (2026-09-01) ─────────────────────────
     *
     * The exact analogue of `freedPromoMinor` above, and deliberately NOT in the same
     * place, because the two slices are not the same kind of money:
     *
     *   promotional credit is a PRE-TAX DISCOUNT   → it moves the tax basis
     *   an excess payment is MONEY ALREADY RECEIVED → it does not
     *
     * That distinction is MEASURED, not reasoned from — four arms differing only in what
     * part-funds invoice #1, with the promotional arm as the positive control so a null
     * result is readable:
     *
     *   arm     invoice #1                          the note raised for the freed slice
     *   promo   discounts[promotional_credits]      ONE adjustment note, sub_total 9118.00,
     *           3647.20, tax 984.74 = 18% of       a `promotional_credits` discount row of
     *           (9118.00 − 3647.20)                3647.20, tax on the NET → basis MOVED
     *   excess  amount_paid 3647.20, discounts 0,   TWO notes, no discount row at all;
     *           tax 1641.24 = 18% of the FULL       the freed slice is a refundable note of
     *           9118.00                             3090.82 + 556.35 tax = 3647.20 → 18%
     *   cash    byte-identical to `excess`          byte-identical to `excess`
     *
     * and on the REPLACEMENT invoice the freed excess came back as post-tax
     * `credits_applied` 3647.20 with tax still 18% of the whole 27918.00 charge, where the
     * freed promotional grant came back as a pre-tax `discounts` row and lowered the tax
     * to 18% of 24270.80. An excess payment is an unapplied PAYMENT TRANSACTION
     * (`POST /customers/:id/record_excess_payment` → `type=payment`, `amount_unused`),
     * which is why it lands post-tax: it is a payment, not a discount.
     *
     * So this widens the POST-TAX phase only, and `grossCreditOnInvoice`'s promo-only tax
     * basis gate is CORRECT AS IT STANDS — extending it to `excessAppliedMinor` would have
     * been a real regression.
     *
     * Measured need, on `verify:credit-chain-gateway` § 9: the preview quoted
     * `amount_due_minor` ₹1,88,202.45 against an invoice issued collectible for
     * ₹1,72,010.40 — short by ₹16,192.05, which is `routed.freedExcessMinor` to the paisa.
     * The booking restores that slice to the excess bucket (`restoreBucketFundedSlices`)
     * BEFORE the proration invoice is raised, and the invoice then draws it down; the
     * preview read the STORED bucket, which does not have it yet.
     */
    const balancesWithFreedExcess = balances
      ? { ...balances, excess: balances.excess + routed.freedExcessMinor }
      : null;
    const { refundable, excess } = balancesWithFreedExcess
      ? planCreditApplication({
          balances: balancesWithFreedExcess,
          discountedSubtotal: promoCap,
          postTaxRemaining,
          // Credits Flexibility must be resolved IDENTICALLY here and in the booking, or
          // the preview quotes credit the invoice will not apply. `probe-estimate-vs-
          // booked-change-chain.ts` is the gate for that class of drift.
          limits: await loadCreditApplicationLimits({
            organizationId,
            businessId,
            subscriptionId: input.subscriptionId,
          }),
        })
      : { refundable: 0n, excess: 0n };
    const creditsApplied = refundable + excess;
    const amountDue = total - creditsApplied > 0n ? total - creditsApplied : 0n;
    // What the proration invoice could not absorb goes back on the balance as refundable
    // credit — "will be added back to the customer's account".
    const refundableAdded =
      routed.cashableMinor - invoiceTotal > 0n ? routed.cashableMinor - invoiceTotal : 0n;
    // `downgrade_credit: refund`: the booking pays that credit back through the card or bank
    // payments behind it (downgrade-credit.ts); only what they cannot take stays on the balance.
    let refundedToMethod = 0n;
    if (refundableAdded > 0n && perShare.length > 0) {
      const [bizRules] = await tx
        .select({ billingRulesConfig: businesses.billingRulesConfig })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      const { creditHandlingFor, MAX_LEGS } = await import("./downgrade-credit");
      const handling =
        input.downgradeCredit ??
        creditHandlingFor(resolveLifecycleConfig(bizRules).downgradeCredit, input.creditChoice);
      if (handling === "refund") {
        const { gatewayRefundableTotalMinor } = await import("@/modules/credit-notes/service");
        const room = await gatewayRefundableTotalMinor(organizationId, perShare[0]!.id, MAX_LEGS);
        refundedToMethod = room < refundableAdded ? room : refundableAdded;
      }
    }
    const refundableKept = refundableAdded - refundedToMethod;
    // ── WHERE THE NOTE WENT, all five legs ────────────────────────────────────────
    // The cashable leg splits at the invoice's edge: what it can absorb offsets THIS
    // document (`invoice_estimate.credits_applied`), the rest lands on the balance.
    // Reported rather than left to the caller — `credit_note_total_minor` minus the open-
    // invoice slice happens to equal this on the unpaid-term shape and nowhere else, so a
    // UI subtraction would pass our repro and misquote a real downgrade.
    const creditAppliedHere =
      routed.cashableMinor < invoiceTotal ? routed.cashableMinor : invoiceTotal;
    const grantsReturned = routed.freedGrantsMinor ?? 0n;
    // Credit-grant slices are discount rows on the note too (`credit_grants`), as booked.
    const returnedToBuckets = routed.freedPromoMinor + routed.freedExcessMinor + grantsReturned;
    /**
     * ── WHAT THE CREDIT NOTE'S **TOTAL** IS, AS THE DOCUMENT PRINTS IT (2026-09-01) ──
     *
     * `creditNoteTotal` above is the note's GROSS — every minor unit of value the change
     * reverses, which is what the five legs account for. It is NOT what the credit note
     * says on its `total` line, and the two differ by exactly the slices handed back to a
     * bucket, because our own booking writes those as DISCOUNT rows:
     *
     *   the identity (measured, `creditOneInvoice`'s docblock): total = sub_total − discounts + tax
     *   CN-188: sub_total ₹41,899.00 · one `promotional_credits` discount of ₹41,899.00 · total ₹0.00
     *   ours, paid branch:  note total = `split.refundable`, sub_total = it + `bucketReturned`,
     *                       with a "Promotional Credits Returned" discount row
     *   ours, open branch:  note total = `due`, sub_total = `due + freedPromo + freedExcess`,
     *                       same discount rows
     *
     * So a preview that reported the gross here disagreed with the documents the very same
     * change books. `verify-credit-chain-gateway`'s own assertion says so in as many words
     * — "credit_note_total_minor == Σ the notes this change actually raised" — and that is
     * the assertion D2 and D3 were filed against. Measured, on every one of the three
     * previews:
     *
     *   creditNoteTotalMinor   owed 645554, quoted 1010274   (and 2863954/3228674, 6191554/6556274)
     *
     * high by exactly the ₹3,647.20 promotional grant returned to its bucket, which also
     * propagated into `creditsAppliedMinor`.
     *
     * The GROSS is not lost: it is `credit_note_total_minor + credit_returned_to_buckets_minor`,
     * and that is the figure the five legs sum to. Every leg below is unchanged —
     * `strandedResidual` still subtracts the bucket leg from the gross, so it is the same
     * number it was.
     */
    const creditNoteDocumentTotal =
      creditNoteTotal - returnedToBuckets > 0n ? creditNoteTotal - returnedToBuckets : 0n;
    // `unplacedMinor` is now in PRE-TAX list units (the distribution runs before the
    // gross-up — see the note there), while every other leg here is gross. Grossed on the
    // BLENDED ratio deliberately: this is credit no invoice could absorb, so there is no
    // one ledger whose tax and discount it carries, and the term's average is the only
    // defensible answer. Every other use of the blend was removed on 2026-09-01.
    /**
     * ── STRANDED IS THE RESIDUAL, NOT AN INDEPENDENT SUM (D2 half one, 2026-09-01) ──
     *
     * This was `routed.strandedMinor + unplacedGross`, where `unplacedGross` grossed up the
     * distribution's `unplacedMinor` on the blended ratio. It DOUBLE-COUNTED, and the
     * measurement is unambiguous — on the credit-funded chain with a partial cash payment:
     *
     *   note=3,939,628  legsum=4,272,209  gap=332,581
     *   cashable=2,403,475  freedExcess=1,536,153  unplacedGross=332,581
     *
     * `cashable + freedExcess` = 3,939,628, i.e. EXACTLY the note total — the routing had
     * already placed all of it — and then the unplaced leg was added on top. The gap equals
     * that leg to the paisa, and equals the partial cash, because the distribution measures
     * `unplacedMinor` in PRE-TAX list units while every leg here is GROSS: a residue appears
     * that the routing has in fact already accounted for.
     *
     * So the leg no longer computes itself. "Stranded" means, by definition, the part of the
     * note that no other leg claims — so it is derived as exactly that, and the five-leg
     * identity `Σ legs == credit_note_total_minor` then holds BY CONSTRUCTION rather than by
     * two independent computations happening to agree. `verify:estimates` and
     * `verify-credit-chain-gateway` both assert that identity.
     *
     * ⚠️ A NEGATIVE residual is a real inconsistency, not a rounding artefact: it means the
     * routing claimed MORE than the note is worth. It is floored at 0 for the caller — a
     * negative destination is not a thing — and surfaced on `credit_routing_over_claimed_minor`
     * so it cannot pass silently the way the double-count did.
     */
    const claimedByOtherLegs =
      creditAppliedHere + refundableAdded + debtRelieved + returnedToBuckets;
    const strandedResidual = creditNoteTotal - claimedByOtherLegs;
    const strandedTotal = strandedResidual > 0n ? strandedResidual : 0n;
    const routingOverClaimed = strandedResidual < 0n ? -strandedResidual : 0n;
    // Built in the order prose reads it: what offsets this invoice, what the customer keeps,
    // what cancelled a debt (naming each document), then the two that are neither.
    // Constructed from the legs rather than alongside them, so the entries cannot drift out
    // of agreement with the scalars — `verify:estimates` asserts they sum to the gross.
    const creditDestinations: CreditDestination[] = [
      ...(creditAppliedHere > 0n
        ? [
            {
              kind: "refundable" as const,
              destination: "this_invoice" as const,
              amount_minor: Number(creditAppliedHere),
            },
          ]
        : []),
      ...(refundableKept > 0n
        ? [
            {
              kind: "refundable" as const,
              destination: "balance" as const,
              amount_minor: Number(refundableKept),
            },
          ]
        : []),
      ...(refundedToMethod > 0n
        ? [
            {
              kind: "refundable" as const,
              destination: "payment_method" as const,
              amount_minor: Number(refundedToMethod),
            },
          ]
        : []),
      ...perShare
        .filter((ps) => ps.routing.adjustmentMinor > 0n)
        .map((ps) => {
          const label = creditRatio?.invoiceLabels.get(ps.id) ?? ps.id;
          creditedOpenInvoices.push({ id: ps.id, label });
          return {
            kind: "adjustment" as const,
            destination: "open_invoice" as const,
            amount_minor: Number(ps.routing.adjustmentMinor),
            invoice: label,
          };
        }),
      ...(returnedToBuckets > 0n
        ? [
            {
              kind: "bucket_restore" as const,
              destination: "buckets" as const,
              amount_minor: Number(returnedToBuckets),
            },
          ]
        : []),
      ...(strandedTotal > 0n
        ? [
            {
              kind: "stranded" as const,
              destination: "none" as const,
              amount_minor: Number(strandedTotal),
            },
          ]
        : []),
    ];

    // ── THE RENEWAL THIS CHANGE LEADS TO ("Next invoice of …") ────────────────────
    // Same null rule as `estimateRenewal`: no next term to bill means no figure to
    // quote. `in_trial` cannot reach here (the trial branch returned above), so the
    // status test is really just the cancelled/paused guard.
    const renewalDate = resetTerm ? newPeriodEnd : sub.currentPeriodEnd;
    const renewable =
      ["active", "in_trial"].includes(sub.status) &&
      !sub.cancelAtPeriodEnd &&
      sub.remainingBillingCycles !== 0 &&
      renewalDate != null &&
      !(sub.cancelScheduledAt != null && sub.cancelScheduledAt.getTime() <= renewalDate.getTime());
    const nextRenewal: RenewalPreview | null =
      renewable && renewalDate
        ? await (async () => {
            const composition = rateFullTermComposition({
              rows,
              removedItemIds,
              reratedByItemId,
              postCycle,
              addResolved,
              prodById,
              changedByItemId: new Map(resolved.map((r) => [r.current.item.id, r])),
            });
            // Peek-only, exactly as the trial branch does — quoting the undiscounted list
            // price for a renewal a coupon still covers is the same lie as quoting no tax.
            // Stored discounts PLUS anything the operator is adding on this screen: by the
            // time this invoice is raised, `POST …/discount` will have run. Priced in one
            // stacking pass with the stored ones — see `peekDiscounts`'s `pending`.
            const disc = await peekDiscounts(
              tx,
              sub.id,
              composition.discountLines,
              sub.currency,
              pendingDiscount,
            );
            const discounted =
              composition.subtotal - disc.totalMinor > 0n
                ? composition.subtotal - disc.totalMinor
                : 0n;
            const [cus] = await tx
              .select()
              .from(customers)
              .where(eq(customers.id, sub.customerId))
              .limit(1);
            const renewalTax = await estimateTax(
              organizationId,
              businessId,
              cus,
              discounted,
              taxedLineAmounts(
                composition.discountLines.map((l) => l.amountMinor),
                disc.lineDiscountByIndex,
                composition.taxable,
              ),
            );
            const renewalTotal = discounted + renewalTax.taxMinor;
            // Only the credit THIS change hands forward, capped at the invoice it lands on.
            const applied = refundableKept < renewalTotal ? refundableKept : renewalTotal;
            return {
              date: renewalDate.toISOString(),
              lines: composition.lines,
              subtotal_minor: Number(composition.subtotal),
              discount_minor: Number(disc.totalMinor),
              tax_minor: Number(renewalTax.taxMinor + renewalTax.inclusiveTaxMinor),
              tax_lines: renewalTax.taxLines,
              total_minor: Number(renewalTotal),
              credits_applied_minor: Number(applied),
              amount_due_minor: Number(renewalTotal - applied),
            };
          })()
        : null;
    return {
      object: "estimate",
      currency: sub.currency,
      lines,
      subtotal_minor: Number(net),
      discount_minor: Number(discountMinor + promotional),
      tax_minor: Number(tax.taxMinor + tax.inclusiveTaxMinor),
      tax_lines: tax.taxLines,
      // Follows the DOCUMENT total, exactly as `estimateNewSubscription` does below.
      // Gating on `net` (pre-tax, gross of the credit's tax) called a downgrade that
      // hands ₹887.36 back an "immediate charge".
      total_minor: Number(total),
      immediate_charge: total > 0n,
      credits_applied_minor: Number(creditsApplied),
      promotional_credits_applied_minor: Number(promotional),
      promotional_discount_minor: Number(promotional),
      refundable_credits_applied_minor: Number(refundable),
      excess_payments_applied_minor: Number(excess),
      amount_due_minor: Number(amountDue),
      ...(creditNoteDocumentTotal > 0n
        ? { credit_note_total_minor: Number(creditNoteDocumentTotal) }
        : {}),
      ...(debtRelieved > 0n ? { credit_applied_to_open_invoices_minor: Number(debtRelieved) } : {}),
      ...(refundableKept > 0n ? { refundable_credit_added_minor: Number(refundableKept) } : {}),
      ...(refundedToMethod > 0n
        ? { refunded_to_payment_method_minor: Number(refundedToMethod) }
        : {}),
      ...(creditAppliedHere > 0n
        ? { credit_applied_to_this_invoice_minor: Number(creditAppliedHere) }
        : {}),
      invoice_total_minor: Number(invoiceTotal),
      invoice_subtotal_minor: Number(invoiceTotal - tax.taxMinor),
      ...(creditDestinations.length > 0 ? { credit_destinations: creditDestinations } : {}),
      // The unused window the credit is FOR: from the change instant to the end of the term
      // that was billed — the same window the credit lines are prorated over, taken from the
      // same variables rather than recomputed.
      //
      // A TERM RESET prorates its credit from `resetStart`, not `prorationNow`
      // (`proration.ts`'s `creditUnused`, and now `changeCreditedPeriod`, which stamps this
      // same window on the note's items). The two differ on a whole-day business — one floors
      // to the local day, the other rounds up — so quoting `prorationNow` for a reset made the
      // preview name a window the booked document would not carry. `2026-08-31`: aligned when
      // the booking started recording the window at all, since a preview and a document that
      // disagree about the period is exactly the class of defect that pair exists to prevent.
      ...(creditNoteTotal > 0n
        ? {
            credited_period_start: (resetTerm ? resetStart : prorationNow).toISOString(),
            credited_period_end: requireTerm(sub).end.toISOString(),
          }
        : {}),
      ...(returnedToBuckets > 0n
        ? { credit_returned_to_buckets_minor: Number(returnedToBuckets) }
        : {}),
      ...(grantsReturned > 0n ? { credit_returned_to_grants_minor: Number(grantsReturned) } : {}),
      ...(strandedTotal > 0n ? { credit_stranded_minor: Number(strandedTotal) } : {}),
      // Non-zero means the routing claimed more than the note is worth — see
      // `strandedResidual`. Reported rather than clamped away, because the double-count this
      // replaced was invisible for exactly as long as nobody summed the legs.
      ...(routingOverClaimed > 0n
        ? { credit_routing_over_claimed_minor: Number(routingOverClaimed) }
        : {}),
      next_renewal: nextRenewal,
      term_reset: resetTerm,
      new_period_end: newPeriodEnd ? newPeriodEnd.toISOString() : null,
    };
  });

  // Attached AFTER the tenant block rather than inside it: the shortfall needs the
  // finished `amount_due_minor`, which is the figure `collectInvoice` will hand to
  // `mandateRefusal`. Checking the subtotal or the pre-credit total would warn about
  // a charge we are not going to make.
  const [subRow] = await withTenant(organizationId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, input.subscriptionId)).limit(1),
  );
  if (!subRow) return estimate;
  const shortfall = await mandateShortfallFor(
    organizationId,
    businessId,
    subRow,
    BigInt(estimate.amount_due_minor ?? estimate.total_minor),
  );
  const withShortfall = shortfall ? { ...estimate, mandate_shortfall: shortfall } : estimate;

  /**
   * Which invoices this edit is about to credit still have a debit live at the rail.
   *
   * Also attached after the tenant block, for the same reason as the shortfall above, and
   * through the SHARED helper rather than a local query: `pendingPaymentsForInvoices` owns
   * what counts as "in flight" and the portal reads the same answer, so a second definition
   * here would drift from the one the buyer is shown.
   */
  if (creditedOpenInvoices.length === 0) return withShortfall;
  const inFlight = await pendingPaymentsForInvoices(
    organizationId,
    creditedOpenInvoices.map((i) => i.id),
    // The whole point of this warning is the money that is moving BEFORE we credit, and
    // a buyer's checkout is most of that: it is the only shape with no payments row, so
    // it is the only shape the first cut of this warning could not see. INV-7824 is the
    // measurement — see `DebitInFlight`.
    { includeIntents: true },
  );
  const debits: DebitInFlight[] = creditedOpenInvoices
    .filter((i) => inFlight.has(i.id))
    .map((i) => ({
      invoice: i.label,
      awaiting_buyer: inFlight.get(i.id)!.awaitingAuthentication,
      kind: inFlight.get(i.id)!.kind,
    }));
  return debits.length > 0 ? { ...withShortfall, debits_in_flight: debits } : withShortfall;
}

/**
 * Preview the NEXT renewal invoice — the "Next Billing Amount".
 *
 * Deliberately delegates to `planSubscriptionPeriodInvoice`, the documented
 * read-only half of `billSubscriptionPeriod`, rather than recomputing lines and
 * tax here: the renewal amount must be whatever the billing clock will actually
 * invoice. A parallel calculator is how the dashboard came to show a customer's
 * "upcoming payment" as the bare sum of `unit_price × quantity` — no tax, no
 * coupons — understating an 18%-GST renewal by the whole tax amount.
 *
 * Metered items are intentionally excluded (no `usagePeriod`): usage for a period
 * that hasn't happened yet is unknown, and `planSubscriptionPeriodInvoice` skips
 * metered lines when no window is given. So this is the fixed-charge floor, which
 * is what a forward-looking estimate can honestly promise.
 *
 * Returns null when there is no next term to bill (cancelled, non-renewing, or
 * ending at period end).
 */
export async function estimateRenewal(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  /** Preview the renewal a pending cancellation (flag, date or exhausted cycles) would stop. */
  ignoreScheduledCancellation?: boolean;
  /**
   * A scheduled change at or before the renewal runs first, so the renewal is priced on
   * the items it leaves. `true` prices today's items instead. When the change cannot be
   * priced here (a pause, more than one change, a change that resets the term), the
   * estimate is null, `onUnpriced` names it, and `false` refuses (ProrationError).
   */
  ignoreScheduledChanges?: boolean;
  onUnpriced?: (change: { id: string; type: string; effective_at: string }) => void;
  /** `false` leaves queued unbilled charges off the preview (they ride on it by default). */
  includeDelayedCharges?: boolean;
  /** `false` previews with no credit applied — every bucket treated as empty. */
  useExistingBalances?: boolean;
  /**
   * `true` adds the metered usage recorded so far, when the renewal is what bills it.
   * Off by default: mandate ceilings, reminders and the portal need a figure that does
   * not move with every usage record.
   */
  includeUsageSoFar?: boolean;
}): Promise<Estimate | null> {
  const { organizationId, businessId } = input;
  // Mirror renewSubscription's own load: the term interval lives on the recurring
  // PRICE, not the subscription row.
  const ctx = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!row) return null;
    const [recurring] = await tx
      .select({ interval: prices.interval, intervalCount: prices.intervalCount })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(and(eq(subscriptionItems.subscriptionId, row.id), eq(prices.type, "recurring")))
      .limit(1);
    return {
      sub: row,
      recurring: recurring ?? null,
      mode: await billingModeFor(tx, row.businessId),
    };
  });
  if (!ctx?.sub || !ctx.recurring) return null;
  const { sub, recurring } = ctx;
  if (!["active", "in_trial"].includes(sub.status)) return null;
  // cancel_at_period_end / an exhausted cycle cap means the current term IS the
  // last one — renewSubscription ends it instead of billing another.
  const honourCancel = !input.ignoreScheduledCancellation;
  if (honourCancel && (sub.cancelAtPeriodEnd || sub.remainingBillingCycles === 0)) return null;
  // A pending specific_date cancel only kills the next term if it fires BEFORE that
  // term would be billed. Scheduled beyond the current term end, the subscription
  // genuinely does renew first (and is billed for it), so the estimate is real —
  // which is why this is a date comparison and not another truthy flag check.
  // The NEXT BILLING BOUNDARY, which for a trialling subscription is its trial end rather
  // than a term it no longer has (2026-08-25).
  const nextBoundary = nextBillingBoundary(sub);
  if (nextBoundary == null) return null;
  if (
    honourCancel &&
    sub.cancelScheduledAt != null &&
    sub.cancelScheduledAt.getTime() <= nextBoundary.getTime()
  )
    return null;
  // Scheduled changes run before the renewal at the boundary, so the renewal bills the
  // items they leave.
  let items: PeriodItemRow[] | undefined;
  let applied: { id: string; type: "change"; effective_at: string } | undefined;
  if (input.ignoreScheduledChanges !== true) {
    const due = (
      await withTenant(organizationId, (tx) =>
        tx
          .select({
            id: scheduledChanges.publicId,
            type: scheduledChanges.type,
            effectiveAt: scheduledChanges.effectiveAt,
            payload: scheduledChanges.payload,
          })
          .from(scheduledChanges)
          .where(
            and(
              eq(scheduledChanges.subscriptionId, sub.id),
              eq(scheduledChanges.status, "scheduled"),
              inArray(scheduledChanges.type, ["change", "pause"]),
            ),
          )
          .orderBy(asc(scheduledChanges.effectiveAt)),
      )
    ).filter((r) => r.effectiveAt.getTime() <= nextBoundary.getTime());
    if (due.length > 0) {
      const only = due.length === 1 && due[0]!.type === "change" ? due[0]! : null;
      const planned = only
        ? await itemsAfterScheduledChange({
            organizationId,
            businessId,
            subscriptionId: sub.id,
            effectiveAt: only.effectiveAt,
            work: (only.payload ?? {}) as {
              changes?: ItemChange[];
              adds?: ItemAdd[];
              removes?: string[];
            },
          })
        : null;
      if (!planned) {
        if (input.ignoreScheduledChanges === false)
          throw new ProrationError(
            "A scheduled change or pause occurs before this renewal, and the renewal estimate cannot apply it. To price the current items, pass ignore_scheduled_changes=true.",
          );
        input.onUnpriced?.({
          id: due[0]!.id,
          type: due[0]!.type,
          effective_at: due[0]!.effectiveAt.toISOString(),
        });
        return null;
      }
      items = planned;
      applied = { id: only!.id, type: "change", effective_at: only!.effectiveAt.toISOString() };
    }
  }

  // The next term, anchored exactly as renewSubscription anchors it — via
  // advancePeriod against the persisted anchor day, NOT a bare addInterval, or a
  // short month would drift the estimated date off the real billing date. Including its
  // trial round-up: a day-anchored trial ends at 23:59:59 local and the term it opens
  // starts on the following midnight, so an estimate that skipped it would quote a term
  // a second off the one the renewal actually books.
  // Mirrors `renewSubscription` exactly (they must agree or the preview lies): a trialling
  // subscription has no term since 2026-08-25, so its next term opens at the TRIAL end.
  const priorBoundary = nextBillingBoundary(sub);
  if (priorBoundary == null) return null;
  const periodStart =
    sub.status === "in_trial" ? normalizeTermEnd(priorBoundary, ctx.mode) : priorBoundary;
  const periodEnd = advancePeriod(
    periodStart,
    (recurring.interval ?? "month") as Interval,
    recurring.intervalCount ?? 1,
    sub.billingAnchorDay,
    ctx.mode,
  );

  // No `createAsPending`: we want the finalize plan, which is the one that carries
  // the money. A pending draft would come back with lines but no totals.
  const preview = {
    ...(input.includeDelayedCharges === false ? { excludePendingCharges: true } : {}),
    ...(input.useExistingBalances === false ? { ignoreCreditBalances: true } : {}),
  };
  const usageWindow = input.includeUsageSoFar
    ? await withTenant(organizationId, (tx) => usageWindowForNextInvoice(tx, sub))
    : null;
  const plan = await planSubscriptionPeriodInvoice({
    organizationId,
    businessId,
    subscription: sub,
    periodStart,
    periodEnd,
    ...(usageWindow?.billedBy === "renewal"
      ? { usagePeriod: { start: usageWindow.start, end: usageWindow.end } }
      : {}),
    ...(Object.keys(preview).length > 0 ? { preview } : {}),
    // The closing term's minimum commitment, as the renewal raises it.
    commitment: closingCommitment(sub),
    ...(items ? { items } : {}),
  });
  if (plan.mode !== "finalize") return null;
  const { money } = plan;
  // With a scheduled change priced in, the mandate must still carry today's items: the
  // change can fail or be withdrawn, and the renewal then debits those.
  const today = applied
    ? await estimateRenewal({ ...input, ignoreScheduledChanges: true, onUnpriced: undefined })
    : null;
  const todayDue = today ? BigInt(today.amount_due_minor ?? today.total_minor) : 0n;
  const shortfall = await mandateShortfallFor(
    organizationId,
    businessId,
    sub,
    todayDue > money.amountDue ? todayDue : money.amountDue,
  );
  return {
    object: "estimate",
    currency: sub.currency,
    lines: plan.lines.map((l) => ({
      description: l.description,
      amount_minor: Number(l.amountMinor),
    })),
    subtotal_minor: Number(plan.subtotal),
    // `money.promoApplied` is a PRE-TAX discount — `resolvePeriodInvoiceMoney` already
    // taxed `discountedSubtotal − promo` to produce `invoiceTax` — so it belongs with the
    // coupons here and OUT of `credits_applied_minor`, and `money.total` (the gross taxed
    // claim the `invoices.total_minor` column stores) has to lose it to become the number
    // the document states. This is the identical derivation `serializeInvoice` makes on
    // the invoice this estimate predicts (30fcbd6); before it, the renewal preview
    // quoted the gross total with the promo counted as a post-tax credit, so preview and
    // invoice disagreed by exactly the promo on every promo-funded renewal.
    discount_minor: Number(plan.discountMinor + money.promoApplied + money.grantPreTaxApplied),
    tax_minor: Number(money.invoiceTax.totalTaxMinor),
    // From the computed rows rather than a re-split: `taxLinesFromRows` groups by component
    // and drops INCLUSIVE tax, which is already inside the line amounts.
    tax_lines: taxLinesFromRows(money.invoiceTax.rows).map((l) => ({
      label: l.label,
      amount_minor: Number(l.amountMinor),
    })),
    // Named, and summing to `discount_minor` above — so the promotional slice is one of
    // them, exactly as `serializeInvoice` lists it first among `discounts[]`. Without it
    // the rows would fall short of the total by the promo and the portal would be back to
    // an unexplained gap, just a smaller one.
    discount_lines: [
      ...(money.promoApplied > 0n
        ? [{ label: "Promotional Credits", amount_minor: Number(money.promoApplied) }]
        : []),
      ...(money.grantPreTaxApplied > 0n
        ? [{ label: "Credit grants", amount_minor: Number(money.grantPreTaxApplied) }]
        : []),
      ...plan.discountRows.map((r) => ({
        label: r.label,
        amount_minor: Number(r.discountMinor),
      })),
    ],
    total_minor: Number(money.total - money.promoApplied - money.grantPreTaxApplied),
    immediate_charge: false, // a renewal is future-dated by definition
    credits_applied_minor: Number(
      money.refundableApplied + money.excessApplied + money.grantPostTaxApplied,
    ),
    grant_credits_pre_tax_minor: Number(money.grantPreTaxApplied),
    grant_credits_post_tax_minor: Number(money.grantPostTaxApplied),
    promotional_credits_applied_minor: Number(money.promoApplied),
    promotional_discount_minor: Number(money.promoApplied),
    refundable_credits_applied_minor: Number(money.refundableApplied),
    excess_payments_applied_minor: Number(money.excessApplied),
    amount_due_minor: Number(money.amountDue),
    term_reset: false,
    new_period_end: periodEnd.toISOString(),
    ...(applied ? { scheduled_change: applied } : {}),
    // The renewal figure is the one a DEFERRED change makes dangerous: a mid-term
    // proration can sit under the ceiling while every renewal after it is refused.
    // `estimateChange` cannot see that number — it does not exist until the change
    // is applied — so this is where that case surfaces.
    ...(shortfall ? { mandate_shortfall: shortfall } : {}),
  };
}

/** Preview the first invoice for a NEW subscription (fixed charges, discount, tax). */
/**
 * One item of a FRESH TERM, already resolved to the price row it belongs to and the
 * SNAPSHOT it will be rated from.
 *
 * The snapshot is the load-bearing half: it is what the booked `subscription_items` row
 * freezes and what `planSubscriptionPeriodInvoice` rates the real invoice from, so a
 * preview that rates the same snapshot cannot disagree with the invoice about a line.
 *
 * Resolving it is the CALLER's job precisely because the two callers resolve differently —
 * a signup auto-includes mandatory add-ons (CAT-3) and applies CAT-7 differentials, while
 * `reactivateSubscriptionWithOptions` books exactly the item set it was handed and does
 * neither. Folding both into one function would make the shared core disagree with one of
 * the two bookings it is supposed to predict.
 */
interface FreshTermItem {
  price: typeof prices.$inferSelect;
  quantity: number;
  /** Normally `alignSnapshotToCycle(snapshotPrice(price, override, tiers), cycle)`. */
  snapshot: PriceSnapshot;
  /** The item's own `free_quantity`; null falls back to the price's. */
  freeQuantity: number | null;
}

/**
 * The money of a fresh term's FIRST INVOICE: rate → discount → promotional draw → tax →
 * refundable/excess draw → amount due.
 *
 * Shared by `estimateNewSubscription` (a signup) and `estimateReactivate` (a cancelled
 * subscription restarted onto a new term). Both raise ONE ordinary recurring invoice, with
 * no proration and no credit note, so the only difference between them is which items they
 * resolve — see {@link FreshTermItem}.
 *
 * It exists so that neither of them computes tax or credit itself. The Reactivate dialog
 * understated an Indian customer's charge by the whole of GST (#56) for exactly as long as
 * no estimator answered for that screen — it summed the line items client-side and called
 * the result "Chargeable immediately", skipping tax, the customer's ₹9,661.13 of refundable
 * credit and therefore the amount due. A second copy of this ladder is how that returns.
 *
 * ⚠ `subscriptionId` is not decoration. `planSubscriptionPeriodInvoice` resolves its credit
 * ceilings through `creditApplicationLimits({ …, subscription })` — the site-level slot
 * TIGHTENED by that subscription's own `max_refundable_credits_usage_minor`. A signup has no
 * subscription and passes null; a reactivation MUST pass the real id, or the preview spends
 * credit the invoice will cap and quotes an amount due that is too low. That is the one
 * reason `POST /customers/:cus/subscription_estimate` could not simply be reused for the
 * reactivate screen.
 */
async function estimateFreshTermMoney(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    subscriptionId: string | null;
    currency: string;
    items: FreshTermItem[];
    /**
     * How this term's discounts are priced, as a PEEK — no redemption is consumed either
     * way. It is a callback rather than a pair of option bags because the two callers read
     * two different things, and reading the wrong one is a silent money error:
     *
     *  · a SIGNUP has no discounts applied yet, so it prices the coupon codes / manual
     *    discount the caller asked for (`peekCouponCodes`);
     *  · a REACTIVATION restarts a subscription whose `subscription_discounts` rows
     *    survived the cancellation, and `planSubscriptionPeriodInvoice` will discount its
     *    first invoice from exactly those rows (`peekDiscounts`) — so a preview that
     *    priced an empty code list would quote list price against a discounted invoice.
     *
     * Only `totalMinor` is consumed here; both helpers return more, and the richer halves
     * belong to the callers that know what they mean.
     */
    peekDiscount: (
      lines: DiscountLine[],
    ) => Promise<{ totalMinor: bigint; lineDiscountByIndex: bigint[] }>;
    /**
     * Set when the term opens INTO A TRIAL: nothing is invoiced or collected today, so the
     * composition is reported in full while every money-moves-now field is zero — the same
     * contract `estimateChange`'s in-trial branch honours. See `Estimate.due_at_trial_end`.
     */
    trialEndIso?: string | null;
  },
): Promise<Estimate> {
  const { organizationId, businessId, currency } = input;
  const lines: EstimateLine[] = [];
  // Kept in lockstep with `lines` so a discount line can be attributed back to the
  // item that produced it — an `each_specified_item` coupon matches on product kind
  // and public id, so index alignment is load-bearing, not incidental.
  const chargeableItems: FreshTermItem[] = [];
  for (const it of input.items) {
    // Usage-model items bill in arrears (nothing on the first invoice).
    if (isMeteredPrice(it.price)) continue;
    // Rate the item's OWN SNAPSHOT — the same row the booked item freezes and the real
    // invoice is rated from, cycle-folded already, so a monthly add-on on a yearly plan
    // previews its ×12 amount.
    const amount = computeLineAmount(
      ratableFromSnapshot(it.snapshot, it.freeQuantity),
      it.quantity,
    );
    lines.push({
      description: `${it.price.model} (${it.price.publicId}) ×${it.quantity}`,
      amount_minor: Number(amount),
    });
    chargeableItems.push(it);
  }
  // Product kind + public id for the chargeable items only, for coupon item-constraint
  // matching.
  const chargeableProductIds = [...new Set(chargeableItems.map((i) => i.price.productId))];
  const productById = new Map(
    chargeableProductIds.length > 0
      ? (
          await tx
            .select({ id: products.id, kind: products.kind, publicId: products.publicId })
            .from(products)
            .where(
              and(eq(products.businessId, businessId), inArray(products.id, chargeableProductIds)),
            )
        ).map((p) => [p.id, { kind: p.kind, publicId: p.publicId }])
      : [],
  );
  const subtotal = lines.reduce((s, l) => s + BigInt(l.amount_minor), 0n);
  // Signup/reactivation coupons, priced through the SAME stacker the first invoice will
  // use (`peekCouponCodes` → `computeStackedDiscounts`), so the preview cannot disagree
  // with the invoice about stacking order or item constraints.
  const discountLines: DiscountLine[] = [];
  for (const [i, it] of chargeableItems.entries()) {
    const prod = productById.get(it.price.productId);
    discountLines.push({
      index: i,
      amountMinor: BigInt(lines[i]!.amount_minor),
      productKind: prod?.kind ?? null,
      productPublicId: prod?.publicId ?? null,
      pricePublicId: it.price.publicId,
    });
  }
  const disc = await input.peekDiscount(discountLines);
  const discounted = subtotal - disc.totalMinor > 0n ? subtotal - disc.totalMinor : 0n;
  const taxedLines = taxedLineAmounts(
    lines.map((l) => BigInt(l.amount_minor)),
    disc.lineDiscountByIndex,
    chargeableItems.map((it) => it.price.isTaxable),
  );
  const [cus] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);

  // ── OPENING INTO A TRIAL: nothing is invoiced or collected today ─────────────
  // Mirror the booking: `reactivateSubscriptionWithOptions` with a `trialEnd` returns
  // `billable: false`, so the route raises no invoice and draws no credit. The buckets
  // are reported as ZERO rather than simulated — no draw happens now, and what the
  // customer's balance will be at trial end is not knowable from here. Same reasoning,
  // same field, same shape as `estimateChange`'s in-trial branch.
  if (input.trialEndIso) {
    const trialTax = await estimateTax(organizationId, businessId, cus, discounted, taxedLines);
    return {
      object: "estimate",
      currency,
      lines,
      subtotal_minor: Number(subtotal),
      discount_minor: Number(disc.totalMinor),
      tax_minor: Number(trialTax.taxMinor + trialTax.inclusiveTaxMinor),
      tax_lines: trialTax.taxLines,
      total_minor: Number(discounted + trialTax.taxMinor),
      immediate_charge: false,
      credits_applied_minor: 0,
      promotional_credits_applied_minor: 0,
      promotional_discount_minor: 0,
      refundable_credits_applied_minor: 0,
      excess_payments_applied_minor: 0,
      amount_due_minor: 0,
      term_reset: false,
      new_period_end: null,
      due_at_trial_end: input.trialEndIso,
    };
  }

  // Tax the DISCOUNTED subtotal, LESS the promotional slice. This used to tax
  // `subtotal`, so a discounted signup was overstated twice over: the discount was
  // missing AND the tax was computed on money the customer was never going to be
  // charged — 18% GST on the full list price. The promotional slice is the same kind
  // of mistake one layer down: the first invoice applies it PRE-tax
  // (`resolvePeriodInvoiceMoney` D1), so a term part-funded by a grant is taxed on
  // `discounted − promo`, and quoting tax on `discounted` promises a bigger bill than
  // the invoice raises.
  const { promotional, balances } = await simulatePromotionalDiscount(
    tx,
    organizationId,
    input.customerId,
    currency,
    discounted,
  );
  const taxBase = discounted - promotional;
  const tax = await estimateTax(
    organizationId,
    businessId,
    cus,
    taxBase > 0n ? taxBase : 0n,
    taxedLines,
  );
  // `total` is the DOCUMENT's total — net of the pre-tax promotional discount, the
  // same figure `serializeInvoice` derives for the invoice this predicts.
  const total = discounted - promotional + tax.taxMinor;
  const postTaxRemaining = total > 0n ? total : 0n;
  const { refundable, excess } = planCreditApplication({
    balances,
    discountedSubtotal: discounted,
    postTaxRemaining,
    // A signup or reactivation invoice IS a recurring invoice, so the class is stated
    // rather than left to the loader, which would infer `one_time` from an absent
    // subscription id and read the wrong half of the business's grid.
    limits: await loadCreditApplicationLimits({
      organizationId,
      businessId,
      subscriptionId: input.subscriptionId,
      invoiceClass: "recurring",
    }),
  });
  const creditsApplied = refundable + excess;
  const amountDue = total - creditsApplied > 0n ? total - creditsApplied : 0n;
  return {
    object: "estimate",
    currency,
    lines,
    subtotal_minor: Number(subtotal),
    // Coupons/manual discount PLUS the promotional slice, so the estimate's own
    // identity `subtotal − discount + tax = total` still holds.
    discount_minor: Number(disc.totalMinor + promotional),
    tax_minor: Number(tax.taxMinor + tax.inclusiveTaxMinor),
    tax_lines: tax.taxLines,
    // `immediate_charge` follows the DOCUMENT total: a term a grant covers outright
    // raises a `paid` invoice with nothing due, and saying "charged now" of it would
    // promise a debit that never happens.
    total_minor: Number(total),
    immediate_charge: total > 0n,
    credits_applied_minor: Number(creditsApplied),
    promotional_credits_applied_minor: Number(promotional),
    promotional_discount_minor: Number(promotional),
    refundable_credits_applied_minor: Number(refundable),
    excess_payments_applied_minor: Number(excess),
    amount_due_minor: Number(amountDue),
    term_reset: false,
    new_period_end: null,
  };
}

export async function estimateNewSubscription(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  /** `customAmountMinor` = the caller's `unit_price_minor` override; it wins over
   *  any CAT-7 differential, exactly as in `createSubscription`. `customTiers` is
   *  filled in by `applyExplicitDifferentials` for a TIERED differential. */
  items: Array<{
    price: typeof prices.$inferSelect;
    quantity: number;
    customAmountMinor?: number | null;
    customTiers?: unknown;
    freeQuantity?: number | null;
  }>;
  /**
   * Coupon codes that would be applied AT SIGNUP — the same `coupon_ids[]` the create
   * route takes. Priced, never redeemed. Was declared and silently ignored, so the rail
   * quoted the undiscounted total while the line list showed a discount figure.
   */
  couponCodes?: string[];
  /** Codes in `couponCodes` already attached to a live subscription: priced, never refused. */
  attachedCouponCodes?: string[];
  /**
   * A signup MANUAL discount (`discount` on createSubBody) — %/amount with no catalog
   * coupon behind it. Always invoice-wide: manual discounts carry no CAT-2 item
   * constraints, which is exactly how `peekDiscounts` projects them from their
   * `manual_*` columns.
   */
  manualDiscount?: {
    kind: "percentage" | "fixed_amount";
    percentOffBps?: number;
    amountOffMinor?: bigint;
  };
  now: Date;
}): Promise<Estimate> {
  const { organizationId, businessId } = input;
  const currency = input.items[0]?.price.currency ?? "USD";
  const recurring = input.items.find((i) => i.price.type === "recurring");
  const interval = recurring?.price.interval ?? null;
  const intervalCount = recurring?.price.intervalCount ?? 1;
  // Mirror createSubscription's guards so the preview refuses what the create would
  // refuse, rather than quoting a price the confirm can't book.
  for (const i of input.items) {
    if (i.customAmountMinor != null) {
      if (!isOverridable(i.price.model)) {
        throw new ProrationError(
          `You can set a custom price only on a flat or per_unit price. This price is ${i.price.model}.`,
        );
      }
      if (i.customAmountMinor < 0) throw new ProrationError("unit_price_minor must be 0 or more");
    }
    const reason = cadenceMismatch(i.price, interval ?? "month", intervalCount);
    if (reason) throw new ProrationError(reason);
  }
  return withTenant(organizationId, async (tx) => {
    // CAT-3: reflect auto-included mandatory add-ons in the estimate.
    const requestedProductIds = [...new Set(input.items.map((i) => i.price.productId))];
    const requestedProducts = await tx
      .select({ id: products.id, kind: products.kind })
      .from(products)
      .where(and(eq(products.businessId, businessId), inArray(products.id, requestedProductIds)));
    const planIds = requestedProducts.filter((r) => r.kind === "plan").map((r) => r.id);
    const addonProductIds = new Set(
      requestedProducts.filter((r) => r.kind === "addon").map((r) => r.id),
    );
    const mandatory = await resolveMandatoryAttachedItems(tx, {
      businessId,
      planProductIds: planIds,
      currency,
      interval,
      intervalCount,
      existingProductIds: requestedProductIds,
    });
    // CAT-7: price explicitly-requested add-ons exactly as `createSubscription`
    // will — same helper — so the preview can't understate a differential add-on
    // (catalog list price 0, real amount per plan+currency+interval).
    const requestedItems = await applyExplicitDifferentials(tx, {
      currency,
      planProductIds: planIds,
      addonProductIds,
      items: input.items,
    });
    const allItems = [
      ...requestedItems,
      ...mandatory.map((m) => ({
        price: m.price,
        quantity: m.quantity,
        customAmountMinor: m.differentialAmountMinor ?? undefined,
        customTiers: m.differentialTiers ?? undefined,
        freeQuantity: null,
      })),
    ];
    // Rating, discounting, tax and the credit draw are `estimateFreshTermMoney`'s —
    // shared with `estimateReactivate`, which raises the same kind of invoice. This
    // function's own job is the SIGNUP's item resolution: the guards above, CAT-3's
    // mandatory add-ons and CAT-7's differentials, folded into the cycle snapshot the
    // booked item will freeze.
    return estimateFreshTermMoney(tx, {
      organizationId,
      businessId,
      customerId: input.customerId,
      // No subscription exists yet, so there is no subscription-level credit cap to
      // tighten the business's slot with. `invoiceClass` is stated explicitly inside.
      subscriptionId: null,
      currency,
      items: allItems.map((it) => ({
        price: it.price,
        quantity: it.quantity,
        snapshot: alignSnapshotToCycle(
          snapshotPrice(it.price, it.customAmountMinor, it.customTiers),
          { interval: interval ?? "month", intervalCount },
        ),
        freeQuantity: it.freeQuantity ?? null,
      })),
      // A signup has nothing applied yet: the codes and the manual discount arrive on the
      // request, and are priced through the SAME stacker the first invoice will use.
      peekDiscount: (discountLines) =>
        peekCouponCodes(
          tx,
          organizationId,
          businessId,
          input.couponCodes ?? [],
          discountLines,
          currency,
          input.manualDiscount,
          input.customerId,
          input.now,
          input.attachedCouponCodes,
        ),
    });
  });
}

/**
 * Dry-run preview of REACTIVATING a cancelled subscription onto a fresh term,
 * itemising tax.
 *
 * ── WHY THIS EXISTS RATHER THAN A REUSE ──────────────────────────────────────────
 * The Reactivate confirmation dialog had no estimate at all. It summed its own line
 * items client-side and printed the result as "Chargeable immediately" (#56), so on an
 * Indian customer it named ₹10,998.00 where the invoice came to ₹12,977.64 and, after
 * that customer's own ₹9,661.13 of refundable credit, collected ₹3,316.51 — a label
 * wrong by ₹7,681.49 in both directions at once. Neither existing endpoint could answer:
 *
 *  · `estimateChange` (`POST …/subscriptions/:sub/estimate`) prorates against a CURRENT
 *    TERM. A cancelled subscription has none — `requireTerm` refuses it outright — and a
 *    reactivation is not a proration anyway: it opens a full fresh term.
 *  · `estimateNewSubscription` (`POST …/customers/:cus/subscription_estimate`) has the
 *    right SHAPE — one full-term invoice, no proration — but the wrong SCOPE. It knows no
 *    subscription, so it resolves credit ceilings with `subscriptionId: null` and ignores
 *    that subscription's own `max_refundable_credits_usage_minor`, which
 *    `planSubscriptionPeriodInvoice` does apply. On a capped subscription it would over-
 *    spend the credit and quote an amount due that is too low. It also auto-includes
 *    mandatory add-ons (CAT-3) and applies CAT-7 differentials, and
 *    `reactivateSubscriptionWithOptions` does NEITHER: it books exactly the item set it
 *    was handed. A preview that added a line the booking will not is the same class of
 *    defect as one that drops the tax.
 *
 * So the money ladder is SHARED — `estimateFreshTermMoney`, one copy of rate → discount →
 * promotional draw → tax → refundable/excess draw → amount due — and only the item
 * resolution is written here, mirroring `reactivateSubscriptionWithOptions` guard for
 * guard. Nothing about tax or credit is computed in this function.
 *
 * ── WHAT IT DOES NOT COVER, AND WHY THAT IS A REFUSAL RATHER THAN A GUESS ────────
 * `items` is REQUIRED. The plain reactivate (`POST …/reactivate` with an empty body, the
 * detail-page action rail) keeps the existing `subscription_items` rows, and the invoice
 * it bills is rated by `planSubscriptionPeriodInvoice` from those rows *including their
 * item-level cycle caps and `cycles_billed` counters* — an exhausted one-time item is
 * skipped there. Re-deriving that rule here would be a second copy of it, which is exactly
 * how the estimate/booking pairs in this file have drifted before. That path also shows no
 * confirmation dialog, so nothing needs the preview.
 */
export async function estimateReactivate(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  /** The full desired line set, in the reactivate route's own wire shape. */
  items: Array<{
    price: string;
    quantity?: number | null;
    unitPriceMinor?: number | null;
    freeQuantity?: number | null;
  }>;
  /** Reactivating INTO a trial: nothing is invoiced or collected today. */
  trialEnd?: Date | null;
  now: Date;
  /** `now` is a backdated term start, which always opens a fresh term. */
  backdated?: boolean;
  /** As `reactivateAndBill`'s `term`; omitted = `auto`. */
  term?: ReactivationTerm;
  /** As `reactivateAndBill`'s `onChargeFailure`; decides whether in-term collects first. */
  onChargeFailure?: ChargeFailureChoice;
  /** Coupons / a manual discount the reactivation will apply before it bills, priced here too. */
  couponCodes?: string[];
  manualDiscount?: {
    kind: "percentage" | "fixed_amount";
    percentOffBps?: number;
    amountOffMinor?: bigint;
  };
}): Promise<Estimate> {
  const { organizationId, businessId } = input;
  if (input.items.length === 0) {
    throw new ProrationError(
      "A reactivation estimate needs the items that it previews. items[] is required.",
    );
  }
  return withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) throw new ProrationError("Subscription not found");
    // The booking's own guard, restated so the preview refuses what the confirm would
    // refuse instead of quoting a price for an impossible action.
    if (sub.status !== "cancelled") {
      throw new ProrationError(
        `You can reactivate only a cancelled subscription with changes. This subscription is ${sub.status}.`,
      );
    }

    // The booking's in-term branch (`reactivateAndBill`), condition for condition.
    const found =
      !input.trialEnd && !input.backdated ? await findInTermReactivation(tx, sub, input.now) : null;
    const inTermAvailable = !!found && (await sameItemSet(tx, sub.id, input.items));
    const term = input.term ?? "auto";
    if (term === "continue" && !inTermAvailable) throw new ProrationError(IN_TERM_REFUSAL);
    if (found && term !== "new" && inTermAvailable) {
      const [biz] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      const [cus] = await tx
        .select({ autoCollection: customers.autoCollection })
        .from(customers)
        .where(eq(customers.id, sub.customerId))
        .limit(1);
      const collectsNow =
        !!biz &&
        requiresChargeOnReactivation(
          (await loadEffectiveDunningConfig(tx, { businessId, customerId: sub.customerId }))
            .requireSuccessfulChargeOnReactivation,
          input.onChargeFailure,
        ) &&
        found.outstandingMinor > 0n &&
        isAutoCollectOn(sub.autoCollection, cus?.autoCollection);
      const due = collectsNow ? Number(found.outstandingMinor) : 0;
      return {
        object: "estimate",
        currency: sub.currency,
        lines: [],
        subtotal_minor: 0,
        discount_minor: 0,
        tax_minor: 0,
        total_minor: 0,
        immediate_charge: collectsNow,
        credits_applied_minor: 0,
        amount_due_minor: due,
        term_reset: false,
        new_period_end: null,
        in_term_available: true,
        in_term_reactivation: {
          current_period_end: found.periodEnd.toISOString(),
          invoice: {
            id: found.invoice.publicId,
            number: found.invoice.number,
            status: found.invoice.status,
            outstanding_minor: Number(found.outstandingMinor),
          },
          collects_now: collectsNow,
        },
      };
    }

    // ── ITEM RESOLUTION: `reactivateSubscriptionWithOptions`, guard for guard ──────
    const resolved: Array<{
      price: typeof prices.$inferSelect;
      quantity: number;
      customAmountMinor?: number;
      freeQuantity: number | null;
    }> = [];
    for (const it of input.items) {
      const [price] = await tx
        .select()
        .from(prices)
        .where(and(eq(prices.businessId, businessId), eq(prices.publicId, it.price)))
        .limit(1);
      if (!price) throw new ProrationError(`We could not find the price ${it.price}.`);
      if (price.currency !== sub.currency) {
        throw new ProrationError("You cannot reactivate with a price in a different currency");
      }
      if (it.unitPriceMinor != null) {
        if (!isOverridable(price.model)) {
          throw new ProrationError(
            `You can set a custom price only on a flat or per_unit price. This price is ${price.model}.`,
          );
        }
        if (it.unitPriceMinor < 0) throw new ProrationError("unit_price_minor must be 0 or more");
      }
      resolved.push({
        price,
        quantity: it.quantity ?? 1,
        customAmountMinor: it.unitPriceMinor ?? undefined,
        freeQuantity: it.freeQuantity ?? null,
      });
    }
    const recurring = resolved.find((i) => i.price.type === "recurring");
    if (!recurring) {
      throw new ProrationError("A subscription needs at least one recurring price");
    }
    const cycle = {
      interval: (recurring.price.interval ?? "month") as Interval,
      intervalCount: recurring.price.intervalCount ?? 1,
    };
    for (const i of resolved) {
      const reason = cadenceMismatch(i.price, cycle.interval, cycle.intervalCount);
      if (reason) throw new ProrationError(reason);
    }

    // The trial end the BOOKING will store, not the one the caller typed: reactivation
    // aligns it through the business's billing mode, and reporting the raw instant would
    // name a date the subscription does not end its trial on.
    const trialEndIso = input.trialEnd
      ? alignTrialEnd(input.trialEnd, await billingModeFor(tx, businessId)).toISOString()
      : null;

    const fresh = await estimateFreshTermMoney(tx, {
      organizationId,
      businessId,
      customerId: sub.customerId,
      // THE REASON THIS IS NOT `estimateNewSubscription`: the subscription's own credit
      // maxima tighten the business's slot, and `planSubscriptionPeriodInvoice` applies
      // them to the very invoice this previews.
      subscriptionId: sub.id,
      currency: sub.currency,
      items: resolved.map((i) => ({
        price: i.price,
        quantity: i.quantity,
        // The snapshot the reactivated `subscription_items` row will freeze, byte for
        // byte — `alignSnapshotToCycle(snapshotPrice(price, override), newCycle)`.
        snapshot: alignSnapshotToCycle(snapshotPrice(i.price, i.customAmountMinor), cycle),
        freeQuantity: i.freeQuantity ?? null,
      })),
      // The subscription's OWN applied discounts. Cancelling does not remove
      // `subscription_discounts`, and `planSubscriptionPeriodInvoice` discounts the
      // reactivated term's first invoice from exactly these rows — so pricing an empty
      // code list here would quote list price against a discounted invoice.
      //
      // Plus what this reactivation adds: the booking applies them before the invoice.
      peekDiscount: (discountLines) =>
        peekDiscounts(
          tx,
          sub.id,
          discountLines,
          sub.currency,
          input.couponCodes?.length || input.manualDiscount
            ? {
                organizationId,
                businessId,
                now: input.now,
                ...(input.couponCodes?.length ? { codes: input.couponCodes } : {}),
                ...(input.manualDiscount ? { manual: input.manualDiscount } : {}),
              }
            : undefined,
        ),
      trialEndIso,
    });
    return { ...fresh, in_term_available: inTermAvailable };
  });
}

// ─── Cancellation estimate ─────────────────────────────────────────────────────

/** What the unbilled charges sitting on the subscription would do. */
export interface UnbilledChargesPreview {
  /** `none` means the option was not set and the charges are simply LEFT PENDING. */
  action: UnbilledChargesOption | "none";
  /** Pending charges found (not the number invoiced — `delete` bills none of them). */
  count: number;
  lines: EstimateLine[];
  subtotal_minor: number;
  /** `invoice` only — `delete` and `none` raise no invoice, so they carry no tax. */
  tax_minor: number;
  /** NET of `promotional_discount_minor`, exactly as `serializeInvoice` reports it. */
  total_minor: number;
  /** POST-tax buckets only (refundable + excess) — see `Estimate.credits_applied_minor`. */
  credits_applied_minor: number;
  /** The pre-tax promotional slice, already subtracted from `total_minor`. */
  promotional_discount_minor: number;
  /** What the resulting invoice would be left owing (it is raised OPEN, not collected). */
  amount_due_minor: number;
  /** `delete` only: the amount that would be thrown away, never billed. */
  discarded_minor: number;
}

/** What the credit for the unused part of the term would do. */
export interface CancellationCreditPreview {
  credit_option: CreditOptionForTerm;
  /**
   * How the credit is delivered — decided by whether the term invoice is still open:
   *  - `adjustment` — unpaid term: reduces what is still owed on that invoice,
   *  - `split`      — paid term: bucket-funded slices go back to their buckets and
   *                   only the cash-funded slice becomes a refundable credit note,
   *  - `none`       — no credit at all (option `none`, no invoice billed this term,
   *                   a zero-total invoice, or a credit that prorates to nothing).
   */
  delivery: "adjustment" | "split" | "none";
  /** The invoice the credit is computed against (the one that billed the current term). */
  invoice: string | null;
  /**
   * The same invoice by DOCUMENT number (`INV-7835`) — what a person reads on the
   * document, the PDF and the list. Null until the invoice is numbered, so a consumer
   * falls back to `invoice`. Additive; `invoice` remains the id an integrator keys on.
   */
  invoice_number: string | null;
  base_minor: number;
  /** The credit before delivery-specific caps. */
  credit_minor: number;
  adjustment_minor: number;
  promotional_restore_minor: number;
  excess_restore_minor: number;
  refundable_credit_note_minor: number;
  /** What the customer actually receives, after every cap and the idempotency check. */
  delivered_minor: number;
  /**
   * True when a prior cancellation already credited this term. The issuer returns
   * the existing credit note untouched, so THIS cancellation grants nothing further
   * — `delivered_minor` is 0 and the amounts above describe what already happened.
   */
  already_credited: boolean;
}

/** What would happen to invoices still open when the subscription is cancelled. */
export interface OpenInvoicesPreview {
  handling: ArHandling;
  /**
   * Every invoice the AR step would act on, with its due AFTER an `adjustment`
   * cancellation credit is applied — the credit is issued before this step, so
   * quoting the pre-credit due would overstate the write-off.
   *
   * Includes the invoice the `invoice` unbilled-charges option would CREATE
   * (`projected: true`): it is raised open and uncollected moments earlier, so the
   * AR step picks it up too. Non-obvious, and worth seeing before confirming —
   * `unbilled_charges_option: 'invoice'` with `write_off` bills the charges and
   * immediately writes them off.
   */
  invoices: Array<{
    invoice: string | null;
    amount_due_minor: number;
    projected?: true;
    /** `void` only: why this invoice would be left open instead (money on it, `voidBlocker`). */
    void_blocked?: string;
  }>;
  total_due_minor: number;
  /** `write_off` only: what would be written off (a real revenue write-down). */
  write_off_minor: number;
  /**
   * `void` only: what would be voided — the invoice withdrawn as though it never stood.
   *
   * Its own field rather than sharing `write_off_minor`, because the two are different
   * events: a write-off keeps the invoice and records the loss, a void withdraws it. A
   * caller adding them together to show "cleared" would be adding two things that mean
   * opposite things about whether the revenue was ever owed.
   *
   * Counts EVERY invoice the step would act on, not only the ones with an amount due —
   * a posted invoice with nothing left due is still voided, and reporting 0 for it would
   * understate what confirming does.
   */
  void_minor: number;
  /** `schedule_payment_collection` only: what we would try to charge right now. */
  collect_minor: number;
  /**
   * Set when the largest single collection attempt exceeds the instrument's mandate
   * ceiling — the debit is refused before it reaches the gateway. Per-invoice
   * because each invoice is its own debit against a PER-DEBIT ceiling.
   */
  mandate_shortfall?: MandateShortfall;
}

/** What would happen to the customer's refundable credit. */
export interface RefundableCreditsPreview {
  handling: RefundableCreditsHandling;
  /**
   * Refundable credit notes the CUSTOMER holds — deliberately not scoped to this
   * subscription, because the cancel path is not either: it refunds every refundable
   * credit note on the customer, including ones earned elsewhere.
   */
  credit_notes: Array<{ credit_note: string; available_minor: number }>;
  refund_minor: number;
  /**
   * How much of `refund_minor` is the refundable slice of the cancellation credit
   * ABOVE. The credit is issued before the refund step and matches its query, so
   * `prorate` + `schedule_refund` turns the unused term into cash back rather than
   * credit on the account. Counted once in each place on purpose: one is what is
   * granted, the other is what leaves as cash.
   */
  includes_cancellation_credit_minor: number;
}

/**
 * Preview a cancellation's money effects.
 *
 * The cancel path moves money in four ways, in this order: it invoices (or deletes)
 * pending unbilled charges, credits the unused part of the term, then handles open
 * invoices and refundable credits. Every one is irreversible on an append-only ledger
 * — a mistaken cancel needs compensating entries, not an undo — and until this existed
 * an operator picked all five options and confirmed with no idea what they would cost.
 *
 * Three things this deliberately does rather than recompute:
 *  - the option set is resolved from the SAME business defaults the cancel resolves
 *    (`default_cancel_option` and friends), so the preview describes the cancel that
 *    would actually run, not the one the caller half-specified;
 *  - the credit comes from `planCancellationCredit`, the read-only half of the issuer
 *    itself, so the preview cannot drift from the credit it predicts;
 *  - the option-set GUARDS are mirrored, so a preview refuses what the cancel refuses
 *    instead of quoting a cancellation that then 400s.
 *
 * Every figure is computed as of `effective_at` from TODAY's state. For a deferred
 * cancel that state can still change before the date arrives.
 */
export interface CancelEstimate {
  object: "cancel_estimate";
  currency: string;
  /** The option set actually previewed, business defaults filled in. */
  options: {
    cancel_option: CancelOption;
    cancel_at: string | null;
    credit_option: CreditOptionForTerm;
    unbilled_charges_option: UnbilledChargesOption | null;
    account_receivables_handling: ArHandling;
    refundable_credits_handling: RefundableCreditsHandling;
  };
  /** ISO instant the cancellation takes effect. */
  /** Null when there is no boundary to name — a cancelled trial has none (2026-08-25). */
  effective_at: string | null;
  /** False when nothing moves today because the cancellation is deferred. */
  immediate: boolean;
  unbilled_charges: UnbilledChargesPreview;
  cancellation_credit: CancellationCreditPreview;
  open_invoices: OpenInvoicesPreview;
  refundable_credits: RefundableCreditsPreview;
  /** Cash we would attempt to take from the customer. */
  net_collect_minor: number;
  /** Cash we would send back. */
  net_refund_minor: number;
  /** Non-cash credit granted to the customer. */
  net_credit_minor: number;
  /**
   * Things that will NOT happen the way the option set implies — an
   * already-credited term, money-handling options an `end_of_term` cancel ignores
   * outright, pending charges left stranded. Empty means no known discrepancy.
   */
  warnings: string[];
  /**
   * Invoices this cancellation is about to act on that still have a debit live at the
   * gateway. Absent when there are none. Covers TWO shapes since #27, and the caller
   * must not conflate them:
   *
   *  · `account_receivables_handling` in {`no_action`-clearing-nothing is not listed,
   *    only `write_off`} or a term credit — this cancellation RELIEVES the invoice,
   *    so a debit that still lands is a stranded credit, refunded automatically.
   *  · `account_receivables_handling = schedule_payment_collection` — the OPPOSITE
   *    shape. This cancellation is about to dispatch a SECOND debit against an
   *    invoice the buyer may already be paying; the risk is a double charge, not a
   *    stranded credit, and `DebitInFlight`'s "the credit note has already cleared"
   *    framing would be false of it.
   *
   * The same field, type and helper the CHANGE estimate uses (#16), because it is the
   * same race on the other lifecycle action and a second definition would drift from
   * the one the buyer is shown. See {@link DebitInFlight}. Deliberately no THIRD field
   * or a tag on `DebitInFlight` to tell the two shapes apart: `open_invoices` already
   * says which invoices `schedule_payment_collection` would collect
   * (`open_invoices.handling === 'schedule_payment_collection'` and the invoice appears
   * in `open_invoices.invoices` with `amount_due_minor > 0`) — a caller cross-references
   * that rather than being handed a second query or a second type.
   */
  debits_in_flight?: DebitInFlight[];
}

const ZERO_UNBILLED: UnbilledChargesPreview = {
  action: "none",
  count: 0,
  lines: [],
  subtotal_minor: 0,
  tax_minor: 0,
  total_minor: 0,
  credits_applied_minor: 0,
  promotional_discount_minor: 0,
  amount_due_minor: 0,
  discarded_minor: 0,
};

function noCredit(creditOption: CreditOptionForTerm): CancellationCreditPreview {
  return {
    credit_option: creditOption,
    delivery: "none",
    invoice: null,
    invoice_number: null,
    base_minor: 0,
    credit_minor: 0,
    adjustment_minor: 0,
    promotional_restore_minor: 0,
    excess_restore_minor: 0,
    refundable_credit_note_minor: 0,
    delivered_minor: 0,
    already_credited: false,
  };
}

export async function estimateCancel(input: {
  organizationId: string;
  businessId: string;
  subscriptionId: string;
  now: Date;
  cancelOption?: CancelOption;
  cancelAt?: Date;
  creditOptionForCurrentTermCharges?: CreditOptionForTerm;
  unbilledChargesOption?: UnbilledChargesOption;
  accountReceivablesHandling?: ArHandling;
  refundableCreditsHandling?: RefundableCreditsHandling;
  /** Mirrors the cancel's `includeCancellationDayInBilling`, guards included. */
  includeCancellationDayInBilling?: boolean;
  /** Mirrors the cancel's `finalPeriod`: prices that credit option. */
  finalPeriod?: SpecificDateFinalPeriod;
  /** Mirrors the cancel's `planCreditsOnCancelAtPeriodEnd`: checked only, moves no money. */
  planCreditsOnCancelAtPeriodEnd?: PlanCreditCancelAtPeriodEnd;
}): Promise<CancelEstimate> {
  const { organizationId, businessId, now } = input;

  const ctx = await withTenant(organizationId, async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!sub) return null;
    const [cus] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, sub.customerId))
      .limit(1);
    // The same three business defaults `cancelSubscriptionWithOptions` reads (H1/SET-1).
    // Resolving them HERE rather than letting the UI offer a "business default" choice
    // is the point: the preview has to describe the cancel that will actually run.
    const [biz] = await tx
      .select({
        cancelOption: businesses.defaultCancelOption,
        creditOption: businesses.defaultCreditOptionForCancel,
        unbilled: businesses.defaultUnbilledOnCancel,
        billingRulesConfig: businesses.billingRulesConfig,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return { sub, cus, biz };
  });
  if (!ctx?.sub) throw new ProrationError("Subscription not found");
  const { sub, cus, biz } = ctx;

  const cancelOption = (input.cancelOption ??
    (biz?.cancelOption as CancelOption | undefined) ??
    "immediately") as CancelOption;
  const overrideProblem = cancelOverrideProblem({
    cancelOption,
    creditOption: input.creditOptionForCurrentTermCharges,
    finalPeriod: input.finalPeriod,
    planCreditsOnCancelAtPeriodEnd: input.planCreditsOnCancelAtPeriodEnd,
  });
  if (overrideProblem) throw new ProrationError(overrideProblem);
  // As the cancel resolves it: a specific_date cancel follows the final-period rule.
  const creditOption = (input.creditOptionForCurrentTermCharges ??
    (input.finalPeriod ? FINAL_PERIOD_CREDIT_OPTION[input.finalPeriod] : undefined) ??
    (cancelOption === "specific_date"
      ? FINAL_PERIOD_CREDIT_OPTION[
          resolveBillingRulesConfig({
            billingRulesConfig: biz?.billingRulesConfig,
            defaultCreditOptionForCancel: biz?.creditOption,
          }).specificDateCancelFinalPeriod
        ]
      : (biz?.creditOption as CreditOptionForTerm | undefined)) ??
    "none") as CreditOptionForTerm;
  // `default_unbilled_on_cancel` ships `'no_action'`, which is NOT a member of
  // UnbilledChargesOption — the cancel path casts it and then matches neither of its
  // two branches, so the charges are left pending. Normalising it to null here says
  // that outright, instead of echoing an option value the API does not accept.
  const rawUnbilled = input.unbilledChargesOption ?? biz?.unbilled ?? null;
  const unbilledOption: UnbilledChargesOption | null =
    rawUnbilled === "invoice" || rawUnbilled === "delete" ? rawUnbilled : null;
  const arHandling = input.accountReceivablesHandling ?? "no_action";
  const refundableHandling = input.refundableCreditsHandling ?? "no_action";

  // Mirror cancelSubscriptionWithOptions' guards, so a preview refuses exactly what
  // the cancel would refuse rather than quoting a cancellation that then 400s.
  if (sub.status === "cancelled") throw new ProrationError("Subscription is already cancelled");
  if (cancelOption === "end_of_term" && sub.status === "paused") {
    throw new ProrationError(
      "A paused subscription has no term end to cancel at. Resume it first, or use cancel_option=immediately or specific_date.",
    );
  }
  if (cancelOption === "specific_date") {
    if (!input.cancelAt) throw new ProrationError("cancel_option=specific_date requires cancel_at");
    if (input.cancelAt.getTime() <= now.getTime()) {
      throw new ProrationError(
        "cancel_at must be in the future. To cancel now, use cancel_option=immediately.",
      );
    }
  }

  if (input.includeCancellationDayInBilling !== undefined) {
    const problem = await cancellationDayProblem({
      organizationId,
      businessId,
      sub,
      cancelOption,
      creditOption,
      cancelAt: input.cancelAt,
    });
    if (problem) throw new ProrationError(problem);
  }

  const options: CancelEstimate["options"] = {
    cancel_option: cancelOption,
    cancel_at: cancelOption === "specific_date" ? input.cancelAt!.toISOString() : null,
    credit_option: creditOption,
    unbilled_charges_option: unbilledOption,
    account_receivables_handling: arHandling,
    refundable_credits_handling: refundableHandling,
  };
  const currency = sub.currency;
  const warnings: string[] = [];

  // `effectiveAt` is nullable because a trialling subscription has no term (2026-08-25) and
  // a cancelled trial has no boundary at all — the estimate is still real, it just has no
  // date to name.
  const zeroMoney = (effectiveAt: Date | null, immediate: boolean): CancelEstimate => ({
    object: "cancel_estimate",
    currency,
    options,
    effective_at: effectiveAt?.toISOString() ?? null,
    immediate,
    unbilled_charges: ZERO_UNBILLED,
    cancellation_credit: noCredit(creditOption),
    open_invoices: {
      handling: arHandling,
      invoices: [],
      total_due_minor: 0,
      write_off_minor: 0,
      void_minor: 0,
      collect_minor: 0,
    },
    refundable_credits: {
      handling: refundableHandling,
      credit_notes: [],
      refund_minor: 0,
      includes_cancellation_credit_minor: 0,
    },
    net_collect_minor: 0,
    net_refund_minor: 0,
    net_credit_minor: 0,
    warnings,
  });

  // A `future` sub has never started or billed: cancelling it by ANY option is a
  // cancel-before-start — terminal now, no money, no deferral.
  if (sub.status === "future") {
    warnings.push(
      "This subscription has not started, so the cancellation moves no money. We cancel it and ignore every money-handling option.",
    );
    return zeroMoney(now, true);
  }

  // `end_of_term` runs no credit, AR or refund step: it sets `cancel_at_period_end`, and at
  // term end the renewal pass cancels and raises one final invoice for the term's usage and
  // pending charges (`cancelAtTermEnd`, renewal.ts). Options the caller passed alongside it
  // are dropped, and saying so is the whole value of previewing. `invoice` is what happens
  // anyway, so only `delete` is ignored.
  if (cancelOption === "end_of_term") {
    const ignored = [
      creditOption !== "none" ? `credit_option_for_current_term_charges=${creditOption}` : null,
      unbilledOption === "delete" ? `unbilled_charges_option=${unbilledOption}` : null,
      arHandling !== "no_action" ? `account_receivables_handling=${arHandling}` : null,
      refundableHandling !== "no_action"
        ? `refundable_credits_handling=${refundableHandling}`
        : null,
    ].filter((s): s is string => s != null);
    if (ignored.length > 0) {
      warnings.push(
        `An end_of_term cancellation does no money handling other than a final invoice for the term's usage and unbilled charges. We would ignore ${ignored.join(", ")}. To apply these options, use cancel_option=specific_date with the term-end date.`,
      );
    }
    const pending = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(unbilledCharges)
        .where(
          and(eq(unbilledCharges.subscriptionId, sub.id), eq(unbilledCharges.status, "pending")),
        ),
    );
    if (pending.length > 0) {
      const total = pending.reduce((s, c) => s + c.amountMinor, 0n);
      warnings.push(
        `${pending.length} pending unbilled charge(s) totaling ${formatMoney(total, currency)} would go on a final invoice at the term end, with the term's metered usage.`,
      );
    }
    return zeroMoney(nextBillingBoundary(sub), false);
  }

  // From here: `immediately` now, or `specific_date` — which the scheduled-changes
  // pass applies AS an immediate cancel with these same carried options, so the two
  // price identically. The only difference is the instant they are priced at.
  const effectiveAt = cancelOption === "specific_date" ? input.cancelAt! : now;
  const immediate = cancelOption === "immediately";

  // ── 1) Unbilled charges ────────────────────────────────────────────────────
  const pending = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(unbilledCharges)
      .where(
        and(eq(unbilledCharges.subscriptionId, sub.id), eq(unbilledCharges.status, "pending")),
      ),
  );
  const pendingTotal = pending.reduce((s, c) => s + c.amountMinor, 0n);
  let unbilled: UnbilledChargesPreview = {
    ...ZERO_UNBILLED,
    action: unbilledOption ?? "none",
    count: pending.length,
    lines: pending.map((c) => ({
      description: c.description,
      amount_minor: Number(c.amountMinor),
    })),
    subtotal_minor: Number(pendingTotal),
  };
  if (unbilledOption === "invoice" && pending.length > 0) {
    // Mirror `invoiceUnbilledCharges` → `createInvoiceFromLines`: taxed, customer
    // credit applied, `collect: false` so it is raised OPEN. Note it passes no
    // `applyCoupons`, so these lines are list-priced — do NOT discount them here.
    // Promotional credit first and PRE-tax, as `createInvoiceFromLines` applies it —
    // it shrinks the taxable base, so quoting tax on the full pending total would
    // over-state the invoice this cancel would raise.
    const { promotional, balances } = await withTenant(organizationId, (tx) =>
      simulatePromotionalDiscount(tx, organizationId, sub.customerId, currency, pendingTotal),
    );
    const taxBase = pendingTotal - promotional;
    // A charge's price decides whether it is taxed; a charge with no price is.
    const pricedIds = [...new Set(pending.flatMap((c) => (c.priceId ? [c.priceId] : [])))];
    const untaxed = new Set(
      pricedIds.length
        ? (
            await withTenant(organizationId, (tx) =>
              tx
                .select({ id: prices.id, isTaxable: prices.isTaxable })
                .from(prices)
                .where(inArray(prices.id, pricedIds)),
            )
          ).flatMap((p) => (p.isTaxable ? [] : [p.id]))
        : [],
    );
    const { taxMinor, inclusiveTaxMinor } = await estimateTax(
      organizationId,
      businessId,
      cus,
      taxBase > 0n ? taxBase : 0n,
      taxedLineAmounts(
        pending.map((c) => c.amountMinor),
        undefined,
        pending.map((c) => !(c.priceId && untaxed.has(c.priceId))),
      ),
    );
    const total = pendingTotal - promotional + taxMinor;
    const { refundable, excess } = planCreditApplication({
      balances,
      discountedSubtotal: pendingTotal,
      postTaxRemaining: total > 0n ? total : 0n,
      limits: await loadCreditApplicationLimits({
        organizationId,
        businessId,
        subscriptionId: input.subscriptionId,
      }),
    });
    const creditApplied = refundable + excess;
    const due = total - creditApplied > 0n ? total - creditApplied : 0n;
    unbilled = {
      ...unbilled,
      tax_minor: Number(taxMinor + inclusiveTaxMinor),
      total_minor: Number(total),
      credits_applied_minor: Number(creditApplied),
      promotional_discount_minor: Number(promotional),
      amount_due_minor: Number(due),
    };
  } else if (unbilledOption === "delete") {
    unbilled = { ...unbilled, discarded_minor: Number(pendingTotal) };
  } else if (unbilledOption == null && pending.length > 0) {
    warnings.push(
      `${pending.length} pending unbilled charge(s) totaling ${formatMoney(pendingTotal, currency)} would stay on the cancelled subscription. Set unbilled_charges_option to invoice or delete them.`,
    );
  }

  // ── 2) Credit for the unused part of the term ──────────────────────────────
  // The planner is the issuer's own read half, priced at `effectiveAt` — which is
  // what a `specific_date` cancel will prorate against when it lands.
  // TERM-WIDE, not just the primary invoice: the issuer writes one note per invoice
  // that charged into this term, so previewing only the primary one under-quoted the
  // credit by every mid-term invoice's share (see planCancellationCredits).
  const plans =
    creditOption === "none"
      ? []
      : await planCancellationCredits({
          organizationId,
          businessId,
          subscription: sub,
          creditOption: creditOption as CreditOption,
          now: effectiveAt,
          ...(input.includeCancellationDayInBilling === false
            ? { excludeCancellationDay: true }
            : {}),
        });
  // The plan the SINGULAR fields describe — the first one that actually delivers, not
  // `plans[0]`. See `representativePlan`: reading the oldest plan made this object report
  // `already_credited: false` beside an `invoice` its own warning named as already
  // credited (#19, measured 2026-09-03).
  const plan = representativePlan(plans);
  let credit = noCredit(creditOption);
  if (plan) {
    // Every part already credited ⇒ this cancellation adds nothing. If ANY part is
    // fresh, credit is still delivered, so this must not be per-primary.
    const alreadyCredited = plans.every(planAlreadyCredited);
    /**
     * ⚠️ #64: SUM THE PLANS THIS CANCELLATION WILL ACT ON, not every plan for the term.
     *
     * `planDeliveredMinor` returns 0 for an already-credited plan, so `delivered_minor`
     * was right while every component beside it was summed raw — including the parts a
     * previous cancellation had already issued. The breakdown then could not reconcile
     * with its own total, and the dashboard's single-headline fallback fired to hide it.
     *
     * Measured 2026-09-04 on sub_XXXXXXXXXXXXXXXXXXXXXX01: two non-voided invoices share
     * one `period_start`, each carrying `refundable_credits_applied_minor = 966113`, so
     * the panel offered ₹19,322.26 of refundable credit against a ₹27,397.24 total —
     * ₹17,736.11 + ₹19,322.26 = ₹37,058.37, off by exactly one recycled slice.
     *
     * The all-already-credited case keeps the RAW sum on purpose: there
     * `delivered_minor` is 0 and the components are the only description of what
     * happened, which the field docs above already state.
     */
    const counted = alreadyCredited ? plans : plans.filter((p) => !planAlreadyCredited(p));
    const sum = (f: (p: (typeof plans)[number]) => bigint) =>
      counted.reduce((t, p) => t + f(p), 0n);
    credit = {
      credit_option: creditOption,
      // Singular in the response shape, so it reports the PRIMARY invoice's delivery.
      // A term can legitimately mix them (an unpaid mid-term invoice alongside a paid
      // base one); widening the field is an SDK change, so it is left alone here.
      delivery: plan.delivery,
      invoice: plan.invoicePublicId,
      /**
       * The same invoice as `invoice`, by the number a person reads. Additive: `invoice`
       * stays the public id an integrator keys on. Null when the invoice is not numbered
       * yet, so every consumer falls back to `invoice`.
       */
      invoice_number: plan.invoiceNumber ?? null,
      base_minor: Number(sum((p) => p.baseMinor)),
      credit_minor: Number(sum((p) => p.creditMinor)),
      adjustment_minor: Number(sum((p) => p.adjustmentMinor)),
      promotional_restore_minor: Number(sum((p) => p.promotionalRestoreMinor)),
      excess_restore_minor: Number(sum((p) => p.excessRestoreMinor)),
      refundable_credit_note_minor: Number(sum((p) => p.refundableCreditNoteMinor)),
      delivered_minor: Number(sum(planDeliveredMinor)),
      already_credited: alreadyCredited,
    };
    /**
     * ⚠️ THE SECOND CLAUSE IS PER-INVOICE, AND IT USED TO CLAIM SOMETHING ABOUT THE WHOLE
     * CANCELLATION. It read "this cancellation would issue no further credit" on EVERY
     * already-credited plan — true only when every plan is credited, which is exactly the
     * `alreadyCredited` case. With one fresh invoice among three, the panel showed two of
     * these above a ₹24,657.52 headline that the fresh invoice legitimately owed, and our
     * user read the number as wrong. It was not; the sentence was.
     *
     * The credit figure and these warnings are computed from the same `plans`, so they can
     * never actually disagree — which is why this was only ever a wording defect. Say what
     * is true of THIS invoice, and let `alreadyCredited` be the one that speaks for the
     * cancellation.
     */
    // NAME the invoice the credit is for, rather than counting to it. Both warnings used
    // to end "credits 1 other invoice for this term", which is true of each but does not
    // say they mean the SAME invoice — and the panel names the spent invoices while never
    // naming the one being paid, so the headline still had no visible source.
    const contributing = plans.length - plans.filter(planAlreadyCredited).length;
    /**
     * DOCUMENT NUMBERS, not public ids — `INV-7835` / `CN-3012` are what the operator sees
     * on the invoice, the credit note and the PDF, so a message naming `inv_xB5pOV…` makes
     * them go and look it up. The public id stays on `cancellation_credit.invoice` for an
     * integrator. Falls back to the id when a document is not numbered yet, because an
     * unnumbered draft would otherwise print nothing at all.
     */
    const doc = (num: string | null | undefined, publicId: string) => num ?? publicId;
    for (const p of plans.filter(planAlreadyCredited)) {
      const note = p.priorCreditNote
        ? ` (${doc(p.priorCreditNote.number, p.priorCreditNote.publicId)})`
        : "";
      warnings.push(
        `The current term of invoice ${doc(p.invoiceNumber, p.invoicePublicId)} already has a cancellation credit${note}. ` +
          (alreadyCredited
            ? "This cancellation would issue no more credit."
            : `Its share adds nothing to this cancellation, which credits ${doc(
                plan.invoiceNumber,
                plan.invoicePublicId,
              )}${contributing > 1 ? ` and ${contributing - 1} other` : ""} for this term.`),
      );
    }
  } else if (creditOption !== "none") {
    warnings.push(
      `credit_option_for_current_term_charges=${creditOption} would credit nothing. No invoice billed the current term, its total was zero, or the unused portion prorates to zero.`,
    );
  }
  // Only a still-open term invoice is reduced by an adjustment credit; a `split`
  // delivery leaves the invoice alone (it was already paid).
  //
  // PER INVOICE, read off the plans — not one summed figure attributed to one invoice.
  // `credit.adjustment_minor` is the SUM over every term invoice while `credit.invoice`
  // names only the representative one, so the old form was right only for a
  // single-invoice term, and delivered NOTHING whenever that representative plan's
  // delivery was `split`. Measured 2026-09-03 (#19): INV-7826 previewed
  // `amount_due_minor: 2218400` while the same object reported `adjustment_minor:
  // 2218400` against it, because the adjustment was attributed to the wrongly-selected
  // primary INV-5419 — `paid`, ₹0 due, and unable to absorb an adjustment at all. Both
  // figures cannot be right: this field's docblock promises the due AFTER the adjustment.
  // Fixing the selection makes today's case correct either way; reading the plans makes a
  // genuinely multi-invoice term correct too, which the summed form never was.
  const adjustmentByInvoice = new Map<string, bigint>();
  for (const p of plans) {
    if (planAlreadyCredited(p) || p.delivery !== "adjustment" || p.adjustmentMinor <= 0n) continue;
    adjustmentByInvoice.set(
      p.invoicePublicId,
      (adjustmentByInvoice.get(p.invoicePublicId) ?? 0n) + p.adjustmentMinor,
    );
  }

  // ── 3) Open invoices (AR handling) ─────────────────────────────────────────
  const open = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.subscriptionId, sub.id),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
        ),
      ),
  );
  // Cash-net, because this preview is what the AR step then ACTS on: `write_off` and
  // `schedule_payment_collection` are both sized from these figures, and both now relieve
  // or collect what is still owed (`writeOffInvoice`, `recordOfflinePayment`). Reading the
  // raw column here previewed a 5000 write-off against an invoice owing 2000 — a preview
  // that disagreed with its own booking by exactly the cash already collected, which is
  // the preview-equals-booking invariant broken by omission rather than by arithmetic.
  const { voidBlocker } =
    arHandling === "void" ? await import("@/modules/invoicing/ops") : { voidBlocker: null };
  const arInvoices: OpenInvoicesPreview["invoices"] = await Promise.all(
    open.map(async (inv) => {
      const { remainingMinor: due, blocked } = await withTenant(organizationId, async (tx) => ({
        ...(await invoiceOutstanding(tx, inv)),
        blocked: voidBlocker ? await voidBlocker(tx, inv) : null,
      }));
      // Net of the adjustment credit, which is issued BEFORE this step.
      const adjustmentApplied = adjustmentByInvoice.get(inv.publicId) ?? 0n;
      const net = due - adjustmentApplied > 0n ? due - adjustmentApplied : 0n;
      return {
        invoice: inv.publicId,
        amount_due_minor: Number(net),
        ...(blocked ? { void_blocked: blocked } : {}),
      };
    }),
  );
  // The unbilled-charges invoice is created open and uncollected just before the AR
  // step reads open invoices, so it lands in that set too.
  if (unbilled.action === "invoice" && unbilled.amount_due_minor > 0) {
    arInvoices.push({
      invoice: null,
      amount_due_minor: unbilled.amount_due_minor,
      projected: true,
    });
  }
  const totalDue = arInvoices.reduce((s, i) => s + BigInt(i.amount_due_minor), 0n);
  const payable = arInvoices.filter((i) => i.amount_due_minor > 0);
  const writeOff =
    arHandling === "write_off" ? payable.reduce((s, i) => s + BigInt(i.amount_due_minor), 0n) : 0n;
  const collect =
    arHandling === "schedule_payment_collection"
      ? payable.reduce((s, i) => s + BigInt(i.amount_due_minor), 0n)
      : 0n;
  // `arInvoices`, NOT `payable` — see `void_minor`. Voiding is about withdrawing the
  // document, so an invoice with nothing left due is still acted on, where writing one
  // off would be a no-op.
  const voided =
    arHandling === "void"
      ? arInvoices
          .filter((i) => !i.void_blocked)
          .reduce((s, i) => s + BigInt(i.amount_due_minor), 0n)
      : 0n;
  // Per-DEBIT ceiling, so the test is the largest single invoice, not the sum.
  const largestDebit = payable.reduce(
    (m, i) => (BigInt(i.amount_due_minor) > m ? BigInt(i.amount_due_minor) : m),
    0n,
  );
  const shortfall =
    arHandling === "schedule_payment_collection"
      ? await mandateShortfallFor(organizationId, businessId, sub, largestDebit)
      : null;
  const openInvoices: OpenInvoicesPreview = {
    handling: arHandling,
    invoices: arInvoices,
    total_due_minor: Number(totalDue),
    write_off_minor: Number(writeOff),
    void_minor: Number(voided),
    collect_minor: Number(collect),
    ...(shortfall ? { mandate_shortfall: shortfall } : {}),
  };
  if (arHandling === "no_action" && totalDue > 0n) {
    warnings.push(
      `${payable.length} invoice(s) totaling ${formatMoney(totalDue, currency)} would stay open after cancellation. Dunning continues on them unless you write them off or collect them.`,
    );
  }

  // ── 4) Refundable credits ──────────────────────────────────────────────────
  const heldCns = await withTenant(organizationId, (tx) =>
    tx
      .select({
        publicId: creditNotes.publicId,
        totalMinor: creditNotes.totalMinor,
        allocatedMinor: creditNotes.allocatedMinor,
        refundedMinor: creditNotes.refundedMinor,
        status: creditNotes.status,
      })
      .from(creditNotes)
      .where(and(eq(creditNotes.customerId, sub.customerId), eq(creditNotes.kind, "refundable"))),
  );
  const refundable = heldCns
    .map((cn) => ({
      credit_note: cn.publicId,
      available: creditNoteSpendable(cn),
      status: cn.status,
    }))
    .filter((cn) => cn.status !== "voided" && cn.available > 0n);
  // The refundable slice of the cancellation credit is minted in step 2, before this
  // step, and matches its query — so `schedule_refund` refunds it too.
  const newRefundableCn =
    !credit.already_credited && credit.delivery === "split"
      ? BigInt(credit.refundable_credit_note_minor)
      : 0n;
  const existingAvailable = refundable.reduce((s, cn) => s + cn.available, 0n);
  const refundTotal =
    refundableHandling === "schedule_refund" ? existingAvailable + newRefundableCn : 0n;
  const refundableCredits: RefundableCreditsPreview = {
    handling: refundableHandling,
    credit_notes: refundable.map((cn) => ({
      credit_note: cn.credit_note,
      available_minor: Number(cn.available),
    })),
    refund_minor: Number(refundTotal),
    includes_cancellation_credit_minor:
      refundableHandling === "schedule_refund" ? Number(newRefundableCn) : 0,
  };
  if (refundableHandling === "schedule_refund" && newRefundableCn > 0n) {
    warnings.push(
      `We would refund the ${formatMoney(newRefundableCn, currency)} cancellation credit as CASH. It would not stay on the account, because refundable_credits_handling=schedule_refund refunds every refundable credit note the customer holds.`,
    );
  }

  const est: CancelEstimate = {
    object: "cancel_estimate",
    currency,
    options,
    effective_at: effectiveAt?.toISOString() ?? null,
    immediate,
    unbilled_charges: unbilled,
    cancellation_credit: credit,
    open_invoices: openInvoices,
    refundable_credits: refundableCredits,
    net_collect_minor: Number(collect),
    net_refund_minor: Number(refundTotal),
    net_credit_minor: credit.delivered_minor,
    warnings,
  };

  /**
   * ── Which invoices carry a debit still live at the gateway (#22, #27) ──
   *
   * Measured 2026-09-03 17:47: a ₹22,184.00 checkout was live on INV-7826 (intent
   * `pi_XXXXXXXXXXXXXXXXXXXXXX02`), the subscription was cancelled ten seconds later —
   * adjustment CN-3010 plus refundable CN-3011, invoice `paid` — and the buyer then
   * finished their bank's step. Nothing warned the operator at any point, because
   * `debits_in_flight` reached the CHANGE estimate alone: #16's brief said "the change
   * screen" and the cancel path was never in scope. Same race, same fix, same helper.
   *
   * Attached after the response object rather than inside it, like the mandate shortfall
   * on the change side, and through the SHARED `pendingPaymentsForInvoices` rather than a
   * local query: that function owns what counts as in flight and the portal reads the
   * same answer.
   *
   * The `relieved` set is what this cancellation CLEARS, which is two things:
   *  · every term invoice a FRESH credit plan actually delivers against — an
   *    already-credited plan clears nothing now, and a plan delivering 0 clears nothing
   *    at all, so warning on either would be noise;
   *  · every open invoice a `write_off` would relieve, because relieving a debt whose
   *    payment is in flight is the identical exposure and the more destructive of the
   *    two. Excluding it would warn less on the stronger action.
   *
   * ── #27: `schedule_payment_collection` is the OPPOSITE shape ──
   *
   * Filed by C3 rather than guessed at when it built #22: every other AR handling
   * CLEARS a debt, so #22's "the money can still arrive afterwards and is refunded
   * automatically" is true of them. Choosing to COLLECT while a debit is already live
   * on the same invoice is not a clearing at all — it is a SECOND debit dispatched
   * against a debt the buyer may be actively paying, and the failure mode is a double
   * charge, not a stranded credit. Tracked in its own map, `collecting`, so the two
   * risks are never collapsed into one id → label lookup; a public id can appear in at
   * most one of the two maps in practice, because `netDueByPublicId` is already NET of
   * any credit this cancellation issued, so a term invoice a fresh plan clears reads
   * 0 due and never enters `collecting`.
   */
  const relieved = new Map<string, string>();
  for (const p of plans) {
    if (planAlreadyCredited(p) || planDeliveredMinor(p) <= 0n) continue;
    relieved.set(p.invoiceId, p.invoicePublicId);
  }
  const netDueByPublicId = new Map(arInvoices.map((i) => [i.invoice, i.amount_due_minor]));
  if (arHandling === "write_off") {
    for (const inv of open) {
      if ((netDueByPublicId.get(inv.publicId) ?? 0) > 0) relieved.set(inv.id, inv.publicId);
    }
  }
  const collecting = new Map<string, string>();
  if (arHandling === "schedule_payment_collection") {
    for (const inv of open) {
      if ((netDueByPublicId.get(inv.publicId) ?? 0) > 0) collecting.set(inv.id, inv.publicId);
    }
  }
  if (relieved.size === 0 && collecting.size === 0) return est;
  const candidates = new Map([...relieved, ...collecting]);
  const inFlight = await pendingPaymentsForInvoices(
    organizationId,
    [...candidates.keys()],
    // A buyer's checkout is the whole point: it is the only shape with no `payments` row,
    // so it is the only shape the first cut of this warning could not see. INV-7826 is
    // the measurement — see `DebitInFlight`.
    { includeIntents: true },
  );
  const debits: DebitInFlight[] = [...candidates.entries()]
    .filter(([id]) => inFlight.has(id))
    .map(([id, label]) => ({
      invoice: label,
      awaiting_buyer: inFlight.get(id)!.awaitingAuthentication,
      kind: inFlight.get(id)!.kind,
    }));
  return debits.length > 0 ? { ...est, debits_in_flight: debits } : est;
}
