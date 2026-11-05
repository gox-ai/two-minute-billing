/**
 * verify:metric-dimensions — `billing_interval`, `region`, `plan_at_start` and `signup_cohort`
 * slices land in the right bucket, sum to the unsliced total on every measure that declares
 * them, and answer through `split=`; and the `has_used_discount` segment filter selects the
 * customers who have had a coupon or discount.
 *
 * The bucket oracle is this suite's own: each subscription's attributes are known from the
 * fixture, and its contribution is its ledger balance — never the writer's helpers.
 */
import { and, eq, lte, sql } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer, listCustomersPage } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, cancelSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import {
  applyCouponToSubscription,
  applyManualDiscount,
  createCoupon,
} from "@/modules/coupons/service";
import { computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { MEASURES, supportsDimension } from "@/modules/metrics/daily/measures";
import { restateTrailingDays } from "@/modules/metrics/daily/maintenance";
import {
  resolveScope,
  resolveAnalytics,
  businessesByPublicIds,
} from "@/modules/metrics/daily/public-query";
import { endOfDay } from "@/modules/metrics/snapshots";
import { createSegment, resolveSegment } from "@/modules/segments/service";
import { SEGMENT_ATTRIBUTE_FIELDS } from "@/modules/segments/attributes";
import { customers, mrrMovements, subscriptionItems, subscriptions } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, cond ? "" : JSON.stringify(detail ?? "", bigintJson));
}
const bigintJson = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const NEW_DIMS = ["billing_interval", "region", "plan_at_start", "signup_cohort"] as const;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const month = (d: Date) => d.toISOString().slice(0, 7);
const PARKED = new Date("2099-01-01T00:00:00Z");

// ── Fixture ────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Metric Dimensions Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Metric Dimensions Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const basic = await createProduct({ organizationId: orgId, businessId: bizId, name: "Basic" });
const pro = await createProduct({ organizationId: orgId, businessId: bizId, name: "Pro" });
const price = (productId: string, amountMinor: number, interval: "month" | "year") =>
  createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval,
  });
const basicMonthly = await price(basic.id, 1_000, "month");
const proMonthly = await price(pro.id, 3_000, "month");
const proAnnual = await price(pro.id, 120_000, "year");
const free = await createProduct({ organizationId: orgId, businessId: bizId, name: "Free" });
const freeMonthly = await price(free.id, 0, "month");

let seq = 0;
async function subscribe(opts: {
  price: typeof basicMonthly;
  country: string | null;
  startedAgo: number;
  trialDays?: number;
}) {
  const start = daysAgo(opts.startedAgo);
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `dims-${++seq}@example.test`,
    ...(opts.country ? { address: { country: opts.country } } : {}),
  });
  await systemDb.update(customers).set({ createdAt: start }).where(eq(customers.id, customer.id));
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizId,
    customer,
    token: "tok_4242",
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: customer.id,
    now: start,
    startDate: start,
    items: [{ price: opts.price, quantity: 1 }],
    ...(opts.trialDays ? { trialDays: opts.trialDays } : {}),
  });
  await systemDb
    .update(subscriptions)
    .set({ createdAt: start })
    .where(eq(subscriptions.id, subscription.id));
  return { customer, subscription, start };
}

// A: US monthly Basic, paying since 70 days ago — a cohort months before the rest.
const A = await subscribe({ price: basicMonthly, country: "US", startedAgo: 70 });
// B: DE annual Pro.
const B = await subscribe({ price: proAnnual, country: "DE", startedAgo: 28 });
// C: IN monthly Basic, upgraded to Pro 10 days ago — plan Pro, plan at start Basic.
const C = await subscribe({ price: basicMonthly, country: "IN", startedAgo: 25 });
// D: no country, annual Pro, cancelled 5 days ago.
const D = await subscribe({ price: proAnnual, country: null, startedAgo: 20 });
// E: DE (lower-case on file) on a free plan — active, never paid.
const E = await subscribe({ price: freeMonthly, country: "de", startedAgo: 3 });

