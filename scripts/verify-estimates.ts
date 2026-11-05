/**
 * Estimates API (Phase 8) — dry-run previews match the real thing:
 *  - estimateChange previews an upgrade's proration/total; applying the same
 *    change (same `now`) produces the same invoice total — and writes nothing,
 *  - estimateNewSubscription previews a new sub's first invoice = the billed total.
 *  - estimateCancel previews all four money effects of a cancellation, and each one
 *    matches what `cancelSubscriptionWithOptions` then actually does.
 *
 *   pnpm verify:estimates
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setDifferentialPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscriptionWithOptions,
  reactivateSubscriptionWithOptions,
} from "@/modules/subscriptions/service";
import { changeSubscription, ProrationError } from "@/modules/subscriptions/proration";
import {
  estimateCancel,
  estimateChange,
  estimateNewSubscription,
  estimateReactivate,
  type Estimate,
} from "@/modules/subscriptions/estimate";
import { createFlatTaxRate, configureIndiaGst, taxComponentLabel } from "@/modules/tax/service";
import { bucketBalancesForCurrency } from "@/modules/customers/balances-read";
import { loadGeoReference } from "@/platform/geo";
import { addPromotionalCredits } from "@/modules/customers/balances";
import {
  createCoupon,
  applyCouponToSubscription,
  applyManualDiscount,
  removeDiscount,
} from "@/modules/coupons/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  issueRefundableCreditNote,
  creditableCapacityForInvoice,
  refundableCapacityForInvoice,
} from "@/modules/credit-notes/service";
import { createInvoiceFromLines } from "@/modules/invoicing/service";
import { serializeInvoice } from "@/modules/invoicing/serialize";
import {
  addAdHocCharges,
  addSubscriptionItem,
  removeSubscriptionItem,
} from "@/modules/subscriptions/items";
import { issueProratedCreditForUnusedTerm } from "@/modules/subscriptions/cancellation-credit";
import {
  invoices,
  invoiceLineItems,
  invoiceLineDiscounts,
  payments,
  creditNotes,
  ledgerEntries,
  unbilledCharges,
  appliedTaxes,
  businesses,
  subscriptions,
  subscriptionItems,
  paymentIntents,
  appliedCoupons,
  events,
} from "@db/schema";
import type { PriceSnapshot } from "@/modules/catalog/pricing";

const org = await createOrganization({ name: "Estimate Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };

/**
 * The DOCUMENT's total, not the raw column — an estimate previews what the customer
 * will SEE. On a promo-funded invoice these are different numbers: the promotional
 * slice is a PRE-TAX discount on the document, so `serializeInvoice().total_minor` is
 * net of it while `invoices.total_minor` is not (30fcbd6, d167b8e). Every case below
 * happens to be promo-free, so comparing against the column passed — and would have
 * failed spuriously the first time a promo case was added here.
 */
async function docOf(invoiceId: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    if (!row) throw new Error(`invoice ${invoiceId} not found`);
    const lines = await tx
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, row.id));
    const shares = await tx
      .select()
      .from(invoiceLineDiscounts)
      .where(eq(invoiceLineDiscounts.invoiceId, row.id));
    const pays = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, row.id), eq(payments.status, "succeeded")));
    return serializeInvoice(row, {
      lines: lines.map((l) => ({ line: l, price: null })),
      discountShares: shares,
      paidMinor: pays.reduce((sum, pay) => sum + pay.amountMinor, 0n),
    });
  });
}

const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
// per_unit so quantity changes actually re-rate (flat would ignore quantity).
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

const checks: Array<[string, boolean]> = [];

/**
 * THE TWO IDENTITIES THAT KEEP THE LADDER HONEST.
 *
 *   1. `invoice total − credit applied here − balance applied = amount due` (floored at 0)
 *      — the ladder the storefront and both operator surfaces render.
 *   2. `gross note = appliedHere + refundableAdded + toOpenInvoices + returnedToBuckets +
 *      stranded` — every minor unit of the note lands somewhere NAMED.
 *
 * ⚠ (2) IS THE ONE THAT BITES; (1) is weaker than it looks. `amount_due_minor` is floored at
 * 0, so on any shape where the credit outruns the invoice the floor absorbs an overstated
 * credit and (1) passes anyway — measured: the naive derivation over-quotes the downgrade by
 * 88736 and (1) still goes green. Keep it for the sign/floor errors it does catch, but (2) is
 * what makes a wrong split impossible to ship.
 *
 * (2) exists because of a specific near-miss. The
 * tempting client-side derivation `credit_note_total − credit_applied_to_open_invoices`
 * equals `credit_applied_to_this_invoice` EXACTLY on the unpaid-term shape everything was
 * debugged against — the other three legs are all 0 there — and is wrong the moment any of
 * them is not. Two of them (`stranded`, and the distribution's `unplaced`) were not reported
 * at all until 2026-08-31, so no caller could have got it right even in principle. Applied to
 * every fixture that issues a note, so a shape where the legs diverge cannot slip through by
 * only ever being checked on the shape where they coincide.
 */
const creditLegsAccountForTheNote = (label: string, est: Estimate) => {
  /**
   * ── THE NOTE'S **GROSS**, WHICH IS NO LONGER ITS TOTAL (2026-09-01) ─────────────
   *
   * This read `credit_note_total_minor` alone, back when that field carried the gross.
   * It now carries the note's PRINTED TOTAL, because a slice returned to the promotional
   * or excess bucket is a DISCOUNT ROW on the note in our own booking
   * (`total = sub_total − discounts + tax`) — see the field's docblock. So the
   * gross the legs must account for is the total PLUS that slice.
   *
   * Not a widened assertion: it is the same identity on the same money, and it RESTORES
   * coverage the definition change would otherwise have dropped in silence. The
   * `promo-funded` fixture below funds its whole term from the bucket, so every unit of
   * its credit goes back there and the printed total is 0 — with the old expression this
   * helper returned early and the one fixture built to exercise a non-zero bucket leg
   * stopped checking the identity at all, while still reporting PASS.
   */
  const gross = (est.credit_note_total_minor ?? 0) + (est.credit_returned_to_buckets_minor ?? 0);
  if (gross === 0) return;
  /**
   * ── THE HALF THAT CAN STILL FAIL (2026-09-01) ───────────────────────────────────
   *
   * The leg-sum identity below no longer catches what it used to. `credit_stranded_minor`
   * is now DERIVED as `note − the other four legs`, which fixed a real double-count and, as
   * a side effect, made `Σ legs == note` true by construction whenever the residual is ≥ 0.
   * So an UNDER-claiming routing, which used to break the sum loudly, is now silently
   * absorbed by the stranded leg.
   *
   * `credit_routing_over_claimed_minor` is the replacement signal, and asserting it ABSENT is
   * the whole point — a diagnostic field nobody checks is not a gate. It covers the OVER-claim
   * direction only. The under-claim direction has no invariant field: the obvious one (per-share
   * conservation) compares PRE-TAX shares against GROSS routing components and so measures the
   * tax gross-up rather than conservation — see the note on that field in `estimate.ts`. Until a
   * fixture exists that makes a leg under-claim, that direction is a known blind spot.
   */

  const here = est.credit_applied_to_this_invoice_minor ?? 0;
  const added = est.refundable_credit_added_minor ?? 0;
  const toOpen = est.credit_applied_to_open_invoices_minor ?? 0;
  const buckets = est.credit_returned_to_buckets_minor ?? 0;
  const stranded = est.credit_stranded_minor ?? 0;
  // The invoice's OWN total, reported by the engine. Deliberately not reconstructed here:
  // `subtotal_minor` is net of the credit lines (negative on a downgrade) and `total_minor`
  // is already net of the credit applied — so any local arithmetic would be derived from the
  // very field under test, and the identity would pass by construction.
  const invoiceTotal = est.invoice_total_minor ?? 0;
  const balance = est.credits_applied_minor ?? 0;
  const due = est.amount_due_minor ?? 0;
  console.log(
    `${label} credit legs: gross=${gross} here=${here} added=${added} toOpen=${toOpen}` +
      ` buckets=${buckets} stranded=${stranded} · invoiceTotal=${invoiceTotal}` +
      ` balance=${balance} due=${due}`,
  );
  // The prose reads these, so they carry the same burden as the scalars: every slice named,
  // typed, and — for an adjustment — attached to a document the customer can look up.
  const dests = est.credit_destinations ?? [];
  const destSum = dests.reduce((n, d) => n + d.amount_minor, 0);
  console.log(`${label} destinations: ${JSON.stringify(dests)}`);
  checks.push(
    [
      `${label}: the note's five legs account for all of it, nothing unnamed`,
      here + added + toOpen + buckets + stranded === gross,
    ],
    // The two below are the half of that identity that CAN still fail — see the note at the
    // top of this helper. Asserting them ABSENT is the point; a diagnostic field nobody
    // checks is not a gate.
    [
      `${label}: …and claimed no more than the note is worth`,
      est.credit_routing_over_claimed_minor === undefined,
    ],
    [`${label}: the destination entries sum to the gross note`, destSum === gross],
    [
      `${label}: every adjustment names the invoice it cancelled, by a printed number`,
      dests
        .filter((d) => d.kind === "adjustment")
        .every((d) => typeof d.invoice === "string" && d.invoice.length > 0),
    ],
    [
      `${label}: the adjustment entries total the open-invoice leg`,
      dests.filter((d) => d.kind === "adjustment").reduce((n, d) => n + d.amount_minor, 0) ===
        toOpen,
    ],
    [
      `${label}: the credited period is stated`,
      typeof est.credited_period_start === "string" &&
        typeof est.credited_period_end === "string" &&
        Date.parse(est.credited_period_end) > Date.parse(est.credited_period_start),
    ],
    [
      `${label}: the charges table adds up (subtotal + tax == invoice total)`,
      (est.invoice_subtotal_minor ?? 0) + est.tax_minor === invoiceTotal,
    ],
    [
      `${label}: invoice total − credit applied − balance applied == amount due`,
      Math.max(invoiceTotal - here - balance, 0) === due,
    ],
  );
};

// 1) estimateChange == actual proration, and the estimate writes nothing.
{
  const customer = await createCustomer({ ...ctx, email: "est@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const item = items[0]!;
  const invoicesBefore = await withTenant(
    orgId,
    async (tx) => (await tx.select({ n: sql<number>`count(*)` }).from(invoices))[0]!.n,
  );
  const now = new Date();
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: item.publicId, newQuantity: 3 }],
  });
  const invoicesAfterEstimate = await withTenant(
    orgId,
    async (tx) => (await tx.select({ n: sql<number>`count(*)` }).from(invoices))[0]!.n,
  );
  // Apply the same change at the same instant → totals must match.
  const { prorationInvoice } = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: item.publicId, newQuantity: 3 }],
    invoiceImmediately: true,
  });
  const appliedDoc = prorationInvoice ? await docOf(prorationInvoice.id) : null;
  console.log(
    `estimate change: est.total=${est.total_minor} immediate=${est.immediate_charge}; applied invoice=${appliedDoc ? appliedDoc.total_minor : "none"}`,
  );
  checks.push(
    ["estimate is an upgrade (immediate charge)", est.immediate_charge && est.total_minor > 0],
    ["estimate wrote no invoice", Number(invoicesAfterEstimate) === Number(invoicesBefore)],
    [
      "estimate total == applied proration total",
      !!appliedDoc && est.total_minor === appliedDoc.total_minor,
    ],
  );
}

// 2) estimateNewSubscription == billed first invoice.
{
  const customer = await createCustomer({ ...ctx, email: "estnew@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const est = await estimateNewSubscription({
    ...ctx,
    customerId: customer.id,
    items: [{ price, quantity: 2 }],
    now: new Date(),
  });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 2 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const doc = await docOf(invoice.id);
  console.log(`estimate new: est.total=${est.total_minor} (exp 2000), billed=${doc.total_minor}`);
  checks.push(
    ["new-sub estimate = 2×$10 = 2000", est.total_minor === 2000],
    ["new-sub estimate == billed total", est.total_minor === doc.total_minor],
  );
}

// 2b) A SIGNUP COUPON is priced by the estimate, and priced the SAME as the invoice.
//
//     `estimateNewSubscription` accepted a coupon argument and ignored it, and the
//     route parsed `coupon_ids` and dropped it, so the rail quoted list price while the
//     line list beside it already showed a discount. It was wrong twice over: tax was
//     computed on the UNDISCOUNTED subtotal too, though the invoice taxes the discounted
//     one (`invoicing/service.ts`: "Tax: computed on the DISCOUNTED subtotal").
//
//     Asserted against the billed invoice rather than a hand-computed figure, because the
//     figure that matters is the one the customer is charged.
{
  const customer = await createCustomer({ ...ctx, email: "estcoupon@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  await createCoupon({
    ...ctx,
    code: "EST20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "once",
  });
  const items = [{ price, quantity: 2 }];
  const est = await estimateNewSubscription({
    ...ctx,
    customerId: customer.id,
    items,
    couponCodes: ["EST20"],
    now: new Date(),
  });
  // Same order the create route uses: subscription first, coupon at signup, then bill —
  // so `peekDiscounts` sees it when the first invoice is planned.
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items,
  });
  await applyCouponToSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    code: "EST20",
    now: new Date(),
    atSignup: true,
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const doc = await docOf(invoice.id);
  console.log(
    `estimate coupon: sub=${est.subtotal_minor} disc=${est.discount_minor} total=${est.total_minor}, billed=${doc.total_minor}`,
  );
  checks.push(
    ["coupon estimate: subtotal stays GROSS (2×$10)", est.subtotal_minor === 2000],
    ["coupon estimate: 20% of 2000 is reported as the discount", est.discount_minor === 400],
    ["coupon estimate: total is net of it", est.total_minor === 1600],
    ["coupon estimate == billed total", est.total_minor === doc.total_minor],
    // The document's own document-level discount, which is the role `discount_minor`
    // plays on an estimate (subtotal stays GROSS, the discount is applied TO it).
    [
      "coupon estimate: discount matches the invoice",
      est.discount_minor === (doc.document_level_discount_minor ?? 0),
    ],
  );
}

