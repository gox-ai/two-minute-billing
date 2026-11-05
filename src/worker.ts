import { EventEmitter } from "node:events";
import type { Runner, WorkerEvents } from "graphile-worker";
import {
  startWorker,
  releaseEnqueuePool,
  crontabFor,
  tasksFor,
  WORKER_CONCURRENCY,
} from "./platform/jobs";
import { config } from "./platform/config";
import { beginShutdown } from "./platform/shutdown";
import { drainJobs } from "./platform/worker-drain";
import { createLogger, flushCloudLogging } from "./platform/logger";
import { loadGeoReference } from "./platform/geo";
import {
  beat,
  markWorkerStopped,
  registerWorker,
  WORKER_BEAT_MS,
  WORKER_STALE_MS,
} from "./modules/ops/heartbeats";
import { releaseStrandedQueueLocks } from "./modules/ops/stranded-locks";
import { trackGraphileLockIds } from "./platform/graphile-lock-ids";
import { startHealthServer, type HealthServer } from "./platform/health";
import { requireCurrentSchema } from "./platform/selfhost/schema-check";

/**
 * Which worker this process is (`--role=`, or `WORKER_ROLE`).
 *
 * `billing` is the billing engine and, since the shadow poller was removed, the only real
 * role; `all` is its alias and stays because it is what local dev and older pm2 configs
 * pass. Kept as a flag rather than hardwired so a future out-of-band role scopes its own
 * tasks and cron lines instead of copy-pasting this entry file — every hole the 2026-08-05
 * robustness review found (the bounded drain, the fatal handlers, the heartbeat) is fixed
 * here once.
 */
const ROLES = ["billing", "all", "clock", "reports", "collect"] as const;
type Role = (typeof ROLES)[number];

function resolveRole(): Role {
  const arg = process.argv
    .slice(2)
    .find((a) => a.startsWith("--role="))
    ?.slice("--role=".length);
  const raw = (arg ?? process.env.WORKER_ROLE ?? "billing").trim();
  if (!(ROLES as readonly string[]).includes(raw)) {
    // Refuse rather than default: a typo'd role that silently fell back would give you
    // two of one process and none of another, with nothing in the logs saying so.
    console.error(`worker: unknown --role='${raw}'. Use one of: ${ROLES.join(" | ")}`);
    process.exit(2);
  }
  return raw as Role;
}

const role = resolveRole();
const log = createLogger(role === "billing" ? "worker" : `worker:${role}`);

const startedAt = new Date();

// ── Process state ────────────────────────────────────────────────────────────
// Declared before the handlers below, because a fatal event during boot would
// otherwise hit these bindings in their temporal dead zone and turn a legible crash
// into a ReferenceError.
let runner: Runner | undefined;
let workerId: string | null = null;
let heartbeat: NodeJS.Timeout | undefined;
let health: HealthServer | null = null;
let stopping = false;
let pump: { done: Promise<void> } | null = null;

/**
 * When this process last got a heartbeat write ACCEPTED by Postgres — the freshness
 * `/readyz` reports.
 *
 * In-process rather than re-read from the row, because `beat` swallows its own errors by
 * design (a monitoring write must not be able to kill the clock). That is right for the
 * clock and wrong for a probe: it means a worker whose every heartbeat is failing looks
 * identical to a healthy one from the inside. This is the value that tells them apart.
 */
let lastBeatOkAt: number | null = null;

// Live counters, mirrored onto the heartbeat row. Kept in-process (not a DB
// increment per job) so job throughput costs no extra writes.
let jobsActive = 0;
let jobsSucceeded = 0;
let jobsFailed = 0;

/**
 * Process memory in MiB for the probes. RSS minus the V8 heap is native memory (driver
 * buffers, malloc arenas); a heap that stays high across nights is a JS leak, not that.
 */
function memoryMiB() {
  const m = process.memoryUsage();
  const mib = (n: number) => Math.round(n / 1048576);
  return {
    rss: mib(m.rss),
    heapUsed: mib(m.heapUsed),
    heapTotal: mib(m.heapTotal),
    external: mib(m.external),
    arrayBuffers: mib(m.arrayBuffers),
  };
}

/** Never rejects (`beat` catches its own errors); awaited only at boot, before the sweep. */
async function publishBeat(): Promise<void> {
  if (!workerId) return;
  // The outcome feeds `/readyz`: a beat that stops landing means this process can no
  // longer write to Postgres, which is a worker that should be taken out of rotation
  // long before its row ages into `stale` on someone's dashboard.
  const ok = await beat(workerId, {
    jobsActive,
    jobsSucceeded,
    jobsFailed,
    graphileWorkerIds: graphileLockIds(),
  });
  if (ok) lastBeatOkAt = Date.now();
}

