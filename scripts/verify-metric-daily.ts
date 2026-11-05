/**
 * The ORACLE GATE for `metric_daily` (0267).
 *
 * A materialised number is only worth having if it still equals the live reconstruction it
 * replaces. So this suite seeds its own book, writes a period through
 * `computeMetricPeriod` → `writeMetricDay`, reads the stored rows back, and compares EVERY
 * measure on EVERY dimension against an oracle built independently: `snapshots.ts` for the
 * stocks, an in-suite aggregation of the movement ledger — its own window arithmetic, its
 * own grouping, its own sign rule — for the flows, and the suite's own predicates over its
 * own rows for the book counts. Re-calling the writer's own helpers would prove only that it
 * agrees with itself.
 *
 * Seven properties, in the order a wrong writer breaks them:
 *   1. stored == reconstructed, per measure per dimension per currency, both directions;
 *   2. the plan slice and the country slice each sum to the unsliced total;
 *   3. a STOCK takes the period's last day, never the sum of its days (~30x if summed);
 *   4. a FLOW tiles — a month equals the sum of its days, and a movement on a boundary
 *      instant is counted once, not twice and not zero times;
 *   5. losses are stored as POSITIVE magnitudes;
 *   6. a measured zero is a row; only a MISSING row means "not computed";
 *   7. the book counts mean what they say — units are not a headcount, a cancelled
 *      subscription still exists, and a signup is an account with no currency.
 *
 *   pnpm verify:metric-daily
 */
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  pauseSubscription,
} from "@/modules/subscriptions/service";
import { applyManualDiscount } from "@/modules/coupons/service";
import {
  computeSnapshot,
  computeSnapshotByPlan,
  computeSnapshotByCountry,
} from "@/modules/metrics/snapshots";
import { computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { computeBusinessAnalytics } from "@/modules/metrics/analytics";
import { writeMetricDay, type MetricDailyRow } from "@/modules/metrics/daily/write";
import { bookScopes } from "@/modules/metrics/book-scope";
import {
  MEASURES,
  measureById,
  supportsDimension,
  type Grain,
} from "@/modules/metrics/daily/measures";
import { customers, metricDaily, mrrMovements, subscriptionItems, subscriptions } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

/** Measure sources fixtured by a SIBLING gate — see the coverage section for the pairing. */
const DELEGATED_SOURCES = new Set([
  "invoices",
  "transactions",
  "payments",
  "payment_methods",
  "derived",
  "customer_grain",
  "scheduled",
  "disputes",
  "read_time",
  "credits",
  "usage",
  "orders",
]);

/** Dimensions fixtured by `verify:metric-dimensions`. */
const DELEGATED_DIMS = new Set([
  "billing_interval",
  "region",
  "plan_at_start",
  "signup_cohort",
  "churn_kind",
]);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** Every seeded term ends here — past the real clock, so the billing worker never renews. */
const PARKED = day("2028-01-01");

// ─────────────────────────────────────────────────────────────────────────────
// Seed — its own organization and business, never the dev database's book.
// ─────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Metric Daily Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Metric Daily Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;

const starter = await createProduct({ organizationId: orgId, businessId: bizId, name: "Starter" });
const pro = await createProduct({ organizationId: orgId, businessId: bizId, name: "Pro" });
const freeTier = await createProduct({ organizationId: orgId, businessId: bizId, name: "Team" });
const support = await createProduct({
  organizationId: orgId,
  businessId: bizId,
  name: "Support",
  kind: "charge",
});

const price = (
  productId: string,
  currency: string,
  amountMinor: number,
  model: "flat" | "per_unit" = "flat",
) =>
  createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId,
    type: "recurring",
    model,
    currency,
    amountMinor,
    interval: "month",
  });
const starterUsd = await price(starter.id, "USD", 5000);
// Per unit, so one line can carry several: a flat price refuses a quantity, and units are
// exactly what `subscription_quantity` counts. 5 × 1000 is the same MRR as the flat line.
const starterSeatsUsd = await price(starter.id, "USD", 1000, "per_unit");
const starterEur = await price(starter.id, "EUR", 3000);
const proUsd = await price(pro.id, "USD", 12_000);
const teamUsd = await price(freeTier.id, "USD", 8000);
const supportUsd = await price(support.id, "USD", 1000);

let seq = 0;
async function subscribe(opts: {
  price: typeof starterUsd;
  country: string | null;
  startedOn: string;
  /** Units on the line. More than one is what tells `subscription_quantity` from a headcount. */
  quantity?: number;
}) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `oracle-${String(++seq).padStart(2, "0")}@example.test`,
    ...(opts.country ? { address: { country: opts.country } } : {}),
  });
  await systemDb
    .update(customers)
    .set({ createdAt: day(opts.startedOn) })
    .where(eq(customers.id, customer.id));
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
    now: day(opts.startedOn),
    startDate: day(opts.startedOn),
    items: [{ price: opts.price, quantity: opts.quantity ?? 1 }],
  });
  // Park BOTH clocks past the real one. A live worker sharing this database renews anything
  // already due, mid-seed, a few at a time — which is how the same seed produced 11, 15, 18
  // and 21 invoices on four runs. A parked term is never due, so there is nothing to claim.
  // …and backdate the row with its term: `subscriptions_total` counts existence, so a book
  // whose every subscription was created today has no history to count.
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: PARKED, trialEnd: PARKED, createdAt: day(opts.startedOn) })
    .where(eq(subscriptions.id, subscription.id));
  return { customer, subscription };
}

// 2 currencies, 4 plans + a charges-only line, 2 countries + one customer with none.
const s1 = await subscribe({
  price: starterSeatsUsd,
  country: "DE",
  startedOn: "2026-01-10",
  quantity: 5,
});
const s2 = await subscribe({ price: proUsd, country: "FR", startedOn: "2026-01-25" });
const s3 = await subscribe({ price: starterEur, country: "DE", startedOn: "2026-02-20" });
const s4 = await subscribe({ price: supportUsd, country: null, startedOn: "2026-03-01" });
const s5 = await subscribe({ price: starterUsd, country: "FR", startedOn: "2026-02-14" });
const s6 = await subscribe({ price: starterEur, country: null, startedOn: "2026-04-05" });
const s7 = await subscribe({ price: teamUsd, country: null, startedOn: "2026-03-18" });

