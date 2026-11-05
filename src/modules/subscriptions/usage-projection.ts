/**
 * Projection maths for the current-usage view. Pure: no I/O, bigint only.
 *
 * A projection rates a projected QUANTITY, never a scaled amount: tiers, free units and
 * package rounding make the amount non-linear in the quantity.
 */

/** Below this share of the window elapsed, there is too little data to project. */
export const MIN_PROJECTION_ELAPSED_BPS = 1000n; // 10 %

export type ProjectionMethod = "linear" | "held_level";

/** Elapsed and total length of the window, in ms. Null when too little of it has passed. */
export function projectionSpan(
  window: { start: Date; end: Date },
  asOf: Date,
): { elapsedMs: bigint; lengthMs: bigint } | null {
  const lengthMs = BigInt(window.end.getTime() - window.start.getTime());
  if (lengthMs <= 0n) return null;
  let elapsedMs = BigInt(asOf.getTime() - window.start.getTime());
  if (elapsedMs > lengthMs) elapsedMs = lengthMs;
  if (elapsedMs * 10_000n < lengthMs * MIN_PROJECTION_ELAPSED_BPS) return null;
  return { elapsedMs, lengthMs };
}

/**
 * The quantity at window end. `additive` (a running total) extends linearly, rounded up.
 * `level` holds today's level (a lower bound for `unique`). `time_weighted` takes the
 * caller's full-window measurement, which holds the closing level to the end.
 */
export function projectQuantity(input: {
  growth: "additive" | "level" | "time_weighted";
  quantity: bigint;
  span: { elapsedMs: bigint; lengthMs: bigint };
  fullWindowQuantity?: bigint;
}): { quantity: bigint; method: ProjectionMethod } {
  const { quantity, span } = input;
  if (input.growth === "time_weighted")
    return { quantity: input.fullWindowQuantity ?? quantity, method: "held_level" };
  if (input.growth === "level" || quantity <= 0n || span.elapsedMs >= span.lengthMs)
    return { quantity, method: input.growth === "additive" ? "linear" : "held_level" };
  return {
    quantity: (quantity * span.lengthMs + span.elapsedMs - 1n) / span.elapsedMs,
    method: "linear",
  };
}
