/**
 * The ORACLE GATE for the customer grain (Phase 7, group 6).
 *
 * Eight figures counted in ACCOUNTS, and the first in the semantic layer that are NOT
 * ADDITIVE. Everything before them counted events or money, so a month was the sum of its
 * days. These count people: an account that moved in April and again in May is ONE account
 * across the two, and a reader that added them would report it twice.
 *
 * The gate proves that against TWO independent oracles:
 *
 *   1. AN EXPECTED TABLE, worked out by hand from the fixture — what a person gets with a
 *      pencil, agreeing with neither the writer nor the reports.
 *   2. THE PUBLISHED REPORTS, which already answer these eight questions. A measure that
 *      quietly redefined its figure fails here; the three places we redefined it ON PURPOSE
 *      are asserted as divergences with both numbers, rather than compared loosely.
 *
 * ⚠️ THE ONE THING THIS GATE EXISTS TO PROTECT: a distinct count must never be folded out of
 * finer rows. The second quarter saw 6 USD accounts move. Its three months saw 3, 3 and 4 —
 * which sums to 10, because A moved in all three. The gate asserts 6 AND 10 side by side, so a
 * writer that skipped the per-grain row, or a reader that summed the months, fails with the
 * two figures next to each other rather than passing at two-thirds too high.
 *
 * The properties, in the order a wrong implementation breaks them:
 *   0. the per-grain write path itself, proven end to end on ONE measure first;
 *   1. the hand-worked table is stored, at every grain, to the unit;
 *   2. NON-ADDITIVITY — the quarter is the quarter, and it is not the sum of its months;
 *   3. a grain that was never written is REFUSED, never synthesised;
 *   4. the published reports still say what the store says — or diverge by a stated amount;
 *   5. a customer is counted ONCE, so the per-currency counts sum to the accounts there are;
 *   6. null is not zero: a book with nothing to lose has no churn rate;
 *   7. declared == emitted, both ways, for every dimension.
 *
 *   pnpm verify:metric-customers
 */
import { and, eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { coarsePeriodEnds } from "@/modules/metrics/daily/cron";
import { DEFAULT_CALENDAR } from "@/platform/business-calendar";
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
  CUSTOMER_DISTINCT_MEASURES,
  CUSTOMER_MEASURES,
} from "@/modules/metrics/daily/customer-measures";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { businesses, metricDaily, mrrMovements, subscriptions } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** Past the real clock, so a live billing worker never renews anything in this fixture. */
const PARKED = day("2028-01-01");
/** Inside July, so a 12-month report's June bucket is the June this fixture is built around. */
const NOW = new Date("2026-07-15T12:00:00.000Z");
/** One thirty-day month, in milliseconds — the unit `average_customer_lifetime` divides to. */
const MONTH_MS = 2_592_000_000;
const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────
// Seed — its own organization and business, never the dev database's book.
// ─────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Customer Grain Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Customer Grain Oracle Biz",
  defaultCurrency: "USD",
  // UTC on purpose: the reports cut their months in the BUSINESS's timezone and these rows
  // are cut on the UTC calendar. On any other zone the two Junes are hours apart at each edge.
  timezone: "UTC",
  livemode: "test",
});
const bizId = biz.id;
/**
 * One EUR rate, at parity.
 *
 * The reports' unscoped view converts everything into the business's own currency and
 * EXCLUDES what it cannot convert, so without a rate a cross-currency comparison would be
 * USD against USD and would prove nothing. Parity, because a head count does not scale with
 * an exchange rate and a rate that did would make the fixture harder to read, not truer.
 */
await systemDb
  .update(businesses)
  .set({ exchangeRates: { EUR: 1 } })
  .where(eq(businesses.id, bizId));

const plan = await createProduct({ organizationId: orgId, businessId: bizId, name: "Plan" });
const priceUsd = await createPrice({
  organizationId: orgId,
  businessId: bizId,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
const priceEur = await createPrice({
  organizationId: orgId,
  businessId: bizId,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "EUR",
  amountMinor: 1000,
  interval: "month",
});

let seq = 0;
const customer = (name: string) =>
  createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `cust-grain-${name}-${++seq}-${Date.now()}@example.test`,
  });

/**
 * The ledger, built WITH the book. The engine reads every stock — MRR, the paying and live
 * head counts — as Σ delta per subscription up to the instant, so each subscription books a
 * `new` at its start, its changes, and a `churn` of whatever it still carries at its
 * cancellation. Its running balance is its MRR at every instant, and never below zero.
 */
type LedgerRow = typeof mrrMovements.$inferInsert;
const ledger: LedgerRow[] = [];

async function addSub(s: {
  customerId: string;
  currency: "USD" | "EUR";
  /** Booked as `new` at the start. 0 books nothing: a trial never paid. */
  openingMinor: number;
  startedOn: string;
  changes?: Array<{ at: string; reason: "expansion" | "contraction"; delta: number }>;
  canceledOn?: string;
  status?: string;
}) {
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: s.customerId,
    now: day(s.startedOn),
    startDate: day(s.startedOn),
    items: [{ price: s.currency === "USD" ? priceUsd : priceEur, quantity: 1 }],
  });
  let mrr = 0;
  const book = (at: Date, reason: string, delta: number) => {
    if (mrr + delta < 0) throw new Error(`fixture: ${reason} takes MRR below zero`);
    ledger.push({
      organizationId: orgId,
      businessId: bizId,
      subscriptionId: subscription.id,
      customerId: s.customerId,
      reason,
      planProductId: plan.id,
      currency: s.currency,
      previousMrrMinor: BigInt(mrr),
      newMrrMinor: BigInt(mrr + delta),
      deltaMinor: BigInt(delta),
      occurredAt: at,
    });
    mrr += delta;
  };
  if (s.openingMinor > 0) book(day(s.startedOn), "new", s.openingMinor);
  for (const c of s.changes ?? []) book(new Date(c.at), c.reason, c.delta);
  if (s.canceledOn && mrr > 0) book(day(s.canceledOn), "churn", -mrr);
  await systemDb
    .update(subscriptions)
    .set({
      status: s.status ?? (s.canceledOn ? "cancelled" : "active"),
      currency: s.currency,
      mrr: BigInt(mrr),
      createdAt: day(s.startedOn),
      startDate: day(s.startedOn),
      startedAt: day(s.startedOn),
      canceledAt: s.canceledOn ? day(s.canceledOn) : null,
      currentPeriodEnd: PARKED,
      trialEnd: PARKED,
    })
    .where(eq(subscriptions.id, subscription.id));
}

