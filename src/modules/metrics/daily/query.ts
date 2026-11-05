import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { metricDaily } from "@db/schema";
import {
  combinesAcrossBusinesses,
  denominatorIsMoney,
  measureById,
  type Grain,
  type MeasureDef,
} from "./measures";
import { DEFAULT_CALENDAR, periodEndOf, type BusinessCalendar } from "@/platform/business-calendar";

/**
 * Read a measure out of `metric_daily` — the one resolver every surface ends up behind.
 *
 * The read this whole design exists for: `WHERE business AND measure AND period_end BETWEEN`,
 * bounded by PERIODS × the cardinality of one dimension, never by how many subscriptions the
 * business has. The reconstruction it replaces costs the whole book per chart bucket —
 * measured at 3.5 s of JavaScript on a 74,534-subscription book.
 *
 * ⚠️ It does NOT convert currencies and it does NOT decide a window. Both are reporting
 * choices made above this layer, and pushing either down here is how a stored figure becomes
 * a number nobody can reproduce.
 */

export interface MetricPoint {
  /** The period's last day, `YYYY-MM-DD`. */
  t: string;
  currency: string;
  /** Null means "computed, and the answer is nothing" — never silently zero. */
  value: bigint | null;
  denominator: bigint | null;
}

export interface MetricSlicePoint extends MetricPoint {
  dimValue: string;
}

export interface MetricSeries {
  measure: MeasureDef;
  grain: Grain;
  points: MetricPoint[];
  /** Present only when `split` was asked for. */
  slices?: MetricSlicePoint[];
  /** The oldest `computed_at` in the answer — the age a caller should be told about. */
  computedAt: Date | null;
  /** Periods the table did not cover. Non-empty means the caller must fall back. */
  missing: string[];
}

/**
 * A refusal a caller can act on.
 *
 * The sentence is the contract — it names the fix in words a screen shows verbatim. But a
 * client should not have to PARSE that sentence to offer the choices, so a refusal that has a
 * finite set of valid answers carries them as data too: `param` says which input to change,
 * `options` says what it may become. Prose for the human, fields for the code.
 */
export class MeasureRefused extends Error {
  readonly param?: string;
  readonly options?: string[];
  constructor(message: string, detail?: { param: string; options: string[] }) {
    super(message);
    this.param = detail?.param;
    this.options = detail?.options;
  }
}

/**
 * Aggregate day rows up to the requested grain.
 *
 * The registry's `aggregate` decides, and it is the field that keeps this honest:
 *
 * - `sum`  — flows add across the period.
 * - `last` — a stock is the value on the period's LAST day. Summing one inflates MRR by
 *            roughly thirty, which is the easiest catastrophic mistake in this design.
 * - `ratio`— numerator and denominator are folded SEPARATELY, each by the rule the measure
 *            declares, and divided by the caller through `ratioValue`. A quarter's rate is
 *            therefore the quarter's own arithmetic, never the mean of its months'. The two
 *            halves do not always fold the same way: retention divides by what the period
 *            OPENED with, which is the first day's denominator and not the sum of them.
 * - `none` — not derivable from a finer grain (a distinct count), so the row must already
 *            exist at the grain asked for. We refuse rather than guess.
 */
