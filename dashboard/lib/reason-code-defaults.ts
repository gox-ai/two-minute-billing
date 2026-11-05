/**
 * The cancellation reasons offered when a business has defined none of its own.
 *
 * MUST stay in sync with DEFAULT_CANCELLATION_REASONS in
 * `src/modules/reason-codes/service.ts` — the backend is the authority (it serves
 * them from `?offered=true`); this copy exists so the settings page can render
 * them greyed-out as "not configured" without a second round trip.
 */
export const DEFAULT_CANCELLATION_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'pricing_high', label: 'Pricing was high' },
  { code: 'pausing_will_return', label: 'Pausing, will come back' },
  { code: 'complicated_to_use', label: 'Complicated to use' },
  { code: 'product_has_issues', label: 'Product has issues' },
  { code: 'product_unsatisfactory', label: 'Product was unsatisfactory' },
  { code: 'trying_out', label: 'Was just trying out' },
  { code: 'other', label: 'Other' },
]
