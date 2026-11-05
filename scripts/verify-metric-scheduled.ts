/**
 * The ORACLE GATE for the forward book (Phase 7, group 7).
 *
 * Six figures about what has been BOOKED and has not happened yet — the only measures in
 * the layer whose answer depends on WHEN YOU ASK as well as which period you ask about. A
 * change booked today for next month is scheduled today, still scheduled next week, and
 * gone the moment it lands.
 *
 * The storage decision this gate exists to hold in place:
 *   · `period_end` IS THE AS-OF DATE — all six declare `asOf: "computed_at"` and are written
 *     only for the period containing the run. A past period gets NO row, never a 0.
 *   · THE TARGET WINDOW is the `horizon` dimension: six disjoint bands that partition the
 *     forward book, so the slices sum to the unsliced figure.
 *
 * Two independent oracles, as every group before this one:
 *   1. AN EXPECTED TABLE worked out by hand from the fixture — what a person gets with a
 *      pencil, agreeing with neither the writer nor the reports.
 *   2. THE PUBLISHED REPORTS, which already answer these six questions. A measure that
 *      quietly redefined its figure fails here.
 *
 * ⚠️ WHAT THE FIXTURE IS BUILT TO SEPARATE. A gate whose every booked change was also inside
 * the horizon would prove nothing about the horizon, and one whose every schedule row was
 * still pending would prove nothing about the word "scheduled". So each condition has a twin
 * that must fall the other way: a change that has ALREADY APPLIED and one still pending; a
 * change the merchant WITHDREW; a booking inside the horizon and one far beyond it; a
 * cancellation booked and still running, and one that has already gone.
 *
 * The properties, in the order a wrong implementation breaks them:
 *   0. the registry and its writer agree, and the six DECLARE that they are as-of the run;
 *   1. the hand-worked table is stored, to the minor unit, band by band;
 *   2. stored == what each published report already answers, in both currencies;
 *   3. AS-OF — a past period carries no row at all, and the reader calls it missing;
 *   4. the horizon bands partition: they sum to the total, and nothing falls outside them;
 *   5. what is NOT scheduled is not counted — applied, withdrawn, and already gone;
 *   6. the figure is as-of the run, so every grain containing it gives the same answer;
 *   7. declared == emitted, both ways, for every dimension and every band.
 *
 *   pnpm verify:metric-scheduled
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
import { MEASURES, type Grain } from "@/modules/metrics/daily/measures";
import {
  HORIZON_BANDS,
  horizonBand,
  SCHEDULED_MEASURES,
} from "@/modules/metrics/daily/scheduled-measures";
import { EXPECTED_CASH_MEASURES } from "@/modules/metrics/daily/renewal-measures";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { businesses, metricDaily, scheduledChanges, subscriptions, timeTravels } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** The instant every figure is taken at — fixed, and passed to both the writer and the
 *  reports. These six are "now" by definition; a gate reading the wall clock would be
 *  comparing two different nows. */
const NOW = new Date("2026-09-15T12:00:00.000Z");
/** Past the real clock, so nothing in the fixture renews under a live worker. */
const PARKED = day("2028-01-01");

// ─────────────────────────────────────────────────────────────────────────────
// Seed — its own organization and business, never the dev database's book.
// ─────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Forward Book Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Forward Book Oracle Biz",
  defaultCurrency: "USD",
  // UTC on purpose: the reports cut in the BUSINESS's timezone, these rows on the UTC calendar.
  timezone: "UTC",
  livemode: "test",
});
const bizId = biz.id;

/**
 * FENCE THE LIVE WORKER OUT, before the fixture has anything to claim.
 *
 * This is the one group whose fixture a running billing clock would eat: a schedule row that
 * is due (`overdue`, deliberately) is exactly what `applyDueScheduledChanges` scans for, and
 * an applied row would silently change the answer mid-run. A non-null `simulated_now` makes
 * the real tick skip this business — `runWithClockScope` cannot, because the worker is a
 * different process.
 */
await systemDb.insert(timeTravels).values({
  organizationId: orgId,
  businessId: bizId,
  status: "in_progress",
  genesisTime: NOW,
  simulatedNow: NOW,
});

/** EUR at parity, so the unscoped report converts instead of excluding — and so a figure
 *  that leaked across currencies would be visible rather than absorbed by a rate. */
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
const uniq = () => `${++seq}_${Date.now()}`;
const customer = (name: string) =>
  createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `forward-${name}-${uniq()}@example.test`,
  });

