/**
 * verify:cancellation-analytics — a cancellation is classified by what it cost: paying (the
 * ledger's churn, not the zeroed `subscriptions.mrr`), a trial that never converted, or a free
 * plan. Paying losses split by cause, merchant reason and tenure, convert at the day's rate, and
 * the population is the subscriptions list's own, so every figure matches its drill-down.
 */
import { and, eq } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  countSubscriptions,
} from "@/modules/subscriptions/service";
import { computeCancellationAnalytics } from "@/modules/metrics/cancellations";
import { zonedDayString } from "@/platform/timezones";
import { businesses, mrrMovements, subscriptions } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, cond ? "" : JSON.stringify(detail ?? ""));
}

const DAY = 86_400_000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const day = (d: Date) => zonedDayString(d, "UTC");
const PARKED = new Date(now.getTime() + 400 * DAY);

const org = await createOrganization({ name: "Cancellation Analytics Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
// 80 INR to the dollar: ₹800.00 is $10.00.
await systemDb
  .update(businesses)
  .set({ exchangeRates: { INR: 80 } })
  .where(eq(businesses.id, biz.id));
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
const price = (currency: string, amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor,
    interval: "month",
  });
const usd100 = await price("USD", 100_00);
const usd50 = await price("USD", 50_00);
const inr800 = await price("INR", 800_00);
const free = await price("USD", 0);

let n = 0;
async function subscribe(p: Awaited<ReturnType<typeof price>>, startedAgo: number, trialDays = 0) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `cx-${++n}-${Date.now()}@example.test`,
  });
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: ago(startedAgo),
    ...(trialDays > 0 ? { trialDays } : { startDate: ago(startedAgo) }),
    items: [{ price: p, quantity: 1 }],
  });
  // Out of the live dev worker's reach: no renewal or trial end fires during the run.
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: PARKED, ...(trialDays > 0 ? { trialEnd: PARKED } : {}) })
    .where(eq(subscriptions.id, subscription.id));
  return subscription;
}
const cancel = (
  id: string,
  daysAgo: number,
  reason?: { cancelReason?: string; cancelReasonCode?: string },
) =>
  cancelSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: id,
    atPeriodEnd: false,
    now: ago(daysAgo),
    ...reason,
  });

//  A — $100, 400 days old, leaves by choice with a reason, 20 days ago.
//  B — $50, 60 days old, cancelled by dunning, 5 days ago.
//  C — ₹800, 200 days old, leaves with no reason, 3 days ago.
//  D — a trial that never converted, 8 days ago.
//  E — a free plan, 2 days ago.
//  F — $100, cancelled 100 days ago: outside the window.
const A = await subscribe(usd100, 400);
const B = await subscribe(usd50, 60);
const C = await subscribe(inr800, 200);
const D = await subscribe(usd100, 20, 30);
const E = await subscribe(free, 90);
const F = await subscribe(usd100, 300);
await cancel(A.id, 20, { cancelReasonCode: "too_expensive" });
await cancel(B.id, 5, { cancelReason: "not_paid" });
await cancel(C.id, 3);
await cancel(D.id, 8, { cancelReason: "no_card" });
await cancel(E.id, 2);
await cancel(F.id, 100);

const start = day(ago(30));
const end = day(now);
const filters = [
  { field: "status", op: "is", value: "cancelled" },
  { field: "canceled_at", op: "between", value: `${start},${end}` },
];
const buckets = [
  { start, end: day(ago(15)) },
  { start: day(ago(14)), end },
];
const r = await computeCancellationAnalytics(orgId, biz.id, { filters, buckets });

// ── the population is the list's ───────────────────────────────────────────────────────
const listed = await countSubscriptions(orgId, biz.id, [{ key: "n", filters }]);
ok(
  "the total equals the list the report drills into",
  r.totals.count === listed.n && r.totals.count === 5,
  {
    report: r.totals.count,
    list: listed.n,
  },
);

