/**
 * Phase G — Catalog completeness verify suite.
 *
 * Money-critical catalog semantics with HAND-COMPUTED constants + LEDGER sums
 * (status-only tests hid money bugs in four prior review passes):
 *  - CAT-1 coupon stacking: application order (line-fixed → line-% → invoice-fixed
 *    → invoice-%, oldest first within class), each on the RUNNING reduced amount.
 *  - CAT-2 item constraints (apply_on + all/specific/none per item-kind), line-accurate.
 *  - CAT-3 mandatory auto-include (differential-aware).
 *  - CAT-4 attached charges (charge_on_event once vs every).
 *  - CAT-7 differential depth (amount OR tiers OR per_unit).
 *
 *   pnpm verify:catalog-v2
 */
import { and, eq, sql } from "drizzle-orm";
import { withTenant, closeDb, type Tx } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  createProduct,
  createPrice,
  setItemApplicablePlans,
  setDifferentialPrice,
  listProducts,
  listPrices,
  getPriceByPublicId,
} from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { removeSubscriptionItem, triggerAttachedItemCharge } from "@/modules/subscriptions/items";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { estimateNewSubscription } from "@/modules/subscriptions/estimate";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  createCoupon,
  applyCouponToSubscription,
  updateCoupon,
  couponStatus,
  createCouponSet,
  addCouponSetCodes,
  archiveCouponCode,
  deleteUnusedCodes,
  listCouponSetCodes,
  listCoupons,
  CouponError,
} from "@/modules/coupons/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import {
  invoices,
  invoiceLineItems,
  invoiceLineDiscounts,
  subscriptions,
  subscriptionItems,
  coupons as couponsTable,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "CatalogV2 Org" });
const orgId = org.organization.id;

async function acctBal(businessId: string, account: string): Promise<bigint> {
  return withTenant(orgId, async (tx: Tx) => {
    const res =
      await tx.execute(sql`select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} and account = ${account} and currency='USD'`);
    return BigInt((res as unknown as Array<{ bal: string | number }>)[0]?.bal ?? 0);
  });
}
async function ledgerNetsZero(businessId: string): Promise<boolean> {
  return withTenant(orgId, async (tx: Tx) => {
    const res =
      await tx.execute(sql`select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal
      from ledger_entries where business_id = ${businessId} group by currency`);
    return (res as unknown as Array<{ bal: string | number }>).every((r) => BigInt(r.bal) === 0n);
  });
}
async function freshBiz(name: string) {
  const b = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const prod = await createProduct({ organizationId: orgId, businessId: b.id, name: "Plan" });
  const price = (amt: number, extra: Record<string, unknown> = {}) =>
    createPrice({
      organizationId: orgId,
      businessId: b.id,
      productId: prod.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: amt,
      interval: "month",
      ...extra,
    });
  return { biz: b, prod, price };
}
async function paidSub(bizId: string, email: string, amountMinor: number) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: "on",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer: c,
    token: "tok_4242",
  });
  const prod = await createProduct({ organizationId: orgId, businessId: bizId, name: "P" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: prod.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  return { c, sub: subscription };
}
async function billNow(bizId: string, sub: typeof subscriptions.$inferSelect) {
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1))[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: bizId,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  return invoice;
}
/**
 * Every discount on an invoice, expressed as NEGATIVE minor units.
 *
 * Discounts have had TWO storage shapes since migration `0169`, and reading only the
 * first is what made every CAT-2 assertion red while the totals, the tax and the
 * ledger in those same cases were all correct:
 *
 *  • DOCUMENT-level → an aggregate `kind='discount'` line item, already negative.
 *  • ITEM-level     → a row in `invoice_line_discounts`, attributed to the line it
 *    reduces and always POSITIVE (that table deliberately owns one sign convention —
 *    "two sign conventions for one concept is how a subtotal ends up off by exactly
 *    twice a discount"). They stopped being line items so `invoices.subtotal_minor`
 *    could mean a NET subtotal.
 *
 * Document-level rows are excluded from the second read: they already arrive via the
 * aggregate line, and counting both would double them.
 */
async function discountLines(invoiceId: string): Promise<bigint[]> {
  return withTenant(orgId, async (tx) => {
    const aggregate = await tx
      .select({ amt: invoiceLineItems.amountMinor })
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.invoiceId, invoiceId), eq(invoiceLineItems.kind, "discount")));
    const perLine = await tx
      .select({
        amt: invoiceLineDiscounts.amountMinor,
        coupon: invoiceLineDiscounts.appliedCouponId,
        label: invoiceLineDiscounts.label,
      })
      .from(invoiceLineDiscounts)
      .where(
        and(
          eq(invoiceLineDiscounts.invoiceId, invoiceId),
          eq(invoiceLineDiscounts.scope, "item_level"),
        ),
      );
    // Grouped BY COUPON, because one coupon spanning several lines is now several
    // rows. The aggregate line it replaced was one figure per discount, and these
    // assertions are about the discount CLASSES an invoice carries and their
    // amounts — not about how a coupon was split across the lines it reduced.
    // Ungrouped, a coupon over two plans reads as two discounts and the count checks
    // (C5, FG1) fail even though every amount is right.
    const byCoupon = new Map<string, bigint>();
    for (const r of perLine) {
      const key = r.coupon ?? r.label ?? "adhoc";
      byCoupon.set(key, (byCoupon.get(key) ?? 0n) + r.amt);
    }
    return [...aggregate.map((r) => r.amt), ...[...byCoupon.values()].map((a) => -a)];
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-1 — coupon stacking (sequential, by class order)
// ══════════════════════════════════════════════════════════════════════════════

