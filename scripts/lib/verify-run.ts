/**
 * Run a verify suite so that a CRASH still prints a verdict.
 *
 * ── Why this wrapper exists ───────────────────────────────────────────────────
 * Each suite ends by printing `✅ NAME: PASS` / `❌ NAME: FAIL` and every human, agent
 * and CI grep keys off that line. An uncaught throw mid-run prints NEITHER: the process
 * dies with a stack trace and no verdict, so anything checking for `❌` sees nothing and
 * reads it as "no failures". Measured 2026-08-31, when a half-applied edit made
 * `verify:estimates` throw and the run looked silent rather than broken.
 *
 * `verify-all.sh` was never fooled — it keys off the EXIT CODE (`if "$@"; then`) — but a
 * single suite run by hand is exactly how these are used all day.
 *
 * The handlers are installed BEFORE the suite is imported, which is the whole trick: a
 * top-level `await` that rejects surfaces as `unhandledRejection`, and a suite cannot
 * install a handler for its own import-time failure.
 *
 * Exit codes are unchanged (1 on crash), so `verify-all.sh` and CI behave exactly as
 * before — this only adds the line they could not see.
 */
// `export {}` so this file is unambiguously a module: it has no static imports (the suite
// is loaded dynamically, AFTER the handlers below are installed — that ordering is the
// whole point), and without it tsc refuses the top-level await.
export {};

const suiteArg = process.argv[2];
if (!suiteArg) {
  console.error("usage: tsx scripts/lib/verify-run.ts <verify-suite-file>");
  process.exit(2);
}

/**
 * `verify-dunning-offline` → `DUNNING-OFFLINE`, matching what the suites print themselves.
 *
 * A suite whose FILE is generically named takes its directory instead
 * (`scripts/parity/run.ts` → `PARITY`), because "❌ RUN: CRASHED" names nothing.
 */
const base = suiteArg.replace(/\.ts$/, "").split("/");
const leaf = base[base.length - 1]!;
const label = (["run", "index", "main"].includes(leaf) ? (base[base.length - 2] ?? leaf) : leaf)
  .replace(/^verify-/, "")
  .toUpperCase();

let crashed = false;
const report = (kind: string, err: unknown): never => {
  // Guard against a second handler firing during our own teardown and hiding the first
  // error behind a less useful one.
  if (crashed) process.exit(1);
  crashed = true;
  console.error("");
  console.error(`❌ ${label}: CRASHED (${kind}) — the suite threw before printing a verdict`);
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
};
process.on("uncaughtException", (e) => report("uncaughtException", e));
process.on("unhandledRejection", (e) => report("unhandledRejection", e));

// A suite outside scripts/ is named by its repo-relative path and resolved from the cwd.
const target =
  suiteArg.startsWith(".") || suiteArg.startsWith("/")
    ? suiteArg
    : suiteArg.startsWith("scripts/") || !suiteArg.includes("/")
      ? `../${suiteArg.replace(/^scripts\//, "")}`
      : `${process.cwd()}/${suiteArg}`;

/**
 * HAND THE SUITE THE ARGV IT WOULD HAVE HAD.
 *
 * Two suites read `process.argv` (`verify-gate`, `verify-worker-lifecycle`), and running
 * them through a wrapper shifts every index by one — which would not fail, it would
 * silently read the wrong flag. So argv is rewritten to exactly what `tsx
 * scripts/verify-x.ts <args>` produces before the suite is imported.
 */
process.argv = [process.argv[0]!, suiteArg, ...process.argv.slice(3)];

/**
 * Suites deliver webhooks to a receiver on 127.0.0.1, which the private-target guard
 * refuses (platform/egress.ts). Set before the suite loads config; `verify:webhook-ssrf`
 * turns the guard back on for its own assertions.
 */
process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS ??= "TRUE";

await import(target);
