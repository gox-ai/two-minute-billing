/**
 * The day-end book (`snapshots.ts`) — the MRR, CMRR and counts `metric_daily` stores, by
 * currency, plan and country. It must AGREE with what `computeBusinessAnalytics` reports for
 * the same instant, figure for figure, and split per currency (two currencies, a row each,
 * never a converted total — FX is a read-time choice).
 *
 * The per-plan breakdown adds one property that matters more than any individual figure:
 * the per-plan rows for a (business, day, currency) must SUM to that business total. A
 * breakdown that disagrees with the total it is supposed to explain is worse than no
 * breakdown at all.
 *
 *   pnpm verify:mrr-snapshots
 */
import { eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, cancelSubscription } from "@/modules/subscriptions/service";
import { computeBusinessAnalytics } from "@/modules/metrics/analytics";
import { computeRatioMeasures } from "@/modules/metrics/daily/ratio-measures";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import {
  computeSnapshot,
  computeSnapshotByPlan,
  computeSnapshotByCountry,
  utcDayString,
  endOfDay,
} from "@/modules/metrics/snapshots";
import { mrrMovements, subscriptions } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Snapshot Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Snapshot Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plans" });
const mkPrice = (currency: string, amountMinor: number) =>
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
const usd = await mkPrice("USD", 5000);
const eur = await mkPrice("EUR", 3000);

// A second plan, to prove the breakdown actually splits rather than collapsing to one
// bucket — the existing fixture had only one plan, which a bug that ignored plan entirely
// would still have passed.
const productB = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Plans B",
});
const usdB = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: productB.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 2000,
  interval: "month",
});

// A charges-only subscription — no plan-kind item at all. `resolvePlanProductId` does NOT
// return null here: it falls back to the first item, so this still lands under a real
// bucket (keyed by the charge product) rather than vanishing from the breakdown. NULL is
// reserved for a subscription with literally no items, which cannot be reached through the
// service layer — kept as a real, never-dropped bucket anyway, because a breakdown whose
// parts don't sum to the whole is worse than one with an awkward row.
const chargeProduct = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Support",
  kind: "charge",
});
const usdCharge = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: chargeProduct.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

/**
 * `country: null` means no country on file — the Unknown bucket the per-country breakdown
 * must keep, not drop. 27 of the 3,361 customers on the largest real book are like this,
 * and dropping them would break the only property a breakdown has to hold.
 */
async function sub(price: typeof usd, country: string | null = null) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `sn${Math.random()}@a.com`,
    ...(country ? { address: { country } } : {}),
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  return (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: new Date(),
      items: [{ price, quantity: 1 }],
    })
  ).subscription;
}

// Book: 3× USD $50 (Plans), 1× EUR €30 (Plans), 1× USD $20 (Plans B), 1× USD $10
// (charges-only, Support), and one USD $50 cancelled straight away.
await sub(usd, "DE");
await sub(usd, "FR");
await sub(usd); // no country on file — the Unknown bucket
await sub(eur, "DE");
await sub(usdB, "DE");
await sub(usdCharge, "FR");
const dead = await sub(usd, "DE");
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: dead.id,
  atPeriodEnd: false,
  now: new Date(),
});

// TODAY's day string: everything above happened now, so today's end is the instant the
// book is fully formed. (The job writes yesterday; this suite writes today deliberately,
// because a fixture created now has nothing to say about yesterday.)
const today = utcDayString(new Date());