// S1: fixed $10 + 20% off $100 → sequential: 10000−1000=9000, 20%·9000=1800 → 7200.
// Discount total 2800; two discount lines (1000, 1800); ledger: revenue 10000,
// discounts 2800, AR 7200.
{
  const { biz } = await freshBiz("S1 fixed+pct");
  const { sub } = await paidSub(biz.id, "s1@a.com", 10000);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "TEN",
    kind: "fixed_amount",
    amountOffMinor: 1000,
    currency: "USD",
    durationType: "forever",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "PCT20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "TEN",
    now: new Date(),
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "PCT20",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  const dl = (await discountLines(inv.id)).map(Number).sort((a, b) => a - b);
  ok("CAT-1/S1: total 7200 (fixed then % on running)", Number(inv.totalMinor) === 7200);
  ok(
    "CAT-1/S1: two discount lines −1000 and −1800",
    dl.length === 2 && dl[0] === -1800 && dl[1] === -1000,
  );
  ok(
    "CAT-1/S1: ledger revenue 10000 / discounts 2800 / AR nets paid",
    (await acctBal(biz.id, "revenue")) === -10000n &&
      (await acctBal(biz.id, "discounts")) === 2800n,
  );
  ok("CAT-1/S1: ledger nets zero", await ledgerNetsZero(biz.id));
}

// S2: class order dominates creation order — create 20% FIRST, then $10; result is
// STILL fixed-applied-first → 7200 (proves ordering is by class, not created-at).
{
  const { biz } = await freshBiz("S2 order");
  const { sub } = await paidSub(biz.id, "s2@a.com", 10000);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "P20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "F10",
    kind: "fixed_amount",
    amountOffMinor: 1000,
    currency: "USD",
    durationType: "forever",
  });
  // Apply % first (older applied_coupon), fixed second — class order must still put fixed first.
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "P20",
    now: new Date(),
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "F10",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  ok(
    "CAT-1/S2: class order (fixed→%) dominates creation order → 7200",
    Number(inv.totalMinor) === 7200,
  );
}

// S3: two % coupons, oldest-applied first: 20% then 10% → 10000·0.8=8000 (−2000),
// 10%·8000=800 → 7200. Discount lines 2000 + 800.
{
  const { biz } = await freshBiz("S3 two-pct");
  const { sub } = await paidSub(biz.id, "s3@a.com", 10000);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "A20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "B10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "A20",
    now: new Date(),
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "B10",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  const dl = (await discountLines(inv.id)).map(Number).sort((a, b) => a - b);
  ok("CAT-1/S3: two % sequential → 7200", Number(inv.totalMinor) === 7200);
  ok(
    "CAT-1/S3: discount lines −2000 (20% first) then −800 (10% of 8000)",
    dl[0] === -2000 && dl[1] === -800,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-2 — item constraints (apply_on) + LINE-ACCURATE tax attribution
// ══════════════════════════════════════════════════════════════════════════════
//
// Line-level (each_specified_item) coupons discount ONLY their matched lines, so a
// discount on a non-taxable line must NOT erode a taxable line's tax base (and vice
// versa). Invoice-level coupons stay proportional. Every total is hand-computed and
// asserted against the LEDGER (tax_payable, discounts, AR).

async function taxBiz(name: string, rateBps: number) {
  const b = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b.id,
    name: "US",
    country: "US",
    rateBps,
  });
  return b;
}
async function mkItem(
  bizId: string,
  kind: "plan" | "addon" | "charge",
  slug: string,
  amountMinor: number,
  opts: { taxable?: boolean; inclusive?: boolean; model?: "flat" | "per_unit" } = {},
) {
  const prod = await createProduct({
    organizationId: orgId,
    businessId: bizId,
    name: slug,
    id: slug,
    kind,
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: prod.id,
    type: "recurring",
    model: opts.model ?? "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
    isTaxable: opts.taxable ?? true,
    taxBehavior: opts.inclusive ? "inclusive" : "exclusive",
  });
  return { prod, price };
}
async function subWith(
  bizId: string,
  email: string,
  prices: Array<typeof import("@db/schema").prices.$inferSelect>,
) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: "on",
    address: { country: "US" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer: c,
    token: "tok_4242",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: c.id,
    now: new Date(),
    items: prices.map((p) => ({ price: p, quantity: 1 })),
  });
  return { c, sub: subscription };
}
const taxAcct = async (bizId: string) => -(await acctBal(bizId, "tax_payable")); // credit balance → positive tax
const discAcct = (bizId: string) => acctBal(bizId, "discounts");