function fold(
  m: MeasureDef,
  rows: Array<{
    periodEnd: string;
    currency: string;
    value: bigint | null;
    denominator: bigint | null;
  }>,
): MetricPoint[] {
  if (m.aggregate === "none") {
    return rows.map((r) => ({
      t: r.periodEnd,
      currency: r.currency,
      value: r.value,
      denominator: r.denominator,
    }));
  }
  if (m.aggregate === "last") {
    // Last by date per currency — the rows arrive ordered, so the final one wins.
    const byCurrency = new Map<string, MetricPoint>();
    for (const r of rows) {
      byCurrency.set(r.currency, {
        t: r.periodEnd,
        currency: r.currency,
        value: r.value,
        denominator: r.denominator,
      });
    }
    return [...byCurrency.values()];
  }
  if (m.aggregate === "ratio") {
    const byCurrency = new Map<string, { t: string; half: RatioHalves }>();
    for (const r of rows) {
      const cur = byCurrency.get(r.currency);
      if (!cur) byCurrency.set(r.currency, { t: r.periodEnd, half: startHalves(r) });
      else {
        cur.t = r.periodEnd;
        addHalves(cur.half, r);
      }
    }
    return [...byCurrency].map(([currency, { t, half }]) => ({
      t,
      currency,
      ...closeHalves(m, half),
    }));
  }

  const byCurrency = new Map<string, MetricPoint>();
  for (const r of rows) {
    const cur = byCurrency.get(r.currency);
    // A null contributes nothing to a sum but must not turn the total null: "no answer for
    // one day" is not "no answer for the period".
    const add = r.value ?? 0n;
    if (!cur) {
      byCurrency.set(r.currency, {
        t: r.periodEnd,
        currency: r.currency,
        value: add,
        denominator: null,
      });
    } else {
      cur.t = r.periodEnd;
      cur.value = (cur.value ?? 0n) + add;
    }
  }
  return [...byCurrency.values()];
}

/**
 * A ratio being folded: the period's opening denominator, its LAST stored row, and the
 * running sums.
 *
 * All of them are kept because the two halves need not fold the same way — the growth rate
 * divides the window's net movement by the stock it OPENED with, while the quick ratio
 * divides one flow by another and an average revenue divides a stock by a count at the
 * period's end.
 */
interface RatioHalves {
  firstDenominator: bigint | null;
  lastValue: bigint | null;
  lastDenominator: bigint | null;
  sumValue: bigint;
  sumDenominator: bigint;
  sawValue: boolean;
}

type RatioRow = { value: bigint | null; denominator: bigint | null };

function startHalves(r: RatioRow): RatioHalves {
  return {
    firstDenominator: r.denominator,
    lastValue: r.value,
    lastDenominator: r.denominator,
    sumValue: r.value ?? 0n,
    sumDenominator: r.denominator ?? 0n,
    sawValue: r.value != null,
  };
}

function addHalves(h: RatioHalves, r: RatioRow): void {
  h.lastValue = r.value;
  h.lastDenominator = r.denominator;
  h.sumValue += r.value ?? 0n;
  h.sumDenominator += r.denominator ?? 0n;
  if (r.value != null) h.sawValue = true;
}

/** Apply the measure's declared fold to each half. Never divides — that is the reader's job. */
function closeHalves(
  m: MeasureDef,
  h: RatioHalves,
): { value: bigint | null; denominator: bigint | null } {
  const fold = m.ratio!;
  const denominator =
    fold.denominator === "sum"
      ? h.sumDenominator
      : fold.denominator === "last"
        ? h.lastDenominator
        : h.firstDenominator;
  if (fold.numerator === "last") return { value: h.lastValue, denominator };
  if (!h.sawValue) return { value: null, denominator };
  return { value: h.sumValue, denominator };
}

