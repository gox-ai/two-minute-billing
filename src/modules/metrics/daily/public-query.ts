/**
 * The public analytics answer — what `GET /v1/analytics` serialises.
 *
 * This layer owns the three reporting choices `readMetricSeries` deliberately refuses: which
 * periods a range means, which currency a figure is stated in, and what a caller is told
 * about the parts of it that are not known. Everything it returns is self-describing,
 * because a third party cannot read this file to find out what a number meant.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { loadRateTimeline, type RateTimeline } from "@/platform/fx/history";
import { zonedDayEndExclusive, zonedDayString } from "@/platform/timezones";
import {
  calendarOf,
  DEFAULT_CALENDAR,
  periodEndOf,
  periodStartOf,
  quarterLabel,
  sameCalendar,
  yearLabel,
  type BusinessCalendar,
} from "@/platform/business-calendar";
import { businesses, meters, metricDaily, organizations, products } from "@db/schema";
import {
  MeasureRefused,
  readMetricSeries,
  type MetricSeriesResult,
  type SeriesCell,
  type SeriesPeriod,
} from "./query";
import {
  denominatorIsMoney,
  hasMoneyHalves,
  measureById,
  ratioValue,
  type Grain,
  type MeasureDef,
} from "./measures";
import { freshnessFor } from "./freshness";
import { cachedSeries, seriesCacheEnabled } from "./series-cache";
import { windowRows } from "./windows";
import { FX_IMPACT_MEASURE, fxBookCurrencies, readFxImpact } from "./fx-measures";
import { BILLING_INTERVAL_LABELS } from "../dimension-values";
import { REGION_LABELS } from "../regions";
import { failureReasonLabel } from "./failure-labels";
import {
  readSegmentSeries,
  segmentRefusal,
  SEGMENT_MEASURES,
  type SegmentPopulation,
} from "./segment-series";
import { segmentPopulation, SegmentError } from "@/modules/segments/service";

export const GRAINS: readonly Grain[] = ["day", "week", "month", "quarter", "year"];

/**
 * Named windows. Each resolves in a real timezone rather than UTC — "this month" starts at a
 * different instant in Auckland than in Los Angeles, and a report that quietly picks UTC is
 * wrong for everyone who is not on it.
 */
export const ANALYTICS_WINDOWS = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "90d",
  "6m",
  "12m",
  "this_month",
  "last_month",
  "this_quarter",
  "this_year",
] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export const isAnalyticsWindow = (v: unknown): v is AnalyticsWindow =>
  typeof v === "string" && (ANALYTICS_WINDOWS as readonly string[]).includes(v);

export const DEFAULT_SPLIT_LIMIT = 20;
export const MAX_SPLIT_LIMIT = 200;
/** A hard ceiling on buckets, so no range can ask for an unbounded series. */
export const MAX_PERIODS = 400;

// ── dates, as calendar strings ────────────────────────────────────────────────────────────

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const utc = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number): string => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Today in a timezone, as that zone's calendar date. */
export function todayIn(timezone: string): string {
  // The cached per-zone formatter: building one per call cost ~1 ms each on production.
  return zonedDayString(new Date(), timezone);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (m: number) => MONTHS[m] ?? "";

/** A bucket's label, from its full (unclipped) period. Quarters and years follow the fiscal year. */
function periodLabel(grain: Grain, start: string, end: string, cal: BusinessCalendar): string {
  const s = utc(start);
  const e = utc(end);
  if (grain === "day") return `${monthName(e.getUTCMonth())} ${e.getUTCDate()}`;
  if (grain === "week")
    return `${monthName(s.getUTCMonth())} ${s.getUTCDate()} – ${monthName(e.getUTCMonth())} ${e.getUTCDate()}`;
  if (grain === "month") return `${monthName(e.getUTCMonth())} ${e.getUTCFullYear()}`;
  if (grain === "quarter") return quarterLabel(end, cal.fiscalYearStartMonth);
  return yearLabel(end, cal.fiscalYearStartMonth);
}

/**
 * The buckets a window covers at a grain, cut on the business's calendar.
 *
 * The first and last bucket are CLIPPED to the window rather than widened to their calendar
 * unit: a month in progress must end today, or a stock would be read at a date the store has
 * no row for and the current period would read empty.
 */
export function buildPeriods(
  grain: Grain,
  start: string,
  end: string,
  cal: BusinessCalendar = DEFAULT_CALENDAR,
): SeriesPeriod[] {
  const periods: SeriesPeriod[] = [];
  let cursor = start;
  while (cursor <= end && periods.length <= MAX_PERIODS) {
    const pEnd = periodEndOf(grain, cursor, cal);
    const clippedEnd = pEnd > end ? end : pEnd;
    periods.push({
      start: cursor,
      end: clippedEnd,
      label: periodLabel(grain, periodStartOf(grain, cursor, cal), pEnd, cal),
    });
    cursor = addDays(clippedEnd, 1);
  }
  if (periods.length > MAX_PERIODS) {
    throw new MeasureRefused(
      `That range covers more than ${MAX_PERIODS} ${grain} periods. Ask for a shorter range or a coarser grain.`,
    );
  }
  return periods;
}

export interface ResolvedWindow {
  name: AnalyticsWindow | null;
  start: string;
  end: string;
  timezone: string;
  timezoneSource: "business" | "organization" | "default";
}

/** A named window's span, ending today in the reporting timezone; quarters and years are fiscal. */
function namedWindow(
  name: AnalyticsWindow,
  today: string,
  cal: BusinessCalendar,
): { start: string; end: string } {
  const d = utc(today);
  switch (name) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: y, end: y };
    }
    case "7d":
      return { start: addDays(today, -6), end: today };
    case "30d":
      return { start: addDays(today, -29), end: today };
    case "90d":
      return { start: addDays(today, -89), end: today };
    case "6m":
      return {
        start: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 5, 1))),
        end: today,
      };
    case "12m":
      return {
        start: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1))),
        end: today,
      };
    case "this_month":
      return { start: periodStartOf("month", today, cal), end: today };
    case "last_month": {
      const prevEnd = addDays(periodStartOf("month", today, cal), -1);
      return { start: periodStartOf("month", prevEnd, cal), end: prevEnd };
    }
    case "this_quarter":
      return { start: periodStartOf("quarter", today, cal), end: today };
    case "this_year":
      return { start: periodStartOf("year", today, cal), end: today };
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveWindow(input: {
  range?: string;
  start?: string;
  end?: string;
  timezone: string;
  timezoneSource: ResolvedWindow["timezoneSource"];
  /** Cuts `this_quarter` / `this_year`; rolling and month windows ignore it. */
  calendar?: BusinessCalendar;
  /** Pins "today" for a test; defaults to today in `timezone`. */
  today?: string;
}): ResolvedWindow {
  const today = input.today ?? todayIn(input.timezone);
  const base = { timezone: input.timezone, timezoneSource: input.timezoneSource };

  if (input.start != null || input.end != null) {
    if (input.range != null) {
      throw new MeasureRefused("Ask for either `range` or `start`/`end`, not both.");
    }
    if (!input.start || !input.end) {
      throw new MeasureRefused("An explicit window needs both `start` and `end`, as YYYY-MM-DD.");
    }
    if (!DATE_RE.test(input.start) || !DATE_RE.test(input.end)) {
      throw new MeasureRefused("`start` and `end` must be calendar dates, as YYYY-MM-DD.");
    }
    if (input.start > input.end) throw new MeasureRefused("`start` must not be after `end`.");
    return { name: null, start: input.start, end: input.end, ...base };
  }

  const name = (input.range ?? "12m") as AnalyticsWindow;
  if (!isAnalyticsWindow(name)) {
    throw new MeasureRefused(
      `There is no range called "${input.range}". Named ranges are ${ANALYTICS_WINDOWS.join(", ")}, or give explicit start and end dates.`,
    );
  }
  return { name, ...namedWindow(name, today, input.calendar ?? DEFAULT_CALENDAR), ...base };
}

