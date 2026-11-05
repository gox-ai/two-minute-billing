/**
 * The COARSE-GRAIN BACKFILL gate for `metric_daily` (0267).
 *
 * A day fill alone leaves every PAST month with no stored figure for the measures that
 * cannot be folded out of days — the four distinct customer counts, and gross and net
 * revenue retention since their cohort restriction made them per-grain measures. The reader
 * is right to report those months missing; the fix is to WRITE them, and this gate is the
 * proof that the writing happened, that it is the same arithmetic the reader expects, and
 * that it did not quietly become a fold.
 *
 * What it proves, in the order a wrong implementation breaks it:
 *   1. THE PERIOD SET IS DISTINCT. 400 days name ~13 months once each, not 400 times.
 *   2. THE BOUNDARIES ARE THE BUSINESS'S. On an Asia/Kolkata book a month closes at local
 *      midnight; a run that derived its days in UTC would name a different month for every
 *      instant in the 5h30m the two calendars disagree, and window the period 5h30m wrong.
 *   3. A DAY-ONLY FILL LEAVES THE MONTH MISSING, and the coarse fill makes it ANSWER. Both
 *      halves asserted, so neither can pass vacuously.
 *   4. THE WRITER AND THE READER AGREE. What was stored for the month equals a direct
 *      `computeMetricPeriod` at month grain over the same period, half for half.
 *   5. THE MONTH IS NOT ITS DAYS. A subscription that both arrived and left inside the
 *      month is in a day's opening cohort and not the month's, so the stored month equals
 *      neither the ratio of the day sums nor the mean of the day rates — while a foldable
 *      measure read at month grain still folds out of exactly those day rows.
 *   6. THE TWO FILL PATHS AGREE. `--fast` writes the same coarse rows as the plain loop.
 *   7. RE-RUNNING WRITES NOTHING NEW. Same keys, same values.
 *   8. `--grains none` IS THE OLD BEHAVIOUR — day rows, no coarse row anywhere.
 *
 *   pnpm verify:metric-daily-coarse
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, cancelSubscription } from "@/modules/subscriptions/service";
import {
  computeMetricPeriod,
  periodStart,
  periodEndExclusive,
} from "@/modules/metrics/daily/compute";
import { coarsePeriodSet, COARSE_GRAINS } from "@/modules/metrics/daily/bulk-fill";
import { readMetricSeries } from "@/modules/metrics/daily/query";
import { resolveAnalytics, resolveScope } from "@/modules/metrics/daily/public-query";
import { zonedDayString } from "@/platform/timezones";
import { DEFAULT_CALENDAR } from "@/platform/business-calendar";
import { customers, metricDaily, subscriptions } from "@db/schema";

const run = promisify(execFile);
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean, detail = "") =>
  checks.push([detail ? `${n} — ${detail}` : n, c]);

/** The business's zone. Non-UTC on purpose: every boundary below is a local one. */
const ZONE = "Asia/Kolkata";
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => {
  const d = at(day);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const daysBetween = (from: string, to: string) =>
  Math.round((at(to).getTime() - at(from).getTime()) / 86_400_000);

// ─────────────────────────────────────────────────────────────────────────────
// The calendar, anchored on TODAY IN THE BUSINESS'S ZONE.
//
// The backfill fills yesterday backwards from the day it runs, so a fixture pinned to
// fixed dates would drift out of the window. The anchor is two local months back: a month
// that has certainly closed, and that a modest `--days` still reaches.
// ─────────────────────────────────────────────────────────────────────────────
const todayLocal = zonedDayString(new Date(), ZONE);
const [ty, tm] = todayLocal.split("-").map(Number) as [number, number, number];
const anchor = new Date(Date.UTC(ty, tm - 3, 1));
const MONTH_START = iso(anchor);
const MONTH_END = iso(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)));
const D = (n: number) => addDays(MONTH_START, n - 1);
/** Enough days to reach a month before the anchor, so its opening stock is a real one. */
const DAYS = daysBetween(addDays(MONTH_START, -40), todayLocal);