// 2b2) A signup MANUAL discount (no coupon object) is priced the same way.
//
//      This one used to be applied by a SECOND call after create — by which point the
//      first invoice had already been raised and charged at full price, so the discount
//      an operator set at signup only reached the NEXT renewal, and a failure surfaced as
//      a warning beside a success banner. A create-time discount belongs on the FIRST
//      invoice (sub_total 700 → discount 175 → total 525), which is what `discount` on
//      createSubBody now does.
{
  const customer = await createCustomer({ ...ctx, email: "estmanual@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const items = [{ price, quantity: 2 }];
  const est = await estimateNewSubscription({
    ...ctx,
    customerId: customer.id,
    items,
    manualDiscount: { kind: "percentage", percentOffBps: 2500 },
    now: new Date(),
  });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items,
  });
  await applyManualDiscount({
    ...ctx,
    subscriptionId: subscription.id,
    kind: "percentage",
    percentOffBps: 2500,
    durationType: "forever",
    now: new Date(),
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const doc = await docOf(invoice.id);
  console.log(
    `estimate manual: disc=${est.discount_minor} total=${est.total_minor}, billed=${doc.total_minor}`,
  );
  checks.push(
    ["manual-discount estimate: 25% of 2000 reported", est.discount_minor === 500],
    ["manual-discount estimate: total is net of it", est.total_minor === 1500],
    ["manual-discount estimate == billed total", est.total_minor === doc.total_minor],
  );
}

// 2c) An UNKNOWN code previews as no discount rather than throwing — the create call is
//     where a bad code must refuse (it 400s). A preview that 500s on a typo is worse
//     than one that shows nothing for it.
{
  const customer = await createCustomer({ ...ctx, email: "estbadcoupon@a.com" });
  const est = await estimateNewSubscription({
    ...ctx,
    customerId: customer.id,
    items: [{ price, quantity: 2 }],
    couponCodes: ["NOPE"],
    now: new Date(),
  });
  checks.push(
    ["unknown coupon code previews no discount", est.discount_minor === 0],
    ["unknown coupon code does not distort the total", est.total_minor === 2000],
  );
}

// 2a) CADENCE FOLDING (the divisor rule): a MONTHLY add-on on a YEARLY plan is
//     billed 12× its monthly rate, once, on the plan's cycle — a ₹475/mo add-on
//     becomes one unit at ₹5,700 on an annual period. The reverse (yearly add-on
//     on a monthly plan) stays an ERROR: the cycle would end before the item's
//     period does.
{
  const yearProduct = await createProduct({ ...ctx, name: "Annual Pro", kind: "plan" });
  const yearPrice = await createPrice({
    ...ctx,
    productId: yearProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 120000,
    interval: "year",
  });
  const seatProduct = await createProduct({ ...ctx, name: "Seats", kind: "addon" });
  const seatMonthly = await createPrice({
    ...ctx,
    productId: seatProduct.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });
  const seatYearly = await createPrice({
    ...ctx,
    productId: seatProduct.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 5000,
    interval: "year",
  });
  const customer = await createCustomer({ ...ctx, email: "estcadence@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const items = [
    { price: yearPrice, quantity: 1 },
    { price: seatMonthly, quantity: 2 },
  ];
  const est = await estimateNewSubscription({
    ...ctx,
    customerId: customer.id,
    items,
    now: new Date(),
  });
  const { subscription, items: booked } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items,
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  // 2 seats × $5.00/mo × 12 months = $120.00, folded onto the annual cycle.
  const seatLine = est.lines.find((l) => l.description.includes(seatMonthly.publicId));
  const seatSnap = booked.find((i) => i.priceId === seatMonthly.id)?.priceSnapshot as PriceSnapshot;
  const doc = await docOf(invoice.id);
  console.log(
    `cadence fold: seat line=${seatLine?.amount_minor} (exp 12000), est.total=${est.total_minor} (exp 132000), billed=${doc.total_minor}`,
  );
  console.log(
    `cadence snapshot: amount=${seatSnap?.amountMinor} (exp 6000) interval=${seatSnap?.interval} (exp year) multiple=${seatSnap?.cadenceMultiple} (exp 12)`,
  );
  checks.push(
    [
      "monthly add-on folded ×12 onto a yearly plan (2×$5×12 = 12000)",
      seatLine?.amount_minor === 12000,
    ],
    ["folded estimate total = $1200 plan + $120 seats", est.total_minor === 132000],
    ["folded estimate == billed total", est.total_minor === doc.total_minor],
    // The snapshot stores the per-UNIT rate scaled (per_unit × qty applies after).
    [
      "snapshot froze the scaled rate on the plan cycle",
      seatSnap?.amountMinor === 6000 && seatSnap?.interval === "year",
    ],
    [
      "snapshot records the multiple + original cadence",
      seatSnap?.cadenceMultiple === 12 && seatSnap?.catalogInterval === "month",
    ],
    // MRR must not inflate: $120/yr of seats = $10/mo, on top of $1200/yr = $100/mo.
    ["MRR normalizes the folded item (no 12× inflation)", Number(subscription.mrr) === 11000],
  );

  // …and the reverse is refused, on BOTH the estimate and the create.
  const c2 = await createCustomer({ ...ctx, email: "estcadencerev@a.com" });
  const monthlyPlanItems = [
    { price, quantity: 1 },
    { price: seatYearly, quantity: 1 },
  ]; // `price` is monthly
  let estRefused = "";
  try {
    await estimateNewSubscription({
      ...ctx,
      customerId: c2.id,
      items: monthlyPlanItems,
      now: new Date(),
    });
  } catch (e) {
    estRefused = (e as Error).message;
  }
  let createRefused = "";
  try {
    await createSubscription({
      ...ctx,
      customerId: c2.id,
      now: new Date(),
      items: monthlyPlanItems,
    });
  } catch (e) {
    createRefused = (e as Error).message;
  }
  console.log(
    `reverse refused: estimate="${estRefused.slice(0, 60)}…" create="${createRefused.slice(0, 60)}…"`,
  );
  checks.push(
    [
      "yearly add-on on a monthly plan is REFUSED by the estimate",
      /Billing period mismatch/.test(estRefused),
    ],
    [
      "yearly add-on on a monthly plan is REFUSED by create",
      /Billing period mismatch/.test(createRefused),
    ],
  );
}

// ── the same fold, but reached by a plan CHANGE rather than at create ────────────
// The block above covers `estimateNewSubscription`. A monthly→yearly plan CHANGE reaches
// the fold through the term-reset branch instead, and that branch did not fold at all: it
// charged the monthly add-on ONE MONTH for the whole year. Worse, only the BOOKING was
// fixed first — this suite passed throughout, because "estimate == billed" is only as good
// as the shapes it is asserted on, and there was no cadence-change shape. Measured before
// the mirror landed: preview $650, apply $1,200 on the very same call.
{
  const planProd = await createProduct({ ...ctx, name: "Swap Plan", kind: "plan" });
  const planMonthly = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const planYearly = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 60000,
    interval: "year",
  });
  const seatProd = await createProduct({ ...ctx, name: "Swap Seats", kind: "addon" });
  const seatMo = await createPrice({
    ...ctx,
    productId: seatProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });
  const cust = await createCustomer({ ...ctx, email: "estswap@a.com" });
  await vaultPaymentMethod({ ...ctx, customer: cust, token: "tok_4242" });
  const { subscription: sub, items: created } = await createSubscription({
    ...ctx,
    customerId: cust.id,
    now: new Date(),
    items: [
      { price: planMonthly, quantity: 1 },
      { price: seatMo, quantity: 10 },
    ],
  });
  const planItem = created.find((i) => i.priceId === planMonthly.id)!;
  const at = sub.currentPeriodStart!;
  const changeEst = await estimateChange({
    ...ctx,
    subscriptionId: sub.id,
    now: at,
    changes: [{ itemId: planItem.publicId, newPriceId: planYearly.publicId }],
  });
  const applied = await changeSubscription({
    ...ctx,
    subscriptionId: sub.id,
    now: at,
    changes: [{ itemId: planItem.publicId, newPriceId: planYearly.publicId }],
    invoiceImmediately: true,
  });
  const bookedTotal = applied.prorationInvoice ? Number(applied.prorationInvoice.totalMinor) : null;
  console.log(
    `cadence CHANGE: estimate=${changeEst.total_minor} booked=${bookedTotal} (exp 120000 = 60000 plan + 10×6000 seats)`,
  );
  checks.push(
    [
      "cadence change: the estimate annualises the monthly add-on (10×$60)",
      changeEst.total_minor === 120000,
    ],
    [
      "cadence change: estimate == booked total (no preview drift)",
      changeEst.total_minor === bookedTotal,
    ],
  );
}

// ── TWO-AXIS CADENCE CHANGE: plan AND add-on cadence move in ONE call ───────────
// This suite is otherwise matrix-shaped PER DIMENSION: 2a fixes the plan (monthly)
// and folds a shorter-cadence add-on; 2a's reverse fixes the plan (monthly) and
// refuses a longer-cadence add-on; the "fold via a plan CHANGE" block above moves
// the PLAN's cadence but leaves the add-on's PRICE untouched (folded ×12 onto the
// new cycle). Nobody ever moved BOTH axes in the SAME request — a plan
// monthly→yearly change that ALSO re-prices its add-on to the add-on's own yearly
// price, in one call. That combination is legal (the end state has no
// shorter-cadence item sitting on a longer cycle — every item lands exactly on the
// yearly cycle) but a `cadenceMismatch` guard that reads the subscription's cadence
// from BEFORE the whole batch of changes refuses it, because in isolation "yearly
// item, still-monthly subscription" looks exactly like the refused direction.
// `changeSubscription` (proration.ts) resolves the post-change cycle across ALL
// changes before checking any single one of them; this block pins that AND proves
// array order cannot flip the answer — the guard used to read state that a LATER
// array element was about to change.
{
  const planProd = await createProduct({ ...ctx, name: "TwoAxis Plan", kind: "plan" });
  const planMo = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const planYr = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 60000,
    interval: "year",
  });
  const seatProd = await createProduct({ ...ctx, name: "TwoAxis Seats", kind: "addon" });
  // per_unit so the change also exercises quantity, not just price.
  const seatMo = await createPrice({
    ...ctx,
    productId: seatProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 300,
    interval: "month",
  });
  const seatYr = await createPrice({
    ...ctx,
    productId: seatProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 3000,
    interval: "year",
  });
  const EXPECTED = 60000 + 4 * 3000; // 72000: plan yearly + 4 seats at the seat's OWN yearly rate (no folding involved)

  const setup = async (email: string) => {
    const customer = await createCustomer({ ...ctx, email });
    await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
    const { subscription, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: planMo, quantity: 1 },
        { price: seatMo, quantity: 4 },
      ],
    });
    const planItem = items.find((i) => i.priceId === planMo.id)!;
    const seatItem = items.find((i) => i.priceId === seatMo.id)!;
    return { subscription, planItem, seatItem };
  };

  // ── forward order: plan change listed first, add-on second ────────────────────
  const fwd = await setup("esttwoaxis-fwd@a.com");
  const fwdNow = fwd.subscription.currentPeriodStart!;
  const fwdChanges = [
    { itemId: fwd.planItem.publicId, newPriceId: planYr.publicId },
    { itemId: fwd.seatItem.publicId, newPriceId: seatYr.publicId },
  ];
  let fwdEst: Awaited<ReturnType<typeof estimateChange>> | null = null;
  let fwdEstError = "";
  try {
    fwdEst = await estimateChange({
      ...ctx,
      subscriptionId: fwd.subscription.id,
      now: fwdNow,
      changes: fwdChanges,
    });
  } catch (e) {
    fwdEstError = (e as Error).message;
  }
  let fwdBookedTotal: number | null = null;
  let fwdApplyError = "";
  try {
    const applied = await changeSubscription({
      ...ctx,
      subscriptionId: fwd.subscription.id,
      now: fwdNow,
      changes: fwdChanges,
      invoiceImmediately: true,
    });
    fwdBookedTotal = applied.prorationInvoice ? Number(applied.prorationInvoice.totalMinor) : null;
  } catch (e) {
    fwdApplyError = (e as Error).message;
  }
  console.log(
    `two-axis fwd (plan,addon): est=${fwdEst?.total_minor} (exp ${EXPECTED}) estErr="${fwdEstError}" booked=${fwdBookedTotal} applyErr="${fwdApplyError}"`,
  );
  checks.push(
    [
      "two-axis change: estimate accepts a monthly→yearly plan + monthly→yearly add-on in one call",
      !fwdEstError && !!fwdEst,
    ],
    [
      "two-axis change: estimate totals the full yearly plan + yearly add-ons",
      fwdEst?.total_minor === EXPECTED,
    ],
    ["two-axis change: apply accepts the same edit", !fwdApplyError && fwdBookedTotal != null],
    [
      "two-axis change: estimate == booked total (no preview drift)",
      fwdEst?.total_minor === fwdBookedTotal,
    ],
  );

  // ── reverse order: SAME edit, add-on listed BEFORE the plan ────────────────────
  // The latent trap: a guard that reads the subscription's CURRENT cadence (or an
  // item's OLD price) sees a different answer depending on which array element it
  // happens to process first. Same two changes, opposite order, must behave
  // identically to the forward case above.
  const rev = await setup("esttwoaxis-rev@a.com");
  const revNow = rev.subscription.currentPeriodStart!;
  const revChanges = [
    { itemId: rev.seatItem.publicId, newPriceId: seatYr.publicId },
    { itemId: rev.planItem.publicId, newPriceId: planYr.publicId },
  ];
  let revEst: Awaited<ReturnType<typeof estimateChange>> | null = null;
  let revEstError = "";
  try {
    revEst = await estimateChange({
      ...ctx,
      subscriptionId: rev.subscription.id,
      now: revNow,
      changes: revChanges,
    });
  } catch (e) {
    revEstError = (e as Error).message;
  }
  let revBookedTotal: number | null = null;
  let revApplyError = "";
  try {
    const applied = await changeSubscription({
      ...ctx,
      subscriptionId: rev.subscription.id,
      now: revNow,
      changes: revChanges,
      invoiceImmediately: true,
    });
    revBookedTotal = applied.prorationInvoice ? Number(applied.prorationInvoice.totalMinor) : null;
  } catch (e) {
    revApplyError = (e as Error).message;
  }
  console.log(
    `two-axis rev (addon,plan): est=${revEst?.total_minor} estErr="${revEstError}" booked=${revBookedTotal} applyErr="${revApplyError}"`,
  );
  checks.push(
    [
      "two-axis change: ARRAY ORDER does not matter — estimate matches the forward order",
      revEst?.total_minor === fwdEst?.total_minor && !revEstError,
    ],
    [
      "two-axis change: ARRAY ORDER does not matter — booked total matches the forward order",
      revBookedTotal === fwdBookedTotal && !revApplyError,
    ],
  );

  // ── the refusal must still hold when only ONE axis moves ───────────────────────
  // A yearly add-on on a subscription that STAYS monthly is still illegal — the
  // two-axis acceptance above must not have loosened this guard.
  const stay = await setup("esttwoaxis-refuse@a.com");
  const stayChanges = [{ itemId: stay.seatItem.publicId, newPriceId: seatYr.publicId }]; // plan NOT in this call
  let stayEstRefused = "";
  try {
    await estimateChange({
      ...ctx,
      subscriptionId: stay.subscription.id,
      now: stay.subscription.currentPeriodStart!,
      changes: stayChanges,
    });
  } catch (e) {
    stayEstRefused = (e as Error).message;
  }
  let stayApplyRefused = "";
  try {
    await changeSubscription({
      ...ctx,
      subscriptionId: stay.subscription.id,
      now: stay.subscription.currentPeriodStart!,
      changes: stayChanges,
      invoiceImmediately: true,
    });
  } catch (e) {
    stayApplyRefused = (e as Error).message;
  }
  console.log(
    `two-axis stay-monthly refusal: est="${stayEstRefused.slice(0, 60)}…" apply="${stayApplyRefused.slice(0, 60)}…"`,
  );
  checks.push(
    [
      "single-axis: a yearly add-on on a subscription that STAYS monthly is still REFUSED by the estimate",
      /Billing period mismatch/.test(stayEstRefused),
    ],
    [
      "single-axis: a yearly add-on on a subscription that STAYS monthly is still REFUSED by the apply",
      /Billing period mismatch/.test(stayApplyRefused),
    ],
  );
}

// 2b) A DIFFERENTIAL add-on requested EXPLICITLY: the estimate must charge the
//     differential, not the add-on's 0 list price. A per-plan add-on price is
//     modelled this way, so an imported catalog is all list-price-0 add-ons —
//     and the create page previewed 0.00 for a sub that then billed the real
//     amount (subscriptions/README.md, 2026-08-04). Both paths now share
//     `applyExplicitDifferentials`; this pins them together.
{
  const addonProduct = await createProduct({ ...ctx, name: "Extra Seats", kind: "addon" });
  // List price 0 — the real amount lives only in the differential.
  const addonPrice = await createPrice({
    ...ctx,
    productId: addonProduct.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 0,
    interval: "month",
  });
  await setDifferentialPrice({
    ...ctx,
    addonPublicId: addonProduct.publicId,
    planPublicId: product.publicId,
    currency: "USD",
    interval: "month",
    amountMinor: 250,
  });
  const customer = await createCustomer({ ...ctx, email: "estdiff@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const items = [
    { price, quantity: 1 },
    { price: addonPrice, quantity: 4 },
  ];
  const est = await estimateNewSubscription({
    ...ctx,
    customerId: customer.id,
    items,
    now: new Date(),
  });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items,
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const addonLine = est.lines.find((l) => l.description.includes(addonPrice.publicId));
  const doc = await docOf(invoice.id);
  console.log(
    `estimate differential addon: est.total=${est.total_minor} (exp 2000), addon line=${addonLine?.amount_minor} (exp 1000), billed=${doc.total_minor}`,
  );
  checks.push(
    ["explicit differential add-on priced at 4×$2.50, not 0", addonLine?.amount_minor === 1000],
    ["differential estimate total = $10 plan + $10 add-on", est.total_minor === 2000],
    ["differential estimate == billed total", est.total_minor === doc.total_minor],
  );

  // An explicit unit_price_minor still WINS over the differential (create's rule).
  const c2 = await createCustomer({ ...ctx, email: "estdiffovr@a.com" });
  await vaultPaymentMethod({ ...ctx, customer: c2, token: "tok_4242" });
  const ovrItems = [
    { price, quantity: 1 },
    { price: addonPrice, quantity: 4, customAmountMinor: 100 },
  ];
  const estOvr = await estimateNewSubscription({
    ...ctx,
    customerId: c2.id,
    items: ovrItems,
    now: new Date(),
  });
  const { subscription: subOvr } = await createSubscription({
    ...ctx,
    customerId: c2.id,
    now: new Date(),
    items: ovrItems,
  });
  const { invoice: invOvr } = await billSubscriptionPeriod({
    ...ctx,
    subscription: subOvr,
    periodStart: subOvr.currentPeriodStart!,
    periodEnd: subOvr.currentPeriodEnd!,
  });
  console.log(
    `estimate override-beats-differential: est.total=${estOvr.total_minor} (exp 1400), billed=${Number(invOvr.totalMinor)}`,
  );
  checks.push(
    ["explicit override beats the differential (4×$1 not 4×$2.50)", estOvr.total_minor === 1400],
    ["override estimate == billed total", estOvr.total_minor === Number(invOvr.totalMinor)],
  );
}

// 3) estimateChange for a PLAN SWAP (term reset) == the actual booking.
//    A swap to a different plan term-resets: charge full new + credit the unused
//    old term. On these unbilled test subs changeSubscription books the credit as
//    net lines, so the proration-invoice total equals the estimate's net total.
{
  const product2 = await createProduct({ ...ctx, name: "Pro2", kind: "plan" });
  const priceB = await createPrice({
    ...ctx,
    productId: product2.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 3000,
    interval: "month",
  });
  const customer = await createCustomer({ ...ctx, email: "estswap@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const item = items[0]!;
  const now = new Date();
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: item.publicId, newPriceId: priceB.publicId }],
  });
  const { prorationInvoice } = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now,
    changes: [{ itemId: item.publicId, newPriceId: priceB.publicId }],
    invoiceImmediately: true,
  });
  const swapDoc = prorationInvoice ? await docOf(prorationInvoice.id) : null;
  console.log(
    `estimate swap: est.total=${est.total_minor}; applied invoice=${swapDoc ? swapDoc.total_minor : "none"}`,
  );
  checks.push([
    "plan-swap estimate == applied booking",
    !!swapDoc && est.total_minor === swapDoc.total_minor,
  ]);
}

// ─── 4) CANCEL ESTIMATES (cancel_subscription_estimate) ──────────────────────
// The property under test throughout: what the estimate says is what the cancel
// then does. Each case previews, then cancels for real, then compares.

/** Row counts across every table a cancellation could write to — for "wrote nothing". */
const moneyRowCounts = async () =>
  withTenant(orgId, async (tx) => ({
    invoices: Number((await tx.select({ n: sql<number>`count(*)` }).from(invoices))[0]!.n),
    creditNotes: Number((await tx.select({ n: sql<number>`count(*)` }).from(creditNotes))[0]!.n),
    ledger: Number((await tx.select({ n: sql<number>`count(*)` }).from(ledgerEntries))[0]!.n),
    unbilled: Number((await tx.select({ n: sql<number>`count(*)` }).from(unbilledCharges))[0]!.n),
  }));

// 4a) UNPAID term + prorate → an ADJUSTMENT credit note. The estimate's
//     adjustment_minor must equal the credit note the cancel actually issues, and
//     estimating must write nothing at all.
{
  // No payment method → the term invoice is raised and stays OPEN.
  const customer = await createCustomer({ ...ctx, email: "cancel-unpaid@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const before = await moneyRowCounts();
  const est = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  const after = await moneyRowCounts();
  const wroteNothing = JSON.stringify(before) === JSON.stringify(after);
  const { creditNote } = await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  const issued = creditNote
    ? await withTenant(
        orgId,
        async (tx) =>
          (
            await tx.select().from(creditNotes).where(eq(creditNotes.publicId, creditNote)).limit(1)
          )[0]!,
      )
    : null;
  console.log(
    `cancel/unpaid: delivery=${est.cancellation_credit.delivery} est.adjustment=${est.cancellation_credit.adjustment_minor} issued=${issued ? Number(issued.totalMinor) : "none"} net_credit=${est.net_credit_minor}`,
  );
  checks.push(
    [
      "cancel estimate: unpaid term → adjustment delivery",
      est.cancellation_credit.delivery === "adjustment",
    ],
    ["cancel estimate: wrote nothing (invoices/CNs/ledger/unbilled)", wroteNothing],
    [
      "cancel estimate: adjustment_minor == credit note actually issued",
      !!issued && est.cancellation_credit.adjustment_minor === Number(issued.totalMinor),
    ],
    [
      "cancel estimate: net_credit_minor == delivered credit",
      est.net_credit_minor === est.cancellation_credit.delivered_minor,
    ],
    ["cancel estimate: immediate cancel is flagged immediate", est.immediate === true],
  );
}

// 4b) PAID term + prorate → the SPLIT delivery: the cash-funded slice becomes a
//     refundable credit note. Estimate's refundable_credit_note_minor == what is minted.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-paid@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const est = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  /**
   * THE CANCELLATION'S OWN CREDIT IS REFUNDABLE, WITH NO PRIOR BALANCE.
   *
   * This is the invariant the cancel dialog's refundable-credits row depends on. That row
   * was gated on the customer's CURRENT refundable balance, so a cancellation that MINTS
   * refundable credit hid the only control deciding whether it leaves as cash — measured
   * on the real book at ₹26,484.00 with the row absent, while the engine was willing to
   * refund exactly that. `credit_notes: []` below is the precondition that makes the
   * point: the customer holds nothing yet, and `refund_minor` is non-zero anyway.
   */
  const refundNow = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    refundableCreditsHandling: "schedule_refund",
  });
  console.log(
    `cancel/paid-refund: held=${refundNow.refundable_credits.credit_notes.length} refund=${refundNow.refundable_credits.refund_minor} of_which_cancellation=${refundNow.refundable_credits.includes_cancellation_credit_minor}`,
  );
  checks.push(
    [
      "cancel estimate: the customer holds no refundable credit before this cancel",
      refundNow.refundable_credits.credit_notes.length === 0,
    ],
    [
      "cancel estimate: schedule_refund refunds the credit THIS cancel creates",
      refundNow.refundable_credits.refund_minor ===
        est.cancellation_credit.refundable_credit_note_minor &&
        refundNow.refundable_credits.refund_minor > 0,
    ],
    [
      "cancel estimate: …and attributes it to the cancellation credit",
      refundNow.refundable_credits.includes_cancellation_credit_minor ===
        refundNow.refundable_credits.refund_minor,
    ],
    // The counterpart: with `no_action` that credit stays on the account. Both directions
    // asserted, so neither can silently become the only behaviour.
    [
      "cancel estimate: no_action leaves that credit on the account",
      est.refundable_credits.refund_minor === 0 && est.net_credit_minor > 0,
    ],
  );

  /**
   * THE GRANTED CREDIT DECOMPOSES WITHOUT DOUBLE COUNTING.
   *
   * The cancel dialog's outcome rail leads with "what does pressing this cost", and it
   * showed the SAME money twice when the cancellation credit is refunded: once as
   * "Credited to the account" and again as "Refunded to the customer" — ₹27,397.24 in each
   * row for ₹27,397.24 actually leaving. `net_credit_minor` is credit GRANTED and
   * `net_refund_minor` includes that grant as cash, which is right for the API (the
   * `includes_cancellation_credit_minor` docblock calls the overlap deliberate) and wrong
   * for a rail.
   *
   * So the parts must account for the whole exactly once: what stays on the account, what
   * stops being owed, and what leaves as cash. The component falls back to an
   * undecomposed row if they ever fail to sum — this is what keeps that fallback from
   * becoming the normal path unnoticed.
   */
  {
    const cc = refundNow.cancellation_credit;
    const leftAsCash = refundNow.refundable_credits.includes_cancellation_credit_minor;
    const staysOnAccount = Math.max(
      0,
      cc.refundable_credit_note_minor +
        cc.promotional_restore_minor +
        cc.excess_restore_minor -
        leftAsCash,
    );
    const stopsBeingOwed = cc.delivery === "adjustment" ? cc.adjustment_minor : 0;
    console.log(
      `cancel/rail: granted=${refundNow.net_credit_minor} cash=${leftAsCash} account=${staysOnAccount} relieved=${stopsBeingOwed}`,
    );
    checks.push(
      [
        "cancel estimate: the granted credit decomposes to exactly its total",
        staysOnAccount + stopsBeingOwed + leftAsCash === refundNow.net_credit_minor,
      ],
      [
        "cancel estimate: a fully-refunded credit leaves NOTHING on the account",
        leftAsCash === refundNow.net_credit_minor && staysOnAccount === 0,
      ],
    );
  }

  const { creditNote } = await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  const issued = creditNote
    ? await withTenant(
        orgId,
        async (tx) =>
          (
            await tx.select().from(creditNotes).where(eq(creditNotes.publicId, creditNote)).limit(1)
          )[0]!,
      )
    : null;
  console.log(
    `cancel/paid: invoice=${invoice.status} delivery=${est.cancellation_credit.delivery} est.refundable_cn=${est.cancellation_credit.refundable_credit_note_minor} issued=${issued ? Number(issued.totalMinor) : "none"} kind=${issued?.kind}`,
  );
  checks.push(
    ["cancel estimate: paid term → split delivery", est.cancellation_credit.delivery === "split"],
    [
      "cancel estimate: refundable_credit_note_minor == minted refundable CN",
      !!issued &&
        est.cancellation_credit.refundable_credit_note_minor === Number(issued.totalMinor),
    ],
    ["cancel estimate: minted CN is refundable kind", issued?.kind === "refundable"],
  );
}

// 4b-mixed) A TERM WITH ONE CREDITED AND ONE FRESH INVOICE — the case that produced a
//     preview contradicting itself. Two invoices can share one `period_start` (measured on
//     the real book, #64), so a second cancellation can owe credit for the fresh one while
//     owing nothing for the credited one. `already_credited` is `plans.every(...)`, so it
//     is correctly FALSE here — but the per-invoice warning used to say "this cancellation
//     would issue no further credit" anyway, which read as the headline being wrong.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-mixed@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  const period = {
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  };
  await billSubscriptionPeriod({ ...ctx, subscription, ...period });
  const sub = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  // Credit the term, so invoice #1 is spent…
  await issueProratedCreditForUnusedTerm({
    ...ctx,
    subscription: sub,
    creditOption: "prorate",
    now: new Date(),
  });
  // …then raise a SECOND invoice into the same term, which nothing has credited.
  await billSubscriptionPeriod({ ...ctx, subscription: sub, ...period });
  const mixed = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  const spent = mixed.warnings.filter((w) => /already has a cancellation credit/.test(w));
  console.log(
    `cancel/mixed: delivered=${mixed.cancellation_credit.delivered_minor} already=${mixed.cancellation_credit.already_credited} spent_warnings=${spent.length}`,
  );
  if (spent[0]) console.log(`cancel/mixed: warning → ${spent[0]}`);
  checks.push(
    [
      "cancel estimate (mixed): a fresh invoice in a part-credited term still delivers",
      mixed.cancellation_credit.delivered_minor > 0,
    ],
    [
      "cancel estimate (mixed): already_credited is false when any part is fresh",
      mixed.cancellation_credit.already_credited === false,
    ],
    ["cancel estimate (mixed): the spent invoice is still reported", spent.length > 0],
    /**
     * THE ASSERTION THIS CASE EXISTS FOR, and it is a contradiction check rather than a
     * string match: no warning may claim the cancellation issues nothing while the
     * estimate is delivering money. That sentence is only true when EVERY part is spent.
     */
    [
      "cancel estimate (mixed): no warning contradicts a non-zero credit",
      !(
        mixed.cancellation_credit.delivered_minor > 0 &&
        mixed.warnings.some((w) => /issue no further credit/.test(w))
      ),
    ],
    /**
     * DOCUMENT NUMBERS, not public ids. An operator reads `INV-7835` on the invoice, the
     * PDF and the list; a message naming `inv_xB5pOV…` makes them go and look it up. The
     * public id stays on `cancellation_credit.invoice` for integrators, so this asserts
     * the PROSE only.
     */
    [
      "cancel estimate (mixed): warnings name documents by number, not public id",
      spent.every((w) => /\bINV-\d+/.test(w)) && !spent.some((w) => /\binv_[A-Za-z0-9]/.test(w)),
    ],
    [
      "cancel estimate (mixed): the prior credit note is named by number too",
      spent.every((w) => /\(CN-\d+\)/.test(w)) && !spent.some((w) => /\(cn_[A-Za-z0-9]/.test(w)),
    ],
    [
      "cancel estimate (mixed): the credited invoice is exposed as a number",
      typeof mixed.cancellation_credit.invoice_number === "string" &&
        /^INV-/.test(mixed.cancellation_credit.invoice_number),
    ],
  );
}

