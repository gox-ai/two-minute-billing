/**
 * verify:metric-windows — a distinct count or cohort rate over a window that is not a calendar
 * period is answered for exactly that window: from the stored rolling windows for a preset,
 * computed on demand for a custom range, and never as a sum of buckets.
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import {
  resolveScope,
  resolveAnalytics,
  businessesByPublicIds,
} from "@/modules/metrics/daily/public-query";
import {
  refreshRollingWindows,
  ROLLING_WINDOWS,
  clearOnDemandWindows,
} from "@/modules/metrics/daily/windows";
import { restateTrailingDays } from "@/modules/metrics/daily/maintenance";
import { customers, metricWindows } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, cond ? "" : JSON.stringify(detail ?? ""));
}

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const org = await createOrganization({ name: "Metric Windows Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
});
// Three customers who started paying 60, 20 and 5 days ago: "new" in a 30-day window is two.
for (const back of [60, 20, 5]) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `w${back}@a.com`,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(customers)
      .set({ createdAt: daysAgo(back) })
      .where(eq(customers.id, c.id)),
  );
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: daysAgo(back),
    items: [{ price, quantity: 1 }],
  });
}
await restateTrailingDays(now, { businessIds: [biz.id] });

const [b] = await businessesByPublicIds(orgId, [biz.publicId]);
const scope = await resolveScope(orgId, b!, "all");
const ask = (q: Record<string, unknown>) => resolveAnalytics(scope, q as never, now);

// ── 1. the stored rolling windows ──────────────────────────────────────────────────────
const res = await refreshRollingWindows(now, { businessIds: [biz.id] });
ok("the hourly refresh ran without a business failing", res.failed === 0, res);
const names = await withTenant(orgId, (tx) =>
  tx
    .selectDistinct({ w: metricWindows.windowName })
    .from(metricWindows)
    .where(eq(metricWindows.businessId, biz.id)),
);
ok(
  `it stores all ${ROLLING_WINDOWS.length} rolling windows`,
  names.length === ROLLING_WINDOWS.length,
  names,
);

// ── 2. a preset reads its window, not a sum of buckets ─────────────────────────────────
const thirty = await ask({ measure: "customers_new", range: "30d", grain: "month" });
ok(
  "a distinct count over the last 30 days is a window total",
  thirty.total_basis === "window",
  thirty.total_basis,
);
ok("…of the two customers who started inside it", thirty.total === 2, thirty.total);
const ninety = await ask({ measure: "customers_new", range: "90d", grain: "month" });
ok("…and three over 90 days", ninety.total === 3, ninety.total);
const grr = await ask({ measure: "gross_revenue_retention", range: "30d", grain: "month" });
ok(
  "a cohort rate over the window publishes the base it divided by",
  grr.total_basis === "window" && grr.total_denominator != null && grr.total_denominator > 0,
  { basis: grr.total_basis, den: grr.total_denominator },
);

// ── 3. custom ranges are computed on demand, and equal the stored answer ───────────────
const same = await ask({
  measure: "customers_new",
  start: thirty.range.start,
  end: thirty.range.end,
  grain: "month",
});
ok("the same dates as a custom range give the same answer", same.total === thirty.total, {
  same: same.total,
  preset: thirty.total,
});
clearOnDemandWindows();
const start = new Date(daysAgo(10)).toISOString().slice(0, 10);
const end = new Date(daysAgo(1)).toISOString().slice(0, 10);
const before = (await withTenant(orgId, (tx) =>
  tx.execute(sql`select count(*)::int n from metric_windows where business_id = ${biz.id}`),
)) as unknown as Array<{ n: number }>;
const t0 = Date.now();
const custom = await ask({ measure: "customers_new", start, end, grain: "day" });
const cold = Date.now() - t0;
ok(
  "a custom range with no stored window is computed: one customer started in it",
  custom.total === 1 && custom.total_basis === "window",
  custom.total,
);
const after = (await withTenant(orgId, (tx) =>
  tx.execute(sql`select count(*)::int n from metric_windows where business_id = ${biz.id}`),
)) as unknown as Array<{ n: number }>;
ok("…without writing a stored window", before[0]!.n === after[0]!.n);
const t1 = Date.now();
await ask({ measure: "customers_new", start, end, grain: "day" });
ok("…and a repeat is served from the cache", Date.now() - t1 <= cold, {
  cold,
  warm: Date.now() - t1,
});

// ── 4. calendar presets are untouched ──────────────────────────────────────────────────
const month = await ask({ measure: "customers_new", range: "this_month", grain: "month" });
ok(
  "a calendar preset still reads its stored bucket",
  month.total_basis !== "window",
  month.total_basis,
);

// ── 5. an organization's cohort rate is Σ halves ÷ Σ halves, never a mean of rates ─────
// USD business: GRR 90,000 / 100,000 (90%). EUR business: 4,000 / 10,000 (40%), at
// 1 USD = 0.5 EUR → 8,000 / 20,000 USD. Right: 98,000 / 120,000 = 8167 bps. Wrong answers
// this rules out: the mean of the two rates (6500), unconverted halves (8545), and a
// numerator converted without its denominator (8909).
const org2 = await createOrganization({ name: "Metric Windows Org Combine" });
const org2Id = org2.organization.id;
const usdBiz = await createBusiness({
  organizationId: org2Id,
  name: "USD biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const eurBiz = await createBusiness({
  organizationId: org2Id,
  name: "EUR biz",
  defaultCurrency: "EUR",
  livemode: "test",
});
await withTenant(org2Id, (tx) =>
  tx.execute(
    sql`update organizations set base_currency = 'USD', exchange_rates = '{"EUR":0.5}'::jsonb where id = ${org2Id}`,
  ),
);
const orgScope = await resolveScope(org2Id, null, "all");
const window30 = (await resolveAnalytics(orgScope, { measure: "mrr", range: "30d" } as never, now))
  .range;
const dayBefore = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
};
const halves = [
  { biz: usdBiz.id, currency: "USD", grr: [90_000n, 100_000n], churn: [10n, 100n], shift: false },
  { biz: eurBiz.id, currency: "EUR", grr: [4_000n, 10_000n], churn: [5n, 10n], shift: true },
];
await withTenant(org2Id, (tx) =>
  tx.insert(metricWindows).values(
    halves.flatMap((h) => {
      // The EUR business's window ends a day earlier, as one cut in another zone would.
      const periodEnd = h.shift ? dayBefore(window30.end) : window30.end;
      const periodStart = h.shift ? dayBefore(window30.start) : window30.start;
      const base = {
        organizationId: org2Id,
        businessId: h.biz,
        windowName: "30d",
        periodStart,
        periodEnd,
        dim: "",
        dimValue: "",
        currency: h.currency,
      };
      return [
        { ...base, measure: "gross_revenue_retention", value: h.grr[0]!, denominator: h.grr[1]! },
        { ...base, measure: "customer_churn_rate", value: h.churn[0]!, denominator: h.churn[1]! },
      ];
    }),
  ),
);
const askOrg = (q: Record<string, unknown>) => resolveAnalytics(orgScope, q as never, now);
const orgGrr = await askOrg({ measure: "gross_revenue_retention", range: "30d", grain: "month" });
ok(
  "an organization's GRR is the revenue-weighted Σ numerators ÷ Σ denominators",
  orgGrr.total === 8167,
  {
    total: orgGrr.total,
    num: orgGrr.total_numerator,
    den: orgGrr.total_denominator,
    cur: orgGrr.currency,
    basis: orgGrr.currency_basis,
    rates: orgGrr.rates,
    missing: orgGrr.missing_rates,
  },
);
ok(
  "…with both halves converted at one rate and both businesses present",
  orgGrr.total_numerator === 98_000 && orgGrr.total_denominator === 120_000,
  { num: orgGrr.total_numerator, den: orgGrr.total_denominator },
);
const orgChurn = await askOrg({ measure: "customer_churn_rate", range: "30d", grain: "month" });
ok(
  "an organization's customer churn sums the counts, unconverted: 15 of 110",
  orgChurn.total_numerator === 15 && orgChurn.total_denominator === 110 && orgChurn.total === 1364,
  { total: orgChurn.total, num: orgChurn.total_numerator, den: orgChurn.total_denominator },
);
const refused = async (q: Record<string, unknown>) => {
  try {
    await askOrg(q);
    return false;
  } catch {
    return true;
  }
};
ok(
  "a bare distinct count is still refused across businesses",
  await refused({ measure: "customers_new", range: "30d", grain: "month" }),
);
ok(
  "…and so is a cohort rate by week, where business calendars can differ",
  await refused({ measure: "gross_revenue_retention", range: "90d", grain: "week" }),
);

console.log(
  `\n${fail === 0 ? "✅" : "❌"} METRIC WINDOWS: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
