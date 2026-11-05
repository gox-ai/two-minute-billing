/**
 * Coupons / discounts — permutation coverage:
 *  - percentage 'once' applies to invoice #1 only, not #2 (renewal),
 *  - 'forever' applies to every invoice,
 *  - 'repeating' N applies to N invoices then stops,
 *  - fixed-amount > subtotal clamps (total never negative),
 *  - discount applied BEFORE tax (tax on discounted subtotal),
 *  - expired and max-redeemed coupons are rejected,
 *  - ledger: revenue gross, discounts contra, balanced.
 *
 *   pnpm verify:coupons
 */
import { eq, desc } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod, createInvoiceFromLines } from "@/modules/invoicing/service";
import { estimateRenewal } from "@/modules/subscriptions/estimate";
import {
  createCoupon,
  applyCouponToSubscription,
  applyManualDiscount,
  removeDiscount,
  CouponError,
} from "@/modules/coupons/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import {
  invoices,
  subscriptions,
  ledgerEntries,
  invoiceLineItems,
  invoiceLineDiscounts,
  appliedCoupons,
} from "@db/schema";

const org = await createOrganization({ name: "Coupon Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
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
  interval: "month", // $100
});

async function mkCustomerSub(email: string, country?: string) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email,
    address: country ? { line1: "1 St", country } : undefined,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  return sub.subscription;
}
/**
 * Bill the sub for its NEXT period and return the invoice total.
 *
 * ⚠️ This ADVANCES the period before billing, exactly as the real renewal does
 * (`subscriptions/renewal.ts` — "so the invoice we generate reflects the new period").
 * It used to re-bill the SAME period over and over, which looked like a renewal only
 * because the old coupon model consumed a period per INVOICE rather than per period.
 * Under 0247 a fixed amount is a per-period allowance, so a second invoice in one period
 * correctly gets nothing more — and this helper would have reported that as a regression
 * while the gate's own expectations (7500, 7500, 10000) were the correct ones all along.
 *
 * The lesson is the helper, not the assertion: a test that simulates a renewal must move
 * the period, or it is testing something the product never does.
 */
async function rebill(sub: typeof subscriptions.$inferSelect) {
  const fresh = await withTenant(orgId, async (tx) => {
    const [cur] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sub.id))
      .limit(1);
    const start = cur!.currentPeriodEnd!;
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const [advanced] = await tx
      .update(subscriptions)
      .set({ currentPeriodStart: start, currentPeriodEnd: end })
      .where(eq(subscriptions.id, sub.id))
      .returning();
    return advanced!;
  });
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  return Number(invoice.totalMinor);
}

const checks: Array<[string, boolean]> = [];

// 1) percentage 'once' (20%) → inv1 $80, inv2 $100.
{
  const sub = await mkCustomerSub("once@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "ONCE20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "once",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "ONCE20",
    now: new Date(),
  });
  const inv1 = await rebill(sub);
  const inv2 = await rebill(sub);
  console.log(`once 20%: inv1=${inv1} (exp 8000), inv2=${inv2} (exp 10000)`);
  checks.push(["once: inv1 discounted", inv1 === 8000], ["once: inv2 full", inv2 === 10000]);
}

// 1b) 0247 — a fixed amount is a PER-PERIOD ALLOWANCE, and a mid-term invoice neither
//     takes it twice nor costs a period.
//
//     This is the defect that was reported and then mis-fixed twice, so it is pinned here
//     rather than left to the unit tests: today's behaviour burned a period on the
//     proration (delivering 2 x $50 of a 3 x $50 coupon), and the reverted 0246 let the
//     proration discount for free (delivering $200 of $150, unbounded in the number of
//     mid-term changes). The only correct total is exactly 3 x $50.
{
  const sub = await mkCustomerSub("allowance@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "ALLOW50",
    kind: "fixed_amount",
    amountOffMinor: 5000,
    currency: "USD",
    durationType: "repeating",
    durationInPeriods: 3,
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "ALLOW50",
    now: new Date(),
  });

  /** A mid-term charge inside the subscription's CURRENT period. */
  const midTerm = async (amountMinor: bigint) => {
    const fresh = await withTenant(
      orgId,
      async (tx) =>
        (await tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1))[0]!,
    );
    const { invoice } = await createInvoiceFromLines({
      organizationId: orgId,
      businessId: biz.id,
      customerId: fresh.customerId,
      currency: "USD",
      subscriptionId: sub.id,
      subscription: fresh,
      lines: [{ description: "mid-term proration", amountMinor }],
    });
    return Number(invoice.totalMinor);
  };

  const r1 = await rebill(sub); // $100 - $50 allowance = $50, one period spent
  const m1 = await midTerm(2500n); // same period, allowance spent → no discount
  const m2 = await midTerm(2500n); // and again, still nothing
  const r2 = await rebill(sub); // new period → full allowance again
  const r3 = await rebill(sub); // third and last period
  const r4 = await rebill(sub); // exhausted → full price

  const given = 10000 - r1 + (2500 - m1) + (2500 - m2) + (10000 - r2) + (10000 - r3) + (10000 - r4);
  console.log(
    `allowance: renewals=${r1},${r2},${r3},${r4} midterm=${m1},${m2} totalDiscount=${given} (exp 15000)`,
  );
  checks.push(
    ["allowance: the renewal takes the period's amount", r1 === 5000],
    ["allowance: a mid-term invoice in the SAME period gets nothing more", m1 === 2500],
    ["allowance: nor does a second one", m2 === 2500],
    ["allowance: the next period resets to the full amount", r2 === 5000],
    ["allowance: mid-term invoices cost no period, so the 3rd still discounts", r3 === 5000],
    ["allowance: exhausted after exactly 3 PERIODS", r4 === 10000],
    ["allowance: total delivered is exactly 3 x the amount, never more or less", given === 15000],
  );
}

