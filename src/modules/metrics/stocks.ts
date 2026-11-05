/**
 * The point-in-time predicates behind every stock figure: what was live, what was earning,
 * and what was committed, at an instant.
 *
 * Extracted from `analytics.ts` when the daily snapshots arrived (Phase 2), because two
 * readers now answer the same questions and a second copy of a definition is how MRR and
 * "MRR as of yesterday" drift apart. Analytics evaluates these over an in-memory book for
 * every chart bucket; the snapshot writer evaluates them once per day and stores the
 * answer. Both must mean the same thing, so both call these.
 *
 * Deliberately pure and row-shaped: no database, no currency conversion, no knowledge of
 * which currency a caller is reporting in. The caller owns all three.
 */

/** The subscription fields these predicates read. Structural, so both callers' rows fit. */
export interface StockRow {
  id: string;
  status: string;
  currency: string;
  createdAt: Date;
  startDate: Date | null;
  startedAt: Date | null;
  canceledAt: Date | null;
  cancelAtPeriodEnd: boolean | null;
  cancelScheduledAt: Date | null;
  /** When a term-end stop was booked, kept once the cancel clears the flags that dated it. */
  cancelBookedAt?: Date | null;
  currentPeriodEnd: Date | null;
  /** When the current term began — the start of the final term when the stop is its end. */
  currentPeriodStart?: Date | null;
  trialEnd: Date | null;
  /** Whether it had a trial at all — `trialEnd` alone is also parked on rows that never did. */
  trialStart: Date | null;
  /** When it was activated. Read only as the activation that ENDED a trial (see `earningFrom`). */
  activatedAt?: Date | null;
  billingPeriod: number | null;
  billingPeriodUnit: string | null;
  remainingBillingCycles: number | null;
  /**
   * Closed stretches it spent cancelled before a reactivation, `[churn, reactivation)` —
   * from the MRR ledger (`loadLapses`), because a reactivation clears `canceled_at` and the
   * row alone then reads as live straight through the gap. Absent means none.
   */
  lapses?: readonly Lapse[] | null;
}

/** A stretch a subscription spent cancelled before it was reactivated: `[from, to)`. */
export interface Lapse {
  from: Date;
  to: Date;
}

/** Inside a cancelled stretch that a later reactivation closed. */
export const lapsedAt = (s: StockRow, at: Date): boolean =>
  s.lapses?.some((l) => l.from <= at && at < l.to) ?? false;

const DAY_MS = 86_400_000;

/** Statuses that carry MRR, plus `cancelled` — which carried it until it stopped. */
export const MRR_STATUSES = new Set(["active", "in_trial", "cancelled"]);
/** What the "active subscriptions" count means: ACTIVE + NON_RENEWING (stored as active). */
export const ACTIVE_COUNT_STATUSES = new Set(["active"]);

/** A subscription's own start: the term's start where there is one, else when it appeared. */
export const startOf = (s: StockRow): Date => s.startedAt ?? s.startDate ?? s.createdAt;

/** Had started by `at`, and had not stopped — nor was in a stretch it was later reactivated from. */
export const liveAt = (s: StockRow, at: Date): boolean =>
  startOf(s) <= at && (s.canceledAt == null || s.canceledAt > at) && !lapsedAt(s, at);

/**
 * When a subscription began to EARN: when its trial ended, not when it started — a trial is
 * unpaid, and counting it at the rate it later converted to put revenue into days nobody paid for.
 *
 * The activation that ended the trial when there is one (within a day of `trialEnd`: the engine
 * activates a second after, which can fall on the next day), else `trialEnd` itself. An
 * activation long after is not that one — on imported books it is a later re-activation, often
 * with payments before it. Left at its start when cancelled before the trial ended. Mirrored in
 * SQL by `scripts/repair-backfilled-movement-rates.ts`, so the ledger and the store agree.
 */
export const earningFrom = (s: StockRow): Date => {
  const start = startOf(s);
  if (
    s.trialStart != null &&
    s.trialEnd != null &&
    s.trialEnd > start &&
    (s.canceledAt == null || s.canceledAt > s.trialEnd)
  ) {
    const a = s.activatedAt;
    return a != null && a >= s.trialEnd && a.getTime() - s.trialEnd.getTime() <= DAY_MS
      ? a
      : s.trialEnd;
  }
  return start;
};

/** Contributing MRR at `at`: an MRR status, earning by then, and not yet stopped. */
export const earningAt = (s: StockRow, at: Date): boolean =>
  MRR_STATUSES.has(s.status) &&
  earningFrom(s) <= at &&
  (s.canceledAt == null || s.canceledAt > at) &&
  !lapsedAt(s, at);

/**
 * Counted by "active subscriptions" at `at`. A currently-trialing subscription was not
 * active at any earlier instant either, so the status test needs no point-in-time
 * treatment.
 */
export const isActiveAt = (s: StockRow, at: Date): boolean =>
  (ACTIVE_COUNT_STATUSES.has(s.status) || s.status === "cancelled") && liveAt(s, at);

/** Milliseconds in one billing period — approximate by design; a chart bucket is a day. */
const periodMs = (s: StockRow): number => {
  const unit = s.billingPeriodUnit ?? "month";
  const n = s.billingPeriod ?? 1;
  const days = unit === "day" ? 1 : unit === "week" ? 7 : unit === "year" ? 365 : 30;
  return n * days * DAY_MS;
};

