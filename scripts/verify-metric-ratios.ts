/**
 * The ORACLE GATE for the derived ratios (Phase 7, group 5).
 *
 * Ten figures that own no facts: retention gross and net, the growth rate, the quick ratio,
 * four averages and two lifetime values. Every one is stored as NUMERATOR + DENOMINATOR and
 * divided at read, and this gate exists to prove that the storing, the folding and the
 * dividing all agree — against TWO independent oracles:
 *
 *   1. AN EXPECTED TABLE, worked out by hand from the fixture. It agrees with neither the
 *      writer nor the reports; it is what a person gets with a pencil.
 *   2. THE PUBLISHED REPORTS — the ten keys that already answer these questions, run over
 *      the window they choose for themselves. A measure that quietly redefined its figure
 *      fails here.
 *
 * ⚠️ THE ONE THING THIS GATE EXISTS TO PROTECT: a ratio must survive re-aggregation. The
 * second quarter's retention is the quarter's own opening revenue less the quarter's own
 * losses — 7,273 basis points on this fixture — and it is NOT the mean of April, May and
 * June's rates, which is 8,924. The gate asserts both numbers, so a writer that stored the
 * quotient, or a reader that averaged the buckets, fails with the two figures side by side
 * rather than passing quietly at double the truth.
 *
 * The properties, in the order a wrong implementation breaks them:
 *   1. the hand-worked table is stored, numerator and denominator, to the minor unit;
 *   2. dividing the stored halves reproduces what each published report already answers;
 *   3. RE-AGGREGATION — a quarter read from day rows is the quarter, not an average;
 *   4. a zero denominator answers NULL: never 0, never an infinity, never a NaN;
 *   5. cross-currency — a customer is counted once, and a count is never converted;
 *   6. the window is the measure, and a period before the book has no row at all;
 *   7. declared == emitted, both ways, for every dimension.
 *
 *   pnpm verify:metric-ratios
 */
import { and, eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { readMetricSeries } from "@/modules/metrics/daily/query";
import {
  MEASURES,
  measureById,
  ratioValue,
  type Grain,
  type MeasureDef,
} from "@/modules/metrics/daily/measures";
import {
  RATIO_MEASURE_AGGREGATE,
  RATIO_MEASURES,
  readBookWithCustomers,
} from "@/modules/metrics/daily/ratio-measures";
import { loadReratedMrr } from "@/modules/metrics/snapshots";
import { MRR_STATUSES, liveAt } from "@/modules/metrics/stocks";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { metricDaily, mrrMovements, subscriptions } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** Past the real clock, so a live billing worker never renews anything in this fixture. */
const PARKED = day("2028-01-01");
/**
 * The instant both sides are asked at. Inside July, so the reports' own window — the last
 * COMPLETE month — is June, which is the month the fixture is built around.
 */
const NOW = new Date("2026-07-15T12:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────
// Seed — its own organization and business, never the dev database's book.
// ─────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Ratio Measure Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Ratio Measure Oracle Biz",
  defaultCurrency: "USD",
  // UTC on purpose: the reports cut their month in the BUSINESS's timezone and these rows
  // are cut on the UTC calendar. On any other timezone the two months are hours apart at
  // each edge, and the gate would be comparing two different Junes.
  timezone: "UTC",
  livemode: "test",
});
const bizId = biz.id;

const plan = await createProduct({ organizationId: orgId, businessId: bizId, name: "Plan" });
/**
 * One price per (currency, rate) the fixture asks for, made on demand.
 *
 * A CANCELLED row's MRR is re-rated from its items, so a subscription whose forced column
 * and whose item line disagree is not pencil-computable at all. One price per rate keeps
 * the two saying the same thing.
 */
const priceCache = new Map<string, Awaited<ReturnType<typeof createPrice>>>();
async function priceFor(currency: "USD" | "EUR", amountMinor: number) {
  const k = `${currency} ${amountMinor}`;
  let p = priceCache.get(k);
  if (!p) {
    p = await createPrice({
      organizationId: orgId,
      businessId: bizId,
      productId: plan.id,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor,
      interval: "month",
    });
    priceCache.set(k, p);
  }
  return p;
}

let seq = 0;
const customer = (name: string) =>
  createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `ratio-${name}-${++seq}-${Date.now()}@example.test`,
  });

/** A subscription as the ledger helpers need it. */
interface SubRef {
  id: string;
  customerId: string;
  currency: string;
}

/**
 * Ledger rows stated outright, each carrying the rate its subscription had before and after
 * it — the running balance, so a row never claims a rate the ledger does not add up to.
 */
function ledgerOf(
  scope: { organizationId: string; businessId: string; planProductId: string },
  entries: Array<[at: string, reason: string, sub: SubRef, delta: number]>,
) {
  const running = new Map<string, bigint>();
  return [...entries]
    .sort((x, y) => Date.parse(x[0]) - Date.parse(y[0]))
    .map(([at, reason, s, delta]) => {
      const previous = running.get(s.id) ?? 0n;
      const next = previous + BigInt(delta);
      running.set(s.id, next);
      return {
        ...scope,
        subscriptionId: s.id,
        customerId: s.customerId,
        reason,
        currency: s.currency,
        previousMrrMinor: previous,
        newMrrMinor: next,
        // SIGNED, as the ledger stores it: a loss is already negative and nothing re-signs it.
        deltaMinor: BigInt(delta),
        occurredAt: new Date(at),
      };
    });
}

/**
 * The fixture's own precondition: stock is read off the ledger, so every subscription's
 * running balance must stay >= 0 and end at the `mrr` column. A fixture that breaks this is
 * measuring a book that cannot exist.
 */
async function ledgerIsTheBook(label: string, organizationId: string, businessId: string) {
  const subs = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: subscriptions.id, mrr: subscriptions.mrr })
      .from(subscriptions)
      .where(eq(subscriptions.businessId, businessId)),
  );
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: mrrMovements.subscriptionId,
        at: mrrMovements.occurredAt,
        delta: mrrMovements.deltaMinor,
      })
      .from(mrrMovements)
      .where(eq(mrrMovements.businessId, businessId)),
  );
  // Gains first within an instant — the order the ops invariant runs the balance in.
  rows.sort((x, y) => +x.at - +y.at || Number(y.delta > 0n) - Number(x.delta > 0n));
  const running = new Map<string, bigint>();
  const bad: string[] = [];
  for (const r of rows) {
    const next = (running.get(r.id) ?? 0n) + r.delta;
    running.set(r.id, next);
    if (next < 0n) bad.push(`${r.id} runs to ${next} at ${r.at.toISOString()}`);
  }
  for (const s of subs) {
    const closing = running.get(s.id) ?? 0n;
    if (closing !== (s.mrr ?? 0n)) bad.push(`${s.id}: ledger ${closing}, column ${s.mrr}`);
  }
  ok(
    `fixture (${label}): every subscription's ledger stays >= 0 and nets to its mrr column`,
    subs.length > 0 && bad.length === 0,
  );
  if (bad.length) console.log("  ↳ ledger/book disagreements:", bad.slice(0, 8));
}

/** Every stamp in the first fixture is 09:00 UTC, so nothing lands on a period's first instant. */
const at9 = (iso: string) => `${iso}T09:00:00.000Z`;

/**
 * One subscription with its stock fields forced.
 *
 * The service creates it; the update states exactly what the book is to say, because the
 * hand-worked table below has to be computable with a pencil rather than by re-running the
 * pricing engine. `rateMinor` is the rate it starts on (and its item price); `mrrMinor` is
 * the column, which must equal where its ledger ends.
 */
async function addSub(s: {
  customerId: string;
  currency: "USD" | "EUR";
  rateMinor: number;
  mrrMinor: number;
  startedOn: string;
  canceledOn?: string;
  paused?: boolean;
}): Promise<SubRef> {
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: s.customerId,
    now: day(s.startedOn),
    startDate: day(s.startedOn),
    items: [{ price: await priceFor(s.currency, s.rateMinor), quantity: 1 }],
  });
  const started = new Date(at9(s.startedOn));
  await systemDb
    .update(subscriptions)
    .set({
      status: s.canceledOn ? "cancelled" : s.paused ? "paused" : "active",
      currency: s.currency,
      mrr: BigInt(s.mrrMinor),
      createdAt: started,
      startDate: started,
      startedAt: started,
      canceledAt: s.canceledOn ? new Date(at9(s.canceledOn)) : null,
      currentPeriodEnd: PARKED,
      trialEnd: PARKED,
    })
    .where(eq(subscriptions.id, subscription.id));
  return { id: subscription.id, customerId: s.customerId, currency: s.currency };
}

