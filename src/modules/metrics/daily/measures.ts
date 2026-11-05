/**
 * The measure registry — what can be asked, as DATA.
 *
 * This file is what `GET /v1/analytics/measures` serialises, so it is written once and read
 * everywhere: the writer decides what to materialise from it, the resolver decides how to
 * aggregate from it, and an integrator reads it to discover the space instead of hard-coding
 * a list. A measure that is not here does not exist.
 *
 * An audit of all 97 report keys (2026-09-20) found they decompose into 80 measures, of which
 * 8 cannot be expressed this way at all — retention cohorts and the movement/account
 * waterfalls carry two dimensions at once; customer concentration, top customers and MRR
 * bands need a global ranking or band edges denominated in the reporting currency, i.e. a
 * dimension domain chosen at READ time. Those keep their reconstruction and are deliberately
 * absent here. See `docs/PROGRESS.md` § Phase 0.5.
 */

/** A value AT an instant, or a sum OVER a window. Getting this wrong produces a chart that is
 *  wrong and looks fine, so it rides on every measure and is echoed on every response. */
export type MeasureKind = "stock" | "flow";

export type MeasureUnit = "money" | "count" | "ratio" | "bps";

export type Grain = "day" | "week" | "month" | "quarter" | "year";

/** Dimensions a caller may slice by. Only these are public; several more are hard-coded
 *  inside individual resolvers and are promoted here only when they are made general. */
export type DimensionId =
  | "plan"
  | "country"
  | "currency"
  | "business"
  /** How late an invoice was when it was finally paid. A closed set of four rungs. */
  | "lateness_band"
  /** Where an invoice stands in collections: in_progress · parked · succeeded · exhausted · stopped. */
  | "dunning_status"
  /** A gateway attempt's outcome: succeeded · failed · in_progress · timeout · needs_attention · … */
  | "transaction_status"
  /**
   * WHY a gateway attempt failed — the normalised decline code, not the gateway's raw
   * string. An OPEN set: the vocabulary is `providers/decline-codes.ts` and it grows with
   * the rails, so a value is only ever emitted because an attempt actually carried it.
   */
  | "failure_reason"
  /** What a payment paid for: recurring · proration · usage · one_time · discount · tax · … */
  | "cash_bucket"
  /**
   * HOW FAR OFF A BOOKED CHANGE IS, from the instant the figure was computed. A closed set
   * of six that PARTITIONS the forward book — overdue · 1_30 · 31_60 · 61_90 · 90_plus ·
   * undated — so the bands sum to the unsliced figure. The rungs are disjoint rather than
   * cumulative, for exactly that reason.
   */
  | "horizon"
  /** The subscription's cadence: daily · weekly · monthly · quarterly · semiannual · annual · multi_year · other. */
  | "billing_interval"
  /** The customer's country grouped by UN M49 region (`metrics/regions.ts`). */
  | "region"
  /** The plan the subscription started on — its earliest plan-bearing ledger row. */
  | "plan_at_start"
  /** `YYYY-MM` the customer first paid, in the business's calendar. */
  | "signup_cohort"
  /**
   * Why a churned subscription stopped: involuntary (payment failed, no payment method,
   * chargeback) · voluntary (everything else). The rule the Cancellations report uses.
   */
  | "churn_kind"
  /** The payment processor an attempt or payment went through: stripe · razorpay · paypal · … */
  | "gateway"
  /** What a line earned as: recurring · usage · one_time · credit_pack (closed set). */
  | "revenue_type"
  /** The product of the line's price, as a product row id; `none` for a line with no price. */
  | "product"
  /** A credit grant's category: paid · promotional. */
  | "credit_category"
  /** Where a credit grant came from: purchase · plan_cycle · manual · restore · auto_top_up. */
  | "credit_source"
  /** A credit grant's unit key; `money` for a grant held in money. */
  | "credit_unit"
  /** A usage meter, as its row id. */
  | "meter";

/**
 * How a period's value is derived from the stored rows. The audit's most load-bearing
 * finding lives in this field.
 *
 * - `sum`   — additive across days. Flows.
 * - `last`  — the value on the period's last day. Stocks: MRR for a month is the MRR at its
 *             end, never the sum of its days, and summing one by accident inflates it by ~30×.
 * - `ratio` — stored as numerator + `denominator` and divided at READ time. Never store the
 *             quotient: a quarter's retention rate is not the mean of its months' rates.
 * - `none`  — not derivable from a finer grain at all. A DISTINCT COUNT is the case that
 *             forces this: a month's distinct customers is not the sum of its days', so the
 *             measure is computed and stored separately at every grain it is served at.
 */
export type Aggregation = "sum" | "last" | "ratio" | "none";

/**
 * Where the measure's facts come from — which reader the writer calls.
 *
 * - `stocks`        — the daily snapshot readers (`snapshots.ts`).
 * - `movements`     — the MRR movement ledger.
 * - `subscriptions` — the book itself, evaluated at an instant or stamped into a window.
 * - `customers`     — the customer table. Customer grain, so no plan and no currency.
 * - `invoices`      — the invoice documents and what hangs off them: lines, applied taxes,
 *                     credit notes. Billing, tax, discount, write-off and receivables.
 * - `transactions`  — the GATEWAY log: one row per attempt against a gateway, with its
 *                     outcome. What the gateway moved.
 * - `payments`      — the engine's applied cash, placed on the invoice LINES it settled.
 *                     What the money paid for.
 * - `payment_methods` — the vaulted instruments. No currency: a card has none.
 *
 * ⚠️ `transactions` and `payments` ANSWER DIFFERENT QUESTIONS AND DO NOT RECONCILE. See the
 * note above the gateway group below; they are two sources rather than one on purpose.
 */
export type MeasureSource =
  | "stocks"
  | "movements"
  | "subscriptions"
  | "customers"
  | "invoices"
  | "transactions"
  | "payments"
  | "payment_methods"
  /** Gateway disputes / chargebacks, per currency of the disputed charge. */
  | "disputes"
  /**
   * THE FORWARD BOOK — changes already booked and not yet applied: the schedule table, plus
   * the cancellation this engine records on the subscription itself. Bi-temporal, so every
   * one of them is as-of the run rather than as-of the period.
   */
  | "scheduled"
  /**
   * THE CUSTOMER AS THE UNIT OF COUNT — distinct accounts over the book and the movement
   * ledger. Separate from `customers` (which counts customer ROWS created, and is additive)
   * because a head count is not: an account present in January and in February is one
   * account over the two months, not two.
   */
  | "customer_grain"
  /**
   * DERIVED — arithmetic over two of the sources above, stored as the two halves and
   * divided at read. Nothing here has facts of its own.
   */
  | "derived"
  /**
   * READ TIME — never stored; composed by the resolver from other measures' converted
   * cells, because the conversion it depends on is chosen per answer. See `fx-measures.ts`.
   */
  | "read_time"
  /** Credit grants and their append-only movements, plus the customer balance ledger accounts. */
  | "credits"
  /** Folded usage events (`usage_rollups`) and the usage lines that billed them. */
  | "usage"
  /** One-time orders: billed invoices with no subscription and a one-time line. */
  | "orders";

