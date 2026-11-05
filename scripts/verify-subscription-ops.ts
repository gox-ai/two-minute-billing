/**
 * Subscription/account ops (Phase 8 ride-along CRUD):
 *  - customer edit (email/name/address) + soft archive (drops from active list),
 *  - payment-method set-default → collection prefers the default PM,
 *  - payment-method detach (delete; payment history survives via set-null),
 *  - discount removal (active coupon → removed; next invoice bills full price).
 *
 *   pnpm verify:subscription-ops
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import {
  createCustomer,
  updateCustomer,
  setCustomerActive,
  listCustomers,
} from "@/modules/customers/service";
import {
  vaultPaymentMethod,
  setDefaultPaymentMethod,
  detachPaymentMethod,
  listPaymentMethods,
} from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  reactivateSubscription,
  reactivateSubscriptionWithOptions,
} from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createCoupon, applyCouponToSubscription, removeDiscount } from "@/modules/coupons/service";
import { subscriptions } from "@db/schema";

const org = await createOrganization({ name: "SubOps Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const product = await createProduct({ ...ctx, name: "Pro", kind: "plan" });
const price = await createPrice({
  ...ctx,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});

const checks: Array<[string, boolean]> = [];
async function rebill(subId: string): Promise<number> {
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (await tx.select().from(subscriptions).where(eq(subscriptions.id, subId)).limit(1))[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  return Number(invoice.totalMinor);
}

// 1) Customer edit + archive.
{
  const c = await createCustomer({
    ...ctx,
    email: "old@a.com",
    firstName: "Old",
    lastName: "Name",
  });
  const edited = await updateCustomer({
    ...ctx,
    customerPublicId: c.publicId,
    email: "new@a.com",
    firstName: "New",
    lastName: "Name",
    address: { line1: "1 St", country: "US" },
  });
  await setCustomerActive(orgId, biz.id, c.publicId, false);
  const active = await listCustomers(orgId, biz.id);
  const all = await listCustomers(orgId, biz.id, { includeArchived: true });
  checks.push(
    // `edited` is the raw ROW, so it has no derived `name` — that key exists only on
    // the serialized wire shape now (`customers.name` is deprecated, 2026-08-23).
    [
      "customer edited",
      edited?.email === "new@a.com" &&
        edited?.firstName === "New" &&
        edited?.lastName === "Name" &&
        edited?.country === "US",
    ],
    ["archived customer hidden from active list", !active.some((x) => x.id === c.id)],
    ["archived customer in include_archived", all.some((x) => x.id === c.id)],
  );
}

// 2) PM set-default → collection prefers default. Vault GOOD first, DECLINE last,
//    set GOOD default; a sub with no explicit PM must charge the default (good).
{
  const customer = await createCustomer({ ...ctx, email: "pm@a.com" });
  const good = await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  await vaultPaymentMethod({ ...ctx, customer, token: "4000000000009995" }); // would decline if picked
  await setDefaultPaymentMethod(orgId, customer.id, good.publicId);
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  // Bill explicitly (service create doesn't auto-bill). With no explicit sub PM,
  // collection must pick the default (good) card → paid; the decline (0002) would → open.
  const fresh = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription: fresh,
    periodStart: fresh.currentPeriodStart!,
    periodEnd: fresh.currentPeriodEnd!,
  });
  const pms = await listPaymentMethods(orgId, customer.id);
  checks.push(
    ["default flag set on the chosen PM", pms.find((p) => p.id === good.id)?.role === "primary"],
    ["collection charged the default (good) card → paid", invoice.status === "paid"],
  );
  // detach the declining card.
  const decline = pms.find((p) => p.last4 === "9995")!;
  const ok = await detachPaymentMethod(orgId, customer.id, decline.publicId);
  const after = await listPaymentMethods(orgId, customer.id);
  checks.push(["detach removes the PM", ok && !after.some((p) => p.id === decline.id)]);
}

// 3) Discount removal → next invoice full price.
{
  const customer = await createCustomer({ ...ctx, email: "disc@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await createCoupon({
    ...ctx,
    code: "HALF",
    kind: "percentage",
    percentOffBps: 5000,
    durationType: "forever",
  });
  await applyCouponToSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    code: "HALF",
    now: new Date(),
  });
  const discounted = await rebill(subscription.id); // 50% off $100 → $50
  const removed = await removeDiscount(orgId, subscription.id);
  const full = await rebill(subscription.id); // back to $100
  checks.push(
    ["discount applied (50% → 5000)", discounted === 5000],
    ["discount removed", removed > 0],
    ["after removal bills full price", full === 10000],
  );
}

// 4) Reactivate a canceled subscription → active + fresh term.
{
  const customer = await createCustomer({ ...ctx, email: "react@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await cancelSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    atPeriodEnd: false,
    now: new Date(),
  });
  const canceled = await withTenant(
    orgId,
    async (tx) =>
      (
        await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)).limit(1)
      )[0]!,
  );
  const { subscription: reactivated, billable } = await reactivateSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
  });
  checks.push(
    ["sub was canceled", canceled.status === "cancelled"],
    ["reactivated → active", reactivated.status === "active"],
    ["reactivate restarts a billable term", billable && reactivated.canceledAt === null],
  );
}

// 4a2) Reactivation must rate items from their PRICE SNAPSHOT, not the live catalog price.
//      `computeSubscriptionMrr` documents that contract — an item's real amount can live
//      only in its snapshot (a subscription-level custom price, or an add-on attached with
//      a plan-scoped differential whose catalog base is 0 by design).
//
//      `reactivateSubscriptionWithOptions` is the one reactivation path that hand-rolls the
//      cached figure instead of calling `recomputeSubscriptionMrr` (which the plain
//      `reactivateSubscription` at ~2942 does, and which reads snapshots), and BOTH of its
//      branches dropped the snapshot: the `items` branch passed `SubscriptionItemInput`,
//      whose `customAmountMinor` computeSubscriptionMrr does not read, and the no-items
//      branch selected the item row — which HOLDS the snapshot — then discarded it.
//
//      Found in production 2026-09-09: an operator reactivated an imported subscription
//      with a ₹800×5 add-on over a ₹0 catalog price and MRR restated to ₹1,259 instead of
//      ₹5,259. Both branches are asserted because only the no-items one was hit there.
{
  const CUSTOM = 25000; // the catalog price above is 10000
  const makeCancelled = async (label: string) => {
    const customer = await createCustomer({
      ...ctx,
      email: `snap-mrr-${label}-${Date.now()}@x.test`,
    });
    const { subscription } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [{ price, quantity: 1, customAmountMinor: CUSTOM }],
    });
    const atCreate = await withTenant(
      orgId,
      async (tx) =>
        (
          await tx
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, subscription.id))
            .limit(1)
        )[0]!,
    );
    await cancelSubscription({
      ...ctx,
      subscriptionId: subscription.id,
      atPeriodEnd: false,
      now: new Date(),
    });
    return { id: subscription.id, atCreate };
  };

  // No `items` → the branch that regressed in production.
  const keep = await makeCancelled("keep");
  const { subscription: keptItems } = await reactivateSubscriptionWithOptions({
    ...ctx,
    subscriptionId: keep.id,
    now: new Date(),
  });

  // With `items` → the other branch, same defect via a different route.
  const swap = await makeCancelled("swap");
  const { subscription: newItems } = await reactivateSubscriptionWithOptions({
    ...ctx,
    subscriptionId: swap.id,
    now: new Date(),
    items: [{ price: price.publicId, quantity: 1, unitPriceMinor: CUSTOM }],
  });

  checks.push(
    // The control: without it, both assertions below would pass even if CREATE were
    // also rating from the catalog price.
    [
      "CONTROL: create rates the custom price, not the catalog one",
      keep.atCreate.mrr === BigInt(CUSTOM),
    ],
    [
      "reactivate-with-options (no items) rates the SNAPSHOT, not the catalog price",
      keptItems.mrr === BigInt(CUSTOM),
    ],
    [
      "reactivate-with-options (new items) rates the custom price too",
      newItems.mrr === BigInt(CUSTOM),
    ],
  );
}

// 4b) Reactivation RE-ANCHORS the term it opens (2026-08-31). `reactivateSubscriptionWithOptions`
//     restarts a term at `now` and may change the cadence in the same call, but it passed the
//     PRE-cancellation `billing_anchor_day` to `advancePeriod` and never wrote a new one. So a sub
//     anchored on the 8th, reactivated on the 23rd onto a YEARLY price, got a term ending on the
//     8th — 350 days, billed as a FULL YEAR by the reactivate route (`billSubscriptionPeriod` over
//     the stored term), i.e. 15 days of service the customer paid for and did not get.
//     `advancePeriod` takes the result's day-of-month ENTIRELY from its anchorDay argument, so a
//     stale anchor silently relocates the boundary. Same defect the term reset had until
//     proration.ts grew `resetAnchorDay`; this is the sibling path that fix does not reach.
//     NOTE the cadence change is what makes it expensive, not what causes it — any reactivation on
//     a day other than the stored anchor produces a short term.
{
  const { reactivateSubscriptionWithOptions } = await import("@/modules/subscriptions/service");
  const yearly = await createPrice({
    ...ctx,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 120000,
    interval: "year",
  });
  const customer = await createCustomer({ ...ctx, email: "reanchor@a.com" });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date("2026-08-08T00:00:00.000Z"),
    items: [{ price, quantity: 1 }],
  });
  await cancelSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    atPeriodEnd: false,
    now: new Date("2026-08-15T00:00:00.000Z"),
  });
  const { subscription: re } = await reactivateSubscriptionWithOptions({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date("2026-08-23T00:00:00.000Z"),
    items: [{ price: yearly.publicId, quantity: 1 }],
  });
  const span = Math.round(
    (re.currentPeriodEnd!.getTime() - re.currentPeriodStart!.getTime()) / 86_400_000,
  );
  checks.push(
    [
      `reactivated term is a full YEAR, not one ending on the old anchor (got ${span}d)`,
      span >= 365 && span <= 366,
    ],
    [
      "reactivation re-anchors to the new term start (23, not the original 8)",
      re.billingAnchorDay === 23,
    ],
  );
}

// 5) Backdating: period starts at startDate (not now).
{
  const customer = await createCustomer({ ...ctx, email: "back@a.com" });
  const start = new Date("2026-01-01T00:00:00Z");
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    startDate: start,
  });
  const expectedEnd = new Date("2026-02-01T00:00:00Z");
  checks.push(
    [
      "backdated period starts at start_date",
      subscription.currentPeriodStart!.getTime() === start.getTime(),
    ],
    [
      "backdated period ends one interval later",
      subscription.currentPeriodEnd!.getTime() === expectedEnd.getTime(),
    ],
  );
}

// 6) Calendar anchor: first period ends on the anchor date.
{
  const customer = await createCustomer({ ...ctx, email: "anchor@a.com" });
  const now = new Date();
  const anchor = new Date(now.getTime() + 10 * 86_400_000); // 10 days out
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: customer.id,
    now,
    items: [{ price, quantity: 1 }],
    billingAnchor: anchor,
  });
  checks.push([
    "calendar anchor sets first period end",
    subscription.currentPeriodEnd!.getTime() === anchor.getTime(),
  ]);
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ SUBSCRIPTION OPS: PASS" : "❌ SUBSCRIPTION OPS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