/** The window of equal length immediately before this one — what `compare=previous` means. */
function previousWindow(w: { start: string; end: string }): { start: string; end: string } {
  const days = Math.round((utc(w.end).getTime() - utc(w.start).getTime()) / 86_400_000) + 1;
  const end = addDays(w.start, -1);
  return { start: addDays(end, -(days - 1)), end };
}

// ── the reporting scope ───────────────────────────────────────────────────────────────────

export interface AnalyticsScope {
  organizationId: string;
  /** Business row ids the answer covers. One, or every business in the organization. */
  businessIds: string[];
  /** Public ids, keyed by row id — what a `split=business` row is labelled with. */
  businessNames: Map<string, { publicId: string; name: string }>;
  scope: "business" | "organization";
  businessPublicId: string | null;
  /**
   * The zone the WINDOW is cut in — and, at business scope, the zone each stored day was
   * cut in too, because `metric_daily.period_end` is the business's own calendar date.
   *
   * ⚠️ AT ORGANIZATION SCOPE THIS IS THE LABEL, NOT THE BASIS. Each business's rows are cut
   * on that business's own local day, and the roll-up sums them. That is what an operator
   * means — each one's Monday is their own Monday — but it does mean an organization total
   * spanning several zones is not a single wall-clock interval, and no zone can make it
   * one. Stated rather than reconciled.
   *
   * It is NOT where "today" is: see `zones` and `scopeToday`.
   */
  timezone: string;
  /**
   * The zones the scope's businesses cut their days in (null is UTC), distinct. Each one's
   * newest row is its own local today, so the answer's last day is the earliest of them.
   */
  zones: string[];
  timezoneSource: ResolvedWindow["timezoneSource"];
  /**
   * Where weeks, quarters and years are cut. At organization scope it is the businesses'
   * shared calendar, or the default when they disagree — additive figures fold from days, so
   * any calendar sums correctly, and a non-additive one crosses businesses only at day or
   * month grain (`combinesAcrossBusinesses`), where every calendar agrees.
   */
  calendar: BusinessCalendar;
  /**
   * The organization's base currency (0268), or null if it has never chosen one.
   *
   * Answers "which one did you mean" when a money measure spans several currencies. It
   * converts nothing and makes nothing summable — an explicit `currency=` still wins, and a
   * base currency the window has no rows in is ignored rather than obeyed.
   */
  baseCurrency: string | null;
  /** Rates against `baseCurrency` — `1 base = rate x other`. Null when none are set. */
  exchangeRates: Record<string, number> | null;
  /** Which row `baseCurrency` and `exchangeRates` came from — named in a refusal. */
  baseCurrencySource: "business" | "organization" | "none";
  /**
   * Rate histories already loaded for this scope, keyed by base + fallback rates. A batch
   * shares one scope, and each converted question reloaded the same ~2.5k observations.
   */
  rateTimelines?: Map<string, Promise<RateTimeline>>;
}

/**
 * The last day every business in the scope has reached at `at`, in its own zone.
 *
 * A business writes today under its own local date, so at 20:00 UTC an Asia/Kolkata book
 * already has tomorrow's row and a New York one does not. Reading the organization at the
 * later day sums one stock with no row for the others, and a missing row is unknown, not
 * zero. So the organization's day is the EARLIEST local today; at business scope it is the
 * business's own.
 */
export function scopeToday(scope: Pick<AnalyticsScope, "zones" | "timezone">, at: Date): string {
  let earliest: string | null = null;
  for (const zone of scope.zones) {
    const day = zonedDayString(at, zone);
    if (earliest == null || day < earliest) earliest = day;
  }
  return earliest ?? zonedDayString(at, scope.timezone);
}

/** The caller's test/live partition. `all` is a platform or operator credential. */
export type ScopeLivemode = "live" | "test" | "all";

/**
 * Resolve the scope of an answer. `business` is a FILTER, not a different question: dropping
 * it widens the same query to every business rather than switching to another computation.
 *
 * `livemode` is the CALLER's partition, not a property of a metric row: every row belongs to a
 * business and a business is wholly live or wholly test, so filtering the businesses filters
 * the figures. It defaults to `live` — an unlabelled caller gets the real population, never
 * sandbox figures folded into a production total.
 *
 * FX precedence: a SINGLE-BUSINESS answer is stated in that business's own default currency,
 * at that business's own rates, and only falls back to the organization's pair when the
 * business has no default. A business bills in one currency and its rates are quoted against
 * it; reading the organization's base for a one-business question converts into a currency
 * nobody on that book uses — and where the organization has never set one, refuses every
 * multi-currency money measure the business could answer perfectly well. Organization scope
 * keeps the organization's pair, which is the only one that spans the account.
 *
 * Currency and rates travel TOGETHER, never mixed: the rates are quoted against their own
 * currency, so an organization rate applied to a business base is a wrong number, not a
 * missing one.
 */
/**
 * When the 5-minute cron last wrote the scope's figures — the latest `computed_at` on its
 * current-day rows, NOT the answer's `computed_at` (that is the oldest row in the range, and
 * a year of closed history is hours old by design). The window is two UTC days back so every
 * zone's "today" is inside it; a backfill rewriting old days does not count as a sync.
 * Org scope reports the businesses' OLDEST latest write: it is only as synced as its laggard.
 */
export async function lastSyncedAt(scope: AnalyticsScope): Promise<Date | null> {
  if (scope.businessIds.length === 0) return null;
  const rows = await withTenant(scope.organizationId, (tx) =>
    tx
      .select({ at: sql<Date>`max(${metricDaily.computedAt})` })
      .from(metricDaily)
      .where(
        and(
          inArray(metricDaily.businessId, scope.businessIds),
          eq(metricDaily.grain, "day"),
          sql`${metricDaily.periodEnd} >= (now() at time zone 'utc')::date - 2`,
        ),
      )
      .groupBy(metricDaily.businessId),
  );
  let oldest: Date | null = null;
  for (const r of rows) {
    const at = r.at ? new Date(r.at) : null;
    if (at && (oldest == null || at < oldest)) oldest = at;
  }
  return oldest;
}