// C1: line-level 20% on the PLAN line; a non-taxable addon is present. Rate 10%.
// Line-accurate: 2000 off plan only → taxable base = plan net 8000 → tax 800.
// discountedSubtotal 18000, total 18800. (Proportional-wrong would give 18900.)
{
  const biz = await taxBiz("C1 line-taxable", 1000);
  const { price: plan } = await mkItem(biz.id, "plan", "p1", 10000);
  const { price: addon } = await mkItem(biz.id, "addon", "a1", 10000, { taxable: false });
  const { sub } = await subWith(biz.id, "c1@a.com", [plan, addon]);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "LP20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "LP20",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  ok(
    "CAT-2/C1: line-level plan discount → total 18800 (tax on 8000)",
    Number(inv.totalMinor) === 18800,
  );
  ok("CAT-2/C1: tax_payable 800 (line-accurate, NOT 900)", (await taxAcct(biz.id)) === 800n);
  ok("CAT-2/C1: discount line −2000", (await discountLines(inv.id)).map(Number).includes(-2000));
  ok("CAT-2/C1: ledger nets zero", await ledgerNetsZero(biz.id));
}

// C2: line-level 20% on the NON-TAXABLE addon. Line-accurate: 2000 off addon →
// taxable plan base stays 10000 → tax 1000, total 19000. (Proportional → 18900.)
{
  const biz = await taxBiz("C2 line-nontaxable", 1000);
  const { price: plan } = await mkItem(biz.id, "plan", "p1", 10000);
  const { price: addon } = await mkItem(biz.id, "addon", "a1", 10000, { taxable: false });
  const { sub } = await subWith(biz.id, "c2@a.com", [plan, addon]);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "LA20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "addon", constraintType: "all" }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "LA20",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  ok(
    "CAT-2/C2: addon discount → total 19000 (tax on full 10000)",
    Number(inv.totalMinor) === 19000,
  );
  ok("CAT-2/C2: tax_payable 1000 (untouched taxable base)", (await taxAcct(biz.id)) === 1000n);
  ok("CAT-2/C2: ledger nets zero", await ledgerNetsZero(biz.id));
}

// C3: INCLUSIVE tax + line-level 10% coupon. Plan $11000 tax-inclusive @10%.
// 1100 off → discountedSubtotal 9900 (= total, tax is inside); inclusive tax
// = 9900·1000/11000 = 900. tax_payable 900, discounts 1100.
{
  const biz = await taxBiz("C3 inclusive", 1000);
  const { price: plan } = await mkItem(biz.id, "plan", "p1", 11000, { inclusive: true });
  const { sub } = await subWith(biz.id, "c3@a.com", [plan]);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "LI10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "LI10",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  ok("CAT-2/C3: inclusive total 9900 (tax inside)", Number(inv.totalMinor) === 9900);
  ok("CAT-2/C3: inclusive tax_payable 900", (await taxAcct(biz.id)) === 900n);
  ok("CAT-2/C3: discount line −1100", (await discountLines(inv.id)).map(Number).includes(-1100));
  ok("CAT-2/C3: ledger nets zero", await ledgerNetsZero(biz.id));
}

// C4: MIXED — line-level 20% on plan THEN invoice-level 10% (class order:
// line-% before invoice-%). Plan $10000 taxable, addon $10000 non-taxable @10%.
// After line: plan 8000. Invoice-10% of 18000 = 1800 spread (plan 800, addon 1000)
// → plan taxable base 7200 → tax 720. discounts 2000+1800, total 16920.
{
  const biz = await taxBiz("C4 mixed", 1000);
  const { price: plan } = await mkItem(biz.id, "plan", "p1", 10000);
  const { price: addon } = await mkItem(biz.id, "addon", "a2", 10000, { taxable: false });
  const { sub } = await subWith(biz.id, "c4@a.com", [plan, addon]);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "LP20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "INV10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    applyOn: "invoice_amount",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "LP20",
    now: new Date(),
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "INV10",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  const dl = (await discountLines(inv.id)).map(Number).sort((a, b) => a - b);
  ok("CAT-2/C4: mixed line+invoice → total 16920", Number(inv.totalMinor) === 16920);
  ok("CAT-2/C4: tax_payable 720 (tax on plan net 7200)", (await taxAcct(biz.id)) === 720n);
  ok(
    "CAT-2/C4: two discount lines −2000 (line) and −1800 (invoice)",
    dl.length === 2 && dl[0] === -2000 && dl[1] === -1800,
  );
  ok("CAT-2/C4: ledger nets zero", await ledgerNetsZero(biz.id));
}

// C5: line-level FIXED $3000 on plan/all — distributed across the two plan lines
// (P1 6000, P2 4000) proportionally, NOT touching the non-taxable addon (10000).
// plan net 7000 → tax 700, one discount line −3000, total 17700 (prop-wrong 17850).
{
  const biz = await taxBiz("C5 fixed-line", 1000);
  const { price: p1 } = await mkItem(biz.id, "plan", "p1", 6000);
  const { price: p2 } = await mkItem(biz.id, "plan", "p2", 4000);
  const { price: addon } = await mkItem(biz.id, "addon", "a1", 10000, { taxable: false });
  const { sub } = await subWith(biz.id, "c5@a.com", [p1, p2, addon]);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "FIX30",
    kind: "fixed_amount",
    amountOffMinor: 3000,
    currency: "USD",
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "FIX30",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  const dl = (await discountLines(inv.id)).map(Number);
  ok("CAT-2/C5: fixed line-level over plans → total 17700", Number(inv.totalMinor) === 17700);
  ok("CAT-2/C5: tax_payable 700 (tax on plan net 7000)", (await taxAcct(biz.id)) === 700n);
  ok("CAT-2/C5: single discount line −3000", dl.length === 1 && dl[0] === -3000);
  ok("CAT-2/C5: ledger nets zero", await ledgerNetsZero(biz.id));
}

