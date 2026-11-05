/**
 * Proves the `percentage` charge model end-to-end, both shapes:
 *  - metered: "2.9% of summed transaction volume" — usage events carry the
 *    transaction amount (minor units); summed in arrears, then a % is taken.
 *  - fixed:   "1.5% of a fixed base" — billed on item.quantity in advance.
 *
 *   pnpm verify:percentage
 */
import { eq, desc } from "drizzle-orm";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { recordUsage } from "@/modules/metering/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { runWithClockScope } from "@/platform/clock";
import { subscriptions, invoices, invoiceLineItems } from "@db/schema";

const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fails.push(name);
};

const org = await createOrganization({ name: "Percentage Org" });
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
  email: "p@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
});
const product = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Payments",
});

// --- Metered percentage: 2.9% of summed transaction volume, arrears ---
const pctMetered = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "percentage",
  currency: "USD",
  interval: "month",
  percentageBps: 290,
  usageAggregation: "sum",
});
const sub = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: pctMetered, quantity: 1 }],
});
const item = sub.items.find((i) => i.priceId === pctMetered.id)!;

// Only this business: an unscoped tick also renews other suites' leftovers in a shard's
// database, and one of those can fail or use up the tick's scan budget before ours.
const tick = () =>
  runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));

const T = Date.now();
const pStart = new Date(T - 2 * 3600_000);
const pEnd = new Date(T - 1 * 3600_000);
await systemDb
  .update(subscriptions)
  .set({ currentPeriodStart: pStart, currentPeriodEnd: pEnd })
  .where(eq(subscriptions.id, sub.subscription.id));

const ts = new Date(T - 90 * 60_000);
// Three transactions: $100.00, $250.00, $49.99 → total 39999 minor. 2.9% = 1159.971 → 1160.
for (const amt of [10000, 25000, 4999]) {
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: item.id,
    quantity: amt,
    timestamp: ts,
  });
}
await tick();

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
  console.log("❌ no metered invoice");
  await closeDb();
  process.exit(1);
}
const pctLine = inv.lines.find((l) => l.kind === "usage");
console.log(`metered: base=39999 line=${pctLine?.amountMinor} (expect 1160 = 2.9% half-up)`);
check(
  "metered percentage rated 2.9% of 39999 → 1160",
  !!pctLine && Number(pctLine.amountMinor) === 1160,
);
check(
  "metered percentage invoice paid",
  inv.i.status === "paid" && Number(inv.i.totalMinor) === 1160,
);

// --- Fixed percentage: 1.5% of a fixed base passed as quantity, advance ---
const pctFixed = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "percentage",
  currency: "USD",
  interval: "month",
  percentageBps: 150,
});
const sub2 = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(),
  items: [{ price: pctFixed, quantity: 20000 }], // 1.5% of $200.00 = $3.00
});
// Close sub2's period so the billing clock bills it (fixed charges bill in advance).
await systemDb
  .update(subscriptions)
  .set({ currentPeriodStart: pStart, currentPeriodEnd: pEnd })
  .where(eq(subscriptions.id, sub2.subscription.id));
await tick();
const inv2 = await withTenant(orgId, async (tx) => {
  const [i] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.subscriptionId, sub2.subscription.id))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  return i ?? null;
});
console.log(`fixed: 1.5% of 20000 → ${inv2?.totalMinor} (expect 300)`);
check("fixed percentage billed in advance → 300", !!inv2 && Number(inv2.totalMinor) === 300);

console.log("");
console.log(
  fails.length === 0
    ? "✅ PERCENTAGE MODEL: PASS"
    : `❌ PERCENTAGE MODEL: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
