/**
 * Payment → line-item attribution: the invariant, and the four shapes that can break it.
 *
 * `payments` is INVOICE-level, so "how much of the cash we collected was recurring" had no
 * answer. `modules/payments/attribution.ts` derives one from the invoice's own lines and
 * stores nothing — the full reasoning is on that module. This suite is its evidence.
 *
 * THE INVARIANT, and the only thing worth gating: **Σ allocations for a payment = the
 * payment amount, exactly, in integer minor units.** A pro-rata split of money that does not
 * divide is where a paisa gets invented or lost, and a report built on a split that is
 * "nearly" right reconciles against nothing.
 *
 * Sections:
 *   §1 THE ALLOCATOR — the pure function, on the cases the SQL path cannot easily stage:
 *      an indivisible amount, negative weights, a zero-weight document, one line, and the
 *      composition property that justifies pro-rata over a priority rule.
 *   §2 FULL PAYMENT of a single recurring invoice — the reference case: all of it recurring,
 *      nothing anywhere else.
 *   §3 MIXED INVOICE, full payment — recurring + setup fee + proration + tax on one
 *      document, settled in one payment. The split must match the lines it was billed from.
 *   §4 PARTIAL PAYMENT — a third of an indivisible document, then the remainder. Every
 *      bucket scales, no bucket is paid first, and the two partials sum to the whole.
 *   §4b TAX AND A NEGATIVE LINE — a tax line and a document-level discount, half paid. Mixed
 *      signs through the database, with exact expected values rather than a tolerance.
 *   §4c TAX INSIDE AN INCLUSIVE PRICE — the tax inside a tax-inclusive line has no line of
 *      its own, so it is backed out of the revenue bucket into `tax`: a pure inclusive
 *      document, a mixed one, an exclusive control that must not move, a partial payment and
 *      a full refund.
 *   §5 REFUND — attributed through its parent payment's invoice with negated buckets, so the
 *      net of a fully refunded payment is exactly zero in every bucket.
 *   §6 UNATTRIBUTED — cash with no line to sit on is REPORTED, never dropped: the invariant
 *      holds for a payment whose invoice link is gone.
 *   §7 THE ROLL-UP a report resolver calls, plus tenancy and the two entry points agreeing.
 *
 * ⚠️ Seeds its own org; safe on the dev database.
 *   pnpm verify:payment-allocation
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { recordOfflinePayment } from "@/modules/invoicing/ops";
import { refundPayment } from "@/modules/refunds/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import {
  allocateProRata,
  attributeInvoicePayments,
  attributePaymentsForBusiness,
  totalsByCurrency,
  PAYMENT_BUCKETS,
  type PaymentAttribution,
} from "@/modules/payments/attribution";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { payments } from "@db/schema";

let ok = 0;
let fail = 0;
const check = (label: string, pass: boolean, detail?: string) => {
  if (pass) {
    ok++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq_ = (label: string, actual: unknown, expected: unknown) =>
  check(label, String(actual) === String(expected), `got ${actual}, want ${expected}`);

/** The invariant, asserted on every attribution this suite produces. */
const invariant = (label: string, r: PaymentAttribution) => {
  const lineSum = r.lines.reduce((s, l) => s + l.amountMinor, 0n);
  const bucketSum = PAYMENT_BUCKETS.reduce((s, b) => s + r.buckets[b], 0n);
  check(
    `${label}: Σ lines = amount (${lineSum} = ${r.signedAmountMinor})`,
    lineSum + (r.buckets.unattributed ?? 0n) === r.signedAmountMinor,
  );
  check(
    `${label}: Σ buckets = amount (${bucketSum} = ${r.signedAmountMinor})`,
    bucketSum === r.signedAmountMinor,
  );
};

