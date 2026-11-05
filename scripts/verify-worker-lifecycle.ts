/**
 * Worker PROCESS lifecycle (2026-08-05 robustness review, findings #2/#4/#5).
 *
 * Everything here needs a real process, so it spawns one: an in-process test cannot
 * observe SIGTERM handling, an exit code, or a boot that fails before the first line of
 * our own code. Spawned as `node --import tsx src/worker.ts` deliberately — going through
 * `pnpm`/`tsx`'s CLI wrapper puts a parent process between us and the worker, and the
 * signal we are testing would be delivered to the wrapper instead.
 *
 * `verify:robustness` covers the HTTP surface; this covers the process.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { parseCrontab } from "graphile-worker";
import { systemDb, closeDb } from "@/platform/db";
import { emailMessages, workerHeartbeats } from "@db/schema";
import { config } from "@/platform/config";
import { publicId } from "@/platform/ids";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { WORKER_CRONTAB, TICK_PASSES } from "@/platform/jobs";
import { asTeamMembers } from "./lib/team-addresses";

/**
 * Child mode: `TICK_SCAN_LIMIT` is read at import time, so the bounded-pass behaviour can
 * only be exercised in a process started with a different value. Re-executing THIS file
 * keeps the fixture and the assertion in one place instead of a second committed script.
 */
if (process.env.TMB_CAP_CHILD) {
  const { deliverPendingEmails } = await import("@/modules/emails/outbox");
  const { runWithClockScope } = await import("@/platform/clock");
  const { setMailer } = await import("@/providers/mailer");
  // This section measures the SCAN CAP, not delivery. The fixture business has no transport of
  // its own, and such a business no longer falls through to the deployment mailer — it refuses
  // the send — so without a stand-in every row would stay `pending` and the two assertions
  // below would be reporting a refused send instead of the limit they exist to test.
  setMailer({
    kind: "console",
    /** In-process fake: reaches no network, so it can never be circuit-broken. */
    target: null,
    async send() {
      return { providerMessageId: null, status: "sent" as const };
    },
  });
  // Scoped to the fixture's OWN business (`TMB_CAP_BIZ`), because the email pass scans
  // system-wide: with TICK_SCAN_LIMIT=1 an older pending row from any earlier suite
  // steals the single slot, our two rows go untouched, and three assertions fail on a
  // shared DB while passing on a fresh one. `scanBusinessFilterNullable` narrows the
  // scan to `business_id = <ours>` under a travel scope — the same seam Time Travel
  // uses — so the cap now bites on exactly the two rows this section inserted.
  const r = await runWithClockScope({ onlyBusinessId: process.env.TMB_CAP_BIZ! }, () =>
    deliverPendingEmails(new Date()),
  );
  console.log(
    `__CAP__${JSON.stringify({ attempted: r.attempted, capped: !!r.capped, limit: config.TICK_SCAN_LIMIT })}`,
  );
  await closeDb();
  process.exit(0);
}

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── (0) Finding #2, checked with graphile-worker's OWN parser ─────────────────
//
// The options are what make cron ticks single-flight, and they are easy to drop while
// editing the string. Asserting on the parsed result (not on a substring) is what
// actually guarantees the scheduler inserts jobs with a queue name and no retries — a
// comment in jobs.ts once claimed serialization came from the task name, and it did not.
const [cronItem] = parseCrontab(WORKER_CRONTAB);
ok("cron ticks are serialized on a named queue", cronItem?.options.queueName === "billing_clock");
ok(
  "…and are never retried (cron re-enqueues every 60s, so a retry is duplication)",
  cronItem?.options.maxAttempts === 1,
);
// The enqueue-side twin of maxAttempts=1, and the same argument: a pending tick is
// redundant, because every pass scans as of the instant it RUNS rather than the job's
// run_at. Without a jobKey the queue is unbounded whenever a tick outlives its own 60s
// cadence — 1,456 queued ticks, oldest 24h old, measured 2026-09-01 while one unreachable
// SMTP host held every tick at 115s. Asserted on the PARSED option for the reason stated
// above: an option is easy to drop while editing the string, and a substring check would
// not notice `jobKeyMode` drifting off `replace`, which is what makes the pending row be
// updated in place rather than added to.
ok(
  "…and never stack duplicates (jobKey caps the queue at one running + one waiting)",
  cronItem?.options.jobKey === "billing_clock_tick",
);
ok(
  "…replacing the pending tick rather than queueing another",
  cronItem?.options.jobKeyMode === "replace",
);
ok("…for the billing_clock_tick task", cronItem?.task === "billing_clock_tick");