// 4c) ALREADY CREDITED: the planner's idempotency, reported. Issue the cancellation
//     credit directly, then estimate — the preview must say this cancellation grants
//     nothing further rather than promising the amount a second time.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-twice@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const first = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  const sub = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  await issueProratedCreditForUnusedTerm({
    ...ctx,
    subscription: sub,
    creditOption: "prorate",
    now: new Date(),
  });
  const second = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  console.log(
    `cancel/already-credited: first.delivered=${first.cancellation_credit.delivered_minor} second.delivered=${second.cancellation_credit.delivered_minor} already=${second.cancellation_credit.already_credited} warnings=${second.warnings.length}`,
  );
  checks.push(
    [
      "cancel estimate: first preview promised a credit",
      first.cancellation_credit.delivered_minor > 0,
    ],
    [
      "cancel estimate: already_credited detected after the credit exists",
      second.cancellation_credit.already_credited === true,
    ],
    [
      "cancel estimate: already-credited term delivers 0 further",
      second.cancellation_credit.delivered_minor === 0 && second.net_credit_minor === 0,
    ],
    [
      "cancel estimate: already-credited raises a warning",
      second.warnings.some((w) => w.includes("already has a cancellation credit")),
    ],
  );
}

// 4d) UNBILLED CHARGES + invoice: the projected invoice must match the one raised,
//     and it must show up in open_invoices as `projected` (it is created OPEN just
//     before the AR step reads open invoices — the interaction worth previewing).
{
  const customer = await createCustomer({ ...ctx, email: "cancel-unbilled@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await addAdHocCharges({
    ...ctx,
    subscriptionId: subscription.id,
    invoiceNow: false,
    now: new Date(),
    lines: [{ description: "Overage", amountMinor: 2500 }],
  });
  const est = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    unbilledChargesOption: "invoice",
    creditOptionForCurrentTermCharges: "none",
  });
  const invoicesBefore = await withTenant(
    orgId,
    async (tx) => (await tx.select({ n: sql<number>`count(*)` }).from(invoices))[0]!.n,
  );
  await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    unbilledChargesOption: "invoice",
    creditOptionForCurrentTermCharges: "none",
  });
  const raised = await withTenant(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subscription.id));
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
  });
  const invoicesAfter = await withTenant(
    orgId,
    async (tx) => (await tx.select({ n: sql<number>`count(*)` }).from(invoices))[0]!.n,
  );
  console.log(
    `cancel/unbilled: est.subtotal=${est.unbilled_charges.subtotal_minor} est.total=${est.unbilled_charges.total_minor} est.due=${est.unbilled_charges.amount_due_minor} raised total=${Number(raised.totalMinor)} projected_in_ar=${est.open_invoices.invoices.some((i) => i.projected)}`,
  );
  checks.push(
    [
      "cancel estimate: unbilled subtotal = 2500",
      est.unbilled_charges.subtotal_minor === 2500 && est.unbilled_charges.count === 1,
    ],
    [
      "cancel estimate: projected unbilled total == invoice actually raised",
      Number(invoicesAfter) > Number(invoicesBefore) &&
        est.unbilled_charges.total_minor === Number(raised.totalMinor),
    ],
    [
      "cancel estimate: projected unbilled invoice appears in open_invoices",
      est.open_invoices.invoices.some((i) => i.projected === true),
    ],
  );
}

// 4e) UNBILLED CHARGES with NO option → left stranded, and the preview says so.
//     `default_unbilled_on_cancel` ships 'no_action', which is not a valid API option
//     value; the preview must normalise it to `none`, never echo it back.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-stranded@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await addAdHocCharges({
    ...ctx,
    subscriptionId: subscription.id,
    invoiceNow: false,
    now: new Date(),
    lines: [{ description: "Overage", amountMinor: 700 }],
  });
  const est = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  console.log(
    `cancel/stranded: action=${est.unbilled_charges.action} warnings=${JSON.stringify(est.warnings)}`,
  );
  checks.push(
    [
      "cancel estimate: 'no_action' business default normalises to 'none'",
      est.unbilled_charges.action === "none",
    ],
    [
      "cancel estimate: stranded unbilled charges raise a warning",
      est.warnings.some((w) => w.includes("would stay on the cancelled subscription")),
    ],
  );
}

// 4f) END_OF_TERM runs no credit, AR or refund step (at term end renewal.ts only
//     bills usage + pending charges). Options passed alongside it are dropped, so the preview must
//     zero every effect AND name what is being ignored. This is the case where a
//     dashboard that offers credit_option next to "cancel at end of term" lies.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-eot@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const est = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "end_of_term",
    creditOptionForCurrentTermCharges: "full",
    refundableCreditsHandling: "schedule_refund",
  });
  const { creditNote } = await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "end_of_term",
    creditOptionForCurrentTermCharges: "full",
    refundableCreditsHandling: "schedule_refund",
  });
  console.log(
    `cancel/eot: immediate=${est.immediate} net_credit=${est.net_credit_minor} net_refund=${est.net_refund_minor} real creditNote=${creditNote} warnings=${est.warnings.length}`,
  );
  checks.push(
    ["cancel estimate: end_of_term is not immediate", est.immediate === false],
    [
      "cancel estimate: end_of_term moves no money",
      est.net_credit_minor === 0 && est.net_refund_minor === 0 && est.net_collect_minor === 0,
    ],
    [
      "cancel estimate: end_of_term names the ignored options",
      est.warnings.some((w) => w.includes("does no money handling") && w.includes("credit_option")),
    ],
    ["cancel estimate: real end_of_term cancel issues no credit note", creditNote === null],
    [
      "cancel estimate: effective_at is the term end",
      est.effective_at === subscription.currentPeriodEnd!.toISOString(),
    ],
  );
}

// 4g) A refundable cancellation credit under schedule_refund leaves as CASH — the
//     credit is minted before the refund step and matches its query. Both the amount
//     and the warning must say so.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-refund@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const est = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    refundableCreditsHandling: "schedule_refund",
  });
  console.log(
    `cancel/refund: refundable_cn=${est.cancellation_credit.refundable_credit_note_minor} refund_minor=${est.refundable_credits.refund_minor} includes=${est.refundable_credits.includes_cancellation_credit_minor}`,
  );
  checks.push(
    [
      "cancel estimate: refund includes the new cancellation credit",
      est.refundable_credits.includes_cancellation_credit_minor ===
        est.cancellation_credit.refundable_credit_note_minor &&
        est.refundable_credits.includes_cancellation_credit_minor > 0,
    ],
    [
      "cancel estimate: net_refund_minor covers it",
      est.net_refund_minor >= est.refundable_credits.includes_cancellation_credit_minor,
    ],
    [
      "cancel estimate: cash-not-credit is warned about",
      est.warnings.some((w) => w.includes("cancellation credit as CASH")),
    ],
  );
}

// 4h) AR handling: an open term invoice, net of the adjustment credit, is what would
//     be written off. no_action must warn that it is left to dunning instead.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-ar@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const due = Number(invoice.amountDueMinor ?? invoice.totalMinor);
  const noAction = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "none",
  });
  const writeOff = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "none",
    accountReceivablesHandling: "write_off",
  });
  // With a prorate adjustment credit the write-off shrinks by exactly the credit.
  const withCredit = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
    accountReceivablesHandling: "write_off",
  });
  console.log(
    `cancel/ar: due=${due} write_off=${writeOff.open_invoices.write_off_minor} with_credit=${withCredit.open_invoices.write_off_minor} adj=${withCredit.cancellation_credit.adjustment_minor}`,
  );
  checks.push(
    [
      "cancel estimate: no_action leaves the invoice open and warns",
      noAction.open_invoices.write_off_minor === 0 &&
        noAction.warnings.some((w) => w.includes("would stay open after cancellation")),
    ],
    [
      "cancel estimate: write_off_minor == open amount due",
      writeOff.open_invoices.write_off_minor === due,
    ],
    [
      "cancel estimate: write-off is net of the adjustment credit",
      withCredit.open_invoices.write_off_minor ===
        due - withCredit.cancellation_credit.adjustment_minor,
    ],
  );

  // ── VOID (2026-09-07) ────────────────────────────────────────────────────────
  // A fourth AR option, added late. It must not be
  // confused with the write-off above: a write-off keeps the invoice and records the
  // loss, a void withdraws it as though it never stood. Different ledger treatment,
  // different thing on the customer's statement — so they get separate fields, and
  // these checks pin that they never bleed into one another.
  const voided = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "none",
    accountReceivablesHandling: "void",
  });
  console.log(
    `cancel/ar-void: void=${voided.open_invoices.void_minor} write_off=${voided.open_invoices.write_off_minor} invoices=${voided.open_invoices.invoices.length}`,
  );
  checks.push(
    ["cancel estimate: void_minor == open amount due", voided.open_invoices.void_minor === due],
    [
      "cancel estimate: void reports the invoices it would withdraw",
      voided.open_invoices.invoices.length > 0,
    ],
    /**
     * THE ASSERTIONS THIS OPTION EXISTS FOR. Each field speaks only for its own
     * handling, so a caller cannot read a void as a write-down or vice versa — and a UI
     * that summed them would be adding two opposite claims about whether the money was
     * ever owed.
     */
    [
      "cancel estimate: void does not report a write-down",
      voided.open_invoices.write_off_minor === 0,
    ],
    ["cancel estimate: write_off does not report a void", writeOff.open_invoices.void_minor === 0],
    [
      "cancel estimate: no_action reports neither",
      noAction.open_invoices.void_minor === 0 && noAction.open_invoices.write_off_minor === 0,
    ],
  );
}

// 4i) Business defaults are RESOLVED, not echoed as a placeholder — an empty option
//     set must preview the cancellation you get by confirming with nothing selected.
{
  const defBiz = await createBusiness({
    organizationId: orgId,
    name: "Defaults Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const defCtx = { organizationId: orgId, businessId: defBiz.id };
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({
        defaultCancelOption: "end_of_term",
        defaultCreditOptionForCancel: "full",
        defaultUnbilledOnCancel: "delete",
      })
      .where(eq(businesses.id, defBiz.id)),
  );
  const defProduct = await createProduct({ ...defCtx, name: "Pro", kind: "plan" });
  const defPrice = await createPrice({
    ...defCtx,
    productId: defProduct.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const customer = await createCustomer({ ...defCtx, email: "cancel-defaults@a.com" });
  const { subscription } = await createSubscription({
    ...defCtx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: defPrice, quantity: 1 }],
  });
  const est = await estimateCancel({ ...defCtx, subscriptionId: subscription.id, now: new Date() });
  console.log(`cancel/defaults: ${JSON.stringify(est.options)}`);
  checks.push(
    [
      "cancel estimate: business default cancel_option resolved",
      est.options.cancel_option === "end_of_term",
    ],
    [
      "cancel estimate: business default credit_option resolved",
      est.options.credit_option === "full",
    ],
    [
      "cancel estimate: business default unbilled option resolved",
      est.options.unbilled_charges_option === "delete",
    ],
  );
}

// 4j) The guards are MIRRORED: a preview must refuse exactly what the cancel refuses,
//     rather than quoting a cancellation that then 400s on confirm.
{
  const customer = await createCustomer({ ...ctx, email: "cancel-guards@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const refused = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const noDate = await refused(() =>
    estimateCancel({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      cancelOption: "specific_date",
    }),
  );
  const pastDate = await refused(() =>
    estimateCancel({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      cancelOption: "specific_date",
      cancelAt: new Date(Date.now() - 60_000),
    }),
  );
  // A paused sub has no term end the clock will ever reach.
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set({ status: "paused" }).where(eq(subscriptions.id, subscription.id)),
  );
  const pausedEot = await refused(() =>
    estimateCancel({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      cancelOption: "end_of_term",
    }),
  );
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set({ status: "active" }).where(eq(subscriptions.id, subscription.id)),
  );
  await cancelSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
  });
  const cancelled = await refused(() =>
    estimateCancel({ ...ctx, subscriptionId: subscription.id, now: new Date() }),
  );
  console.log(
    `cancel/guards: noDate=${noDate} pastDate=${pastDate} pausedEot=${pausedEot} cancelled=${cancelled}`,
  );
  checks.push(
    [
      "cancel estimate: specific_date without cancel_at is refused",
      !!noDate?.includes("requires cancel_at"),
    ],
    ["cancel estimate: past cancel_at is refused", !!pastDate?.includes("must be in the future")],
    [
      "cancel estimate: end_of_term on a paused sub is refused",
      !!pausedEot?.includes("no term end to cancel at"),
    ],
    [
      "cancel estimate: an already-cancelled sub is refused",
      !!cancelled?.includes("already cancelled"),
    ],
  );
}

// 5) ONE COMPOSITION EDIT → ONE INVOICE, and the preview still matches it.
//
//    The defect, measured on real data: an operator made ONE edit — move the monthly
//    plan to its yearly price, remove one add-on, remove the old monthly connections
//    line, add connections on its yearly price. `/change` could not carry adds or
//    removes, so the dashboard sent FOUR requests and the customer got FIVE documents:
//    an invoice billing a full YEAR of two lines the very next request removed
//    (₹279,296.56), two credit notes handing them straight back (−₹65,220.96,
//    −₹106,483.20), a second invoice for the added line (₹110,920.00), and the
//    unused-term credit (−₹47,251.92). The net, ₹171,260.48, was arithmetically
//    CORRECT — and the edit still could not be collected: the ₹110,920 invoice alone
//    exceeded that customer's ₹97,572 per-debit e-mandate ceiling, so the bank refused
//    it. Splitting one collectable charge into two turns a payable edit into a dunning
//    case. The whole edit goes as ONE update and raises ONE invoice.
//
//    So this asserts on DOCUMENTS, not only on totals — the net was never the bug — and
//    then proves the net did not move by replaying the same edit the old way.
{
  const cctx = ctx;
  const planProd = await createProduct({ ...cctx, name: "Composition plan", kind: "plan" });
  const planMonthly = await createPrice({
    ...cctx,
    productId: planProd.id,
    name: "PRO monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const planYearly = await createPrice({
    ...cctx,
    productId: planProd.id,
    name: "LITE yearly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 100000,
    interval: "year",
  });
  const studioProd = await createProduct({ ...cctx, name: "Studio add-on", kind: "addon" });
  const studioMonthly = await createPrice({
    ...cctx,
    productId: studioProd.id,
    name: "Studio monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const connProd = await createProduct({ ...cctx, name: "Connections", kind: "addon" });
  const connMonthly = await createPrice({
    ...cctx,
    productId: connProd.id,
    name: "Connections monthly",
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const connYearly = await createPrice({
    ...cctx,
    productId: connProd.id,
    name: "Connections yearly",
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 10000,
    interval: "year",
  });

  // FIXED instants, not "now ± half a term": both fixtures must be priced from the same
  // term and the same change instant, or the two paths' rounding could differ by a minor
  // unit and the comparison below would be measuring the clock instead of the edit.
  const termStart = new Date("2026-08-01T00:00:00.000Z");
  const changeAt = new Date("2026-08-16T00:00:00.000Z"); // 16 of 31 days left

  const mkFixture = async (email: string) => {
    const customer = await createCustomer({ ...cctx, email });
    await vaultPaymentMethod({ ...cctx, customer, token: "tok_4242" });
    const { subscription, items } = await createSubscription({
      ...cctx,
      customerId: customer.id,
      now: termStart,
      items: [
        { price: planMonthly, quantity: 1 },
        { price: studioMonthly, quantity: 1 },
        { price: connMonthly, quantity: 10 },
      ],
    });
    // The first term must be billed AND paid: that is the real-world shape (the
    // ₹47,251.92 credit above came out of a paid monthly term) and the only one where a
    // term-reset credit becomes drawable balance rather than an invoice adjustment.
    const already = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)),
    );
    if (already.length === 0) {
      await billSubscriptionPeriod({
        ...cctx,
        subscription,
        periodStart: subscription.currentPeriodStart!,
        periodEnd: subscription.currentPeriodEnd!,
      });
    }
    return {
      customerId: customer.id,
      subscriptionId: subscription.id,
      planItem: items.find((i) => i.priceId === planMonthly.id)!,
      studioItem: items.find((i) => i.priceId === studioMonthly.id)!,
      connItem: items.find((i) => i.priceId === connMonthly.id)!,
    };
  };

  /** Every document this customer holds, and the net money across them. */
  const docs = async (customerId: string, subscriptionId: string) => {
    const invRows = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, subscriptionId)),
    );
    const cnRows = await withTenant(orgId, (tx) =>
      tx.select().from(creditNotes).where(eq(creditNotes.customerId, customerId)),
    );
    return {
      invoices: invRows,
      creditNotes: cnRows,
      // Document-level net: what we billed, less what we handed back. Insensitive to
      // whether a credit lands as an adjustment or a refundable note, which is exactly
      // the axis the two paths are allowed to differ on.
      net:
        invRows.reduce((s, i) => s + Number(i.totalMinor), 0) -
        cnRows.reduce((s, c) => s + Number(c.totalMinor), 0),
    };
  };
  const itemPriceIds = (subscriptionId: string) =>
    withTenant(orgId, async (tx) =>
      (
        await tx
          .select()
          .from(subscriptionItems)
          .where(eq(subscriptionItems.subscriptionId, subscriptionId))
      )
        .map((i) => i.priceId)
        .sort()
        .join(","),
    );

  // ── A: ONE atomic call ────────────────────────────────────────────────────────────
  const A = await mkFixture("composition-atomic@a.com");
  const beforeA = await docs(A.customerId, A.subscriptionId);
  const est = await estimateChange({
    ...cctx,
    subscriptionId: A.subscriptionId,
    now: changeAt,
    changes: [{ itemId: A.planItem.publicId, newPriceId: planYearly.publicId }],
    adds: [{ priceId: connYearly.publicId, quantity: 10 }],
    removes: [A.studioItem.publicId, A.connItem.publicId],
  });
  const applied = await changeSubscription({
    ...cctx,
    subscriptionId: A.subscriptionId,
    now: changeAt,
    changes: [{ itemId: A.planItem.publicId, newPriceId: planYearly.publicId }],
    adds: [{ priceId: connYearly.publicId, quantity: 10 }],
    removes: [A.studioItem.publicId, A.connItem.publicId],
    invoiceImmediately: true,
  });
  const afterA = await docs(A.customerId, A.subscriptionId);
  const newInvoices = afterA.invoices.filter((i) => !beforeA.invoices.some((b) => b.id === i.id));
  const newCreditNotes = afterA.creditNotes.filter(
    (c) => !beforeA.creditNotes.some((b) => b.id === c.id),
  );
  const editInvoice = newInvoices[0] ?? null;
  const editLines = editInvoice
    ? await withTenant(orgId, (tx) =>
        tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, editInvoice.id)),
      )
    : [];
  const removedPriceIds = new Set([studioMonthly.id, connMonthly.id]);
  const linesBillingRemovedItems = editLines.filter(
    (l) => l.priceId != null && removedPriceIds.has(l.priceId) && l.amountMinor > 0n,
  );
  // What we actually try to take from the card: the invoice total less every credit
  // bucket drawn onto it (and any withholding). NOT `amount_due_minor`, which collection
  // then zeroes — this is the figure that must fit under a per-debit mandate ceiling, and
  // the figure the estimate promised.
  const netCollectible = editInvoice
    ? Number(editInvoice.totalMinor) -
      Number(editInvoice.withholdingMinor) -
      Number(editInvoice.promotionalCreditsAppliedMinor) -
      Number(editInvoice.refundableCreditsAppliedMinor) -
      Number(editInvoice.excessPaymentsAppliedMinor)
    : 0;
  const atomicNet = afterA.net - beforeA.net;
  const atomicComposition = await itemPriceIds(A.subscriptionId);

  // ── B: the SAME edit, sent the old way — `/change`, then the add, then each removal
  // (reconcile.ts's swap → add → remove order). Kept as a live comparison rather than a
  // hard-coded expectation: the point of the atomic path is that it changes HOW an edit
  // is documented, never WHAT is owed.
  const B = await mkFixture("composition-split@a.com");
  const beforeB = await docs(B.customerId, B.subscriptionId);
  await changeSubscription({
    ...cctx,
    subscriptionId: B.subscriptionId,
    now: changeAt,
    changes: [{ itemId: B.planItem.publicId, newPriceId: planYearly.publicId }],
    invoiceImmediately: true,
  });
  await addSubscriptionItem({
    ...cctx,
    subscriptionId: B.subscriptionId,
    price: connYearly,
    quantity: 10,
    now: changeAt,
    invoiceImmediately: true,
  });
  await removeSubscriptionItem({
    ...cctx,
    subscriptionId: B.subscriptionId,
    itemPublicId: B.studioItem.publicId,
    now: changeAt,
  });
  await removeSubscriptionItem({
    ...cctx,
    subscriptionId: B.subscriptionId,
    itemPublicId: B.connItem.publicId,
    now: changeAt,
  });
  const afterB = await docs(B.customerId, B.subscriptionId);
  const splitDocuments =
    afterB.invoices.filter((i) => !beforeB.invoices.some((b) => b.id === i.id)).length +
    afterB.creditNotes.filter((c) => !beforeB.creditNotes.some((b) => b.id === c.id)).length;
  const splitNet = afterB.net - beforeB.net;
  const splitComposition = await itemPriceIds(B.subscriptionId);

  console.log(
    `composition edit: ATOMIC → ${newInvoices.length} invoice(s) ${newCreditNotes.length} credit note(s), ` +
      `invoice total=${editInvoice ? Number(editInvoice.totalMinor) : "none"} net collectible=${netCollectible}, estimate amount_due=${est.amount_due_minor}; ` +
      `SPLIT (4 calls) → ${splitDocuments} documents; net atomic=${atomicNet} split=${splitNet}`,
  );
  checks.push(
    ["composition edit raises exactly ONE invoice", newInvoices.length === 1],
    ["composition edit raises at most ONE credit note", newCreditNotes.length <= 1],
    ["composition edit does raise the unused-term credit", newCreditNotes.length === 1],
    // The five-document defect in one assertion: nothing is billed for a year and
    // credited back in the same breath.
    ["no invoice line bills an item the same call removes", linesBillingRemovedItems.length === 0],
    [
      "the removed items really are gone",
      !atomicComposition.split(",").some((id) => removedPriceIds.has(id)),
    ],
    ["the added item is on the subscription", atomicComposition.split(",").includes(connYearly.id)],
    // The primary correctness gate: preview == booking on a MIXED edit.
    [
      "net collectible == estimate amount_due_minor",
      netCollectible === est.amount_due_minor && netCollectible > 0,
    ],
    // …and the atomic path changed only how the edit is documented.
    ["atomic net money == the same edit as four separate calls", atomicNet === splitNet],
    ["both paths end on the same composition", atomicComposition === splitComposition],
    // Guards the comparison against being vacuous: the old way really did produce a pile
    // of documents (1 invoice + 1 add invoice + 2 removal credits + the term credit).
    ["the split path really was the multi-document path", splitDocuments >= 4],
    // The collection failure, stated as money: every document the old way raised was
    // bigger than the one charge the atomic path makes.
    [
      "the atomic charge is no larger than the largest charge the split path raised",
      netCollectible <=
        Math.max(
          ...afterB.invoices
            .filter((i) => !beforeB.invoices.some((b) => b.id === i.id))
            .map((i) => Number(i.totalMinor)),
        ),
    ],
  );
}

