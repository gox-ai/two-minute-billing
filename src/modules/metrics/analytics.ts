import { reportableCustomer } from "./reportable";
import { and, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { slowReadCache } from "@/platform/slow-cache";
import { loadActiveDiscounts, reportingMrrBySubscription } from "./mrr";
import {
  carried,
  NETS_TO_SOMETHING,
  NETTED_KEYS,
  nettedDelta,
  retentionRates,
} from "./mrr-movements";
import { resolveBusinessPlanProductIds } from "./plan-of";
import {
  committedMrrOf,
  earnedAt,
  ledgerSweep,
  attachLapses,
  loadLapses,
  loadLedgerRows,
} from "./snapshots";
import { loadRateTimeline } from "@/platform/fx/history";
import {
  MRR_STATUSES,
  committedAt,
  committedWindow,
  isActiveAt,
  liveAt,
  nonRenewingAt,
  startOf,
} from "./stocks";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import { loadStockReaderFromMetrics, type StockMeasure } from "./daily/stock-reader";
import {
  businesses,
  subscriptions,
  subscriptionItems,
  prices,
  products,
  invoices,
  transactions,
  creditNotes,
  customers,
  mrrMovements,
} from "@db/schema";

/**
 * Business Home analytics — the dashboard behind the business home page: headline
 * KPIs, a today/this-month revenue strip, twelve bucketed time-series, and the
 * subscriptions-by-plan breakdown.
 *
 * All of it is derived on read (no snapshot table): flow metrics bucket their
 * source rows by timestamp, stock metrics (MRR/CMRR/active) are reconstructed
 * from subscription lifecycle timestamps. See README § "Analytics" for the
 * definitions and their known limits.
 */

export type AnalyticsRange = "daily" | "3m" | "6m" | "12m";
export type Granularity = "day" | "week" | "month";

export const ANALYTICS_RANGES: AnalyticsRange[] = ["daily", "3m", "6m", "12m"];

/** Buckets per range + the granularity each one uses. */
export const RANGE_SHAPE: Record<AnalyticsRange, { granularity: Granularity; count: number }> = {
  daily: { granularity: "day", count: 60 },
  "3m": { granularity: "week", count: 13 },
  "6m": { granularity: "week", count: 26 },
  "12m": { granularity: "month", count: 12 },
};

/** Cancellations the *system* forced (dunning) — everything else is voluntary. */
const INVOLUNTARY_REASONS = new Set(["not_paid", "no_card"]);

/** Invoice statuses that represent billed revenue (excludes drafts + reversals). */
const BILLED_STATUSES = new Set(["posted", "payment_due", "not_paid", "paid"]);

/** Invoice statuses still owed money. */
const UNPAID_STATUSES = new Set(["posted", "payment_due", "not_paid"]);

/**
 * Statuses counted as "active" in the PLAN MIX below. The point-in-time counts use
 * `isActiveAt` from `stocks.ts`, which is the same set — this one stays because the mix
 * groups the book as it stands now rather than at an instant.
 *
 * ACTIVE + NON_RENEWING, with trials reported separately: we store non_renewing as
 * `active` + `cancel_at_period_end`, so `active` alone is exactly that set. Counting
 * `in_trial` here (until 2026-08-08) put the whole trial cohort into the headline —
 * 2,972 where the real figure was 2,551.
 */
const ACTIVE_STATUSES = new Set(["active"]);

export interface SeriesPointOut {
  /** Bucket start, ISO date (UTC) — `YYYY-MM-DD`. */
  t: string;
  /** Short bucket label, e.g. `Jun 7` / `Jun 2026`. */
  label: string;
  /** Money series → minor units. Count series → a count. Percent → basis points. */
  v: number;
}

export interface SeriesHeadline {
  kind: "money" | "count" | "percent";
  /** Current value: window total for flows, value-at-`as_of` for stocks. */
  value: number;
  /** Comparison value (a calendar month — see `prev_label`), or null. */
  prev_value: number | null;
  /** Short month label the comparison covers, e.g. `Jun`. */
  prev_label: string | null;
  /**
   * Change vs `prev_value` in basis points; null when there is no base.
   * OPTIONAL and only emitted by the payments read (`payments-analytics.ts`),
   * which shows a "+63.4% vs Previous Week" delta on every tile. The Business
   * Home read deliberately never sets it — its own deltas live on `kpis`, and
   * adding it here would change that response's shape.
   */
  change_bps?: number | null;
}

export interface AnalyticsSeries {
  key: string;
  label: string;
  /** Unit of the `points` values. */
  kind: "money" | "count" | "percent";
  /** True when the series projects forward from `as_of` instead of backward. */
  forward?: boolean;
  headline: SeriesHeadline;
  points: SeriesPointOut[];
}

export interface DeltaKpi {
  value: number;
  prev_value: number;
  /** Change vs `prev_value` in basis points; null when there is no base. */
  change_bps: number | null;
}

/** One plan's share of a window's MRR movement. Losses are positive magnitudes. */
export interface PlanMovementRow {
  plan: string;
  plan_id: string | null;
  new_mrr_minor: number;
  expansion_mrr_minor: number;
  reactivation_mrr_minor: number;
  contraction_mrr_minor: number;
  churn_mrr_minor: number;
  /** Signed: what this plan added to, or took from, MRR over the window. */
  net_mrr_minor: number;
}

export interface PlanRow {
  plan: string;
  /** Product public id, when the plan resolved to a catalog product. */
  plan_id: string | null;
  count: number;
  pct_bps: number;
}

export interface BusinessAnalytics {
  as_of: string;
  range: AnalyticsRange;
  granularity: Granularity;
  /** Currency all money figures are expressed in. */
  currency: string;
  /** True when multi-currency money was converted into `currency` via FX rates. */
  converted: boolean;
  /** Currencies this business holds money in (selector options). */
  available_currencies: string[];
  /** Currencies excluded from a converted roll-up for want of a rate. */
  missing_rates: string[];
  kpis: {
    mrr: DeltaKpi;
    cmrr: { value: number };
    active_subscriptions: DeltaKpi;
    /** Active subscriptions carrying MRR > 0 — the paying subset of the count above. */
    paying_subscriptions: DeltaKpi;
    renewing_subscriptions: DeltaKpi;
    /** Retention + MRR movement over the last complete calendar month. */
    retention: {
      /** The month these figures describe, e.g. "Aug". */
      window_label: string;
      starting_mrr_minor: number;
      new_mrr_minor: number;
      expansion_mrr_minor: number;
      reactivation_mrr_minor: number;
      /** Positive magnitudes — what was lost, stated as an amount. */
      contraction_mrr_minor: number;
      churn_mrr_minor: number;
      /** (start − contraction − churn) ÷ start, in bps. Null with no base. */
      gross_retention_bps: number | null;
      /** (start + expansion + reactivation − contraction − churn) ÷ start, in bps. */
      net_retention_bps: number | null;
      /** (new + expansion + reactivation) ÷ (contraction + churn), in bps. */
      quick_ratio_bps: number | null;
    };
    net_billing_minor: number;
    net_payments_minor: number;
    unpaid_invoices: { count: number; amount_minor: number };
    revenue_this_month: {
      expected_minor: number;
      received_minor: number;
      last_month_minor: number;
    };
    revenue_today: { expected_minor: number; received_minor: number; yesterday_minor: number };
    signups_this_month: { count: number; last_month: number };
    signups_today: { count: number; yesterday: number };
  };
  /**
   * The list filters that reproduce each strip window, as **local dates in the
   * business timezone** — `on` for a day, `after`/`before` for a month, matching
   * the operators `filterSql` implements for a `date` column.
   *
   * Emitted so the KPI figures can deep-link to the rows behind them without the
   * client redoing the timezone arithmetic: a browser computing "today" from its
   * OWN clock would send a different day than the figure was counted over, and
   * the list would open on a total that disagrees with the number just clicked.
   * These come from the same `calendarWindows` result the KPIs are summed over,
   * so the link and the figure cannot drift apart.
   */
  windows: {
    today: { on: string };
    yesterday: { on: string };
    this_month: { after: string; before: string };
    last_month: { after: string; before: string };
  };
  series: AnalyticsSeries[];
  subscriptions_by_plan: { total: number; rows: PlanRow[] };
  /** MRR movement over the retention window, broken down by the plan it happened on. */
  mrr_movement_by_plan: PlanMovementRow[];
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/**
 * A chart bucket. Exported with `buildBuckets` and `RANGE_SHAPE` because the report layer
 * (`reports/`) builds the same windows: a report whose buckets disagreed with the
 * dashboard's would be a second calendar, and the two would diverge on exactly the edges
 * nobody checks.
 */
export interface Bucket {
  t: string;
  label: string;
  /** Half-open window: `start <= x < end`. */
  start: Date;
  end: Date;
}

const DAY_MS = 24 * 3600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const utcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addMonths = (d: Date, n: number) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const monthName = (d: Date) => MONTHS[d.getUTCMonth()] ?? "";
function dayLabel(d: Date) {
  return `${monthName(d)} ${d.getUTCDate()}`;
}
function monthLabel(d: Date) {
  return `${monthName(d)} ${d.getUTCFullYear()}`;
}

/**
 * Build the chart buckets for a range. Backward series end with the bucket
 * containing `now`; forward series (CMRR) start with it and project ahead.
 * Day/week buckets are rolling (anchored on `now`), month buckets are calendar.
 */
export function buildBuckets(
  range: AnalyticsRange,
  now: Date,
  direction: "back" | "forward" = "back",
): Bucket[] {
  const { granularity, count } = RANGE_SHAPE[range];
  const out: Bucket[] = [];

  if (granularity === "month") {
    const anchor = utcMonth(now);
    for (let i = 0; i < count; i++) {
      const start =
        direction === "back" ? addMonths(anchor, -(count - 1 - i)) : addMonths(anchor, i);
      const end = addMonths(start, 1);
      out.push({ t: isoDate(start), label: monthLabel(start), start, end });
    }
    return out;
  }

  const span = granularity === "week" ? 7 * DAY_MS : DAY_MS;
  const anchor = utcDay(now);
  for (let i = 0; i < count; i++) {
    const offset = direction === "back" ? -(count - 1 - i) : i;
    const start = new Date(anchor.getTime() + offset * span);
    const end = new Date(start.getTime() + span);
    out.push({ t: isoDate(start), label: dayLabel(start), start, end });
  }
  return out;
}

const inWindow = (at: Date | null | undefined, w: { start: Date; end: Date }) =>
  at != null && at >= w.start && at < w.end;

/** Half-open window: `start <= t < end`. */
interface Span {
  start: Date;
  end: Date;
}

/** A day span, plus the local calendar date it covers (`YYYY-MM-DD`). */
interface DaySpan extends Span {
  date: string;
}

/** A month span, plus the short name (`Jun`) the series headlines label it with. */
interface MonthSpan extends Span {
  label: string;
  /** Local dates bounding the month, for `after`/`before` list filters. */
  after: string;
  before: string;
}

export interface CalendarWindows {
  today: DaySpan;
  yesterday: DaySpan;
  thisMonth: MonthSpan;
  lastMonth: MonthSpan;
  nextMonth: MonthSpan;
}

/**
 * The calendar windows the revenue/signup strip is cut on, and the month
 * boundaries the month-over-month KPI deltas compare across.
 *
 * Resolved in the **business timezone**, in Postgres, exactly as
 * `calendar-ranges.ts` resolves the payments-dashboard ranges — "today" is a
 * wall-clock day for the business that owns the money, not a UTC one.
 *
 * This used to be `utcDay`/`utcMonth` arithmetic in JS, which for any business
 * east or west of UTC labelled a slice of every day with the wrong date. On an
 * `Asia/Kolkata` book (UTC+5:30) the strip read, at 01:30 IST on 10-Aug:
 *
 *     signups_today { count: 78, yesterday: 0 }      ← all 78 were 9-Aug's
 *     revenue_today { received_minor: 2431791, … }   ← all of it was 9-Aug's
 *
 * — yesterday's numbers under "Today" and a zeroed "Yesterday", for the 5h30m
 * between local midnight and UTC midnight. The same skew put July's figures
 * under "Revenue this month" for the first 5h30m of 1-Aug. Postgres owns the
 * arithmetic so DST is its problem, not ours, and `+ interval '1 month'` on a
 * LOCAL timestamp keeps the wall clock across a transition.
 *
 * `previous.end === current.start` holds by construction for both pairs, so the
 * windows tile: no gap, no double-count.
 */
/**
 * Exported for the report layer: a `derived` report quotes its rates over the last complete
 * month, and that month has to be the SAME month the dashboard means. Cut in UTC instead,
 * the two disagreed by five and a half hours of movement on an Asia/Kolkata book — the
 * dashboard read a quick ratio of 5.67× while the report read 6.09×, from the same ledger.
 */
export async function calendarWindows(
  tx: Tx,
  timezone: string,
  now: Date,
): Promise<CalendarWindows> {
  const res = await tx.execute(sql`
    with local as (
      select (${now.toISOString()}::timestamptz at time zone ${timezone}) as t
    ),
    anchors as (
      select date_trunc('day', t) as d, date_trunc('month', t) as m from local
    )
    select (d at time zone ${timezone})                                  as today_start,
           ((d + interval '1 day') at time zone ${timezone})             as today_end,
           ((d - interval '1 day') at time zone ${timezone})             as yesterday_start,
           (m at time zone ${timezone})                                  as month_start,
           ((m + interval '1 month') at time zone ${timezone})           as month_end,
           ((m - interval '1 month') at time zone ${timezone})           as last_month_start,
           ((m + interval '2 month') at time zone ${timezone})           as next_month_end,
           to_char(m, 'Mon')                                             as this_label,
           to_char(m - interval '1 month', 'Mon')                        as last_label,
           to_char(m + interval '1 month', 'Mon')                        as next_label,
           -- Local dates, for the list filters the strip deep-links with. The
           -- "after X" operator means >= X + 1 day and "before Y" means < Y, so a
           -- month is bounded by the day BEFORE it starts and the day it ends.
           to_char(d, 'YYYY-MM-DD')                                      as today_date,
           to_char(d - interval '1 day', 'YYYY-MM-DD')                   as yesterday_date,
           to_char(m - interval '1 day', 'YYYY-MM-DD')                   as this_after,
           to_char(m + interval '1 month', 'YYYY-MM-DD')                 as this_before,
           to_char(m - interval '1 month' - interval '1 day', 'YYYY-MM-DD') as last_after,
           to_char(m, 'YYYY-MM-DD')                                      as last_before,
           to_char(m + interval '1 month' - interval '1 day', 'YYYY-MM-DD') as next_after,
           to_char(m + interval '2 month', 'YYYY-MM-DD')                 as next_before
    from anchors
  `);
  const r = (res as unknown as Array<Record<string, string | Date>>)[0]!;
  const at = (k: string) => new Date(r[k] as string | Date);

  const todayStart = at("today_start");
  const monthStart = at("month_start");
  const monthEnd = at("month_end");
  return {
    today: { start: todayStart, end: at("today_end"), date: String(r.today_date) },
    yesterday: { start: at("yesterday_start"), end: todayStart, date: String(r.yesterday_date) },
    thisMonth: {
      start: monthStart,
      end: monthEnd,
      label: String(r.this_label),
      after: String(r.this_after),
      before: String(r.this_before),
    },
    lastMonth: {
      start: at("last_month_start"),
      end: monthStart,
      label: String(r.last_label),
      after: String(r.last_after),
      before: String(r.last_before),
    },
    nextMonth: {
      start: monthEnd,
      end: at("next_month_end"),
      label: String(r.next_label),
      after: String(r.next_after),
      before: String(r.next_before),
    },
  };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

interface MoneyRow {
  at: Date;
  amount: number;
  currency: string;
}

const emptyPoints = (buckets: Bucket[]): SeriesPointOut[] =>
  buckets.map((b) => ({ t: b.t, label: b.label, v: 0 }));

/**
 * The bucket holding `at`, or -1. Buckets are sorted and do not overlap, so a binary search finds
 * the one a scan from the first would: a scan per row was buckets × rows (D4.5).
 */
function bucketOf(buckets: Bucket[], at: Date): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = buckets[mid]!;
    if (at < b.start) hi = mid - 1;
    else if (at >= b.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Bucket money rows into series points, converting each into the reporting currency. */
function bucketMoney(
  rows: MoneyRow[],
  buckets: Bucket[],
  convert: (m: number, c: string, at?: Date) => number | null,
): SeriesPointOut[] {
  const out = emptyPoints(buckets);
  for (const r of rows) {
    const v = convert(r.amount, r.currency, r.at);
    if (v == null) continue;
    const i = bucketOf(buckets, r.at);
    if (i >= 0) out[i]!.v += v;
  }
  return out;
}

/** Sum money rows inside a window, in the reporting currency. */
function sumMoney(
  rows: MoneyRow[],
  convert: (m: number, c: string, at?: Date) => number | null,
  w?: { start: Date; end: Date },
): number {
  let total = 0;
  for (const r of rows) {
    if (w && !inWindow(r.at, w)) continue;
    total += convert(r.amount, r.currency, r.at) ?? 0;
  }
  return total;
}

function bucketCount(dates: Array<Date | null | undefined>, buckets: Bucket[]): SeriesPointOut[] {
  const out = emptyPoints(buckets);
  for (const at of dates) {
    if (!at) continue;
    const i = bucketOf(buckets, at);
    if (i >= 0) out[i]!.v += 1;
  }
  return out;
}

const countIn = (dates: Array<Date | null | undefined>, w: { start: Date; end: Date }) =>
  dates.filter((d) => inWindow(d, w)).length;

/** Values keyed by time, summed up to and including an instant by binary search. */
interface PrefixSums {
  upTo(t: number): number;
}
function prefixSums(points: Array<[number, number]>): PrefixSums {
  points.sort((a, b) => a[0] - b[0]);
  const times = points.map((p) => p[0]);
  const sums: number[] = [];
  let acc = 0;
  for (const [, v] of points) sums.push((acc += v));
  return {
    upTo(t) {
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! <= t) lo = mid + 1;
        else hi = mid;
      }
      return lo === 0 ? 0 : sums[lo - 1]!;
    },
  };
}

/**
 * `load(at)`, kept for the last few instants only. Each value is a map over the whole book, and
 * a chart asks for one instant per bucket: holding all of them ran a 1.2M-subscription book out
 * of a 12 GB heap (D4.5). Instants are asked in runs (every row at one instant, then the next),
 * so a small window keeps every repeat a hit.
 */
function recentInstants<V>(load: (at: Date) => V, keep = 4): (at: Date) => V {
  const held = new Map<number, V>();
  return (at) => {
    const k = at.getTime();
    let v = held.get(k);
    if (v === undefined) {
      v = load(at);
      held.set(k, v);
      if (held.size > keep) held.delete(held.keys().next().value!);
    }
    return v;
  };
}

/**
 * Business Home as the API serves it: `computeBusinessAnalytics`, kept for two minutes when it
 * took over a second — a large book only (D4.5: ~17 s at 240k subscriptions). Two minutes is
 * inside the five-minute cadence its stored stock figures already run on. Per process.
 */
const homeCache = slowReadCache<string, BusinessAnalytics>({
  ttlMs: 120_000,
  slowMs: 1_000,
  maxEntries: 200,
});
export function cachedBusinessAnalytics(
  organizationId: string,
  businessId: string,
  opts: { range?: AnalyticsRange; currency?: string } = {},
): Promise<BusinessAnalytics> {
  const key = `${organizationId} ${businessId} ${opts.range ?? "daily"} ${(opts.currency ?? "ALL").toUpperCase()}`;
  return homeCache(key, () => computeBusinessAnalytics(organizationId, businessId, opts));
}

/**
 * Compute the Business Home analytics payload.
 *
 * `currency` selects the reporting currency: `'ALL'` converts every currency into
 * the business default via its manual FX rates (reporting the gaps in
 * `missing_rates`), a specific code scopes every figure to that currency only.
 */
export async function computeBusinessAnalytics(
  organizationId: string,
  businessId: string,
  opts: { range?: AnalyticsRange; currency?: string; now?: Date } = {},
): Promise<BusinessAnalytics> {
  const range: AnalyticsRange = ANALYTICS_RANGES.includes(opts.range as AnalyticsRange)
    ? opts.range!
    : "daily";
  const now = opts.now ?? new Date();

  return withTenant(organizationId, async (tx) => {
    const [bizRow] = await tx
      .select({
        defaultCurrency: businesses.defaultCurrency,
        exchangeRates: businesses.exchangeRates,
        // Cut alongside the currency rather than via `businessTimezone`: it is the
        // same row, already being read. `'UTC'` is that helper's default too.
        timezone: businesses.timezone,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);

    const subs = await tx
      .select({
        id: subscriptions.id,
        status: subscriptions.status,
        currency: subscriptions.currency,
        mrr: subscriptions.mrr,
        // 0271: what a cancelled row was worth while it was live. Read, not re-rated.
        lastEarningMrr: subscriptions.lastEarningMrr,
        createdAt: subscriptions.createdAt,
        startDate: subscriptions.startDate,
        startedAt: subscriptions.startedAt,
        activatedAt: subscriptions.activatedAt,
        canceledAt: subscriptions.canceledAt,
        cancelReason: subscriptions.cancelReason,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        // A cancellation booked for a specific future date — the other way a
        // subscription stops being committed revenue before it has stopped earning.
        cancelScheduledAt: subscriptions.cancelScheduledAt,
        cancelBookedAt: subscriptions.cancelBookedAt,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        // The trial's own boundary — a trialling subscription has no term (2026-08-25),
        // so a projection that read only the term would lose every trialling row.
        trialEnd: subscriptions.trialEnd,
        trialStart: subscriptions.trialStart,
        billingPeriod: subscriptions.billingPeriod,
        billingPeriodUnit: subscriptions.billingPeriodUnit,
        remainingBillingCycles: subscriptions.remainingBillingCycles,
      })
      .from(subscriptions)
      // A deleted subscription is not revenue: it bills nothing from the moment it is
      // stamped, so counting its MRR would report money no invoice will ever ask for.
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          notDeleted(),
        ),
      );
    attachLapses(subs, await loadLapses(tx, businessId));

    /**
     * Items for the CANCELLED rows only — the sole thing that reads them.
     *
     * This used to fetch every item in the business joined to its full price row. Measured
     * on a 74,534-subscription book: 76,151 rows at 1,204 bytes each — **~92 MB** into Node
     * per request, most of it `price_snapshot` JSON for the driver to parse, on the page an
     * operator opens first. The server produced those rows in 64 ms; the cost was never the
     * query, which is why `EXPLAIN` alone does not find this.
     *
     * Only `reportingMrrBySubscription` reads them, and only for cancelled subscriptions —
     * whose stored `mrr` is deliberately 0, so the history and churn series need the rate
     * they carried while live. Plan mix used to ride along on the same rows; it asks
     * `resolveBusinessPlanProductIds` now, which answers the same question in one query.
     */
    // Chunked at 500: one id is one bind parameter and Postgres caps a statement at
    // 65,534. Cancelled rows only ever accumulate, so an unchunked list is a failure
    // scheduled for whenever the book crosses that line — which is exactly how
    // `backfill-mrr-movements` broke on a 74,534-subscription book.
    /**
     * How far back the row reads have to reach.
     *
     * Every series buckets inside the chart window, but four KPIs quote calendar months,
     * and on the 1st of a month "last month" starts earlier than a 60-day chart does. So
     * the bound is the EARLIER of the two, less two days for timezone skew —
     * `calendarWindows` works in the business's zone and a SQL predicate cannot.
     *
     * Before this, these reads had no bound: every invoice, transaction, credit note and
     * customer the business had ever created, on a page whose longest view is 12 months.
     * That is unbounded by the age of the account — the one dimension that only grows.
     */
    const chartStart = buildBuckets(range, now)[0]!.start;
    const lastMonthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) - 2 * 24 * 3600_000,
    );
    const since = chartStart < lastMonthStart ? chartStart : lastMonthStart;

    /**
     * Cancelled INSIDE the window, not cancelled ever.
     *
     * Every consumer of a re-rated cancelled row is window-bounded: the cancellation series
     * sum over `window`/`lastMonth` and bucket their points, and `mrrAt`/cMRR ask `liveAt`
     * and `committedAt` at instants inside the window — where a subscription cancelled
     * before `since` is live at none of them. `payingAt` excludes cancelled outright.
     *
     * Measured on the production book after an archive import left it 96% cancelled:
     * 71,732 ids, 71,925 rows, **4,108 ms — 48% of the whole call**. Scoping the read to
     * cancelled rows was itself the previous fix here; it assumed cancelled was a small
     * minority of a book, which is true right up until an archive migration lands.
     * A null `canceled_at` is kept rather than filtered: it is rare, cheap, and the
     * predicates below decide what it means.
     *
     * Narrowed again by 0271: a cancelled row that RECORDED the rate it was earning needs
     * no items at all, because the figure is read off `last_earning_mrr`. Only the tail
     * that churned before that column existed, and has not been backfilled, is re-rated.
     */
    const cancelledIds = subs
      .filter(
        (s) =>
          s.status === "cancelled" &&
          s.lastEarningMrr == null &&
          (s.canceledAt == null || s.canceledAt >= since),
      )
      .map((s) => s.id);
    const items: {
      item: typeof subscriptionItems.$inferSelect;
      price: typeof prices.$inferSelect;
    }[] = [];
    for (let i = 0; i < cancelledIds.length; i += 500) {
      const rows = await tx
        .select({ item: subscriptionItems, price: prices })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .where(inArray(subscriptionItems.subscriptionId, cancelledIds.slice(i, i + 500)));
      for (const r of rows) items.push(r);
    }

    const invoiceCols = {
      id: invoices.id,
      subscriptionId: invoices.subscriptionId,
      status: invoices.status,
      currency: invoices.currency,
      totalMinor: invoices.totalMinor,
      amountDueMinor: invoices.amountDueMinor,
      createdAt: invoices.createdAt,
    };
    const windowedInvRows = await tx
      .select(invoiceCols)
      .from(invoices)
      .where(
        and(
          and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)),
          gte(invoices.createdAt, since),
        ),
      );

    /**
     * Open invoices of ANY age, separately. The AR figure is a statement about what is
     * owed, not about what happened this quarter, so bounding it by date would silently
     * drop the oldest and most overdue rows — the ones that matter most. Bounded by how
     * much is unpaid, not by the age of the account.
     */
    const openInvRows = await tx
      .select(invoiceCols)
      .from(invoices)
      .where(
        and(
          and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)),
          inArray(invoices.status, [...UNPAID_STATUSES]),
          lt(invoices.createdAt, since),
        ),
      );

    /**
     * What the rest of the function reads. `bucketMoney` only adds a row that falls
     * inside a bucket, so the older open invoices cannot reach a series point; they exist
     * for the AR figure, which sums by status rather than by date.
     */
    const invRows = [...windowedInvRows, ...openInvRows];

    const txnRows = await tx
      .select({
        type: transactions.type,
        currency: transactions.currency,
        amountMinor: transactions.amountMinor,
        occurredAt: transactions.occurredAt,
      })
      .from(transactions)
      .where(
        and(
          and(eq(transactions.businessId, businessId), reportableCustomer(transactions.customerId)),
          eq(transactions.status, "succeeded"),
          inArray(transactions.type, ["payment", "refund"]),
          gte(transactions.occurredAt, since),
        ),
      );

    const cnRows = await tx
      .select({
        currency: creditNotes.currency,
        totalMinor: creditNotes.totalMinor,
        createdAt: creditNotes.createdAt,
      })
      .from(creditNotes)
      .where(
        and(
          and(eq(creditNotes.businessId, businessId), reportableCustomer(creditNotes.customerId)),
          gte(creditNotes.createdAt, since),
        ),
      );

    const custRows = await tx
      .select({ createdAt: customers.createdAt })
      .from(customers)
      .where(
        and(
          and(eq(customers.businessId, businessId), reportableCustomer(customers.id)),
          gte(customers.createdAt, since),
        ),
      );

    /**
     * The two ALL-TIME figures, aggregated instead of summed from rows.
     *
     * `Net Billing` and `Net Payments` say "all time" in their own tooltips, so they are
     * the one thing here that legitimately reaches past the window — and they were the
     * reason all four reads above had no bound at all. Nine-odd rows answer them.
     *
     * ⚠️ Converted ONCE per currency rather than per row. The old path rounded every row
     * through `Math.round(minor / rate)` and summed the results; residuals are ±0.5 minor
     * units and cancel, so the two agree to a few minor units on a book of this size — and
     * converting the total is the more accurate of the two. Exactly equal whenever a single
     * currency is selected, or for the reporting currency itself, since neither rounds.
     */
    const billedLifetime = await tx
      .select({
        currency: invoices.currency,
        total: sql<string>`coalesce(sum(${invoices.totalMinor}), 0)`.as("total"),
      })
      .from(invoices)
      .where(
        and(
          and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)),
          inArray(invoices.status, [...BILLED_STATUSES]),
        ),
      )
      .groupBy(invoices.currency);

    const txnLifetime = await tx
      .select({
        type: transactions.type,
        currency: transactions.currency,
        total: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)`.as("total"),
      })
      .from(transactions)
      .where(
        and(
          and(eq(transactions.businessId, businessId), reportableCustomer(transactions.customerId)),
          eq(transactions.status, "succeeded"),
          inArray(transactions.type, ["payment", "refund"]),
        ),
      )
      .groupBy(transactions.type, transactions.currency);

    /**
     * Currency options come from a DISTINCT, not from the rows above — a business that
     * billed in a currency only before the window would otherwise lose it from the
     * selector the moment those reads were bounded.
     */
    const currencyRows = await tx
      .select({ currency: invoices.currency })
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)))
      .groupBy(invoices.currency);

    // The MRR movement ledger (0254). Stocks are still reconstructed from lifecycle
    // timestamps — that reconstruction needs no history table and cannot drift — but FLOW
    // between two instants is not recoverable that way: an upgrade, a downgrade, a pause
    // and a 100%-off coupon all leave a subscription looking exactly as live as before.
    // Netted (see `NETTED_KEYS`): every consumer below adds magnitudes row by row.
    const movementRows = await tx
      .select({
        reason: mrrMovements.reason,
        currency: carried<string>(mrrMovements.currency),
        deltaMinor: nettedDelta(),
        occurredAt: mrrMovements.occurredAt,
        planProductId: carried<string | null>(mrrMovements.planProductId),
        subscriptionId: mrrMovements.subscriptionId,
      })
      .from(mrrMovements)
      /**
       * Bounded like the other row reads. Every consumer is windowed — the series bucket
       * by `occurredAt`, and the plan breakdown covers the last complete month, both of
       * which sit inside `since`. Unbounded this was 0 rows until the ledger was
       * backfilled and 98,858 the moment it was, i.e. a read that grows with the age of
       * the book on a page that only ever shows a window of it.
       */
      .where(
        and(
          and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
          gte(mrrMovements.occurredAt, since),
        ),
      )
      .groupBy(...NETTED_KEYS)
      .having(NETS_TO_SOMETHING);

    const productRows = await tx
      .select({
        id: products.id,
        publicId: products.publicId,
        name: products.name,
        kind: products.kind,
      })
      .from(products)
      .where(eq(products.businessId, businessId));

    // --- MRR per subscription: the cached `subscriptions.mrr` column, which is
    // the ONE authoritative figure in the system.
    //
    // This used to re-derive MRR here by summing the items through
    // `monthlyRecurringMinor`, falling back to the column only for rows with no
    // items. That sum is GROSS: it cannot see discounts (the item rows do not
    // carry them) and it cannot see the trial rule, so the dashboard reported a
    // book at 10.2× the real MRR ($502.30K vs $48.94K, 2026-08-08) while the
    // subscriptions LIST screen — reading the column — showed the right one. Two
    // rating paths is what let them disagree; there is now one.
    //
    // `recomputeSubscriptionMrr` owns it end to end: price snapshots (so sub-level
    // overrides count), discount netting (`discountsForMrr`), and 0 while
    // `in_trial`. Every path that mutates the composition recomputes it — see that
    // function's caller list. An imported book predating 2026-08-07 stored gross
    // values; `scripts/backfill-subscription-mrr.ts` restates them.
    //
    // `reportingMrrBySubscription` re-rates CANCELLED rows only, whose column is
    // deliberately 0 — the history and churn series need the rate they carried
    // while live. See that function for why that is the one exception.
    const reportingMrr = reportingMrrBySubscription({
      subs,
      items: items.map((r) => ({
        subscriptionId: r.item.subscriptionId,
        price: r.price,
        quantity: r.item.quantity,
        snapshot: r.item.priceSnapshot,
      })),
      discounts: await loadActiveDiscounts(tx, businessId),
      cadence: new Map(
        subs.map((s) => [
          s.id,
          { interval: s.billingPeriodUnit ?? "month", intervalCount: s.billingPeriod ?? 1 },
        ]),
      ),
    });
    const mrrOf = (s: (typeof subs)[number]): number => Number(reportingMrr.get(s.id) ?? 0n);
    const subMrr = new Map(subs.map((s) => [s.id, mrrOf(s)]));

    // What each row EARNED at an instant: its ledger balance then (`earnedAt`), so a later rate
    // change is not projected backwards. Read once; each instant sums in memory.
    const ledgerRows = await loadLedgerRows(tx, businessId);
    const ratedMinor = new Map(subs.map((s) => [s.id, reportingMrr.get(s.id) ?? 0n]));
    const sweep = ledgerSweep(ledgerRows);
    /**
     * `earnedAt`, without rebuilding the whole book per instant. A subscription with ledger rows
     * earned its balance, which only moves when the sweep passes a movement, so that part is
     * rebuilt only when the sweep's version changes — never across the 60-odd forward CMRR
     * instants, which no movement separates. Only the rows with no ledger at all depend on the
     * instant itself (`earningAt`), and they are few.
     */
    const unbooked = subs.filter((s) => !sweep.has(s.id));
    let ledgered: { version: number; earned: Map<string, bigint> } | null = null;
    const earnedOn = recentInstants((at): Pick<ReadonlyMap<string, bigint>, "get"> => {
      const balances = sweep.balancesAt(at);
      if (ledgered?.version !== sweep.version()) {
        const earned = new Map<string, bigint>();
        for (const s of subs) {
          const v = balances.get(s.id);
          if (v !== undefined && v !== 0n) earned.set(s.id, v);
        }
        ledgered = { version: sweep.version(), earned };
      }
      const base = ledgered.earned;
      const extra = earnedAt(unbooked, balances, ratedMinor, at);
      return extra.size === 0 ? base : { get: (id) => extra.get(id) ?? base.get(id) };
    });
    const earnedOf = (s: (typeof subs)[number], at: Date): number =>
      Number(earnedOn(at).get(s.id) ?? 0n);
    const bookedOn = recentInstants((at) => sweep.bookedAt(at));

    // --- Reporting currency + FX.
    const base = (bizRow?.defaultCurrency ?? "USD").toUpperCase();
    const rates = (bizRow?.exchangeRates as Record<string, number> | null) ?? {};
    const availableCurrencies = [
      ...new Set<string>([
        base,
        ...subs.map((s) => s.currency),
        ...currencyRows.map((r) => r.currency),
        ...txnLifetime.map((t) => t.currency),
      ]),
    ].sort();

    const requested = (opts.currency ?? "ALL").toUpperCase();
    const scoped =
      requested !== "ALL" && availableCurrencies.includes(requested) ? requested : null;
    const reporting = scoped ?? base;

    // The rate the business held at an instant; before any observation, today's rate.
    const timeline = await loadRateTimeline(tx, businessId, { base, currentRates: rates });
    /**
     * Convert into the reporting currency; null = not representable (excluded). Given `at`,
     * at the rate held then, so a past bucket converts at that bucket's rate.
     */
    const convert = (minor: number, ccy: string, at?: Date): number | null => {
      const c = ccy.toUpperCase();
      if (scoped) return c === scoped ? minor : null;
      if (c === reporting) return minor;
      const rate = at ? Number(timeline.rateAt(c, at)) : rates[c];
      return rate != null && Number.isFinite(rate) && rate > 0 ? Math.round(minor / rate) : null;
    };
    /** Sum per-currency totals through `convert`, skipping what it cannot represent. */
    const convertTotals = (rows: Array<{ currency: string; total: string }>): number =>
      rows.reduce((acc, r) => acc + (convert(Number(r.total), r.currency) ?? 0), 0);

    const missingRates = scoped
      ? []
      : availableCurrencies.filter((c) => c !== reporting && !(rates[c] != null && rates[c] > 0));

    const buckets = buildBuckets(range, now);
    const fwdBuckets = buildBuckets(range, now, "forward");
    const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
    const { today, yesterday, thisMonth, lastMonth, nextMonth } = await calendarWindows(
      tx,
      bizRow?.timezone ?? "UTC",
      now,
    );

    /**
     * Stocks, from the semantic layer.
     *
     * The same reader the report resolvers use, so the active count and the committed
     * revenue on this page are the stored figures a report quotes rather than a second
     * derivation of them. The reconstruction stays behind it — a cache that is not yet
     * complete must only make a read slower, never change its answer — and both arms are
     * handed the SAME `convert`, so they cannot disagree about which currencies are in
     * scope.
     *
     * The paying count is NOT read here; see its note below for why the stored one is not
     * the same question.
     *
     * The preload spans the chart plus the two calendar instants the KPIs quote. A forward
     * bucket is never covered: no day row exists for a day that has not happened.
     */
    const stockInstants = [
      now,
      lastMonth.start,
      lastMonth.end,
      ...buckets.map((b) => new Date(b.end.getTime() - 1)),
    ];
    /**
     * A stored day holds the value at that day's END, so an instant is asked for as the day
     * it CLOSES — `at − 1ms`. Half the instants here are exclusive boundaries (a month
     * start, a window end), and asking those under their own calendar date reads the
     * FOLLOWING day's close: on the golden fixture that moved the retention base by 3,444
     * minor units and a subscriber count by one.
     */
    const closingDay = (at: Date) => new Date(at.getTime() - 1);
    /**
     * ⚠️ And the store may only answer an instant it can actually name.
     *
     * `metric_daily` is keyed on UTC days; the calendar windows above are cut in the
     * BUSINESS's timezone. For a business on Asia/Kolkata "this month" starts at 18:30 UTC
     * on the last of the previous month, and there is no stored day whose close is that
     * instant — reading the nearest one would answer a question five and a half hours away
     * from the one asked. So the store answers a UTC day boundary, or `now` (which is what
     * the current-day row is computed as of), and everything else reconstructs.
     */
    const storeCanAnswer = (at: Date) =>
      at === now || at.getTime() % DAY_MS === 0 || (at.getTime() + 1) % DAY_MS === 0;
    const stockDays = stockInstants
      .filter(storeCanAnswer)
      .map((d) => closingDay(d).toISOString().slice(0, 10))
      .sort();
    const store = await loadStockReaderFromMetrics({
      organizationId,
      businessId,
      from: stockDays[0] ?? isoDate(now),
      to: stockDays[stockDays.length - 1] ?? isoDate(now),
      convert,
    });
    const stockStore = {
      at: (at: Date, m: StockMeasure) => (storeCanAnswer(at) ? store.at(closingDay(at), m) : null),
    };

    // --- Money flows.
    const billed = invRows.filter((i) => BILLED_STATUSES.has(i.status));
    const billing: MoneyRow[] = billed.map((i) => ({
      at: i.createdAt,
      amount: Number(i.totalMinor),
      currency: i.currency,
    }));

    // "New billing" = each subscription's FIRST invoice (signup billing), plus
    // one-off invoices with no subscription.
    const firstInvoiceAt = new Map<string, Date>();
    for (const i of billed) {
      if (!i.subscriptionId) continue;
      const prev = firstInvoiceAt.get(i.subscriptionId);
      if (!prev || i.createdAt < prev) firstInvoiceAt.set(i.subscriptionId, i.createdAt);
    }
    const newBilling: MoneyRow[] = billed
      .filter(
        (i) =>
          !i.subscriptionId ||
          firstInvoiceAt.get(i.subscriptionId)!.getTime() === i.createdAt.getTime(),
      )
      .map((i) => ({ at: i.createdAt, amount: Number(i.totalMinor), currency: i.currency }));

    const payments: MoneyRow[] = txnRows
      .filter((t) => t.type === "payment")
      .map((t) => ({ at: t.occurredAt, amount: Number(t.amountMinor), currency: t.currency }));
    const refunds: MoneyRow[] = txnRows
      .filter((t) => t.type === "refund")
      .map((t) => ({ at: t.occurredAt, amount: Number(t.amountMinor), currency: t.currency }));
    const creditNoteAmounts: MoneyRow[] = cnRows.map((c) => ({
      at: c.createdAt,
      amount: Number(c.totalMinor),
      currency: c.currency,
    }));

    // Cancellation MRR, split by *why* it churned (dunning = involuntary).
    const cancelRows = (involuntary: boolean): MoneyRow[] =>
      subs
        .filter(
          (s) =>
            s.canceledAt != null && INVOLUNTARY_REASONS.has(s.cancelReason ?? "") === involuntary,
        )
        .map((s) => ({ at: s.canceledAt!, amount: subMrr.get(s.id) ?? 0, currency: s.currency }));
    const voluntary = cancelRows(false);
    const involuntary = cancelRows(true);

    // --- Stocks: MRR / active-count reconstruction.
    // A subscription's own start; `future` subs have a start beyond `now`.

    // Paused subs contribute 0 for the whole window: we don't retain pause
    // history, and the point-in-time definition excludes them — this keeps
    // series[as_of] identical to the MRR KPI.
    const mrrEligible = subs.filter((s) => MRR_STATUSES.has(s.status));

    const reconstructMrrAt = (at: Date): number => {
      let total = 0;
      for (const s of subs) {
        const earned = earnedOf(s, at);
        if (earned !== 0) total += convert(earned, s.currency, at) ?? 0;
      }
      return total;
    };
    /**
     * MRR reads `metric_daily` first, like every other stock here and every report: that store
     * holds the ledger's figure (`earnedAt`), so a stored day and a rebuilt one agree.
     */
    const mrrAt = (at: Date): number => stockStore.at(at, "mrr") ?? reconstructMrrAt(at);
    // Currency scoping is the caller's, not the predicate's — `stocks.ts` knows nothing
    // about which currency this payload reports in.
    const inScope = (s: (typeof subs)[number]) => scoped == null || s.currency === scoped;
    // Earning per the ledger is active then, whatever the row's (possibly reset) start says.
    const reconstructActiveAt = (at: Date): number =>
      subs.filter(
        (s) =>
          (earnedOf(s, at) > 0 || (MRR_STATUSES.has(s.status) && isActiveAt(s, at))) && inScope(s),
      ).length;
    const activeAt = (at: Date): number =>
      stockStore.at(at, "active_subscriptions") ?? reconstructActiveAt(at);
    /**
     * The three nested counts: ACTIVE (everything live, $0 lines included) ⊇ PAYING (carrying
     * revenue above zero, a non-renewing one included — it is still billing this term) ⊇
     * RENEWING (paying and not in its final term before a booked stop). The same definitions
     * as the stored measures, which answer first.
     */
    const reconstructPayingAt = (at: Date, renewing: boolean): number =>
      subs.filter(
        (s) =>
          // Currency scoping stays: without it a scoped view counts every currency's
          // subscriptions under one currency's heading.
          inScope(s) && earnedOf(s, at) > 0 && (!renewing || !nonRenewingAt(s, at)),
      ).length;
    const payingAt = (at: Date): number =>
      stockStore.at(at, "paying_subscriptions") ?? reconstructPayingAt(at, false);
    const renewingAt = (at: Date): number =>
      stockStore.at(at, "renewing_subscriptions") ?? reconstructPayingAt(at, true);

    // CMRR — the MRR we are COMMITTED to, which is NOT the MRR we are earning.
    //
    // Until 2026-09-17 this was "MRR still live at instant t", and at t = now that
    // predicate is the MRR predicate: the KPI printed the MRR figure a second time on
    // every business measured (12/12). The three differences that make it its own
    // number:
    //
    //  - **A booked cancellation stops being committed the moment it is booked**, not
    //    when it lands. `cancel_at_period_end` and a dated `cancel_scheduled_at` are both
    //    a decision already taken; counting that revenue as committed is the optimism the
    //    metric exists to remove. (110 subscriptions on the largest business here.)
    //  - **A signed subscription that has not started yet DOES count.** It is revenue we
    //    are contracted to receive; excluding it meant the projection could only ever
    //    fall, never book committed growth.
    //  - **Finite cycles end.** A subscription with `remaining_billing_cycles` is
    //    committed until those cycles run out, and drops out of the forward series there.
    //
    // A TRIAL contributes 0 — nothing is committed until it converts, the same rule MRR
    // applies — and so does every past trial day: see `committedMrrOf`.
    const cmrrOf = (s: (typeof subs)[number], at: Date): number =>
      convert(
        Number(
          committedMrrOf(
            s.id,
            earnedOn(at),
            bookedOn(at),
            ratedMinor.get(s.id) ?? 0n,
            startOf(s) <= at,
          ),
        ),
        s.currency,
        at,
      ) ?? 0;
    const reconstructCmrrAt = (at: Date): number => {
      if (at >= now) return forwardCmrrAt(at);
      let total = 0;
      for (const s of subs) if (committedAt(s, at)) total += cmrrOf(s, at);
      return total;
    };
    /**
     * The forward projection without testing every row at every instant (D4.5): 60-odd instants
     * × the whole book. `committedAt` is an interval (`committedWindow`), and between instants
     * the ledger has not moved (same sweep version) and the FX rates are the same, a row's CMRR
     * is the same number. So the book is sorted once per (version, rates) into prefix sums,
     * and an instant is two binary searches. Rows with no ledger depend on the instant itself
     * (`earningAt`) and are still tested one by one; they are few.
     */
    const otherCurrencies = [...new Set(subs.map((s) => s.currency.toUpperCase()))].filter(
      (c) => c !== reporting,
    );
    const windows = new Map(subs.map((s) => [s.id, committedWindow(s)]));
    const forwardIndex = new Map<string, { from: PrefixSums; until: PrefixSums }>();
    const forwardCmrrAt = (at: Date): number => {
      earnedOn(at); // moves the sweep to `at`, so its version names the balances read below
      const rateKey = scoped
        ? ""
        : otherCurrencies.map((c) => String(timeline.rateAt(c, at))).join();
      const key = `${sweep.version()}|${rateKey}`;
      let index = forwardIndex.get(key);
      if (!index) {
        const from: Array<[number, number]> = [];
        const until: Array<[number, number]> = [];
        for (const s of subs) {
          const w = windows.get(s.id);
          if (!w || !sweep.has(s.id) || (w.until != null && !(w.until > w.from))) continue;
          const v = cmrrOf(s, at);
          if (v === 0) continue;
          from.push([w.from.getTime(), v]);
          if (w.until != null) until.push([w.until.getTime(), v]);
        }
        index = { from: prefixSums(from), until: prefixSums(until) };
        forwardIndex.set(key, index);
      }
      // Committed: from <= at < until. A row whose `until` has passed also started (until > from).
      let total = index.from.upTo(at.getTime()) - index.until.upTo(at.getTime());
      for (const s of unbooked) if (committedAt(s, at)) total += cmrrOf(s, at);
      return total;
    };
    // A FORWARD instant is never covered — no day row exists for a day that has not
    // happened — so the projection always reconstructs, by arithmetic rather than by rule.
    const cmrrAt = (at: Date): number => stockStore.at(at, "cmrr") ?? reconstructCmrrAt(at);

    // --- MRR movement (0254): the flow behind the stock.
    //
    // Losses are carried as POSITIVE magnitudes, because every consumer of them — the
    // series, the ratios, the chart legend — states them as an amount lost. `delta_minor`
    // keeps its sign in the table, where the identity Σdelta = ΔMRR has to hold.
    const movementRowsFor = (
      reasons: string[],
      keep: (m: (typeof movementRows)[number]) => boolean = () => true,
    ): MoneyRow[] =>
      movementRows
        .filter((m) => reasons.includes(m.reason) && keep(m))
        .map((m) => ({
          at: m.occurredAt,
          amount: Math.abs(Number(m.deltaMinor)),
          currency: m.currency,
        }));
    const newMrrRows = movementRowsFor(["new"]);
    const expansionRows = movementRowsFor(["expansion"]);
    const reactivationRows = movementRowsFor(["reactivation", "resume"]);
    const contractionRows = movementRowsFor(["contraction"]);
    const churnRows = movementRowsFor(["churn", "pause"]);

    /**
     * Retention, over the LAST COMPLETE CALENDAR MONTH.
     *
     * Deliberately not the range selector's window: retention is quoted per month, and a
     * figure that changed when someone switched the chart from 3 months to 12 would be
     * a different measurement each time it was read. It is also not the month in progress,
     * whose churn has not finished happening.
     *
     *   GRR = (start − contraction − churn) ÷ start      — the base, without any credit
     *                                                      for growing the accounts kept
     *   NRR = (start + expansion + reactivation − contraction − churn) ÷ start
     *   Quick ratio = (new + expansion + reactivation) ÷ (contraction + churn)
     *
     * `new` is absent from GRR and NRR on purpose: both ask what happened to the base we
     * already had, and new business answers a different question. Quick ratio is the one
     * that wants everything gained over everything lost.
     *
     * GRR and NRR are moved only by the OPENING COHORT: subscriptions whose ledger balance at
     * the previous close was above zero. A line that started mid-month and then upgraded or
     * cancelled was never in the base they divide by. Same rule as the reports' derived path.
     */
    const sumIn = (rows: MoneyRow[], w: { start: Date; end: Date }) => sumMoney(rows, convert, w);
    const retentionWindow = lastMonth;
    const startingMrr = mrrAt(retentionWindow.start);
    const movedNew = sumIn(newMrrRows, retentionWindow);
    const movedExpansion = sumIn(expansionRows, retentionWindow);
    const movedReactivation = sumIn(reactivationRows, retentionWindow);
    const movedContraction = sumIn(contractionRows, retentionWindow);
    const movedChurn = sumIn(churnRows, retentionWindow);

    // The balance at the opening needs the whole ledger, not just the rows since `since`.
    const openAt = new Date(retentionWindow.start.getTime() - 1);
    const RETENTION_MOVES = [
      "expansion",
      "reactivation",
      "resume",
      "contraction",
      "churn",
      "pause",
    ];
    const movedIds = [
      ...new Set(
        movementRows
          .filter(
            (m) =>
              RETENTION_MOVES.includes(m.reason) &&
              m.occurredAt >= retentionWindow.start &&
              m.occurredAt < retentionWindow.end,
          )
          .map((m) => m.subscriptionId),
      ),
    ];
    const openingCohort = new Set<string>();
    for (let i = 0; i < movedIds.length; i += 1000) {
      const open = await tx
        .select({ id: mrrMovements.subscriptionId })
        .from(mrrMovements)
        .where(
          and(
            and(
              eq(mrrMovements.businessId, businessId),
              reportableCustomer(mrrMovements.customerId),
            ),
            inArray(mrrMovements.subscriptionId, movedIds.slice(i, i + 1000)),
            lte(mrrMovements.occurredAt, openAt),
          ),
        )
        .groupBy(mrrMovements.subscriptionId)
        .having(sql`sum(${mrrMovements.deltaMinor}) > 0`);
      for (const r of open) openingCohort.add(r.id);
    }
    const inCohort = (m: (typeof movementRows)[number]) => openingCohort.has(m.subscriptionId);
    const cohortSum = (reasons: string[]) =>
      sumIn(movementRowsFor(reasons, inCohort), retentionWindow);
    /**
     * The same month, broken down by PLAN — "expansion is up" is the beginning of a
     * question, and this is the answer to it.
     *
     * Grouped on the plan STORED WITH THE MOVEMENT, not on the subscription's plan today:
     * after an upgrade those differ, and the difference is exactly the movement being
     * explained. A movement with no plan (a charges-only subscription) groups under null
     * and is labelled rather than dropped — a breakdown whose parts do not sum to the whole
     * is worse than one with an awkward row in it.
     */
    const planNameOf = (id: string | null): { plan: string; plan_id: string | null } => {
      if (!id) return { plan: "No plan", plan_id: null };
      const p = productRows.find((x) => x.id === id);
      return { plan: p?.name ?? "Unknown", plan_id: p?.publicId ?? null };
    };
    const movementByPlan: PlanMovementRow[] = (() => {
      const acc = new Map<string, PlanMovementRow>();
      for (const mv of movementRows) {
        if (mv.occurredAt < retentionWindow.start || mv.occurredAt >= retentionWindow.end) continue;
        const amount = convert(Math.abs(Number(mv.deltaMinor)), mv.currency, mv.occurredAt);
        if (amount == null) continue;
        const key = mv.planProductId ?? "none";
        let row = acc.get(key);
        if (!row) {
          row = {
            ...planNameOf(mv.planProductId),
            new_mrr_minor: 0,
            expansion_mrr_minor: 0,
            reactivation_mrr_minor: 0,
            contraction_mrr_minor: 0,
            churn_mrr_minor: 0,
            net_mrr_minor: 0,
          };
          acc.set(key, row);
        }
        if (mv.reason === "new") row.new_mrr_minor += amount;
        else if (mv.reason === "expansion") row.expansion_mrr_minor += amount;
        else if (mv.reason === "reactivation" || mv.reason === "resume")
          row.reactivation_mrr_minor += amount;
        else if (mv.reason === "contraction") row.contraction_mrr_minor += amount;
        else if (mv.reason === "churn" || mv.reason === "pause") row.churn_mrr_minor += amount;
        row.net_mrr_minor += convert(Number(mv.deltaMinor), mv.currency, mv.occurredAt) ?? 0;
      }
      // Biggest movers first, by ABSOLUTE net: a plan that lost 40k matters as much as one
      // that gained 40k, and sorting on the signed figure buries the losses at the bottom.
      return [...acc.values()].sort(
        (a, b) => Math.abs(b.net_mrr_minor) - Math.abs(a.net_mrr_minor),
      );
    })();

    const cohortRates = retentionRates({
      startingMrr,
      newMrr: movedNew,
      expansion: cohortSum(["expansion"]),
      reactivation: cohortSum(["reactivation", "resume"]),
      contraction: cohortSum(["contraction"]),
      churn: cohortSum(["churn", "pause"]),
    });
    const retentionRatesBlock = {
      gross_retention_bps: cohortRates.gross_retention_bps,
      net_retention_bps: cohortRates.net_retention_bps,
      quick_ratio_bps: retentionRates({
        startingMrr,
        newMrr: movedNew,
        expansion: movedExpansion,
        reactivation: movedReactivation,
        contraction: movedContraction,
        churn: movedChurn,
      }).quick_ratio_bps,
    };

    // --- Counts.
    // Signups = customers created (a signup is an account, not a subscription).
    const signupDates = custRows.map((c) => c.createdAt);
    // Activations = the trial→active moment (non-trial subs activate on start).
    const activationDates = subs.map((s) => s.activatedAt ?? null);
    const cancelDates = subs.filter((s) => s.canceledAt != null).map((s) => s.canceledAt!);

    // Churn rate over a window = cancellations ÷ the base exposed to churn:
    // subscriptions live at its start plus those that started during it. (Live-at-
    // start alone breaks down for a young business, where nearly every
    // subscription is created inside the window.)
    const churnBps = (w: { start: Date; end: Date }): number => {
      const cancels = countIn(cancelDates, w);
      const started = mrrEligible.filter((s) => inWindow(startOf(s), w)).length;
      const denom = activeAt(w.start) + started;
      if (denom <= 0) return 0;
      return Math.round((cancels / denom) * 10000);
    };

    // --- Series.
    // Every flow series compares its window total against last month, the same
    // comparable `countSeries` uses. (This took a `forwardLabelOffset` knob to
    // pick a different month; no caller ever passed one — the forward CMRR
    // series builds its own headline against `nextMonth` below.)
    const moneySeries = (key: string, label: string, rows: MoneyRow[]): AnalyticsSeries => ({
      key,
      label,
      kind: "money",
      headline: {
        kind: "money",
        value: sumMoney(rows, convert, window),
        prev_value: sumMoney(rows, convert, lastMonth),
        prev_label: lastMonth.label,
      },
      points: bucketMoney(rows, buckets, convert),
    });
    const countSeries = (
      key: string,
      label: string,
      dates: Array<Date | null | undefined>,
    ): AnalyticsSeries => ({
      key,
      label,
      kind: "count",
      headline: {
        kind: "count",
        value: countIn(dates, window),
        prev_value: countIn(dates, lastMonth),
        prev_label: lastMonth.label,
      },
      points: bucketCount(dates, buckets),
    });

    const mrrNow = mrrAt(now);

    const series: AnalyticsSeries[] = [
      moneySeries("total_billing", "Total Billing", billing),
      moneySeries("total_new_billing", "Total New Billing", newBilling),
      moneySeries("voluntary_cancellation_mrr", "Voluntary Cancellation MRR", voluntary),
      moneySeries("involuntary_cancellation_mrr", "Involuntary Cancellation MRR", involuntary),
      moneySeries("total_payments", "Total Payments", payments),
      moneySeries("total_refunds", "Total Refunds", refunds),
      {
        key: "total_mrr",
        label: "Total MRR",
        kind: "money",
        headline: {
          kind: "money",
          value: mrrNow,
          prev_value: mrrAt(lastMonth.end),
          prev_label: lastMonth.label,
        },
        // Stock metric: value at each bucket's *end*, through the same `mrrAt` the KPIs
        // read — stored snapshot first, reconstruction second. One definition of MRR
        // serves both, so a tile and its chart cannot disagree.
        points: buckets.map((b) => {
          const at = new Date(b.end.getTime() - 1);
          return { t: b.t, label: b.label, v: mrrAt(at) };
        }),
      },
      {
        key: "total_cmrr",
        label: "Total CMRR",
        kind: "money",
        forward: true,
        headline: {
          kind: "money",
          value: cmrrAt(now),
          prev_value: cmrrAt(nextMonth.end),
          prev_label: nextMonth.label,
        },
        points: fwdBuckets.map((b) => ({
          t: b.t,
          label: b.label,
          v: cmrrAt(new Date(b.end.getTime() - 1)),
        })),
      },
      moneySeries("total_new_mrr", "Total New MRR", newMrrRows),
      moneySeries("total_expansion_mrr", "Total Expansion MRR", expansionRows),
      moneySeries("total_reactivation_mrr", "Total Reactivation MRR", reactivationRows),
      moneySeries("total_contraction_mrr", "Total Contraction MRR", contractionRows),
      moneySeries("total_churn_mrr", "Total Churn MRR", churnRows),
      countSeries("total_signups", "Total Signups", signupDates),
      countSeries("total_activations", "Total Activations", activationDates),
      {
        key: "subscription_churn_rate",
        label: "Total Subscription Churn Rate",
        kind: "count",
        headline: {
          kind: "percent",
          value: churnBps(window),
          prev_value: churnBps(lastMonth),
          prev_label: lastMonth.label,
        },
        // Points are cancellation *counts* per bucket; the headline is the rate
        // over the whole window (a per-day rate is noise at this resolution).
        points: bucketCount(cancelDates, buckets),
      },
      moneySeries("total_credit_notes_amount", "Total Credit Notes Amount", creditNoteAmounts),
    ];

    // --- Subscriptions by plan.
    //
    // Grouped by the subscription's PLAN item — the one whose product is
    // `kind='plan'`. This used to take `items[0]`, which was wrong twice over: the
    // items query has no ORDER BY, so "first" was whatever Postgres happened to
    // return, and an ADDON row coming back first attributed the whole subscription
    // to the addon. Measured on a 251-active book: the panel listed
    // `platform-additional-connections-v202604` — an add-on — as a plan with 1
    // subscription, and reported `platform-pro-v202604` at 189 instead of 190,
    // because one subscription's addon row sorted ahead of its plan row. Which way
    // it went was not stable across runs.
    //
    // The catalog guarantees this resolves: an add-on must be `kind='addon'`
    // (`attachAddon` rejects anything else), so a plan product cannot be attached
    // as one, and every active subscription on that book carries exactly one
    // plan-kind item. A subscription with none (charges only) falls back to its
    // first item so it still appears somewhere rather than vanishing from a
    // breakdown whose total must equal the KPI above it.
    const productById = new Map(productRows.map((p) => [p.id, p]));
    // Same set as the active-subscriptions KPI, so the breakdown's total is the
    // number in the tile above it rather than that number plus the trials.
    const live = subs.filter(
      (s) => ACTIVE_STATUSES.has(s.status) && (scoped == null || s.currency === scoped),
    );
    // One batched query for the whole set, and the SAME rule stated above — first
    // `kind='plan'` item, else the first item. Reading it from a whole-business item join
    // was what made this panel cost 92 MB.
    const planOf = await resolveBusinessPlanProductIds(tx, businessId);
    const byPlan = new Map<string, { plan: string; plan_id: string | null; count: number }>();
    for (const s of live) {
      const prodId = planOf.get(s.id);
      const prod = prodId ? productById.get(prodId) : undefined;
      const key = prod?.publicId ?? "unknown";
      const row = byPlan.get(key) ?? {
        plan: prod?.name ?? "Unknown",
        plan_id: prod?.publicId ?? null,
        count: 0,
      };
      row.count += 1;
      byPlan.set(key, row);
    }
    const planTotal = live.length;
    const planRows: PlanRow[] = [...byPlan.values()]
      .sort((a, b) => b.count - a.count)
      .map((r) => ({
        ...r,
        pct_bps: planTotal > 0 ? Math.round((r.count / planTotal) * 10000) : 0,
      }));

    // --- KPIs. The headline deltas are month-over-month — the live figure against
    // the close of the previous calendar month, not vs the start of the selected
    // chart range.
    const activeNow = activeAt(now);
    const activeLastMonthEnd = activeAt(lastMonth.end);
    const payingNow = payingAt(now);
    const payingLastMonthEnd = payingAt(lastMonth.end);
    const renewingNow = renewingAt(now);
    const renewingLastMonthEnd = renewingAt(lastMonth.end);
    const mrrLastMonthEnd = mrrAt(lastMonth.end);
    const unpaid = invRows.filter((i) => UNPAID_STATUSES.has(i.status));
    const unpaidScoped = unpaid.filter((i) => convert(0, i.currency) != null);
    // ── AR IS NET OF CASH (F-18, 2026-08-26) ────────────────────────────────────────
    // `amount_due_minor` is the issue-time collectible net of CREDITS only and is
    // deliberately never decremented by payments, so summing it raw counts settled
    // invoices as still owing. Measured on the local book: outstanding AR overstated by
    // 121.8% on USD and 66.7% on INR, with four fully-settled invoices reported as open.
    //
    // One batched query via the helper that owns the rule, not a per-invoice lookup: this
    // is a dashboard KPI and N round-trips would be its own defect. The subtraction stays
    // in BIGINT and only the result is handed to `convert`, so no minor unit is lost to a
    // float before the currency conversion even starts.
    const { paidTotals } = await import("@/modules/invoicing/service");
    const paidByInvoice = await paidTotals(
      tx,
      unpaidScoped.map((i) => i.id),
    );
    const outstandingMinor = (i: (typeof unpaidScoped)[number]): bigint => {
      const remaining = (i.amountDueMinor ?? i.totalMinor) - (paidByInvoice.get(i.id) ?? 0n);
      return remaining > 0n ? remaining : 0n;
    };
    // Count what is actually OWED, not what merely has an unpaid status: an invoice whose
    // balance is fully settled is not part of accounts receivable, whatever its status row
    // still says.
    const owing = unpaidScoped.filter((i) => outstandingMinor(i) > 0n);
    const bps = (curr: number, prev: number): number | null =>
      prev > 0 ? Math.round(((curr - prev) / prev) * 10000) : null;

    /**
     * Money actually kept in a window: payments collected LESS refunds issued —
     * the same definition as the `net_payments_minor` KPI directly above the
     * strip, over a window instead of all time.
     *
     * The strip used to report gross payments here while that card reported net,
     * so one screen carried two meanings of "received" and a refunded charge
     * stayed booked as revenue. Both comparison figures (`last_month`,
     * `yesterday`) net too — netting only the current window would make the
     * comparison a different measurement from the thing it is compared against.
     */
    const receivedIn = (w: { start: Date; end: Date }): number =>
      sumMoney(payments, convert, w) - sumMoney(refunds, convert, w);

    return {
      as_of: now.toISOString(),
      range,
      granularity: RANGE_SHAPE[range].granularity,
      currency: reporting,
      converted: scoped == null && availableCurrencies.length > 1,
      available_currencies: availableCurrencies,
      missing_rates: missingRates,
      kpis: {
        mrr: {
          value: mrrNow,
          prev_value: mrrLastMonthEnd,
          change_bps: bps(mrrNow, mrrLastMonthEnd),
        },
        cmrr: { value: cmrrAt(now) },
        active_subscriptions: {
          value: activeNow,
          prev_value: activeLastMonthEnd,
          change_bps: bps(activeNow, activeLastMonthEnd),
        },
        /** The subset of the above that carries MRR > 0 — see `payingAt`. */
        renewing_subscriptions: {
          value: renewingNow,
          prev_value: renewingLastMonthEnd,
          change_bps: bps(renewingNow, renewingLastMonthEnd),
        },
        paying_subscriptions: {
          value: payingNow,
          prev_value: payingLastMonthEnd,
          change_bps: bps(payingNow, payingLastMonthEnd),
        },
        /**
         * Retention over the last complete calendar month, and the movement it is built
         * from. Rates are basis points and null when there was no base to retain.
         */
        retention: {
          window_label: retentionWindow.label,
          starting_mrr_minor: startingMrr,
          new_mrr_minor: movedNew,
          expansion_mrr_minor: movedExpansion,
          reactivation_mrr_minor: movedReactivation,
          contraction_mrr_minor: movedContraction,
          churn_mrr_minor: movedChurn,
          ...retentionRatesBlock,
        },
        // From the all-time aggregates, not from `billing`/`payments` — those rows are
        // bounded to the window now, and these two tiles say "all time" on their face.
        net_billing_minor: convertTotals(billedLifetime),
        net_payments_minor:
          convertTotals(txnLifetime.filter((t) => t.type === "payment")) -
          convertTotals(txnLifetime.filter((t) => t.type === "refund")),
        unpaid_invoices: {
          count: owing.length,
          amount_minor: owing.reduce(
            (sum, i) => sum + (convert(Number(outstandingMinor(i)), i.currency) ?? 0),
            0,
          ),
        },
        revenue_this_month: {
          expected_minor: sumMoney(billing, convert, thisMonth),
          received_minor: receivedIn(thisMonth),
          last_month_minor: receivedIn(lastMonth),
        },
        revenue_today: {
          expected_minor: sumMoney(billing, convert, today),
          received_minor: receivedIn(today),
          yesterday_minor: receivedIn(yesterday),
        },
        signups_this_month: {
          count: countIn(signupDates, thisMonth),
          last_month: countIn(signupDates, lastMonth),
        },
        signups_today: {
          count: countIn(signupDates, today),
          yesterday: countIn(signupDates, yesterday),
        },
      },
      windows: {
        today: { on: today.date },
        yesterday: { on: yesterday.date },
        this_month: { after: thisMonth.after, before: thisMonth.before },
        last_month: { after: lastMonth.after, before: lastMonth.before },
      },
      series,
      subscriptions_by_plan: { total: planTotal, rows: planRows },
      mrr_movement_by_plan: movementByPlan,
    };
  });
}
