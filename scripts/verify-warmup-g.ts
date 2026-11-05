/**
 * Phase G review-backlog warm-up — regression suite for the money/correctness
 * should-fixes cleared in the Phase H session. HAND-COMPUTED constants + real
 * lifecycle (no fabricated state):
 *   W1  void refunds the coupon redemption (remaining_periods restored)
 *   W2  a $0-effect (constrained, non-matching) coupon does NOT burn a period
 *   W3  trigger_charge guards (on_demand-only; charge_once fires once; status)
 *   W4  plan swap REMOVES the old plan's mandatory add-on
 *   W5  a late HARD decline (reversal retriable=false) does NOT re-arm dunning
 *
 *   pnpm verify:warmup-g
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setItemApplicablePlans } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { triggerAttachedItemCharge } from "@/modules/subscriptions/items";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { voidInvoice } from "@/modules/invoicing/ops";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { recordTransaction } from "@/modules/transactions/service";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { invoices, subscriptions, subscriptionItems, appliedCoupons, payments } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "WarmupG Org" });
const orgId = org.organization.id;
const rid = org.organization.publicId.slice(-6);

async function pmCustomer(bizId: string, email: string) {
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
  return c;
}
async function plan(bizId: string, slug: string, amt: number, kind: "plan" | "addon" = "plan") {
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
    model: "flat",
    currency: "USD",
    amountMinor: amt,
    interval: "month",
  });
  return { prod, price };
}
async function freshSub(subId: string) {
  return (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1),
    )
  )[0]!;
}

// ── W1: void refunds the coupon redemption ────────────────────────────────────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "W1 void-restore",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price } = await plan(biz.id, "w1plan", 10000);
  // Offline customer → invoice stays `posted` (open) so it can be voided.
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "w1@a.com",
    autoCollection: "off",
    address: { country: "US" },
  });
  // Repeating 20%-off for 2 periods.
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "REP20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "repeating",
    durationInPeriods: 2,
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "REP20",
    now: new Date(),
  });
  const fresh1 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1),
    )
  )[0]!;
  const bill = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh1,
    periodStart: fresh1.currentPeriodStart!,
    periodEnd: fresh1.currentPeriodEnd!,
  });
  ok("W1: discounted invoice total 8000 (20% off 10000)", Number(bill.invoice.totalMinor) === 8000);
  const ac1 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, sub.id)).limit(1),
    )
  )[0]!;
  ok(
    "W1: after billing, 1 period remains (2→1)",
    ac1.remainingPeriods === 1 && ac1.status === "active",
  );
  await voidInvoice(orgId, biz.id, bill.invoice.publicId);
  const ac2 = (
    await withTenant(orgId, (tx) =>
      tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, sub.id)).limit(1),
    )
  )[0]!;
  ok(
    "W1: void restores the redemption (1→2, active)",
    ac2.remainingPeriods === 2 && ac2.status === "active",
  );
}

// ── W2: a constrained coupon that matches NO line does not burn a period ──────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "W2 zero-burn",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price } = await plan(biz.id, "w2plan", 10000); // a PLAN line
  const c = await pmCustomer(biz.id, "w2@a.com");
  // each_specified_item coupon scoped to ADDONS only → never matches a plan-only invoice.
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "ADDONONLY",
    kind: "percentage",
    percentOffBps: 5000,
    durationType: "repeating",
    durationInPeriods: 2,
    applyOn: "each_specified_item",
    itemConstraints: [{ itemKind: "addon", constraintType: "all" }],
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    code: "ADDONONLY",
    now: new Date(),
  });
  const fresh = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1),
    )
  )[0]!;
  const bill = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  ok("W2: no discount applied (total 10000)", Number(bill.invoice.totalMinor) === 10000);
  const ac = (
    await withTenant(orgId, (tx) =>
      tx.select().from(appliedCoupons).where(eq(appliedCoupons.subscriptionId, sub.id)).limit(1),
    )
  )[0]!;
  ok(
    "W2: $0-effect coupon did NOT burn a period (still 2, active)",
    ac.remainingPeriods === 2 && ac.status === "active",
  );
}

// ── W3: trigger_charge guards ─────────────────────────────────────────────────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "W3 trigger-guards",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: planPrice } = await plan(biz.id, "w3plan", 10000);
  await plan(biz.id, "w3create", 3000, "addon"); // charge_on_event defaults to subscription_creation
  await plan(biz.id, "w3once", 2000, "addon");
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "w3create",
    planPublicIds: ["w3plan"],
    applicability: { w3plan: "optional" },
  });
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "w3once",
    planPublicIds: ["w3plan"],
    applicability: { w3plan: "optional" },
    config: { w3plan: { chargeOnEvent: "on_demand", chargeOnce: true } },
  });
  const c = await pmCustomer(biz.id, "w3@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: planPrice, quantity: 1 }],
  });
  // A subscription_creation attached item cannot be triggered on-demand.
  let rejectedEvent = false;
  try {
    await triggerAttachedItemCharge({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      itemPublicId: "w3create",
      now: new Date(),
    });
  } catch {
    rejectedEvent = true;
  }
  ok("W3: trigger_charge rejects a non-on_demand attached item", rejectedEvent);
  // charge_once on_demand fires once…
  const first = await triggerAttachedItemCharge({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    itemPublicId: "w3once",
    now: new Date(),
  });
  ok("W3: charge_once on_demand fires the first time", Number(first.invoice.totalMinor) === 2000);
  // …and rejects a second time.
  let rejectedOnce = false;
  try {
    await triggerAttachedItemCharge({
      organizationId: orgId,
      businessId: biz.id,
      subscriptionId: sub.id,
      itemPublicId: "w3once",
      now: new Date(),
    });
  } catch {
    rejectedOnce = true;
  }
  ok("W3: charge_once on_demand rejects the second charge", rejectedOnce);
}

// ── W4: plan swap REMOVES the old plan's mandatory add-on ─────────────────────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "W4 swap-remove",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price: p1 } = await plan(biz.id, "w4one", 10000);
  const { price: p2 } = await plan(biz.id, "w4two", 12000);
  await plan(biz.id, "w4addon", 2000, "addon");
  // addon is mandatory ONLY for plan one.
  await setItemApplicablePlans({
    organizationId: orgId,
    businessId: biz.id,
    itemPublicId: "w4addon",
    planPublicIds: ["w4one"],
    applicability: { w4one: "mandatory" },
  });
  const c = await pmCustomer(biz.id, "w4@a.com");
  const { subscription: sub, items } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price: p1, quantity: 1 }],
  });
  ok("W4: plan one auto-includes its mandatory addon (2 items)", items.length === 2);
  const planItem = items.find((i) => i.priceId === p1.id)!;
  await changeSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: sub.id,
    now: new Date(),
    changes: [{ itemId: planItem.publicId, newPriceId: p2.publicId }],
  });
  const after = await withTenant(orgId, (tx) =>
    tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, sub.id)),
  );
  ok(
    "W4: swap to plan two REMOVES the old mandatory addon (1 item)",
    after.length === 1 && after[0]!.priceId === p2.id,
  );
}

// ── W5: a late HARD decline (retriable=false) does NOT re-arm dunning ─────────
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "W5 hard-reversal",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const { price } = await plan(biz.id, "w5plan", 6000);
  const c = await pmCustomer(biz.id, "w5@a.com");
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const fresh = (
    await withTenant(orgId, (tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, sub.id)).limit(1),
    )
  )[0]!;
  const paid = await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  ok("W5: card invoice paid", paid.invoice.status === "paid");
  const payRow = (
    await withTenant(orgId, (tx) =>
      tx.select().from(payments).where(eq(payments.invoiceId, paid.invoice.id)).limit(1),
    )
  )[0]!;
  const succTxn = await recordTransaction({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    type: "payment",
    status: "succeeded",
    amountMinor: 6000n,
    currency: "USD",
    gatewayKey: "tmtest",
    idAtGateway: `tmch_hard_${rid}`,
    invoiceId: paid.invoice.id,
    paymentId: payRow.id,
  });
  await handleProviderEvent(
    "tmtest",
    {
      providerEventId: `tmev_hard_${rid}`,
      type: "charge.failed",
      providerChargeId: `tmch_hard_${rid}`,
      occurredAt: new Date(),
      raw: { data: { reversal: true, retriable: false } },
    },
    { businessId: biz.id, payload: { id: `tmev_hard_${rid}` } },
  );
  const reopened = (
    await withTenant(orgId, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, paid.invoice.id)).limit(1),
    )
  )[0]!;
  ok(
    "W5: hard reversal reopens NOT for retry (not_paid, no next attempt)",
    reopened.status === "not_paid" && reopened.nextAttemptAt === null,
  );
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ WARMUP-G: PASS" : `❌ WARMUP-G: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