// ── Snapshot vs the live reconstruction ──────────────────────────────────────
{
  const rows = await withTenant(orgId, (tx) => computeSnapshot(tx, biz.id, today));
  const byCcy = new Map(rows.map((r) => [r.currency, r]));
  const usdRow = byCcy.get("USD");
  const eurRow = byCcy.get("EUR");
  console.log(
    "snapshot:",
    JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  );

  ok("snapshot: one row per currency held", rows.length === 2);
  ok(
    "snapshot: USD MRR = 18000 (15000 Plans + 2000 Plans B + 1000 Support; the cancelled one is out)",
    usdRow?.mrrMinor === 18000n,
  );
  ok("snapshot: EUR kept separate at 3000, never converted", eurRow?.mrrMinor === 3000n);
  ok("snapshot: USD active = 5", usdRow?.activeSubscriptions === 5);
  ok("snapshot: USD paying = 5", usdRow?.payingSubscriptions === 5);

  // The agreement that is the whole point. Analytics scopes to one currency and reports
  // its own reconstruction; the snapshot must land on the same numbers.
  const usdOnly = await computeBusinessAnalytics(orgId, biz.id, {
    range: "daily",
    currency: "USD",
    now: endOfDay(today),
  });
  ok(
    "agreement: snapshot USD MRR = analytics MRR KPI",
    Number(usdRow?.mrrMinor ?? -1n) === usdOnly.kpis.mrr.value,
  );
  ok(
    "agreement: snapshot USD active = analytics active KPI",
    (usdRow?.activeSubscriptions ?? -1) === usdOnly.kpis.active_subscriptions.value,
  );
  ok(
    "agreement: snapshot USD paying = analytics paying KPI",
    (usdRow?.payingSubscriptions ?? -1) === usdOnly.kpis.paying_subscriptions.value,
  );
  ok(
    "agreement: snapshot USD CMRR = analytics CMRR KPI",
    Number(usdRow?.cmrrMinor ?? -1n) === usdOnly.kpis.cmrr.value,
  );
}

// ── The per-plan breakdown ────────────────────────────────────────────────────
{
  const rows = await withTenant(orgId, (tx) => computeSnapshotByPlan(tx, biz.id, today));
  console.log(
    "snapshot by plan:",
    JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  );

  const usdRows = rows.filter((r) => r.currency === "USD");
  const eurRows = rows.filter((r) => r.currency === "EUR");
  const plansRow = usdRows.find((r) => r.planProductId === product.id);
  const plansBRow = usdRows.find((r) => r.planProductId === productB.id);
  const supportRow = usdRows.find((r) => r.planProductId === chargeProduct.id);

  ok("by plan: one USD row per plan actually held (Plans, Plans B, Support)", usdRows.length === 3);
  ok(
    "by plan: Plans = 15000 MRR, 3 active",
    plansRow?.mrrMinor === 15000n && plansRow?.activeSubscriptions === 3,
  );
  ok(
    "by plan: Plans B = 2000 MRR, 1 active",
    plansBRow?.mrrMinor === 2000n && plansBRow?.activeSubscriptions === 1,
  );
  ok(
    "no-plan handling: a charges-only subscription is NOT nulled — it falls back to its " +
      "only item (Support) rather than vanishing from the breakdown",
    supportRow != null && supportRow.mrrMinor === 1000n && supportRow.activeSubscriptions === 1,
  );

  // The property that matters more than any individual figure: the per-plan rows for a
  // currency must SUM to the business total for that same currency and day.
  const usdTotal = await withTenant(orgId, (tx) => computeSnapshot(tx, biz.id, today));
  const usdTotalRow = usdTotal.find((r) => r.currency === "USD")!;
  const usdSumMrr = usdRows.reduce((acc, r) => acc + r.mrrMinor, 0n);
  const usdSumActive = usdRows.reduce((acc, r) => acc + r.activeSubscriptions, 0);
  ok(
    "sum-to-total: USD per-plan MRR sums to the business total",
    usdSumMrr === usdTotalRow.mrrMinor,
  );
  ok(
    "sum-to-total: USD per-plan active count sums to the business total",
    usdSumActive === usdTotalRow.activeSubscriptions,
  );

  ok(
    "by plan: EUR still just Plans, at 3000",
    eurRows.length === 1 && eurRows[0]?.mrrMinor === 3000n,
  );
}