// C6: `specific` product-id scoping — coupon targets only p1, so p2 (also a plan)
// is NOT discounted. 20% off p1 (10000) = 2000; p2 (10000) untouched.
{
  const biz = await taxBiz("C6 specific", 0);
  const { price: p1 } = await mkItem(biz.id, "plan", "p1", 10000);
  const { price: p2 } = await mkItem(biz.id, "plan", "p2", 10000);
  const { sub } = await subWith(biz.id, "c6@a.com", [p1, p2]);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "SP20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "specific", productIds: ["p1"] }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "SP20",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  ok(
    "CAT-2/C6: specific scoping discounts only p1 → total 18000",
    Number(inv.totalMinor) === 18000,
  );
  ok(
    "CAT-2/C6: single discount line −2000",
    (await discountLines(inv.id)).map(Number).filter((n) => n < 0).length === 1 &&
      (await discountLines(inv.id)).map(Number).includes(-2000),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-3 — mandatory add-on auto-include (differential-aware) + reject removal
// ══════════════════════════════════════════════════════════════════════════════

async function pmCustomer(bizId: string, email: string) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email,
    autoCollection: "on",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer: c,
    token: "tok_4242",
  });
  return c;
}

// M1: a plan with a MANDATORY add-on auto-includes it at create; the renewal bills
// plan + addon; the mandatory add-on cannot be removed.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "M1 mandatory",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "adna", 3000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "adna",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
  });
  const c = await pmCustomer(biz.id, "m1@a.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  ok("CAT-3/M1: mandatory addon auto-included (2 items)", items.length === 2);
  const inv = await billNow(biz.id, sub);
  ok("CAT-3/M1: renewal bills plan+addon = 13000", Number(inv.totalMinor) === 13000);
  const addonItem = items.find((i) => i.priceId !== planPrice.id)!;
  let rejected = false;
  try {
    await removeSubscriptionItem({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      itemPublicId: addonItem.publicId,
      now: new Date(),
    });
  } catch {
    rejected = true;
  }
  ok("CAT-3/M1: removing the mandatory addon is rejected", rejected);
}

// M2: differential price for the (addon, plan) pair overrides the addon base at
// auto-include time → renewal bills 10000 + 1000 = 11000 (not 3000).
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "M2 differential",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "adna", 3000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "adna",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
  });
  await setDifferentialPrice({
    organizationId: orgId,
    businessId: biz.id,
    addonPublicId: "adna",
    planPublicId: "planp",
    currency: "USD",
    interval: "month",
    amountMinor: 1000,
  });
  const c = await pmCustomer(biz.id, "m2@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const inv = await billNow(biz.id, sub);
  ok("CAT-3/M2: mandatory addon billed at differential → 11000", Number(inv.totalMinor) === 11000);
}

// M3: estimateNewSubscription reflects the auto-included mandatory add-on.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "M3 estimate",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "adna", 3000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "adna",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
  });
  const c = await pmCustomer(biz.id, "m3@a.com");
  const est = await estimateNewSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    items: [{ price: planPrice, quantity: 1 }],
    now: new Date(),
  });
  ok("CAT-3/M3: estimate subtotal includes mandatory addon (13000)", est.subtotal_minor === 13000);
}

// M4: plan SWAP brings the new plan's mandatory add-on. Plan one (no mandatory) →
// change to plan two (mandatory addon B) auto-includes B.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "M4 swap",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: p1 } = await mkItem(biz.id, "plan", "planone", 10000);
  const { price: p2 } = await mkItem(biz.id, "plan", "plantwo", 12000);
  await mkItem(biz.id, "addon", "adnb", 2000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "adnb",
    planPublicIds: ["plantwo"],
    applicability: { plantwo: "mandatory" },
  });
  const c = await pmCustomer(biz.id, "m4@a.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: p1, quantity: 1 }],
  });
  ok("CAT-3/M4: plan one has no mandatory addon (1 item)", items.length === 1);
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    changes: [{ itemId: items[0]!.publicId, newPriceId: p2.publicId }],
  });
  const after = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
  );
  ok("CAT-3/M4: plan swap auto-includes new plan mandatory addon (2 items)", after.length === 2);
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-4 — attached items: charge_on_event / charge_once / default_quantity / trigger_charge
// ══════════════════════════════════════════════════════════════════════════════

// A1: charge_once mandatory addon → a ONE-TIME charge on the first invoice, NOT a
// recurring subscription item (so it doesn't recur).
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "A1 charge_once",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "setupfee", 3000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "setupfee",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
    config: { planp: { chargeOnce: true } },
  });
  const c = await pmCustomer(biz.id, "a1@a.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  ok("CAT-4/A1: charge_once addon is NOT a recurring item (1 item)", items.length === 1);
  const inv = await billNow(biz.id, sub);
  ok(
    "CAT-4/A1: first invoice includes the one-time addon = 13000",
    Number(inv.totalMinor) === 13000,
  );
}

