// Cross-currency honesty for the organization screens, in one place.
//
// The engine converts money into the organization's base currency at READ time and publishes
// exactly what it did: `currency_basis`, the `rates` applied, and `missing_rates` — the
// currencies it had no rate for and therefore LEFT OUT. A screen that drops those three fields
// turns an excluded currency into a silent zero, which is the one thing this layer exists to
// prevent.

import type { AnalyticsResult, BatchEntry, SeriesPoint } from "@/lib/analytics-api";

/**
 * The published shape, with the three conversion fields the engine sends.
 *
 * `lib/analytics-api.ts` has not been widened for them yet and is owned elsewhere, so the
 * fields are declared here rather than invented at the call site. Nothing is computed — every
 * value below comes off the wire.
 */
export type ConvertedResult = Omit<AnalyticsResult, "currency_basis"> & {
  currency_basis: "per_currency" | "across_currencies" | "converted";
  /** `1 base = rate x other`, so an amount in `other` becomes `amount / rate`. */
  rates?: Record<string, number>;
  /** Currencies excluded from the total for want of a rate. Named, never counted as zero. */
  missing_rates?: string[];
};

/** Read an `AnalyticsResult` out of a batch reply, or `null` if that slot was refused. */
export function ok(entry: BatchEntry | undefined): ConvertedResult | null {
  return entry && entry.object === "analytics_result" ? (entry as ConvertedResult) : null;
}

/** One split row, as the engine returns it. */
export interface SplitRow {
  key: string;
  label: string;
  total: number | null;
  points: SeriesPoint[];
}

/** Every split row of a result, keyed — `other` dropped, since it names no business. */
export function splitByKey(r: ConvertedResult | null): Map<string, SplitRow> {
  const out = new Map<string, SplitRow>();
  for (const row of r?.split?.series ?? []) {
    // Only real dimension values. A residual row (truncated or unattributed) is not a
    // business, a plan or a country, and must not be keyed as though it were.
    if ((row.kind ?? "dimension") === "dimension") out.set(row.key, row);
  }
  return out;
}

/**
 * The change across a stock's own window, in basis points.
 *
 * A split row carries points but no `compare` block — the engine computes a comparison for the
 * whole answer, not per row — so the movement over the window is read off the row's FIRST and
 * LAST measured points. Null wherever that subtraction would be a fiction: no start value, or
 * a start of zero (every increase from nothing is infinite, not a percentage).
 */
export function windowChangeBps(points: readonly SeriesPoint[]): number | null {
  const measured = points.filter((p) => p.value != null);
  if (measured.length < 2) return null;
  const first = measured[0]!.value!;
  const last = measured[measured.length - 1]!.value!;
  if (first === 0) return null;
  return Math.round(((last - first) / Math.abs(first)) * 10_000);
}

/**
 * Which businesses a converted total had to leave out, named.
 *
 * `missing_rates` names CURRENCIES; an operator reads businesses. A business is excluded when
 * every currency it bills in is one the roll-up could not convert — so a business that also
 * bills in a convertible currency is counted (in part) and is not named here.
 */
export function excludedBusinesses<
  T extends {
    id: string;
    name: string;
    default_currency: string | null;
    currencies?: string[] | null;
  },
>(businesses: readonly T[], missingRates: readonly string[]): T[] {
  if (missingRates.length === 0) return [];
  const missing = new Set(missingRates.map((c) => c.toUpperCase()));
  return businesses.filter((b) => {
    const ccys = (b.currencies?.length ? b.currencies : [b.default_currency]).filter(
      (c): c is string => !!c,
    );
    return ccys.length > 0 && ccys.every((c) => missing.has(c.toUpperCase()));
  });
}

/** The currencies an organization's businesses actually bill in, most common first. */
export function billedCurrencies<
  T extends { default_currency: string | null; currencies?: string[] | null },
>(businesses: readonly T[]): string[] {
  const counts = new Map<string, number>();
  for (const b of businesses) {
    for (const c of b.currencies?.length ? b.currencies : [b.default_currency]) {
      if (c) counts.set(c.toUpperCase(), (counts.get(c.toUpperCase()) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]))
    .map(([c]) => c);
}
