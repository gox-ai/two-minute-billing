// Pure, client-safe: does a QUANTITY mean anything for a given price model?
// Kept out of `lib/api` (which drags `node:crypto` in) so client components can
// import it — same reasoning as `lib/differential.ts`.

/** The subset of a Price this rule reads. */
export interface QuantityRelevantPrice {
  model: string;
  usage_aggregation?: string | null;
  /** The API's own verdict (`isMeteredPrice`). Read first; the model rule is the fallback. */
  metered?: boolean;
}

/**
 * Mirrors the engine's `quantityInvariant` in `src/modules/subscriptions/service.ts`,
 * which THROWS on `quantity !== 1`:
 *
 *   `quantity must be 1 for flat price price_… (quantity applies only to
 *    per-unit/tiered/volume/package items)`
 *
 *  - `flat` rates as `amountMinor` and ignores quantity outright
 *    (`computeLineAmount` in src/modules/catalog/pricing.ts).
 *  - a USAGE-aggregated `percentage` takes its base from metered usage, so a
 *    quantity there is meaningless too. A non-usage `percentage` is the odd one
 *    out and DOES read quantity — as the monetary base it takes a cut of — so it
 *    stays true here.
 *
 * Keep the two in step: relaxing the engine's invariant without relaxing this
 * hides a field that would now work; tightening it without tightening this ships
 * a field that 400s on submit.
 */
export function quantityAppliesToPrice(price: QuantityRelevantPrice): boolean {
  if (price.model === "flat") return false;
  // A metered tier, package or percentage price takes quantity 1; `usage` ignores it.
  if (price.metered != null) return !(price.metered && price.model !== "usage");
  if (
    (price.model === "percentage" || price.model === "graduated_percentage") &&
    price.usage_aggregation != null
  )
    return false;
  return true;
}

/**
 * Per-PRODUCT verdict, for screens that configure an item rather than a price.
 * A product can hold several prices; quantity is offered when ANY of them
 * reads one, because the attach config is shared across all of them. A product with
 * NO price yet returns true — we cannot know, and only `flat` is actually refused,
 * so erring towards showing the field beats hiding one that works.
 */
export function quantityAppliesByProduct(
  prices: Array<{ product: string } & QuantityRelevantPrice>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const p of prices) {
    out[p.product] = (out[p.product] ?? false) || quantityAppliesToPrice(p);
  }
  return out;
}
