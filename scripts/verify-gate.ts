/**
 * verify:gate — run every non-destructive `verify:*` suite and report one verdict.
 *
 * WHY THIS EXISTS. The suites were only ever run individually, so they rotted
 * silently. One suite was found (2026-07-29) with THREE layers of
 * breakage stacked behind each other — a `quantity: 2` on a flat price that the
 * engine had rejected since d69d2fe, which ERRORED and short-circuited the suite,
 * hiding two stale `posted` expectations and a timeline assertion broken by the
 * plan-trial auto-apply. Three separate engine changes broke it and nothing noticed.
 * `verify:invoice-ops` had been red since 501364d for the same reason. The only
 * aggregate that existed, `verify:all`, truncates the database (`db:reset` inside),
 * so nobody ran it, so nothing was watching.
 *
 * THE ANTI-ROT PROPERTY. The suite list is DERIVED from package.json — every
 * `verify:*` script is gated unless it appears in EXCLUDED below with a reason. Add a
 * suite and it is covered automatically; skipping one is a deliberate, documented act.
 * A hand-maintained allowlist would reproduce the original bug one level up.
 *
 *   pnpm verify:gate              # every safe suite
 *   pnpm verify:gate --with-live  # also the real-gateway suites (slow, needs keys)
 *   pnpm verify:gate --only=a,b   # a subset, for iterating
 *
 * Suites run STRICTLY SEQUENTIALLY. They share one Postgres and one dev server;
 * running two at once produces phantom failures (a concurrent pair once reported
 * parity j07 at 4 fail / 2 warn when it was 0/0 alone).
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Suites deliberately outside the gate, each with the reason it cannot run here. */
const EXCLUDED: Record<string, string> = {
  "verify:all": "DESTRUCTIVE — runs db:reset and truncates the local database",
  "verify:gate": "this runner",
  // Real-gateway suites: they make live API calls against provider sandboxes, cost
  // real time, and are rate-limited. Included by --with-live.
  "verify:gateway-live": "live provider calls (--with-live)",
  "verify:stripe-live": "live provider calls (--with-live)",
  "verify:paypal-live": "live provider calls (--with-live)",
  "verify:razorpay-live": "live provider calls (--with-live)",
  // Tunnel suites need an operator-run ngrok tunnel and a pasted public URL, so they
  // can never be unattended.
  "verify:stripe-tunnel": "needs an operator-run tunnel",
  "verify:paypal-tunnel": "needs an operator-run tunnel",
  "verify:razorpay-tunnel": "needs an operator-run tunnel",
  "verify:webhook-e2e": "needs WEBHOOK_BASE_URL (a publicly reachable URL)",
};

const LIVE_SUITES = [
  "verify:gateway-live",
  "verify:stripe-live",
  "verify:paypal-live",
  "verify:razorpay-live",
];

/**
 * Suites that assert GLOBAL state — row counts across the database, webhook delivery
 * totals, the shared imported parity org — rather than only what they created
 * themselves. Every other suite's leftovers make them fail, so they run FIRST, before
 * the rest add noise. Measured (2026-07-29): all three pass alone and failed inside the
 * gate purely from preceding suites; that is a false failure, and a gate that cries
 * wolf gets ignored, which is how the suites rotted in the first place.
 *
 * The real fix is for these suites to scope their assertions to their own org. Until
 * then, ordering buys back the signal.
 *
 * ⚠ `verify:outbound-webhooks` STAYS HERE EVEN THOUGH d4cf7865 SCOPED IT — checked in source
 * 2026-09-02, because a session reading that commit reasonably concluded the entry was now
 * redundant and nearly removed it. d4cf7865 replaced assertions on `deliverPending`'s return
 * counters (which drain the WHOLE outbox, so they counted other suites' leftovers) with row
 * selects filtered on `organizationId` — lines 89/95/99 of that suite. But its NUDGE block
 * still reads `graphile_worker.jobs` filtered ONLY by `task_identifier =
 * 'webhook_outbox_nudge'` (lines 180/192/199): global, not org-scoped. It clears the queue at
 * the top, which makes it sound against other SUITES and is exactly what this ordering
 * preserves. Delete the entry and those three assertions go back to depending on what ran
 * before them.
 *
 * That block cannot be fixed by ordering at all when a LIVE WORKER is running: a
 * `--role=billing` worker drains the nudge job mid-suite, and `nudgesAfterEvents` reads 0.
 * Filed separately as 🟠 — ordering is a suite-vs-suite tool, and that is a suite-vs-process
 * problem.
 */
const ISOLATION_SENSITIVE = [
  "verify:migration",
  "verify:migration-history",
  "verify:outbound-webhooks",
  "verify:parity",
];

const args = process.argv.slice(2);
const withLive = args.includes("--with-live");
const onlyArg = args.find((a) => a.startsWith("--only="));
const only = onlyArg
  ? onlyArg
      .slice("--only=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

const scripts: Record<string, string> = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const allVerify = Object.keys(scripts)
  .filter((k) => k.startsWith("verify:"))
  .sort();

let planned = allVerify.filter((k) => !(k in EXCLUDED));
if (withLive) planned = planned.concat(LIVE_SUITES.filter((k) => k in scripts));
if (only) {
  const want = new Set(only.map((o) => (o.startsWith("verify:") ? o : `verify:${o}`)));
  planned = allVerify.filter((k) => want.has(k));
}
// Global-state assertions first, while the database is still quiet.
planned = [
  ...ISOLATION_SENSITIVE.filter((k) => planned.includes(k)),
  ...planned.filter((k) => !ISOLATION_SENSITIVE.includes(k)),
];

type Result = { suite: string; ok: boolean; ms: number; tail: string };
const results: Result[] = [];

console.log(
  `\nverify:gate — ${planned.length} suites, sequential${withLive ? " (incl. live)" : ""}\n`,
);

for (const suite of planned) {
  const started = Date.now();
  process.stdout.write(
    `  ${suite.padEnd(30)}${ISOLATION_SENSITIVE.includes(suite) ? "[first] " : "        "}`,
  );
  const run = spawnSync("pnpm", [suite], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - started;
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const ok = run.status === 0;
  // Keep only what a failure needs: the ✗ lines, else the last few lines.
  const marks = out.split("\n").filter((l) => l.includes("✗"));
  const tail = (marks.length ? marks : out.split("\n").filter(Boolean).slice(-6))
    .slice(0, 12)
    .join("\n");
  results.push({ suite, ok, ms, tail });
  console.log(`${ok ? "✓" : "✗"}  ${(ms / 1000).toFixed(1)}s`);
}

const failed = results.filter((r) => !r.ok);

console.log(`\n${"─".repeat(64)}`);
if (failed.length) {
  console.log(`\n${failed.length} FAILING suite(s):\n`);
  for (const f of failed) {
    console.log(`── ${f.suite} ──`);
    console.log(f.tail.replace(/^/gm, "   "));
    console.log();
  }
}

const skipped = Object.entries(EXCLUDED).filter(
  ([k]) => k !== "verify:gate" && !planned.includes(k),
);
if (skipped.length && !only) {
  console.log("Not gated (deliberate):");
  for (const [k, why] of skipped) console.log(`  ${k.padEnd(24)} ${why}`);
  console.log();
}

const total = (results.reduce((s, r) => s + r.ms, 0) / 1000 / 60).toFixed(1);
console.log(
  failed.length
    ? `❌ VERIFY GATE: ${failed.length} of ${results.length} suites FAILED (${total} min)`
    : `✅ VERIFY GATE: all ${results.length} suites passed (${total} min)`,
);
process.exit(failed.length ? 1 : 0);