// 5a) The three lists are independent: an ADDS-ONLY and a REMOVES-ONLY call are legal
//     through `/change` (they used to be impossible — `changes` was `.min(1)`), and each
//     books exactly what the single-line route books. `POST …/items` and
//     `DELETE …/items/:id` keep working for callers that hold one line, which is why the
//     comparison is against them.
{
  const soloProd = await createProduct({ ...ctx, name: "Solo plan", kind: "plan" });
  const soloPlan = await createPrice({
    ...ctx,
    productId: soloProd.id,
    name: "Solo monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 20000,
    interval: "month",
  });
  const seatProd = await createProduct({ ...ctx, name: "Solo seats", kind: "addon" });
  const seatPrice = await createPrice({
    ...ctx,
    productId: seatProd.id,
    name: "Solo seat monthly",
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 1500,
    interval: "month",
  });
  const termStart = new Date("2026-08-01T00:00:00.000Z");
  const at = new Date("2026-08-16T00:00:00.000Z");

  const mk = async (email: string) => {
    const customer = await createCustomer({ ...ctx, email });
    await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
    const { subscription, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: termStart,
      items: [
        { price: soloPlan, quantity: 1 },
        { price: seatPrice, quantity: 4 },
      ],
    });
    const already = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)),
    );
    if (already.length === 0) {
      await billSubscriptionPeriod({
        ...ctx,
        subscription,
        periodStart: subscription.currentPeriodStart!,
        periodEnd: subscription.currentPeriodEnd!,
      });
    }
    return {
      customerId: customer.id,
      subscriptionId: subscription.id,
      seatItem: items.find((i) => i.priceId === seatPrice.id)!,
    };
  };

  // ADDS-ONLY through /change == POST …/items
  const addA = await mk("adds-only-change@a.com");
  const addEst = await estimateChange({
    ...ctx,
    subscriptionId: addA.subscriptionId,
    now: at,
    changes: [],
    adds: [{ priceId: seatPrice.publicId, quantity: 2 }],
  });
  const addViaChange = await changeSubscription({
    ...ctx,
    subscriptionId: addA.subscriptionId,
    now: at,
    changes: [],
    adds: [{ priceId: seatPrice.publicId, quantity: 2 }],
    invoiceImmediately: true,
  });
  const addB = await mk("adds-only-item@a.com");
  const { invoice: addViaItems } = await addSubscriptionItem({
    ...ctx,
    subscriptionId: addB.subscriptionId,
    price: seatPrice,
    quantity: 2,
    now: at,
    invoiceImmediately: true,
  });

  // REMOVES-ONLY through /change == DELETE …/items/:id, credit note included: a single
  // removal must still credit the invoice that CHARGED the item, not merely the
  // newest live one, or the refundable cap can refuse what the standalone route allows.
  const remA = await mk("removes-only-change@a.com");
  const remEst = await estimateChange({
    ...ctx,
    subscriptionId: remA.subscriptionId,
    now: at,
    changes: [],
    removes: [remA.seatItem.publicId],
  });
  const remViaChange = await changeSubscription({
    ...ctx,
    subscriptionId: remA.subscriptionId,
    now: at,
    changes: [],
    removes: [remA.seatItem.publicId],
    invoiceImmediately: true,
  });
  const remB = await mk("removes-only-item@a.com");
  const { creditNote: remViaItems } = await removeSubscriptionItem({
    ...ctx,
    subscriptionId: remB.subscriptionId,
    itemPublicId: remB.seatItem.publicId,
    now: at,
  });

  const addChangeTotal = addViaChange.prorationInvoice
    ? Number(addViaChange.prorationInvoice.totalMinor)
    : 0;
  const addItemsTotal = addViaItems ? Number(addViaItems.totalMinor) : 0;
  const remChangeCredit = remViaChange.creditNote ? Number(remViaChange.creditNote.totalMinor) : 0;
  const remItemsCredit = remViaItems ? Number(remViaItems.totalMinor) : 0;
  console.log(
    `adds-only: /change=${addChangeTotal} POST items=${addItemsTotal} estimate=${addEst.total_minor}; ` +
      `removes-only: /change credit=${remChangeCredit} DELETE item credit=${remItemsCredit} estimate=${-remEst.lines.reduce((s, l) => s + l.amount_minor, 0)}`,
  );
  checks.push(
    [
      "adds-only /change bills the same as POST …/items",
      addChangeTotal === addItemsTotal && addChangeTotal > 0,
    ],
    ["adds-only /change matches its estimate", addChangeTotal === addEst.total_minor],
    ["adds-only /change raises no credit note", addViaChange.creditNote === null],
    [
      "removes-only /change credits the same as DELETE …/items/:id",
      remChangeCredit === remItemsCredit && remChangeCredit > 0,
    ],
    [
      "removes-only /change matches its estimate",
      remChangeCredit === -remEst.lines.reduce((s, l) => s + l.amount_minor, 0),
    ],
    ["removes-only /change raises no invoice", remViaChange.prorationInvoice === null],
  );
}

// 5b) The guards a mixed edit owes, each REFUSED rather than mis-billed. Every one of
//     them exists on the single-line route too, and the preview mirrors them — a preview
//     that quotes what the apply then rejects is the defect class this file is here for.
{
  const gProd = await createProduct({ ...ctx, name: "Guard plan", kind: "plan" });
  const gPlan = await createPrice({
    ...ctx,
    productId: gProd.id,
    name: "Guard monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 30000,
    interval: "month",
  });
  const gPlanYear = await createPrice({
    ...ctx,
    productId: gProd.id,
    name: "Guard yearly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 300000,
    interval: "year",
  });
  const gAddProd = await createProduct({ ...ctx, name: "Guard addon", kind: "addon" });
  const gAddMonthly = await createPrice({
    ...ctx,
    productId: gAddProd.id,
    name: "Guard addon monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2000,
    interval: "month",
  });
  const gAddYearly = await createPrice({
    ...ctx,
    productId: gAddProd.id,
    name: "Guard addon yearly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 24000,
    interval: "year",
  });
  const gEurProd = await createProduct({ ...ctx, name: "Guard eur addon", kind: "addon" });
  const gEur = await createPrice({
    ...ctx,
    productId: gEurProd.id,
    name: "Guard eur",
    type: "recurring",
    model: "flat",
    currency: "EUR",
    amountMinor: 1000,
    interval: "month",
  });

  const customer = await createCustomer({ ...ctx, email: "composition-guards@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: gPlan, quantity: 1 },
      { price: gAddMonthly, quantity: 1 },
    ],
  });
  const planItem = items.find((i) => i.priceId === gPlan.id)!;
  const addonItem = items.find((i) => i.priceId === gAddMonthly.id)!;
  const refused = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  const wrongCurrency = await refused(() =>
    changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [],
      adds: [{ priceId: gEur.publicId }],
      invoiceImmediately: true,
    }),
  );
  // A YEARLY add-on on a subscription that stays MONTHLY is the illegal direction (it
  // would bill a year's price every month) — and the same add is LEGAL in the call that
  // moves the plan to its yearly price, which is the whole point of the atomic path.
  const yearlyOntoMonthly = await refused(() =>
    changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [],
      adds: [{ priceId: gAddYearly.publicId }],
      invoiceImmediately: true,
    }),
  );
  const bothChangeAndRemove = await refused(() =>
    changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      // A price OVERRIDE, not a quantity: `gAddMonthly` is a flat price, and the
      // quantity-invariant guard in the changes loop would refuse a quantity first —
      // masking the guard under test.
      changes: [{ itemId: addonItem.publicId, customAmountMinor: 2500 }],
      removes: [addonItem.publicId],
      invoiceImmediately: true,
    }),
  );
  const unknownItem = await refused(() =>
    changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [],
      removes: ["si_nope"],
      invoiceImmediately: true,
    }),
  );
  const unknownPrice = await refused(() =>
    changeSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [],
      adds: [{ priceId: "price_nope" }],
      invoiceImmediately: true,
    }),
  );
  // The estimate must refuse the same two, with the same words.
  const estWrongCurrency = await refused(() =>
    estimateChange({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [],
      adds: [{ priceId: gEur.publicId }],
    }),
  );
  const estYearlyOntoMonthly = await refused(() =>
    estimateChange({
      ...ctx,
      subscriptionId: subscription.id,
      now: new Date(),
      changes: [],
      adds: [{ priceId: gAddYearly.publicId }],
    }),
  );
  // …and the legal two-axis edit goes through: plan → yearly AND a yearly add-on added in
  // the SAME call, validated against the cycle the subscription is JOINING.
  const twoAxis = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [{ itemId: planItem.publicId, newPriceId: gPlanYear.publicId }],
    adds: [{ priceId: gAddYearly.publicId }],
    removes: [addonItem.publicId],
    invoiceImmediately: true,
  });
  const twoAxisLines = twoAxis.prorationInvoice
    ? await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, twoAxis.prorationInvoice!.id)),
      )
    : [];
  console.log(
    `composition guards: currency="${wrongCurrency}" cadence="${yearlyOntoMonthly}" change+remove="${bothChangeAndRemove}" ` +
      `item="${unknownItem}" price="${unknownPrice}"; two-axis invoice=${twoAxis.prorationInvoice ? Number(twoAxis.prorationInvoice.totalMinor) : "none"}`,
  );
  checks.push(
    [
      "a mixed edit refuses an add in another currency",
      !!wrongCurrency?.includes("currency must match"),
    ],
    [
      "a mixed edit refuses a yearly add on a subscription staying monthly",
      !!yearlyOntoMonthly?.toLowerCase().includes("billing period"),
    ],
    [
      "the estimate refuses both the same way",
      estWrongCurrency === wrongCurrency && estYearlyOntoMonthly === yearlyOntoMonthly,
    ],
    [
      "one item cannot be both changed and removed",
      !!bothChangeAndRemove?.includes("You cannot change and remove"),
    ],
    [
      "an unknown remove target is refused",
      !!unknownItem?.includes("We could not find the subscription item"),
    ],
    ["an unknown add price is refused", !!unknownPrice?.includes("We could not find the price")],
    // The two-axis edit: the yearly add-on is legal because the plan becomes yearly in
    // the same call, and it is billed a FULL year (24000), not a month of one.
    ["a yearly add is legal in the call that moves the plan to yearly", !!twoAxis.prorationInvoice],
    [
      "the added yearly add-on is billed a full year on the reset term",
      twoAxisLines.some((l) => l.priceId === gAddYearly.id && Number(l.amountMinor) === 24000),
    ],
    [
      "the removed monthly add-on is not billed by that same call",
      !twoAxisLines.some((l) => l.priceId === gAddMonthly.id && l.amountMinor > 0n),
    ],
  );
}

// 5c) A ONE-TIME item added by a mixed edit: charged in FULL (it buys no span of time),
//     booked `kind: 'one_time'`, and — the part only the atomic path has to work for —
//     its single cycle RECORDED, so no later renewal bills the fee a second time. The
//     item id does not exist while the invoice lines are built (the row is inserted by
//     the apply transaction), so it is resolved afterwards and handed to
//     `createInvoiceFromLines({ markItemsBilled })`. Get that wrong and the fee is
//     charged again at the next renewal.
{
  const oProd = await createProduct({ ...ctx, name: "Onetime host plan", kind: "plan" });
  const oPlan = await createPrice({
    ...ctx,
    productId: oProd.id,
    name: "Onetime host monthly",
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 40000,
    interval: "month",
  });
  const feeProd = await createProduct({ ...ctx, name: "Onboarding", kind: "charge" });
  const fee = await createPrice({
    ...ctx,
    productId: feeProd.id,
    name: "Onboarding fee",
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 7000,
  });
  const seatProd2 = await createProduct({ ...ctx, name: "Onetime seats", kind: "addon" });
  const seat2 = await createPrice({
    ...ctx,
    productId: seatProd2.id,
    name: "Onetime seat",
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 500,
    interval: "month",
  });

  const termStart = new Date("2026-08-01T00:00:00.000Z");
  const at = new Date("2026-08-16T00:00:00.000Z"); // mid-term: a fraction ≠ the full fee
  const customer = await createCustomer({ ...ctx, email: "composition-onetime@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: termStart,
    items: [
      { price: oPlan, quantity: 1 },
      { price: seat2, quantity: 6 },
    ],
  });
  const seatItem = items.find((i) => i.priceId === seat2.id)!;
  const already = await withTenant(orgId, (tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)),
  );
  if (already.length === 0) {
    await billSubscriptionPeriod({
      ...ctx,
      subscription,
      periodStart: subscription.currentPeriodStart!,
      periodEnd: subscription.currentPeriodEnd!,
    });
  }
  // One edit: raise the seats AND attach the one-off fee, same call, same instant.
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    changes: [{ itemId: seatItem.publicId, newQuantity: 8 }],
    adds: [{ priceId: fee.publicId, quantity: 1 }],
  });
  const res = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    changes: [{ itemId: seatItem.publicId, newQuantity: 8 }],
    adds: [{ priceId: fee.publicId, quantity: 1 }],
    invoiceImmediately: true,
  });
  const lines = res.prorationInvoice
    ? await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, res.prorationInvoice!.id)),
      )
    : [];
  const feeLine = lines.find((l) => l.priceId === fee.id);
  const feeItem = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(subscriptionItems)
          .where(eq(subscriptionItems.subscriptionId, subscription.id))
      ).find((i) => i.priceId === fee.id) ?? null,
  );
  console.log(
    `mixed edit with a one-time add: invoice total=${res.prorationInvoice ? Number(res.prorationInvoice.totalMinor) : "none"} estimate=${est.total_minor}, ` +
      `fee line=${Number(feeLine?.amountMinor ?? 0n)} kind=${feeLine?.kind} cycles_billed=${feeItem?.cyclesBilled}`,
  );
  checks.push(
    [
      "a mixed edit and a one-time add land on ONE invoice",
      lines.filter((l) => l.priceId === fee.id).length === 1 && !!res.prorationInvoice,
    ],
    [
      "the one-time fee is billed in FULL, not prorated",
      Number(feeLine?.amountMinor ?? 0n) === 7000,
    ],
    ["the one-time line is kind='one_time'", feeLine?.kind === "one_time"],
    [
      'the one-time line is not labelled "Prorated"',
      !!feeLine && !/prorated/i.test(feeLine.description),
    ],
    // Without this the next renewal bills the fee again.
    ["the one-time add recorded the cycle it consumed", feeItem?.cyclesBilled === 1],
    [
      "estimate == booked for the mixed edit",
      est.total_minor === Number(res.prorationInvoice?.totalMinor ?? 0n),
    ],
  );
}

// ── A QUANTITY INCREASE BILLS THE ADDED UNITS, in BOTH the preview and the booking ──
// ONE row for what you gained. We used to show the whole add-on being credited and
// re-charged — reported from the portal 2026-08-28 on a ×21 → ×22 move:
//
//   want  Additional Connections - Prorated Charges   1 unit    ₹752.00
//   ours  Unused time on Additional Connections ×21           -₹15,792.00
//         Remaining time on Additional Connections ×22        +₹16,544.00
//
// Identical money, but the pair reads like a re-bill of all 22 and it is what the
// customer is asked to confirm. Both sides are asserted here because the shape lives in
// TWO places — `estimate.ts` previews it, `proration.ts` books it — and nothing but this
// test stops them drifting apart. The TOTAL is asserted too: this is a presentation
// change and the money must not move (4b7b5be kept quantity changes netted on purpose;
// only a PRICE SWAP takes the credit-note path, because there a percentage coupon needs
// the charge to land on).
{
  const prod = await createProduct({ ...ctx, name: "QtyShape Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 27918,
    interval: "month",
  });
  const seatProd = await createProduct({ ...ctx, name: "QtyShape Connections", kind: "addon" });
  const seat = await createPrice({
    ...ctx,
    productId: seatProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 752,
    interval: "month",
  });

  const customer = await createCustomer({ ...ctx, email: "qtyshape@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: seat, quantity: 21 },
    ],
  });
  const planItem = items.find((i) => i.priceId === planPrice.id)!;
  const seatItem = items.find((i) => i.priceId === seat.id)!;
  const at = subscription.currentPeriodStart!;

  // The plan is passed UNCHANGED alongside the add-on move — exactly what the portal
  // sends. It must contribute no lines at all; it used to contribute a cancelling pair.
  const changes = [
    { itemId: planItem.publicId, newPriceId: planPrice.publicId },
    { itemId: seatItem.publicId, newQuantity: 22 },
  ];
  const est = await estimateChange({ ...ctx, subscriptionId: subscription.id, now: at, changes });
  const applied = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    changes,
    invoiceImmediately: true,
  });
  const booked = applied.prorationInvoice ? await docOf(applied.prorationInvoice.id) : null;
  const bookedLines = booked?.lines ?? [];

  // Match on the PRODUCT's name, which is what a line is now called: these prices set no
  // `external_name` and no `name`, and `priceLabel` falls back to the product before the
  // slug (2026-08-28) — so the slug this used to match on no longer appears on either side.
  // That fallback is the whole reason the wanted row above reads "Additional Connections …"
  // and ours used to read a versioned handle.
  const isSeat = (d: string) => d.includes("QtyShape Connections");
  const estSeat = est.lines.filter((l) => isSeat(l.description));
  const estPlan = est.lines.filter((l) => !isSeat(l.description));
  console.log(
    `qty ×21→×22: est lines=${JSON.stringify(est.lines.map((l) => [l.description, l.amount_minor]))} ` +
      `booked=${JSON.stringify(bookedLines.map((l) => [l.description, Number(l.amount_minor), l.quantity]))}`,
  );
  checks.push(
    [
      "qty increase: the preview shows ONE add-on line, not a credit/charge pair",
      estSeat.length === 1,
    ],
    [
      "qty increase: the preview line is the ADDED units",
      /Prorated Charges ×1$/.test(estSeat[0]?.description ?? ""),
    ],
    ["qty increase: the preview charges the delta only", estSeat[0]?.amount_minor === 752],
    ["qty increase: an UNCHANGED plan contributes no preview line", estPlan.length === 0],
    [
      "qty increase: the booking shows ONE add-on line too",
      bookedLines.filter((l) => isSeat(l.description)).length === 1,
    ],
    [
      "qty increase: the booked line carries quantity = the delta",
      bookedLines.find((l) => isSeat(l.description))?.quantity === 1,
    ],
    [
      "qty increase: an UNCHANGED plan contributes no booked line",
      bookedLines.filter((l) => /Unused time|Remaining time/i.test(l.description)).length === 0,
    ],
    [
      "qty increase: the money is unchanged — estimate == booked",
      est.total_minor === Number(applied.prorationInvoice?.totalMinor ?? -1n),
    ],
    [
      "qty increase: the total is the delta, not a re-bill",
      Number(applied.prorationInvoice?.totalMinor ?? 0n) === 752,
    ],
  );
}

