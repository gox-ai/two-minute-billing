/**
 * Coupons on change invoices that carry credit lines ("Unused time on X" netted against
 * "Remaining time on Y" on one invoice):
 *  - each credit is restated at what was paid for that time (`creditPaidBasis`);
 *  - the coupons that apply after the change discount the NET; the discount never
 *    exceeds it; a fixed coupon draws on the period allowance the credit hands back;
 *  - item-scoped coupons net only the lines they match; `plan_change_coupons: drop`;
 *  - inclusive tax; a downgrade still goes to a credit note;
 *  - every invoice's ledger entry balances, and `estimateChange` equals the booking.
 *
 *   pnpm verify:coupons-proration
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { estimateChange } from "@/modules/subscriptions/estimate";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { serializeInvoice } from "@/modules/invoicing/serialize";
import { createCoupon, applyCouponToSubscription, removeDiscount } from "@/modules/coupons/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { getSubscriptionItems } from "@/modules/subscriptions/service";
import {
  appliedCoupons,
  invoiceLineDiscounts,
  invoiceLineItems,
  invoices,
  ledgerEntries,
  subscriptions,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean, detail?: unknown) => {
  checks.push([name, pass]);
  if (!pass && detail !== undefined) console.log(`    ↳ ${name}: ${JSON.stringify(detail)}`);
};

const org = await createOrganization({ name: "Coupon Proration Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
await createFlatTaxRate({ ...ctx, name: "VAT", country: "GB", rateBps: 1000 });

const planProduct = await createProduct({ ...ctx, name: "Plans" });
const otherProduct = await createProduct({ ...ctx, name: "Pro Plans" });
const recurring = (productId: string, amountMinor: number, extra: object = {}) =>
  createPrice({
    ...ctx,
    productId,
    type: "recurring",
    currency: "USD",
    amountMinor,
    interval: "month",
    model: "flat",
    ...extra,
  });
const seat = await recurring(planProduct.id, 1000, { model: "per_unit" });
const A = await recurring(planProduct.id, 1000);
const B = await recurring(otherProduct.id, 2000);
const AIncl = await recurring(planProduct.id, 1100, { taxBehavior: "inclusive" });
const BIncl = await recurring(otherProduct.id, 2200, { taxBehavior: "inclusive" });

let n = 0;
async function mkSub(price: typeof A, quantity = 1, taxBehavior?: "inclusive") {
  const customer = await createCustomer({
    ...ctx,
    email: `cp${++n}@example.com`,
    address: { line1: "1 St", country: "GB" },
    ...(taxBehavior ? { taxBehavior } : {}),
  });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity }],
  });
  const item = (await getSubscriptionItems(orgId, subscription.id))[0]!;
  return { sub: subscription, item, customer };
}
const freshSub = async (id: string) =>
  (
    await withTenant(orgId, (tx) => tx.select().from(subscriptions).where(eq(subscriptions.id, id)))
  )[0]!;
const billTerm = async (subId: string) => {
  const s = await freshSub(subId);
  return billSubscriptionPeriod({
    ...ctx,
    subscription: s,
    periodStart: s.currentPeriodStart!,
    periodEnd: s.currentPeriodEnd!,
  });
};
let c = 0;
async function coupon(spec: {
  kind: "percentage" | "fixed_amount";
  pct?: number;
  amount?: number;
  duration?: "once" | "forever";
  applyOn?: "invoice_amount" | "each_specified_item";
  productIds?: string[];
  constraint?: "all" | "specific";
}) {
  const code = `CP${++c}`;
  await createCoupon({
    ...ctx,
    code,
    kind: spec.kind,
    ...(spec.pct != null ? { percentOffBps: spec.pct } : {}),
    ...(spec.amount != null ? { amountOffMinor: spec.amount, currency: "USD" } : {}),
    durationType: spec.duration ?? "forever",
    ...(spec.applyOn ? { applyOn: spec.applyOn } : {}),
    ...(spec.applyOn === "each_specified_item"
      ? {
          itemConstraints: [
            {
              itemKind: "plan" as const,
              constraintType: spec.constraint ?? "all",
              ...(spec.productIds ? { productIds: spec.productIds } : {}),
            },
          ],
        }
      : {}),
  });
  return code;
}
const applyCoupon = (subscriptionId: string, code: string) =>
  applyCouponToSubscription({ ...ctx, subscriptionId, code, now: new Date(), skipItemMatch: true });

/** The invoice as its own document states it, plus the ledger and line facts. */
async function inspect(invoiceId: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    const lines = await tx
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoiceId));
    const shares = await tx
      .select()
      .from(invoiceLineDiscounts)
      .where(eq(invoiceLineDiscounts.invoiceId, invoiceId));
    const ledger = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.sourceType, "invoice"), eq(ledgerEntries.sourceId, row!.publicId)),
      );
    const sum = (dir: "debit" | "credit") =>
      ledger.filter((e) => e.direction === dir).reduce((s, e) => s + e.amountMinor, 0n);
    const signed = (account: string, positive: "debit" | "credit") =>
      ledger
        .filter((e) => e.account === account)
        .reduce((s, e) => s + (e.direction === positive ? e.amountMinor : -e.amountMinor), 0n);
    const doc = serializeInvoice(row!, {
      lines: lines.map((l) => ({ line: l, price: null })),
      discountShares: shares,
      paidMinor: 0n,
    });
    const charged = lines.filter((l) => !["tax", "discount", "rounding"].includes(l.kind ?? ""));
    const net = charged.reduce((s, l) => s + l.amountMinor, 0n);
    const discount = signed("discounts", "debit");
    const tax = signed("tax_payable", "credit");
    return {
      row: row!,
      doc,
      lines,
      credits: charged.filter((l) => l.amountMinor <= 0n && l.description.startsWith("Unused")),
      net,
      discount,
      tax,
      balanced: ledger.length > 0 && sum("debit") === sum("credit"),
      // total = net charge − discount + exclusive tax (inclusive tax is inside `net`).
      identity:
        row!.totalMinor === net - discount + (lines.some((l) => l.kind === "tax") ? tax : 0n),
    };
  });
}
const periodUsed = async (subscriptionId: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, subscriptionId)),
    )
  )[0]?.periodUsedMinor ?? null;