const [cItem] = await withTenant(orgId, (tx) =>
  tx
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, C.subscription.id)),
);
await changeSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: C.subscription.id,
  now: daysAgo(10),
  changes: [{ itemId: cItem!.publicId, newPriceId: proMonthly.publicId }],
});
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: D.subscription.id,
  atPeriodEnd: false,
  now: daysAgo(5),
  // As dunning cancels: the system reason is what `churn_kind` reads.
  cancelReason: "not_paid",
});
// Coupons: a manual discount on A, a coupon on B. C, D and E never had one.
await applyManualDiscount({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: A.subscription.id,
  kind: "percentage",
  percentOffBps: 1000,
  durationType: "forever",
  now: daysAgo(2),
});
const coupon = await createCoupon({
  organizationId: orgId,
  businessId: bizId,
  code: `DIMS${Date.now()}`,
  kind: "percentage",
  percentOffBps: 500,
  durationType: "forever",
});
await applyCouponToSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: B.subscription.id,
  code: coupon.code,
  now: daysAgo(2),
});
// Park every term past the real clock so a live worker renews nothing mid-run.
await systemDb
  .update(subscriptions)
  .set({ currentPeriodEnd: PARKED })
  .where(and(eq(subscriptions.businessId, bizId), sql`${subscriptions.status} <> 'cancelled'`));

// What each subscription IS, per dimension — the oracle's input, written by hand.
const firstPaid = (s: { start: Date }) => month(s.start);
const truth: Record<string, Record<(typeof NEW_DIMS)[number], string>> = {
  [A.subscription.id]: {
    billing_interval: "monthly",
    region: "north_america",
    plan_at_start: basic.id,
    signup_cohort: firstPaid(A),
  },
  [B.subscription.id]: {
    billing_interval: "annual",
    region: "europe",
    plan_at_start: pro.id,
    signup_cohort: firstPaid(B),
  },
  [C.subscription.id]: {
    billing_interval: "monthly",
    region: "asia_pacific",
    plan_at_start: basic.id,
    signup_cohort: firstPaid(C),
  },
  [D.subscription.id]: {
    billing_interval: "annual",
    region: "none",
    plan_at_start: pro.id,
    signup_cohort: firstPaid(D),
  },
  [E.subscription.id]: {
    billing_interval: "monthly",
    region: "europe",
    plan_at_start: free.id,
    signup_cohort: "none",
  },
};
ok(
  "the fixture has two cohorts and two cadences",
  new Set(Object.values(truth).map((t) => t.signup_cohort)).size >= 3,
);

// ── 1. computeMetricPeriod: slices sum to totals, and each key is right ───────────────
const today = ymd(now);
const at = endOfDay(today, "UTC");
const rows = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "day", today, now, {
    timezone: "UTC",
    periodStart: ymd(daysAgo(40)),
  }),
);
const val = (measure: string, dim: string, key: string) =>
  rows
    .filter((r) => r.measure === measure && r.dim === dim && r.dimValue === key)
    .reduce((a, r) => a + (r.value ?? 0n), 0n);
const total = (measure: string) => val(measure, "", "");

for (const m of MEASURES) {
  for (const dim of NEW_DIMS) {
    if (!supportsDimension(m, dim)) continue;
    const slices = rows.filter((r) => r.measure === m.id && r.dim === dim);
    const sum = slices.reduce((a, r) => a + (r.value ?? 0n), 0n);
    const t = total(m.id);
    if (t === 0n && slices.length === 0) continue;
    ok(`${m.id} by ${dim}: slices sum to the total`, sum === t, { sum, t });
  }
}