export async function resolveScope(
  organizationId: string,
  business: { id: string; publicId: string; name: string; timezone: string | null } | null,
  livemode: ScopeLivemode = "live",
): Promise<AnalyticsScope> {
  const [org] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        timezone: organizations.timezone,
        baseCurrency: organizations.baseCurrency,
        exchangeRates: organizations.exchangeRates,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1),
  );
  const orgCurrency = org?.baseCurrency ?? null;
  const orgRates = (org?.exchangeRates as Record<string, number> | null) ?? null;

  if (business) {
    const [own] = await withTenant(organizationId, (tx) =>
      tx
        .select({
          defaultCurrency: businesses.defaultCurrency,
          exchangeRates: businesses.exchangeRates,
          weekStart: businesses.weekStart,
          fiscalYearStartMonth: businesses.fiscalYearStartMonth,
        })
        .from(businesses)
        .where(eq(businesses.id, business.id))
        .limit(1),
    );
    const useBusiness = own?.defaultCurrency != null;
    return {
      organizationId,
      businessIds: [business.id],
      businessNames: new Map([[business.id, { publicId: business.publicId, name: business.name }]]),
      scope: "business",
      businessPublicId: business.publicId,
      // A business's own timezone wins over the organization's: "this month" is the month
      // where the billing happens.
      timezone: business.timezone ?? "UTC",
      zones: [business.timezone ?? "UTC"],
      timezoneSource: business.timezone ? "business" : "default",
      calendar: calendarOf(own),
      baseCurrency: useBusiness ? (own?.defaultCurrency ?? null) : orgCurrency,
      exchangeRates: useBusiness
        ? ((own?.exchangeRates as Record<string, number> | null) ?? null)
        : orgRates,
      baseCurrencySource: useBusiness ? "business" : orgCurrency ? "organization" : "none",
    };
  }
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: businesses.id,
        publicId: businesses.publicId,
        name: businesses.name,
        timezone: businesses.timezone,
        weekStart: businesses.weekStart,
        fiscalYearStartMonth: businesses.fiscalYearStartMonth,
      })
      .from(businesses)
      .where(livemode === "all" ? undefined : eq(businesses.livemode, livemode)),
  );
  const calendars = rows.map(calendarOf);
  const shared =
    calendars.length > 0 && calendars.every((c) => sameCalendar(c, calendars[0]!))
      ? calendars[0]!
      : DEFAULT_CALENDAR;
  return {
    organizationId,
    businessIds: rows.map((r) => r.id),
    businessNames: new Map(rows.map((r) => [r.id, { publicId: r.publicId, name: r.name }])),
    scope: "organization",
    businessPublicId: null,
    timezone: org?.timezone ?? "UTC",
    zones: [...new Set(rows.map((r) => r.timezone ?? "UTC"))],
    timezoneSource: org?.timezone ? "organization" : "default",
    calendar: shared,
    baseCurrency: orgCurrency,
    exchangeRates: orgRates,
    baseCurrencySource: orgCurrency ? "organization" : "none",
  };
}

// ── the answer ────────────────────────────────────────────────────────────────────────────

export interface AnalyticsRequest {
  measure: string;
  grain?: string;
  range?: string;
  start?: string;
  end?: string;
  split?: string;
  splitLimit?: number;
  currency?: string;
  compare?: string;
  /** `series` (default) or `totals` — see `ANSWER_SHAPES`. */
  shape?: string;
  /** A saved segment's id (`seg_…`) — the measure for that population only. */
  segment?: string;
}

/**
 * How much of the answer to send.
 *
 *  - `series` — every period, on the headline and on each split row.
 *  - `totals` — the same answer with the periods left out: `series` and each split row's
 *    `points` are empty, and `total` is unchanged. A split becomes a ranked list, and a
 *    measure without a split a single figure. Totals are still folded from the periods, so
 *    they are digit for digit the `series` answer's totals.
 */
export const ANSWER_SHAPES = ["series", "totals"] as const;
export type AnswerShape = (typeof ANSWER_SHAPES)[number];

export interface SeriesPoint {
  t: string;
  label: string;
  /**
   * The answer, in the measure's declared unit. For a RATIO this is the quotient — divided
   * here and nowhere else — and `numerator`/`denominator` travel beside it so a caller can
   * audit it or re-aggregate it themselves. A quotient with nothing to divide by is null,
   * never 0 and never an infinity.
   */
  value: number | null;
  numerator?: number | null;
  denominator?: number | null;
}

/**
 * What a split row IS. The two residual rows exist for DIFFERENT reasons and a caller must be
 * able to tell them apart without reading this file — a dimension whose own closed set already
 * contains a key called `other` makes the key alone ambiguous.
 *
 *  - `dimension`    — a real value of the dimension.
 *  - `truncated`    — the rows beyond `split_limit`, added up. Real data, just not itemised.
 *  - `unattributed` — the part of the population the dimension does not describe at all: a
 *                     subscription with no plan, an invoice with no country. It is the stored
 *                     total minus every dimension row, so it is a remainder, not a measurement.
 */
export type SplitRowKind = "dimension" | "truncated" | "unattributed";

export type SplitExhaustiveBasis =
  | "rows_add_to_total"
  | "row_totals_not_coincident"
  | "rate_not_decomposable"
  | "distinct_count_not_additive";

export interface SplitRow {
  key: string;
  label: string;
  kind: SplitRowKind;
  total: number | null;
  points: SeriesPoint[];
}

export interface AnalyticsResult {
  object: "analytics_result";
  measure: string;
  name: string;
  description: string;
  kind: MeasureDef["kind"];
  unit: MeasureDef["unit"];
  aggregate: MeasureDef["aggregate"];
  currency: string | null;
  /**
   * `per_currency` — one currency's own figure, nothing converted.
   * `across_currencies` — a count, which is currency-agnostic.
   * `converted` — summed INTO `currency` using the organization's rates. Read `rates` for what
   *   was applied and `missing_rates` for what had none and was therefore left out.
   */
  currency_basis: "per_currency" | "across_currencies" | "converted";
  /** The rates applied, when `currency_basis` is `converted`. `1 base = rate x other`. */
  rates?: Record<string, number>;
  /** Currencies EXCLUDED from a converted total for want of a rate — named, never dropped. */
  missing_rates?: string[];
  scope: "business" | "organization";
  business: string | null;
  grain: Grain;
  range: {
    name: AnalyticsWindow | null;
    start: string;
    end: string;
    timezone: string;
    timezone_source: ResolvedWindow["timezoneSource"];
  };
  as_of: string;
  computed_at: string | null;
  /** Echoed, so an empty `series` reads as asked-for rather than as no data. */
  shape: AnswerShape;
  /**
   * The population answered for, when a segment was asked for. Membership is TODAY'S —
   * see `segment-series.ts` — and `note` says so, for a caller that prints the figure.
   */
  segment?: { id: string; name: string; membership: "current"; note: string };
  series: SeriesPoint[];
  total: number | null;
  /** A `window` total's own halves, so a card can show the base the rate was divided by. */
  total_numerator?: number | null;
  total_denominator?: number | null;
  /** `window`: a distinct count or cohort rate computed over the window itself (`windows.ts`). */
  total_basis: "sum_over_window" | "value_at_end" | "window";
  split?: {
    dimension: string;
    limit: number;
    returned: number;
    truncated: boolean;
    /** True only when the returned rows' totals add back up to `total`. */
    exhaustive: boolean;
    /** Why they do or do not — the machine-readable half of `note`. */
    exhaustive_basis: SplitExhaustiveBasis;
    /** One sentence a screen can print verbatim. */
    note: string;
    series: SplitRow[];
  };
  compare?: {
    basis: "previous_window";
    start: string;
    end: string;
    previous_total: number | null;
    change_minor: number | null;
    change_bps: number | null;
  };
  coverage?: {
    complete_from: string | null;
    missing_periods: string[];
    note: string;
  };
  /** Non-null when the answer covers the period in progress and can still move. */
  freshness: { includes_current_period: boolean; max_age_seconds: number };
}

const num = (v: bigint | null): number | null => (v == null ? null : Number(v));

/**
 * Decide what currency an answer is stated in, and convert into it where the account has said
 * how.
 *
 * Money is never summed across currencies UNCONVERTED — adding rupees to dollars is not a
 * number. But converting at READ time, with rates the account set and with what could not be
 * converted named out loud, is exactly what this layer is for: FX is a reporting choice, which
 * is why no rate is ever baked into a stored row.
 *
 * Three outcomes, in order:
 *  - `asked` wins. One currency, no conversion.
 *  - one currency present. That one, no conversion.
 *  - several present, and the organization has a base currency + rates: CONVERT and sum,
 *    naming every currency that had no rate. Without a base currency, refuse and name the
 *    options — a total that silently drops a currency is the dishonesty this layer removes.
 *
 * A count is never converted: a subscription has exactly one currency, so counting across
 * currencies counts each subscription once.
 */
export interface CurrencyChoice {
  currency: string | null;
  basis: "per_currency" | "across_currencies" | "converted";
  /** `1 base = rate x other`, so an amount in `other` becomes `amount / rate`. Null = no conversion. */
  rates: Record<string, number> | null;
  /** Currencies excluded from the total for want of a rate. Named, never silently dropped. */
  missingRates: string[];
}

