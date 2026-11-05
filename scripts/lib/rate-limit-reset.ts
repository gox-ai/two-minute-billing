import { systemDb } from "@/platform/db";
import { publicRateLimitCounters } from "@db/schema";

/**
 * Clear the UNAUTHENTICATED-surface rate-limit counters before a suite runs.
 *
 * ── WHY A SUITE NEEDS THIS ──────────────────────────────────────────────────────
 * `RATE_LIMIT_AUTH_PER_IP` is 30 per 15-minute window, counted per IP — and every suite runs
 * from 127.0.0.1, so they all share one bucket. Running a portal or auth suite two or three
 * times inside that window exhausts it, and the failure is not a legible "429": the portal
 * link exchange returns no token, every subsequent portal call answers `missing_portal_token`,
 * and the suite dies on whatever line first touches the response body.
 *
 * Measured 2026-08-28 in `verify:customer-portal` — `26/71 failed` and then a bare
 * `TypeError: Cannot read properties of undefined (reading 'every')` on a line that had nothing
 * to do with rate limiting and had not been touched. Ten minutes went into looking for a code
 * defect that did not exist.
 *
 * ⚠ Do NOT call this from `verify:rate-limit` or any suite whose subject IS the limiter.
 * Elsewhere the limiter is ambient state, and a suite that depends on ambient state passes or
 * fails by accident of what ran before it.
 */
export async function clearPublicRateLimits(): Promise<void> {
  await systemDb.delete(publicRateLimitCounters);
}
