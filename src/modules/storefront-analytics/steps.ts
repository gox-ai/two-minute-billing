export type StorefrontSurface = "checkout" | "portal";

/** The keys a beacon may report time for. Anything else is refused at the route. */
export const CHECKOUT_STEPS = ["details", "confirm", "card", "pay", "done"] as const;
export const PORTAL_SECTIONS = ["plan", "invoices", "methods", "details"] as const;

/** One beacon reports at most this much time per key; a tab left open is not engagement. */
export const MAX_STEP_MS_PER_BEACON = 30 * 60 * 1000;
/** A row's time for one key stops growing here. */
export const MAX_STEP_MS_TOTAL = 6 * 60 * 60 * 1000;

/** Known keys only, whole milliseconds, each capped per beacon. */
export function clampSteps(
  surface: StorefrontSurface,
  steps: Record<string, number>,
): Record<string, number> {
  const allowed: readonly string[] = surface === "checkout" ? CHECKOUT_STEPS : PORTAL_SECTIONS;
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(steps)) {
    if (!allowed.includes(k) || !Number.isFinite(raw)) continue;
    const ms = Math.min(Math.max(Math.round(raw), 0), MAX_STEP_MS_PER_BEACON);
    if (ms > 0) out[k] = ms;
  }
  return out;
}