// ── A REMOVAL'S REFUND MUST BE QUOTABLE, TAX INCLUDED ─────────────────────────────
// Reported by a buyer (PROGRESS :306): unchecking an add-on previewed
// `subtotal −4606, tax 0, total −4606` while the credit note it produced was ₹5,435.08 —
// the fee AND the 18% GST. Quote `total_minor` and you promise 4606 and pay back 5435.08.
//
// `total_minor` is not the bug and must not be "fixed": "TAX THE CHARGES, NOT THE NET"
// (estimate.ts) is deliberate — on apply the negative lines never reach the invoice, they
// become a credit note that reverses its own booked tax, and netting first re-breaks the
// partial-offset case. The gap was that the response never REPORTED the tax the note will
// reverse, so no caller could quote the refund. `credit_note_total_minor` does.
//
// Asserted against the note the apply actually issues, not against a recomputed figure —
// that equality is the whole point, and it is what nothing covered before.
{
  const { biz: taxBiz } = { biz: null as never };
  void taxBiz;
  const prod = await createProduct({ ...ctx, name: "RemovalTax Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 6072400,
    interval: "month",
  });
  const addonProd = await createProduct({ ...ctx, name: "RemovalTax Destination", kind: "addon" });
  const addonPrice = await createPrice({
    ...ctx,
    productId: addonProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 460600,
    interval: "month",
  });

  // A flat 18% so the credit's tax is unmistakable in the numbers.
  await createFlatTaxRate({ ...ctx, name: "GST18", country: "US", rateBps: 1800 } as never).catch(
    () => undefined,
  );

  const customer = await createCustomer({
    ...ctx,
    email: `removaltax${Date.now()}@a.com`,
    address: {
      line1: "1 A St",
      city: "SF",
      state: "CA",
      postalCode: "94105",
      country: "US",
    } as never,
  });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: addonPrice, quantity: 1 },
    ],
  });
  const addonItem = items.find((i) => i.priceId === addonPrice.id)!;
  const at = subscription.currentPeriodStart!;
  // The term's invoice has to EXIST for the removal to credit anything —
  // `issueCurrentTermCredit` needs a live invoice, and `createSubscription` alone raises
  // none here. Without this the case silently proved nothing: 0 notes, 0 actual.
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });

  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    changes: [],
    removes: [addonItem.publicId],
  });
  const { creditNotes: issued } = await removeSubscriptionItem({
    ...ctx,
    subscriptionId: subscription.id,
    itemPublicId: addonItem.publicId,
    now: at,
  });
  const actual = issued.reduce((s, c) => s + Number(c.totalMinor), 0);

  const invDoc = await withTenant(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, subscription.id));
    return rows.map((r) => ({
      id: r.publicId,
      status: r.status,
      total: Number(r.totalMinor),
      due: Number(r.amountDueMinor ?? 0n),
    }));
  });
  console.log(
    `removal refund: estimate total_minor=${est.total_minor} credit_note_total_minor=${est.credit_note_total_minor} · actual=${actual} notes=${issued.length} invoices=${JSON.stringify(invDoc)}`,
  );
  checks.push(
    ["a pure removal still previews (changes:[] must not skip the preview)", est.lines.length > 0],
    ["the removal quotes a refund at all", (est.credit_note_total_minor ?? 0) > 0],
    [
      "the quoted refund equals the credit note the apply issues",
      est.credit_note_total_minor === actual,
    ],
    // ⚠ THIS ASSERTION USED TO PIN THE DEFECT IN PLACE. It read "total_minor still
    // reports the untaxed net, unchanged … the regression that would catch someone
    // 'fixing' total_minor by netting the tax back in" — and expected −460600 for a
    // removal whose credit note is 543508. That is a preview promising a buyer ₹4,606
    // against a refund of ₹5,435.08, which `Estimate.credit_note_total_minor`'s own
    // docstring described as a lie while the test defended it.
    //
    // The fear behind the lock was that netting would re-break the partial-offset case
    // (charges 9118 against a 5000 credit). It does not: the fix nets the CREDIT NOTE'S
    // OWN TOTAL, tax included, so that case reads 10759.24 − 5900 = 4859.24 — right,
    // where BOTH the old shapes were wrong. `tax_minor` is untouched and still reports
    // the invoice's tax, which is what that fear was actually about.
    [
      "total_minor reports the money that moves — the note, tax included",
      est.total_minor === -543508,
    ],
    ["…and that is exactly minus the note the apply issues", est.total_minor === -actual],
  );
}

// ─── 8) A DOWNGRADE WHOSE CREDIT OUTWEIGHS ITS CHARGE (the 2026-08-30 defect) ──
// Reproduces the imported-INR subscription from the bug report at USD scale: a per-unit
// add-on at 752.00 × 60 dropped to × 59, at the period start so the proration factor is
// exactly 1.0, under a flat 18%.
//
//   charge   59 × 75200 = 4436800   tax 798624   → invoice     5235424
//   credit   60 × 75200 = 4512000   tax 812160   → credit note 5324160
//   the money that moves                                        −88736
//
// The preview quoted +7234.24 "chargeable immediately" for this — a DOWNGRADE billing the
// customer — because `total` was `net + invoiceTax`, mixing a subtotal net of the credit
// with a tax gross of it, and so overshooting by the credit's own tax every single time.
// The right answer is 887.36 BACK on the same change; −88736 is that figure.
//
// Nothing caught it because every other case in this file is either untaxed (where
// chargeTax − creditTax is 0 and the bug is invisible) or a PURE credit with no charge to
// mix. This case is the one shape that fails: taxed, AND both sides non-zero.
{
  const prod = await createProduct({ ...ctx, name: "Downgrade Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2791800,
    interval: "month",
  });
  const addonProd = await createProduct({ ...ctx, name: "Downgrade Connections", kind: "addon" });
  const addonPrice = await createPrice({
    ...ctx,
    productId: addonProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 75200,
    interval: "month",
  });
  await createFlatTaxRate({ ...ctx, name: "GST18", country: "US", rateBps: 1800 } as never).catch(
    () => undefined,
  );

  const customer = await createCustomer({
    ...ctx,
    email: `downgrade${Date.now()}@a.com`,
    address: {
      line1: "1 A St",
      city: "SF",
      state: "CA",
      postalCode: "94105",
      country: "US",
    } as never,
  });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: addonPrice, quantity: 60 },
    ],
  });
  const addonItem = items.find((i) => i.priceId === addonPrice.id)!;
  const at = subscription.currentPeriodStart!;
  // The term must have been BILLED, or the credit falls to `fallbackCreditLines` (negative
  // invoice lines) instead of a credit note — a different shape, and not the one that broke.
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });

  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    changes: [{ itemId: addonItem.publicId, newQuantity: 59 }],
  });
  const renewal = est.next_renewal;
  const applied = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    changes: [{ itemId: addonItem.publicId, newQuantity: 59 }],
    invoiceImmediately: true,
  });
  const appliedDoc = applied.prorationInvoice ? await docOf(applied.prorationInvoice.id) : null;
  const appliedInvoice = appliedDoc ? appliedDoc.total_minor : 0;
  const appliedNotes = applied.creditNotes.reduce((sum, c) => sum + Number(c.totalMinor), 0);
  // ⚠ `refundable_credit_added_minor` — and the dashboard bullet built on it — CLAIM that
  // the note is applied to this invoice and only the excess reaches the balance. That is a
  // claim about the apply, so measure the apply: the invoice must end up owing nothing, and
  // the customer's refundable bucket must grow by exactly the excess. Asserting only
  // `total === invoice − notes` (a net-cash identity) would hold just as well if the whole
  // note had gone to the balance and the invoice were left due in full.
  const refundableAfter = await withTenant(orgId, async (tx) =>
    Number((await bucketBalancesForCurrency(orgId, customer.id, "USD", tx)).refundable),
  );

  console.log(
    `downgrade: est.total=${est.total_minor} due=${est.amount_due_minor} immediate=${est.immediate_charge} added_back=${est.refundable_credit_added_minor} · applied invoice=${appliedInvoice} notes=${appliedNotes} net=${appliedInvoice - appliedNotes}`,
  );
  console.log(
    `downgrade renewal: subtotal=${renewal?.subtotal_minor} tax=${renewal?.tax_minor} total=${renewal?.total_minor} credits=${renewal?.credits_applied_minor} due=${renewal?.amount_due_minor} on ${renewal?.date}`,
  );
  // refundableAdded > 0 here (88736 lands on the balance), which is precisely the shape the
  // naive client-side subtraction gets wrong — the unpaid-term fixture below has it at 0.
  creditLegsAccountForTheNote("downgrade", est);
  checks.push(
    // THE PROPERTY: the preview equals invoice − credit note, whatever those turn out to be.
    [
      "downgrade total == applied invoice − credit notes",
      est.total_minor === appliedInvoice - appliedNotes,
    ],
    ["downgrade total is the credit owed back (−88736)", est.total_minor === -88736],
    ["a downgrade is not an immediate charge", est.immediate_charge === false],
    ["a downgrade collects nothing", est.amount_due_minor === 0],
    ["the leftover credit goes back on the balance", est.refundable_credit_added_minor === 88736],
    // ⚠ THE GUARD ON THE GUARD. `creditLegsAccountForTheNote` is only worth running if some
    // fixture actually SEPARATES the legs — on the unpaid-term shape the naive client-side
    // derivation `gross − open-invoice slice` coincides with the truth, so an invariant
    // checked only there would ratify the bug it exists to catch. Here they diverge by
    // exactly the credit that overflows to the balance, and this asserts that they do:
    // 5324160 − 0 = 5324160 quoted, against 5235424 actually applied to the invoice.
    [
      "downgrade: the naive client-side credit derivation really does diverge here (by 88736)",
      (est.credit_note_total_minor ?? 0) -
        (est.credit_applied_to_open_invoices_minor ?? 0) -
        (est.credit_applied_to_this_invoice_minor ?? 0) ===
        88736,
    ],
    [
      // This fixture is an add-on quantity DECREASE, which since 2026-09-01 raises no
      // invoice at all (see the matrix docblock). So there is no document left
      // to absorb the note, and the property worth asserting is that: the note stands alone
      // and is accounted for entirely by its legs, which the five checks above already
      // verify leg by leg. Asserted as `null` rather than deleted, because an invoice
      // reappearing here would mean the gross form came back.
      "…and the apply raises NO invoice, so the note is accounted for by its legs alone",
      appliedDoc === null,
    ],
    ["…leaving exactly the excess as refundable balance", refundableAfter === 88736],
    // tax_minor keeps its documented meaning — the INVOICE's rows, never the net. With no
    // invoice raised there are no rows, so zero is the honest answer here; the
    // must-not-be-netted property is carried by the shapes that DO raise a charge (the plan
    // upgrade/downgrade rows of the matrix assert `tax_minor === expectedTax` against the
    // charge base).
    ["tax_minor reports the invoice's rows — and there is no invoice", est.tax_minor === 0],
    [
      "tax_lines sum to tax_minor",
      (est.tax_lines ?? []).reduce((sum, l) => sum + l.amount_minor, 0) === est.tax_minor,
    ],

    // ── the "Next invoice of …" sentence ──
    ["the change previews a renewal at all", !!renewal],
    ["renewal is tax-INCLUSIVE, not the bare line sum", renewal?.total_minor === 7228600 + 1301148],
    ["renewal subtotal is the post-change composition", renewal?.subtotal_minor === 7228600],
    ["the downgrade credit is spent at renewal", renewal?.credits_applied_minor === 88736],
    [
      "renewal amount due nets that credit",
      renewal?.amount_due_minor === 7228600 + 1301148 - 88736,
    ],
    [
      "renewal is dated the next billing boundary",
      renewal?.date === subscription.currentPeriodEnd?.toISOString(),
    ],
  );
}

// ─── 9) EVERY CHANGE SHAPE, TAXED, AGAINST THE REAL APPLY ────────────────────
// The 2026-08-30 defect needed THREE things at once to be visible: tax configured, a
// CHARGE, and a CREDIT. Every pre-existing case in this file had at most two — most are
// untaxed (where `chargeTax − creditTax` is 0 and the arithmetic cannot be wrong), and the
// removal case is a pure credit with no charge to mix. So the suite was green while a
// downgrade quoted a charge.
//
// One property, asserted for every shape an operator can actually perform:
//
//     est.total_minor === (proration invoice total) − (credit notes issued)
//
// That is the definition of "what moves", it is measured against `changeSubscription`
// rather than recomputed, and it holds regardless of which shape produced it. Plus the
// convention that `tax_minor` stays the INVOICE's tax — on the POSITIVE lines only —
// because that is what the two-document footer on all three screens depends on.
{
  const TAX_BPS = 1800;
  await createFlatTaxRate({
    ...ctx,
    name: "GST18",
    country: "US",
    rateBps: TAX_BPS,
  } as never).catch(() => undefined);
  const mxPlanProd = await createProduct({ ...ctx, name: "Matrix Plan", kind: "plan" });
  const mxAddonProd = await createProduct({ ...ctx, name: "Matrix Addon", kind: "addon" });
  const mxExtraProd = await createProduct({ ...ctx, name: "Matrix Extra", kind: "addon" });
  const recurring = (productId: string, amountMinor: number, model: "flat" | "per_unit") =>
    createPrice({
      ...ctx,
      productId,
      type: "recurring",
      model,
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const planA = await recurring(mxPlanProd.id, 1000000, "flat");
  const planUp = await recurring(mxPlanProd.id, 2500000, "flat");
  const planDown = await recurring(mxPlanProd.id, 400000, "flat");
  const addon = await recurring(mxAddonProd.id, 100000, "per_unit");
  const extra = await recurring(mxExtraProd.id, 250000, "flat");

  /** A fresh taxed subscription (plan + 10 add-on units) whose term has been BILLED —
   *  without a live invoice the credit falls to negative invoice lines instead of a
   *  credit note, which is a different shape and not the one that broke. */
  let seq = 0;
  const freshSub = async (
    discount?: "coupon" | "manual" | "coupon-after-billing" | "coupon-then-removed",
  ) => {
    const customer = await createCustomer({
      ...ctx,
      email: `matrix${Date.now()}-${seq++}@a.com`,
      address: {
        line1: "1 A St",
        city: "SF",
        state: "CA",
        postalCode: "94105",
        country: "US",
      } as never,
    });
    await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
    const { subscription, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: planA, quantity: 1 },
        { price: addon, quantity: 10 },
      ],
    });
    // BEFORE the term is billed, so the discount is on the invoice this change will credit
    // against — the order the create route uses (see the coupon case above).
    if (discount === "coupon" || discount === "coupon-then-removed") {
      await applyCouponToSubscription({
        ...ctx,
        subscriptionId: subscription.id,
        code: "MATRIX10",
        now: new Date(),
        atSignup: true,
      });
    } else if (discount === "manual") {
      await applyManualDiscount({
        ...ctx,
        subscriptionId: subscription.id,
        kind: "percentage",
        percentOffBps: 1000,
        durationType: "forever",
        now: new Date(),
      });
    }
    await billSubscriptionPeriod({
      ...ctx,
      subscription,
      periodStart: subscription.currentPeriodStart!,
      periodEnd: subscription.currentPeriodEnd!,
    });
    // ⚠ AFTER the term is billed — the shape every case above was missing. The credit
    // note must then be worth the FULL undiscounted term (the customer paid it), while
    // the new charge is discounted. The estimate got that wrong on its first live run,
    // because every fixture here applied the discount BEFORE billing, where scaling the
    // credit by the current stack is right. REMOVED after the term was billed at the
    // discounted price. `removeDiscount` is forward-looking ("future invoices bill at
    // the remaining stack"), so the change that follows must charge FULL price while
    // the credit still reverses what was actually PAID — the discounted amount. The
    // exact inverse of `coupon-after-billing`, and a shape nothing covered: ADDING a
    // discount mid-term was wrong in three separate ways, and removal runs the same
    // paths.
    if (discount === "coupon-then-removed") {
      await removeDiscount(orgId, subscription.id, "MATRIX10");
    }
    if (discount === "coupon-after-billing") {
      await applyCouponToSubscription({
        ...ctx,
        subscriptionId: subscription.id,
        code: "MATRIX10",
        now: new Date(),
        atSignup: false,
      });
    }
    return {
      subscription,
      planItem: items.find((i) => i.priceId === planA.id)!,
      addonItem: items.find((i) => i.priceId === addon.id)!,
    };
  };

  await createCoupon({
    ...ctx,
    code: "MATRIX10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  }).catch(() => undefined);

  type Shape = {
    name: string;
    /** A discount already live on the subscription when the change is previewed. */
    discount?: "coupon" | "manual" | "coupon-after-billing" | "coupon-then-removed";
    build: (f: Awaited<ReturnType<typeof freshSub>>) => {
      changes?: Parameters<typeof estimateChange>[0]["changes"];
      adds?: Parameters<typeof estimateChange>[0]["adds"];
      removes?: string[];
    };
    /**
     * Does this shape issue a CREDIT NOTE? Not guessable from the direction of the change.
     *
     * ── THE ASYMMETRY THIS DOCUMENTED IS GONE (2026-09-01) ──────────────────────
     * Measured 2026-08-30 and recorded here as an engine fact:
     *
     *   qty 10 → 15  charges the DELTA (5 units, 500000) and credits nothing
     *   qty 10 → 6   re-rated the whole line: charged the new 6 (600000) and credited all 10
     *
     * The increase was right and the decrease was not. A decrease credits the REMOVED UNITS
     * ONLY and raises no invoice: unused service = plan price × unused QUANTITY × fraction,
     * so a qty 4→2 move raises 0 new invoices and one note for 2 units. The decrease now
     * emits one negative line for the 4 removed units, so both directions raise ONE document
     * and the numbers below are the delta, not the whole line.
     *
     * This is not cosmetic: on the "coupon applied AFTER billing" shape the gross form let
     * the coupon land on a re-charge that is never raised, and preview and apply disagreed
     * by 70800 (−542800 vs −472000). They now agree.
     *
     * ⚠️ The note above once read "the table was wrong, not the engine" about a first draft
     * that assumed any quantity change credits. Both were partly wrong: the engine's
     * asymmetry was real AND it was a defect.
     */
    credits: boolean;
  };
  const shapes: Shape[] = [
    {
      name: "plan upgrade",
      credits: true,
      build: (f) => ({ changes: [{ itemId: f.planItem.publicId, newPriceId: planUp.publicId }] }),
    },
    {
      name: "plan downgrade",
      credits: true,
      build: (f) => ({ changes: [{ itemId: f.planItem.publicId, newPriceId: planDown.publicId }] }),
    },
    // No credit note: the engine bills the 5 extra units and leaves the existing 10 alone.
    {
      name: "addon qty increase",
      credits: false,
      build: (f) => ({ changes: [{ itemId: f.addonItem.publicId, newQuantity: 15 }] }),
    },
    {
      name: "addon qty decrease",
      credits: true,
      build: (f) => ({ changes: [{ itemId: f.addonItem.publicId, newQuantity: 6 }] }),
    },
    {
      name: "add an addon",
      credits: false,
      build: () => ({ changes: [], adds: [{ priceId: extra.publicId, quantity: 1 }] }),
    },
    {
      name: "remove an addon",
      credits: true,
      build: (f) => ({ changes: [], removes: [f.addonItem.publicId] }),
    },
    // ── DISCOUNTED SUBSCRIPTIONS ──────────────────────────────────────────────
    // A coupon / manual discount ALREADY on the subscription. The question these two
    // answer is whether the change estimate prices a proration the way the apply bills
    // it once a discount is in play — the same `est == applied` property, on a shape
    // nothing in this file previously exercised.
    //
    // (Distinct from the OPEN gap where a coupon is added ON the change screen:
    // `estimateChange` has no `couponCode` parameter at all, so that one cannot be
    // tested here — the preview never receives it. See docs/PROGRESS.md.)
    {
      name: "qty decrease with a coupon",
      credits: true,
      discount: "coupon",
      build: (f) => ({ changes: [{ itemId: f.addonItem.publicId, newQuantity: 6 }] }),
    },
    {
      name: "qty decrease with a manual discount",
      credits: true,
      discount: "manual",
      build: (f) => ({ changes: [{ itemId: f.addonItem.publicId, newQuantity: 6 }] }),
    },
    // The late-coupon shape: the coupon lands AFTER the term invoice, so the credit it
    // reverses carries NO discount even though the subscription now has one.
    {
      name: "qty decrease, coupon applied AFTER billing",
      credits: true,
      discount: "coupon-after-billing",
      build: (f) => ({ changes: [{ itemId: f.addonItem.publicId, newQuantity: 6 }] }),
    },
    {
      name: "qty decrease, coupon REMOVED after billing",
      credits: true,
      discount: "coupon-then-removed",
      build: (f) => ({ changes: [{ itemId: f.addonItem.publicId, newQuantity: 6 }] }),
    },
  ];

  for (const shape of shapes) {
    const f = await freshSub(shape.discount);
    const at = f.subscription.currentPeriodStart!;
    const spec = shape.build(f);
    const args = {
      ...ctx,
      subscriptionId: f.subscription.id,
      now: at,
      changes: spec.changes ?? [],
      adds: spec.adds,
      removes: spec.removes,
    };
    const est = await estimateChange(args);
    const applied = await changeSubscription({ ...args, invoiceImmediately: true } as never);
    const invoiceTotal = applied.prorationInvoice
      ? (await docOf(applied.prorationInvoice.id)).total_minor
      : 0;
    const notesTotal = applied.creditNotes.reduce(
      (sum: number, c: { totalMinor: bigint }) => sum + Number(c.totalMinor),
      0,
    );
    const chargeLines = est.lines.reduce(
      (sum, l) => (l.amount_minor > 0 ? sum + l.amount_minor : sum),
      0,
    );
    // Tax is charged on the DISCOUNTED charge base. Before `estimateChange` priced
    // discounts this could only be asserted for undiscounted shapes (the harness skipped
    // it otherwise), so the two coupon shapes printed a tax figure nothing checked. One
    // expression now covers every shape — `discount_minor` is 0 where there is no coupon,
    // so it collapses to the old form rather than weakening it.
    const expectedTax = Math.round(((chargeLines - (est.discount_minor ?? 0)) * TAX_BPS) / 10000);

    console.log(
      `matrix ${shape.name}: total=${est.total_minor} due=${est.amount_due_minor} immediate=${est.immediate_charge}` +
        ` chargeLines=${chargeLines} tax=${est.tax_minor} note=${est.credit_note_total_minor ?? 0}` +
        ` addedBack=${est.refundable_credit_added_minor ?? 0} · applied invoice=${invoiceTotal} notes=${notesTotal}` +
        ` net=${invoiceTotal - notesTotal}`,
    );
    checks.push(
      [
        `${shape.name}: total == applied invoice − credit notes`,
        est.total_minor === invoiceTotal - notesTotal,
      ],
      [
        `${shape.name}: tax_minor is the INVOICE tax, on the charge base net of any ACTIVE discount`,
        est.tax_minor === expectedTax,
      ],
      // The discount itself must be reported, not merely absorbed into the total — the
      // footer on all three screens renders it as its own row.
      // `coupon-then-removed` has a discount in its HISTORY but none active, so the
      // charge must be full price — the same branch as a shape with no discount at all.
      // ⚠️ A DISCOUNT NEEDS A CHARGE TO DISCOUNT. All three discounted shapes are built on
      // the qty DECREASE edit, which since 2026-09-01 raises no invoice at all,
      // so there is nothing for the coupon to reduce and `discount_minor` is legitimately 0.
      // Keyed off `chargeLines` rather than the shape name, so a shape that starts raising a
      // charge again is held to the 60000 without anyone remembering to re-enable it.
      ...(shape.discount && shape.discount !== "coupon-then-removed"
        ? ([
            [
              `${shape.name}: the discount is reported iff there is a charge to discount`,
              est.discount_minor === (chargeLines > 0 ? 60000 : 0),
            ],
          ] as Array<[string, boolean]>)
        : ([
            [
              `${shape.name}: no discount reported where none applies`,
              (est.discount_minor ?? 0) === 0,
            ],
          ] as Array<[string, boolean]>)),
      // ⚠ THE ASYMMETRY. The charge is full price (the coupon is gone) but the credit must
      // still reverse what the customer PAID (the discounted term), so the note keeps the
      // source invoice's 0.9 while the charge does not. A credit scaled by the CURRENT
      // stack would refund 1180000 here and over-credit by 118000.
      ...(shape.discount === "coupon-then-removed"
        ? ([
            // No charge is raised any more on a decrease, so there is no charge tax
            // to check — asserted as ZERO rather than deleted, because a charge reappearing
            // here would mean the gross form came back.
            [`${shape.name}: no charge is raised, so no charge tax`, est.tax_minor === 0],
            [
              // THE ASYMMETRY THIS CASE EXISTS FOR SURVIVES, scaled to the removed units:
              // 424800 = 0.4 × 1062000 keeps the source invoice's 0.9, where the
              // coupon-after-billing sibling gives 472000 = 0.4 × 1180000 at list. A credit
              // scaled by the CURRENT stack would still over-credit here.
              `${shape.name}: credit still reverses the DISCOUNTED term (424800, not 472000)`,
              (est.credit_note_total_minor ?? 0) === 424800,
            ],
          ] as Array<[string, boolean]>)
        : []),
      // The credit reverses what was BILLED, not what is discounted now — at LIST, because
      // the coupon arrived after the term was billed. Scaled to the removed units (0.4)
      // since the decrease stopped re-rating the whole line; the property under test is the
      // UNDISCOUNTED basis, which 472000 = 0.4 × 1180000 still carries. The discounted
      // sibling below is what makes the pair meaningful: 424800 = 0.4 × 1062000.
      ...(shape.discount === "coupon-after-billing"
        ? ([
            [
              `${shape.name}: the credit note is UNDISCOUNTED (4 × 100000 + tax)`,
              (est.credit_note_total_minor ?? 0) === 472000,
            ],
          ] as Array<[string, boolean]>)
        : []),
      [
        `${shape.name}: immediate_charge follows the total`,
        est.immediate_charge === est.total_minor > 0,
      ],
      [`${shape.name}: amount_due never negative`, (est.amount_due_minor ?? 0) >= 0],
      // A shape that credits must SAY what the note is worth; one that does not must not invent one.
      [
        `${shape.name}: credit note reported iff the shape credits`,
        (est.credit_note_total_minor ?? 0) > 0 === shape.credits,
      ],
      // The renewal block must exist and be tax-inclusive for every shape.
      // The asymmetry above, pinned per shape: an increase charges only the delta, a
      // decrease charges the whole new quantity. Silently unifying them would change what
      // every downgrade invoice says.
      ...(shape.name === "addon qty increase"
        ? ([
            [`${shape.name}: charges only the DELTA (5 × 100000)`, chargeLines === 500000],
          ] as Array<[string, boolean]>)
        : []),
      ...(shape.name === "addon qty decrease"
        ? ([
            [
              // Since 2026-09-01: the 4 REMOVED units are credited (472000 =
              // 0.4 × 1180000, tax included) and NO invoice is raised, so there is no
              // charge line at all. The old expectation — charge the kept 6, credit all 10 —
              // was the gross form.
              `${shape.name}: credits the REMOVED units (4 × 100000 + tax) and raises no charge`,
              chargeLines === 0 && (est.credit_note_total_minor ?? 0) === 472000,
            ],
          ] as Array<[string, boolean]>)
        : []),
      [
        `${shape.name}: previews a tax-inclusive renewal`,
        !!est.next_renewal &&
          est.next_renewal.total_minor ===
            est.next_renewal.subtotal_minor -
              est.next_renewal.discount_minor +
              est.next_renewal.tax_minor,
      ],
    );
  }
}

// ─── 10) A COUPON ADDED ON THE CHANGE SCREEN REACHES THE PREVIEW ─────────────
// The gap this closes: `estimateChange` had no coupon parameter, the estimate request
// never sent one, and zod would have stripped it if it had. So an operator added a
// coupon, the rail did not move, and the confirm charged a different number.
//
// WHERE it lands is the subtle half. The dashboard applies the edit in order —
// `POST …/change` (which raises the proration invoice) and only THEN `POST …/discount`
// — so the coupon cannot touch that proration; the first document it affects is the next
// renewal. Previewing it on the immediate charges would quote a discount the apply does
// not give, which is the very divergence this file exists to catch.
{
  await createFlatTaxRate({ ...ctx, name: "GST18", country: "US", rateBps: 1800 } as never).catch(
    () => undefined,
  );
  await createCoupon({
    ...ctx,
    code: "PENDING25",
    kind: "percentage",
    percentOffBps: 2500,
    durationType: "forever",
  }).catch(() => undefined);
  const prod = await createProduct({ ...ctx, name: "Pending Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000000,
    interval: "month",
  });
  const addonProd = await createProduct({ ...ctx, name: "Pending Addon", kind: "addon" });
  const addonPrice = await createPrice({
    ...ctx,
    productId: addonProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 100000,
    interval: "month",
  });

  const customer = await createCustomer({
    ...ctx,
    email: `pending${Date.now()}@a.com`,
    address: {
      line1: "1 A St",
      city: "SF",
      state: "CA",
      postalCode: "94105",
      country: "US",
    } as never,
  });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      { price: addonPrice, quantity: 10 },
    ],
  });
  const addonItem = items.find((i) => i.priceId === addonPrice.id)!;
  const at = subscription.currentPeriodStart!;
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });

  const change = {
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    changes: [{ itemId: addonItem.publicId, newQuantity: 12 }],
  };
  const bare = await estimateChange(change);
  const withCoupon = await estimateChange({ ...change, couponCodes: ["PENDING25"] });
  const withManual = await estimateChange({
    ...change,
    manualDiscount: { kind: "percentage", percentOffBps: 2500 },
  });

  console.log(
    `pending coupon: bare total=${bare.total_minor} renewalDue=${bare.next_renewal?.amount_due_minor}` +
      ` · coupon total=${withCoupon.total_minor} renewalDisc=${withCoupon.next_renewal?.discount_minor} renewalDue=${withCoupon.next_renewal?.amount_due_minor}` +
      ` · manual renewalDisc=${withManual.next_renewal?.discount_minor}`,
  );
  // …and APPLY it the way the dashboard now does — the discount rides ON `/change`, so it
  // is live inside that transaction before the proration invoice is raised. This is the
  // assertion that was impossible before: preview and booking, both discounted.
  const applied = await changeSubscription({
    ...change,
    couponCode: "PENDING25",
    invoiceImmediately: true,
  } as never);
  const appliedInvoice = applied.prorationInvoice
    ? (await docOf(applied.prorationInvoice.id)).total_minor
    : 0;
  const appliedNotes = applied.creditNotes.reduce(
    (sum: number, c: { totalMinor: bigint }) => sum + Number(c.totalMinor),
    0,
  );
  console.log(
    `pending applied: invoice=${appliedInvoice} notes=${appliedNotes} net=${appliedInvoice - appliedNotes} · est=${withCoupon.total_minor}`,
  );

  checks.push(
    // THE POINT: the preview reacts at all. Before this it was byte-identical.
    ["a pending coupon changes the estimate", withCoupon.total_minor !== bare.total_minor],
    ["a pending manual discount changes the estimate", withManual.total_minor !== bare.total_minor],
    // ON THE PRORATION, because `changeSubscription` applies it before billing.
    [
      "the pending coupon discounts the immediate proration",
      withCoupon.total_minor < bare.total_minor,
    ],
    ["…and its tax follows the discounted base", withCoupon.tax_minor < bare.tax_minor],
    [
      "a manual 25% lands the same as the coupon",
      withManual.total_minor === withCoupon.total_minor,
    ],
    // ⚠ THE PROPERTY. Before this change the apply billed the proration at LIST price
    // while a coupon-aware preview quoted a discount — or the preview stayed silent and
    // matched a booking that disagreed with it. Both halves have to move together.
    [
      "pending-coupon estimate == the booking it now produces",
      withCoupon.total_minor === appliedInvoice - appliedNotes,
    ],
    // …and it reaches the renewal too, which is a separate invoice.
    [
      "the pending coupon discounts the RENEWAL (25% of 1+12 units = 2200000 → 550000)",
      withCoupon.next_renewal?.discount_minor === 550000,
    ],
    [
      "renewal tax follows the DISCOUNTED base (18% of 1650000)",
      withCoupon.next_renewal?.tax_minor === 297000,
    ],
    ["the bare estimate reports no discount", (bare.next_renewal?.discount_minor ?? 0) === 0],
  );
}

