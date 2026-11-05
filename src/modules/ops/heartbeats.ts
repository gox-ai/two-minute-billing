import { hostname } from "node:os";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { workerHeartbeats } from "@db/schema";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";

const log = createLogger("ops.heartbeats");

/**
 * Worker liveness (SCHED-3).
 *
 * The worker process owns its row: `registerWorker` on boot, `beat` on an
 * interval, `markWorkerStopped` on a clean shutdown. Reads derive health rather
 * than storing it, so a row can never claim "alive" about a process that died —
 * the timestamp is the only truth and it ages on its own.
 */

/** A process is considered dead if it hasn't beaten within this window. */
export const WORKER_STALE_MS = 30_000;
/** How often the worker refreshes its row. Must stay well under WORKER_STALE_MS. */
export const WORKER_BEAT_MS = 10_000;
/** Stopped rows older than this are pruned on registration, so the list stays readable. */
export const WORKER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkerHealth = "alive" | "stale" | "stopped";

export interface WorkerView {
  workerId: string;
  hostname: string;
  pid: number;
  /** `billing` (the clock) | `all`. Historical rows may hold `shadow` or null. */
  role: string | null;
  concurrency: number;
  tasks: string[];
  crontab: string | null;
  jobsActive: number;
  jobsSucceeded: number;
  jobsFailed: number;
  /** graphile-worker in-pool ids this process owns. Null = row predates 0215. */
  graphileWorkerIds: string[] | null;
  startedAt: Date;
  lastBeatAt: Date;
  stoppedAt: Date | null;
  /** True = the drain did not finish. Null = still running, or predates 0215. */
  stoppedForced: boolean | null;
  health: WorkerHealth;
  uptimeMs: number;
  /** Age of the last beat at read time — the number an operator actually scans for. */
  beatAgeMs: number;
}

/** Announce this process. Returns the minted worker id used by every later call. */
export async function registerWorker(input: {
  /** Which worker this process is. Omitted only by callers that predate the role split. */
  role?: string;
  concurrency: number;
  tasks: string[];
  crontab?: string;
  startedAt?: Date;
}): Promise<string> {
  const workerId = publicId("wrk");
  const now = input.startedAt ?? new Date();
  await systemDb.insert(workerHeartbeats).values({
    workerId,
    hostname: hostname(),
    pid: process.pid,
    role: input.role ?? null,
    concurrency: input.concurrency,
    tasks: input.tasks,
    crontab: input.crontab ?? null,
    startedAt: now,
    lastBeatAt: now,
  });
  // Opportunistic prune — no separate cleanup job for a table that gains one row
  // per deploy. Only rows that stopped cleanly long ago; a crashed row is kept
  // because "it never came back" is the interesting case.
  await systemDb
    .delete(workerHeartbeats)
    .where(
      sql`${workerHeartbeats.stoppedAt} is not null and ${workerHeartbeats.stoppedAt} < now() - ${sql.raw(
        `interval '${Math.round(WORKER_RETENTION_MS / 1000)} seconds'`,
      )}`,
    );
  return workerId;
}

/**
 * Refresh the beat + the running counters. Never throws — a monitoring write must not be
 * able to take the worker down.
 *
 * Returns whether the write LANDED, which `/readyz` uses as its heartbeat check. The
 * alternative was for the probe to re-read this row, but that answers a weaker question:
 * a fresh row proves *some* process is beating, while the return value proves **this**
 * one's own write reached Postgres — and it costs no extra query per probe.
 */
export async function beat(
  workerId: string,
  counters: {
    jobsActive: number;
    jobsSucceeded: number;
    jobsFailed: number;
    /**
     * graphile-worker's in-pool worker ids this process currently owns.
     *
     * Written on every beat rather than once at boot because the pool churns: graphile
     * replaces a worker after a fatal error, and a set captured at startup would slowly
     * drift into naming ids that no longer exist while omitting the ones that do. A stale
     * set here makes `liveGraphileWorkerIds` wrong in the dangerous direction — a live
     * lock read as stranded — so it is refreshed at the same 10s cadence as the beat.
     *
     * Omit (rather than pass `[]`) to leave the column untouched; `[]` asserts "this
     * process holds none", which is a different claim.
     */
    graphileWorkerIds?: string[];
  },
): Promise<boolean> {
  try {
    await systemDb
      .update(workerHeartbeats)
      .set({
        lastBeatAt: new Date(),
        jobsActive: counters.jobsActive,
        jobsSucceeded: counters.jobsSucceeded,
        jobsFailed: counters.jobsFailed,
        ...(counters.graphileWorkerIds ? { graphileWorkerIds: counters.graphileWorkerIds } : {}),
      })
      .where(eq(workerHeartbeats.workerId, workerId));
    return true;
  } catch (e) {
    // Not fatal — a failed heartbeat shows up as a stale row, which is the correct
    // signal anyway, and crashing the clock over it would be worse. But the log
    // line is what distinguishes "the worker died" from "the worker is alive and
    // its heartbeat write is failing", which the stale row alone cannot say.
    log.warn("worker heartbeat write failed", { workerId, error: (e as Error)?.message });
    return false;
  }
}

/**
 * Stamp a shutdown, so the row reads `stopped` rather than `stale`.
 *
 * `forced` records whether the drain actually finished. The stamp itself happens either
 * way — the process is about to be gone, and a row that said `stale` for a shutdown we
 * initiated would be a lie of a different kind — but "exited cleanly" and "we gave up and
 * exited anyway" are different incidents. Conflating them cost real time on 2026-08-29:
 * the panel read "0 stale · 2 stopped" while one of those two had been SIGKILLed mid-job
 * and had stranded a queue lock on the way out.
 */
