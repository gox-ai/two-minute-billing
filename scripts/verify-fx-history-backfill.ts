/**
 * The exchange-rate history backfill (`backfillExchangeRateHistory`).
 *
 * Fed fixed published days rather than the network: the cross-rate, which days land, and that
 * nothing on or after a real observation is touched are the claims, and a live feed would make
 * every one of them depend on the day it ran.
 *
 *   pnpm verify:fx-history-backfill
 */
import { and, asc, eq } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness, updateBusiness } from "@/modules/tenancy/service";
import { businesses, exchangeRateHistory } from "@db/schema";
import { backfillExchangeRateHistory, loadRateTimeline } from "@/platform/fx/history";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { mrrMovements, subscriptions } from "@db/schema";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { bulkFillMetricDays } from "@/modules/metrics/daily/bulk-fill";
import { resolveAnalytics, resolveScope } from "@/modules/metrics/daily/public-query";
import { computeBusinessAnalytics } from "@/modules/metrics/analytics";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "FX Backfill Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "FX Backfill Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
// Today's rates, observed now — the first REAL observation the backfill must stop at.
await updateBusiness(orgId, biz.publicId, { exchangeRates: { INR: 94, EUR: 0.9 } });
await systemDb
  .update(businesses)
  .set({ exchangeRateSources: { INR: { source: "auto" }, EUR: { source: "manual" } } })
  .where(eq(businesses.id, biz.id));

// Real ECB figures (per 1 EUR), plus a repeat day and one dated after the real observation.
const day = (d: string, inr: number, usd: number) => ({
  day: d,
  perEur: new Map([
    ["EUR", 1],
    ["INR", inr],
    ["USD", usd],
  ]),
});
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const days = [
  day("2021-10-06", 86.438, 1.1542),
  day("2021-10-04", 86.4025, 1.1636),
  day("2021-10-05", 86.488, 1.1602),
  day("2021-10-07", 86.408, 1.1562),
  day("2021-10-08", 86.7495, 1.1569),
  day("2021-10-11", 86.7495, 1.1569),
  day(tomorrow, 90, 1),
];

const run = () =>
  withTenant(orgId, (tx) =>
    backfillExchangeRateHistory(tx, { organizationId: orgId, businessId: biz.id, days }),
  );
const first = await run();
const inr = first.find((r) => r.currency === "INR");
console.log("backfill:", JSON.stringify(first));

const rows = await systemDb
  .select({
    currency: exchangeRateHistory.currency,
    rate: exchangeRateHistory.rate,
    at: exchangeRateHistory.effectiveFrom,
  })
  .from(exchangeRateHistory)
  .where(and(eq(exchangeRateHistory.businessId, biz.id), eq(exchangeRateHistory.currency, "INR")))
  .orderBy(asc(exchangeRateHistory.effectiveFrom));

ok("backfill: five published days, the repeat and the future day skipped", inr?.appended === 5);
ok(
  "backfill: a hand-entered currency gets no invented history",
  !first.some((r) => r.currency === "EUR"),
);
ok(
  "backfill: the cross-rate is quote/EUR over base/EUR (86.4025 / 1.1636)",
  Math.abs(Number(rows[0]?.rate) - 74.2544688897) < 1e-9,
);
ok(
  "backfill: each day is effective when the refresh runs, 16:30 UTC",
  rows[0]?.at.toISOString() === "2021-10-04T16:30:00.000Z",
);
ok(
  "backfill: nothing lands on or after the first real observation",
  rows.filter((r) => r.at > new Date("2022-01-01")).length === 1 &&
    Number(rows[rows.length - 1]?.rate) === 94,
);

const t = await withTenant(orgId, (tx) => loadRateTimeline(tx, biz.id));
ok(
  "timeline: a past instant reads the rate published that day",
  Math.abs(Number(t.rateAt("INR", new Date("2021-10-06T18:29:59Z"))) - 74.8899670768) < 1e-9,
);
ok(
  "timeline: …the morning before a publication reads the day before",
  Math.abs(Number(t.rateAt("INR", new Date("2021-10-06T09:00:00Z"))) - 86.488 / 1.1602) < 1e-9,
);
ok("timeline: today still reads today's rate", Number(t.rateAt("INR", new Date())) === 94);
ok(
  "timeline: before any observation it still falls back to the current rate",
  Number(t.rateAt("INR", new Date("2020-01-01"))) === 94,
);

const again = await run();
ok(
  "backfill: a rerun appends nothing",
  again.every((r) => r.appended === 0),
);