function chooseCurrency(
  m: MeasureDef,
  asked: string | undefined,
  present: string[],
  base: {
    currency: string | null;
    rates: Record<string, number> | null;
    /** Whose currency to ask for when there is none — the business, or the whole account. */
    owner: "business" | "organization";
  },
): CurrencyChoice {
  const none = { rates: null, missingRates: [] as string[] };
  if (asked) {
    const want = asked.toUpperCase();
    if (present.length > 0 && !present.includes(want)) {
      throw new MeasureRefused(
        `${m.name} has nothing recorded in ${want} for that window. It has ${present.join(", ")}.`,
      );
    }
    return { currency: want, basis: "per_currency", ...none };
  }
  // Counts, and rates of counts, combine across currencies as they are. Anything built from
  // money — a rate of money included — converts, or its halves weigh raw minor units.
  if (!hasMoneyHalves(m)) return { currency: null, basis: "across_currencies", ...none };
  if (present.length <= 1) {
    return { currency: present[0] ?? null, basis: "per_currency", ...none };
  }

  const baseCcy = base.currency?.toUpperCase() ?? null;
  if (baseCcy) {
    const rates = base.rates ?? {};
    // The base currency itself converts at 1 and needs no rate on file.
    const missing = present.filter((c) => {
      const r = rates[c];
      return c !== baseCcy && (r == null || !(r > 0));
    });
    if (missing.length < present.length) {
      return { currency: baseCcy, basis: "converted", rates, missingRates: missing };
    }
    // Every currency present is unconvertible: a converted total would be empty, which reads
    // as zero revenue. Refuse and say which rates are missing.
    throw new MeasureRefused(
      `${m.name} cannot be converted to ${baseCcy}: no rate is set for ${missing.join(", ")}. Set one, or ask for a single currency.`,
      { param: "currency", options: present },
    );
  }

  throw new MeasureRefused(
    `${m.name} is money held per currency and is never summed across them. Set a ${
      base.owner === "business"
        ? "default currency for the business"
        : "base currency for the organization"
    }, or ask for one of: ${present.join(", ")}.`,
    { param: "currency", options: present },
  );
}

/**
 * Sum the cells that belong to the chosen currency, per period — converting into it when the
 * account has a base currency and a rate.
 *
 * ⚠️ Converted PER CELL, then summed, and rounded once per cell. That is the convention the
 * stored rows already use and the one the FX decision of 2026-09-20 settled; converting a
 * total instead would give a figure a few minor units apart from every other screen.
 *
 * A currency with no rate is SKIPPED, never zeroed and never guessed at — the caller reports
 * it in `missing_rates` so the total says what it left out.
 */
function collapse(
  m: MeasureDef,
  cells: readonly SeriesCell[],
  currency: string | null,
  convert?: { rates: Record<string, number>; base: string },
): Map<string, { value: bigint | null; denominator: bigint | null }> {
  /**
   * ⚠️ A COUNT DENOMINATOR IS NEVER CONVERTED. Both halves of a money ratio must cross into
   * the reporting currency together, at the same rate and the same instant, or the quotient
   * is two currencies deep. But subscriptions and customers are not money: dividing a head
   * count by an exchange rate would inflate the average revenue per head by that rate.
   */
  const convertDenominator = denominatorIsMoney(m);
  const out = new Map<string, { value: bigint | null; denominator: bigint | null }>();
  for (const raw of cells) {
    let c = raw;
    if (convert) {
      if (raw.currency !== convert.base) {
        const rate = convert.rates[raw.currency];
        if (rate == null || !(rate > 0)) continue;
        // `1 base = rate x other`, so an amount in `other` becomes `amount / rate` — the same
        // reading `businesses.exchange_rates` has always had.
        c = {
          ...raw,
          currency: convert.base,
          value: raw.value == null ? null : BigInt(Math.round(Number(raw.value) / rate)),
          denominator:
            raw.denominator == null || !convertDenominator
              ? raw.denominator
              : BigInt(Math.round(Number(raw.denominator) / rate)),
        };
      }
    } else if (currency != null && raw.currency !== currency) continue;
    const cur = out.get(c.t);
    if (!cur) {
      out.set(c.t, { value: c.value, denominator: c.denominator });
      continue;
    }
    if (c.value != null) cur.value = (cur.value ?? 0n) + c.value;
    if (c.denominator != null) cur.denominator = (cur.denominator ?? 0n) + c.denominator;
  }
  return out;
}

/**
 * The window's two halves, folded from the periods already folded — by the measure's own
 * rule, so the window is the window's arithmetic and not an average of its buckets.
 *
 * The composite numerator is recovered rather than re-added: a period's stored numerator is
 * already `its opening + what happened to it`, so the window's is the FIRST period's opening
 * plus every period's own movement, `numerator − denominator`. Summing the periods' numerators
 * instead would add the opening stock once per bucket.
 */
function windowHalves(
  m: MeasureDef,
  points: readonly SeriesPoint[],
): { value: number | null; denominator: number | null } {
  const fold = m.ratio!;
  let firstDenominator: number | null = null;
  let seenDenominator = false;
  let last: SeriesPoint | null = null;
  let sumValue = 0;
  let sumDenominator = 0;
  let movement = 0;
  let sawValue = false;
  for (const p of points) {
    const n = p.numerator ?? null;
    const d = p.denominator ?? null;
    if (d != null) {
      if (!seenDenominator) {
        firstDenominator = d;
        seenDenominator = true;
      }
      sumDenominator += d;
      last = p;
    }
    if (n != null) {
      sawValue = true;
      sumValue += n;
      movement += n - (d ?? 0);
      last = p;
    }
  }
  const denominator =
    fold.denominator === "sum"
      ? seenDenominator
        ? sumDenominator
        : null
      : fold.denominator === "last"
        ? (last?.denominator ?? null)
        : firstDenominator;
  if (fold.numerator === "last") return { value: last?.numerator ?? null, denominator };
  if (!sawValue) return { value: null, denominator };
  const value = fold.numerator === "sum" ? sumValue : (firstDenominator ?? 0) + movement;
  return { value, denominator };
}

/** A flow's window total is the sum of its buckets; a stock's is the value at the end. */
function windowTotal(m: MeasureDef, points: SeriesPoint[]): number | null {
  /**
   * A DISTINCT COUNT HAS NO WINDOW TOTAL UNLESS THE WINDOW IS ONE BUCKET.
   *
   * Summing twelve months of "customers who moved" counts every returning account once per
   * month it came back in, and the answer looks entirely plausible. There is no arithmetic
   * that recovers the window's own figure from its buckets, so we say null and let
   * `coverage` explain, rather than publishing a number nobody can reproduce. A caller that
   * wants the window asks for it as one period, at a grain we stored.
   */
  if (m.aggregate === "none") return points.length === 1 ? (points[0]!.value ?? null) : null;
  if (m.aggregate === "ratio") {
    const h = windowHalves(m, points);
    return ratioValue(m, h.value, h.denominator);
  }
  if (m.kind === "stock") {
    for (let i = points.length - 1; i >= 0; i--) {
      const v = points[i]!.value;
      if (v != null) return v;
    }
    return null;
  }
  let sum = 0;
  let seen = false;
  for (const p of points) {
    if (p.value == null) continue;
    sum += p.value;
    seen = true;
  }
  return seen ? sum : null;
}

