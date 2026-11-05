/**
 * Stranded queue-lock recovery — the fix for the 46-minute outage of 2026-08-29.
 *
 *   pnpm verify:stranded-locks
 *
 * ── WHAT THIS SUITE IS ACTUALLY GUARDING ─────────────────────────────────────────────
 * The mechanism has two halves and they fail in opposite directions:
 *
 *   1. It must RELEASE a lock whose holder is dead. Failing to is the outage itself —
 *      graphile-worker expires no queue lock, so a missed release is permanent.
 *   2. It must NEVER release a lock whose holder is alive. The queue lock is the only
 *      thing serializing the billing clock; breaking one while a tick is genuinely
 *      running starts a second tick against the same subscriptions.
 *
 * (2) is the one that cannot be allowed to regress quietly, because nothing observable
 * goes wrong until the day two ticks renew the same customer. So the liveness checks are
 * MUTATION-TESTED below: the suite re-runs them against a deliberately broken predicate
 * and fails if the assertion still passes. A safety check that cannot fail is decoration.
 *
 * Runs against the real `graphile_worker` tables (via `db:bootstrap`), on a queue name no
 * task uses, and cleans up after itself.
 */
import { sql } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { workerHeartbeats } from "@db/schema";
import { eq } from "drizzle-orm";
import { publicId } from "@/platform/ids";
import {
  findStrandedQueueLocks,
  releaseStrandedQueueLocks,
  STRANDED_LOCK_GRACE_MS,
} from "@/modules/ops/stranded-locks";
import { liveGraphileWorkerIds } from "@/modules/ops/heartbeats";
import { EventEmitter } from "node:events";
import { run, type WorkerEvents } from "graphile-worker";
import { config } from "@/platform/config";
import { trackGraphileLockIds } from "@/platform/graphile-lock-ids";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

// A queue name no real task uses, so a developer box running `pnpm worker` alongside this
// suite can neither be disturbed by it nor make it flap. The 2026-08-29 tick ran on
// `billing_clock`; touching that here would be testing on the patient.
const TEST_QUEUE = "verify_stranded_locks";
const DEAD_WORKER = "worker-verifydeadbeef00000";
const LIVE_WORKER = "worker-verifyalive00000000";

/** Put a lock on the test queue, aged far enough back to clear the grace window. */
async function lockQueue(lockedBy: string, ageMs: number): Promise<void> {
  await systemDb.execute(sql`
    insert into graphile_worker._private_job_queues (queue_name, locked_at, locked_by)
    values (${TEST_QUEUE}, now() - make_interval(secs => ${Math.round(ageMs / 1000)}), ${lockedBy})
    on conflict (queue_name) do update
      set locked_at = excluded.locked_at, locked_by = excluded.locked_by
  `);
}

async function queueLockedBy(): Promise<string | null> {
  const rows = (await systemDb.execute(sql`
    select locked_by from graphile_worker._private_job_queues where queue_name = ${TEST_QUEUE}
  `)) as unknown as Array<{ locked_by: string | null }>;
  return rows[0]?.locked_by ?? null;
}

async function cleanup(workerRowIds: string[]): Promise<void> {
  await systemDb.execute(sql`
    delete from graphile_worker._private_job_queues where queue_name = ${TEST_QUEUE}
  `);
  for (const id of workerRowIds) {
    await systemDb.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, id));
  }
}

const created: string[] = [];

/**
 * A live heartbeat row that REPORTS its pool ids.
 *
 * Every live row must report, or `liveGraphileWorkerIds` returns `complete: false` and the
 * sweep abstains — which is correct behaviour but would make every assertion below vacuous.
 * A developer box running `pnpm worker` on a build from before 0215 would do exactly that,
 * so the suite states its precondition rather than silently passing on an abstention.
 */
