import { reportableSubscription } from "../reportable";
import { reportableCustomer } from "../reportable";
import { and, eq, gte, inArray, isNotNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { withTenant, type Tx } from "@/platform/db";
import {
  appliedTaxes,
  businesses,
  checkoutSessions,
  retentionEvents,
  creditNotes,
  customers,
  invoiceLineDiscounts,
  invoiceLineItems,
  invoices,
  mrrMovements,
  paymentMethods,
  products,
  scheduledChanges,
  subscriptionItems,
  subscriptions,
  transactions,
} from "@db/schema";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import {
  AR_AGING_INTERVALS,
  arAgingIntervalError,
  arAgingLadder,
  type ArAgingInterval,
} from "@/modules/invoicing/ar-aging";
import { paidTotals } from "@/modules/invoicing/service";
import { accountHolderName } from "@/modules/customers/names";
import {
  ANALYTICS_RANGES,
  RANGE_SHAPE,
  buildBuckets,
  calendarWindows,
  type AnalyticsRange,
  type Bucket,
  type Granularity,
} from "../analytics";
import {
  committedAt,
  isBookedToStop,
  liveAt,
  MRR_STATUSES,
  nonRenewingAt,
  startOf,
  type StockRow,
} from "../stocks";
import { loadStockReaderFromMetrics } from "../daily/stock-reader";
import {
  committedMrrOf,
  earnedAt,
  ledgerBalancesAt,
  ledgerBookedAt,
  attachLapses,
  loadLapses,
  loadLedgerRows,
  loadReratedMrr,
  type LedgerRow,
} from "../snapshots";
import {
  carried,
  NETS_TO_SOMETHING,
  NETTED_KEYS,
  nettedDelta,
  retentionRates,
} from "../mrr-movements";
import { loadRateTimeline } from "@/platform/fx/history";
import { loadMovementCells, movementPath } from "./movement-matview";
import {
  attributePaymentsForBusiness,
  PAYMENT_BUCKETS,
  type PaymentAttribution,
  type PaymentBucket,
} from "@/modules/payments/attribution";
import {
  acceptsAgingInterval,
  acceptsGranularity,
  GRANULARITIES,
  REPORT_BY_KEY,
  type ReportDef,
  type ReportDimension,
} from "./registry";

/**
 * The report resolvers: one per `source`, never one per report.
 *
 * Everything comparable about a report — its window, its bucket edges, its currency
 * conversion, its comparison period — is decided here, once. That is the point: a hundred
 * bespoke query functions do not disagree about what a metric MEANS, they disagree about
 * where August ended, and only on the edges nobody checks.
 *
 * Buckets come from `analytics.ts` (`buildBuckets`) rather than from a local copy, so a
 * report and the chart beside it on the dashboard cut time identically.
 */

export interface ReportPoint {
  t: string;
  label: string;
  v: number;
}

export interface ReportRow {
  group: string;
  group_id: string | null;
  value: number;
}

/**
 * What a comparison was computed ON, stated rather than assumed.
 *
 * The trap this exists to close: a month-to-date figure against a COMPLETE previous month
 * is a guaranteed false drop — worst on the 2nd, invisible by the 28th. **Compare like to
 * like:** a partial period compares against the same elapsed part of the previous one, and
 * the payload says which it did, so a card can label its delta instead of a reader assuming.
 *
 * There is ONE basis for the pair, not one per side, because both sides are cut the same way
 * by construction — a partial current window can never reach a complete previous one.
 *
 *  - `month_to_date` / `complete_month` — a window one calendar month long, cut short or whole.
 *  - `period_to_date` / `complete_period` — any other window, cut short or whole.
 *  - `point_in_time` — a stock, read at two instants one window apart. A stock has no partial
 *    reading to worry about; what matters is that the earlier instant is stated.
 */
export type ReportComparisonBasis =
  | "month_to_date"
  | "complete_month"
  | "period_to_date"
  | "complete_period"
  | "point_in_time";

/** The previous period, and how this report's figure moved against it. */
export interface ReportComparison {
  /** The same measure over the comparison window. Null where the measure has no answer. */
  prev_value: number | null;
  /** The period `prev_value` covers, e.g. `Aug 2026` or `Oct 1, 2024 – Sep 18, 2025`. */
  prev_label: string;
  /**
   * Change vs `prev_value` in basis points, relative — whatever the report's `kind`, so a
   * rate's delta is the proportion it moved by, not a subtraction of two rates.
   * Null, never 0, where there is no base: a zero or negative base has no proportion.
   */
  change_bps: number | null;
  basis: ReportComparisonBasis;
}

/**
 * The two windows a comparison is computed over, and where each one is CUT.
 *
 * Exported for the gate. The properties that make a comparison honest are properties of
 * this pair — `previous.end === current.start`, and the same elapsed span on both sides —
 * and they can only be asserted if the windows themselves are inspectable.
 */
export interface ReportComparisonWindows {
  /** `cut` is where the figure actually stops: `now`, or the window end if it has passed. */
  current: { start: Date; end: Date; cut: Date };
  previous: { start: Date; end: Date; cut: Date };
  basis: ReportComparisonBasis;
  label: string;
}

export interface ReportResult {
  object: "report";
  key: string;
  name: string;
  description: string;
  category: string;
  /** What this report may be grouped by, so a client can offer exactly those controls. */
  dimensions: ReadonlyArray<string>;
  /** Cross-cutting tags — the filter chips, not a second grouping. */
  tags: ReadonlyArray<string>;
  kind: ReportDef["kind"];
  shape: ReportDef["shape"];
  range: AnalyticsRange;
  granularity: Granularity;
  currency: string;
  converted: boolean;
  /** The window total (flow) or its latest value (stock). Units follow `kind`. */
  headline: number | null;
  points: ReportPoint[];
  /**
   * The granularities this report's series may be re-cut at, or empty where it has no
   * series to re-cut. The client renders a control per entry and none at all when the list
   * is empty — a control the engine would refuse is a control that reaches nothing.
   */
  granularities: ReadonlyArray<Granularity>;
  /** The rung width the ageing ladder was built at — `standard` unless one was asked for. */
  aging_interval: ArAgingInterval;
  /**
   * The rung widths this report's ageing ladder may be rebuilt at, empty on every report
   * that is not an ageing ladder — same contract as `granularities`: a control the engine
   * would refuse is a control that reaches nothing.
   */
  aging_intervals: ReadonlyArray<ArAgingInterval>;
  /** Present only when `group_by` was asked for and the report supports it. */
  rows?: ReportRow[];
  /**
   * The rows are nested steps — each a subset of the one before — so a share is of the FIRST
   * row, not of their sum. Set only by the checkout funnel.
   */
  funnel?: boolean;
  /**
   * The customer filter this answer was narrowed by, echoed back exactly as asked. Absent
   * when the report covers the whole book — which is what makes a filtered figure legible
   * next to an unfiltered one.
   */
  customer_filter?: string;
  /**
   * A `periodic` report's table: one row per period, one column per measure. The waterfall
   * shape — opening, what moved, closing — which a series of separate charts cannot show,
   * because the point is that the columns RECONCILE across the row.
   */
  table?: {
    columns: Array<{ key: string; label: string }>;
    rows: Array<{ period: string; values: number[] }>;
  };
  /**
   * A cohort report's grid: one row per intake month, one column per month since. Values
   * are basis points of the cohort's opening figure, or null where the month has not
   * happened yet — null is "not yet", which 0 would misreport as total loss.
   */
  matrix?: {
    columns: string[];
    /** What the `base` column holds, so the client formats it without guessing. */
    base_kind: "money" | "count";
    rows: Array<{ group: string; base: number; values: Array<number | null> }>;
  };
  /**
   * The period a single-figure report describes, e.g. "Aug 2026". A rate with no stated
   * period is ambiguous — the reader cannot tell last month from the last twelve — and the
   * series reports do not need it, because their axis says so.
   */
  window_label?: string;
  /**
   * The previous period, present on exactly the reports the registry marks `comparable`
   * and absent on every other — see `ReportComparison`.
   */
  comparison?: ReportComparison;
  as_of: string;
}

export class ReportError extends Error {}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const isRange = (v: string | undefined): v is AnalyticsRange =>
  v != null && (ANALYTICS_RANGES as string[]).includes(v);

const isGranularity = (v: string | undefined): v is Granularity =>
  v != null && (GRANULARITIES as readonly string[]).includes(v);

const utcDayStart = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const utcMonthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const addUtcMonths = (d: Date, n: number) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

/**
 * The buckets a report's series is cut into.
 *
 * `range` says how far back to look; `granularity` says how finely to cut it, and the two
 * are separate questions — "the last three months, by day" is a legitimate request that a
 * range preset alone cannot express. Each preset keeps its own granularity as the default
 * (daily → day, 3m/6m → week, 12m → month), so an untouched URL answers exactly as before.
 *
 * An override re-cuts the SAME span the preset covers: the span comes from `buildBuckets`
 * rather than from a second table of counts, so the range vocabulary has one definition and
 * a re-cut series can never cover a different window from the preset it re-cuts.
 */
function reportBuckets(
  range: AnalyticsRange,
  now: Date,
  direction: "back" | "forward",
  granularity: Granularity,
): Bucket[] {
  const preset = buildBuckets(range, now, direction);
  if (granularity === RANGE_SHAPE[range].granularity) return preset;

  const spanStart = preset[0]!.start;
  const spanEnd = preset[preset.length - 1]!.end;
  const label = (d: Date) =>
    granularity === "month"
      ? `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
      : `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const out: Bucket[] = [];

  /**
   * Every bucket is CLIPPED to the preset's span, so the edge bucket of a re-cut series is
   * a partial week or a partial month rather than a wider window. Without the clip, cutting
   * the 12-month span by week would reach back a few days further than the preset does and
   * the same report would total differently at two granularities — the re-cut must be a
   * finer view of one window, not a second window. `verify:reports` pins that the window
   * total is identical at every granularity.
   */
  const push = (start: Date, end: Date, at: Date) => {
    const s = start < spanStart ? spanStart : start;
    const e = end > spanEnd ? spanEnd : end;
    if (s >= e) return;
    out.push({ t: s.toISOString().slice(0, 10), label: label(at), start: s, end: e });
  };

  if (granularity === "month") {
    // Calendar months, as everywhere else in this module — a "month" that is 30 rolling
    // days would put the same invoice in a different month from the waterfall's.
    let start = utcMonthStart(spanStart);
    while (start < spanEnd) {
      const end = addUtcMonths(start, 1);
      push(start, end, start);
      start = end;
    }
    return out;
  }

  const span = granularity === "week" ? 7 * DAY : DAY;
  const count = Math.ceil((spanEnd.getTime() - spanStart.getTime()) / span);
  for (let i = 0; i < count; i++) {
    // A backward series must END on the bucket containing `now` — the same edge the presets
    // anchor on — so it is built from the far end back. A forward one starts there.
    const start =
      direction === "back"
        ? new Date(spanEnd.getTime() - (count - i) * span)
        : new Date(utcDayStart(spanStart).getTime() + i * span);
    const end = new Date(start.getTime() + span);
    push(start, end, start);
  }
  return out;
}

/**
 * What every resolver needs: the business's FX rates, the reporting currency, and the
 * buckets. Loaded once per request, exactly as the dashboard payload does it — a report that
 * converted at different rates from the dashboard would be a second answer to the same
 * question.
 */
async function loadContext(
  organizationId: string,
  businessId: string,
  opts: {
    range?: string;
    currency?: string;
    granularity?: string;
    agingInterval?: string;
    now?: Date;
  },
  def?: ReportDef,
) {
  if (opts.range != null && !isRange(opts.range)) {
    throw new ReportError(`range must be one of: ${ANALYTICS_RANGES.join(", ")}`);
  }
  const range: AnalyticsRange = isRange(opts.range) ? opts.range : "12m";
  if (opts.granularity != null && opts.granularity !== "") {
    if (!isGranularity(opts.granularity)) {
      throw new ReportError(`granularity must be one of: ${GRANULARITIES.join(", ")}`);
    }
    // Refused, not ignored: these reports define their own rows, so a granularity would
    // silently do nothing and the reader would believe the table had been re-cut.
    if (def && !acceptsGranularity(def)) {
      throw new ReportError(`${def.name} has no series to re-cut, so granularity does not apply`);
    }
  }
  if (opts.agingInterval != null && opts.agingInterval !== "") {
    const problem = arAgingIntervalError(opts.agingInterval);
    if (problem) throw new ReportError(problem);
    // Refused, not ignored — same reason as granularity: a report whose rows are dunning
    // states or decline codes has no ageing ladder to rebuild, and honouring the parameter
    // silently would let a reader believe it had been.
    if (def && !acceptsAgingInterval(def)) {
      throw new ReportError(`${def.name} is not an aging ladder, so aging_interval does not apply`);
    }
  }
  const agingInterval: ArAgingInterval =
    def == null || acceptsAgingInterval(def)
      ? arAgingLadder(opts.agingInterval).interval
      : "standard";
  const granularity: Granularity =
    isGranularity(opts.granularity) && (def == null || acceptsGranularity(def))
      ? opts.granularity
      : RANGE_SHAPE[range].granularity;
  const now = opts.now ?? new Date();

  const { biz, timeline } = await withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({
        defaultCurrency: businesses.defaultCurrency,
        exchangeRates: businesses.exchangeRates,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return {
      biz: row,
      timeline: await loadRateTimeline(tx, businessId, {
        base: (row?.defaultCurrency ?? "USD").toUpperCase(),
        currentRates: (row?.exchangeRates ?? null) as Record<string, unknown> | null,
      }),
    };
  });
  const base = (biz?.defaultCurrency ?? "USD").toUpperCase();
  const rates = (biz?.exchangeRates as Record<string, number> | null) ?? {};
  const requested = (opts.currency ?? "ALL").toUpperCase();
  const scoped = requested !== "ALL" ? requested : null;
  const reporting = scoped ?? base;

  /**
   * Into the reporting currency; null = not representable, which EXCLUDES the row.
   *
   * Given `at`, at the rate the business held THEN (`convertAt`) — every figure that belongs
   * to an instant passes it, so a past month converts at that month's rate. Without it,
   * today's rate: for figures about the present (a current book, amounts owed now).
   */
  const convert = (minor: number, ccy: string, at?: Date): number | null => {
    if (at) return convertAt(minor, ccy, at);
    const c = ccy.toUpperCase();
    if (scoped) return c === scoped ? minor : null;
    if (c === reporting) return minor;
    const rate = rates[c];
    return rate != null && rate > 0 ? Math.round(minor / rate) : null;
  };

  /**
   * The conversion AT AN INSTANT — the rate the business held then, not the one it holds
   * now. With no earlier observation the timeline answers with the CURRENT rate, so a book
   * with no history yet converts exactly as it would at today's rate.
   */
  const convertAt = (minor: number, ccy: string, at: Date): number | null => {
    const c = ccy.toUpperCase();
    if (scoped) return c === scoped ? minor : null;
    if (c === reporting) return minor;
    const rate = timeline.rateAt(c, at);
    if (rate == null) return null;
    const n = Number(rate);
    return Number.isFinite(n) && n > 0 ? Math.round(minor / n) : null;
  };

  return {
    range,
    now,
    reporting,
    scoped,
    convert,
    convertAt,
    converted: scoped == null,
    granularity,
    agingInterval,
  };
}

type Ctx = Awaited<ReturnType<typeof loadContext>>;

/** The ledger rows for a window, already scoped to the business, netted (see `NETTED_KEYS`). */
async function loadMovements(organizationId: string, businessId: string, where?: SQL) {
  return withTenant(organizationId, (tx) =>
    tx
      .select({
        reason: mrrMovements.reason,
        currency: carried<string>(mrrMovements.currency),
        deltaMinor: nettedDelta(),
        // A restatement never touches a pause, the one reader of this, so any row's value is it.
        previousMrrMinor: carried<string>(mrrMovements.previousMrrMinor).mapWith(BigInt),
        occurredAt: mrrMovements.occurredAt,
        planProductId: carried<string | null>(mrrMovements.planProductId),
        previousPlanProductId: carried<string | null>(mrrMovements.previousPlanProductId),
        subscriptionId: mrrMovements.subscriptionId,
        customerId: carried<string>(mrrMovements.customerId),
      })
      .from(mrrMovements)
      .where(
        and(
          and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
          where,
        ),
      )
      .groupBy(...NETTED_KEYS)
      .having(NETS_TO_SOMETHING),
  );
}

type MovementRow = Awaited<ReturnType<typeof loadMovements>>[number];

/**
 * Does this movement match the declaration's plan-change and direction filters?
 *
 * `planChange: "changed"` is what separates an UPGRADE from ordinary expansion, and it needs
 * a from-plan. A movement written before that column existed has none, and is EXCLUDED
 * rather than assumed: counting it as "same plan" would quietly file every historical
 * upgrade as expansion, which is the very confusion the column was added to end.
 */
function matchesMovement(m: MovementRow, def: ReportDef): boolean {
  if (def.reasons && !def.reasons.includes(m.reason as never)) return false;
  if (def.planChange) {
    if (m.previousPlanProductId == null) return false;
    const changed = m.previousPlanProductId !== m.planProductId;
    if (def.planChange === "changed" && !changed) return false;
    if (def.planChange === "same" && changed) return false;
  }
  if (def.direction) {
    const delta = Number(m.deltaMinor);
    if (def.direction === "up" && delta <= 0) return false;
    if (def.direction === "down" && delta >= 0) return false;
  }
  return true;
}

/** Sum a report's movement rows over one window, in the reporting currency. */
function sumMovement(rows: MovementRow[], def: ReportDef, ctx: Ctx, w: { start: Date; end: Date }) {
  let total = 0;
  for (const m of rows) {
    if (m.occurredAt < w.start || m.occurredAt >= w.end) continue;
    if (!matchesMovement(m, def)) continue;
    const raw = def.signed ? Number(m.deltaMinor) : Math.abs(Number(m.deltaMinor));
    const v = ctx.convert(raw, m.currency, m.occurredAt);
    if (v == null) continue;
    total += v;
  }
  return total * (def.multiplier ?? 1);
}

/**
 * Movement counted at CUSTOMER grain.
 *
 * The ledger already carries `customer_id`, so this is a grouping of rows we hold, not a
 * new measure — and the grouping is the whole point: **a customer with three subscriptions
 * must count once.** Every figure here is therefore the SIZE OF A SET of customer ids,
 * rebuilt per window, never a sum of subscription-level rows.
 *
 * Which set, per report:
 *  - `new` — customers whose FIRST movement of any kind falls in the window, i.e. the first
 *    recurring revenue they ever carried. Not "had a `new` movement in the window": an
 *    existing customer opening a second subscription is expansion of an account we already
 *    had, and counting them again would make "new customers" a count of new subscriptions
 *    wearing a customer's name.
 *  - `churned` — customers with a cancellation in the window whose recurring revenue was
 *    still nothing at the END of it. A customer who cancelled one of three subscriptions is
 *    not a lost account, and that is exactly what the subscription-level churn count says
 *    instead. A pause is not counted: the account is suspended, not gone.
 *  - `any` — customers whose revenue moved at all.
 *  - `churn_rate` — the churned set over the accounts we HAD to lose: customers already
 *    carrying recurring revenue when the window opened. Null, never 0, where that base is
 *    empty — a book with no accounts to lose has no churn rate, and 0% would state that it
 *    kept them all.
 *
 * ⚠️ A distinct count does NOT sum across buckets: a customer who moved in March and again
 * in April is one customer in the window total and one in each of the two points. That is
 * inherent to counting people rather than events, and the window figure is the one to read.
 */
function resolveCustomerMovementReport(
  def: ReportDef,
  ctx: Ctx,
  rows: MovementRow[],
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
): ReportResult {
  const grain = def.customers!;
  // Out-of-scope currencies leave first, so a currency-scoped report counts only the
  // customers that currency actually reaches.
  const scoped = rows.filter((m) => ctx.convert(0, m.currency) != null);

  const byCustomer = new Map<string, MovementRow[]>();
  for (const m of scoped) {
    const arr = byCustomer.get(m.customerId) ?? [];
    arr.push(m);
    byCustomer.set(m.customerId, arr);
  }
  for (const arr of byCustomer.values()) arr.sort((a, b) => +a.occurredAt - +b.occurredAt);

  /** The customer's recurring revenue at an instant: the sum of their own deltas up to it. */
  const mrrAt = (movements: MovementRow[], at: Date) => {
    let total = 0;
    for (const m of movements) {
      if (m.occurredAt > at) break;
      total += ctx.convert(Number(m.deltaMinor), m.currency) ?? 0;
    }
    return total;
  };

  const countIn = (w: { start: Date; end: Date }): number => {
    let n = 0;
    for (const movements of byCustomer.values()) {
      const inWindow = movements.filter((m) => m.occurredAt >= w.start && m.occurredAt < w.end);
      if (inWindow.length === 0) continue;
      if (grain === "any") {
        n += 1;
      } else if (grain === "new") {
        if (movements[0]!.occurredAt >= w.start && movements[0]!.occurredAt < w.end) n += 1;
      } else if (
        inWindow.some((m) => m.reason === "churn") &&
        mrrAt(movements, new Date(w.end.getTime() - 1)) <= 0
      ) {
        n += 1;
      }
    }
    return n;
  };

  const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };

  if (grain === "churn_rate") {
    // The base is the book as it stood when the window OPENED. Measuring against the
    // accounts present at the end would net the month's own arrivals into the denominator
    // and report a growing book as a retentive one.
    const rateIn = (w: { start: Date; end: Date }): number | null => {
      let base = 0;
      let lost = 0;
      for (const movements of byCustomer.values()) {
        if (mrrAt(movements, new Date(w.start.getTime() - 1)) <= 0) continue;
        base += 1;
        const inWindow = movements.filter((m) => m.occurredAt >= w.start && m.occurredAt < w.end);
        if (
          inWindow.some((m) => m.reason === "churn") &&
          mrrAt(movements, new Date(w.end.getTime() - 1)) <= 0
        ) {
          lost += 1;
        }
      }
      return base > 0 ? Math.round((lost / base) * 10000) : null;
    };
    return {
      ...base,
      headline: rateIn(window),
      // A point carries a number, so a bucket with no base plots at 0 — the headline is
      // where the distinction survives, as it does for every other rate that draws.
      points: buckets.map((b) => ({ t: b.t, label: b.label, v: rateIn(b) ?? 0 })),
    };
  }

  return {
    ...base,
    headline: countIn(window),
    points: buckets.map((b) => ({ t: b.t, label: b.label, v: countIn(b) })),
  };
}