// ── (0b) Egress lanes (phase 1) ──────────────────────────────────────────────
//
// The isolation these buy is the QUEUE NAME, not a separate process: graphile serializes
// within a named queue and runs different queues concurrently, so a mail drain that runs
// long occupies `egress_email` and cannot delay a renewal on `billing_clock`. Asserted on
// the parsed options for the same reason as the tick above — an option is easy to drop
// while editing the string, and a `queue=` that silently reverted to NULL would put egress
// back in the billing lane while every other check here still passed.
const byTask = new Map(parseCrontab(WORKER_CRONTAB).map((c) => [c.task, c]));
for (const [task, queue] of [
  ["email_outbox_nudge", "egress_email"],
  ["webhook_outbox_nudge", "egress_webhook"],
  // Completing a support 2FA reset sends mail, so it gets a lane of its own too.
  ["security_sweep", "security"],
  // Usage metering: the fold on its own lane, partition upkeep and the notice on another.
  ["usage_fold", "usage_rollups"],
  ["usage_partitions", "usage_maintenance"],
  ["usage_unmatched_notice", "usage_maintenance"],
  // Usage controls on arrival: no network call, but never the billing lane.
  ["usage_controls_check", "usage_controls"],
  // Plan credit windows (G3b): never the billing lane.
  ["plan_credit_resets", "plan_credit_resets"],
  // The model price fetch and its mail: a network call, so never the billing lane.
  ["model_prices_sync", "model_prices"],
  ["model_price_notices", "model_prices"],
] as const) {
  const item = byTask.get(task);
  ok(`${task} is scheduled`, !!item);
  ok(`…on its own lane (${queue}), not the billing one`, item?.options.queueName === queue);
  ok(`…and cannot stack a backlog (jobKey)`, item?.options.jobKey === task);
  ok(
    `…with no retries (every drain re-scans, so a retry is duplication)`,
    item?.options.maxAttempts === 1,
  );
}

// The two heavy metric jobs take turns on one lane: run together, glibc keeps their summed
// peak as worker RSS. Neither may land on the billing lane.
for (const task of ["metric_daily_current", "metric_windows_refresh"]) {
  const item = byTask.get(task);
  ok(`${task} runs on the shared metrics_live lane`, item?.options.queueName === "metrics_live");
  ok(`…and cannot stack a backlog (jobKey)`, item?.options.jobKey === task);
}

// ── (0c) The tick's pass list is a declared allowlist ────────────────────────
//
// `TICK_PASSES` is enforced from both ends: `runPass` refuses a name that is not on it, and
// this asserts the array matches the `runPass` calls in the source EXACTLY — same members,
// same order. Either half alone leaves a gap. The runtime guard cannot notice a pass that
// was declared and then deleted; a source scan cannot notice one added dynamically.
//
// The point is not that the list is correct. It is that a pass cannot be added by ACCIDENT:
// the build fails until someone edits the array, and editing it is where "does this pass
// make a network call?" gets asked. That question, unasked, is the whole of the 2026-09-01
// incident.
//
// ORDER is asserted too, not just membership. Passes draw down one sweep-wide budget in this
// order and whatever it does not reach is `skipped`, so moving a GC pass ahead of the one
// that releases money held at a gateway is a real regression that membership alone misses.
const tickSrc = await readFile("src/platform/jobs.ts", "utf8");
const tickBody = tickSrc.slice(
  tickSrc.indexOf("export async function runBillingClockTickOnce"),
  tickSrc.indexOf("export const WORKER_CRONTAB"),
);
const inSource = [...tickBody.matchAll(/runPass\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]!);
ok(
  "every tick pass is declared in TICK_PASSES",
  inSource.every((n) => TICK_PASSES.includes(n as never)),
);
ok(
  "…and every declared pass is actually run",
  TICK_PASSES.every((n) => inSource.includes(n)),
);
ok(
  "…in the declared order (the budget sheds from the tail, so order is a priority list)",
  inSource.join(",") === TICK_PASSES.join(","),
);

