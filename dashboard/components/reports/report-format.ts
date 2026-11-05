import { money } from "@/lib/format";
import type { ReportResult } from "@/lib/api";
import type { SeriesPolarity } from "@/components/analytics/series-format";
import { bucketDrill } from "./report-drills";

/**
 * The payload the explorer renders.
 *
 * `table` — the waterfall a `periodic` report answers with — is already in the engine's
 * envelope but not yet in `ReportResult`. `lib/api.ts` is owned elsewhere, so the field is
 * narrowed here instead of widened there; delete this intersection once the client type
 * carries it. Same for the shapes the registry grew after `ReportSummary["shape"]` was
 * written: a client that refuses to render a shape the engine declares is worse than one
 * that types it loosely.
 */
export type ReportPayload = Omit<ReportResult, "shape"> & {
  shape: ReportResult["shape"] | "buckets" | "cohort" | "periodic";
  /**
   * The granularities this report's series may be re-cut at — empty, or absent, where it
   * has none. The control is rendered from THIS list rather than from a copy of the
   * vocabulary here: a shape with no series refuses the parameter, and a control the engine
   * would refuse is a control that reaches nothing.
   */
  granularities?: Array<"day" | "week" | "month">;
  /**
   * The half-open window the figures cover, as instants, served by the engine from the
   * same bucket builder the resolvers use. A drill-down into a WINDOWED report has to
   * carry it, or the list answers over the whole book while the figure answered over a
   * year. Absent on an older engine, in which case such a row does not link at all.
   */
  window_start?: string;
  window_end?: string;
  /** Rows are nested steps (the checkout funnel): shares are of the first row. */
  funnel?: boolean;
  table?: {
    columns: Array<{ key: string; label: string }>;
    rows: Array<{ period: string; values: number[] }>;
  };
};

export type ReportKind = ReportResult["kind"];

/**
 * A value in the report's own unit. Proportions arrive in basis points because the engine
 * states every proportion that way, and a null is an em-dash rather than 0 — 0% reads as
 * total loss, which is a different claim from "no base to divide by".
 */
export function reportValue(v: number | null, kind: ReportKind, currency: string): string {
  if (v == null) return "—";
  if (kind === "money") return money(v, currency);
  if (kind === "rate") return `${(v / 100).toFixed(1)}%`;
  if (kind === "ratio") return `${(v / 10000).toFixed(2)}×`;
  return v.toLocaleString("en");
}

/** The headline, which a cohort report states in its BASE unit rather than in the cells'. */
export function reportHeadline(report: ReportPayload): string {
  if (report.headline == null) return "—";
  if (report.matrix) {
    return report.matrix.base_kind === "money"
      ? money(report.headline, report.currency)
      : report.headline.toLocaleString("en");
  }
  return reportValue(report.headline, report.kind, report.currency);
}

/** A report answered nothing at all — no figure, no series, no rows, no grid, no table. */
export function reportIsEmpty(report: ReportPayload): boolean {
  return (
    report.headline == null &&
    report.points.length === 0 &&
    (report.rows?.length ?? 0) === 0 &&
    (report.matrix?.rows.length ?? 0) === 0 &&
    (report.table?.rows.length ?? 0) === 0
  );
}