// ── The readers: a past figure converts at the rate held then ─────────────────────────
// An INR book on a USD business, sold 2021-10-05 at 9,000 and expanded +1,000 on 10-07.
// Today's rate is 94; October 2021's were ~74.5–74.9, so the two answers are far apart.
{
  const hb = await createBusiness({
    organizationId: orgId,
    name: "FX History Readers",
    defaultCurrency: "USD",
    timezone: "UTC",
    livemode: "test",
  });
  await updateBusiness(orgId, hb.publicId, { exchangeRates: { INR: 94 } });
  await systemDb
    .update(businesses)
    .set({ exchangeRateSources: { INR: { source: "auto" } } })
    .where(eq(businesses.id, hb.id));
  const product = await createProduct({ organizationId: orgId, businessId: hb.id, name: "Plan" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: hb.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: 9000,
    interval: "month",
  });
  // A USD line beside it: with one currency in the window the API answers in that currency,
  // so the INR book is converted only when the answer spans two.
  const usdPrice = await createPrice({
    organizationId: orgId,
    businessId: hb.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const cu = await createCustomer({
    organizationId: orgId,
    businessId: hb.id,
    email: `fx-readers-usd-${Date.now()}@example.test`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: hb.id,
    customer: cu,
    token: "tok_4242",
  });
  const { subscription: usdSub } = await createSubscription({
    organizationId: orgId,
    businessId: hb.id,
    customerId: cu.id,
    now: new Date("2021-10-05T10:00:00Z"),
    items: [{ price: usdPrice, quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000) })
    .where(eq(subscriptions.id, usdSub.id));
  const c = await createCustomer({
    organizationId: orgId,
    businessId: hb.id,
    email: `fx-readers-${Date.now()}@example.test`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: hb.id,
    customer: c,
    token: "tok_4242",
  });
  const { subscription: sub } = await createSubscription({
    organizationId: orgId,
    businessId: hb.id,
    customerId: c.id,
    now: new Date("2021-10-05T10:00:00Z"),
    items: [{ price, quantity: 1 }],
  });
  // Park the term so a live worker never renews a subscription dated years back.
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: new Date(Date.now() + 365 * 86_400_000), mrr: 10000n })
    .where(eq(subscriptions.id, sub.id));
  await systemDb.insert(mrrMovements).values({
    organizationId: orgId,
    businessId: hb.id,
    subscriptionId: sub.id,
    customerId: c.id,
    reason: "expansion",
    planProductId: product.id,
    previousPlanProductId: product.id,
    currency: "INR",
    previousMrrMinor: 9000n,
    newMrrMinor: 10000n,
    deltaMinor: 1000n,
    occurredAt: new Date("2021-10-07T12:00:00Z"),
  });
  await withTenant(orgId, (tx) =>
    backfillExchangeRateHistory(tx, { organizationId: orgId, businessId: hb.id, days }),
  );

  const inrPerUsd = {
    "10-05": 86.488 / 1.1602,
    "10-06": 86.438 / 1.1542,
    "10-07": 86.408 / 1.1562,
  };
  const usd = (minor: number, rate: number) => Math.round(minor / rate);

  const report = async (key: string, now: Date) =>
    (await resolveReport(orgId, hb.id, key, { now })).headline;
  const past = await report("total_mrr", new Date("2021-10-06T23:59:59.999Z"));
  const today = await report("total_mrr", new Date());
  console.log("readers: report", JSON.stringify({ past, today }));
  ok(
    "report: a past day's MRR converts at that day's rate, not today's",
    past === 5000 + usd(9000, inrPerUsd["10-06"]),
  );
  ok("report: today's MRR still converts at today's rate", today === 5000 + usd(10000, 94));

  await bulkFillMetricDays({
    organizationId: orgId,
    businessId: hb.id,
    grain: "day",
    days: ["2021-10-05", "2021-10-06", "2021-10-07"],
    write: true,
    timezone: "UTC",
  });
  // Asked again now that the day is STORED: the report reads it through the stored-stock
  // reader instead of rebuilding it, and must convert it at the same rate.
  ok(
    "report: a stored day converts at that day's rate too",
    (await report("total_mrr", new Date("2021-10-06T23:59:59.999Z"))) === past,
  );
  const scope = await resolveScope(orgId, {
    id: hb.id,
    publicId: hb.publicId,
    name: "FX History Readers",
    timezone: "UTC",
  });
  const series = async (measure: string) =>
    (
      await resolveAnalytics(
        scope,
        { measure, grain: "day", start: "2021-10-05", end: "2021-10-07" },
        new Date("2021-10-08T00:00:00Z"),
      )
    ).series.map((p) => p.value);
  const mrr = await series("mrr");
  const fresh = await series("mrr_new");
  console.log("readers: api", JSON.stringify({ mrr, fresh }));
  ok(
    "api: each stored day converts at its own rate",
    JSON.stringify(mrr) ===
      JSON.stringify([
        5000 + usd(9000, inrPerUsd["10-05"]),
        5000 + usd(9000, inrPerUsd["10-06"]),
        5000 + usd(10000, inrPerUsd["10-07"]),
      ]),
  );
  ok(
    "api: a flow converts at the rate of its day",
    fresh[0] === 5000 + usd(9000, inrPerUsd["10-05"]),
  );
  ok("api: …and agrees with the report for that day", mrr[1] === past);

  const home = await computeBusinessAnalytics(orgId, hb.id, {
    range: "daily",
    now: new Date("2021-10-06T23:59:59.999Z"),
  });
  console.log("readers: home", home.kpis.mrr.value);
  ok(
    "business home: a past day's MRR is the stored metric_daily day, at that day's rate",
    home.kpis.mrr.value === past,
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
