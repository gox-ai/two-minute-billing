/**
 * Coupons on invoices with no subscription (0520):
 *  - % and fixed coupons on a one-off invoice; a 'forever' coupon applies once;
 *  - item-scoped match and refusal; a fixed coupon in another currency is refused;
 *  - max_redemptions and the per-customer limit count subscription AND invoice
 *    redemptions, by customer and by email (trimmed, lower-cased; parallel redeems lock);
 *  - a void releases the redemption (set code, times_redeemed); voiding a subscription
 *    invoice leaves subscription coupons alone;
 *  - preview equals the created invoice (exclusive and inclusive tax, promo credit);
 *  - a 100% coupon gives a paid zero invoice.
 *
 *   pnpm verify:coupons-invoice
 */
import { and, eq } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createInvoiceFromLines, previewInvoiceFromLines } from "@/modules/invoicing/service";
import { createManualInvoice, voidInvoice } from "@/modules/invoicing/ops";
import {
  createCoupon,
  createCouponSet,
  applyCouponToSubscription,
  CouponError,
} from "@/modules/coupons/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import {
  appliedCoupons,
  coupons,
  couponSetCodes,
  customers,
  events,
  invoiceLineItems,
  invoices,
  ledgerEntries,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean, detail?: unknown) => {
  checks.push([name, pass]);
  if (!pass && detail !== undefined) console.log(`    ↳ ${name}: ${JSON.stringify(detail)}`);
};

const org = await createOrganization({ name: "Coupon Invoice Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
await createFlatTaxRate({ ...ctx, name: "VAT", country: "GB", rateBps: 1000 });

const widget = await createProduct({ ...ctx, name: "Widget", kind: "charge" });
const widgetPrice = await createPrice({
  ...ctx,
  productId: widget.id,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
});
const gadget = await createProduct({ ...ctx, name: "Gadget", kind: "charge" });
const gadgetPrice = await createPrice({
  ...ctx,
  productId: gadget.id,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 11000,
  taxBehavior: "inclusive",
});
const plan = await createProduct({ ...ctx, name: "Plan" });
const planPrice = await createPrice({
  ...ctx,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});

let n = 0;
const mkCustomer = (email?: string, country?: string) =>
  createCustomer({
    ...ctx,
    email: email ?? `buyer${++n}@example.com`,
    address: country ? { line1: "1 St", country } : undefined,
  });
async function mkSub(customer: typeof customers.$inferSelect) {
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const r = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  return r.subscription;
}
const widgetLine = { description: "Widget", amountMinor: 10000n, priceId: widgetPrice.id };
const gadgetLine = { description: "Gadget", amountMinor: 11000n, priceId: gadgetPrice.id };
async function oneOff(
  customer: typeof customers.$inferSelect,
  codes: string[],
  lines: Array<{ description: string; amountMinor: bigint; priceId?: string }> = [widgetLine],
  applyTax = false,
) {
  return createManualInvoice({
    ...ctx,
    customerId: customer.id,
    currency: "USD",
    lines,
    applyTax,
    coupons: { codes },
  });
}
async function refusal(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof CouponError ? e.message : `not a CouponError: ${String(e)}`;
  }
}
const couponRow = async (code: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(coupons)
        .where(and(eq(coupons.businessId, biz.id), eq(coupons.code, code))),
    )
  )[0]!;
const redemptionsOn = (invoiceId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(appliedCoupons).where(eq(appliedCoupons.invoiceId, invoiceId)),
  );
const linesOf = (invoiceId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
  );

