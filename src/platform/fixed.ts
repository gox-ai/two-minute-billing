/**
 * Fixed12: an exact decimal held as a bigint scaled by 10^12. Used for usage quantities and
 * sub-cent rates. Money still leaves here as integer minor units, rounded half-up once.
 * Pure, no dependency.
 */

/** The most decimal places a usage value, rate or amount may carry. */
export const MAX_USAGE_DECIMALS = 12;

export const FIXED12_SCALE = 10n ** BigInt(MAX_USAGE_DECIMALS);

/**
 * The largest magnitude one money amount (minor units) or one usage quantity may take:
 * 10^12. `LIMITS.amountMinor` at the API boundary is this same number.
 */
export const MAX_AMOUNT_MAGNITUDE = 1_000_000_000_000;
const MAX_MAGNITUDE_FIXED12 = BigInt(MAX_AMOUNT_MAGNITUDE) * FIXED12_SCALE;

/** True when a Fixed12 value lies within ±`MAX_AMOUNT_MAGNITUDE`. */
export const withinMaxMagnitude = (v: bigint) =>
  v <= MAX_MAGNITUDE_FIXED12 && v >= -MAX_MAGNITUDE_FIXED12;

export class FixedParseError extends Error {
  constructor(
    readonly input: string,
    readonly reason: "invalid" | "too_many_decimals",
  ) {
    super(
      reason === "too_many_decimals"
        ? `"${input}" has more than ${MAX_USAGE_DECIMALS} decimal places`
        : `"${input}" is not a decimal number`,
    );
    this.name = "FixedParseError";
  }
}

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Strict parse: optional `-`, digits, optional `.digits`. No exponent, no `+`, no bare `.`,
 * no whitespace. More than 12 decimal places throws (never truncated).
 */
export function parseFixed12(s: string): bigint {
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new FixedParseError(s, "invalid");
  const frac = m[3] ?? "";
  if (frac.length > MAX_USAGE_DECIMALS) throw new FixedParseError(s, "too_many_decimals");
  const v = BigInt(m[2]!) * FIXED12_SCALE + BigInt(frac.padEnd(MAX_USAGE_DECIMALS, "0") || "0");
  return m[1] === "-" ? -v : v;
}

/** `parseFixed12` that returns null instead of throwing. */
export function tryParseFixed12(s: string): bigint | null {
  try {
    return parseFixed12(s);
  } catch {
    return null;
  }
}

/**
 * Parse a Postgres `numeric` text (any scale, no exponent), rounding half-up to 12 dp. For
 * values the database derived (sums, averages), not for input.
 */
export function fixed12FromNumeric(s: string | number | bigint | null | undefined): bigint {
  if (s == null) return 0n;
  if (typeof s === "bigint") return s * FIXED12_SCALE;
  const text = typeof s === "number" ? numberToPlain(s) : s.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new FixedParseError(text, "invalid");
  const frac = m[3] ?? "";
  const intPart = BigInt(m[2]!);
  let v: bigint;
  if (frac.length <= MAX_USAGE_DECIMALS) {
    v = intPart * FIXED12_SCALE + BigInt(frac.padEnd(MAX_USAGE_DECIMALS, "0") || "0");
  } else {
    const all = BigInt(m[2]! + frac);
    v = divHalfUp(all, 10n ** BigInt(frac.length - MAX_USAGE_DECIMALS));
  }
  return m[1] === "-" ? -v : v;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new FixedParseError(String(n), "invalid");
  if (Number.isInteger(n)) return BigInt(n).toString();
  return n.toFixed(MAX_USAGE_DECIMALS);
}

/** Canonical text: no trailing zeros, no trailing dot. `370370100000000n` → "370.3701". */
export function formatFixed12(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const int = abs / FIXED12_SCALE;
  const frac = (abs % FIXED12_SCALE)
    .toString()
    .padStart(MAX_USAGE_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Integer → Fixed12. */
export function fixed12FromInt(n: bigint | number): bigint {
  return BigInt(n) * FIXED12_SCALE;
}

/** n ÷ d rounded half away from zero. d must be non-zero. */
export function divHalfUp(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = (abs * 2n + d) / (2n * d);
  return neg ? -q : q;
}

/** a × b ÷ d, rounded half away from zero once, with no intermediate rounding. */
export function mulDivHalfUp(a: bigint, b: bigint, d: bigint): bigint {
  return divHalfUp(a * b, d);
}

/** Fixed12 × Fixed12 → Fixed12 (rounded half-up at 12 dp). */
export function mulFixed12(a: bigint, b: bigint): bigint {
  return mulDivHalfUp(a, b, FIXED12_SCALE);
}

/** Fixed12 → integer, half-up. */
export function roundFixed12(v: bigint): bigint {
  return divHalfUp(v, FIXED12_SCALE);
}

/** Fixed12 ÷ Fixed12 → Fixed12 (rounded half-up at 12 dp). */
export function divFixed12(a: bigint, b: bigint): bigint {
  return mulDivHalfUp(a, FIXED12_SCALE, b);
}

/** Major-unit Fixed12 → minor-unit Fixed12 for a currency exponent (exact). */
export function majorToMinorFixed12(major: bigint, exponent: number): bigint {
  return major * 10n ** BigInt(exponent);
}