// ── §1 THE ALLOCATOR ──────────────────────────────────────────────────────────────────
console.log("\n§1 the allocator");
{
  // 100 across three equal lines: 33/33/34 in some order, and it MUST be 100.
  const a = allocateProRata(100n, [1n, 1n, 1n]);
  eq_(
    "indivisible: Σ = 100",
    a.reduce((s, v) => s + v, 0n),
    100n,
  );
  check("indivisible: one line absorbs the remainder", a.filter((v) => v === 34n).length === 1);

  // The remainder goes by LARGEST fractional remainder, not to a fixed slot: 10 over
  // weights 1,1,8 is 1,1,8 exactly; 10 over 3,3,4 is 3,3,4.
  eq_("exact split is exact", allocateProRata(10n, [1n, 1n, 8n]).join(","), "1,1,8");

  // Negative weights (a document-level discount line / an "Unused time" credit).
  const neg = allocateProRata(900n, [1000n, -100n]);
  eq_(
    "negative weight: Σ = 900",
    neg.reduce((s, v) => s + v, 0n),
    900n,
  );
  check("negative weight: the credit line is negative", neg[1]! < 0n);

  // A refund is the same allocator with a negative amount.
  const ref = allocateProRata(-100n, [1n, 1n, 1n]);
  eq_(
    "negative amount: Σ = −100",
    ref.reduce((s, v) => s + v, 0n),
    -100n,
  );

  eq_("zero weights allocate nothing", allocateProRata(500n, [0n, 0n]).join(","), "0,0");
  eq_("one line takes all of it", allocateProRata(777n, [12345n]).join(","), "777");
  eq_("zero amount", allocateProRata(0n, [5n, 7n]).join(","), "0,0");

  // WHY PRO-RATA: two partial payments attribute as one payment of their sum, to within the
  // one-unit remainder. This is the property a priority rule ("recurring first") destroys.
  const w = [70000n, 12500n, 3333n];
  const whole = allocateProRata(50000n, w);
  const halfA = allocateProRata(25000n, w);
  const halfB = allocateProRata(25000n, w);
  const composed = whole.map((_, i) => halfA[i]! + halfB[i]!);
  check(
    "composition: two halves ≈ the whole (≤1 unit per line)",
    composed.every((v, i) => {
      const d = v - whole[i]!;
      return d <= 1n && d >= -1n;
    }),
  );
  eq_(
    "composition: both sides total 50000",
    `${whole.reduce((s, v) => s + v, 0n)}/${composed.reduce((s, v) => s + v, 0n)}`,
    "50000/50000",
  );
}

// ── FIXTURE ───────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Payment Allocation Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Alloc Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "alloc@example.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price, quantity: 1 }],
});

// ── §2 FULL PAYMENT of a purely recurring invoice ─────────────────────────────────────
console.log("\n§2 full payment, purely recurring");
const billed = await billSubscriptionPeriod({
  organizationId: orgId,
  businessId: biz.id,
  subscription: sub.subscription,
  periodStart: sub.subscription.currentPeriodStart!,
  periodEnd: sub.subscription.currentPeriodEnd!,
});
if (!billed.payment || billed.payment.status !== "succeeded") {
  console.log("❌ fixture: renewal did not collect");
  process.exit(1);
}
{
  const rows = await attributeInvoicePayments({
    organizationId: orgId,
    invoiceId: billed.invoice.id,
  });
  eq_("one attribution row", rows.length, 1);
  const r = rows[0]!;
  invariant("renewal", r);
  eq_("all of it is recurring", r.recurringMinor, 10000n);
  eq_("nothing is non-recurring", r.nonRecurringMinor, 0n);
  eq_("no tax on a US flat price", r.taxMinor, 0n);
  eq_("nothing unattributed", r.buckets.unattributed, 0n);
  eq_("the subscription is carried", r.subscriptionId, sub.subscription.id);
}

// ── §3 MIXED INVOICE, full payment ────────────────────────────────────────────────────
// One document: a recurring line, a setup fee, a proration and a tax line. Exactly the
// shape that made the question unanswerable.
console.log("\n§3 mixed invoice, one payment");
const mixed = await createInvoiceFromLines({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  currency: "USD",
  lines: [
    { description: "Plan — monthly", amountMinor: 60000n, kind: "recurring" },
    { description: "Setup fee", amountMinor: 25000n, kind: "one_time" },
    { description: "Remaining time on Add-on", amountMinor: 7500n, kind: "proration" },
    { description: "Metered API calls", amountMinor: 2500n, kind: "usage" },
  ],
  applyTax: false,
});
{
  const paid = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: mixed.invoice.publicId,
    method: "wire",
  });
  const rows = await attributeInvoicePayments({
    organizationId: orgId,
    invoiceId: mixed.invoice.id,
  });
  eq_("one payment settled the document", rows.length, 1);
  const r = rows[0]!;
  invariant("mixed/full", r);
  eq_("payment amount", r.signedAmountMinor, BigInt(paid.payment.amountMinor));
  eq_("recurring = plan + proration", r.recurringMinor, 67500n);
  eq_("non-recurring = the setup fee", r.nonRecurringMinor, 25000n);
  eq_("usage is its own bucket", r.usageMinor, 2500n);
  eq_("plan line alone", r.buckets.recurring, 60000n);
  eq_("proration line alone", r.buckets.proration, 7500n);
  eq_("nothing unattributed", r.buckets.unattributed, 0n);
  eq_("one allocation per line", r.lines.length, 4);
}