/** A dimension name as a person reads it: `plan_id` → `Plan`. */
export function dimensionLabel(d: string): string {
  const base = d.replace(/_id$/, "").replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** A breakdown row, with the destination its group resolved to (or none). */
export type BreakdownRow = NonNullable<ReportPayload["rows"]>[number] & { href?: string | null };

/**
 * Where a breakdown row leads, when it leads anywhere.
 *
 * Two kinds of destination. A GROUPED report's rows are plan or currency, both of which map
 * onto a subscriptions-list filter and give their `group_id` as the public id it takes. A
 * `buckets` report's rows are the report's own buckets, and those reach a list only where a
 * filter can express the bucket — `report-drills.ts` holds those, import-free, so the
 * engine's gate executes the same triples this builds a URL from.
 *
 * A row with a null `group_id` on a GROUPED report ("No plan", "Unknown") never links: it is
 * a roll-up of things with no single filter value, so any destination would open a list that
 * disagrees with the number that was clicked. Bucket rows carry a null `group_id` by design
 * — their `group` IS the filter value — so the same test cannot be applied to both.
 */
export function breakdownLinks(
  rows: NonNullable<ReportPayload["rows"]>,
  groupBy: string | null,
  biz: string,
  report?: ReportPayload,
): BreakdownRow[] {
  const param = groupBy === "plan" ? "plan" : groupBy === "currency" ? "currency" : null;
  if (param) {
    return rows.map((r) => ({
      ...r,
      href: r.group_id
        ? `/businesses/${biz}/subscriptions?${param}=${encodeURIComponent(r.group_id)}`
        : null,
    }));
  }
  if (!report || groupBy) return rows;
  const window = { start: report.window_start, end: report.window_end };
  return rows.map((r) => {
    const target = bucketDrill(report.key, r.group, window);
    if (!target) return { ...r, href: null };
    const sp = new URLSearchParams();
    for (const f of target.filters) sp.append("filter", `${f.field}:${f.op}:${f.value}`);
    return { ...r, href: `/businesses/${biz}/${target.entity}?${sp.toString()}` };
  });
}

/**
 * The window the figures actually cover, stated in the payload's own terms.
 *
 * `window_label` wins where the engine sends one, because several reports are quoted over
 * the last COMPLETE calendar period rather than the range selector's window — and a figure
 * whose period is assumed rather than stated is the one that gets misread. Otherwise the
 * span is read off the data that was returned (first to last point, oldest to newest
 * period), never computed from the range name, so it cannot claim a month the answer does
 * not contain.
 */
export function coverageLabel(report: ReportPayload): string | null {
  if (report.window_label) return report.window_label;
  if (report.points.length > 0) {
    const first = report.points[0]!.label;
    const last = report.points[report.points.length - 1]!.label;
    return first === last ? first : `${first} – ${last}`;
  }
  const periods = report.table?.rows.map((r) => r.period) ?? [];
  if (periods.length > 0) {
    // Waterfall rows arrive newest-first, so the span reads from the end backwards.
    const first = periods[periods.length - 1]!;
    const last = periods[0]!;
    return first === last ? first : `${first} – ${last}`;
  }
  return null;
}

/**
 * Whether a RISE in this figure is good news, bad news, or neither.
 *
 * The delta's colour is direction × polarity, so a rise in churn never renders green and a
 * fall in it never renders red. Unlisted keys are `neutral` ON PURPOSE: a coloured delta is
 * a claim about whether the business got better, and guessing that from a key name is how
 * you end up telling someone their refunds are up and painting it as a win.
 */
const UP_BAD = new Set([
  "average_activation_lead_time",
  "average_revenue_lost_per_churned_subscription",
  "churn_breakdown_summary",
  "customer_churn_rate",
  "dunning_status_summary",
  "payment_error_summary",
  "receivables_aging_summary",
  "refund_error_summary",
  "refund_transactions_summary",
  "revenue_leakage_summary",
  "total_amount_voided",
  "total_arr_churn",
  "total_cards_due_to_expire",
  "total_cards_expired",
  "total_churned_customers",
  "total_churn_mrr",
  "total_contraction_mrr",
  "total_downgrade_mrr",
  "total_failed_payment_transactions",
  "total_failed_refund_transactions",
  "total_paused_subscription_mrr",
  "total_receivables",
  "total_refunds",
  "total_refund_transactions",
  "total_revenue_leakage",
  "total_same_period_cancellations",
  "total_scheduled_cancellation_mrr",
  "total_scheduled_cancellations",
  "total_scheduled_downgrade_mrr",
  "total_scheduled_downgrades",
  "total_subscription_churn",
  "total_write_off_amount",
]);

const UP_GOOD = new Set([
  "average_customer_lifetime",
  "average_lifetime_of_a_paid_subscription",
  "average_revenue_per_new_subscription",
  "average_revenue_per_paid_subscription",
  "average_revenue_per_paying_customer",
  "average_subscriptions_per_customer",
  "gross_revenue_retention_rate",
  "lifetime_value_of_a_customer",
  "lifetime_value_of_a_paid_subscription",
  "net_arr_growth",
  "net_billing",
  "net_mrr_growth",
  "net_mrr_growth_rate",
  "net_payments",
  "net_recurring_payments",
  "net_revenue_retention_rate",
  "new_trial_subscriptions",
  "non_recurring_payments",
  "quick_ratio",
  "receivables_recovery_summary",
  "recurring_payments",
  "total_activations",
  "total_active_customers",
  "total_active_paid_subscriptions",
  "total_active_subscriptions",
  "total_amount_recovered",
  "total_arr",
  "total_billing",
  "total_cmrr",
  "total_expansion_arr",
  "total_expansion_mrr",
  "total_mrr",
  "total_new_arr",
  "total_new_customers",
  "total_new_mrr",
  "total_non_recurring_billing",
  "total_paying_customers",
  "total_payments",
  "total_payment_transactions",
  "total_reactivation_mrr",
  "total_scheduled_upgrades",
  "total_scheduled_upgrade_mrr",
  "total_signups",
  "total_subscriptions",
  "total_subscription_quantity",
  "total_subscription_trials",
  "total_upcoming_renewal_amount",
  "total_upgrade_mrr",
  "trial_conversion_rate",
  "usage_payments",
]);

export function reportPolarity(key: string): SeriesPolarity {
  if (UP_BAD.has(key)) return "up_bad";
  if (UP_GOOD.has(key)) return "up_good";
  return "neutral";
}

/**
 * How far the series moved across the window on screen, in basis points.
 *
 * Read off the SAME points the chart draws, so the number under the headline and the shape
 * above it can never disagree. First and last MEASURED points, not first and last slots — a
 * leading gap is an unmeasured period, and treating it as zero turns "we started measuring
 * in July" into infinite growth. Null when there is no base to divide by: a change against
 * zero is not a percentage.
 */
export function seriesChangeBps(points: ReportPayload["points"]): number | null {
  const measured = points.filter((p) => p.v != null && Number.isFinite(p.v));
  if (measured.length < 2) return null;
  const first = measured[0]!.v;
  const last = measured[measured.length - 1]!.v;
  if (first === 0) return null;
  return Math.round(((last - first) / Math.abs(first)) * 10000);
}
