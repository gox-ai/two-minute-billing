// Pure, client-safe labels and rules for a price's usage aggregation. Mirrors
// `src/modules/catalog/pricing.ts` (USAGE_AGGREGATIONS, RECURRING_AGGREGATIONS).

export const USAGE_AGGREGATIONS = [
  "sum",
  "max",
  "last",
  "count",
  "min",
  "avg",
  "unique",
  "weighted_sum",
] as const;

const LABEL: Record<string, string> = {
  sum: "Sum",
  max: "Maximum",
  last: "Last value",
  count: "Count of records",
  min: "Minimum",
  avg: "Average",
  unique: "Unique keys",
  weighted_sum: "Time-weighted sum",
};

export function aggregationLabel(a: string): string {
  return LABEL[a] ?? a;
}

/** Aggregations whose level can carry into the next period. */
export const RECURRING_AGGREGATIONS = new Set(["sum", "last", "max", "unique", "weighted_sum"]);

/** Models that bill recorded usage when they have an aggregation (`usage` always does). */
export const METERABLE_MODELS = new Set([
  "percentage",
  "graduated_percentage",
  "tiered",
  "volume",
  "stairstep",
  "package",
]);

/** The rows shown under a usage line, as the invoice PDF prints them. */
export function ratingRows(
  rating:
    | {
        quantity: number;
        free_quantity: number;
        /** Meter lines: numbers as decimal strings, `amount` unrounded minor units. */
        tiers: Array<{
          from: number | string;
          to: number | string | null;
          units: number | string;
          unit_amount_minor?: number;
          flat_amount_minor: number;
          amount_minor?: number;
          amount?: string;
        }>;
        level: { carried_in: number; closing: number; peak: number } | null;
        /** Meter lines (G1a § 3.9): the combination and the rate-card row that billed it. */
        meter?: string;
        group?: string[] | null;
        rate_match?: Record<string, string> | "default" | null;
        late_for?: { start: string; end: string } | null;
      }
    | null
    | undefined,
  fmt: (minor: number) => string,
): string[] {
  if (!rating) return [];
  const n = (v: number | string) => Number(v).toLocaleString("en-US");
  const rows = (rating.tiers ?? []).map((t) => {
    const range = t.to == null ? `${n(t.from)} and more` : `${n(t.from)} to ${n(t.to)}`;
    const parts = [
      ...(t.unit_amount_minor ? [`${n(t.units)} × ${fmt(t.unit_amount_minor)}`] : []),
      ...(t.flat_amount_minor ? [`${fmt(t.flat_amount_minor)} flat`] : []),
    ];
    const amount = t.amount_minor ?? Math.round(Number(t.amount ?? 0));
    return `Units ${range}: ${parts.join(" + ") || n(t.units)} = ${fmt(amount)}`;
  });
  if (rating.free_quantity > 0)
    rows.unshift(`Free units: ${n(Math.min(rating.free_quantity, rating.quantity))}`);
  if (rating.meter && rating.rate_match)
    rows.unshift(
      rating.rate_match === "default"
        ? "Rate: default"
        : `Rate: ${Object.entries(rating.rate_match)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")}`,
    );
  if (rating.level)
    rows.push(
      `Level at period start ${n(rating.level.carried_in)}, highest ${n(rating.level.peak)}, at period end ${n(rating.level.closing)}`,
    );
  return rows;
}
