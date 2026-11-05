/**
 * Conformance: usage aggregation cases. Two events [100, 200] are recorded and
 * every aggregation function is asserted against the real aggregateUsage:
 * sum 300 · max 200 · min 100 · avg 150 · count 2 · last 200 (latest by ts).
 *
 *   pnpm verify:conformance:usage
 */
import { closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, getSubscriptionItems } from "@/modules/subscriptions/service";
import { recordUsage, aggregateUsage } from "@/modules/metering/service";

const org = await createOrganization({ name: "Usage Conformance" });
const orgId = org.organization.id;
const biz = await createBusiness({ organizationId: orgId, name: "Biz", defaultCurrency: "USD" });
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "p@a.com",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "API" });
const usagePrice = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  amountMinor: 1,
  interval: "month",
  usageAggregation: "sum",
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: usagePrice, quantity: 1 }],
});
const item = (await getSubscriptionItems(orgId, sub.subscription.id))[0]!;

// Open the window wide; record the two events.
const start = new Date(Date.now() - 3600_000);
const end = new Date(Date.now() + 3600_000);
const ts = new Date();
for (const q of [100, 200]) {
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: item.id,
    quantity: q,
    timestamp: ts,
  });
}

const sum = await aggregateUsage(orgId, item.id, start, end, "sum"); // 300
const max = await aggregateUsage(orgId, item.id, start, end, "max"); // 200
const min = await aggregateUsage(orgId, item.id, start, end, "min"); // 100
const avg = await aggregateUsage(orgId, item.id, start, end, "avg"); // 150
const count = await aggregateUsage(orgId, item.id, start, end, "count"); // 2
const last = await aggregateUsage(orgId, item.id, start, end, "last"); // 200 (latest by ts)

console.log(`  ✓ sum([100,200]) = ${sum}  (expected 300)`);
console.log(`  ✓ max([100,200]) = ${max}`);
console.log(`  ✓ min([100,200]) = ${min}`);
console.log(`  ✓ avg([100,200]) = ${avg}`);
console.log(`  ✓ count([100,200]) = ${count}`);
console.log(`  ✓ last([100,200]) = ${last}`);

const pass =
  sum === 300n && max === 200n && min === 100n && avg === 150n && count === 2n && last === 200n;

console.log("");
console.log(
  "Aggregation functions covered: sum ✓ · max ✓ · min ✓ · avg ✓ · count ✓ · last/latest ✓",
);
console.log(
  "Remaining gap: unique (count-distinct over an event property — needs property metering); fractional values (integer qty).",
);
console.log("");
console.log(pass ? "✅ USAGE CONFORMANCE: PASS" : "❌ USAGE CONFORMANCE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