// ── The per-country breakdown (4c) ───────────────────────────────────────────
// The dimension that makes a report answerable for "customers in Germany" without
// rebuilding the book per slice. Same property as the per-plan table, and one more: the
// Unknown bucket (no country on file) is a ROW, never a dropped subscription.
{
  const rows = await withTenant(orgId, (tx) => computeSnapshotByCountry(tx, biz.id, today));
  console.log(
    "snapshot by country:",
    JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  );

  const usdRows = rows.filter((r) => r.currency === "USD");
  const de = usdRows.find((r) => r.country === "DE");
  const fr = usdRows.find((r) => r.country === "FR");
  const unknown = usdRows.find((r) => r.country === null);

  ok("by country: USD splits DE / FR / Unknown", usdRows.length === 3);
  ok("by country: DE = 7000 (a $50 plan + a $20 plan), 2 active", de?.mrrMinor === 7000n);
  ok("by country: FR = 6000 ($50 plan + $10 charges-only), 2 active", fr?.mrrMinor === 6000n);
  ok(
    "by country: a customer with no country is the Unknown BUCKET, not a dropped row",
    unknown != null && unknown.mrrMinor === 5000n && unknown.activeSubscriptions === 1,
  );
  ok(
    "by country: the cancelled DE subscription is out, exactly as it is out of the total",
    de?.activeSubscriptions === 2,
  );

  // Σ segments = the unsegmented figure, EXACTLY — NULLs included. The identity that makes
  // a slice trustworthy; without the Unknown row it is false by 5000 here.
  const totals = await withTenant(orgId, (tx) => computeSnapshot(tx, biz.id, today));
  const usdTotalRow = totals.find((r) => r.currency === "USD")!;
  ok(
    "sum-to-total: USD per-country MRR sums to the business total, EXACTLY",
    usdRows.reduce((a, r) => a + r.mrrMinor, 0n) === usdTotalRow.mrrMinor,
  );
  ok(
    "sum-to-total: USD per-country active count sums to the business total",
    usdRows.reduce((a, r) => a + r.activeSubscriptions, 0) === usdTotalRow.activeSubscriptions,
  );
  ok(
    "sum-to-total: USD per-country paying count sums to the business total",
    usdRows.reduce((a, r) => a + r.payingSubscriptions, 0) === usdTotalRow.payingSubscriptions,
  );
  ok(
    "by country: EUR is its own book — DE only, at 3000, never converted",
    rows.filter((r) => r.currency === "EUR").length === 1 &&
      rows.find((r) => r.currency === "EUR")?.country === "DE",
  );
}

// ── The read path agrees with the day-end book ───────────────────────────────
// The MRR series serves a bucket from `metric_daily` when it has the day and reconstructs
// when it does not. Both must land on the day-end book this module computes.
{
  const a = await computeBusinessAnalytics(orgId, biz.id, {
    range: "daily",
    currency: "USD",
    now: endOfDay(today),
  });
  const series = a.series.find((x) => x.key === "total_mrr")!;
  const last = series.points.at(-1)!;
  ok("read path: today's bucket = the day-end book (18000)", last.v === 18000);
  ok("read path: …and equals the reconstruction's KPI", last.v === a.kpis.mrr.value);

  // A day with no stored row must still answer — the rebuild is what makes the store safe
  // to be incomplete.
  const earlier = series.points.at(-2);
  ok("read path: an unstored bucket still reports", earlier != null && earlier.v >= 0);
}

// ── A day before the book existed ────────────────────────────────────────────
// Nothing was live, so nothing is stored — a row of zeros would claim the business held
// those currencies on a day it had no subscriptions at all.
{
  const longAgo = utcDayString(new Date(Date.now() - 400 * 86_400_000));
  const rows = await withTenant(orgId, (tx) => computeSnapshot(tx, biz.id, longAgo));
  ok("empty day: nothing live → no rows, not rows of zeros", rows.length === 0);
  const rowsByPlan = await withTenant(orgId, (tx) => computeSnapshotByPlan(tx, biz.id, longAgo));
  ok("empty day: a plan with nothing on the day writes no row either", rowsByPlan.length === 0);
  const rowsByCountry = await withTenant(orgId, (tx) =>
    computeSnapshotByCountry(tx, biz.id, longAgo),
  );
  ok(
    "empty day: a country with nothing on the day writes no row either",
    rowsByCountry.length === 0,
  );
}

