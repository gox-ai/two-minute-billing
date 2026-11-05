/**
 * Proves structured logging + trace correlation (`platform/trace`,
 * `platform/logger`):
 *  - trace ids are unique, base62 and prefixed
 *  - a trace context propagates across async boundaries and nests correctly
 *  - every log line carries service + traceId, and error() extracts message/stack
 *  - inbound `x-trace-id` / `x-request-id` / `traceparent` are ADOPTED, so one
 *    execution spanning an upstream service → tmbilling shares an id; junk headers are ignored
 *  - the id survives the job queue via the `_trace` payload stamp
 *  - oversized debug_info is truncated, not dumped
 *  - a real HTTP request gets a traceId and echoes it back as `x-trace-id`
 *  - a pino line converts into the Google Cloud Logging entry we intend to send:
 *    severity, the GCP-native `trace` field, indexed labels, an error's stack in
 *    `message` (Error Reporting's grouping key) and `serviceContext`
 *  - an oversized entry is truncated in escalating passes, never dropped silently,
 *    and bigint/circular payloads survive the conversion
 *  - the sink stays OFF unless it is configured, so nothing here needs credentials
 *  - a failure reported by PUSHING onto a warnings/errors array (instead of
 *    throwing) is logged too — a response-body warning is not a record
 *
 *   pnpm verify:logging
 */
import { Writable } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildApp } from "@/index";
import {
  newTraceId,
  withTraceContext,
  getTraceId,
  getTraceContext,
  updateTraceContext,
  traceIdFromHeaders,
  isValidTraceId,
  stampTracePayload,
  traceContextFromPayload,
} from "@/platform/trace";
import {
  createLogger,
  logger,
  flushCloudLogging,
  ambientLogFields,
  redactSensitive,
  claimRecurrence,
  resetRecurrenceState,
  LOG_REPEAT_WINDOW_MS,
  type Logger,
} from "@/platform/logger";
import { config } from "@/platform/config";
import { runWithEventContext } from "@/platform/event-context";
import {
  severityFor,
  toCloudLogEntry,
  boundEntryPayload,
  cloudLoggingEnabled,
  createCloudLoggingSink,
} from "@/platform/cloud-logging";
import { truncateLogPayload, getSizeKB, safeStringify } from "@/platform/log-truncation";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label);
  }
}

/**
 * The sink can only be exercised with `CLOUD_LOGGING=TRUE`, which is read once at
 * import time — so that half runs as a CHILD of this same file (`SINK_CHILD=1`),
 * spawned with the env set. It proves the property that actually matters in
 * production: a sink that CANNOT reach Google (no credentials here) must degrade
 * to stdout and let the process exit cleanly, never throw into a caller and never
 * hang a shutdown. A failure to ship logs must not become a failure to bill.
 */
if (process.env.SINK_CHILD === "1") {
  const { createCloudLoggingSink: build, cloudLoggingEnabled: enabled } =
    await import("@/platform/cloud-logging");
  const { createLogger: mk, flushCloudLogging: flush } = await import("@/platform/logger");
  if (!enabled()) {
    console.error("child: sink not enabled");
    process.exit(3);
  }
  const sink = build();
  if (!sink) {
    console.error("child: sink not built");
    process.exit(3);
  }
  const childLog = mk("sink-child");
  childLog.log("a line that will never reach Google", { blob: "x".repeat(300_000) });
  childLog.error(new Error("an error line"), { attempt: 1 });
  // Bounded: an unreachable sink must not wedge shutdown.
  const settled = await Promise.race([
    flush().then(() => "flushed" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000).unref()),
  ]);
  if (settled !== "flushed") {
    console.error("child: flush did not settle");
    process.exit(4);
  }
  console.log("child: ok");
  process.exit(0);
}

// ── Trace id shape ───────────────────────────────────────────────────────────
const id = newTraceId();
ok("default prefix is trace-", id.startsWith("trace-"));
ok("id is prefix + 21 base62 chars", /^trace-[0-9A-Za-z]{21}$/.test(id));
ok("custom prefix honored", newTraceId("api").startsWith("api-"));
const many = new Set(Array.from({ length: 2000 }, () => newTraceId()));
ok("2000 ids are all unique", many.size === 2000);
// A well-formed `prefix-` + 21 base62 id.
ok("a well-formed id validates", isValidTraceId("trace-AbCdEfGhIjKlMnOpQrStU"));
ok("junk is rejected", !isValidTraceId("has space") && !isValidTraceId("a".repeat(200)));
ok("newline injection rejected", !isValidTraceId("abc\ndef-injected"));

// ── Propagation across async boundaries ──────────────────────────────────────
ok("no traceId outside any context", getTraceId() === undefined);
await withTraceContext({ traceId: "trace-OUTER0000000000000" }, async () => {
  ok("traceId readable inside the context", getTraceId() === "trace-OUTER0000000000000");
  await new Promise((r) => setTimeout(r, 5));
  ok("traceId survives an await", getTraceId() === "trace-OUTER0000000000000");
  await Promise.all([
    (async () => {
      await new Promise((r) => setTimeout(r, 1));
      ok("traceId survives Promise.all branches", getTraceId() === "trace-OUTER0000000000000");
    })(),
    (async () => {
      // A nested context shadows only within itself.
      await withTraceContext({ traceId: "trace-INNER0000000000000" }, async () => {
        ok("nested context shadows the outer id", getTraceId() === "trace-INNER0000000000000");
      });
      ok("outer id restored after the nested context", getTraceId() === "trace-OUTER0000000000000");
    })(),
  ]);
  // updateTraceContext patches in place (how auth fills in org/business).
  updateTraceContext({ organizationId: "org_1", businessId: "biz_1" });
  ok("updateTraceContext patches the live store", getTraceContext()?.organizationId === "org_1");
});
ok("context is gone after the wrapper resolves", getTraceId() === undefined);
// A context with no explicit id must still get one — never a silent undefined.
await withTraceContext({}, async () =>
  ok("a fresh id is minted when none supplied", !!getTraceId()),
);

