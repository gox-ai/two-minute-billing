/**
 * verify:metric-maintenance — the nightly restatement repairs the trailing month, the drift
 * scan catches a stored day that no longer matches a recompute.
 */
import { and, eq, inArray } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  reactivateSubscriptionWithOptions,
} from "@/modules/subscriptions/service";
import { loadLapses } from "@/modules/metrics/snapshots";
import { computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { bulkFillMetricDays } from "@/modules/metrics/daily/bulk-fill";
import {
  lateDays,
  restateTrailingDays,
  scanMetricDrift,
  TRAILING_DAYS,
} from "@/modules/metrics/daily/maintenance";
import { recordTransaction } from "@/modules/transactions/service";
import { businessesWithSubscriptions } from "@/modules/metrics/daily/cron";
import { metricDaily, mrrMovements } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, cond ? "" : (detail ?? ""));
}
const shift = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const now = new Date();
const today = now.toISOString().slice(0, 10);
const org = await createOrganization({ name: "Metric Maintenance Org" });
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
  email: "m@a.com",
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer,
  token: "tok_4242",
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
// Started 50 days ago, so every trailing day and the first drift sample (45 back) has a book.
await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: new Date(now.getTime() - 50 * 86_400_000),
  items: [{ price, quantity: 1 }],
});

const storedDay = async (day: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select()
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, biz.id),
          eq(metricDaily.grain, "day"),
          eq(metricDaily.periodEnd, day),
        ),
      ),
  );

// ── 1. restatement ─────────────────────────────────────────────────────────────────────
const res = await restateTrailingDays(now, { businessIds: [biz.id] });
ok("the restatement ran without a business failing", res.failed === 0, res);
const days = await withTenant(orgId, (tx) =>
  tx
    .selectDistinct({ d: metricDaily.periodEnd })
    .from(metricDaily)
    .where(
      and(
        eq(metricDaily.businessId, biz.id),
        eq(metricDaily.grain, "day"),
        eq(metricDaily.measure, "mrr"),
      ),
    ),
);
ok(`it writes the trailing ${TRAILING_DAYS} days`, days.length === TRAILING_DAYS, days.length);
const oldest = shift(today, -TRAILING_DAYS);
ok(
  "…from yesterday back to 35 days ago, not today",
  days.some((x) => x.d === oldest) && !days.some((x) => x.d === today),
);
const yesterday = shift(today, -1);
const fresh = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, biz.id, "day", yesterday, now),
);
const stored = await storedDay(yesterday);
const key = (m: string, dim: string, v: string, c: string) => `${m}|${dim}|${v}|${c}`;
const storedMap = new Map(
  stored.map((r) => [key(r.measure, r.dim, r.dimValue, r.currency), String(r.value)]),
);
const mismatch = fresh.filter(
  (f) => storedMap.get(key(f.measure, f.dim, f.dimValue, f.currency)) !== String(f.value),
);
ok(
  "a restated day equals a fresh compute, row for row",
  mismatch.length === 0,
  mismatch.slice(0, 3),
);
const coarse = await withTenant(orgId, (tx) =>
  tx
    .select({ g: metricDaily.grain })
    .from(metricDaily)
    .where(and(eq(metricDaily.businessId, biz.id), inArray(metricDaily.grain, ["week", "month"]))),
);
ok("…and the coarse periods containing those days are written", coarse.length > 0);

// ── 1b. a measure subset restates only itself ──────────────────────────────────────────
const subset = new Set(["gross_revenue_retention", "net_mrr_growth_rate", "mrr"]);
const only = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, biz.id, "day", yesterday, now, { measures: subset }),
);
ok(
  "a subset computes only the measures asked for",
  only.length > 0 && only.every((r) => subset.has(r.measure)),
  [...new Set(only.map((r) => r.measure))],
);
const sig = (r: {
  measure: string;
  dim: string;
  dimValue: string;
  currency: string;
  value: bigint | null;
  denominator?: bigint | null;
}) => `${r.measure}|${r.dim}|${r.dimValue}|${r.currency}|${r.value}|${r.denominator ?? ""}`;
const fromFull = fresh
  .filter((r) => subset.has(r.measure))
  .map(sig)
  .sort()
  .join("\n");
ok(
  "…with exactly the rows a full compute gives them",
  only.map(sig).sort().join("\n") === fromFull,
);

// ── 2. drift scan ──────────────────────────────────────────────────────────────────────
const sampled = shift(today, -45);
await bulkFillMetricDays({
  organizationId: orgId,
  businessId: biz.id,
  grain: "day",
  days: [sampled],
  write: true,
  now,
});
const clean = await scanMetricDrift(now, { businessIds: [biz.id] });
ok("an untouched history shows no drift", clean.length === 0, clean);
await withTenant(orgId, (tx) =>
  tx
    .update(metricDaily)
    .set({ value: 1n })
    .where(
      and(
        eq(metricDaily.businessId, biz.id),
        eq(metricDaily.grain, "day"),
        eq(metricDaily.periodEnd, sampled),
        eq(metricDaily.measure, "mrr"),
        eq(metricDaily.dim, ""),
      ),
    ),
);
const drifted = await scanMetricDrift(now, { businessIds: [biz.id] });
ok(
  "a stored MRR that no longer matches its recompute is reported",
  drifted.length === 1 &&
    drifted[0]!.measure === "mrr" &&
    drifted[0]!.day === sampled &&
    drifted[0]!.stored === "1",
  drifted,
);