/**
 * HOW A RATIO'S TWO HALVES FOLD FROM THE STORED DAY ROWS.
 *
 * A ratio is stored as numerator + denominator and divided at read, so that a quarter is
 * the quarter's own arithmetic and never the mean of its months. But "sum both halves" is
 * only right when BOTH halves are additive, and three of the rates here have a denominator
 * that is a STOCK the period opened with — a quarter's starting revenue is January's, not
 * the sum of three months' starting revenues. So each half states its own rule.
 *
 * - `sum`  — additive across the period. A flow.
 * - `last` — the value on the period's last day. A stock.
 * - `opening` — the value the period OPENED with: the first stored day's denominator.
 *
 * ⚠️ THERE IS NO "OPENING PLUS MOVEMENT" FOLD, and the absence is deliberate. Retention
 * once used one — the first day's opening plus every day's own movement — and it was the
 * best a fold can do for a figure whose numerator is restricted to the cohort the period
 * opened with. It is not good enough: a subscription that starts on day 2 and leaves on
 * day 20 is in DAY 20's opening cohort but not the month's, so the day rows subtract a loss
 * the month must not, and the folded month is a number with no definition. Gross and net
 * retention are therefore `aggregate: "none"` — written per grain, never folded. A future
 * ratio whose numerator is cohort-restricted belongs there too, not in a fold.
 */
export interface RatioFold {
  numerator: "sum" | "last";
  denominator: "sum" | "last" | "opening";
  /**
   * Money converts at read time; a COUNT never does. Both halves of a money ratio must be
   * converted at the same instant and the same rate or the quotient means nothing, and a
   * denominator of subscriptions or customers must be left alone.
   */
  denominatorUnit: "money" | "count";
}

export interface MeasureDef {
  /**
   * What a rate stored with `aggregate: "none"` divides — it has no `RatioFold` to say so.
   * Money halves are converted into the base currency before a cross-currency answer divides
   * them; count halves never are. Required on every such rate; see `hasMoneyHalves`.
   */
  halves?: "money" | "count";
  id: string;
  name: string;
  /** One sentence, published to third parties. Says what the number MEANS, not how it is got. */
  description: string;
  kind: MeasureKind;
  unit: MeasureUnit;
  aggregate: Aggregation;
  dimensions: readonly DimensionId[];
  grains: readonly Grain[];
  /**
   * `per_currency` — held per currency and only ever converted at read time.
   * `none` — not currency-scoped; stored under ISO 4217 `XXX` (a customer count, a card).
   */
  currency: "per_currency" | "none";
  source: MeasureSource;
  /**
   * WHICH INSTANT THE NUMBER DESCRIBES — and the one field here that can make a stored
   * series quietly mean something other than the question it answers.
   *
   * - `period_end` — the period decides the answer: a flow is summed across it, a stock is
   *   read on its last instant. Every period can be recomputed from the facts, so history
   *   is real history.
   * - `computed_at` — the answer is the LIVE state at the moment the row was written, and
   *   the facts carry no history to reconstruct an earlier instant from. Receivables are
   *   the case: an invoice records what is owed NOW, not what was owed last March. Such a
   *   measure is written only for the period in progress and a past period is left
   *   UNWRITTEN — a row backfilled with today's answer would be a fabricated history, and a
   *   zero would be a lie about a period nobody can measure.
   */
  asOf: "period_end" | "computed_at";
  /** Whether a comparison window is meaningful. A forward-looking stock has no previous. */
  supportsCompare: boolean;
  /** Required when `aggregate` is `ratio`, and forbidden otherwise. */
  ratio?: RatioFold;
}

const ALL_GRAINS: readonly Grain[] = ["day", "week", "month", "quarter", "year"];

/**
 * ⚠️ FIRST CUT — the MRR ledger and the subscription stocks.
 *
 * Chosen because every one of them is either additive or last-value, has an existing storage
 * precedent (`mrr_snapshots`, `mrr_movements`), and is what Home and the org screens render.
 * The 10 derived ratios come next, once numerator/denominator pairs exist for them to divide;
 * the customer-grain measures come after that, because they are distinct counts and need the
 * `none` aggregation's per-grain write path proven first.
 *
 * `plan` is on the ledger FLOWS only, because that is where `plan_product_id` is stored on the
 * row. `country` reaches the stocks and the flows but deliberately NOT `cmrr` — the existing
 * catalogue refuses that combination by name and this registry does not quietly widen it.
 * `billing_interval` does reach `cmrr` (and `subscription_cancellations`): it is a property
 * of the subscription itself. `region` follows `country`; `plan_at_start` follows `plan` on
 * MRR and the flows. The rules for each key live in `metrics/dimension-values.ts`.
 *
 * The subscription-book group below joins them. `signups` is customer grain but still `sum`:
 * it counts customer ROWS created, one row one day, which is additive. The distinct counts —
 * active and paying CUSTOMERS — are not, and are still absent.
 */
/**
 * Whether a non-additive measure may be read across several businesses.
 *
 * Only a cohort RATIO stored as two halves can: each business's halves are its own cohort,
 * the cohorts never overlap (a customer belongs to one business), so the organization's
 * figure is Σ numerators ÷ Σ denominators — divided once, never a mean of percentages.
 * A bare distinct count has no denominator to weight it and stays refused. Day and month
 * only: those period ends are the same on every business's calendar, while a week, quarter
 * or year is cut where each business's own calendar puts it.
 */
export function combinesAcrossBusinesses(m: MeasureDef, grain: Grain): boolean {
  return m.halves != null && (grain === "day" || grain === "month");
}

/**
 * Whether a measure's value is built from money — itself money, or a rate whose numerator and
 * denominator are. Such a measure is converted into one currency before a cross-currency
 * answer is formed; adding its halves raw would weigh a rupee paisa as a US cent.
 */
export function hasMoneyHalves(m: MeasureDef): boolean {
  if (m.unit === "money") return true;
  if (m.ratio) return m.ratio.denominatorUnit === "money";
  return m.halves === "money";
}

/**
 * Whether a stored DENOMINATOR is money, and so converted with its numerator. Not the same
 * question as `hasMoneyHalves`: revenue per paying subscription is money over a COUNT, and
 * converting its subscriptions by an exchange rate turned 34 INR subscriptions into 0.
 */
export function denominatorIsMoney(m: MeasureDef): boolean {
  if (m.ratio) return m.ratio.denominatorUnit === "money";
  return m.halves !== "count";
}