// ─── 10b) REMOVING THE APPLIED DISCOUNT ON THE CHANGE SCREEN ─────────────────
// `remove_discount` takes the active discount off INSIDE the change's transaction, before
// its proration invoice — so that invoice bills at list price, its tax is on the
// undiscounted base, and the renewal quote carries no discount. The estimate must price
// the same order to the minor unit, for a percentage, a fixed amount, a limited-duration
// coupon with periods already used, and a swap (remove + add in one edit).
{
  await createCoupon({
    ...ctx,
    code: "RMPCT20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
  }).catch(() => undefined);
  await createCoupon({
    ...ctx,
    code: "RMFIX15",
    kind: "fixed_amount",
    amountOffMinor: 150000,
    currency: "USD",
    durationType: "forever",
  }).catch(() => undefined);
  await createCoupon({
    ...ctx,
    code: "RMREP30",
    kind: "percentage",
    percentOffBps: 3000,
    durationType: "repeating",
    durationInPeriods: 3,
  }).catch(() => undefined);
  const prod = await createProduct({ ...ctx, name: "Remove Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000000,
    interval: "month",
  });
  const addonProd = await createProduct({ ...ctx, name: "Remove Addon", kind: "addon" });
  const addonPrice = await createPrice({
    ...ctx,
    productId: addonProd.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 100000,
    interval: "month",
  });

  async function removalCase(code: string, swapTo?: string) {
    const customer = await createCustomer({
      ...ctx,
      email: `remove-${code.toLowerCase()}-${Date.now()}@example.com`,
      address: {
        line1: "1 A St",
        city: "SF",
        state: "CA",
        postalCode: "94105",
        country: "US",
      } as never,
    });
    await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
    const { subscription, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: planPrice, quantity: 1 },
        { price: addonPrice, quantity: 10 },
      ],
    });
    await applyCouponToSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      code,
      now: subscription.currentPeriodStart!,
    });
    // Bills the term discounted (and uses one period of a repeating coupon).
    const term = await billSubscriptionPeriod({
      ...ctx,
      subscription,
      periodStart: subscription.currentPeriodStart!,
      periodEnd: subscription.currentPeriodEnd!,
    });
    const addonItem = items.find((i) => i.priceId === addonPrice.id)!;
    const change = {
      ...ctx,
      subscriptionId: subscription.id,
      now: subscription.currentPeriodStart!,
      changes: [{ itemId: addonItem.publicId, newQuantity: 12 }],
    };
    const kept = await estimateChange(change);
    const est = await estimateChange({
      ...change,
      removeDiscount: true,
      ...(swapTo ? { couponCodes: [swapTo] } : {}),
    });
    const mark = new Date();
    const applied = await changeSubscription({
      ...change,
      removeDiscount: true,
      ...(swapTo ? { couponCode: swapTo } : {}),
      invoiceImmediately: true,
    } as never);
    const inv = applied.prorationInvoice ? await docOf(applied.prorationInvoice.id) : null;
    const invId = applied.prorationInvoice?.id;
    const invTax = invId
      ? await withTenant(orgId, async (tx) =>
          (await tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, invId))).reduce(
            (sum, t) => sum + Number(t.amountMinor),
            0,
          ),
        )
      : 0;
    const invDisc = invId
      ? await withTenant(orgId, async (tx) =>
          (
            await tx
              .select()
              .from(invoiceLineDiscounts)
              .where(eq(invoiceLineDiscounts.invoiceId, invId))
          ).reduce((sum, d) => sum + Number(d.amountMinor), 0),
        )
      : 0;
    const notes = applied.creditNotes.reduce(
      (sum: number, c: { totalMinor: bigint }) => sum + Number(c.totalMinor),
      0,
    );
    const left = await withTenant(orgId, (tx) =>
      tx
        .select({ id: appliedCoupons.id })
        .from(appliedCoupons)
        .where(
          and(
            eq(appliedCoupons.subscriptionId, subscription.id),
            eq(appliedCoupons.status, "active"),
          ),
        ),
    );
    const evRows = await withTenant(orgId, (tx) =>
      tx
        .select({ type: events.type })
        .from(events)
        .where(and(eq(events.businessId, biz.id), gte(events.createdAt, mark))),
    );
    const count = (t: string) => evRows.filter((r) => r.type === t).length;
    console.log(
      `remove ${code}${swapTo ? `→${swapTo}` : ""}: kept total=${kept.total_minor} tax=${kept.tax_minor}` +
        ` · est total=${est.total_minor} tax=${est.tax_minor} renewalDisc=${est.next_renewal?.discount_minor}` +
        ` · applied invoice=${inv?.total_minor ?? 0} tax=${invTax} disc=${invDisc} notes=${notes}` +
        ` · term disc=${term ? "billed" : "none"} · active left=${left.length}` +
        ` · events removed=${count("coupon_removed")} changed=${count("subscription_changed")}`,
    );
    return { kept, est, inv, invTax, invDisc, notes, left: left.length, count };
  }

  for (const code of ["RMPCT20", "RMFIX15", "RMREP30"]) {
    const r = await removalCase(code);
    const net = (r.inv?.total_minor ?? 0) - r.notes;
    checks.push(
      [`remove ${code}: the estimate moves`, r.est.total_minor !== r.kept.total_minor],
      [
        `remove ${code}: the proration bills MORE without the discount`,
        r.est.total_minor > r.kept.total_minor,
      ],
      [`remove ${code}: estimate == the booking it produces`, r.est.total_minor === net],
      [
        `remove ${code}: invoice tax == estimated tax (undiscounted base)`,
        r.invTax === r.est.tax_minor && r.est.tax_minor > r.kept.tax_minor,
      ],
      [`remove ${code}: the invoice carries no discount`, r.invDisc === 0],
      [
        `remove ${code}: the renewal quote carries no discount`,
        (r.est.next_renewal?.discount_minor ?? 0) === 0,
      ],
      [`remove ${code}: no active discount remains`, r.left === 0],
      [`remove ${code}: one coupon_removed`, r.count("coupon_removed") === 1],
      [
        `remove ${code}: one subscription_changed for the whole edit`,
        r.count("subscription_changed") === 1,
      ],
    );
  }
  // A swap: the old discount off, the new one on, priced and booked in that order.
  const sw = await removalCase("RMPCT20", "PENDING25");
  const swNet = (sw.inv?.total_minor ?? 0) - sw.notes;
  checks.push(
    ["swap RMPCT20→PENDING25: estimate == the booking it produces", sw.est.total_minor === swNet],
    [
      "swap: the renewal is discounted by the NEW coupon only (25% of 2200000)",
      sw.est.next_renewal?.discount_minor === 550000,
    ],
    ["swap: exactly one discount remains", sw.left === 1],
    ["swap: one subscription_changed for the whole edit", sw.count("subscription_changed") === 1],
  );
}

// ─── 11) A CREDIT SPENT RELIEVING AN UNPAID INVOICE IS NOT CREDIT "ADDED BACK" ──
// The buyer-facing checkout quoted "₹17,010.12 credited to your balance" on a change whose
// apply put ₹0 on the balance and still wanted ₹5,088.01 (dashboard, 2026-08-31). The
// preview modelled the credit note as if the whole of it were available to offset the NEW
// invoice, but `creditOneInvoice` spends it on the OLD invoice's outstanding debt first —
// an ADJUSTMENT note relieving what the customer still owes — and only the overflow reaches
// the balance. So every unpaid currency unit on the term was promised twice.
//
// ⚠ THE NET-CASH IDENTITY CANNOT SEE THIS, which is why section 8's assertions all held
// while the screen lied. The adjustment note IS a credit note, so `invoice − Σ notes` came
// out exactly equal to the (wrong) preview. What differs is the DESTINATION of the money:
// debt relieved versus balance credited. The two assertions that bite are therefore the
// customer's actual bucket and the invoice's actual amount due — the same lesson section 8
// wrote down and this shape then evaded.
//
// Constants: a 2791800 flat plan under 18% bills 3294324 and is left UNPAID
// (auto_collection off). A forced term reset on day 1 to a near-zero 10000 plan credits the
// whole unused term, 3294324, and charges 11800. Every unit of the credit is owed on the
// open invoice, so nothing reaches the balance and the new invoice is due in full.
// (The target plan is deliberately near-zero: at a normal price the change takes the NETTED
// shape and the credit never overflows far enough to expose the split.)
{
  const prod = await createProduct({ ...ctx, name: "OpenDebt Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2791800,
    interval: "month",
  });
  const cheapProd = await createProduct({ ...ctx, name: "OpenDebt Lite", kind: "plan" });
  const cheapPrice = await createPrice({
    ...ctx,
    productId: cheapProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  await createFlatTaxRate({ ...ctx, name: "GST18", country: "US", rateBps: 1800 } as never).catch(
    () => undefined,
  );

  const customer = await createCustomer({
    ...ctx,
    email: `opendebt${Date.now()}@a.com`,
    // OFF, so the billed term stays OPEN. That single field is the whole precondition:
    // with it on, tok_4242 settles the invoice and the credit has no debt to relieve.
    autoCollection: "off",
    address: {
      line1: "1 A St",
      city: "SF",
      state: "CA",
      postalCode: "94105",
      country: "US",
    } as never,
  } as never);
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const planItem = items.find((i) => i.priceId === planPrice.id)!;
  const at = subscription.currentPeriodStart!;
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const openBefore = await withTenant(orgId, async (tx) =>
    (await tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id))).map(
      (r) => ({ due: Number(r.amountDueMinor ?? r.totalMinor), total: Number(r.totalMinor) }),
    ),
  );

  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    resetTerm: true,
    changes: [{ itemId: planItem.publicId, newPriceId: cheapPrice.publicId }],
  });
  const applied = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    resetTerm: true,
    changes: [{ itemId: planItem.publicId, newPriceId: cheapPrice.publicId }],
    invoiceImmediately: true,
  });
  const appliedDoc = applied.prorationInvoice ? await docOf(applied.prorationInvoice.id) : null;
  const appliedNotes = applied.creditNotes.reduce((sum, c) => sum + Number(c.totalMinor), 0);
  // BY KIND: an adjustment note relieves debt, a refundable note lands on the balance. The
  // estimate now names those two destinations separately, so the check has to read them
  // separately — summing all notes is the net-cash identity that could not see this defect.
  const byKind = (k: string) =>
    applied.creditNotes
      .filter((c) => (c as unknown as { kind?: string }).kind === k)
      .reduce((sum, c) => sum + Number(c.totalMinor), 0);
  const appliedAdjustments = byKind("adjustment");
  const appliedRefundables = byKind("refundable");
  const refundableAfter = await withTenant(orgId, async (tx) =>
    Number((await bucketBalancesForCurrency(orgId, customer.id, "USD", tx)).refundable),
  );

  console.log(
    `open-debt: adjustments=${appliedAdjustments} refundables=${appliedRefundables} · term invoice ${JSON.stringify(openBefore)} · est.total=${est.total_minor} due=${est.amount_due_minor} added_back=${est.refundable_credit_added_minor ?? 0} note=${est.credit_note_total_minor ?? 0} · applied invoice=${appliedDoc?.total_minor ?? 0} due=${appliedDoc?.amount_due_minor ?? 0} notes=${appliedNotes} refundable_after=${refundableAfter}`,
  );

  creditLegsAccountForTheNote("open-debt", est);
  checks.push(
    [
      "open-debt: the term really was billed and left unpaid",
      openBefore.some((i) => i.due === 3294324),
    ],
    [
      "open-debt: the new term is charged at the cheap plan (11800)",
      appliedDoc?.total_minor === 11800,
    ],
    // ⚠ THE TWO THAT BITE. Both were false before this fix: the preview promised 3282524
    // onto the balance and 0 due, where the apply credits nothing and wants the full 11800.
    [
      "open-debt: previewed refundable credit == the bucket the apply really grows",
      (est.refundable_credit_added_minor ?? 0) === refundableAfter,
    ],
    [
      "open-debt: previewed amount due == what the apply really leaves owing",
      (est.amount_due_minor ?? 0) === (appliedDoc?.amount_due_minor ?? 0),
    ],
    // Hand-computed, so a change that moves BOTH sides together still has to justify itself.
    [
      "open-debt: nothing reaches the balance (the debt swallowed the credit)",
      refundableAfter === 0,
    ],
    ["open-debt: the new invoice is due in full", appliedDoc?.amount_due_minor === 11800],
    // The credit note itself is unchanged — it is the credit for unused time, and it is real.
    // ⚠ THE PLUMBING CHECK, not the arithmetic one. `credit-routing.ts` asserts that the
    // ROUTING conserves, over a grid, with no database. This asserts that the WIRING does:
    // that our weights, the inverse gross-up, `distributeCreditAcrossInvoices` and the
    // per-invoice call compose without losing or inventing a unit — measured against the
    // notes the apply really books, by KIND. A share silently dropped between the
    // distributor and the router would pass every arithmetic test and fail here.
    [
      "open-debt: previewed debt relief == the ADJUSTMENT notes the apply really books",
      (est.credit_applied_to_open_invoices_minor ?? 0) === appliedAdjustments,
    ],
    [
      "open-debt: …and the two note kinds account for the whole note, nothing invented",
      appliedAdjustments + appliedRefundables === appliedNotes,
    ],
    [
      "open-debt: the credit note is still the whole unused term",
      (est.credit_note_total_minor ?? 0) === 3294324,
    ],
  );
}

