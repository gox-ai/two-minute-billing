/**
 * The assistant's monthly allowance per plan (Cloud). Account billing writes each organization's
 * allowance to `organizations.assistant_allowance_usd_cents` from its plan; the engine only reads
 * that column. NULL, or self-hosted: no allowance, and the token cap applies.
 */

/** Cost recorded as USD minor units × 10^12 → US cents. A month stays far below 2^53. */
export const fixed12ToCents = (v: string | null): number => (v === null ? 0 : Number(v) / 1e12);

/**
 * A turn on a model with no price in the price list counts at $1 per million tokens, about ten
 * times our default model, so a missing price never makes questions free.
 */
export const UNPRICED_CENTS_PER_MILLION_TOKENS = 100;

export function usedPercent(usedCents: number, allowanceCents: number): number {
  if (allowanceCents <= 0) return usedCents > 0 ? 100 : 0;
  return Math.floor((usedCents / allowanceCents) * 100);
}

export const WARN_PERCENT = 80;

/**
 * Members see the allowance in credits, not dollars (user decision 2026-11-07): one credit is
 * $0.002 of model cost, about one typical question. Free 50, $29 300, $99 1,000, $299 3,000.
 */
export const CREDIT_USD_CENTS = 0.2;
export const centsToCredits = (cents: number): number => Math.round(cents / CREDIT_USD_CENTS);

/** The first instant of next month (UTC): when the allowance renews. */
export const renewsAt = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

export const monthKey = (now: Date) => now.toISOString().slice(0, 7);