// Cancelled outright, booked to stop, and paused — three shapes the stock predicates treat
// differently, and the reason the EUR book has a cmrr of exactly zero below.
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: s3.subscription.id,
  atPeriodEnd: false,
  now: day("2026-05-14"),
});
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: s6.subscription.id,
  atPeriodEnd: true,
  now: day("2026-06-20"),
});
await pauseSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: s5.subscription.id,
});
// Active, live, and worth nothing — a measured zero rather than an absent figure.
await applyManualDiscount({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: s7.subscription.id,
  kind: "percentage",
  percentOffBps: 10_000,
  durationType: "forever",
  now: day("2026-03-18"),
});

/**
 * The book's own stamps — trials, activations, cancellations — written EXPLICITLY, for the
 * same reason the ledger below is: the services stamp them at wall clock, which lies outside
 * every sampled period, and a gate about window arithmetic cannot be built on rows it cannot
 * date. None of these columns feeds a stock predicate, so the MRR figures are untouched.
 */
const stamp = (id: string, set: Record<string, Date>) =>
  systemDb.update(subscriptions).set(set).where(eq(subscriptions.id, id));

// Two trials that CONVERTED: the trial ends at the moment billing starts, so "in trial"
// comes back down where "trials to date" cannot. Both subscriptions are `active`, so a dated
// trial end cannot put a term back in front of the clock.
await stamp(s7.subscription.id, {
  trialStart: new Date("2026-02-15T09:00:00.000Z"),
  trialEnd: new Date("2026-02-15T10:00:00.000Z"),
  activatedAt: new Date("2026-02-15T10:00:00.000Z"),
});
await stamp(s2.subscription.id, {
  trialStart: new Date("2026-06-11T09:00:00.000Z"),
  trialEnd: new Date("2026-06-25T09:00:00.000Z"),
  activatedAt: new Date("2026-06-25T09:00:00.000Z"),
});
// A trial that never converted, in the other currency — and has no end on file, so it is
// still running on every sampled day.
await stamp(s6.subscription.id, { trialStart: new Date("2026-04-30T12:00:00.000Z") });
// The paused line stops for good, on the day its churn movement is filed.
await stamp(s5.subscription.id, { canceledAt: new Date("2026-06-19T10:00:00.000Z") });
// …and one exactly on a month boundary: it belongs to July, never to June.
await stamp(s4.subscription.id, { canceledAt: new Date("2026-07-01T00:00:00.000Z") });

// Two customers who joined and nothing else — a signup is an ACCOUNT, so it counts with no
// subscription behind it. Countries kept to the two already on file.
for (const [at, country] of [
  ["2026-06-30T12:00:00.000Z", "DE"],
  ["2026-07-14T08:00:00.000Z", null],
] as const) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `oracle-signup-${at.slice(0, 10)}@example.test`,
    ...(country ? { address: { country } } : {}),
  });
  await systemDb
    .update(customers)
    .set({ createdAt: new Date(at) })
    .where(eq(customers.id, c.id));
}

/**
 * The movement ledger, written EXPLICITLY.
 *
 * `occurred_at` is append-only (no UPDATE grant) and only `createSubscription` stamps the
 * caller's clock, so a backdated cancel files its movement at wall clock. A gate about
 * window arithmetic cannot be built on rows it cannot date, so the flow story is inserted
 * at exact instants — including the two that decide a boundary.
 */
const flow = (
  at: string,
  reason: string,
  sub: { subscription: { id: string }; customer: { id: string } },
  currency: string,
  previous: number,
  next: number,
  planProductId: string | null,
) => ({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: sub.subscription.id,
  customerId: sub.customer.id,
  reason,
  planProductId,
  currency,
  previousMrrMinor: BigInt(previous),
  newMrrMinor: BigInt(next),
  deltaMinor: BigInt(next - previous),
  occurredAt: new Date(at),
});

await withTenant(orgId, (tx) =>
  tx.insert(mrrMovements).values([
    // June, spread across days — what the month must equal the sum of.
    flow("2026-06-02T09:00:00.000Z", "new", s1, "USD", 0, 4000, starter.id),
    flow("2026-06-11T13:30:00.000Z", "new", s2, "USD", 0, 2500, pro.id),
    flow("2026-06-11T18:00:00.000Z", "new", s3, "EUR", 0, 900, starter.id),
    // NULL plan — a real bucket, not an excluded one. The plan slice must keep it or it
    // stops summing to the total.
    flow("2026-06-17T08:00:00.000Z", "new", s4, "USD", 0, 1100, null),
    // The losses, which every measure states as a positive amount lost.
    flow("2026-06-08T10:00:00.000Z", "contraction", s2, "USD", 2500, 900, pro.id),
    flow("2026-06-19T10:00:00.000Z", "churn", s5, "USD", 4200, 0, starter.id),
    flow("2026-06-23T10:00:00.000Z", "pause", s7, "USD", 3300, 0, freeTier.id),
    flow("2026-06-05T10:00:00.000Z", "expansion", s1, "USD", 4000, 6000, starter.id),
    flow("2026-06-27T10:00:00.000Z", "reactivation", s6, "EUR", 0, 700, starter.id),
    // `resume` carries no measure of its own — it must not leak into one.
    flow("2026-06-28T10:00:00.000Z", "resume", s7, "USD", 0, 3300, freeTier.id),
    // ── The boundary. The last instant June can hold, and the first July can. ──────────
    flow("2026-06-30T23:59:59.999Z", "new", s1, "USD", 0, 777, starter.id),
    flow("2026-07-01T00:00:00.000Z", "new", s2, "USD", 0, 888, pro.id),
    flow("2026-07-14T10:00:00.000Z", "new", s1, "USD", 0, 1500, starter.id),
    // Earlier months, so the sampled days are not all the same book.
    flow("2026-02-15T12:00:00.000Z", "new", s1, "USD", 0, 2000, starter.id),
    flow("2026-03-31T23:00:00.000Z", "expansion", s1, "USD", 2000, 3000, starter.id),
    flow("2026-04-30T00:00:00.000Z", "churn", s3, "EUR", 1500, 0, starter.id),
  ]),
);

const BOUNDARY_NEW_MINOR = 777n;

