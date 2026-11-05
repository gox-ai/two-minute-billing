// Pure, client-safe rules and decimal helpers for meters and meter prices.
// Decimals stay strings end to end: a rate like $3 per 1M tokens is 0.0003 minor units
// per token, which a float cannot carry exactly.
import { currencyExponent } from "./money";

export const METER_AGGREGATIONS = [
  "sum",
  "count",
  "min",
  "max",
  "avg",
  "last",
  "unique",
  "weighted_sum",
] as const;
export type MeterAggregation = (typeof METER_AGGREGATIONS)[number];

const LABEL: Record<MeterAggregation, string> = {
  sum: "Sum",
  count: "Count of events",
  min: "Minimum",
  max: "Maximum",
  avg: "Average",
  last: "Last value",
  unique: "Unique values",
  weighted_sum: "Time-weighted sum",
};

const HINT: Record<MeterAggregation, string> = {
  sum: "We add the value of each event in the period.",
  count: "We count the events in the period. Events need no value.",
  min: "We bill the lowest value in the period.",
  max: "We bill the highest value in the period.",
  avg: "We bill the total of the values divided by the number of events.",
  last: "We bill the value of the last event in the period.",
  unique: "We count the different values of one property.",
  weighted_sum:
    "Each event changes a level. We bill the level multiplied by the time that it stayed.",
};

export const meterAggregationLabel = (a: string) => LABEL[a as MeterAggregation] ?? a;
export const meterAggregationHint = (a: string) => HINT[a as MeterAggregation] ?? "";

/** Every aggregation except `count` reads a value property. */
export const needsValueProperty = (a: string) => a !== "count";
export const needsUniqueProperty = (a: string) => a === "unique";
/** The level can carry into the next period (design G1a § 3.1). */
export const canRecur = (a: string) => ["sum", "last", "max", "unique"].includes(a);

export const MAX_GROUP_BY = 5;
/** Properties a spend limit may name per meter (`meters_limit_dimensions_ck`). */
export const MAX_LIMIT_DIMENSIONS = 3;
export const MAX_USAGE_DECIMALS = 12;

/** The suggested meter for AI tokens (design § 3.1). */
export const AI_TOKENS_PRESET = {
  id: "ai_tokens",
  name: "AI tokens",
  event_name: "ai_tokens",
  aggregation: "sum" as MeterAggregation,
  value_property: "tokens",
  group_by: ["model", "token_type"],
};

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PROPERTY = /^[A-Za-z0-9_.-]{1,100}$/;
export const isSlug = (s: string) => SLUG.test(s);
export const isPropertyName = (s: string) => PROPERTY.test(s);

// ── Decimal strings ────────────────────────────────────────────────────────────

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Shift a non-negative decimal string by `places` (positive = multiply by 10^places). */
export function shiftDecimal(s: string, places: number): string | null {
  const m = DECIMAL.exec(s.trim());
  if (!m) return null;
  let int = m[1] ?? "0";
  let frac = m[2] ?? "";
  if (places >= 0) {
    frac = frac.padEnd(places, "0");
    int += frac.slice(0, places);
    frac = frac.slice(places);
  } else {
    const p = -places;
    int = int.padStart(p + 1, "0");
    frac = int.slice(int.length - p) + frac;
    int = int.slice(0, int.length - p);
  }
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/** Decimal places in a decimal string, or null when it does not parse. */
export function decimalPlaces(s: string): number | null {
  const m = DECIMAL.exec(s.trim());
  return m ? (m[2]?.replace(/0+$/, "").length ?? 0) : null;
}

/**
 * A rate typed in MAJOR units → the API's `unit_amount_decimal` in MINOR units.
 * "3" USD → "300". Null when it does not parse or has more than 12 places in minor units.
 */
export function majorRateToMinor(major: string, currency: string): string | null {
  const minor = shiftDecimal(major, currencyExponent(currency));
  if (minor == null) return null;
  const dp = decimalPlaces(minor);
  return dp != null && dp <= MAX_USAGE_DECIMALS ? minor : null;
}

/** `unit_amount_decimal` (minor units) → the major-unit string an input shows. */
export function minorRateToMajor(minor: string | null | undefined, currency: string): string {
  if (minor == null || minor === "") return "";
  return shiftDecimal(minor, -currencyExponent(currency)) ?? "";
}

type ExactFormat = (value: string) => string;
const exact =
  (f: Intl.NumberFormat): ExactFormat =>
  (v) =>
    (f.format as unknown as ExactFormat)(v);

/** A decimal quantity for display: "1234567.000000000000" → "1,234,567". */
export function formatDecimalQuantity(q: string | number | null | undefined): string {
  if (q == null || q === "") return "—";
  const s = String(q);
  if (!DECIMAL.test(s.replace(/^-/, ""))) return s;
  return exact(new Intl.NumberFormat("en-US", { maximumFractionDigits: MAX_USAGE_DECIMALS }))(s);
}

/** A minor-unit decimal rate as money, keeping every significant place: "0.0003" USD → "$0.000003". */
export function formatMinorRate(
  minor: string | number | null | undefined,
  currency: string,
): string {
  if (minor == null || minor === "") return "—";
  const neg = String(minor).startsWith("-");
  const major = shiftDecimal(String(minor).replace(/^-/, ""), -currencyExponent(currency));
  if (major == null) return String(minor);
  const exp = currencyExponent(currency);
  try {
    const f = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: exp,
      maximumFractionDigits: exp + MAX_USAGE_DECIMALS,
    });
    return exact(f)(neg ? `-${major}` : major);
  } catch {
    return `${neg ? "-" : ""}${major} ${currency}`;
  }
}

/** The "per" choices of a rate card. */
export const DIVISORS = [
  { value: "1", label: "Per unit" },
  { value: "1000", label: "Per 1K units" },
  { value: "1000000", label: "Per 1M units" },
  { value: "custom", label: "Per a custom number of units" },
] as const;

export function divisorChoice(divisor: string | number | null | undefined): string {
  const d = String(divisor ?? "1");
  return DIVISORS.some((x) => x.value === d) ? d : "custom";
}

export function divisorLabel(divisor: string | number | null | undefined): string {
  const d = Number(divisor ?? 1);
  if (d === 1) return "per unit";
  if (d === 1000) return "per 1K units";
  if (d === 1_000_000) return "per 1M units";
  return `per ${d.toLocaleString("en-US")} units`;
}

// ── Invoice lines ──────────────────────────────────────────────────────────────

/** A line's quantity: the decimal field, or the integer one on rows written before it. */
export function lineQuantity(l: { quantity: number; quantity_decimal?: string | null }): string {
  return formatDecimalQuantity(l.quantity_decimal ?? l.quantity);
}

/** A line's unit price: the decimal field, or the integer one on rows written before it. */
export function lineUnitPrice(
  l: { unit_amount_minor: number; unit_amount_decimal?: string | null },
  currency: string,
): string {
  return formatMinorRate(l.unit_amount_decimal ?? l.unit_amount_minor, currency);
}