/** Estimate, then apply the same change at the same instant. */
async function change(
  s: Awaited<ReturnType<typeof mkSub>>,
  newPrice: typeof A,
  opts: { qty?: number; planChangeCoupons?: "keep" | "drop" | "keep_if_valid" } = {},
) {
  const at = s.sub.currentPeriodStart!;
  const changes = [
    opts.qty != null
      ? { itemId: s.item.publicId, newQuantity: opts.qty }
      : { itemId: s.item.publicId, newPriceId: newPrice.publicId },
  ];
  const rule = { planChangeCoupons: opts.planChangeCoupons ?? "keep" };
  const est = await estimateChange({ ...ctx, subscriptionId: s.sub.id, now: at, changes, ...rule });
  const r = await changeSubscription({
    ...ctx,
    subscriptionId: s.sub.id,
    now: at,
    changes,
    invoiceImmediately: true,
    ...rule,
  });
  return { est, r, inv: r.prorationInvoice ? await inspect(r.prorationInvoice.id) : null };
}
const estMatches = (
  label: string,
  est: Awaited<ReturnType<typeof estimateChange>>,
  inv: Awaited<ReturnType<typeof inspect>>,
) => {
  ok(`${label}: estimate total == invoice total`, est.total_minor === inv.doc.total_minor, {
    est: est.total_minor,
    inv: inv.doc.total_minor,
  });
  ok(`${label}: estimate tax == invoice tax`, est.tax_minor === Number(inv.tax), {
    est: est.tax_minor,
    inv: Number(inv.tax),
  });
};
const sound = (label: string, inv: Awaited<ReturnType<typeof inspect>>) => {
  ok(`${label}: ledger entry balanced`, inv.balanced);
  ok(`${label}: total = net − discount + tax`, inv.identity, {
    total: inv.row.totalMinor,
    net: inv.net,
    discount: inv.discount,
    tax: inv.tax,
  });
  ok(`${label}: discount never exceeds the net`, inv.discount <= inv.net);
};

