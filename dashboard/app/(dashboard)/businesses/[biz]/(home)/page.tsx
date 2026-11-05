import { listBusinesses, listCustomers, getReport, type ReportResult } from "@/lib/api";
import { listDisputes } from "@/lib/api/disputes";
import { fetchQueueCounts, queueItems } from "@/lib/attention-queues";
import {
  queryAnalytics,
  type AnalyticsQuery,
  type BatchEntry,
  type AnalyticsResult,
  getSyncedAt,
} from "@/lib/analytics-api";
import { requirePermission } from "@/lib/session";
import { SyncedBadge } from "@/components/analytics/synced-badge";
import { PageHeader } from "@/components/page-header";
import { PaletteWelcome } from "@/components/palette-hints";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import { SetupChecklist } from "@/components/home/setup-checklist";
import { resolveSetupSteps } from "@/lib/setup-readiness";
import { HomeTabs, type HomeTab } from "@/components/analytics/home/tabs";
import { CurrencyPicker } from "@/components/analytics/home/currency-picker";
import { BoardRangePicker } from "@/components/reports/board-range-picker";
import { overviewZones } from "@/components/analytics/home/overview";
import { recurringZones } from "@/components/analytics/home/book";
import { collectionsZones } from "@/components/analytics/home/money";
import { creditsZones, salesZones, usageZones } from "@/components/analytics/home/models";
import { ZoneHeading, ZoneMeta } from "@/components/analytics/home/zone";
import {
  currencyBasis,
  localYmd,
  missingRatesWarning,
  pick,
  rangeLabel,
  slice,
  type Basis,
  type LinkWindow,
} from "@/components/analytics/home/parts";
import { PageNote } from "@/components/analytics/layout";
import {
  OverviewCurrentSkeleton,
  OverviewPerformanceSkeleton,
  RecurringCurrentSkeleton,
  RecurringPerformanceSkeleton,
  CollectionsCurrentSkeleton,
  CollectionsPerformanceSkeleton,
} from "@/components/analytics/home/skeletons";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";

export const dynamic = "force-dynamic";

const TABS = new Set<HomeTab>([
  "overview",
  "recurring",
  "collections",
  "credits",
  "usage",
  "sales",
]);

/**
 * The page-wide period: every FLOW and STOCK on every tab answers it. Positions the engine keeps
 * no history for (receivables, trials, dunning, scheduled changes) stay readings as they stand
 * and say so. Rolling windows first, then calendar ones.
 *
 * `countGrain` is the one stored bucket a calendar period IS. A distinct count (customers) is
 * never a sum of buckets, so a calendar preset reads that bucket; a rolling preset or a custom
 * range reads the window the engine computed for exactly those dates (`total_basis: window`).
 */
const PERIODS = [
  { id: "today", label: "Today", range: "today", grain: "day", countGrain: null },
  { id: "yesterday", label: "Yesterday", range: "yesterday", grain: "day", countGrain: null },
  { id: "7d", label: "Last 7 days", range: "7d", grain: "day", countGrain: null },
  { id: "30d", label: "Last 30 days", range: "30d", grain: "day", countGrain: null },
  { id: "90d", label: "Last 90 days", range: "90d", grain: "day", countGrain: null },
  { id: "6m", label: "Last 6 months", range: "6m", grain: "month", countGrain: null },
  { id: "12m", label: "Last 12 months", range: "12m", grain: "month", countGrain: null },
  { id: "this_month", label: "This month", range: "this_month", grain: "day", countGrain: "month" },
  { id: "last_month", label: "Last month", range: "last_month", grain: "day", countGrain: "month" },
  {
    id: "this_quarter",
    label: "This quarter",
    range: "this_quarter",
    grain: "day",
    countGrain: "quarter",
  },
  {
    id: "this_year",
    label: "Year to date",
    range: "this_year",
    grain: "month",
    countGrain: "year",
  },
] as const;

const isYmd = (v: string | undefined): v is string => v != null && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The ageing ladder, read only by the tabs that show it. */
const report = (biz: string, key: string, currency?: string, range?: "daily" | "12m") =>
  getReport(biz, key, { range, currency }).catch(() => null);

/**
 * Calendar arithmetic on a LOCAL date string.
 *
 * `YYYY-MM-DD` here is already the business's own date, so shifting it is calendar work, not
 * instant work — UTC is used purely as a calendar that never shifts under the arithmetic. A
 * local instant would be the wrong tool: on a DST day it would move by an hour and hand back
 * the neighbouring date.
 */