/**
 * Which path a stock read took, across both stock readers.
 *
 * A probe and gate instrument, not engine state — the same role `countryStockPath` plays for
 * the sliced read, and for the same reason: the number alone is identical whichever path
 * produced it, so only a counter can show which one ran. `bookLoads` is the one that matters
 * — it is how many times the whole subscription book was fetched, and the point of the
 * semantic layer is that a covered report makes it zero.
 */
export const stockPath = { fromStore: 0, missing: 0, bookLoads: 0 };
export function resetStockPath(): void {
  stockPath.fromStore = 0;
  stockPath.missing = 0;
  stockPath.bookLoads = 0;
}

/**
 * The whole subscription book — the read every stock RECONSTRUCTION needs, and the one both
 * stock readers must stop paying for once the semantic layer answers.
 *
 * It is a hot path only because of what follows it: on a 74k-row book the fetch is the small
 * half and the per-instant predicate sweep over those rows is the large one. Both loaders
 * call this lazily, so a report whose every instant is stored never reaches either.
 */
async function loadStockSubscriptions(organizationId: string, businessId: string) {
  stockPath.bookLoads++;
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({
        id: subscriptions.id,
        customerId: subscriptions.customerId,
        status: subscriptions.status,
        currency: subscriptions.currency,
        mrr: subscriptions.mrr,
        // 0271: the rate a cancelled row last carried while it was earning. The column
        // above is 0 once cancelled, so history reads this instead.
        lastEarningMrr: subscriptions.lastEarningMrr,
        createdAt: subscriptions.createdAt,
        startDate: subscriptions.startDate,
        startedAt: subscriptions.startedAt,
        canceledAt: subscriptions.canceledAt,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        cancelScheduledAt: subscriptions.cancelScheduledAt,
        cancelBookedAt: subscriptions.cancelBookedAt,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        trialEnd: subscriptions.trialEnd,
        trialStart: subscriptions.trialStart,
        billingPeriod: subscriptions.billingPeriod,
        billingPeriodUnit: subscriptions.billingPeriodUnit,
        remainingBillingCycles: subscriptions.remainingBillingCycles,
      })
      .from(subscriptions)
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          notDeleted(),
        ),
      );
    return attachLapses(rows, await loadLapses(tx, businessId));
  });
}

type StockSubscription = Awaited<ReturnType<typeof loadStockSubscriptions>>[number];

/** The day an instant belongs to, in the spelling both stores key on. */
const instantDay = (at: Date) => at.toISOString().slice(0, 10);

/** The preload window for `metric_daily`, or today's day when a caller named no instants. */
function storeWindow(instants: readonly Date[], now: Date): { from: string; to: string } {
  const days = instants.map(instantDay).sort();
  return { from: days[0] ?? instantDay(now), to: days[days.length - 1] ?? instantDay(now) };
}

/**
 * Stock at an instant: `metric_daily` when the semantic layer has the day, the live
 * reconstruction when it does not.
 *
 * The fallback is not optional. A cache that is not yet complete must only make a read
 * slower, never change its answer, so both arms are given the SAME `ctx.convert` — counts
 * excluded rather than converted, money converted — and they cannot disagree on scope.
 *
 * `instants` is a preload hint only: it sizes the `metric_daily` query. An instant outside it
 * reads as a miss and falls back, which is the safe direction.
 */
async function loadStockReaders(
  organizationId: string,
  businessId: string,
  ctx: Ctx,
  instants: readonly Date[] = [],
) {
  const store = await loadStockReaderFromMetrics({
    organizationId,
    businessId,
    ...storeWindow(instants, ctx.now),
    convert: ctx.convert,
  });

  /** Fetched once, and only if an instant reaches the reconstruction. */
  let book: Promise<StockSubscription[]> | null = null;
  const loadBook = () => (book ??= loadStockSubscriptions(organizationId, businessId));

  /**
   * The rate each subscription carried AT an instant — the same rule the stored arms were
   * written with, so the three arms answer one number.
   *
   * `subscriptions.mrr` is 0 once a row is cancelled. Summing it verbatim charged every
   * past bucket for a churn that happened after it, which is the defect this closes: on the
   * measured book a day the snapshot arm put at 1,140,200 read 48,500 here.
   *
   * Keyed by day only when the book still holds a cancelled row with no stored earning rate
   * — those are re-rated from their items and only while they were live, so their map is
   * the instant's. With none, the map is the same at every instant and is built once.
   */
  const ratesByKey = new Map<string, Promise<Map<string, bigint>>>();
  const ratesAt = async (at: Date): Promise<Map<string, bigint>> => {
    const subs = await loadBook();
    const perInstant = subs.some((r) => r.status === "cancelled" && r.lastEarningMrr == null);
    const key = perInstant ? instantDay(at) : "*";
    let rates = ratesByKey.get(key);
    if (!rates) {
      rates = withTenant(organizationId, (tx) =>
        loadReratedMrr(tx, businessId, subs as unknown as Parameters<typeof loadReratedMrr>[2], at),
      );
      ratesByKey.set(key, rates);
    }
    return rates;
  };

  // What each row EARNED at an instant — its ledger balance then (`earnedAt`), so a later rate
  // change is not projected backwards. The ledger is read once; each instant sums in memory.
  let ledger: Promise<LedgerRow[]> | null = null;
  const earnedByInstant = new Map<number, Promise<Map<string, bigint>>>();
  const earnedAtInstant = (at: Date): Promise<Map<string, bigint>> => {
    let earned = earnedByInstant.get(at.getTime());
    if (!earned) {
      earned = (async () => {
        ledger ??= withTenant(organizationId, (tx) => loadLedgerRows(tx, businessId));
        const subs = await loadBook();
        const rates = await ratesAt(at);
        const rated = new Map(subs.map((r) => [r.id, rates.get(r.id) ?? r.mrr ?? 0n]));
        return earnedAt(
          subs as unknown as (StockRow & { id: string })[],
          ledgerBalancesAt(await ledger, at),
          rated,
          at,
        );
      })();
      earnedByInstant.set(at.getTime(), earned);
    }
    return earned;
  };
  const bookedAtInstant = async (at: Date): Promise<Set<string>> => {
    ledger ??= withTenant(organizationId, (tx) => loadLedgerRows(tx, businessId));
    return ledgerBookedAt(await ledger, at);
  };

  const reconstruct = (
    subs: StockSubscription[],
    rates: Map<string, bigint>,
    earned: Map<string, bigint>,
    booked: Set<string>,
    at: Date,
    measure: NonNullable<ReportDef["measure"]>,
  ): number => {
    let total = 0;
    for (const r of subs) {
      const s = r as unknown as StockRow;
      const value = Number(earned.get(r.id) ?? 0n);
      if (measure === "cmrr") {
        if (!committedAt(s, at)) continue;
        const committed = Number(
          committedMrrOf(r.id, earned, booked, rates.get(r.id) ?? r.mrr ?? 0n, startOf(s) <= at),
        );
        total += ctx.convert(committed, r.currency, at) ?? 0;
        continue;
      }
      if (measure === "mrr") {
        if (value !== 0) total += ctx.convert(value, r.currency, at) ?? 0;
        continue;
      }
      // Earning per the ledger is active then, whatever the row's (possibly reset) start says.
      const active = value > 0 || (MRR_STATUSES.has(r.status) && liveAt(s, at));
      if (!active || ctx.convert(0, r.currency) == null) continue;
      if (measure === "active_subscriptions") total += 1;
      else if (value > 0 && (measure !== "renewing_subscriptions" || !nonRenewingAt(s, at)))
        total += 1;
    }
    return total;
  };

  /**
   * Customers carrying recurring revenue at an instant.
   *
   * Reconstructed, never read from the store: stored stocks count subscriptions,
   * and a customer with three subscriptions is ONE denominator — a figure no pre-aggregated
   * row can give back. So this is the one measure here with no stored fast path, which is
   * also why it is offered only as a statement about a single instant.
   */
  const payingCustomers = async (at: Date): Promise<number> => {
    const heads = new Set<string>();
    const earned = await earnedAtInstant(at);
    for (const r of await loadBook()) {
      // Same earnings the stocks above read: a customer who churned was paying back then.
      const mrr = Number(earned.get(r.id) ?? 0n);
      if (mrr <= 0 || ctx.convert(0, r.currency) == null) continue;
      heads.add(r.customerId);
    }
    return heads.size;
  };

  return {
    payingCustomers,
    /** How many instants the semantic layer answered, and how many it could not. */
    path: store.path,
    /** Whether the reconstruction was ever reached — the proof the fast path engaged. */
    get bookLoaded() {
      return book != null;
    },
    at: async (at: Date, measure: NonNullable<ReportDef["measure"]>): Promise<number> => {
      const fromStore = store.at(at, measure);
      if (fromStore != null) {
        stockPath.fromStore++;
        return fromStore;
      }
      stockPath.missing++;
      return reconstruct(
        await loadBook(),
        await ratesAt(at),
        await earnedAtInstant(at),
        await bookedAtInstant(at),
        at,
        measure,
      );
    },
  };
}

/**
 * A **customer filter**: a predicate over the stored dimensions, restricting which
 * customers a report is computed from.
 *
 * ⚠️ Not a "segment". `list_views` already documents itself as "a saved list view, or
 * segment" — a named filter set over a LIST of rows on a screen. This is a filter over the
 * CUSTOMERS a metric is computed from, and one word for both would make it impossible to
 * tell which one a screen means. The two names, kept apart everywhere: a **saved view**
 * filters a list; a **customer filter** narrows a report.
 *
 * The filter is never stored. It is a predicate over ATTRIBUTES that are stored — answered
 * by summing rows we already keep per attribute — which is what keeps the snapshot tables
 * bounded: one extra row per attribute VALUE (three countries on the largest real book),
 * not one per filter anybody saves.
 *
 * Syntax: `country:DE`, `country:DE,IN`, `country:unknown` for the customers with no
 * country on file. That bucket is addressable on purpose — it is a real part of the total.
 */
export interface CustomerFilter {
  field: "country";
  /** `null` is the Unknown bucket, spelled `unknown` in the input. */
  values: Array<string | null>;
  /** The filter as given, for the payload and for error messages. */
  raw: string;
}

/**
 * Dimensions a customer filter may be a predicate over.
 *
 * Deliberately NOT currency: a report already takes a `currency`, and a second way to say
 * the same thing is two definitions of scope. Not plan either — a plan is a property of the
 * subscription, not of the customer, and "customers on Pro" and "subscriptions on Pro" are
 * different questions that would look identical in a URL.
 */
export const FILTERABLE_DIMENSIONS = ["country"] as const;

const UNKNOWN_BUCKET = "Unknown";

/**
 * Parse a customer filter, or refuse it BY NAME.
 *
 * A predicate that the stored dimensions cannot express is refused — never answered by
 * reconstructing the book per slice, which is slowest on exactly the book big enough to
 * need slicing. The refusal says which dimension was asked for and which ones exist, so the
 * answer is a next step rather than a dead end.
 */
export function parseCustomerFilter(raw: string, def: ReportDef): CustomerFilter {
  const at = raw.indexOf(":");
  if (at <= 0) {
    throw new ReportError(
      `A customer filter has the form "<dimension>:<value>". For example: "country:DE". ` +
        `Got "${raw}".`,
    );
  }
  const field = raw.slice(0, at).trim().toLowerCase();
  const rest = raw.slice(at + 1).trim();
  if (!(FILTERABLE_DIMENSIONS as readonly string[]).includes(field)) {
    throw new ReportError(
      `Reports cannot be filtered by "${field}": a customer filter must be a predicate over ` +
        `a stored dimension, and the stored dimensions are: ${FILTERABLE_DIMENSIONS.join(", ")}. ` +
        `Filtering by anything else would mean rebuilding the book per slice on every read.`,
    );
  }
  if (!def.dimensions.includes(field as ReportDimension)) {
    throw new ReportError(
      `${def.name} has no stored ${field} dimension, so it cannot be filtered by ${field}.`,
    );
  }
  const values = rest
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "")
    .map((v) => (v.toLowerCase() === "unknown" ? null : v.toUpperCase()));
  if (values.length === 0) {
    throw new ReportError(`A customer filter needs a value: "${field}:<value>".`);
  }
  return { field: "country", values, raw };
}

/**
 * Which path a per-country stock read took.
 *
 * A gate instrument, not engine state. The whole decision behind this dimension is that a
 * sliced stock is SUMMED from pre-aggregated rows instead of rebuilt; a check on the number
 * alone would pass just as happily on the rebuild, so the gate counts the path taken.
 */
export const countryStockPath = { fromSnapshot: 0, reconstructed: 0 };
export function resetCountryStockPath(): void {
  countryStockPath.fromSnapshot = 0;
  countryStockPath.reconstructed = 0;
}

/** Every customer's country, as it stands now. `null` = the Unknown bucket. */
async function loadCustomerCountries(
  organizationId: string,
  businessId: string,
): Promise<Map<string, string | null>> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: customers.id, country: customers.country })
      .from(customers)
      .where(and(eq(customers.businessId, businessId), reportableCustomer(customers.id))),
  );
  return new Map(rows.map((r) => [r.id, r.country ? r.country.toUpperCase() : null]));
}

const countryLabel = (c: string | null) => c ?? UNKNOWN_BUCKET;

/**
 * Stock by customer country: `metric_daily`'s country slice for that day when there is one,
 * the reconstruction when there is not. Same contract as `loadStockReaders` — a cache that
 * is not yet complete must not change the answer.
 */