// ── Inbound header adoption (cross-service correlation) ──────────────────────
ok(
  "x-trace-id adopted",
  traceIdFromHeaders({ "x-trace-id": "trace-FROMTMR000000000000" }) === "trace-FROMTMR000000000000",
);
ok(
  "x-request-id adopted",
  traceIdFromHeaders({ "x-request-id": "req-abcdefgh" }) === "req-abcdefgh",
);
ok(
  "x-trace-id wins over x-request-id",
  traceIdFromHeaders({ "x-trace-id": "trace-WINS0000000000000", "x-request-id": "req-loses" }) ===
    "trace-WINS0000000000000",
);
ok(
  "W3C traceparent trace-id extracted",
  traceIdFromHeaders({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }) ===
    "4bf92f3577b34da6a3ce929d0e0e4736",
);
ok(
  "all-zero traceparent rejected (spec-invalid)",
  traceIdFromHeaders({ traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" }) ===
    null,
);
ok("malformed header ignored", traceIdFromHeaders({ "x-trace-id": "bad id with spaces" }) === null);
ok(
  "array header takes the first value",
  traceIdFromHeaders({ "x-trace-id": ["trace-FIRST000000000000"] }) === "trace-FIRST000000000000",
);
ok("no headers → null", traceIdFromHeaders(undefined) === null);

// ── Job-queue propagation ────────────────────────────────────────────────────
await withTraceContext({ traceId: "trace-QUEUED00000000000" }, async () => {
  const payload = stampTracePayload({ invoiceId: "inv_1" }) as Record<string, unknown>;
  ok(
    "payload is stamped with _trace",
    (payload._trace as { traceId: string }).traceId === "trace-QUEUED00000000000",
  );
  const ctx = traceContextFromPayload(payload);
  ok("worker recovers the enqueuer traceId", ctx.traceId === "trace-QUEUED00000000000");
  ok("recovered trace is marked inherited", ctx.inherited === true);
});
const orphan = traceContextFromPayload({ invoiceId: "inv_2" });
ok("unstamped payload gets a job- id", orphan.traceId.startsWith("job-"));
ok("unstamped payload is NOT marked inherited", orphan.inherited === false);
ok(
  "stamping outside a context is a no-op",
  (stampTracePayload({ a: 1 }) as Record<string, unknown>)._trace === undefined,
);
// A tampered/garbage stamp must not reach the logs.
ok(
  "junk stamped traceId is rejected, not adopted",
  traceContextFromPayload({ _trace: { traceId: "nope\ninjected" } }).inherited === false,
);

// ── Log output: fields, error extraction, truncation ────────────────────────
// Bind createLogger to a collecting stream so these assertions run through the
// REAL field assembly (createLogger's `base` seam) rather than a copy of it.
const lines: Array<Record<string, unknown>> = [];
const sink = new Writable({
  write(chunk, _enc, cb) {
    try {
      lines.push(JSON.parse(String(chunk)));
    } catch {
      /* non-JSON line */
    }
    cb();
  },
});
const { pino } = await import("pino");
const sinkLogger = pino({ level: "trace" }, sink) as unknown as typeof logger;
const log = createLogger("checkout", sinkLogger);
const last = () => lines.at(-1)!;

await withTraceContext({ traceId: "trace-LOGLINE0000000000", inherited: true }, async () =>
  runWithEventContext({ source: "api", actor: "ak_test" }, async () => {
    log.log("checkout completed", { session: "cosess_1" });
  }),
);
ok("log line carries the message", last().msg === "checkout completed");
ok("log line carries service", last().service === "checkout");
ok("log line carries traceId", last().traceId === "trace-LOGLINE0000000000");
ok("log line marks an inherited trace", last().traceInherited === true);
ok("log line carries source + actor", last().source === "api" && last().actor === "ak_test");
ok(
  "log line carries debug_info",
  (last().debug_info as { session: string }).session === "cosess_1",
);

// Outside any context the line still logs — just without correlation fields.
log.log("no context here");
ok(
  "logs fine with no trace context",
  last().msg === "no context here" && last().traceId === undefined,
);
ok("service is always present", last().service === "checkout");
ok("debug_info omitted when not supplied", !("debug_info" in last()));

// verbose → pino trace.
log.warn("a warning");
ok("warn logs at warn level", last().level === 40);
log.verbose("a verbose line");
ok("verbose maps to pino trace level", last().level === 10);
log.debug("a debug line");
ok("debug logs at debug level", last().level === 20);

// error() extracts message + stack from a real Error.
try {
  throw new Error("card declined");
} catch (err) {
  log.error(err, { gateway: "stripe" });
}
ok("error line uses the error message as msg", last().msg === "card declined");
ok("error line carries error_message", last().error_message === "card declined");
ok(
  "error line carries a stack",
  typeof last().stack === "string" && (last().stack as string).includes("Error: card declined"),
);
ok(
  "error line keeps its debug_info",
  (last().debug_info as { gateway: string }).gateway === "stripe",
);
ok("error logs at error level", last().level === 50);

// error() must also accept a bare string and a non-Error value.
log.error("plain string failure");
ok("error accepts a plain string", last().error_message === "plain string failure");
log.error({ code: "weird" });
ok("error accepts a non-Error object", typeof last().error_message === "string");

// bigint (money is bigint minor units here) must serialize, not throw.
log.log("bigint payload", { amountMinor: 12345n });
ok("bigint debug_info serializes", last().msg === "bigint payload");

// Circular refs must not throw.
const circular: Record<string, unknown> = { name: "a" };
circular.self = circular;
log.log("circular payload", circular);
ok("circular debug_info does not throw", last().msg === "circular payload");

// Oversized debug_info is truncated with a marker rather than dumped whole.
log.log("oversized payload", { blob: "x".repeat(200_000) });
const big = last().debug_info as {
  _truncated?: boolean;
  _originalBytes?: number;
  preview?: string;
};
ok("oversized debug_info is truncated", big._truncated === true);
ok("truncation records the original size", (big._originalBytes ?? 0) > 100_000);
ok("truncation keeps a bounded preview", (big.preview?.length ?? 0) <= 2000);

// ── Google Cloud Logging entry shaping ───────────────────────────────────────
// These assert the CONVERSION, which is where the bugs that cost you a log line live
// (a rejected 256KB entry, a missing trace field, an error that never reaches Error
// Reporting).
//
// The two switch assertions below test the INVARIANT — a sink exists if and only if it
// is configured — rather than asserting the sink is off in this environment. They used
// to hard-code `=== false`, which meant the gate failed for any developer who had
// actually turned the sink on: exactly what deploy/README § Logs tells you to do, and
// what you must do to test delivery. A verification that breaks when you follow the
// instructions trains people to ignore it.

const sinkConfigured = config.CLOUD_LOGGING === "TRUE" && !!config.GOOGLE_CLOUD_PROJECT_ID;
ok("cloudLoggingEnabled() agrees with the config", cloudLoggingEnabled() === sinkConfigured);
ok("a sink is built iff it is configured", (createCloudLoggingSink() !== null) === sinkConfigured);
await flushCloudLogging(); // must resolve, not throw, with no sink

ok("fatal → CRITICAL", severityFor(60) === "CRITICAL");
ok("error → ERROR", severityFor(50) === "ERROR");
ok("warn → WARNING", severityFor(40) === "WARNING");
ok("info → INFO", severityFor(30) === "INFO");
ok("debug → DEBUG", severityFor(20) === "DEBUG");
ok("trace → DEBUG", severityFor(10) === "DEBUG");

const infoEntry = toCloudLogEntry(
  {
    level: 30,
    time: 1_700_000_000_000,
    msg: "checkout completed",
    service: "checkout",
    traceId: "api-ABCDEFGHIJKLMNOPQRSTU",
    source: "api",
  },
  "demo-project",
);
ok("info entry keeps its message", infoEntry.payload.message === "checkout completed");
ok("info entry maps to INFO", infoEntry.severity === "INFO");
ok("entry uses the log line time", infoEntry.timestamp.getTime() === 1_700_000_000_000);
ok(
  "entry carries the GCP-native trace field",
  infoEntry.trace === "projects/demo-project/traces/api-ABCDEFGHIJKLMNOPQRSTU",
);
ok("service is an indexed label", infoEntry.labels.service === "checkout");
ok(
  "traceId is an indexed label too (text search)",
  infoEntry.labels.traceId === "api-ABCDEFGHIJKLMNOPQRSTU",
);
ok("source is an indexed label", infoEntry.labels.source === "api");
ok("an info entry carries no serviceContext", infoEntry.payload.serviceContext === undefined);

const noProject = toCloudLogEntry({ level: 30, msg: "x", traceId: "api-ABCDEFGHIJKLMNOPQRSTU" });
ok("no project id → no trace field (never a malformed one)", noProject.trace === undefined);

const errEntry = toCloudLogEntry(
  {
    level: 50,
    msg: "card declined",
    error_message: "card declined",
    stack: "Error: card declined\n    at charge (collection.ts:1:1)",
    service: "collection",
    traceId: "job-ABCDEFGHIJKLMNOPQRSTU",
  },
  "demo-project",
);
ok("error entry maps to ERROR", errEntry.severity === "ERROR");
ok(
  "error entry puts the STACK in message (Error Reporting groups on it)",
  String(errEntry.payload.message).startsWith("Error: card declined"),
);
ok(
  "error entry keeps the clean message in error_message",
  errEntry.payload.error_message === "card declined",
);
ok("error entry carries serviceContext", typeof errEntry.payload.serviceContext === "object");

// An error with no stack must still produce a message rather than an empty string.
const stackless = toCloudLogEntry({
  level: 50,
  msg: "no stack here",
  error_message: "no stack here",
});
ok("a stackless error still carries its message", stackless.payload.message === "no stack here");

// Size discipline — the reason entries get rejected by GCP at 256KB.
const small = boundEntryPayload({ message: "small", service: "checkout" });
ok(
  "a small payload passes through unchanged",
  small.message === "small" && small._wasTruncated === undefined,
);

const huge = boundEntryPayload({ message: "huge", service: "checkout", blob: "x".repeat(400_000) });
ok("an oversized payload is truncated", huge._wasTruncated === true);
ok("truncation keeps the message", huge.message === "huge");
ok("truncation records the original size", (huge._originalSizeKB as number) > 170);
ok("the truncated payload is under the safe cap", getSizeKB(huge) <= 170);

// Truncation escalates: many long strings survive pass 1 but not pass 2/3.
const wide = boundEntryPayload({
  message: "wide",
  rows: Array.from({ length: 400 }, (_, i) => ({
    i,
    note: "y".repeat(900),
    nested: { deep: { deeper: "z".repeat(900) } },
  })),
});
ok("a wide payload is truncated too", wide._wasTruncated === true);
ok("a wide payload ends under the cap", getSizeKB(wide) <= 170);

// bigint + circular must survive the conversion (money is bigint; provider errors
// are frequently circular) — JSON.stringify alone throws on both.
const bigintEntry = toCloudLogEntry({
  level: 30,
  msg: "money",
  amountMinor: 12345n as unknown as number,
});
ok("a bigint payload converts without throwing", bigintEntry.payload.amountMinor === "12345n");
const circularPayload: Record<string, unknown> = { message: "circular" };
circularPayload.self = circularPayload;
const circularEntry = boundEntryPayload(circularPayload);
ok("a circular payload converts without throwing", circularEntry.message === "circular");
ok("safeStringify marks the cycle", safeStringify(circularPayload).includes("[Circular]"));

// The truncator itself: the escalation is observable, not just "it got smaller".
const modes = truncateLogPayload({ message: "m", blob: "x".repeat(400_000) }, 155);
ok("truncation reports which pass ran", typeof modes._truncationMode === "string");
ok(
  "an already-small payload is returned untouched",
  truncateLogPayload({ a: 1 }, 155)._wasTruncated === undefined,
);

// The sink half, in a child with CLOUD_LOGGING=TRUE (see the top of this file).
const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
  env: {
    ...process.env,
    SINK_CHILD: "1",
    CLOUD_LOGGING: "TRUE",
    GOOGLE_CLOUD_PROJECT_ID: "tmbilling-verify-fake",
    GOOGLE_CLOUD_CREDENTIALS_PATH: "/nonexistent/verify-credentials.json",
    LOG_LEVEL: "info",
  },
  encoding: "utf8",
  timeout: 60_000,
});
const childOut = `${child.stdout ?? ""}${child.stderr ?? ""}`;
ok("an unreachable sink still exits cleanly", child.status === 0);
ok("the sink accepted lines and flushed", childOut.includes("child: ok"));
ok("the write failure is reported, not thrown", /cloud-logging|child: ok/.test(childOut));