// ─────────────────────────────────────────────────────────────────────────────
// Seed — its own organization, never the dev database's book.
// ─────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Metric Daily Coarse Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Metric Daily Coarse Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: ZONE,
});
const bizId = biz.id;

const product = await createProduct({ organizationId: orgId, businessId: bizId, name: "Plan" });
const priceFor = (amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
  });
const big = await priceFor(10_000);
const small = await priceFor(5_000);
/** Every term parked well past the window, so a live worker never renews anything mid-run. */
const PARKED = at(addDays(todayLocal, 400));

let seq = 0;
async function subscribe(price: Awaited<ReturnType<typeof priceFor>>, startedOn: string) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `coarse-${String(++seq).padStart(2, "0")}-${Date.now()}@example.test`,
  });
  await systemDb
    .update(customers)
    .set({ createdAt: at(startedOn) })
    .where(eq(customers.id, customer.id));
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: customer.id,
    now: at(startedOn),
    startDate: at(startedOn),
    items: [{ price, quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: PARKED, trialEnd: PARKED, createdAt: at(startedOn) })
    .where(eq(subscriptions.id, subscription.id));
  return subscription;
}

/**
 * THE FIXTURE IS THE WHOLE ARGUMENT for check 5.
 *
 *  A — live before the month opens, cancelled INSIDE it. It is in the month's opening
 *      cohort, and its loss is the month's loss.
 *  B — arrives AND leaves inside the month. It was never in the month's opening, so the
 *      month must not count its loss — but it IS in the opening of the day it left on, so
 *      that day must. That single subscription is why a month cannot be folded.
 */
