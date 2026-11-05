import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { liveGraphileWorkerIds } from "./heartbeats";
import { createLogger } from "@/platform/logger";

const log = createLogger("ops.stranded-locks");

/**
 * Stranded queue-lock detection and recovery — the fix for the 2026-08-29 outage.
 *
 * ── THE FAILURE THIS EXISTS FOR ───────────────────────────────────────────────────────
 * graphile-worker serializes a named queue (`?queue=billing_clock`) by locking a row in
 * `_private_job_queues`. Completing a job clears that lock in the same atomic statement
 * that deletes the job. Kill the process in between — SIGKILL, OOM, a supervisor that
 * treekills faster than our drain budget — and the lock survives its holder.
 *
 * It then survives FOREVER. The availability rule is `generated always as (locked_at is
 * null)`; there is no expiry, and nothing in the library calls `force_unlock_workers`.
 * On 2026-08-29 that turned a 250ms process kill into 46 minutes of no billing, with every
 * health signal green: the replacement worker was alive and draining every OTHER queue, so
 * "worker alive: yes, tick running: no" was the only hint, and it reads as a paradox.
 *
 * This module makes that self-healing. It is deliberately NOT a timeout — a lock is
 * released only once its holder is proven dead.
 *
 * ── WHY NOT JUST AGE THE LOCK OUT ─────────────────────────────────────────────────────
 * The obvious fix — "release any lock older than N minutes" — is the one that can
 * double-bill. The queue lock is the ONLY thing serializing ticks; break it while a tick
 * is genuinely running and two ticks renew the same subscription. There is no safe N,
 * because the code that sets N cannot know whether a slow tick is slow or gone.
 *
 * So the test is identity, not age: `locked_by` names a graphile worker pool (0.17+) or in-pool
 * worker (0.16), and `liveGraphileWorkerIds()` says which ids belong to processes currently
 * beating. A lock held by an id no live process claims cannot be interrupting anything. Age
 * enters only as a grace period against the reporting race below, never as the reason to release.
 */

/**
 * How long a lock must have been held before it is even a CANDIDATE.
 *
 * Not a timeout — the identity test above is what authorizes a release. This closes one
 * narrow race: a worker creates an in-pool worker and claims a job in the milliseconds
 * before its next heartbeat publishes that id, during which a live lock could look
 * unclaimed. Five minutes is far longer than the 10s beat cadence, and still 9× faster
 * than the incident it replaces.
 */
export const STRANDED_LOCK_GRACE_MS = 5 * 60_000;

export interface StrandedLock {
  queueName: string;
  /** The graphile in-pool worker id still named on the row — a process that is gone. */
  lockedBy: string;
  lockedAt: Date;
  ageMs: number;
  /** Jobs queued behind it that cannot be claimed until it is released. */
  blockedJobs: number;
}

const ABSTAIN_WARN_EVERY_MS = 60 * 60 * 1000;
let lastAbstainWarnAt: number | null = null;

/**
 * Queue locks whose holder is not alive.
 *
 * Returns `[]` — never a guess — when liveness cannot be established (`complete: false`,
 * i.e. some live worker predates 0215 and has not reported its ids). Abstaining is the
 * only safe answer there: the alternative reads "no live process claims this id" from a
 * process that was never asked, which is how a recovery sweep becomes an outage.
 */
