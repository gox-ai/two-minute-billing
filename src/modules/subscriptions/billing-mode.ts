/**
 * Billing mode — the two granularities that decide where a term starts and how
 * mid-term money is measured. They are separate axes, and only three combinations are
 * supported:
 *
 *   anchor    proration    meaning
 *   instant   exact        millisecond-based (the default)
 *   instant   whole_day    day-based, billing days run from the term start's time of day
 *   day       whole_day    day-based, billing days run from local midnight
 *
 * ('day' + 'exact' is not a supported mode; the write layer rejects it and the DB has
 * a CHECK constraint, so this module may assume it never occurs.)
 *
 * WHY THIS MODULE EXISTS. The two decisions used to be read as
 * `termAlignment === 'calendar_day'` inline at seven call sites, each re-deriving the
 * boundaries with its own copy of the tz math. Adding a third mode that agrees with
 * one axis and not the other would have meant seven chances to get it wrong, silently
 * — a wrong boundary does not throw, it bills the wrong amount. So both decisions live
 * here, as two named functions, and the call sites ask instead of deciding.
 */
import { eq } from "drizzle-orm";
import { businesses } from "@db/schema";
import type { AnchorGranularity, ProrationGranularity } from "@db/schema/tenancy";
import { startOfDayInTz, startOfNextDayInTz } from "@/platform/clock";
import type { Tx } from "@/platform/db";
import { withTenant } from "@/platform/db";

// Declared with the columns they type (db/schema/tenancy.ts) so tenancy — which writes
// them — and this module, which reads them, cannot drift apart.
export type { AnchorGranularity, ProrationGranularity } from "@db/schema/tenancy";

export interface BillingMode {
  anchor: AnchorGranularity;
  proration: ProrationGranularity;
  /** IANA zone the day boundaries are taken in. Falls back to UTC, as before. */
  timezone: string;
}

/** The default: exact instants, exact proration. */
export const DEFAULT_BILLING_MODE: BillingMode = {
  anchor: "instant",
  proration: "exact",
  timezone: "UTC",
};

