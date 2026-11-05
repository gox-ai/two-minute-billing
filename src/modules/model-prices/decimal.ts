/**
 * Source prices are USD per unit as JSON decimal text; we store cents per unit as Fixed12
 * (`numeric(38,12)`). Digits are moved, never multiplied as floats: `0.29 × 100` in binary is
 * 28.999…, so a float path would bill a different price than the one published.
 */
import { divHalfUp, FIXED12_SCALE, MAX_USAGE_DECIMALS } from "@/platform/fixed";
import { expandExponent } from "@/modules/metering/json-source";

export class SourceDecimalError extends Error {
  constructor(readonly input: string) {
    super(`"${input}" is not a non-negative decimal`);
    this.name = "SourceDecimalError";
  }
}

const UNSIGNED_DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Major-unit decimal text (exponent allowed) → minor units as Fixed12, for a currency with
 * `exponent` minor digits. More than 12 decimals after the shift → half-up once, `rounded`.
 */
export function majorTextToMinorFixed12(
  text: string,
  exponent = 2,
): { value: bigint; rounded: boolean } {
  const plain = expandExponent(text.trim());
  const m = UNSIGNED_DECIMAL_RE.exec(plain);
  if (!m) throw new SourceDecimalError(text);
  const int = m[1]!;
  const frac = m[2] ?? "";
  // Shift the point `exponent` places right: major → minor.
  const minorInt = int + frac.slice(0, exponent).padEnd(exponent, "0");
  const minorFrac = frac.slice(exponent).replace(/0+$/, "");
  if (minorFrac.length <= MAX_USAGE_DECIMALS) {
    const value =
      BigInt(minorInt) * FIXED12_SCALE + BigInt(minorFrac.padEnd(MAX_USAGE_DECIMALS, "0") || "0");
    return { value, rounded: false };
  }
  const all = BigInt(minorInt + minorFrac);
  const value = divHalfUp(all, 10n ** BigInt(minorFrac.length - MAX_USAGE_DECIMALS));
  return { value, rounded: true };
}

/** Fixed12 as `numeric(38,12)` text, always 12 places ("29.000000000000"). */
export function numericText(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / FIXED12_SCALE;
  const frac = (abs % FIXED12_SCALE).toString().padStart(MAX_USAGE_DECIMALS, "0");
  return `${neg ? "-" : ""}${int}.${frac}`;
}