// Stock oracle: each subscription's ledger balance at `at`, bucketed by the hand truth.
const balances = await withTenant(orgId, (tx) =>
  tx
    .select({ id: mrrMovements.subscriptionId, v: sql<string>`sum(${mrrMovements.deltaMinor})` })
    .from(mrrMovements)
    .where(and(eq(mrrMovements.businessId, bizId), lte(mrrMovements.occurredAt, at)))
    .groupBy(mrrMovements.subscriptionId),
);
const balance = new Map(balances.map((b) => [b.id, BigInt(b.v)]));
for (const dim of NEW_DIMS) {
  const want = new Map<string, bigint>();
  for (const [id, t] of Object.entries(truth)) {
    const b = balance.get(id) ?? 0n;
    if (b !== 0n) want.set(t[dim], (want.get(t[dim]) ?? 0n) + b);
  }
  const got = new Map(
    rows
      .filter((r) => r.measure === "mrr" && r.dim === dim && r.value !== 0n)
      .map((r) => [r.dimValue, r.value]),
  );
  ok(
    `mrr by ${dim}: every bucket holds exactly its subscriptions' MRR`,
    JSON.stringify([...want].sort(), bigintJson) === JSON.stringify([...got].sort(), bigintJson),
    { want: [...want], got: [...got] },
  );
}
ok(
  "active_subscriptions by signup_cohort: the free subscription that never paid is 'none'",
  val("active_subscriptions", "signup_cohort", "none") === 1n,
);
ok(
  "paying_subscriptions by signup_cohort: …and is not paying",
  val("paying_subscriptions", "signup_cohort", "none") === 0n,
);
ok(
  "active_subscriptions by region: both DE customers are Europe",
  val("active_subscriptions", "region", "europe") === 2n,
);
ok(
  "active_subscriptions by billing_interval: B is the one live annual",
  val("active_subscriptions", "billing_interval", "annual") === 1n,
);
ok(
  "cmrr by billing_interval: annual is B's committed rate",
  val("cmrr", "billing_interval", "annual") === balance.get(B.subscription.id),
);

// Movements over the last 40 days.
ok(
  "mrr_churn by billing_interval: D's annual churn",
  val("mrr_churn", "billing_interval", "annual") > 0n &&
    val("mrr_churn", "billing_interval", "monthly") === 0n,
);
ok(
  "mrr_churn by region: D has no country → none",
  val("mrr_churn", "region", "none") === total("mrr_churn"),
);
ok(
  "mrr_churn by signup_cohort: D's cohort",
  val("mrr_churn", "signup_cohort", firstPaid(D)) === total("mrr_churn"),
);
ok(
  "mrr_churn by churn_kind: D was cancelled for non-payment, so all of it is involuntary",
  total("mrr_churn") > 0n &&
    val("mrr_churn", "churn_kind", "involuntary") === total("mrr_churn") &&
    val("mrr_churn", "churn_kind", "voluntary") === 0n,
  {
    total: total("mrr_churn"),
    involuntary: val("mrr_churn", "churn_kind", "involuntary"),
    voluntary: val("mrr_churn", "churn_kind", "voluntary"),
  },
);
ok(
  "mrr_expansion by plan_at_start: C's upgrade files under Basic",
  val("mrr_expansion", "plan_at_start", basic.id) > 0n,
);
ok(
  "mrr_expansion by plan: …and under Pro by current plan",
  val("mrr_expansion", "plan", pro.id) > 0n && val("mrr_expansion", "plan", basic.id) === 0n,
);
ok(
  "mrr_expansion by region: C's upgrade is Asia Pacific",
  total("mrr_expansion") > 0n &&
    val("mrr_expansion", "region", "asia_pacific") === total("mrr_expansion"),
);
ok(
  "mrr_contraction by region: A's discount is North America, B's coupon Europe",
  val("mrr_contraction", "region", "north_america") > 0n &&
    val("mrr_contraction", "region", "europe") > 0n &&
    val("mrr_contraction", "region", "north_america") +
      val("mrr_contraction", "region", "europe") ===
      total("mrr_contraction"),
);
ok(
  "mrr_new by region: A's start is outside the window, so no North America",
  val("mrr_new", "region", "north_america") === 0n,
);
ok(
  "subscription_cancellations by billing_interval: one annual",
  val("subscription_cancellations", "billing_interval", "annual") === 1n &&
    total("subscription_cancellations") === 1n,
);