async function loadCountryStockReaders(
  organizationId: string,
  businessId: string,
  ctx: Ctx,
  instants: Date[],
) {
  const store = await loadStockReaderFromMetrics({
    organizationId,
    businessId,
    ...storeWindow(instants, ctx.now),
    convert: ctx.convert,
    dims: ["country"],
  });

  /**
   * The reconstruction, fetched only when an instant reaches it. On a book the stores cover
   * this reads no subscription and no customer rows at all, which is the point of storing
   * the dimension; `countryStockPath` is what proves it stayed that way.
   */
  type CountrySub = StockRow & { customerId: string; mrr: bigint | null };
  let book: Promise<{
    subs: CountrySub[];
    countries: Map<string, string | null>;
    ledger: LedgerRow[];
  }> | null = null;
  const loadBook = () =>
    (book ??= (async () => ({
      countries: await loadCustomerCountries(organizationId, businessId),
      subs: (await loadStockSubscriptions(organizationId, businessId)) as unknown as CountrySub[],
      ledger: await withTenant(organizationId, (tx) => loadLedgerRows(tx, businessId)),
    }))());

  /** Per-country totals at `at`, already converted and currency-scoped. */
  const breakdown = async (
    at: Date,
    measure: NonNullable<ReportDef["measure"]>,
  ): Promise<Map<string | null, number>> => {
    const acc = new Map<string | null, number>();
    const add = (country: string | null, v: number) =>
      acc.set(country, (acc.get(country) ?? 0) + v);
    // `cmrr` carries no country slice in the store, so it is never asked of it.
    if (measure !== "cmrr") {
      const stored = store.rowsAt(at, measure, "country");
      if (stored) {
        countryStockPath.fromSnapshot++;
        // The writer spells the Unknown bucket "none"; here it is null, as it is everywhere
        // else in this file.
        for (const r of stored) add(r.group_id === "none" ? null : r.group_id, r.value);
        return acc;
      }
    }
    countryStockPath.reconstructed++;
    const { subs, countries, ledger } = await loadBook();
    // Same earnings the total reads (`earnedAt`), so the country rows sum to it.
    const earned = earnedAt(
      subs as unknown as (StockRow & { id: string })[],
      ledgerBalancesAt(ledger, at),
      new Map(subs.map((r) => [r.id, r.mrr ?? 0n])),
      at,
    );
    for (const r of subs) {
      const mrr = Number(earned.get(r.id) ?? 0n);
      const country = countries.get(r.customerId) ?? null;
      if (measure === "mrr") {
        if (mrr === 0) continue;
        const v = ctx.convert(mrr, r.currency, at);
        if (v == null) continue;
        add(country, v);
      } else {
        if (!(mrr > 0 || (MRR_STATUSES.has(r.status) && liveAt(r, at)))) continue;
        if (ctx.convert(0, r.currency) == null) continue;
        if (measure === "paying_subscriptions" && mrr <= 0) continue;
        if (measure === "renewing_subscriptions" && (mrr <= 0 || nonRenewingAt(r, at))) continue;
        add(country, 1);
      }
    }
    return acc;
  };

  return {
    /** How many instants the semantic layer answered, and how many it could not. */
    path: store.path,
    /** Whether the reconstruction was ever reached — the proof the fast path engaged. */
    get bookLoaded() {
      return book != null;
    },
    /** The breakdown at `at`, heaviest first. */
    rowsAt: async (at: Date, measure: NonNullable<ReportDef["measure"]>): Promise<ReportRow[]> =>
      [...(await breakdown(at, measure)).entries()]
        .map(([country, value]) => ({
          group: countryLabel(country),
          group_id: country,
          value,
        }))
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
    /** The total over a filter's countries at `at` — the same rows, summed. */
    totalAt: async (
      at: Date,
      measure: NonNullable<ReportDef["measure"]>,
      values: Array<string | null>,
    ): Promise<number> => {
      let total = 0;
      for (const [country, v] of await breakdown(at, measure)) {
        if (values.includes(country)) total += v;
      }
      return total;
    },
  };
}

/**
 * The window every `derived` rate is quoted over: the last COMPLETE month, cut in the
 * BUSINESS's timezone.
 *
 * Not UTC. Cutting it in UTC cost a real disagreement the first time this ran: on an
 * Asia/Kolkata book the dashboard reported a quick ratio of 5.67× and this resolver 6.09×,
 * from the same ledger — five and a half hours of movement landing in different months. Two
 * calendars is precisely the failure the registry exists to prevent, so the month comes from
 * the same helper the dashboard uses.
 */
async function lastCompleteMonth(organizationId: string, businessId: string, now: Date) {
  const [biz] = await withTenant(organizationId, (tx) =>
    tx
      .select({ timezone: businesses.timezone })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1),
  );
  const windows = await withTenant(organizationId, (tx) =>
    calendarWindows(tx, biz?.timezone ?? "UTC", now),
  );
  return { start: windows.lastMonth.start, end: windows.lastMonth.end };
}

/**
 * Group a set of already-filtered rows by CURRENCY.
 *
 * Shared across the sources because the answer must be the same everywhere: the amounts stay
 * in the currency they were earned in — converting and then splitting by currency would
 * produce a table whose rows are all in one currency and labelled with another.
 */
function groupByCurrency(
  rows: Array<{ currency: string; amount: number }>,
  scoped: string | null,
): ReportRow[] {
  const acc = new Map<string, ReportRow>();
  for (const r of rows) {
    const ccy = r.currency.toUpperCase();
    if (scoped && ccy !== scoped) continue;
    const row = acc.get(ccy) ?? { group: ccy, group_id: ccy, value: 0 };
    row.value += r.amount;
    acc.set(ccy, row);
  }
  return [...acc.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

/** Invoice statuses that represent money actually billed. */
const BILLED_STATUSES = new Set(["posted", "payment_due", "not_paid", "paid"]);
/** …and the subset still owed. */
const UNPAID_STATUSES = new Set(["posted", "payment_due", "not_paid"]);

const DAY = 86_400_000;

/** The span every bucket lies in — what a loader can bound its WHERE by. */
function bucketSpan(buckets: readonly Bucket[]): { start: Date; end: Date } {
  let start = buckets[0]!.start;
  let end = buckets[0]!.end;
  for (const b of buckets) {
    if (b.start < start) start = b.start;
    if (b.end > end) end = b.end;
  }
  return { start, end };
}

/**
 * Calls `fn` with the index of every bucket holding `at`. A binary search when the buckets
 * are sorted and disjoint (every series here), else a scan — so a series is one pass over
 * the rows, not one per bucket.
 */
function bucketLocator(buckets: readonly Bucket[]): (at: Date, fn: (i: number) => void) => void {
  const disjoint = buckets.every((b, i) => i === 0 || buckets[i - 1]!.end <= b.start);
  if (!disjoint) {
    return (at, fn) => buckets.forEach((b, i) => at >= b.start && at < b.end && fn(i));
  }
  return (at, fn) => {
    let lo = 0;
    let hi = buckets.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (buckets[mid]!.start <= at) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found >= 0 && at < buckets[found]!.end) fn(found);
  };
}

/**
 * The invoice-side resolver.
 *
 * Every measure here is a sum over the invoices (or their lines) that fall in a window,
 * except the `buckets` shapes, which answer with rows: an ageing ladder is a report ABOUT
 * its buckets, and inventing them in the client would put the report's definition in two
 * places.
 */
async function resolveInvoiceReport(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
  groupBy?: string,
): Promise<ReportResult> {
  const agingOnly = def.shape === "buckets" && def.bucketing === "ar_aging";
  // Only the invoices that can reach this report: its window and its definition, in SQL.
  const span = bucketSpan(buckets);
  const between = (col: AnyPgColumn) => and(gte(col, span.start), lt(col, span.end))!;
  const billedInSpan = and(
    inArray(invoices.status, [...BILLED_STATUSES] as never[]),
    between(invoices.createdAt),
  )!;
  let scope: SQL | undefined;
  if (def.shape === "buckets") {
    if (def.bucketing === "recovery_aging") {
      scope = and(eq(invoices.status, "paid" as never), between(invoices.paidAt));
    } else if (def.bucketing === "dunning_status") {
      scope = isNotNull(invoices.dunningStatus);
    } else if (def.bucketing === "coupon_leakage") {
      scope = sql`false`; // reads the discounts, not the invoices
    }
  } else {
    switch (def.metric) {
      case "billing":
      case "net_billing":
      case "non_recurring_billing":
      case "revenue_leakage":
      case "taxes":
      case "taxable_base":
      case "exempt_base":
        scope = billedInSpan;
        break;
      case "voided":
        scope = between(invoices.voidedAt);
        break;
      case "written_off":
        scope = and(eq(invoices.writtenOff, true), between(invoices.createdAt));
        break;
      case "amount_recovered":
        scope = and(eq(invoices.dunningStatus, "succeeded"), between(invoices.paidAt));
        break;
      default:
        scope = sql`false`;
    }
    // The currency rows are billed invoices in the window, whatever the measure.
    if (groupBy === "currency") scope = or(scope, billedInSpan);
  }
  const invoiceWhere = and(
    and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)),
    scope,
  );
  const { rows, paidByInvoice } = await withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({
        id: invoices.id,
        status: invoices.status,
        currency: invoices.currency,
        totalMinor: invoices.totalMinor,
        amountDueMinor: invoices.amountDueMinor,
        createdAt: invoices.createdAt,
        dueDate: invoices.dueDate,
        paidAt: invoices.paidAt,
        voidedAt: invoices.voidedAt,
        writtenOff: invoices.writtenOff,
        dunningStatus: invoices.dunningStatus,
      })
      .from(invoices)
      .where(
        and(
          invoiceWhere,
          // The ladder reads unpaid, not-written-off invoices only: filter here rather than
          // load the whole book (66k rows on production) to keep six.
          ...(agingOnly
            ? [
                inArray(invoices.status, [...UNPAID_STATUSES] as never[]),
                eq(invoices.writtenOff, false),
              ]
            : []),
        ),
      );
    // Only the ageing ladder needs cash, and it needs it for the open invoices alone —
    // one batched query on the same read, never a lookup per invoice.
    const needsCash = def.shape === "buckets" && def.bucketing === "ar_aging";
    const paidByInvoice = needsCash
      ? await paidTotals(
          tx,
          rows.filter((i) => UNPAID_STATUSES.has(i.status) && !i.writtenOff).map((i) => i.id),
        )
      : new Map<string, bigint>();
    return { rows, paidByInvoice };
  });

  /**
   * WHAT IS STILL OWED ON ONE INVOICE — the same rule as the stored measure and as
   * Business Home, not a third definition.
   *
   * `amount_due_minor` is the issue-time collectible, net of credits only, and is never
   * decremented as cash arrives. Summing it raw reports settled invoices as still owing.
   * Subtracted in BIGINT and floored at zero — an overpayment is not negative receivables —
   * with only the result handed to `convert`, so no minor unit is lost before the FX.
   */
  const outstandingMinor = (i: {
    id: string;
    amountDueMinor: bigint | null;
    totalMinor: bigint;
  }): bigint => {
    const remaining = (i.amountDueMinor ?? i.totalMinor) - (paidByInvoice.get(i.id) ?? 0n);
    return remaining > 0n ? remaining : 0n;
  };

  const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
  const inWindow = (at: Date | null, w: { start: Date; end: Date }) =>
    at != null && at >= w.start && at < w.end;

  // ── Bucketed answers ───────────────────────────────────────────────────────
  if (def.shape === "buckets") {
    const out: ReportRow[] = [];
    if (def.bucketing === "ar_aging") {
      /**
       * Ageing is measured from the DUE date, not the issue date: an invoice with 30-day
       * terms is not overdue on the day it is raised, and an ageing ladder that says
       * otherwise reports a collections problem that does not exist.
       *
       * The ladder itself comes from `invoicing/ar-aging`, which is also what the list
       * filter drills through. It was a second copy here, agreeing only because a gate
       * compared the two string for string — and the rung names ARE the filter's
       * vocabulary, so a drifted label is a drill-down that silently matches nothing.
       */
      const { edges: ladder, labels } = arAgingLadder(ctx.agingInterval);
      const totals: number[] = new Array(labels.length).fill(0);
      for (const i of rows) {
        if (!UNPAID_STATUSES.has(i.status) || i.writtenOff) continue;
        // An invoice whose balance is settled is not receivable, whatever its status says.
        const owedMinor = outstandingMinor(i);
        if (owedMinor === 0n) continue;
        const owed = ctx.convert(Number(owedMinor), i.currency);
        if (owed == null) continue;
        const overdueMs = i.dueDate ? ctx.now.getTime() - i.dueDate.getTime() : 0;
        if (overdueMs <= 0) {
          totals[0] = (totals[0] ?? 0) + owed;
          continue;
        }
        const days = Math.floor(overdueMs / DAY);
        let idx = ladder.findIndex((d) => days <= d);
        idx = idx === -1 ? labels.length - 1 : idx + 1;
        totals[idx] = (totals[idx] ?? 0) + owed;
      }
      labels.forEach((label, i) =>
        out.push({ group: label, group_id: null, value: totals[i] ?? 0 }),
      );
    } else if (def.bucketing === "recovery_aging") {
      const labels = ["Paid on time", "1–30 days late", "31–60 days late", "60+ days late"];
      const totals: number[] = [0, 0, 0, 0];
      for (const i of rows) {
        if (i.status !== "paid" || !i.paidAt || !inWindow(i.paidAt, window)) continue;
        const v = ctx.convert(Number(i.totalMinor), i.currency, i.paidAt);
        if (v == null) continue;
        const lateMs = i.dueDate ? i.paidAt.getTime() - i.dueDate.getTime() : 0;
        const days = Math.floor(lateMs / DAY);
        const slot = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : 3;
        totals[slot] = (totals[slot] ?? 0) + v;
      }
      labels.forEach((label, i) =>
        out.push({ group: label, group_id: null, value: totals[i] ?? 0 }),
      );
    } else if (def.bucketing === "dunning_status") {
      const acc = new Map<string, number>();
      for (const i of rows) {
        if (!i.dunningStatus) continue;
        if (ctx.convert(0, i.currency) == null) continue;
        acc.set(i.dunningStatus, (acc.get(i.dunningStatus) ?? 0) + 1);
      }
      for (const [status, n] of acc) out.push({ group: status, group_id: null, value: n });
      out.sort((a, b) => b.value - a.value);
    } else if (def.bucketing === "coupon_leakage") {
      // A discount has no currency of its own; it belongs to the invoice, so the invoice
      // is what says which currency the amount is in. Without that join every amount was
      // summed as a bare number, which adds paise to dollars on a multi-currency book.
      const discounts = await withTenant(organizationId, (tx) =>
        tx
          .select({
            amountMinor: invoiceLineDiscounts.amountMinor,
            label: invoiceLineDiscounts.label,
            appliedCouponId: invoiceLineDiscounts.appliedCouponId,
            createdAt: invoiceLineDiscounts.createdAt,
            currency: invoices.currency,
          })
          .from(invoiceLineDiscounts)
          .innerJoin(invoices, eq(invoiceLineDiscounts.invoiceId, invoices.id))
          .where(
            and(
              eq(invoiceLineDiscounts.businessId, businessId),
              reportableCustomer(invoices.customerId),
              between(invoiceLineDiscounts.createdAt),
              // Same total as `total_revenue_leakage`: not a 100%-off invoice.
              sql`${invoices.totalMinor} > 0`,
            ),
          ),
      );
      const acc = new Map<string, ReportRow>();
      for (const d of discounts) {
        if (!inWindow(d.createdAt, window)) continue;
        // `convert` returns null for an amount the reporting currency cannot state — a
        // currency with no rate, or one filtered out by an explicit `currency=`. Excluded
        // rather than counted raw: a wrong total is worse than a smaller one.
        const v = ctx.convert(Number(d.amountMinor), d.currency, d.createdAt);
        if (v == null) continue;
        const key = d.appliedCouponId ?? d.label ?? "Ad-hoc discount";
        const row = acc.get(key) ?? {
          group: d.label ?? "Ad-hoc discount",
          group_id: null,
          value: 0,
        };
        row.value += v;
        acc.set(key, row);
      }
      out.push(...[...acc.values()].sort((a, b) => b.value - a.value));
    }
    return { ...base, headline: out.reduce((n, r) => n + r.value, 0), points: [], rows: out };
  }

  // ── Summed answers ─────────────────────────────────────────────────────────
  // Lines and taxes of the invoices this report reads, not of the whole book.
  const inScopeIds = (tx: Tx) => tx.select({ id: invoices.id }).from(invoices).where(invoiceWhere);
  const lines =
    def.metric === "non_recurring_billing" ||
    def.metric === "taxes" ||
    def.metric === "taxable_base" ||
    def.metric === "exempt_base" ||
    def.metric === "revenue_leakage"
      ? await withTenant(organizationId, (tx) =>
          tx
            .select({
              invoiceId: invoiceLineItems.invoiceId,
              kind: invoiceLineItems.kind,
              amountMinor: invoiceLineItems.amountMinor,
              discountMinor: invoiceLineItems.discountMinor,
            })
            .from(invoiceLineItems)
            .where(
              and(
                eq(invoiceLineItems.businessId, businessId),
                inArray(invoiceLineItems.invoiceId, inScopeIds(tx)),
              ),
            ),
        )
      : [];
  const taxes =
    def.metric === "taxes" || def.metric === "taxable_base" || def.metric === "exempt_base"
      ? await withTenant(organizationId, (tx) =>
          tx
            .select({
              invoiceId: appliedTaxes.invoiceId,
              amountMinor: appliedTaxes.amountMinor,
              taxabilityReason: appliedTaxes.taxabilityReason,
              invoiceLineItemId: appliedTaxes.invoiceLineItemId,
            })
            .from(appliedTaxes)
            .where(
              and(
                eq(appliedTaxes.businessId, businessId),
                inArray(appliedTaxes.invoiceId, inScopeIds(tx)),
              ),
            ),
        )
      : [];
  const creditNoteRows =
    def.metric === "net_billing"
      ? await withTenant(organizationId, (tx) =>
          tx
            .select({
              currency: creditNotes.currency,
              totalMinor: creditNotes.totalMinor,
              createdAt: creditNotes.createdAt,
            })
            .from(creditNotes)
            .where(
              and(
                and(
                  eq(creditNotes.businessId, businessId),
                  reportableCustomer(creditNotes.customerId),
                ),
                between(creditNotes.createdAt),
              ),
            ),
        )
      : [];

  const lineAmountByInvoice = new Map<string, { nonRecurring: number; discount: number }>();
  for (const l of lines) {
    const acc = lineAmountByInvoice.get(l.invoiceId) ?? { nonRecurring: 0, discount: 0 };
    if (l.kind === "one_time") acc.nonRecurring += Number(l.amountMinor);
    acc.discount += Number(l.discountMinor ?? 0n);
    lineAmountByInvoice.set(l.invoiceId, acc);
  }
  const taxByInvoice = new Map<string, { charged: number; exemptLines: Set<string> }>();
  for (const t of taxes) {
    const acc = taxByInvoice.get(t.invoiceId) ?? { charged: 0, exemptLines: new Set<string>() };
    acc.charged += Number(t.amountMinor);
    if (t.taxabilityReason !== "standard_rated" && t.invoiceLineItemId) {
      acc.exemptLines.add(t.invoiceLineItemId);
    }
    taxByInvoice.set(t.invoiceId, acc);
  }

  const lineTotalByInvoice = new Map<string, number>();
  if (def.metric === "exempt_base") {
    for (const l of lines) {
      lineTotalByInvoice.set(
        l.invoiceId,
        (lineTotalByInvoice.get(l.invoiceId) ?? 0) + Number(l.amountMinor),
      );
    }
  }

  /** The instant an invoice counts at, or null when this measure does not count it. */
  const countedAt = (i: (typeof rows)[number]): Date | null => {
    switch (def.metric) {
      case "billing":
      case "net_billing":
      case "non_recurring_billing":
      case "revenue_leakage":
      case "taxes":
      case "taxable_base":
      case "exempt_base":
        return BILLED_STATUSES.has(i.status) ? i.createdAt : null;
      case "voided":
        return i.voidedAt;
      case "written_off":
        return i.writtenOff ? i.createdAt : null;
      case "amount_recovered":
        // Went into dunning and was paid in the end — the money collections saved.
        return i.dunningStatus === "succeeded" ? i.paidAt : null;
      default:
        return null;
    }
  };

  /**
   * What one invoice adds — at the rate held when it was raised, or voided, or paid, where
   * that is the event the figure counts.
   */
  const amountOf = (i: (typeof rows)[number], at: Date): number => {
    const conv = (n: number) => ctx.convert(n, i.currency, at) ?? 0;
    switch (def.metric) {
      case "non_recurring_billing":
        return conv(lineAmountByInvoice.get(i.id)?.nonRecurring ?? 0);
      case "revenue_leakage":
        // Not on an invoice a discount took to zero: nothing was given up there.
        return Number(i.totalMinor) > 0 ? conv(lineAmountByInvoice.get(i.id)?.discount ?? 0) : 0;
      case "taxes":
        return conv(taxByInvoice.get(i.id)?.charged ?? 0);
      case "taxable_base":
        // The base tax was charged ON: the document total less the tax itself. Stated
        // this way rather than summed from lines, because a line can be partly exempt and
        // the invoice total is the figure the document shows.
        return conv(Number(i.totalMinor) - (taxByInvoice.get(i.id)?.charged ?? 0));
      case "exempt_base":
        if ((taxByInvoice.get(i.id)?.exemptLines.size ?? 0) === 0) return 0;
        return conv(lineTotalByInvoice.get(i.id) ?? 0);
      default:
        return conv(Number(i.totalMinor));
    }
  };

  // One pass: each counted row lands in the headline and in the bucket that holds it.
  const locate = bucketLocator(buckets);
  let headline = 0;
  const series = new Array<number>(buckets.length).fill(0);
  const add = (at: Date, v: number) => {
    if (inWindow(at, window)) headline += v;
    locate(at, (k) => (series[k]! += v));
  };
  for (const i of rows) {
    const at = countedAt(i);
    if (at == null) continue;
    add(at, amountOf(i, at));
  }
  if (def.metric === "net_billing") {
    for (const c of creditNoteRows) {
      add(c.createdAt, -(ctx.convert(Number(c.totalMinor), c.currency, c.createdAt) ?? 0));
    }
  }

  const result: ReportResult = {
    ...base,
    headline,
    points: buckets.map((b, k) => ({ t: b.t, label: b.label, v: series[k]! })),
  };
  if (groupBy === "currency") {
    // Per currency, the figures stay in their OWN currency: converting first and then
    // labelling the row with the source currency would print dollars under "INR".
    result.rows = groupByCurrency(
      rows
        .filter(
          (i) =>
            BILLED_STATUSES.has(i.status) &&
            i.createdAt >= window.start &&
            i.createdAt < window.end,
        )
        .map((i) => ({ currency: i.currency, amount: Number(i.totalMinor) })),
      ctx.scoped,
    );
  }
  return result;
}