// ── §4 PARTIAL PAYMENT ────────────────────────────────────────────────────────────────
// Two lines that do NOT divide cleanly, settled with a third of the document, so both the
// pro-rata rule and the remainder rule are exercised at once.
console.log("\n§4 partial payment");
const partialInv = await createInvoiceFromLines({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  currency: "USD",
  lines: [
    { description: "Plan — monthly", amountMinor: 3333n, kind: "recurring" },
    { description: "Setup fee", amountMinor: 3333n, kind: "one_time" },
    { description: "Ad-hoc charge", amountMinor: 3334n, kind: "one_time" },
  ],
  applyTax: false,
});
{
  const first = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: partialInv.invoice.publicId,
    amountMinor: 3334, // a third of 10000, and indivisible across these weights
  });
  eq_("partial payment booked", first.payment.amountMinor, 3334);
  let rows = await attributeInvoicePayments({
    organizationId: orgId,
    invoiceId: partialInv.invoice.id,
  });
  eq_("one row so far", rows.length, 1);
  const p1 = rows[0]!;
  invariant("partial #1", p1);
  check(
    "no bucket is settled first — recurring is a THIRD of the plan line, not all of it",
    p1.recurringMinor > 1000n && p1.recurringMinor < 1200n,
    `recurring=${p1.recurringMinor}`,
  );
  check(
    "the one-off share scales with it",
    p1.nonRecurringMinor > 2100n && p1.nonRecurringMinor < 2300n,
    `nonRecurring=${p1.nonRecurringMinor}`,
  );

  // Settle the rest. Σ over BOTH payments must be the whole document, exactly — the
  // remainder cannot be double-counted or dropped between two partial payments.
  const second = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: partialInv.invoice.publicId,
  });
  eq_("remainder collected", second.payment.amountMinor, 6666);
  rows = await attributeInvoicePayments({
    organizationId: orgId,
    invoiceId: partialInv.invoice.id,
  });
  eq_("two rows now", rows.length, 2);
  for (const r of rows) invariant("partial pair", r);
  const cash = rows.reduce((s, r) => s + r.signedAmountMinor, 0n);
  const rec = rows.reduce((s, r) => s + r.recurringMinor, 0n);
  const non = rows.reduce((s, r) => s + r.nonRecurringMinor, 0n);
  eq_("two partials collected the document", cash, 10000n);
  eq_("recurring over both = the plan line", rec, 3333n);
  eq_("non-recurring over both = the two one-off lines", non, 6667n);
  eq_("and they add back to the cash", rec + non, cash);
}

// ── §4b TAX AND A NEGATIVE LINE, half paid ────────────────────────────────────────────
// A real document carries a tax line and, when an invoice-level coupon applied, a NEGATIVE
// `discount` line. Mixed signs are where a pro-rata split goes wrong quietly, so this is the
// DB-level counterpart to §1's negative-weight cases. Weights sum to 88500 and the payment
// is exactly half, so every bucket has an exact expected value — no tolerance to hide in.
console.log("\n§4b tax and a negative line, half paid");
{
  const doc = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    currency: "USD",
    lines: [
      { description: "Plan — monthly", amountMinor: 60000n, kind: "recurring" },
      { description: "Setup fee", amountMinor: 20000n, kind: "one_time" },
      { description: "Discount", amountMinor: -5000n, kind: "discount" },
      { description: "Sales tax (18.00%)", amountMinor: 13500n, kind: "tax" },
    ],
    applyTax: false,
  });
  const half = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: doc.invoice.publicId,
    amountMinor: 44250, // exactly half of 88500
  });
  eq_("half the document collected", half.payment.amountMinor, 44250);
  const r = (
    await attributeInvoicePayments({ organizationId: orgId, invoiceId: doc.invoice.id })
  )[0]!;
  invariant("tax + negative line", r);
  eq_("recurring is half the plan line", r.buckets.recurring, 30000n);
  eq_("one-off is half the setup fee", r.nonRecurringMinor, 10000n);
  eq_("TAX IS NOT PAID FIRST — it is half the tax line", r.taxMinor, 6750n);
  eq_("the discount line carries a NEGATIVE share", r.buckets.discount, -2500n);
  eq_("and the four still add to the cash", 30000n + 10000n - 2500n + 6750n, 44250n);
}