// ── kind: what it cost ─────────────────────────────────────────────────────────────────
const kind = (k: string) => r.kinds.find((x) => x.kind === k);
ok(
  "three paying cancellations, from the ledger's churn",
  kind("paying")?.count === 3 && r.totals.paying === 3,
  r.kinds,
);
ok(
  "the trial that never converted is not a paying loss",
  kind("trial_not_converted")?.count === 1 && kind("trial_not_converted")?.mrr_lost_minor === 0,
);
ok(
  "a free plan had no MRR to lose",
  kind("no_mrr")?.count === 1 && kind("no_mrr")?.mrr_lost_minor === 0,
);

// ── money: per currency, and converted at the day's rate ───────────────────────────────
ok(
  "MRR lost per currency is what each subscription earned",
  r.totals.mrr_lost_by_currency.USD === 150_00 && r.totals.mrr_lost_by_currency.INR === 800_00,
  r.totals.mrr_lost_by_currency,
);
ok(
  "converted: $100 + $50 + ₹800 at 80 = $160",
  r.totals.mrr_lost_minor === 160_00 && r.currency === "USD",
  r.totals,
);
ok("no loss went unconverted", r.totals.unconverted === 0);

// ── cause, reason, tenure ──────────────────────────────────────────────────────────────
const cause = (c: string) => r.causes.find((x) => x.cause === c);
ok(
  "a dunning cancellation is an involuntary payment failure",
  cause("payment_failed")?.count === 1 &&
    cause("payment_failed")?.involuntary === true &&
    cause("payment_failed")?.mrr_lost_minor === 50_00,
);
ok(
  "the other two paying losses are voluntary",
  cause("voluntary")?.count === 2 && cause("voluntary")?.mrr_lost_minor === 110_00,
  r.causes,
);
ok("the involuntary count excludes the trial's no_card", r.totals.involuntary === 1);
const reason = (x: string | null) => r.reasons.find((y) => y.reason === x);
ok(
  "a merchant reason carries its paying loss",
  reason("too_expensive")?.count === 1 && reason("too_expensive")?.mrr_lost_minor === 100_00,
);
ok("paying losses with no reason are counted, not dropped", reason(null)?.count === 2);
const band = (b: string) => r.tenure.find((x) => x.band === b)?.count ?? 0;
ok(
  "tenure: 400 days is 1–2 years, 200 is 6–12 months, 60 is 1–3 months",
  band("12_24m") === 1 && band("6_12m") === 1 && band("1_3m") === 1,
  r.tenure,
);

// ── the trend and the largest losses ───────────────────────────────────────────────────
ok(
  "buckets: A in the first half; B, C, D, E in the second",
  r.buckets[0]!.count === 1 && r.buckets[1]!.count === 4,
  r.buckets,
);
ok(
  "a bucket's involuntary MRR is its dunning loss",
  r.buckets[1]!.involuntary_mrr_lost_minor === 50_00 && r.buckets[1]!.mrr_lost_minor === 60_00,
  r.buckets[1],
);
ok(
  "the largest losses are ranked by converted MRR",
  r.top_losses.map((t) => t.subscription).join(",") ===
    [A.publicId, B.publicId, C.publicId].join(","),
  r.top_losses.map((t) => [t.subscription, t.converted_mrr_lost_minor]),
);
ok("…and name the plan the churn left", r.top_losses[0]?.plan === "Pro");

// ── an imported churn carries no plan: the subscription's own plan item names it ───────
await systemDb
  .update(mrrMovements)
  .set({ planProductId: null })
  .where(and(eq(mrrMovements.subscriptionId, A.id), eq(mrrMovements.reason, "churn")));
const unplanned = await computeCancellationAnalytics(orgId, biz.id, { filters });
ok(
  "a churn with no plan still names the subscription's plan",
  unplanned.top_losses[0]?.plan === "Pro",
  unplanned.top_losses[0],
);

// ── a plan filter narrows every figure ─────────────────────────────────────────────────
const none = await computeCancellationAnalytics(orgId, biz.id, {
  filters: [...filters, { field: "billing_period_unit", op: "is", value: "year" }],
});
ok(
  "an interval no subscription has leaves nothing",
  none.totals.count === 0 && none.top_losses.length === 0,
);

console.log(
  `\n${fail === 0 ? "✅" : "❌"} CANCELLATION ANALYTICS: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