/** One subscription with its stock fields forced, so the table below is pencil-computable. */
async function addSub(s: {
  currency: "USD" | "EUR";
  mrrMinor: number;
  /** A booked stop, dated. */
  cancelScheduledOn?: string;
  /** A booked stop at the term's end — dated only if the term has an end on file. */
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
  /** Already gone. */
  canceledOn?: string;
  /** A trial on the subscription. Absent means it never had one. */
  trial?: { startedOn: string; endsOn: string | null };
}): Promise<string> {
  const cus = await customer("sub");
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: cus.id,
    now: day("2026-01-10"),
    startDate: day("2026-01-10"),
    items: [{ price: s.currency === "USD" ? priceUsd : priceEur, quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({
      status: s.canceledOn ? "cancelled" : "active",
      currency: s.currency,
      mrr: BigInt(s.mrrMinor),
      createdAt: day("2026-01-10"),
      startDate: day("2026-01-10"),
      startedAt: day("2026-01-10"),
      canceledAt: s.canceledOn ? day(s.canceledOn) : null,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd ?? false,
      cancelScheduledAt: s.cancelScheduledOn ? day(s.cancelScheduledOn) : null,
      currentPeriodEnd:
        s.currentPeriodEnd === null ? null : s.currentPeriodEnd ? day(s.currentPeriodEnd) : PARKED,
      // No trial unless the fixture asks for one — an inert far-future end would otherwise
      // put every subscription in the trial book.
      trialStart: s.trial ? day(s.trial.startedOn) : null,
      trialEnd: s.trial ? (s.trial.endsOn ? day(s.trial.endsOn) : null) : PARKED,
    })
    .where(eq(subscriptions.id, subscription.id));
  return subscription.id;
}

/** One row of the schedule table, dated and priced exactly. The service path would re-rate. */
async function schedule(c: {
  subscriptionId: string;
  type: "change" | "cancel" | "pause";
  effectiveOn: string;
  mrrDeltaMinor?: number | null;
  status?: "scheduled" | "applied" | "canceled";
}) {
  await withTenant(orgId, (tx) =>
    tx.insert(scheduledChanges).values({
      organizationId: orgId,
      businessId: bizId,
      subscriptionId: c.subscriptionId,
      publicId: `sch_forward_${uniq()}`,
      type: c.type,
      effectiveAt: day(c.effectiveOn),
      mrrDeltaMinor: c.mrrDeltaMinor == null ? null : BigInt(c.mrrDeltaMinor),
      status: c.status ?? "scheduled",
      appliedAt: c.status === "applied" ? day(c.effectiveOn) : null,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The fixture. NOW = 2026-09-15T12:00Z, so the bands cut at 10-15, 11-14 and 12-14.
// ─────────────────────────────────────────────────────────────────────────────
// Five subscriptions carrying booked PLAN CHANGES, one per band. None of them is also
// booked to stop, so the two families cannot be confused for one another.
const up1 = await addSub({ currency: "USD", mrrMinor: 10_000 });
const up2 = await addSub({ currency: "USD", mrrMinor: 10_000 });
const up3 = await addSub({ currency: "USD", mrrMinor: 10_000 });
const up4 = await addSub({ currency: "USD", mrrMinor: 10_000 });
const up5 = await addSub({ currency: "USD", mrrMinor: 10_000 });
const down1 = await addSub({ currency: "USD", mrrMinor: 10_000 });
const down2 = await addSub({ currency: "USD", mrrMinor: 10_000 });
const eur1 = await addSub({ currency: "EUR", mrrMinor: 10_000 });
const noise = await addSub({ currency: "USD", mrrMinor: 20_000 });

// Upgrades — one in every band, so no band is proven by another's number.
await schedule({
  subscriptionId: up1,
  type: "change",
  effectiveOn: "2026-09-01",
  mrrDeltaMinor: 1500,
}); // overdue
await schedule({
  subscriptionId: up2,
  type: "change",
  effectiveOn: "2026-10-01",
  mrrDeltaMinor: 5000,
}); // 1_30
await schedule({
  subscriptionId: up3,
  type: "change",
  effectiveOn: "2026-11-01",
  mrrDeltaMinor: 2000,
}); // 31_60
await schedule({
  subscriptionId: up4,
  type: "change",
  effectiveOn: "2026-12-01",
  mrrDeltaMinor: 3000,
}); // 61_90
await schedule({
  subscriptionId: up5,
  type: "change",
  effectiveOn: "2027-03-01",
  mrrDeltaMinor: 1000,
}); // 90_plus
// Downgrades — stated as a positive amount wherever they are reported.
await schedule({
  subscriptionId: down1,
  type: "change",
  effectiveOn: "2026-10-05",
  mrrDeltaMinor: -3000,
}); // 1_30
await schedule({
  subscriptionId: down2,
  type: "change",
  effectiveOn: "2027-01-15",
  mrrDeltaMinor: -1000,
}); // 90_plus
// The other currency, which must never be added to the first.
await schedule({
  subscriptionId: eur1,
  type: "change",
  effectiveOn: "2026-10-10",
  mrrDeltaMinor: 4000,
}); // 1_30

/**
 * THE SEPARATING CASES. Each is a change on the SAME shape of subscription as one that
 * counts, differing only in the condition under test — so a writer that dropped the
 * condition is caught by a number, not by an absence.
 */
// Already applied: it is not booked any more, it HAPPENED. 9,999 is deliberately larger
// than any real figure here, so leaking it in cannot look like a rounding difference.
await schedule({
  subscriptionId: noise,
  type: "change",
  effectiveOn: "2026-08-01",
  mrrDeltaMinor: 9999,
  status: "applied",
});
// Withdrawn by the merchant before it landed.
await schedule({
  subscriptionId: noise,
  type: "change",
  effectiveOn: "2026-10-02",
  mrrDeltaMinor: 7777,
  status: "canceled",
});
// A booked cancel/pause moves no rate by being scheduled and carries no estimate: null is
// not a delta of zero, and neither belongs in an upgrade or a downgrade.
await schedule({
  subscriptionId: noise,
  type: "cancel",
  effectiveOn: "2026-10-03",
  mrrDeltaMinor: null,
});
await schedule({
  subscriptionId: noise,
  type: "pause",
  effectiveOn: "2026-10-04",
  mrrDeltaMinor: null,
});
// A change that moves nothing is not an upgrade and not a downgrade.
await schedule({
  subscriptionId: noise,
  type: "change",
  effectiveOn: "2026-10-06",
  mrrDeltaMinor: 0,
});

// Booked CANCELLATIONS — recorded on the subscription, not in the schedule table.
await addSub({ currency: "USD", mrrMinor: 4000, cancelScheduledOn: "2026-09-10" }); // overdue
await addSub({
  currency: "USD",
  mrrMinor: 6000,
  cancelAtPeriodEnd: true,
  currentPeriodEnd: "2026-09-20",
}); // 1_30
await addSub({ currency: "USD", mrrMinor: 8000, cancelScheduledOn: "2026-10-20" }); // 31_60
await addSub({ currency: "USD", mrrMinor: 1000, cancelScheduledOn: "2026-12-05" }); // 61_90
// No date on file at all: booked at a term end the subscription does not have. Not "later".
await addSub({ currency: "USD", mrrMinor: 2000, cancelAtPeriodEnd: true, currentPeriodEnd: null }); // undated
await addSub({ currency: "EUR", mrrMinor: 5000, cancelScheduledOn: "2027-02-01" }); // 90_plus
// ALREADY GONE — booked to stop AND stopped. The twin of the five above: that is churn, and
// counting it here would double-count the same revenue in two catalogues.
await addSub({
  currency: "USD",
  mrrMinor: 30_000,
  cancelAtPeriodEnd: true,
  canceledOn: "2026-08-01",
});

/**
 * THE TRIAL BOOK. `trials_ending` asks the same forward question of a date the subscription
 * already carries, so it takes the same bands — and the same twins: a trial already over, one
 * with no end on file, and one whose subscription has gone.
 */
// Ends inside the month, inside the next two months, and inside the quarter.
await addSub({
  currency: "USD",
  mrrMinor: 1000,
  trial: { startedOn: "2026-09-01", endsOn: "2026-09-20" },
}); // 1_30
await addSub({
  currency: "USD",
  mrrMinor: 1000,
  trial: { startedOn: "2026-08-20", endsOn: "2026-10-30" },
}); // 31_60
await addSub({
  currency: "USD",
  mrrMinor: 1000,
  trial: { startedOn: "2026-09-10", endsOn: "2026-12-01" },
}); // 61_90
// Running with NO end on file: in trial, but not ending. Not "undated" — there is no date
// we failed to record, there is no ending.
await addSub({
  currency: "USD",
  mrrMinor: 1000,
  trial: { startedOn: "2026-09-05", endsOn: null },
});
// Already over: that is a conversion or a lapse, and neither is a trial ending ahead.
await addSub({
  currency: "USD",
  mrrMinor: 1000,
  trial: { startedOn: "2026-07-01", endsOn: "2026-09-01" },
});
// Gone before the trial could end.
await addSub({
  currency: "USD",
  mrrMinor: 1000,
  trial: { startedOn: "2026-09-01", endsOn: "2026-09-25" },
  canceledOn: "2026-09-08",
});
// The other currency keeps its own count.
await addSub({
  currency: "EUR",
  mrrMinor: 1000,
  trial: { startedOn: "2026-09-02", endsOn: "2026-09-19" },
}); // 1_30

// ─────────────────────────────────────────────────────────────────────────────
// Materialise.
// ─────────────────────────────────────────────────────────────────────────────
// The seven this fixture exercises. Expected renewal cash shares the group but values priced
// items, which this book has none of — its schedule is `test/unit/expected-renewal-charges`.
const MINE = new Set<string>(SCHEDULED_MEASURES);
type Key = string;
const key = (measure: string, dim: string, dimValue: string, currency: string) =>
  `${measure}|${dim}|${dimValue}|${currency}`;

const SAMPLED: Array<[Grain, string]> = [
  // Periods that CONTAIN the run — every one of them must give the same answer.
  ["day", "2026-09-15"],
  ["month", "2026-09-30"],
  ["quarter", "2026-09-30"],
  ["year", "2026-12-31"],
  // Periods that do not. Nothing may be written for any of them.
  ["day", "2026-09-14"],
  ["day", "2026-09-16"],
  ["month", "2026-07-31"],
  ["month", "2026-10-31"],
  ["year", "2025-12-31"],
];

async function materialise(grain: Grain, periodEnd: string): Promise<Map<Key, bigint | null>> {
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
  const out = new Map<Key, bigint | null>();
  for (const r of stored) {
    if (!MINE.has(r.measure)) continue;
    out.set(key(r.measure, r.dim, r.dimValue, r.currency), r.value);
  }
  return out;
}

const materialised = new Map<string, Map<Key, bigint | null>>();
for (const [grain, periodEnd] of SAMPLED) {
  materialised.set(`${grain}|${periodEnd}`, await materialise(grain, periodEnd));
}
const M = (grain: Grain, periodEnd: string) => materialised.get(`${grain}|${periodEnd}`)!;

// ─────────────────────────────────────────────────────────────────────────────
// 0. The registry and its writer agree, and the seven declare what they are.
// ─────────────────────────────────────────────────────────────────────────────
{
  let paired = true;
  try {
    assertRegistryImplemented();
  } catch {
    paired = false;
  }
  ok("registry: every declared measure is implemented, with the aggregate it promises", paired);

  const group = MEASURES.filter((m) => m.source === "scheduled");
  const mine = group.filter((m) => MINE.has(m.id));
  ok(
    "registry: seven forward measures plus the expected-cash pair, and nothing else in the group",
    SCHEDULED_MEASURES.length === 7 &&
      mine.length === 7 &&
      group.length === SCHEDULED_MEASURES.length + EXPECTED_CASH_MEASURES.length &&
      group.every(
        (m) => MINE.has(m.id) || (EXPECTED_CASH_MEASURES as readonly string[]).includes(m.id),
      ),
  );
  ok(
    "registry: the expected-cash pair is a reading like the seven, split by horizon",
    group
      .filter((m) => (EXPECTED_CASH_MEASURES as readonly string[]).includes(m.id))
      .every(
        (m) =>
          m.asOf === "computed_at" &&
          !m.supportsCompare &&
          m.kind === "stock" &&
          m.aggregate === "last" &&
          m.dimensions.includes("horizon"),
      ),
  );
  ok(
    "registry: all seven DECLARE that they are as-of the run and offer no comparison",
    mine.every(
      (m) =>
        m.asOf === "computed_at" &&
        !m.supportsCompare &&
        m.kind === "stock" &&
        m.aggregate === "last",
    ),
  );
  ok(
    "registry: all seven are held per currency and sliced by the horizon, and by nothing else",
    mine.every(
      (m) =>
        m.currency === "per_currency" &&
        m.dimensions.filter((d) => d !== "currency" && d !== "business").join(",") === "horizon",
    ),
  );
  ok(
    "registry: every description states that the figure has no history",
    mine.every((m) => m.description.includes("No history")),
  );
  // A closed set is only closed if it is declared in one place. The bands are not derived
  // from the data, and a band invented at write time would fail §7 below.
  ok(
    "registry: the horizon is a CLOSED set of six disjoint bands",
    HORIZON_BANDS.length === 6 &&
      new Set(HORIZON_BANDS).size === 6 &&
      HORIZON_BANDS.join(",") === "overdue,1_30,31_60,61_90,90_plus,undated",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE EXPECTED TABLE — worked out from the fixture by hand, not from either side.
// ─────────────────────────────────────────────────────────────────────────────
const EXPECTED: Array<[string, string, string, string, bigint]> = [
  // measure, dim, dimValue, currency, value
  // ── Upgrades, USD: 1,500 overdue + 5,000 + 2,000 + 3,000 + 1,000 = 12,500 over five rows
  ["scheduled_upgrade_mrr", "", "", "USD", 12_500n],
  ["scheduled_upgrade_mrr", "horizon", "overdue", "USD", 1500n],
  ["scheduled_upgrade_mrr", "horizon", "1_30", "USD", 5000n],
  ["scheduled_upgrade_mrr", "horizon", "31_60", "USD", 2000n],
  ["scheduled_upgrade_mrr", "horizon", "61_90", "USD", 3000n],
  ["scheduled_upgrade_mrr", "horizon", "90_plus", "USD", 1000n],
  ["scheduled_upgrades", "", "", "USD", 5n],
  ["scheduled_upgrades", "horizon", "overdue", "USD", 1n],
  ["scheduled_upgrades", "horizon", "90_plus", "USD", 1n],
  // ── Downgrades, USD: stated positive — 3,000 inside the month and 1,000 far out
  ["scheduled_downgrade_mrr", "", "", "USD", 4000n],
  ["scheduled_downgrade_mrr", "horizon", "1_30", "USD", 3000n],
  ["scheduled_downgrade_mrr", "horizon", "90_plus", "USD", 1000n],
  ["scheduled_downgrades", "", "", "USD", 2n],
  ["scheduled_downgrades", "horizon", "1_30", "USD", 1n],
  ["scheduled_downgrades", "horizon", "90_plus", "USD", 1n],
  // ── The other currency, on its own arithmetic
  ["scheduled_upgrade_mrr", "", "", "EUR", 4000n],
  ["scheduled_upgrade_mrr", "horizon", "1_30", "EUR", 4000n],
  ["scheduled_upgrades", "", "", "EUR", 1n],
  // Nothing booked down in EUR: a MEASURED zero on the total, and no band row at all.
  ["scheduled_downgrade_mrr", "", "", "EUR", 0n],
  ["scheduled_downgrades", "", "", "EUR", 0n],
  // ── Cancellations, USD: 4,000 + 6,000 + 8,000 + 1,000 + 2,000 = 21,000 over five
  ["scheduled_cancellation_mrr", "", "", "USD", 21_000n],
  ["scheduled_cancellation_mrr", "horizon", "overdue", "USD", 4000n],
  ["scheduled_cancellation_mrr", "horizon", "1_30", "USD", 6000n],
  ["scheduled_cancellation_mrr", "horizon", "31_60", "USD", 8000n],
  ["scheduled_cancellation_mrr", "horizon", "61_90", "USD", 1000n],
  ["scheduled_cancellation_mrr", "horizon", "undated", "USD", 2000n],
  ["scheduled_cancellations", "", "", "USD", 5n],
  ["scheduled_cancellations", "horizon", "undated", "USD", 1n],
  // ── Cancellations, EUR: one, booked far out
  ["scheduled_cancellation_mrr", "", "", "EUR", 5000n],
  ["scheduled_cancellation_mrr", "horizon", "90_plus", "EUR", 5000n],
  ["scheduled_cancellations", "", "", "EUR", 1n],
  // ── Trials ending, USD: three with a date ahead, one per band. The open-ended trial, the
  // one already over and the one whose subscription has gone are all absent.
  ["trials_ending", "", "", "USD", 3n],
  ["trials_ending", "horizon", "1_30", "USD", 1n],
  ["trials_ending", "horizon", "31_60", "USD", 1n],
  ["trials_ending", "horizon", "61_90", "USD", 1n],
  ["trials_ending", "", "", "EUR", 1n],
  ["trials_ending", "horizon", "1_30", "EUR", 1n],
];
{
  const wrong: string[] = [];
  const got = M("month", "2026-09-30");
  for (const [measure, dim, dimValue, currency, want] of EXPECTED) {
    const v = got.get(key(measure, dim, dimValue, currency));
    if (v !== want) {
      wrong.push(`${measure}/${dim}:${dimValue} ${currency}: want ${want}, stored ${v}`);
    }
  }
  ok(
    `oracle: all ${EXPECTED.length} hand-worked figures are stored, to the minor unit`,
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ mismatches:", wrong.slice(0, 15));

  // The band function is the definition; its boundaries are asserted directly rather than
  // inferred from the table above, so an off-by-one at a cut cannot hide inside a total.
  ok(
    "horizon: the cuts are where they are declared to be, and a date that has passed is overdue",
    horizonBand(day("2026-09-01"), NOW) === "overdue" &&
      horizonBand(NOW, NOW) === "overdue" &&
      horizonBand(new Date(NOW.getTime() + 1), NOW) === "1_30" &&
      horizonBand(new Date(NOW.getTime() + 30 * 86_400_000), NOW) === "1_30" &&
      horizonBand(new Date(NOW.getTime() + 30 * 86_400_000 + 1), NOW) === "31_60" &&
      horizonBand(new Date(NOW.getTime() + 60 * 86_400_000), NOW) === "31_60" &&
      horizonBand(new Date(NOW.getTime() + 61 * 86_400_000), NOW) === "61_90" &&
      horizonBand(new Date(NOW.getTime() + 90 * 86_400_000), NOW) === "61_90" &&
      horizonBand(new Date(NOW.getTime() + 91 * 86_400_000), NOW) === "90_plus" &&
      horizonBand(null, NOW) === "undated",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE REPORTS — the figures already published must not have changed meaning.
// ─────────────────────────────────────────────────────────────────────────────
{
  const PUBLISHED: Array<[string, string]> = [
    ["total_scheduled_upgrade_mrr", "scheduled_upgrade_mrr"],
    ["total_scheduled_downgrade_mrr", "scheduled_downgrade_mrr"],
    ["total_scheduled_upgrades", "scheduled_upgrades"],
    ["total_scheduled_downgrades", "scheduled_downgrades"],
    ["total_scheduled_cancellation_mrr", "scheduled_cancellation_mrr"],
    ["total_scheduled_cancellations", "scheduled_cancellations"],
  ];
  const got = M("month", "2026-09-30");
  const wrong: string[] = [];
  for (const [reportKey, measure] of PUBLISHED) {
    for (const currency of ["USD", "EUR"]) {
      const r = await resolveReport(orgId, bizId, reportKey, { currency, now: NOW, range: "12m" });
      const stored = got.get(key(measure, "", "", currency)) ?? 0n;
      if (BigInt(Math.round(r.headline ?? 0)) !== stored) {
        wrong.push(`${reportKey} ${currency}: report ${r.headline}, measure ${measure}=${stored}`);
      }
      // A forward figure has no series to draw — the report says so, and a measure that
      // grew one would be answering a question nothing recorded.
      if (r.points.length !== 0)
        wrong.push(`${reportKey} ${currency}: drew a series of ${r.points.length}`);
    }
  }
  ok(
    "oracle: all six published figures equal the report that publishes them, in both currencies",
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ report disagreements:", wrong.slice(0, 15));

  // …and the unscoped report, which converts, is the two currencies added at parity. A
  // per-currency store that had lost a currency would pass the scoped check and fail here.
  const all = await resolveReport(orgId, bizId, "total_scheduled_cancellation_mrr", {
    currency: "ALL",
    now: NOW,
    range: "12m",
  });
  ok(
    "oracle: the converted report is the sum of the per-currency figures, at parity",
    BigInt(Math.round(all.headline ?? 0)) ===
      got.get(key("scheduled_cancellation_mrr", "", "", "USD"))! +
        got.get(key("scheduled_cancellation_mrr", "", "", "EUR"))!,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. TRIALS ENDING has no published report, so its second oracle is `trials_active` —
//     written by a different module, off the same two stamps, for the same instant.
// ─────────────────────────────────────────────────────────────────────────────
{
  /** The trial stock the day the run happens, straight out of the store. */
  const activeRows = await withTenant(orgId, (tx) =>
    tx
      .select({ currency: metricDaily.currency, value: metricDaily.value })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.grain, "day"),
          eq(metricDaily.periodEnd, "2026-09-15"),
          eq(metricDaily.measure, "trials_active"),
          eq(metricDaily.dim, ""),
        ),
      ),
  );
  const active = new Map(activeRows.map((r) => [r.currency, r.value]));
  const got = M("day", "2026-09-15");
  /**
   * The two answer the same population read two ways, and differ by EXACTLY the trials with
   * no end on file: running, so in the stock; not ending, so not on the ladder. The fixture
   * holds one of those in USD and none in EUR, which is why the gap is asserted per currency
   * rather than as a single number.
   */
  ok(
    "oracle: the trial ladder and the trial stock agree, apart from the open-ended trial",
    active.get("USD") === 4n &&
      got.get(key("trials_ending", "", "", "USD")) === 3n &&
      active.get("EUR") === 1n &&
      got.get(key("trials_ending", "", "", "EUR")) === 1n,
  );
  ok(
    "not counted: a trial already OVER is not ending, and neither is one on a subscription that has gone",
    got.get(key("trials_ending", "", "", "USD")) === 3n &&
      got.get(key("trials_ending", "horizon", "overdue", "USD")) === undefined,
  );
  ok(
    "not counted: a trial with no end on file is running but not ENDING — never banded undated",
    got.get(key("trials_ending", "horizon", "undated", "USD")) === undefined,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE AS-OF RULE — a past period carries NO row, and the reader calls it missing.
// ─────────────────────────────────────────────────────────────────────────────
{
  const outside: Array<[Grain, string]> = [
    ["day", "2026-09-14"],
    ["day", "2026-09-16"],
    ["month", "2026-07-31"],
    ["month", "2026-10-31"],
    ["year", "2025-12-31"],
  ];
  const leaked = outside.filter(([g, p]) => M(g, p).size > 0);
  ok(
    "as-of: only the period containing the run carries a row — a past period is unknown, never a zero",
    leaked.length === 0,
  );
  if (leaked.length) console.log("  ↳ periods that invented a history:", leaked);

  const series = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "scheduled_cancellation_mrr",
    grain: "day",
    periods: [
      { start: "2026-09-14", end: "2026-09-14", label: "Sep 14" },
      { start: "2026-09-15", end: "2026-09-15", label: "Sep 15" },
      { start: "2026-09-16", end: "2026-09-16", label: "Sep 16" },
    ],
  });
  ok(
    "as-of: the reader reports the unanswerable day as MISSING, and only the run's day as answered",
    series.missing.includes("2026-09-14") &&
      series.missing.includes("2026-09-16") &&
      !series.missing.includes("2026-09-15"),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE BANDS PARTITION — they sum to the total, and nothing falls outside them.
// ─────────────────────────────────────────────────────────────────────────────
{
  const got = M("month", "2026-09-30");
  const wrong: string[] = [];
  for (const measure of SCHEDULED_MEASURES) {
    for (const currency of ["USD", "EUR"]) {
      const total = got.get(key(measure, "", "", currency));
      if (total == null) {
        wrong.push(`${measure} ${currency}: no unsliced total stored`);
        continue;
      }
      let summed = 0n;
      for (const band of HORIZON_BANDS)
        summed += got.get(key(measure, "horizon", band, currency)) ?? 0n;
      if (summed !== total) wrong.push(`${measure} ${currency}: bands ${summed}, total ${total}`);
    }
  }
  ok(
    "horizon: every measure's bands sum to its unsliced figure, in both currencies",
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ bands that do not partition:", wrong);

  // Both halves of the closed set, from the data's side: every band the fixture reaches is
  // one of the six, and all six ARE reached — so the check above is not summing a set of one.
  const emitted = new Set<string>();
  for (const k of got.keys()) {
    const [, dim, dimValue] = k.split("|") as [string, string, string];
    if (dim === "horizon") emitted.add(dimValue);
  }
  const outside = [...emitted].filter((b) => !(HORIZON_BANDS as readonly string[]).includes(b));
  const unreached = HORIZON_BANDS.filter((b) => !emitted.has(b));
  ok("horizon: every band emitted is one of the declared six", outside.length === 0);
  ok("horizon: all six declared bands are actually reached by the fixture", unreached.length === 0);
  if (outside.length) console.log("  ↳ invented bands:", outside);
  if (unreached.length) console.log("  ↳ bands nothing exercises:", unreached);

  // …and the reader can cut by it. A dimension that answers empty is the same defect one
  // layer up — the forward book would show one number and no way to ask when it lands.
  const read = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "scheduled_cancellation_mrr",
    grain: "month",
    periods: [{ start: "2026-09-01", end: "2026-09-30", label: "Sep" }],
    split: "horizon",
  });
  const keys = new Set((read.slices ?? []).map((s) => s.dimValue));
  ok(
    "horizon: the split is readable, not merely writable",
    ["overdue", "1_30", "31_60", "61_90", "undated"].every((b) => keys.has(b)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. WHAT IS NOT SCHEDULED IS NOT COUNTED. Each condition has a twin that falls the
//    other way, so a dropped predicate shows up as a number rather than an absence.
// ─────────────────────────────────────────────────────────────────────────────
{
  const got = M("month", "2026-09-30");
  const up = got.get(key("scheduled_upgrade_mrr", "", "", "USD"))!;
  ok(
    "not counted: a change that has ALREADY APPLIED is gone from the forward book (9,999 never lands)",
    up !== 12_500n + 9999n && up === 12_500n,
  );
  ok(
    "not counted: a change the merchant WITHDREW is not booked (7,777 never lands)",
    up !== 12_500n + 7777n && got.get(key("scheduled_upgrades", "", "", "USD")) === 5n,
  );
  ok(
    "not counted: a booked cancel or pause carries no estimate, and null is not a delta of zero",
    got.get(key("scheduled_upgrades", "", "", "USD")) === 5n &&
      got.get(key("scheduled_downgrades", "", "", "USD")) === 2n,
  );
  ok(
    "counted, and placed: a booking beyond the horizon is in the total AND in 90_plus, nowhere nearer",
    got.get(key("scheduled_upgrade_mrr", "horizon", "90_plus", "USD")) === 1000n &&
      got.get(key("scheduled_upgrade_mrr", "horizon", "1_30", "USD")) === 5000n,
  );
  /**
   * The Group 6 trap, head on: the already-gone subscription carries 30,000 — MORE than the
   * whole booked figure — and is the only one in the fixture that is both booked to stop and
   * stopped. If the "not yet gone" predicate were dropped, this check fails by a number.
   */
  ok(
    "not counted: a subscription already GONE is churn, not a booked cancellation (30,000 never lands)",
    got.get(key("scheduled_cancellation_mrr", "", "", "USD")) === 21_000n &&
      got.get(key("scheduled_cancellations", "", "", "USD")) === 5n,
  );
  ok(
    "counted: a booked stop whose date has PASSED is still booked until something applies it",
    got.get(key("scheduled_cancellation_mrr", "horizon", "overdue", "USD")) === 4000n,
  );
  ok(
    "counted: a booked stop with NO date on file is undated, not 'later'",
    got.get(key("scheduled_cancellation_mrr", "horizon", "undated", "USD")) === 2000n &&
      got.get(key("scheduled_cancellation_mrr", "horizon", "90_plus", "USD")) === undefined,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. AS-OF THE RUN, NOT AS-OF THE PERIOD — so every grain containing it agrees.
// ─────────────────────────────────────────────────────────────────────────────
{
  const dayRows = M("day", "2026-09-15");
  const wrong: string[] = [];
  for (const [grain, periodEnd] of [
    ["month", "2026-09-30"],
    ["quarter", "2026-09-30"],
    ["year", "2026-12-31"],
  ] as Array<[Grain, string]>) {
    const other = M(grain, periodEnd);
    if (other.size !== dayRows.size) {
      wrong.push(`${grain} ${periodEnd}: ${other.size} rows, the day has ${dayRows.size}`);
      continue;
    }
    for (const [k, v] of dayRows) {
      if (other.get(k) !== v) wrong.push(`${grain} ${periodEnd} ${k}: ${other.get(k)}, day ${v}`);
    }
  }
  ok(
    "as-of: the day, the month, the quarter and the year containing the run all give the SAME answer",
    wrong.length === 0,
  );
  if (wrong.length) console.log("  ↳ grains that disagree:", wrong.slice(0, 10));
  ok("as-of: and the answer is not empty", dayRows.size > 0);
  // The pair's schedule and valuation are pinned in `test/unit/expected-renewal-charges`;
  // here, that the run writes a measured total for every currency the book bills in.
  const cashRows = await withTenant(orgId, (tx) =>
    tx
      .select({
        measure: metricDaily.measure,
        currency: metricDaily.currency,
        value: metricDaily.value,
      })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.grain, "day"),
          eq(metricDaily.periodEnd, "2026-09-15"),
          eq(metricDaily.dim, ""),
        ),
      ),
  );
  const cashTotal = new Set(
    cashRows
      .filter(
        (r) => (EXPECTED_CASH_MEASURES as readonly string[]).includes(r.measure) && r.value != null,
      )
      .map((r) => `${r.measure}|${r.currency}`),
  );
  ok(
    "expected cash: the run writes expected_renewal_cash and expected_renewals for USD and EUR",
    (["expected_renewal_cash", "expected_renewals"] as const).every((m) =>
      (["USD", "EUR"] as const).every((c) => cashTotal.has(`${m}|${c}`)),
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. DECLARED == EMITTED, both ways, including the dimensions that are columns.
// ─────────────────────────────────────────────────────────────────────────────
{
  const emitted = new Map<string, Set<string>>();
  const currencies = new Map<string, Set<string>>();
  for (const got of materialised.values()) {
    for (const k of got.keys()) {
      const [measure, dim, , currency] = k.split("|") as [string, string, string, string];
      if (dim !== "")
        (emitted.get(measure) ?? emitted.set(measure, new Set()).get(measure)!).add(dim);
      (currencies.get(measure) ?? currencies.set(measure, new Set()).get(measure)!).add(currency);
    }
  }
  const wrong: string[] = [];
  for (const m of MEASURES) {
    if (!MINE.has(m.id)) continue;
    const declared = m.dimensions.filter((d) => d !== "currency" && d !== "business");
    const seen = emitted.get(m.id) ?? new Set<string>();
    for (const d of declared)
      if (!seen.has(d)) wrong.push(`${m.id}: declares ${d}, never emits it`);
    for (const d of seen) {
      if (!(declared as readonly string[]).includes(d))
        wrong.push(`${m.id}: emits ${d}, undeclared`);
    }
    // `currency` is a column rather than a slice, and is only a real dimension if more than
    // one actually reaches the table.
    if ((currencies.get(m.id)?.size ?? 0) < 2) {
      wrong.push(`${m.id}: declares currency, but only one ever reached the table`);
    }
    if ([...(currencies.get(m.id) ?? [])].some((c) => c === "XXX")) {
      wrong.push(`${m.id}: is money or a per-currency count, yet wrote XXX`);
    }
  }
  ok("dimensions: every declared dimension is emitted, and nothing else is", wrong.length === 0);
  if (wrong.length) console.log("  ↳ registry/writer disagreements:", wrong);

  // A band row is only ever written for a band something is actually in, so a currency with
  // nothing booked has a measured-zero TOTAL and no bands — null is not zero, and a zero
  // band would claim a window was inspected and found empty when no such window was cut.
  const got = M("month", "2026-09-30");
  ok(
    "null is not zero: the empty currency has a measured zero total and no band rows at all",
    got.get(key("scheduled_downgrade_mrr", "", "", "EUR")) === 0n &&
      ![...got.keys()].some(
        (k) => k.startsWith("scheduled_downgrade_mrr|horizon|") && k.endsWith("|EUR"),
      ),
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
    ? `✅ METRIC-SCHEDULED: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-SCHEDULED: FAIL (${failed}/${checks.length} failed)`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