// Named explicitly, on top of the allowlist above, because these two are the regression the
// list exists to prevent and a named assertion says so where a membership failure would not.
// The coupling that caused the 2026-09-01 incident is otherwise invisible to a suite — a
// slow mail server is not something a test reproduces by accident.
ok(
  "the billing tick runs neither egress pass",
  !inSource.includes("email_outbox") && !inSource.includes("webhook_outbox"),
);

const WORKER_ENTRY = "src/worker.ts";
/** This file, for the re-exec used by the bounded-pass check below. */
const SELF_ENTRY = process.argv[1]!;
const spawnedPids: number[] = [];

function spawnWorker(env: Record<string, string> = {}, entry: string = WORKER_ENTRY) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    cwd: process.cwd(),
    // The probe listener is OFF unless a section asks for it (section 4 does, on a port
    // it discovered as free). Sections that only care about the process must not bind a
    // fixed port: `verify:all` runs sharded across three parallel jobs, so two shards in
    // this file would race for 4002 and whichever lost would log a bind error into the
    // output the shutdown assertions grep. A suite that passes by accident of scheduling
    // is the hermeticity failure this repo has been bitten by before.
    env: { ...process.env, WORKER_HEALTH_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => {
    output += String(d);
  });
  child.stderr.on("data", (d) => {
    output += String(d);
  });
  return { child, out: () => output };
}

/** Wait for this process to announce itself in worker_heartbeats. */
async function waitForHeartbeat(pid: number, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await systemDb
      .select()
      .from(workerHeartbeats)
      .where(eq(workerHeartbeats.pid, pid))
      .limit(1);
    if (row) return row;
    await wait(500);
  }
  return null;
}

// ── (1) A healthy worker boots, registers, and drains on SIGTERM ─────────────
const idlePort = await freePort();
const { child, out } = spawnWorker({
  PG_STATEMENT_TIMEOUT_MS: "60000",
  WORKER_HEALTH_PORT: String(idlePort),
});
spawnedPids.push(child.pid!);
const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>(
  (resolve) => {
    const t0 = Date.now();
    child.on("exit", (code, signal) => resolve({ code, signal, ms: Date.now() - t0 }));
  },
);

const row = await waitForHeartbeat(child.pid!);
ok("worker registers a heartbeat row for its own pid", !!row);
ok(
  "…advertising the task it can run",
  !!row && (row.tasks as string[]).includes("billing_clock_tick"),
);
// Finding #2 shipped: cron ticks must be serialized on a named queue and must NOT retry.
ok(
  "…and the SERIALIZED crontab (queue=…, max=1)",
  !!row?.crontab?.includes("queue=billing_clock") && !!row?.crontab?.includes("max=1"),
);

// The boot sweep must not abstain on its OWN worker id: the first beat has to land before it
// reads. Other live workers may legitimately be unreported, so only our id is checked.
{
  // The fields follow the message on their own lines in the dev (pretty) sink, so read a
  // window after each occurrence rather than the message line alone.
  const log = out();
  const windows: string[] = [];
  for (let i = log.indexOf("sweep abstained"); i !== -1; i = log.indexOf("sweep abstained", i + 1))
    windows.push(log.slice(i, i + 800));
  ok(
    "the boot stranded-lock sweep does not abstain on its own worker id",
    !!row?.workerId && !windows.some((w) => w.includes(row.workerId)),
  );
}

