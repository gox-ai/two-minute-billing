import type { MrrMovementReason } from "../mrr-movements";

/**
 * The report catalogue, as DATA.
 *
 * A reporting product is ~100 metrics with several cuts each. Written as one query function
 * and one route per report, that is ~200 files nobody can keep consistent — and the first
 * thing to rot is the part that makes them comparable: the window, the currency conversion,
 * the comparison period. So a report is a DECLARATION, and a handful of resolvers
 * (`resolve.ts`) turn each declaration into an answer.
 *
 * The rule to protect: **adding a report should be an entry in this file.** When a request
 * arrives that cannot be expressed here, the right move is usually to widen the declaration
 * — another `source`, another `shape` — not to write a one-off query beside the others,
 * because the one-off is the one that will use a different month boundary.
 */

/** What the numbers ARE, which decides how they render and how they may be summed. */
export type ReportKind = "money" | "count" | "rate" | "ratio";

/**
 * Where the answer comes from. One resolver per source, not one per report.
 *
 * - `movement` — the MRR movement ledger: flows between two instants.
 * - `stock` — the book at an instant, from snapshots with reconstruction behind them.
 * - `derived` — arithmetic over the two above (retention rates, growth rates, averages).
 */
export type ReportSource =
  | "movement"
  | "scheduled"
  | "stock"
  | "derived"
  | "invoice"
  | "transaction"
  | "subscription"
  | "payment_method"
  | "payment"
  | "checkout";

/**
 * How the window applies.
 *
 * - `flow` — summed over each bucket (what happened in it).
 * - `stock` — measured at each bucket's END (what was true then).
 * - `forward` — a stock, projected ahead instead of back.
 */
export type ReportShape = "flow" | "stock" | "forward" | "buckets" | "cohort" | "periodic";

/**
 * Cross-cutting tags. A report has ONE category — its home in the grouped list — and any
 * number of tags, because the questions people arrive with cut across that grouping: "show
 * me everything about tax" spans billing and receivables, "what is committed" spans
 * recurring revenue and churn.
 *
 * Tags are not a second grouping. A grouped list keyed on tags would print a catalogue
 * longer than the number of reports in it, with the same report under five headings; these
 * drive FILTER chips instead, which is what the question actually is.
 */
export type ReportTag =
  | "billing_and_taxes"
  | "leakage"
  | "collections"
  | "customers"
  | "committed"
  | "trials"
  | "plans"
  | "cohorts"
  | "annualised";

export const TAG_LABELS: Record<ReportTag, string> = {
  billing_and_taxes: "Billing & taxes",
  leakage: "Leakage",
  collections: "Collections",
  customers: "Customers",
  committed: "Committed",
  trials: "Trials",
  plans: "Plans",
  cohorts: "Cohorts",
  annualised: "Annualised",
};

export type ReportCategory =
  | "recurring_revenue"
  | "retention"
  | "subscriptions"
  | "acquisitions"
  | "churn"
  | "transactions"
  | "receivables";

/**
 * What a report may be cut by. A small closed set on purpose: every entry costs stored rows
 * (a stock dimension) or a join (a flow dimension), so widening it is a decision, not a
 * convenience.
 */
export type ReportDimension = "plan" | "currency" | "country";