export async function resolveAnalytics(
  scope: AnalyticsScope,
  req: AnalyticsRequest,
  now: Date = new Date(),
): Promise<AnalyticsResult> {
  const m = measureById(req.measure);
  if (!m) {
    throw new MeasureRefused(
      `There is no measure called "${req.measure}". Ask GET /v1/analytics/measures for the list.`,
    );
  }
  const grain = (req.grain ?? "month") as Grain;
  if (!(GRAINS as readonly string[]).includes(grain)) {
    throw new MeasureRefused(
      `There is no grain called "${req.grain}". Grains are ${GRAINS.join(", ")}.`,
    );
  }
  if (!m.grains.includes(grain)) {
    throw new MeasureRefused(
      `${m.name} cannot be shown by ${grain}. It supports ${m.grains.join(", ")}.`,
    );
  }
  if (req.split && !(m.dimensions as readonly string[]).includes(req.split)) {
    throw new MeasureRefused(
      `${m.name} cannot be split by ${req.split}. It can be split by ${m.dimensions.join(", ") || "nothing"}.`,
    );
  }
  const splitLimit = req.splitLimit ?? DEFAULT_SPLIT_LIMIT;
  if (!Number.isInteger(splitLimit) || splitLimit < 1 || splitLimit > MAX_SPLIT_LIMIT) {
    throw new MeasureRefused(
      `split_limit must be a whole number between 1 and ${MAX_SPLIT_LIMIT}.`,
    );
  }
  const shape = (req.shape ?? "series") as AnswerShape;
  if (!ANSWER_SHAPES.includes(shape)) {
    throw new MeasureRefused(
      `There is no shape called "${req.shape}". Shapes are ${ANSWER_SHAPES.join(", ")}.`,
      {
        param: "shape",
        options: [...ANSWER_SHAPES],
      },
    );
  }
  if (req.compare != null && req.compare !== "previous") {
    throw new MeasureRefused("The only comparison is `compare=previous`.");
  }
  if (req.compare === "previous" && !m.supportsCompare) {
    throw new MeasureRefused(`${m.name} has no comparable previous window.`);
  }

  /**
   * The last day every business has reached (`scopeToday`). A named window ends on it, and an
   * organization reads no day row past it, so the stock at the end and the previous window's
   * stock are both every business on the same local date. A period past it is unknown.
   */
  const today = scopeToday(scope, now);
  const through = scope.scope === "organization" ? today : undefined;
  const window = resolveWindow({
    range: req.range,
    start: req.start,
    end: req.end,
    timezone: scope.timezone,
    timezoneSource: scope.timezoneSource,
    calendar: scope.calendar,
    today,
  });
  const periods = buildPeriods(grain, window.start, window.end, scope.calendar);

  // A segment is answered from the ledger at read time; see `segment-series.ts`.
  let population: SegmentPopulation | null = null;
  let segmentInfo: AnalyticsResult["segment"];
  if (req.segment) {
    const why = segmentRefusal(m, req.split, scope.businessIds.length);
    if (why) throw new MeasureRefused(why, { param: "segment", options: [...SEGMENT_MEASURES] });
    try {
      const p = await segmentPopulation(scope.organizationId, scope.businessIds[0]!, req.segment);
      population = {
        businessId: scope.businessIds[0]!,
        filters: p.filters,
        customFieldDefs: p.customFieldDefs,
      };
      segmentInfo = {
        id: p.segment.publicId,
        name: p.segment.name,
        membership: "current",
        note:
          "Membership is judged as the segment stands today and applied to all of history, so a " +
          "customer who has since left it is absent from its past.",
      };
    } catch (e) {
      if (e instanceof SegmentError)
        throw new MeasureRefused(e.message, { param: "segment", options: [] });
      throw e;
    }
  }
  const readLive = (
    ps: readonly SeriesPeriod[],
    split?: string,
    convert?: Parameters<typeof readMetricSeries>[0]["convert"],
  ) =>
    population
      ? readSegmentSeries({
          organizationId: scope.organizationId,
          population,
          measure: m,
          grain,
          periods: ps,
        })
      : readMetricSeries({
          organizationId: scope.organizationId,
          businessIds: scope.businessIds,
          measure: m.id,
          grain,
          periods: ps,
          calendar: scope.calendar,
          ...(through ? { through } : {}),
          ...(split ? { split } : {}),
          ...(convert ? { convert } : {}),
        });

  /**
   * One business, no segment: periods that ended before YESTERDAY come from `series-cache`;
   * the rest is read live — today is rewritten every 5 minutes and the nightly close
   * restates yesterday. `ratesKey` names the conversion: the same periods converted another
   * way are a different answer.
   */
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const readPeriods = async (
    ps: readonly SeriesPeriod[],
    split?: string,
    convert?: Parameters<typeof readMetricSeries>[0]["convert"],
    ratesKey = "",
  ): Promise<MetricSeriesResult> => {
    const closed = ps.filter((p) => p.end < yesterday);
    if (
      !seriesCacheEnabled() ||
      population ||
      scope.businessIds.length !== 1 ||
      closed.length === 0
    )
      return readLive(ps, split, convert);
    const open = ps.filter((p) => p.end >= yesterday);
    const key = [
      scope.businessIds[0],
      m.id,
      grain,
      split ?? "",
      convert ? `${convert.base}:${ratesKey}` : "",
      window.timezone,
      closed.map((p) => `${p.start}~${p.end}`).join(","),
    ].join("|");
    const [past, live] = await Promise.all([
      // A gap is not cached: the writer may fill it on the next pass.
      cachedSeries(
        key,
        () => readLive(closed, split, convert),
        (r) => r.missing.length === 0,
      ),
      open.length > 0 ? readLive(open, split, convert) : null,
    ]);
    if (!live) return past;
    const at = [past.computedAt, live.computedAt].filter((d): d is Date => d != null);
    return {
      ...live,
      cells: [...past.cells, ...live.cells],
      ...(split ? { slices: [...(past.slices ?? []), ...(live.slices ?? [])] } : {}),
      computedAt: at.length ? new Date(Math.min(...at.map((d) => d.getTime()))) : null,
      missing: [...past.missing, ...live.missing],
    };
  };

  let read = await readPeriods(periods, req.split);

  /**
   * A movement is a change IN the MRR book, so it is stated in the book's currency: an
   * INR-only churn on a USD+INR book converts, or the waterfall adds paise to cents. FX
   * impact stores nothing and takes the book's currencies alone.
   */
  const fxImpact = m.id === FX_IMPACT_MEASURE;
  const bookScoped = (fxImpact || m.source === "movements") && !population;
  const present = [
    ...new Set([
      ...(fxImpact ? [] : read.cells.map((c) => c.currency)),
      ...(bookScoped
        ? await fxBookCurrencies({
            organizationId: scope.organizationId,
            businessIds: scope.businessIds,
            grain,
            periods,
            ...(through ? { through } : {}),
          })
        : []),
    ]),
  ]
    .filter((c) => c !== "XXX")
    .sort();
  const choice = chooseCurrency(m, req.currency, present, {
    currency: scope.baseCurrency,
    rates: scope.exchangeRates,
    owner: scope.scope,
  });
  const { currency, basis } = choice;

  // Resolved ONCE and shared by the headline and the split: a split converted at its own
  // rates, or not at all, would not add up to the headline it sits under.
  const convert =
    choice.basis === "converted" && currency
      ? { rates: choice.rates ?? {}, base: currency }
      : undefined;
  /**
   * One business converts each DAY at the rate it held that day (`exchange_rate_history`),
   * so a past month reads at that month's rates and its flows sum day by day. The read is
   * repeated with the converter, because which currency to convert into depends on what the
   * first read found. Organization scope has no rate history and keeps today's rates.
   */
  const dayConvert =
    convert && scope.scope === "business" && scope.businessIds.length === 1 && !population
      ? await (async () => {
          const cacheKey = `${convert.base}|${JSON.stringify(convert.rates)}`;
          scope.rateTimelines ??= new Map();
          let pending = scope.rateTimelines.get(cacheKey);
          if (!pending) {
            pending = withTenant(scope.organizationId, (tx) =>
              loadRateTimeline(tx, scope.businessIds[0]!, {
                base: convert.base,
                currentRates: convert.rates,
              }),
            );
            // A failed load must not poison the scope for the questions after it.
            pending.catch(() => scope.rateTimelines?.delete(cacheKey));
            scope.rateTimelines.set(cacheKey, pending);
          }
          const timeline = await pending;
          return {
            base: convert.base,
            toBase: (minor: bigint, ccy: string, day: string): bigint | null => {
              const at = new Date(zonedDayEndExclusive(day, window.timezone).getTime() - 1);
              const rate = Number(timeline.rateAt(ccy, at));
              return Number.isFinite(rate) && rate > 0
                ? BigInt(Math.round(Number(minor) / rate))
                : null;
            },
          };
        })()
      : undefined;
  if (dayConvert && !fxImpact)
    read = await readPeriods(periods, req.split, dayConvert, JSON.stringify(convert!.rates));
  if (fxImpact)
    read = await readFxImpact({
      organizationId: scope.organizationId,
      businessIds: scope.businessIds,
      grain,
      periods,
      currency,
      ...(through ? { through } : {}),
      ...(convert ? { convert: { ...convert, ...(dayConvert ? { dayConvert } : {}) } } : {}),
    });
  const totals = collapse(m, read.cells, currency, convert);
  const series: SeriesPoint[] = periods.map((p) => {
    const cell = totals.get(p.end);
    return {
      t: p.end,
      label: p.label,
      // A ratio is DIVIDED here — the one place — and its halves ride along beside it.
      // `ratioValue` divides when — and only when — the row carries a denominator, so a
      // churn rate reads as a rate even though it is not a foldable ratio.
      value: ratioValue(m, cell?.value ?? null, cell?.denominator ?? null),
      ...(cell?.denominator != null
        ? {
            numerator: num(cell?.value ?? null),
            denominator: num(cell?.denominator ?? null),
          }
        : {}),
    };
  });

  const fresh = freshnessFor({
    computedAt: read.computedAt,
    to: window.end,
    today,
    missing: read.missing,
  });

  const result: AnalyticsResult = {
    object: "analytics_result",
    measure: m.id,
    name: m.name,
    description: m.description,
    kind: m.kind,
    unit: m.unit,
    aggregate: m.aggregate,
    currency,
    currency_basis: basis,
    // Published so a converted figure can be reproduced and audited: which rates were used,
    // and what was left out for want of one. A total that cannot be re-derived is a total
    // nobody can defend.
    ...(choice.rates ? { rates: choice.rates } : {}),
    ...(choice.missingRates.length > 0 ? { missing_rates: choice.missingRates } : {}),
    scope: scope.scope,
    business: scope.businessPublicId,
    grain,
    range: {
      name: window.name,
      start: window.start,
      end: window.end,
      timezone: window.timezone,
      timezone_source: window.timezoneSource,
    },
    as_of: now.toISOString(),
    computed_at: read.computedAt?.toISOString() ?? null,
    shape,
    ...(segmentInfo ? { segment: segmentInfo } : {}),
    series,
    total: windowTotal(m, series),
    total_basis: m.kind === "stock" ? "value_at_end" : "sum_over_window",
    freshness: {
      includes_current_period: fresh.includesCurrentPeriod,
      max_age_seconds: fresh.maxAgeSeconds,
    },
  };

  /**
   * A distinct count or cohort rate has no total over several buckets — its window is not
   * the sum of them. Unless the window is one stored period, read (or compute) the window
   * itself, and fold its currencies by the same rules as every other figure.
   */
  if (m.aggregate === "none" && !population && series.length !== 1) {
    const rows = await windowRows({
      organizationId: scope.organizationId,
      businessIds: scope.businessIds,
      start: window.start,
      end: window.end,
      timezone: window.timezone,
      now,
      ...(window.name ? { windowName: window.name } : {}),
    });
    const cells = rows
      .filter((r) => r.dim === "" && r.measure === m.id)
      .map((r) => ({
        t: window.end,
        currency: r.currency,
        value: r.value,
        denominator: r.denominator,
      }));
    // The currency was chosen from the series' rows. A window can hold a currency the series
    // never saw (several businesses, or a window stored before the month rows), and collapsing
    // with no conversion would then add one currency's minor units to another's. Choose again
    // over the window's own currencies whenever it holds one the series did not.
    const windowCcys = [...new Set(cells.map((c) => c.currency))].filter((c) => c !== "XXX");
    let wCurrency = currency;
    let wConvert = convert;
    if (windowCcys.some((c) => !present.includes(c))) {
      const ccys = [...new Set([...present, ...windowCcys])].sort();
      const again = chooseCurrency(m, req.currency, ccys, {
        currency: scope.baseCurrency,
        rates: scope.exchangeRates,
        owner: scope.scope,
      });
      wCurrency = again.currency;
      wConvert =
        again.basis === "converted" && again.currency
          ? { rates: again.rates ?? {}, base: again.currency }
          : undefined;
      result.currency = again.currency;
      result.currency_basis = again.basis;
      if (again.rates) result.rates = again.rates;
      if (again.missingRates.length > 0) result.missing_rates = again.missingRates;
    }
    if (cells.length > 0) {
      const cell = collapse(m, cells, wCurrency, wConvert).get(window.end);
      result.total = ratioValue(m, cell?.value ?? null, cell?.denominator ?? null);
      result.total_basis = "window";
      if (cell?.denominator != null) {
        result.total_numerator = cell.value == null ? null : Number(cell.value);
        result.total_denominator = Number(cell.denominator);
      }
    }
  }

  if (req.split && read.slices) {
    result.split = buildSplit(
      m,
      req.split,
      scope,
      read.slices,
      periods,
      currency,
      splitLimit,
      series,
      convert,
    );
    await nameSplitRows(result.split, req.split, scope);
  }

  if (req.compare === "previous") {
    const prev = previousWindow(window);
    const prevPeriods = buildPeriods(grain, prev.start, prev.end, scope.calendar);
    const prevRead = await readPeriods(
      prevPeriods,
      undefined,
      dayConvert,
      convert ? JSON.stringify(convert.rates) : "",
    );
    // Converted like the current window: without `convert` a converted answer's comparison
    // kept only the base currency's cells.
    const prevTotals = collapse(m, prevRead.cells, currency, convert);
    const prevSeries: SeriesPoint[] = prevPeriods.map((p) => {
      const cell = prevTotals.get(p.end);
      return {
        t: p.end,
        label: p.label,
        value: ratioValue(m, cell?.value ?? null, cell?.denominator ?? null),
        ...(cell?.denominator != null
          ? { numerator: num(cell?.value ?? null), denominator: num(cell?.denominator ?? null) }
          : {}),
      };
    });
    const previousTotal = windowTotal(m, prevSeries);
    const current = result.total;
    result.compare = {
      basis: "previous_window",
      start: prev.start,
      end: prev.end,
      previous_total: previousTotal,
      change_minor: current == null || previousTotal == null ? null : current - previousTotal,
      change_bps:
        current == null || previousTotal == null || previousTotal === 0
          ? null
          : Math.round(((current - previousTotal) / Math.abs(previousTotal)) * 10_000),
    };
  }

  /**
   * Where history is only partly known, SAY SO. A partner that plots a gap as zero publishes
   * a retention curve that flatters us, and nothing in the numbers themselves reveals it.
   */
  if (read.missing.length > 0) {
    const covered = periods.filter((p) => !read.missing.includes(p.end));
    const firstComplete = (() => {
      for (let i = periods.length - 1; i >= 0; i--) {
        if (read.missing.includes(periods[i]!.end)) return periods[i + 1]?.end ?? null;
      }
      return covered[0]?.end ?? null;
    })();
    result.coverage = {
      complete_from: firstComplete,
      missing_periods: read.missing,
      // A totals answer plots nothing, so it is told what the gap does to the TOTAL.
      note:
        shape === "totals"
          ? `${read.missing.length} of ${periods.length} ${grain} periods have no stored figure, so this total covers only part of the window. ` +
            "A missing period is unknown, not zero."
          : `${read.missing.length} of ${periods.length} ${grain} periods have no stored figure, so this series is partial. ` +
            "A period listed here is unknown, not zero. Do not plot it as zero or include it in an average.",
    };
  }

  // Last, so every total above was folded from the full series first.
  if (shape === "totals") {
    result.series = [];
    for (const row of result.split?.series ?? []) row.points = [];
  }

  return result;
}