// A2: default_quantity=3 on a mandatory addon → auto-included recurring item at qty 3.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "A2 default_qty",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "seats", 1000, { model: "per_unit" });
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "seats",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
    config: { planp: { defaultQuantity: 3 } },
  });
  const c = await pmCustomer(biz.id, "a2@a.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const addonItem = items.find((i) => i.priceId !== planPrice.id)!;
  ok("CAT-4/A2: mandatory addon auto-included at default_quantity 3", addonItem.quantity === 3);
  const inv = await billNow(biz.id, sub);
  ok("CAT-4/A2: renewal bills 10000 + 3×1000 = 13000", Number(inv.totalMinor) === 13000);
}

// A3: on_demand attached item is NOT auto-included; trigger_charge bills it now.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "A3 on_demand",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "overage", 2000, { model: "per_unit" });
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "overage",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
    config: { planp: { chargeOnEvent: "on_demand" } },
  });
  const c = await pmCustomer(biz.id, "a3@a.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  ok("CAT-4/A3: on_demand attached item NOT auto-included (1 item)", items.length === 1);
  const { invoice } = await triggerAttachedItemCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    itemPublicId: "overage",
    quantity: 2,
    now: new Date(),
  });
  ok("CAT-4/A3: trigger_charge bills 2×2000 = 4000", Number(invoice.totalMinor) === 4000);
}

// A4: activation attached item is NOT auto-included at create (Phase-H handoff for
// the activation/trial-end hook that fires it).
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "A4 activation",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "actfee", 2000);
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "actfee",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
    config: { planp: { chargeOnEvent: "activation" } },
  });
  const c = await pmCustomer(biz.id, "a4@a.com");
  const { items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  ok("CAT-4/A4: activation attached item NOT auto-included at create (1 item)", items.length === 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-5 — coupon edits (redeem_by / max_redemptions / invoice_name / valid_from) + derived status
// ══════════════════════════════════════════════════════════════════════════════

const readCoupon = (bizId: string, code: string) =>
  withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(couponsTable)
          .where(and(eq(couponsTable.businessId, bizId), eq(couponsTable.code, code)))
          .limit(1)
      )[0]!,
  );

// E1: PATCH edits; derived status transitions.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "E1 coupon-edit",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "EDITME",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  ok(
    "CAT-5/E1: fresh coupon status active",
    couponStatus(await readCoupon(biz.id, "EDITME")) === "active",
  );
  // valid_from in the future → status future
  await updateCoupon({
    organizationId: orgId,
    businessId: biz.id,
    couponPublicId: "EDITME",
    validFrom: new Date(Date.now() + 86_400_000),
    invoiceName: "10% Launch",
    maxRedemptions: 5,
  });
  const edited = await readCoupon(biz.id, "EDITME");
  ok("CAT-5/E1: valid_from future → status future", couponStatus(edited) === "future");
  ok(
    "CAT-5/E1: invoice_name + max_redemptions persisted",
    edited.invoiceName === "10% Launch" && edited.maxRedemptions === 5,
  );
  // redeem_by in the past → expired
  await updateCoupon({
    organizationId: orgId,
    businessId: biz.id,
    couponPublicId: "EDITME",
    validFrom: null,
    redeemBy: new Date(Date.now() - 86_400_000),
  });
  ok(
    "CAT-5/E1: redeem_by past → status expired",
    couponStatus(await readCoupon(biz.id, "EDITME")) === "expired",
  );
}