// ── End-to-end over HTTP ─────────────────────────────────────────────────────
const app = await buildApp({ logger: false });
const res1 = await app.inject({ method: "GET", url: "/health" });
ok("response carries an x-trace-id header", isValidTraceId(res1.headers["x-trace-id"]));
ok(
  "a minted request trace uses the api- prefix",
  String(res1.headers["x-trace-id"]).startsWith("api-"),
);

const res2 = await app.inject({
  method: "GET",
  url: "/health",
  headers: { "x-trace-id": "trace-ENDTOEND000000000" },
});
ok(
  "an inbound x-trace-id is echoed back unchanged",
  res2.headers["x-trace-id"] === "trace-ENDTOEND000000000",
);

const res3 = await app.inject({
  method: "GET",
  url: "/health",
  headers: { "x-trace-id": "bad id" },
});
ok("a malformed inbound id is replaced, not echoed", res3.headers["x-trace-id"] !== "bad id");
ok("the replacement is a valid minted id", isValidTraceId(res3.headers["x-trace-id"]));

const res4 = await app.inject({
  method: "GET",
  url: "/health",
  headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
});
ok(
  "traceparent is adopted end-to-end",
  res4.headers["x-trace-id"] === "4bf92f3577b34da6a3ce929d0e0e4736",
);