// ── 2b. a zero-MRR reactivation still closes the cancelled stretch ─────────────────────
// It books no ledger movement, so the stretch must come from the row; otherwise the
// recompute counts the subscription live through the gap and the scan reports drift.
const ago = (n: number) => new Date(now.getTime() - n * 86_400_000);
const { subscription: lapsed } = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  now: ago(120),
  items: [{ price, quantity: 1 }],
});
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: lapsed.id,
  atPeriodEnd: false,
  now: ago(90),
});
await reactivateSubscriptionWithOptions({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: lapsed.id,
  now: ago(30),
  items: [{ price: price.publicId, quantity: 1, unitPriceMinor: 0 }],
});
const moves = await withTenant(orgId, (tx) =>
  tx
    .select({ reason: mrrMovements.reason, delta: mrrMovements.deltaMinor })
    .from(mrrMovements)
    .where(eq(mrrMovements.subscriptionId, lapsed.id)),
);
ok(
  "the zero-MRR reactivation booked no reactivation movement",
  moves.some((m) => m.reason === "churn" && m.delta < 0n) &&
    !moves.some((m) => m.reason === "reactivation" && m.delta > 0n),
  moves,
);
const lapses = await withTenant(orgId, (tx) => loadLapses(tx, biz.id));
const gap = lapses.get(lapsed.id) ?? [];
ok(
  "its cancelled stretch is still a lapse, from the churn to the reactivation",
  gap.length === 1 &&
    Math.abs(gap[0]!.from.getTime() - ago(90).getTime()) < 86_400_000 &&
    Math.abs(gap[0]!.to.getTime() - ago(30).getTime()) < 86_400_000,
  gap,
);
const activeOn = async (day: string) => {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, biz.id, "day", day, now, {
      measures: new Set(["active_subscriptions"]),
    }),
  );
  return Number(rows.find((r) => r.dim === "" && r.currency === "USD")?.value ?? 0);
};
// The first subscription started 50 days ago, so 60 days back only this one could count.
ok("…so it is not active inside the gap", (await activeOn(shift(today, -60))) === 0);
ok("…and is active before it", (await activeOn(shift(today, -100))) === 1);

// ── 3. a backdated row older than the trailing window restates its own day ────────────
// An offline refund recorded today but dated 80 days back: the trailing pass never reaches
// that day, so before the late-day pass only a lucky drift sample would have found it.
const lateDay = shift(today, -80);
await bulkFillMetricDays({
  organizationId: orgId,
  businessId: biz.id,
  grain: "day",
  days: [lateDay],
  write: true,
  now,
});
const cronBiz = (await businessesWithSubscriptions()).find((b) => b.id === biz.id)!;
ok("a stored old day with no later row is not late", (await lateDays(cronBiz, now)).length === 0);
await recordTransaction({
  organizationId: orgId,
  businessId: biz.id,
  customerId: customer.id,
  type: "refund",
  status: "succeeded",
  amountMinor: 2100n,
  currency: "USD",
  gatewayKey: "offline_other",
  occurredAt: new Date(`${lateDay}T12:00:00.000Z`),
});
ok(
  "a refund dated onto a stored old day makes that day late",
  JSON.stringify(await lateDays(cronBiz, now)) === JSON.stringify([lateDay]),
  await lateDays(cronBiz, now),
);
const stale = (await storedDay(lateDay)).find(
  (r) => r.measure === "refunds_issued" && r.dim === "" && r.currency === "USD",
);
// No row at all is the honest answer: the business had moved no USD money by that day.
ok("…whose stored refunds do not include it yet", String(stale?.value ?? "0") === "0", stale);
const lateRes = await restateTrailingDays(now, { businessIds: [biz.id] });
ok("the nightly pass restates it", lateRes.failed === 0 && lateRes.late === 1, lateRes);
const restated = await storedDay(lateDay);
const val = (m: string) =>
  String(restated.find((r) => r.measure === m && r.dim === "" && r.currency === "USD")?.value);
ok("…so the day's refunds include it", val("refunds_issued") === "2100", val("refunds_issued"));
ok("…and net payments drop by it", val("payments_net") === "-2100", val("payments_net"));
ok("…and the day is no longer late", (await lateDays(cronBiz, now)).length === 0);

console.log(
  `\n${fail === 0 ? "✅" : "❌"} METRIC MAINTENANCE: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