/**
 * Owned here, not inside `startWorker`, because `worker:create` fires synchronously
 * within `run()`: a listener attached to `runner.events` afterwards misses every worker
 * the pool opened at boot — precisely the ids that must be on our heartbeat row before
 * the stranded-lock sweep runs, or the sweep would see them as unaccounted for.
 */
const workerEvents = new EventEmitter() as WorkerEvents;

// Publish the id set the moment it changes rather than waiting up to WORKER_BEAT_MS.
// The gap matters: between creating an in-pool worker and publishing its id, that worker
// can already have claimed a job and locked its queue — a lock nothing can yet vouch for.
// STRANDED_LOCK_GRACE_MS covers the remaining milliseconds; this keeps them milliseconds.
const graphileLockIds = trackGraphileLockIds(workerEvents, () => void publishBeat());

/**
 * The one way this process exits.
 *
 * Every previous exit path had a hole (2026-08-05 robustness review, findings #4/#5):
 *
 *  - `runner.stop()` waits for in-flight jobs with NO timeout. A tick has no upper
 *    bound, so SIGTERM during a slow one outlived any orchestrator grace period and got
 *    SIGKILLed mid-tick — the worst case, because nothing is stamped and the tick row is
 *    left open. Now the wait is bounded by `WORKER_SHUTDOWN_TIMEOUT_MS` and WE decide.
 *  - If `stop()` REJECTED, the async signal handler rejected unhandled: the heartbeat row
 *    was never stamped and `process.exit` never ran, so the process hung until something
 *    killed it. Now it is caught.
 *  - It exited 0 unconditionally, reporting a shutdown that did not drain as success. A
 *    forced or failed stop now exits non-zero.
 *
 * Idempotent: a second signal (or a fatal error during shutdown) is ignored rather than
 * starting a second teardown.
 */