/**
 * The periods every property below is checked on. Both grains, deliberately: a DAY sees a
 * stock and whatever moved that day, and only a MONTH exercises the aggregation rules —
 * which is where a stock summed like a flow, or a window that does not tile, actually
 * shows.
 */
const SAMPLED: Array<[Grain, string]> = [
  ["day", "2026-02-15"],
  ["day", "2026-03-31"],
  ["day", "2026-04-30"],
  ["day", "2026-05-14"],
  ["day", "2026-06-30"],
  ["day", "2026-07-01"],
  ["month", "2026-06-30"],
  ["month", "2026-07-31"],
];

// ─────────────────────────────────────────────────────────────────────────────
// 0. The seed's SHAPE, before any figure is compared.
// A worker that renewed something mid-seed changes every number below; naming the race
// once here is worth more than fifty diffs that all say the same thing.
// ─────────────────────────────────────────────────────────────────────────────
{
  const subs = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: subscriptions.id,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        trialEnd: subscriptions.trialEnd,
        currency: subscriptions.currency,
      })
      .from(subscriptions)
      .where(eq(subscriptions.businessId, bizId)),
  );
  ok("seed: exactly 7 subscriptions", subs.length === 7);
  ok(
    "seed: every term parked past both clocks — no renewal can race the fixture",
    subs.every((s) => (s.currentPeriodEnd?.getTime() ?? 0) >= PARKED.getTime()),
  );
  // The two converted trials carry a real end; every other trial end stays parked. An
  // `in_trial` subscription with a dated end WOULD be claimable, so this counts them.
  ok(
    "seed: exactly the two converted trials have an end on file, and neither is in trial",
    subs.filter((s) => (s.trialEnd?.getTime() ?? 0) < PARKED.getTime()).length === 2,
  );
  ok("seed: two currencies held", new Set(subs.map((s) => s.currency)).size === 2);

  const moves = await withTenant(orgId, (tx) =>
    tx
      .select({ id: mrrMovements.id, occurredAt: mrrMovements.occurredAt })
      .from(mrrMovements)
      .where(eq(mrrMovements.businessId, bizId)),
  );
  // 16 inserted above + 7 opening moves + the 2 the seed's backdated service calls file,
  // now that a movement carries the instant its operation took effect rather than the
  // clock. The count is what a stray renewal would move, so it is pinned.
  const seeded = moves.filter((m) => m.occurredAt < day("2026-08-01"));
  ok("seed: 25 dated movements, none added or lost", seeded.length === 25);
  if (seeded.length !== 25) console.log(`  ↳ dated movements: ${seeded.length}, expected 25`);

  const countries = await withTenant(orgId, (tx) =>
    tx
      .select({ country: customers.country })
      .from(customers)
      .where(eq(customers.businessId, bizId)),
  );
  ok(
    "seed: 2 countries on file plus customers with none",
    new Set(countries.map((c) => c.country).filter(Boolean)).size === 2 &&
      countries.some((c) => c.country == null),
  );
  ok("seed: 9 customers — 7 with a subscription, 2 who only signed up", countries.length === 9);

  const stamps = await withTenant(orgId, (tx) =>
    tx
      .select({
        trialStart: subscriptions.trialStart,
        activatedAt: subscriptions.activatedAt,
        canceledAt: subscriptions.canceledAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.businessId, bizId)),
  );
  const stampCounts = [
    stamps.filter((s) => s.trialStart != null).length,
    stamps.filter((s) => s.activatedAt != null).length,
    stamps.filter((s) => s.canceledAt != null).length,
  ];
  // Every subscription activates when it starts, so all 7 carry an activation; two of them
  // were moved onto sampled periods above, along with 3 trials and 3 cancellations.
  ok(
    "seed: 3 trials, 7 activations and 3 cancellations, dated where the sampled periods see them",
    stampCounts.join() === "3,7,3",
  );
  if (stampCounts.join() !== "3,7,3") {
    console.log(`  \u21b3 trials/activations/cancels: ${stampCounts.join("/")}`);
  }

  const units = await withTenant(orgId, (tx) =>
    tx
      .select({ quantity: subscriptionItems.quantity })
      .from(subscriptionItems)
      .where(eq(subscriptionItems.businessId, bizId)),
  );
  ok(
    "seed: one line carries 5 units — units and a headcount cannot be confused",
    units.some((u) => u.quantity === 5),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The oracle for flows — this suite's OWN arithmetic, deliberately not the writer's.
// ─────────────────────────────────────────────────────────────────────────────
const LOSS = new Set(["contraction", "churn", "pause"]);
const FLOW_MEASURE: Record<string, string> = {
  new: "mrr_new",
  expansion: "mrr_expansion",
  reactivation: "mrr_reactivation",
  contraction: "mrr_contraction",
  churn: "mrr_churn",
  pause: "mrr_paused",
};
const FLOW_KEYS = new Set(Object.values(FLOW_MEASURE));

/** `[start, next)`, from the calendar. A period that does not tile is not a period. */
function windowOf(grain: Grain, periodEnd: string): [Date, Date] {
  const end = day(periodEnd);
  const next = new Date(end);
  next.setUTCDate(next.getUTCDate() + 1);
  const y = end.getUTCFullYear();
  const m = end.getUTCMonth();
  if (grain === "day") return [end, next];
  if (grain === "week") {
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 6);
    return [start, next];
  }
  if (grain === "year") return [new Date(Date.UTC(y, 0, 1)), next];
  if (grain === "quarter") return [new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1)), next];
  return [new Date(Date.UTC(y, m, 1)), next];
}

const ledger = await withTenant(orgId, (tx) =>
  tx
    .select({
      reason: mrrMovements.reason,
      currency: mrrMovements.currency,
      planProductId: mrrMovements.planProductId,
      delta: mrrMovements.deltaMinor,
      occurredAt: mrrMovements.occurredAt,
      country: customers.country,
    })
    .from(mrrMovements)
    .leftJoin(customers, eq(customers.id, mrrMovements.customerId))
    .where(eq(mrrMovements.businessId, bizId)),
);

/**
 * The oracle for the BOOK measures — the suite's own rows and its own predicates.
 *
 * Deliberately spelled out rather than imported from `stocks.ts`: the writer calls those, so
 * reusing them would prove only that the writer agrees with itself. `liveHere` is the same
 * rule written twice on purpose.
 */