// ── §4c TAX INSIDE A TAX-INCLUSIVE PRICE ──────────────────────────────────────────────
// On an inclusive price the tax is inside the product line and the document carries no tax
// line for it, so the tax used to land in the revenue bucket and `recurring_payments` read
// high by it. Every figure below is exact: 20% inside 120.00 is 20.00 on the nose.
console.log("\n§4c tax inside an inclusive price");
await createFlatTaxRate({
  organizationId: orgId,
  businessId: biz.id,
  name: "GST",
  country: "IN",
  rateBps: 2000,
});
const inCustomer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "inclusive@example.com",
  address: { line1: "1 St", country: "IN" },
});
const incPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 12000,
  interval: "month",
  taxBehavior: "inclusive",
});
const exPrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});
const incInvoice = (lines: Parameters<typeof createInvoiceFromLines>[0]["lines"]) =>
  createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: inCustomer.id,
    currency: "USD",
    lines,
    applyTax: true,
  });
{
  // A pure inclusive document: 120.00 billed, 120.00 collected, 20.00 of it tax.
  const doc = await incInvoice([
    { description: "Plan — monthly", amountMinor: 12000n, kind: "recurring", priceId: incPrice.id },
  ]);
  eq_("inclusive: the tax is NOT added on top", doc.invoice.totalMinor, 12000n);
  const paid = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: doc.invoice.publicId,
    method: "wire",
  });
  eq_("inclusive: the whole document collected", paid.payment.amountMinor, 12000);
  const r = (
    await attributeInvoicePayments({ organizationId: orgId, invoiceId: doc.invoice.id })
  )[0]!;
  invariant("inclusive/full", r);
  eq_("inclusive: revenue is NET of the tax inside it", r.recurringMinor, 10000n);
  eq_("inclusive: the tax collected is in the tax bucket", r.taxMinor, 2000n);
  eq_("inclusive: and the two are the cash", r.recurringMinor + r.taxMinor, 12000n);
  eq_("inclusive: the line is split in two, not duplicated", r.lines.length, 2);
  eq_("inclusive: nothing unattributed", r.buckets.unattributed, 0n);
}
{
  // A MIXED document: an inclusive plan line and an exclusive setup fee that does carry a
  // tax line. 20.00 comes out of the plan, 10.00 sits on its own line, tax = 30.00.
  const doc = await incInvoice([
    { description: "Plan — monthly", amountMinor: 12000n, kind: "recurring", priceId: incPrice.id },
    { description: "Setup fee", amountMinor: 5000n, kind: "one_time" },
  ]);
  eq_(
    "mixed inclusive: only the exclusive line grosses up the total",
    doc.invoice.totalMinor,
    18000n,
  );
  const paid = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: doc.invoice.publicId,
    method: "wire",
  });
  const r = (
    await attributeInvoicePayments({ organizationId: orgId, invoiceId: doc.invoice.id })
  )[0]!;
  invariant("inclusive/mixed", r);
  eq_("mixed inclusive: plan revenue net of its own tax", r.recurringMinor, 10000n);
  eq_("mixed inclusive: the setup fee is untouched", r.nonRecurringMinor, 5000n);
  eq_("mixed inclusive: tax = backed out 2000 + the printed 1000", r.taxMinor, 3000n);
  eq_(
    "mixed inclusive: Σ is the payment",
    r.recurringMinor + r.nonRecurringMinor + r.taxMinor,
    BigInt(paid.payment.amountMinor),
  );
}
{
  // THE CONTROL: the same 100.00 of revenue priced EXCLUSIVE. Same split, reached the way it
  // always was — a tax line into the tax bucket, one allocation per line, nothing backed out.
  const doc = await incInvoice([
    { description: "Plan — monthly", amountMinor: 10000n, kind: "recurring", priceId: exPrice.id },
  ]);
  eq_("exclusive: tax is added on top", doc.invoice.totalMinor, 12000n);
  await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: doc.invoice.publicId,
    method: "wire",
  });
  const r = (
    await attributeInvoicePayments({ organizationId: orgId, invoiceId: doc.invoice.id })
  )[0]!;
  invariant("exclusive control", r);
  eq_("exclusive: revenue unchanged", r.recurringMinor, 10000n);
  eq_("exclusive: tax unchanged", r.taxMinor, 2000n);
  eq_("exclusive: no line was split", r.lines.length, 2);
  eq_("exclusive: one allocation per line item", new Set(r.lines.map((l) => l.lineItemId)).size, 2);
}
{
  // A PARTIAL payment of an inclusive document is part revenue and part tax, in proportion:
  // half of 120.00 is 50.00 revenue + 10.00 tax. Tax is not settled first.
  const doc = await incInvoice([
    { description: "Plan — monthly", amountMinor: 12000n, kind: "recurring", priceId: incPrice.id },
  ]);
  const half = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: doc.invoice.publicId,
    amountMinor: 6000,
  });
  eq_("inclusive: half collected", half.payment.amountMinor, 6000);
  const r = (
    await attributeInvoicePayments({ organizationId: orgId, invoiceId: doc.invoice.id })
  )[0]!;
  invariant("inclusive/partial", r);
  eq_("inclusive partial: half the net revenue", r.recurringMinor, 5000n);
  eq_("inclusive partial: half the tax", r.taxMinor, 1000n);

  // …and the rest: the two partials add back to the whole document, in both buckets.
  const rest = await recordOfflinePayment({
    organizationId: orgId,
    businessId: biz.id,
    invoicePublicId: doc.invoice.publicId,
  });
  eq_("inclusive: remainder collected", rest.payment.amountMinor, 6000);
  const both = await attributeInvoicePayments({ organizationId: orgId, invoiceId: doc.invoice.id });
  for (const row of both) invariant("inclusive partial pair", row);
  eq_(
    "inclusive: two partials = the whole net revenue",
    both.reduce((s, row) => s + row.recurringMinor, 0n),
    10000n,
  );
  eq_(
    "inclusive: two partials = the whole tax",
    both.reduce((s, row) => s + row.taxMinor, 0n),
    2000n,
  );
}
{
  // A REFUND of inclusive cash comes back out of both buckets: every one nets to zero.
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: inCustomer,
    token: "tok_4242",
  });
  const doc = await createInvoiceFromLines({
    organizationId: orgId,
    businessId: biz.id,
    customerId: inCustomer.id,
    currency: "USD",
    lines: [
      {
        description: "Plan — monthly",
        amountMinor: 12000n,
        kind: "recurring",
        priceId: incPrice.id,
      },
    ],
    applyTax: true,
    collect: true,
  });
  const paid = (
    await attributeInvoicePayments({
      organizationId: orgId,
      invoiceId: doc.invoice.id,
    })
  )[0]!;
  eq_("inclusive: the card collected it", paid.signedAmountMinor, 12000n);
  eq_("inclusive: collected revenue is net", paid.recurringMinor, 10000n);
  eq_("inclusive: collected tax", paid.taxMinor, 2000n);
  await refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: paid.publicId,
  });
  const rows = await attributeInvoicePayments({ organizationId: orgId, invoiceId: doc.invoice.id });
  for (const row of rows) invariant("inclusive refunded", row);
  check(
    "inclusive: a fully refunded document nets to zero in EVERY bucket",
    PAYMENT_BUCKETS.every((b) => rows.reduce((s, row) => s + row.buckets[b], 0n) === 0n),
  );
  eq_(
    "inclusive: and the tax bucket specifically",
    rows.reduce((s, row) => s + row.taxMinor, 0n),
    0n,
  );
}