// ── A PROMO-FUNDED PAID TERM: the bucket-restore leg, which had NO coverage ──────────
// `estimate.ts` says so in its own words — "a PROMO- or EXCESS-funded PAID invoice DOES
// move … and NO test covers that shape today, which is why it is written down here rather
// than implied". The five-leg identity and the prose built on it are only worth as much as
// the shapes they are measured on, and both fixtures above leave `buckets` and `stranded`
// at 0 — so the conservation check had never actually exercised a bucket restore.
//
// Shape: promotional credit large enough to settle the whole term invoice, so the invoice is
// PAID and entirely bucket-funded. The change then credits the unused term, and
// `splitCreditByFunding` sends that slice back to the promotional bucket rather than making
// it cashable — promotional credit never becomes refundable, which is the rule the whole
// routing module exists to hold.
{
  const prod = await createProduct({ ...ctx, name: "PromoFunded Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000000,
    interval: "month",
  });
  const cheapProd = await createProduct({ ...ctx, name: "PromoFunded Lite", kind: "plan" });
  const cheapPrice = await createPrice({
    ...ctx,
    productId: cheapProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const customer = await createCustomer({
    ...ctx,
    email: `promofunded${Date.now()}@a.com`,
    address: {
      line1: "1 A St",
      city: "SF",
      state: "CA",
      postalCode: "94105",
      country: "US",
    } as never,
  } as never);
  // Comfortably more than the taxed term, so the invoice settles entirely from the bucket
  // and no cash is ever behind it — the precondition the routing branches on.
  await addPromotionalCredits({
    ...ctx,
    customer,
    amountMinor: 5000000,
    currency: "USD",
    description: "fixture: fund the whole term from the promotional bucket",
  });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const planItem = items.find((i) => i.priceId === planPrice.id)!;
  const at = subscription.currentPeriodStart!;
  await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const termInvoice = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)))[0],
  );
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: at,
    resetTerm: true,
    changes: [{ itemId: planItem.publicId, newPriceId: cheapPrice.publicId }],
  });
  console.log(
    `promo-funded: term invoice total=${Number(termInvoice?.totalMinor ?? 0)}` +
      ` promoApplied=${Number(termInvoice?.promotionalCreditsAppliedMinor ?? 0)}` +
      ` due=${Number(termInvoice?.amountDueMinor ?? 0)}`,
  );
  creditLegsAccountForTheNote("promo-funded", est);
  checks.push(
    [
      "promo-funded: the term invoice really was settled from the promotional bucket",
      Number(termInvoice?.promotionalCreditsAppliedMinor ?? 0) > 0 &&
        Number(termInvoice?.amountDueMinor ?? 0) === 0,
    ],
    // ⚠ THE POINT OF THE FIXTURE. Without a bucket-funded shape the conservation identity
    // and the prose that reads it were only ever measured with this leg at 0.
    [
      "promo-funded: the bucket-restore leg is actually exercised (non-zero)",
      (est.credit_returned_to_buckets_minor ?? 0) > 0,
    ],
    [
      "promo-funded: …and it is reported as a bucket_restore destination, not as refundable",
      (est.credit_destinations ?? []).some(
        (d) =>
          d.kind === "bucket_restore" &&
          d.amount_minor === (est.credit_returned_to_buckets_minor ?? 0),
      ),
    ],
    // The rule the routing module exists to hold: promotional credit never becomes cashable.
    [
      "promo-funded: promotional credit never turns into refundable balance",
      (est.refundable_credit_added_minor ?? 0) === 0,
    ],
  );
}

// ── § reset-anchor — the previewed term end must be the one the booking produces ───────
// Both halves of the reset boundary passed `sub.billingAnchorDay`, the PRE-reset day of the
// month, while `proration.ts` separately persisted the POST-reset one. `advancePeriod` takes
// day-of-month entirely from that argument, so the new term end landed on the OLD day: an
// 08→23 monthly→yearly swap minted 2026-08-23 → 2027-08-08, a 350-day "year", and the first
// renewal then ran 381 days (`verify:renewal-matrix`).
//
// It survived because BOTH sides were wrong identically — preview and booking agreed, so no
// estimate assertion could see it. This fixture is the one that can: it moves the anchor
// (start on the 8th, reset on the 23rd, exactly as renewal-matrix does) and asserts the
// quoted `new_period_end` IS the booked `current_period_end`. Without it the two lines can
// drift again with nothing going red — which is how the 2026-08-23 partial fix shipped
// looking complete.
{
  const org = await createOrganization({ name: "Estimate reset anchor" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ctx = { organizationId: orgId, businessId: biz.id };
  const cus = await createCustomer({ ...ctx, email: "reset-anchor@a.com" });
  await vaultPaymentMethod({ ...ctx, customer: cus, token: "tok_4242" });
  const prod = await createProduct({ ...ctx, name: "Plans", kind: "plan" });
  const monthly = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 100000,
    interval: "month",
  });
  const yearly = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000000,
    interval: "year",
  });
  // Start on the 8th so the reset (on the 23rd) MOVES the anchor — same-day would hide it.
  const sub = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date("2026-08-08T00:00:00.000Z"),
    items: [{ price: monthly, quantity: 1 }],
  });
  await billSubscriptionPeriod({
    ...ctx,
    subscription: sub.subscription,
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  const resetAt = new Date("2026-08-23T00:00:00.000Z");
  const est = await estimateChange({
    ...ctx,
    subscriptionId: sub.subscription.id,
    now: resetAt,
    resetTerm: true,
    changes: [{ itemId: sub.items[0]!.publicId, newPriceId: yearly.publicId }],
  });
  await changeSubscription({
    ...ctx,
    subscriptionId: sub.subscription.id,
    now: resetAt,
    resetTerm: true,
    invoiceImmediately: true,
    changes: [{ itemId: sub.items[0]!.publicId, newPriceId: yearly.publicId }],
  });
  const [after] = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.id, sub.subscription.id)),
  );
  const booked = after!.currentPeriodEnd!;
  const quoted = est.new_period_end ? new Date(est.new_period_end) : null;
  const span = Math.round(
    (booked.getTime() - after!.currentPeriodStart!.getTime()) / (24 * 60 * 60 * 1000),
  );
  checks.push(
    [
      `reset-anchor: the PREVIEW quotes the term end the booking produces (quoted ${quoted?.toISOString().slice(0, 10)}, booked ${booked.toISOString().slice(0, 10)})`,
      quoted != null && quoted.getTime() === booked.getTime(),
    ],
    // The bug this exists for: anchored on the OLD day the "year" was 350 days.
    [`reset-anchor: the reset term is a full YEAR (got ${span}d)`, span >= 365 && span <= 366],
    [
      "reset-anchor: the anchor followed the new term start (23, not the original 8)",
      after!.billingAnchorDay === 23,
    ],
  );
}

// ─── § 13) THE RESET CAP MUST ASK THE CREDIT QUESTION, NOT THE CASH QUESTION (F-40) ──
// `estimateChange`'s reset-branch cap (`termCapacity`) bounds the credit a reset may grant. It
// read `refundableCapacityForInvoice` — "is this money still a claim on CASH" — while the
// booking's `creditAcrossInvoices` asks `creditableCapacityForInvoice` — "is this invoice's
// value already spent". They differ on ALLOCATED credit:
//
//   refundable  subtracts a note's OUTSTANDING claim   (total − allocated − refunded)
//   creditable  subtracts EVERY non-voided note's FULL total
//
// so `creditable <= refundable` always, and the cap read the WIDER figure: the preview granted
// credit the booking cannot place. Fixed 2026-08-31 — and when it was fixed NO ASSERTION MOVED,
// because nothing in this file reached the binding shape. Hence this.
//
// ── GETTING THE SHAPE RIGHT TOOK THREE TRIES; THE DEAD ENDS ARE THE DOCUMENTATION ──
// The state needed is the one measured on a real subscriber 2026-08-28: an invoice credited in
// full whose note is then ALLOCATED elsewhere, so its outstanding claim is 0 and `refundable`
// reports the invoice's whole value as available while `creditable` reports nothing.
//
//  1. NOTE LEFT UNALLOCATED → both functions subtract its full total, so BOTH read 0. The
//     precondition below is then false (0 < 0) and the fixture tests nothing.
//  2. ALLOCATED IN FULL BY BILLING A SECOND TERM → the state arrives, but that invoice joins
//     the term-invoice set and contributes its own `recycled` capacity, restoring under
//     `creditable` what the credited invoice stopped contributing. The two calculators agree
//     again and the assertion passes `est 0 <= booked 0` — GREEN AGAINST THE BUG.
//  3. `allocateRefundableDraw` DIRECTLY → rejected. Its docstring says it runs inside the
//     invoice transaction after the bucket ledger is posted, so calling it alone builds a state
//     no code path produces. A fixture standing on unreachable data proves nothing.
//
// What works is a PARTIAL draw: a small ad-hoc charge allocates 10000 of a 1000000 note, so
// invoice A reads `creditable 0` against `refundable 10000`. Measured, not assumed.
//
// The change target is an UPGRADE on purpose. On a downgrade the credit outruns the charge and
// `proration.ts:3930` refuses the whole change ("the term's invoice cannot be credited (it is
// pending or voided)" — wrong diagnostic, the invoice is PAID and fully credited; logged as its
// own item). Refusal-vs-over-quote is a real consequence of this bug but a poor thing to assert
// through; an upgrade keeps both sides in numbers.
{
  const prod = await createProduct({ ...ctx, name: "F40 Plan", kind: "plan" });
  const planPrice = await createPrice({
    ...ctx,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000000,
    interval: "month",
  });
  const upProd = await createProduct({ ...ctx, name: "F40 Premium", kind: "plan" });
  const upPrice = await createPrice({
    ...ctx,
    productId: upProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2000000,
    interval: "month",
  });
  // DE deliberately: § 8/§ 11 install a flat US GST18 for the whole org, and tax would only add
  // bookkeeping to an assertion about two capacity functions.
  const customer = await createCustomer({
    ...ctx,
    email: `f40-${Date.now()}@a.com`,
    address: { line1: "1 A St", city: "Berlin", country: "DE" } as never,
  } as never);
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const planItem = items.find((i) => i.priceId === planPrice.id)!;
  const t1Start = subscription.currentPeriodStart!;
  const t1End = subscription.currentPeriodEnd!;

  // TERM 1 → invoice A, collected in cash.
  await billSubscriptionPeriod({ ...ctx, subscription, periodStart: t1Start, periodEnd: t1End });
  const invA = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)),
    )
  )[0]!;
  // Credit A in FULL, refundable — its value is now spent, but the credit sits on the balance.
  await issueRefundableCreditNote({
    ...ctx,
    invoicePublicId: invA.publicId,
    items: [{ description: "goodwill", amountMinor: Number(invA.totalMinor) }],
    reason: "F-40 fixture",
  });
  // A SMALL charge draws 10000 of that balance, which ALLOCATES that much of the note. Partial
  // on purpose — see dead end 2 above.
  await addAdHocCharges({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    lines: [{ description: "small charge", amountMinor: 10000n }] as never,
    invoiceNow: true,
  });

  const caps = await withTenant(orgId, async (tx) => ({
    creditable: (await creditableCapacityForInvoice(tx, invA.id)).available,
    refundable: (await refundableCapacityForInvoice(tx, invA.id)).available,
  }));
  const midTerm = new Date((t1Start.getTime() + t1End.getTime()) / 2);
  const est = await estimateChange({
    ...ctx,
    subscriptionId: subscription.id,
    now: midTerm,
    resetTerm: true,
    changes: [{ itemId: planItem.publicId, newPriceId: upPrice.publicId }],
  });
  const applied = await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: midTerm,
    resetTerm: true,
    changes: [{ itemId: planItem.publicId, newPriceId: upPrice.publicId }],
    invoiceImmediately: true,
  });
  const bookedNotes = applied.creditNotes.reduce((sum, c) => sum + Number(c.totalMinor), 0);
  console.log(
    `f40: A total=${invA.totalMinor} creditable=${caps.creditable} refundable=${caps.refundable} · est.note=${est.credit_note_total_minor ?? 0} booked=${bookedNotes} est.total=${est.total_minor}`,
  );
  // The file's own convention, and § 13 is exactly the shape its docstring warns about: a
  // CAPPED grant against an invoice with prior allocated credit, where the legs need not
  // coincide the way they do on the unpaid-term shape everything was first debugged against.
  creditLegsAccountForTheNote("f40", est);

  checks.push(
    // ⚠ THE PRECONDITION, asserted rather than assumed. Every dead end above produced a fixture
    // that looked fine and tested nothing; this is the line that says the shape is live. If the
    // two capacities ever converge here, this goes red instead of the suite going quietly
    // vacuous.
    [
      `f40: the capacity functions really do diverge here (creditable ${caps.creditable} < refundable ${caps.refundable})`,
      caps.creditable < caps.refundable,
    ],
    // ⚠ THE PROPERTY. Relational, not a constant: it is an inequality between two calculators,
    // and pinning a number would assert the proration factor and the tax rate too. Reading the
    // wider capacity grants ~20000 where the booking can place only ~10000.
    [
      `f40: the preview grants exactly what the booking places (est ${est.credit_note_total_minor ?? 0} == booked ${bookedNotes})`,
      (est.credit_note_total_minor ?? 0) === bookedNotes,
    ],
    // A SECOND, ABSOLUTE TOOTH. The relational check above compares two live calculators, so it
    // moves if both move together; this pins the creditable bound itself. `10000 + 10000` was
    // the first draft and it PASSED WHILE MUTATED (est 20000 <= 20000) — a bound equal to the
    // buggy answer is not a bound. The creditable capacity here is 10000: invoice A can absorb
    // nothing (its value is fully credited) and the ad-hoc invoice contributes only the 10000 it
    // recycled. The measured mutated value is 20000, so this fails against the defect.
    [
      "f40: the grant is bounded by the CREDITABLE capacity (<= 10000), not the refundable one",
      (est.credit_note_total_minor ?? 0) <= 10000,
    ],
  );
}

// ─── 14) #22: THE CANCEL ESTIMATE SEES A BUYER'S LIVE CHECKOUT ───────────────
/**
 * Cancelling credits the term invoice. It does NOT cancel a debit already live against
 * that invoice — and when the debit is a buyer's own checkout, nothing can: RazorPay
 * reports `capabilities.intentVoid: false`, so the money is captured, booked as excess
 * and auto-refunded, after the buyer has finished a challenge for a debt the credit note
 * had already cleared.
 *
 * `debits_in_flight` was built for exactly this (#16) and reached the CHANGE estimate
 * only, because that brief said "the change screen". Measured 2026-09-03 17:47 on the
 * cancel path: intent `pi_XXXXXXXXXXXXXXXXXXXXXX03`, ₹22,184.00 live on INV-7826, the
 * subscription cancelled ten seconds later (CN-3010 adjustment + CN-3011 refundable),
 * the payment then completed — and NO warning appeared at any point.
 *
 * The fixture is 4a's shape (no payment method ⇒ the term invoice stays OPEN, so the
 * credit delivers as an `adjustment` against it) plus an INTENT-ONLY debit: a
 * `payment_intents` row and deliberately no `payments` row, which is the exact shape the
 * first cut of this warning could not see — `pendingPaymentsForInvoices` selected
 * `payments.status = 'pending'` and a buyer-initiated checkout writes no payments row at
 * all until its capture settles.
 */
{
  const customer = await createCustomer({ ...ctx, email: "cancel-inflight@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  // The buyer's checkout, in the live state `pendingPaymentsForInvoices` recognises:
  // purpose `payment`, status `in_progress`, no `voided_at`, deadline in the future.
  const intentPublicId = `pi_estcancel${Date.now().toString(36)}`;
  await withTenant(orgId, (tx) =>
    tx.insert(paymentIntents).values({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      publicId: intentPublicId,
      status: "in_progress",
      purpose: "payment",
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  );
  const pendingPayRows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "pending"))),
  );
  const est = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  const named = est.debits_in_flight ?? [];
  console.log(
    `cancel/in-flight: pendingPayments=${pendingPayRows.length} delivery=${est.cancellation_credit.delivery} credited=${est.cancellation_credit.invoice} debits_in_flight=${JSON.stringify(named)}`,
  );
  /**
   * THE OTHER WAY A CANCELLATION CLEARS THE SAME DEBT. `account_receivables_handling =
   * write_off` relieves the open invoice outright, which is the identical exposure and
   * the more destructive of the two — so warning on the credit and not on the write-off
   * would warn LESS on the stronger action.
   *
   * `credit_option_for_current_term_charges: 'none'` on purpose: there is then no credit
   * plan at all, so the set under test comes purely from the AR branch and this cannot
   * pass on the back of the assertions above.
   */
  const estWriteOff = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "none",
    accountReceivablesHandling: "write_off",
  });
  const namedWriteOff = estWriteOff.debits_in_flight ?? [];
  console.log(
    `cancel/in-flight write_off: credit=${estWriteOff.cancellation_credit.delivery} write_off=${estWriteOff.open_invoices.write_off_minor} debits_in_flight=${JSON.stringify(namedWriteOff)}`,
  );

  /**
   * AND IT IS NOT ALWAYS ON. A warning that fires on every cancellation is one an
   * operator learns to click past, so the same estimate must come back CLEAN once the
   * checkout is gone. This is the half a hard-coded field cannot pass.
   */
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ status: "voided", voidedAt: new Date() })
      .where(eq(paymentIntents.publicId, intentPublicId)),
  );
  const estAfter = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "prorate",
  });
  console.log(
    `cancel/in-flight cleared: debits_in_flight=${JSON.stringify(estAfter.debits_in_flight ?? [])}`,
  );

  checks.push(
    // ⚠ THE PRECONDITION, asserted rather than assumed: this is the INTENT-ONLY case, the
    // one the payments-row query missed. If a pending payments row ever appears here the
    // fixture has stopped testing what it was written for, and this goes red instead of
    // the assertions below passing for the wrong reason.
    [
      `#22: precondition — the invoice has NO pending payments row (${pendingPayRows.length})`,
      pendingPayRows.length === 0,
    ],
    [
      "#22: the cancel estimate names the invoice whose checkout is still live",
      named.length === 1 && named[0]!.invoice === invoice.publicId,
    ],
    // `kind` is load-bearing, not decoration: an intent has no payments and no
    // transactions row, so the portal's release control cannot see it — the copy must
    // not tell the operator to ask the customer to release it from there.
    [
      "#22: …and reports it as a buyer's CHECKOUT, not a debit we dispatched",
      named[0]?.kind === "intent",
    ],
    // `in_progress` = the buyer is in the gateway's sheet, so the wait is theirs and only
    // they can finish or abandon it. That is what makes the warning actionable.
    ["#22: …and says the buyer is the one being waited on", named[0]?.awaiting_buyer === true],
    // ⚠ THE PRECONDITION for the write-off half: with `credit_option: none` nothing is
    // credited, so the warning below can only come from the AR write-off.
    [
      `#22: precondition — the write_off variant credits nothing and writes off ${estWriteOff.open_invoices.write_off_minor}`,
      estWriteOff.cancellation_credit.delivery === "none" &&
        estWriteOff.open_invoices.write_off_minor > 0,
    ],
    [
      "#22: a write_off cancellation warns too — it clears the same debt more bluntly",
      namedWriteOff.length === 1 &&
        namedWriteOff[0]!.invoice === invoice.publicId &&
        namedWriteOff[0]!.kind === "intent",
    ],
    [
      "#22: …and the same cancel is CLEAN once the checkout is voided",
      (estAfter.debits_in_flight ?? []).length === 0,
    ],
    // The credit really is aimed at the invoice the warning names — otherwise the warning
    // would be true of some other invoice and irrelevant to what is being confirmed.
    [
      "#22: precondition — the cancellation credits that same invoice as an adjustment",
      est.cancellation_credit.delivery === "adjustment" &&
        est.cancellation_credit.invoice === invoice.publicId,
    ],
  );
}

