// Pure, client-safe cadence helpers — the browser-side mirror of
// `cadenceMultiple` / `alignSnapshotToCycle` (src/modules/catalog/pricing.ts).
//
// Deliberately duplicated, in the same spirit as `addUtcInterval` mirroring the
// engine's `addInterval`: the ENGINE stays authoritative (it refuses a bad cadence
// and does the real scaling), and this copy exists only so the form can filter the
// price picker and preview the scaled rate instead of letting the operator build a
// subscription the confirm will reject. Keep the two in step — if you change the
// rule there, change it here.

/** Cadence units that convert exactly among themselves; the families never mix. */
const MONTH_UNITS: Record<string, number> = { month: 1, year: 12 }
const DAY_UNITS: Record<string, number> = { day: 1, week: 7 }

/** Models whose single amount can be scaled — mirrors `OVERRIDABLE_MODELS`. */
const SCALABLE_MODELS = new Set(['flat', 'per_unit'])

/**
 * How many times an item's billing period fits into the subscription's cycle, or
 * null when it does not divide it exactly. A monthly item on a yearly cycle → 12;
 * a yearly item on a monthly cycle → null (it bills LESS often than the cycle,
 * which the engine refuses).
 */
export function cadenceMultiple(
  cycle: { interval: string | null; interval_count?: number | null },
  item: { interval: string | null; interval_count?: number | null },
): number | null {
  const cycleInterval = cycle.interval ?? 'month'
  const cycleCount = cycle.interval_count ?? 1
  const itemInterval = item.interval ?? 'month'
  const itemCount = item.interval_count ?? 1
  if (cycleCount <= 0 || itemCount <= 0) return null
  for (const units of [MONTH_UNITS, DAY_UNITS]) {
    const cycleUnit = units[cycleInterval]
    const itemUnit = units[itemInterval]
    if (cycleUnit == null || itemUnit == null) continue
    const cycleSpan = cycleUnit * cycleCount
    const itemSpan = itemUnit * itemCount
    if (itemSpan <= 0 || cycleSpan % itemSpan !== 0) return null
    return cycleSpan / itemSpan
  }
  return null
}

/**
 * Whether a non-plan price may sit on a subscription whose cycle the plan sets.
 * Exact match always; a shorter cadence only when it divides the cycle AND the
 * model carries one scalable amount (a tier table has no unambiguous ×N).
 */
export function cadenceCompatible(
  cycle: { interval: string | null; interval_count?: number | null },
  item: { interval: string | null; interval_count?: number | null; model: string; type: string },
): boolean {
  if (item.type !== 'recurring') return true // one-time fees carry no cadence
  const multiple = cadenceMultiple(cycle, item)
  if (multiple == null) return false
  return multiple === 1 || SCALABLE_MODELS.has(item.model)
}