/**
 * The Account Summary: one row per month, and it RECONCILES or it does not ship.
 *
 * **Net = Gross billing − Discounts + Taxes − Credit notes − Written off**, which is the
 * same statement as **Net = the billed document totals, less credit notes and write-offs**.
 * Both forms hold exactly, because `Gross billing` is DERIVED as
 * `document total + discounts − taxes` per invoice rather than re-summed from the lines:
 * that way the row cannot depend on an assumption about how a document total was composed,
 * and every term is converted independently so the identity survives FX rounding.
 *
 * Read the columns as: what we would have charged at list price (gross), what we gave away
 * (discounts), what we collected for a tax authority (taxes — in Net because it is in the
 * document total and in the credit note), what we credited back, and what we abandoned.
 *
 * Two figures are deliberately NOT here, because they cannot be a term of a monthly net:
 *  - **Voided invoices.** A voided invoice is `status='voided'`, so it never entered Gross
 *    billing — subtracting it would take out money the row never counted. Worse, voiding
 *    can happen months after the billing, so the two would sit on different rows.
 *  - **Amounts recovered**, for the same timing reason: a payment settles an invoice from an
 *    earlier month, so it belongs to a payments report, not to a billing reconciliation.
 * Both are their own reports (`total_amount_voided`, `total_amount_recovered`). Fewer
 * columns that add up beat a wider table that does not.
 *
 * Write-offs and credit notes DO sit here, on their own date (the invoice's creation for a
 * write-off, the note's for a credit note) — that is the convention a finance reader expects,
 * and the row's arithmetic holds whichever month they fall in.
 */
