// Pure, client-safe differential-pricing helpers. Kept out of `lib/api/subscriptions`
// (which imports `lib/api` and transitively `node:crypto`) so client components can
// import the value helper without dragging server-only code into the browser bundle.

/** One plan-specific override of an addon's price (flat/per-unit amount). */
export interface DifferentialRule {
  addon: string // addon PRODUCT id
  plan: string // plan PRODUCT id
  currency: string
  interval: string | null
  amount_minor: number | null
}

/**
 * Look up the plan-specific differential amount for an addon, if any. Prefers an
 * exact interval match, then an interval-agnostic row, then any currency match.
 * Returns null when no differential is configured (caller falls back to catalog).
 */
export function differentialAmount(
  diffs: DifferentialRule[],
  addonProductId: string | undefined,
  planProductId: string | undefined,
  currency: string,
  interval: string | null,
): number | null {
  if (!addonProductId || !planProductId) return null
  const rows = diffs.filter((d) => d.addon === addonProductId && d.plan === planProductId && d.currency === currency)
  const match = rows.find((d) => d.interval === interval) ?? rows.find((d) => d.interval == null) ?? rows[0]
  return match?.amount_minor ?? null
}