// ─── 15) #27: `schedule_payment_collection` IS THE OPPOSITE SHAPE ────────────
/**
 * Handed back by agent C3 rather than guessed at when it built #22 (`907d5913`):
 * every OTHER `account_receivables_handling` CLEARS a debt, so #22's warning —
 * "cancelling clears the debt now … it is then booked as excess and refunded
 * automatically" — is true of them. Choosing to COLLECT while a debit is already
 * live on the same invoice is not a clearing at all: it is a SECOND debit
 * dispatched against a debt the buyer may be actively paying, and the failure mode
 * is a double charge, not a stranded credit. C3 deliberately left this case out of
 * `debits_in_flight` rather than show a warning that says the wrong thing.
 *
 * Fixture is #22's shape again (an intent-only debit — a `payment_intents` row and
 * deliberately no `payments` row) but with `account_receivables_handling:
 * 'schedule_payment_collection'` and no credit plan at all, so the invoice under
 * test can only ever be reached through the AR-collection branch this section adds.
 */
{
  const customer = await createCustomer({ ...ctx, email: "cancel-inflight-collect@a.com" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 4 }],
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
  });
  const intentPublicId = `pi_estcancelcollect${Date.now().toString(36)}`;
  await withTenant(orgId, (tx) =>
    tx.insert(paymentIntents).values({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      publicId: intentPublicId,
      status: "in_progress",
      purpose: "payment",
      amountMinor: invoice.totalMinor,
      currency: invoice.currency,
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }),
  );
  const estCollect = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "none",
    accountReceivablesHandling: "schedule_payment_collection",
  });
  const namedCollect = estCollect.debits_in_flight ?? [];
  console.log(
    `cancel/in-flight collect: handling=${estCollect.open_invoices.handling} collect_minor=${estCollect.open_invoices.collect_minor} debits_in_flight=${JSON.stringify(namedCollect)}`,
  );

  // AND IT IS NOT ALWAYS ON, same negative control as #22: void the checkout, and the
  // SAME cancel (same handling, same due invoice) comes back with nothing in flight —
  // no warning at all, not just a differently-worded one.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentIntents)
      .set({ status: "voided", voidedAt: new Date() })
      .where(eq(paymentIntents.publicId, intentPublicId)),
  );
  const estCollectAfter = await estimateCancel({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    cancelOption: "immediately",
    creditOptionForCurrentTermCharges: "none",
    accountReceivablesHandling: "schedule_payment_collection",
  });
  console.log(
    `cancel/in-flight collect cleared: handling=${estCollectAfter.open_invoices.handling} debits_in_flight=${JSON.stringify(estCollectAfter.debits_in_flight ?? [])}`,
  );

  checks.push(
    // ⚠ THE PRECONDITION: this cancel really does route through the AR-collection
    // branch — with `credit_option: none` there is no credit plan, so any warning
    // below can only come from #27's new `collecting` set, never from `relieved`.
    [
      `#27: precondition — schedule_payment_collection would actually collect ${estCollect.open_invoices.collect_minor} on this invoice`,
      estCollect.open_invoices.handling === "schedule_payment_collection" &&
        estCollect.open_invoices.collect_minor > 0 &&
        estCollect.cancellation_credit.delivery === "none",
    ],
    [
      "#27: the cancel estimate NOW reports the invoice a collection attempt would double-charge",
      namedCollect.length === 1 && namedCollect[0]!.invoice === invoice.publicId,
    ],
    // `kind`/`awaiting_buyer` are unchanged by #27 — still describe WHAT is in flight,
    // never WHY it matters. The dialog is what turns this into the double-charge
    // sentence, keyed off `open_invoices.handling`, not a new field here.
    [
      "#27: …reported as the buyer's own checkout, still waiting on them",
      namedCollect[0]?.kind === "intent" && namedCollect[0]?.awaiting_buyer === true,
    ],
    [
      "#27: nothing in flight ⇒ no warning at all, even with schedule_payment_collection active",
      estCollectAfter.open_invoices.handling === "schedule_payment_collection" &&
        (estCollectAfter.debits_in_flight ?? []).length === 0,
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────
// #56 — REACTIVATION: the preview must equal the invoice the reactivation books.
//
// The Reactivate confirmation dialog had no estimate. It summed its own line items and
// printed the result as "Chargeable immediately", so on an Indian customer it named the
// PRE-TAX SUBTOTAL as the amount about to be charged: ₹10,998.00 against an invoice of
// ₹12,977.64 which, after that customer's ₹9,661.13 of refundable credit, collected
// ₹3,316.51. Wrong by ₹7,681.49, understating tax and overstating the charge at once.
//
// So this section is not "does the estimator return numbers" — it is the pair the defect
// broke: RAISE the estimate, BOOK the reactivation through the same two calls the route
// makes (`reactivateSubscriptionWithOptions` → `billSubscriptionPeriod`), and require the
// preview to equal the document. A preview that cannot disagree with the invoice is the
// only fix that stays fixed.
//
// The Σ-lines figure is kept as a NEGATIVE CONTROL rather than deleted: it is what the
// screen used to print, and asserting it differs from the amount due is what catches a
// future "simplification" back to it.
{
  // The GST vector is resolved from the geo reference (state codes are normalized
  // through it), and this suite never loaded it — `configureIndiaGst` throws
  // `GeoNotLoadedError` without it. `db:reset`/`geo:seed` populate the table; this
  // primes the in-process cache that reads it.
  await loadGeoReference();
  const rBiz = await createBusiness({
    organizationId: orgId,
    name: "Reactivate INR Biz",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const rCtx = { organizationId: orgId, businessId: rBiz.id };
  // India GST, seller in TN, 9% + 9% intra-state — the subject customer's own vector, and
  // the reason a single row called "Tax" is not what the invoice says.
  await configureIndiaGst({
    ...rCtx,
    homeStateCode: "TN",
    cgstBps: 900,
    sgstBps: 900,
    registrationNumber: "33AAFCN5032R1Z6",
  });
  const rPlanProduct = await createProduct({ ...rCtx, name: "Platform Lite", kind: "plan" });
  const rPlanPrice = await createPrice({
    ...rCtx,
    productId: rPlanProduct.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: 911800,
    interval: "month",
  });
  const rAddonProduct = await createProduct({ ...rCtx, name: "Connections", kind: "addon" });
  const rAddonPrice = await createPrice({
    ...rCtx,
    productId: rAddonProduct.id,
    type: "recurring",
    model: "per_unit",
    currency: "INR",
    amountMinor: 94000,
    interval: "month",
  });

  /**
   * A customer in TN with a CANCELLED subscription on the plan alone — the state the
   * Reactivate screen is reached from. `withCredit` pays the first term and credits it
   * back REFUNDABLE, which is how the subject customer's ₹9,661.13 came to exist (a
   * refundable note, `cn_NdXISODFBoAoLUNJh6eg8T4V`, sitting on the balance).
   */
  const cancelledSub = async (tag: string, withCredit: boolean) => {
    const cus = await createCustomer({
      ...rCtx,
      email: `r56-${tag}-${Date.now()}@a.com`,
      address: { line1: "1 Mount Rd", city: "Chennai", country: "IN", stateCode: "TN" } as never,
    } as never);
    await vaultPaymentMethod({ ...rCtx, customer: cus, token: "tok_4242" });
    const { subscription } = await createSubscription({
      ...rCtx,
      customerId: cus.id,
      now: new Date(),
      items: [{ price: rPlanPrice, quantity: 1 }],
    });
    await billSubscriptionPeriod({
      ...rCtx,
      subscription,
      periodStart: subscription.currentPeriodStart!,
      periodEnd: subscription.currentPeriodEnd!,
    });
    if (withCredit) {
      const [inv0] = await withTenant(orgId, (tx) =>
        tx.select().from(invoices).where(eq(invoices.subscriptionId, subscription.id)),
      );
      await issueRefundableCreditNote({
        ...rCtx,
        invoicePublicId: inv0!.publicId,
        items: [{ description: "goodwill", amountMinor: Number(inv0!.totalMinor) }],
        reason: "#56 fixture",
      });
    }
    await cancelSubscriptionWithOptions({
      ...rCtx,
      subscriptionId: subscription.id,
      now: new Date(),
      cancelOption: "immediately",
      // No cancellation credit: the only credit in play must be the one this fixture
      // put on the balance, or the assertion measures two things at once.
      creditOptionForCurrentTermCharges: "none",
    });
    return { customer: cus, subscription };
  };

  /** Reactivate for real, exactly as `POST …/reactivate` does, and read the document back. */
  const bookReactivation = async (
    subscriptionId: string,
    items: Array<{ price: string; quantity?: number; unitPriceMinor?: number }>,
  ) => {
    const { subscription: re } = await reactivateSubscriptionWithOptions({
      ...rCtx,
      subscriptionId,
      now: new Date(),
      items: items.map((i) => ({
        price: i.price,
        quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor,
      })),
      billingCycles: null,
      trialEnd: null,
    });
    const { invoice } = await billSubscriptionPeriod({
      ...rCtx,
      subscription: re,
      periodStart: re.currentPeriodStart!,
      periodEnd: re.currentPeriodEnd!,
    });
    const [row] = await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, invoice.id)).limit(1),
    );
    // The invoice's OWN tax rows, grouped by component exactly as `taxLinesForBase`
    // labels them — so the preview's named rows are compared against what the document
    // booked, not against a format this script made up.
    const taxRows = await withTenant(orgId, (tx) =>
      tx.select().from(appliedTaxes).where(eq(appliedTaxes.invoiceId, invoice.id)),
    );
    const byComponent = new Map<string, number>();
    for (const t of taxRows) {
      const label = taxComponentLabel(t.name, t.rateBps);
      byComponent.set(label, (byComponent.get(label) ?? 0) + Number(t.amountMinor));
    }
    const bookedTax = [...byComponent].map(([label, amount_minor]) => ({ label, amount_minor }));
    return {
      invoice: row!,
      doc: await docOf(invoice.id),
      bookedTax,
      // ⚠ The STORED `amount_due_minor` column, deliberately — the ISSUE-TIME collectible,
      // which is the figure an estimate predicts. `serializeInvoice().amount_due_minor` is
      // the REMAINING balance and decrements to 0 the moment the card settles, so
      // comparing against it would make every passing assertion pass for the wrong reason
      // (and every zero-due preview agree with every paid invoice). The column's own
      // docblock warns about exactly this misreading.
      issueDueMinor: Number(row!.amountDueMinor ?? 0n),
      // Balance credit spent AT GENERATION, post-tax: refundable + excess. The
      // promotional bucket is a pre-tax DISCOUNT and is never counted here — the same
      // split `serializeInvoice` makes, and double-counting it is a documented past bug.
      issueCreditMinor:
        Number(row!.refundableCreditsAppliedMinor ?? 0n) +
        Number(row!.excessPaymentsAppliedMinor ?? 0n),
      bookedTaxMinor: taxRows.reduce((n, t) => n + Number(t.amountMinor), 0),
    };
  };

  // ── (1) THE DEFECT'S OWN CASE: plan swap + 2 add-ons, GST, refundable credit ───────
  {
    const { subscription } = await cancelledSub("main", true);
    const wantItems = [
      { price: rPlanPrice.publicId, quantity: 1 },
      { price: rAddonPrice.publicId, quantity: 2 },
    ];
    const est = await estimateReactivate({
      ...rCtx,
      subscriptionId: subscription.id,
      items: wantItems,
      now: new Date(),
    });
    const sumLines = est.lines.reduce((s, l) => s + l.amount_minor, 0);
    console.log(
      `#56 estimate: Σlines=${sumLines} subtotal=${est.subtotal_minor} tax=${est.tax_minor}` +
        ` taxLines=${JSON.stringify(est.tax_lines)} total=${est.total_minor}` +
        ` credits=${est.credits_applied_minor} due=${est.amount_due_minor}`,
    );
    const booked = await bookReactivation(subscription.id, wantItems);
    console.log(
      `#56 booked  : subtotal=${booked.doc.subtotal_minor} tax=${booked.bookedTaxMinor}` +
        ` taxRows=${JSON.stringify(booked.bookedTax)} total=${booked.doc.total_minor}` +
        ` issueDue=${booked.issueDueMinor} credit=${booked.issueCreditMinor}`,
    );

    checks.push(
      // ── THE PREVIEW EQUALS THE DOCUMENT. The whole point. ──
      [
        "#56: the reactivation preview's total IS the booked invoice's total",
        est.total_minor === booked.doc.total_minor,
      ],
      [
        "#56: the reactivation preview's amount due IS the booked invoice's amount due",
        est.amount_due_minor === booked.issueDueMinor,
      ],
      [
        "#56: …and the credit it says will be spent IS the credit the invoice applied",
        est.credits_applied_minor === booked.issueCreditMinor,
      ],
      [
        "#56: …and the preview's subtotal IS the invoice's subtotal",
        est.subtotal_minor === booked.doc.subtotal_minor,
      ],
      // ── THE DEFECT, MEASURED. Σ lines is what the dialog printed as "Chargeable
      // immediately"; it is neither the invoice total nor the amount due. Keeping this
      // means a revert to the client-side sum fails the gate instead of shipping.
      [
        "#56: Σ line items is NOT the amount due — the figure the dialog used to print",
        sumLines !== est.amount_due_minor && sumLines !== est.total_minor,
      ],
      [
        "#56: the understatement is the whole of GST — Σ lines + tax = the invoice total",
        sumLines + est.tax_minor === est.total_minor,
      ],
      // ── TAX IS NAMED, NOT COLLAPSED. An Indian invoice prints two rows. ──
      [
        "#56: tax arrives as NAMED components, not one row called Tax",
        (est.tax_lines ?? []).length === 2 &&
          (est.tax_lines ?? []).some((t) => t.label.startsWith("CGST")) &&
          (est.tax_lines ?? []).some((t) => t.label.startsWith("SGST")),
      ],
      [
        "#56: the tax components sum EXACTLY to tax_minor",
        (est.tax_lines ?? []).reduce((s, t) => s + t.amount_minor, 0) === est.tax_minor,
      ],
      ["#56: …and to the tax the invoice actually booked", est.tax_minor === booked.bookedTaxMinor],
      // NAMED-FOR-NAMED against the document. `tax_minor` matching leaves open a preview
      // that splits 18% as one row, or as 12+6, and still totals correctly — which is the
      // shape #56 is about: a true total under a wrong description.
      [
        "#56: every tax component the preview names is the component the invoice booked",
        JSON.stringify(
          [...(est.tax_lines ?? [])].sort((a, b) => a.label.localeCompare(b.label)),
        ) === JSON.stringify([...booked.bookedTax].sort((a, b) => a.label.localeCompare(b.label))),
      ],
      // ── THE LADDER THE DIALOG RENDERS, top to bottom. ──
      [
        "#56: subtotal − discount + tax = total",
        est.subtotal_minor - est.discount_minor + est.tax_minor === est.total_minor,
      ],
      [
        "#56: total − credits applied = amount due, and the credit is a REAL, non-zero row",
        (est.credits_applied_minor ?? 0) > 0 &&
          (est.amount_due_minor ?? 0) > 0 &&
          est.total_minor - (est.credits_applied_minor ?? 0) === (est.amount_due_minor ?? 0),
      ],
      [
        "#56: the credit is REFUNDABLE balance, so the dialog can name what is being spent",
        est.refundable_credits_applied_minor === est.credits_applied_minor,
      ],
    );
  }

  // ── (2) THE SUBSCRIPTION'S OWN CREDIT CAP — why `estimateNewSubscription` could NOT
  //        be reused. It resolves ceilings with `subscriptionId: null` and so cannot see
  //        `max_refundable_credits_usage_minor`, while `planSubscriptionPeriodInvoice`
  //        applies it to the very invoice being previewed. Without this assertion the
  //        reuse looks correct on any subscription that happens to have no cap — which is
  //        every subscription in this file, and the subject one in production.
  {
    const { subscription } = await cancelledSub("cap", true);
    await withTenant(orgId, (tx) =>
      tx
        .update(subscriptions)
        .set({ maxRefundableCreditsUsageMinor: 250000n })
        .where(eq(subscriptions.id, subscription.id)),
    );
    const wantItems = [{ price: rPlanPrice.publicId, quantity: 1 }];
    const est = await estimateReactivate({
      ...rCtx,
      subscriptionId: subscription.id,
      items: wantItems,
      now: new Date(),
    });
    const capBooked = await bookReactivation(subscription.id, wantItems);
    console.log(
      `#56 cap: est credits=${est.credits_applied_minor} due=${est.amount_due_minor}` +
        ` · booked credits=${capBooked.issueCreditMinor} due=${capBooked.issueDueMinor}`,
    );
    checks.push(
      [
        "#56: the preview honours the SUBSCRIPTION's own refundable-credit cap",
        est.credits_applied_minor === 250000,
      ],
      [
        "#56: …the same cap the booked invoice applied",
        est.credits_applied_minor === capBooked.issueCreditMinor &&
          est.amount_due_minor === capBooked.issueDueMinor,
      ],
    );
  }

  // ── (3) A COUPON THAT SURVIVED THE CANCELLATION. `subscription_discounts` rows are not
  //        removed by cancelling, and `planSubscriptionPeriodInvoice` discounts the
  //        reactivated term's first invoice from exactly those rows. A preview that priced
  //        an empty CODE list instead would quote list price against a discounted invoice.
  {
    const { subscription } = await cancelledSub("coupon", false);
    const couponCode = `R56OFF-${Date.now()}`;
    await createCoupon({
      ...rCtx,
      code: couponCode,
      kind: "percentage",
      percentOffBps: 1000,
      durationType: "forever",
    });
    await applyCouponToSubscription({
      ...rCtx,
      subscriptionId: subscription.id,
      code: couponCode,
      now: new Date(),
    });
    const wantItems = [{ price: rPlanPrice.publicId, quantity: 1 }];
    const est = await estimateReactivate({
      ...rCtx,
      subscriptionId: subscription.id,
      items: wantItems,
      now: new Date(),
    });
    const { doc } = await bookReactivation(subscription.id, wantItems);
    console.log(
      `#56 coupon: est discount=${est.discount_minor} total=${est.total_minor}` +
        ` · booked total=${doc.total_minor}`,
    );
    checks.push(
      [
        "#56: the subscription's OWN surviving discount is priced into the preview",
        est.discount_minor === 91180,
      ],
      [
        "#56: …so the preview still equals the discounted invoice",
        est.total_minor === doc.total_minor,
      ],
    );
  }

  // ── (4) REACTIVATING INTO A TRIAL collects nothing today. The composition is still
  //        reported in full (it is what the conversion will bill), but every
  //        money-moves-now field is zero and `due_at_trial_end` says when instead — the
  //        same contract `estimateChange`'s in-trial branch honours. A dialog that
  //        headlined `amount_due` here would be right; one that headlined `total_minor`
  //        would promise a charge that does not happen.
  {
    const { subscription } = await cancelledSub("trial", true);
    const trialEnd = new Date(Date.now() + 14 * 86_400_000);
    const est = await estimateReactivate({
      ...rCtx,
      subscriptionId: subscription.id,
      items: [{ price: rPlanPrice.publicId, quantity: 1 }],
      trialEnd,
      now: new Date(),
    });
    console.log(
      `#56 trial: total=${est.total_minor} due=${est.amount_due_minor}` +
        ` credits=${est.credits_applied_minor} dueAt=${est.due_at_trial_end}`,
    );
    checks.push(
      [
        "#56: reactivating into a trial charges nothing today and says WHEN instead",
        est.amount_due_minor === 0 &&
          est.credits_applied_minor === 0 &&
          est.immediate_charge === false &&
          typeof est.due_at_trial_end === "string",
      ],
      [
        "#56: …while still reporting the full taxed composition the conversion will bill",
        est.total_minor === 911800 + 164124 && (est.tax_lines ?? []).length === 2,
      ],
    );
  }

  // ── (5) THE PREVIEW REFUSES WHAT THE CONFIRM WOULD REFUSE, rather than quoting a price
  //        for an impossible action. An ACTIVE subscription is not reactivatable.
  {
    const cus = await createCustomer({
      ...rCtx,
      email: `r56-active-${Date.now()}@a.com`,
      address: { line1: "1 Mount Rd", city: "Chennai", country: "IN", stateCode: "TN" } as never,
    } as never);
    const { subscription } = await createSubscription({
      ...rCtx,
      customerId: cus.id,
      now: new Date(),
      items: [{ price: rPlanPrice, quantity: 1 }],
    });
    let refused = false;
    try {
      await estimateReactivate({
        ...rCtx,
        subscriptionId: subscription.id,
        items: [{ price: rPlanPrice.publicId, quantity: 1 }],
        now: new Date(),
      });
    } catch (e) {
      refused = e instanceof ProrationError;
    }
    checks.push(["#56: an ACTIVE subscription's reactivation preview is refused", refused]);
  }

  // ── A coupon / manual discount added AT reactivation is priced and billed ──────────
  // The route applies them after the rebuild and before the invoice; the preview prices
  // them as pending. Both must land on the same figure, and below list price.
  await createCoupon({
    ...rCtx,
    code: "REACT50",
    kind: "percentage",
    percentOffBps: 5000,
    durationType: "forever",
  });
  const reItems = [{ price: rPlanPrice.publicId, quantity: 1 }];
  type Pending = Pick<Parameters<typeof estimateReactivate>[0], "couponCodes" | "manualDiscount">;
  const discountCases: Array<[string, Pending, (id: string) => Promise<unknown>]> = [
    [
      "coupon",
      { couponCodes: ["REACT50"] },
      (id: string) =>
        applyCouponToSubscription({
          ...rCtx,
          subscriptionId: id,
          code: "REACT50",
          now: new Date(),
          suppressSubscriptionChanged: true,
        }),
    ],
    [
      "manual discount",
      { manualDiscount: { kind: "fixed_amount", amountOffMinor: 500n } },
      (id: string) =>
        applyManualDiscount({
          ...rCtx,
          subscriptionId: id,
          kind: "fixed_amount",
          amountOffMinor: 500,
          durationType: "once",
          now: new Date(),
        }),
    ],
  ];
  for (const [label, pending, apply] of discountCases) {
    const { subscription } = await cancelledSub(`disc-${label.replace(" ", "-")}`, false);
    const plain = await estimateReactivate({
      ...rCtx,
      subscriptionId: subscription.id,
      items: reItems,
      now: new Date(),
    });
    const est = await estimateReactivate({
      ...rCtx,
      subscriptionId: subscription.id,
      items: reItems,
      now: new Date(),
      ...pending,
    });
    const { subscription: re } = await reactivateSubscriptionWithOptions({
      ...rCtx,
      subscriptionId: subscription.id,
      now: new Date(),
      items: reItems,
      billingCycles: null,
      trialEnd: null,
    });
    await apply(re.id);
    const { invoice } = await billSubscriptionPeriod({
      ...rCtx,
      subscription: re,
      periodStart: re.currentPeriodStart!,
      periodEnd: re.currentPeriodEnd!,
    });
    const doc = await docOf(invoice.id);
    console.log(
      `reactivate + ${label}: list=${plain.total_minor} quoted=${est.total_minor} billed=${doc.total_minor}`,
    );
    checks.push([
      `reactivation with a ${label}: the preview is the invoice (quoted ${est.total_minor}, billed ${doc.total_minor})`,
      est.total_minor === doc.total_minor,
    ]);
    checks.push([
      `reactivation with a ${label}: both are below list price (${plain.total_minor})`,
      est.total_minor < plain.total_minor && doc.total_minor < plain.total_minor,
    ]);
  }
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ ESTIMATES: PASS" : "❌ ESTIMATES: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