// ── A trial is not revenue ────────────────────────────────────────────────────────────
// Stored history counts a subscription from its trial's END. One converts at 5,000; one is
// cancelled when its trial ends without ever activating, and must never be priced at list.
{
  const tb = await createBusiness({
    organizationId: orgId,
    name: "Trial Snapshots",
    defaultCurrency: "USD",
    timezone: "UTC",
    livemode: "test",
  });
  const plan = await createProduct({ organizationId: orgId, businessId: tb.id, name: "Plan" });
  const list = await createPrice({
    organizationId: orgId,
    businessId: tb.id,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 9000,
    interval: "month",
  });
  const trialSub = async (name: string) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: tb.id,
      email: `trial-${name}-${Date.now()}@example.test`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: tb.id,
      customer: c,
      token: "tok_4242",
    });
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: tb.id,
      customerId: c.id,
      now: new Date("2026-04-01T00:00:00Z"),
      items: [{ price: list, quantity: 1 }],
      trialDays: 14,
    });
    return subscription.id;
  };
  const converted = await trialSub("converted");
  const lapsed = await trialSub("lapsed");
  const trial = {
    trialStart: new Date("2026-04-01T00:00:00Z"),
    // One second before the day closes, as a real one did: the lapsed trial is then still
    // live at the day's end, which is exactly when a list-price fallback would count it.
    trialEnd: new Date("2026-04-14T23:59:59Z"),
    startedAt: new Date("2026-04-01T00:00:00Z"),
    startDate: new Date("2026-04-01T00:00:00Z"),
    createdAt: new Date("2026-04-01T00:00:00Z"),
    currentPeriodEnd: new Date("2028-01-01T00:00:00Z"),
  };
  await systemDb
    .update(subscriptions)
    .set({ ...trial, status: "active", mrr: 5000n, activatedAt: new Date("2026-04-14T23:59:59Z") })
    .where(eq(subscriptions.id, converted));
  await systemDb
    .update(subscriptions)
    .set({
      ...trial,
      status: "cancelled",
      mrr: 0n,
      lastEarningMrr: null,
      activatedAt: null,
      canceledAt: new Date("2026-04-15T00:01:00Z"),
    })
    .where(eq(subscriptions.id, lapsed));
  const on = async (day: string) =>
    (await withTenant(orgId, (tx) => computeSnapshot(tx, tb.id, day, undefined, "UTC"))).find(
      (r) => r.currency === "USD",
    );
  const during = await on("2026-04-10");
  const edge = await on("2026-04-14");
  const after = await on("2026-04-20");
  ok("trial: no MRR while both are still trialing", (during?.mrrMinor ?? 0n) === 0n);
  ok("trial: …nor a paying subscription", (during?.payingSubscriptions ?? -1) === 0);
  ok("trial: …though both are active", (during?.activeSubscriptions ?? -1) === 2);
  ok(
    "trial: the lapsed trial is never priced at list, even on its last day",
    (edge?.mrrMinor ?? -1n) === 5000n,
  );
  ok(
    "trial: after conversion, only the converted one earns",
    (after?.mrrMinor ?? -1n) === 5000n && after?.payingSubscriptions === 1,
  );
}