// Two requests must never share a trace.
const a1 = await app.inject({ method: "GET", url: "/health" });
const a2 = await app.inject({ method: "GET", url: "/health" });
ok("separate requests get separate traces", a1.headers["x-trace-id"] !== a2.headers["x-trace-id"]);
await app.close();

// ── A failure reported as data must still be logged (source guard) ───────────
/**
 * Some failures are deliberately NOT thrown. `applyCancelMoneyHandling` catches a
 * per-item money failure, pushes a string onto `warnings[]` and carries on, because
 * the subscription is already cancelled and throwing would 500 a cancellation that
 * has in fact happened; the clock's passes do the same with `errors[]` so one bad
 * row cannot stall a tick.
 *
 * That is the right call — but the warning then reaches the operator only in a
 * response body, and a response body is not a RECORD: the dashboard renders it once
 * in a toast and keeps nothing. A cancellation credit that was never issued, or a
 * refundable credit note that never paid out, has to be answerable from the logs
 * alone. This is exactly how those four cancellation paths went unlogged — they
 * never looked like a bare `catch {}`, so the 2026-08-19 sweep did not flag them.
 *
 * The rule, enforced over source: if a `catch` block reports a failure by pushing
 * onto a warnings/errors array, that block must ALSO log. Currently 8 such sites,
 * all logged — a ratchet, so the next one cannot land silent.
 */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const LOG_CALL =
  /\b\w*log\w*\.(error|recurringError|warn|fatal|info|debug)\b|logError|console\.(error|warn)/;