// 2) 'forever' (10%) → every invoice $90.
{
  const sub = await mkCustomerSub("fvr@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "FVR10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "FVR10",
    now: new Date(),
  });
  const a = await rebill(sub),
    b = await rebill(sub),
    c = await rebill(sub);
  console.log(`forever 10%: ${a},${b},${c} (all exp 9000)`);
  checks.push(["forever: all discounted", a === 9000 && b === 9000 && c === 9000]);

  /**
   * `discount_lines` must SUM to `discount_minor`.
   *
   * The lump `discount_minor` let every surface quoting an estimate show a total already
   * net of a discount beside gross line items, naming nothing — which is how the buyer's
   * portal came to display a discounted next payment under undiscounted plan rows. The
   * named rows fix that only while they add up: rows that fall short (dropping the
   * promotional slice is the easy way) put the same unexplained gap back, just smaller.
   */
  const est = await estimateRenewal({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
  });
  const lines = est?.discount_lines ?? [];
  const summed = lines.reduce((t, l) => t + l.amount_minor, 0);
  checks.push(
    ["forever: the renewal estimate names its discount", lines.length === 1],
    ["forever: the named row carries the coupon's label", lines[0]?.label === "FVR10"],
    ["forever: discount_lines sums to discount_minor", summed === (est?.discount_minor ?? -1)],
  );
}

// 3) 'repeating' 2 ($25 off) → inv1,2 = $75, inv3 = $100.
{
  const sub = await mkCustomerSub("rep@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "REP25",
    kind: "fixed_amount",
    amountOffMinor: 2500,
    currency: "USD",
    durationType: "repeating",
    durationInPeriods: 2,
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "REP25",
    now: new Date(),
  });
  const a = await rebill(sub),
    b = await rebill(sub),
    c = await rebill(sub);
  console.log(`repeating(2) $25: ${a},${b},${c} (exp 7500,7500,10000)`);
  checks.push(["repeating: 2 discounted then stop", a === 7500 && b === 7500 && c === 10000]);
}

// 4) fixed > subtotal clamps → total 0, never negative.
{
  const sub = await mkCustomerSub("big@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "BIG",
    kind: "fixed_amount",
    amountOffMinor: 999999,
    currency: "USD",
    durationType: "once",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "BIG",
    now: new Date(),
  });
  const inv = await rebill(sub);
  console.log(`fixed > subtotal: total=${inv} (exp 0, not negative)`);
  checks.push(["clamp: total 0", inv === 0]);
}

// 5) discount BEFORE tax: 20% off $100 = $80, +10% VAT = $88.
{
  const sub = await mkCustomerSub("tax@a.com", "GB");
  await createFlatTaxRate({
    organizationId: orgId,
    businessId: biz.id,
    name: "VAT",
    country: "GB",
    rateBps: 1000,
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "TAX20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "once",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "TAX20",
    now: new Date(),
  });
  const inv = await rebill(sub);
  console.log(`discount-before-tax: total=${inv} (exp 8800 = 80 + 10% VAT)`);
  checks.push(["discount before tax", inv === 8800]);
}

