import { and, desc, eq, isNotNull, type SQL } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { clockTicks } from "@db/schema";
import { workerAliveThroughout } from "@/modules/ops/heartbeats";
import type { TickError } from "@/modules/subscriptions/renewal";

/** SCHED-1 thresholds. */
export const TICK_OVERRUN_MS = 60_000; // a tick that runs longer than this overran
export const TICK_LAG_MS = 90_000; // …or started this long after the previous finished
/** Post-H (#12): cap the per-tick errors jsonb so a mass-failure can't bloat the row. */
export const TICK_ERROR_CAP = 100;

/**
 * When an unfinished tick stops meaning "running" and starts meaning "nobody will
 * ever close this row".
 *
 * Five times the overrun threshold, so it is well clear of a legitimately slow tick.
 * Past it, the row was almost certainly opened by `startClockTick` and then abandoned
 * — the worker died mid-tick, or a pass threw and `finishClockTick` never ran. Nothing
 * on the server ever revisits such a row.
 *
 * **This is the only definition.** Readers that filter ticks in SQL and readers that
 * render a verdict must use the same number, so they import it from here rather than
 * keeping a copy that can drift.
 */
export const TICK_ABANDONED_AFTER_MS = 5 * TICK_OVERRUN_MS;

/**
 * One entry in `clock_ticks.passes` — what a single pass of the tick did.
 *
 * `counts` is each pass's own vocabulary (`{ applied: 2 }`, `{ delivered: 7, failed: 1 }`)
 * rather than a fixed shape: the fifteen passes genuinely count different things, and
 * flattening them into shared columns is what limited the row to four passes' worth of
 * detail. Written by `runPass` in platform/jobs.ts, so a new pass cannot be added
 * without showing up here.
 */
export interface TickPass {
  name: string;
  /**
   * `skipped` means the SWEEP ran out of its wall-clock budget before reaching this pass —
   * not that the pass had nothing to do, and not that it failed.
   *
   * Recorded rather than omitted, because a pass missing from the array is
   * indistinguishable from one that ran and found no work, and "why did dunning not run at
   * 03:00" has to be answerable from this row alone. Passes run in priority order, so the
   * skipped ones are always the most deferrable.
   */
  status: "ok" | "failed" | "skipped";
  ms: number;
  counts?: Record<string, number>;
  /** Set when `status === 'failed'` — the message that aborted this pass. */
  error?: string;
}

export interface TickCounters {
  scheduledApplied: number;
  renewed: number;
  dunningRetried: number;
  dunningRecovered: number;
  dunningCanceled: number;
  webhooksDelivered: number;
  webhooksFailed: number;
}

export interface TickStart {
  id: string;
  /** Gap from the previous tick's finish to this tick's start; null for the first tick. */
  lagMs: number | null;
  /** The gap exceeded TICK_LAG_MS *and* a worker was up throughout — the clock fell behind. */
  laggedOverrun: boolean;
  /** The gap exceeded TICK_LAG_MS but no worker spanned it — restart/deploy/outage. */
  downtimeGap: boolean;
}

/**
 * Open a clock_ticks row at tick start; returns its id, the measured gap, and the
 * lag verdict.
 *
 * The gap alone is not evidence of lag. Ticks are cron-driven, so a gap means one of
 * two very different things:
 *
 *   - a worker was up the whole time and the ticks still didn't happen → the clock is
 *     falling behind (queue starved, cron stalled) → a real overrun, worth paging on;
 *   - no worker was up for part of it → the ticks were never attempted → downtime.
 *
 * Conflating them made every dev restart and every deploy log an error-level
 * "overran" with zero counters and zero errors, which is exactly how a genuine
 * overrun ends up ignored. So lag is only charged against the clock when
 * `workerAliveThroughout` can positively establish that a process spanned the gap.
 */
export async function startClockTick(
  startedAt: Date,
  traceId: string | null = null,
): Promise<TickStart> {
  // The newest FINISHED tick, not simply the newest.
  //
  // A tick that died mid-pass leaves `finished_at` null, and reading that row gave
  // `lagMs = null` → `lagged = false`: the tick right after a crash could never report
  // lag, exactly when the clock is most likely to have fallen behind. Skipping unclosed
  // rows measures the gap from the last tick we actually know completed.
  const [prev] = await systemDb
    .select({ finishedAt: clockTicks.finishedAt })
    .from(clockTicks)
    .where(isNotNull(clockTicks.finishedAt))
    .orderBy(desc(clockTicks.startedAt))
    .limit(1);
  const prevFinishedAt = prev?.finishedAt ?? null;
  const lagMs = prevFinishedAt ? startedAt.getTime() - prevFinishedAt.getTime() : null;
  const lagged = lagMs !== null && lagMs > TICK_LAG_MS;
  const workerSpannedGap = lagged && (await workerAliveThroughout(prevFinishedAt!, startedAt));
  const laggedOverrun = lagged && workerSpannedGap;
  const downtimeGap = lagged && !workerSpannedGap;
  const [row] = await systemDb
    .insert(clockTicks)
    .values({ startedAt, lagMs, downtimeGap, overran: laggedOverrun, traceId })
    .returning({ id: clockTicks.id });
  return { id: row!.id, lagMs, laggedOverrun, downtimeGap };
}

/**
 * Close the row with counters, per-item errors, and the final overrun verdict.
 *
 * Returns the two causes separately (`ranOverrun` + the run duration) because
 * "overran: true" on its own is unreadable in a log — it took a database query to
 * tell a 100ms tick after a restart from a tick that genuinely ran for a minute.
 */
export async function finishClockTick(
  id: string,
  input: {
    startedAt: Date;
    finishedAt: Date;
    counters: TickCounters;
    errors: TickError[];
    laggedOverrun: boolean;
    /** Per-pass timeline; omitted by callers that drive a tick's phases themselves. */
    passes?: TickPass[];
  },
): Promise<{ overran: boolean; ranOverrun: boolean; runMs: number }> {
  const runMs = input.finishedAt.getTime() - input.startedAt.getTime();
  const ranOverrun = runMs > TICK_OVERRUN_MS;
  const overran = ranOverrun || input.laggedOverrun;
  // Post-H (#12): bound the errors jsonb — keep the first TICK_ERROR_CAP and append a
  // synthetic marker recording how many more were dropped, so the row can't grow
  // unbounded on a mass-failure tick.
  let errors: TickError[] | null = null;
  if (input.errors.length) {
    if (input.errors.length > TICK_ERROR_CAP) {
      const dropped = input.errors.length - TICK_ERROR_CAP;
      errors = [
        ...input.errors.slice(0, TICK_ERROR_CAP),
        {
          organization: "system",
          step: "errors_truncated",
          message: `+${dropped} more errors truncated (cap ${TICK_ERROR_CAP})`,
        },
      ];
    } else {
      errors = input.errors;
    }
  }
  await systemDb
    .update(clockTicks)
    .set({
      finishedAt: input.finishedAt,
      scheduledApplied: input.counters.scheduledApplied,
      renewed: input.counters.renewed,
      dunningRetried: input.counters.dunningRetried,
      dunningRecovered: input.counters.dunningRecovered,
      dunningCanceled: input.counters.dunningCanceled,
      webhooksDelivered: input.counters.webhooksDelivered,
      webhooksFailed: input.counters.webhooksFailed,
      errors,
      overran,
      ...(input.passes ? { passes: input.passes } : {}),
    })
    .where(eq(clockTicks.id, id));
  return { overran, ranOverrun, runMs };
}