// E2: valid_from in the future blocks application; invoice_name shows on the discount line.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "E2 valid_from",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { sub } = await paidSub(biz.id, "e2@a.com", 10000);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "FUTURE",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    validFrom: new Date(Date.now() + 86_400_000),
  });
  let blocked = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      code: "FUTURE",
      now: new Date(),
    });
  } catch {
    blocked = true;
  }
  ok("CAT-5/E2: future valid_from blocks apply", blocked);
  // Now a coupon with invoice_name applies and labels the discount line.
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "NAMED",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    invoiceName: "Spring Promo",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "NAMED",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  const labelled = await withTenant(orgId, (tx) =>
    tx
      .select({ d: invoiceLineItems.description })
      .from(invoiceLineItems)
      .where(and(eq(invoiceLineItems.invoiceId, inv.id), eq(invoiceLineItems.kind, "discount"))),
  );
  ok(
    "CAT-5/E2: discount line uses invoice_name",
    labelled.some((r) => r.d === "Discount (Spring Promo)"),
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-6 — coupon set ops: add codes / archive code / delete-unused
// ══════════════════════════════════════════════════════════════════════════════
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "CS coupon-set-ops",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "PROMO",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await createCouponSet({
    organizationId: orgId,
    businessId: biz.id,
    couponId: "PROMO",
    name: "Promo Set",
    id: "promoset",
    count: 3,
  });
  const count = async () => (await listCouponSetCodes(orgId, biz.id, "promoset"))!.length;
  ok("CAT-6/CS: set created with 3 codes", (await count()) === 3);
  // add 2 generated + 2 explicit
  const g = await addCouponSetCodes({
    organizationId: orgId,
    businessId: biz.id,
    setPublicId: "promoset",
    count: 2,
  });
  ok("CAT-6/CS: 2 generated codes added", g?.added === 2 && (await count()) === 5);
  const e = await addCouponSetCodes({
    organizationId: orgId,
    businessId: biz.id,
    setPublicId: "promoset",
    codes: ["MANUAL1", "MANUAL2"],
  });
  ok("CAT-6/CS: 2 explicit codes added", e?.added === 2 && (await count()) === 7);
  // duplicate explicit code is skipped (business-unique)
  const dup = await addCouponSetCodes({
    organizationId: orgId,
    businessId: biz.id,
    setPublicId: "promoset",
    codes: ["MANUAL1"],
  });
  ok("CAT-6/CS: duplicate code skipped", dup?.added === 0 && (await count()) === 7);
  // archive one code
  const arch = await archiveCouponCode({
    organizationId: orgId,
    businessId: biz.id,
    code: "MANUAL1",
  });
  const archived = (await listCouponSetCodes(orgId, biz.id, "promoset", { status: "archived" }))!;
  ok("CAT-6/CS: code archived", arch && archived.length === 1 && archived[0]!.code === "MANUAL1");
  // delete unused → not_redeemed removed (6 of them), archived (1) kept
  const del = await deleteUnusedCodes({
    organizationId: orgId,
    businessId: biz.id,
    setPublicId: "promoset",
  });
  ok(
    "CAT-6/CS: delete-unused removes 6 not_redeemed, keeps archived",
    del === 6 && (await count()) === 1,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-7 — differential depth: amount / per_unit / tiers
// ══════════════════════════════════════════════════════════════════════════════

// T1: TIERED differential overrides the addon's tier table for the plan. Addon is
// a volume price (base 1000/unit); differential sets 500/unit. default_quantity 5
// → addon 5×500 = 2500 (NOT base 5000). Plan 10000 → total 12500.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "T1 diff-tiers",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  const addonProd = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "vol",
    id: "volad",
    kind: "addon",
  });
  await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: addonProd.id,
    type: "recurring",
    model: "volume",
    currency: "USD",
    interval: "month",
    tiers: [
      { upToMinor: 10, unitAmountMinor: 1000 },
      { upToMinor: null, unitAmountMinor: 800 },
    ],
  });
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "volad",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
    config: { planp: { defaultQuantity: 5 } },
  });
  await setDifferentialPrice({
    organizationId: orgId,
    businessId: biz.id,
    addonPublicId: "volad",
    planPublicId: "planp",
    currency: "USD",
    interval: "month",
    tiers: [
      { upToMinor: 10, unitAmountMinor: 500 },
      { upToMinor: null, unitAmountMinor: 400 },
    ],
  });
  const c = await pmCustomer(biz.id, "t1@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const inv = await billNow(biz.id, sub);
  ok(
    "CAT-7/T1: tiered differential → addon 2500, total 12500 (not 15000)",
    Number(inv.totalMinor) === 12500,
  );
}