/**
 * Turn a split's stored keys into something a person can read.
 *
 * `dim_value` holds whatever the writer had — for `plan` that is a product ROW id, which is
 * correct to store and useless to look at. Only the kept rows are resolved (at most
 * `split_limit`), so this is one small query, not a join on the fact table.
 *
 * A key that cannot be resolved keeps its raw value rather than being dropped or blanked:
 * an id on screen is a bug report, a missing row is a silent hole.
 */
async function nameSplitRows(
  split: NonNullable<AnalyticsResult["split"]>,
  dimension: string,
  scope: AnalyticsScope,
): Promise<void> {
  // Residual rows are named by `buildSplit` and must keep that name: a row saying "3 more"
  // when the truth is "revenue with no plan" is the lie this whole payload exists to stop.
  const dimensionRows = split.series.filter((r) => r.kind === "dimension");

  // The writer groups charges-only subscriptions under "none" so the slices still sum to
  // the total. It is a real bucket, not a missing value, and it is named as one.
  for (const row of dimensionRows) {
    if (row.key === "none") {
      row.label =
        dimension === "plan" || dimension === "plan_at_start"
          ? "No plan"
          : dimension === "product"
            ? "No product"
            : dimension === "meter"
              ? "No meter"
              : "Not set";
    }
  }

  // Dimensions whose values are a closed set of KEYS: the key is the contract an integrator
  // filters on, the label is the sentence a screen prints, and they are kept apart so
  // rewording one cannot break the other.
  const CLOSED_SET_LABELS: Record<string, Record<string, string>> = {
    lateness_band: {
      on_time: "Paid on time",
      "1_30": "1–30 days late",
      "31_60": "31–60 days late",
      "60_plus": "60+ days late",
    },
    dunning_status: {
      in_progress: "In progress",
      parked: "Parked",
      succeeded: "Recovered",
      exhausted: "Exhausted",
      stopped: "Stopped",
    },
    transaction_status: {
      succeeded: "Succeeded",
      failed: "Failed",
      in_progress: "In progress",
      voided: "Voided",
      timeout: "Timed out",
      needs_attention: "Needs attention",
      late_failed: "Failed late",
    },
    /**
     * How far off a booked change is, from the instant the figure was computed. Six
     * disjoint bands that partition the forward book — `overdue` has a date that has passed
     * and nothing has applied it yet, `undated` has no date on file at all. Neither is
     * "later", and folding either into a rung would put a number in a window it is not in.
     */
    horizon: {
      overdue: "Already due",
      "1_30": "Within 30 days",
      "31_60": "31–60 days",
      "61_90": "61–90 days",
      "90_plus": "Beyond 90 days",
      undated: "No date on file",
    },
    cash_bucket: {
      recurring: "Subscription fees",
      proration: "Prorated changes",
      usage: "Metered usage",
      one_time: "One-off charges",
      discount: "Discounts",
      tax: "Tax",
      rounding: "Rounding",
      other: "Other",
      unattributed: "Not attributable to a line",
    },
    churn_kind: { involuntary: "Involuntary", voluntary: "Voluntary" },
    credit_category: { paid: "Paid", promotional: "Promotional" },
    credit_source: {
      purchase: "Bought",
      plan_cycle: "Plan credits",
      manual: "Granted by hand",
      restore: "Given back",
      auto_top_up: "Automatic top-up",
    },
    credit_unit: { money: "Money" },
    revenue_type: {
      recurring: "Subscriptions",
      usage: "Usage",
      one_time: "One-time sales",
      credit_pack: "Credit packs",
    },
    // An open set: a gateway not named here shows its own key.
    gateway: {
      stripe: "Stripe",
      razorpay: "Razorpay",
      paypal: "PayPal",
      offline: "Offline",
      imported: "Imported",
      tmtest: "Test gateway",
      none: "No gateway",
    },
    billing_interval: BILLING_INTERVAL_LABELS,
    region: REGION_LABELS,
  };
  // The column holds raw provider spellings (`BAD_REQUEST_ERROR`) beside our own codes; read
  // each through the decline vocabulary so one refusal is one sentence whatever the rail said.
  if (dimension === "failure_reason") {
    for (const row of dimensionRows) row.label = failureReasonLabel(row.key);
    return;
  }
  const labels = CLOSED_SET_LABELS[dimension];
  if (labels) {
    for (const row of dimensionRows) row.label = labels[row.key] ?? row.key;
    return;
  }

  // `YYYY-MM` → "Sep 2026". The key stays the month; only the label is prose.
  if (dimension === "signup_cohort") {
    for (const row of dimensionRows) {
      if (!/^\d{4}-\d{2}$/.test(row.key)) continue;
      const d = new Date(`${row.key}-01T00:00:00Z`);
      row.label = d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    }
    return;
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (dimension === "meter") {
    const ids = dimensionRows.map((r) => r.key).filter((k) => UUID.test(k));
    if (ids.length === 0) return;
    const named = await withTenant(scope.organizationId, (tx) =>
      tx.select({ id: meters.id, name: meters.name }).from(meters).where(inArray(meters.id, ids)),
    );
    const names = new Map(named.map((r) => [r.id, r.name]));
    for (const row of dimensionRows) row.label = names.get(row.key) ?? row.label;
    return;
  }

  if (dimension !== "plan" && dimension !== "plan_at_start" && dimension !== "product") return;

  // Only uuid-shaped keys reach the query. The writer stores a product row id here, but the
  // column is `uuid` and Postgres rejects the whole statement on the first value that is not
  // one — so a key from any other source takes the answer down with it rather than simply
  // going unnamed.
  const ids = dimensionRows
    .map((r) => r.key)
    .filter((k) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k));
  if (ids.length === 0) return;

  const rows = await withTenant(scope.organizationId, (tx) =>
    tx
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(inArray(products.id, ids)),
  );
  const names = new Map(rows.map((r) => [r.id, r.name]));
  for (const row of dimensionRows) {
    const name = names.get(row.key);
    if (name) row.label = name;
  }
}