// ── 1) 10 → 11 seats, 10% forever, term billed ──────────────────────────────────
// A same-price quantity move bills the added unit as one line; the coupon takes 10%.
{
  const s = await mkSub(seat, 10);
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 1000 }));
  await billTerm(s.sub.id);
  const { est, inv } = await change(s, seat, { qty: 11 });
  console.log(`seats 10→11: total=${inv?.row.totalMinor} discount=${inv?.discount}`);
  ok("seats: the added seat is billed 1000 − 100 + 90 tax = 990", inv?.row.totalMinor === 990n);
  if (inv) {
    sound("seats", inv);
    estMatches("seats", est, inv);
  }
}

// ── 2) The same move as an unused/remaining PAIR on one invoice (engine level) ──
// Before: a 10% coupon on gross 11000 against a net 1000 subtotal, or no coupon at all.
// Now: the credit is what was paid (10000 less its 1000 of coupon = 9000), and the coupon
// discounts the charge: 11000 − 1100 − 9000 = 900, + 90 tax.
{
  const s = await mkSub(seat, 10);
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 1000 }));
  await billTerm(s.sub.id);
  const sub = await freshSub(s.sub.id);
  const { invoice } = await createInvoiceFromLines({
    ...ctx,
    customerId: s.customer.id,
    subscriptionId: sub.id,
    subscription: sub,
    currency: "USD",
    lines: [
      {
        description: "Unused time on seat ×10",
        amountMinor: -10000n,
        priceId: seat.id,
        quantity: 10,
      },
      {
        description: "Remaining time on seat ×11",
        amountMinor: 11000n,
        priceId: seat.id,
        quantity: 11,
      },
    ],
    applyTax: true,
    applyCoupons: true,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  const inv = await inspect(invoice.id);
  console.log(
    `pair 10→11: credit=${inv.credits[0]?.amountMinor} discount=${inv.discount} total=${inv.row.totalMinor}`,
  );
  ok("pair: the credit is what was paid (−9000)", inv.credits[0]?.amountMinor === -9000n);
  ok("pair: 10% off the new charge (1100)", inv.discount === 1100n);
  ok("pair: total 900 + 90 tax = 990, same as the one-line shape", inv.row.totalMinor === 990n);
  sound("pair", inv);
}

// ── 3) Upgrade swap A → B, 10% forever, term never billed: the coupon nets ─────
{
  const s = await mkSub(A);
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 1000 }));
  const { est, inv } = await change(s, B);
  console.log(`swap 10%: total=${inv?.row.totalMinor} discount=${inv?.discount}`);
  ok("swap 10%: (2000 − 1000) × 0.9 = 900, + 90 tax", inv?.row.totalMinor === 990n);
  ok(
    "swap 10%: the unbilled credit stays at list (−1000)",
    inv?.credits[0]?.amountMinor === -1000n,
  );
  if (inv) {
    sound("swap 10%", inv);
    estMatches("swap 10%", est, inv);
  }
}

// ── 4) Upgrade swap with a FIXED coupon (300 forever), term never billed ───────
{
  const s = await mkSub(A);
  await applyCoupon(s.sub.id, await coupon({ kind: "fixed_amount", amount: 300 }));
  const { est, inv } = await change(s, B);
  console.log(`swap fixed: total=${inv?.row.totalMinor} used=${await periodUsed(s.sub.id)}`);
  ok("swap fixed: 1000 − 300 = 700, + 70 tax", inv?.row.totalMinor === 770n);
  ok("swap fixed: the period allowance records 300", (await periodUsed(s.sub.id)) === 300n);
  if (inv) {
    sound("swap fixed", inv);
    estMatches("swap fixed", est, inv);
  }
}