export async function findStrandedQueueLocks(
  graceMs: number = STRANDED_LOCK_GRACE_MS,
): Promise<StrandedLock[]> {
  const live = await liveGraphileWorkerIds();
  if (!live.complete) {
    // The sweep runs every 5 minutes and this condition lasts as long as that worker does:
    // warn when it starts, then at most hourly.
    const now = Date.now();
    const fields = {
      event: "stranded_lock_sweep_abstained",
      unreportedWorkerIds: live.unreportedWorkerIds,
    };
    if (lastAbstainWarnAt === null || now - lastAbstainWarnAt >= ABSTAIN_WARN_EVERY_MS) {
      lastAbstainWarnAt = now;
      log.warn(
        "stranded-lock sweep abstained — a live worker has not reported its pool ids",
        fields,
      );
    } else {
      log.debug(
        "stranded-lock sweep abstained — a live worker has not reported its pool ids",
        fields,
      );
    }
    return [];
  }
  lastAbstainWarnAt = null;

  // `_private_job_queues` is internal, but it is the only place the queue lock exists —
  // the public `jobs` view exposes the JOB's lock, not the QUEUE's, and the two are what
  // this incident proved can disagree. Read defensively for the same reason `queue.ts`
  // guards `_private_known_crontabs`: a schema change upstream must degrade to "found
  // nothing", never take the worker's boot down with it.
  let rows: Array<{
    queue_name: string;
    locked_by: string | null;
    locked_at: string;
    age_ms: string;
    blocked_jobs: number;
  }>;
  try {
    rows = (await systemDb.execute(sql`
      select jq.queue_name                                             as queue_name,
             jq.locked_by                                              as locked_by,
             jq.locked_at                                              as locked_at,
             (extract(epoch from (now() - jq.locked_at)) * 1000)::bigint as age_ms,
             (select count(*)::int
                from graphile_worker.jobs j
               where j.queue_name = jq.queue_name
                 and j.locked_at is null
                 and j.run_at <= now())                                as blocked_jobs
        from graphile_worker._private_job_queues jq
       where jq.locked_at is not null
         and jq.locked_at < now() - make_interval(secs => ${Math.round(graceMs / 1000)})
      union all
      -- Jobs outside any named queue (a fanned-out renewal) lock only themselves, so a worker
      -- that died holding just those shows up nowhere above, and graphile frees them only after
      -- 4 hours. Reported as one row per dead worker, its job count as blocked_jobs.
      select '(no queue)', j.locked_by, min(j.locked_at),
             (extract(epoch from (now() - min(j.locked_at))) * 1000)::bigint, count(*)::int
        from graphile_worker._private_jobs j
       where j.job_queue_id is null
         and j.locked_at is not null
         and j.locked_at < now() - make_interval(secs => ${Math.round(graceMs / 1000)})
       group by j.locked_by
       order by 3 asc
    `)) as unknown as typeof rows;
  } catch (e) {
    log.warn("could not read graphile-worker queue locks", {
      event: "stranded_lock_read_failed",
      error: (e as Error)?.message,
    });
    return [];
  }

  return rows
    .filter((r) => r.locked_by != null && !live.ids.has(r.locked_by))
    .map((r) => ({
      queueName: r.queue_name,
      lockedBy: r.locked_by as string,
      lockedAt: new Date(r.locked_at),
      ageMs: Number(r.age_ms),
      blockedJobs: Number(r.blocked_jobs),
    }));
}

export interface StrandedLockRelease {
  released: StrandedLock[];
  /** The dead in-pool worker ids handed to `force_unlock_workers`. */
  workerIds: string[];
}

/**
 * Release every queue lock whose holder is proven dead. Safe to call concurrently and on
 * every boot; a no-op when nothing is stranded.
 *
 * Uses graphile-worker's own `force_unlock_workers`, which clears `locked_at`/`locked_by`
 * on `_private_jobs` AND `_private_job_queues` for those ids — rather than writing to the
 * internal tables ourselves, so an upstream change to the locking model breaks loudly at
 * the function signature instead of silently corrupting queue state.
 *
 * It does NOT delete the job the dead worker was running. Its outcome is genuinely unknown
 * — on 2026-08-29 the tick had finished its work and only the bookkeeping was lost, but
 * that is not knowable from here — so it is left to surface as `abandoned`/`failed` in the
 * ops panel for a human. Silently deleting evidence of an incident is how the next one gets
 * misdiagnosed.
 */
export async function releaseStrandedQueueLocks(
  graceMs: number = STRANDED_LOCK_GRACE_MS,
): Promise<StrandedLockRelease> {
  const stranded = await findStrandedQueueLocks(graceMs);
  if (stranded.length === 0) return { released: [], workerIds: [] };

  const workerIds = [...new Set(stranded.map((s) => s.lockedBy))];

  // `array[$1, $2, …]`, NOT `${workerIds}::text[]`.
  //
  // Interpolating the JS array directly binds it as a SCALAR — postgres.js hands the driver
  // the bare string `worker-abc`, and Postgres rejects it with `malformed array literal`
  // ("Array value must start with {"). So the release throws EVERY time it has something to
  // release, while the no-op path — the one that runs on every healthy boot and every
  // 5-minute sweep — passes happily, because it returns before reaching this line.
  //
  // That is the worst possible shape for a recovery mechanism: green until the day it
  // matters, and then swallowed by the caller's catch as one line in a log nobody reads.
  // `verify:stranded-locks` is what caught it; keep that suite exercising the RELEASE path,
  // not just detection.
  const idList = sql.join(
    workerIds.map((id) => sql`${id}`),
    sql`, `,
  );
  await systemDb.execute(
    sql`select graphile_worker.force_unlock_workers(array[${idList}]::text[])`,
  );

  // `error` level, deliberately: this is a successful recovery, but it only ever runs
  // because a worker died holding a lock — which is an incident that happened whether or
  // not anyone noticed. A silent self-heal would let a supervisor that hard-kills the
  // worker on every deploy stay invisible indefinitely.
  log.error(new Error("released stranded queue lock(s) left by a dead worker"), {
    event: "stranded_lock_released",
    queues: stranded.map((s) => s.queueName),
    workerIds,
    oldestAgeMs: Math.max(...stranded.map((s) => s.ageMs)),
    blockedJobs: stranded.reduce((n, s) => n + s.blockedJobs, 0),
  });

  return { released: stranded, workerIds };
}