/**
 * The split, bounded by construction and honest about what it does not cover.
 *
 * A split can fall short of its headline for two unrelated reasons, and they get two rows:
 *
 *  - `split_limit` dropped rows. Those rows exist and were read; they are added up into
 *    `other`, which is therefore measured data.
 *  - the dimension does not describe the whole population. That part is the STORED total
 *    minus every dimension row — a remainder, never a measurement, and it can legitimately be
 *    negative for a measure with signed movement. It is never clamped.
 *
 * Both are computed PER PERIOD, where the arithmetic is sound, and folded by the measure's own
 * rule. `exhaustive` then states whether the returned row totals actually add to `total`,
 * rather than assuming they do.
 *
 * A converted answer converts the slices too, with the headline's own rates — a slice held in
 * another currency is attributed money, not a residual. A currency with no rate is still
 * dropped and still named in `missing_rates`.
 */
function buildSplit(
  m: MeasureDef,
  dimension: string,
  scope: AnalyticsScope,
  slices: ReadonlyArray<SeriesCell & { dimValue: string }>,
  periods: readonly SeriesPeriod[],
  currency: string | null,
  limit: number,
  totalSeries: readonly SeriesPoint[],
  convert?: { rates: Record<string, number>; base: string },
): NonNullable<AnalyticsResult["split"]> {
  const byKey = new Map<string, SeriesCell[]>();
  for (const s of slices) {
    const arr = byKey.get(s.dimValue) ?? [];
    arr.push(s);
    byKey.set(s.dimValue, arr);
  }

  const built = [...byKey.entries()].map(([key, cells]) => {
    const collapsed = collapse(m, cells, currency, convert);
    const points: SeriesPoint[] = periods.map((p) => {
      const cell = collapsed.get(p.end);
      return {
        t: p.end,
        label: p.label,
        value: ratioValue(m, cell?.value ?? null, cell?.denominator ?? null),
        ...(cell?.denominator != null
          ? { numerator: num(cell?.value ?? null), denominator: num(cell?.denominator ?? null) }
          : {}),
      };
    });
    return { key, points, total: windowTotal(m, points) };
  });

  // Deterministic order: biggest first by magnitude, ties broken by key so two identical
  // answers cannot come back in a different order.
  built.sort(
    (a, b) => Math.abs(b.total ?? 0) - Math.abs(a.total ?? 0) || a.key.localeCompare(b.key),
  );

  const kept = built.slice(0, limit);
  const dropped = built.slice(limit);
  const truncated = dropped.length > 0;

  const label = (key: string) =>
    dimension === "business" ? (scope.businessNames.get(key)?.name ?? key) : key;
  const publicKey = (key: string) =>
    dimension === "business" ? (scope.businessNames.get(key)?.publicId ?? key) : key;

  const rows: SplitRow[] = kept.map((r) => ({
    key: publicKey(r.key),
    label: label(r.key),
    kind: "dimension" as const,
    total: r.total,
    points: r.points,
  }));

  /**
   * A RESIDUAL RATE IS NOT A RATE, AND A DISTINCT COUNT DOES NOT SUBTRACT. A remainder is an
   * identity for a sum and for a stock read at one instant, and arithmetic nonsense for a
   * quotient or a count of distinct things — so those splits get no residual row at all and
   * say so through `exhaustive` instead.
   */
  const decomposable = m.aggregate === "sum" || m.aggregate === "last";

  if (decomposable && truncated) {
    const points = periods.map((p, i) => ({
      t: p.end,
      label: p.label,
      value: dropped.reduce((sum, r) => sum + (r.points[i]?.value ?? 0), 0),
    }));
    rows.push({
      key: "other",
      label: `Other (${dropped.length} more)`,
      kind: "truncated",
      total: windowTotal(m, points),
      points,
    });
  }

  if (decomposable) {
    const points: SeriesPoint[] = periods.map((p, i) => {
      const total = totalSeries[i]?.value ?? null;
      // Null is not zero: a period with no stored total has an unknown remainder, not a
      // remainder of nothing.
      if (total == null) return { t: p.end, label: p.label, value: null };
      const attributed = built.reduce((sum, r) => sum + (r.points[i]?.value ?? 0), 0);
      return { t: p.end, label: p.label, value: total - attributed };
    });
    // Emit whenever the dimension leaves anything unexplained — not only when rows were
    // dropped. Negative is allowed: for a signed movement it is the true remainder.
    if (points.some((p) => p.value != null && p.value !== 0)) {
      rows.push({
        key: "unattributed",
        label: `Not attributed to a ${dimension.replace(/_/g, " ")}`,
        kind: "unattributed",
        total: windowTotal(m, points),
        points,
      });
    }
  }

  const { exhaustive, basis, note } = exhaustiveness(m, rows, totalSeries, dimension);

  return {
    dimension,
    limit,
    returned: rows.length,
    truncated,
    exhaustive,
    exhaustive_basis: basis,
    note,
    series: rows,
  };
}

