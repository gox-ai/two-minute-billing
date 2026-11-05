// No imports on purpose. This is pure derivation, unit-tested from the engine's own
// `test/unit/` suite, and anything reaching into `@/lib/api/payments` would drag the
// server-only api client into that program. The shapes below are structural subsets of
// `PaymentIntentDetail` / `PaymentAttempt`, so callers pass the real objects unchanged.

/**
 * The status to SHOW for an intent whose newest attempt was refused.
 *
 * Not an engine value — `payment_intents.status` deliberately has no `failed`.
 * A refused authorization marks the ATTEMPT failed and leaves the intent open,
 * because that pairing is exactly what `retryPaymentIntent` requires to mint
 * attempt N+1. Rendering the raw column then puts "In Progress" over a flow that
 * is not in progress at all: the gateway refused, `next_action` is gone, and the
 * row only moves again on a retry or at its expiry.
 *
 * Reported from production, 2026-09-18 — a setup intent badged "In Progress"
 * above its own red "Attempt 1 · Failed · The gateway refused the authorization"
 * card. The page contradicted itself, and the badge is what an operator scans.
 */
export const ATTEMPT_FAILED = "attempt_failed";

/** Statuses that END an intent. A failed attempt under one of these is history, not a live refusal. */
const TERMINAL: ReadonlySet<string> = new Set(["consumed", "expired", "voided"]);

/**
 * What to render as an intent's status, given its attempts.
 *
 * Mirrors `retryPaymentIntent`'s own refusals rather than guessing which states
 * can still carry a live failure: it throws on consumed / expired / voided and
 * requires the newest attempt to be `failed`. Everything else — `inited`,
 * `in_progress`, and the `authorized` a refused vault is rewound to — is an open
 * intent sitting on a refusal.
 *
 * Returns `intent.status` unchanged when nothing diverges, so callers can compare
 * the two to decide whether the difference needs explaining.
 */
export function displayIntentStatus(
  intent: { status: string; voided_at?: string | null; last_attempt_status?: string | null },
  /**
   * The attempts, where the caller has them (the detail page). A LIST row does not, and
   * reads the engine's denormalised `last_attempt_status` off the intent instead — the
   * same fact, cached, because a per-row read of `payment_attempts` is the correlated
   * subquery GUIDE §3.4 forbids on a keyset list.
   */
  attempts?: readonly { status: string; attempt_number: number }[],
): string {
  if (TERMINAL.has(intent.status) || intent.voided_at) return intent.status;
  // Highest attempt_number, not array order: `currentAttempt` is what the engine
  // acts on, and the API's oldest-first ordering is a serializer detail.
  const newest = attempts?.length
    ? attempts.reduce((acc, a) => (a.attempt_number > acc.attempt_number ? a : acc)).status
    : intent.last_attempt_status;
  return newest === "failed" ? ATTEMPT_FAILED : intent.status;
}