// A — one account, several USD lines. Two still paying at June's close: the reason revenue
// per customer sits above revenue per subscription.
const a = await customer("a");
const a1 = await addSub({
  customerId: a.id,
  currency: "USD",
  rateMinor: 10_000,
  mrrMinor: 10_500,
  startedOn: "2026-01-10",
});
// Arrives inside the quarter and leaves inside it: in June's opening, never in the quarter's.
const a2 = await addSub({
  customerId: a.id,
  currency: "USD",
  rateMinor: 1000,
  mrrMinor: 0,
  startedOn: "2026-04-08",
  canceledOn: "2026-06-25",
});
// Paused in May, back in June.
const a3 = await addSub({
  customerId: a.id,
  currency: "USD",
  rateMinor: 500,
  mrrMinor: 500,
  startedOn: "2026-02-15",
});
// Arrives in June and pauses in June: in no opening cohort this fixture reads.
const a4 = await addSub({
  customerId: a.id,
  currency: "USD",
  rateMinor: 2000,
  mrrMinor: 0,
  startedOn: "2026-06-10",
  paused: true,
});
// B — pays in BOTH currencies. Counted once, in USD, the currency carrying most of it.
const b = await customer("b");
const b1 = await addSub({
  customerId: b.id,
  currency: "USD",
  rateMinor: 3000,
  mrrMinor: 3000,
  startedOn: "2026-02-01",
});
const b2 = await addSub({
  customerId: b.id,
  currency: "USD",
  rateMinor: 4000,
  mrrMinor: 4000,
  startedOn: "2026-06-03",
});
const bEur = await addSub({
  customerId: b.id,
  currency: "EUR",
  rateMinor: 500,
  mrrMinor: 500,
  startedOn: "2026-02-01",
});
// C and D — accounts that have fully ENDED, so a lifetime can be measured at all. D was
// comped: worth nothing, so it has no ledger row to book.
const c = await customer("c");
const c1 = await addSub({
  customerId: c.id,
  currency: "USD",
  rateMinor: 3000,
  mrrMinor: 0,
  startedOn: "2026-01-01",
  canceledOn: "2026-06-20",
});
const d = await customer("d");
await addSub({
  customerId: d.id,
  currency: "USD",
  rateMinor: 0,
  mrrMinor: 0,
  startedOn: "2026-02-01",
  canceledOn: "2026-05-01",
});
// E — the EUR book's living account, three lines. F — its ended, comped one.
const e = await customer("e");
const e1 = await addSub({
  customerId: e.id,
  currency: "EUR",
  rateMinor: 2000,
  mrrMinor: 2200,
  startedOn: "2026-04-01",
});
const e2 = await addSub({
  customerId: e.id,
  currency: "EUR",
  rateMinor: 300,
  mrrMinor: 0,
  startedOn: "2026-03-10",
  canceledOn: "2026-06-28",
});
const e3 = await addSub({
  customerId: e.id,
  currency: "EUR",
  rateMinor: 800,
  mrrMinor: 800,
  startedOn: "2026-06-05",
});
// T — a June trial that never converts. The engine books `new` and reverses it at trial
// start: two ledger rows, net zero, so it must not count as a new subscription.
const t = await customer("t");
const tTrial = await addSub({
  customerId: t.id,
  currency: "USD",
  rateMinor: 700,
  mrrMinor: 0,
  startedOn: "2026-06-08",
});
const f = await customer("f");
await addSub({
  customerId: f.id,
  currency: "EUR",
  rateMinor: 0,
  mrrMinor: 0,
  startedOn: "2026-01-01",
  canceledOn: "2026-03-01",
});

/**
 * The ledger, stated outright: every subscription's `new` at its start, every change, and a
 * `churn` at every paid cancellation, so each running balance is the rate it carried then.
 *
 * Every movement the seeding services filed is deleted first: this fixture's arithmetic is
 * the rows below and nothing else, so a service that starts filing one more movement cannot
 * move a figure this gate calls exact.
 */
// Deleted with the unscoped client: the tenant role is denied DELETE on the ledger, which
// is exactly the guard the append-only rule exists for.
await systemDb.delete(mrrMovements).where(eq(mrrMovements.businessId, bizId));

await withTenant(orgId, (tx) =>
  tx.insert(mrrMovements).values(
    ledgerOf({ organizationId: orgId, businessId: bizId, planProductId: plan.id }, [
      // ── Before the quarter: the book it opens with ──
      [at9("2026-01-01"), "new", c1, 3000],
      [at9("2026-01-10"), "new", a1, 10_000],
      [at9("2026-02-01"), "new", b1, 3000],
      [at9("2026-02-15"), "new", a3, 500],
      [at9("2026-02-01"), "new", bEur, 500],
      [at9("2026-03-10"), "new", e2, 300],
      // ── April and May, so the QUARTER is not just June wearing a longer name ──
      [at9("2026-04-08"), "new", a2, 1000],
      [at9("2026-05-15"), "pause", a3, -500],
      [at9("2026-04-01"), "new", e1, 2000],
      [at9("2026-04-20"), "expansion", e1, 200],
      // ── June, USD: gained 8,000 across four movements, lost 7,000 across four ──
      [at9("2026-06-03"), "new", b2, 4000],
      [at9("2026-06-10"), "new", a4, 2000],
      [at9("2026-06-08"), "new", tTrial, 700],
      [at9("2026-06-08"), "new", tTrial, -700],
      [at9("2026-06-12"), "expansion", a1, 1500],
      [at9("2026-06-14"), "reactivation", a3, 500],
      [at9("2026-06-18"), "contraction", a1, -1000],
      [at9("2026-06-20"), "churn", c1, -3000],
      [at9("2026-06-22"), "pause", a4, -2000],
      [at9("2026-06-25"), "churn", a2, -1000],
      // ── June, EUR: its own arithmetic, never added to the first ──
      [at9("2026-06-05"), "new", e3, 800],
      [at9("2026-06-28"), "churn", e2, -300],
    ]),
  ),
);
await ledgerIsTheBook("ratio book", orgId, bizId);

// ─────────────────────────────────────────────────────────────────────────────
// Materialise.
// ─────────────────────────────────────────────────────────────────────────────
const MINE = new Set<string>(RATIO_MEASURES);
type Key = string;
const key = (measure: string, currency: string) => `${measure}|${currency}`;
interface Halves {
  value: bigint | null;
  denominator: bigint | null;
}

async function materialise(grain: Grain, periodEnd: string): Promise<Map<Key, Halves>> {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, grain, periodEnd, NOW),
  );
  await writeMetricDay({ organizationId: orgId, businessId: bizId, grain, periodEnd, rows });
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select({
        measure: metricDaily.measure,
        dim: metricDaily.dim,
        dimValue: metricDaily.dimValue,
        currency: metricDaily.currency,
        value: metricDaily.value,
        denominator: metricDaily.denominator,
      })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.grain, grain),
          eq(metricDaily.periodEnd, periodEnd),
        ),
      ),
  );
  const out = new Map<Key, Halves>();
  for (const r of stored) {
    if (!MINE.has(r.measure)) continue;
    // Every ratio row is a total; a stray slice would break the key and is caught below.
    if (r.dim !== "") continue;
    out.set(key(r.measure, r.currency), { value: r.value, denominator: r.denominator });
  }
  return out;
}

const SAMPLED: Array<[Grain, string]> = [
  ["month", "2025-12-31"],
  ["month", "2026-04-30"],
  ["month", "2026-05-31"],
  ["month", "2026-06-30"],
  ["quarter", "2026-06-30"],
  ["day", "2026-06-03"],
  ["day", "2026-07-15"],
];
const materialised = new Map<string, Map<Key, Halves>>();
for (const [grain, periodEnd] of SAMPLED) {
  materialised.set(`${grain}|${periodEnd}`, await materialise(grain, periodEnd));
}
const M = (grain: Grain, periodEnd: string) => materialised.get(`${grain}|${periodEnd}`)!;

/** The measure's own divide, so the gate never forms a quotient a reader would not. */
const read = (m: MeasureDef, h: Halves | undefined): number | null =>
  h === undefined ? null : ratioValue(m, h.value, h.denominator);
const def = (id: string): MeasureDef => measureById(id)!;

