// The SHAPE of the payments-analytics read: the range vocabulary, its labels and
// the response types. Client-safe on purpose — it imports nothing but itself.
//
// Split out of `analytics.ts` because that module imports `@/lib/api` (the BFF's
// server-only fetcher, which reads the request's session cookie), and
// `payments-analytics-block.tsx` is a CLIENT component that needs the range
// constants at runtime. Importing them from the fetcher module pulled `next/headers`
// into the browser bundle and broke the build. Types alone were fine (erased at
// compile time); the two `const`s are not.
//
// Rule of thumb: anything a 'use client' file needs at RUNTIME belongs here, and
// anything that calls `apiGet` belongs in `analytics.ts`.


/**
 * The CALENDAR range vocabulary. Deliberately disjoint from `AnalyticsRange`
 * (`daily|3m|6m|12m`) on the Home dashboard — those are ROLLING windows and
 * answer a different question, so the two sets are not interchangeable. An
 * unknown value 400s server-side with the allowed set, so validate before
 * fetching rather than letting a hand-typed URL blank the page.
 */
export const PAYMENTS_ANALYTICS_RANGES = [
  'current_day',
  'yesterday',
  'this_week',
  'previous_week',
  'this_month',
  'last_month',
] as const
export type PaymentsAnalyticsRange = (typeof PAYMENTS_ANALYTICS_RANGES)[number]

/** Menu labels, matching the period labels the API returns for each range. */
export const PAYMENTS_ANALYTICS_RANGE_LABELS: Record<PaymentsAnalyticsRange, string> = {
  current_day: 'Current Day',
  yesterday: 'Yesterday',
  this_week: 'This Week',
  previous_week: 'Previous Week',
  this_month: 'This Month',
  last_month: 'Last Month',
}

export function isPaymentsAnalyticsRange(v: unknown): v is PaymentsAnalyticsRange {
  return typeof v === 'string' && (PAYMENTS_ANALYTICS_RANGES as readonly string[]).includes(v)
}

/**
 * `money` values are integer MINOR units — format with `money()`/`moneyCompact()`
 * and never divide by 100 by hand (the divisor is the currency's exponent).
 * `percent` values are BASIS POINTS — render with `pctFromBps()`.
 */
export type PaymentsSeriesKind = 'money' | 'count' | 'percent'

export interface PaymentsAnalyticsPoint {
  t: string
  label: string
  v: number
}

export interface PaymentsAnalyticsHeadline {
  kind: PaymentsSeriesKind
  value: number
  prev_value: number | null
  prev_label: string | null
  /** Change vs the previous period in basis points; null when there is no base. */
  change_bps: number | null
}

export interface PaymentsAnalyticsSeries {
  key: string
  label: string
  kind: PaymentsSeriesKind
  headline: PaymentsAnalyticsHeadline
  points: PaymentsAnalyticsPoint[]
}

/** Failures grouped by gateway error cause. Amounts are minor units. */
export interface PaymentsErrorDetailRow {
  error_code: string
  label: string
  count: number
  prev_count: number
  amount_minor: number
  prev_amount_minor: number
  /** Share of this period's failures, in basis points. */
  share_bps: number
}

/** One row of the payment-method / gateway breakdown. Amounts are minor units. */
export interface PaymentsDimensionRow {
  key: string
  label: string
  count: number
  prev_count: number
  amount_minor: number
  prev_amount_minor: number
  failed_count: number
  prev_failed_count: number
  /** Share of this period's transactions, in basis points. */
  share_bps: number
}

export interface PaymentsAnalyticsPeriod {
  label: string
  start: string
  end: string
}

export interface PaymentsAnalyticsOption {
  key: string
  label: string
}

export interface PaymentsAnalytics {
  object: 'business_payments_analytics'
  business: string
  as_of: string
  range: PaymentsAnalyticsRange
  timezone: string
  granularity: 'hour' | 'day'
  period: PaymentsAnalyticsPeriod
  previous_period: PaymentsAnalyticsPeriod
  /** The reporting currency every money figure is expressed in. */
  currency: string
  /** True when rows in other currencies were converted into `currency`. */
  converted: boolean
  available_currencies: string[]
  /**
   * Currencies with NO exchange rate. Their rows are excluded from both the money
   * and the counts, so a non-empty list means the figures omit real money and the
   * UI must say so rather than showing a total that quietly under-reports.
   */
  missing_rates: string[]
  filters: { gateway: string | null; payment_method: string | null }
  /**
   * The gateways / payment methods that actually occur IN THE SELECTED PERIOD —
   * so the menus shrink as the range narrows. A currently-selected value can
   * therefore be absent from its own option list; keep it in the menu anyway or
   * the control stops showing its own state.
   */
  options: { gateways: PaymentsAnalyticsOption[]; payment_methods: PaymentsAnalyticsOption[] }
  series: PaymentsAnalyticsSeries[]
  breakdowns: {
    error_details: PaymentsErrorDetailRow[]
    payment_methods: PaymentsDimensionRow[]
    gateways: PaymentsDimensionRow[]
  }
}
