/**
 * Credit unit conversion (design G3 §3.1). Pure.
 *
 * A grant's `amount` is an integer count of the unit's smallest step (10^-decimals of a unit).
 * The rate is minor units per WHOLE unit × 10^12. Money is the implicit unit: 1 minor per
 * step, 0 decimals.
 */

export interface CreditUnitRate {
  /** Minor units per whole unit × 10^12. */
  minorPerUnitE12: bigint;
  /** 0–4. */
  decimals: number;
}

export const E12 = 1_000_000_000_000n;
export const MONEY_RATE: CreditUnitRate = { minorPerUnitE12: E12, decimals: 0 };

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** round_half_up(n / d) for n ≥ 0, d > 0. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("divisor must be positive");
  if (n < 0n) return -divHalfUp(-n, d);
  return (2n * n + d) / (2n * d);
}

/** Money for `steps` of the unit: round_half_up(units × rate). */
export function faceMinorFor(steps: bigint, rate: CreditUnitRate): bigint {
  return divHalfUp(steps * rate.minorPerUnitE12, E12 * pow10(rate.decimals));
}

/** Steps of the unit worth `minor`: round_half_up(money ÷ rate), at the unit's precision. */
export function stepsForMinor(minor: bigint, rate: CreditUnitRate): bigint {
  return divHalfUp(minor * E12 * pow10(rate.decimals), rate.minorPerUnitE12);
}

/** "12.5" for 125 steps at 1 decimal. */
export function formatSteps(steps: bigint, decimals: number): string {
  if (decimals === 0) return steps.toString();
  const neg = steps < 0n;
  const abs = neg ? -steps : steps;
  const s = abs.toString().padStart(decimals + 1, "0");
  const out = `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/, "");
  return neg ? `-${out}` : out;
}

const DECIMAL_RE = /^\d{1,18}(\.\d{1,12})?$/;

/** Rate string ("0.01", "100") → minor per unit × 10^12. Null when malformed or ≤ 0. */
export function parseRateE12(rate: string): bigint | null {
  if (!DECIMAL_RE.test(rate)) return null;
  const [whole, frac = ""] = rate.split(".");
  const v = BigInt(whole!) * E12 + BigInt(frac.padEnd(12, "0"));
  return v > 0n ? v : null;
}

/** 10^12-scaled rate → decimal string with trailing zeros dropped. */
export function formatRateE12(e12: bigint): string {
  const whole = e12 / E12;
  const frac = (e12 % E12).toString().padStart(12, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