const book = await withTenant(orgId, (tx) =>
  tx
    .select({
      id: subscriptions.id,
      status: subscriptions.status,
      currency: subscriptions.currency,
      createdAt: subscriptions.createdAt,
      startDate: subscriptions.startDate,
      startedAt: subscriptions.startedAt,
      canceledAt: subscriptions.canceledAt,
      trialStart: subscriptions.trialStart,
      trialEnd: subscriptions.trialEnd,
      activatedAt: subscriptions.activatedAt,
    })
    .from(subscriptions)
    .where(eq(subscriptions.businessId, bizId)),
);
const items = await withTenant(orgId, (tx) =>
  tx
    .select({
      subscriptionId: subscriptionItems.subscriptionId,
      quantity: subscriptionItems.quantity,
    })
    .from(subscriptionItems)
    .where(eq(subscriptionItems.businessId, bizId)),
);
const unitsOf = (id: string) =>
  items.filter((i) => i.subscriptionId === id).reduce((n, i) => n + i.quantity, 0);
const roster = await withTenant(orgId, (tx) =>
  tx
    .select({ id: customers.id, createdAt: customers.createdAt })
    .from(customers)
    .where(eq(customers.businessId, bizId)),
);

type BookSub = (typeof book)[number];
const startsAt = (s: BookSub) => s.startedAt ?? s.startDate ?? s.createdAt;
/** Had started by `at` and had not stopped — the MRR statuses only. */
const liveHere = (s: BookSub, at: Date) =>
  new Set(["active", "in_trial", "cancelled"]).has(s.status) &&
  startsAt(s) <= at &&
  (s.canceledAt == null || s.canceledAt > at);

type Key = string;
const key = (measure: string, dim: string, dimValue: string, currency: string): Key =>
  `${measure}|${dim}|${dimValue}|${currency}`;

/** What the period SHOULD hold: stocks from `snapshots.ts`, flows from the ledger. */
async function oracle(grain: Grain, periodEnd: string): Promise<Map<Key, bigint>> {
  const want = new Map<Key, bigint>();
  const put = (k: Key, v: bigint) => want.set(k, (want.get(k) ?? 0n) + v);

  for (const r of await withTenant(orgId, (tx) => computeSnapshot(tx, bizId, periodEnd))) {
    put(key("mrr", "", "", r.currency), r.mrrMinor);
    put(key("arr", "", "", r.currency), r.mrrMinor * 12n);
    put(key("cmrr", "", "", r.currency), r.cmrrMinor);
    put(key("active_subscriptions", "", "", r.currency), BigInt(r.activeSubscriptions));
    put(key("paying_subscriptions", "", "", r.currency), BigInt(r.payingSubscriptions));
    put(key("renewing_subscriptions", "", "", r.currency), BigInt(r.renewingSubscriptions));
  }
  for (const r of await withTenant(orgId, (tx) => computeSnapshotByPlan(tx, bizId, periodEnd))) {
    const v = r.planProductId ?? "none";
    put(key("mrr", "plan", v, r.currency), r.mrrMinor);
    put(key("arr", "plan", v, r.currency), r.mrrMinor * 12n);
    put(key("active_subscriptions", "plan", v, r.currency), BigInt(r.activeSubscriptions));
    put(key("paying_subscriptions", "plan", v, r.currency), BigInt(r.payingSubscriptions));
    put(key("renewing_subscriptions", "plan", v, r.currency), BigInt(r.renewingSubscriptions));
  }
  for (const r of await withTenant(orgId, (tx) => computeSnapshotByCountry(tx, bizId, periodEnd))) {
    const v = r.country ?? "none";
    put(key("mrr", "country", v, r.currency), r.mrrMinor);
    put(key("arr", "country", v, r.currency), r.mrrMinor * 12n);
    put(key("active_subscriptions", "country", v, r.currency), BigInt(r.activeSubscriptions));
    put(key("paying_subscriptions", "country", v, r.currency), BigInt(r.payingSubscriptions));
    put(key("renewing_subscriptions", "country", v, r.currency), BigInt(r.renewingSubscriptions));
  }

  const [from, to] = windowOf(grain, periodEnd);
  for (const m of ledger) {
    if (m.occurredAt < from || m.occurredAt >= to) continue;
    const measure = FLOW_MEASURE[m.reason];
    if (!measure) continue;
    const value = LOSS.has(m.reason) ? -m.delta : m.delta;
    put(key(measure, "", "", m.currency), value);
    put(key(measure, "plan", m.planProductId ?? "none", m.currency), value);
    put(key(measure, "country", m.country ? m.country.toUpperCase() : "none", m.currency), value);
  }
  // A currency with a movement before the period's end writes every flow total, zero included.
  for (const ccy of new Set(ledger.filter((m) => m.occurredAt < to).map((m) => m.currency))) {
    for (const measure of Object.values(FLOW_MEASURE)) put(key(measure, "", "", ccy), 0n);
  }

  // The book, per currency. Stocks at the period's last instant, flows stamped inside it.
  const at = new Date(`${periodEnd}T23:59:59.999Z`);
  const inWindow = (t: Date | null) => t != null && t >= from && t < to;
  for (const ccy of new Set(book.map((s) => s.currency.toUpperCase()))) {
    const subs = book.filter((s) => s.currency.toUpperCase() === ccy);
    const held = subs.some((s) => s.createdAt <= at);
    if (held) {
      put(
        key("subscriptions_total", "", "", ccy),
        BigInt(subs.filter((s) => s.createdAt <= at).length),
      );
      put(
        key("subscription_quantity", "", "", ccy),
        subs.reduce((n, s) => n + (liveHere(s, at) ? BigInt(unitsOf(s.id)) : 0n), 0n),
      );
      put(
        key("trials_cumulative", "", "", ccy),
        BigInt(subs.filter((s) => s.trialStart != null && s.trialStart <= at).length),
      );
      // In trial AT that instant. No status test — a trial is a window on the row, and the
      // only disqualification is having gone. A null end is an open-ended trial, still on.
      put(
        key("trials_active", "", "", ccy),
        BigInt(
          subs.filter(
            (s) =>
              s.trialStart != null &&
              s.trialStart <= at &&
              (s.trialEnd == null || s.trialEnd > at) &&
              startsAt(s) <= at &&
              (s.canceledAt == null || s.canceledAt > at),
          ).length,
        ),
      );
    }
    const flowsOf: Array<[string, (s: BookSub) => Date | null]> = [
      ["trials_started", (s) => s.trialStart],
      ["activations", (s) => s.activatedAt],
      ["subscription_cancellations", (s) => s.canceledAt],
    ];
    for (const [measure, stampOf] of flowsOf) {
      const n = BigInt(subs.filter((s) => inWindow(stampOf(s))).length);
      if (held) put(key(measure, "", "", ccy), n);
    }
  }

  // Signups are customer grain: no currency, so `XXX`.
  const joined = BigInt(roster.filter((c) => inWindow(c.createdAt)).length);
  put(key("customers_created", "", "", "XXX"), joined);

  return want;
}

