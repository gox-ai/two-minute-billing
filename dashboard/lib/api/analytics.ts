// Typed fetcher for the payments-analytics read. Read-only. SERVER-ONLY — it reaches
// `@/lib/api`, which forwards the signed-in operator's session to the engine.
//
// GET /v1/businesses/:biz/payments_analytics — the block behind the "Dashboard"
// tab on /transactions and /payment_intents. One request serves BOTH periods:
// every series headline carries `prev_value` + `change_bps`, and every breakdown
// row carries its previous-period twin, so a "this period vs previous" column
// never costs a second round trip.
//
// The range vocabulary and response types live in `./analytics-shape` so a client
// component can import them without dragging this module's server imports along.
// Re-exported here so server callers keep one import site.
import { apiGet } from '@/lib/api'
import type { PaymentsAnalytics, PaymentsAnalyticsRange } from './analytics-shape'

export * from './analytics-shape'

export function getPaymentsAnalytics(
  biz: string,
  opts: {
    range?: PaymentsAnalyticsRange
    /** `ALL` (the default) converts every currency; a code scopes money AND counts. */
    currency?: string
    gateway?: string
    payment_method?: string
  } = {},
) {
  const qs = new URLSearchParams()
  if (opts.range) qs.set('range', opts.range)
  if (opts.currency) qs.set('currency', opts.currency)
  if (opts.gateway) qs.set('gateway', opts.gateway)
  if (opts.payment_method) qs.set('payment_method', opts.payment_method)
  const q = qs.toString()
  return apiGet<PaymentsAnalytics>(`/v1/businesses/${biz}/payments_analytics${q ? `?${q}` : ''}`)
}
