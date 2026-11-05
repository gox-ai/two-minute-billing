/**
 * `free_quantity` is rated: the free units come off the quantity every period, before the
 * pricing model rates the rest. The item's own value wins; else the price's, frozen at attach.
 * Covers the first invoice, renewal, a quantity change, the signup estimate, metered usage,
 * and the stored MRR.
 *
 *   pnpm verify:free-quantity
 */
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, updatePrice } from "@/modules/catalog/service";
import { createSubscription, recomputeSubscriptionMrr } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { estimateNewSubscription } from "@/modules/subscriptions/estimate";
import { recordUsage } from "@/modules/metering/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { closeDb, withTenant } from "@/platform/db";
import { invoiceLineItems } from "@db/schema";
import { and, eq } from "drizzle-orm";

const org = await createOrganization({ name: "Free Quantity Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ctx = { organizationId: orgId, businessId: biz.id };
const plan = await createProduct({ ...ctx, name: "Seats", kind: "plan" });
const recurring = {
  ...ctx,
  productId: plan.id,
  type: "recurring" as const,
  currency: "USD",
  interval: "month" as const,
};
const perUnit = await createPrice({ ...recurring, model: "per_unit", amountMinor: 100 });
const tiered = await createPrice({
  ...recurring,
  model: "tiered",
  tiers: [
    { upToMinor: 5, unitAmountMinor: 100 },
    { upToMinor: null, unitAmountMinor: 80 },
  ],
});
const perUnitWithFree = await createPrice({
  ...recurring,
  model: "per_unit",
  amountMinor: 100,
  freeQuantity: 2,
});

const checks: Array<[string, boolean]> = [];

async function customer(email: string) {
  const c = await createCustomer({ ...ctx, email });
  await vaultPaymentMethod({ ...ctx, customer: c, token: "tok_4242" });
  return c;
}
type Sub = Awaited<ReturnType<typeof createSubscription>>["subscription"];
async function billFull(subscription: Sub, usagePeriod?: { start: Date; end: Date }) {
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: subscription.currentPeriodStart!,
    periodEnd: subscription.currentPeriodEnd!,
    ...(usagePeriod ? { usagePeriod } : {}),
  });
  return Number(invoice.subtotalMinor);
}

// 1) per_unit: 10 seats, 3 free, 100 each → 700 on the first invoice, renewal and MRR.
{
  const cus = await customer("per-unit@example.com");
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: perUnit, quantity: 10, freeQuantity: 3 }],
  });
  const first = await billFull(subscription);
  const renewal = await billFull(subscription);
  const mrr = await withTenant(orgId, (tx) => recomputeSubscriptionMrr(tx, subscription.id));
  console.log(
    `per_unit: first=${first} renewal=${renewal} stored mrr=${subscription.mrr} mrr=${mrr}`,
  );
  checks.push(
    ["per_unit 10 seats, 3 free → 700 (not 1000)", first === 700],
    ["renewal keeps the free units → 700", renewal === 700],
    ["stored MRR at create → 700", subscription.mrr === 700n],
    ["recomputed MRR agrees → 700", mrr === 700n],
  );

  // A quantity change keeps the item's free units: 12 seats → 9 billable → 900.
  await changeSubscription({
    ...ctx,
    subscriptionId: subscription.id,
    now: new Date(),
    changes: [{ itemId: items[0]!.publicId, newQuantity: 12 }],
    invoiceImmediately: true,
  });
  const afterChange = await billFull(subscription);
  console.log(`per_unit after qty 12: ${afterChange}`);
  checks.push(["after a change to 12 seats → 900", afterChange === 900]);
}

// 2) tiered: 10 units, 3 free → 7 billable fill tier 1 first → 5×100 + 2×80 = 660.
{
  const cus = await customer("tiered@example.com");
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: tiered, quantity: 10, freeQuantity: 3 }],
  });
  const first = await billFull(subscription);
  console.log(`tiered: first=${first}`);
  checks.push(["tiered 10 units, 3 free → 660 (not 900)", first === 660]);
}

// 3) The price's free_quantity applies when the item sets none, frozen at attach.
{
  const cus = await customer("price-level@example.com");
  const { subscription } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: perUnitWithFree, quantity: 10 }],
  });
  const first = await billFull(subscription);
  await updatePrice({ ...ctx, pricePublicId: perUnitWithFree.publicId, freeQuantity: 5 });
  const afterEdit = await billFull(subscription);
  console.log(`price-level: first=${first} after price edit=${afterEdit}`);
  checks.push(
    ["price free_quantity 2 applies to an item without one → 800", first === 800],
    ["a later price edit does not reach the live item → 800", afterEdit === 800],
  );

  // An explicit item value of 0 overrides the price's.
  const cus2 = await customer("item-zero@example.com");
  const { subscription: s2 } = await createSubscription({
    ...ctx,
    customerId: cus2.id,
    now: new Date(),
    items: [{ price: perUnitWithFree, quantity: 10, freeQuantity: 0 }],
  });
  const zero = await billFull(s2);
  checks.push(["item free_quantity 0 overrides the price's → 1000", zero === 1000]);
}

// 4) The signup estimate rates the same free units the booking will.
{
  const cus = await customer("estimate@example.com");
  const est = await estimateNewSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: perUnit, quantity: 10, freeQuantity: 3 }],
  });
  console.log(`estimate: subtotal=${est.subtotal_minor}`);
  checks.push(["new-subscription estimate → 700", est.subtotal_minor === 700]);
}

// 5) Metered usage: 100 units, 10 free, 5 each → 450, stated at the 5 rate.
{
  const metered = await createProduct({ ...ctx, name: "API calls", kind: "addon" });
  const usage = await createPrice({
    ...ctx,
    productId: metered.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    amountMinor: 5,
    interval: "month",
    usageAggregation: "sum",
  });
  const cus = await customer("usage@example.com");
  const { subscription, items } = await createSubscription({
    ...ctx,
    customerId: cus.id,
    now: new Date(),
    items: [
      { price: perUnit, quantity: 1 },
      { price: usage, quantity: 1, freeQuantity: 10 },
    ],
  });
  const usageItem = items.find((i) => i.priceId === usage.id)!;
  const start = subscription.currentPeriodStart!;
  const end = subscription.currentPeriodEnd!;
  await recordUsage({
    ...ctx,
    subscriptionItemId: usageItem.id,
    quantity: 100,
    timestamp: new Date(start.getTime() + 1000),
  });
  const { invoice } = await billSubscriptionPeriod({
    ...ctx,
    subscription,
    periodStart: start,
    periodEnd: end,
    usagePeriod: { start, end },
  });
  const [line] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(invoiceLineItems)
      .where(
        and(eq(invoiceLineItems.invoiceId, invoice.id), eq(invoiceLineItems.priceId, usage.id)),
      ),
  );
  console.log(
    `usage: line=${line?.amountMinor} unit=${line?.unitAmountMinor} subtotal=${invoice.subtotalMinor}`,
  );
  checks.push(
    ["usage 100 units, 10 free, 5 each → 450", line?.amountMinor === 450n],
    ["usage line states the 5 rate", line?.unitAmountMinor === 5n],
  );
}

let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ FREE QUANTITY: PASS" : "❌ FREE QUANTITY: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
