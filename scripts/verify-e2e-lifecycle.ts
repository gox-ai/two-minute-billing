/**
 * End-to-end SaaS lifecycle through the PUBLIC API (in-process server) — the
 * "can I migrate onto this?" smoke test. Drives the journey a real app would,
 * asserting money + state at each step:
 *
 *   org → API key → business → product → prices (flat + usage)
 *   → customer → vault card → subscribe (trial) → record usage
 *   → renew (trial→active, bills flat + usage) → metrics reflect it
 *
 *   pnpm verify:e2e
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { createOrganization } from "@/modules/tenancy/service";
import { getSubscriptionItems } from "@/modules/subscriptions/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { Tmbilling } from "../sdk/index";
import { subscriptions } from "@db/schema";

const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const port = (app.server.address() as { port: number }).port;
const org = await createOrganization({ name: "E2E Migrate Co" });
const orgId = org.organization.id;
const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: `http://127.0.0.1:${port}` });

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

// 1) Catalog via SDK
const biz = await tmb.businesses.create({
  name: "Acme SaaS",
  default_currency: "USD",
  livemode: "test",
});
ok("business created", biz.id.startsWith("biz_"));
const product = await tmb.products.create(biz.id, { name: "Pro Plan" });
const flat = await tmb.prices.create(biz.id, {
  product: product.id,
  model: "flat",
  currency: "USD",
  amount_minor: 5000,
  interval: "month",
});
const usage = await tmb.prices.create(biz.id, {
  product: product.id,
  model: "usage",
  currency: "USD",
  amount_minor: 10,
  interval: "month",
  usage_aggregation: "sum",
});
ok("flat + usage prices created", !!flat.id && !!usage.id);

// 2) Customer + vaulted card
const customer = await tmb.customers.create(biz.id, {
  email: "jane@acme.test",
  first_name: "Jane",
});
const pm = await tmb.paymentMethods.create(biz.id, customer.id, { token: "tok_4242" });
ok("card vaulted (4242)", pm.last4 === "4242");

// 3) Subscribe with a 14-day trial (flat + usage)
const sub = await tmb.subscriptions.create(biz.id, customer.id, {
  items: [{ price: flat.id }, { price: usage.id }],
  trial_days: 14,
});
ok("subscription trialing", sub.status === "in_trial");

// 4) Resolve the usage item id directly.
const subRow = (
  await systemDb.select().from(subscriptions).where(eq(subscriptions.publicId, sub.id)).limit(1)
)[0]!;
const subItems = await getSubscriptionItems(orgId, subRow.id);
const { prices } = await import("@db/schema");
// Scope by business: post-CAT-0 a price's public_id is a per-business slug, no
// longer globally unique, so an unscoped lookup can hit another business's price.
const usagePriceRow = (
  await systemDb
    .select()
    .from(prices)
    .where(and(eq(prices.publicId, usage.id), eq(prices.businessId, subRow.businessId)))
    .limit(1)
)[0]!;
const usageItem = subItems.find((i) => i.priceId === usagePriceRow.id)!;

// 5) Put the (trial) period into a clean CLOSED window in the recent past, record
//    300 usage units inside it, then renew — usage bills in arrears for that window.
const periodStart = new Date(Date.now() - 2 * 3600_000);
const periodEnd = new Date(Date.now() - 3600_000);
await systemDb
  .update(subscriptions)
  .set({ currentPeriodStart: periodStart, currentPeriodEnd: periodEnd })
  .where(eq(subscriptions.publicId, sub.id));
await tmb.subscriptions.recordUsage(biz.id, sub.id, {
  item: usageItem.publicId,
  quantity: 300,
  timestamp: new Date(Date.now() - 90 * 60_000).toISOString(),
});
ok("usage recorded (300 units, in-period)", true);

await runBillingClockTick(new Date());
const active = (await tmb.subscriptions.list(biz.id)).data.find((s) => s.id === sub.id);
ok("trial → active after renewal", active?.status === "active");
const paid = (await tmb.invoices.list(biz.id)).data.filter((i) => i.status === "paid");
ok("renewal invoice paid", paid.length >= 1);
ok(
  "billed flat $50 + usage $30 = $80",
  paid.some((i) => i.total_minor === 8000),
);

// 6) Metrics: MRR = flat $50 (usage excluded)
const m = (await (
  await fetch(`http://127.0.0.1:${port}/v1/businesses/${biz.id}/metrics`, {
    headers: { Authorization: `Bearer ${org.secret}` },
  })
).json()) as { currencies: Array<{ currency: string; mrr_minor: number }> };
ok(
  "MRR = $50 (usage excluded)",
  m.currencies.find((c) => c.currency === "USD")?.mrr_minor === 5000,
);

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ E2E LIFECYCLE: PASS" : "❌ E2E LIFECYCLE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