/** Compute → write → read back. The stored side of every comparison below. */
async function materialise(grain: Grain, periodEnd: string): Promise<Map<Key, bigint | null>> {
  const rows = await withTenant(orgId, (tx) => computeMetricPeriod(tx, bizId, grain, periodEnd));
  await writeMetricDay({ organizationId: orgId, businessId: bizId, grain, periodEnd, rows });
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.grain, grain),
          eq(metricDaily.periodEnd, periodEnd),
        ),
      ),
  );
  ok(
    `${grain} ${periodEnd}: every computed row survived the write (no key collision)`,
    stored.length === rows.length,
  );
  /**
   * Scoped to the measures THIS gate owns. The invoice, gateway, card and derived-ratio
   * groups are fixtured in their own gates; the derived ratios are the ones that matter
   * here, because unlike the others they read this very book and would otherwise land in
   * the reconstruction comparison below as rows the oracle does not produce. The coverage
   * check further down is what stops "scoped out" from meaning "unchecked".
   */
  return new Map(
    stored
      .filter((r) => !DELEGATED_SOURCES.has(measureById(r.measure)?.source ?? ""))
      // Their oracle and slice-sum checks live in scripts/verify-metric-dimensions.ts.
      .filter((r) => !DELEGATED_DIMS.has(r.dim))
      .map((r) => [key(r.measure, r.dim, r.dimValue, r.currency), r.value]),
  );
}