export interface ReportDef {
  key: string;
  name: string;
  /** One sentence, in the operator's language. Rendered as the report's subtitle. */
  description: string;
  category: ReportCategory;
  kind: ReportKind;
  source: ReportSource;
  shape: ReportShape;
  /** Cross-cutting tags — see `ReportTag`. A report may carry none. */
  tags?: ReadonlyArray<ReportTag>;
  /**
   * Dimensions this report can be grouped by. `plan` comes from the movement ledger's
   * stored plan; `currency` is available wherever the rows carry one, which is everything
   * except the derived rates — a rate is already a ratio of converted figures and splitting
   * it by currency would mean four different denominators in one table.
   *
   * `country` is the customer attribute (Phase 4c). A flow gets it by joining the movement
   * to its customer; a stock gets it from `mrr_snapshot_countries`, which is why it is
   * offered on the stocks that table stores (MRR and the two counts) and NOT on CMRR, which
   * it does not. A report that cannot honour it refuses by name rather than answering empty.
   *
   * ⚠️ These are ATTRIBUTES, and the word "segment" is not used for them anywhere in the
   * metrics module: `list_views` already owns it for a saved filter set over a LIST. A
   * predicate over these attributes is a **customer filter** (`resolve.ts`), which is
   * answered by summing rows stored per attribute — never stored in its own right.
   */
  dimensions: ReadonlyArray<ReportDimension>;
  /** `movement` reports: which ledger reasons they sum. */
  reasons?: ReadonlyArray<MrrMovementReason>;
  /**
   * `movement` reports: keep only movements where the plan CHANGED (an upgrade or a
   * downgrade) or where it did not (expansion or contraction within one plan). Needs
   * `previous_plan_product_id`, so these reports report nothing for movements written
   * before that column existed rather than guessing.
   */
  planChange?: "changed" | "same";
  /** `movement` reports: keep only gains (`up`) or only losses (`down`). */
  direction?: "up" | "down";
  /**
   * This report answers with ONE figure and no series, even though its shape is a window.
   * Some questions are only about now — how many units are live, how many customers are —
   * and drawing them across twelve months would imply we know what they were then.
   */
  noSeries?: true;
  /**
   * This report has a meaningful PREVIOUS period, so its answer carries a comparison —
   * previous value, the period it covers, the change in basis points, and the basis the
   * pair was computed on (`resolve.ts`).
   *
   * Declared rather than inferred, because most of the catalogue does not qualify and the
   * reasons differ:
   *
   *  - `forward` shapes project ahead; there is no earlier window to project from.
   *  - `noSeries` stocks are statements about NOW.
   *  - `buckets`, `cohort` and `periodic` answers ARE their rows — several of them (the
   *    ageing ladder, the dunning summary) are read as of today and would return the same
   *    figure for any window, so a delta would be a guaranteed 0 rather than a finding.
   *  - a measure that ignores its window (an average lifetime over everything that ever
   *    ended) would do the same.
   *
   * The rule a client can rely on: a report declares this exactly when it answers with a
   * comparison, and never otherwise. `verify:reports` asserts the equivalence.
   */
  comparable?: true;
  /**
   * `periodic` reports: a row per period and a column per measure — the waterfall shape.
   * `opening` and `closing` are stocks; everything between them is a flow, and the row is
   * only worth reading if they reconcile. `verify:reports` asserts that they do.
   */
  periodic?: "mrr_movement" | "account_summary";
  /**
   * `movement` reports counted at CUSTOMER grain: the ledger carries `customer_id`, so
   * these are a grouping of rows we already hold, not a new measure. A customer with three
   * subscriptions counts ONCE per window — see `resolveCustomerMovementReport` for the
   * de-duplication, for what "churned" means at customer grain, and for the base
   * `churn_rate` divides by.
   */
  customers?: "new" | "churned" | "any" | "churn_rate";
  /** `cohort` reports: what is being retained — money or subscriptions. */
  cohort?: "mrr" | "subscriptions";
  /** `scheduled` reports: which scheduled-change measure. */
  scheduled?:
    | "upgrade_mrr"
    | "downgrade_mrr"
    | "upgrade_count"
    | "downgrade_count"
    | "cancellation_mrr"
    | "cancellation_count";
  /**
   * `movement` reports: report the SIGNED delta instead of the magnitude. Losses are
   * otherwise stated as positive amounts, because every consumer says "churn was $40K",
   * not "churn was −$40K".
   */
  signed?: boolean;
  /** `stock` reports: which stored measure to read. */
  measure?:
    | "mrr"
    | "cmrr"
    | "active_subscriptions"
    | "paying_subscriptions"
    | "renewing_subscriptions";
  /**
   * `invoice` reports: which invoice measure, over invoices in the window.
   * `transaction` reports: which transaction measure.
   * `subscription` reports: which count or average over the book.
   */
  metric?:
    // invoice
    | "billing"
    | "net_billing"
    | "non_recurring_billing"
    | "taxes"
    | "taxable_base"
    | "exempt_base"
    | "revenue_leakage"
    | "voided"
    | "written_off"
    | "receivables"
    | "amount_recovered"
    // transaction
    | "payments"
    | "refunds"
    | "net_payments"
    | "failed_payments"
    | "failed_refunds"
    | "payment_transactions"
    | "refund_transactions"
    // subscription
    | "cancellations"
    | "active_subscriptions"
    | "trials"
    | "new_trials"
    | "trial_conversion_rate"
    | "same_period_cancellations"
    | "subscription_quantity"
    | "active_customers"
    | "paying_customers"
    | "subscriptions_per_customer"
    | "average_lifetime_months"
    | "average_customer_lifetime_months"
    | "activation_lead_days"
    | "signups"
    | "activations"
    | "total_subscriptions"
    | "upcoming_renewal_amount"
    // payment_method
    | "cards_expired"
    | "cards_expiring"
    /**
     * `payment` reports: CASH, split across the invoice lines it settled. These are the
     * cash-side twins of the billing-side invoice metrics — `recurring_cash` answers what
     * we collected where `non_recurring_billing` answers what we charged — and they differ
     * by exactly what is unpaid, refunded or paid in a later period.
     */
    | "recurring_cash"
    | "non_recurring_cash"
    | "usage_cash"
    | "net_recurring_cash";
  /**
   * `buckets` reports answer with ROWS rather than a series: an ageing ladder, a status
   * summary, an error breakdown. The bucketing itself belongs to the resolver, because it
   * is the report's definition rather than a rendering choice.
   */
  bucketing?:
    | "ar_aging"
    | "recovery_aging"
    | "dunning_status"
    | "payment_errors"
    | "refund_errors"
    | "payment_status"
    | "refund_status"
    | "coupon_leakage"
    | "plan_movement"
    | "churn_age"
    | "cash_composition"
    | "customer_concentration"
    | "top_customers"
    | "customer_mrr_band"
    | "checkout_funnel"
    | "checkout_recovery"
    | "checkout_recovered_revenue"
    | "checkout_conversion"
    | "checkout_payment_failures"
    | "cancellation_saves";
  /**
   * Multiply the answer. ARR is MRR × 12 and nothing else — a separate resolver for the
   * annual family would be a second definition of every one of them.
   */
  multiplier?: number;
  /** `derived` reports: which computation. */
  formula?:
    | "net_mrr_growth"
    | "net_mrr_growth_rate"
    | "gross_retention"
    | "net_retention"
    | "quick_ratio"
    | "arpu_new"
    | "arpu_churned"
    | "paused_mrr"
    | "arps"
    | "ltv"
    | "arpc"
    | "customer_ltv";
  /**
   * Reports that answer the same question a different way. Declared here rather than as
   * separate entries so the catalogue lists one metric with its cuts, which is how people
   * look for them.
   */
  variants?: ReadonlyArray<{ key: string; name: string }>;
}

/**
 * Phase 3a: the recurring-revenue slice.
 *
 * Every entry here is answerable from `mrr_movements` and `metric_daily` as they stand —
 * no new columns. Two things this slice deliberately does NOT contain, because they need a
 * schema addition first and a report that silently approximates is worse than a missing one:
 *
 *  - **Upgrade vs Downgrade MRR** as distinct from expansion/contraction. The ledger records
 *    the plan a movement landed on and not the one it came from, so "more seats on the same
 *    plan" and "moved to a pricier plan" are indistinguishable today.
 *  - **Scheduled Upgrade / Downgrade MRR.** `scheduled_changes` holds a raw payload with no
 *    stored delta, so the figure would mean re-running an estimate per row per page load.
 */