// ── 5) Fixed coupon, term billed: the credit hands back its share of the allowance ──
// Term 1000 − 300. A credit for half the term (list 500) was paid 350; its 150 of coupon
// returns to the period, so the 1100 charge takes 150: 1100 − 150 − 350 = 600. The
// period still records 300 used — never more than the coupon's face.
{
  const s = await mkSub(A);
  await applyCoupon(s.sub.id, await coupon({ kind: "fixed_amount", amount: 300 }));
  await billTerm(s.sub.id);
  const sub = await freshSub(s.sub.id);
  const { invoice } = await createInvoiceFromLines({
    ...ctx,
    customerId: s.customer.id,
    subscriptionId: sub.id,
    subscription: sub,
    currency: "USD",
    lines: [
      { description: "Unused time on A ×1", amountMinor: -500n, priceId: A.id, quantity: 1 },
      { description: "Remaining time on B ×1", amountMinor: 1100n, priceId: B.id, quantity: 1 },
    ],
    applyTax: true,
    applyCoupons: true,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  const inv = await inspect(invoice.id);
  const used = await periodUsed(s.sub.id);
  console.log(
    `fixed billed: credit=${inv.credits[0]?.amountMinor} discount=${inv.discount} used=${used}`,
  );
  ok("fixed billed: credit at paid basis (−350)", inv.credits[0]?.amountMinor === -350n);
  ok("fixed billed: the released 150 discounts the charge", inv.discount === 150n);
  ok("fixed billed: total 600 + 60 tax", inv.row.totalMinor === 660n);
  ok("fixed billed: the period still records 300 used", used === 300n);
  sound("fixed billed", inv);
}

// ── 6) Paid basis: a 100% `once` coupon made the term free ─────────────────────
// The term invoice is zero-total, so no credit note can attach and the credit nets on
// the change invoice. Nothing was paid for the unused time, so nothing is handed back:
// the new plan is charged in full (2000 + 200), not the list difference.
{
  const s = await mkSub(A);
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 10000, duration: "once" }));
  const term = await billTerm(s.sub.id);
  const { est, inv } = await change(s, B);
  console.log(
    `free term: term total=${term.invoice.totalMinor} change total=${inv?.row.totalMinor} credit=${inv?.credits[0]?.amountMinor}`,
  );
  ok("free term: precondition — the term invoice is zero-total", term.invoice.totalMinor === 0n);
  ok(
    "free term: the unused time is credited at what was paid (0)",
    inv?.credits[0]?.amountMinor === 0n,
  );
  ok("free term: the new plan is charged in full, 2000 + 200", inv?.row.totalMinor === 2200n);
  if (inv) {
    sound("free term", inv);
    estMatches("free term", est, inv);
  }
}

// ── 7) Paid basis + the coupon removed: credited what was paid, charged list ───
{
  const s = await mkSub(A);
  const code = await coupon({ kind: "percentage", pct: 1000 });
  await applyCoupon(s.sub.id, code);
  await billTerm(s.sub.id);
  await removeDiscount(orgId, s.sub.id, code);
  const sub = await freshSub(s.sub.id);
  const { invoice } = await createInvoiceFromLines({
    ...ctx,
    customerId: s.customer.id,
    subscriptionId: sub.id,
    subscription: sub,
    currency: "USD",
    lines: [
      { description: "Unused time on A ×1", amountMinor: -1000n, priceId: A.id, quantity: 1 },
      { description: "Remaining time on B ×1", amountMinor: 2000n, priceId: B.id, quantity: 1 },
    ],
    applyTax: true,
    applyCoupons: true,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  const inv = await inspect(invoice.id);
  ok("dropped, paid 900: credited 900", inv.credits[0]?.amountMinor === -900n);
  ok(
    "dropped, paid 900: no discount, total 1100 + 110",
    inv.row.totalMinor === 1210n && inv.discount === 0n,
  );
  sound("dropped paid", inv);
}

// ── 8) plan_change_coupons = drop: the change bills without the coupon ─────────
{
  const s = await mkSub(A);
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 1000 }));
  const { est, inv } = await change(s, B, { planChangeCoupons: "drop" });
  ok("drop: no discount, 1000 + 100", inv?.row.totalMinor === 1100n && inv?.discount === 0n);
  if (inv) {
    sound("drop", inv);
    estMatches("drop", est, inv);
  }
}