const subA = await subscribe(big, addDays(MONTH_START, -20));
const subB = await subscribe(small, D(5));
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subA.id,
  atPeriodEnd: false,
  now: at(D(12)),
});
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subB.id,
  atPeriodEnd: false,
  now: at(D(20)),
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE PERIOD SET IS DISTINCT — and derived, not walked.
// ─────────────────────────────────────────────────────────────────────────────
{
  const window: string[] = [];
  for (let i = 0; i < 400; i++) window.push(addDays("2026-09-20", -i));
  const set = coarsePeriodSet(window, DEFAULT_CALENDAR);

  const months = set.get("month") ?? [];
  const expectedMonths = new Set(window.map((d) => d.slice(0, 7)));
  ok(
    "distinct: 400 days name each containing month exactly once",
    months.length === expectedMonths.size && new Set(months).size === months.length,
    `${months.length} months for 400 days`,
  );
  const quarters = set.get("quarter") ?? [];
  const years = set.get("year") ?? [];
  const weeks = set.get("week") ?? [];
  ok(
    "distinct: …and each quarter, year and week once too",
    new Set(quarters).size === quarters.length &&
      new Set(years).size === years.length &&
      new Set(weeks).size === weeks.length &&
      quarters.length < months.length &&
      years.length < quarters.length,
    `${weeks.length} weeks, ${quarters.length} quarters, ${years.length} years`,
  );
  ok(
    "distinct: the whole coarse pass is a fraction of the day pass, not a multiple of it",
    weeks.length + months.length + quarters.length + years.length < window.length / 4,
  );
  ok(
    "distinct: every period end is a real month/quarter/year end",
    months.every((m) => addDays(m, 1).endsWith("-01")) &&
      quarters.every((q) => ["03-31", "06-30", "09-30", "12-31"].includes(q.slice(5))) &&
      years.every((y) => y.endsWith("-12-31")),
  );
  ok(
    "distinct: newest first, so an interrupted run has filled what a screen asks for",
    months.join(",") === [...months].sort().reverse().join(","),
  );
  const subset = coarsePeriodSet(window, DEFAULT_CALENDAR, ["month"]);
  ok(
    "distinct: --grains month asks for months and nothing else",
    subset.size === 1 && (subset.get("month") ?? []).length === months.length,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE BOUNDARIES ARE THE BUSINESS'S, NOT THE RUN HOST'S.
// ─────────────────────────────────────────────────────────────────────────────
{
  /**
   * 00:30 on the first of a month in Asia/Kolkata is still 19:00 on the last of the
   * PREVIOUS month in UTC. A run that derived its day list from the UTC calendar would
   * close the previous month here — the wrong period, by a whole month, from one instant.
   */
  const justAfterLocalMidnight = new Date("2026-07-01T00:30:00.000+05:30");
  const localDay = zonedDayString(justAfterLocalMidnight, ZONE);
  const utcDay = zonedDayString(justAfterLocalMidnight, null);
  const localMonth = coarsePeriodSet([localDay], DEFAULT_CALENDAR, ["month"]).get("month")![0];
  const utcMonth = coarsePeriodSet([utcDay], DEFAULT_CALENDAR, ["month"]).get("month")![0];
  ok(
    "local: an instant just after local midnight closes the LOCAL month",
    localDay === "2026-07-01" && localMonth === "2026-07-31",
    `${localDay} → ${localMonth}`,
  );
  ok(
    "local: …and the UTC calendar would have named the month before it",
    utcDay === "2026-06-30" && utcMonth === "2026-06-30" && utcMonth !== localMonth,
  );
  const localQuarter = coarsePeriodSet([localDay], DEFAULT_CALENDAR, ["quarter"]).get(
    "quarter",
  )![0];
  const localYear = coarsePeriodSet([localDay], DEFAULT_CALENDAR, ["year"]).get("year")![0];
  ok(
    "local: the quarter and the year follow the same calendar",
    localQuarter === "2026-09-30" && localYear === "2026-12-31",
  );

  /**
   * And the WINDOW of that period is cut at local midnight too — 18:30Z, not 00:00Z. The
   * period end and the period window are two implementations of one boundary, and a
   * coarse row written under a local key but computed over a UTC window is the same bug
   * wearing the right label.
   */
  const from = periodStart("month", localMonth!, ZONE);
  const to = periodEndExclusive(localMonth!, ZONE);
  ok(
    "local: the month's window opens and closes at LOCAL midnight",
    from.toISOString() === "2026-06-30T18:30:00.000Z" &&
      to.toISOString() === "2026-07-31T18:30:00.000Z",
    `${from.toISOString()} … ${to.toISOString()}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The backfill itself. Spawned as the CLI, so the flag and its default are what is tested.
// ─────────────────────────────────────────────────────────────────────────────
const backfill = async (...flags: string[]) => {
  const { stdout } = await run(
    "node_modules/.bin/tsx",
    ["scripts/backfill-metric-daily.ts", "--biz", biz.publicId, "--days", String(DAYS), ...flags],
    { cwd: process.cwd(), env: process.env, maxBuffer: 32 * 1024 * 1024 },
  );
  return stdout;
};

type Row = { measure: string; currency: string; value: bigint | null; denominator: bigint | null };
const coarseRows = async (): Promise<Map<string, Row>> => {
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(metricDaily)
      .where(
        and(eq(metricDaily.businessId, bizId), inArray(metricDaily.grain, [...COARSE_GRAINS])),
      ),
  );
  return new Map(
    rows.map((r) => [
      `${r.grain}|${r.periodEnd}|${r.measure}|${r.dim}|${r.dimValue}|${r.currency}`,
      { measure: r.measure, currency: r.currency, value: r.value, denominator: r.denominator },
    ]),
  );
};
const sameRows = (a: Map<string, Row>, b: Map<string, Row>): boolean => {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.value !== v.value || o.denominator !== v.denominator) return false;
  }
  return true;
};

const scope = await resolveScope(
  orgId,
  { id: bizId, publicId: biz.publicId, name: biz.name, timezone: ZONE },
  "test",
);
const monthRetention = () =>
  resolveAnalytics(scope, {
    measure: "gross_revenue_retention",
    grain: "month",
    start: MONTH_START,
    end: MONTH_END,
    currency: "USD",
  });

// ── 8 + 3a. Day-only: the old behaviour, and the month the product cannot answer ────────
await backfill("--fast", "--write", "--grains", "none");
{
  const coarse = await coarseRows();
  ok("day-only: --grains none writes not one coarse row", coarse.size === 0);
  const dayRows = await withTenant(orgId, (tx) =>
    tx
      .select({ id: metricDaily.id })
      .from(metricDaily)
      .where(and(eq(metricDaily.businessId, bizId), eq(metricDaily.grain, "day"))),
  );
  ok("day-only: …and the day path still fills the window", dayRows.length > 0);

  const before = await monthRetention();
  ok(
    "missing: with day rows alone the month's retention reports MISSING, not a number",
    before.total === null && (before.coverage?.missing_periods ?? []).includes(MONTH_END),
  );
}

// ── 3b + 4 + 5. The coarse fill, plain loop ─────────────────────────────────────────────
await backfill("--write");
const sequential = await coarseRows();
{
  const after = await monthRetention();
  ok(
    "answers: after the coarse fill the month's retention is a figure, with nothing missing",
    after.total !== null && after.coverage === undefined,
    `total ${after.total}`,
  );

  /**
   * THE WRITER AND THE READER MUST NOT DISAGREE. The stored month is compared against a
   * direct `computeMetricPeriod` at month grain over the same period — the same call the
   * nightly close makes, run here with no fill in between.
   */
  const direct = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, "month", MONTH_END, new Date(), {
      onlyNonAdditive: true,
      timezone: ZONE,
    }),
  );
  ok("writer==reader: the direct month computation returns rows at all", direct.length > 0);
  const mismatched = direct.filter((d) => {
    const stored = sequential.get(
      `month|${MONTH_END}|${d.measure}|${d.dim}|${d.dimValue}|${d.currency}`,
    );
    return (
      !stored ||
      stored.value !== d.value ||
      (stored.denominator ?? null) !== (d.denominator ?? null)
    );
  });
  ok(
    "writer==reader: every directly computed month row is the row the backfill stored",
    mismatched.length === 0,
    mismatched.length > 0 ? `${mismatched.length} of ${direct.length} differ` : "",
  );
  const storedMonthOnly = [...sequential.keys()].filter((k) => k.startsWith(`month|${MONTH_END}|`));
  ok(
    "writer==reader: …and the backfill stored nothing the computation did not produce",
    storedMonthOnly.length === direct.length,
  );

  /**
   * THE MONTH IS NOT ITS DAYS. B arrived and left inside the month, so it is in the
   * opening cohort of the day it left on and not in the month's — the two figures are
   * different measurements, and the gate states both so a fold cannot creep back in.
   */
  const stored = sequential.get(`month|${MONTH_END}|gross_revenue_retention|||USD`) ?? null;
  const days = await readMetricSeries({
    organizationId: orgId,
    businessIds: [bizId],
    measure: "gross_revenue_retention",
    grain: "day",
    periods: [{ start: MONTH_START, end: MONTH_END, label: "m" }],
  });
  ok("not-a-fold: the day rows for the month exist to be folded", days.cells.length > 0);
  const dayCells = await withTenant(orgId, (tx) =>
    tx
      .select({
        periodEnd: metricDaily.periodEnd,
        value: metricDaily.value,
        denominator: metricDaily.denominator,
      })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.grain, "day"),
          eq(metricDaily.measure, "gross_revenue_retention"),
        ),
      ),
  );
  const inMonth = dayCells.filter((c) => c.periodEnd >= MONTH_START && c.periodEnd <= MONTH_END);
  const sumNum = inMonth.reduce((a, c) => a + (c.value ?? 0n), 0n);
  const sumDen = inMonth.reduce((a, c) => a + (c.denominator ?? 0n), 0n);
  const foldedRatio = sumDen === 0n ? null : Number((sumNum * 10_000n) / sumDen);
  const rates = inMonth
    .filter((c) => c.denominator != null && c.denominator !== 0n)
    .map((c) => Number(((c.value ?? 0n) * 10_000n) / c.denominator!));
  const meanRate =
    rates.length === 0 ? null : Math.round(rates.reduce((a, b) => a + b, 0) / rates.length);
  const storedRate =
    stored == null || stored.denominator == null || stored.denominator === 0n
      ? null
      : Number((stored.value! * 10_000n) / stored.denominator);
  ok(
    "not-a-fold: the stored month is the ratio of the MONTH's own halves, not of its days' sums",
    storedRate !== null && foldedRatio !== null && storedRate !== foldedRatio,
    `month ${storedRate} vs folded ${foldedRatio}`,
  );
  ok(
    "not-a-fold: …and not the mean of the day rates either",
    storedRate !== null && meanRate !== null && storedRate !== meanRate,
    `month ${storedRate} vs mean ${meanRate}`,
  );
  ok(
    "not-a-fold: the month's opening cohort excludes what arrived inside it",
    stored?.denominator === 10_000n,
    `denominator ${stored?.denominator}`,
  );

  /**
   * …while a FOLDABLE measure still folds out of exactly those day rows. Cancellations
   * have no month row at all — the reader reads days and adds them — and the sum must
   * still equal the month computed directly.
   */
  const foldable = await resolveAnalytics(scope, {
    measure: "subscription_cancellations",
    grain: "month",
    start: MONTH_START,
    end: MONTH_END,
    currency: "USD",
  });
  const directFull = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, "month", MONTH_END, new Date(), { timezone: ZONE }),
  );
  const directNew = directFull.find(
    (r) => r.measure === "subscription_cancellations" && r.dim === "" && r.currency === "USD",
  );
  ok(
    "folds: a foldable measure read at month grain equals the month computed directly",
    foldable.total != null && directNew != null && BigInt(foldable.total) === directNew.value,
    `folded ${foldable.total} vs direct ${directNew?.value}`,
  );
  const storedNewMrrMonth = [...sequential.keys()].some((k) =>
    k.includes("|subscription_cancellations|"),
  );
  ok(
    "folds: …and no month row was written for it — the coarse pass writes only what cannot fold",
    !storedNewMrrMonth,
  );
}

// ── 6. The two fill paths agree ─────────────────────────────────────────────────────────
{
  await withTenant(orgId, (tx) =>
    tx
      .delete(metricDaily)
      .where(
        and(eq(metricDaily.businessId, bizId), inArray(metricDaily.grain, [...COARSE_GRAINS])),
      ),
  );
  await backfill("--fast", "--write");
  const fast = await coarseRows();
  ok(
    "paths: --fast writes the same coarse rows as the plain loop, key for key and half for half",
    sameRows(sequential, fast) && fast.size > 0,
    `${sequential.size} vs ${fast.size} rows`,
  );

  // ── 7. Idempotent ────────────────────────────────────────────────────────────────────
  await backfill("--fast", "--write");
  const again = await coarseRows();
  ok(
    "idempotent: re-running restates the same rows and invents none",
    sameRows(fast, again),
    `${fast.size} vs ${again.size} rows`,
  );
}

// ── The dry run is the default ──────────────────────────────────────────────────────────
{
  await withTenant(orgId, (tx) =>
    tx
      .delete(metricDaily)
      .where(
        and(eq(metricDaily.businessId, bizId), inArray(metricDaily.grain, [...COARSE_GRAINS])),
      ),
  );
  const out = await backfill("--fast");
  const after = await coarseRows();
  ok(
    "dry run: without --write the coarse pass counts rows and writes none",
    after.size === 0 && /coarse rows/.test(out) && /Dry run/.test(out),
  );
}

for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
const failed = checks.filter(([, c]) => !c);
console.log("");
const verdict = failed.length === 0;
console.log(
  verdict
    ? `✅ METRIC-DAILY-COARSE: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-DAILY-COARSE: FAIL (${failed.length}/${checks.length} failed)`,
);
await closeDb();
process.exit(verdict ? 0 : 1);