function shiftDay(date: string, by: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` today, in the zone the business's own calendar runs on. */
function todayIn(tz: string | null): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * Business Home: one route, three views, each in two zones. "Current" holds readings as they
 * stand and ignores the period; "Performance" holds everything the period drives. The view is
 * a URL parameter rather than client state, so a link is shareable, Back works, and each view
 * fetches only what it renders.
 *
 * Every semantic-layer figure a view shows arrives in ONE batched POST — the per-tab query
 * lists below are that batch. A refused slot is rendered as the engine's own sentence; the
 * rest of the screen still answers.
 *
 * NOTHING here reconstructs the subscription book any more. Every figure is a stored measure,
 * including the calendar windows and the credit-note total — the two that held the old payload
 * open. Those needed `metric_daily` to be cut on the BUSINESS's day rather than the UTC one,
 * because a window asked of UTC rows counts different rows than the list it deep-links into;
 * on a book five and a half hours off UTC that was a fifth of a one-day window.
 *
 * ⚠️ That day-boundary property is load-bearing HERE: these windows are stated as local dates
 * and trusted to be the engine's own buckets. Cut the table on UTC days again and every figure
 * in the strip silently drifts by the zone offset rather than failing.
 */
export default async function BizHome({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    msg?: string;
    error?: string;
    tab?: string;
    currency?: string;
    period?: string;
    /** A custom window, as calendar dates. Both or neither. */
    start?: string;
    end?: string;
  }>;
}) {
  const { biz } = await params;
  const {
    msg,
    error,
    tab: tabParam,
    currency: currencyParam,
    period: periodParam,
    start: startParam,
    end: endParam,
  } = await searchParams;
  const user = await requirePermission("reports:view", "ops");

  const tab: HomeTab = TABS.has(tabParam as HomeTab) ? (tabParam as HomeTab) : "overview";
  // "Last 30 days" is the default: it lines up with monthly billing better than 28 or 7.
  const preset = PERIODS.find((p) => p.id === periodParam) ?? PERIODS.find((p) => p.id === "30d")!;
  const custom =
    isYmd(startParam) && isYmd(endParam) && startParam <= endParam
      ? { start: startParam, end: endParam }
      : null;
  const spanDays = custom
    ? Math.round((Date.parse(custom.end) - Date.parse(custom.start)) / 86_400_000) + 1
    : 0;
  /** Where the window comes from: a named range the engine resolves, or explicit dates. */
  const WHEN = custom ? { start: custom.start, end: custom.end } : { range: preset.range };
  /** The MRR chart: daily over a short window, monthly over a long one. */
  const CHART = {
    ...WHEN,
    grain: (custom ? (spanDays <= 92 ? "day" : "month") : preset.grain) as "day" | "month",
  };
  /**
   * Every other figure's window. Month buckets: every measure stores them, and a sum or a
   * ratio's window total does not depend on the bucket size — the engine folds a ratio from the
   * first bucket's opening, never by adding openings.
   */
  const PERIOD = { ...WHEN, grain: "month" as const };
  /** A distinct count's window: the stored calendar bucket, or the window itself. */
  const COUNT =
    !custom && preset.countGrain
      ? { range: preset.range, grain: preset.countGrain }
      : { ...WHEN, grain: "month" as const };
  // Written exactly as the picker writes a custom window, so the headings and the control agree.
  const dayLabel = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  /** The period in the URL, carried by every link that should keep it. */
  const periodCarry: Record<string, string> = custom
    ? { start: custom.start, end: custom.end }
    : periodParam && preset.id === periodParam
      ? { period: preset.id }
      : {};
  const currency = (currencyParam ?? "ALL").toUpperCase();
  // The reports and the semantic layer both take a real ISO code or none at all: `ALL` is
  // this page's own word for the converted roll-up, never something they can answer for.
  const scoped = currency === "ALL" ? undefined : currency;
  /** The ageing ladder and the dispute deadline: only Collections shows them. */
  const needsReports = tab === "collections";

  /**
   * The business row first, and alone.
   *
   * It is a cheap list read, and everything after it is shaped by what it says: the reporting
   * currency, the selector, and the zone the all-time window ends in. Waiting for it here is
   * what lets every expensive read below start together instead of in two rounds.
   */
  let businesses: Awaited<ReturnType<typeof listBusinesses>>;
  try {
    businesses = await listBusinesses();
  } catch (e) {
    return (
      <>
        <PageHeader title="Business" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz);
  // A fiscal year that does not start in January says so: the window is the fiscal one.
  const fiscal = (business?.fiscal_year_start_month ?? 1) !== 1;
  const labelOf = (p: (typeof PERIODS)[number]): string =>
    fiscal && p.id === "this_year"
      ? "Fiscal year to date"
      : fiscal && p.id === "this_quarter"
        ? "This fiscal quarter"
        : p.label;
  const periodLabel = custom
    ? `${dayLabel(custom.start)} – ${dayLabel(custom.end)}`
    : labelOf(preset);
  // Dates render in the business timezone: the engine's day boundaries are midnight there.
  const tz = business?.timezone ?? null;
  const baseCurrency = business?.default_currency ?? "USD";

  /**
   * The currency basis, off the business record the page already had.
   *
   * This used to come from the reconstructed payload, which derived the same list by scanning
   * every subscription, invoice and transaction the business owns. `currencies` is the set the
   * business is configured to transact in and `exchange_rates` the rates it publishes, so the
   * selector offers what can actually be asked for and the excluded list names what has no
   * rate — the same two answers, from a row that was already on the wire.
   */
  const availableCurrencies = business?.currencies?.length
    ? [...business.currencies].sort()
    : [baseCurrency];
  const rates = business?.exchange_rates ?? {};
  const reporting = scoped ?? baseCurrency;

  /**
   * A measure the engine keeps no history for — receivables, dunning, card counts, the trial
   * and scheduled-change book — carries a figure only in the period IN PROGRESS. A short
   * window at day grain ends on today, so the total is the reading as it stands.
   */
  const READING = { grain: "day", range: "7d" } as const;
  /**
   * Today and yesterday, as the business's own dates, for Collections' "Today so far".
   *
   * `metric_daily` is cut on the business's local day, so a local date IS the engine's bucket
   * and the figures agree with the lists they deep-link into. Cut it on UTC days again and
   * these drift by the zone offset rather than failing.
   */
  const today = todayIn(tz);
  const DAYS = [
    { id: "today", day: today },
    { id: "yest", day: shiftDay(today, -1) },
  ] as const;
  const WINDOWS: AnalyticsQuery[] = DAYS.flatMap((w) => [
    { key: `w_${w.id}_billed`, measure: "billing_gross", grain: "day", start: w.day, end: w.day },
    { key: `w_${w.id}_cash`, measure: "cash_collected", grain: "day", start: w.day, end: w.day },
    {
      key: `w_${w.id}_signups`,
      measure: "customers_created",
      grain: "day",
      start: w.day,
      end: w.day,
    },
  ]);

  /** The booked book: counts, and MRR by horizon band. Readings, never a series. */
  const SCHEDULED: AnalyticsQuery[] = [
    { key: "sched_up_n", measure: "scheduled_upgrades", ...READING },
    { key: "sched_down_n", measure: "scheduled_downgrades", ...READING },
    { key: "sched_cancel_n", measure: "scheduled_cancellations", ...READING },
    { key: "sched_up", measure: "scheduled_upgrade_mrr", split: "horizon", ...READING },
    { key: "sched_down", measure: "scheduled_downgrade_mrr", split: "horizon", ...READING },
    { key: "sched_cancel", measure: "scheduled_cancellation_mrr", split: "horizon", ...READING },
  ];

  /** What is owed, and across how many invoices. Both readings, never a series. */
  const RECEIVABLES: AnalyticsQuery[] = [
    { key: "recv_amount", measure: "receivables_outstanding", ...READING },
    { key: "recv_count", measure: "receivables_invoices", ...READING },
  ];

  /**
   * The period's rates. Asked for rather than derived: the engine folds each once, on its own
   * numerator and denominator, and `gross_revenue_retention`'s denominator IS the opening MRR.
   */
  const RATES: AnalyticsQuery[] = [
    { key: "m_churn", measure: "mrr_churn", ...PERIOD },
    { key: "grr", measure: "gross_revenue_retention", ...PERIOD },
    { key: "nrr", measure: "net_revenue_retention", ...PERIOD },
    { key: "quick", measure: "quick_ratio", ...PERIOD },
  ];
  /** The period's MRR flows, whole. */
  const FLOWS: AnalyticsQuery[] = [
    { key: "m_new", measure: "mrr_new", ...PERIOD },
    { key: "m_expansion", measure: "mrr_expansion", ...PERIOD },
    { key: "m_reactivation", measure: "mrr_reactivation", ...PERIOD },
    { key: "m_contraction", measure: "mrr_contraction", ...PERIOD },
  ];
  /** The same flows per bucket — the grain follows the period, as the MRR chart's does. */
  const TREND: AnalyticsQuery[] = [
    { key: "t_new", measure: "mrr_new", ...CHART },
    { key: "t_expansion", measure: "mrr_expansion", ...CHART },
    { key: "t_reactivation", measure: "mrr_reactivation", ...CHART },
    { key: "t_contraction", measure: "mrr_contraction", ...CHART },
    { key: "t_churn", measure: "mrr_churn", ...CHART },
    { key: "t_net", measure: "net_new_mrr", ...CHART },
  ];
  const byPlan = (key: string, measure: string): AnalyticsQuery => ({
    key,
    measure,
    split: "plan",
    split_limit: 12,
    ...PERIOD,
  });
  /** Gateway attempts and failures by normalised reason, over the period. */
  const GATEWAY: AnalyticsQuery[] = [
    { key: "gw_attempts", measure: "payment_attempts", ...PERIOD },
    {
      key: "gw_failures",
      measure: "payment_failures",
      split: "failure_reason",
      split_limit: 25,
      ...PERIOD,
    },
  ];

  /** Renewal cash already due, and how many renewals carry it. Readings, banded by horizon. */
  const EXPECTED: AnalyticsQuery[] = [
    { key: "expected_cash", measure: "expected_renewal_cash", split: "horizon", ...READING },
    { key: "expected_renewals", measure: "expected_renewals", split: "horizon", ...READING },
  ];
  /** Open disputes. Provisional measures: refused until the engine publishes them. */
  const DISPUTES: AnalyticsQuery[] = [
    { key: "disputes_open", measure: "disputes_open", split: "horizon", ...READING },
    { key: "disputes_amount", measure: "disputes_open_amount", ...READING },
  ];

  const QUERIES: Record<HomeTab, AnalyticsQuery[]> = {
    overview: [
      // Current
      { key: "mrr_now", measure: "mrr", ...READING },
      { key: "arr", measure: "arr", ...READING },
      { key: "cmrr", measure: "cmrr", ...READING },
      { key: "subs_active", measure: "active_subscriptions", ...READING },
      { key: "subs_paying", measure: "paying_subscriptions", ...READING },
      { key: "subs_renewing", measure: "renewing_subscriptions", ...READING },
      { key: "arpa", measure: "revenue_per_paying_customer", ...READING },
      { key: "cust_paying_now", measure: "paying_customers", ...READING },
      { key: "sched_cancel_n", measure: "scheduled_cancellations", ...READING },
      { key: "sched_cancel", measure: "scheduled_cancellation_mrr", split: "horizon", ...READING },
      { key: "mrr_at_risk", measure: "mrr_at_risk", ...READING },
      { key: "dunning_subs", measure: "dunning_subscriptions", ...READING },
      // The headline row: always the last 30 days, whatever the Performance period says.
      { key: "h_mrr", measure: "mrr", range: "30d", grain: "day" },
      { key: "h_paying", measure: "paying_customers", range: "30d", grain: "day" },
      { key: "h_cust_churn", measure: "customer_churn_rate", range: "30d", grain: "month" },
      { key: "h_mrr_churn", measure: "gross_mrr_churn_rate", range: "30d", grain: "month" },
      { key: "h_churned", measure: "mrr_churn", range: "30d", grain: "month" },
      { key: "h_trial_conv", measure: "trial_conversion_rate", range: "30d", grain: "month" },
      { key: "h_mrr_new", measure: "mrr_new", range: "30d", grain: "month" },
      // Performance
      { key: "mrr", measure: "mrr", ...CHART, compare: "previous" },
      ...RATES,
      ...FLOWS,
      { key: "m_net", measure: "net_new_mrr", ...PERIOD },
      // Net new MRR counts pauses too; without this its parts cannot add up to it.
      { key: "m_paused", measure: "mrr_paused", ...PERIOD },
      { key: "created_series", measure: "customers_created", ...CHART },
      { key: "new_paying_series", measure: "customers_new", ...CHART },
      { key: "churn_series", measure: "mrr_churn", ...CHART },
      // Provisional dimension: refused until the engine splits churn by kind.
      { key: "churn_kind", measure: "mrr_churn", split: "churn_kind", ...CHART },
      // Distinct counts and a logo rate: the stored calendar bucket, or the window itself.
      { key: "cust_new", measure: "customers_new", ...COUNT },
      { key: "cust_churned", measure: "customers_churned", ...COUNT },
      { key: "cust_churn_rate", measure: "customer_churn_rate", ...COUNT },
      // Converted over ended, both dated in the period — a rate, so it folds, never averages.
      { key: "trial_conv", measure: "trial_conversion_rate", ...PERIOD },
      { key: "trials_started", measure: "trials_started", ...PERIOD },
      { key: "p_billed", measure: "billing_gross", ...PERIOD },
      { key: "p_cash", measure: "cash_collected", ...PERIOD },
      { key: "recovered", measure: "amount_recovered", ...PERIOD },
      { key: "refunds", measure: "refunds_issued", ...PERIOD },
      // Revenue mix: shown only when the period has revenue other than subscriptions.
      { key: "rev_mix", measure: "revenue_billed", split: "revenue_type", ...PERIOD },
      { key: "rev_mix_cash", measure: "revenue_collected", split: "revenue_type", ...PERIOD },
      ...GATEWAY,
    ],
    recurring: [
      // Current
      { key: "mrr_by_plan", measure: "mrr", split: "plan", split_limit: 12, ...READING },
      { key: "mrr_by_interval", measure: "mrr", split: "billing_interval", ...READING },
      { key: "mrr_by_country", measure: "mrr", split: "country", split_limit: 8, ...READING },
      // Provisional measure: refused until the engine publishes it.
      { key: "mrr_top10", measure: "mrr_top10_share", ...READING },
      ...SCHEDULED,
      // Performance
      ...RATES,
      ...FLOWS,
      { key: "net_growth", measure: "net_mrr_growth_rate", ...PERIOD },
      { key: "churn_rate", measure: "gross_mrr_churn_rate", ...PERIOD },
      { key: "m_paused", measure: "mrr_paused", ...PERIOD },
      { key: "m_fx", measure: "mrr_fx_impact", ...PERIOD },
      // The waterfall's edges: closing MRR, and the opening as the previous window's close.
      { key: "m_book", measure: "mrr", ...PERIOD, compare: "previous" },
      ...TREND,
      // Losses arrive as positive magnitudes, like the totals.
      byPlan("p_new", "mrr_new"),
      byPlan("p_expansion", "mrr_expansion"),
      byPlan("p_reactivation", "mrr_reactivation"),
      byPlan("p_contraction", "mrr_contraction"),
      byPlan("p_churn", "mrr_churn"),
      { key: "ue_new", measure: "revenue_per_new_subscription", ...PERIOD },
      { key: "ue_churned", measure: "revenue_lost_per_churned_subscription", ...PERIOD },
      { key: "ue_subs_per_cust", measure: "subscriptions_per_customer", ...PERIOD },
      { key: "ue_clv", measure: "customer_lifetime_value", ...PERIOD },
      { key: "ue_life", measure: "average_customer_lifetime", ...PERIOD },
    ],
    collections: [
      // Current
      ...WINDOWS,
      ...RECEIVABLES,
      ...EXPECTED,
      // What was billed in the last 30 days — the yardstick for what is to be billed in the next.
      { key: "h_billed", measure: "billing_gross", range: "30d", grain: "month" },
      { key: "dunning", measure: "dunning_invoices", split: "dunning_status", ...READING },
      ...DISPUTES,
      // Performance
      { key: "p_billed", measure: "billing_gross", ...PERIOD },
      { key: "p_cash", measure: "cash_collected", ...PERIOD },
      { key: "recovered", measure: "amount_recovered", ...PERIOD },
      { key: "lost", measure: "amount_exhausted", ...PERIOD },
      { key: "recovered_n", measure: "dunning_recovered_invoices", ...PERIOD },
      { key: "lost_n", measure: "dunning_exhausted_invoices", ...PERIOD },
      { key: "paid_late", measure: "recovery_paid_late", split: "lateness_band", ...PERIOD },
      { key: "disp_opened", measure: "disputes_opened", ...PERIOD },
      { key: "disp_opened_amt", measure: "disputes_opened_amount", ...PERIOD },
      { key: "disp_won", measure: "disputes_won", ...PERIOD },
      { key: "disp_won_amt", measure: "disputes_won_amount", ...PERIOD },
      { key: "disp_lost", measure: "disputes_lost", ...PERIOD },
      { key: "disp_lost_amt", measure: "disputes_lost_amount", ...PERIOD },
      ...GATEWAY,
      { key: "att_series", measure: "payment_attempts", ...CHART },
      { key: "fail_series", measure: "payment_failures", ...CHART },
      // Provisional dimension: refused until attempts are split by gateway.
      {
        key: "gw_att_by",
        measure: "payment_attempts",
        split: "gateway",
        split_limit: 12,
        ...PERIOD,
      },
      {
        key: "gw_fail_by",
        measure: "payment_failures",
        split: "gateway",
        split_limit: 12,
        ...PERIOD,
      },
      { key: "cash_recurring", measure: "cash_recurring", ...PERIOD },
      { key: "cash_non_recurring", measure: "cash_non_recurring", ...PERIOD },
      { key: "cash_usage", measure: "cash_usage", ...PERIOD },
      { key: "cash_recurring_net", measure: "cash_recurring_net", ...PERIOD },
      { key: "refunds", measure: "refunds_issued", ...PERIOD },
      // Dated by each note's own issue date.
      { key: "cn", measure: "credit_notes_issued", ...PERIOD },
      { key: "discount_given", measure: "discount_given", ...PERIOD },
      { key: "tax_charged", measure: "tax_charged", ...PERIOD },
      { key: "taxable_base", measure: "taxable_base", ...PERIOD },
      { key: "exempt_base", measure: "exempt_base", ...PERIOD },
      { key: "voided", measure: "invoice_voided", ...PERIOD },
      { key: "written_off", measure: "invoice_written_off", ...PERIOD },
    ],
    credits: [
      // Current
      { key: "c_balance", measure: "credits_outstanding", ...READING },
      { key: "c_by_unit", measure: "credits_outstanding", split: "credit_unit", ...READING },
      { key: "c_liability", measure: "credits_liability", ...READING },
      { key: "c_customers", measure: "credit_customers", ...READING },
      { key: "c_prepaid", measure: "prepaid_balance", ...READING },
      { key: "c_expiring", measure: "credits_expiring", split: "horizon", ...READING },
      // Performance
      { key: "c_granted", measure: "credits_granted", ...PERIOD },
      { key: "c_granted_by", measure: "credits_granted", split: "credit_source", ...PERIOD },
      { key: "c_used", measure: "credits_used", ...PERIOD },
      { key: "c_used_series", measure: "credits_used", ...CHART },
      { key: "c_used_cost", measure: "credits_used_cost", ...PERIOD },
      { key: "c_expired", measure: "credits_expired", ...PERIOD },
      { key: "c_breakage", measure: "credit_breakage", ...PERIOD },
      { key: "c_packs", measure: "credit_packs_sold", ...PERIOD },
      { key: "c_pack_revenue", measure: "revenue_billed", split: "revenue_type", ...PERIOD },
    ],
    usage: [
      // Current: the last 30 days, whatever the Performance period says.
      {
        key: "u_rev30",
        measure: "revenue_billed",
        split: "revenue_type",
        range: "30d",
        grain: "month",
      },
      { key: "u_events30", measure: "usage_events", range: "30d", grain: "month" },
      { key: "u_customers30", measure: "usage_customers", range: "30d", grain: "month" },
      // Performance
      { key: "u_rev", measure: "revenue_billed", split: "revenue_type", ...PERIOD },
      { key: "u_rev_meter", measure: "revenue_billed", split: "meter", ...PERIOD },
      { key: "u_events", measure: "usage_events", ...PERIOD },
      { key: "u_events_series", measure: "usage_events", ...CHART },
      { key: "u_events_meter", measure: "usage_events", split: "meter", ...PERIOD },
      { key: "u_customers", measure: "usage_customers", ...COUNT },
      { key: "u_cost", measure: "usage_cost", ...PERIOD },
      { key: "u_retention", measure: "usage_revenue_retention", ...COUNT },
    ],
    sales: [
      // Current: the last 30 days, whatever the Performance period says.
      { key: "s_orders30", measure: "orders", range: "30d", grain: "month" },
      { key: "s_revenue30", measure: "order_revenue", range: "30d", grain: "month" },
      { key: "s_aov30", measure: "average_order_value", range: "30d", grain: "month" },
      // Performance
      { key: "s_orders", measure: "orders", ...PERIOD },
      { key: "s_orders_series", measure: "orders", ...CHART },
      { key: "s_revenue", measure: "order_revenue", ...PERIOD },
      {
        key: "s_by_product",
        measure: "order_revenue",
        split: "product",
        split_limit: 10,
        ...PERIOD,
      },
      { key: "s_aov", measure: "average_order_value", ...PERIOD },
      { key: "s_buyers", measure: "buyers", ...COUNT },
      { key: "s_returning", measure: "returning_buyers", ...COUNT },
      { key: "s_returning_rate", measure: "returning_buyer_rate", ...COUNT },
      { key: "s_refunds", measure: "order_refunds", ...PERIOD },
    ],
  };

  /**
   * The batch, in as few round trips as the engine allows.
   *
   * `POST /v1/analytics/query` caps a batch, and answers 400 — not a per-slot refusal — for
   * the question past it, so a view asking more is chunked. The cap was 24 and both larger
   * views exceeded it; it is 48 now, so every view fits in one. The chunking stays as the
   * guard it is, because the alternative to chunking is a blank board.
   *
   * One chunk matters: the endpoint stamps a single `as_of` across a batch, which is what
   * stops two tiles disagreeing about when they were true. Two chunks are two instants.
   */
  /**
   * Which models this business has, over the last 90 days: the Credits, Usage and One-time
   * sales tabs show only for a model present. Asked on every tab so the tab row is the same
   * whichever tab is open. Same rule as the engine's `billingModelsPresent`. A batch of its
   * own: it is not a tile, and adding it to a full tab batch would split that batch in two.
   */
  const PRESENCE: AnalyticsQuery[] = [
    {
      key: "pr_mix",
      measure: "revenue_billed",
      split: "revenue_type",
      range: "90d",
      grain: "month",
    },
    { key: "pr_credit", measure: "credits_outstanding", ...READING },
    { key: "pr_granted", measure: "credits_granted", range: "90d", grain: "month" },
    { key: "pr_usage", measure: "usage_events", range: "90d", grain: "month" },
    { key: "pr_orders", measure: "orders", range: "90d", grain: "month" },
    { key: "pr_subs", measure: "active_subscriptions", range: "90d", grain: "month" },
  ];
  /** Overview's headline for a business with no subscriptions: revenue of every kind. */
  const MODEL_HEADLINE: AnalyticsQuery[] =
    tab === "overview"
      ? [
          {
            key: "hm_rev",
            measure: "revenue_billed",
            split: "revenue_type",
            range: "30d",
            grain: "month",
          },
          { key: "hm_rev_series", measure: "revenue_billed", range: "30d", grain: "day" },
          { key: "hm_collected", measure: "revenue_collected", range: "30d", grain: "month" },
          { key: "hm_customers", measure: "billed_customers", range: "30d", grain: "month" },
          { key: "hm_per_customer", measure: "revenue_per_customer", range: "30d", grain: "month" },
          { key: "hm_liability", measure: "credits_liability", ...READING },
          { key: "hm_used", measure: "credits_used", range: "30d", grain: "month" },
          { key: "hm_events", measure: "usage_events", range: "30d", grain: "month" },
          { key: "hm_orders", measure: "orders", range: "30d", grain: "month" },
          { key: "hm_aov", measure: "average_order_value", range: "30d", grain: "month" },
        ]
      : [];
  const presenceBatch = queryAnalytics({
    queries: [...PRESENCE, ...MODEL_HEADLINE],
    business: biz,
    currency: scoped,
  }).catch(() => [] as BatchEntry[]);
  const asked = QUERIES[tab];
  const BATCH_LIMIT = 48;
  const chunks: AnalyticsQuery[][] = [];
  for (let i = 0; i < asked.length; i += BATCH_LIMIT) {
    chunks.push(asked.slice(i, i + BATCH_LIMIT));
  }
  const analyticsBatch = Promise.all(
    chunks.map((queries) =>
      queryAnalytics({ queries, business: biz, currency: scoped }).catch(() => [] as BatchEntry[]),
    ),
  )
    .then((parts) => parts.flat())
    .then(async (main) => [...main, ...(await presenceBatch)]);

  /**
   * Every remaining read at once.
   *
   * These used to go in two rounds — the reconstructed payload, and then the batch — which
   * added its latency to theirs rather than hiding it inside. They answer independent
   * questions, so the view now waits for the slowest rather than for the sum.
   */
  // Started with the batch so it adds no latency; it never throws.
  const syncedAtP = getSyncedAt(biz);
  let batch: BatchEntry[];
  let aging: ReportResult | null = null;
  let topCustomers: ReportResult | null = null;
  let nextDeadline: string | null = null;
  try {
    const [b, ar, tc, dl] = await Promise.all([
      analyticsBatch,
      tab === "collections"
        ? report(biz, "receivables_aging_summary", scoped)
        : Promise.resolve(null),
      // Who makes up the concentration share; the semantic layer has no per-customer split.
      tab === "recurring" ? report(biz, "top_customers_by_mrr", scoped) : Promise.resolve(null),
      // The soonest open evidence deadline; the analytics layer has no date unit for it.
      needsReports
        ? listDisputes(biz, { open: true, sort: "evidence_due_by", limit: 1 })
            .then((l) => l.data[0]?.evidence_due_by ?? null)
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    batch = b;
    aging = ar;
    topCustomers = tc;
    nextDeadline = dl;
  } catch (e) {
    return (
      <>
        <PageHeader title={business?.name ?? biz} />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const syncedAt = await syncedAtP;
  const mrrEntry = batch.find((e) => e.key === "mrr");
  const mrr: AnalyticsResult | null =
    mrrEntry && mrrEntry.object === "analytics_result" ? mrrEntry : null;

  /**
   * One instant for the whole screen: the batch endpoint stamps every slot with the same
   * `as_of`, so two tiles cannot disagree about when they were true.
   */
  const answered = batch.filter(
    (e): e is AnalyticsResult & { key: string } => e.object === "analytics_result",
  );
  const basis: Basis = {
    currency: answered.find((e) => e.currency != null)?.currency ?? reporting,
    // A converted roll-up only when nothing was scoped AND there is more than one currency.
    converted: scoped == null && availableCurrencies.length > 1,
    missingRates: scoped
      ? []
      : availableCurrencies.filter((c) => c !== reporting && !(Number(rates[c]) > 0)),
    asOf: answered[0]?.as_of ?? null,
    computedAt: answered.map((e) => e.computed_at).find((c) => c != null) ?? null,
    tz,
  };

  /** The window the Performance zone answered over, as the engine resolved it. */
  const periodAnswer =
    mrr ?? pick(batch, "p_billed") ?? pick(batch, "grr") ?? pick(batch, "p_cash") ?? null;
  const resolved = periodAnswer
    ? { start: periodAnswer.range.start, end: periodAnswer.range.end }
    : null;
  // The window each card's link filters to: the period's own business days, the next 30 days
  // for renewals, and the preset (Explore only takes named ranges).
  const linkWindow: LinkWindow = {
    from: resolved ? localYmd(resolved.start, tz) : null,
    to: resolved ? localYmd(resolved.end, tz) : null,
    range: custom ? null : preset.range,
    next30: { from: today, to: shiftDay(today, 30) },
  };
  const resolvedLabel = resolved
    ? rangeLabel(localYmd(resolved.start, tz), localYmd(resolved.end, tz))
    : periodLabel;

  /**
   * First-run checklist, skipped once the stored count shows an active subscription. A brand-new
   * business has no stored count yet (null), so it asks the list API instead; the card hides
   * itself when every step is done.
   */
  const activeSubs = pick(batch, "subs_active")?.total ?? null;
  const setupSteps =
    activeSubs === 0 || activeSubs === null
      ? await resolveSetupSteps(biz, baseCurrency, {
          livemode: business?.livemode ?? "live",
          signupGateway: user.organization_signup_gateway,
        })
      : null;

  // Paying customers who cannot be charged, and those whose card is expiring: the customers
  // list's own counts through its filters, so each figure and the list it opens agree.
  const stuck = [{ field: "cannot_be_charged", op: "is", value: "true" }];
  const queuesP =
    tab === "overview"
      ? fetchQueueCounts(biz).then((c) => queueItems(c, () => biz, basis.tz))
      : Promise.resolve([]);
  const unchargeable =
    tab === "overview"
      ? await Promise.all([
          listCustomers(biz, { limit: 1, filters: stuck }),
          listCustomers(biz, {
            limit: 1,
            filters: [...stuck, { field: "payment_method_type", op: "is_present", value: "false" }],
          }),
          listCustomers(biz, {
            limit: 1,
            filters: [
              { field: "payment_method_expiring", op: "is", value: "true" },
              { field: "renewing", op: "is", value: "true" },
            ],
          }),
        ])
          .then(([all, none, expiring]) => ({
            total: all.total ?? 0,
            noMethod: none.total ?? 0,
            expiring: expiring.total ?? 0,
          }))
          .catch(() => null)
      : null;

  // Models present, from the PRESENCE answers.
  const mixPresent = pick(batch, "pr_mix");
  const present = new Set<HomeTab>(["overview", "recurring", "collections"]);
  const hasSubscriptions = (pick(batch, "pr_subs")?.series ?? []).some((p) => (p.value ?? 0) > 0);
  if ((pick(batch, "pr_credit")?.total ?? 0) > 0 || (pick(batch, "pr_granted")?.total ?? 0) > 0)
    present.add("credits");
  if ((slice(mixPresent, "usage") ?? 0) !== 0 || (pick(batch, "pr_usage")?.total ?? 0) > 0)
    present.add("usage");
  // Orders, not one-time revenue: a setup fee on a subscription is not a sale.
  if ((pick(batch, "pr_orders")?.total ?? 0) > 0) present.add("sales");
  // No subscriptions, but another model: Recurring has nothing to show, and the Overview
  // headline leads with revenue of every kind. A business with no data keeps today's view.
  const otherModels = (["credits", "usage", "sales"] as const).filter((m) => present.has(m));
  const modelLed = !hasSubscriptions && otherModels.length > 0;
  if (modelLed) present.delete("recurring");

  const lowCredit =
    tab === "credits"
      ? await listCustomers(biz, {
          limit: 1,
          filters: [{ field: "credit_runway_days", op: "lt", value: "7" }],
        })
          .then((l) => l.total ?? null)
          .catch(() => null)
      : null;

  const stopped =
    tab === "usage"
      ? await listCustomers(biz, {
          limit: 1,
          filters: [{ field: "days_since_last_usage", op: "gte", value: "30" }],
        })
          .then((l) => l.total ?? null)
          .catch(() => null)
      : null;

  const lapsed =
    tab === "sales"
      ? await listCustomers(biz, {
          limit: 1,
          filters: [{ field: "days_since_last_order", op: "gte", value: "90" }],
        })
          .then((l) => l.total ?? null)
          .catch(() => null)
      : null;

  const zones =
    tab === "sales"
      ? salesZones({ biz, basis, batch, lapsed })
      : tab === "credits"
        ? creditsZones({ biz, basis, batch, lowCredit })
        : tab === "usage"
          ? usageZones({ biz, basis, batch, stopped })
          : tab === "overview"
            ? overviewZones({
                biz,
                basis,
                batch,
                unchargeable,
                queues: await queuesP,
                linkWindow,
                windowLabel: periodLabel,
                modelLed: modelLed ? otherModels : null,
              })
            : tab === "recurring"
              ? recurringZones({ biz, basis, batch, topCustomers, linkWindow })
              : collectionsZones({ biz, basis, batch, aging, nextDeadline, linkWindow });

  const carry = {
    ...(tab !== "overview" ? { tab } : {}),
    ...(currencyParam ? { currency: currencyParam } : {}),
  };

  return (
    <NavPendingProvider>
      <PageHeader
        title={business?.name ?? biz}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SyncedBadge syncedAt={syncedAt} />
            <CurrencyPicker
              value={availableCurrencies.includes(currency) ? currency : "ALL"}
              baseCurrency={baseCurrency}
              available={availableCurrencies}
            />
          </div>
        }
      />

      <HomeTabs
        biz={biz}
        active={tab}
        currency={currency}
        period={periodCarry}
        shown={[...present]}
      />

      {/* A business still in setup has better first steps than a search shortcut. */}
      {setupSteps ? (
        <SetupChecklist steps={setupSteps} sampleDataHref={`/businesses/${biz}/transfer`} />
      ) : (
        <PaletteWelcome />
      )}
      {msg ? (
        <Alert tone="info" className="mb-6">
          {msg}
        </Alert>
      ) : null}
      {error ? <ErrorState className="mb-6" description={error} /> : null}

      <div className="flex flex-col gap-6">
        {/* A tab or currency change reloads this zone; a period change cannot move it. */}
        <PendingContent
          current={tab}
          keepFor={["period"]}
          skeleton={{
            overview: <OverviewCurrentSkeleton />,
            recurring: <RecurringCurrentSkeleton />,
            collections: <CollectionsCurrentSkeleton />,
            credits: <CollectionsCurrentSkeleton />,
            usage: <CollectionsCurrentSkeleton />,
            sales: <CollectionsCurrentSkeleton />,
          }}
        >
          {zones.current}
        </PendingContent>

        <div className="mt-4">
          <ZoneHeading zone="performance">
            <BoardRangePicker
              ranges={PERIODS.map((p) => ({
                id: p.id,
                label: labelOf(p),
                href: `/businesses/${biz}?${new URLSearchParams({ period: p.id, ...carry }).toString()}`,
              }))}
              range={custom ? "" : preset.id}
              grains={[]}
              grain=""
              basePath={`/businesses/${biz}`}
              carry={carry}
              custom={{ start: custom?.start ?? null, end: custom?.end ?? null }}
              resolved={resolved}
            />
            <ZoneMeta>{resolvedLabel}</ZoneMeta>
          </ZoneHeading>
        </div>
        <PendingContent
          current={tab}
          skeleton={{
            overview: <OverviewPerformanceSkeleton />,
            recurring: <RecurringPerformanceSkeleton />,
            collections: <CollectionsPerformanceSkeleton />,
            credits: <CollectionsPerformanceSkeleton />,
            usage: <CollectionsPerformanceSkeleton />,
            sales: <CollectionsPerformanceSkeleton />,
          }}
        >
          {zones.performance}
        </PendingContent>

        <PageNote warning={missingRatesWarning(basis)}>
          {[
            mrr?.coverage?.missing_periods?.length
              ? `The MRR trend has no data for ${mrr.coverage.missing_periods.length} of its periods`
              : null,
            currencyBasis(basis),
          ]
            .filter(Boolean)
            .join(" · ")}
        </PageNote>
      </div>
    </NavPendingProvider>
  );
}