async function resolveAccountSummary(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  // The twelve months the table shows, and only the documents inside them.
  const from = addUtcMonths(utcMonthStart(ctx.now), -11);
  const to = addUtcMonths(utcMonthStart(ctx.now), 1);
  const billedInTable = and(
    and(eq(invoices.businessId, businessId), reportableCustomer(invoices.customerId)),
    inArray(invoices.status, [...BILLED_STATUSES] as never[]),
    gte(invoices.createdAt, from),
    lt(invoices.createdAt, to),
  );
  const inTable = (tx: Tx) => tx.select({ id: invoices.id }).from(invoices).where(billedInTable);
  const [invoiceRows, lines, taxRows, creditNoteRows] = await Promise.all([
    withTenant(organizationId, (tx) =>
      tx
        .select({
          id: invoices.id,
          status: invoices.status,
          currency: invoices.currency,
          totalMinor: invoices.totalMinor,
          createdAt: invoices.createdAt,
          writtenOff: invoices.writtenOff,
        })
        .from(invoices)
        .where(billedInTable),
    ),
    withTenant(organizationId, (tx) =>
      tx
        .select({
          invoiceId: invoiceLineItems.invoiceId,
          discountMinor: invoiceLineItems.discountMinor,
        })
        .from(invoiceLineItems)
        .where(
          and(
            eq(invoiceLineItems.businessId, businessId),
            inArray(invoiceLineItems.invoiceId, inTable(tx)),
          ),
        ),
    ),
    withTenant(organizationId, (tx) =>
      tx
        .select({ invoiceId: appliedTaxes.invoiceId, amountMinor: appliedTaxes.amountMinor })
        .from(appliedTaxes)
        .where(
          and(
            eq(appliedTaxes.businessId, businessId),
            inArray(appliedTaxes.invoiceId, inTable(tx)),
          ),
        ),
    ),
    withTenant(organizationId, (tx) =>
      tx
        .select({
          currency: creditNotes.currency,
          totalMinor: creditNotes.totalMinor,
          createdAt: creditNotes.createdAt,
        })
        .from(creditNotes)
        .where(
          and(
            and(eq(creditNotes.businessId, businessId), reportableCustomer(creditNotes.customerId)),
            gte(creditNotes.createdAt, from),
            lt(creditNotes.createdAt, to),
          ),
        ),
    ),
  ]);

  const discountByInvoice = new Map<string, number>();
  for (const l of lines) {
    discountByInvoice.set(
      l.invoiceId,
      (discountByInvoice.get(l.invoiceId) ?? 0) + Number(l.discountMinor ?? 0n),
    );
  }
  const taxByInvoice = new Map<string, number>();
  for (const t of taxRows) {
    taxByInvoice.set(t.invoiceId, (taxByInvoice.get(t.invoiceId) ?? 0) + Number(t.amountMinor));
  }

  const columns = [
    { key: "gross_billing", label: "Gross billing" },
    { key: "discounts", label: "Discounts" },
    { key: "taxes", label: "Taxes" },
    { key: "credit_notes", label: "Credit notes" },
    { key: "written_off", label: "Written off" },
    { key: "net", label: "Net" },
  ];

  const mult = def.multiplier ?? 1;
  const out: NonNullable<ReportResult["table"]>["rows"] = [];
  for (let i = 0; i < 12; i++) {
    const start = addUtcMonths(utcMonthStart(ctx.now), -i);
    const end = addUtcMonths(start, 1);
    let gross = 0;
    let discounts = 0;
    let taxes = 0;
    let writtenOff = 0;
    let creditNotesTotal = 0;

    for (const inv of invoiceRows) {
      if (!BILLED_STATUSES.has(inv.status)) continue;
      if (inv.createdAt < start || inv.createdAt >= end) continue;
      const conv = (n: number) => ctx.convert(n, inv.currency, inv.createdAt);
      const billed = conv(Number(inv.totalMinor));
      if (billed == null) continue;
      const disc = conv(discountByInvoice.get(inv.id) ?? 0) ?? 0;
      const tax = conv(taxByInvoice.get(inv.id) ?? 0) ?? 0;
      gross += billed + disc - tax;
      discounts += disc;
      taxes += tax;
      if (inv.writtenOff) writtenOff += billed;
    }
    for (const c of creditNoteRows) {
      if (c.createdAt < start || c.createdAt >= end) continue;
      creditNotesTotal += ctx.convert(Number(c.totalMinor), c.currency, c.createdAt) ?? 0;
    }

    const net = gross - discounts + taxes - creditNotesTotal - writtenOff;
    out.push({
      period: `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
      values: [gross, discounts, taxes, creditNotesTotal, writtenOff, net].map((v) => v * mult),
    });
  }

  return {
    ...base,
    // This month's Net — what the current month leaves after credits and write-offs. Found
    // by column key, never by index: a widened table is how a headline silently became $0.
    headline: out[0]?.values[columns.findIndex((c) => c.key === "net")] ?? null,
    points: [],
    table: { columns, rows: out },
  };
}

/** The transaction-side resolver: money that moved, and the attempts that did not. */
async function resolveTransactionReport(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
  groupBy?: string,
): Promise<ReportResult> {
  // Only the attempts that can reach this report: its window, type and outcome, in SQL.
  const span = bucketSpan(buckets);
  const byType = (type: string) => eq(transactions.type, type);
  const success = eq(transactions.status, "succeeded");
  let scope: SQL | undefined;
  if (def.shape === "buckets") {
    const byStatus = def.bucketing === "payment_status" || def.bucketing === "refund_status";
    const refund = def.bucketing === "refund_errors" || def.bucketing === "refund_status";
    scope = and(
      byType(refund ? "refund" : "payment"),
      byStatus ? undefined : ne(transactions.status, "succeeded"),
    );
  } else {
    switch (def.metric) {
      case "payments":
        scope = and(byType("payment"), success);
        break;
      case "refunds":
        scope = and(byType("refund"), success);
        break;
      case "net_payments":
        scope = and(inArray(transactions.type, ["payment", "refund"]), success);
        break;
      case "failed_payments":
        scope = and(byType("payment"), ne(transactions.status, "succeeded"));
        break;
      case "failed_refunds":
        scope = and(byType("refund"), ne(transactions.status, "succeeded"));
        break;
      case "payment_transactions":
        scope = byType("payment");
        break;
      case "refund_transactions":
        scope = byType("refund");
        break;
      default:
        scope = sql`false`;
    }
    // The currency rows read successful payments (and refunds, for net).
    if (groupBy === "currency") {
      scope = or(scope, and(inArray(transactions.type, ["payment", "refund"]), success));
    }
  }
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        type: transactions.type,
        status: transactions.status,
        currency: transactions.currency,
        amountMinor: transactions.amountMinor,
        errorCode: transactions.errorCode,
        occurredAt: transactions.occurredAt,
      })
      .from(transactions)
      .where(
        and(
          and(eq(transactions.businessId, businessId), reportableCustomer(transactions.customerId)),
          gte(transactions.occurredAt, span.start),
          lt(transactions.occurredAt, span.end),
          scope,
        ),
      ),
  );
  const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
  const inW = (at: Date, w: { start: Date; end: Date }) => at >= w.start && at < w.end;

  if (def.shape === "buckets") {
    const byStatus = def.bucketing === "payment_status" || def.bucketing === "refund_status";
    const wantType =
      def.bucketing === "refund_errors" || def.bucketing === "refund_status" ? "refund" : "payment";
    const acc = new Map<string, number>();
    for (const t of rows) {
      if (t.type !== wantType) continue;
      // An error breakdown asks about failures; a STATUS summary asks about all of them —
      // every attempt lands in exactly one status row, so the rows sum to the count report
      // beside them rather than to its failed subset.
      if (!byStatus && t.status === "succeeded") continue;
      if (!inW(t.occurredAt, window)) continue;
      if (ctx.convert(0, t.currency) == null) continue;
      if (byStatus) {
        acc.set(t.status, (acc.get(t.status) ?? 0) + 1);
        continue;
      }
      // An unnamed failure is still a failure: bucketing it as "Unspecified" keeps the rows
      // summing to the count above them.
      const key = t.errorCode ?? "Unspecified";
      acc.set(key, (acc.get(key) ?? 0) + 1);
    }
    const out = [...acc.entries()]
      .map(([group, value]) => ({ group, group_id: null, value }))
      .sort((a, b) => b.value - a.value);
    return { ...base, headline: out.reduce((n, r) => n + r.value, 0), points: [], rows: out };
  }

  /** What one attempt adds to this measure. */
  const amountOf = (t: (typeof rows)[number]): number => {
    const amount = () => ctx.convert(Number(t.amountMinor), t.currency, t.occurredAt) ?? 0;
    const counted = () => (ctx.convert(0, t.currency) != null ? 1 : 0);
    switch (def.metric) {
      case "payments":
        return t.type === "payment" && t.status === "succeeded" ? amount() : 0;
      case "refunds":
        return t.type === "refund" && t.status === "succeeded" ? amount() : 0;
      case "net_payments":
        if (t.status !== "succeeded") return 0;
        return t.type === "payment" ? amount() : t.type === "refund" ? -amount() : 0;
      case "failed_payments":
        return t.type === "payment" && t.status !== "succeeded" ? counted() : 0;
      case "failed_refunds":
        return t.type === "refund" && t.status !== "succeeded" ? counted() : 0;
      // Counts of the attempts themselves, whatever their outcome — which is what makes
      // the status summary beside each one add up to it.
      case "payment_transactions":
        return t.type === "payment" ? counted() : 0;
      case "refund_transactions":
        return t.type === "refund" ? counted() : 0;
      default:
        return 0;
    }
  };

  // One pass: each row lands in the headline and in the bucket that holds it.
  const locate = bucketLocator(buckets);
  let headline = 0;
  const series = new Array<number>(buckets.length).fill(0);
  for (const t of rows) {
    const v = amountOf(t);
    if (inW(t.occurredAt, window)) headline += v;
    locate(t.occurredAt, (k) => (series[k]! += v));
  }

  const result: ReportResult = {
    ...base,
    headline,
    points: buckets.map((b, k) => ({ t: b.t, label: b.label, v: series[k]! })),
  };
  if (groupBy === "currency") {
    const wanted = def.metric === "refunds" ? "refund" : "payment";
    result.rows = groupByCurrency(
      rows
        .filter(
          (t) =>
            t.status === "succeeded" &&
            (def.metric === "net_payments"
              ? t.type === "payment" || t.type === "refund"
              : t.type === wanted) &&
            t.occurredAt >= window.start &&
            t.occurredAt < window.end,
        )
        .map((t) => ({
          currency: t.currency,
          amount:
            t.type === "refund" && def.metric === "net_payments"
              ? -Number(t.amountMinor)
              : Number(t.amountMinor),
        })),
      ctx.scoped,
    );
  }
  return result;
}

/**
 * Cash, placed on the invoice lines it settled.
 *
 * The cash-side twin of the billing metrics: `total_non_recurring_billing` says what we
 * CHARGED for one-off items, this says what we COLLECTED against them, and the gap is
 * whatever is unpaid, refunded or paid in a later period. The split itself is
 * `modules/payments/attribution.ts` — pro-rata across every line, never a priority rule,
 * with Σ allocations equal to the payment by construction.
 *
 * ⚠️ **These do not sum to `total_payments`, and should not be expected to.** That report
 * sums `transactions` — what the gateway moved — and these sum `payments` — what was applied
 * to a document. They agree on a book this engine billed itself, and diverge on a payment
 * with no transaction row and on an imported transaction that settled several invoices, where
 * the importer stores the applied amount on the payment and the full amount on the
 * transaction. Each is right about its own question; neither is a check on the other.
 *
 * **Gross unless the report says net.** `recurring_payments` counts money in; refunds are
 * their own direction and would otherwise net silently into a figure named "collected".
 * `net_recurring_payments` opts in, and because both run through the SAME allocator the
 * pair cannot disagree about what a recurring line is.
 *
 * Currency is the only dimension. The attribution rows carry a subscription id, so grouping
 * by plan looks free — but a plan is resolved from the subscription's items AS THEY ARE NOW,
 * and cash collected two years ago against a plan the customer has since left would be filed
 * under the current one. The movement ledger stores the plan WITH the row precisely because
 * that is not good enough; until cash has the same, this offers no plan cut rather than a
 * wrong one.
 */
async function resolvePaymentReport(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
  groupBy?: string,
): Promise<ReportResult> {
  const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
  const net = def.metric === "net_recurring_cash";
  const rows = await attributePaymentsForBusiness({
    organizationId,
    businessId,
    from: window.start,
    // The query bound is inclusive and a bucket's end is not, so the last instant of the
    // window would otherwise pull in a payment the buckets go on to exclude.
    to: new Date(window.end.getTime() - 1),
    includeRefunds: net,
  });

  if (def.bucketing === "cash_composition") {
    // Gross, so this reconciles with `total_payments` beside it AND its recurring row
    // equals `recurring_payments` — an identity `verify:reports` pins.
    const acc = new Map<PaymentBucket, number>();
    for (const r of rows) {
      if (r.direction !== "payment") continue;
      for (const b of PAYMENT_BUCKETS) {
        const v = ctx.convert(Number(r.buckets[b]), r.currency, r.occurredAt);
        if (v == null || v === 0) continue;
        acc.set(b, (acc.get(b) ?? 0) + v);
      }
    }
    const out = [...acc.entries()]
      .map(([b, value]) => ({ group: CASH_BUCKET_LABELS[b], group_id: b, value }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return { ...base, headline: out.reduce((n, r) => n + r.value, 0), points: [], rows: out };
  }

  const measureOf = (r: PaymentAttribution): bigint => {
    switch (def.metric) {
      case "non_recurring_cash":
        return r.nonRecurringMinor;
      case "usage_cash":
        return r.usageMinor;
      // Gross and net read the same measure; they differ only in whether the refund rows
      // were fetched at all, which is what keeps one definition of "recurring".
      default:
        return r.recurringMinor;
    }
  };

  const sumIn = (w: { start: Date; end: Date }): number => {
    let total = 0;
    for (const r of rows) {
      if (r.occurredAt < w.start || r.occurredAt >= w.end) continue;
      const v = ctx.convert(Number(measureOf(r)), r.currency, r.occurredAt);
      if (v == null) continue;
      total += v;
    }
    return total;
  };

  const result: ReportResult = {
    ...base,
    headline: sumIn(window),
    points: buckets.map((b) => ({ t: b.t, label: b.label, v: sumIn(b) })),
  };
  if (groupBy === "currency") {
    result.rows = groupByCurrency(
      rows
        .filter((r) => r.occurredAt >= window.start && r.occurredAt < window.end)
        .map((r) => ({ currency: r.currency, amount: Number(measureOf(r)) })),
      ctx.scoped,
    );
  }
  return result;
}

/** The composition rows, in the operator's language rather than the schema's. */
const CASH_BUCKET_LABELS: Record<PaymentBucket, string> = {
  recurring: "Subscription fees",
  proration: "Prorated changes",
  usage: "Metered usage",
  one_time: "One-off charges",
  discount: "Discounts",
  tax: "Tax",
  rounding: "Rounding",
  other: "Other",
  unattributed: "Not attributable to a line",
};

/**
 * Saved cards, and when they stop working.
 *
 * A count about NOW, not a series: we do not keep the history of a card's status, and a
 * twelve-month line would imply we did. The value of the report is entirely in the present
 * tense — an expiring card is dunning you can still avoid.
 */
async function resolvePaymentMethodReport(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        status: paymentMethods.status,
        expMonth: paymentMethods.expMonth,
        expYear: paymentMethods.expYear,
      })
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.businessId, businessId),
          reportableCustomer(paymentMethods.customerId),
        ),
      ),
  );

  // Expiry is END of month: a card marked 09/2026 is good until 30 September.
  const expiresAt = (m: number | null, y: number | null): Date | null =>
    m == null || y == null ? null : new Date(Date.UTC(y, m, 1) - 1);
  const horizon = new Date(ctx.now.getTime() + 90 * DAY);

  let n = 0;
  for (const r of rows) {
    const at = expiresAt(r.expMonth, r.expYear);
    if (def.metric === "cards_expired") {
      // The stored status is the engine's own verdict and takes precedence; the date is the
      // fallback for a card nothing has re-checked yet.
      if (r.status === "expired" || (at != null && at < ctx.now)) n += 1;
    } else if (at != null && at >= ctx.now && at <= horizon) {
      n += 1;
    }
  }
  return { ...base, headline: n, points: [] };
}

/** Funnel step labels, in order. E6 measures recovered checkouts against these counts. */
export const CHECKOUT_FUNNEL_STEPS = [
  "Links created",
  "Opened",
  "Details entered",
  "Payment started",
  "Completed",
] as const;

/**
 * Checkout links created in the window, counted at each step they reached.
 *
 * A step counts every session that reached it OR A LATER ONE, so the funnel never rises:
 * sessions completed before `payment_started_at` existed (0343) still count as having paid.
 * Plan-change links are left out — their customer is fixed, so they have no details step.
 */
async function resolveCheckoutReport(
  organizationId: string,
  businessId: string,
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  const s = checkoutSessions;
  const [r] = await withTenant(organizationId, (tx) =>
    tx
      .select({
        created: sql<number>`count(*)::int`,
        opened: sql<number>`count(*) filter (where ${s.lastUsedAt} is not null or ${s.resultingCustomerId} is not null or ${s.paymentStartedAt} is not null or ${s.completedAt} is not null)::int`,
        details: sql<number>`count(*) filter (where ${s.resultingCustomerId} is not null or ${s.paymentStartedAt} is not null or ${s.completedAt} is not null)::int`,
        payment: sql<number>`count(*) filter (where ${s.paymentStartedAt} is not null or ${s.completedAt} is not null)::int`,
        completed: sql<number>`count(*) filter (where ${s.completedAt} is not null)::int`,
      })
      .from(s)
      .where(
        and(
          eq(s.businessId, businessId),
          eq(s.mode, "create"),
          gte(s.createdAt, buckets[0]!.start),
          lt(s.createdAt, buckets[buckets.length - 1]!.end),
        ),
      ),
  );
  const counts = [r?.created, r?.opened, r?.details, r?.payment, r?.completed];
  const rows: ReportRow[] = CHECKOUT_FUNNEL_STEPS.map((group, i) => ({
    group,
    group_id: null,
    value: counts[i] ?? 0,
  }));
  return { ...base, headline: r?.completed ?? 0, points: [], rows, funnel: true };
}

const OFFER_LABEL: Record<string, string> = {
  pause: "Took a pause",
  downgrade: "Moved to a cheaper plan",
  discount: "Took a discount",
  contact: "Contacted you",
};

/** A taken offer followed by a cancel of the same subscription within this many days is not a save. */
const SAVE_HOLD_DAYS = 30;

/**
 * The portal cancel flow (0483), over offers taken and cancellations made in the window. A save
 * is a taken offer whose subscription was NOT cancelled within SAVE_HOLD_DAYS after it; the base
 * is saves + cancellations after offers were shown (a revoked save counts once, as that cancel).
 * Basis points; no base reads null.
 */
async function resolveCancellationSaves(
  organizationId: string,
  businessId: string,
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  const e = retentionEvents;
  const start = buckets[0]!.start;
  const end = buckets[buckets.length - 1]!.end;
  const hold = SAVE_HOLD_DAYS * 86_400_000;
  // Cancellations up to the hold past the window end, so a save near the end can be revoked.
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        kind: e.kind,
        offer: e.offer,
        offersShown: e.offersShown,
        subscriptionId: e.subscriptionId,
        createdAt: e.createdAt,
      })
      .from(e)
      .where(
        and(
          eq(e.businessId, businessId),
          gte(e.createdAt, start),
          lt(e.createdAt, new Date(end.getTime() + hold)),
          reportableCustomer(e.customerId),
        ),
      ),
  );
  const inWindow = (d: Date) => d >= start && d < end;
  const cancels = rows.filter((r) => r.kind === "cancelled");
  const saves = rows.filter(
    (r) =>
      r.kind === "offer_accepted" &&
      inWindow(r.createdAt) &&
      !cancels.some(
        (c) =>
          c.subscriptionId === r.subscriptionId &&
          c.createdAt >= r.createdAt &&
          c.createdAt.getTime() - r.createdAt.getTime() <= hold,
      ),
  );
  // A cancel counts as lost when offers were shown, or when it revokes an earlier taken offer
  // (with "offer once" on, that second flow shows no offers but is still a lost save).
  const accepted = rows.filter((r) => r.kind === "offer_accepted");
  const lost = cancels.filter(
    (c) =>
      inWindow(c.createdAt) &&
      (c.offersShown ||
        accepted.some(
          (a) =>
            a.subscriptionId === c.subscriptionId &&
            a.createdAt <= c.createdAt &&
            c.createdAt.getTime() - a.createdAt.getTime() <= hold,
        )),
  ).length;
  const denom = saves.length + lost;
  const byOffer = new Map<string, number>();
  for (const r of saves)
    byOffer.set(r.offer ?? "other", (byOffer.get(r.offer ?? "other") ?? 0) + 1);
  const out: ReportRow[] = [...byOffer.entries()]
    .map(([offer, n]) => ({
      group: OFFER_LABEL[offer] ?? offer,
      group_id: offer,
      value: Math.round((n * 10000) / denom),
    }))
    .sort((a, b) => b.value - a.value);
  return {
    ...base,
    headline: denom > 0 ? Math.round((saves.length * 10000) / denom) : null,
    points: [],
    rows: out,
  };
}

const CHECKOUT_LAYOUT_LABEL: Record<string, string> = { steps: "Steps", one_page: "One page" };
const CHECKOUT_DEVICE_LABEL: Record<string, string> = {
  mobile: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
};

/**
 * Conversion and payment-failure rates per layout × device, over checkouts first VIEWED in
 * the window (0478). Basis points. A segment with no base is left out, never shown as 0%.
 * Plan changes are left out: their buyer is already a customer.
 */
async function resolveCheckoutSegments(
  organizationId: string,
  businessId: string,
  measure: "checkout_conversion" | "checkout_payment_failures",
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  const s = checkoutSessions;
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        layout: s.layout,
        device: s.deviceClass,
        opened: sql<number>`count(*)::int`,
        completed: sql<number>`count(*) filter (where ${s.completedAt} is not null)::int`,
        attempts: sql<number>`coalesce(sum(${s.paymentAttemptCount}), 0)::int`,
        failures: sql<number>`coalesce(sum(${s.paymentFailureCount}), 0)::int`,
      })
      .from(s)
      .where(
        and(
          eq(s.businessId, businessId),
          inArray(s.mode, ["create", "purchase"]),
          gte(s.firstViewedAt, buckets[0]!.start),
          lt(s.firstViewedAt, buckets[buckets.length - 1]!.end),
        ),
      )
      .groupBy(s.layout, s.deviceClass),
  );
  const rate = (num: number, den: number) => (den > 0 ? Math.round((num * 10000) / den) : null);
  const pick = (r: { opened: number; completed: number; attempts: number; failures: number }) =>
    measure === "checkout_conversion" ? rate(r.completed, r.opened) : rate(r.failures, r.attempts);
  const total = rows.reduce(
    (a, r) => ({
      opened: a.opened + r.opened,
      completed: a.completed + r.completed,
      attempts: a.attempts + r.attempts,
      failures: a.failures + r.failures,
    }),
    { opened: 0, completed: 0, attempts: 0, failures: 0 },
  );
  const segments: ReportRow[] = rows
    .flatMap((r) => {
      const value = pick(r);
      if (value === null) return [];
      return [
        {
          group: `${CHECKOUT_LAYOUT_LABEL[r.layout ?? ""] ?? "Unknown"} · ${CHECKOUT_DEVICE_LABEL[r.device ?? ""] ?? "Unknown"}`,
          group_id: `${r.layout ?? "unknown"}:${r.device ?? "unknown"}`,
          value,
        },
      ];
    })
    .sort((a, b) => a.group.localeCompare(b.group));
  return { ...base, headline: pick(total), points: [], rows: segments };
}

/**
 * Abandoned-checkout reminders (E6), over checkouts CREATED in the window: how many were
 * reminded, how many of those completed afterwards, and what those paid. A checkout counts
 * as recovered only when it completed after its last reminder.
 */
async function resolveCheckoutRecovery(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  const s = checkoutSessions;
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        mode: s.mode,
        completedAt: s.completedAt,
        lastRemindedAt: s.lastRemindedAt,
        invoiceId: s.resultingInvoiceId,
        subscriptionId: s.resultingSubscriptionId,
      })
      .from(s)
      .where(
        and(
          eq(s.businessId, businessId),
          gte(s.createdAt, buckets[0]!.start),
          lt(s.createdAt, buckets[buckets.length - 1]!.end),
          sql`${s.reminderCount} > 0`,
        ),
      ),
  );
  const recovered = rows.filter(
    (r) => r.completedAt != null && r.lastRemindedAt != null && r.completedAt > r.lastRemindedAt,
  );
  if (def.bucketing === "checkout_recovery") {
    const out: ReportRow[] = [
      { group: "Reminded", group_id: null, value: rows.length },
      { group: "Completed after a reminder", group_id: null, value: recovered.length },
    ];
    return { ...base, headline: recovered.length, points: [], rows: out, funnel: true };
  }
  // Revenue: the purchase's invoice, or the subscription's first invoice.
  let total = 0;
  await withTenant(organizationId, async (tx) => {
    for (const r of recovered) {
      const [inv] = r.invoiceId
        ? await tx.select().from(invoices).where(eq(invoices.id, r.invoiceId)).limit(1)
        : r.subscriptionId
          ? await tx
              .select()
              .from(invoices)
              .where(eq(invoices.subscriptionId, r.subscriptionId))
              .orderBy(invoices.createdAt)
              .limit(1)
          : [];
      if (!inv || inv.status !== "paid") continue;
      const v = ctx.convert(Number(inv.totalMinor), inv.currency, inv.paidAt ?? inv.createdAt);
      if (v != null) total += v;
    }
  });
  return {
    ...base,
    headline: total,
    points: [],
    rows: [{ group: "Recovered revenue", group_id: null, value: total }],
  };
}

/**
 * The subscription-side resolver: counts and averages over the book itself.
 *
 * These are `flow`-shaped in the registry because they are quoted over a window, but several
 * of them (quantity, active customers) are really statements about NOW — the series would be
 * a straight line and is deliberately not drawn.
 */
/** A subscription's start, however much of the chain is populated. */
const subStart = (s: { startedAt: Date | null; startDate: Date | null; createdAt: Date }) =>
  s.startedAt ?? s.startDate ?? s.createdAt;

/** Statuses that mean the account is still there — a pause suspends, it does not end. */
const OPEN_STATUSES = new Set(["future", "in_trial", "active", "paused"]);

/**
 * Average life of an ACCOUNT, in months, over the accounts that have fully ended.
 *
 * Account grain, not subscription grain: a customer's life runs from their first
 * subscription starting to their last one cancelling, however many sat in between and
 * whatever the gaps. A customer who replaced one subscription with another lived once.
 *
 * Only accounts with nothing open are measured. An account still running has no length
 * yet, and averaging the living in reports a young book as short-lived — the same reason
 * the subscription-grain figure beside it looks only at what has ended. Null when nothing
 * has fully ended: that is "not yet", which 0 would state as "accounts last no time".
 */
async function averageCustomerLifetimeMonths(
  organizationId: string,
  businessId: string,
  ctx: Ctx,
): Promise<number | null> {
  const subs = await withTenant(organizationId, (tx) =>
    tx
      .select({
        customerId: subscriptions.customerId,
        status: subscriptions.status,
        currency: subscriptions.currency,
        createdAt: subscriptions.createdAt,
        startedAt: subscriptions.startedAt,
        startDate: subscriptions.startDate,
        canceledAt: subscriptions.canceledAt,
      })
      .from(subscriptions)
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          notDeleted(),
        ),
      ),
  );
  const byCustomer = new Map<string, { open: boolean; first: number; last: number | null }>();
  for (const s of subs) {
    if (ctx.convert(0, s.currency) == null) continue;
    const acc = byCustomer.get(s.customerId) ?? { open: false, first: Infinity, last: null };
    if (OPEN_STATUSES.has(s.status)) acc.open = true;
    acc.first = Math.min(acc.first, subStart(s).getTime());
    if (s.canceledAt != null) acc.last = Math.max(acc.last ?? 0, s.canceledAt.getTime());
    byCustomer.set(s.customerId, acc);
  }
  const lives: number[] = [];
  for (const a of byCustomer.values()) {
    if (a.open || a.last == null || a.first === Infinity) continue;
    lives.push((a.last - a.first) / (30 * DAY));
  }
  if (lives.length === 0) return null;
  return Math.round((lives.reduce((n, v) => n + v, 0) / lives.length) * 10) / 10;
}

/**
 * How long the cancelled ones lasted, counted in SQL — the book is mostly cancelled, so this
 * is the one bucketing where shipping the rows costs the most.
 *
 * Measured from the subscription's START, not the customer's signup: the question is how long
 * the thing survived. Days are cut on millisecond-truncated instants, as the rows would read
 * in JavaScript, so a boundary lands in the same band either way.
 */
async function resolveChurnAgeReport(
  organizationId: string,
  businessId: string,
  ctx: Ctx,
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  const labels = [
    "Under 30 days",
    "30–90 days",
    "91–180 days",
    "181–365 days",
    "1–2 years",
    "Over 2 years",
  ];
  // Bands compare the lifetime INTERVAL to their edges ("30–90 days" is under 91 whole days),
  // computed once per row in the inner select (`offset 0` stops the planner inlining it, which
  // would re-evaluate it in every arm of the `case`).
  const rows = (await withTenant(organizationId, (tx) =>
    tx.execute(sql`
      select currency,
             (case when life < interval '30 days' then 0
                   when life < interval '91 days' then 1
                   when life < interval '181 days' then 2
                   when life < interval '366 days' then 3
                   when life < interval '731 days' then 4
                   else 5 end)::int as slot,
             count(*)::int as n
        from (select currency,
                     date_trunc('milliseconds', canceled_at)
                       - date_trunc('milliseconds', coalesce(started_at, start_date, created_at)) as life
                from subscriptions
               where business_id = ${businessId}::uuid
                 and ${reportableCustomer(sql`customer_id`)}
                 and deleted_at is null
                 and canceled_at is not null
              offset 0) lives
       group by 1, 2
    `),
  )) as unknown as Array<{ currency: string; slot: number; n: number }>;
  const totals: number[] = new Array(labels.length).fill(0);
  for (const r of rows) {
    // A currency the scope cannot represent is excluded, as everywhere else.
    if (ctx.convert(0, r.currency) == null) continue;
    totals[r.slot] = (totals[r.slot] ?? 0) + r.n;
  }
  const out = labels.map((label, i) => ({ group: label, group_id: null, value: totals[i] ?? 0 }));
  return { ...base, headline: out.reduce((n, r) => n + r.value, 0), points: [], rows: out };
}

async function resolveSubscriptionReport(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  if (def.shape === "buckets" && def.bucketing === "churn_age") {
    return resolveChurnAgeReport(organizationId, businessId, ctx, base);
  }

  // These read only the LIVE book — a few percent of a mostly-cancelled one — so the status
  // filter goes to SQL. `liveMrrByCustomer` applies the same filter, so the answer is unchanged.
  const liveOnly =
    (def.shape === "buckets" &&
      (def.bucketing === "customer_concentration" ||
        def.bucketing === "top_customers" ||
        def.bucketing === "customer_mrr_band")) ||
    def.metric === "paying_customers";

  const subs = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: subscriptions.id,
        customerId: subscriptions.customerId,
        status: subscriptions.status,
        currency: subscriptions.currency,
        createdAt: subscriptions.createdAt,
        startedAt: subscriptions.startedAt,
        startDate: subscriptions.startDate,
        trialStart: subscriptions.trialStart,
        activatedAt: subscriptions.activatedAt,
        canceledAt: subscriptions.canceledAt,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        billingPeriod: subscriptions.billingPeriod,
        billingPeriodUnit: subscriptions.billingPeriodUnit,
        mrr: subscriptions.mrr,
      })
      .from(subscriptions)
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          notDeleted(),
          liveOnly ? inArray(subscriptions.status, ["active", "in_trial"]) : undefined,
        ),
      ),
  );
  const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
  const inW = (at: Date | null, w: { start: Date; end: Date }) =>
    at != null && at >= w.start && at < w.end;
  const scoped = (s: (typeof subs)[number]) => ctx.convert(0, s.currency) != null;
  const startOfSub = (s: (typeof subs)[number]) => s.startedAt ?? s.startDate ?? s.createdAt;

  /**
   * Live recurring revenue per CUSTOMER, in the reporting currency.
   *
   * The whole point of the customer-grain family: a customer with three subscriptions is
   * ONE entry here, worth the sum of the three. Converted per subscription before summing,
   * because an account can hold subscriptions in two currencies and adding paise to cents
   * would produce a number that means nothing. "Live" is the same predicate the active
   * customer count uses, so the two cannot disagree about who is on the book.
   */
  const liveMrrByCustomer = (): Map<string, number> => {
    const acc = new Map<string, number>();
    for (const sub of subs) {
      if (!scoped(sub) || !(sub.status === "active" || sub.status === "in_trial")) continue;
      const v = ctx.convert(Number(sub.mrr ?? 0n), sub.currency);
      if (v == null) continue;
      acc.set(sub.customerId, (acc.get(sub.customerId) ?? 0) + v);
    }
    return acc;
  };

  const valueIn = (w: { start: Date; end: Date }): number => {
    switch (def.metric) {
      case "trials":
        return subs.filter((s) => scoped(s) && s.trialStart != null && startOfSub(s) < w.end)
          .length;
      case "new_trials":
        return subs.filter((s) => scoped(s) && inW(s.trialStart, w)).length;
      case "trial_conversion_rate": {
        // Of the trials that STARTED in the window, how many ever activated. Measured on the
        // cohort that started, not on activations in the window — otherwise a good month
        // for conversions reads as a bad one for trials.
        const started = subs.filter((s) => scoped(s) && inW(s.trialStart, w));
        if (started.length === 0) return 0;
        const converted = started.filter((s) => s.activatedAt != null).length;
        return Math.round((converted / started.length) * 10000);
      }
      case "signups":
        // A signup is an ACCOUNT, not a subscription: a customer who starts three
        // subscriptions signed up once. Counted on the customer, hence the distinct set.
        return new Set(
          subs.filter((s) => scoped(s) && inW(s.createdAt, w)).map((s) => s.customerId),
        ).size;
      case "activations":
        return subs.filter((s) => scoped(s) && inW(s.activatedAt, w)).length;
      case "cancellations":
        // Every cancellation that landed in the window, counted on `canceled_at` — the
        // count behind the churn MRR figure, which is stated in money.
        return subs.filter((s) => scoped(s) && inW(s.canceledAt, w)).length;
      case "same_period_cancellations":
        return subs.filter((s) => scoped(s) && inW(startOfSub(s), w) && inW(s.canceledAt, w))
          .length;
      case "average_lifetime_months": {
        // Only subscriptions that have ENDED have a lifetime; averaging live ones in would
        // report a book as short-lived simply because it is young.
        const ended = subs.filter((s) => scoped(s) && s.canceledAt != null);
        if (ended.length === 0) return 0;
        const months = ended.reduce(
          (sum, s) => sum + (s.canceledAt!.getTime() - startOfSub(s).getTime()) / (30 * DAY),
          0,
        );
        return Math.round((months / ended.length) * 10) / 10;
      }
      case "activation_lead_days": {
        const activated = subs.filter((s) => scoped(s) && s.activatedAt != null);
        if (activated.length === 0) return 0;
        const days = activated.reduce(
          (sum, s) => sum + (s.activatedAt!.getTime() - s.createdAt.getTime()) / DAY,
          0,
        );
        return Math.round((days / activated.length) * 10) / 10;
      }
      default:
        return 0;
    }
  };

  if (def.shape === "buckets" && def.bucketing === "customer_concentration") {
    /**
     * How much of the book sits in the largest accounts.
     *
     * Bands are DISJOINT rank ranges, not cumulative top-N shares, for one reason: rows
     * that overlap cannot sum to anything, and a breakdown whose parts do not sum to the
     * whole sends the reader hunting for the missing rows. So these sum to total MRR
     * exactly, and any top-N share is the running total of the rows above it — which also
     * makes it impossible for a share to exceed 100%.
     *
     * Bands beyond the book's size are kept rather than dropped: an empty "Accounts 26–100"
     * says the book is smaller than the band, which is a fact about the book.
     */
    const ranked = [...liveMrrByCustomer().values()].sort((a, b) => b - a);
    const bands: Array<[string, number, number]> = [
      ["Largest account", 0, 1],
      ["Accounts 2–5", 1, 5],
      ["Accounts 6–10", 5, 10],
      ["Accounts 11–25", 10, 25],
      ["Accounts 26–100", 25, 100],
      ["Everyone else", 100, Number.MAX_SAFE_INTEGER],
    ];
    const out = bands.map(([label, from, to]) => ({
      group: label,
      group_id: null,
      value: ranked.slice(from, to).reduce((n, v) => n + v, 0),
    }));
    return { ...base, headline: out.reduce((n, r) => n + r.value, 0), points: [], rows: out };
  }

  if (def.shape === "buckets" && def.bucketing === "top_customers") {
    /**
     * The largest accounts by name, with everything below them on one row — so the rows
     * still sum to total MRR and the reader can see what share the named ones are of it.
     */
    const TOP = 20;
    const byCustomer = [...liveMrrByCustomer().entries()].sort((a, b) => b[1] - a[1]);
    const ids = byCustomer.slice(0, TOP).map(([id]) => id);
    const named = ids.length
      ? await withTenant(organizationId, (tx) =>
          tx
            .select({
              id: customers.id,
              publicId: customers.publicId,
              firstName: customers.firstName,
              lastName: customers.lastName,
              company: customers.company,
              email: customers.email,
            })
            .from(customers)
            .where(inArray(customers.id, ids)),
        )
      : [];
    const rows: ReportRow[] = byCustomer.slice(0, TOP).map(([id, value]) => {
      const c = named.find((n) => n.id === id);
      return {
        group: (c ? accountHolderName(c) : null) ?? c?.publicId ?? "Unknown",
        group_id: c?.publicId ?? null,
        value,
      };
    });
    const rest = byCustomer.slice(TOP).reduce((n, [, v]) => n + v, 0);
    if (byCustomer.length > TOP) {
      rows.push({
        group: `All other accounts (${byCustomer.length - TOP})`,
        group_id: null,
        value: rest,
      });
    }
    return { ...base, headline: rows.reduce((n, r) => n + r.value, 0), points: [], rows };
  }

  if (def.shape === "buckets" && def.bucketing === "customer_mrr_band") {
    /**
     * The shape of the book: how many accounts sit in each size band.
     *
     * Band edges are MAJOR units of the reporting currency and the label says which — the
     * same ladder over a book kept in paise and one kept in cents would otherwise print
     * two different questions under one heading. The edges are wide on purpose: a fixed
     * ladder cannot be right for every currency, and two orders of magnitude per band is
     * what keeps it readable on both.
     */
    const minor = 100;
    const edges: Array<[string, number, number]> = [
      ["No recurring revenue", 0, 1],
      [`1 – 50 ${ctx.reporting}`, 1, 50 * minor + 1],
      [`51 – 500 ${ctx.reporting}`, 50 * minor + 1, 500 * minor + 1],
      [`501 – 5,000 ${ctx.reporting}`, 500 * minor + 1, 5_000 * minor + 1],
      [`5,001 – 50,000 ${ctx.reporting}`, 5_000 * minor + 1, 50_000 * minor + 1],
      [`Over 50,000 ${ctx.reporting}`, 50_000 * minor + 1, Number.MAX_SAFE_INTEGER],
    ];
    const totals = new Array(edges.length).fill(0);
    for (const v of liveMrrByCustomer().values()) {
      const i = edges.findIndex(([, lo, hi]) => v >= lo && v < hi);
      if (i >= 0) totals[i] += 1;
    }
    const out = edges.map(([label], i) => ({
      group: label,
      group_id: null,
      value: totals[i] ?? 0,
    }));
    return { ...base, headline: out.reduce((n, r) => n + r.value, 0), points: [], rows: out };
  }

  if (def.metric === "paying_customers") {
    // Customers carrying revenue NOW, not subscriptions doing so: the denominator the
    // per-customer revenue figures divide by.
    const paying = [...liveMrrByCustomer().values()].filter((v) => v > 0).length;
    return { ...base, headline: paying, points: [] };
  }

  if (def.metric === "subscriptions_per_customer") {
    // The factor between per-subscription and per-customer revenue, stated on its own so
    // the gap between the two averages has a number rather than an explanation.
    const live = subs.filter(
      (sub) => scoped(sub) && (sub.status === "active" || sub.status === "in_trial"),
    );
    const heads = new Set(live.map((sub) => sub.customerId)).size;
    return {
      ...base,
      headline: heads > 0 ? Math.round((live.length / heads) * 10) / 10 : null,
      points: [],
    };
  }

  if (def.metric === "average_customer_lifetime_months") {
    return {
      ...base,
      headline: await averageCustomerLifetimeMonths(organizationId, businessId, ctx),
      points: [],
    };
  }

  if (def.metric === "total_subscriptions") {
    // Every subscription on the book, whatever its state — the one count that does not
    // filter by status, which is exactly what makes it different from the active count.
    return { ...base, headline: subs.filter(scoped).length, points: [] };
  }

  if (def.metric === "upcoming_renewal_amount") {
    /**
     * What the renewals falling due in the window are worth at the plan rate.
     *
     * `mrr` is monthly, so a cycle is worth `mrr × months-per-cycle` — an annual plan
     * renewing once is worth twelve months of it, not one. Before tax, before usage, and
     * before a discount that has not started yet: the report says so, because the invoice
     * the engine eventually raises is the authority and this is a forecast.
     */
    const monthsPerCycle = (s: (typeof subs)[number]) => {
      const unit = s.billingPeriodUnit ?? "month";
      const n = s.billingPeriod ?? 1;
      return unit === "year"
        ? n * 12
        : unit === "month"
          ? n
          : unit === "week"
            ? (n * 7) / 30
            : n / 30;
    };
    const valueForWindow = (w: { start: Date; end: Date }) => {
      let total = 0;
      for (const s of subs) {
        if (!scoped(s) || s.status !== "active") continue;
        if (!inW(s.currentPeriodEnd, w)) continue;
        total += ctx.convert(Math.round(Number(s.mrr ?? 0n) * monthsPerCycle(s)), s.currency) ?? 0;
      }
      return total;
    };
    return {
      ...base,
      headline: valueForWindow(window),
      points: buckets.map((b) => ({ t: b.t, label: b.label, v: valueForWindow(b) })),
    };
  }

  if (def.metric === "subscription_quantity" || def.metric === "active_customers") {
    // Statements about the book NOW, so no series: a flat line across twelve months would
    // imply we know what it was then, and we do not.
    if (def.metric === "active_customers") {
      const live = new Set(
        subs
          .filter((s) => scoped(s) && (s.status === "active" || s.status === "in_trial"))
          .map((s) => s.customerId),
      );
      return { ...base, headline: live.size, points: [] };
    }
    const liveIds = subs
      .filter((s) => scoped(s) && (s.status === "active" || s.status === "in_trial"))
      .map((s) => s.id);
    const items = liveIds.length
      ? await withTenant(organizationId, (tx) =>
          tx
            .select({
              subscriptionId: subscriptionItems.subscriptionId,
              quantity: subscriptionItems.quantity,
            })
            .from(subscriptionItems)
            .where(inArray(subscriptionItems.subscriptionId, liveIds)),
        )
      : [];
    return { ...base, headline: items.reduce((n, i) => n + i.quantity, 0), points: [] };
  }

  return {
    ...base,
    headline: valueIn(window),
    points: buckets.map((b) => ({ t: b.t, label: b.label, v: valueIn(b) })),
  };
}

/**
 * The waterfall's columns. They PARTITION the movements: every row lands in exactly one, so
 * a period reconciles by construction. `expansion` is expansion WITHIN a plan — an upgrade is
 * expansion that also changed plan, and counting it in both would overstate the book.
 */
const WATERFALL_COLUMNS = [
  { key: "opening", label: "Opening" },
  { key: "new", label: "New" },
  { key: "free_to_paid", label: "Free to paid" },
  { key: "upgrade", label: "Upgrade" },
  { key: "expansion", label: "Expansion" },
  { key: "reactivation", label: "Reactivation" },
  { key: "resumed", label: "Resumed" },
  { key: "downgrade", label: "Downgrade" },
  { key: "contraction", label: "Contraction" },
  { key: "paused", label: "Paused" },
  { key: "churn", label: "Cancellation" },
  // Not a ledger row — see `resolvePeriodicReport`. The rate's share of the move.
  { key: "fx", label: "FX" },
  { key: "net", label: "Net" },
  { key: "closing", label: "Closing" },
];

/**
 * Which column a movement belongs to. Exactly one, always.
 *
 * ⚠️ Mirrored in SQL by 0273's `column_key` — change both, and `verify:movement-matview`
 * fails until you do. A movement with no from-plan cannot be told apart from a same-plan
 * change, so it stays in expansion/contraction rather than being guessed into a plan change.
 */
function waterfallColumn(m: MovementRow, trialSubs: Set<string>): string {
  const changedPlan =
    m.previousPlanProductId != null && m.previousPlanProductId !== m.planProductId;
  switch (m.reason) {
    case "new":
      // A first sale on a subscription that ran a trial is a CONVERSION, not new business.
      return trialSubs.has(m.subscriptionId) ? "free_to_paid" : "new";
    case "expansion":
      return changedPlan ? "upgrade" : "expansion";
    case "contraction":
      return changedPlan ? "downgrade" : "contraction";
    case "reactivation":
      return "reactivation";
    case "resume":
      return "resumed";
    case "pause":
      return "paused";
    default:
      return "churn";
  }
}

/** `weight` identical ledger rows: same instant-bucket, currency, column and signed delta. */
interface WaterfallCell {
  occurredAt: Date;
  currency: string;
  column: string;
  deltaMinor: number;
  weight: number;
}

function cellOf(m: MovementRow, trialSubs: Set<string>): WaterfallCell {
  return {
    occurredAt: m.occurredAt,
    currency: m.currency,
    column: waterfallColumn(m, trialSubs),
    deltaMinor: Number(m.deltaMinor),
    weight: 1,
  };
}

/**
 * The waterfall's input: the pre-grouped ledger (0275) for complete months written before its
 * cutoff, and the netted ledger for the rest — this month, and anything written since the
 * cutoff. The two sets are complements, so every row is counted exactly once.
 *
 * A cell stands in at its month's first instant. Every comparison the fold makes is against a
 * month boundary or an instant inside the current month, and a complete month's rows compare
 * the same way against those as its first instant does.
 *
 * Exact, not approximate: `convertAt` rounds per row, and a cell converts its one delta once
 * and multiplies by the count — the same figure.
 */
async function loadWaterfallCells(
  organizationId: string,
  businessId: string,
  now: Date,
  trialSubs: Set<string>,
): Promise<WaterfallCell[]> {
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fold = await loadMovementCells(organizationId, businessId, thisMonth);
  if (!fold) {
    movementPath.rebuilt++;
    return (await loadMovements(organizationId, businessId)).map((m) => cellOf(m, trialSubs));
  }
  const tail = await loadMovements(
    organizationId,
    businessId,
    or(gte(mrrMovements.createdAt, fold.cutoff), gte(mrrMovements.occurredAt, thisMonth)),
  );
  movementPath.fromMatview++;
  return [
    ...fold.cells.map((c) => ({
      occurredAt: c.month,
      currency: c.currency,
      column: c.columnKey,
      deltaMinor: c.deltaMinor,
      weight: c.count,
    })),
    ...tail.map((m) => cellOf(m, trialSubs)),
  ];
}

/**
 * The movement waterfall: a row per period, columns that reconcile.
 *
 * `opening + new + expansion + reactivation − contraction − churn + FX = closing`, and the
 * row is worthless if that does not hold.
 *
 * So EVERY column comes from the ledger — opening and closing included, as the running sum
 * of every delta up to that instant. The first cut read opening and closing from the stock
 * reader instead, and the row was out by $142.76 on the dev book: the snapshots it reads
 * were backfilled at TODAY's rates while the deltas are what actually moved. Mixing two
 * sources in one row is how a waterfall stops adding up, and a waterfall that does not add
 * up is worse than no waterfall.
 *
 * FX IS THE ONE COLUMN THAT IS NOT A LEDGER ROW. A converted total moves for two reasons —
 * the book changed, or the rate did — and in its own currency a rate move is exactly zero,
 * so it appends nothing and never will. It exists only in the converted view, and it is
 * DERIVED here: each period converts at the rate the business held AT ITS CLOSE, each
 * opening at the rate held the instant before it, and FX is what is left over. That
 * remainder is `Σ opening native MRR × (1/rate_close − 1/rate_open)` exactly — the rupee,
 * separated from the volume. Subscriptions already in the reporting currency contribute
 * nothing to it, and a currency with no usable rate is excluded from the row entirely
 * rather than counted at par.
 *
 * With no rate history — a fresh book, or one seeded only with today's rates — every
 * instant resolves to the CURRENT rate, so every figure here is what it was before this
 * column existed and FX reads zero. That is deliberate: nothing is restated.
 *
 * Periods are calendar months, newest first, because that is the order a finance reader
 * scans: this month against last.
 */
function resolvePeriodicReport(
  def: ReportDef,
  ctx: Ctx,
  cells: WaterfallCell[],
  base: Omit<ReportResult, "headline" | "points">,
): ReportResult {
  const MONTHS = 12;
  const mult = def.multiplier ?? 1;
  const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const addMonths = (d: Date, n: number) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

  /**
   * The book at an instant, as the ledger tells it: every delta that had happened by then,
   * converted at THE RATE IN FORCE AT THAT INSTANT. The same identity
   * `verify:mrr-movements` checks per subscription, summed across the business.
   */
  const ledgerStock = (at: Date): number => {
    let total = 0;
    for (const c of cells) {
      if (c.occurredAt > at) continue;
      total += (ctx.convertAt(c.deltaMinor, c.currency, at) ?? 0) * c.weight;
    }
    return total * mult;
  };

  const columns = WATERFALL_COLUMNS;

  /**
   * One window's movement, each row converted ONCE at the window's close rate and filed into
   * exactly one column. One conversion per row is what makes the arithmetic exact: rounding
   * the magnitude and rounding the signed delta separately can differ by a minor unit on a
   * half-way division, and a waterfall out by a cent is a waterfall nobody trusts.
   */
  const windowFlows = (w: { start: Date; end: Date }, at: Date) => {
    const byColumn = new Map<string, number>();
    let net = 0;
    for (const c of cells) {
      if (c.occurredAt < w.start || c.occurredAt >= w.end) continue;
      const u = ctx.convertAt(Math.abs(c.deltaMinor), c.currency, at);
      if (u == null) continue; // no usable rate: excluded, never counted at par
      const v = u * c.weight;
      byColumn.set(c.column, (byColumn.get(c.column) ?? 0) + v * mult);
      net += (c.deltaMinor < 0 ? -v : v) * mult;
    }
    return { of: (key: string) => byColumn.get(key) ?? 0, net };
  };

  const out: NonNullable<ReportResult["table"]>["rows"] = [];
  for (let i = 0; i < MONTHS; i++) {
    const start = addMonths(monthStart(ctx.now), -i);
    const end = addMonths(start, 1);
    // The period in progress closes at NOW, not at a month end that has not arrived.
    const closeAt = new Date(Math.min(end.getTime() - 1, ctx.now.getTime()));
    const w = { start, end: new Date(closeAt.getTime() + 1) };
    const opening = ledgerStock(new Date(start.getTime() - 1));
    const closing = ledgerStock(closeAt);
    const flows = windowFlows(w, closeAt);
    // The remainder, and therefore EXACT by construction: everything the book did is in
    // `net`, everything else that moved the converted total is the rate. On a single-
    // currency book, and on any book whose rates did not move, it is 0.
    const fx = closing - opening - flows.net;
    out.push({
      period: `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCFullYear()}`,
      values: [
        opening,
        flows.of("new"),
        flows.of("free_to_paid"),
        flows.of("upgrade"),
        flows.of("expansion"),
        flows.of("reactivation"),
        flows.of("resumed"),
        flows.of("downgrade"),
        flows.of("contraction"),
        flows.of("paused"),
        flows.of("churn"),
        fx,
        flows.net,
        closing,
      ],
    });
  }

  return {
    ...base,
    // The current period's CLOSING figure: what the book is worth now. Found by column key,
    // never by index — widening the table from 8 columns to 13 moved index 7 from "closing"
    // to "downgrade", and the headline silently became $0.00 on a book worth $855K.
    headline: out[0]?.values[columns.findIndex((c) => c.key === "closing")] ?? null,
    points: [],
    table: { columns, rows: out },
  };
}

/**
 * Cohort retention, reconstructed from the ledger.
 *
 * A subscription's MRR at any instant is the sum of its own movement deltas up to that
 * instant — that is the identity the ledger is built on, so a cohort curve is EXACT for
 * anything the writer recorded, not an approximation from today's rate.
 *
 * Cohort = the calendar month a subscription first earned in. Offsets count whole months
 * from there. A cell is null, never 0, where the month has not happened yet: 0 would read
 * as "everything churned" on a cohort that is simply young, which is the classic way a
 * cohort table lies.
 *
 * ⚠️ Backfilled subscriptions carry only two movements (a start and a cancellation), so
 * their curves are flat until they churn — no mid-life expansion or contraction exists to
 * reconstruct. The months after the ledger's cutover are the real ones; see the backfill
 * script's header.
 */
function resolveCohortReport(
  rows: MovementRow[],
  def: ReportDef,
  ctx: Ctx,
  base: Omit<ReportResult, "headline" | "points">,
): ReportResult {
  const MONTHS_BACK = 12;
  const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const addMonths = (d: Date, n: number) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const label = (d: Date) => `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

  // Each subscription's movements, oldest first — the trajectory this whole report reads.
  const bySub = new Map<string, MovementRow[]>();
  for (const m of rows) {
    const arr = bySub.get(m.subscriptionId) ?? [];
    arr.push(m);
    bySub.set(m.subscriptionId, arr);
  }
  for (const arr of bySub.values()) arr.sort((a, b) => +a.occurredAt - +b.occurredAt);

  /** MRR for one subscription at `at`, in the reporting currency. */
  const mrrAt = (movements: MovementRow[], at: Date): number => {
    let total = 0;
    for (const m of movements) {
      if (m.occurredAt > at) break;
      total += Number(m.deltaMinor);
    }
    const first = movements[0];
    if (!first) return 0;
    return ctx.convert(total, first.currency, at) ?? 0;
  };

  const firstMonth = monthStart(addMonths(ctx.now, -(MONTHS_BACK - 1)));
  const cohorts = new Map<string, MovementRow[][]>();
  for (const [, movements] of bySub) {
    const first = movements[0];
    if (!first) continue;
    const m0 = monthStart(first.occurredAt);
    if (m0 < firstMonth) continue;
    const key = label(m0);
    const arr = cohorts.get(key) ?? [];
    arr.push(movements);
    cohorts.set(key, arr);
  }

  const columns = Array.from({ length: MONTHS_BACK }, (_, i) => `M${i}`);
  const out: NonNullable<ReportResult["matrix"]>["rows"] = [];
  for (let i = 0; i < MONTHS_BACK; i++) {
    const cohortStart = addMonths(firstMonth, i);
    const key = label(cohortStart);
    const members = cohorts.get(key);
    if (!members || members.length === 0) continue;

    const valueAt = (at: Date): number =>
      def.cohort === "subscriptions"
        ? members.filter((mv) => mv[0] != null && mrrAt(mv, at) > 0).length
        : members.reduce((sum, mv) => sum + mrrAt(mv, at), 0);

    /**
     * Measured at the END of each month — so a subscription that started on the 28th is not
     * judged on its second day — but never later than NOW: the month in progress is read as
     * it stands rather than dropped, which is what an operator means by "this month".
     */
    const measureAt = (offset: number) => {
      const end = new Date(addMonths(cohortStart, offset + 1).getTime() - 1);
      return end > ctx.now ? ctx.now : end;
    };
    const opening = valueAt(measureAt(0));
    const values: Array<number | null> = [];
    for (let k = 0; k < MONTHS_BACK; k++) {
      // A month that has not BEGUN is null — "not yet", which 0 would misreport as total
      // loss on a cohort that is simply young.
      if (addMonths(cohortStart, k) > ctx.now) {
        values.push(null);
        continue;
      }
      values.push(opening > 0 ? Math.round((valueAt(measureAt(k)) / opening) * 10000) : null);
    }
    out.push({ group: key, base: opening, values });
  }

  return {
    ...base,
    // The headline is the most recent cohort's opening size: a cohort table has no single
    // number, and inventing an average across cohorts of different ages would be worse.
    headline: out.at(-1)?.base ?? null,
    points: [],
    matrix: { columns, base_kind: def.cohort === "subscriptions" ? "count" : "money", rows: out },
  };
}

/**
 * The scheduled-change resolver: the book that is already committed to move.
 *
 * A stock of FUTURE intent, not a flow, so there is no series — every one of these is "what
 * is booked right now", and drawing it across past buckets would imply we recorded what was
 * booked then, which we did not.
 *
 * ⚠️ The MRR figures come from `scheduled_changes.mrr_delta_minor`, an estimate taken when
 * the change was scheduled: gross of discounts, rated from the catalogue at that moment, and
 * never restated if the subscription or the catalogue moves before it lands. The report says
 * so in its description rather than presenting an estimate as a measurement.
 */
async function resolveScheduledReport(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  base: Omit<ReportResult, "headline" | "points">,
): Promise<ReportResult> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        type: scheduledChanges.type,
        status: scheduledChanges.status,
        mrrDeltaMinor: scheduledChanges.mrrDeltaMinor,
        subscriptionId: scheduledChanges.subscriptionId,
      })
      .from(scheduledChanges)
      .where(
        and(
          eq(scheduledChanges.businessId, businessId),
          eq(scheduledChanges.status, "scheduled"),
          reportableSubscription(scheduledChanges.subscriptionId),
        ),
      ),
  );

  const subs = await withTenant(organizationId, (tx) =>
    tx
      .select({
        id: subscriptions.id,
        status: subscriptions.status,
        currency: subscriptions.currency,
        mrr: subscriptions.mrr,
        canceledAt: subscriptions.canceledAt,
        cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        cancelScheduledAt: subscriptions.cancelScheduledAt,
        cancelBookedAt: subscriptions.cancelBookedAt,
      })
      .from(subscriptions)
      .where(
        and(
          and(
            eq(subscriptions.businessId, businessId),
            reportableCustomer(subscriptions.customerId),
          ),
          notDeleted(),
        ),
      ),
  );
  const subById = new Map(subs.map((s) => [s.id, s]));

  let headline = 0;

  /**
   * A booked cancellation lives on the SUBSCRIPTION, not in `scheduled_changes`: this engine
   * records it as `cancel_at_period_end` or a dated `cancel_scheduled_at`. Reading only the
   * scheduled-changes table reported 0 on a book where CMRR was excluding $29.68K/month of
   * exactly these — two answers to one question, which is the failure this whole layer
   * exists to avoid. So the same predicate CMRR uses answers here: `isBookedToStop`, minus
   * the ones already gone.
   */
  if (def.scheduled === "cancellation_mrr" || def.scheduled === "cancellation_count") {
    for (const s of subs) {
      if (s.canceledAt != null) continue;
      if (!isBookedToStop(s as unknown as StockRow)) continue;
      const v = ctx.convert(Number(s.mrr ?? 0n), s.currency);
      if (v == null) continue;
      headline += def.scheduled === "cancellation_count" ? 1 : v;
    }
    return { ...base, headline, points: [] };
  }

  for (const r of rows) {
    const sub = subById.get(r.subscriptionId);
    if (!sub) continue;
    const conv = (n: number) => ctx.convert(n, sub.currency);
    if (r.type !== "change" || r.mrrDeltaMinor == null) continue;
    const delta = Number(r.mrrDeltaMinor);
    const wantUp = def.scheduled === "upgrade_mrr" || def.scheduled === "upgrade_count";
    if (wantUp ? delta <= 0 : delta >= 0) continue;
    if (def.scheduled === "upgrade_count" || def.scheduled === "downgrade_count") {
      if (conv(0) != null) headline += 1;
    } else {
      // Stated as a positive amount, like every other loss in this catalogue.
      headline += conv(Math.abs(delta)) ?? 0;
    }
  }

  return { ...base, headline, points: [] };
}

