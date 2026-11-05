/**
 * Proves usage-based metering: record usage, then at renewal the invoice bills
 * usage in ARREARS for the just-closed period (aggregated + rated) alongside the
 * fixed recurring charge billed in advance. Also checks sum/max/last aggregation.
 *
 *   pnpm verify:usage
 */
import { eq, desc } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { recordUsage, aggregateUsage } from "@/modules/metering/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { subscriptions, invoices, invoiceLineItems } from "@db/schema";
import { loadGeoReference } from "@/platform/geo";

await loadGeoReference();

const org = await createOrganization({ name: "Usage Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "u@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "API" });

// $10/mo base (advance) + $0.05/call metered (arrears, summed).
const flat = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const metered = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  amountMinor: 5,
  interval: "month",
  usageAggregation: "sum",
});

const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [
    { price: flat, quantity: 1 },
    { price: metered, quantity: 1 },
  ],
});
const usageItem = sub.items.find((i) => i.priceId === metered.id)!;

// Force a CLOSED past period [T-2h, T-1h] so renewal bills usage in arrears.
const T = Date.now();
const pStart = new Date(T - 2 * 3600_000);
const pEnd = new Date(T - 1 * 3600_000);
await systemDb
  .update(subscriptions)
  .set({ currentPeriodStart: pStart, currentPeriodEnd: pEnd })
  .where(eq(subscriptions.id, sub.subscription.id));

// Record 100 units of usage inside the closed window (40 + 35 + 25).
const ts = new Date(T - 90 * 60_000); // T-90min, within [T-2h, T-1h)
for (const q of [40, 35, 25]) {
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: usageItem.id,
    quantity: q,
    timestamp: ts,
  });
}

// Aggregation-mode checks over the window.
const sumQ = await aggregateUsage(orgId, usageItem.id, pStart, pEnd, "sum");
const maxQ = await aggregateUsage(orgId, usageItem.id, pStart, pEnd, "max");
const lastQ = await aggregateUsage(orgId, usageItem.id, pStart, pEnd, "last");
console.log(`aggregation: sum=${sumQ} max=${maxQ} last=${lastQ} (expect 100, 40, 25)`);

// Renew: bills usage(arrears, 100*5=500) + flat(advance, 1000) = 1500.
await runBillingClockTick(new Date());

const inv = await withTenant(orgId, async (tx) => {
  const [i] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, sub.subscription.id))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  if (!i) return null;
  const lines = await tx
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, i.id));
  return { i, lines };
});

if (!inv) {
  console.log("❌ no invoice generated");
  await closeDb();
  process.exit(1);
}
const usageLine = inv.lines.find((l) => l.kind === "usage");
const flatLine = inv.lines.find((l) => l.kind === "recurring");
console.log(`invoice total=${inv.i.totalMinor} status=${inv.i.status}`);
for (const l of inv.lines)
  console.log(`  line: ${l.kind} qty=${l.quantity} amount=${l.amountMinor} — ${l.description}`);

const pass =
  sumQ === 100n &&
  maxQ === 40n &&
  lastQ === 25n &&
  !!usageLine &&
  Number(usageLine.amountMinor) === 500 &&
  usageLine.quantity === 100 &&
  !!flatLine &&
  Number(flatLine.amountMinor) === 1000 &&
  Number(inv.i.totalMinor) === 1500 &&
  inv.i.status === "paid";

console.log("");
console.log(pass ? "✅ USAGE METERING: PASS" : "❌ USAGE METERING: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
