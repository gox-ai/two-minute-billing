// Value formatters shared by the payments-analytics tiles, charts and tables.
// Client-safe: only `lib/format` (which is pure presentation), no server imports.
import { countCompact, money, moneyCompact, pctFromBps, toMajor } from "@/lib/format";
import type { PaymentsSeriesKind } from "@/lib/api/analytics";

/**
 * The exact value, e.g. `$34,453.50` / `8.13%` / `314`.
 *
 * `money` is integer MINOR units and `percent` is BASIS POINTS — both come off the
 * wire that way, so every read goes through `money()` / `pctFromBps()`. Never
 * divide by 100 by hand: the divisor is the CURRENCY's exponent (JPY has none,
 * KWD has three), which is exactly the bug that made a chart axis read 100× low.
 */
export function seriesValue(v: number, kind: PaymentsSeriesKind, currency: string): string {
  if (kind === "money") return money(Math.round(v), currency);
  if (kind === "percent") return pctFromBps(Math.round(v));
  return Math.round(v).toLocaleString("en");
}

/** Headline form — compact money so a six-figure tile never wraps: `$34.45K`. */
export function seriesHeadline(v: number, kind: PaymentsSeriesKind, currency: string): string {
  if (kind === "money") return moneyCompact(Math.round(v), currency);
  if (kind === "percent") return pctFromBps(Math.round(v));
  return Math.round(v).toLocaleString("en");
}

/**
 * Axis-tick form — bare compact numbers (`34.5k`), no currency symbol: the card
 * headline above the chart already states the currency, and repeating it on every
 * tick is ink that carries no information.
 */
export function seriesAxis(v: number, kind: PaymentsSeriesKind, currency: string): string {
  if (kind === "money") return countCompact(toMajor(Math.round(v), currency));
  if (kind === "percent") return pctFromBps(Math.round(v), 1);
  return countCompact(v);
}

/**
 * Whether a RISE in this measure is good news, bad news, or neither — the delta's
 * colour is direction × polarity, so more refunds must not render green.
 * `neutral` renders the delta in muted ink: pending intents rising is neither.
 */
export type SeriesPolarity = "up_good" | "up_bad" | "neutral";

export const SERIES_POLARITY: Record<string, SeriesPolarity> = {
  gross_volume: "up_good",
  net_volume: "up_good",
  transaction_count: "up_good",
  successful_payments: "up_good",
  refunds: "up_bad",
  chargebacks: "up_bad",
  failed_transactions: "up_bad",
  failed_amount: "up_bad",
  failure_rate: "up_bad",
  pending_payment_intents: "neutral",
};

/**
 * The same question for a semantic-layer MEASURE, by its id. Explicit on purpose: guessing
 * from a name is how a rising churn figure gets painted green. Anything unlisted is
 * `neutral` — muted ink, never a semantic colour it has not earned.
 */
const MEASURES_UP_BAD = new Set([
  "cards_expired",
  "cards_expiring",
  "customer_churn_rate",
  "customers_churned",
  "dunning_invoices",
  "dunning_subscriptions",
  "gross_mrr_churn_rate",
  "invoice_voided",
  "invoice_written_off",
  "mrr_churn",
  "mrr_contraction",
  "mrr_at_risk",
  "mrr_paused",
  "payment_failures",
  "receivables_invoices",
  "receivables_outstanding",
  "refund_failures",
  "refunds_issued",
  "revenue_lost_per_churned_subscription",
  "scheduled_cancellation_mrr",
  "scheduled_cancellations",
  "scheduled_downgrade_mrr",
  "scheduled_downgrades",
  "subscriber_churn_rate",
  "subscription_cancellations",
]);

const MEASURES_UP_GOOD = new Set([
  "activations",
  "active_customers",
  "active_subscriptions",
  "amount_recovered",
  "arr",
  "average_customer_lifetime",
  "billing_gross",
  "billing_net",
  "billing_non_recurring",
  "cash_collected",
  "cash_non_recurring",
  "cash_recurring",
  "cash_recurring_net",
  "cash_usage",
  "cmrr",
  "customer_lifetime_value",
  "customers_created",
  "customers_new",
  "customers_reactivated",
  "gross_revenue_retention",
  "mrr",
  "mrr_expansion",
  "mrr_new",
  "mrr_reactivation",
  "net_mrr_growth_rate",
  "net_new_mrr",
  "net_revenue_retention",
  "paying_customers",
  "paying_subscriptions",
  "payments_captured",
  "payments_net",
  "quick_ratio",
  "recovery_paid_late",
  "revenue_billed",
  "revenue_collected",
  "revenue_per_new_subscription",
  "revenue_per_paying_customer",
  "revenue_per_paying_subscription",
  "scheduled_upgrade_mrr",
  "scheduled_upgrades",
  "subscription_lifetime_value",
  "subscription_quantity",
  "subscriptions_per_customer",
  "subscriptions_total",
  "trial_conversion_rate",
  "trials_active",
  "trials_cumulative",
  "trials_started",
]);

export function measurePolarity(id: string): SeriesPolarity {
  if (MEASURES_UP_BAD.has(id)) return "up_bad";
  if (MEASURES_UP_GOOD.has(id)) return "up_good";
  return "neutral";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A stock's chart points, led by its opening (the previous window's closing value).
 *
 * Each engine point is the stock at the END of its bucket, so without the opening the line
 * starts one bucket late and hides a move inside it, contradicting "opening → closing". The
 * opening is labelled with the window's start the way the engine labels a bucket. An unknown
 * opening adds nothing: it is a gap, never a zero.
 */
export function stockPoints(r: {
  kind: string;
  grain: string;
  range: { start: string };
  series: Array<{ label: string; value: number | null }>;
  compare?: { previous_total: number | null } | null;
}): Array<{ label: string; value: number | null }> {
  const points = r.series.map((p) => ({ label: p.label, value: p.value ?? null }));
  const opening = r.compare?.previous_total;
  if (r.kind !== "stock" || opening == null || points.length === 0) return points;
  const [y, m, d] = r.range.start.slice(0, 10).split("-").map(Number);
  const month = MONTHS[(m ?? 1) - 1] ?? "";
  const start = r.grain === "day" || r.grain === "week" ? `${month} ${d}` : `${month} ${y}`;
  return [{ label: `${start} (opening)`, value: opening }, ...points];
}