// ── % and fixed; 'forever' applies once ─────────────────────────────────────────
await createCoupon({ ...ctx, code: "PCT20", kind: "percentage", percentOffBps: 2000 });
await createCoupon({
  ...ctx,
  code: "FIX15",
  kind: "fixed_amount",
  amountOffMinor: 1500,
  currency: "USD",
  durationType: "forever",
});
{
  const cus = await mkCustomer();
  const { invoice } = await oneOff(cus, ["PCT20"]);
  const disc = (await linesOf(invoice.id)).filter((l) => l.kind === "discount");
  ok("percent: 20% off 10000 → total 8000", invoice.totalMinor === 8000n, invoice.totalMinor);
  ok(
    "percent: one discount line of -2000",
    disc.length === 1 && disc[0]!.amountMinor === -2000n,
    disc.map((l) => String(l.amountMinor)),
  );
  const [row] = await redemptionsOn(invoice.id);
  ok(
    "percent: invoice-scope row, exhausted, stamped with the invoice",
    row?.scope === "invoice" &&
      row.status === "exhausted" &&
      row.subscriptionId === null &&
      row.customerId === cus.id &&
      row.remainingPeriods === 0 &&
      row.totalPeriods === 1,
    row,
  );
  ok("percent: times_redeemed 1", (await couponRow("PCT20")).timesRedeemed === 1);
  const evts = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.businessId, biz.id), eq(events.type, "coupon_applied"))),
  );
  ok(
    "percent: coupon_applied emitted for the redemption",
    evts.some((e) => (e.data as any)?.applied_coupon === row?.publicId),
  );
  const ledger = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(ledgerEntries)
      .where(
        and(eq(ledgerEntries.sourceId, invoice.publicId), eq(ledgerEntries.account, "discounts")),
      ),
  );
  ok("percent: 2000 booked to discounts", ledger.length === 1 && ledger[0]!.amountMinor === 2000n);

  const fixed = await oneOff(cus, ["FIX15"]);
  ok("fixed: 1500 off → 8500", fixed.invoice.totalMinor === 8500n, fixed.invoice.totalMinor);
  const [frow] = await redemptionsOn(fixed.invoice.id);
  ok(
    "forever on a one-off invoice: born exhausted, applies once",
    frow?.status === "exhausted" && frow.remainingPeriods === 0,
    frow,
  );
  const again = await createManualInvoice({
    ...ctx,
    customerId: cus.id,
    currency: "USD",
    lines: [widgetLine],
  });
  ok(
    "forever: the next invoice without the code is list price",
    again.invoice.totalMinor === 10000n,
  );
}

// ── item-scoped; currency ────────────────────────────────────────────────────────
await createCoupon({
  ...ctx,
  code: "WIDGET50",
  kind: "percentage",
  percentOffBps: 5000,
  applyOn: "each_specified_item",
  itemConstraints: [
    { itemKind: "charge", constraintType: "specific", productIds: [widget.publicId] },
  ],
});
await createCoupon({
  ...ctx,
  code: "EUR5",
  kind: "fixed_amount",
  amountOffMinor: 500,
  currency: "EUR",
});
{
  const cus = await mkCustomer();
  const both = await oneOff(cus, ["WIDGET50"], [widgetLine, { ...gadgetLine }]);
  const wl = (await linesOf(both.invoice.id)).find((l) => l.priceId === widgetPrice.id);
  ok(
    "item-scoped: only the widget line is discounted (21000 → 16000)",
    both.invoice.totalMinor === 16000n && wl?.discountMinor === 5000n,
    { total: both.invoice.totalMinor, wl: wl?.discountMinor },
  );
  const before = (await couponRow("WIDGET50")).timesRedeemed;
  const why = await refusal(oneOff(cus, ["WIDGET50"], [gadgetLine]));
  ok(
    "item-scoped: refused on an invoice with no matching item",
    /none of the items/.test(why ?? ""),
    why,
  );
  ok(
    "item-scoped: refusal rolled back (times_redeemed unchanged)",
    (await couponRow("WIDGET50")).timesRedeemed === before,
  );
  const cur = await refusal(oneOff(cus, ["EUR5"]));
  ok("currency: a EUR fixed coupon on a USD invoice is refused", /is in EUR/.test(cur ?? ""), cur);
  const unknown = await refusal(oneOff(cus, ["NOPE"]));
  ok("unknown code refused", /No active coupon/.test(unknown ?? ""), unknown);
}