// ── A later rate change stays in the day it happened ─────────────────────────
// A past day is the LEDGER balance then, not today's rate projected backwards. Two shapes: an
// expansion, and a cancel + reactivation at a lower rate that also resets the start.
{
  const hb = await createBusiness({
    organizationId: orgId,
    name: "History Snapshots",
    defaultCurrency: "USD",
    timezone: "UTC",
    livemode: "test",
  });
  const plan = await createProduct({ organizationId: orgId, businessId: hb.id, name: "Plan" });
  const at = (amountMinor: number) =>
    createPrice({
      organizationId: orgId,
      businessId: hb.id,
      productId: plan.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const started = new Date("2026-03-01T00:00:00Z");
  const subAt = async (amountMinor: number, name: string) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: hb.id,
      email: `history-${name}-${Date.now()}@example.test`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: hb.id,
      customer: c,
      token: "tok_4242",
    });
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: hb.id,
      customerId: c.id,
      now: started,
      items: [{ price: await at(amountMinor), quantity: 1 }],
    });
    return subscription;
  };
  const move = (
    sub: { id: string; customerId: string },
    reason: string,
    previous: bigint,
    next: bigint,
    occurredAt: Date,
  ) =>
    systemDb.insert(mrrMovements).values({
      organizationId: orgId,
      businessId: hb.id,
      subscriptionId: sub.id,
      customerId: sub.customerId,
      reason,
      planProductId: plan.id,
      previousPlanProductId: plan.id,
      currency: "USD",
      previousMrrMinor: previous,
      newMrrMinor: next,
      deltaMinor: next - previous,
      occurredAt,
    });

  const grown = await subAt(5000, "grown");
  const may = new Date("2026-05-01T00:00:00Z");
  await move(grown, "expansion", 5000n, 8000n, may);
  await systemDb.update(subscriptions).set({ mrr: 8000n }).where(eq(subscriptions.id, grown.id));

  const back = await subAt(9000, "back");
  const june = new Date("2026-06-01T00:00:00Z");
  await move(back, "churn", 9000n, 0n, june);
  await move(back, "reactivation", 0n, 4000n, june);
  await systemDb
    .update(subscriptions)
    .set({ mrr: 4000n, startedAt: june, startDate: june })
    .where(eq(subscriptions.id, back.id));

  const totalOn = async (day: string) =>
    (await withTenant(orgId, (tx) => computeSnapshot(tx, hb.id, day, undefined, "UTC"))).find(
      (r) => r.currency === "USD",
    );
  const plansOn = async (day: string) =>
    (await withTenant(orgId, (tx) => computeSnapshotByPlan(tx, hb.id, day, undefined, "UTC")))
      .filter((r) => r.currency === "USD")
      .reduce((a, r) => a + r.mrrMinor, 0n);
  const april = await totalOn("2026-04-15");
  const mid = await totalOn("2026-05-15");
  const later = await totalOn("2026-06-15");
  console.log(
    "history:",
    JSON.stringify({ april, mid, later }, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
  );
  ok(
    "history: before the expansion a day reads the old rate, not today's",
    april?.mrrMinor === 14000n,
  );
  ok("history: …and the expansion lands on its own day", mid?.mrrMinor === 17000n);
  ok(
    "history: the reactivation's lower rate applies only from its day",
    later?.mrrMinor === 12000n,
  );
  ok(
    "history: a reactivated subscription still earns — and is active — before its reset start",
    april?.payingSubscriptions === 2 && april?.activeSubscriptions === 2,
  );
  ok(
    "history: the plan rows sum to the total on a restated day",
    (await plansOn("2026-04-15")) === 14000n,
  );

  // The same rule on the paths that rebuild instead of storing: a report with nothing stored,
  // and the ratio measures' opening cohort.
  const aprilEnd = new Date("2026-04-15T23:59:59.999Z");
  const report = (key: string) =>
    resolveReport(orgId, hb.id, key, { currency: "USD", now: aprilEnd });
  const rebuiltMrr = await report("total_mrr");
  const rebuiltPaying = await report("total_paying_customers");
  const ratios = await withTenant(orgId, (tx) =>
    computeRatioMeasures({
      tx,
      businessId: hb.id,
      from: new Date("2026-04-01T00:00:00Z"),
      toExclusive: new Date("2026-05-01T00:00:00Z"),
      periodEnd: "2026-04-30",
      zone: "UTC",
    }),
  );
  const ratio = (m: string) => ratios.find((r) => r.measure === m && r.currency === "USD");
  console.log(
    "history rebuilt:",
    JSON.stringify(
      {
        mrr: rebuiltMrr.headline,
        paying: rebuiltPaying.headline,
        grr: ratio("gross_revenue_retention"),
        rppc: ratio("revenue_per_paying_customer"),
      },
      (_, v) => (typeof v === "bigint" ? `${v}` : v),
    ),
  );
  ok("history: a rebuilt report reads the old rate too", rebuiltMrr.headline === 14000);
  ok("history: …and counts both paying customers then", rebuiltPaying.headline === 2);
  ok(
    "history: retention opens on the rates the book held then",
    ratio("gross_revenue_retention")?.denominator === 14000n,
  );
  ok(
    "history: revenue per paying customer counts the head that was paying then",
    ratio("revenue_per_paying_customer")?.denominator === 2n,
  );
}