export const REPORTS: readonly ReportDef[] = [
  {
    key: "total_mrr",
    name: "Total MRR",
    description: "The predictable monthly revenue earned from subscriptions.",
    category: "recurring_revenue",
    kind: "money",
    source: "stock",
    shape: "stock",
    comparable: true,
    measure: "mrr",
    dimensions: ["country"],
    variants: [{ key: "total_arr", name: "Total ARR" }],
  },
  {
    key: "total_arr",
    tags: ["annualised"],
    name: "Total ARR",
    description: "Annualised recurring revenue: monthly recurring revenue times twelve.",
    category: "recurring_revenue",
    kind: "money",
    source: "stock",
    shape: "stock",
    comparable: true,
    measure: "mrr",
    multiplier: 12,
    dimensions: ["country"],
  },
  {
    key: "total_cmrr",
    tags: ["committed"],
    name: "Total CMRR",
    description:
      "The recurring revenue you are committed to: anything booked to cancel is already out, and a subscription signed to start later is already in.",
    category: "recurring_revenue",
    kind: "money",
    source: "stock",
    shape: "forward",
    measure: "cmrr",
    dimensions: [],
  },
  {
    key: "total_new_mrr",
    name: "Total New MRR",
    description: "Monthly recurring revenue from subscriptions earning for the first time.",
    category: "acquisitions",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["new"],
    dimensions: ["plan", "currency", "country"],
    variants: [{ key: "total_new_arr", name: "Total New ARR" }],
  },
  {
    key: "total_new_arr",
    tags: ["annualised"],
    name: "Total New ARR",
    description: "New monthly recurring revenue, annualised.",
    category: "acquisitions",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["new"],
    multiplier: 12,
    dimensions: ["plan", "currency", "country"],
  },
  {
    key: "checkout_funnel",
    name: "Checkout Funnel",
    description:
      "Checkout links created in the period, and how many reached each step. The total is the number of completed checkouts.",
    category: "acquisitions",
    kind: "count",
    source: "checkout",
    shape: "buckets",
    bucketing: "checkout_funnel",
    dimensions: [],
    variants: [
      { key: "checkout_reminders", name: "Checkout Reminders" },
      { key: "checkout_recovered_revenue", name: "Recovered Checkout Revenue" },
      { key: "checkout_conversion", name: "Checkout Conversion" },
      { key: "checkout_payment_failures", name: "Checkout Payment Failures" },
    ],
  },
  {
    key: "cancellation_saves",
    name: "Cancellation Saves",
    description:
      "Of the customers who saw offers when they started to cancel in the portal, the share who took one instead, by offer. An offer followed by a cancel within 30 days does not count.",
    category: "retention",
    kind: "rate",
    source: "checkout",
    shape: "buckets",
    bucketing: "cancellation_saves",
    dimensions: [],
  },
  {
    key: "checkout_conversion",
    name: "Checkout Conversion",
    description:
      "Of the checkouts that buyers opened in the period, the share they completed, by page layout and device.",
    category: "acquisitions",
    kind: "rate",
    source: "checkout",
    shape: "buckets",
    bucketing: "checkout_conversion",
    dimensions: [],
  },
  {
    key: "checkout_payment_failures",
    name: "Checkout Payment Failures",
    description:
      "Of the payment attempts on checkouts opened in the period, the share the payment provider refused, by page layout and device.",
    category: "acquisitions",
    kind: "rate",
    source: "checkout",
    shape: "buckets",
    bucketing: "checkout_payment_failures",
    dimensions: [],
  },
  {
    key: "checkout_reminders",
    name: "Checkout Reminders",
    description:
      "Checkouts that we reminded by email in the period, and how many of them completed after the reminder.",
    category: "acquisitions",
    kind: "count",
    source: "checkout",
    shape: "buckets",
    bucketing: "checkout_recovery",
    dimensions: [],
  },
  {
    key: "checkout_recovered_revenue",
    name: "Recovered Checkout Revenue",
    description:
      "What buyers paid on checkouts that completed after a reminder email. The first invoice of a subscription, or the purchase.",
    category: "acquisitions",
    kind: "money",
    source: "checkout",
    shape: "buckets",
    bucketing: "checkout_recovered_revenue",
    dimensions: [],
  },
  {
    key: "total_expansion_mrr",
    name: "Total Expansion MRR",
    description: "Additional recurring revenue from subscriptions that were already earning.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["expansion"],
    dimensions: ["plan", "currency", "country"],
    variants: [{ key: "total_expansion_arr", name: "Total Expansion ARR" }],
  },
  {
    key: "total_expansion_arr",
    tags: ["annualised"],
    name: "Total Expansion ARR",
    description: "Expansion monthly recurring revenue, annualised.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["expansion"],
    multiplier: 12,
    dimensions: ["plan", "currency", "country"],
  },
  {
    key: "total_reactivation_mrr",
    name: "Total Reactivation MRR",
    description:
      "Recurring revenue from subscriptions that came back. They were won back after churn, or resumed after a pause.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["reactivation", "resume"],
    dimensions: ["plan", "currency", "country"],
  },
  {
    key: "total_contraction_mrr",
    name: "Total Contraction MRR",
    description:
      "Recurring revenue lost from subscriptions that shrank but are still running. This includes a subscription discounted to nothing.",
    category: "churn",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["contraction"],
    dimensions: ["plan", "currency", "country"],
  },
  {
    key: "total_churn_mrr",
    name: "Total MRR Churn",
    description: "Recurring revenue lost to cancellations and pauses.",
    category: "churn",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["churn", "pause"],
    dimensions: ["plan", "currency", "country"],
    variants: [{ key: "total_arr_churn", name: "Total ARR Churn" }],
  },
  {
    key: "total_arr_churn",
    tags: ["annualised"],
    name: "Total ARR Churn",
    description: "Churned monthly recurring revenue, annualised.",
    category: "churn",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["churn", "pause"],
    multiplier: 12,
    dimensions: ["plan", "currency", "country"],
  },
  {
    key: "net_mrr_growth",
    name: "Net MRR Growth",
    description:
      "Everything gained less everything lost. This is the amount that recurring revenue actually moved.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    signed: true,
    dimensions: ["plan", "currency", "country"],
    variants: [
      { key: "net_arr_growth", name: "Net ARR Growth" },
      { key: "net_mrr_growth_rate", name: "Net MRR Growth Rate" },
    ],
  },
  {
    key: "net_arr_growth",
    tags: ["annualised"],
    name: "Net ARR Growth",
    description: "Net monthly recurring growth, annualised.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    signed: true,
    multiplier: 12,
    dimensions: ["plan", "currency", "country"],
  },
  {
    key: "net_mrr_growth_rate",
    name: "Net MRR Growth Rate",
    description: "Net growth as a share of the recurring revenue the window opened with.",
    category: "recurring_revenue",
    kind: "rate",
    source: "derived",
    shape: "flow",
    comparable: true,
    formula: "net_mrr_growth_rate",
    dimensions: [],
  },
  {
    key: "gross_revenue_retention_rate",
    name: "Gross Revenue Retention Rate",
    description:
      "How much of the recurring revenue you started with you kept, giving no credit for growing the accounts you kept.",
    category: "retention",
    kind: "rate",
    source: "derived",
    shape: "flow",
    comparable: true,
    formula: "gross_retention",
    dimensions: [],
  },
  {
    key: "net_revenue_retention_rate",
    name: "Net Revenue Retention Rate",
    description:
      "What the revenue you started with is worth now, expansion included. Above 100% means that the base grew without new customers.",
    category: "retention",
    kind: "rate",
    source: "derived",
    shape: "flow",
    comparable: true,
    formula: "net_retention",
    dimensions: [],
  },
  {
    key: "quick_ratio",
    name: "Quick Ratio",
    description:
      "Everything gained divided by everything lost. Below 1 means the book is shrinking.",
    category: "recurring_revenue",
    kind: "ratio",
    source: "derived",
    shape: "flow",
    comparable: true,
    formula: "quick_ratio",
    dimensions: [],
  },
  {
    key: "average_revenue_per_new_subscription",
    name: "Average Revenue per New Subscription",
    description: "New recurring revenue divided by the number of subscriptions that brought it.",
    category: "acquisitions",
    kind: "money",
    source: "derived",
    shape: "flow",
    comparable: true,
    formula: "arpu_new",
    dimensions: [],
  },
  {
    key: "average_revenue_lost_per_churned_subscription",
    name: "Average Revenue Lost per Churned Subscription",
    description: "Churned recurring revenue divided by the number of subscriptions that left.",
    category: "churn",
    kind: "money",
    source: "derived",
    shape: "flow",
    comparable: true,
    formula: "arpu_churned",
    dimensions: [],
  },
  {
    key: "total_paused_subscription_mrr",
    name: "Total Paused Subscription MRR",
    description:
      "Recurring revenue currently suspended by a pause. It earns nothing, but it is not lost yet.",
    category: "churn",
    kind: "money",
    source: "derived",
    shape: "stock",
    formula: "paused_mrr",
    dimensions: [],
  },
  // ── Billing and tax ────────────────────────────────────────────────────────
  {
    key: "total_billing",
    tags: ["billing_and_taxes"],
    name: "Total Billing",
    description: "Everything invoiced in the period, at the document total.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "billing",
    dimensions: ["currency"],
    variants: [{ key: "net_billing", name: "Net Billing" }],
  },
  {
    key: "net_billing",
    tags: ["billing_and_taxes"],
    name: "Net Billing",
    description: "Invoiced less the credit notes issued against it.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "net_billing",
    dimensions: ["currency"],
  },
  {
    key: "total_non_recurring_billing",
    tags: ["billing_and_taxes"],
    name: "Total Non Recurring Billing",
    description:
      "The one-off part of what was invoiced: setup fees, ad-hoc and non-recurring charges.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "non_recurring_billing",
    dimensions: ["currency"],
  },
  {
    key: "total_taxes",
    tags: ["billing_and_taxes"],
    name: "Total Taxes",
    description: "Tax charged on what was invoiced.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "taxes",
    dimensions: ["currency"],
    variants: [
      { key: "tax_summary", name: "Tax Summary" },
      { key: "tax_exemption_summary", name: "Tax Exemption Summary" },
    ],
  },
  {
    key: "tax_summary",
    tags: ["billing_and_taxes"],
    name: "Tax Summary",
    description:
      "The amount that tax was charged ON. This is the taxable base behind the tax figure.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "taxable_base",
    dimensions: ["currency"],
  },
  {
    key: "tax_exemption_summary",
    tags: ["billing_and_taxes"],
    name: "Tax Exemption Summary",
    description:
      "The amount that carried no tax because it was exempt, zero-rated or reverse-charged.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "exempt_base",
    dimensions: ["currency"],
  },
  {
    key: "total_revenue_leakage",
    tags: ["leakage", "billing_and_taxes"],
    name: "Total Revenue Leakage",
    description: "What discounts and coupons took off the invoices you raised.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "revenue_leakage",
    dimensions: ["currency"],
    variants: [{ key: "revenue_leakage_summary", name: "Revenue Leakage Summary" }],
  },
  {
    key: "revenue_leakage_summary",
    tags: ["leakage", "billing_and_taxes"],
    name: "Revenue Leakage Summary",
    description: "The same discount total, split by the coupon that caused it.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "buckets",
    bucketing: "coupon_leakage",
    dimensions: [],
  },
  {
    key: "total_amount_voided",
    tags: ["leakage", "billing_and_taxes"],
    name: "Total Amount Voided",
    description: "The value of invoices that were voided.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "voided",
    dimensions: ["currency"],
  },
  {
    key: "total_write_off_amount",
    tags: ["leakage", "collections"],
    name: "Total Write-Off Amount",
    description: "The value of invoices written off as uncollectable.",
    category: "receivables",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "written_off",
    dimensions: ["currency"],
  },

  // ── Receivables and dunning ────────────────────────────────────────────────
  {
    key: "total_receivables",
    tags: ["collections"],
    name: "Total Receivables",
    description: "What is currently owed on unpaid invoices.",
    category: "receivables",
    kind: "money",
    source: "invoice",
    shape: "buckets",
    bucketing: "ar_aging",
    dimensions: [],
    variants: [{ key: "receivables_aging_summary", name: "Receivables Aging Summary" }],
  },
  {
    key: "receivables_aging_summary",
    tags: ["collections"],
    name: "Receivables Aging Summary",
    description: "What is owed, by the age of the debt.",
    category: "receivables",
    kind: "money",
    source: "invoice",
    shape: "buckets",
    bucketing: "ar_aging",
    dimensions: [],
  },
  {
    key: "receivables_recovery_summary",
    tags: ["collections"],
    name: "Receivables Recovery Summary",
    description: "Overdue invoices that were eventually paid, by how late they were.",
    category: "receivables",
    kind: "money",
    source: "invoice",
    shape: "buckets",
    bucketing: "recovery_aging",
    dimensions: [],
  },
  {
    key: "dunning_status_summary",
    tags: ["collections"],
    name: "Dunning Status Summary",
    description: "Where every invoice in collection currently stands.",
    category: "receivables",
    kind: "count",
    source: "invoice",
    shape: "buckets",
    bucketing: "dunning_status",
    dimensions: [],
  },
  {
    key: "total_amount_recovered",
    tags: ["collections"],
    name: "Total Amount Recovered",
    description: "Invoices that entered collections and were then paid.",
    category: "receivables",
    kind: "money",
    source: "invoice",
    shape: "flow",
    comparable: true,
    metric: "amount_recovered",
    dimensions: ["currency"],
  },

  // ── Transactions ───────────────────────────────────────────────────────────
  {
    key: "total_payments",
    name: "Total Payments",
    description: "Money collected in the period.",
    category: "transactions",
    kind: "money",
    source: "transaction",
    shape: "flow",
    comparable: true,
    metric: "payments",
    dimensions: ["currency"],
    variants: [
      { key: "net_payments", name: "Net Payments" },
      { key: "recurring_payments", name: "Recurring Payments" },
      { key: "cash_composition", name: "Cash Composition" },
    ],
  },
  // ── Cash, split by what it paid for ────────────────────────────────────────
  // `payments` is invoice-level: one row settles a document that mixes a plan renewal with
  // a setup fee and tax. These four place that cash on the invoice's LINES, so the cash side
  // can answer the question the billing side already answers. Pro-rata, never a priority
  // rule — see `modules/payments/attribution.ts` for why, and for the exactness invariant.
  {
    key: "recurring_payments",
    name: "Recurring Payments",
    description: "Money collected against subscription fees: whole periods and prorated ones.",
    category: "transactions",
    kind: "money",
    source: "payment",
    shape: "flow",
    comparable: true,
    metric: "recurring_cash",
    dimensions: ["currency"],
    variants: [{ key: "net_recurring_payments", name: "Net Recurring Payments" }],
  },
  {
    key: "net_recurring_payments",
    name: "Net Recurring Payments",
    description: "Recurring cash collected, less the part of refunds that gave it back.",
    category: "transactions",
    kind: "money",
    source: "payment",
    shape: "flow",
    comparable: true,
    metric: "net_recurring_cash",
    dimensions: ["currency"],
  },
  {
    key: "non_recurring_payments",
    name: "Non Recurring Payments",
    description: "Money collected against one-off charges: setup fees and ad-hoc items.",
    category: "transactions",
    kind: "money",
    source: "payment",
    shape: "flow",
    comparable: true,
    metric: "non_recurring_cash",
    dimensions: ["currency"],
  },
  {
    key: "usage_payments",
    name: "Usage Payments",
    description: "Money collected against metered usage.",
    category: "transactions",
    kind: "money",
    source: "payment",
    shape: "flow",
    comparable: true,
    metric: "usage_cash",
    dimensions: ["currency"],
  },
  {
    key: "cash_composition",
    name: "Cash Composition",
    description: "How the money collected in the period splits across what it paid for.",
    category: "transactions",
    kind: "money",
    source: "payment",
    shape: "buckets",
    bucketing: "cash_composition",
    dimensions: [],
  },
  {
    key: "total_refunds",
    name: "Total Refunds",
    description: "Money given back in the period.",
    category: "transactions",
    kind: "money",
    source: "transaction",
    shape: "flow",
    comparable: true,
    metric: "refunds",
    dimensions: ["currency"],
  },
  {
    key: "net_payments",
    name: "Net Payments",
    description: "Collected less refunded. This is what you actually kept.",
    category: "transactions",
    kind: "money",
    source: "transaction",
    shape: "flow",
    comparable: true,
    metric: "net_payments",
    dimensions: ["currency"],
  },
  {
    key: "total_failed_payment_transactions",
    tags: ["collections"],
    name: "Total Failed Payment Transactions",
    description: "Payment attempts that did not succeed.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "flow",
    comparable: true,
    metric: "failed_payments",
    dimensions: [],
    variants: [{ key: "payment_error_summary", name: "Payment Error Summary" }],
  },
  {
    key: "payment_error_summary",
    tags: ["collections"],
    name: "Payment Error Summary",
    description: "Failed payments grouped by the reason the gateway gave.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "buckets",
    bucketing: "payment_errors",
    dimensions: [],
  },
  {
    key: "refund_error_summary",
    tags: ["collections"],
    name: "Refund Error Summary",
    description: "Failed refunds grouped by the reason the gateway gave.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "buckets",
    bucketing: "refund_errors",
    dimensions: [],
  },

  // ── Subscriptions and acquisition ──────────────────────────────────────────
  {
    key: "total_active_subscriptions",
    name: "Total Active Subscriptions",
    description: "Subscriptions active or in trial at each point in the period.",
    category: "subscriptions",
    kind: "count",
    source: "stock",
    shape: "stock",
    comparable: true,
    measure: "active_subscriptions",
    dimensions: ["country"],
    variants: [{ key: "total_active_paid_subscriptions", name: "Total Active Paid Subscriptions" }],
  },
  {
    key: "total_active_paid_subscriptions",
    name: "Total Active Paid Subscriptions",
    description: "The subset carrying recurring revenue above zero.",
    category: "subscriptions",
    kind: "count",
    source: "stock",
    shape: "stock",
    comparable: true,
    measure: "paying_subscriptions",
    dimensions: ["country"],
  },
  {
    key: "total_renewing_subscriptions",
    name: "Total Renewing Subscriptions",
    description:
      "Paying subscriptions set to renew. A subscription booked to stop at the end of its current term is not included.",
    category: "subscriptions",
    kind: "count",
    source: "stock",
    shape: "stock",
    comparable: true,
    measure: "renewing_subscriptions",
    dimensions: ["country"],
  },
  {
    key: "total_subscription_trials",
    tags: ["trials"],
    name: "Total Subscription Trials",
    description: "Subscriptions that have ever been in trial.",
    category: "acquisitions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    // No `comparable`: this counts trials started up to the window's END, so it is a
    // running total rather than a flow, and a window-over-window delta would state a
    // basis it does not have.
    metric: "trials",
    dimensions: [],
    variants: [
      { key: "new_trial_subscriptions", name: "New Trial Subscriptions" },
      { key: "trial_conversion_rate", name: "Trial Conversion Rate" },
    ],
  },
  {
    key: "new_trial_subscriptions",
    tags: ["trials"],
    name: "New Trial Subscriptions",
    description: "Trials that started in the period.",
    category: "acquisitions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    comparable: true,
    metric: "new_trials",
    dimensions: [],
  },
  {
    key: "trial_conversion_rate",
    tags: ["trials"],
    name: "Trial Conversion Rate",
    description: "The share of trials started in the period that went on to activate.",
    category: "acquisitions",
    kind: "rate",
    source: "subscription",
    shape: "flow",
    comparable: true,
    metric: "trial_conversion_rate",
    dimensions: [],
  },
  {
    key: "total_same_period_cancellations",
    name: "Total Same Period Cancellations",
    description: "Subscriptions that started and cancelled inside the same period.",
    category: "churn",
    kind: "count",
    source: "subscription",
    shape: "flow",
    comparable: true,
    metric: "same_period_cancellations",
    dimensions: [],
  },
  {
    key: "average_lifetime_of_a_paid_subscription",
    name: "Average Lifetime of a Paid Subscription",
    description: "How long a subscription lasted, on average, among those that ended.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    // No `comparable`: averaged over everything that has ever ended, so the figure does
    // not move with the window and the delta would always be 0.
    metric: "average_lifetime_months",
    dimensions: [],
  },
  {
    key: "average_activation_lead_time",
    name: "Average Activation Lead Time",
    description: "Days from the sign-up of a customer to the activation of their subscription.",
    category: "acquisitions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    // No `comparable`: averaged over every activation on the book, window-independent.
    metric: "activation_lead_days",
    dimensions: [],
  },
  {
    key: "total_subscription_quantity",
    name: "Total Subscription Quantity",
    description:
      "Units across every live subscription: seats, licenses or any other unit that is counted.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    metric: "subscription_quantity",
    noSeries: true,
    dimensions: [],
  },
  {
    key: "total_active_customers",
    tags: ["customers"],
    name: "Total Active Customers",
    description:
      "Customers with at least one live subscription. A customer with three counts once.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    metric: "active_customers",
    noSeries: true,
    dimensions: [],
  },
  // ── Plan movement and the forward book (Phase 3b's columns) ────────────────
  {
    key: "total_upgrade_mrr",
    tags: ["plans"],
    name: "Total Upgrade MRR",
    description:
      "Recurring revenue gained by customers who move to a different, pricier plan. This is not the same as buying more of their current plan.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["expansion"],
    planChange: "changed",
    dimensions: ["plan", "currency", "country"],
    variants: [{ key: "total_downgrade_mrr", name: "Total Downgrade MRR" }],
  },
  {
    key: "total_downgrade_mrr",
    tags: ["plans"],
    name: "Total Downgrade MRR",
    description: "Recurring revenue lost to customers moving to a cheaper plan.",
    category: "churn",
    kind: "money",
    source: "movement",
    shape: "flow",
    comparable: true,
    reasons: ["contraction"],
    planChange: "changed",
    dimensions: ["plan", "currency", "country"],
  },
  {
    key: "plan_movement_summary",
    tags: ["plans"],
    name: "Plan Movement Summary",
    description: "Who moved from which plan to which, and what it was worth.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "buckets",
    bucketing: "plan_movement",
    dimensions: [],
  },
  {
    key: "total_scheduled_upgrade_mrr",
    tags: ["committed", "plans"],
    name: "Total Scheduled Upgrade MRR",
    description:
      "Recurring revenue from plan changes already booked to take effect. An estimate taken when the change was scheduled: gross of discounts, and not restated if the catalog moves before it lands.",
    category: "recurring_revenue",
    kind: "money",
    source: "scheduled",
    shape: "forward",
    scheduled: "upgrade_mrr",
    dimensions: [],
    variants: [
      { key: "total_scheduled_downgrade_mrr", name: "Total Scheduled Downgrade MRR" },
      { key: "total_scheduled_upgrades", name: "Total Scheduled Upgrades" },
    ],
  },
  {
    key: "total_scheduled_downgrade_mrr",
    tags: ["committed", "plans"],
    name: "Total Scheduled Downgrade MRR",
    description:
      "Recurring revenue already booked to be lost to plan changes. Same estimate and the same limits as the upgrade figure.",
    category: "churn",
    kind: "money",
    source: "scheduled",
    shape: "forward",
    scheduled: "downgrade_mrr",
    dimensions: [],
  },
  {
    key: "total_scheduled_upgrades",
    tags: ["committed", "plans"],
    name: "Total Scheduled Upgrades",
    description: "How many subscriptions are booked to move up.",
    category: "recurring_revenue",
    kind: "count",
    source: "scheduled",
    shape: "forward",
    scheduled: "upgrade_count",
    dimensions: [],
  },
  {
    key: "total_scheduled_downgrades",
    tags: ["committed", "plans"],
    name: "Total Scheduled Downgrades",
    description: "How many subscriptions are booked to move down.",
    category: "churn",
    kind: "count",
    source: "scheduled",
    shape: "forward",
    scheduled: "downgrade_count",
    dimensions: [],
  },
  {
    key: "total_scheduled_cancellation_mrr",
    tags: ["committed"],
    name: "Total Scheduled Cancellation MRR",
    description:
      "Recurring revenue on subscriptions already booked to cancel. CMRR excludes this revenue and MRR still includes it.",
    category: "churn",
    kind: "money",
    source: "scheduled",
    shape: "forward",
    scheduled: "cancellation_mrr",
    dimensions: [],
    variants: [{ key: "total_scheduled_cancellations", name: "Total Scheduled Cancellations" }],
  },
  {
    key: "total_scheduled_cancellations",
    tags: ["committed"],
    name: "Total Scheduled Cancellations",
    description: "How many subscriptions are booked to cancel.",
    category: "churn",
    kind: "count",
    source: "scheduled",
    shape: "forward",
    scheduled: "cancellation_count",
    dimensions: [],
  },
  // ── Cohorts ────────────────────────────────────────────────────────────────
  {
    key: "mrr_retention_cohort",
    tags: ["cohorts"],
    name: "MRR Retention Cohort",
    description:
      "For each month's intake, how much of its recurring revenue is still there one month later, two months later, and so on.",
    category: "retention",
    kind: "rate",
    source: "movement",
    shape: "cohort",
    cohort: "mrr",
    dimensions: [],
    variants: [{ key: "subscription_retention_cohort", name: "Subscription Retention Cohort" }],
  },
  {
    key: "subscription_retention_cohort",
    tags: ["cohorts"],
    name: "Subscription Retention Cohort",
    description:
      "The same question about subscriptions rather than money: how many of each month's intake are still live.",
    category: "retention",
    kind: "rate",
    source: "movement",
    shape: "cohort",
    cohort: "subscriptions",
    dimensions: [],
  },
  // ── The waterfall ──────────────────────────────────────────────────────────
  {
    key: "mrr_movement_summary",
    name: "MRR Movement Summary",
    description:
      "Every month on one row: what you opened with, everything that moved, and what you closed with.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "periodic",
    periodic: "mrr_movement",
    dimensions: [],
    variants: [{ key: "arr_movement_summary", name: "ARR Movement Summary" }],
  },
  {
    key: "arr_movement_summary",
    tags: ["annualised"],
    name: "ARR Movement Summary",
    description: "The same month-by-month movement, annualised.",
    category: "recurring_revenue",
    kind: "money",
    source: "movement",
    shape: "periodic",
    periodic: "mrr_movement",
    multiplier: 12,
    dimensions: [],
  },
  // ── Closing the catalogue ──────────────────────────────────────────────────
  {
    key: "churn_breakdown_summary",
    name: "Churn Breakdown Summary",
    description: "How long cancelled subscriptions lasted before they left.",
    category: "churn",
    kind: "count",
    source: "subscription",
    shape: "buckets",
    bucketing: "churn_age",
    dimensions: [],
  },
  {
    key: "average_revenue_per_paid_subscription",
    name: "Average Revenue per Paid Subscription",
    description: "Recurring revenue divided by the subscriptions actually paying for it.",
    category: "subscriptions",
    kind: "money",
    source: "derived",
    shape: "stock",
    formula: "arps",
    dimensions: [],
    variants: [
      {
        key: "lifetime_value_of_a_paid_subscription",
        name: "Lifetime Value of a Paid Subscription",
      },
    ],
  },
  {
    key: "lifetime_value_of_a_paid_subscription",
    name: "Lifetime Value of a Paid Subscription",
    description:
      "What a paying subscription is worth over its life: its average monthly revenue times the average life of one that ended.",
    category: "subscriptions",
    kind: "money",
    source: "derived",
    shape: "stock",
    formula: "ltv",
    dimensions: [],
  },
  {
    key: "total_signups",
    name: "Total Signups",
    description: "Customers who joined in the period. This counts accounts, not subscriptions.",
    category: "acquisitions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    comparable: true,
    metric: "signups",
    dimensions: [],
    tags: ["customers"],
  },
  {
    key: "total_activations",
    name: "Total Activations",
    description: "Subscriptions that started billing in the period: the trial-to-paid moment.",
    category: "acquisitions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    comparable: true,
    metric: "activations",
    dimensions: [],
    tags: ["trials"],
  },
  {
    key: "total_subscriptions",
    name: "Total Subscriptions",
    description:
      "Every subscription on the book, whatever its state. Unpaid subscriptions are included.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    metric: "total_subscriptions",
    noSeries: true,
    dimensions: [],
  },
  {
    key: "total_upcoming_renewal_amount",
    name: "Total Upcoming Renewal Amount",
    description:
      "The recurring value of renewals due in the period. The plan rate for each cycle that falls due, before tax, usage and any discount that did not start yet.",
    category: "receivables",
    kind: "money",
    source: "subscription",
    /**
     * FORWARD, not `flow`. The measure is a cycle end falling due, which is in the future
     * for every live subscription — bucketed backwards it reported eleven empty months and
     * one accidental hit ($685K against $16.6M actually renewing inside 30 days). A window
     * that cannot contain the thing it measures is not a window.
     */
    shape: "forward",
    // No `comparable`: the measure looks AHEAD, so an earlier window would answer a
    // different question, not the same one a period ago.
    metric: "upcoming_renewal_amount",
    dimensions: [],
    tags: ["committed", "collections"],
  },
  {
    key: "total_cards_expired",
    name: "Total Cards Expired",
    description: "Saved cards that can no longer be charged.",
    category: "receivables",
    kind: "count",
    source: "payment_method",
    shape: "stock",
    metric: "cards_expired",
    noSeries: true,
    dimensions: [],
    tags: ["collections"],
    variants: [{ key: "total_cards_due_to_expire", name: "Total Cards Due to Expire" }],
  },
  {
    key: "total_cards_due_to_expire",
    name: "Total Cards Due to Expire",
    description:
      "Saved cards that expire within ninety days. This is the dunning that you can still prevent.",
    category: "receivables",
    kind: "count",
    source: "payment_method",
    shape: "stock",
    metric: "cards_expiring",
    noSeries: true,
    dimensions: [],
    tags: ["collections"],
  },
  // ── Counts of the things themselves ────────────────────────────────────────
  // The money reports above answer "how much"; these answer "how many", which is the
  // question an operations reader arrives with. Every one of them is a count over rows a
  // resolver already loads.
  {
    key: "total_subscription_churn",
    name: "Total Subscription Churn",
    description: "Subscriptions cancelled in the period. This is the count, not the revenue.",
    category: "churn",
    kind: "count",
    source: "subscription",
    shape: "flow",
    comparable: true,
    metric: "cancellations",
    dimensions: [],
  },
  {
    key: "total_payment_transactions",
    name: "Total Payment Transactions",
    description:
      "Payment attempts recorded in the period, whatever their outcome: successes, failures and all other results.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "flow",
    comparable: true,
    metric: "payment_transactions",
    dimensions: [],
    variants: [{ key: "payment_transaction_summary", name: "Payment Transaction Summary" }],
  },
  {
    key: "payment_transaction_summary",
    name: "Payment Transaction Summary",
    description: "The same payment attempts, split by the final status of each one.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "buckets",
    bucketing: "payment_status",
    dimensions: [],
  },
  {
    key: "total_refund_transactions",
    name: "Total Refund Transactions",
    description: "Refunds attempted in the period, whatever their outcome.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "flow",
    comparable: true,
    metric: "refund_transactions",
    dimensions: [],
    variants: [
      { key: "refund_transactions_summary", name: "Refund Transactions Summary" },
      { key: "total_failed_refund_transactions", name: "Total Failed Refund Transactions" },
    ],
  },
  {
    key: "refund_transactions_summary",
    name: "Refund Transactions Summary",
    description: "The same refunds, split by the final status of each one.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "buckets",
    bucketing: "refund_status",
    dimensions: [],
  },
  {
    key: "total_failed_refund_transactions",
    name: "Total Failed Refund Transactions",
    description:
      "Refunds that did not go through. An operational failure rather than a decline, so it is counted apart from the payment failures.",
    category: "transactions",
    kind: "count",
    source: "transaction",
    shape: "flow",
    comparable: true,
    metric: "failed_refunds",
    dimensions: [],
  },
  // ── The account summary ────────────────────────────────────────────────────
  {
    key: "account_summary",
    tags: ["billing_and_taxes", "leakage"],
    name: "Account Summary",
    description:
      "Every month on one row: what was billed, what discounts and taxes it carried, what was credited or written off, and what that leaves. Net is the billed document totals less credit notes and write-offs.",
    category: "transactions",
    kind: "money",
    source: "invoice",
    shape: "periodic",
    periodic: "account_summary",
    dimensions: [],
  },
  // ── Customer grain ────────────────────────────────────────────────────────
  // The ledger carries `customer_id`, so these are a GROUPING of movements we already
  // record, not a second measure. A customer with three subscriptions counts once.
  {
    key: "total_new_customers",
    tags: ["customers"],
    name: "Total New Customers",
    description:
      "Customers who started earning recurring revenue for the first time in the period. One count per customer, however many subscriptions they opened.",
    category: "acquisitions",
    kind: "count",
    source: "movement",
    shape: "flow",
    comparable: true,
    customers: "new",
    dimensions: [],
  },
  {
    key: "total_churned_customers",
    tags: ["customers"],
    name: "Total Churned Customers",
    description:
      "Customers whose recurring revenue fell to nothing in the period and was still nothing at the end of it. This is a lost account, not one that cancelled a single subscription.",
    category: "churn",
    kind: "count",
    source: "movement",
    shape: "flow",
    comparable: true,
    customers: "churned",
    dimensions: [],
  },
  {
    key: "total_customers_with_movement",
    tags: ["customers"],
    name: "Total Customers with Movement",
    description:
      "Customers whose recurring revenue moved at all in the period: up, down, in or out.",
    category: "subscriptions",
    kind: "count",
    source: "movement",
    shape: "flow",
    comparable: true,
    customers: "any",
    dimensions: [],
  },
  {
    key: "customer_churn_rate",
    tags: ["customers"],
    name: "Customer Churn Rate",
    description:
      "Share of the accounts you started the period with that ended it earning nothing. This is logo churn, not subscription churn.",
    category: "churn",
    kind: "rate",
    source: "movement",
    shape: "flow",
    comparable: true,
    customers: "churn_rate",
    dimensions: [],
  },
  // ── What an ACCOUNT is worth ──────────────────────────────────────────────
  // The catalogue already divides revenue by subscriptions. These divide it by the people
  // paying, which is a different number and the one that answers "what is this account
  // worth to us": a customer with three subscriptions is ONE denominator.
  {
    key: "total_paying_customers",
    tags: ["customers"],
    name: "Total Paying Customers",
    description:
      "Customers carrying recurring revenue right now. Fewer than the active count, which includes trials and anything discounted to nothing.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    metric: "paying_customers",
    noSeries: true,
    dimensions: [],
  },
  {
    key: "average_subscriptions_per_customer",
    tags: ["customers"],
    name: "Average Subscriptions per Customer",
    description:
      "Live subscriptions divided by the customers who hold them. This is the factor between per-subscription and per-customer revenue.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    metric: "subscriptions_per_customer",
    noSeries: true,
    dimensions: [],
  },
  {
    key: "average_revenue_per_paying_customer",
    tags: ["customers"],
    name: "Average Revenue per Paying Customer",
    description:
      "Recurring revenue divided by the customers paying it. A customer with three subscriptions counts once, so this sits above the per-subscription figure whenever accounts hold more than one.",
    category: "subscriptions",
    kind: "money",
    source: "derived",
    shape: "stock",
    formula: "arpc",
    dimensions: [],
    variants: [{ key: "lifetime_value_of_a_customer", name: "Lifetime Value of a Customer" }],
  },
  {
    key: "average_customer_lifetime",
    tags: ["customers"],
    name: "Average Customer Lifetime",
    description:
      "How long an account lasted, on average, among those that fully ended. The life runs from the start of the first subscription to the cancellation of the last one.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "flow",
    // No `comparable`: averaged over every account that has ended, so the figure does not
    // move with the window.
    metric: "average_customer_lifetime_months",
    noSeries: true,
    dimensions: [],
  },
  {
    key: "lifetime_value_of_a_customer",
    tags: ["customers"],
    name: "Lifetime Value of a Customer",
    description:
      "What an account is worth over its life: its average monthly recurring revenue times the average life of an account that ended.",
    category: "subscriptions",
    kind: "money",
    source: "derived",
    shape: "stock",
    formula: "customer_ltv",
    dimensions: [],
  },
  {
    key: "customer_concentration",
    tags: ["customers"],
    name: "Customer Concentration",
    description:
      "How much of your recurring revenue sits in your largest accounts. Bands do not overlap, so they sum to total MRR and any top-N share is the running total.",
    category: "recurring_revenue",
    kind: "money",
    source: "subscription",
    shape: "buckets",
    bucketing: "customer_concentration",
    dimensions: [],
  },
  {
    key: "top_customers_by_mrr",
    tags: ["customers"],
    name: "Top Customers by MRR",
    description:
      "Your largest accounts by recurring revenue, with all other accounts on one row. The rows still sum to total MRR.",
    category: "recurring_revenue",
    kind: "money",
    source: "subscription",
    shape: "buckets",
    bucketing: "top_customers",
    dimensions: [],
  },
  {
    key: "customers_by_mrr_band",
    tags: ["customers"],
    name: "Customers by MRR Band",
    description:
      "How many accounts are in each size band. This shows the shape of the book, not its total.",
    category: "subscriptions",
    kind: "count",
    source: "subscription",
    shape: "buckets",
    bucketing: "customer_mrr_band",
    dimensions: [],
  },
];