// ── max_redemptions + per-customer limit across subscription and invoice ────────
await createCoupon({
  ...ctx,
  code: "CAP2",
  kind: "percentage",
  percentOffBps: 1000,
  maxRedemptions: 2,
});
await createCoupon({
  ...ctx,
  code: "ONEPERCUS",
  kind: "percentage",
  percentOffBps: 1000,
  maxRedemptionsPerCustomer: 1,
});
await createCoupon({
  ...ctx,
  code: "ONEPEREMAIL",
  kind: "percentage",
  percentOffBps: 1000,
  maxRedemptionsPerCustomer: 1,
  perCustomerLimitBy: "email",
});
{
  const a = await mkCustomer();
  const subA = await mkSub(a);
  await applyCouponToSubscription({
    ...ctx,
    subscriptionId: subA.id,
    code: "CAP2",
    now: new Date(),
  });
  await oneOff(a, ["CAP2"]);
  const b = await mkCustomer();
  const capWhy = await refusal(oneOff(b, ["CAP2"]));
  ok(
    "max_redemptions: subscription + invoice reach 2, a third is refused",
    /redemption limit/.test(capWhy ?? ""),
    capWhy,
  );

  await applyCouponToSubscription({
    ...ctx,
    subscriptionId: subA.id,
    code: "ONEPERCUS",
    now: new Date(),
  });
  const perWhy = await refusal(oneOff(a, ["ONEPERCUS"]));
  ok(
    "per customer: a subscription redemption counts against an invoice one",
    /per customer/.test(perWhy ?? ""),
    perWhy,
  );
  const otherCus = await oneOff(b, ["ONEPERCUS"]);
  ok("per customer: another customer may still redeem", otherCus.invoice.totalMinor === 9000n);

  // By email: the stored address is padded and mixed-case; it counts as the same buyer.
  const e1 = await mkCustomer("buyer@example.com");
  const subE = await mkSub(e1);
  await applyCouponToSubscription({
    ...ctx,
    subscriptionId: subE.id,
    code: "ONEPEREMAIL",
    now: new Date(),
  });
  const e2 = await mkCustomer("guest-placeholder@example.com");
  await withTenant(orgId, (tx) =>
    tx.update(customers).set({ email: " Buyer@Example.com " }).where(eq(customers.id, e2.id)),
  );
  const emailWhy = await refusal(oneOff(e2, ["ONEPEREMAIL"]));
  ok(
    "per email: ' Buyer@Example.com ' and 'buyer@example.com' are one customer",
    /per customer/.test(emailWhy ?? ""),
    emailWhy,
  );
  const plus = await mkCustomer("buyer+shop@example.com");
  const plusInv = await oneOff(plus, ["ONEPEREMAIL"]);
  ok("per email: a +tag address is a separate customer", plusInv.invoice.totalMinor === 9000n);
}

// Two parallel guest redemptions with one email, limit 1: exactly one wins.
await createCoupon({
  ...ctx,
  code: "RACE",
  kind: "percentage",
  percentOffBps: 1000,
  maxRedemptionsPerCustomer: 1,
  perCustomerLimitBy: "email",
});
{
  const g1 = await mkCustomer("race@example.com");
  const g2 = await mkCustomer("race@example.com");
  const results = await Promise.allSettled([oneOff(g1, ["RACE"]), oneOff(g2, ["RACE"])]);
  const won = results.filter((r) => r.status === "fulfilled").length;
  const lost = results.filter(
    (r) =>
      r.status === "rejected" &&
      r.reason instanceof CouponError &&
      /per customer/.test(r.reason.message),
  ).length;
  ok("per email, parallel: exactly one of two redemptions succeeds", won === 1 && lost === 1, {
    won,
    lost,
    reasons: results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")),
  });
  ok("per email, parallel: times_redeemed 1", (await couponRow("RACE")).timesRedeemed === 1);
}