const materialised = new Map<string, Map<Key, bigint | null>>();
for (const [grain, periodEnd] of SAMPLED) {
  materialised.set(`${grain}|${periodEnd}`, await materialise(grain, periodEnd));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. STORED == RECONSTRUCTED — every measure, every dimension, both directions.
// ─────────────────────────────────────────────────────────────────────────────
for (const [grain, periodEnd] of SAMPLED) {
  const label = `${grain} ${periodEnd}`;
  const want = await oracle(grain, periodEnd);
  const got = materialised.get(`${grain}|${periodEnd}`)!;
  const wrong: string[] = [];
  for (const [k, v] of want)
    if (got.get(k) !== v) wrong.push(`${k}: want ${v}, stored ${got.get(k)}`);
  const extra = [...got.keys()].filter((k) => !want.has(k));
  ok(
    `oracle ${label}: every reconstructed figure is stored, to the minor unit`,
    wrong.length === 0,
  );
  ok(
    `oracle ${label}: nothing stored that the reconstruction does not produce`,
    extra.length === 0,
  );
  if (wrong.length) console.log(`  ↳ ${label} mismatches:`, wrong.slice(0, 12));
  if (extra.length) console.log(`  ↳ ${label} unexplained rows:`, extra.slice(0, 12));
}

// The gate is only as wide as the fixture. A measure with no row on any sampled day was
// never actually checked above, and a green run would say nothing about it.
{
  const seen = new Set<string>();
  for (const got of materialised.values()) for (const k of got.keys()) seen.add(k.split("|")[0]!);
  /**
   * The invoice group is fixtured in its OWN gate — this book raises no invoices, so a
   * figure about one cannot be exercised here and a zero row would prove nothing.
   * Delegated rather than skipped: the two gates must cover the registry between them, so
   * the sibling is read and every measure it is responsible for must appear in it. An
   * orphaned measure is exactly what a per-gate coverage check stops seeing.
   */
  const DELEGATED: Array<[readonly string[], string]> = [
    [["invoices"], "scripts/verify-metric-invoices.ts"],
    [["transactions", "payments", "payment_methods"], "scripts/verify-metric-payments.ts"],
    [["derived"], "scripts/verify-metric-ratios.ts"],
    [["customer_grain"], "scripts/verify-metric-customers.ts"],
    [["scheduled"], "scripts/verify-metric-scheduled.ts"],
    // One read, so its counting rules are pinned in a unit test over that read.
    [["disputes"], "test/unit/dispute-measures.test.ts"],
    [["read_time"], "scripts/verify-mrr-fx-impact.ts"],
    [["credits"], "scripts/verify-metric-credits.ts"],
    [["usage"], "scripts/verify-metric-usage.ts"],
    [["orders"], "scripts/verify-metric-orders.ts"],
  ];
  const delegatedSources = new Set(DELEGATED.flatMap(([sources]) => sources));
  ok(
    "coverage: the delegated set here is the one `materialise` scopes by — no measure falls between the two",
    [...delegatedSources].every((s) => DELEGATED_SOURCES.has(s)) &&
      DELEGATED_SOURCES.size === delegatedSources.size,
  );
  for (const [sources, path] of DELEGATED) {
    const delegated = MEASURES.filter((m) => sources.includes(m.source)).map((m) => m.id);
    // The headline measures and the revenue mix are fixtured in gates of their own.
    const sibling =
      (await readFile(path, "utf8")) +
      (await readFile("scripts/verify-metric-new-measures.ts", "utf8")) +
      (await readFile("scripts/verify-revenue-mix.ts", "utf8"));
    const orphaned = delegated.filter((id) => !sibling.includes(`"${id}"`));
    ok(
      `coverage: the ${delegated.length} ${sources.join("/")} measures are exercised by ${path.replace("scripts/verify-", "verify:").replace(".ts", "")}`,
      orphaned.length === 0,
    );
    if (orphaned.length) console.log("  ↳ measures no gate exercises:", orphaned);
  }

  const mine = MEASURES.filter((m) => !delegatedSources.has(m.source));
  const missing = mine.map((m) => m.id).filter((id) => !seen.has(id));
  ok(
    `coverage: all ${mine.length} subscription-side registry measures appear on a sampled day`,
    missing.length === 0,
  );
  if (missing.length) console.log("  ↳ measures never exercised:", missing);

  const dims = new Set<string>();
  for (const got of materialised.values()) for (const k of got.keys()) dims.add(k.split("|")[1]!);
  ok(
    "coverage: the total, the plan slice and the country slice are all exercised",
    dims.size === 3,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SLICES SUM TO THE TOTAL — including the null-plan and no-country buckets.
// ─────────────────────────────────────────────────────────────────────────────
for (const [grain, periodEnd] of SAMPLED) {
  const label = `${grain} ${periodEnd}`;
  const got = materialised.get(`${grain}|${periodEnd}`)!;
  const totals = new Map<string, bigint>();
  const sliced = new Map<string, bigint>();
  for (const [k, v] of got) {
    if (v == null) continue;
    const [measure, dim, , currency] = k.split("|") as [string, string, string, string];
    if (dim === "") totals.set(`${measure}|${currency}`, v);
    else
      sliced.set(
        `${measure}|${dim}|${currency}`,
        (sliced.get(`${measure}|${dim}|${currency}`) ?? 0n) + v,
      );
  }
  const broken: string[] = [];
  for (const [sk, sum] of sliced) {
    const [measure, dim, currency] = sk.split("|") as [string, string, string];
    const total = totals.get(`${measure}|${currency}`);
    if (total !== sum)
      broken.push(`${measure}/${dim}/${currency}: slices ${sum} vs total ${total}`);
  }
  // And the other way: a DECLARED dimension with no rows at all is one silently dropped —
  // the registry says which combinations are real, so `cmrr` is not asked for a plan here.
  // A zero total has nothing to break down: an empty breakdown already sums to it.
  for (const [tk, tv] of totals) {
    if (tv === 0n) continue;
    const [measure, currency] = tk.split("|") as [string, string];
    const def = MEASURES.find((m) => m.id === measure);
    if (!def) continue;
    for (const dim of ["plan", "country"]) {
      if (!supportsDimension(def, dim)) continue;
      if (!sliced.has(`${measure}|${dim}|${currency}`)) {
        broken.push(`${measure}/${dim}/${currency}: declared dimension, no slice rows at all`);
      }
    }
  }
  ok(
    `slices ${label}: plan and country each sum to the unsliced total, exactly`,
    broken.length === 0,
  );
  if (broken.length) console.log(`  ↳ ${label} slice breaks:`, broken.slice(0, 12));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. A STOCK IS NOT SUMMED. `mrr` for a month is its LAST day, never the month's total —
// summing it inflates the figure by roughly the number of days in the period.
// ─────────────────────────────────────────────────────────────────────────────
{
  const month = materialised.get("month|2026-06-30")!;
  const lastDay = materialised.get("day|2026-06-30")!;
  const stockIds = MEASURES.filter((m) => m.aggregate === "last").map((m) => m.id);

  const disagreed: string[] = [];
  for (const [k, v] of month) {
    const [measure] = k.split("|") as [string];
    if (!stockIds.includes(measure)) continue;
    if (lastDay.get(k) !== v) disagreed.push(`${k}: month ${v}, last day ${lastDay.get(k)}`);
  }
  ok(
    "stock: every `last` measure at grain=month equals the month's LAST DAY",
    disagreed.length === 0,
  );
  if (disagreed.length) console.log("  ↳ stock disagreements:", disagreed.slice(0, 12));

  // …and the fixture can actually tell the two apart. Without this the check above passes
  // on a book whose month sum happens to equal its last day — i.e. on nothing at all.
  let summed = 0n;
  const june: string[] = [];
  for (let i = 1; i <= 30; i++) june.push(`2026-06-${String(i).padStart(2, "0")}`);
  for (const d of june) {
    const rows = await withTenant(orgId, (tx) => computeMetricPeriod(tx, bizId, "day", d));
    for (const r of rows)
      if (r.measure === "mrr" && r.dim === "" && r.currency === "USD") summed += r.value ?? 0n;
  }
  const monthMrr = month.get(key("mrr", "", "", "USD"));
  ok(
    "stock: the month's USD MRR is NOT the sum of its days (a ~30x inflation would pass otherwise)",
    summed !== monthMrr && summed > 0n,
  );
  console.log(`  mrr USD — month ${monthMrr}, sum of June's days ${summed}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. FLOWS TILE — no gap, no double count, at a boundary instant included.
// ─────────────────────────────────────────────────────────────────────────────
{
  const monthJune = materialised.get("month|2026-06-30")!;
  const monthJuly = materialised.get("month|2026-07-31")!;
  const flowIds = MEASURES.filter((m) => m.aggregate === "sum").map((m) => m.id);

  const dailySum = new Map<Key, bigint>();
  const days: string[] = [];
  for (let i = 1; i <= 30; i++) days.push(`2026-06-${String(i).padStart(2, "0")}`);
  for (const d of days) {
    const rows = await withTenant(orgId, (tx) => computeMetricPeriod(tx, bizId, "day", d));
    for (const r of rows) {
      if (!flowIds.includes(r.measure) || DELEGATED_DIMS.has(r.dim)) continue;
      // Scoped like `materialise`: a delegated group's month is checked in its own gate.
      if (DELEGATED_SOURCES.has(measureById(r.measure)?.source ?? "")) continue;
      const k = key(r.measure, r.dim, r.dimValue, r.currency);
      dailySum.set(k, (dailySum.get(k) ?? 0n) + (r.value ?? 0n));
    }
  }
  const tiling: string[] = [];
  for (const [k, v] of monthJune) {
    const [measure] = k.split("|") as [string];
    if (!flowIds.includes(measure)) continue;
    if ((dailySum.get(k) ?? 0n) !== v)
      tiling.push(`${k}: month ${v}, Σ days ${dailySum.get(k) ?? 0n}`);
  }
  for (const [k, v] of dailySum)
    if (!monthJune.has(k) && v !== 0n) tiling.push(`${k}: Σ days ${v}, month has no row`);
  ok(
    "flow: a month equals the SUM of its days, measure by measure and slice by slice",
    tiling.length === 0,
  );
  if (tiling.length) console.log("  ↳ tiling breaks:", tiling.slice(0, 12));

  // The boundary itself: a movement at the last instant June can hold.
  const d30 = materialised.get("day|2026-06-30")!;
  const d0701 = materialised.get("day|2026-07-01")!;
  const k = key("mrr_new", "", "", "USD");
  const june30 = d30.get(k) ?? 0n;
  const july01 = d0701.get(k) ?? 0n;
  ok(
    "boundary: the 23:59:59.999 movement lands in its own day, once",
    june30 === BOUNDARY_NEW_MINOR,
  );
  ok("boundary: …and NOT also in the next day (double counting)", july01 === 888n);
  ok(
    "boundary: …counted once by the month that owns it",
    (monthJune.get(k) ?? 0n) - (dailySum.get(k) ?? 0n) === 0n,
  );
  ok(
    "boundary: …and zero times by the month that does not",
    (monthJuly.get(k) ?? 0n) === 888n + 1500n,
  );
  // Two adjacent months must partition the movements they span — neither losing one at the
  // seam nor claiming one twice.
  const spanned = ledger.filter(
    (m) =>
      m.reason === "new" &&
      m.currency === "USD" &&
      m.occurredAt >= day("2026-06-01") &&
      m.occurredAt < day("2026-08-01"),
  );
  const spannedTotal = spanned.reduce((a, m) => a + m.delta, 0n);
  ok(
    "boundary: June + July = every movement in June and July, each exactly once",
    (monthJune.get(k) ?? 0n) + (monthJuly.get(k) ?? 0n) === spannedTotal,
  );

  // `resume` carries no measure. It must not silently arrive as one.
  const leaked = [...monthJune.keys()].filter((mk) => mk.startsWith("mrr_resume"));
  ok("flow: a `resume` movement does not leak into a measure of its own", leaked.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SIGN CONVENTION — losses are POSITIVE magnitudes.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = materialised.get("month|2026-06-30")!;
  const losses: Array<[string, bigint]> = [
    ["mrr_contraction", 1600n],
    ["mrr_churn", 4200n],
    ["mrr_paused", 3300n],
  ];
  for (const [measure, magnitude] of losses) {
    const v = june.get(key(measure, "", "", "USD"));
    ok(`sign: ${measure} is stored as +${magnitude}, not −${magnitude}`, v === magnitude);
  }
  // Every loss row, on every slice — a sign that flips on a breakdown only is just as fatal
  // to a waterfall, and one spot check would not see it.
  const lossIds = new Set(losses.map(([m]) => m));
  const negatives = [...june.entries()].filter(
    ([k, v]) => lossIds.has(k.split("|")[0]!) && v != null && v < 0n,
  );
  ok("sign: no loss row is negative on ANY slice", negatives.length === 0);
  // And a gain is left alone.
  ok("sign: a gain keeps its own sign", june.get(key("mrr_expansion", "", "", "USD")) === 2000n);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. NULL vs ZERO vs MISSING. A measured zero is a ROW; absence means "not computed".
// ─────────────────────────────────────────────────────────────────────────────
{
  const d = materialised.get("day|2026-06-30")!;
  const eurCmrr = d.get(key("cmrr", "", "", "EUR"));
  ok(
    "zero: EUR is held and committed to nothing — cmrr is a row valued 0n, not a missing row",
    eurCmrr === 0n,
  );
  const teamPaying = [...d.entries()].filter(
    ([k, v]) => k.startsWith("paying_subscriptions|plan|") && v === 0n,
  );
  ok(
    "zero: a live subscription discounted to nothing is `paying = 0n`, present as a row",
    teamPaying.length > 0,
  );
  // The reader shows a missing row as "unknown", so a quiet flow must still write its zero.
  ok(
    "zero: EUR is held and nothing churned — mrr_churn is a row valued 0n, not a missing row",
    d.get(key("mrr_churn", "", "", "EUR")) === 0n,
  );
  // The distinction only means something if absence still means absence.
  const firstEur = Math.min(
    ...ledger.filter((m) => m.currency === "EUR").map((m) => m.occurredAt.getTime()),
  );
  const beforeEur = SAMPLED.find(
    ([g, end]) => g === "day" && windowOf(g, end)[1].getTime() <= firstEur,
  );
  const early = beforeEur ? materialised.get(`day|${beforeEur[1]}`)! : null;
  ok(
    "missing: a day before EUR's first movement writes NO EUR flow row",
    early != null &&
      ![...early.keys()].some((k) => k.endsWith("|EUR") && FLOW_KEYS.has(k.split("|")[0]!)),
  );
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select({ measure: metricDaily.measure, value: metricDaily.value })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.grain, "day"),
          eq(metricDaily.periodEnd, "2026-06-30"),
        ),
      ),
  );
  /**
   * Scoped to this gate's own measures. A NULL is legal elsewhere in the table — a lifetime
   * value with nothing yet ended is deliberately null — and "no measure here writes one" is
   * the claim being made, not "the table holds none".
   */
  const mineOnly = stored.filter(
    (r) => !DELEGATED_SOURCES.has(measureById(r.measure)?.source ?? ""),
  );
  ok(
    "zero: a 0n row survives the round trip as 0n and never as NULL",
    mineOnly.some((r) => r.value === 0n) && !mineOnly.some((r) => r.value === null),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE BOOK MEASURES — the figures the movement ledger cannot answer.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = materialised.get("month|2026-06-30")!;
  const july = materialised.get("month|2026-07-31")!;
  const d0630 = materialised.get("day|2026-06-30")!;
  const d0701 = materialised.get("day|2026-07-01")!;
  const d0215 = materialised.get("day|2026-02-15")!;
  const d0430 = materialised.get("day|2026-04-30")!;
  const cancels = (m: Map<Key, bigint | null>) =>
    m.get(key("subscription_cancellations", "", "", "USD"));

  ok(
    "book: a cancellation at the 00:00 July instant belongs to July, and June keeps its own",
    cancels(june) === 1n && cancels(july) === 1n && cancels(d0701) === 1n,
  );
  ok(
    "book: the trial and the activation are counted on their OWN stamps, not on one date",
    june.get(key("trials_started", "", "", "USD")) === 1n &&
      june.get(key("activations", "", "", "USD")) === 1n &&
      d0630.get(key("trials_started", "", "", "USD")) === 0n,
  );
  ok(
    "book: trials to date is the running total of trials started — 1 by February, 2 by June",
    d0215.get(key("trials_cumulative", "", "", "USD")) === 1n &&
      d0630.get(key("trials_cumulative", "", "", "USD")) === 2n &&
      d0430.get(key("trials_cumulative", "", "", "EUR")) === 1n,
  );
  /**
   * …and "in trial" is a DIFFERENT question, which is the whole reason it exists: the running
   * total never comes down, so on a day where a trial has since ended the two must disagree.
   * Reconstructed here from the suite's own rows rather than from the oracle above.
   */
  ok(
    "book: in trial counts trials RUNNING — both USD trials had converted by June, the total had not",
    d0630.get(key("trials_active", "", "", "USD")) === 0n &&
      d0630.get(key("trials_cumulative", "", "", "USD")) === 2n,
  );
  ok(
    "book: a trial with no end on file is still running, and a trial ends the day it converts",
    d0630.get(key("trials_active", "", "", "EUR")) === 1n &&
      d0215.get(key("trials_active", "", "", "USD")) === 0n,
  );

  // Units, not a headcount. Counted here against the suite's own live set.
  const at = new Date("2026-06-30T23:59:59.999Z");
  const live = BigInt(
    book.filter((s) => s.currency.toUpperCase() === "USD" && liveHere(s, at)).length,
  );
  const qty = d0630.get(key("subscription_quantity", "", "", "USD"));
  ok(
    "book: subscription_quantity counts UNITS — more than the subscriptions holding them",
    live > 0n && qty != null && qty > live,
  );
  console.log(`  subscription_quantity USD — ${qty} units across ${live} live subscriptions`);

  // Existence, not liveness: the cancelled and the paused stay on the total.
  ok(
    "book: the total counts every subscription that exists, cancelled ones included",
    d0630.get(key("subscriptions_total", "", "", "USD")) === 5n &&
      d0630.get(key("subscriptions_total", "", "", "EUR")) === 2n,
  );

  // A signup is an ACCOUNT — no currency, and no subscription needed behind it.
  ok(
    "book: a customer who joined and subscribed to nothing is still a signup, under XXX",
    d0630.get(key("customers_created", "", "", "XXX")) === 1n &&
      july.get(key("customers_created", "", "", "XXX")) === 1n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. STORED MRR == THE LIVE RECONSTRUCTION, for a PAST day.
//
// The check that would have caught the one this suite missed for a release: the stored
// stock summed `subscriptions.mrr` verbatim, and that column is 0 once a row is cancelled,
// so every past day lost the rate a subscription was actually being billed the moment it
// churned. Both sides here are whole pipelines — `computeMetricPeriod` → `writeMetricDay`
// → read back, against `computeBusinessAnalytics`, which re-rates cancelled rows through
// `reportingMrrBySubscription` and has always been the definition MRR means.
//
// Non-circular: analytics reads `metric_daily` first, so the stored `mrr` rows are captured
// (`materialised`) and then deleted before it is asked — the right-hand side must rebuild.
//
// EUR on 2026-04-30 is the live wire: s3 was live that day and cancelled on 2026-05-14.
// ─────────────────────────────────────────────────────────────────────────────
{
  const liveMrrOn = async (periodEnd: string, currency: string): Promise<number> => {
    const a = await computeBusinessAnalytics(orgId, bizId, {
      range: "daily",
      currency,
      // `daily` buckets end on `now`'s day, so the last point is read at exactly
      // `endOfDay(periodEnd)` — the instant the stored day is computed at.
      now: day(periodEnd),
    });
    const series = a.series.find((x) => x.key === "total_mrr");
    return series?.points.at(-1)?.v ?? 0;
  };

  await systemDb
    .delete(metricDaily)
    .where(and(eq(metricDaily.businessId, bizId), eq(metricDaily.measure, "mrr")));
  for (const [grain, periodEnd] of SAMPLED) {
    if (grain !== "day") continue;
    const got = materialised.get(`day|${periodEnd}`)!;
    for (const currency of ["USD", "EUR"]) {
      const stored = got.get(key("mrr", "", "", currency)) ?? 0n;
      const live = await liveMrrOn(periodEnd, currency);
      ok(
        `reconstruction: stored MRR on ${periodEnd} ${currency} equals the live figure (${stored} vs ${live})`,
        Number(stored) === live,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. SLICED == WHOLE (D4.5). A large book is computed a slice of customers at a time and the
// slices summed; one customer per slice must give every row the whole book gives, every
// measure, slices and halves included.
// ─────────────────────────────────────────────────────────────────────────────
{
  const canon = (rows: MetricDailyRow[]) =>
    rows
      .map((r) =>
        JSON.stringify([
          r.measure,
          r.dim,
          r.dimValue,
          r.currency,
          r.value == null ? null : String(r.value),
          "denominator" in r ? (r.denominator == null ? null : String(r.denominator)) : "-",
        ]),
      )
      .sort();
  const slices = await withTenant(orgId, (tx) => bookScopes(tx, bizId, 1));
  ok(`sliced: one customer per slice cuts this book in ${slices.length}`, slices.length > 2);
  const runAt = new Date();
  for (const [grain, periodEnd] of SAMPLED) {
    const whole = canon(
      await withTenant(orgId, (tx) => computeMetricPeriod(tx, bizId, grain, periodEnd, runAt)),
    );
    const cut = canon(
      await withTenant(orgId, (tx) =>
        computeMetricPeriod(tx, bizId, grain, periodEnd, runAt, { sliceCustomers: 1 }),
      ),
    );
    const differ = whole.filter((r, i) => r !== cut[i]);
    ok(
      `sliced ${grain} ${periodEnd}: one customer per slice gives the whole book's ${whole.length} rows`,
      whole.length === cut.length && differ.length === 0,
    );
    if (differ.length) console.log(`  ↳ ${grain} ${periodEnd}:`, differ.slice(0, 6));
  }
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-DAILY: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-DAILY: FAIL (${failed}/${checks.length} failed)`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