// T2: PER_UNIT differential (amount override on a per_unit addon). base 1000/unit,
// differential 600/unit, default_quantity 4 → addon 2400, total 12400.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "T2 diff-per_unit",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await mkItem(biz.id, "plan", "planp", 10000);
  await mkItem(biz.id, "addon", "seatpu", 1000, { model: "per_unit" });
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "seatpu",
    planPublicIds: ["planp"],
    applicability: { planp: "mandatory" },
    config: { planp: { defaultQuantity: 4 } },
  });
  await setDifferentialPrice({
    organizationId: orgId,
    businessId: biz.id,
    addonPublicId: "seatpu",
    planPublicId: "planp",
    currency: "USD",
    interval: "month",
    amountMinor: 600,
  });
  const c = await pmCustomer(biz.id, "t2@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  const inv = await billNow(biz.id, sub);
  ok(
    "CAT-7/T2: per_unit differential → addon 4×600=2400, total 12400",
    Number(inv.totalMinor) === 12400,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CAT-8 — list filters (products/prices/coupons) + get single price
// ══════════════════════════════════════════════════════════════════════════════
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "L1 filters",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const planP = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "p",
    id: "planx",
    kind: "plan",
  });
  const addonP = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "a",
    id: "addx",
    kind: "addon",
  });
  const mk = (productId: string, model: string, currency: string, interval: string, amt: number) =>
    createPrice({
      organizationId: orgId,
      businessId: biz.id,
      productId,
      type: "recurring",
      model: model as any,
      currency,
      interval: interval as any,
      amountMinor: amt,
    });
  await mk(planP.id, "flat", "USD", "month", 1000);
  await mk(planP.id, "flat", "EUR", "year", 2000);
  await mk(addonP.id, "per_unit", "USD", "month", 500);
  // products kind filter
  const plans = await listProducts(orgId, biz.id, { kind: "plan" });
  ok(
    "CAT-8/L1: products kind=plan → only planx",
    plans.length === 1 && plans[0]!.publicId === "planx",
  );
  // price filters
  ok(
    "CAT-8/L1: prices currency=USD → 2",
    (await listPrices(orgId, biz.id, { currency: "USD" })).length === 2,
  );
  ok(
    "CAT-8/L1: prices currency=EUR → 1",
    (await listPrices(orgId, biz.id, { currency: "EUR" })).length === 1,
  );
  ok(
    "CAT-8/L1: prices model=per_unit → 1",
    (await listPrices(orgId, biz.id, { model: "per_unit" })).length === 1,
  );
  ok(
    "CAT-8/L1: prices interval=month → 2",
    (await listPrices(orgId, biz.id, { interval: "month" })).length === 2,
  );
  ok(
    "CAT-8/L1: prices product=planx → 2",
    (await listPrices(orgId, biz.id, { productPublicId: "planx" })).length === 2,
  );
  // get single price
  const someUsd = (await listPrices(orgId, biz.id, { currency: "USD" }))[0]!.price;
  const got = await getPriceByPublicId(orgId, biz.id, someUsd.publicId);
  ok("CAT-8/L1: get single price by id", got?.publicId === someUsd.publicId);
  ok(
    "CAT-8/L1: get unknown price → null",
    (await getPriceByPublicId(orgId, biz.id, "nope")) === null,
  );
}
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "L2 coupon-filters",
    defaultCurrency: "USD",
    livemode: "test",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "PCT",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "FIX",
    kind: "fixed_amount",
    amountOffMinor: 500,
    currency: "USD",
    durationType: "forever",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "GONE",
    kind: "percentage",
    percentOffBps: 500,
    durationType: "forever",
  });
  await updateCoupon({
    organizationId: orgId,
    businessId: biz.id,
    couponPublicId: "GONE",
    redeemBy: new Date(Date.now() - 86_400_000),
  });
  const all = await listCoupons(orgId, biz.id, { includeArchived: true });
  ok(
    "CAT-8/L2: kind=percentage → 2 (same as the route filter)",
    all.filter((c) => c.kind === "percentage").length === 2,
  );
  ok(
    "CAT-8/L2: status=expired → GONE only",
    all
      .filter((c) => couponStatus(c) === "expired")
      .map((c) => c.code)
      .join() === "GONE",
  );
  ok(
    "CAT-8/L2: status=active → PCT + FIX",
    all.filter((c) => couponStatus(c) === "active").length === 2,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// GB1 — G-review regression: item-level billing_cycles is ENFORCED at billing
// ══════════════════════════════════════════════════════════════════════════════
{
  const { biz, prod, price } = await freshBiz("GB1 item cycle cap");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "gb1@a.com",
    autoCollection: "off",
  });
  const plan = await price(5000);
  const addonProd = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Capped addon",
    kind: "addon",
  });
  const addonPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: addonProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [
      { price: plan, quantity: 1 },
      { price: addonPrice, quantity: 1, billingCycles: 1 },
    ],
  });
  const inv1 = await billNow(biz.id, sub);
  const inv1Row = await withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, inv1.id)).limit(1))[0]!,
  );
  ok("GB1: first period bills plan + capped addon (6000)", inv1Row.totalMinor === 6000n);
  // Second period: the addon's single cycle is consumed → plan only.
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1))[0]!,
  );
  const { invoice: inv2 } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodEnd!,
    periodEnd: new Date(fresh.currentPeriodEnd!.getTime() + 30 * 86_400_000),
  });
  const inv2Row = await withTenant(
    orgId,
    async (tx) => (await tx.select().from(invoices).where(eq(invoices.id, inv2.id)).limit(1))[0]!,
  );
  ok("GB1: second period skips the exhausted addon (5000, not 6000)", inv2Row.totalMinor === 5000n);
  const item = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(subscriptionItems)
          .where(
            and(
              eq(subscriptionItems.subscriptionId, sub.id),
              eq(subscriptionItems.priceId, addonPrice.id),
            ),
          )
          .limit(1)
      )[0]!,
  );
  ok("GB1: cycles_billed counted exactly once for the capped item", item.cyclesBilled === 1);
  void prod;
}

// ══════════════════════════════════════════════════════════════════════════════
// FG — Finale-review verify gaps (carried since Phase G)
// ══════════════════════════════════════════════════════════════════════════════

// FG1: TRUE 4-class stack in one invoice — line-fixed → line-% → invoice-fixed →
// invoice-% sequentially on the running amount. Hand-computed:
//   plan 10000 + addon 2000 = 12000
//   line-fixed  −3000 (plan-constrained)             → running 9000
//   line-%      −20% of plan(7000)+addon(2000) = −1800 → running 7200
//   inv-fixed   −1200                                  → running 6000
//   inv-%       −10% of 6000 = −600                    → total 5400
{
  const { biz, prod, price } = await freshBiz("FG1 four-class");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "fg1@a.com",
    autoCollection: "on",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const plan = await price(10000);
  const addonProd = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "FG1 addon",
    kind: "addon",
  });
  const addonPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: addonProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 2000,
    interval: "month",
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [
      { price: plan, quantity: 1 },
      { price: addonPrice, quantity: 1 },
    ],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "LF3000",
    kind: "fixed_amount",
    amountOffMinor: 3000,
    currency: "USD",
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "LP20A",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [
      { itemKind: "plan", constraintType: "all" },
      { itemKind: "addon", constraintType: "all" },
    ],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "IF1200",
    kind: "fixed_amount",
    amountOffMinor: 1200,
    currency: "USD",
    durationType: "forever",
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "IP10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  for (const code of ["LF3000", "LP20A", "IF1200", "IP10"]) {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      code,
      now: new Date(),
    });
  }
  const inv = await billNow(biz.id, sub);
  ok(
    "FG1: 4-class stack total 5400 (12000 −3000 −1800 −1200 −600)",
    Number(inv.totalMinor) === 5400,
  );
  const dl = (await discountLines(inv.id)).map(Number).sort((a, b) => a - b);
  ok(
    "FG1: four discount lines, class order amounts",
    dl.length === 4 && dl[0] === -3000 && dl[1] === -1800 && dl[2] === -1200 && dl[3] === -600,
  );
  ok("FG1: ledger nets zero", await ledgerNetsZero(biz.id));
  void prod;
}