// ── Active ⊇ Paying ⊇ Renewing ────────────────────────────────────────────────
// One subscription of each: paying and renewing, paying but booked to stop at its term's end,
// and live at $0. Today they count 3 / 2 / 1; two months back the booked one was mid-life,
// not in its final term, so it was still renewing then.
{
  const rb = await createBusiness({
    organizationId: orgId,
    name: "Renewing Counts",
    defaultCurrency: "USD",
    timezone: "UTC",
    livemode: "test",
  });
  const plan = await createProduct({ organizationId: orgId, businessId: rb.id, name: "Plan" });
  const priced = (amountMinor: number) =>
    createPrice({
      organizationId: orgId,
      businessId: rb.id,
      productId: plan.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor,
      interval: "month",
    });
  const started = new Date(Date.now() - 120 * 86_400_000);
  const termEnd = new Date(Date.now() + 10 * 86_400_000);
  const sub = async (amountMinor: number, name: string) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: rb.id,
      email: `renewing-${name}-${Date.now()}@example.test`,
    });
    await vaultPaymentMethod({
      organizationId: orgId,
      businessId: rb.id,
      customer: c,
      token: "tok_4242",
    });
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: rb.id,
      customerId: c.id,
      now: started,
      items: [{ price: await priced(amountMinor), quantity: 1 }],
    });
    // A term running now, ending in ten days — and parked there, so no worker renews it.
    await systemDb
      .update(subscriptions)
      .set({
        currentPeriodStart: new Date(termEnd.getTime() - 30 * 86_400_000),
        currentPeriodEnd: termEnd,
      })
      .where(eq(subscriptions.id, subscription.id));
    return subscription;
  };
  await sub(5000, "renews");
  const leaving = await sub(4000, "leaving");
  await sub(0, "free");
  await cancelSubscription({
    organizationId: orgId,
    businessId: rb.id,
    subscriptionId: leaving.id,
    atPeriodEnd: true,
    now: new Date(),
  });

  const todayDay = new Date().toISOString().slice(0, 10);
  const pastDay = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const snap = async (d: string) =>
    (await withTenant(orgId, (tx) => computeSnapshot(tx, rb.id, d, undefined, "UTC"))).find(
      (r) => r.currency === "USD",
    );
  const now = await snap(todayDay);
  const past = await snap(pastDay);
  console.log(
    "renewing:",
    JSON.stringify({
      now: [now?.activeSubscriptions, now?.payingSubscriptions, now?.renewingSubscriptions],
      past: [past?.activeSubscriptions, past?.payingSubscriptions, past?.renewingSubscriptions],
    }),
  );
  ok(
    "renewing: today — active 3 ⊇ paying 2 ⊇ renewing 1",
    now?.activeSubscriptions === 3 &&
      now?.payingSubscriptions === 2 &&
      now?.renewingSubscriptions === 1,
  );
  ok(
    "renewing: two months back the booked one was not in its final term — it was renewing",
    past?.payingSubscriptions === 2 && past?.renewingSubscriptions === 2,
  );
  const report = await resolveReport(orgId, rb.id, "total_renewing_subscriptions", {
    currency: "USD",
    now: new Date(),
  });
  ok("renewing: the report says the same", report.headline === 1);
  const home = await computeBusinessAnalytics(orgId, rb.id, {
    range: "daily",
    currency: "USD",
    now: new Date(),
  });
  ok(
    "renewing: Business Home — paying includes the non-renewing one, renewing does not",
    home.kpis.paying_subscriptions.value === 2 && home.kpis.renewing_subscriptions.value === 1,
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