export async function readMetric(input: {
  organizationId: string;
  businessId: string;
  measure: string;
  grain: Grain;
  /** Inclusive, `YYYY-MM-DD`, both the first and last period END. */
  from: string;
  to: string;
  /** A dimension to split by, or omitted for the total. */
  split?: string;
  /** The business's calendar — where a stored coarse row is keyed. */
  calendar?: BusinessCalendar;
}): Promise<MetricSeries> {
  const m = measureById(input.measure);
  if (!m) throw new MeasureRefused(`There is no measure called "${input.measure}".`);
  if (!m.grains.includes(input.grain)) {
    throw new MeasureRefused(
      `${m.name} cannot be shown by ${input.grain}. It supports ${m.grains.join(", ")}.`,
    );
  }
  if (input.split && !(m.dimensions as readonly string[]).includes(input.split)) {
    throw new MeasureRefused(
      `${m.name} cannot be split by ${input.split}. It can be split by ${m.dimensions.join(", ") || "nothing"}.`,
    );
  }

  /**
   * A measure that is not additive must be READ at the grain it is served at — there is no
   * arithmetic that turns days into it. Everything else is stored daily and folded above,
   * which keeps one row per day doing the work of five grains.
   */
  const storedGrain: Grain = m.aggregate === "none" ? input.grain : "day";
  // A running coarse period is stored at its calendar end, past a window that ends today.
  const readTo =
    m.aggregate === "none" ? calendarEnd(storedGrain, input.to, input.calendar) : input.to;
  /**
   * `currency` is not a stored slice — every row carries its currency as a COLUMN, because
   * money is held per currency and converted once at read time. So it is grouped by rather
   * than filtered on, exactly as `business` is in the series read below. Filtering for
   * `dim = 'currency'` finds nothing, which is a declared dimension answering empty.
   */
  const byCurrency = input.split === "currency";
  /**
   * The headline is ALWAYS the stored `dim = ''` row. A stored split reads BOTH dims in one
   * pass: the total rows answer `points`, the dimension rows answer `slices`. Folding the
   * slices instead would publish a different number — they need not cover the population,
   * and for a stock, folding slices is not the operation that produced the stored total.
   */
  const storedDim = input.split && !byCurrency ? input.split : "";
  const dims = storedDim === "" ? [""] : ["", storedDim];

  const rows = await withTenant(input.organizationId, (tx) =>
    tx
      .select({
        periodEnd: metricDaily.periodEnd,
        dim: metricDaily.dim,
        dimValue: metricDaily.dimValue,
        currency: metricDaily.currency,
        value: metricDaily.value,
        denominator: metricDaily.denominator,
        computedAt: metricDaily.computedAt,
      })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, input.businessId),
          eq(metricDaily.measure, m.id),
          eq(metricDaily.grain, storedGrain),
          inArray(metricDaily.dim, dims),
          gte(metricDaily.periodEnd, input.from),
          lte(metricDaily.periodEnd, readTo),
        ),
      )
      .orderBy(asc(metricDaily.periodEnd)),
  );

  const computedAt = rows.reduce<Date | null>(
    (oldest, r) => (oldest == null || r.computedAt < oldest ? r.computedAt : oldest),
    null,
  );

  // Which periods the table did not answer. A caller that ignores this and plots the gap as
  // zero is the failure mode this field exists to prevent — an incomplete cache must not
  // change the answer, it must say it is incomplete.
  const totalRows = storedDim === "" ? rows : rows.filter((r) => r.dim === "");
  const sliceRows = storedDim === "" ? rows : rows.filter((r) => r.dim === storedDim);

  const covered = new Set(totalRows.map((r) => r.periodEnd));
  const missing: string[] = [];
  for (const d of eachPeriodEnd(storedGrain, input.from, input.to)) {
    if (!covered.has(d)) missing.push(d);
  }
  /**
   * A non-additive measure has to have been WRITTEN at this grain — no fold can produce it —
   * so a read that finds nothing is an uncovered period, not an answer of zero. The coarser
   * grains have no day-by-day calendar to walk, so the range itself is what is missing.
   */
  if (m.aggregate === "none" && storedGrain !== "day" && totalRows.length === 0) {
    missing.push(input.to);
  }

  if (!input.split) {
    return { measure: m, grain: input.grain, points: fold(m, totalRows), computedAt, missing };
  }

  const byValue = new Map<string, typeof sliceRows>();
  for (const r of sliceRows) {
    const key = byCurrency ? r.currency : r.dimValue;
    const arr = byValue.get(key) ?? [];
    arr.push(r);
    byValue.set(key, arr);
  }
  const slices: MetricSlicePoint[] = [];
  for (const [dimValue, group] of byValue) {
    for (const p of fold(m, group)) slices.push({ ...p, dimValue });
  }
  return {
    measure: m,
    grain: input.grain,
    points: fold(m, totalRows),
    slices,
    computedAt,
    missing,
  };
}

/**
 * The END of the `grain` period containing `day` — the key a non-additive coarse row is
 * stored under, even while that period is still running (`coarsePeriodEnds` in cron.ts
 * writes it there). A window that ends today must read the current period at THIS key, or
 * the running month is never found.
 */