// ── 2. stored and split through resolveAnalytics ───────────────────────────────────────
const restated = await restateTrailingDays(now, { businessIds: [bizId] });
ok(
  "the trailing restatement (the backfill path) writes the new slices",
  JSON.stringify(restated).includes('"failed":0'),
  restated,
);
const [b] = await businessesByPublicIds(orgId, [biz.publicId]);
const scope = await resolveScope(orgId, b!, "all");
const ask = (q: Record<string, unknown>) => resolveAnalytics(scope, q as never, now);
for (const [measure, split] of [
  ["mrr", "billing_interval"],
  ["mrr", "region"],
  ["mrr", "plan_at_start"],
  ["mrr", "signup_cohort"],
  ["active_subscriptions", "region"],
  ["mrr_churn", "billing_interval"],
] as const) {
  const res = await ask({ measure, range: "30d", grain: "month", split });
  // Every row, residual included, adds to the headline — the split's own `exhaustive` contract.
  const all = res.split?.series ?? [];
  const sum = all.reduce((a, r) => a + (r.total ?? 0), 0);
  ok(
    `split=${split} on ${measure}: rows sum to the headline`,
    all.some((r) => r.kind === "dimension") &&
      res.split!.exhaustive &&
      Math.abs(sum - (res.total ?? 0)) < 1e-9,
    { sum, total: res.total, split: res.split },
  );
  // The closing period, bucket by bucket: dimension rows alone equal the headline's last point.
  const lastT = res.series.at(-1)?.t;
  const closing = all
    .filter((r) => r.kind === "dimension")
    .reduce((a, r) => a + (r.points.find((p) => p.t === lastT)?.value ?? 0), 0);
  // A stock is what exists on the period's last stored day: a slice that emptied mid-period
  // contributes nothing, so the dimension rows alone equal the headline — no residual needed.
  if (measure === "mrr" || measure === "active_subscriptions") {
    ok(
      `split=${split} on ${measure}: the closing slices equal the closing headline, no residual`,
      closing === (res.series.at(-1)?.value ?? 0),
      { closing, headline: res.series.at(-1)?.value },
    );
  }
  // Region is a fold of country, so every period agrees with the country split.
  if (split === "region") {
    const probe = await ask({ measure, range: "30d", grain: "month", split: "country" });
    const cclosing = (probe.split?.series ?? [])
      .filter((r) => r.kind === "dimension")
      .reduce((a, r) => a + (r.points.find((p) => p.t === lastT)?.value ?? 0), 0);
    ok(
      `split=region on ${measure}: the closing period agrees with split=country`,
      closing === cclosing,
      { closing, cclosing },
    );
  }
}
const byInterval = await ask({
  measure: "mrr",
  range: "30d",
  grain: "month",
  split: "billing_interval",
});
const labels = Object.fromEntries((byInterval.split?.series ?? []).map((r) => [r.key, r.label]));
ok(
  "billing_interval keys are labelled",
  labels.annual === "Annual" && labels.monthly === "Monthly",
  labels,
);
const byStart = await ask({ measure: "mrr", range: "30d", grain: "month", split: "plan_at_start" });
ok(
  "plan_at_start keys are named by product",
  (byStart.split?.series ?? []).some((r) => r.label === "Basic"),
  byStart.split?.series,
);
const byRegion = await ask({
  measure: "active_subscriptions",
  range: "30d",
  grain: "month",
  split: "region",
});
ok(
  "region keys are labelled",
  (byRegion.split?.series ?? []).some((r) => r.key === "europe" && r.label === "Europe"),
  byRegion.split?.series,
);
let refused = false;
try {
  await ask({ measure: "cmrr", range: "30d", grain: "month", split: "region" });
} catch {
  refused = true;
}
ok("cmrr refuses region, which it does not declare", refused);

// ── 3. the coupon segment filter ───────────────────────────────────────────────────────
ok(
  "has_used_discount is offered by the segment builder",
  SEGMENT_ATTRIBUTE_FIELDS.has("has_used_discount"),
);
const pick = async (value: string) => {
  const page = await listCustomersPage(orgId, bizId, {
    filters: [{ field: "has_used_discount", op: "is", value }],
    limit: 50,
  });
  return new Set(page.data.map((c) => c.id));
};
const used = await pick("true");
const unused = await pick("false");
ok(
  "has_used_discount=true selects exactly A (manual) and B (coupon)",
  used.size === 2 && used.has(A.customer.id) && used.has(B.customer.id),
  [...used],
);
ok(
  "has_used_discount=false selects the other three",
  unused.size === 3 && !unused.has(A.customer.id) && !unused.has(B.customer.id),
  [...unused],
);
await createSegment({
  organizationId: orgId,
  businessId: bizId,
  name: "Used a discount",
  filters: [{ field: "has_used_discount", op: "is", value: "true" }],
});
const seg = await resolveSegment(orgId, bizId, [
  { field: "has_used_discount", op: "is", value: "true" },
]);
ok(
  "a saved segment on it resolves to the same two customers",
  seg.totals.customers === 2,
  seg.totals,
);

console.log(
  `\n${fail === 0 ? "✅" : "❌"} METRIC DIMENSIONS: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