// ── §5 REFUND ─────────────────────────────────────────────────────────────────────────
console.log("\n§5 refund");
{
  // Half the renewal back.
  const part = await refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: billed.payment.publicId,
    amountMinor: 5000,
    reason: "partial",
  });
  eq_("partial refund booked", part.amountMinor, 5000n);
  let rows = await attributeInvoicePayments({
    organizationId: orgId,
    invoiceId: billed.invoice.id,
  });
  const refundRow = rows.find((r) => r.direction === "refund");
  check("the refund is attributed at all", !!refundRow);
  invariant("refund", refundRow!);
  eq_("the refund is negative", refundRow!.signedAmountMinor, -5000n);
  eq_(
    "and it is negative RECURRING — the same bucket it was collected in",
    refundRow!.recurringMinor,
    -5000n,
  );
  eq_("it inherits the invoice", refundRow!.invoiceId, billed.invoice.id);

  // Refund the rest: net cash and every net bucket must be exactly zero.
  const rest = await refundPayment({
    organizationId: orgId,
    businessId: biz.id,
    paymentPublicId: billed.payment.publicId,
  });
  eq_("remainder refunded", rest.amountMinor, 5000n);
  rows = await attributeInvoicePayments({
    organizationId: orgId,
    invoiceId: billed.invoice.id,
  });
  for (const r of rows) invariant("refunded pair", r);
  eq_(
    "net cash on a fully refunded invoice",
    rows.reduce((s, r) => s + r.signedAmountMinor, 0n),
    0n,
  );
  eq_(
    "net recurring",
    rows.reduce((s, r) => s + r.recurringMinor, 0n),
    0n,
  );
  check(
    "every net bucket is zero",
    PAYMENT_BUCKETS.every((b) => rows.reduce((s, r) => s + r.buckets[b], 0n) === 0n),
  );
}