export function calendarEnd(
  grain: Grain,
  day: string,
  calendar: BusinessCalendar = DEFAULT_CALENDAR,
): string {
  return periodEndOf(grain, day, calendar);
}

/** Every period END between two dates at a grain, inclusive. Days only for now — coarser
 *  grains are folded from days, so only a `none` measure ever reads them directly. */
function* eachPeriodEnd(grain: Grain, from: string, to: string): Generator<string> {
  if (grain !== "day") return;
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The series read behind the public API.
//
// `readMetric` answers ONE period. A chart wants many, and asking it per period costs a
// round trip per bucket — 365 of them for a year by day. This reads the whole window once
// and folds each period out of it in memory, so a request costs one query per (measure,
// split) no matter how many buckets it draws.
// ─────────────────────────────────────────────────────────────────────────────

/** A bucket, as calendar dates. Both ends inclusive; `end` is the row key a stock is read at. */
export interface SeriesPeriod {
  start: string;
  end: string;
  label: string;
}

export interface SeriesCell {
  /** The period's `end` — the key the caller plots on. */
  t: string;
  currency: string;
  value: bigint | null;
  denominator: bigint | null;
}

export interface MetricSeriesResult {
  measure: MeasureDef;
  grain: Grain;
  /** The unsliced total, per period × currency. */
  cells: SeriesCell[];
  /** Present only when `split` was asked for. */
  slices?: Array<SeriesCell & { dimValue: string }>;
  computedAt: Date | null;
  /** Period ENDS the store could not answer at all. Drives the response's `coverage`. */
  missing: string[];
}

interface SeriesRow {
  businessId: string;
  periodEnd: string;
  dimValue: string;
  currency: string;
  value: bigint | null;
  denominator: bigint | null;
}

/**
 * Fold one period's rows into one figure per currency.
 *
 * The business dimension is why this is not `fold`. Across several businesses a STOCK is the
 * sum of each business's own last value — take the last row overall and an organization's MRR
 * becomes whichever business happened to sort last.
 */
function foldPeriod(
  m: MeasureDef,
  rows: SeriesRow[],
  /**
   * Each business's last stored day in the period, read off its TOTAL rows. A stock is what
   * exists on that day: a slice or currency with no row there contributes nothing, rather
   * than its value from earlier in the period (a churned plan kept showing its old MRR).
   */
  asOf?: ReadonlyMap<string, string>,
): Map<string, SeriesCell> {
  const out = new Map<string, SeriesCell>();
  const add = (currency: string, value: bigint | null, denominator: bigint | null) => {
    const cur = out.get(currency);
    if (!cur) {
      out.set(currency, { t: "", currency, value, denominator });
      return;
    }
    if (value != null) cur.value = (cur.value ?? 0n) + value;
    if (denominator != null) cur.denominator = (cur.denominator ?? 0n) + denominator;
  };

  /**
   * A DISTINCT COUNT IS NEVER ADDED — not across periods, and not across the rows inside
   * one. The rows were read at the grain asked for, so a bucket holds one row per business
   * and currency; if a restatement ever put two there, the later one supersedes rather than
   * joining it. Falling through to the sum below would double-count every returning account,
   * which is the whole reason this aggregation exists.
   */
  if (m.aggregate === "none") {
    const lastPerBusiness = new Map<string, SeriesRow>();
    for (const r of rows) lastPerBusiness.set(`${r.businessId}\u0000${r.currency}`, r);
    for (const r of lastPerBusiness.values()) add(r.currency, r.value, r.denominator);
    return out;
  }
  if (m.aggregate === "last") {
    const lastPerBusiness = new Map<string, SeriesRow>();
    for (const r of rows) {
      const day = asOf?.get(r.businessId);
      if (day != null && r.periodEnd !== day) continue;
      lastPerBusiness.set(`${r.businessId}\u0000${r.currency}`, r);
    }
    for (const r of lastPerBusiness.values()) add(r.currency, r.value, r.denominator);
    return out;
  }
  /**
   * A ratio folds PER BUSINESS and the results are then added, for the same reason a stock
   * does: an organization's retention is each business's opening revenue less each
   * business's losses, and taking "the first row overall" would make the denominator
   * whichever business happened to sort first.
   */
  if (m.aggregate === "ratio") {
    const perBusiness = new Map<string, { currency: string; half: RatioHalves }>();
    for (const r of rows) {
      const k = `${r.businessId}\u0000${r.currency}`;
      const cur = perBusiness.get(k);
      if (!cur) perBusiness.set(k, { currency: r.currency, half: startHalves(r) });
      else addHalves(cur.half, r);
    }
    for (const { currency, half } of perBusiness.values()) {
      const folded = closeHalves(m, half);
      add(currency, folded.value, folded.denominator);
    }
    return out;
  }
  for (const r of rows) add(r.currency, r.value ?? 0n, null);
  return out;
}

export async function readMetricSeries(input: {
  organizationId: string;
  /** One business, or every business in the organization. */
  businessIds: readonly string[];
  measure: string;
  grain: Grain;
  periods: readonly SeriesPeriod[];
  /** A dimension to split by, or omitted for the total. */
  split?: string;
  /** The business's calendar — where a stored coarse row is keyed. Additive reads ignore it. */
  calendar?: BusinessCalendar;
  /**
   * The last day every business has reached (`scopeToday`). No day row after it is read: a
   * business that has not reached a day has no row for it, and a stock summed without that
   * business is a fraction of the total. A period past it is reported missing instead.
   */
  through?: string;
  /**
   * Convert every DAY row into `base` before it folds, at the rate held that day — so a
   * month of flows is the sum of its days at their own rates. `toBase` answers null for a
   * currency with no rate, and that row is dropped. Rows fold in their own currency (a stock
   * keeps its last row per business AND currency) and are relabelled `base` after.
   */
  convert?: {
    base: string;
    toBase: (minor: bigint, currency: string, periodEnd: string) => bigint | null;
  };
}): Promise<MetricSeriesResult> {
  const m = measureById(input.measure);
  if (!m) throw new MeasureRefused(`There is no measure called "${input.measure}".`);
  if (!m.grains.includes(input.grain)) {
    throw new MeasureRefused(
      `${m.name} cannot be shown by ${input.grain}. It supports ${m.grains.join(", ")}.`,
    );
  }
  if (input.split && !(m.dimensions as readonly string[]).includes(input.split)) {
    throw new MeasureRefused(
      `${m.name} cannot be split by ${input.split}. It can be split by ${m.dimensions.join(", ") || "nothing"}.`,
    );
  }
  if (
    m.aggregate === "none" &&
    input.businessIds.length > 1 &&
    !combinesAcrossBusinesses(m, input.grain)
  ) {
    throw new MeasureRefused(
      `${m.name} is not additive, so it cannot be combined across businesses. Ask for one business.`,
    );
  }
  if (input.periods.length === 0) throw new MeasureRefused("That range contains no periods.");

  /**
   * `business` is not a stored slice — every row already carries its business — so it is
   * grouped by rather than filtered on. Everything else reads the stored dimension.
   */
  const byBusiness = input.split === "business";
  // Neither `business` nor `currency` is a stored slice: both are columns on every row, so
  // both are grouped by rather than filtered on. See `readMetric`.
  const byCurrency = input.split === "currency";
  const storedDim = byBusiness || byCurrency ? "" : (input.split ?? "");
  /**
   * THE HEADLINE IS ALWAYS THE STORED `dim = ''` ROW, whatever the split.
   *
   * A stored split therefore reads both dims in one pass and they are partitioned below:
   * the total rows answer `cells`, the dimension rows answer `slices`. Building `cells`
   * from the slices instead moves the published total — the slices need not cover the
   * population (a row with no attribution has no slice), and for a `last`-aggregate stock,
   * folding slices per period is not the operation that produced the stored total.
   */
  const dims = storedDim === "" ? [""] : ["", storedDim];
  const storedGrain: Grain = m.aggregate === "none" ? input.grain : "day";
  // Non-additive coarse rows are keyed at each period's CALENDAR end — see `calendarEnd`.
  const keyOf = (end: string) =>
    m.aggregate === "none" ? calendarEnd(storedGrain, end, input.calendar) : end;

  const from = input.periods[0]!.start;
  const lastKey = keyOf(input.periods[input.periods.length - 1]!.end);
  // Coarse `none` rows are keyed at a period's calendar end, often past `through`.
  const to =
    storedGrain === "day" && input.through != null && input.through < lastKey
      ? input.through
      : lastKey;

  const rows = await withTenant(input.organizationId, (tx) =>
    tx
      .select({
        businessId: metricDaily.businessId,
        periodEnd: metricDaily.periodEnd,
        dim: metricDaily.dim,
        dimValue: metricDaily.dimValue,
        currency: metricDaily.currency,
        value: metricDaily.value,
        denominator: metricDaily.denominator,
        computedAt: metricDaily.computedAt,
      })
      .from(metricDaily)
      .where(
        and(
          inArray(metricDaily.businessId, [...input.businessIds]),
          eq(metricDaily.measure, m.id),
          eq(metricDaily.grain, storedGrain),
          inArray(metricDaily.dim, dims),
          gte(metricDaily.periodEnd, from),
          lte(metricDaily.periodEnd, to),
        ),
      )
      .orderBy(asc(metricDaily.periodEnd)),
  );

  const computedAt = rows.reduce<Date | null>(
    (oldest, r) => (oldest == null || r.computedAt < oldest ? r.computedAt : oldest),
    null,
  );

  // Bucket by period, and by which dim the row answers. When the split is a COLUMN
  // (`business`, `currency`) there is one set of rows and it answers both.
  const totalBuckets = input.periods.map(() => [] as SeriesRow[]);
  const sliceBuckets = input.periods.map(() => [] as SeriesRow[]);
  for (const r of rows) {
    const i = input.periods.findIndex((p) => r.periodEnd >= p.start && r.periodEnd <= keyOf(p.end));
    if (i < 0) continue;
    let value = r.value;
    let denominator = r.denominator;
    const conv = input.convert;
    if (conv && r.currency !== conv.base) {
      // `toBase` answers null only for a currency with no rate, whatever the amount.
      const converted = conv.toBase(value ?? 0n, r.currency, r.periodEnd);
      if (converted == null) continue;
      value = value == null ? null : converted;
      // A count denominator is never money, and never converted.
      if (denominator != null && denominatorIsMoney(m)) {
        denominator = conv.toBase(denominator, r.currency, r.periodEnd);
      }
    }
    const cell: SeriesRow = {
      businessId: r.businessId,
      periodEnd: r.periodEnd,
      dimValue: byBusiness ? r.businessId : byCurrency ? r.currency : r.dimValue,
      currency: r.currency,
      value,
      denominator,
    };
    if (r.dim === "") totalBuckets[i]!.push(cell);
    if (input.split && r.dim === storedDim) sliceBuckets[i]!.push(cell);
  }

  const cells: SeriesCell[] = [];
  const slices: Array<SeriesCell & { dimValue: string }> = [];
  const missing: string[] = [];

  input.periods.forEach((p, i) => {
    const group = totalBuckets[i]!;
    if (group.length === 0) missing.push(p.end);
    const label = (c: SeriesCell) => (input.convert ? { ...c, currency: input.convert.base } : c);
    const asOf = new Map<string, string>();
    for (const r of group)
      if ((asOf.get(r.businessId) ?? "") < r.periodEnd) asOf.set(r.businessId, r.periodEnd);
    for (const c of foldPeriod(m, group, asOf).values()) cells.push({ ...label(c), t: p.end });
    if (!input.split) return;
    const byValue = new Map<string, SeriesRow[]>();
    for (const r of sliceBuckets[i]!) {
      const arr = byValue.get(r.dimValue) ?? [];
      arr.push(r);
      byValue.set(r.dimValue, arr);
    }
    for (const [dimValue, group2] of byValue) {
      for (const c of foldPeriod(m, group2, asOf).values())
        slices.push({ ...label(c), t: p.end, dimValue });
    }
  });

  return {
    measure: m,
    grain: input.grain,
    cells,
    ...(input.split ? { slices } : {}),
    computedAt,
    missing,
  };
}