/**
 * Do the rows returned actually add up to the headline?
 *
 * ASKED, NOT ASSUMED. The per-period arithmetic is exact, but a `value_at_end` stock folds
 * each row to ITS OWN last stored value: a slice that ended mid-window contributes that value
 * to its row total and nothing to the window's closing figure, so the row totals can exceed
 * the headline with every row correct. We do not doctor a residual to hide that — the split
 * declares itself non-exhaustive and names why.
 */
function exhaustiveness(
  m: MeasureDef,
  rows: readonly SplitRow[],
  totalSeries: readonly SeriesPoint[],
  dimension: string,
): { exhaustive: boolean; basis: SplitExhaustiveBasis; note: string } {
  if (m.aggregate === "ratio") {
    return {
      exhaustive: false,
      basis: "rate_not_decomposable",
      note:
        `These rows are each ${m.name} for one ${dimension}. A rate has no remainder, so the ` +
        "rows carry no residual and their sum is not the headline. Do not subtract them from it.",
    };
  }
  if (m.aggregate === "none") {
    return {
      exhaustive: false,
      basis: "distinct_count_not_additive",
      note:
        "These rows count distinct things, which do not add: the same one can appear under " +
        "more than one row. The rows do not sum to the headline and no residual exists.",
    };
  }

  const total = windowTotal(m, [...totalSeries]);
  const summed = rows.reduce((sum, r) => sum + (r.total ?? 0), 0);
  if (total != null && summed === total) {
    return {
      exhaustive: true,
      basis: "rows_add_to_total",
      note: "Every row, including any residual, adds back up to the headline.",
    };
  }
  return {
    exhaustive: false,
    basis: "row_totals_not_coincident",
    note:
      total == null
        ? "The window has no headline figure, so there is no total for these rows to match."
        : "Each row's total is read at its own last figure, which need not fall on the window's " +
          "last period, so the sum of the rows is not the headline. Compare them period by " +
          "period instead of summing the totals.",
  };
}

/**
 * The `cache-control` this answer may be served with. An answer with gaps is never cached —
 * a hole held for an hour is a wrong chart for an hour.
 */
export function cacheControlFor(result: AnalyticsResult): string {
  if (result.freshness.max_age_seconds === 0) return "private, no-store";
  return `private, max-age=${result.freshness.max_age_seconds}, must-revalidate`;
}

/** The whole space, as data — what an integrator reads instead of hard-coding a list. */
export function serialiseMeasure(m: MeasureDef) {
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    kind: m.kind,
    unit: m.unit,
    aggregate: m.aggregate,
    dimensions: m.dimensions,
    grains: m.grains,
    currency: m.currency,
    /**
     * Which instant the figure describes. `period_end` is the ordinary case — the period
     * decides the answer. `computed_at` says the number is the live book at the moment it
     * was written and has NO history: only the period in progress carries a figure, and an
     * earlier one comes back empty rather than zero. An integrator that misses this plots a
     * flat line at zero for a year of receivables.
     */
    value_as_of: m.asOf,
    supports_compare: m.supportsCompare,
    /** Whether `segment=` is accepted — the same list the engine refuses against. */
    segmentable: SEGMENT_MEASURES.includes(m.id),
  };
}

/**
 * Businesses named by public id, for the `business` query parameter.
 *
 * `livemode` rides along so the caller can refuse one outside its partition instead of
 * answering for it.
 */
export async function businessesByPublicIds(organizationId: string, publicIds: string[]) {
  return withTenant(organizationId, (tx) =>
    tx
      .select({
        id: businesses.id,
        publicId: businesses.publicId,
        name: businesses.name,
        timezone: businesses.timezone,
        livemode: businesses.livemode,
      })
      .from(businesses)
      .where(inArray(businesses.publicId, publicIds)),
  );
}