// ─────────────────────────────────────────────────────────────────────────────
// 0. The registry and its writer agree, measure for measure.
// ─────────────────────────────────────────────────────────────────────────────
{
  let paired = true;
  try {
    assertRegistryImplemented();
  } catch {
    paired = false;
  }
  ok("registry: every declared measure is implemented, with the aggregate it promises", paired);
  // The headline four are fixtured in verify:metric-new-measures; this is the original ten.
  const HEADLINE = new Set([
    "net_new_mrr",
    "gross_mrr_churn_rate",
    "trial_conversion_rate",
    "subscriber_churn_rate",
  ]);
  const mine = MEASURES.filter((m) => m.source === "derived" && !HEADLINE.has(m.id));
  const COHORT_RESTRICTED = ["gross_revenue_retention", "net_revenue_retention"];
  const folds = mine.filter((m) => !COHORT_RESTRICTED.includes(m.id));
  ok(
    "registry: eleven derived measures — nine that fold out of day rows, and the two cohort-restricted retentions that cannot",
    mine.length === 11 &&
      folds.length === 9 &&
      folds.every((m) => m.aggregate === "ratio") &&
      COHORT_RESTRICTED.every((id) => def(id).aggregate === "none"),
  );
  ok(
    "registry: every FOLDING ratio declares how both halves fold — without it a reader would just sum them",
    folds.every((m) => m.ratio != null),
  );
  /**
   * A cohort-restricted retention must carry NO fold at all. Declaring one would be a
   * promise the writer cannot keep — its numerator is about the population that opened the
   * period, and that is a different set at every grain — and `public-query` reads the
   * absence as "this denominator is money and converts with its numerator", which is what
   * an opening stock is.
   */
  ok(
    "registry: the cohort-restricted retentions declare no fold at all, so no reader can fold them",
    COHORT_RESTRICTED.every((id) => def(id).ratio === undefined),
  );
  ok(
    "registry: the four averages and two lifetimes divide by a COUNT; the two folding rates and the top-10 share by money",
    folds.filter((m) => m.ratio!.denominatorUnit === "count").length === 6 &&
      folds.filter((m) => m.ratio!.denominatorUnit === "money").length === 3 &&
      def("mrr_top10_share").ratio!.denominatorUnit === "money",
  );
  ok(
    "registry: the growth rate divides by what the period OPENED with, not by a sum of openings",
    def("net_mrr_growth_rate").ratio!.denominator === "opening" &&
      def("net_mrr_growth_rate").ratio!.numerator === "sum",
  );
  /**
   * THE READER AND THE WRITER SAY THE SAME WORD. `compute.ts` declares each derived
   * measure's aggregation from `RATIO_MEASURE_AGGREGATE`; the registry the reader folds by
   * states it again. A row stored per grain and read as foldable — or the reverse — is the
   * class of bug this pairing exists to make impossible, and `assertRegistryImplemented`
   * above only compares the two once this map covers every measure.
   */
  ok(
    "registry: the writer's aggregation map covers every one and agrees with the registry, measure for measure",
    RATIO_MEASURES.every((id) => RATIO_MEASURE_AGGREGATE[id] === def(id).aggregate) &&
      Object.keys(RATIO_MEASURE_AGGREGATE).length === RATIO_MEASURES.length,
  );
  ok(
    "registry: the four stock ratios take the period's LAST day on both halves",
    [
      "revenue_per_paying_subscription",
      "revenue_per_paying_customer",
      "subscription_lifetime_value",
      "customer_lifetime_value",
    ].every((id) => def(id).ratio!.numerator === "last" && def(id).ratio!.denominator === "last"),
  );
  ok(
    "registry: no ratio claims a plan or country slice it cannot cut both halves by",
    mine.every((m) => !m.dimensions.includes("plan") && !m.dimensions.includes("country")),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE EXPECTED TABLE — worked out from the fixture by hand, not from either side.
//
// June, USD. Opening 17,000 on 1 June: A1 10,000 + B1 3,000 + C1 3,000 + A2 1,000. A3 is at 0
// (paused), so NOT in the cohort: a line the opening did not earn from cannot grow it. Gained 8,000 (B2 4,000 + A4 2,000 new, A1 1,500 expansion,
// A3 500 reactivation). Lost 7,000 (A1 1,000 contraction, C1 3,000 + A2 1,000 churn, A4 2,000
// pause). Net +1,000, so closing 18,000: A1 10,500 + A3 500 + B1 3,000 + B2 4,000 — four
// paying lines, two accounts.
// Retention loses only the cohort's: 1,000 + 3,000 + 1,000 = 5,000 (A4 arrived in June), so
// gross 12,000. Net adds the cohort's growth, A1 1,500 (A3's resume is not the base's): 13,500.
// Departures (churn + pause): C1, A4, A2 = 6,000 over 3.
// Ended USD lines by 30 June: C1 170 days, D 89, A2 78 → 112.33 days, 3.7444 months;
// 18,000 × 3.7444 = 67,400. Ended USD accounts: C 170, D 89 → 4.3 months; 18,000 × 4.3 = 77,400.
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED: Array<[Grain, string, string, string, bigint, bigint]> = [
  // grain, periodEnd, measure, currency, numerator, denominator
  ["month", "2026-06-30", "gross_revenue_retention", "USD", 12_000n, 17_000n],
  ["month", "2026-06-30", "net_revenue_retention", "USD", 13_500n, 17_000n],
  ["month", "2026-06-30", "net_mrr_growth_rate", "USD", 1000n, 17_000n],
  ["month", "2026-06-30", "quick_ratio", "USD", 8000n, 7000n],
  ["month", "2026-06-30", "revenue_per_new_subscription", "USD", 6000n, 2n],
  ["month", "2026-06-30", "revenue_lost_per_churned_subscription", "USD", 6000n, 3n],
  ["month", "2026-06-30", "revenue_per_paying_subscription", "USD", 18_000n, 4n],
  ["month", "2026-06-30", "revenue_per_paying_customer", "USD", 18_000n, 2n],
  ["month", "2026-06-30", "subscription_lifetime_value", "USD", 67_400n, 4n],
  ["month", "2026-06-30", "customer_lifetime_value", "USD", 77_400n, 2n],
  // Two paying USD accounts, both inside the top ten: the share is the whole book.
  ["month", "2026-06-30", "mrr_top10_share", "USD", 18_000n, 18_000n],
  // June, EUR. Opening 3,000 (E1 2,200 + B 500 + E2 300). Gained 800 (E3), lost 300 (E2).
  // Closing 3,500 over 3 paying lines — but ONE account, because B is counted in USD, the
  // currency carrying most of its revenue (7,000 against 500).
  ["month", "2026-06-30", "gross_revenue_retention", "EUR", 2700n, 3000n],
  ["month", "2026-06-30", "net_revenue_retention", "EUR", 2700n, 3000n],
  ["month", "2026-06-30", "net_mrr_growth_rate", "EUR", 500n, 3000n],
  ["month", "2026-06-30", "quick_ratio", "EUR", 800n, 300n],
  ["month", "2026-06-30", "revenue_per_new_subscription", "EUR", 800n, 1n],
  ["month", "2026-06-30", "revenue_lost_per_churned_subscription", "EUR", 300n, 1n],
  ["month", "2026-06-30", "revenue_per_paying_subscription", "EUR", 3500n, 3n],
  ["month", "2026-06-30", "revenue_per_paying_customer", "EUR", 3500n, 1n],
  // Ranked per currency, so B's 500 EUR ranks here beside E's 3,000.
  ["month", "2026-06-30", "mrr_top10_share", "EUR", 3500n, 3500n],
  // April, USD: opening 16,500 (A1 10,000 + B1 3,000 + C1 3,000 + A3 500), one gain (A2's
  // 1,000 new) and NOTHING lost. The zero denominator, measured rather than absent.
  ["month", "2026-04-30", "gross_revenue_retention", "USD", 16_500n, 16_500n],
  ["month", "2026-04-30", "net_mrr_growth_rate", "USD", 1000n, 16_500n],
  ["month", "2026-04-30", "quick_ratio", "USD", 1000n, 0n],
  ["month", "2026-04-30", "revenue_lost_per_churned_subscription", "USD", 0n, 0n],
  // The quarter, read as its OWN period: opening 16,500 on 1 April, and 4,500 lost BY THAT
  // OPENING (A3 500, A1 1,000, C1 3,000). The quarter's other 3,000 of losses is A2 and A4,
  // which both arrived inside the window. June counts A2, because A2 was there on 1 June; the
  // quarter does not. Flows: 1,000 + 8,000 gained, 500 + 7,000 lost; new 1,000 + 4,000 + 2,000.
  ["quarter", "2026-06-30", "gross_revenue_retention", "USD", 12_000n, 16_500n],
  ["quarter", "2026-06-30", "quick_ratio", "USD", 9000n, 7500n],
  ["quarter", "2026-06-30", "revenue_per_new_subscription", "USD", 7000n, 3n],
];
{
  const wrong: string[] = [];
  for (const [grain, periodEnd, measure, currency, wantValue, wantDen] of EXPECTED) {
    const got = M(grain, periodEnd).get(key(measure, currency));
    if (got?.value !== wantValue || got?.denominator !== wantDen) {
      wrong.push(
        `${grain} ${periodEnd} ${measure} ${currency}: want ${wantValue}/${wantDen}, stored ${got?.value}/${got?.denominator}`,
      );
    }
  }
  ok(
    `oracle: all ${EXPECTED.length} hand-worked pairs are stored, numerator and denominator, to the minor unit`,
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ mismatches:", wrong.slice(0, 15));

  // …and the quotients those pairs produce. Written out so a wrong DIVIDE is as visible as
  // a wrong numerator — 7,059 basis points is 12,000 of 17,000, and nothing else.
  const june = M("month", "2026-06-30");
  const QUOTIENTS: Array<[string, string, number | null]> = [
    ["gross_revenue_retention", "USD", 7059],
    ["net_revenue_retention", "USD", 7941],
    ["net_mrr_growth_rate", "USD", 588],
    ["revenue_per_new_subscription", "USD", 3000],
    ["revenue_lost_per_churned_subscription", "USD", 2000],
    ["revenue_per_paying_subscription", "USD", 4500],
    ["revenue_per_paying_customer", "USD", 9000],
    ["subscription_lifetime_value", "USD", 16_850],
    ["customer_lifetime_value", "USD", 38_700],
    ["gross_revenue_retention", "EUR", 9000],
    ["net_mrr_growth_rate", "EUR", 1667],
    ["revenue_per_paying_subscription", "EUR", 1167],
    ["revenue_per_paying_customer", "EUR", 3500],
  ];
  const badQuotient: string[] = [];
  for (const [measure, currency, want] of QUOTIENTS) {
    const got = read(def(measure), june.get(key(measure, currency)));
    if (got !== want) badQuotient.push(`${measure} ${currency}: want ${want}, read ${got}`);
  }
  ok("oracle: dividing the stored halves gives the hand-worked answer", badQuotient.length === 0);
  if (badQuotient.length) console.log("  ↳ quotients:", badQuotient);

  // The quick ratio is a bare quotient rather than basis points, and says so.
  const q = read(def("quick_ratio"), june.get(key("quick_ratio", "USD")));
  ok(
    "oracle: the quick ratio reads as a multiple (8,000 gained over 7,000 lost), not as money",
    q != null && Math.abs(q - 8000 / 7000) < 1e-9 && def("quick_ratio").unit === "ratio",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REPORTS — the figures already published must not have changed meaning.
//
// The reports quote these over the LAST COMPLETE MONTH, whatever window they are handed.
// The measures answer for the period they are stored against, which is a generalisation of
// that and not a redefinition: read the month the report would have picked, and the figure
// is the report's. That is exactly what this section reads.
// ─────────────────────────────────────────────────────────────────────────────
const report = (reportKey: string, currency: string) =>
  resolveReport(orgId, bizId, reportKey, { currency, now: NOW, range: "12m" });

{
  /** The six the reports date by the last complete month — June, here. */
  const MONTHLY: Array<[string, string]> = [
    ["gross_revenue_retention_rate", "gross_revenue_retention"],
    ["net_revenue_retention_rate", "net_revenue_retention"],
    ["net_mrr_growth_rate", "net_mrr_growth_rate"],
    ["average_revenue_per_new_subscription", "revenue_per_new_subscription"],
    ["average_revenue_lost_per_churned_subscription", "revenue_lost_per_churned_subscription"],
  ];
  const wrong: string[] = [];
  for (const [reportKey, measure] of MONTHLY) {
    const r = await report(reportKey, "USD");
    const stored = read(def(measure), M("month", "2026-06-30").get(key(measure, "USD")));
    if (r.headline !== stored) wrong.push(`${reportKey}: report ${r.headline}, stored ${stored}`);
  }
  // The quick ratio is published in basis points and stored as the bare quotient.
  const qr = await report("quick_ratio", "USD");
  const qStored = read(def("quick_ratio"), M("month", "2026-06-30").get(key("quick_ratio", "USD")));
  if (qr.headline !== (qStored == null ? null : Math.round(qStored * 10_000))) {
    wrong.push(`quick_ratio: report ${qr.headline}, stored ${qStored}`);
  }
  ok(
    "reports: the six window-dated rates agree with the stored June, figure for figure",
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ report disagreements:", wrong);

  /** The four the reports read at `now` — 15 July, which is the day period holding it. */
  const AT_NOW: Array<[string, string]> = [
    ["average_revenue_per_paid_subscription", "revenue_per_paying_subscription"],
    ["average_revenue_per_paying_customer", "revenue_per_paying_customer"],
  ];
  const wrongNow: string[] = [];
  for (const [reportKey, measure] of AT_NOW) {
    const r = await report(reportKey, "USD");
    const stored = read(def(measure), M("day", "2026-07-15").get(key(measure, "USD")));
    if (r.headline !== stored)
      wrongNow.push(`${reportKey}: report ${r.headline}, stored ${stored}`);
  }
  ok(
    "reports: the two live averages agree with the day period holding `now`",
    wrongNow.length === 0,
  );
  if (wrongNow.length) console.log("  ↳ report disagreements:", wrongNow);

  /**
   * ⚠️ THE ONE PLACE THE TWO SIDES ARE ALLOWED TO DIFFER, AND BY HOW MUCH.
   *
   * A lifetime value is revenue-per-head times a life. The report divides and then
   * multiplies; the stored pair multiplies into the numerator and divides at read, because
   * that is what keeps it a ratio a reader can re-aggregate. The two round at different
   * moments, so they can land one minor unit apart — stated and bounded here rather than
   * papered over with a looser comparison.
   */
  const LIFETIMES: Array<[string, string, string[]]> = [
    ["lifetime_value_of_a_paid_subscription", "subscription_lifetime_value", ["USD", "EUR"]],
    // ⚠️ USD only — the EUR headcounts differ on purpose. See the check below.
    ["lifetime_value_of_a_customer", "customer_lifetime_value", ["USD"]],
  ];
  const drift: string[] = [];
  for (const [reportKey, measure, scopes] of LIFETIMES) {
    for (const currency of scopes) {
      const r = await report(reportKey, currency);
      const stored = read(def(measure), M("day", "2026-07-15").get(key(measure, currency)));
      if (r.headline == null || stored == null) {
        drift.push(`${reportKey} ${currency}: report ${r.headline}, stored ${stored}`);
        continue;
      }
      if (Math.abs(r.headline - stored) > 1) {
        drift.push(`${reportKey} ${currency}: report ${r.headline}, stored ${stored}`);
      }
    }
  }
  ok(
    "reports: both lifetime values agree with the stored pair to within one minor unit of rounding",
    drift.length === 0,
  );
  if (drift.length) console.log("  ↳ lifetime drift:", drift);

  /**
   * ⚠️ THE ONE DELIBERATE DIVERGENCE FROM THE PUBLISHED FIGURE, ASSERTED RATHER THAN HIDDEN.
   *
   * B pays in both currencies. Asked for the EUR book alone, the report counts B as a paying
   * customer because B has a EUR subscription — and asked for the USD book it counts B again,
   * so its per-currency headcounts add up to four accounts where only three exist. EUR on
   * 15 July is 3,500: over E and B that is 1,750, over E alone 3,500. The stored
   * denominator counts B once, in USD, which is what lets a converted read divide by a real
   * headcount. The per-currency EUR figures therefore differ, and the gate states by how much
   * instead of loosening the comparison until they agree.
   */
  const eurArpcReport = await report("average_revenue_per_paying_customer", "EUR");
  const eurArpcStored = read(
    def("revenue_per_paying_customer"),
    M("day", "2026-07-15").get(key("revenue_per_paying_customer", "EUR")),
  );
  ok(
    "reports: the per-currency head count diverges by design — the report counts B twice (1,750), the store once (3,500)",
    eurArpcReport.headline === 1750 && eurArpcStored === 3500,
  );

  // …and the EUR book answers its own arithmetic, never the USD book's.
  const eurQuick = await report("quick_ratio", "EUR");
  ok(
    "reports: the EUR quick ratio is 800 over 300 — the EUR ledger alone",
    eurQuick.headline === Math.round((800 / 300) * 10_000),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. RE-AGGREGATION. The reason a quotient is never stored.
// ─────────────────────────────────────────────────────────────────────────────
{
  // Every day of the second quarter, so the reader has the rows a real caller would.
  const days: string[] = [];
  for (
    let d = new Date("2026-04-01T00:00:00.000Z");
    d <= new Date("2026-06-30T00:00:00.000Z");
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(d.toISOString().slice(0, 10));
  }
  for (const d of days) {
    const rows = await withTenant(orgId, (tx) => computeMetricPeriod(tx, bizId, "day", d, NOW));
    await writeMetricDay({
      organizationId: orgId,
      businessId: bizId,
      grain: "day",
      periodEnd: d,
      rows,
    });
  }

  const quarterFromDays = async (measure: string) => {
    const series = await readMetricSeries({
      organizationId: orgId,
      businessIds: [bizId],
      measure,
      grain: "quarter",
      periods: [{ start: "2026-04-01", end: "2026-06-30", label: "Q2" }],
    });
    const cell = series.cells.find((c) => c.currency === "USD");
    return ratioValue(def(measure), cell?.value ?? null, cell?.denominator ?? null);
  };
  const monthFromDays = async (measure: string, start: string, end: string) => {
    const series = await readMetricSeries({
      organizationId: orgId,
      businessIds: [bizId],
      measure,
      grain: "month",
      periods: [{ start, end, label: "m" }],
    });
    const cell = series.cells.find((c) => c.currency === "USD");
    return ratioValue(def(measure), cell?.value ?? null, cell?.denominator ?? null);
  };

  const quarterRead = await quarterFromDays("gross_revenue_retention");
  const quarterOwn = read(
    def("gross_revenue_retention"),
    M("quarter", "2026-06-30").get(key("gross_revenue_retention", "USD")),
  );
  const april = await monthFromDays("gross_revenue_retention", "2026-04-01", "2026-04-30");
  const may = await monthFromDays("gross_revenue_retention", "2026-05-01", "2026-05-31");
  const june = await monthFromDays("gross_revenue_retention", "2026-06-01", "2026-06-30");
  const meanOfMonths = Math.round(((april ?? 0) + (may ?? 0) + (june ?? 0)) / 3);

  /**
   * ⚠️ RETENTION IS READ AT THE GRAIN IT WAS WRITTEN AT — never folded, in either direction.
   *
   * The quarter opened with 16,500 and THAT opening gave up 4,500, so the quarter is 7,273
   * basis points. Two other numbers are within reach and both are wrong: 8,924, the mean of
   * its months (10,000, 9,714, 7,059), which is what storing a quotient would give; and 5,455,
   * what folding the day rows gives — 16,500 less all 7,500 lost — because each day's cohort
   * also holds A2 (8 April → 25 June) and A4 (10 June → paused 22 June), and neither was part
   * of what the quarter opened with. The gate names all three so a regression reports which
   * mistake it made.
   */
  ok(
    "re-aggregation: the quarter is its OWN period — 16,500 opened, 4,500 of it lost, 7,273 bps",
    quarterRead === 7273 && quarterOwn === 7273,
  );
  ok(
    "re-aggregation: …not the mean of its three months (8,924), and not a fold of its days (5,455)",
    meanOfMonths === 8924 && quarterRead !== meanOfMonths && quarterRead !== 5455,
  );
  console.log(
    `  gross retention — quarter ${quarterRead} bps, months ${april}/${may}/${june}, their mean ${meanOfMonths}`,
  );

  ok(
    "re-aggregation: each month read back is the month the writer computed directly",
    april ===
      read(
        def("gross_revenue_retention"),
        M("month", "2026-04-30").get(key("gross_revenue_retention", "USD")),
      ) &&
      may ===
        read(
          def("gross_revenue_retention"),
          M("month", "2026-05-31").get(key("gross_revenue_retention", "USD")),
        ) &&
      june ===
        read(
          def("gross_revenue_retention"),
          M("month", "2026-06-30").get(key("gross_revenue_retention", "USD")),
        ),
  );

  /**
   * AND THE READER REFUSES RATHER THAN FOLDING. Every day of the second quarter is stored,
   * so a folding measure answers for any window inside it. Retention answers only for a
   * period it was WRITTEN for: no week was ever written, so the week is reported missing and
   * returns no cell at all — not a plausible number a caller would plot.
   */
  const WEEK = { start: "2026-06-08", end: "2026-06-14", label: "w" };
  const weekOf = async (measure: string) =>
    readMetricSeries({
      organizationId: orgId,
      businessIds: [bizId],
      measure,
      grain: "week",
      periods: [WEEK],
    });
  const grrWeek = await weekOf("gross_revenue_retention");
  const quickWeek = await weekOf("quick_ratio");
  ok(
    "re-aggregation: a week nobody wrote retention for is reported MISSING, not folded out of its days",
    grrWeek.cells.length === 0 && grrWeek.missing.length > 0,
  );
  ok(
    "re-aggregation: …while a measure that really does fold answers the same week from those same day rows",
    quickWeek.cells.length > 0 && quickWeek.missing.length === 0,
  );

  // The flow ratio, whose two halves simply sum — and the stock ratio, whose halves take the
  // period's last day. Both re-aggregate, by different rules, and both are checked.
  const quickQuarter = await quarterFromDays("quick_ratio");
  ok(
    "re-aggregation: a flow ratio sums BOTH halves — 9,000 gained over 7,500 lost across the quarter",
    quickQuarter != null && Math.abs(quickQuarter - 9000 / 7500) < 1e-9,
  );
  const arpsQuarter = await quarterFromDays("revenue_per_paying_subscription");
  ok(
    "re-aggregation: a stock ratio takes the period's LAST day, never a sum of ninety-one of them",
    // 30 June: 18,000 over 4 paying lines.
    arpsQuarter === 4500,
  );
  /**
   * The growth rate still folds, and it is the measure that proves the fold was not thrown
   * away with retention: its numerator is the whole book's net movement, which really is
   * additive, over the opening the period began with. Read from ninety-one day rows and
   * computed directly for the quarter, it is the same figure.
   */
  const growthFolded = await quarterFromDays("net_mrr_growth_rate");
  const growthDirect = read(
    def("net_mrr_growth_rate"),
    M("quarter", "2026-06-30").get(key("net_mrr_growth_rate", "USD")),
  );
  ok(
    "re-aggregation: the growth rate DOES fold — 91 day rows and the quarter computed directly agree",
    growthFolded === growthDirect && growthFolded != null,
  );

  /**
   * The denominator is the period's OPENING, not the first day's total and not the last.
   * Without this the whole fold collapses into a sum and the quarter divides by 91 days of
   * opening revenue, which would read as a retention under one percent.
   */
  const quarterCell = (
    await readMetricSeries({
      organizationId: orgId,
      businessIds: [bizId],
      measure: "gross_revenue_retention",
      grain: "quarter",
      periods: [{ start: "2026-04-01", end: "2026-06-30", label: "Q2" }],
    })
  ).cells.find((c) => c.currency === "USD");
  ok(
    "re-aggregation: the quarter's denominator is the 16,500 it opened with, not a sum of its days",
    quarterCell?.denominator === 16_500n,
  );

  /**
   * …and the same contract survives the PUBLIC payload, which is where a caller meets it.
   * Each month publishes its own rate and both halves. The three-month WINDOW total is not
   * joined out of them — a cohort-restricted rate has no arithmetic that does that — but
   * computed as the window's own period: the quarter's 12,000 of 16,500, not the months' mean.
   */
  const { resolveAnalytics, resolveScope } = await import("@/modules/metrics/daily/public-query");
  const scope = await resolveScope(
    orgId,
    { id: bizId, publicId: biz.publicId, name: biz.name, timezone: "UTC" },
    "test",
  );
  const published = await resolveAnalytics(
    scope,
    {
      measure: "gross_revenue_retention",
      grain: "month",
      start: "2026-04-01",
      end: "2026-06-30",
      currency: "USD",
    },
    NOW,
  );
  ok(
    "re-aggregation: the public payload publishes each month's own rate, and a window total that is the window's OWN period",
    published.unit === "bps" &&
      // April 16,500/16,500; May 17,000/17,500 (A3's 500 paused); June 12,000/17,000.
      published.series.map((p) => p.value).join(",") === "10000,9714,7059" &&
      published.total_basis === "window" &&
      published.total === 7273 &&
      published.total_numerator === 12_000 &&
      published.total_denominator === 16_500 &&
      published.total !== meanOfMonths,
  );
  ok(
    "re-aggregation: …and every bucket publishes both halves, so a caller can see what it divided",
    published.series.every((p) => p.numerator != null && p.denominator != null),
  );
  const oneMonth = await resolveAnalytics(
    scope,
    {
      measure: "gross_revenue_retention",
      grain: "month",
      start: "2026-06-01",
      end: "2026-06-30",
      currency: "USD",
    },
    NOW,
  );
  ok(
    "re-aggregation: …and a window that IS one stored period publishes that period's rate as its total",
    oneMonth.total === 7059,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. A ZERO DENOMINATOR IS NOT A RATIO OF ZERO.
// ─────────────────────────────────────────────────────────────────────────────
{
  const april = M("month", "2026-04-30");
  const stored = april.get(key("quick_ratio", "USD"));
  ok(
    "zero: April lost nothing, so the quick ratio's denominator is a MEASURED zero, stored as such",
    stored?.value === 1000n && stored?.denominator === 0n,
  );
  ok(
    "zero: …and dividing by it answers null — never 0, never an infinity, never a NaN",
    read(def("quick_ratio"), stored) === null,
  );
  const churned = april.get(key("revenue_lost_per_churned_subscription", "USD"));
  ok(
    "zero: nothing churned is `null per subscription`, not `0 per subscription`",
    churned?.denominator === 0n &&
      read(def("revenue_lost_per_churned_subscription"), churned) === null,
  );

  // Nothing has ended in the EUR book's earliest months, so a lifetime is unknown rather
  // than zero — a null NUMERATOR this time, which is the other half of the same rule.
  const early = await materialise("month", "2026-02-28");
  const ltv = early.get(key("subscription_lifetime_value", "EUR"));
  ok(
    "zero: a lifetime with no completed lifetime in it is null, not an estimate of nothing",
    ltv !== undefined &&
      ltv.value === null &&
      read(def("subscription_lifetime_value"), ltv) === null,
  );

  // And the public payload carries the same answer, not a tidy zero for a chart to plot.
  const { resolveAnalytics, resolveScope } = await import("@/modules/metrics/daily/public-query");
  const scope = await resolveScope(
    orgId,
    {
      id: bizId,
      publicId: biz.publicId,
      name: biz.name,
      timezone: "UTC",
    },
    "test",
  );
  const answer = await resolveAnalytics(
    scope,
    {
      measure: "quick_ratio",
      grain: "month",
      start: "2026-04-01",
      end: "2026-04-30",
      currency: "USD",
    },
    NOW,
  );
  ok(
    "zero: the public series says null for the undividable period, and publishes both halves beside it",
    answer.series[0]?.value === null &&
      answer.series[0]?.numerator === 1000 &&
      answer.series[0]?.denominator === 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CROSS-CURRENCY. Both halves travel together, or not at all.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = M("month", "2026-06-30");
  const usdHeads = june.get(key("revenue_per_paying_customer", "USD"))?.denominator ?? 0n;
  const eurHeads = june.get(key("revenue_per_paying_customer", "EUR"))?.denominator ?? 0n;
  /**
   * The property that makes a converted read honest: B pays in USD and in EUR, and is
   * counted ONCE — in USD, the currency carrying most of its revenue. So the per-currency
   * denominators still sum to the number of distinct paying accounts, and a cross-currency
   * total does not divide by a headcount that does not exist.
   */
  ok(
    "currency: a customer paying in two currencies is counted once — 2 + 1 = the 3 accounts actually paying",
    usdHeads === 2n && eurHeads === 1n && usdHeads + eurHeads === 3n,
  );
  ok(
    "currency: …while the SUBSCRIPTION denominators are per currency and total seven paying lines",
    (june.get(key("revenue_per_paying_subscription", "USD"))?.denominator ?? 0n) === 4n &&
      (june.get(key("revenue_per_paying_subscription", "EUR"))?.denominator ?? 0n) === 3n,
  );
  ok(
    "currency: each currency's ratio is its own arithmetic — neither half ever crosses",
    june.get(key("gross_revenue_retention", "USD"))?.denominator === 17_000n &&
      june.get(key("gross_revenue_retention", "EUR"))?.denominator === 3000n,
  );

  /**
   * And the registry states which denominators may be converted at all. A money denominator
   * must cross into the reporting currency with its numerator, at the same rate and the same
   * instant; a head count must not cross at all, or the average revenue per head comes back
   * multiplied by an exchange rate.
   */
  ok(
    "currency: a count denominator is declared unconvertible, a money one convertible",
    def("revenue_per_paying_customer").ratio!.denominatorUnit === "count" &&
      def("net_mrr_growth_rate").ratio!.denominatorUnit === "money",
  );
  /**
   * Retention declares no fold, and the reader converts such a denominator as money —
   * which is what an opening stock is. Pinned here because the two facts live in different
   * files: drop the rule in `collapse` and a converted retention would divide the kept
   * revenue by an unconverted opening.
   */
  ok(
    "currency: retention carries no fold, so the reader converts its opening stock as the money it is",
    def("gross_revenue_retention").ratio === undefined &&
      def("net_revenue_retention").ratio === undefined,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE WINDOW IS THE MEASURE — and a period the book did not exist for has NO row.
// ─────────────────────────────────────────────────────────────────────────────
{
  ok(
    "window: before the first subscription there is nothing to divide, and nothing is written",
    M("month", "2025-12-31").size === 0,
  );
  const april = M("month", "2026-04-30");
  const june = M("month", "2026-06-30");
  ok(
    "window: April's opening is 16,500 and June's is 17,000 — the denominator moves with the period",
    april.get(key("gross_revenue_retention", "USD"))?.denominator === 16_500n &&
      june.get(key("gross_revenue_retention", "USD"))?.denominator === 17_000n,
  );
  ok(
    "window: a single day is a period too — 3 June gained 4,000 and lost nothing",
    M("day", "2026-06-03").get(key("quick_ratio", "USD"))?.value === 4000n &&
      M("day", "2026-06-03").get(key("quick_ratio", "USD"))?.denominator === 0n,
  );
  // A lifetime is measured AS AT the period's end: by 31 May only D (89 days) had ended — C1
  // and A2 end in June. May closes on 17,000 (A1 10,000, B1 3,000, C1 3,000, A2 1,000). The
  // figure is not a running restatement of today's book onto every past month.
  const may = M("month", "2026-05-31");
  ok(
    "window: a lifetime counts only what had ended by the period's end, not what has ended since",
    may.get(key("subscription_lifetime_value", "USD"))?.value ===
      BigInt(Math.round(17_000 * (89 / 30))),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. DECLARED == EMITTED, both ways.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        measure: metricDaily.measure,
        dim: metricDaily.dim,
        currency: metricDaily.currency,
      })
      .from(metricDaily)
      .where(eq(metricDaily.businessId, bizId)),
  );
  const mine = rows.filter((r) => MINE.has(r.measure));
  const emitted = new Map<string, Set<string>>();
  const currencies = new Map<string, Set<string>>();
  for (const r of mine) {
    if (r.dim !== "")
      (emitted.get(r.measure) ?? emitted.set(r.measure, new Set()).get(r.measure)!).add(r.dim);
    (currencies.get(r.measure) ?? currencies.set(r.measure, new Set()).get(r.measure)!).add(
      r.currency,
    );
  }
  const wrong: string[] = [];
  for (const m of MEASURES) {
    if (!MINE.has(m.id)) continue;
    const declared = m.dimensions.filter((d) => d !== "currency" && d !== "business");
    const seen = emitted.get(m.id) ?? new Set<string>();
    for (const d of declared)
      if (!seen.has(d)) wrong.push(`${m.id}: declares ${d}, never emits it`);
    for (const d of seen) wrong.push(`${m.id}: emits ${d}, which it does not declare`);
    if ((currencies.get(m.id)?.size ?? 0) < 2)
      wrong.push(`${m.id}: declares currency, but only one reached the table`);
    if ([...(currencies.get(m.id) ?? [])].includes("XXX"))
      wrong.push(`${m.id}: wrote a currencyless row`);
  }
  ok("dimensions: every declared dimension is emitted, and nothing else is", wrong.length === 0);
  if (wrong.length) console.log("  ↳ registry/writer disagreements:", wrong.slice(0, 12));

  const orphaned = RATIO_MEASURES.filter((id) => !mine.some((r) => r.measure === id));
  ok(
    `coverage: all ${RATIO_MEASURES.length} derived measures actually wrote a row`,
    orphaned.length === 0,
  );
  if (orphaned.length) console.log("  ↳ measures never exercised:", orphaned);

  // Every stored ratio row carries BOTH halves. A numerator with no denominator is a figure
  // nobody can divide, and it would reach a reader as a silent null.
  const halfWritten = await withTenant(orgId, (tx) =>
    tx
      .select({ measure: metricDaily.measure, denominator: metricDaily.denominator })
      .from(metricDaily)
      .where(eq(metricDaily.businessId, bizId)),
  );
  ok(
    "storage: no ratio row was written with a missing denominator",
    // `net_new_mrr` is a plain flow in this group: it divides nothing.
    halfWritten.filter(
      (r) => MINE.has(r.measure) && r.measure !== "net_new_mrr" && r.denominator == null,
    ).length === 0,
  );
  /**
   * …and nothing else in the table grew one.
   *
   * SCOPED when the customer grain landed: a stored denominator is what makes a row a
   * quotient, and `customer_churn_rate` is a quotient that cannot be folded — it is computed
   * per grain rather than declared `ratio`, so it carries two halves without being one. The
   * two cohort-restricted retentions are the same case for the same reason. The two
   * customer-grain ratios are ordinary ratios and are covered by the first clause. Every
   * OTHER measure must still store nothing to divide by.
   */
  const DIVIDES = new Set<string>([
    ...MEASURES.filter((m) => m.aggregate === "ratio").map((m) => m.id),
    "customer_churn_rate",
    "gross_revenue_retention",
    "net_revenue_retention",
    "subscriber_churn_rate",
  ]);
  ok(
    "storage: a measure that does not divide at read still stores no denominator at all",
    halfWritten.filter((r) => !DIVIDES.has(r.measure) && r.denominator != null).length === 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. THE HISTORICAL RATE — a past period is valued at what it was EARNING then.
//
// `subscriptions.mrr` and the rate a subscription earned in the past do not agree in
// general: `subscriptions.mrr` is a CACHE OF THE PRESENT. It reads 0 the moment a
// subscription cancels and today's number the moment one re-rates, while the movement
// ledger the numerator comes off is dated correctly. A denominator read from the present
// against a numerator read from the past is two different books, and the loss can then
// exceed the opening without bound — a retention rate below −700% was stored on a real book
// before this section existed.
//
// Its own business, because the point is a book where the two readings DIFFER:
//
//   P  10,000 USD, ran 2025-01-01 → cancelled 2026-06-15; −2,000 on 2026-03-10. Column 0.
//   Q       0 USD, ran 2025-02-01 → cancelled 2026-06-15. Comped: worth nothing then too.
//   R   5,000 USD on its items, ran 2025-01-01 → cancelled 2026-06-15; +3,000 on 2025-03-15,
//       so 8,000 is the rate it last earned (recorded) — it moved up before it left. Down
//       6,000 on 2025-06-10 and back on 2025-07-10.
//   S   4,000 USD, running. The one row the column gets right.
//   T   2,000 EUR, ran 2024-12-15 → cancelled 2026-06-15; −500 and back in December 2024,
//       and again in June 2025 (the 20th, back on 20 July).
//
// So on 1 June 2025 and on 1 March 2026 the book is 22,000 USD (P 10,000 + R 8,000 + S 4,000)
// over three paying accounts and 2,000 EUR over one, and the column alone says 4,000 USD
// over one account and nothing at all in EUR. Every change is on the ledger, so the ledger
// balance and the recorded rate agree at both instants.
// ─────────────────────────────────────────────────────────────────────────────
{
  const horg = await createOrganization({ name: "Historical Rate Oracle Org" });
  const horgId = horg.organization.id;
  const hbiz = await createBusiness({
    organizationId: horgId,
    name: "Historical Rate Oracle Biz",
    defaultCurrency: "USD",
    timezone: "UTC",
    livemode: "test",
  });
  const hbizId = hbiz.id;
  const hplan = await createProduct({
    organizationId: horgId,
    businessId: hbizId,
    name: "Historical Plan",
  });
  let hseq = 0;
  const hprice = (currency: "USD" | "EUR", amountMinor: number) =>
    createPrice({
      organizationId: horgId,
      businessId: hbizId,
      productId: hplan.id,
      type: "recurring",
      model: "flat",
      currency,
      amountMinor,
      interval: "month",
    });
  /** One subscription on its own account, with its stock fields and its rates forced. */
  async function hsub(s: {
    currency: "USD" | "EUR";
    /** What its ITEMS say — the rate a re-rate recovers when nothing was recorded. */
    itemMinor: number;
    startedOn: string;
    canceledOn?: string;
    /** 0271, where the fixture wants the recorded rate to differ from the item rate. */
    lastEarningMinor?: number;
  }) {
    const cust = await createCustomer({
      organizationId: horgId,
      businessId: hbizId,
      email: `hist-${++hseq}-${Date.now()}@example.test`,
    });
    const { subscription } = await createSubscription({
      organizationId: horgId,
      businessId: hbizId,
      customerId: cust.id,
      now: day(s.startedOn),
      startDate: day(s.startedOn),
      items: [{ price: await hprice(s.currency, s.itemMinor), quantity: 1 }],
    });
    await systemDb
      .update(subscriptions)
      .set({
        status: s.canceledOn ? "cancelled" : "active",
        currency: s.currency,
        // The column is the PRESENT: zero once cancelled. That is the whole point.
        mrr: BigInt(s.canceledOn ? 0 : s.itemMinor),
        lastEarningMrr: s.lastEarningMinor == null ? null : BigInt(s.lastEarningMinor),
        createdAt: day(s.startedOn),
        startDate: day(s.startedOn),
        startedAt: day(s.startedOn),
        canceledAt: s.canceledOn ? day(s.canceledOn) : null,
        currentPeriodEnd: PARKED,
        trialEnd: PARKED,
      })
      .where(eq(subscriptions.id, subscription.id));
    return { id: subscription.id, customerId: cust.id };
  }

  const P = await hsub({
    currency: "USD",
    itemMinor: 10_000,
    startedOn: "2025-01-01",
    canceledOn: "2026-06-15",
  });
  // Q — comped, so nothing to book on the ledger.
  await hsub({
    currency: "USD",
    itemMinor: 0,
    startedOn: "2025-02-01",
    canceledOn: "2026-06-15",
  });
  const R = await hsub({
    currency: "USD",
    itemMinor: 5000,
    startedOn: "2025-01-01",
    canceledOn: "2026-06-15",
    lastEarningMinor: 8000,
  });
  const S = await hsub({ currency: "USD", itemMinor: 4000, startedOn: "2025-01-01" });
  const T = await hsub({
    currency: "EUR",
    itemMinor: 2000,
    startedOn: "2024-12-15",
    canceledOn: "2026-06-15",
  });

  // The ledger, stated outright — the seeding services' own rows are cleared first, exactly
  // as the first fixture does, so these rows are the whole of the arithmetic.
  await systemDb.delete(mrrMovements).where(eq(mrrMovements.businessId, hbizId));
  const usd = (h: { id: string; customerId: string }) => ({ ...h, currency: "USD" });
  const eur = (h: { id: string; customerId: string }) => ({ ...h, currency: "EUR" });
  await withTenant(horgId, (tx) =>
    tx.insert(mrrMovements).values(
      ledgerOf({ organizationId: horgId, businessId: hbizId, planProductId: hplan.id }, [
        ["2025-01-01T00:00:00.000Z", "new", usd(P), 10_000],
        ["2025-01-01T00:00:00.000Z", "new", usd(R), 5000],
        ["2025-01-01T00:00:00.000Z", "new", usd(S), 4000],
        ["2025-03-15T09:00:00.000Z", "expansion", usd(R), 3000],
        // A loss FAR back — June 2025 — big enough that the column alone (4,000) cannot
        // absorb it. This is the row that went negative.
        ["2025-06-10T09:00:00.000Z", "contraction", usd(R), -6000],
        ["2025-07-10T09:00:00.000Z", "expansion", usd(R), 6000],
        // …and a smaller one in a recent past month, so the gradient has two points.
        ["2026-03-10T09:00:00.000Z", "contraction", usd(P), -2000],
        ["2026-06-15T00:00:00.000Z", "churn", usd(P), -8000],
        ["2026-06-15T00:00:00.000Z", "churn", usd(R), -8000],
        // A loss inside a month that opened with nothing: T arrived in it.
        ["2024-12-15T00:00:00.000Z", "new", eur(T), 2000],
        ["2024-12-20T09:00:00.000Z", "contraction", eur(T), -500],
        ["2025-01-10T09:00:00.000Z", "expansion", eur(T), 500],
        ["2025-06-20T09:00:00.000Z", "contraction", eur(T), -500],
        ["2025-07-20T09:00:00.000Z", "expansion", eur(T), 500],
        ["2026-06-15T00:00:00.000Z", "churn", eur(T), -2000],
      ]),
    ),
  );
  await ledgerIsTheBook("historical book", horgId, hbizId);

  const hmaterialise = async (grain: Grain, periodEnd: string): Promise<Map<Key, Halves>> => {
    const computed = await withTenant(horgId, (tx) =>
      computeMetricPeriod(tx, hbizId, grain, periodEnd, NOW),
    );
    await writeMetricDay({
      organizationId: horgId,
      businessId: hbizId,
      grain,
      periodEnd,
      rows: computed,
    });
    const out = new Map<Key, Halves>();
    for (const r of computed) {
      if (!MINE.has(r.measure) || r.dim !== "") continue;
      out.set(key(r.measure, r.currency), {
        value: r.value,
        denominator: r.denominator ?? null,
      });
    }
    return out;
  };

  const H: Record<string, Map<Key, Halves>> = {};
  for (const [grain, periodEnd] of [
    ["month", "2024-12-31"],
    ["month", "2025-06-30"],
    ["month", "2026-03-31"],
    ["month", "2026-07-31"],
  ] as Array<[Grain, string]>) {
    H[periodEnd] = await hmaterialise(grain, periodEnd);
  }

  /**
   * THE INVARIANT THE WHOLE FINDING REDUCES TO — checked against an oracle that shares no
   * code with the writer's opening loop: the book, re-rated at the instant, summed here.
   */
  const openingOracle = async (at: Date): Promise<Map<string, bigint>> => {
    const sums = new Map<string, bigint>();
    await withTenant(horgId, async (tx) => {
      const book = await readBookWithCustomers(tx, hbizId);
      const rates = await loadReratedMrr(tx, hbizId, book, at);
      for (const s of book) {
        if (!MRR_STATUSES.has(s.status) || !liveAt(s, at)) continue;
        const c = s.currency.toUpperCase();
        sums.set(c, (sums.get(c) ?? 0n) + (rates.get(s.id) ?? s.mrr ?? 0n));
      }
    });
    return sums;
  };

  const grr = def("gross_revenue_retention");
  const openedWith = (periodEnd: string, currency: string) =>
    H[periodEnd]!.get(key("gross_revenue_retention", currency))?.denominator ?? null;

  for (const [periodEnd, from] of [
    ["2025-06-30", "2025-06-01"],
    ["2026-03-31", "2026-03-01"],
  ] as const) {
    const oracle = await openingOracle(day(from));
    ok(
      `history: the opening stock on ${from} is the re-rated book on ${from}, currency by currency`,
      openedWith(periodEnd, "USD") === (oracle.get("USD") ?? null) &&
        openedWith(periodEnd, "EUR") === (oracle.get("EUR") ?? null),
    );
  }

  ok(
    "history: a subscription that has since churned still counts at its own rate a YEAR back — 22,000, not the 4,000 the column has left",
    openedWith("2025-06-30", "USD") === 22_000n,
  );
  ok(
    "history: a comped subscription that has since churned contributes ZERO — not its list price, and not a spurious exclusion",
    // Q is in the book and live at both instants; it simply adds nothing. Were it excluded
    // rather than valued, the sums below would be unchanged — so the check that bites is the
    // head count further down, where Q is the one account that does NOT count as paying.
    openedWith("2026-03-31", "USD") === 22_000n && openedWith("2025-06-30", "USD") === 22_000n,
  );
  ok(
    "history: a subscription that moved rate before it left is valued at the rate it last EARNED (8,000), not at its item list price and not at today's zero",
    // R's ledger stands at 8,000 here, and so does its recorded rate. Its items' 5,000 would
    // make the book 19,000; today's column, 14,000.
    openedWith("2026-03-31", "USD") === 22_000n,
  );
  ok(
    "history: the EUR book a year back is 2,000, where the column alone reports no EUR at all",
    openedWith("2025-06-30", "EUR") === 2000n,
  );

  ok(
    "history: gross retention is never negative on a book where nothing arrived and left inside the window — far back",
    H["2025-06-30"]!.get(key("gross_revenue_retention", "USD"))!.value === 16_000n &&
      read(grr, H["2025-06-30"]!.get(key("gross_revenue_retention", "USD"))) === 7273 &&
      H["2025-06-30"]!.get(key("gross_revenue_retention", "EUR"))!.value === 1500n &&
      read(grr, H["2025-06-30"]!.get(key("gross_revenue_retention", "EUR"))) === 7500,
  );
  ok(
    "history: …and in a recent past month, where the error was smaller but still there",
    H["2026-03-31"]!.get(key("gross_revenue_retention", "USD"))!.value === 20_000n &&
      read(grr, H["2026-03-31"]!.get(key("gross_revenue_retention", "USD"))) === 9091,
  );
  ok(
    "history: every stored retention row on this book divides to something between nothing-left and nothing-lost",
    (["2025-06-30", "2026-03-31", "2026-07-31"] as const).every((pe) =>
      [...H[pe]!].every(([k, h]) => {
        if (!k.startsWith("gross_revenue_retention|")) return true;
        const r = read(grr, h);
        return r === null || (r >= 0 && r <= 10_000);
      }),
    ),
  );

  /**
   * THE ZERO DENOMINATOR, PINNED.
   *
   * December 2024 opened with nothing — the book had not started — and a loss was booked
   * inside it. The row is written, both halves as measured, and it publishes NULL: the
   * period has no retention rate, and 0% would be the false claim that everything was lost.
   */
  const dec = H["2024-12-31"]!.get(key("gross_revenue_retention", "EUR"));
  ok(
    "history: a period that opened with nothing stores both halves as measured — an empty cohort keeps its empty 0",
    // T arrived on 15 December and lost 500 on the 20th: nothing the period opened with was
    // lost, because it opened with nothing. Both halves are written rather than left null,
    // so a reader knows the period WAS measured.
    dec != null && dec.value === 0n && dec.denominator === 0n,
  );
  ok(
    "history: …and publishes NULL rather than 0%, an infinity or a NaN",
    read(grr, dec) === null &&
      read(
        def("net_revenue_retention"),
        H["2024-12-31"]!.get(key("net_revenue_retention", "EUR")),
      ) === null &&
      read(def("net_mrr_growth_rate"), H["2024-12-31"]!.get(key("net_mrr_growth_rate", "EUR"))) ===
        null,
  );

  /** The growth rate shares the opening stock, so it is corrected by the same change. */
  ok(
    "history: net_mrr_growth_rate divides by the SAME re-rated opening stock, not by the column",
    H["2025-06-30"]!.get(key("net_mrr_growth_rate", "USD"))!.denominator === 22_000n &&
      H["2026-03-31"]!.get(key("net_mrr_growth_rate", "USD"))!.denominator === 22_000n &&
      read(def("net_mrr_growth_rate"), H["2025-06-30"]!.get(key("net_mrr_growth_rate", "USD"))) ===
        -2727,
  );

  /**
   * THE HEAD COUNT — the second symptom of the same defect.
   *
   * Three USD accounts were paying in March 2026: P, R and S. Q was comped and is not one of
   * them. All three cancelled subscriptions have since ended, and the column reads 0 for
   * every one, which is why this count used to be 1.
   */
  const payingRows = await withTenant(horgId, (tx) =>
    tx
      .select({
        periodEnd: metricDaily.periodEnd,
        currency: metricDaily.currency,
        value: metricDaily.value,
      })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, hbizId),
          eq(metricDaily.measure, "paying_customers"),
          eq(metricDaily.grain, "month"),
        ),
      ),
  );
  /** The stored `paying_customers` row itself — the measure, not a ratio's denominator. */
  const payingAt = (periodEnd: string, currency: string) =>
    payingRows.find((r) => r.periodEnd === periodEnd && r.currency === currency)?.value ?? null;
  const payingDenom = (periodEnd: string, currency: string) =>
    H[periodEnd]!.get(key("revenue_per_paying_customer", currency))?.denominator ?? null;
  ok(
    "history: the paying-customer count at a past instant INCLUDES someone who has since churned — three USD accounts, not the one still running",
    payingAt("2026-03-31", "USD") === 3n && payingAt("2025-06-30", "USD") === 3n,
  );
  ok(
    "history: …and the comped account is not one of them — worth nothing is not paying",
    // Four USD accounts are live at both instants; Q is the one left out.
    payingAt("2026-03-31", "USD") === 3n && payingAt("2025-06-30", "USD") === 3n,
  );
  ok(
    "history: the EUR book had a paying account a year back, where the column reports none",
    payingAt("2025-06-30", "EUR") === 1n,
  );
  ok(
    "history: after they leave the count drops — the fix is a DATED read, not a blanket inclusion",
    payingAt("2026-07-31", "USD") === 1n && payingAt("2026-07-31", "EUR") === 0n,
  );
  ok(
    "history: the count and the denominator revenue-per-customer divides by are the SAME number",
    (["2025-06-30", "2026-03-31", "2026-07-31"] as const).every((pe) =>
      (["USD", "EUR"] as const).every(
        (c) => payingDenom(pe, c) === null || payingDenom(pe, c) === payingAt(pe, c),
      ),
    ),
  );
  ok(
    // 31 March: P 8,000 (after its contraction) + R 8,000 + S 4,000.
    "history: revenue per paying customer is therefore not inflated — 20,000 over 3, not over 1",
    H["2026-03-31"]!.get(key("revenue_per_paying_customer", "USD"))!.value === 20_000n &&
      H["2026-03-31"]!.get(key("revenue_per_paying_customer", "USD"))!.denominator === 3n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. THE OPENING COHORT — retention may only lose what it opened with.
//
// The defect this section pins: the numerator took EVERY contraction, churn and pause in
// the window while the denominator was the cohort that existed at `from`. A subscription
// that both arrived and left inside the window was counted as lost against an opening it
// was never part of, so the loss could exceed the opening without bound — 334 stored rows
// on the dev book divided to a NEGATIVE retention rate, and on the worst of them the loss
// attributable to the opening cohort was zero.
//
// Its own business, four accounts, one currency, one month:
//
//   X  10,000 USD, ran 2026-05-15 → churned 2026-06-10. In June's opening cohort, and lost.
//   Y   7,000 USD, ran 2026-06-05 → churned 2026-06-20. ARRIVED AND LEFT INSIDE JUNE.
//   Z   3,000 USD, running since January, expands by 2,000 on 12 June. In the cohort.
//   W   6,500 USD, arrived 3 June, expands by 5,000 on 15 June. Not in the cohort.
//
// June opened with 13,000 (X and Z). It gave up 10,000 of it and grew 2,000 of it. Every
// other movement in the month belongs to subscriptions June never opened with.
// ─────────────────────────────────────────────────────────────────────────────
{
  const corg = await createOrganization({ name: "Opening Cohort Oracle Org" });
  const corgId = corg.organization.id;
  const cbiz = await createBusiness({
    organizationId: corgId,
    name: "Opening Cohort Oracle Biz",
    defaultCurrency: "USD",
    timezone: "UTC",
    livemode: "test",
  });
  const cbizId = cbiz.id;
  const cplan = await createProduct({
    organizationId: corgId,
    businessId: cbizId,
    name: "Cohort Plan",
  });
  let cseq = 0;
  /** Both stamps are full instants here: a subscription that cancels at 09:00 was still
   *  there when its day opened, which is exactly the distinction this section measures.
   *  `mrrMinor` is its starting rate; `closingMinor` the column, where its ledger ends. */
  async function csub(s: {
    mrrMinor: number;
    closingMinor: number;
    startedAt: string;
    canceledAt?: string;
  }) {
    const cust = await createCustomer({
      organizationId: corgId,
      businessId: cbizId,
      email: `cohort-${++cseq}-${Date.now()}@example.test`,
    });
    const price = await createPrice({
      organizationId: corgId,
      businessId: cbizId,
      productId: cplan.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: s.mrrMinor,
      interval: "month",
    });
    const { subscription } = await createSubscription({
      organizationId: corgId,
      businessId: cbizId,
      customerId: cust.id,
      now: new Date(s.startedAt),
      startDate: new Date(s.startedAt),
      items: [{ price, quantity: 1 }],
    });
    await systemDb
      .update(subscriptions)
      .set({
        status: s.canceledAt ? "cancelled" : "active",
        currency: "USD",
        mrr: BigInt(s.closingMinor),
        createdAt: new Date(s.startedAt),
        startDate: new Date(s.startedAt),
        startedAt: new Date(s.startedAt),
        canceledAt: s.canceledAt ? new Date(s.canceledAt) : null,
        currentPeriodEnd: PARKED,
        trialEnd: PARKED,
      })
      .where(eq(subscriptions.id, subscription.id));
    return { id: subscription.id, customerId: cust.id, currency: "USD" };
  }

  const X = await csub({
    mrrMinor: 10_000,
    closingMinor: 0,
    startedAt: "2026-05-15T09:00:00.000Z",
    canceledAt: "2026-06-10T09:00:00.000Z",
  });
  const Y = await csub({
    mrrMinor: 7000,
    closingMinor: 0,
    startedAt: "2026-06-05T09:00:00.000Z",
    canceledAt: "2026-06-20T09:00:00.000Z",
  });
  const Z = await csub({
    mrrMinor: 3000,
    closingMinor: 5000,
    startedAt: "2026-01-01T09:00:00.000Z",
  });
  const W = await csub({
    mrrMinor: 6500,
    closingMinor: 11_500,
    startedAt: "2026-06-03T09:00:00.000Z",
  });

  await systemDb.delete(mrrMovements).where(eq(mrrMovements.businessId, cbizId));
  await withTenant(corgId, (tx) =>
    tx.insert(mrrMovements).values(
      ledgerOf({ organizationId: corgId, businessId: cbizId, planProductId: cplan.id }, [
        // Before June: what June opens with. X's arrival is also inside the quarter.
        ["2026-01-01T09:00:00.000Z", "new", Z, 3000],
        ["2026-05-15T09:00:00.000Z", "new", X, 10_000],
        ["2026-06-03T09:00:00.000Z", "new", W, 6500],
        ["2026-06-05T09:00:00.000Z", "new", Y, 7000],
        ["2026-06-10T09:00:00.000Z", "churn", X, -10_000],
        ["2026-06-12T09:00:00.000Z", "expansion", Z, 2000],
        ["2026-06-15T09:00:00.000Z", "expansion", W, 5000],
        ["2026-06-20T09:00:00.000Z", "churn", Y, -7000],
      ]),
    ),
  );
  await ledgerIsTheBook("cohort book", corgId, cbizId);

  const cmaterialise = async (grain: Grain, periodEnd: string): Promise<Map<Key, Halves>> => {
    const computed = await withTenant(corgId, (tx) =>
      computeMetricPeriod(tx, cbizId, grain, periodEnd, NOW),
    );
    await writeMetricDay({
      organizationId: corgId,
      businessId: cbizId,
      grain,
      periodEnd,
      rows: computed,
    });
    const out = new Map<Key, Halves>();
    for (const r of computed) {
      if (!MINE.has(r.measure) || r.dim !== "") continue;
      out.set(key(r.measure, r.currency), { value: r.value, denominator: r.denominator ?? null });
    }
    return out;
  };

  const C = await cmaterialise("month", "2026-06-30");
  const Cq = await cmaterialise("quarter", "2026-06-30");
  const grr = def("gross_revenue_retention");
  const nrr = def("net_revenue_retention");
  const juneGrr = C.get(key("gross_revenue_retention", "USD"));
  const juneNrr = C.get(key("net_revenue_retention", "USD"));

  ok(
    "cohort: June opened with the 13,000 X and Z held, and nothing that arrived inside it",
    juneGrr?.denominator === 13_000n && juneNrr?.denominator === 13_000n,
  );
  /**
   * THE CASE BEHIND EVERY NEGATIVE ROW. Y arrived on 5 June and left on 20 June. Its 7,000
   * is a real loss on the ledger and it is NOT a loss of anything June opened with, so it
   * does not reduce June's retention. Counting it gave a numerator of −4,000 against an
   * opening of 13,000 — a retention rate of −3,077 basis points, which is not a rate.
   */
  ok(
    "cohort: a subscription that ARRIVED AND LEFT inside the window does not reduce that window's retention",
    juneGrr?.value === 3000n && read(grr, juneGrr) === 2308,
  );
  // Built from the stored halves rather than written out: the month's opening, less every
  // loss the month saw — which is the quick ratio's denominator, and is what retention used
  // to subtract.
  const unrestricted =
    (juneGrr?.denominator ?? 0n) - (C.get(key("quick_ratio", "USD"))?.denominator ?? 0n);
  ok(
    "cohort: …and the old, unrestricted numerator would have been NEGATIVE on this same book",
    unrestricted === -4000n &&
      read(grr, { value: unrestricted, denominator: juneGrr?.denominator ?? 0n }) === -3077,
  );
  ok(
    "cohort: a subscription that WAS in the opening cohort still reduces it — X's 10,000 is gone",
    juneGrr?.value === 13_000n - 10_000n,
  );
  /**
   * Net retention restricts BOTH halves to the same cohort. Z's 2,000 is the base growing;
   * W's 5,000 is new business that happened to arrive as an expansion, and a figure that
   * counted it would say the base grew when it was replaced.
   */
  ok(
    "cohort: net retention counts the opening cohort's expansion (Z's 2,000) and not a newcomer's (W's 5,000)",
    juneNrr?.value === 5000n && read(nrr, juneNrr) === 3846,
  );
  /**
   * …and the growth rate restricts NEITHER half, because new business is exactly what it
   * exists to include: 3,500 of net movement over the 13,000 the month opened with.
   */
  ok(
    "cohort: the growth rate is NOT cohort-restricted — the whole book's net movement over the opening",
    C.get(key("net_mrr_growth_rate", "USD"))?.value === 3500n &&
      read(def("net_mrr_growth_rate"), C.get(key("net_mrr_growth_rate", "USD"))) === 2692,
  );
  ok(
    "cohort: nor is the quick ratio — 20,500 gained over 17,000 lost, every movement in the month",
    C.get(key("quick_ratio", "USD"))?.value === 20_500n &&
      C.get(key("quick_ratio", "USD"))?.denominator === 17_000n,
  );

  /**
   * THE QUARTER IS A DIFFERENT COHORT, AND THAT IS THE WHOLE COST OF THE FIX.
   *
   * Only Z was there on 1 April, so the second quarter opened with 3,000 and lost none of
   * it: X arrived in May, Y in June, and neither was ever part of what the quarter opened
   * with. The quarter is 100% retention on 3,000 — and folding its day rows would give
   * 3,000 − 17,000 = −4,000, because each of those days had its OWN opening cohort and X
   * and Y were in theirs. Both numbers are stated here; only one is published.
   */
  const qGrr = Cq.get(key("gross_revenue_retention", "USD"));
  ok(
    "cohort: the quarter opened with Z's 3,000 alone and lost none of it — 100%, not a fold's −4,000",
    qGrr?.value === 3000n && qGrr?.denominator === 3000n && read(grr, qGrr) === 10_000,
  );

  // Every June day, so the fold a reader could have done is actually available to measure.
  for (
    let d = new Date("2026-06-01T00:00:00.000Z");
    d <= new Date("2026-06-30T00:00:00.000Z");
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    await cmaterialise("day", d.toISOString().slice(0, 10));
  }
  const dayRows = await withTenant(corgId, (tx) =>
    tx
      .select({ value: metricDaily.value, denominator: metricDaily.denominator })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, cbizId),
          eq(metricDaily.measure, "gross_revenue_retention"),
          eq(metricDaily.grain, "day"),
        ),
      ),
  );
  const foldedMovement = dayRows.reduce(
    (t, r) => t + ((r.value ?? 0n) - (r.denominator ?? 0n)),
    0n,
  );
  ok(
    "cohort: the day rows are each right for their OWN cohort — X and Y are in theirs, so they sum to −17,000",
    foldedMovement === -17_000n,
  );
  /**
   * BOTH WAYS, which is the point of this pair: the month computed directly is 2,308 basis
   * points; the same month folded out of those day rows would be −3,077. They cannot agree,
   * so the reader must not fold — and it does not: asked for June it returns the stored
   * month, and asked for a week nobody wrote it returns nothing at all.
   */
  const juneRead = await readMetricSeries({
    organizationId: corgId,
    businessIds: [cbizId],
    measure: "gross_revenue_retention",
    grain: "month",
    periods: [{ start: "2026-06-01", end: "2026-06-30", label: "June" }],
  });
  const juneCell = juneRead.cells.find((c) => c.currency === "USD");
  ok(
    "cohort: the reader answers June with the month that was WRITTEN (3,000 / 13,000), never the fold of its days",
    juneCell?.value === 3000n &&
      juneCell?.denominator === 13_000n &&
      ratioValue(grr, juneCell?.value ?? null, juneCell?.denominator ?? null) === 2308,
  );
  const weekRead = await readMetricSeries({
    organizationId: corgId,
    businessIds: [cbizId],
    measure: "gross_revenue_retention",
    grain: "week",
    periods: [{ start: "2026-06-08", end: "2026-06-14", label: "w" }],
  });
  ok(
    "cohort: …and a grain nobody wrote is reported missing rather than returning a foldable-looking number",
    weekRead.cells.length === 0 && weekRead.missing.length > 0,
  );

  /**
   * THE INVARIANT, over every retention row this business has: a cohort cannot lose more
   * than it had, and cannot keep more than it had. Nothing pathological happened on this
   * book — one arrival, one departure, one of each inside the window — so every rate it
   * produces belongs between nothing-left and nothing-lost.
   */
  const stored = await withTenant(corgId, (tx) =>
    tx
      .select({
        measure: metricDaily.measure,
        grain: metricDaily.grain,
        periodEnd: metricDaily.periodEnd,
        value: metricDaily.value,
        denominator: metricDaily.denominator,
      })
      .from(metricDaily)
      .where(
        and(eq(metricDaily.businessId, cbizId), eq(metricDaily.measure, "gross_revenue_retention")),
      ),
  );
  const outOfRange = stored.filter((r) => {
    const v = ratioValue(grr, r.value, r.denominator);
    return v != null && (v < 0 || v > 10_000);
  });
  ok(
    `cohort: all ${stored.length} stored retention rows divide to between 0% and 100% — none negative, none above 100%`,
    stored.length > 0 && outOfRange.length === 0,
  );
  if (outOfRange.length) console.log("  ↳ out of range:", outOfRange.slice(0, 6));
  ok(
    "cohort: …and the opening is never exceeded on either side — the numerator stays inside [0, opening]",
    stored.every((r) => r.value == null || (r.value >= 0n && r.value <= (r.denominator ?? 0n))),
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-RATIOS: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-RATIOS: FAIL (${failed}/${checks.length} failed)`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