export const REPORT_BY_KEY = new Map(REPORTS.map((r) => [r.key, r]));

/** The cuts a series can be re-bucketed at, independently of the range preset. */
export const GRANULARITIES = ["day", "week", "month"] as const;

/**
 * May this report's series be re-cut at a different granularity?
 *
 * Only the reports that DRAW a series: a `buckets` ladder, a `cohort` grid and a
 * `periodic` waterfall each define their own rows, and a derived rate or a `noSeries`
 * count answers with a single figure. Re-cutting any of those is not a narrower question,
 * it is a different report — so the parameter is refused there rather than ignored, and
 * the catalogue says which reports take it so the UI never renders a control the engine
 * would refuse. This is the same predicate `verify:reports` uses for "owes a series",
 * asserted equal there: granularity is exactly what cuts a series.
 */
export const acceptsGranularity = (def: ReportDef): boolean =>
  def.source !== "derived" &&
  def.source !== "scheduled" &&
  def.shape !== "buckets" &&
  def.shape !== "cohort" &&
  def.shape !== "periodic" &&
  !def.noSeries;

/**
 * May this report's ageing ladder be rebuilt at a different rung width?
 *
 * Only the reports that ARE the ageing ladder. Every other report's rows mean something
 * else entirely — a dunning state, a decline code, a size band — and a rung width would
 * silently do nothing there, so it is refused rather than ignored, exactly as `granularity`
 * is. The catalogue says which reports take it, so the UI never renders a control the
 * engine would refuse.
 */
export const acceptsAgingInterval = (def: ReportDef): boolean => def.bucketing === "ar_aging";

/** Catalogue order: category first, then the order declared above. */
export const CATEGORY_LABELS: Record<ReportCategory, string> = {
  recurring_revenue: "Recurring Revenue",
  retention: "Retention",
  subscriptions: "Subscriptions",
  acquisitions: "Acquisitions",
  churn: "Churn",
  transactions: "Transactions",
  receivables: "Receivables",
};