// Wait until it is genuinely idle, so the shutdown path is the thing measured. The drain now
// waits for running jobs, and near a 5-minute boundary this worker picks up real cron work
// (metric_daily_current can outlast the 25 s budget on the dev book).
await wait(1500);
// Cron fires on 5-minute boundaries; SIGTERM in the 30 s before one and a fresh job lands in
// the drain. Step past the boundary first, then wait for idle.
{
  const intoWindowMs = Date.now() % 300_000;
  if (intoWindowMs > 270_000) await wait(300_000 - intoWindowMs + 2_000);
}
for (const until = Date.now() + 120_000; Date.now() < until; await wait(500)) {
  const h = await hit(idlePort, "/healthz");
  if (!h.refused && h.body?.jobsActive === 0) break;
}
child.kill("SIGTERM");
const result = await exited;

ok("SIGTERM exits 0 (clean drain)", result.code === 0);
ok("…was not killed by a signal instead", result.signal === null);
// The point of the bounded shutdown: WE decide the outcome, inside the orchestrator's grace
// period (pm2 kill_timeout = budget + 10 s), instead of being SIGKILLed mid-tick. The drain
// may legitimately use the whole budget when a job is running; exit 0 above says it drained.
ok(
  `…inside the ${config.WORKER_SHUTDOWN_TIMEOUT_MS}ms budget plus post-drain headroom`,
  result.ms < config.WORKER_SHUTDOWN_TIMEOUT_MS + 10_000,
);
// The message is a CONSTANT and the reason is a FIELD (the log convention: variable
// data never goes in the message, or nothing can group the line). Asserted as two
// substrings so this holds for both the JSON sink and pino-pretty's dev rendering.
ok(
  "…logging a structured shutdown line, with the reason as a field",
  /worker shutting down/.test(out()) && /SIGTERM received/.test(out()),
);

const after = child.pid
  ? (
      await systemDb
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.pid, child.pid))
        .limit(1)
    )[0]
  : undefined;
ok("…and stamps its heartbeat row stopped (ops reads `stopped`, not `stale`)", !!after?.stoppedAt);

// ── (2) A boot failure is legible and exits non-zero (finding #5) ────────────
//
// Previously a bare top-level `await startWorker()` against an unreachable database gave
// an unhandled rejection, a raw stack, and exit 1 with nothing structured to alert on.
const dead = spawnWorker({
  // Valid URL shape (config validation must pass) pointing at a closed port.
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:59987/nope",
});
const deadResult = await new Promise<{ code: number | null }>((resolve) => {
  dead.child.on("exit", (code) => resolve({ code }));
  // Don't hang the suite if it somehow stays up — that is itself the failure.
  setTimeout(() => {
    dead.child.kill("SIGKILL");
    resolve({ code: null });
  }, 60_000).unref();
});
ok("an unreachable database exits non-zero rather than hanging", deadResult.code === 1);
ok("…with a structured, alertable boot-failure line", /worker_boot_failed/.test(dead.out()));
ok("…and no bare unhandled-rejection stack", !/UnhandledPromiseRejection/.test(dead.out()));