/** Read a business's billing mode inside an existing transaction. */
export async function billingModeFor(tx: Tx, businessId: string): Promise<BillingMode> {
  const [b] = await tx
    .select({
      anchor: businesses.anchorGranularity,
      proration: businesses.prorationGranularity,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  // A missing business keeps the old fallback behavior (treat as the default mode)
  // rather than throwing — these are read-only boundary decisions, and the callers
  // already tolerated `bizAlign` being undefined.
  if (!b) return DEFAULT_BILLING_MODE;
  return {
    anchor: b.anchor === "day" ? "day" : "instant",
    proration: b.proration === "whole_day" ? "whole_day" : "exact",
    timezone: b.timezone ?? "UTC",
  };
}

/** `billingModeFor` for callers that are not already inside a transaction. */
export async function loadBillingMode(
  organizationId: string,
  businessId: string,
): Promise<BillingMode> {
  return withTenant(organizationId, (tx) => billingModeFor(tx, businessId));
}

/** True when this business reports term ends inclusively (…T23:59:59). */
export function usesInclusiveTermEnd(mode: BillingMode): boolean {
  return mode.anchor === "day";
}

/**
 * How far an INCLUSIVE boundary sits before the exclusive one it names.
 *
 * One SECOND, not one millisecond. A day-anchored term ends at `…T23:59:59` local — that
 * is the last instant the term actually covers, and it is the resolution the convention
 * is defined at: timestamps are expressed in unix seconds, so a boundary cannot be
 * stated any finer. `…59.999` names no moment
 * anyone reasons about and reads as a different instant to anything comparing below day
 * granularity. `alignTrialEnd` had always backed off a second while `serialize.ts` backed
 * off a millisecond, so our own two inclusive boundaries disagreed with each other. One
 * constant now, so they cannot.
 */
const INCLUSIVE_BACKOFF_MS = 1000;

/**
 * An EXCLUSIVE stored boundary → the INCLUSIVE instant that names the same boundary:
 * the last second of the final day (…T23:59:59 local) rather than the first instant of
 * the next (…T00:00:00). Instant-anchored businesses have no final day and pass through.
 *
 * THE ONE PLACE THIS CONVERSION LIVES. Storage is exclusive everywhere and must stay that
 * way — all the period arithmetic depends on `next_period_start === current_period_end`
 * (proration, renewal, cancellation credit) — so this is applied only at the edges that
 * PRESENT a boundary to someone outside the engine. A second copy of `end - 1` anywhere
 * else is a bug waiting to drift, which is exactly how the ms/second split above happened.
 *
 * ── ONLY A LOCAL MIDNIGHT IS CONVERTED ────────────────────────────────────────────────
 * "The last instant of the final day" is only a true statement about a boundary that IS a
 * day boundary. Term ends on a day-anchored business always are (`alignTermStart` /
 * `advancePeriod` / `normalizeTermEnd` all land on local midnight), so the guard is a
 * no-op for them. But a period end can also be an ARBITRARY instant the caller chose —
 * `POST /v1/invoices` and the ad-hoc charge endpoint both accept one and store it raw, and
 * there is no write-side normalization forcing it to midnight. Backing such a value off a
 * second would report `12:00:00` as `11:59:59`, and a client that read it and posted it
 * back would walk it a second per cycle — the same drift `normalizeTermEnd` exists to
 * absorb for term ends, reintroduced one field over. So a non-midnight instant is reported
 * exactly as stored: the convention has nothing to say about it.
 */
export function inclusiveBoundary(at: Date, mode: BillingMode): Date;
export function inclusiveBoundary(at: Date | null | undefined, mode: BillingMode): Date | null;
export function inclusiveBoundary(at: Date | null | undefined, mode: BillingMode): Date | null {
  if (!at) return null;
  if (mode.anchor !== "day") return at;
  if (startOfDayInTz(at, mode.timezone).getTime() !== at.getTime()) return at;
  return new Date(at.getTime() - INCLUSIVE_BACKOFF_MS);
}

/**
 * Where a term that begins at `at` actually starts: floored to the start of the local
 * day when day-anchored, otherwise `at` unchanged.
 */
export function alignTermStart(at: Date, mode: BillingMode): Date {
  return mode.anchor === "day" ? startOfDayInTz(at, mode.timezone) : at;
}

/**
 * The last moment of the final day of a day-anchored trial — `trial_end` sits at the
 * END of its last day (…T23:59:59) rather than the start, so the trial lands on the
 * calendar day it names. Returns `at` unchanged for instant-anchored businesses.
 *
 * A trial end is STORED inclusively (unlike a term end, which is stored exclusively and
 * converted at the read edge) — the clock schedules the conversion off exactly this
 * instant. So it shares the back-off with `inclusiveBoundary` but not the direction:
 * nothing may shift it again on the way out.
 *
 * ⚠️ `at` must NAME THE DAY the trial ends ON — a date an operator picked, or the
 * `…T23:59:59` a client read back from us (both land on the same answer, so this is
 * idempotent on a read-back). It must NOT be an exclusive boundary: this advances to
 * the next local midnight before backing off, so handing it `start + trialDays` — which
 * is already the exclusive boundary — buys a whole extra day. `createSubscription` did
 * exactly that and every 14-day trial ran 15; it uses `inclusiveBoundary` now. If you
 * have a boundary rather than a day, that is the function you want.
 */
export function alignTrialEnd(at: Date, mode: BillingMode): Date {
  if (mode.anchor !== "day") return at;
  return inclusiveBoundary(startOfNextDayInTz(at, mode.timezone), mode);
}

/**
 * Normalize an incoming term-end instant to the stored EXCLUSIVE convention.
 *
 * The read side reports a day-anchored term end inclusively (`…T23:59:59`, see
 * `serializeSubscription`), so a client that reads a term end, shows it, and writes it
 * back hands us that inclusive instant. Stored as-is it would sit a second before the
 * real boundary — and each read-modify-write cycle would walk the term further off midnight,
 * breaking the invariant that a day-anchored term starts and ends at local midnight.
 * Observed in the browser: the change-term-end dialog moved the boundary 23:59:59 →
 * 23:59:00 → 23:58:00 on successive opens.
 *
 * So for a day-anchored business, any instant that is not already a local midnight rounds
 * UP to the next one — the customer keeps the day they are in, the same rule
 * `prorationBoundary` applies to money. An exact local midnight passes through untouched,
 * which is what stops a caller who already sends the exclusive boundary from gaining a
 * whole extra day. Instant-anchored businesses are returned unchanged.
 */
export function normalizeTermEnd(at: Date, mode: BillingMode): Date {
  if (mode.anchor !== "day") return at;
  const startOfIts = startOfDayInTz(at, mode.timezone);
  return startOfIts.getTime() === at.getTime() ? at : startOfNextDayInTz(at, mode.timezone);
}

/**
 * The instant to prorate AS-OF — the money decision, and the only part that needed
 * generalizing for the day-based mode.
 *
 * With `exact` proration the answer is just `now`: prorate() measures elapsed time.
 *
 * With `whole_day` proration the customer keeps the whole billing day they are in, so
 * the boundary advances to the END of that day and prorate()'s time fraction collapses
 * to a whole number of days. A "billing day" runs from the TERM START's time-of-day: a
 * term created at 10:00 AM has billing days running 10:00 AM → 10:00 AM, so a 09:00 AM
 * cancellation falls in the PREVIOUS day.
 *
 * For day-anchored terms the term start IS local midnight, so this reduces exactly to
 * `startOfNextDayInTz(now)` — the previous behavior, byte-for-byte, which is what the
 * frozen fixtures assert. `termStart` is only consulted in the instant-anchored
 * case, and falls back to local midnights when it is unknown.
 */
export function prorationBoundary(
  now: Date,
  termStart: Date | null | undefined,
  mode: BillingMode,
): Date {
  if (mode.proration !== "whole_day") return now;
  const tz = mode.timezone;
  if (mode.anchor === "day" || !termStart) return startOfNextDayInTz(now, tz);

  // Instant-anchored + whole-day: shift the local-midnight grid by the term start's
  // time-of-day, then take the first boundary strictly after `now`. Landing exactly ON
  // a boundary yields the NEXT one, so a customer always keeps a full final day —
  // consistent with the day-anchored case, where startOfNextDayInTz(midnight) is the
  // following midnight.
  const timeOfDayMs = termStart.getTime() - startOfDayInTz(termStart, tz).getTime();
  const todayBoundary = startOfDayInTz(now, tz).getTime() + timeOfDayMs;
  if (todayBoundary > now.getTime()) return new Date(todayBoundary);
  return new Date(startOfNextDayInTz(now, tz).getTime() + timeOfDayMs);
}

/**
 * The START of the billing day containing `now` — the mirror of `prorationBoundary`,
 * used as the start of the proration window when an item is added or removed mid-term
 * Whole-day granularity means a same-day-as-term-start add bills the full term
 * and its `dateFrom` equals the term start.
 *
 * `exact` proration returns `now`. Day-anchored whole-day returns local midnight (the
 * previous behavior). Instant-anchored whole-day returns the term start's time-of-day
 * on the current billing day.
 */
export function prorationWindowStart(
  now: Date,
  termStart: Date | null | undefined,
  mode: BillingMode,
): Date {
  if (mode.proration !== "whole_day") return now;
  const tz = mode.timezone;
  if (mode.anchor === "day" || !termStart) return startOfDayInTz(now, tz);
  const timeOfDayMs = termStart.getTime() - startOfDayInTz(termStart, tz).getTime();
  const todayBoundary = startOfDayInTz(now, tz).getTime() + timeOfDayMs;
  if (todayBoundary <= now.getTime()) return new Date(todayBoundary);
  // `now` is before today's boundary → the current billing day began yesterday. Step
  // back a full local day and re-apply the offset (DST-safe: the grid is rebuilt from
  // a local midnight rather than by subtracting 24h).
  const yesterdayMidnight = startOfDayInTz(
    new Date(startOfDayInTz(now, tz).getTime() - 12 * 60 * 60 * 1000),
    tz,
  );
  return new Date(yesterdayMidnight.getTime() + timeOfDayMs);
}