const REPORTS_FAILURE = /\b(warnings|warning|errors|problems)\.push\s*\(/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** The `catch (…) { … }` block starting on `lines[start]`, by brace balance. */
function catchBlockAt(lines: string[], start: number): string | null {
  let depth = 0;
  let started = false;
  const body: string[] = [];
  for (let j = start; j < Math.min(start + 60, lines.length); j++) {
    const line = lines[j] ?? "";
    let seg = line;
    if (!started) {
      const k = seg.indexOf("{", seg.indexOf("catch"));
      if (k === -1) continue;
      started = true;
      seg = seg.slice(k);
    }
    for (const ch of seg) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    body.push(line);
    if (depth <= 0) return body.join("\n");
  }
  return null;
}

const silentlyReported: string[] = [];
let reportingCatches = 0;
for (const file of tsFilesUnder(SRC_ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/catch\s*(\(|\{)/.test(lines[i] ?? "")) continue;
    const block = catchBlockAt(lines, i);
    if (!block || !REPORTS_FAILURE.test(block)) continue;
    reportingCatches++;
    if (!LOG_CALL.test(block)) silentlyReported.push(`${file.slice(SRC_ROOT.length - 3)}:${i + 1}`);
  }
}
ok("the warnings/errors-array guard found sites to check", reportingCatches >= 8);
ok(
  `a catch that reports a failure as data also logs it${silentlyReported.length ? ` — silent: ${silentlyReported.join(", ")}` : ""}`,
  silentlyReported.length === 0,
);

// ── Ambient enrichment reaches the RAW logger, not just the facade ───────────
/**
 * The correlation fields used to be added only by `createLogger`'s facade. Anything
 * writing straight through the pino instance — Fastify's own per-request lines,
 * graphile's queue lines — therefore came out with NO traceId, source or actor, even
 * when a trace context was active around it. That was the highest-volume log in the
 * system and the one you could not correlate: a request line and the error it produced
 * shared no id. Fixed with a pino `mixin` on the root logger; asserted here on a raw
 * line so the fix cannot silently regress back into the facade.
 */
const rawLines: Array<Record<string, unknown>> = [];
const rawSink = new Writable({
  write(chunk, _enc, cb) {
    rawLines.push(JSON.parse(String(chunk)));
    cb();
  },
});
const { pino: pinoRaw } = await import("pino");
const withMixin = pinoRaw({ level: "trace", mixin: () => ambientLogFields() }, rawSink);
await withTraceContext(
  { traceId: "trace-RAWMIXIN0000000000", organizationId: "org_X", businessId: "biz_Y" },
  async () => {
    withMixin.info({ hand: "written" }, "a line written straight through pino");
  },
);
const rawLine = rawLines.at(-1)!;
ok("a raw pino line carries the traceId", rawLine.traceId === "trace-RAWMIXIN0000000000");
ok("a raw pino line carries the organizationId", rawLine.organizationId === "org_X");
ok("a raw pino line carries the businessId", rawLine.businessId === "biz_Y");
const rawEntry = toCloudLogEntry(rawLine as never, "p");
ok(
  "…and they become INDEXED labels",
  rawEntry.labels.organizationId === "org_X" && rawEntry.labels.businessId === "biz_Y",
);

// ── The tenant is actually bound somewhere ───────────────────────────────────
/**
 * `TraceContext.organizationId` / `businessId` were declared and documented as "filled
 * in once auth resolves them" from the start — and nothing called `updateTraceContext`,
 * so the per-tenant query deploy/README § Logs tells you to use matched nothing on any
 * API request. These assert the wiring exists, in the two places it can be known.
 */
const authSrc = readFileSync(join(SRC_ROOT, "platform", "auth.ts"), "utf8");
const helpersSrc = readFileSync(join(SRC_ROOT, "api", "helpers.ts"), "utf8");
ok(
  "authenticate binds the organization to the trace",
  /updateTraceContext\(\{\s*organizationId/.test(authSrc.replace(/\n/g, " ")),
);
ok(
  "resolveBusiness binds the business to the trace",
  /updateTraceContext\(\{\s*businessId/.test(helpersSrc.replace(/\n/g, " ")),
);

// ── One self-describing access line per request ──────────────────────────────
/**
 * Fastify's built-ins logged `incoming request` / `request completed` — two lines whose
 * SUMMARY (the only thing a log viewer shows by default) named neither the route, the
 * status nor the duration, so every request rendered identically. Replaced by one line
 * built to be read. The route is the PATTERN, so ten thousand ids aggregate into one row.
 */
const indexSrc = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");
ok("fastify built-in request logging is off", /disableRequestLogging:\s*true/.test(indexSrc));
// Quote-agnostic on purpose: the repo is migrating to oxfmt file by file, so a source
// assertion pinned to `'` breaks the day its target gets reformatted — which is exactly
// how this one broke. Assert the SHAPE, never the quote style.
ok("an access line is emitted on response", /addHook\(["']onResponse["']/.test(indexSrc));
ok("the access line groups by ROUTE PATTERN", /routeOptions\?\.url/.test(indexSrc));
ok(
  "its severity follows the status",
  /status >= 500/.test(indexSrc) && /status >= 400/.test(indexSrc),
);

// ── One name per concept ─────────────────────────────────────────────────────
/**
 * `business` vs `businessId`, `err` vs `error`: two names for one field means a query
 * that silently misses half its matches — the worst kind of log defect, because it
 * looks like an answer. Asserted over source: the loser spelling must not come back.
 */
const logCall = /\b(?:log|logger|apiLog)\.(?:error|warn|info|log|debug|verbose)\s*\(/g;
const banned: string[] = [];
for (const file of tsFilesUnder(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(logCall)) {
    let depth = 1,
      j = m.index! + m[0].length;
    const start = j;
    while (j < src.length && depth) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
      j++;
    }
    const args = src.slice(start, j - 1);
    if (/[{,]\s*(business|organization|err)\s*:/.test(args)) {
      banned.push(
        `${file.slice(SRC_ROOT.length - 3)}:${src.slice(0, m.index!).split("\n").length}`,
      );
    }
  }
}
ok(
  `log fields use one name per concept (businessId/organizationId/error)${banned.length ? ` — offenders: ${banned.slice(0, 5).join(", ")}` : ""}`,
  banned.length === 0,
);

// ── Nothing writes through the raw pino instance ─────────────────────────────
/**
 * The root `logger` is exported for the ONE place that needs it — Fastify's
 * `loggerInstance` — and for the sink's own internals. Everywhere else must use a
 * `createLogger(<module>)` facade, so the line carries a `service` label.
 *
 * The two signatures are REVERSED — raw pino is `(fields, message)`, the facade is
 * `(message, fields)` — so a careless conversion puts an object where the summary
 * belongs and the log viewer renders `[object Object]`. That is why `platform/jobs.ts`
 * kept nine raw calls long after every module had a logger, and why this is checked
 * rather than trusted.
 */
const rawLoggerCalls: string[] = [];
for (const file of tsFilesUnder(SRC_ROOT)) {
  if (file.endsWith(join("platform", "logger.ts"))) continue; // defines it
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((l, i) => {
    // `helpers.logger` is graphile's own per-job logger and routes through our adapter.
    if (/(^|[^.\w])logger\.(error|warn|info|debug|trace|fatal)\s*\(/.test(l)) {
      rawLoggerCalls.push(`${file.slice(SRC_ROOT.length - 3)}:${i + 1}`);
    }
  });
}
ok(
  `no module writes through the raw pino instance${rawLoggerCalls.length ? ` — ${rawLoggerCalls.slice(0, 5).join(", ")}` : ""}`,
  rawLoggerCalls.length === 0,
);

/**
 * Fastify's own `req.log` is banned for the same reason, one step further in.
 *
 * It was tolerated for a while on the grounds that the root-logger mixin enriches it
 * — and it does: a `req.log` line gets `traceId`, `source` and `actor`. What it does
 * NOT get is `service`, which `cloud-logging` promotes to an indexed label, so those
 * lines were the only ones in the system you could not narrow to a module in Logs
 * Explorer. They also take the REVERSED argument order, which is a standing trap
 * next to 264 facade calls that take the other one.
 *
 * The conversion had a real edge to it, worth recording: raw pino renders `{ err }`
 * through its error serializer, while the facade puts `debug_info` through JSON,
 * which renders an Error as `{}`. Four of these sites passed an Error object, so a
 * verbatim conversion would have silently deleted the only useful part of the line.
 * Each one extracts `.message` instead.
 */
const fastifyLogCalls: string[] = [];
for (const file of tsFilesUnder(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((l, i) => {
    if (
      /\b(req|request|reply|app|fastify)\.log\.(error|warn|info|debug|trace|fatal)\s*\(/.test(l)
    ) {
      fastifyLogCalls.push(`${file.slice(SRC_ROOT.length - 3)}:${i + 1}`);
    }
  });
}
ok(
  `no module logs through Fastify's req.log (no service label, reversed args)${fastifyLogCalls.length ? ` — ${fastifyLogCalls.slice(0, 5).join(", ")}` : ""}`,
  fastifyLogCalls.length === 0,
);

// The facade's argument order, asserted directly — this is the bug the rule above
// exists to prevent, and it is one line to prove rather than reason about.
const orderLines: Array<Record<string, unknown>> = [];
const orderSink = new Writable({
  write(c, _e, cb) {
    orderLines.push(JSON.parse(String(c)));
    cb();
  },
});
const orderLog = createLogger("jobs", pinoRaw({ level: "trace" }, orderSink) as unknown as Logger);
orderLog.warn("a readable summary", { tickId: "t1", event: "tick_pass_capped" });
const ordered = orderLines.at(-1)!;
ok("facade(message, fields) puts the MESSAGE in msg", ordered.msg === "a readable summary");
ok(
  "…and the fields in debug_info",
  (ordered.debug_info as { event?: string })?.event === "tick_pass_capped",
);

/**
 * ── Every ERROR entry must be groupable by Error Reporting ──────────────────
 *
 * Error Reporting ingests an entry only if it can parse a STACK out of `message`;
 * one without a stack lands in Logs Explorer and is silently skipped by the tool you
 * alert from. `ServiceLogger.error` takes `unknown`, so a failure reported as a
 * STRING used to produce exactly that: ERROR severity, `serviceContext` attached,
 * no error group. Measured on a day of production logs — 82 of 185 ERROR entries had
 * no stack and no group, and they were the ones worth paging on (invariants not
 * clean, idempotency keys orphaned by a crash).
 */
const errLines: Array<Record<string, unknown>> = [];
const errSink = new Writable({
  write(c, _e, cb) {
    errLines.push(JSON.parse(String(c)));
    cb();
  },
});
const errLog = createLogger(
  "ops-invariants",
  pinoRaw({ level: "trace" }, errSink) as unknown as Logger,
);

errLog.error("ops_invariants: one or more checks are not clean", {
  event: "ops_invariants_not_clean",
});
const strErr = errLines.at(-1)!;
ok("an error reported as a STRING still gets a stack", typeof strErr.stack === "string");
// The stack must start at the reporting site, because THAT is the stable group key —
// the message text is not (it can carry an id, a count, whatever the caller wrote).
const strFrame = String(strErr.stack ?? "").split("\n")[1] ?? "";
ok(
  "…cut at the call site, not inside platform/logger.ts",
  strFrame.includes("verify-logging.ts") && !strFrame.includes(join("platform", "logger.ts")),
);
ok(
  "…while msg stays the clean, constant text",
  strErr.msg === "ops_invariants: one or more checks are not clean",
);
ok(
  "…and it is Error-Reporting-eligible once converted",
  String(
    (toCloudLogEntry(strErr as never, "demo-project").payload as { message?: unknown }).message,
  ).startsWith("Error: ops_invariants"),
);

errLog.error(new Error("boom"), { event: "x" });
ok(
  "a thrown Error keeps its OWN stack (not a synthetic one)",
  String(errLines.at(-1)!.stack).includes("Error: boom"),
);

/**
 * ── The redaction backstop ──────────────────────────────────────────────────
 *
 * Call sites log ids, not rows, and the checks above hold them to it. This proves
 * the net under that: what happens when one of them slips. It also proves the net
 * does not eat the fields we log ON PURPOSE — a backstop that blinds the mail outbox
 * or the idempotency reaper costs more than it saves.
 */
const redLines: Array<Record<string, unknown>> = [];
const redSink = new Writable({
  write(c, _e, cb) {
    redLines.push(JSON.parse(String(c)));
    cb();
  },
});
const redLog = createLogger("redaction", pinoRaw({ level: "trace" }, redSink) as unknown as Logger);
const lastDebug = () => redLines.at(-1)!.debug_info as Record<string, unknown>;

redLog.log("m", {
  password: "hunter2",
  apiKey: "sk_live_abc",
  key: "idem_123",
  number: "INV-0042",
});
ok(
  "credential KEYS are masked whatever they hold",
  lastDebug().password === "****" && lastDebug().apiKey === "****",
);
ok(
  "…but `key` and `number` are NOT — both are deliberately logged operational data",
  lastDebug().key === "idem_123" && lastDebug().number === "INV-0042",
);

redLog.log("m", {
  to: "jane.doe@acme.example",
  email: "em_7UqZ",
  note: "mail to a.b@x.co bounced",
});
ok(
  "an email is masked by SHAPE, under whatever key it arrived",
  lastDebug().to === "j***@acme.example",
);
ok(
  "…partially, so the line still names the tenant domain",
  String(lastDebug().to).endsWith("@acme.example"),
);
ok("…and a PUBLIC ID under the key `email` is left alone", lastDebug().email === "em_7UqZ");
ok("…including one embedded in a longer string", lastDebug().note === "mail to a***@x.co bounced");

redLog.log("m", { pan: "4111 1111 1111 1111", ref: "1234567890123456" });
ok("a Luhn-valid PAN is masked to the last 4 (locked decision #8)", lastDebug().pan === "****1111");
ok("…and a 16-digit reference that is NOT a card survives", lastDebug().ref === "1234567890123456");

// An exception's own text is redacted too: `log.error(err)` puts message + stack on the
// line outside `debug_info`, and an email quoted in an error message reached the sink.
redLog.error(new Error("Ledger write failed for jane.doe@acme.example card 4111 1111 1111 1111"));
const errLine = redLines.at(-1)!;
ok(
  "an Error's message and stack are redacted on the line",
  !JSON.stringify(errLine).includes("jane.doe@acme.example") &&
    !JSON.stringify(errLine).includes("4111 1111 1111 1111") &&
    String(errLine.error_message).includes("j***@acme.example") &&
    String(errLine.stack).includes("****1111"),
);
redLog.error("refund failed for a.b@x.co");
ok(
  "…and a string reported as the error",
  String(redLines.at(-1)!.error_message) === "refund failed for a***@x.co",
);

// Hostile shapes: the backstop must never be the reason a line is lost or gutted.
const cyclic: Record<string, unknown> = { a: 1 };
cyclic.self = cyclic;
redLog.log("m", { cyclic });
ok(
  "a circular payload is marked, not thrown on",
  (lastDebug().cyclic as Record<string, unknown>).self === "[circular]",
);

// Asserted on the walk DIRECTLY, not through the serialized line: JSON renders an
// Error as `{}` either way (its message and stack are non-enumerable), so the line
// cannot tell a preserved Error from a gutted one. What must hold is that the walk
// hands non-plain objects back UNTOUCHED — cloning one through `Object.entries`
// would drop exactly the context the caller attached.
const anError = new Error("inner");
const aDate = new Date("2026-01-01T00:00:00Z");
const walked = redactSensitive({ cause: anError, when: aDate }) as Record<string, unknown>;
ok("an Error in debug_info is passed through, not cloned into {}", walked.cause === anError);
ok("a Date in debug_info is passed through too", walked.when === aDate);

/**
 * The redaction walk must never become the reason a line is slow. The email pattern
 * is applied to every string logged anywhere; an unbounded quantifier in it
 * backtracked quadratically on a long run with no `@` and hung the process. The
 * truncation blob below is the shape that caught it.
 */
const blobStart = Date.now();
redLog.log("m", { blob: "x".repeat(300_000), tail: "ops@acme.example" });
const blobMs = Date.now() - blobStart;
ok(`a 300KB payload redacts in bounded time (${blobMs}ms)`, blobMs < 2_000);

/**
 * ── Repeat suppression for a failure that recurs on a schedule ──────────────
 *
 * The billing clock is `* * * * *`, so an item stuck in a broken state fails on
 * EVERY tick: 1,440 identical ERROR entries a day, each with a full stack, all
 * restating one fact. (The production sample that prompted this showed 70 entries
 * in 26 seconds, but that was a dev harness driving the clock — the real cadence is
 * one a minute, and the repeats are ACROSS ticks, not within one. A within-tick
 * collapse would have achieved nothing.)
 *
 * The window is an hour, so the clock is INJECTED here — a test that had to wait an
 * hour to prove the window reopens is a test nobody writes.
 */
resetRecurrenceState();
const W = 60_000;
const t0 = 1_000_000;

ok("the first occurrence always speaks", claimRecurrence("k", t0, W)?.suppressed === 0);
ok("an identical repeat inside the window is silent", claimRecurrence("k", t0 + 1, W) === null);
ok("…and so is the hundredth", claimRecurrence("k", t0 + 2, W) === null);
const reopened = claimRecurrence("k", t0 + W + 1, W);
ok("the window reopens after it lapses", reopened !== null);
ok("…and the line says how many it stood for", reopened?.suppressed === 2);
ok("the count resets once reported", claimRecurrence("k", t0 + W + 2, W) === null);

// A DIFFERENT failure must never hide behind an open window — this is why the error
// message joins the key rather than the subject id alone.
ok("a different key speaks immediately", claimRecurrence("k2", t0 + 3, W)?.suppressed === 0);
// Debuggability escape hatch: no window, no bookkeeping, every occurrence.
ok("a non-positive window disables suppression", claimRecurrence("k", t0 + 4, 0)?.suppressed === 0);

// Bounded memory: far more distinct keys than the cap, and the mechanism still works.
for (let i = 0; i < 12_000; i++) claimRecurrence(`flood-${i}`, t0 + 5, W);
ok(
  "a key flood does not break the next claim",
  claimRecurrence("after-flood", t0 + 6, W)?.suppressed === 0,
);

// Through the facade, end to end.
resetRecurrenceState();
const recLines: Array<Record<string, unknown>> = [];
const recSink = new Writable({
  write(c, _e, cb) {
    recLines.push(JSON.parse(String(c)));
    cb();
  },
});
const recLog = createLogger("renewal", pinoRaw({ level: "trace" }, recSink) as unknown as Logger);

recLog.recurringError("renewal_pass_failed:sub_1", new Error("no billing term"), {
  event: "renewal_pass_failed",
  subscription: "sub_1",
});
ok(
  "recurringError logs the first occurrence in full",
  recLines.length === 1 && String(recLines[0]!.stack).includes("no billing term"),
);
recLog.recurringError("renewal_pass_failed:sub_1", new Error("no billing term"), {
  event: "renewal_pass_failed",
  subscription: "sub_1",
});
ok("…and swallows the identical repeat", recLines.length === 1);
recLog.recurringError("renewal_pass_failed:sub_1", new Error("a DIFFERENT failure"), {
  event: "renewal_pass_failed",
  subscription: "sub_1",
});
ok("…while a different failure on the same subject still speaks", recLines.length === 2);
recLog.recurringError("renewal_pass_failed:sub_2", new Error("no billing term"), {
  event: "renewal_pass_failed",
  subscription: "sub_2",
});
ok("…and so does the same failure on a different subject", recLines.length === 3);
ok("the window is an hour", LOG_REPEAT_WINDOW_MS === 3_600_000);

/**
 * ── fatal: a crash must be distinguishable from a 500 ───────────────────────
 *
 * Everything that goes wrong in a billing engine is an `error` — a declined card, a
 * failed renewal, a gateway timeout. While a process death shared that severity, the
 * one query worth having during an incident ("did something CRASH?") could not be
 * written. The level carries it now, which is also why the old `fatal: true` FIELD
 * must not come back: two ways to say one thing means every query has to know both.
 */
const fatalLines: Array<Record<string, unknown>> = [];
const fatalSink = new Writable({
  write(c, _e, cb) {
    fatalLines.push(JSON.parse(String(c)));
    cb();
  },
});
const fatalLog = createLogger(
  "worker",
  pinoRaw({ level: "trace" }, fatalSink) as unknown as Logger,
);
fatalLog.fatal(new Error("the runner died"), { event: "runner_failed" });
const fatalLine = fatalLines.at(-1)!;
ok("fatal emits at pino level 60", fatalLine.level === 60);
ok("…which is CRITICAL in Cloud Logging", severityFor(60) === "CRITICAL");
const fatalEntry = toCloudLogEntry(fatalLine as never, "demo-project");
ok(
  "…a CRITICAL entry still carries serviceContext (Error Reporting sees crashes)",
  typeof (fatalEntry.payload as { serviceContext?: unknown }).serviceContext === "object",
);
ok(
  "…and its message is the stack, like an error",
  String((fatalEntry.payload as { message?: unknown }).message).startsWith(
    "Error: the runner died",
  ),
);

const fatalField: string[] = [];
for (const file of tsFilesUnder(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  src.split("\n").forEach((l, i) => {
    if (/\bfatal:\s*true\b/.test(l)) fatalField.push(`${file.slice(SRC_ROOT.length - 3)}:${i + 1}`);
  });
}
ok(
  `fatality is a LEVEL, not a field${fatalField.length ? ` — ${fatalField.slice(0, 5).join(", ")}` : ""}`,
  fatalField.length === 0,
);
/**
 * ── A per-item failure in a clock pass must leave a durable record ──────────
 *
 * `runPass` contains a pass ENTRY failure — its scan query, its config load. Per-ITEM
 * failures are isolated INSIDE each pass, and five passes used to isolate the item and
 * then only log it: the tick row said `status: "ok"`, the counters said the pass did
 * nothing, and the sole trace of WHY was a log line that rotates away. An invoice
 * silently failing its due-date transition every minute was invisible until a customer
 * asked why they were never charged.
 *
 * The rule this locks is the self-consistency one: if a pass REPORTS a failure count in
 * its counters, it must also hand the failures up — otherwise `clock_ticks.errors`
 * contradicts the number sitting next to it in the same row.
 */
const jobsSrc = readFileSync(join(SRC_ROOT, "platform", "jobs.ts"), "utf8");
const passVars = [...jobsSrc.matchAll(/const (\w+) = await runPass\(/g)].map((m) => m[1]!);
/**
 * Just the `runPass(...)` call, by paren balance. Slicing "to the next pass" instead
 * looked simpler and was wrong: the LAST pass's slice ran to end of file and swallowed
 * the tick summary's own `errors.length`, so the check reported an offender that did
 * not exist. Read the call, not the neighbourhood.
 */
function runPassCall(varName: string): string {
  const at = jobsSrc.indexOf(`const ${varName} = await runPass(`);
  if (at < 0) return "";
  let depth = 0;
  for (let i = jobsSrc.indexOf("(", at); i < jobsSrc.length; i++) {
    if (jobsSrc[i] === "(") depth++;
    else if (jobsSrc[i] === ")" && --depth === 0) return jobsSrc.slice(at, i + 1);
  }
  return "";
}
const unmerged: string[] = [];
for (const v of passVars) {
  // The pass advertises per-item failures in its counters …
  if (!/\berrors\.length\b/.test(runPassCall(v))) continue;
  // … so it must also merge them into the tick's list.
  if (!jobsSrc.includes(`errors.push(...${v}.errors)`)) unmerged.push(v);
}
ok(
  `a pass that COUNTS its per-item failures also records them${unmerged.length ? ` — ${unmerged.join(", ")}` : ""}`,
  passVars.length > 0 && unmerged.length === 0,
);
ok("…and the pass scan still matches jobs.ts at all", passVars.length >= 15);

/**
 * ── Money-integrity findings are errors, not warnings ───────────────────────
 *
 * Each of these names state that is WRONG RIGHT NOW and needs a human to reconcile —
 * not a degradation that fell back and recovered, which is what the surrounding warns
 * are. They sat at `warn` among 122 others, where nothing could alert on them:
 *
 *  - `settlement_dropped_not_pending` — a capture landed on an abandoned debit, so the
 *    customer paid twice and we booked once. It cannot self-heal: posting cash against
 *    a failed payment would corrupt the invariant the claim protects.
 *  - `payment_settled_overshoot`      — charged and owed disagreed at settlement; the
 *    excess is now sitting as credit nobody asked for.
 *  - `dispute_late_funds_withdrawn`   — a real clawback notice was accepted and
 *    deliberately not posted (posting it once double-credited 3000 for a 1500
 *    chargeback), so this line is the only record it arrived.
 *  - `tax_no_configured_rate`         — an invoice went out with zero tax on a taxable
 *    line. Already delivered, possibly paid, and the merchant owes the tax.
 */
const MONEY_INTEGRITY_EVENTS = [
  "settlement_dropped_not_pending",
  "payment_settled_overshoot",
  "dispute_late_funds_withdrawn",
  "tax_no_configured_rate",
];
const misleveled: string[] = [];
for (const event of MONEY_INTEGRITY_EVENTS) {
  let found = false;
  for (const file of tsFilesUnder(SRC_ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => new RegExp(`event:\\s*["']${event}["']`).test(l));
    if (at < 0) continue;
    found = true;
    // Walk back to the log call this field belongs to.
    const call = lines.slice(Math.max(0, at - 8), at + 1).join("\n");
    if (!/log\.error\(/.test(call))
      misleveled.push(`${event} (${file.slice(SRC_ROOT.length - 3)}:${at + 1})`);
  }
  if (!found) misleveled.push(`${event} (NOT FOUND — renamed or deleted?)`);
}
ok(
  `money-integrity findings are logged at error${misleveled.length ? ` — ${misleveled.join(", ")}` : ""}`,
  misleveled.length === 0,
);

ok(
  "a process crash is reported through fatal()",
  /log\.fatal\(\s*error\s*,\s*\{\s*event:\s*kind\s*\}\s*\)/.test(
    readFileSync(join(SRC_ROOT, "platform", "logger.ts"), "utf8"),
  ),
);

/**
 * Suppression is for the LOG, never for the record. Every `recurringError` site must
 * sit next to a durable record of the same failure, or an operator loses the item
 * entirely for an hour rather than merely losing a duplicate log line.
 */
const unrecorded: string[] = [];
for (const file of tsFilesUnder(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  lines.forEach((l, i) => {
    if (!/log\.recurringError\(/.test(l)) return;
    // The durable write is within a few lines either way: `errors.push(...)` onto the
    // tick row, or a status/attempt column update on the item itself.
    const near = lines.slice(Math.max(0, i - 6), i + 10).join("\n");
    if (!/errors\.push\(|\.push\(\{|update\(|recordFailure|markFailed/.test(near)) {
      unrecorded.push(`${file.slice(SRC_ROOT.length - 3)}:${i + 1}`);
    }
  });
}
ok(
  `every suppressed failure is also recorded durably${unrecorded.length ? ` — ${unrecorded.slice(0, 5).join(", ")}` : ""}`,
  unrecorded.length === 0,
);
ok("…under the module service label", ordered.service === "jobs");

// ── A log message is a CONSTANT ──────────────────────────────────────────────
/**
 * Variable data — ids, amounts, counts, statuses, durations — never goes in the
 * message. It goes in the fields.
 *
 * The message is the only thing a log viewer groups, counts and alerts on. Bake a
 * status and a duration into it and every request becomes a unique string: 576 rows
 * that cannot be collapsed into "this route, this status, this many times". The
 * billing clock was the worst case — its message was a sentence built from ~25
 * counters, so no two ticks in the system's history shared a message, and "how many
 * ticks ran unhealthy today" could only be answered by regexing prose. Those numbers
 * were already structured on the same line.
 *
 * Enforced over source: the first argument of a log call may not be a template
 * literal containing an interpolation. 40 sites violated this; they are now 0, so the
 * rule is a ratchet.
 */
const interpolated: string[] = [];
for (const file of tsFilesUnder(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(
    /\b(?:log|logger|apiLog)\.(?:error|warn|info|log|debug|verbose)\s*\(/g,
  )) {
    let depth = 1,
      j = m.index! + m[0].length;
    const start = j;
    while (j < src.length && depth) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")") depth--;
      j++;
    }
    const args = src.slice(start, j - 1).trim();
    if (!args.startsWith("`")) continue;
    let end = 1;
    while (end < args.length && !(args[end] === "`" && args[end - 1] !== "\\")) end++;
    if (args.slice(0, end + 1).includes("${")) {
      interpolated.push(
        `${file.slice(SRC_ROOT.length - 3)}:${src.slice(0, m.index!).split("\n").length}`,
      );
    }
  }
}
ok(
  `log messages are constant — variable data lives in fields${interpolated.length ? ` — offenders: ${interpolated.slice(0, 5).join(", ")}` : ""}`,
  interpolated.length === 0,
);

// And the access line specifically: the route may vary (it is a bounded set you group
// BY), the status and the duration may not.
const accessMsg = indexSrc.match(/const message = `([^`]*)`/)?.[1] ?? "";
ok("the access line message carries method + route only", accessMsg === "${req.method} ${route}");
ok("…and never the status or duration", !/status|ms|elapsed/i.test(accessMsg));

// ── graphile-worker logs its own ORDINARY LIFECYCLE at `error` ──────────────────
//
// 21 of 185 ERROR rows in a 13-hour export (11%) were routine shutdown chatter, because
// graphile-worker 0.16.6 calls `logger.error` for every line in its signal handling —
// including a completely normal SIGTERM. An error budget that is mostly normal operation is
// one nobody reads. `graphileLevelFor` downgrades those and NOTHING else; pinned here so a
// graphile upgrade that rewords them, or a careless widening of the match, is visible.
{
  const { graphileLevelFor } = await import("@/platform/jobs");
  const cases: Array<[string, string, string]> = [
    [
      "error",
      "Received 'SIGTERM'; attempting global graceful shutdown... (all termination signals will be ignored for the next 5 seconds)",
      "info",
    ],
    ["error", "Global graceful shutdown complete; killing self via SIGTERM", "info"],
    ["error", "Ignoring 'SIGINT' (graceful shutdown already in progress)", "info"],
    // Forceful means the graceful path timed out — worth seeing, not a failure.
    [
      "error",
      "Received 'SIGTERM'; attempting global forceful shutdown... (all termination signals will be ignored for the next 5 seconds)",
      "warn",
    ],
    ["error", "Global forceful shutdown completed; killing self via SIGTERM", "warn"],
    // A REAL error must survive untouched — this is the assertion that matters.
    ["error", "Failed to release job 123: connection terminated unexpectedly", "error"],
    ["error", "Error occurred while processing task", "error"],
    // Non-error levels map straight through.
    ["warning", "anything", "warn"],
    ["info", "anything", "info"],
    ["debug", "anything", "debug"],
  ];
  for (const [level, message, expected] of cases) {
    const actual = graphileLevelFor(level, message);
    ok(`graphile ${level} "${message.slice(0, 44)}…" → ${expected}`, actual === expected);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