/**
 * Answer one report.
 *
 * `group_by` is honoured only where the declaration allows it — a breakdown the data cannot
 * support is refused rather than returned empty, because an empty breakdown reads as "no
 * activity" and is actually "wrong question".
 */
// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * `now`, one whole window earlier.
 *
 * The shift is the preset's OWN span — its bucket count in its own granularity, the two
 * numbers `buildBuckets` consumes — so the previous window ends exactly where the current
 * one starts: no gap, no overlap, and no second definition of how long `12m` is. It lands on
 * the same day of the month (or the same day, for a day/week preset), which is what makes
 * the two trailing partial periods the same length.
 */
function previousAnchor(range: AnalyticsRange, now: Date): Date {
  const { granularity, count } = RANGE_SHAPE[range];
  if (granularity !== "month") {
    return new Date(now.getTime() - count * (granularity === "week" ? 7 : 1) * DAY);
  }
  const shifted = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - count,
      1,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
  // The same date does not exist in every month — hold the day at the month's last.
  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return shifted;
}

/** Drop or truncate buckets so a series stops at `cut` — the like-for-like clip. */
function clipBuckets(buckets: Bucket[], cut: Date): Bucket[] {
  return buckets.flatMap((b) => (b.end <= cut ? [b] : b.start >= cut ? [] : [{ ...b, end: cut }]));
}