async function finalize(code: number, reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Before the drain: jobs that check it wind down now rather than at their own budget.
  beginShutdown();
  log.info("worker shutting down", {
    event: "worker_shutdown",
    reason,
    workerId,
    jobsActive,
    jobsSucceeded,
    jobsFailed,
    uptimeMs: Date.now() - startedAt.getTime(),
    shutdownBudgetMs: config.WORKER_SHUTDOWN_TIMEOUT_MS,
  });

  // The heartbeat keeps beating THROUGH the drain and stops only after it. A draining worker
  // still holds its jobs' queue locks; let its row go stale (30 s) and the stranded-lock sweep
  // would call it dead and release a lock mid-job — a second worker would then run it again.

  let forced = false;
  if (runner) {
    const r = runner;
    try {
      const drained = await drainJobs({
        stop: () => r.stop(),
        activeJobs: () => jobsActive,
        budgetMs: config.WORKER_SHUTDOWN_TIMEOUT_MS,
      });
      if (drained === "timeout") {
        forced = true;
        log.error(new Error("graceful shutdown timed out"), {
          event: "shutdown_forced",
          jobsActive,
          budgetMs: config.WORKER_SHUTDOWN_TIMEOUT_MS,
        });
      }
    } catch (e) {
      forced = true;
      log.error(e, { event: "shutdown_failed", stage: "runner.stop" });
    }
  }
  // The pump stops claiming once `beginShutdown` ran; wait for its in-flight charges.
  if (pump) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      pump.done,
      new Promise((r) => (timer = setTimeout(r, config.WORKER_SHUTDOWN_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
  }
  if (heartbeat) clearInterval(heartbeat);

  // AFTER the drain, deliberately. `stopping` flips at the top of this function, so for
  // the whole 25-second drain `/readyz` answers 503 `draining` while `/healthz` stays 200
  // — an orchestrator takes the process out of rotation without also deciding it is
  // wedged and escalating to SIGKILL, which is the exact failure this budget exists to
  // avoid. Closing the listener first would make the same window look like a crash.
  if (health) {
    await health.close();
    health = null;
  }

  // Stamped whether or not the drain succeeded: the row describes THIS PROCESS, and the
  // process is about to be gone either way. (On a forced stop a job may still have been
  // running — its tick row stays open and the dashboard shows it as `abandoned`, which is
  // exactly what happened.) `markWorkerStopped` swallows its own errors by design.
  if (workerId) await markWorkerStopped(workerId, { forced });
  await releaseEnqueuePool();

  // The exit lines above (and the fatal error that got us here) are still queued in
  // the Cloud Logging sink. Ship them before the process is gone — a worker death
  // whose reason never left the box is the whole reason these handlers exist.
  await flushCloudLogging();
  process.exit(forced ? 1 : code);
}

/**
 * Last-resort handlers. An escaped rejection used to terminate the process with a bare
 * stack on stderr: no structured line to alert on, and indistinguishable from a clean
 * exit in a log aggregator. These do not try to continue — state after an escaped throw
 * is unknown — they make the death legible and stamp the heartbeat row on the way out.
 */
process.on("unhandledRejection", (reason) => {
  log.fatal(reason, { event: "unhandled_rejection" });
  void finalize(1, "unhandled rejection");
});
process.on("uncaughtException", (err) => {
  log.fatal(err, { event: "uncaught_exception" });
  void finalize(1, "uncaught exception");
});

// ── Boot ─────────────────────────────────────────────────────────────────────
// Inside a try: with a bare top-level await, a database that is not up yet produced an
// unhandled rejection, a raw stack and exit 1 with no structured line.
await requireCurrentSchema(config.DATABASE_URL, log);
try {
  // The daily cron creates usage partitions, so a missing one means it has not run: make
  // them now, then fail loud if that did not work.
  const { createUpcomingPartitions, requireUsagePartitions } =
    await import("./modules/metering/partitions");
  await createUpcomingPartitions();
  await requireUsagePartitions();
  // Jobs reach tax resolution, which validates `state_code` synchronously against
  // the country reference set — so it has to be in memory before the first job runs.
  await loadGeoReference();
  runner = await startWorker(role, workerEvents);
} catch (e) {
  // NAME THE TARGET. `connect ECONNREFUSED 127.0.0.1:59987` alone says a worker could not
  // reach a database but not WHICH one, and the port is the only clue — so a log export of
  // this line reads as a broken deployment even when it is `verify:worker-lifecycle`
  // deliberately pointing a child at a closed port to prove the boot fails loudly. That cost
  // real investigation on 2026-08-26. Host/port/database only: a connection string carries a
  // password, and this line goes to an aggregator.
  const target = (() => {
    try {
      const u = new URL(config.DATABASE_URL);
      return {
        dbHost: u.hostname,
        dbPort: u.port || "5432",
        dbName: u.pathname.replace(/^\//, ""),
      };
    } catch {
      return { dbHost: null, dbPort: null, dbName: null };
    }
  })();
  log.fatal(e, { event: "worker_boot_failed", role, ...target });
  await flushCloudLogging();
  // A short pause so a crash-loop against an unreachable database backs off a little
  // even under a supervisor that has no backoff of its own.
  await new Promise((r) => setTimeout(r, 2_000));
  process.exit(1);
}

/**
 * Announce this process in `worker_heartbeats` so the ops backoffice can tell a
 * healthy idle worker from a dead one (graphile-worker keeps no worker registry —
 * see the table's comment). Registration failing must NOT stop the clock: the
 * billing engine is the product, the monitoring row is not.
 */
try {
  workerId = await registerWorker({
    role,
    concurrency: WORKER_CONCURRENCY,
    tasks: tasksFor(role),
    crontab: crontabFor(role),
    startedAt,
  });
} catch (e) {
  log.error(e, { stage: "registerWorker", role });
}
if (workerId) lastBeatOkAt = startedAt.getTime();

/**
 * Release queue locks left behind by a worker that died holding them (0215).
 *
 * ── WHY AT BOOT, AND WHY HERE IN THE SEQUENCE ─────────────────────────────────────────
 * A worker killed mid-job leaves `_private_job_queues.locked_at` set forever — graphile's
 * availability rule is `generated always as (locked_at is null)`, with no expiry and no
 * caller for `force_unlock_workers`. Boot is when the replacement process exists and the
 * dead one demonstrably does not, so it is the earliest moment the lock can be proven
 * stale. On 2026-08-29 that proof was available within milliseconds; without this it took
 * 46 minutes and a human.
 *
 * The ORDER is load-bearing. `publishBeat()` must land first: `registerWorker` has just
 * inserted our row with `graphile_worker_ids` NULL, and a live row with NULL ids makes
 * `liveGraphileWorkerIds` report `complete: false` — so sweeping before publishing would
 * make this process abstain on account of itself, every single boot. Publishing first also
 * means our OWN pool's locks are vouched for before anything is considered for release.
 * AWAITED: it was fire-and-forget, the write had not landed when the sweep read, and the
 * sweep abstained on its own worker id at every boot (seen 2026-09-27, twice).
 *
 * Non-fatal by the same rule as `registerWorker` above: the billing engine is the product,
 * the recovery sweep is not. A sweep that cannot run leaves us exactly where we were.
 */
await publishBeat();
try {
  await releaseStrandedQueueLocks();
} catch (e) {
  log.error(e, { stage: "releaseStrandedQueueLocks", role });
}

/**
 * Liveness + readiness over HTTP (RELEASE.md A4).
 *
 * Started AFTER `startWorker` succeeded, so a bound port already means "this process is
 * running the queue" and never merely "the file was executed" — a probe that answers
 * during boot reports a worker as healthy before it can run a single job.
 *
 * `/healthz` checks nothing external and `/readyz` checks everything; the long note in
 * platform/health.ts explains why treating them alike is worse than having neither.
 */
health = await startHealthServer({
  service: role === "billing" ? "worker" : `worker:${role}`,
  host: config.WORKER_HEALTH_HOST,
  port: config.WORKER_HEALTH_PORT,
  identity: () => ({
    role,
    pid: process.pid,
    uptimeMs: Date.now() - startedAt.getTime(),
    // Load-bearing during a rolling restart: it is the number that says whether the
    // drain is still doing something or has simply stalled.
    jobsActive,
    memoryMiB: memoryMiB(),
    ...(workerId ? { workerId } : {}),
  }),
  processReadiness: () => {
    if (stopping) return { ok: false, state: "draining" };
    // A worker whose REGISTRATION failed is still a working billing engine — the same
    // judgement `registerWorker`'s catch makes above. Reporting it permanently unready
    // would take the engine out of rotation over a monitoring row, so the heartbeat
    // check reports `unknown` and abstains rather than voting no.
    if (!workerId) return { ok: true, state: "running", fields: { heartbeat: "unknown" } };
    const beatAgeMs = lastBeatOkAt == null ? null : Date.now() - lastBeatOkAt;
    // The SAME staleness window the ops backoffice uses to call a row dead, so the
    // probe and the dashboard can never disagree about the same process.
    const fresh = beatAgeMs != null && beatAgeMs <= WORKER_STALE_MS;
    return {
      ok: fresh,
      state: fresh ? "running" : "heartbeat_stale",
      fields: { heartbeat: fresh ? "up" : "down", ...(beatAgeMs != null ? { beatAgeMs } : {}) },
    };
  },
});

log.info("worker started (billing clock active)", {
  workerId,
  role,
  pid: process.pid,
  concurrency: WORKER_CONCURRENCY,
  pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
  statementTimeoutMs: config.PG_STATEMENT_TIMEOUT_MS ?? null,
  healthPort: health?.port ?? null,
  scanLimit: config.TICK_SCAN_LIMIT,
  tasks: tasksFor(role),
  crontab: crontabFor(role),
});

// Batch-numbered renewal invoices are charged by the pump, not by queued jobs. A billing worker
// runs it even with batch numbering off, polling once a minute, so invoices queued before the
// flag was switched off are still charged.
if (role === "collect" || role === "billing" || role === "all") {
  const { startCollectionPump } = await import("./modules/subscriptions/collect-pump");
  pump = startCollectionPump(config.COLLECT_LANES ?? WORKER_CONCURRENCY, {
    idleMs: role === "collect" || config.RENEWAL_BATCH_NUMBERING === "TRUE" ? 1000 : 60_000,
  });
}

// For pm2's `wait_ready` (the cluster config): the old worker is stopped only once this one is
// running the queue, so a restart never leaves the clock without a process. No-op without IPC.
process.send?.("ready");

/**
 * Job lifecycle logging. Every line carries the traceId the task established
 * (`tracedTask`), so a slow tick and the invoices it produced share one id.
 * Start/finish are `debug` — at one tick a minute, logging both at info would
 * bury real signal — while a permanent failure is `error`, because a job that has
 * exhausted its retries is a thing an operator must see.
 */
const startedAtByJob = new Map<string, { at: number; rss: number }>();

/**
 * A job that raises RSS by this much is logged at info, naming it. glibc keeps what a job
 * frees, so the worker's RSS settles at its worst job's peak; this says which job that is.
 */
const JOB_RSS_GROWTH_LOG_BYTES = 100 * 1048576;

runner.events.on("job:start", ({ job }) => {
  jobsActive++;
  startedAtByJob.set(job.id, { at: Date.now(), rss: process.memoryUsage.rss() });
  // `attempts` ALREADY counts this attempt — graphile-worker's getJob does
  // `attempts = attempts + 1` when it claims the row — so it is the attempt
  // number as-is. Adding one would report a first run as "attempt 2".
  log.debug("job started", {
    jobId: job.id,
    task: job.task_identifier,
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
  });
});

runner.events.on("job:success", ({ job }) => {
  jobsSucceeded++;
  const began = startedAtByJob.get(job.id)?.at;
  log.debug("job succeeded", {
    jobId: job.id,
    task: job.task_identifier,
    ...(began ? { durationMs: Date.now() - began } : {}),
  });
});

runner.events.on("job:error", ({ job, error }) => {
  // Retries remain — a transient failure, not yet an incident.
  log.warn("job failed, will retry", {
    jobId: job.id,
    task: job.task_identifier,
    attempt: job.attempts,
    maxAttempts: job.max_attempts,
    error: error instanceof Error ? error.message : String(error),
  });
});

runner.events.on("job:failed", ({ job, error }) => {
  jobsFailed++;
  // Terminal: graphile-worker will not try again. This is the alerting line.
  log.error(error, {
    event: "job_failed_permanently",
    jobId: job.id,
    task: job.task_identifier,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
  });
});

runner.events.on("job:complete", ({ job }) => {
  jobsActive = Math.max(0, jobsActive - 1);
  const began = startedAtByJob.get(job.id);
  startedAtByJob.delete(job.id);
  if (!began) return;
  const rss = process.memoryUsage.rss();
  if (rss - began.rss < JOB_RSS_GROWTH_LOG_BYTES) return;
  // Other jobs may have run alongside, so `jobsActive` says how clean the attribution is.
  log.info("job raised worker memory", {
    event: "job_rss_growth",
    jobId: job.id,
    task: job.task_identifier,
    durationMs: Date.now() - began.at,
    rssBeforeMiB: Math.round(began.rss / 1048576),
    rssAfterMiB: Math.round(rss / 1048576),
    jobsActive,
    memoryMiB: memoryMiB(),
  });
});

/**
 * The event that means "this worker is dying" — graphile-worker emits it when it cannot
 * even record a job's outcome, and the runner stops afterwards. It was previously
 * unobserved, so the one signal distinguishing "the queue broke" from "the process was
 * asked to stop" was logged only by graphile's own console logger.
 */
runner.events.on("worker:fatalError", ({ error, jobError }) => {
  log.fatal(error, {
    event: "worker_fatal_error",
    ...(jobError
      ? { jobError: jobError instanceof Error ? jobError.message : String(jobError) }
      : {}),
  });
  void finalize(1, "worker fatal error");
});

// A listen failure degrades the worker to polling rather than killing it, so this is a
// warning — but an invisible one is how "jobs are slow since the network blip" happens.
runner.events.on("pool:listen:error", ({ error }) => {
  log.warn("queue LISTEN connection failed — falling back to polling", {
    event: "pool_listen_error",
    error: error instanceof Error ? error.message : String(error),
    pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
  });
});

// Cron misfires are the failure mode that silently stops billing: the timer fired
// late (overloaded box, VM suspended) or early (clock adjusted). Both are worth a
// line, since a skipped window means renewals that never ran.
runner.events.on("cron:overdueTimer", ({ currentTimestamp, expectedTimestamp }) => {
  log.warn("cron timer overdue — the schedule fired late", {
    lateByMs: currentTimestamp - expectedTimestamp,
    expected: new Date(expectedTimestamp).toISOString(),
  });
});

runner.events.on("cron:prematureTimer", ({ currentTimestamp, expectedTimestamp }) => {
  log.warn("cron timer premature — system clock moved backwards", {
    earlyByMs: expectedTimestamp - currentTimestamp,
    expected: new Date(expectedTimestamp).toISOString(),
  });
});

heartbeat = setInterval(() => void publishBeat(), WORKER_BEAT_MS);
// Don't let the heartbeat alone hold the event loop open on shutdown.
heartbeat.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void finalize(0, `${sig} received`));
}

// The runner's promise rejects when the worker dies for a reason `worker:fatalError`
// did not already cover; awaiting it bare made that an unhandled rejection.
try {
  await runner.promise;
  await finalize(0, "runner stopped on its own");
} catch (e) {
  log.fatal(e, { event: "runner_failed" });
  await finalize(1, "runner failed");
}