// ── §6 UNATTRIBUTED — cash with no line to sit on ─────────────────────────────────────
console.log("\n§6 unattributed cash is reported, not dropped");
{
  // `payments.invoice_id` is ON DELETE SET NULL, so a payment really can lose its document.
  const [orphan] = await withTenant(orgId, (tx) =>
    tx
      .insert(payments)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        invoiceId: null,
        publicId: `pay_alloc_orphan_${Date.now()}`,
        status: "succeeded",
        amountMinor: 4242n,
        currency: "USD",
        providerKey: "offline",
        providerChargeId: "cash",
      })
      .returning(),
  );
  const rows = await attributePaymentsForBusiness({ organizationId: orgId, businessId: biz.id });
  const o = rows.find((r) => r.publicId === orphan!.publicId)!;
  check("the orphan payment is still reported", !!o);
  invariant("orphan", o);
  eq_("all of it is unattributed", o.buckets.unattributed, 4242n);
  eq_("and none of it is claimed as recurring", o.recurringMinor, 0n);
}

// ── THE BUSINESS-WIDE ROLL-UP ─────────────────────────────────────────────────────────
console.log("\n§7 the business-wide roll-up a report calls");
{
  const rows = await attributePaymentsForBusiness({ organizationId: orgId, businessId: biz.id });
  for (const r of rows) invariant(`roll-up ${r.publicId}`, r);
  const totals = totalsByCurrency(rows);
  const usd = totals.get("USD")!;
  const cash = rows.reduce((s, r) => s + r.signedAmountMinor, 0n);
  const bucketSum = PAYMENT_BUCKETS.reduce((s, b) => s + usd[b], 0n);
  eq_("Σ buckets over the whole business = Σ cash", bucketSum, cash);
  check(
    "rows are ordered by time",
    rows.every((r, i) => i === 0 || rows[i - 1]!.occurredAt <= r.occurredAt),
  );
  check(
    "refunds are included by default",
    rows.some((r) => r.direction === "refund"),
  );
  const noRefunds = await attributePaymentsForBusiness({
    organizationId: orgId,
    businessId: biz.id,
    includeRefunds: false,
  });
  check(
    "…and can be excluded",
    noRefunds.every((r) => r.direction === "payment"),
  );
  // Tenancy: another org's business must see none of this.
  const other = await createOrganization({ name: "Payment Allocation Other Org" });
  const otherBiz = await createBusiness({
    organizationId: other.organization.id,
    name: "Other",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const leaked = await attributePaymentsForBusiness({
    organizationId: other.organization.id,
    businessId: otherBiz.id,
  });
  eq_("no cross-tenant leak", leaked.length, 0);
  // And the invoice-scoped path agrees with the business-wide one.
  const scoped = await attributeInvoicePayments({
    organizationId: orgId,
    invoiceId: mixed.invoice.id,
  });
  const wide = rows.filter((r) => r.invoiceId === mixed.invoice.id);
  eq_(
    "the two entry points agree on the mixed invoice",
    scoped.reduce((s, r) => s + r.recurringMinor, 0n),
    wide.reduce((s, r) => s + r.recurringMinor, 0n),
  );
}

// A last direct read: the raw payment rows this suite produced, and their Σ.
const bookedCash = await withTenant(orgId, async (tx) => {
  const rows = await tx.select().from(payments).where(eq(payments.businessId, biz.id));
  return rows.filter((r) => r.status === "succeeded").reduce((s, r) => s + r.amountMinor, 0n);
});
console.log(`\nbooked cash (succeeded payments): ${bookedCash}`);

// ── §8 THE REPORTS BUILT ON IT ────────────────────────────────────────────────────────
// The allocator being exact is worth nothing if the report layer then reports something
// else. These are the identities a reader will check by eye — the composition adding up to
// the cash, and the named report agreeing with its row in that composition.
console.log("\n§8 the reports agree with the allocation");
{
  const opts = { range: "12m", currency: "USD" } as const;
  const [composition, recurring, nonRecurring, usage, netRecurring] = await Promise.all([
    resolveReport(orgId, biz.id, "cash_composition", opts),
    resolveReport(orgId, biz.id, "recurring_payments", opts),
    resolveReport(orgId, biz.id, "non_recurring_payments", opts),
    resolveReport(orgId, biz.id, "usage_payments", opts),
    resolveReport(orgId, biz.id, "net_recurring_payments", opts),
  ]);

  const rowOf = (id: string) => composition.rows?.find((r) => r.group_id === id)?.value ?? 0;
  const rowSum = (composition.rows ?? []).reduce((s, r) => s + r.value, 0);

  // Gross cash, split every way and put back together. This is the identity that makes the
  // composition readable as a whole: no bucket is missing and none is counted twice.
  eq_("composition sums to its own headline", rowSum, composition.headline);

  /**
   * …and to the PAYMENT ROWS, which is a different total from `total_payments`.
   *
   * `total_payments` sums `transactions` — the gateway log — and these reports sum
   * `payments` — the cash applied to a document. The two are equal on a book this engine
   * billed itself and are NOT equal in two real cases: a payment with no transaction row
   * (§6's orphan, 4,242 here), and an imported transaction that settled several invoices,
   * where the importer deliberately stores the APPLIED amount on the payment and the whole
   * gateway amount on the transaction. So this asserts against the source these reports
   * actually read; asserting against `total_payments` would fail on any migrated book and
   * would be asserting that two different questions have one answer.
   */
  const bookedUsd = await withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(payments).where(eq(payments.businessId, biz.id));
    return rows
      .filter((r) => r.status === "succeeded" && r.currency === "USD")
      .reduce((s, r) => s + r.amountMinor, 0n);
  });
  eq_("…and to the succeeded payment rows it reads", composition.headline, Number(bookedUsd));

  // Each named report is its own row of that composition — the same figure, not a second
  // calculation that happens to be close.
  eq_(
    "recurring = subscription fees + prorated changes",
    recurring.headline,
    rowOf("recurring") + rowOf("proration"),
  );
  eq_("non-recurring = one-off charges", nonRecurring.headline, rowOf("one_time"));
  eq_("usage = metered usage", usage.headline, rowOf("usage"));

  // §5 refunded a payment in full, so net MUST be below gross here. A gate that only
  // asserted `net <= gross` would also pass if refunds were silently dropped.
  check(
    "net recurring is gross less the refunded part",
    netRecurring.headline! < recurring.headline!,
    `net ${netRecurring.headline} vs gross ${recurring.headline}`,
  );

  // The series is the same answer cut up; if it disagrees with the headline, one of them is
  // being computed from a different window.
  const seriesSum = recurring.points.reduce((s, p) => s + p.v, 0);
  eq_("the recurring series sums to its headline", seriesSum, recurring.headline);

  const grouped = await resolveReport(orgId, biz.id, "recurring_payments", {
    ...opts,
    groupBy: "currency",
  });
  eq_(
    "grouped by currency, the rows sum to the headline",
    (grouped.rows ?? []).reduce((s, r) => s + r.value, 0),
    grouped.headline,
  );
  await resolveReport(orgId, biz.id, "cash_composition", { ...opts, groupBy: "currency" }).then(
    () => check("a breakdown the composition does not offer is refused", false),
    () => check("a breakdown the composition does not offer is refused", true),
  );
}

console.log("");
console.log(`${ok} ok, ${fail} failed`);
console.log(fail === 0 ? "✅ PAYMENT ALLOCATION: PASS" : "❌ PAYMENT ALLOCATION: FAIL");
await closeDb();
process.exit(fail === 0 ? 0 : 1);
