// Currency exponents and major↔minor conversion. No imports: this file is shared
// by client components, server components, server actions AND the root unit test
// (`test/unit/currency-exponent.test.ts` imports it by relative path).
//
// Why it exists: every money path in the dashboard used to hardcode `/100`, which
// silently mangles any currency that is not two-decimal. ¥1000 (already whole yen)
// rendered as ¥10.00, and a form that typed 1000 posted 100000 minor — a 100×
// error. `lib/format.ts` re-exports these three functions, so existing importers
// of `@/lib/format` keep working and there is exactly one implementation.

/**
 * ISO-4217 exponents that are NOT 2. The default is 2, so only the exceptions are
 * listed. An explicit table rather than `Intl.…resolvedOptions().maximumFractionDigits`
 * on purpose: Intl reads CLDR, whose currency digits are a *display* convention and
 * differ from ISO-4217 for a few codes (CLDR says 0 for MGA/MRU where ISO says 2).
 * Money must not depend on the runtime's locale data.
 */
const EXPONENT_0 = [
  // No minor unit at all — the amount IS the integer.
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
] as const

const EXPONENT_3 = [
  // Thousandths: 1 KWD = 1000 fils.
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
] as const

const EXPONENT_4 = [
  // Funds/index units quoted to four places.
  'CLF', 'UYW',
] as const

const EXPONENTS: Record<string, number> = Object.fromEntries([
  ...EXPONENT_0.map((c) => [c, 0] as const),
  ...EXPONENT_3.map((c) => [c, 3] as const),
  ...EXPONENT_4.map((c) => [c, 4] as const),
])

/** The exponent used for any currency not in the table (USD, EUR, INR, …). */
export const DEFAULT_CURRENCY_EXPONENT = 2

/**
 * How many decimal places a currency has, so 1 major unit = 10^exponent minor
 * units. 2 for USD/EUR/INR, **0** for JPY/KRW/VND, 3 for KWD/BHD, 4 for CLF.
 * An unknown or malformed code falls back to 2 — the same assumption every call
 * site made before this helper existed, so nothing regresses on bad input.
 */
export function currencyExponent(currency: string | null | undefined): number {
  if (!currency) return DEFAULT_CURRENCY_EXPONENT
  return EXPONENTS[currency.trim().toUpperCase()] ?? DEFAULT_CURRENCY_EXPONENT
}

/** 1 major unit expressed in minor units: 100 for USD, 1 for JPY, 1000 for KWD. */
export function minorPerMajor(currency: string | null | undefined): number {
  return 10 ** currencyExponent(currency)
}

/**
 * Major units as typed by a human → integer minor units. `1642.00` INR → `164200`;
 * `1642` JPY → `1642`. Rounded, never truncated, so `0.07 * 100 = 7.000000000000001`
 * cannot post 7.000000000000001 to an integer column.
 */
export function toMinor(major: number, currency: string | null | undefined): number {
  return Math.round(major * minorPerMajor(currency))
}

/** Integer minor units → major units for display/editing. `164200` INR → `1642`. */
export function toMajor(minor: number, currency: string | null | undefined): number {
  return minor / minorPerMajor(currency)
}

/**
 * Minor units → the string a major-unit input should show: fixed to the currency's
 * exponent so an editable field never shows `1642` where the operator expects
 * `1642.00`, nor `1642.00` for a zero-decimal currency.
 */
export function toMajorInput(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor == null) return ''
  return toMajor(minor, currency).toFixed(currencyExponent(currency))
}

/**
 * The `step` a major-unit `<input type="number">` should use: one minor unit.
 * `1` for JPY, `0.01` for USD, `0.001` for KWD. This is what stops an operator
 * entering an amount finer than the currency can represent — `toMinor` would
 * round it and the posted value would not match what they typed.
 */
export function majorStep(currency: string | null | undefined): string {
  const exponent = currencyExponent(currency)
  return exponent === 0 ? '1' : `0.${'0'.repeat(exponent - 1)}1`
}