// ── (3) A bounded pass REPORTS its cap (finding #3) ──────────────────────────
//
// The cap is the honest half of bounding a tick: a truncated sweep that reads as a
// complete one is how "why is this invoice still unsent" becomes unanswerable. Driven
// through the EMAIL outbox because its console sink makes the loop deterministic and
// instant — the webhook outbox would spend its 10s HTTP timeout per row.
const capOrg = await createOrganization({ name: "Worker Cap Org" });
// The rows carry a business so the child can SCOPE the pass to them (see the child
// block at the top). Without it the assertions below depend on nothing else in the
// database being due — true only on a freshly reset DB, which is how this section
// passed standalone and failed inside `verify:gate`. Delivery itself is unaffected:
// the opt-in gate is at enqueue time, and a business with no `email_config` still
// falls back to the deployment mailer (the console sink here).
const capBiz = await createBusiness({
  defaultCurrency: "USD",
  organizationId: capOrg.organization.id,
  name: "Worker Cap Biz",
  livemode: "test",
});
const capRows = [1, 2].map((n) => ({
  publicId: publicId("em"),
  organizationId: capOrg.organization.id,
  businessId: capBiz.id,
  type: "invoice_issued",
  toAddress: `cap${n}@example.com`,
  subject: `cap probe ${n}`,
  bodyHtml: "<p>cap</p>",
  bodyText: "cap",
  status: "pending",
  // Both due now, staggered so "oldest first" is well defined.
  nextAttemptAt: new Date(Date.now() - (10 - n) * 1000),
}));
// Test mode emails only team members.
await asTeamMembers(capOrg.organization.id, ...capRows.map((r) => r.toAddress));
await systemDb.insert(emailMessages).values(capRows);
try {
  const capChild = spawnWorker(
    { TMB_CAP_CHILD: "1", TICK_SCAN_LIMIT: "1", TMB_CAP_BIZ: capBiz.id },
    SELF_ENTRY,
  );
  await new Promise<void>((resolve) => {
    capChild.child.on("exit", () => resolve());
    setTimeout(() => {
      capChild.child.kill("SIGKILL");
      resolve();
    }, 60_000).unref();
  });
  const m = capChild.out().match(/__CAP__(\{.*\})/);
  const capResult = m
    ? (JSON.parse(m[1]!) as { attempted: number; capped: boolean; limit: number })
    : null;
  ok(
    "a bounded pass stops at TICK_SCAN_LIMIT",
    capResult?.attempted === 1 && capResult?.limit === 1,
  );
  ok("…and REPORTS the cap rather than looking complete", capResult?.capped === true);
  const remaining = await systemDb
    .select({ status: emailMessages.status })
    .from(emailMessages)
    .where(
      inArray(
        emailMessages.publicId,
        capRows.map((r) => r.publicId),
      ),
    );
  // Deferred, never dropped: the row the cap skipped is still pending for the next tick.
  ok(
    "…leaving the skipped row pending for the next tick",
    remaining.filter((r) => r.status === "pending").length === 1,
  );
  ok(
    "…and having actually delivered the one it took",
    remaining.filter((r) => r.status === "sent").length === 1,
  );
} finally {
  await systemDb.delete(emailMessages).where(
    inArray(
      emailMessages.publicId,
      capRows.map((r) => r.publicId),
    ),
  );
}

// ── (4) The probe listener: /healthz and /readyz (RELEASE.md A4) ─────────────
//
// The worker is not an HTTP service, so before this an orchestrator could only ask "is
// the PID there?" — which stays true for a process that has lost its database and is
// failing every job it claims. These assertions are about the DISTINCTION between the two
// probes, because getting it backwards is the harmful direction: a liveness check that
// consults Postgres turns a database blip into a fleet-wide restart storm.