// 6) rejection: expired + max-redeemed.
{
  const sub = await mkCustomerSub("rej@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "EXPIRED",
    kind: "percentage",
    percentOffBps: 5000,
    durationType: "once",
    redeemBy: new Date(Date.now() - 86_400_000),
  });
  let expiredRejected = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      code: "EXPIRED",
      now: new Date(),
    });
  } catch (e) {
    expiredRejected = e instanceof CouponError;
  }
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "MAXED",
    kind: "percentage",
    percentOffBps: 5000,
    durationType: "once",
    maxRedemptions: 1,
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: (await mkCustomerSub("m1@a.com")).id,
    code: "MAXED",
    now: new Date(),
  });
  let maxedRejected = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: (await mkCustomerSub("m2@a.com")).id,
      code: "MAXED",
      now: new Date(),
    });
  } catch (e) {
    maxedRejected = e instanceof CouponError;
  }
  console.log(`rejections: expired=${expiredRejected}, maxed=${maxedRejected}`);
  checks.push(["expired rejected", expiredRejected], ["max-redeemed rejected", maxedRejected]);
}

// 7b) A manual discount on an IN-TRIAL subscription.
//
// Every other block here builds an ACTIVE subscription, which is exactly why this shipped
// broken: the guard read `sub.status !== 'active' && sub.status !== 'trialing'`, and
// `'trialing'` is a value our column never holds (it is Stripe's word —
// ours is `in_trial`). The column is `text`, so nothing type-checked it and the rule
// silently became "active only". EVERY manual discount on a trialing subscription was
// refused, and refused as a WARNING: the change flow reported "Subscription updated
// (0 step(s)) — warnings: manual discount failed" on a screen whose status chip read
// "In Trial".
//
// The coupon path has no status guard at all, so coupons always worked in trial. The
// asymmetry is the tell, and is asserted here too.
{
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "manual-trial@a.com",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const { subscription: trialSub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    trialDays: 14,
  });
  const storedStatus = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select({ status: subscriptions.status })
          .from(subscriptions)
          .where(eq(subscriptions.id, trialSub.id))
          .limit(1)
      )[0]!.status,
  );
  let trialAccepted = false;
  try {
    await applyManualDiscount({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: trialSub.id,
      kind: "percentage",
      percentOffBps: 2500,
      durationType: "forever",
      now: new Date(),
    });
    trialAccepted = true;
  } catch {
    trialAccepted = false;
  }
  console.log(`manual discount on trial: storedStatus=${storedStatus}, accepted=${trialAccepted}`);
  checks.push(
    // Pins the vocabulary itself — if the stored value ever becomes 'trialing' for real,
    // this fails and the guard gets revisited deliberately rather than by accident.
    ["a trialing subscription stores status = in_trial", storedStatus === "in_trial"],
    ["manual discount is ACCEPTED on an in-trial subscription", trialAccepted],
  );

  // And a coupon on a trial sub, so the two paths are asserted to agree.
  const customer2 = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "coupon-trial@a.com",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: customer2,
    token: "tok_4242",
  });
  const { subscription: trialSub2 } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer2.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    trialDays: 14,
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "TRIALOK",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  let couponOnTrial = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: trialSub2.id,
      code: "TRIALOK",
      now: new Date(),
    });
    couponOnTrial = true;
  } catch {
    couponOnTrial = false;
  }
  checks.push(["a coupon is accepted on an in-trial subscription too", couponOnTrial]);
}

// 8) manual discount — percent, one_time consumed, forever persists, reject
// double-discount, and remove (%/amount, no coupon object).
{
  const sub = await mkCustomerSub("manual-pct@a.com");
  await applyManualDiscount({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    kind: "percentage",
    percentOffBps: 1500,
    durationType: "once",
    now: new Date(),
  });
  const inv1 = await rebill(sub);
  const inv2 = await rebill(sub);
  console.log(`manual percent 15% once: inv1=${inv1} (exp 8500), inv2=${inv2} (exp 10000)`);
  checks.push(
    ["manual percent: inv1 discounted", inv1 === 8500],
    ["manual percent once: inv2 full", inv2 === 10000],
  );
}

{
  const sub = await mkCustomerSub("manual-amt@a.com");
  await applyManualDiscount({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    kind: "fixed_amount",
    amountOffMinor: 3000,
    currency: "USD",
    durationType: "forever",
    now: new Date(),
  });
  const a = await rebill(sub),
    b = await rebill(sub);
  console.log(`manual amount $30 forever: ${a},${b} (exp 7000,7000)`);
  checks.push(["manual amount forever: persists", a === 7000 && b === 7000]);
}