/**
 * A window's MIDPOINT names its month; its edges do not. On a book east of UTC the start of
 * a local August is 31 July in UTC, and labelling from the edge printed "Jul" over August's
 * figures.
 */
const monthOf = (w: { start: Date; end: Date }) =>
  new Date((w.start.getTime() + w.end.getTime()) / 2);
const monthLabel = (d: Date) => `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const dayLabel = (d: Date) =>
  `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

/** A window one calendar month long, however it was cut — 28 to 31 days. */
const spansOneMonth = (w: { start: Date; end: Date }) => {
  const len = w.end.getTime() - w.start.getTime();
  return len >= 28 * DAY && len <= 31 * DAY;
};

interface ComparisonPlan {
  windows: ReportComparisonWindows;
  /** `now`, as the comparison resolution must see it. */
  anchor: Date;
  /** The comparison window's buckets, clipped to the same elapsed part as the current one. */
  buckets: Bucket[];
}

/**
 * The window a comparable report compares against, and the basis of the pair.
 *
 * Both windows come from the same calendar the report's own window came from — the series
 * families from `reportBuckets`, the `derived` rates from `calendarWindows` in the business
 * timezone. A comparison cut on a second calendar is how a delta ends up disagreeing with
 * the figure printed above it, and this module has paid for that twice already.
 */
async function planComparison(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
): Promise<ComparisonPlan> {
  if (def.source === "derived") {
    // A derived rate is quoted over the last COMPLETE month, so the comparison is the month
    // before it — asked of the same helper from inside that month, never computed here.
    const current = await lastCompleteMonth(organizationId, businessId, ctx.now);
    const previous = await lastCompleteMonth(organizationId, businessId, current.start);
    return {
      anchor: current.start,
      // The derived branch takes its window from the anchor, not from these.
      buckets,
      windows: {
        current: { ...current, cut: current.end },
        previous: { ...previous, cut: previous.end },
        basis: "complete_month",
        label: monthLabel(monthOf(previous)),
      },
    };
  }

  const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
  const anchor = previousAnchor(ctx.range, ctx.now);
  const prevBuckets = reportBuckets(ctx.range, anchor, "back", ctx.granularity);
  const previous = {
    start: prevBuckets[0]!.start,
    end: prevBuckets[prevBuckets.length - 1]!.end,
  };
  /**
   * The current window's nominal end is in the FUTURE — its last bucket is the period we are
   * in — and every source it sums is past-dated, so the figure already stops at `now`. The
   * comparison has to stop at the same elapsed point, or a partial period would be measured
   * against a complete one. That is the clip; it is also why a report whose measure looks
   * ahead is not `comparable` at all.
   */
  const currentCut = ctx.now < window.end ? ctx.now : window.end;
  const previousCut = anchor < previous.end ? anchor : previous.end;
  const month = spansOneMonth(window);
  const basis: ReportComparisonBasis =
    def.source === "stock"
      ? "point_in_time"
      : currentCut < window.end
        ? month
          ? "month_to_date"
          : "period_to_date"
        : month
          ? "complete_month"
          : "complete_period";
  return {
    anchor,
    buckets: clipBuckets(prevBuckets, previousCut),
    windows: {
      current: { ...window, cut: currentCut },
      previous: { ...previous, cut: previousCut },
      basis,
      label:
        basis === "point_in_time"
          ? dayLabel(previousCut)
          : month
            ? monthLabel(monthOf(previous))
            : `${dayLabel(previous.start)} – ${dayLabel(new Date(previousCut.getTime() - 1))}`,
    },
  };
}

/**
 * The same measure, one window earlier — resolved by the SAME resolver over the SAME
 * declaration, so the pair cannot disagree about what the metric is.
 */
async function compareToPreviousPeriod(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
  headline: number | null,
  filter?: CustomerFilter,
): Promise<ReportComparison> {
  const plan = await planComparison(organizationId, businessId, def, ctx, buckets);
  // The same filter on both sides, or the comparison would be two different books.
  const previous = await resolveFigure(
    organizationId,
    businessId,
    def,
    { ...ctx, now: plan.anchor },
    plan.buckets,
    undefined,
    filter,
  );
  const prev = previous.headline;
  return {
    prev_value: prev,
    prev_label: plan.windows.label,
    // A zero or negative base has no proportion to state, so there is no change — null,
    // never 0, which would read as "flat".
    change_bps:
      headline != null && prev != null && prev > 0
        ? Math.round(((headline - prev) / prev) * 10000)
        : null,
    basis: plan.windows.basis,
  };
}

/**
 * The comparison windows, for the gate.
 *
 * What makes a comparison honest is a property of the PAIR — `previous.end === current.start`
 * and the same elapsed span on both sides — and a property of a pair can only be asserted
 * if the pair is inspectable. Null for a report that declares no comparison.
 */
export async function resolveComparisonWindows(
  organizationId: string,
  businessId: string,
  key: string,
  opts: {
    range?: string;
    currency?: string;
    granularity?: string;
    agingInterval?: string;
    now?: Date;
  } = {},
): Promise<ReportComparisonWindows | null> {
  const def = REPORT_BY_KEY.get(key);
  if (!def) throw new ReportError(`No such report: ${key}`);
  if (!def.comparable) return null;
  const ctx = await loadContext(organizationId, businessId, opts, def);
  const buckets = reportBuckets(ctx.range, ctx.now, "back", ctx.granularity);
  return (await planComparison(organizationId, businessId, def, ctx, buckets)).windows;
}

export async function resolveReport(
  organizationId: string,
  businessId: string,
  key: string,
  opts: {
    range?: string;
    currency?: string;
    granularity?: string;
    /** The ageing ladder's rung width — see `AR_AGING_INTERVALS`. */
    agingInterval?: string;
    groupBy?: string;
    /** A predicate over the stored dimensions — see `CustomerFilter`. */
    customerFilter?: string;
    now?: Date;
  } = {},
): Promise<ReportResult> {
  const def = REPORT_BY_KEY.get(key);
  if (!def) throw new ReportError(`No such report: ${key}`);
  if (opts.groupBy && !def.dimensions.includes(opts.groupBy as ReportDimension)) {
    // Named, both ways: which cut was asked for and which ones this report actually has.
    // An empty breakdown would read as "no activity" when the truth is "wrong question".
    throw new ReportError(
      def.dimensions.length === 0
        ? `${def.name} cannot be grouped by ${opts.groupBy}: it has no dimensions`
        : `${def.name} cannot be grouped by ${opts.groupBy}. It can be grouped by: ` +
            `${def.dimensions.join(", ")}`,
    );
  }
  const filter =
    opts.customerFilter && opts.customerFilter !== ""
      ? parseCustomerFilter(opts.customerFilter, def)
      : undefined;
  const ctx = await loadContext(organizationId, businessId, opts, def);
  const buckets: Bucket[] = reportBuckets(
    ctx.range,
    ctx.now,
    def.shape === "forward" ? "forward" : "back",
    ctx.granularity,
  );
  const current = await resolveFigure(
    organizationId,
    businessId,
    def,
    ctx,
    buckets,
    opts.groupBy,
    filter,
  );
  if (!def.comparable) return current;
  return {
    ...current,
    comparison: await compareToPreviousPeriod(
      organizationId,
      businessId,
      def,
      ctx,
      buckets,
      current.headline,
      filter,
    ),
  };
}

/**
 * One report, over one window. Everything `resolveReport` does twice — the current window
 * and the comparison window — goes through here, so a comparison cannot be computed by a
 * second code path with its own idea of what the metric is.
 */