/** A port nobody is on. Asking the kernel beats picking a constant two shards can share. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

interface ProbeHit {
  status: number;
  body: Record<string, unknown> | null;
  refused: boolean;
}

async function hit(port: number, path: string): Promise<ProbeHit> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body: body as Record<string, unknown> | null, refused: false };
  } catch {
    // The socket being gone is a legitimate observation here, not a suite error: it is
    // exactly what a stopped worker looks like.
    return { status: 0, body: null, refused: true };
  }
}

const healthPort = await freePort();
const probed = spawnWorker({
  PG_STATEMENT_TIMEOUT_MS: "60000",
  WORKER_HEALTH_PORT: String(healthPort),
});
spawnedPids.push(probed.child.pid!);
const probedExit = new Promise<void>((resolve) => probed.child.on("exit", () => resolve()));
try {
  // Wait for the listener rather than sleeping a guessed interval — boot includes the
  // geo reference load and a graphile-worker connection, which vary by machine.
  let live: ProbeHit = { status: 0, body: null, refused: true };
  for (const _ of Array(80)) {
    live = await hit(healthPort, "/healthz");
    if (!live.refused) break;
    await wait(250);
  }

  ok("the worker serves GET /healthz", live.status === 200 && live.body?.status === "ok");
  ok(
    "…identifying the process (role, pid, uptime)",
    live.body?.role === "billing" && live.body?.pid === probed.child.pid,
  );
  // `jobsActive` is what tells an operator mid-rollout whether a drain is progressing or
  // has stalled, so its ABSENCE is a real regression, not a cosmetic one.
  ok("…and reporting in-flight work", typeof live.body?.jobsActive === "number");
  const mem = live.body?.memoryMiB as Record<string, unknown> | undefined;
  ok(
    "…and its memory (rss, heap, external, arrayBuffers)",
    ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"].every(
      (k) => typeof mem?.[k] === "number",
    ) && (mem!.rss as number) > 0,
  );

  const ready = await hit(healthPort, "/readyz");
  ok("the worker serves GET /readyz", ready.status === 200 && ready.body?.status === "ready");
  ok("…naming BOTH dependencies it checked", ready.body?.db === "up" && ready.body?.queue === "up");
  // The heartbeat check is the half a `select 1` cannot cover: `beat` swallows its own
  // errors so the clock cannot be killed by a monitoring write, which means a worker
  // whose every heartbeat is failing looks healthy from the inside without this.
  ok(
    "…and its own heartbeat write",
    ready.body?.heartbeat === "up" && typeof ready.body?.beatAgeMs === "number",
  );

  ok("an unknown path is 404, not a false 200", (await hit(healthPort, "/nope")).status === 404);

  // ── the drain window ───────────────────────────────────────────────────────
  // The invariant is one-directional and therefore deterministic, unlike catching the
  // (very short, when idle) draining state itself: once SIGTERM has landed, /readyz must
  // NEVER answer 200 again. A worker that keeps advertising readiness while shutting
  // down is one an orchestrator keeps routing to, which is the whole failure readiness
  // exists to prevent. /healthz meanwhile must not report the drain as a wedged process.
  probed.child.kill("SIGTERM");
  // kill() returns before the child runs its handler; on a busy loop a probe sent in the same
  // instant is answered first. "Once shutting down" starts when the worker says so.
  for (const until = Date.now() + 5000; Date.now() < until; await wait(10))
    if (/worker shutting down/.test(probed.out())) break;
  let readyAfterSigterm = false;
  // /healthz statuses answered while /readyz said `draining`.
  const liveDuringDrain: number[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const r = await hit(healthPort, "/readyz");
    if (r.refused) break; // listener closed: the drain finished
    if (r.status === 200) readyAfterSigterm = true;
    if (r.body?.state === "draining") {
      // Sampled only when we KNOW it is draining, so this cannot pass by reading a
      // healthy pre-SIGTERM process. A refused sample is the drain ending between the two
      // probes, not a wedged process — now that the drain waits for jobs, the test sees it.
      const live = await hit(healthPort, "/healthz");
      if (!live.refused) liveDuringDrain.push(live.status);
    }
    await wait(20);
  }
  ok("/readyz never reports ready once shutting down", !readyAfterSigterm);
  // Not asserted as required: an idle worker can drain faster than the poll above, and a
  // suite that fails on a FAST shutdown would be punishing the good outcome.
  if (liveDuringDrain.length > 0)
    ok(
      "…reporting `draining` while /healthz stays 200 (not wedged)",
      liveDuringDrain.every((s) => s === 200),
    );

  await probedExit;
  ok("the probe port is released on exit", (await hit(healthPort, "/healthz")).refused);
} finally {
  if (!probed.child.killed) probed.child.kill("SIGKILL");
}

// Spawned workers are real processes that really ran, but leaving their rows behind would
// add a `stopped` row to the ops list on every run.
if (spawnedPids.length) {
  for (const pid of spawnedPids)
    await systemDb.delete(workerHeartbeats).where(eq(workerHeartbeats.pid, pid));
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ WORKER LIFECYCLE: PASS" : `❌ WORKER LIFECYCLE: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