{
  const sub = await mkCustomerSub("manual-reject@a.com");
  await applyManualDiscount({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    now: new Date(),
  });
  let doubleRejected = false;
  try {
    await applyManualDiscount({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      kind: "percentage",
      percentOffBps: 2000,
      durationType: "once",
      now: new Date(),
    });
  } catch (e) {
    doubleRejected = e instanceof CouponError;
  }
  // Same rule applies against an existing coupon-sourced discount.
  const sub2 = await mkCustomerSub("manual-vs-coupon@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "MVSC",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub2.id,
    code: "MVSC",
    now: new Date(),
  });
  let manualVsCouponRejected = false;
  try {
    await applyManualDiscount({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub2.id,
      kind: "percentage",
      percentOffBps: 1000,
      durationType: "once",
      now: new Date(),
    });
  } catch (e) {
    manualVsCouponRejected = e instanceof CouponError;
  }
  console.log(
    `manual double-discount rejected: manual-on-manual=${doubleRejected}, manual-on-coupon=${manualVsCouponRejected}`,
  );
  checks.push(
    ["manual: reject double discount", doubleRejected],
    ["manual: reject over existing coupon", manualVsCouponRejected],
  );

  const removedCount = await removeDiscount(orgId, sub.id);
  const invAfterRemove = await rebill(sub);
  console.log(
    `manual remove: removedCount=${removedCount}, invAfterRemove=${invAfterRemove} (exp 1,10000)`,
  );
  checks.push(["manual: remove works", removedCount === 1 && invAfterRemove === 10000]);
}

// 6b) THE TWO-STAGE WATERFALL (0169) — an ITEM-level coupon nets into `subtotal_minor`,
// a DOCUMENT-level one does not. This is the only end-to-end coverage of the item-level
// path, which is the one that moves the stored subtotal; the pre-existing W2 case in
// verify-warmup-g only covers a constrained coupon that matches NOTHING.
{
  const itemProduct = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "ItemLvl",
  });
  const itemPrice = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: itemProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "itemlvl@a.com",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "tok_4242",
  });
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: itemPrice, quantity: 1 }],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "ITEM15",
    kind: "percentage",
    // `repeating`, not `forever`, on purpose: a forever coupon has remaining_periods
    // = null and never consumes, so it could not detect the regression below.
    percentOffBps: 1500,
    durationType: "repeating",
    durationInPeriods: 2,
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "plan", constraintType: "all" }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: created.subscription.id,
    code: "ITEM15",
    now: new Date(),
  });
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.id, created.subscription.id))
          .limit(1)
      )[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  const lines = await withTenant(orgId, (tx) =>
    tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoice.id)),
  );
  const shares = await withTenant(orgId, (tx) =>
    tx.select().from(invoiceLineDiscounts).where(eq(invoiceLineDiscounts.invoiceId, invoice.id)),
  );
  const CHARGE = new Set(["recurring", "proration", "usage", "one_time"]);
  const gross = lines.filter((l) => CHARGE.has(l.kind)).reduce((s, l) => s + l.amountMinor, 0n);
  const itemLvl = shares
    .filter((s) => s.scope === "item_level")
    .reduce((s, x) => s + x.amountMinor, 0n);
  const docLvl = shares
    .filter((s) => s.scope === "document_level")
    .reduce((s, x) => s + x.amountMinor, 0n);
  const discLines = lines.filter((l) => l.kind === "discount").length;
  const perLine = lines.filter((l) => CHARGE.has(l.kind)).reduce((s, l) => s + l.discountMinor, 0n);
  console.log(
    `item-level 15%: gross=${gross} item=${itemLvl} doc=${docLvl} subtotal=${invoice.subtotalMinor} ` +
      `total=${invoice.totalMinor} perLineDiscount=${perLine} aggregateDiscountLines=${discLines}`,
  );
  checks.push(
    // The money is unchanged — this is the safety property of the whole change.
    ["item-level: total still 8500", Number(invoice.totalMinor) === 8500],
    // …but the SUBTOTAL is now net.
    ["item-level: subtotal NET (8500, not gross 10000)", invoice.subtotalMinor === 8500n],
    ["item-level: attributed as item_level", itemLvl === 1500n && docLvl === 0n],
    ["item-level: per-line discount_minor recorded", perLine === 1500n],
    // No aggregate line: it would subtract the discount a second time.
    ["item-level: NO aggregate discount line", discLines === 0],
    ["item-level: subtotal = gross − item_level", invoice.subtotalMinor === gross - itemLvl],
  );
  // Redemption must still be consumed even though NO discount line was written. Gating
  // consumption on the line existing would let a repeating/once item-level coupon
  // discount every renewal forever — the invoice would look right and the entitlement
  // would silently never expire.
  const ac = (
    await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(appliedCoupons)
        .where(eq(appliedCoupons.subscriptionId, created.subscription.id))
        .limit(1),
    )
  )[0]!;
  checks.push([
    "item-level: period consumed despite no discount line (2 → 1)",
    ac.remainingPeriods === 1 && ac.status === "active",
  ]);

  // The /discount route asks for an item match: a coupon scoped to items the subscription
  // does not have is refused instead of sitting "active" and discounting nothing.
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "ADDON10",
    kind: "percentage",
    percentOffBps: 1000,
    durationType: "forever",
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "addon", constraintType: "all" }],
  });
  let noMatchRefused = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: created.subscription.id,
      code: "ADDON10",
      now: new Date(),
      requireItemMatch: true,
    });
  } catch (e) {
    noMatchRefused = e instanceof CouponError && /applies to none of the items/.test(e.message);
  }
  const addonRows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(appliedCoupons)
      .where(eq(appliedCoupons.subscriptionId, created.subscription.id)),
  );
  checks.push(
    ["item match: an add-on-only coupon on a plan-only subscription is refused", noMatchRefused],
    ["item match: …and nothing is attached", addonRows.length === 1],
  );
  const planSub = await mkCustomerSub("itemmatch@a.com");
  let planMatchOk = false;
  try {
    await applyCouponToSubscription({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: planSub.id,
      code: "ITEM15",
      now: new Date(),
      requireItemMatch: true,
    });
    planMatchOk = true;
  } catch {
    planMatchOk = false;
  }
  checks.push([
    "item match: a plan-scoped coupon on a subscription with a plan applies",
    planMatchOk,
  ]);

  // The same 15% as a DOCUMENT-level coupon leaves the subtotal gross.
  const docSub = await mkCustomerSub("doclvl@a.com");
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "DOC15",
    kind: "percentage",
    percentOffBps: 1500,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: docSub.id,
    code: "DOC15",
    now: new Date(),
  });
  const freshDoc = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, docSub.id)).limit(1))[0]!,
  );
  const { invoice: docInv } = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: freshDoc,
    periodStart: freshDoc.currentPeriodStart!,
    periodEnd: freshDoc.currentPeriodEnd!,
  });
  console.log(
    `document-level 15%: subtotal=${docInv.subtotalMinor} total=${docInv.totalMinor} (exp 10000, 8500)`,
  );
  checks.push(
    ["document-level: same total as item-level (8500)", Number(docInv.totalMinor) === 8500],
    ["document-level: subtotal stays GROSS (10000)", docInv.subtotalMinor === 10000n],
  );
}