// G — opens BEFORE the quarter, so the quarter has a base to lose. Lost in May.
const g = await customer("g");
await addSub({
  customerId: g.id,
  currency: "USD",
  openingMinor: 2500,
  startedOn: "2026-01-10",
  canceledOn: "2026-05-20",
});
// A — one account, TWO live USD lines: why a head count is not a sum of subscriptions, and
// the account that moves in all three months of the quarter.
const a = await customer("a");
await addSub({
  customerId: a.id,
  currency: "USD",
  openingMinor: 4000,
  startedOn: "2026-04-08",
  changes: [
    { at: "2026-05-12T09:00:00.000Z", reason: "expansion", delta: 1000 },
    { at: "2026-06-18T09:00:00.000Z", reason: "contraction", delta: -500 },
  ],
});
await addSub({ customerId: a.id, currency: "USD", openingMinor: 5000, startedOn: "2026-05-20" });
// I — cancels ONE line of two and keeps the other: a subscription churned, an account kept.
const i = await customer("i");
await addSub({ customerId: i.id, currency: "USD", openingMinor: 2000, startedOn: "2026-04-05" });
await addSub({
  customerId: i.id,
  currency: "USD",
  openingMinor: 1500,
  startedOn: "2026-04-06",
  canceledOn: "2026-06-10",
});
// B — arrives in April, the account lost in June.
const b = await customer("b");
await addSub({
  customerId: b.id,
  currency: "USD",
  openingMinor: 3000,
  startedOn: "2026-04-10",
  canceledOn: "2026-06-20",
});
// C — arrives and leaves inside May. D — arrives in June and stays.
const c = await customer("c");
await addSub({
  customerId: c.id,
  currency: "USD",
  openingMinor: 2000,
  startedOn: "2026-05-04",
  canceledOn: "2026-05-25",
});
const d = await customer("d");
await addSub({ customerId: d.id, currency: "USD", openingMinor: 1500, startedOn: "2026-06-05" });
// E — the EUR book's living account.
const e = await customer("e");
await addSub({
  customerId: e.id,
  currency: "EUR",
  openingMinor: 800,
  startedOn: "2026-04-15",
  changes: [{ at: "2026-06-22T09:00:00.000Z", reason: "expansion", delta: 200 }],
});
// F — the EUR book's ended account, gone before the quarter opens.
const f = await customer("f");
await addSub({
  customerId: f.id,
  currency: "EUR",
  openingMinor: 700,
  startedOn: "2026-01-01",
  canceledOn: "2026-03-01",
});
// J — pays in BOTH currencies: USD 1,200 against EUR 5,000, so counted once, in EUR.
const j = await customer("j");
await addSub({
  customerId: j.id,
  currency: "USD",
  openingMinor: 1000,
  startedOn: "2026-04-20",
  changes: [{ at: "2026-05-18T09:00:00.000Z", reason: "expansion", delta: 200 }],
});
await addSub({ customerId: j.id, currency: "EUR", openingMinor: 5000, startedOn: "2026-04-20" });
// H — a TRIALING account, and the reason our active count and the published one differ.
const h = await customer("h");
await addSub({
  customerId: h.id,
  currency: "USD",
  openingMinor: 0,
  startedOn: "2026-06-01",
  status: "in_trial",
});

// The services' own filings are replaced by the ledger above, so nothing a service starts
// filing can move a figure this gate calls exact. Unscoped client: the tenant role is denied
// DELETE on the ledger, which is exactly the guard the append-only rule exists for.
await systemDb.delete(mrrMovements).where(eq(mrrMovements.businessId, bizId));
await withTenant(orgId, (tx) => tx.insert(mrrMovements).values(ledger));

// ─────────────────────────────────────────────────────────────────────────────
// Materialise.
// ─────────────────────────────────────────────────────────────────────────────
const MINE = new Set<string>(CUSTOMER_MEASURES);
const NOT_FOLDABLE = new Set<string>(CUSTOMER_DISTINCT_MEASURES);
const key = (measure: string, currency: string) => `${measure}|${currency}`;
interface Halves {
  value: bigint | null;
  denominator: bigint | null;
}