export const MEASURES: readonly MeasureDef[] = [
  {
    id: "mrr",
    name: "Monthly recurring revenue",
    description:
      "The rate the live book bills each month, measured at the instant asked for. Per currency, never summed across currencies.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: [
      "plan",
      "plan_at_start",
      "country",
      "region",
      "billing_interval",
      "signup_cohort",
      "currency",
      "business",
    ],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "stocks",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "cmrr",
    name: "Committed monthly recurring revenue",
    description:
      "The recurring revenue under commitment at that instant, including terms already booked to stop. Not the same question as MRR, and not sliceable by country.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["billing_interval", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "stocks",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "active_subscriptions",
    name: "Active subscriptions",
    description: "Subscriptions live at that instant, whether or not they carry revenue.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: [
      "plan",
      "country",
      "region",
      "billing_interval",
      "signup_cohort",
      "currency",
      "business",
    ],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "stocks",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "paying_subscriptions",
    name: "Paying subscriptions",
    description:
      "Active subscriptions carrying revenue above zero, including one booked to stop at the end of its term. Excludes a fully discounted or usage-only line.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: [
      "plan",
      "country",
      "region",
      "billing_interval",
      "signup_cohort",
      "currency",
      "business",
    ],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "stocks",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "renewing_subscriptions",
    name: "Renewing subscriptions",
    description:
      "Paying subscriptions set to renew. A subscription booked to stop at the end of its current term is not included.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["plan", "country", "region", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "stocks",
    asOf: "period_end",
    supportsCompare: true,
  },

  // The flows. Losses are stored as POSITIVE magnitudes — every consumer states them as an
  // amount lost, and a sign convention that flips between reader and writer is how a
  // waterfall stops adding up.
  ...(
    [
      ["mrr_new", "New MRR", "Recurring revenue from subscriptions starting in the period."],
      ["mrr_expansion", "Expansion MRR", "Increases on subscriptions that were already live."],
      [
        "mrr_reactivation",
        "Reactivation MRR",
        "Recurring revenue from subscriptions that had stopped and resumed.",
      ],
      [
        "mrr_contraction",
        "Contraction MRR",
        "Decreases on subscriptions that stayed live, as a positive amount lost.",
      ],
      [
        "mrr_churn",
        "Churned MRR",
        "Recurring revenue lost to cancellation, as a positive amount lost.",
      ],
      [
        "mrr_paused",
        "Paused MRR",
        "Recurring revenue removed by a pause, as a positive amount lost. A pause is not churn and is reported apart from it.",
      ],
    ] as const
  ).map(([id, name, description]): MeasureDef => ({
    id,
    name,
    description,
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: [
      "plan",
      "plan_at_start",
      "country",
      "region",
      "billing_interval",
      "signup_cohort",
      ...(id === "mrr_churn" ? (["churn_kind"] as const) : []),
      "currency",
      "business",
    ],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "movements",
    asOf: "period_end",
    supportsCompare: true,
  })),
  {
    id: "mrr_fx_impact",
    name: "FX impact on MRR",
    description:
      "How much a converted MRR total moved because exchange rates did, not because the book did: converted closing MRR less converted opening MRR less every movement converted at its own day's rate. Signed. Zero in a single-currency answer, where no rate applies.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: [],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "read_time",
    asOf: "period_end",
    supportsCompare: false,
  },

  /**
   * ── THE SUBSCRIPTION BOOK ───────────────────────────────────────────────────────────
   * Counts over the book and the customer table, taken from the reports that already
   * answer these questions. None of them carries a plan: a subscription's plan is resolved
   * per item rather than stored on the row, and a customer has none at all — so the
   * registry declares the dimensions these numbers genuinely have and no more.
   *
   * Subscription counts are held per currency, like every other subscription-grain figure;
   * a count is summed across currencies at read time because it is not money. `signups` is
   * customer grain and has no currency, so it is stored under `XXX`.
   */
  {
    id: "subscriptions_total",
    name: "Total subscriptions",
    description:
      "Every subscription in existence at that instant, whatever its state. This includes subscriptions that never paid and subscriptions already cancelled.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "subscriptions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "subscription_quantity",
    name: "Subscription quantity",
    description:
      "Units across the live book at that instant: seats, licenses or any other unit that each subscription counts. Not a headcount of subscriptions.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "subscriptions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "trials_cumulative",
    name: "Trials to date",
    description:
      "Subscriptions that had ever begun a trial as at that instant, whether or not the trial converted.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "subscriptions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "trials_active",
    name: "In trial",
    description:
      "Subscriptions whose trial was RUNNING at that instant: started, not yet over and not already cancelled. An open-ended trial with no end on file counts. ⚠️ The trial's end is read as it stands now, so extending a trial restates the days between the old end and the new one.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "subscriptions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "trials_started",
    name: "Trials started",
    description: "Subscriptions whose trial began in the period.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "subscriptions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "activations",
    name: "Activations",
    description: "Subscriptions that started billing in the period: the trial-to-paid moment.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "subscriptions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "subscription_cancellations",
    name: "Subscription cancellations",
    description:
      "Subscriptions cancelled in the period. This is the count, not the revenue lost with it.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["billing_interval", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "subscriptions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "customers_created",
    name: "Customers created",
    description:
      "Customer accounts created in the period. An account, not a subscription: a customer who starts three subscriptions is counted once, and one who starts none is still counted. Deliberately NOT the same question as the number who began subscribing. That is a distinct count over customers with a live subscription, and it is a separate measure.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["business"],
    grains: ALL_GRAINS,
    currency: "none",
    source: "customers",
    asOf: "period_end",
    supportsCompare: true,
  },

  /**
   * ── INVOICES AND RECEIVABLES ────────────────────────────────────────────────────────
   * What was billed, what tax and discount rode on it, what was never collected, and what
   * is still owed. Money per currency, integer minor units, converted only at read time.
   *
   * ⚠️ THE WINDOW EACH ONE IS DATED BY IS PART OF THE MEASURE, and they are not the same
   * date. Billing, tax, discount and write-off are dated by the invoice's ISSUE date;
   * a void by the day it was voided; a recovery by the day the money landed. Each
   * description says which, because a figure whose window is guessed is a figure that
   * disagrees with the ledger by exactly the invoices near the edge.
   *
   * Four of them are not flows at all. `receivables_outstanding`, `receivables_invoices`,
   * `dunning_invoices` and `dunning_subscriptions` describe the book AS IT STANDS — an invoice records what is owed now, and nothing
   * records what was owed last March — so they carry `asOf: "computed_at"` and are written
   * only for the period in progress. A past period has NO row, which reads as unknown.
   * None of them carries a plan or a country: an invoice is a document to a customer, and
   * neither dimension is on it.
   */
  {
    id: "billing_gross",
    name: "Total billing",
    description:
      "Everything invoiced in the period at the document total, tax included. Dated by the invoice's issue date, and counts only invoices that were actually raised. A draft that still collects lines is not billing.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "billing_net",
    name: "Net billing",
    description:
      "Invoiced in the period, less the credit notes issued in the same period. The credit note is dated by ITS OWN issue date, so a note against an older invoice reduces the period it was raised in, not the one being credited.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "credit_notes_issued",
    name: "Credit notes issued",
    description:
      "The document value of credit notes raised in the period. We date each credit note by its OWN issue date. So a note against an older invoice belongs to the period it was RAISED in, not the period of the credited invoice. Total billing less this figure gives net billing. This measure shows the figure on its own.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "billing_non_recurring",
    name: "Non-recurring billing",
    description:
      "The one-off part of what was invoiced: setup fees and ad-hoc charges, not the subscription lines. Gross of discount, like every line amount. Credit packs are included; Revenue billed shows them apart.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "revenue_billed",
    name: "Revenue billed",
    description:
      "What was invoiced in the period before tax, by what it was for: subscriptions, usage, one-time sales and credit packs. Net of discounts; a discount on the whole invoice is shared across its lines by value. Rounding is left out. The meter split covers usage lines only.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business", "revenue_type", "product", "meter"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "tax_charged",
    name: "Tax charged",
    description:
      "Tax charged on what was invoiced in the period. Money collected for a tax authority, not revenue.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "taxable_base",
    name: "Taxable base",
    description:
      "The amount that tax was charged ON: the invoiced document totals less the tax itself. We take it from the document and do not add up the lines. A line can be partly exempt, and the document total is the figure that the invoice shows.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "exempt_base",
    name: "Exempt base",
    description:
      "Line value on invoices carrying at least one exempt, zero-rated or reverse-charged line. ⚠️ It is the WHOLE invoice's line value, not the exempt lines alone, so a part-exempt invoice contributes in full. This is the same figure that the exemption report always published.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "discount_given",
    name: "Discount given",
    description:
      "What discounts and coupons took off the invoices raised in the period, totaled from the line amounts they reduced. An invoice that a discount took to zero, such as a 100%-off trial, is not included. Nothing was lost on it.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "invoice_voided",
    name: "Amount voided",
    description:
      "The document value of invoices voided in the period, dated by the day they were voided. This is not the day they were raised, which may be any earlier period.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "invoice_written_off",
    name: "Amount written off",
    description:
      "The document value of invoices written off as uncollectable, dated by the invoice's ISSUE date. Nothing records the day a write-off happened, so this says which billing a business failed to collect, never when it gave up.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "amount_recovered",
    name: "Amount recovered",
    description:
      "Invoices that entered collections and were then paid, dated by the day the money arrived. This is the value that collections saved.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "amount_exhausted",
    name: "Amount lost to collections",
    description:
      "Invoices that collections stopped chasing, dated by the day it stopped. The counterpart to amount recovered: together they are everything that dunning completed in the period. ⚠️ Only exhaustions recorded after this measure shipped carry a date, so earlier ones are absent rather than counted. The series is short, not zero.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "dunning_recovered_invoices",
    name: "Invoices recovered",
    description:
      "How many invoices entered collections and were then paid, dated by the day the money arrived. This is the count beside the amount, because a rate by value and a rate by invoice are different questions. They differ on a book with one large renewal and many small failures.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "dunning_exhausted_invoices",
    name: "Invoices lost to collections",
    description:
      "How many invoices collections gave up on, dated by the day it gave up. ⚠️ Carries the same short history as the amount: an exhaustion recorded before this measure shipped has no date and is absent.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "recovery_paid_late",
    name: "Invoices paid, by lateness",
    description:
      "The document value of invoices paid in the period, split by how late they were against their due date. The unsliced figure is every invoice paid in the period, whether on time or not.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business", "lateness_band"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "receivables_outstanding",
    name: "Receivables outstanding",
    description:
      "What is still owed on unpaid invoices, as the book stands right now. This is the issue-time collectible LESS the cash already applied, with a floor of zero. So a settled invoice owes nothing, whatever its status row says. ⚠️ An invoice records what is owed today. Nothing records what was owed last March, so this measure has no history. Only the period in progress carries a figure. An earlier period is unknown, not zero. The aging ladder is not stored with it. Its rungs are chosen when the question is asked.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "receivables_invoices",
    name: "Open invoices",
    description:
      "How many invoices still carry a balance, as the book stands right now. This is the count beside the receivables amount. An invoice whose balance is fully settled is not counted, whatever its status row still says. ⚠️ Like the amount, this has no history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "dunning_recovery_rate",
    name: "Collections recovery rate",
    description:
      "Of the money that collections completed in the period, the share that it recovered: recovered over recovered plus abandoned. Invoices still in retry are in neither half. They have no outcome yet, and counting them as losses would make the rate a function of how much is currently in flight. A period where collections finished nothing has NO rate and publishes null, never 0%.",
    kind: "flow",
    unit: "bps",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
    // Both halves are flows: a quarter is its own arithmetic, not the mean of its months.
    ratio: { numerator: "sum", denominator: "sum", denominatorUnit: "money" },
  },
  {
    id: "dunning_invoices",
    name: "Invoices in collections",
    description:
      "How many invoices stand in each collections state right now, counting every invoice dunning has ever touched. ⚠️ A state is a current fact, not a dated one, so like receivables this has no history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business", "dunning_status"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "dunning_subscriptions",
    name: "Subscriptions in dunning",
    description:
      "Subscriptions with an unpaid invoice being chased right now: retries scheduled, or the chase paused. Split by state, each slice counts subscriptions with an unpaid invoice in it. `exhausted` means that all retries are used on an invoice that is still owed. Paid, voided and written-off invoices are never counted. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business", "dunning_status"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "computed_at",
    supportsCompare: false,
  },

  /**
   * ── THE GATEWAY LOG ─────────────────────────────────────────────────────────────────
   * What a gateway moved, and what it refused. One row per attempt, dated by the instant
   * the attempt OCCURRED — `settled_at` is null on every failure, so it cannot window a
   * family that is half about failures, and `occurred_at` is what the published reports
   * already use.
   *
   * ⚠️ THESE ARE NOT THE CASH MEASURES BELOW, AND THE TWO MUST NOT BE RECONCILED.
   * `payments_captured` sums `transactions` — what the gateway moved. `cash_collected`
   * sums `payments` — what was applied to a document. They agree on a book this engine
   * billed itself, and diverge on a payment with no transaction row (a wallet draw, an
   * offline settlement) and on an imported transaction that settled several invoices,
   * where the importer stores the applied amount on the payment and the full amount on the
   * transaction. Each is right about its own question; neither is a check on the other,
   * and a "net" of the two would be arithmetic across two different populations.
   *
   * No plan and no country: a gateway attempt carries neither.
   */
  {
    id: "payments_captured",
    name: "Payments captured",
    description:
      "Money the gateway actually took in the period, summed from successful payment attempts and dated by when the attempt occurred. ⚠️ This is the gateway's view. It is deliberately NOT the same population as the cash measures, which sum what was applied to invoices, and the two are not expected to agree.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "transactions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "refunds_issued",
    name: "Refunds issued",
    description:
      "Money given back through the gateway in the period, from successful refund attempts, dated by when the refund occurred. It is not dated by the payment that it reverses.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "transactions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "payments_net",
    name: "Net payments",
    description:
      "Captured less refunded in the same period. This is what the gateway left you with. A refund of an older payment reduces the period the refund happened in, because that is when the money left.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "transactions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "payment_attempts",
    name: "Payment attempts",
    description:
      "Every payment attempt the gateway saw in the period, whatever became of it. Split by outcome, the slices are every attempt in exactly one state, so they sum to this figure.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business", "transaction_status", "gateway"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "transactions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "refund_attempts",
    name: "Refund attempts",
    description:
      "Every refund attempt in the period, whatever became of it, split by outcome the same way payment attempts are.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business", "transaction_status"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "transactions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "payment_failures",
    name: "Failed payment attempts",
    description:
      "Payment attempts in the period that did not succeed, split by the normalized reason the gateway gave. An attempt whose reason the gateway withheld is counted under `unspecified` and is not dropped, so the reasons still sum to the total.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business", "failure_reason", "gateway"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "transactions",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "refund_failures",
    name: "Failed refund attempts",
    description:
      "Refund attempts in the period that did not succeed, split by the reason the gateway gave. A refund that fails is money you still owe a customer, which is why it is counted apart from a failed payment.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["currency", "business", "failure_reason"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "transactions",
    asOf: "period_end",
    supportsCompare: true,
  },

  /**
   * ── CASH, PLACED ON WHAT IT PAID FOR ────────────────────────────────────────────────
   * A payment settles a DOCUMENT that routinely mixes a plan renewal with a setup fee, a
   * proration and tax. These five place that cash on the invoice's lines pro-rata — one
   * allocator, `modules/payments/attribution.ts`, with Σ allocations equal to the payment
   * by construction — so the cash side can answer what the billing side already answers.
   *
   * Dated by the payment's own date. A payment row records when it was taken and nothing
   * else; there is no separate settlement stamp to prefer.
   *
   * GROSS unless the id says net: a refund is its own direction and would otherwise net
   * silently into a figure named "collected". `cash_recurring_net` opts in, and runs
   * through the SAME allocator, so the pair cannot disagree about what a recurring line is.
   *
   * No plan cut. The attribution rows carry a subscription id, so it looks free — but a
   * plan is resolved from the subscription's items AS THEY ARE NOW, and cash collected two
   * years ago against a plan since left would be filed under the current one. The movement
   * ledger stores the plan with the row precisely because that is not good enough.
   */
  {
    id: "cash_collected",
    name: "Cash collected",
    description:
      "Money applied to invoices in the period, split by what it paid for. ⚠️ This sums the engine's applied payments, not the gateway log, so it is deliberately a different figure from payments captured and the two are not reconciled.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business", "cash_bucket", "gateway"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "payments",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "cash_recurring",
    name: "Recurring cash",
    description:
      "The part of the money collected that paid subscription fees: whole periods and prorated changes together. Gross: refunds are not deducted from it.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "payments",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "cash_non_recurring",
    name: "Non-recurring cash",
    description:
      "The part that paid one-off charges: setup fees and ad-hoc items. Metered usage is NOT included here. It recurs without being a fixed fee and has its own figure. Credit packs are included; Revenue collected shows them apart.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "payments",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "cash_usage",
    name: "Usage cash",
    description: "The part that paid for metered usage.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "payments",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "cash_recurring_net",
    name: "Net recurring cash",
    description:
      "Recurring cash collected, less the recurring part of the refunds made in the same period. A refund is attributed through the same allocator as the payment it reverses, so a fully refunded payment nets to exactly zero.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "payments",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "billed_customers",
    name: "Customers billed",
    description:
      "Customers with at least one invoice raised in the period, for any kind of revenue. One count per customer. Not additive: two periods cannot be added.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "revenue_per_customer",
    halves: "count",
    name: "Revenue per customer billed",
    description:
      "Revenue billed in the period divided by the customers billed in it, for every kind of revenue: subscriptions, usage, one-time sales and credit packs. Not additive.",
    kind: "flow",
    unit: "money",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "revenue_collected",
    name: "Revenue collected",
    description:
      "Money applied to invoices in the period, by what it paid for: subscriptions, usage, one-time sales and credit packs. Before tax and net of discounts, so the part of a payment that paid tax or rounding is left out. Refunds are not deducted.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business", "revenue_type"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "payments",
    asOf: "period_end",
    supportsCompare: true,
  },

  /**
   * ── SAVED CARDS ─────────────────────────────────────────────────────────────────────
   * Two counts about NOW. We keep no history of an instrument's status, and a card's
   * expiry is a fact about the card rather than about any period — so a twelve-month line
   * would imply a history nothing recorded. Both therefore carry `asOf: "computed_at"`:
   * the period containing the run gets a figure and an earlier period gets NO row.
   *
   * No currency — a card has none, so they are stored under `XXX`.
   */
  // ── Disputes ─────────────────────────────────────────────────────────────────────────
  ...(
    [
      [
        "disputes_open",
        "Open disputes",
        "count",
        "Disputes still open, awaiting a response or under review, counted as they stand right now. They are banded by how soon their evidence is due. `overdue` means that the deadline is past. `undated` means that the gateway sent no deadline. ⚠️ No history: only the period in progress carries a figure.",
      ],
      [
        "disputes_open_amount",
        "Open dispute amount",
        "money",
        "The disputed amount still open, awaiting a response or under review, as it stands right now, banded by how soon evidence is due. ⚠️ No history: only the period in progress carries a figure.",
      ],
    ] as const
  ).map(([id, name, unit, description]): MeasureDef => ({
    id,
    name,
    description,
    kind: "stock",
    unit,
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "disputes",
    asOf: "computed_at",
    supportsCompare: false,
  })),
  ...(
    [
      [
        "disputes_opened",
        "Disputes opened",
        "count",
        "Disputes the gateways opened in the period, dated by when each was opened.",
      ],
      [
        "disputes_opened_amount",
        "Disputed amount opened",
        "money",
        "The amount disputed in the period, dated by when each dispute was opened.",
      ],
      [
        "disputes_won",
        "Disputes won",
        "count",
        "Disputes decided in the business's favor in the period, dated by when each closed. A dispute withdrawn or accepted is neither won nor lost.",
      ],
      [
        "disputes_won_amount",
        "Disputed amount won",
        "money",
        "The disputed amount decided in the business's favor in the period, dated by when each dispute closed.",
      ],
      [
        "disputes_lost",
        "Disputes lost",
        "count",
        "Disputes decided against the business in the period, dated by when each closed.",
      ],
      [
        "disputes_lost_amount",
        "Disputed amount lost",
        "money",
        "The disputed amount decided against the business in the period, dated by when each dispute closed.",
      ],
    ] as const
  ).map(([id, name, unit, description]): MeasureDef => ({
    id,
    name,
    description,
    kind: "flow",
    unit,
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "disputes",
    asOf: "period_end",
    supportsCompare: true,
  })),
  // ── Credits ──────────────────────────────────────────────────────────────────────────
  ...(
    [
      [
        "credits_granted",
        "Credits granted",
        "money",
        ["credit_category", "credit_source"],
        "Face value of credit that became spendable in the period: packs bought, plan credits, grants made by hand and top-ups. A grant that waits for its invoice to be paid counts when it activates. Credit given back or carried over is not new credit.",
      ],
      [
        "credits_used",
        "Credits used",
        "money",
        ["credit_category"],
        "Face value of credit that paid invoice lines in the period, less what was given back on a refund or credit note.",
      ],
      [
        "credits_used_cost",
        "Credit revenue recognized",
        "money",
        [],
        "What the paid credit used in the period was sold for. This is the revenue that prepaid credit turns into as it is used.",
      ],
      [
        "credits_expired",
        "Credits expired",
        "money",
        ["credit_category"],
        "Face value of credit that expired unused in the period.",
      ],
      [
        "credit_breakage",
        "Credit breakage",
        "money",
        [],
        "What the paid credit that expired unused in the period was sold for. It becomes revenue when it expires.",
      ],
      [
        "credit_packs_sold",
        "Credit packs sold",
        "count",
        [],
        "Credit pack lines on invoices raised in the period.",
      ],
    ] as const
  ).map(([id, name, unit, dims, description]): MeasureDef => ({
    id,
    name,
    description,
    kind: "flow",
    unit,
    aggregate: "sum",
    dimensions: ["currency", "business", ...dims],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "credits",
    asOf: "period_end",
    supportsCompare: true,
  })),
  ...(
    [
      [
        "credits_outstanding",
        "Credit balance",
        "money",
        ["credit_category", "credit_unit"],
        "Face value of credit customers still hold at the end of the period, paid and promotional.",
      ],
      [
        "credits_liability",
        "Credit liability",
        "money",
        [],
        "What the paid credit customers still hold was sold for: money received for credit not yet used.",
      ],
      [
        "credit_customers",
        "Customers with credit",
        "count",
        [],
        "Customers who hold any credit at the end of the period.",
      ],
      [
        "prepaid_balance",
        "Prepaid account balance",
        "money",
        [],
        "Money customers hold on their account at the end of the period: top-ups, promotional credit and excess payments. It pays any invoice, so it is kept apart from credit grants.",
      ],
    ] as const
  ).map(([id, name, unit, dims, description]): MeasureDef => ({
    id,
    name,
    description,
    kind: "stock",
    unit,
    aggregate: "last",
    dimensions: ["currency", "business", ...dims],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "credits",
    asOf: "period_end",
    supportsCompare: true,
  })),
  // ── Usage ────────────────────────────────────────────────────────────────────────────
  {
    id: "usage_events",
    name: "Usage events",
    description:
      "Usage events received in the period, by meter. Events are counted once they are folded into usage totals, which runs every few minutes.",
    kind: "flow",
    unit: "count",
    aggregate: "sum",
    dimensions: ["business", "meter"],
    grains: ALL_GRAINS,
    currency: "none",
    source: "usage",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "usage_customers",
    name: "Customers with usage",
    description:
      "Customers who sent at least one usage event in the period. One count per customer. Not additive: two periods cannot be added.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["business"],
    grains: ALL_GRAINS,
    currency: "none",
    source: "usage",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "usage_cost",
    name: "Usage cost",
    description:
      "What the usage invoiced in the period cost you, on the lines that carry a full cost, by meter. Compare it with the usage revenue of the same lines in the Usage margin report.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business", "meter"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "usage",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "usage_revenue_retention",
    halves: "money",
    name: "Usage revenue retention",
    description:
      "Usage revenue invoiced in the period to customers who had usage revenue in the period before it, as a share of what they had then. Above 100% means existing customers use more. Each period is compared with the period of the same length just before it. In basis points, where 10,000 is 100%. Not additive.",
    kind: "flow",
    unit: "bps",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "usage",
    asOf: "period_end",
    supportsCompare: true,
  },
  // ── One-time sales ───────────────────────────────────────────────────────────────────
  ...(
    [
      [
        "orders",
        "Orders",
        "count",
        [],
        "One-time orders raised in the period. An order is an invoice with no subscription and at least one one-time line that is not a credit pack.",
      ],
      [
        "order_revenue",
        "Order revenue",
        "money",
        ["product"],
        "What the orders raised in the period are worth, before tax and after discounts, by product.",
      ],
      [
        "order_refunds",
        "Order refunds",
        "money",
        [],
        "Money given back in the period on payments for orders, whenever the order was raised.",
      ],
    ] as const
  ).map(([id, name, unit, dims, description]): MeasureDef => ({
    id,
    name,
    description,
    kind: "flow",
    unit,
    aggregate: "sum",
    dimensions: ["currency", "business", ...dims],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "orders",
    asOf: "period_end",
    supportsCompare: true,
  })),
  {
    id: "average_order_value",
    name: "Average order value",
    description:
      "Order revenue divided by the number of orders in the period. Both halves are summed over the period, so a quarter is its own average, not the mean of its months.",
    kind: "flow",
    unit: "money",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "orders",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "sum", denominator: "sum", denominatorUnit: "count" },
  },
  {
    id: "buyers",
    name: "Buyers",
    description:
      "Customers who placed at least one order in the period. One count per customer. Not additive.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "orders",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "returning_buyers",
    name: "Returning buyers",
    description: "Buyers in the period who had placed an order before it. Not additive.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "orders",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "returning_buyer_rate",
    halves: "count",
    name: "Returning buyer rate",
    description:
      "Returning buyers as a share of all buyers in the period. In basis points, where 10,000 is 100%. Not additive.",
    kind: "flow",
    unit: "bps",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "orders",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "credits_expiring",
    name: "Credits expiring",
    description:
      "Face value of credit customers hold now, banded by how soon it expires. `undated` is credit that does not expire. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "credits",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "cards_expired",
    name: "Cards expired",
    description:
      "Saved cards that can no longer be charged, counted as the vault stands right now. A card that the engine already marked expired counts as expired whatever its printed date says. Otherwise the printed expiry decides, and a card is good to the last day of the month it names. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["business"],
    grains: ALL_GRAINS,
    currency: "none",
    source: "payment_methods",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "cards_expiring",
    name: "Cards expiring",
    description:
      "Saved cards that still work but expire within ninety days. This is the dunning that you can still prevent. Counted from the instant the figure was computed, so the ninety days always run forward from now. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["business"],
    grains: ALL_GRAINS,
    currency: "none",
    source: "payment_methods",
    asOf: "computed_at",
    supportsCompare: false,
  },

  /**
   * ── DERIVED RATIOS ──────────────────────────────────────────────────────────────────
   * Ten figures that are arithmetic over the book and the ledger. Every one is stored as
   * NUMERATOR + DENOMINATOR and divided at read; not one of them stores a quotient.
   *
   * ⚠️ WHY THE QUOTIENT IS NEVER STORED. A ratio is not re-aggregatable. The mean of
   * January, February and March's retention is not the first quarter's retention, and a
   * year built from months is not the year. Divide once, at the end, over the period
   * actually asked for — which is only possible if both halves survive to read time.
   *
   * ⚠️ THE WINDOW. The published reports for these ten IGNORE the window they are given:
   * the four rates and the two ARPUs always answer for the last COMPLETE month, and the
   * four averages always answer for `now`. As MEASURES they answer for the period they are
   * stored against, because a series whose every point holds the same number is not a
   * series. That is a GENERALISATION, not a redefinition: read the month the report would
   * have picked and the figure is the report's. Two consequences are stated rather than
   * smoothed over, and both are real:
   *
   *  - The report cuts its month in the BUSINESS's timezone; these rows are cut on the UTC
   *    calendar, like every other row in the table. On a non-UTC book the two months are
   *    hours apart at each edge and the figures may differ by whatever moved in those hours.
   *  - MRR is the cached `subscriptions.mrr`, so a past period carries the rate a
   *    subscription holds NOW — the same limitation every stock in this table carries.
   *
   * ⚠️ A DENOMINATOR OF ZERO IS NOT A RATIO OF ZERO. It is unknown, and it is stored as the
   * measured zero it is — `ratioValue` below refuses to divide by it and answers null. No
   * reader ever sees an Infinity, a NaN, or a fabricated 0%.
   *
   * ⚠️ CURRENCY. Both halves are held in the currency they were earned in and converted
   * together, once, at read. A count denominator is never converted, which is what
   * `denominatorUnit` says. A customer is counted in exactly ONE currency — the one
   * carrying most of its recurring revenue — so the per-currency denominators still sum to
   * the distinct number of customers and a converted read does not count anyone twice.
   */
  {
    id: "gross_revenue_retention",
    halves: "money",
    name: "Gross revenue retention",
    description:
      "How much of the recurring revenue the period opened with was still there at the end, giving no credit for growing the accounts that stayed. Numerator: the opening revenue less what THAT revenue contracted, churned or paused away across the window. A subscription that both arrived and left inside the window was never part of the opening and does not reduce it. Denominator: the opening revenue. In basis points, where 10,000 is 100%. Not additive: the cohort is a different set at every grain, so each grain is computed and stored on its own.",
    kind: "flow",
    unit: "bps",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "net_revenue_retention",
    halves: "money",
    name: "Net revenue retention",
    description:
      "What the revenue the period opened with is worth at the end, the expansion and reactivation of THAT revenue included. Above 10,000 basis points the base grew without a single new customer. So neither the growth nor the loss of anything that arrived inside the window counts, on either side. Denominator: the opening revenue. Not additive: the cohort is a different set at every grain, so each grain is computed and stored on its own.",
    kind: "flow",
    unit: "bps",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "net_mrr_growth_rate",
    name: "Net recurring revenue growth rate",
    description:
      "Everything gained less everything lost across the window, as a share of the recurring revenue the window opened with. In basis points.",
    kind: "flow",
    unit: "bps",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "sum", denominator: "opening", denominatorUnit: "money" },
  },
  {
    id: "quick_ratio",
    name: "Quick ratio",
    description:
      "Everything gained divided by everything lost across the window: new, expansion and reactivation over contraction, churn and pause. Below 1 the book is shrinking. Both halves are flows, so a quarter is its own arithmetic rather than an average of its months.",
    kind: "flow",
    unit: "ratio",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "sum", denominator: "sum", denominatorUnit: "money" },
  },
  {
    id: "revenue_per_new_subscription",
    name: "Revenue per new subscription",
    description:
      "New recurring revenue across the window divided by the number of subscriptions that brought it.",
    kind: "flow",
    unit: "money",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "sum", denominator: "sum", denominatorUnit: "count" },
  },
  {
    id: "revenue_lost_per_churned_subscription",
    name: "Revenue lost per churned subscription",
    description:
      "Recurring revenue lost to churn and pause across the window divided by the number of subscriptions that left. Contraction is not counted here: the subscription is still on the book.",
    kind: "flow",
    unit: "money",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "sum", denominator: "sum", denominatorUnit: "count" },
  },
  {
    id: "revenue_per_paying_subscription",
    name: "Revenue per paying subscription",
    description:
      "Recurring revenue at the period's end divided by the subscriptions actually paying for it. A free or fully discounted line is in neither half.",
    kind: "stock",
    unit: "money",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "last", denominator: "last", denominatorUnit: "count" },
  },
  {
    id: "revenue_per_paying_customer",
    name: "Revenue per paying customer",
    description:
      "Recurring revenue at the period's end divided by the customers paying it. An account with three subscriptions is one denominator, so this sits above the per-subscription figure wherever accounts hold more than one.",
    kind: "stock",
    unit: "money",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "last", denominator: "last", denominatorUnit: "count" },
  },
  {
    id: "mrr_top10_share",
    name: "Top 10 customers' share of MRR",
    description:
      "The recurring revenue of the ten largest paying customers at the period's end, as a share of all paying customers' recurring revenue. In basis points, where 10,000 is 100%. Per currency: a customer paying in two currencies ranks in each.",
    kind: "stock",
    unit: "bps",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "last", denominator: "last", denominatorUnit: "money" },
  },
  {
    id: "subscription_lifetime_value",
    name: "Lifetime value of a paying subscription",
    description:
      "What a paying subscription is worth over its life. It is the revenue per paying subscription at the period's end, times the average life of a subscription that had ended by then. Null until a subscription has actually ended. A lifetime with no completed lifetime in it is a guess, not an estimate.",
    kind: "stock",
    unit: "money",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "last", denominator: "last", denominatorUnit: "count" },
  },
  {
    id: "customer_lifetime_value",
    name: "Lifetime value of a customer",
    description:
      "What an account is worth over its life. It is the revenue per paying customer at the period's end, times the average life of an account that had fully ended by then. The life runs from the start of the first subscription to the cancellation of the last one. Null until an account has fully ended.",
    kind: "stock",
    unit: "money",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "last", denominator: "last", denominatorUnit: "count" },
  },

  /**
   * ⚠️ THE CUSTOMER GRAIN — the eight figures counted in ACCOUNTS, and the first that are
   * NOT ADDITIVE.
   *
   * Everything above counts events or money, so a month is the sum of its days. These count
   * people. An account that moved in January and again in February is ONE account over the
   * two months, and a reader that added the months would report it twice.
   *
   * The four WINDOW counts therefore declare `aggregate: "none"`: there is no arithmetic
   * that turns days into them, so each grain is computed and stored separately, and a grain
   * that was never written is reported missing rather than folded up. The four INSTANT
   * figures are distinct counts too, but taken AT a moment — a month's is the figure on its
   * last day, which is exactly what `last` and a `last`/`last` ratio already mean, and
   * nothing is ever re-added.
   *
   * ⚠️ A customer is counted ONCE, in a single currency — the one carrying most of its
   * recurring revenue. So the per-currency rows sum to the number of distinct accounts, and
   * a converted read never divides by a headcount that does not exist.
   */
  {
    id: "customers_new",
    name: "New customers",
    description:
      "Accounts that started earning recurring revenue for the first time in the period. One count per account, however many subscriptions it opened. An existing account that opens a second one is expansion, not a new customer. Not additive: two periods cannot be added.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "customers_churned",
    name: "Churned customers",
    description:
      "Accounts whose recurring revenue fell to nothing in the period and was still nothing at the end of it. This is a lost account, not one that cancelled a single subscription. A pause is a suspension, not a departure. Not additive.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "customers_moved",
    name: "Customers with movement",
    description:
      "Accounts whose recurring revenue moved at all in the period: up, down, in or out. Not additive: an account that moved in two periods is one account across them.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "customer_churn_rate",
    halves: "count",
    name: "Customer churn rate",
    description:
      "The share of the accounts the period opened with that ended it earning nothing. This is logo churn, not subscription churn. In basis points. Numerator: those accounts lost. Denominator: the accounts there were to lose, so a book with none answers null rather than 0%. Not additive: a quarter is the quarter's own arithmetic and is stored separately.",
    kind: "flow",
    unit: "bps",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "active_customers",
    name: "Active customers",
    description:
      "Accounts that hold at least one live subscription at that instant. This is the customer grain of the active subscription count, on the same predicate. An account with three counts once.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "paying_customers",
    name: "Paying customers",
    description:
      "Accounts carrying recurring revenue at that instant. Fewer than the active count, which includes anything discounted to nothing. This is the headcount the per-customer revenue figures divide by.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "subscriptions_per_customer",
    name: "Subscriptions per customer",
    description:
      "Live subscriptions divided by the accounts that hold them. This is the factor between per-subscription and per-customer revenue. Both halves are read at the period's end.",
    kind: "stock",
    unit: "ratio",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "last", denominator: "last", denominatorUnit: "count" },
  },
  {
    id: "average_customer_lifetime",
    name: "Average customer lifetime",
    description:
      "How long an account lasted among those that had fully ended by the period's end. The life runs from the start of its first subscription to the cancellation of its last one. Numerator: that time, totaled, in MILLISECONDS. Denominator: how many accounts it covers. Divide for the average life, 2,592,000,000 to a thirty-day month. Null until an account has fully ended: a lifetime with no completed life in it is a guess.",
    kind: "stock",
    unit: "ratio",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: false,
    ratio: { numerator: "last", denominator: "last", denominatorUnit: "count" },
  },

  /**
   * ⚠️ THE FORWARD BOOK — six figures about what has been booked and has not happened yet,
   * and the only ones here that are BI-TEMPORAL.
   *
   * Every other measure answers "what was true in this period". These answer "what was
   * booked, as at the day this row was written, for some window ahead" — two time axes over
   * a table with one. The decision: `period_end` IS the as-of date. All six declare
   * `asOf: "computed_at"` and are written only for the period containing the run, so a past
   * period carries NO row. Because the writer runs daily, the day grain accumulates the
   * as-of history forward for free.
   *
   * The TARGET window is the `horizon` dimension — a closed set of six disjoint bands that
   * partition the forward book, so the slices sum to the unsliced figure.
   *
   * ⚠️ NO HISTORY AND NO COMPARISON. A backfill cannot reconstruct what was scheduled last
   * March: the schedule rows that have since applied are gone. `supportsCompare` is false on
   * all six, and a reader reports an unwritten period as unknown rather than as zero.
   *
   * ⚠️ THE MRR FIGURES ARE AN ESTIMATE, priced once when the change was booked — gross of
   * discounts, rated from the catalogue of that moment, never restated if the subscription
   * or the catalogue moves before it lands. Each description says so.
   */
  {
    id: "scheduled_upgrade_mrr",
    name: "Scheduled upgrade revenue",
    description:
      "Recurring revenue from plan changes already booked to take effect, as the book stands right now. An estimate taken when the change was scheduled: gross of discounts, and not restated if the catalog moves before it lands. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "scheduled_downgrade_mrr",
    name: "Scheduled downgrade revenue",
    description:
      "Recurring revenue already booked to be lost to plan changes, stated as a positive amount. The same estimate and the same limits as the upgrade figure. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "scheduled_upgrades",
    name: "Scheduled upgrades",
    description:
      "Plan changes booked to move a subscription up, counted as the book stands right now. One count per booked change, so a subscription with two of them counts twice. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "scheduled_downgrades",
    name: "Scheduled downgrades",
    description:
      "Plan changes booked to move a subscription down, counted as the book stands right now. One count per booked change. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "scheduled_cancellation_mrr",
    name: "Scheduled cancellation revenue",
    description:
      "Recurring revenue on subscriptions already booked to stop and still running. Committed revenue excludes this revenue and monthly recurring revenue still includes it. Read from the subscription's own cancellation, not from the schedule table. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "scheduled_cancellations",
    name: "Scheduled cancellations",
    description:
      "Subscriptions booked to stop that have not stopped yet, counted as the book stands right now. One already gone is churn and is counted there instead. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "trials_ending",
    name: "Trials ending",
    description:
      "Trials still running whose end date is ahead, banded by how far away it is. This is the forward view of the trial book. A trial with no end on file is running but is not ending, so it is not counted here. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "expected_renewal_cash",
    name: "Expected renewal cash",
    description:
      "What the book will bill at its renewal boundaries in the next 90 days, banded by how far away each charge is. Every charge counts, so a weekly plan contributes each renewal in the window. A trial's first charge is its conversion. Valued at one period's recurring amount net of every discount spanning more than one period, before tax and usage. Excludes cancelled and paused subscriptions, charges at or after a booked cancellation, and charges past the last committed cycle. A booked plan change is valued at the current rate. A boundary already passed that has not been billed yet is `overdue`. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },
  {
    id: "expected_renewals",
    name: "Expected renewals",
    description:
      "How many renewal charges the book will raise in the next 90 days. This is the count behind expected renewal cash, banded the same way. Counts charges, not subscriptions: a weekly plan counts once per renewal in the window. A charge of zero is not counted. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "count",
    aggregate: "last",
    dimensions: ["horizon", "currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "scheduled",
    asOf: "computed_at",
    supportsCompare: false,
  },

  /**
   * ── HEADLINE SAAS FIGURES ───────────────────────────────────────────────────────────
   * Run rate, net movement, trial conversion, subscription churn, reactivation and revenue
   * at risk. Each is arithmetic over facts a group above already reads, and each follows
   * its siblings' storage rule — none of them owns a new source.
   */
  {
    id: "arr",
    name: "Annual recurring revenue",
    description:
      "Monthly recurring revenue times twelve. This is what the live book would bill over a year at the rate it holds at the requested instant. A run rate, not a forecast: nothing booked to change is anticipated. Sliced, dated and converted exactly as monthly recurring revenue is, and never summed across currencies.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    // Must stay identical to `mrr`'s: ARR is written off the same snapshot rows.
    dimensions: [
      "plan",
      "plan_at_start",
      "country",
      "region",
      "billing_interval",
      "signup_cohort",
      "currency",
      "business",
    ],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "stocks",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "net_new_mrr",
    name: "Net new MRR",
    description:
      "Recurring revenue gained less recurring revenue lost across the window: new, expansion and reactivation, less contraction and churn. A pause counts as a loss and its resumption as a gain. So the figure is exactly how far monthly recurring revenue moved between the first and last instant of the window. Negative when the book shrank.",
    kind: "flow",
    unit: "money",
    aggregate: "sum",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "gross_mrr_churn_rate",
    name: "Gross MRR churn rate",
    description:
      "Recurring revenue lost to cancellation and contraction across the window, as a share of the recurring revenue the window opened with. In basis points, where 10,000 is 100%. Expansion never offsets it, and a pause is not churn so is not in it. Losses on subscriptions that started inside the window count too, so a book that grew and shrank fast can read above 10,000. Null when the window opened with no recurring revenue.",
    kind: "flow",
    unit: "bps",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    // Losses are a flow; the base is the stock the window opened with — the growth rate's fold.
    ratio: { numerator: "sum", denominator: "opening", denominatorUnit: "money" },
  },
  {
    id: "trial_conversion_rate",
    name: "Trial conversion rate",
    description:
      "Trials that converted to paid in the window, over trials that ended in the window by conversion, by cancellation or by expiry. In basis points. A trial ends at the earliest of its end date, its conversion and its cancellation. We date each half by its own event. So a trial that lapses in one period and converts in a later one lifts the later period. That period can then read above 10,000. Null when no trial ended.",
    kind: "flow",
    unit: "bps",
    aggregate: "ratio",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
    ratio: { numerator: "sum", denominator: "sum", denominatorUnit: "count" },
  },
  {
    id: "subscriber_churn_rate",
    halves: "count",
    name: "Subscriber churn rate",
    description:
      "Subscriptions that stopped in the window, as a share of those there were to lose. That base is the subscriptions live when the window opened plus those that started inside it. In basis points. Subscription churn, not account churn. An account that cancels one of three subscriptions counts here. A trial is not a subscriber until it converts, so a trial cancelled before converting is in neither half. Not additive: the base is an opening stock plus a flow, so each grain is computed and stored on its own.",
    kind: "flow",
    unit: "bps",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "derived",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "customers_reactivated",
    name: "Reactivated customers",
    description:
      "Accounts that had churned and started earning recurring revenue again in the period. Such an account earned nothing when the period opened, after a cancellation, and earned something at some point inside it. One count per account, however many subscriptions came back. An account returning from a pause alone was never lost and is not counted. Not additive.",
    kind: "flow",
    unit: "count",
    aggregate: "none",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "customer_grain",
    asOf: "period_end",
    supportsCompare: true,
  },
  {
    id: "mrr_at_risk",
    name: "MRR at risk",
    description:
      "Monthly recurring revenue on subscriptions with an unpaid invoice in collections right now, with retries scheduled or the chase paused. These are the same subscriptions that the dunning count counts. Each one at its current rate, once, however many invoices it owes. ⚠️ No history: only the period in progress carries a figure.",
    kind: "stock",
    unit: "money",
    aggregate: "last",
    dimensions: ["currency", "business"],
    grains: ALL_GRAINS,
    currency: "per_currency",
    source: "invoices",
    asOf: "computed_at",
    supportsCompare: false,
  },
];

const BY_ID = new Map(MEASURES.map((m) => [m.id, m]));

export function measureById(id: string): MeasureDef | undefined {
  return BY_ID.get(id);
}

/**
 * DIVIDE A STORED RATIO — the one place the quotient is ever formed.
 *
 * Returns null when there is nothing to divide by. A zero denominator is not a ratio of
 * zero: no revenue opened the period, nothing churned, nobody was paying — the question has
 * no answer, and 0, Infinity and NaN are three different lies about it.
 *
 * The answer is in the measure's DECLARED unit: basis points for a rate, minor units for
 * money, the bare quotient for a ratio. A caller never has to guess a scale.
 */
export function ratioValue(
  m: MeasureDef,
  value: bigint | number | null,
  denominator: bigint | number | null,
): number | null {
  /**
   * A STORED DENOMINATOR IS WHAT MAKES A ROW A QUOTIENT — not the `aggregate` field, which
   * says only how the row FOLDS. The two came apart when the customer grain arrived: a churn
   * rate is a quotient that cannot be folded at all, so it is computed per grain and still
   * has to be divided here. Keying on the denominator keeps one rule for both.
   */
  if (denominator == null) return value == null ? null : Number(value);
  if (value == null) return null;
  const den = Number(denominator);
  if (den === 0) return null;
  const q = Number(value) / den;
  if (!Number.isFinite(q)) return null;
  if (m.unit === "bps") return Math.round(q * 10_000);
  if (m.unit === "money" || m.unit === "count") return Math.round(q);
  return q;
}

/** Whether a measure can legally be cut by a dimension — the check behind the 422. */
export function supportsDimension(m: MeasureDef, dim: string): boolean {
  return (m.dimensions as readonly string[]).includes(dim);
}