// 7) ledger balances per transaction (every txn nets to zero — invariant).
/**
 * PER (transaction, CURRENCY) — grouping on `transaction_id` alone was wrong in BOTH
 * directions, and it cost a full-gate investigation on 2026-09-03.
 *
 * `assertBalanced` (ledger/service.ts) validates each posting per CURRENCY, so a
 * transaction with legs in two currencies is legitimate and its cross-currency sum of
 * `amount_minor` is meaningless — the old query reported such a row as UNBALANCED. The
 * same flattening hides the real thing: +100 USD against -100 INR nets to zero and
 * passed. So it false-positived on legal data and could mask an actual imbalance.
 *
 * It also failed SILENTLY: the old form returned only a boolean, so a red line said
 * "all ledger transactions balanced ✗" and named nothing. The offending rows are now
 * printed, because an invariant that fails without saying which row failed sends the
 * next person bisecting sixty suites.
 *
 * ⚠ STILL GLOBAL, deliberately not narrowed here: it reads every organization's
 * entries, so in `verify:all` it also judges data that earlier suites left behind. That
 * is why this passes when the suite runs alone and failed inside the full run. Scoping
 * it to this suite's own organization would make it hermetic — worth doing, but it
 * would also stop it noticing an imbalance created anywhere else, which is a real
 * trade-off and not a tidy-up (see docs/PROGRESS.md).
 */
const allBalanced = await (async () => {
  const { sql: raw } = await import("drizzle-orm");
  const rows = (await systemDb.execute(
    raw`select transaction_id, currency,
               sum(case when direction='debit' then amount_minor else -amount_minor end) as net,
               string_agg(distinct account, ',') as accounts,
               string_agg(distinct source_type, ',') as sources
          from ledger_entries group by transaction_id, currency
         having sum(case when direction='debit' then amount_minor else -amount_minor end) <> 0
         limit 5`,
  )) as unknown as unknown[];
  for (const r of rows) console.log(`    ↳ unbalanced: ${JSON.stringify(r)}`);
  return rows.length === 0;
})();
checks.push(["all ledger transactions balanced", allBalanced]);

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ COUPONS: PASS" : "❌ COUPONS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
