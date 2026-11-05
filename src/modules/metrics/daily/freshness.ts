/**
 * How long an analytics answer may be reused, and what the caller is told about its age.
 *
 * Caching comes last in this rewrite on purpose: caching a slow, disagreeing path just
 * caches the disagreement. Now that one resolver answers from stored rows, the question is
 * only "can this answer still change?" — and it has a real answer rather than a guessed TTL.
 *
 * **PRIVATE, always.** This is one tenant's revenue. `public` would let a shared proxy serve
 * it to somebody else, and the geo endpoint's `public, max-age=86400` — the only
 * `cache-control` in this codebase before now — is reference data, not a precedent for this.
 */

/** How often `metric_daily_current` recomputes the period in progress. */
export const CURRENT_REFRESH_SECONDS = 300;

/**
 * Closed history can be held far longer than the refresh interval, but not forever: a
 * backdated cancellation restates a past period, and the nightly close rewrites yesterday.
 * An hour is short enough that a restatement surfaces within one, and long enough that ten
 * people opening the same board at 09:00 pay for it once.
 */
const CLOSED_HISTORY_SECONDS = 3600;

export interface Freshness {
  /** The value for the `cache-control` header. */
  cacheControl: string;
  /** When the oldest row in the answer was computed, ISO — published on the payload. */
  computedAt: string | null;
  /**
   * True when the answer covers the period in progress, so it can still move. A caller
   * showing a "live" badge should key it off this rather than off the range it asked for.
   */
  includesCurrentPeriod: boolean;
  /** Seconds until this answer could next change. Published so a client can schedule itself. */
  maxAgeSeconds: number;
}

/**
 * `now` and `to` are both dates in the BUSINESS's timezone, already resolved by the caller —
 * "today" is not the same day everywhere, and deciding it here would put a second timezone
 * rule in the codebase.
 */
export function freshnessFor(input: {
  computedAt: Date | null;
  /** The last period the answer covers, `YYYY-MM-DD`. */
  to: string;
  /** Today in the business's timezone, `YYYY-MM-DD`. */
  today: string;
  /** Non-empty when the store could not answer some periods — see `readMetric`. */
  missing: readonly string[];
}): Freshness {
  const includesCurrentPeriod = input.to >= input.today;

  /**
   * An answer with gaps was assembled by falling back to reconstruction, so the next request
   * may legitimately differ once the writer catches up. Never cache one: a hole cached for an
   * hour is a wrong chart for an hour, and the whole contract here is that an incomplete
   * cache must not change the answer.
   */
  if (input.missing.length > 0) {
    return {
      cacheControl: "private, no-store",
      computedAt: input.computedAt?.toISOString() ?? null,
      includesCurrentPeriod,
      maxAgeSeconds: 0,
    };
  }

  const maxAgeSeconds = includesCurrentPeriod ? CURRENT_REFRESH_SECONDS : CLOSED_HISTORY_SECONDS;
  return {
    // `must-revalidate`: serving a stale revenue figure after the window has passed is worse
    // than paying for the round trip.
    cacheControl: `private, max-age=${maxAgeSeconds}, must-revalidate`,
    computedAt: input.computedAt?.toISOString() ?? null,
    includesCurrentPeriod,
    maxAgeSeconds,
  };
}