async function seedLiveWorker(graphileIds: string[]): Promise<string> {
  const workerId = publicId("wrk");
  const now = new Date();
  await systemDb.insert(workerHeartbeats).values({
    workerId,
    hostname: "verify-stranded-locks",
    pid: process.pid,
    role: "billing",
    concurrency: 1,
    tasks: [],
    graphileWorkerIds: graphileIds,
    startedAt: now,
    lastBeatAt: now,
  });
  created.push(workerId);
  return workerId;
}

try {
  // ── (1) The precondition ───────────────────────────────────────────────────────────
  await seedLiveWorker([LIVE_WORKER]);
  const live = await liveGraphileWorkerIds();
  ok("every live worker reports its pool ids (else the sweep abstains)", live.complete);
  ok("…and the seeded id is in the live set", live.ids.has(LIVE_WORKER));
  ok("…while a dead worker's id is not", !live.ids.has(DEAD_WORKER));

  if (!live.complete) {
    // Refuse to report green on an abstention. A suite whose subject declined to run is
    // not a passing suite, and this is precisely the failure the interlock exists to cause.
    console.error(
      "\n⚠  A live worker_heartbeats row has NULL graphile_worker_ids — the sweep abstains and\n" +
        "   every assertion below would be vacuous. Restart local workers on a build with 0215.\n" +
        `   Unreported: ${live.unreportedWorkerIds.join(", ")}`,
    );
    await cleanup(created);
    await closeDb();
    process.exit(1);
  }

  // ── (2) A lock held by a LIVE worker is untouchable ────────────────────────────────
  // The safety property. Asserted BEFORE the release path, so a bug that releases
  // everything cannot be masked by the dead-lock test passing for the wrong reason.
  await lockQueue(LIVE_WORKER, 2 * STRANDED_LOCK_GRACE_MS);
  const liveFound = await findStrandedQueueLocks();
  ok(
    "a lock held by a LIVE worker is never stranded, however old",
    !liveFound.some((l) => l.queueName === TEST_QUEUE),
  );
  await releaseStrandedQueueLocks();
  ok("…and survives a full sweep", (await queueLockedBy()) === LIVE_WORKER);

  // ── (3) A lock held by a DEAD worker is found and released ─────────────────────────
  await lockQueue(DEAD_WORKER, 2 * STRANDED_LOCK_GRACE_MS);
  const deadFound = await findStrandedQueueLocks();
  const mine = deadFound.find((l) => l.queueName === TEST_QUEUE);
  ok("a lock held by a DEAD worker is detected", mine != null);
  ok("…and names its holder", mine?.lockedBy === DEAD_WORKER);
  ok("…and reports an age", (mine?.ageMs ?? 0) >= STRANDED_LOCK_GRACE_MS);

  const released = await releaseStrandedQueueLocks();
  ok(
    "…and the sweep releases it",
    released.released.some((l) => l.queueName === TEST_QUEUE),
  );
  ok("…leaving the queue claimable again", (await queueLockedBy()) === null);

  // ── (4) The grace window ───────────────────────────────────────────────────────────
  // Not a timeout — identity is what authorises a release — but a lock younger than the
  // grace is not even a candidate, which is what covers the milliseconds between a worker
  // creating an in-pool worker and publishing its id.
  await lockQueue(DEAD_WORKER, 0);
  const fresh = await findStrandedQueueLocks();
  ok(
    "a FRESH lock is left alone even when its holder is unknown",
    !fresh.some((l) => l.queueName === TEST_QUEUE),
  );
  ok("…and survives the sweep", (await queueLockedBy()) === DEAD_WORKER);

  // ── (5) The abstention interlock ───────────────────────────────────────────────────
  // A live row that has NOT reported its ids must stop the sweep entirely. Without this,
  // the deploy that introduces 0215 would rip live locks off workers still running the
  // old build — the recovery mechanism causing the outage it exists to prevent.
  const silentWorker = publicId("wrk");
  const now = new Date();
  await systemDb.insert(workerHeartbeats).values({
    workerId: silentWorker,
    hostname: "verify-stranded-locks-silent",
    pid: process.pid,
    role: "billing",
    concurrency: 1,
    tasks: [],
    graphileWorkerIds: null, // the pre-0215 shape
    startedAt: now,
    lastBeatAt: now,
  });
  created.push(silentWorker);

  await lockQueue(DEAD_WORKER, 2 * STRANDED_LOCK_GRACE_MS);
  const abstained = await liveGraphileWorkerIds();
  ok("a live row with NULL pool ids makes liveness incomplete", !abstained.complete);
  ok(
    "…and names the row that could not vouch for itself",
    abstained.unreportedWorkerIds.includes(silentWorker),
  );
  ok("…so the sweep finds nothing", (await findStrandedQueueLocks()).length === 0);
  await releaseStrandedQueueLocks();
  ok("…and releases nothing, even a provably dead lock", (await queueLockedBy()) === DEAD_WORKER);

  // ── (6) MUTATION TEST ──────────────────────────────────────────────────────────────
  // Both safety checks above assert a NEGATIVE ("nothing was released"), and a negative
  // passes just as happily when the code under test is a no-op — a broken query, a renamed
  // internal table, a typo'd queue name would all still be green. So: prove the fixture
  // can go red. With the interlock satisfied and a genuinely dead holder, the same setup
  // MUST release. If this fails, every "nothing was released" check above is worthless.
  await systemDb.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, silentWorker));
  const afterMutation = await releaseStrandedQueueLocks();
  ok(
    "MUTATION: with the interlock satisfied, the very same lock IS released",
    afterMutation.released.some((l) => l.queueName === TEST_QUEUE) &&
      (await queueLockedBy()) === null,
  );

  // ── (7) THE REAL LOCK ──────────────────────────────────────────────────────────────
  // Every case above writes `locked_by` by hand. Here graphile-worker writes it: since 0.17
  // that is the POOL's id, and a mapping that published only in-pool worker ids would match
  // no lock and release every held one. A job on the test queue blocks while we look; the
  // lock it takes must be one `trackGraphileLockIds` publishes.
  {
    const events = new EventEmitter() as WorkerEvents;
    const ids = trackGraphileLockIds(events, () => {});
    let releaseJob = () => {};
    const held = new Promise<void>((r) => (releaseJob = r));
    let markStarted = () => {};
    const started = new Promise<void>((r) => (markStarted = r));
    const runner = await run({
      connectionString: config.DATABASE_URL,
      concurrency: 1,
      pollInterval: 200,
      noHandleSignals: true,
      events,
      taskList: {
        verify_stranded_locks_hold: async () => {
          markStarted();
          await held;
        },
      },
    });
    try {
      await runner.addJob("verify_stranded_locks_hold", {}, { queueName: TEST_QUEUE });
      const ran = await Promise.race([
        started.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
      ]);
      const lockedBy = await queueLockedBy();
      ok("REAL LOCK: graphile-worker ran the job and locked the queue", ran && lockedBy != null);
      ok(
        `REAL LOCK: …under an id this process publishes (${lockedBy})`,
        lockedBy != null && ids().includes(lockedBy),
      );
      const vouching = await seedLiveWorker(ids());
      // Age the real lock past the grace window, keeping its holder.
      await systemDb.execute(sql`
        update graphile_worker._private_job_queues
           set locked_at = now() - make_interval(secs => ${Math.round((2 * STRANDED_LOCK_GRACE_MS) / 1000)})
         where queue_name = ${TEST_QUEUE}`);
      const strandedNow = async () =>
        (await findStrandedQueueLocks()).some((l) => l.queueName === TEST_QUEUE);
      ok("REAL LOCK: a lock its live holder vouches for is not stranded", !(await strandedNow()));
      await systemDb.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, vouching));
      ok("REAL LOCK: …and is stranded once no live row vouches for it", await strandedNow());
    } finally {
      releaseJob();
      await runner.stop();
    }
  }
} finally {
  await cleanup(created);
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? `✅ STRANDED LOCKS: PASS (${checks.length} checks)` : `❌ STRANDED LOCKS: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
