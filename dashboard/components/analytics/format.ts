// Value formatting for the semantic-layer API (`lib/analytics-api.ts`), unit-aware.
// Distinct from `components/analytics/series-format.ts`, which formats the OLDER
// payments-analytics payload (`lib/api/analytics`) — different wire shape, same folder.
import { money, moneyCompact, countCompact, pctFromBps } from "@/lib/format";
import type { MeasureUnit } from "@/lib/analytics-api";

/**
 * A measure's value, full precision. `null` is "computed, and the answer is
 * nothing" — every branch returns "—" for it, never "0".
 */
export function measureValue(
  value: number | null,
  unit: MeasureUnit,
  currency: string | null,
  denominator?: number | null,
): string {
  if (value == null) return "—";
  switch (unit) {
    case "money":
      return money(Math.round(value), currency ?? "USD");
    case "bps":
      return pctFromBps(Math.round(value));
    case "ratio":
      // `value` over `denominator` — divided here, at read time, never by the engine.
      return denominator ? `${((value / denominator) * 100).toFixed(1)}%` : value.toFixed(2);
    case "count":
    default:
      return Math.round(value).toLocaleString("en");
  }
}

/** Compact form for a headline figure: money only, so a six-figure MRR never wraps. */
export function measureValueCompact(
  value: number | null,
  unit: MeasureUnit,
  currency: string | null,
  denominator?: number | null,
): string {
  if (value == null) return "—";
  if (unit === "money") return moneyCompact(Math.round(value), currency ?? "USD");
  return measureValue(value, unit, currency, denominator);
}

/** Axis-tick form: bare compact numbers, no currency symbol — the headline states it. */
export function measureAxisValue(value: number, unit: MeasureUnit): string {
  if (unit === "bps") return pctFromBps(Math.round(value), 1);
  if (unit === "count" || unit === "money") return countCompact(value);
  return value.toFixed(1);
}

/** What kind of chart axis this unit draws as — money/percent/count is all `AreaChart` knows. */
export function chartKindFor(unit: MeasureUnit): "money" | "count" | "percent" {
  if (unit === "money") return "money";
  if (unit === "bps") return "percent";
  return "count";
}