// ── void releases a set code; a subscription invoice void leaves sub coupons alone ──
await createCoupon({
  ...ctx,
  code: "SETPARENT",
  kind: "percentage",
  percentOffBps: 1000,
  maxRedemptionsPerCustomer: 1,
});
{
  const set = await createCouponSet({ ...ctx, couponId: "SETPARENT", name: "Launch", count: 1 });
  const [code] = await withTenant(orgId, (tx) =>
    tx.select().from(couponSetCodes).where(eq(couponSetCodes.couponSetId, set.set.id)),
  );
  const cus = await mkCustomer();
  const { invoice } = await oneOff(cus, [code!.code]);
  const claimed = (
    await withTenant(orgId, (tx) =>
      tx.select().from(couponSetCodes).where(eq(couponSetCodes.id, code!.id)),
    )
  )[0]!;
  ok(
    "set code: claimed by the invoice redemption",
    claimed.status === "redeemed" &&
      claimed.appliedCouponId != null &&
      invoice.totalMinor === 9000n,
  );
  ok("set code: parent times_redeemed 1", (await couponRow("SETPARENT")).timesRedeemed === 1);
  await voidInvoice(orgId, biz.id, invoice.publicId);
  const freed = (
    await withTenant(orgId, (tx) =>
      tx.select().from(couponSetCodes).where(eq(couponSetCodes.id, code!.id)),
    )
  )[0]!;
  const [row] = await redemptionsOn(invoice.id);
  ok(
    "void: set code is not_redeemed again",
    freed.status === "not_redeemed" && freed.appliedCouponId === null,
    freed,
  );
  ok("void: the redemption is released", row?.status === "released", row?.status);
  ok("void: times_redeemed back to 0", (await couponRow("SETPARENT")).timesRedeemed === 0);
  const re = await oneOff(cus, [code!.code]);
  ok(
    "void: the released code redeems again, and the released row is not counted per customer",
    re.invoice.totalMinor === 9000n,
  );

  // A subscription invoice that also carries an invoice code: the void releases only that.
  await createCoupon({
    ...ctx,
    code: "SUBFOREVER",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await createCoupon({ ...ctx, code: "EXTRA5", kind: "percentage", percentOffBps: 500 });
  const owner = await mkCustomer();
  const sub = await mkSub(owner);
  const applied = await applyCouponToSubscription({
    ...ctx,
    subscriptionId: sub.id,
    code: "SUBFOREVER",
    now: new Date(),
  });
  const subTimes = (await couponRow("SUBFOREVER")).timesRedeemed;
  const subInv = await createInvoiceFromLines({
    ...ctx,
    customerId: owner.id,
    subscriptionId: sub.id,
    subscription: sub,
    currency: "USD",
    lines: [widgetLine],
    applyCoupons: true,
    coupons: { codes: ["EXTRA5"] },
  });
  // One pass: 10% then 5% of the reduced 9000 = 1000 + 450.
  ok(
    "one pass: subscription 10% and invoice 5% stack to 8550",
    subInv.invoice.totalMinor === 8550n,
    subInv.invoice.totalMinor,
  );
  await voidInvoice(orgId, biz.id, subInv.invoice.publicId);
  const [subRow] = await withTenant(orgId, (tx) =>
    tx.select().from(appliedCoupons).where(eq(appliedCoupons.id, applied.id)),
  );
  const [extraRow] = await redemptionsOn(subInv.invoice.id);
  ok(
    "void of a subscription invoice: the subscription coupon stays active, uncounted down",
    subRow?.status === "active" &&
      subRow.invoiceId === null &&
      (await couponRow("SUBFOREVER")).timesRedeemed === subTimes,
    subRow,
  );
  ok(
    "void of a subscription invoice: only its invoice code is released",
    extraRow?.status === "released" && (await couponRow("EXTRA5")).timesRedeemed === 0,
    extraRow,
  );
}

// ── preview equals create (exclusive + inclusive tax, promo credit) ──────────────
async function previewMatches(label: string, lines: (typeof widgetLine)[], code: string) {
  const cus = await mkCustomer(undefined, "GB");
  await addPromotionalCredits({ ...ctx, customer: cus, amountMinor: 3000, currency: "USD" });
  const p = await previewInvoiceFromLines({
    ...ctx,
    customerId: cus.id,
    currency: "USD",
    lines,
    coupons: [code],
  });
  const { invoice } = await oneOff(cus, [code], lines, true);
  const taxLines = (await linesOf(invoice.id)).filter((l) => l.kind === "tax");
  const taxOnLines = taxLines.reduce((s, l) => s + l.amountMinor, 0n);
  const pTaxLines = p.taxLines.reduce((s, l) => s + l.amountMinor, 0n);
  const got = {
    subtotal: invoice.subtotalMinor,
    total: invoice.totalMinor,
    due: invoice.amountDueMinor,
    promo: invoice.promotionalCreditsAppliedMinor,
    withholding: invoice.withholdingMinor,
    taxLines: taxOnLines,
  };
  const want = {
    subtotal: p.subtotalMinor,
    total: p.totalMinor,
    due: p.amountDueMinor,
    promo: p.promotionalCreditsAppliedMinor,
    withholding: p.withholdingMinor,
    taxLines: pTaxLines,
  };
  ok(`preview = create (${label})`, JSON.stringify(got, big) === JSON.stringify(want, big), {
    got: JSON.stringify(got, big),
    want: JSON.stringify(want, big),
  });
  return { p, invoice };
}
const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
await createCoupon({ ...ctx, code: "PREV20", kind: "percentage", percentOffBps: 2000 });
await createCoupon({
  ...ctx,
  code: "PREVFIX",
  kind: "fixed_amount",
  amountOffMinor: 1500,
  currency: "USD",
});
{
  const ex = await previewMatches("exclusive tax, 20%, promo 3000", [widgetLine], "PREV20");
  ok(
    "exclusive: discount 2000, tax on (8000 - promo 3000) = 500",
    ex.p.discountMinor === 2000n && ex.p.taxMinor === 500n,
    { d: String(ex.p.discountMinor), t: String(ex.p.taxMinor) },
  );
  const inc = await previewMatches(
    "inclusive tax, fixed 1500, promo 3000",
    [gadgetLine],
    "PREVFIX",
  );
  ok(
    "inclusive: no tax line, total excludes nothing extra",
    inc.p.taxLines.length === 0 && inc.p.taxMinor > 0n,
  );
  await previewMatches("mixed lines, 20%", [widgetLine, gadgetLine], "PREV20");
}

// ── 100% coupon: total 0, paid ───────────────────────────────────────────────────
await createCoupon({ ...ctx, code: "FREE", kind: "percentage", percentOffBps: 10000 });
{
  const cus = await mkCustomer(undefined, "GB");
  const { invoice } = await oneOff(cus, ["FREE"], [widgetLine], true);
  ok("100%: total 0 and paid", invoice.totalMinor === 0n && invoice.status === "paid", {
    total: String(invoice.totalMinor),
    status: invoice.status,
  });
}

// ── preview refuses what create refuses ──────────────────────────────────────────
{
  const cus = await mkCustomer();
  const why = await refusal(
    previewInvoiceFromLines({
      ...ctx,
      customerId: cus.id,
      currency: "USD",
      lines: [widgetLine],
      coupons: ["EUR5"],
    }),
  );
  ok("preview: a currency mismatch is refused too", /is in EUR/.test(why ?? ""), why);
}

const allBalanced = await (async () => {
  const { sql: raw } = await import("drizzle-orm");
  const rows = (await systemDb.execute(
    raw`select transaction_id from ledger_entries where organization_id = ${orgId}
         group by transaction_id, currency
        having sum(case when direction='debit' then amount_minor else -amount_minor end) <> 0
         limit 5`,
  )) as unknown as unknown[];
  return rows.length === 0;
})();
ok("all ledger transactions balanced", allBalanced);
const voidedTotals = await withTenant(orgId, (tx) =>
  tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.status, "voided")),
);
ok("two invoices voided", voidedTotals.length === 2);

let pass = true;
for (const [name, good] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${name}`);
  if (!good) pass = false;
}
console.log("");
console.log(pass ? "✅ COUPONS-INVOICE: PASS" : "❌ COUPONS-INVOICE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