async function materialise(grain: Grain, periodEnd: string): Promise<Map<string, Halves>> {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, grain, periodEnd, NOW),
  );
  await writeMetricDay({ organizationId: orgId, businessId: bizId, grain, periodEnd, rows });
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select({
        measure: metricDaily.measure,
        dim: metricDaily.dim,
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
  const out = new Map<string, Halves>();
  for (const r of stored) {
    if (!MINE.has(r.measure) || r.dim !== "") continue;
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
  ["day", "2026-07-15"],
];
const materialised = new Map<string, Map<string, Halves>>();
for (const [grain, periodEnd] of SAMPLED) {
  materialised.set(`${grain}|${periodEnd}`, await materialise(grain, periodEnd));
}
const M = (grain: Grain, periodEnd: string) => materialised.get(`${grain}|${periodEnd}`)!;

/** The measure's own divide, so the gate never forms a quotient a reader would not. */
const read = (m: MeasureDef, h: Halves | undefined): number | null =>
  h === undefined ? null : ratioValue(m, h.value, h.denominator);
const def = (id: string): MeasureDef => measureById(id)!;

// ─────────────────────────────────────────────────────────────────────────────
// 0. THE PER-GRAIN WRITE PATH, PROVEN ON ONE MEASURE BEFORE THE OTHER SEVEN EXIST.
//
// `customers_moved` is the purest distinct count in the group: no revenue test, no history,
// just "did this account's revenue move inside this window". It is the measure the whole
// `none` aggregation was built for, so it is the one the path is proven on.
// ─────────────────────────────────────────────────────────────────────────────
{
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        grain: metricDaily.grain,
        periodEnd: metricDaily.periodEnd,
        value: metricDaily.value,
        currency: metricDaily.currency,
      })
      .from(metricDaily)
      .where(and(eq(metricDaily.businessId, bizId), eq(metricDaily.measure, "customers_moved"))),
  );
  const at = (grain: string, periodEnd: string, currency: string) =>
    rows.find((r) => r.grain === grain && r.periodEnd === periodEnd && r.currency === currency)
      ?.value ?? null;

  ok(
    "per-grain: `customers_moved` is stored under its OWN grain — the month and the quarter are separate rows",
    at("month", "2026-06-30", "USD") === 4n && at("quarter", "2026-06-30", "USD") === 6n,
  );
  ok(
    "per-grain: the two rows share a period_end and differ only by grain, which is what the column is for",
    rows.filter((r) => r.periodEnd === "2026-06-30" && r.currency === "USD").length === 2,
  );
  ok(
    "per-grain: the registry says so — `customers_moved` declares `aggregate: none`, a promise it cannot be re-aggregated",
    def("customers_moved").aggregate === "none" && def("customers_moved").kind === "flow",
  );

  // …and the reader honours it. Ask for the quarter and you get the quarter's own row.
  const quarter = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "customers_moved",
    grain: "quarter",
    periods: [{ start: "2026-04-01", end: "2026-06-30", label: "Q2" }],
  });
  ok(
    "per-grain: reading the quarter returns the quarter's stored 6 accounts, not a fold of anything",
    quarter.cells.find((c) => c.currency === "USD")?.value === 6n && quarter.missing.length === 0,
  );

  /**
   * THE REFUSAL. 2026 is a grain nothing wrote. A foldable measure would happily build it out
   * of day rows; this one must say it does not have it, because no arithmetic produces it.
   */
  const year = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "customers_moved",
    grain: "year",
    periods: [{ start: "2026-01-01", end: "2026-12-31", label: "2026" }],
  });
  ok(
    "per-grain: a grain that was never written is REPORTED MISSING, never synthesised out of finer rows",
    year.cells.length === 0 && year.missing.join(",") === "2026-12-31",
  );

  // The nightly cron is what writes those coarser rows, and it keys them on the calendar END
  // of the period containing the day — so a period still running sits where a reader asks.
  // Default calendar: Sunday–Saturday weeks, so Wednesday 20 May closes on Saturday the 23rd.
  const ends = new Map(coarsePeriodEnds("2026-05-20", DEFAULT_CALENDAR));
  ok(
    "per-grain: the cron closes the week, month, quarter and year containing a day, on the calendar",
    ends.get("week") === "2026-05-23" &&
      ends.get("month") === "2026-05-31" &&
      ends.get("quarter") === "2026-06-30" &&
      ends.get("year") === "2026-12-31",
  );
  const onlyNone = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, "quarter", "2026-06-30", NOW, { onlyNonAdditive: true }),
  );
  /**
   * The pass is defined by the REGISTRY, not by this file's family: every measure declaring
   * `aggregate: "none"` and nothing else. The customer distinct counts were the first, and
   * the cohort-restricted retentions joined them — a gate that named only its own four
   * would fail the day another measure correctly stopped folding.
   */
  const perGrain = new Set(MEASURES.filter((m) => m.aggregate === "none").map((m) => m.id));
  ok(
    "per-grain: that pass computes ONLY the non-additive measures — the rest are stored once, daily, and folded",
    onlyNone.length > 0 &&
      [...NOT_FOLDABLE].every((id) => perGrain.has(id)) &&
      onlyNone.every((r) => perGrain.has(r.measure)) &&
      new Set(onlyNone.map((r) => r.measure)).size === perGrain.size,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE EXPECTED TABLE — worked out from the fixture by hand, not from either side.
//
// The ledger, by account: A moves in April, May AND June. B in April and June, churning in
// June. C arrives and leaves inside May. D arrives in June. E in April and June. I in April
// and June, keeping one line. J in April (both currencies) and May. G opened in JANUARY and
// churns in May. F ended in March and moves in no month of the quarter.
// J is counted in EUR: 5,000 of EUR movement against 1,200 of USD.
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED: Array<[Grain, string, string, string, bigint | null, bigint | null]> = [
  // grain, periodEnd, measure, currency, value, denominator
  // ── April: four accounts move, all four for the first time. Only G was there to lose. ──
  ["month", "2026-04-30", "customers_new", "USD", 3n, null],
  ["month", "2026-04-30", "customers_new", "EUR", 2n, null],
  ["month", "2026-04-30", "customers_churned", "USD", 0n, null],
  ["month", "2026-04-30", "customers_moved", "USD", 3n, null],
  ["month", "2026-04-30", "customers_moved", "EUR", 2n, null],
  ["month", "2026-04-30", "customer_churn_rate", "USD", 0n, 1n],
  ["month", "2026-04-30", "customer_churn_rate", "EUR", 0n, 0n],
  // ── May: C arrives and leaves inside it; G, who we HAD, leaves. ──
  ["month", "2026-05-31", "customers_new", "USD", 1n, null],
  ["month", "2026-05-31", "customers_churned", "USD", 2n, null],
  ["month", "2026-05-31", "customers_moved", "USD", 3n, null],
  ["month", "2026-05-31", "customers_moved", "EUR", 1n, null],
  // C and G lost — but only G was in the base (A, B, G, I), so the rate is 1 in 4 USD.
  ["month", "2026-05-31", "customer_churn_rate", "USD", 1n, 4n],
  ["month", "2026-05-31", "customer_churn_rate", "EUR", 0n, 2n],
  // ── June ──
  ["month", "2026-06-30", "customers_new", "USD", 1n, null],
  ["month", "2026-06-30", "customers_churned", "USD", 1n, null],
  ["month", "2026-06-30", "customers_moved", "USD", 4n, null],
  ["month", "2026-06-30", "customers_moved", "EUR", 1n, null],
  ["month", "2026-06-30", "customer_churn_rate", "USD", 1n, 3n],
  // ── The quarter, as its OWN period. Not one of its months, and not their sum. ──
  ["quarter", "2026-06-30", "customers_new", "USD", 5n, null],
  ["quarter", "2026-06-30", "customers_new", "EUR", 2n, null],
  ["quarter", "2026-06-30", "customers_churned", "USD", 3n, null],
  ["quarter", "2026-06-30", "customers_moved", "USD", 6n, null],
  ["quarter", "2026-06-30", "customers_moved", "EUR", 2n, null],
  // G alone opened the quarter with revenue, and G alone was lost: 100%.
  ["quarter", "2026-06-30", "customer_churn_rate", "USD", 1n, 1n],
  // ── The book, at the period's end: A, I, D live in USD; E, and J by its larger EUR line.
  // Lines count in their OWN currency: USD a1 a2 i1 d1 j1 over A I D, EUR e1 j2 over E J.
  ["month", "2026-06-30", "active_customers", "USD", 3n, null],
  ["month", "2026-06-30", "active_customers", "EUR", 2n, null],
  ["month", "2026-06-30", "paying_customers", "USD", 3n, null],
  ["month", "2026-06-30", "paying_customers", "EUR", 2n, null],
  ["month", "2026-06-30", "subscriptions_per_customer", "USD", 5n, 3n],
  ["month", "2026-06-30", "subscriptions_per_customer", "EUR", 2n, 2n],
  // G 130 days, B 71, C 21 — 222 days over three accounts. F's 59 days are the EUR book's.
  ["month", "2026-06-30", "average_customer_lifetime", "USD", BigInt(222 * DAY_MS), 3n],
  ["month", "2026-06-30", "average_customer_lifetime", "EUR", BigInt(59 * DAY_MS), 1n],
];
{
  const wrong: string[] = [];
  for (const [grain, periodEnd, measure, currency, wantValue, wantDen] of EXPECTED) {
    const got = M(grain, periodEnd).get(key(measure, currency));
    if (got === undefined || got.value !== wantValue || got.denominator !== wantDen) {
      wrong.push(
        `${grain} ${periodEnd} ${measure} ${currency}: want ${wantValue}/${wantDen}, stored ${got?.value}/${got?.denominator}`,
      );
    }
  }
  ok(
    `oracle: all ${EXPECTED.length} hand-worked figures are stored, at the grain they belong to`,
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ mismatches:", wrong.slice(0, 15));

  // …and the quotients those pairs produce, so a wrong DIVIDE is as visible as a wrong count.
  const june = M("month", "2026-06-30");
  const QUOTIENTS: Array<[string, string, number | null]> = [
    // 1 lost of the 3 we had, in basis points.
    ["customer_churn_rate", "USD", 3333],
    ["customer_churn_rate", "EUR", 0],
    ["subscriptions_per_customer", "USD", 5 / 3],
    ["subscriptions_per_customer", "EUR", 1],
  ];
  const badQuotient: string[] = [];
  for (const [measure, currency, want] of QUOTIENTS) {
    const got = read(def(measure), june.get(key(measure, currency)));
    if (got !== want) badQuotient.push(`${measure} ${currency}: want ${want}, read ${got}`);
  }
  ok("oracle: dividing the stored halves gives the hand-worked answer", badQuotient.length === 0);
  if (badQuotient.length) console.log("  ↳ quotients:", badQuotient);

  const lifeUsd = read(
    def("average_customer_lifetime"),
    june.get(key("average_customer_lifetime", "USD")),
  );
  ok(
    "oracle: the average USD account lasted 74 days — 2.5 months, and the quotient says so in milliseconds",
    lifeUsd === 74 * DAY_MS && Math.round((lifeUsd / MONTH_MS) * 10) / 10 === 2.5,
  );

  // A count is a count: nothing in this group stores a denominator it does not divide by.
  ok(
    "oracle: the four plain counts store no denominator — there is nothing to divide them by",
    [
      "customers_new",
      "customers_churned",
      "customers_moved",
      "active_customers",
      "paying_customers",
    ].every((id) => june.get(key(id, "USD"))?.denominator == null),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. NON-ADDITIVITY. The reason this group exists, asserted with both numbers.
// ─────────────────────────────────────────────────────────────────────────────
{
  const months: Grain = "month";
  const monthly = (measure: string, currency: string) =>
    (["2026-04-30", "2026-05-31", "2026-06-30"] as const).map(
      (d) => M(months, d).get(key(measure, currency))?.value ?? 0n,
    );

  const moved = monthly("customers_moved", "USD");
  const sumOfMonths = moved.reduce((n, v) => n + v, 0n);
  const quarter = M("quarter", "2026-06-30").get(key("customers_moved", "USD"))?.value ?? null;
  ok(
    "non-additivity: April, May and June saw 3, 3 and 4 USD accounts move — and they sum to 10",
    moved.join(",") === "3,3,4" && sumOfMonths === 10n,
  );
  ok(
    "non-additivity: …but only 6 distinct accounts moved across the quarter, and THAT is what is stored",
    quarter === 6n && quarter !== sumOfMonths,
  );
  console.log(
    `  customers_moved USD — months ${moved.join("/")}, their sum ${sumOfMonths}, the quarter ${quarter}`,
  );

  // A carries the whole difference: present in all three months, one account in the quarter.
  ok(
    "non-additivity: the gap of 4 is the returning accounts — A in all three months, B and I in two each",
    sumOfMonths - quarter! === 4n,
  );

  /**
   * The rate is the sharper case, because a mean of the months LOOKS like an answer. It is
   * not: the quarter opened with one account and lost it, which is 100%, while its months
   * average to 1,944 basis points.
   */
  const rates = (["2026-04-30", "2026-05-31", "2026-06-30"] as const).map(
    (d) =>
      read(def("customer_churn_rate"), M(months, d).get(key("customer_churn_rate", "USD"))) ?? 0,
  );
  const meanOfMonths = Math.round(rates.reduce((n, v) => n + v, 0) / rates.length);
  const quarterRate = read(
    def("customer_churn_rate"),
    M("quarter", "2026-06-30").get(key("customer_churn_rate", "USD")),
  );
  ok(
    "non-additivity: the quarter's churn rate is its own arithmetic — one account opened it, one was lost, 10,000 bps",
    quarterRate === 10_000,
  );
  ok(
    "non-additivity: …and it is NOT the mean of its months' 0 / 2,500 / 3,333, which is 1,944",
    rates.join(",") === "0,2500,3333" && meanOfMonths === 1944 && quarterRate !== meanOfMonths,
  );

  /**
   * THE DAY ROWS EXIST AND ARE DELIBERATELY IGNORED.
   *
   * Every day of the quarter is written, so a foldable measure builds the quarter out of
   * them. The distinct count reads its own grain instead — which is the difference between
   * "we did not have the rows" and "those rows cannot answer this question".
   */
  for (
    let d = new Date("2026-04-01T00:00:00.000Z");
    d <= new Date("2026-06-30T00:00:00.000Z");
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const iso = d.toISOString().slice(0, 10);
    const rows = await withTenant(orgId, (tx) => computeMetricPeriod(tx, bizId, "day", iso, NOW));
    await writeMetricDay({
      organizationId: orgId,
      businessId: bizId,
      grain: "day",
      periodEnd: iso,
      rows,
    });
  }
  const q2 = [{ start: "2026-04-01", end: "2026-06-30", label: "Q2" }];
  const foldable = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "mrr_new",
    grain: "quarter",
    periods: q2,
  });
  const distinct = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "customers_moved",
    grain: "quarter",
    periods: q2,
  });
  // Q2's USD `new` rows: a1 4,000 + i1 2,000 + i2 1,500 + b1 3,000 + j1 1,000 + c1 2,000
  // + a2 5,000 + d1 1,500. G opened in January, outside it.
  ok(
    "non-additivity: with 91 day rows present, an additive measure folds them into the quarter",
    (foldable.cells.find((c) => c.currency === "USD")?.value ?? 0n) === 20_000n,
  );
  ok(
    "non-additivity: …and the distinct count still answers 6, off its own quarter row, having ignored all 91",
    distinct.cells.find((c) => c.currency === "USD")?.value === 6n,
  );

  /**
   * And the public payload refuses too. Twelve buckets of a distinct count have NO window
   * total — summing them counts every returning account once per bucket it came back in, and
   * the number looks entirely plausible.
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
      measure: "customers_moved",
      grain: "month",
      start: "2026-04-01",
      end: "2026-06-30",
      currency: "USD",
    },
    NOW,
  );
  ok(
    "non-additivity: three monthly buckets, and a window total computed over the window, never their sum",
    published.series.map((p) => p.value).join(",") === "3,3,4" &&
      published.total === 6 &&
      published.total_basis === "window",
  );
  const oneBucket = await resolveAnalytics(
    scope,
    {
      measure: "customers_moved",
      grain: "quarter",
      start: "2026-04-01",
      end: "2026-06-30",
      currency: "USD",
    },
    NOW,
  );
  ok(
    "non-additivity: …and the window asked for AS ONE PERIOD gives the same 6",
    oneBucket.total === 6 && oneBucket.series.length === 1,
  );
  const rate = await resolveAnalytics(
    scope,
    {
      measure: "customer_churn_rate",
      grain: "month",
      start: "2026-04-01",
      end: "2026-06-30",
      currency: "USD",
    },
    NOW,
  );
  ok(
    "non-additivity: the churn rate publishes as a RATE with both halves beside it, though it folds not at all",
    rate.unit === "bps" &&
      rate.series.map((p) => p.value).join(",") === "0,2500,3333" &&
      rate.series.every((p) => p.denominator != null),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE REPORTS — the figures already published must not have changed meaning.
// ─────────────────────────────────────────────────────────────────────────────
const report = (reportKey: string, currency: string, opts: Record<string, unknown> = {}) =>
  resolveReport(orgId, bizId, reportKey, { currency, now: NOW, range: "12m", ...opts });

/** One currency's stored figure for a month, summed across currencies when asked for ALL. */
const storedAt = (grain: Grain, periodEnd: string, measure: string, currency: string): Halves => {
  const got = M(grain, periodEnd);
  if (currency !== "ALL")
    return got.get(key(measure, currency)) ?? { value: null, denominator: null };
  let value: bigint | null = null;
  let denominator: bigint | null = null;
  for (const [k, v] of got) {
    if (k.split("|")[0] !== measure) continue;
    if (v.value != null) value = (value ?? 0n) + v.value;
    if (v.denominator != null) denominator = (denominator ?? 0n) + v.denominator;
  }
  return { value, denominator };
};

{
  /**
   * The four window counts, bucket by bucket. The report cuts the same calendar months, so
   * each stored month must be the report's point for that month — and across currencies,
   * because that is the scope in which the two definitions agree (see the divergence below).
   */
  const MONTHLY: Array<[string, string]> = [
    ["total_new_customers", "customers_new"],
    ["total_churned_customers", "customers_churned"],
    ["total_customers_with_movement", "customers_moved"],
  ];
  const wrong: string[] = [];
  for (const [reportKey, measure] of MONTHLY) {
    const r = await report(reportKey, "ALL", { granularity: "month" });
    for (const [t, periodEnd] of [
      ["2026-04-01", "2026-04-30"],
      ["2026-05-01", "2026-05-31"],
      ["2026-06-01", "2026-06-30"],
    ] as const) {
      const point = r.points.find((p) => p.t === t);
      const stored = storedAt("month", periodEnd, measure, "ALL").value;
      if (BigInt(point?.v ?? -1) !== (stored ?? -1n)) {
        wrong.push(`${reportKey} ${t}: report ${point?.v}, stored ${stored}`);
      }
    }
  }
  ok(
    "reports: the three window counts agree with the stored months, bucket for bucket",
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ report disagreements:", wrong);

  const rateReport = await report("customer_churn_rate", "ALL", { granularity: "month" });
  const rateWrong: string[] = [];
  for (const [t, periodEnd] of [
    ["2026-04-01", "2026-04-30"],
    ["2026-05-01", "2026-05-31"],
    ["2026-06-01", "2026-06-30"],
  ] as const) {
    const point = rateReport.points.find((p) => p.t === t);
    const h = storedAt("month", periodEnd, "customer_churn_rate", "ALL");
    const stored = ratioValue(def("customer_churn_rate"), h.value, h.denominator);
    if (point?.v !== stored) rateWrong.push(`${t}: report ${point?.v}, stored ${stored}`);
  }
  ok(
    "reports: the churn rate agrees month by month, basis point for basis point",
    rateWrong.length === 0,
  );
  if (rateWrong.length) console.log("  ↳ churn-rate disagreements:", rateWrong);

  /**
   * ⚠️ THE PUBLISHED REPORT IS ITSELF NON-ADDITIVE, AND SAYS SO.
   *
   * Its headline counts the whole window as one set; its points count each month. They do
   * not reconcile, and they should not. That the store agrees with the headline when read at
   * the window's grain, and with the points when read at theirs, is the strongest evidence
   * the semantic layer did not change the meaning of the figure.
   */
  const movedReport = await report("total_customers_with_movement", "ALL", {
    granularity: "month",
  });
  const pointSum = movedReport.points.reduce((n, p) => n + p.v, 0);
  ok(
    "reports: the published report's own headline is not the sum of its own points, and never was",
    pointSum !== movedReport.headline,
  );

  /** The four instant figures, read at the day period holding `now`. */
  const at = M("day", "2026-07-15");
  const payingReport = await report("total_paying_customers", "ALL");
  ok(
    "reports: the paying head count agrees — 5 accounts carry revenue, whatever currency they carry it in",
    payingReport.headline === 5 &&
      (storedAt("day", "2026-07-15", "paying_customers", "ALL").value ?? 0n) === 5n,
  );
  const lifeReport = await report("average_customer_lifetime", "ALL");
  const lifeHalves = storedAt("day", "2026-07-15", "average_customer_lifetime", "ALL");
  const lifeMonths =
    Math.round(
      (ratioValue(def("average_customer_lifetime"), lifeHalves.value, lifeHalves.denominator)! /
        MONTH_MS) *
        10,
    ) / 10;
  ok(
    "reports: the average account life agrees to the published decimal — 2.3 months over four ended accounts",
    lifeReport.headline === 2.3 && lifeMonths === 2.3 && lifeHalves.denominator === 4n,
  );
  const lifeUsdReport = await report("average_customer_lifetime", "USD");
  const usdHalves = at.get(key("average_customer_lifetime", "USD"))!;
  ok(
    "reports: …and per currency too — the USD book's three ended accounts averaged 2.5 months",
    lifeUsdReport.headline === 2.5 &&
      Math.round(
        (ratioValue(def("average_customer_lifetime"), usdHalves.value, usdHalves.denominator)! /
          MONTH_MS) *
          10,
      ) /
        10 ===
        2.5,
  );

  /**
   * ⚠️ DIVERGENCE 1, ON PURPOSE: WHAT "ACTIVE" MEANS.
   *
   * `active_customers` is the CUSTOMER GRAIN of `active_subscriptions` and uses its
   * predicate, which excludes a trial and includes a cancellation that has not taken effect
   * yet. The published report uses a predicate of its own — active or in trial — so H, who is
   * trialing, is an active customer there and is not one here. The semantic layer refuses to
   * hold two definitions of "live", so the report is the one that needs changing; the gate
   * states both numbers rather than loosening the comparison.
   */
  const activeReport = await report("total_active_customers", "ALL");
  const activeStored = storedAt("day", "2026-07-15", "active_customers", "ALL").value;
  ok(
    "reports: active head count diverges by design — the report counts the trialing account (6), the store does not (5)",
    activeReport.headline === 6 && activeStored === 5n,
  );
  const perCustomerReport = await report("average_subscriptions_per_customer", "ALL");
  const spc = storedAt("day", "2026-07-15", "subscriptions_per_customer", "ALL");
  ok(
    "reports: …and the per-customer factor moves with it — 8/6 = 1.3 counting trials, 7/5 = 1.4 counting live lines only",
    perCustomerReport.headline === 1.3 &&
      Math.round(ratioValue(def("subscriptions_per_customer"), spc.value, spc.denominator)! * 10) /
        10 ===
        1.4,
  );

  /**
   * ⚠️ DIVERGENCE 2, ON PURPOSE: A TWO-CURRENCY ACCOUNT.
   *
   * J pays in USD and in EUR. Asked for the EUR book the report counts J, and asked for the
   * USD book it counts J again, so running it per currency adds up to more accounts than
   * exist. The store counts J once, in EUR — the currency carrying most of its revenue —
   * which is what lets a converted read divide by a real headcount.
   */
  const payingUsd = await report("total_paying_customers", "USD");
  const payingEur = await report("total_paying_customers", "EUR");
  const storedUsd = at.get(key("paying_customers", "USD"))?.value ?? 0n;
  const storedEur = at.get(key("paying_customers", "EUR"))?.value ?? 0n;
  ok(
    "reports: per-currency head counts diverge by design — the report's 4 + 2 is six accounts where five exist, the store's 3 + 2 is five",
    payingUsd.headline === 4 &&
      payingEur.headline === 2 &&
      payingUsd.headline + payingEur.headline === 6 &&
      storedUsd === 3n &&
      storedEur === 2n &&
      storedUsd + storedEur === 5n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. A CUSTOMER IS COUNTED ONCE — the property that makes a converted read honest.
// ─────────────────────────────────────────────────────────────────────────────
{
  const june = M("month", "2026-06-30");
  const quarter = M("quarter", "2026-06-30");
  /** J transacts in both currencies across the quarter and is counted in EUR alone. */
  ok(
    "currency: the quarter's movers are 6 USD + 2 EUR = the 8 distinct accounts that actually moved",
    quarter.get(key("customers_moved", "USD"))?.value === 6n &&
      quarter.get(key("customers_moved", "EUR"))?.value === 2n,
  );
  ok(
    "currency: J transacts in both and is counted in EUR — the currency carrying 5,000 against USD's 1,200",
    quarter.get(key("customers_new", "EUR"))?.value === 2n &&
      quarter.get(key("customers_new", "USD"))?.value === 5n,
  );
  ok(
    "currency: the churn-rate denominators sum to the accounts there were to lose, never to more",
    (june.get(key("customer_churn_rate", "USD"))?.denominator ?? 0n) +
      (june.get(key("customer_churn_rate", "EUR"))?.denominator ?? 0n) ===
      5n,
  );
  ok(
    "currency: a head count is stored per currency and never under XXX — it is not currencyless",
    def("active_customers").currency === "per_currency" &&
      def("customers_moved").currency === "per_currency",
  );
  ok(
    "currency: each currency answers its own arithmetic — the EUR book's lifetime is F's 59 days alone",
    june.get(key("average_customer_lifetime", "EUR"))?.value === BigInt(59 * DAY_MS) &&
      june.get(key("average_customer_lifetime", "EUR"))?.denominator === 1n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. NULL IS NOT ZERO, AND A ZERO DENOMINATOR IS NOT A RATE OF ZERO.
// ─────────────────────────────────────────────────────────────────────────────
{
  const april = M("month", "2026-04-30");
  const eurRate = april.get(key("customer_churn_rate", "EUR"));
  ok(
    "zero: the EUR book had no accounts to lose in April, so its denominator is a MEASURED zero, stored as such",
    eurRate?.value === 0n && eurRate?.denominator === 0n,
  );
  ok(
    "zero: …and dividing by it answers null — a book with nothing to lose did not keep everything",
    read(def("customer_churn_rate"), eurRate) === null,
  );
  const usdRate = april.get(key("customer_churn_rate", "USD"));
  ok(
    "zero: the USD book HAD one account and lost none — that is a real 0%, and it is not the same row",
    usdRate?.denominator === 1n && read(def("customer_churn_rate"), usdRate) === 0,
  );

  // Nothing had ended in the EUR book before March, so its average life is unknown rather
  // than zero — a null NUMERATOR this time, which is the other half of the same rule.
  const early = await materialise("month", "2026-02-28");
  const life = early.get(key("average_customer_lifetime", "EUR"));
  ok(
    "zero: a lifetime with no completed life in it is null, not an average of nothing",
    life !== undefined &&
      life.value === null &&
      read(def("average_customer_lifetime"), life) === null,
  );
  ok(
    "zero: a period before the book existed writes no row at all — absent, not zero",
    M("month", "2025-12-31").size === 0,
  );

  // Zero is WRITTEN where it was measured: April churned nobody, and the row says so.
  ok(
    "zero: April churned nobody and the row exists saying 0 — a missing row would mean 'not computed'",
    april.get(key("customers_churned", "USD"))?.value === 0n,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. DECLARED == EMITTED, both ways — and the registry pairs with its writer.
// ─────────────────────────────────────────────────────────────────────────────
{
  let paired = true;
  try {
    assertRegistryImplemented();
  } catch {
    paired = false;
  }
  ok("registry: every declared measure is implemented, with the aggregate it promises", paired);

  // `customers_reactivated` is fixtured in verify:metric-new-measures; this is the original eight.
  const mine = MEASURES.filter(
    (m) => m.source === "customer_grain" && m.id !== "customers_reactivated",
  );
  ok("registry: eight measures at the customer grain, and no more", mine.length === 8);
  ok(
    "registry: the four WINDOW counts declare `none` — the promise that they cannot be re-aggregated",
    CUSTOMER_DISTINCT_MEASURES.every((id) => def(id).aggregate === "none") &&
      def("customers_reactivated").aggregate === "none" &&
      mine.filter((m) => m.aggregate === "none").length === 4,
  );
  ok(
    "registry: the two instant counts declare `last` — a distinct count AT a moment folds by taking that moment",
    def("active_customers").aggregate === "last" && def("paying_customers").aggregate === "last",
  );
  ok(
    "registry: the two averages are ratios taking the period's last day on BOTH halves",
    ["subscriptions_per_customer", "average_customer_lifetime"].every(
      (id) =>
        def(id).aggregate === "ratio" &&
        def(id).ratio!.numerator === "last" &&
        def(id).ratio!.denominator === "last" &&
        def(id).ratio!.denominatorUnit === "count",
    ),
  );
  ok(
    "registry: no head count claims a plan or country slice — a two-plan account belongs to neither",
    mine.every((m) => !m.dimensions.includes("plan") && !m.dimensions.includes("country")),
  );

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
  const emitted = new Map<string, Set<string>>();
  const currencies = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!MINE.has(r.measure)) continue;
    if (r.dim !== "")
      (emitted.get(r.measure) ?? emitted.set(r.measure, new Set()).get(r.measure)!).add(r.dim);
    (currencies.get(r.measure) ?? currencies.set(r.measure, new Set()).get(r.measure)!).add(
      r.currency,
    );
  }
  const wrong: string[] = [];
  for (const m of mine) {
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

  const orphaned = CUSTOMER_MEASURES.filter((id) => !rows.some((r) => r.measure === id));
  ok(
    `coverage: all ${CUSTOMER_MEASURES.length} customer-grain measures actually wrote a row`,
    orphaned.length === 0,
  );
  if (orphaned.length) console.log("  ↳ measures never exercised:", orphaned);

  /**
   * The grain column earns its keep: the four non-additive measures wrote rows at MORE than
   * one grain, and the four that fold wrote at day and at whatever grain was asked directly.
   */
  const grains = await withTenant(orgId, (tx) =>
    tx
      .select({ measure: metricDaily.measure, grain: metricDaily.grain })
      .from(metricDaily)
      .where(eq(metricDaily.businessId, bizId)),
  );
  const byMeasure = new Map<string, Set<string>>();
  for (const r of grains) {
    if (!NOT_FOLDABLE.has(r.measure)) continue;
    (byMeasure.get(r.measure) ?? byMeasure.set(r.measure, new Set()).get(r.measure)!).add(r.grain);
  }
  ok(
    "coverage: every non-additive measure was written at day, month AND quarter — the per-grain path, exercised",
    [...NOT_FOLDABLE].every((id) => {
      const g = byMeasure.get(id);
      return g != null && g.has("day") && g.has("month") && g.has("quarter");
    }),
  );
}

// ── 8 · a restated pair is no account ─────────────────────────────────────────────────
// `repair-backfilled-movement-rates.ts` cancels a list-priced pair with its opposite at the same
// instants. That subscription never carried revenue, so it must count as nobody — not as a
// new customer in May and a churned one a fortnight later.
{
  const b2 = await createBusiness({
    organizationId: orgId,
    name: "Customer Grain Restated Biz",
    defaultCurrency: "USD",
    timezone: "UTC",
    livemode: "test",
  });
  const plan2 = await createProduct({ organizationId: orgId, businessId: b2.id, name: "Plan" });
  const price2 = await createPrice({
    organizationId: orgId,
    businessId: b2.id,
    productId: plan2.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  });
  const account = async (name: string) => {
    const c = await createCustomer({
      organizationId: orgId,
      businessId: b2.id,
      email: `cust-grain-restated-${name}-${Date.now()}@example.test`,
    });
    const { subscription } = await createSubscription({
      organizationId: orgId,
      businessId: b2.id,
      customerId: c.id,
      now: day("2026-05-01"),
      startDate: day("2026-05-01"),
      items: [{ price: price2, quantity: 1 }],
    });
    return { sid: subscription.id, cid: c.id };
  };
  const real = await account("real");
  const phantom = await account("phantom");
  await systemDb.delete(mrrMovements).where(eq(mrrMovements.businessId, b2.id));
  const row = (who: { sid: string; cid: string }, at: string, reason: string, delta: number) => ({
    organizationId: orgId,
    businessId: b2.id,
    subscriptionId: who.sid,
    customerId: who.cid,
    reason,
    planProductId: plan2.id,
    currency: "USD",
    previousMrrMinor: 0n,
    newMrrMinor: 0n,
    deltaMinor: BigInt(delta),
    occurredAt: new Date(at),
  });
  await withTenant(orgId, (tx) =>
    tx
      .insert(mrrMovements)
      .values([
        row(real, "2026-05-05T09:00:00.000Z", "new", 4000),
        row(real, "2026-05-20T09:00:00.000Z", "churn", -4000),
        row(phantom, "2026-05-06T09:00:00.000Z", "new", 9000),
        row(phantom, "2026-05-06T09:00:00.000Z", "new", -9000),
        row(phantom, "2026-05-21T09:00:00.000Z", "churn", -9000),
        row(phantom, "2026-05-21T09:00:00.000Z", "churn", 9000),
      ]),
  );
  const may = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, b2.id, "month", "2026-05-31", NOW),
  );
  const count = (measure: string) =>
    may.find((r) => r.measure === measure && r.dim === "" && r.currency === "USD")?.value;
  ok(
    "restated: a pair that cancels itself is not a new customer (1, not 2)",
    count("customers_new") === 1n,
  );
  ok("restated: …nor a churned one (1, not 2)", count("customers_churned") === 1n);
  ok("restated: …nor an account that moved (1, not 2)", count("customers_moved") === 1n);
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-CUSTOMERS: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-CUSTOMERS: FAIL (${failed}/${checks.length} failed)`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