// ── 9) Inclusive tax: the discount comes off the inclusive net ─────────────────
// 2200 − 1100 = 1100 tax-inclusive; 10% → 990, of which 90 is tax backed out of the one
// rate. Price-level inclusive: the booking only (`estimateChange` prices every change
// exclusive of a price's own tax behaviour; a separate gap).
{
  const s = await mkSub(AIncl);
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 1000 }));
  const { inv } = await change(s, BIncl);
  console.log(`inclusive: total=${inv?.row.totalMinor} tax=${inv?.tax} discount=${inv?.discount}`);
  ok("inclusive price: total 990", inv?.row.totalMinor === 990n);
  ok("inclusive price: tax backed out of the one rate, 90", inv?.tax === 90n);
  if (inv) {
    ok("inclusive price: ledger entry balanced", inv.balanced);
    ok("inclusive price: total = net − discount", inv.row.totalMinor === inv.net - inv.discount);
  }
}
{
  // The same money for a customer whose prices include tax, which the estimate prices.
  const A2 = await recurring(planProduct.id, 1100);
  const B2 = await recurring(otherProduct.id, 2200);
  const s = await mkSub(A2, 1, "inclusive");
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 1000 }));
  const { est, inv } = await change(s, B2);
  ok("inclusive customer: total 990", inv?.row.totalMinor === 990n);
  ok("inclusive customer: tax 90 inside it", inv?.tax === 90n);
  if (inv) {
    ok("inclusive customer: ledger entry balanced", inv.balanced);
    ok(
      "inclusive customer: estimate total == invoice total",
      est.total_minor === inv.doc.total_minor,
      {
        est: est.total_minor,
        inv: inv.doc.total_minor,
      },
    );
    ok("inclusive customer: estimate tax == invoice tax", est.tax_minor === Number(inv.tax), {
      est: est.tax_minor,
      inv: Number(inv.tax),
    });
  }
}

// ── 10) Item-scoped coupons net only the lines they match ──────────────────────
{
  // Matches every plan: the old plan's credit and the new plan's charge → 10% of 1000.
  const s = await mkSub(A);
  await applyCoupon(
    s.sub.id,
    await coupon({ kind: "percentage", pct: 1000, applyOn: "each_specified_item" }),
  );
  const { est, inv } = await change(s, B);
  ok("item-scoped (all plans): 900 + 90", inv?.row.totalMinor === 990n);
  if (inv) {
    sound("item-scoped all", inv);
    estMatches("item-scoped all", est, inv);
  }
}
{
  // Matches only the new plan's product: 2000 × 0.9 − 1000 = 800.
  const s = await mkSub(A);
  await applyCoupon(
    s.sub.id,
    await coupon({
      kind: "percentage",
      pct: 1000,
      applyOn: "each_specified_item",
      constraint: "specific",
      productIds: [otherProduct.publicId],
    }),
  );
  const { est, inv } = await change(s, B);
  ok("item-scoped (new plan only): 800 + 80", inv?.row.totalMinor === 880n);
  if (inv) {
    sound("item-scoped new", inv);
    estMatches("item-scoped new", est, inv);
  }
}

// ── 11) Downgrade (net negative): a credit note, never a discounted invoice ────
{
  const s = await mkSub(B);
  await applyCoupon(s.sub.id, await coupon({ kind: "percentage", pct: 1000 }));
  await billTerm(s.sub.id);
  const { est, r, inv } = await change(s, A);
  const notes = r.creditNotes.reduce((sum, cn) => sum + Number(cn.totalMinor), 0);
  console.log(
    `downgrade: notes=${notes} invoice=${inv?.row.totalMinor ?? "none"} est=${est.total_minor}`,
  );
  ok("downgrade: a credit note is issued", r.creditNotes.length > 0);
  ok("downgrade: no invoice carries a credit line", !inv || inv.credits.length === 0);
  ok(
    "downgrade: estimate == invoice − credit notes",
    est.total_minor === (inv ? inv.doc.total_minor : 0) - notes,
    { est: est.total_minor, inv: inv?.doc.total_minor, notes },
  );
  if (inv) sound("downgrade", inv);
}

// ── 12) A one-off coupon code on an invoice with a credit line nets too ────────
{
  const { customer } = await mkSub(A);
  const code = await coupon({ kind: "percentage", pct: 1000 });
  const { invoice } = await createInvoiceFromLines({
    ...ctx,
    customerId: customer.id,
    currency: "USD",
    lines: [
      { description: "Service", amountMinor: 1000n },
      { description: "Goodwill credit", amountMinor: -200n },
    ],
    applyTax: true,
    coupons: { codes: [code] },
  });
  const inv = await inspect(invoice.id);
  ok(
    "one-off code: 10% of the net 800 = 80, + 72 tax",
    inv.discount === 80n && inv.row.totalMinor === 792n,
  );
  sound("one-off code", inv);
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
await closeDb();
process.exit(failed ? 1 : 0);
