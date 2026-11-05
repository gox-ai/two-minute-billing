/**
 * Proves the `unique` usage-aggregation mode (count of DISTINCT unique_key values
 * in the window) — e.g. per-active-user billing. Records duplicate keys and
 * confirms only distinct users are counted, then rated through an invoice.
 *
 *   pnpm verify:usage-unique
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

const org = await createOrganization({ name: "Unique Usage Org" });
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
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Seats" });

// $2.00 per distinct active user per month, metered in arrears.
const metered = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  amountMinor: 200,
  interval: "month",
  usageAggregation: "unique",
});

const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: metered, quantity: 1 }],
});
const usageItem = sub.items.find((i) => i.priceId === metered.id)!;

// Closed past window [T-2h, T-1h).
const T = Date.now();
const pStart = new Date(T - 2 * 3600_000);
const pEnd = new Date(T - 1 * 3600_000);
await systemDb
  .update(subscriptions)
  .set({ currentPeriodStart: pStart, currentPeriodEnd: pEnd })
  .where(eq(subscriptions.id, sub.subscription.id));

const ts = new Date(T - 90 * 60_000);
// 5 events but only 3 DISTINCT users (alice twice, bob twice, carol once).
for (const key of ["alice", "bob", "alice", "carol", "bob"]) {
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: usageItem.id,
    quantity: 1,
    uniqueKey: key,
    timestamp: ts,
  });
}

const uniqueQ = await aggregateUsage(orgId, usageItem.id, pStart, pEnd, "unique");
const countQ = await aggregateUsage(orgId, usageItem.id, pStart, pEnd, "count");
console.log(`unique=${uniqueQ} (expect 3 distinct), count=${countQ} (expect 5 events)`);

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
console.log(`invoice total=${inv.i.totalMinor} status=${inv.i.status}`);
for (const l of inv.lines)
  console.log(`  line: ${l.kind} qty=${l.quantity} amount=${l.amountMinor} — ${l.description}`);

// 3 distinct users × $2.00 = $6.00 (600 minor).
const pass =
  uniqueQ === 3n &&
  countQ === 5n &&
  !!usageLine &&
  usageLine.quantity === 3 &&
  Number(usageLine.amountMinor) === 600 &&
  Number(inv.i.totalMinor) === 600 &&
  inv.i.status === "paid";

console.log("");
console.log(pass ? "✅ USAGE UNIQUE AGGREGATION: PASS" : "❌ USAGE UNIQUE AGGREGATION: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