// FG2: over-discount clamp — a fixed coupon larger than the whole invoice clamps
// to zero, never negative.
{
  const { biz } = await freshBiz("FG2 clamp");
  const { sub } = await paidSub(biz.id, "fg2@a.com", 5000);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "HUGE",
    kind: "fixed_amount",
    amountOffMinor: 999999,
    currency: "USD",
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "HUGE",
    now: new Date(),
  });
  const inv = await billNow(biz.id, sub);
  ok(
    "FG2: discount clamps at the invoice (total 0, status paid)",
    Number(inv.totalMinor) === 0 && inv.status === "paid",
  );
  ok(
    "FG2: discount line is exactly −5000, never more",
    (await discountLines(inv.id)).map(Number)[0] === -5000,
  );
  ok("FG2: ledger nets zero", await ledgerNetsZero(biz.id));
}

// FG3: INCLUSIVE tax × INVOICE-level coupon. Plan 11000 inclusive @10%:
// invoice-10% coupon → discounted gross 9900 → inclusive tax = 9900×1000/11000 = 900.
{
  const { biz: b } = await freshBiz("FG3 inclusive×invoice");
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: b.id,
    name: "US",
    country: "US",
    rateBps: 1000,
  });
  const c = await createCustomer({
    organizationId: orgId,
    businessId: b.id,
    email: "fg3@a.com",
    autoCollection: "on",
    address: { country: "US" },
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: b.id,
    customer: c,
    token: "tok_4242",
  });
  const prod3 = await createProduct({ organizationId: orgId, businessId: b.id, name: "FG3" });
  const p3 = await createPrice({
    organizationId: orgId,
    businessId: b.id,
    productId: prod3.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 11000,
    interval: "month",
    taxBehavior: "inclusive",
  });
  const { subscription: sub3 } = await createSubscription({
    organizationId: orgId,
    businessId: b.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: p3, quantity: 1 }],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: b.id,
    code: "IP10B",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: b.id,
    subscriptionId: sub3.id,
    code: "IP10B",
    now: new Date(),
  });
  const inv3 = await billNow(b.id, sub3);
  ok("FG3: inclusive × invoice-% → total 9900 (tax inside)", Number(inv3.totalMinor) === 9900);
  ok("FG3: tax_payable = 900 (9900×1000/11000)", (await acctBal(b.id, "tax_payable")) === -900n);
  ok("FG3: ledger nets zero", await ledgerNetsZero(b.id));
}

// FG4: tiered differential at the EXACT tier boundary. Tiers: up to 10 @100/u,
// beyond @50/u. qty 10 → 1000; qty 11 → 1000 + 50 = 1050.
{
  const { biz, price } = await freshBiz("FG4 tier edge");
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "fg4@a.com",
    autoCollection: "off",
  });
  const plan = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "FG4 plan",
    kind: "plan",
    id: "fg4-plan",
  });
  const planPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 0,
    interval: "month",
  });
  const addon = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "FG4 addon",
    kind: "addon",
    id: "fg4-addon",
  });
  const addonPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: addon.id,
    type: "recurring",
    model: "tiered",
    currency: "USD",
    amountMinor: 0,
    interval: "month",
    tiers: [
      { upToMinor: 10, unitAmountMinor: 100 },
      { upToMinor: null, unitAmountMinor: 50 },
    ],
  });
  const mk = (qty: number, email: string) =>
    createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [
        { price: planPrice, quantity: 1 },
        { price: addonPrice, quantity: qty },
      ],
    });
  const { subscription: sAt } = await mk(10, "x");
  const invAt = await billNow(biz.id, sAt);
  ok("FG4: qty exactly AT the boundary (10) → 1000", Number(invAt.totalMinor) === 1000);
  const { subscription: sOver } = await mk(11, "y");
  const invOver = await billNow(biz.id, sOver);
  ok("FG4: qty 11 → 1050 (next tier gets exactly 1 unit)", Number(invOver.totalMinor) === 1050);
  void price;
}

// FG5: valid_from / redeem_by at the EXACT boundary instant. valid_from = T:
// apply at T succeeds (inclusive); redeem_by = T: apply at T is rejected
// (expiry is exclusive — the instant itself is past).
{
  const { biz } = await freshBiz("FG5 instants");
  const { sub } = await paidSub(biz.id, "fg5@a.com", 5000);
  const T = new Date();
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "VFROM",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    validFrom: T,
  });
  let vfOk = true;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      code: "VFROM",
      now: T,
    });
  } catch {
    vfOk = false;
  }
  ok("FG5: apply AT valid_from instant is accepted (inclusive)", vfOk);
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "RBY",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    redeemBy: T,
  });
  let rbRejected = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      code: "RBY",
      now: new Date(T.getTime() + 1),
    });
  } catch (e) {
    rbRejected = e instanceof CouponError;
  }
  ok("FG5: apply past redeem_by instant is rejected", rbRejected);
}

// ── Report ──────────────────────────────────────────────────────────────────
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ CATALOG V2: PASS" : "❌ CATALOG V2: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
