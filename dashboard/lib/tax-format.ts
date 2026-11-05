import type { TaxRateComponent, TaxTreatment } from '@/lib/api'

/**
 * Shared tax formatting + component arithmetic. Lives outside the components so the
 * region list, the region detail page and the customer form all derive the same
 * numbers from the same rules — a second copy is how "18%" and "9% + 9%" drift apart.
 */

export const REGIME_LABEL: Record<'gst' | 'vat' | 'sales_tax' | 'flat', string> = {
  gst: 'GST (place of supply)',
  vat: 'VAT',
  sales_tax: 'Sales tax',
  flat: 'Flat rate',
}

/** Basis points → a percent string. 900 → "9%", 825 → "8.25%". */
export function pct(bps: number): string {
  const n = bps / 100
  // Trim trailing zeros so 9.00% reads as 9% but 8.25% keeps both decimals.
  return `${Number(n.toFixed(2))}%`
}

/** Percent input value for a form field: 900 → "9". */
export function pctValue(bps: number): string {
  return String(Number((bps / 100).toFixed(2)))
}

/** Components for one state scope — null = the region's default vector. */
const scoped = (components: TaxRateComponent[], stateCode: string | null) =>
  components.filter((c) => (c.state_code ?? null) === stateCode)

/** The default (non-state-override) vector. */
export function defaultVector(components: TaxRateComponent[]): TaxRateComponent[] {
  return scoped(components, null)
}

/** Every state that has its own override vector. */
export function overriddenStates(components: TaxRateComponent[]): string[] {
  return [...new Set(components.map((c) => c.state_code).filter((s): s is string => !!s))].sort()
}

/** Σ rates that apply to an INTRA-state supply (CGST + SGST + Cess). */
export function intraTotalBps(components: TaxRateComponent[], stateCode: string | null = null): number {
  return scoped(components, stateCode)
    .filter((c) => c.applies_to === 'intra' || c.applies_to === 'both')
    .reduce((s, c) => s + c.rate_bps, 0)
}

/** Σ rates that apply to an INTER-state supply (IGST + Cess). */
export function interTotalBps(components: TaxRateComponent[], stateCode: string | null = null): number {
  return scoped(components, stateCode)
    .filter((c) => c.applies_to === 'inter' || c.applies_to === 'both')
    .reduce((s, c) => s + c.rate_bps, 0)
}

/** One named component's rate in a scope, or 0 when absent. */
export function componentBps(components: TaxRateComponent[], stateCode: string | null, name: string): number {
  return scoped(components, stateCode).find((c) => c.name === name)?.rate_bps ?? 0
}

/** Human labels for `customers.tax_treatment`. */
export const TREATMENT_LABEL: Record<TaxTreatment, string> = {
  default: 'Standard — resolve from place of supply',
  sez_igst: 'SEZ — with payment of IGST',
  sez_zero_rated: 'SEZ — zero-rated',
  export_igst: 'Export — with payment of IGST',
  export_zero_rated: 'Export — zero-rated',
  reverse_charge: 'Reverse charge — buyer accounts for tax',
}

/** Short label for a chip or table cell. */
export const TREATMENT_SHORT: Record<TaxTreatment, string> = {
  default: 'Standard',
  sez_igst: 'SEZ (IGST)',
  sez_zero_rated: 'SEZ (zero-rated)',
  export_igst: 'Export (IGST)',
  export_zero_rated: 'Export (zero-rated)',
  reverse_charge: 'Reverse charge',
}