export async function markWorkerStopped(
  workerId: string,
  opts: { forced: boolean } = { forced: false },
): Promise<void> {
  try {
    await systemDb
      .update(workerHeartbeats)
      .set({ stoppedAt: new Date(), jobsActive: 0, stoppedForced: opts.forced })
      .where(eq(workerHeartbeats.workerId, workerId));
  } catch (e) {
    // Same reasoning as `beat` — best-effort.
    log.warn("worker stop stamp failed", { workerId, error: (e as Error)?.message });
  }
}

/**
 * Was a single worker PROCESS alive for this entire window?
 *
 * The clock's lag guard asks this before calling a gap between ticks an overrun. A
 * gap only means "the clock fell behind" if a worker was actually there to run the
 * ticks it missed; if no process spans the window — a restart, a deploy, a laptop
 * that slept, a verify script running the pipeline with no worker at all — those
 * ticks were never attempted. That's downtime, a different signal (see
 * `startClockTick`).
 *
 * Liveness at the end of the window gets the same `WORKER_STALE_MS` grace used
 * everywhere else, so a process that is merely between beats still counts as up.
 * A crashed worker's `last_beat_at` freezes at the crash, so it correctly stops
 * spanning anything after it.
 */
export async function workerAliveThroughout(from: Date, to: Date): Promise<boolean> {
  const aliveBy = new Date(to.getTime() - WORKER_STALE_MS);
  const [row] = await systemDb
    .select({ workerId: workerHeartbeats.workerId })
    .from(workerHeartbeats)
    .where(
      and(
        lte(workerHeartbeats.startedAt, from),
        // ONLY processes that run the clock. This table holds a row per worker role, and
        // asking "was any worker alive" would let a non-clock process vouch for a billing
        // worker that was down — reporting real billing downtime as a clock overrun, which
        // is a different incident with a different fix. `role is null` covers rows written
        // by builds from before roles existed, where one process did run the clock.
        sql`(${workerHeartbeats.role} is null or ${workerHeartbeats.role} in ('billing', 'all', 'clock'))`,
        // A raw Date inside sql`` reaches the driver unmapped — cast the ISO string.
        sql`coalesce(${workerHeartbeats.stoppedAt}, ${workerHeartbeats.lastBeatAt}) >= ${aliveBy.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  return !!row;
}

function health(row: typeof workerHeartbeats.$inferSelect, now: number): WorkerHealth {
  if (row.stoppedAt) return "stopped";
  return now - row.lastBeatAt.getTime() > WORKER_STALE_MS ? "stale" : "alive";
}

/** Every known worker process, newest boot first, with a derived health verdict. */
export async function listWorkers(limit = 50): Promise<WorkerView[]> {
  const rows = await systemDb
    .select()
    .from(workerHeartbeats)
    .orderBy(desc(workerHeartbeats.startedAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  const now = Date.now();
  return rows.map((r) => ({
    workerId: r.workerId,
    hostname: r.hostname,
    pid: r.pid,
    role: r.role,
    concurrency: r.concurrency,
    tasks: Array.isArray(r.tasks) ? (r.tasks as string[]) : [],
    crontab: r.crontab,
    jobsActive: r.jobsActive,
    jobsSucceeded: r.jobsSucceeded,
    jobsFailed: r.jobsFailed,
    graphileWorkerIds: Array.isArray(r.graphileWorkerIds) ? r.graphileWorkerIds : null,
    startedAt: r.startedAt,
    lastBeatAt: r.lastBeatAt,
    stoppedAt: r.stoppedAt,
    stoppedForced: r.stoppedForced,
    health: health(r, now),
    uptimeMs: (r.stoppedAt ?? new Date(now)).getTime() - r.startedAt.getTime(),
    beatAgeMs: now - r.lastBeatAt.getTime(),
  }));
}

/**
 * Which graphile-worker in-pool ids belong to a process that is still ALIVE.
 *
 * The join that makes stranded-lock recovery safe. graphile-worker keeps no worker
 * registry, so a queue lock's `locked_by` is an opaque string with nothing to check it
 * against; this turns it into a question we can answer — is a live process claiming that
 * id? A lock held by an id NOT in this set is held by nobody.
 *
 * ── `complete` IS THE SAFETY INTERLOCK ────────────────────────────────────────────────
 * `graphile_worker_ids` is NULL on any row written before 0215, and NULL means "this
 * process never told us", NOT "this process holds no locks". Treating the two alike would
 * make the very deploy that introduces the sweep rip live locks off workers still running
 * the old build — turning a recovery mechanism into the outage it exists to prevent.
 *
 * So when ANY live row is NULL we report `complete: false`, and the caller must abstain.
 * Absence of evidence is not evidence of death; the sweep resumes on its own once every
 * live worker has beaten at least once on a build that reports its ids.
 */
export async function liveGraphileWorkerIds(): Promise<{
  ids: Set<string>;
  /** False when a live row has not reported its ids — callers MUST NOT act on `ids`. */
  complete: boolean;
  /** Live rows that could not vouch for themselves, for the log line. */
  unreportedWorkerIds: string[];
}> {
  const live = (await listWorkers(200)).filter((w) => w.health === "alive");
  const unreported = live.filter((w) => w.graphileWorkerIds == null);
  return {
    ids: new Set(live.flatMap((w) => w.graphileWorkerIds ?? [])),
    complete: unreported.length === 0,
    unreportedWorkerIds: unreported.map((w) => w.workerId),
  };
}
