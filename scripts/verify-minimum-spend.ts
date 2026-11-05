/**
 * Minimum spend per price (`minimum_amount_minor`), end to end:
 *  - API: set, read back, clear; refused on a one-time price (create and update);
 *  - period billing adds a "Minimum spend adjustment" line for the shortfall — metered
 *    usage below the minimum, no usage at all, a fixed line below it — and nothing when
 *    the line reaches the minimum or the price has no minimum;
 *  - a partial window is billed a prorated minimum.
 *
 *   pnpm verify:minimum-spend
 */
import { desc, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, CatalogError } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addInterval } from "@/modules/subscriptions/interval";
import { recordUsage } from "@/modules/metering/service";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import { runWithClockScope } from "@/platform/clock";
import { subscriptions, invoices, invoiceLineItems } from "@db/schema";

const fails: string[] = [];
const check = (name: string, cond: boolean) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}`);
  if (!cond) fails.push(name);
};

const org = await createOrganization({ name: "Minimum Spend Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const ids = { organizationId: orgId, businessId: biz.id };

// ── 1. API ──────────────────────────────────────────────────────────────────────
console.log("1. API");
const app = await buildApp({ logger: false });
let n = 0;
async function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: {
      authorization: `Bearer ${org.secret}`,
      "idempotency-key": `min-${Date.now()}-${n++}`,
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
await call("POST", "/products", { id: "api-plan", name: "API plan", kind: "plan" });
const made = await call("POST", "/prices", {
  product: "api-plan",
  id: "api-usage",
  model: "usage",
  currency: "USD",
  amount_minor: 10,
  interval: "month",
  minimum_amount_minor: 3000,
});
check("create stores and returns minimum_amount_minor", made.body.minimum_amount_minor === 3000);
const noMin = await call("POST", "/prices", {
  product: "api-plan",
  id: "api-flat",
  model: "flat",
  currency: "USD",
  amount_minor: 100,
  interval: "month",
});
check(
  "a price without one reads null",
  noMin.status === 201 && noMin.body.minimum_amount_minor === null,
);
const cleared = await call("PATCH", "/prices/api-usage", { minimum_amount_minor: null });
check("PATCH null clears it", cleared.status === 200 && cleared.body.minimum_amount_minor === null);
const oneTime = await call("POST", "/prices", {
  product: "api-plan",
  id: "api-once",
  model: "flat",
  type: "one_time",
  currency: "USD",
  amount_minor: 100,
  minimum_amount_minor: 50,
});
check(
  "a one-time price with a minimum → 400 on minimum_amount_minor",
  oneTime.status === 400 && !!oneTime.body.error?.details?.minimum_amount_minor,
);
await call("POST", "/prices", {
  product: "api-plan",
  id: "api-once-ok",
  model: "flat",
  type: "one_time",
  currency: "USD",
  amount_minor: 100,
});
const onePatch = await call("PATCH", "/prices/api-once-ok", { minimum_amount_minor: 50 });
check("PATCH a minimum onto a one-time price → 400", onePatch.status === 400);
await app.close();

// ── 2. Period billing ───────────────────────────────────────────────────────────
console.log("2. period billing");
const customer = await createCustomer({ ...ids, email: "min@example.com" });
await vaultPaymentMethod({ ...ids, customer, token: "tok_4242" });
const product = await createProduct({ ...ids, name: "Metered" });
const usagePrice = (minimumAmountMinor?: number) =>
  createPrice({
    ...ids,
    productId: product.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    amountMinor: 10, // $0.10 per unit
    usageAggregation: "sum",
    minimumAmountMinor,
  });

const T = Date.now();
const pEnd = new Date(T - 3600_000);
const monthStart = addInterval(pEnd, "month", -1);

/** Subscribe, put the term on [start, pEnd), record `units`, renew, return the last invoice. */
async function bill(
  price: Awaited<ReturnType<typeof usagePrice>>,
  units: number,
  start: Date,
  qty = 1,
) {
  const sub = await createSubscription({
    ...ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: qty }],
  });
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodStart: start, currentPeriodEnd: pEnd })
    .where(eq(subscriptions.id, sub.subscription.id));
  if (units > 0)
    await recordUsage({
      ...ids,
      subscriptionItemId: sub.items[0]!.id,
      quantity: units,
      timestamp: new Date(pEnd.getTime() - 60_000),
    });
  await runWithClockScope({ onlyBusinessId: biz.id }, () => runBillingClockTick(new Date()));
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.subscriptionId, sub.subscription.id))
      .orderBy(desc(invoices.createdAt))
      .limit(1);
    const lines = inv
      ? await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, inv.id))
      : [];
    return { inv, lines };
  });
}
const trueUpOf = <L extends { description: string }>(lines: L[]) =>
  lines.find((l) => l.description.startsWith("Minimum spend adjustment"));

const withMin = await usagePrice(3000);
const a = await bill(withMin, 50, monthStart); // 500 used
check(
  "usage 500 below a 3000 minimum → true-up 2500, invoice 3000",
  Number(trueUpOf(a.lines)?.amountMinor) === 2500 && Number(a.inv?.totalMinor) === 3000,
);
check(
  "the true-up line names the price and carries its period",
  !!trueUpOf(a.lines)?.description.includes("Metered") &&
    trueUpOf(a.lines)?.periodStart?.getTime() === monthStart.getTime(),
);
const b = await bill(withMin, 0, monthStart);
check(
  "no usage → a true-up of the whole minimum",
  b.lines.length === 1 && Number(trueUpOf(b.lines)?.amountMinor) === 3000,
);
const c = await bill(withMin, 400, monthStart); // 4000 used
check(
  "usage above the minimum → no true-up",
  !trueUpOf(c.lines) && Number(c.inv?.totalMinor) === 4000,
);

// A 10-day window of a monthly price: minimum × 10 days ÷ the month from the window start.
const tenDays = new Date(pEnd.getTime() - 10 * 86_400_000);
const full = addInterval(tenDays, "month", 1).getTime() - tenDays.getTime();
const expected = Math.floor((3000 * 10 * 86_400_000 + Math.floor(full / 2)) / full);
const d = await bill(withMin, 0, tenDays);
console.log(`   partial window: true-up ${trueUpOf(d.lines)?.amountMinor} (expect ${expected})`);
check(
  "a partial window bills a prorated minimum",
  Number(trueUpOf(d.lines)?.amountMinor) === expected,
);

const without = await usagePrice();
const e = await bill(without, 0, monthStart);
check("no minimum, no usage → nothing billed", e.lines.length === 0);

// A fixed line: 3 seats × 100 = 300 against a 1000 minimum, billed in advance for a full period.
const seats = await createPrice({
  ...ids,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  interval: "month",
  amountMinor: 100,
  minimumAmountMinor: 1000,
});
const f = await bill(seats, 0, monthStart, 3);
check(
  "a fixed line of 300 under a 1000 minimum → true-up 700",
  Number(trueUpOf(f.lines)?.amountMinor) === 700 &&
    trueUpOf(f.lines)?.kind === "recurring" &&
    Number(f.inv?.totalMinor) === 1000,
);

let refused = false;
try {
  await createPrice({
    ...ids,
    productId: product.id,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 100,
    minimumAmountMinor: 50,
  });
} catch (err) {
  refused = err instanceof CatalogError;
}
check("the service refuses a minimum on a one-time price", refused);

console.log("");
console.log(
  fails.length === 0 ? "✅ MINIMUM SPEND: PASS" : `❌ MINIMUM SPEND: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