/** When a commitment runs out on its own. Null = it renews until someone stops it. */
export const commitmentEnd = (s: StockRow): Date | null => {
  if (s.remainingBillingCycles == null) return null;
  const boundary = s.status === "in_trial" ? s.trialEnd : s.currentPeriodEnd;
  if (!boundary) return null;
  return new Date(boundary.getTime() + Math.max(0, s.remainingBillingCycles - 1) * periodMs(s));
};

/** Booked to stop, whether or not it has stopped yet — see `committedAt`. */
export const isBookedToStop = (s: StockRow): boolean =>
  s.canceledAt != null || s.cancelAtPeriodEnd === true || s.cancelScheduledAt != null;

/**
 * Due to stop at the end of the term running at `at` — the difference between a paying and a
 * RENEWING subscription.
 *
 * From `cancel_booked_at` when the row has it (every engine booking since 2026-10-03).
 * Without it — imported or older bookings — the rule for a past instant is: inside the final term before a stop at term end (`cancel_scheduled_at`, or
 * `cancel_at_period_end` with the term's end or, once it has ended, `canceled_at`). An
 * immediate cancellation is never non-renewing — nothing was booked ahead. For the present
 * instant this is exactly the row's own flags.
 */
export const nonRenewingAt = (s: StockRow, at: Date): boolean => {
  if (s.cancelBookedAt != null) {
    const end =
      s.canceledAt ??
      s.cancelScheduledAt ??
      (s.cancelAtPeriodEnd === true ? s.currentPeriodEnd : null);
    if (end != null) return s.cancelBookedAt <= at && at < end;
  }
  const stop =
    s.cancelScheduledAt ??
    (s.cancelAtPeriodEnd === true ? (s.canceledAt ?? s.currentPeriodEnd) : null);
  if (stop == null || stop <= at) return false;
  // The final term: the current one when the stop is its end, else one billing period back.
  const finalTermStart =
    s.currentPeriodStart != null && s.currentPeriodEnd != null && +stop === +s.currentPeriodEnd
      ? s.currentPeriodStart.getTime()
      : stop.getTime() - periodMs(s);
  return finalTermStart <= at.getTime();
};

/**
 * When a stop was booked, as far as the row can say: `cancel_booked_at` when set. Without
 * it (imported or older bookings), for a stop at term end this is the start of its final term —
 * the same reading `nonRenewingAt` uses — and for an immediate cancellation its own instant.
 * Null when nothing is booked.
 */
export const stopBookedBy = (s: StockRow): Date | null => {
  if (s.cancelBookedAt != null) return s.cancelBookedAt;
  const stop =
    s.cancelScheduledAt ??
    (s.cancelAtPeriodEnd === true ? (s.canceledAt ?? s.currentPeriodEnd) : null);
  if (stop != null) {
    const finalTermStart =
      s.currentPeriodStart != null && s.currentPeriodEnd != null && +stop === +s.currentPeriodEnd
        ? s.currentPeriodStart.getTime()
        : stop.getTime() - periodMs(s);
    const at =
      s.canceledAt != null ? Math.min(finalTermStart, s.canceledAt.getTime()) : finalTermStart;
    return new Date(at);
  }
  return s.canceledAt;
};

/**
 * What a cancel writes to `cancel_booked_at` from the row it is about to cancel. Every cancel
 * clears `cancel_at_period_end`/`cancel_scheduled_at`, and without this the terminal row reads
 * as booked at `canceledAt` — moving a year-old booking to today and rewriting CMRR history.
 */
export const frozenStopBooking = (before: StockRow, canceledAt: Date): Date | null => {
  const booked = stopBookedBy(before);
  if (booked == null) return null;
  return booked < canceledAt ? booked : canceledAt;
};

/**
 * Counted by CMRR at `at`: revenue we are COMMITTED to, which is not the revenue we are
 * earning. A booked cancellation leaves the moment it is booked — the decision is already
 * taken — and a subscription signed to start later is already in.
 *
 * Point in time: the stop is judged by when it was booked (`stopBookedBy`), never by the
 * row's flags today. Reading today's `cancelled` backwards dropped a subscription cancelled
 * this morning from every day back to its creation, so each cancellation rewrote history.
 */
export const committedAt = (s: StockRow, at: Date): boolean => {
  const w = committedWindow(s);
  return w != null && !(w.from > at) && (w.until == null || w.until > at);
};

/**
 * `committedAt` as the interval it is: committed exactly while `from <= at < until`, null when
 * never. Neither end depends on `at`, so a reader asking many instants can sort the book once
 * instead of testing every row at every instant (D4.5).
 */
export const committedWindow = (s: StockRow): { from: Date; until: Date | null } | null => {
  if (!(MRR_STATUSES.has(s.status) || s.status === "future")) return null;
  // The commitment exists from the moment the subscription does — which is `createdAt`,
  // NOT its start: a subscription signed today to start next month is committed revenue
  // today, and that asymmetry with `liveAt` is the whole point of the metric.
  //
  // The lower bound is what makes the predicate safe to evaluate BACKWARDS. Without it a
  // daily snapshot of a day before the business had any subscriptions counted today's book as
  // committed then, which is how `verify:mrr-snapshots` found it.
  const booked = stopBookedBy(s);
  // A cancelled row with no stop on record has nothing to date it by.
  if (s.status === "cancelled" && booked == null) return null;
  const end = commitmentEnd(s);
  // A booked stop leaves the moment it is booked; the term's end, when it comes.
  const until = booked == null ? end : end == null || booked < end ? booked : end;
  return { from: s.createdAt, until };
};