async function resolveFigure(
  organizationId: string,
  businessId: string,
  def: ReportDef,
  ctx: Ctx,
  buckets: Bucket[],
  groupBy?: string,
  filter?: CustomerFilter,
): Promise<ReportResult> {
  const base = {
    object: "report" as const,
    key: def.key,
    name: def.name,
    description: def.description,
    category: def.category,
    dimensions: def.dimensions,
    tags: def.tags ?? [],
    kind: def.kind,
    shape: def.shape,
    range: ctx.range,
    granularity: ctx.granularity,
    granularities: acceptsGranularity(def) ? GRANULARITIES : [],
    aging_interval: ctx.agingInterval,
    aging_intervals: acceptsAgingInterval(def) ? AR_AGING_INTERVALS : [],
    currency: ctx.reporting,
    converted: ctx.converted,
    customer_filter: filter?.raw,
    as_of: ctx.now.toISOString(),
  };

  if (def.source === "movement") {
    // A flow is filtered and grouped by joining the movement to its customer — no stored
    // dimension needed, because the ledger already carries `customer_id`.
    const countryOf =
      groupBy === "country" || filter
        ? await loadCustomerCountries(organizationId, businessId)
        : null;
    const inFilter = (m: MovementRow) =>
      !filter || !countryOf || filter.values.includes(countryOf.get(m.customerId) ?? null);

    if (def.shape === "periodic" && !def.customers) {
      const trialRows = await withTenant(organizationId, (tx) =>
        tx
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              and(
                eq(subscriptions.businessId, businessId),
                reportableCustomer(subscriptions.customerId),
              ),
              isNotNull(subscriptions.trialStart),
              notDeleted(),
            ),
          ),
      );
      const trialSubs = new Set(trialRows.map((t) => t.id));
      // A customer filter needs each row's customer, which a pre-grouped cell no longer has.
      const cells = filter
        ? (await loadMovements(organizationId, businessId))
            .filter(inFilter)
            .map((m) => cellOf(m, trialSubs))
        : await loadWaterfallCells(organizationId, businessId, ctx.now, trialSubs);
      return resolvePeriodicReport(def, ctx, cells, base);
    }

    const rows = (await loadMovements(organizationId, businessId)).filter(inFilter);

    if (def.customers) {
      return resolveCustomerMovementReport(def, ctx, rows, buckets, base);
    }

    if (def.shape === "cohort") {
      return resolveCohortReport(rows, def, ctx, base);
    }

    if (def.bucketing === "plan_movement") {
      /**
       * The from-plan → to-plan matrix. Only movements that actually CHANGED plan appear:
       * a row saying "Pro → Pro" is a quantity change wearing a plan change's clothes.
       * Movements with no from-plan (written before the column, or a first sale) are out.
       */
      const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
      const names = await withTenant(organizationId, (tx) =>
        tx
          .select({ id: products.id, publicId: products.publicId, name: products.name })
          .from(products)
          .where(eq(products.businessId, businessId)),
      );
      const nameOf = (id: string | null) =>
        id ? (names.find((n) => n.id === id)?.name ?? "Unknown") : "No plan";
      const acc = new Map<string, ReportRow>();
      for (const m of rows) {
        if (m.occurredAt < window.start || m.occurredAt >= window.end) continue;
        if (m.previousPlanProductId == null) continue;
        if (m.previousPlanProductId === m.planProductId) continue;
        const v = ctx.convert(Number(m.deltaMinor), m.currency, m.occurredAt);
        if (v == null) continue;
        const key = `${m.previousPlanProductId}→${m.planProductId ?? "none"}`;
        const row = acc.get(key) ?? {
          group: `${nameOf(m.previousPlanProductId)} → ${nameOf(m.planProductId)}`,
          group_id: null,
          value: 0,
        };
        row.value += v;
        acc.set(key, row);
      }
      return {
        ...base,
        headline: [...acc.values()].reduce((n, r) => n + r.value, 0),
        points: [],
        rows: [...acc.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)),
      };
    }

    const points = buckets.map((b) => ({
      t: b.t,
      label: b.label,
      v: sumMovement(rows, def, ctx, b),
    }));
    const window = { start: buckets[0]!.start, end: buckets[buckets.length - 1]!.end };
    const result: ReportResult = {
      ...base,
      headline: sumMovement(rows, def, ctx, window),
      points,
    };
    if (groupBy === "currency") {
      result.rows = groupByCurrency(
        rows
          .filter(
            (m) =>
              m.occurredAt >= window.start && m.occurredAt < window.end && matchesMovement(m, def),
          )
          .map((m) => ({
            currency: m.currency,
            amount:
              (def.signed ? Number(m.deltaMinor) : Math.abs(Number(m.deltaMinor))) *
              (def.multiplier ?? 1),
          })),
        ctx.scoped,
      );
    }
    if (groupBy === "country" && countryOf) {
      const acc = new Map<string | null, ReportRow>();
      for (const m of rows) {
        if (m.occurredAt < window.start || m.occurredAt >= window.end) continue;
        if (!matchesMovement(m, def)) continue;
        const raw = def.signed ? Number(m.deltaMinor) : Math.abs(Number(m.deltaMinor));
        const v = ctx.convert(raw, m.currency, m.occurredAt);
        if (v == null) continue;
        // `null` is the Unknown bucket and is never dropped: the rows have to sum to the
        // headline, and a customer with no country on file is still part of it.
        const country = countryOf.get(m.customerId) ?? null;
        const row = acc.get(country) ?? {
          group: countryLabel(country),
          group_id: country,
          value: 0,
        };
        row.value += v * (def.multiplier ?? 1);
        acc.set(country, row);
      }
      result.rows = [...acc.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    }
    if (groupBy === "plan") {
      const names = await withTenant(organizationId, (tx) =>
        tx
          .select({ id: products.id, publicId: products.publicId, name: products.name })
          .from(products)
          .where(eq(products.businessId, businessId)),
      );
      const acc = new Map<string, ReportRow>();
      for (const m of rows) {
        if (m.occurredAt < window.start || m.occurredAt >= window.end) continue;
        if (!matchesMovement(m, def)) continue;
        const raw = def.signed ? Number(m.deltaMinor) : Math.abs(Number(m.deltaMinor));
        const v = ctx.convert(raw, m.currency, m.occurredAt);
        if (v == null) continue;
        const id = m.planProductId;
        const p = id ? names.find((n) => n.id === id) : undefined;
        const gkey = id ?? "none";
        const row = acc.get(gkey) ?? {
          group: p?.name ?? (id ? "Unknown" : "No plan"),
          group_id: p?.publicId ?? null,
          value: 0,
        };
        row.value += v * (def.multiplier ?? 1);
        acc.set(gkey, row);
      }
      result.rows = [...acc.values()].sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    }
    return result;
  }

  if (def.source === "scheduled") {
    return resolveScheduledReport(organizationId, businessId, def, ctx, base);
  }

  if (def.source === "invoice") {
    if (def.periodic === "account_summary") {
      return resolveAccountSummary(organizationId, businessId, def, ctx, base);
    }
    return resolveInvoiceReport(organizationId, businessId, def, ctx, buckets, base, groupBy);
  }

  if (def.source === "transaction") {
    return resolveTransactionReport(organizationId, businessId, def, ctx, buckets, base, groupBy);
  }

  if (def.source === "payment") {
    return resolvePaymentReport(organizationId, businessId, def, ctx, buckets, base, groupBy);
  }

  if (def.source === "payment_method") {
    return resolvePaymentMethodReport(organizationId, businessId, def, ctx, base);
  }

  if (def.source === "checkout") {
    if (def.bucketing === "checkout_funnel")
      return resolveCheckoutReport(organizationId, businessId, buckets, base);
    if (def.bucketing === "cancellation_saves")
      return resolveCancellationSaves(organizationId, businessId, buckets, base);
    if (def.bucketing === "checkout_conversion" || def.bucketing === "checkout_payment_failures")
      return resolveCheckoutSegments(organizationId, businessId, def.bucketing, buckets, base);
    return resolveCheckoutRecovery(organizationId, businessId, def, ctx, buckets, base);
  }

  if (def.source === "subscription") {
    return resolveSubscriptionReport(organizationId, businessId, def, ctx, buckets, base);
  }

  if (def.source === "stock") {
    const measure = def.measure ?? "mrr";
    // The period in progress is read at NOW, like every periodic report: its end has not
    // happened, so no stored day holds it, and asking for it rebuilt the whole book on every
    // load to project a month-end nobody has reached. A wholly future bucket (a forward
    // series) still reads at its end — that projection is the point of it.
    const pointAt = (b: (typeof buckets)[number]) =>
      b.start <= ctx.now && ctx.now < b.end ? ctx.now : new Date(b.end.getTime() - 1);

    // A sliced stock is SUMMED from `metric_daily`'s country slice, never rebuilt per slice —
    // the decision this dimension exists to implement. The rebuild stays behind it for
    // days the store has not reached, exactly as the unsliced stock keeps one.
    if (groupBy === "country" || filter) {
      const instants = [...buckets.map(pointAt), ctx.now];
      const byCountry = await loadCountryStockReaders(organizationId, businessId, ctx, instants);
      if (filter) {
        const at = async (d: Date) =>
          (await byCountry.totalAt(d, measure, filter.values)) * (def.multiplier ?? 1);
        const headline = await at(ctx.now);
        const points = await Promise.all(
          buckets.map(async (b) => ({
            t: b.t,
            label: b.label,
            v: await at(pointAt(b)),
          })),
        );
        return {
          ...base,
          headline,
          points,
          ...(groupBy === "country"
            ? {
                rows: (await byCountry.rowsAt(ctx.now, measure))
                  .filter((r) => filter.values.includes(r.group_id))
                  .map((r) => ({ ...r, value: r.value * (def.multiplier ?? 1) })),
              }
            : {}),
        };
      }
      const readers = await loadStockReaders(organizationId, businessId, ctx, instants);
      const rows = await byCountry.rowsAt(ctx.now, measure);
      return {
        ...base,
        headline: (await readers.at(ctx.now, measure)) * (def.multiplier ?? 1),
        points: await Promise.all(
          buckets.map(async (b) => ({
            t: b.t,
            label: b.label,
            v: (await readers.at(pointAt(b), measure)) * (def.multiplier ?? 1),
          })),
        ),
        rows: rows.map((r) => ({ ...r, value: r.value * (def.multiplier ?? 1) })),
      };
    }

    const instants = [...buckets.map(pointAt), ctx.now];
    const readers = await loadStockReaders(organizationId, businessId, ctx, instants);
    const points = await Promise.all(
      buckets.map(async (b) => ({
        t: b.t,
        label: b.label,
        v: (await readers.at(pointAt(b), measure)) * (def.multiplier ?? 1),
      })),
    );
    return {
      ...base,
      // A stock's headline is its CURRENT value, not the last bucket's: the last bucket ends
      // at midnight tonight (or, for a forward series, months out).
      headline: (await readers.at(ctx.now, measure)) * (def.multiplier ?? 1),
      points,
    };
  }

  // `derived`: arithmetic over the two above, quoted over the last complete calendar month.
  const rows = await loadMovements(organizationId, businessId);
  const w = await lastCompleteMonth(organizationId, businessId, ctx.now);
  const sumOf = (reasons: ReportDef["reasons"], signed = false) =>
    sumMovement(rows, { ...def, reasons, signed, multiplier: 1 }, ctx, w);
  // Opening = the previous period's close, one millisecond before the window: a movement
  // stamped at `w.start` is this window's flow, not also its opening.
  const openAt = new Date(w.start.getTime() - 1);
  const startingMrr = await (
    await loadStockReaders(organizationId, businessId, ctx, [openAt])
  ).at(openAt, "mrr");
  const newMrr = sumOf(["new"]);
  const expansion = sumOf(["expansion"]);
  const reactivation = sumOf(["reactivation", "resume"]);
  const contraction = sumOf(["contraction"]);
  const churn = sumOf(["churn", "pause"]);
  /**
   * Retention may only be moved by the cohort the window OPENED with — the subscriptions
   * earning at its opening. Anyone who arrived inside it and left again was never in the base
   * it divides by; counting their loss let the published rate go negative.
   */
  const balanceAtOpen = new Map<string, bigint>();
  for (const m of rows) {
    if (m.occurredAt > openAt) continue;
    balanceAtOpen.set(
      m.subscriptionId,
      (balanceAtOpen.get(m.subscriptionId) ?? 0n) + BigInt(m.deltaMinor),
    );
  }
  const cohortRows = rows.filter((m) => (balanceAtOpen.get(m.subscriptionId) ?? 0n) > 0n);
  const cohortSum = (reasons: ReportDef["reasons"]) =>
    sumMovement(cohortRows, { ...def, reasons, signed: false, multiplier: 1 }, ctx, w);

  const countOf = (reasons: ReadonlyArray<string>) =>
    rows.filter(
      (m) =>
        m.occurredAt >= w.start &&
        m.occurredAt < w.end &&
        reasons.includes(m.reason) &&
        ctx.convert(0, m.currency) != null,
    ).length;

  let headline: number | null = null;
  switch (def.formula) {
    case "net_mrr_growth":
      headline = sumOf(undefined, true);
      break;
    case "net_mrr_growth_rate":
      headline =
        startingMrr > 0 ? Math.round((sumOf(undefined, true) / startingMrr) * 10000) : null;
      break;
    case "gross_retention":
    case "net_retention":
    case "quick_ratio": {
      const r = retentionRates({
        startingMrr,
        newMrr,
        // The quick ratio is everything gained over everything lost; the two retentions are
        // the opening cohort's own moves only.
        expansion: def.formula === "quick_ratio" ? expansion : cohortSum(["expansion"]),
        reactivation:
          def.formula === "quick_ratio" ? reactivation : cohortSum(["reactivation", "resume"]),
        contraction: def.formula === "quick_ratio" ? contraction : cohortSum(["contraction"]),
        churn: def.formula === "quick_ratio" ? churn : cohortSum(["churn", "pause"]),
      });
      headline =
        def.formula === "gross_retention"
          ? r.gross_retention_bps
          : def.formula === "net_retention"
            ? r.net_retention_bps
            : r.quick_ratio_bps;
      break;
    }
    case "arpu_new": {
      const n = countOf(["new"]);
      headline = n > 0 ? Math.round(newMrr / n) : null;
      break;
    }
    case "arpu_churned": {
      const n = countOf(["churn", "pause"]);
      headline = n > 0 ? Math.round(churn / n) : null;
      break;
    }
    case "arps": {
      // Recurring revenue over the subscriptions actually paying for it — the PAYING count,
      // not the active one, or a free tier drags the average down without earning anything.
      const readers = await loadStockReaders(organizationId, businessId, ctx, [ctx.now]);
      const mrrNow = await readers.at(ctx.now, "mrr");
      const paying = await readers.at(ctx.now, "paying_subscriptions");
      headline = paying > 0 ? Math.round(mrrNow / paying) : null;
      break;
    }
    case "ltv": {
      /**
       * Average monthly revenue per paying subscription × the average life of one that has
       * ENDED.
       *
       * Only ended subscriptions have a life to measure; including the living would report a
       * young book as short-lived. Null until something has actually churned, because a
       * lifetime with no completed lifetime in it is not an estimate, it is a guess.
       */
      const readers = await loadStockReaders(organizationId, businessId, ctx, [ctx.now]);
      const mrrNow = await readers.at(ctx.now, "mrr");
      const paying = await readers.at(ctx.now, "paying_subscriptions");
      const ended = await withTenant(organizationId, (tx) =>
        tx
          .select({
            startedAt: subscriptions.startedAt,
            startDate: subscriptions.startDate,
            createdAt: subscriptions.createdAt,
            canceledAt: subscriptions.canceledAt,
            currency: subscriptions.currency,
          })
          .from(subscriptions)
          .where(
            and(
              and(
                eq(subscriptions.businessId, businessId),
                reportableCustomer(subscriptions.customerId),
              ),
              isNotNull(subscriptions.canceledAt),
              notDeleted(),
            ),
          ),
      );
      const lives = ended.filter((s) => ctx.convert(0, s.currency) != null);
      if (paying <= 0 || lives.length === 0) {
        headline = null;
        break;
      }
      const months =
        lives.reduce(
          (sum, s) =>
            sum +
            (s.canceledAt!.getTime() - (s.startedAt ?? s.startDate ?? s.createdAt).getTime()) /
              (30 * 86_400_000),
          0,
        ) / lives.length;
      headline = Math.round((mrrNow / paying) * months);
      break;
    }
    case "arpc": {
      /**
       * Recurring revenue over the CUSTOMERS paying it, where the per-subscription figure
       * beside it divides by subscriptions. A customer with three subscriptions is one
       * denominator, so this sits above the per-subscription average by exactly the average
       * number of subscriptions an account holds.
       */
      const readers = await loadStockReaders(organizationId, businessId, ctx, [ctx.now]);
      const mrrNow = await readers.at(ctx.now, "mrr");
      const heads = await readers.payingCustomers(ctx.now);
      headline = heads > 0 ? Math.round(mrrNow / heads) : null;
      break;
    }
    case "customer_ltv": {
      /**
       * Revenue per paying customer × the average life of an ACCOUNT that has ended.
       *
       * Both halves at customer grain, deliberately: pairing per-customer revenue with a
       * per-subscription lifetime would understate an account that replaced one
       * subscription with another, because the subscription's life ended and the account's
       * did not. Null until something has fully ended — a lifetime value with no completed
       * lifetime in it is a guess, not an estimate.
       */
      const readers = await loadStockReaders(organizationId, businessId, ctx, [ctx.now]);
      const heads = await readers.payingCustomers(ctx.now);
      const months = await averageCustomerLifetimeMonths(organizationId, businessId, ctx);
      headline =
        heads > 0 && months != null
          ? Math.round(((await readers.at(ctx.now, "mrr")) / heads) * months)
          : null;
      break;
    }
    case "paused_mrr": {
      /**
       * What a pause SUSPENDED, which the cached rate cannot say: pausing zeroes
       * `subscriptions.mrr` by design, so summing the column reports nothing paused. The
       * ledger keeps the rate the subscription carried into the pause, and the latest pause
       * per subscription — with no later resume — is what is still suspended today.
       */
      const paused = await withTenant(organizationId, (tx) =>
        tx
          .select({ id: subscriptions.id, currency: subscriptions.currency })
          .from(subscriptions)
          .where(
            and(
              and(
                eq(subscriptions.businessId, businessId),
                reportableCustomer(subscriptions.customerId),
              ),
              eq(subscriptions.status, "paused"),
              notDeleted(),
            ),
          ),
      );
      const latestPause = new Map<string, number>();
      for (const m of rows) {
        if (m.reason !== "pause") continue;
        latestPause.set(m.subscriptionId, Number(m.previousMrrMinor));
      }
      headline = paused.reduce(
        (sum, s) => sum + (ctx.convert(latestPause.get(s.id) ?? 0, s.currency) ?? 0),
        0,
      );
      break;
    }
    default:
      throw new ReportError(`Report ${def.key} declares no formula`);
  }

  return {
    ...base,
    headline,
    points: [],
    window_label: monthLabel(monthOf(w)),
  };
}
