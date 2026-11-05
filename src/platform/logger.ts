import { createRequire } from "node:module";
import { pino, multistream } from "pino";
import { config } from "./config";
import { getTraceContext } from "./trace";
import { currentEventContext } from "./event-context";
import { createCloudLoggingSink, flushCloudLogging } from "./cloud-logging";
import { safeStringify } from "./log-truncation";

/**
 * Structured logging with trace correlation.
 *
 * The root `logger` is plain pino and stays exported unchanged (existing callers
 * use `logger.info(...)`). On top of it, `createLogger(service)` returns the
 * ergonomics `log/error/warn/debug/verbose(message, debug_info)`, while every line
 * automatically carries:
 *
 *  - `service`  — the module that logged it (`createLogger('checkout')`)
 *  - `traceId`  — from `platform/trace`, correlating one execution end-to-end
 *  - `source` / `actor` — from `platform/event-context` (api / dashboard /
 *    scheduled_job / migration / system, and who)
 *
 * Why a facade rather than a pino child logger: the contexts are async-scoped, so
 * the fields must be read AT LOG TIME. A child logger binds its fields once at
 * construction, which would capture the wrong trace (or none at all) for a
 * module-level logger created at import time.
 */

/**
 * Human-readable stdout for local dev. `pino-pretty` is a devDependency, so it is
 * required through a try/catch rather than imported: a production install has no
 * such module, and the sink layout below (multistream) can't defer the decision to
 * pino's own lazily-loaded `transport` target the way the plain logger did.
 */
function prettyStreamOrStdout(): NodeJS.WritableStream {
  if (config.NODE_ENV !== "development") return process.stdout;
  try {
    const require = createRequire(import.meta.url);
    const pretty = require("pino-pretty") as (opts: unknown) => NodeJS.WritableStream;
    return pretty({ colorize: true });
  } catch {
    return process.stdout;
  }
}

/**
 * The root logger.
 *
 * Two shapes, one behaviour:
 *  - cloud logging OFF (default, and every test/script/CLI): unchanged — pino to
 *    stdout, pretty in development.
 *  - cloud logging ON: a multistream fanning out to stdout *and* the Google Cloud
 *    Logging sink, so pm2's local log files and Logs Explorer see the same lines.
 *    stdout is kept deliberately — a sink outage must not blind the box itself.
 */
function buildRootLogger() {
  const sink = createCloudLoggingSink();
  if (!sink) {
    return pino({
      level: config.LOG_LEVEL,
      // Every line, including ones written straight through this instance.
      mixin: ambientLogFields,
      ...(config.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { colorize: true } } }
        : {}),
    });
  }
  return pino(
    { level: config.LOG_LEVEL, mixin: ambientLogFields },
    multistream(
      [
        { level: config.LOG_LEVEL, stream: prettyStreamOrStdout() },
        { level: config.CLOUD_LOGGING_LEVEL, stream: sink.stream },
      ],
      { dedupe: false },
    ),
  );
}

export const logger = buildRootLogger();

export type Logger = typeof logger;

/** Re-exported so shutdown paths have one import for "get the last lines out". */
export { flushCloudLogging };

/**
 * Cap on a single entry's serialized `debug_info`. Unlike the cloud sink (GCP's
 * 256KB protobuf entry cap) nothing here rejects a big line — but an unbounded
 * payload still floods stdout, costs money in any log sink, and buries the
 * message it was attached to. 64KB is far above any legitimate debug payload.
 */
const MAX_DEBUG_INFO_BYTES = 64 * 1024;

// ── Redaction backstop ───────────────────────────────────────────────────────
/**
 * `debug_info` is free-form — the call sites decide what goes in it, and today they
 * decide well (public ids, not rows). Nothing ENFORCED that, though, and the blast
 * radius of one careless `log.error(e, { customer })` is a real name, email and
 * address sitting in Cloud Logging for the retention period. This is a BACKSTOP,
 * not the policy: call sites should still log ids, and `verify:logging` still holds
 * them to it.
 *
 * Three rules, deliberately different in kind:
 *
 *  - **Credential KEYS** are masked whatever they hold — a field called `password`
 *    or `cvv` has no legitimate logged value. Matched narrowly on purpose: the
 *    provider-side regex in `providers/http.ts` masks bare `key`, `number` and
 *    `account`, which is right for a gateway body and wrong here, where it would
 *    redact the `key` in `{ key: idempotencyKey }` and the `number` in an invoice
 *    number — both deliberately logged, both needed to debug the line they are on.
 *
 *  - **Email-shaped VALUES** are masked by SHAPE, not by key, because a leak
 *    arrives under whatever name the row happened to use (`to`, `billing_email`,
 *    `contact`). Shape-matching also spares `{ email: 'em_7Uq…' }` in the mail
 *    outbox, where the key says email and the value is a public id — a key-based
 *    rule would have blinded that log for nothing. Masked PARTIALLY, so the line
 *    still says which domain (and which tenant) it concerned.
 *
 *  - **PAN-shaped VALUES** — 13–19 digits passing Luhn — are masked to the last 4.
 *    Locked decision #8 is that a PAN never reaches our storage, and a log line IS
 *    storage. Luhn is what keeps a 16-digit reference number from being mangled by
 *    a length test alone.
 */
const CREDENTIAL_KEY_RE =
  /^(?:.*_)?(?:password|passwd|secret|token|authorization|cookie|credential|signature|cvv|cvc|pin|otp|apikey|api_key|accesskey|access_key|privatekey|private_key|clientsecret|client_secret|cardnumber|card_number|accountnumber|account_number|iban|ssn)$/i;

/**
 * Global so it also catches an address embedded in a longer string.
 *
 * Every quantifier is BOUNDED, and that is not cosmetic. The unbounded first
 * version (`[A-Za-z0-9._%+-]+@…`) backtracks quadratically on a long run of
 * matching characters that never reaches an `@`: it matched all 300,000 chars of
 * a truncation-test blob, failed, backed off one char at a time, then restarted
 * from the next offset — and hung the process outright. `verify:logging` caught it
 * because it logs exactly such a blob. The bounds are RFC-shaped anyway (64-char
 * local part, 255-char domain), so correctness and safety agree here.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;
/** Digit runs long enough to be a PAN, allowing the usual space/dash grouping. */
const PAN_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Luhn — the difference between masking a card and mangling an invoice reference. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** `vendor@example.com` → `v***@example.com`. Enough to identify the tenant, not the person. */
function maskEmail(address: string): string {
  const at = address.indexOf("@");
  if (at <= 0) return "****";
  return `${address[0]}***${address.slice(at)}`;
}

function redactString(value: string): string {
  // `includes` is a native scan and the overwhelmingly common answer is "no @" —
  // this keeps a large blob (a truncated response body, a stack) at one linear pass
  // instead of running the email machine over it at all.
  return maskPans(value.includes("@") ? value.replace(EMAIL_RE, maskEmail) : value);
}

/** Card numbers (Luhn-valid digit runs) → `****1234`. Shared with the request log's redaction. */
export function maskPans(value: string): string {
  return value.replace(PAN_RE, (m) => {
    const digits = m.replace(/[ -]/g, "");
    return passesLuhn(digits) ? `****${digits.slice(-4)}` : m;
  });
}

/**
 * Deep-walk and redact. Only PLAIN objects and arrays are cloned: an Error, Date or
 * Buffer in `debug_info` is handed back untouched, because cloning one through
 * `Object.entries` returns `{}` (its useful properties are non-enumerable) and would
 * destroy the very context the caller attached. `seen` guards the cycle a request or
 * an ORM row will eventually bring.
 */
export function redactSensitive(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";

  const proto = Object.getPrototypeOf(value);
  const isPlain = proto === Object.prototype || proto === null;
  if (!Array.isArray(value) && !isPlain) return value;

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactSensitive(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = CREDENTIAL_KEY_RE.test(k) ? "****" : redactSensitive(v, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Keep `debug_info` loggable: redact it, then pass it through when it's small, else
 * replace it with a truncated preview plus the original size, so the entry still
 * says what it was carrying instead of silently dropping it.
 */
function boundDebugInfo(debugInfo: unknown): unknown {
  if (debugInfo === undefined) return undefined;
  const redacted = redactSensitive(debugInfo);
  const serialized = safeStringify(redacted);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_DEBUG_INFO_BYTES) return redacted;
  return { _truncated: true, _originalBytes: bytes, preview: serialized.slice(0, 2000) };
}

/**
 * Pull a message + stack out of anything a `catch` block might hand us.
 *
 * A non-Error gets a SYNTHETIC stack, and that is the whole point of this function
 * rather than a two-line destructure. Cloud Error Reporting groups an entry by
 * parsing a stack out of its `message` (see `cloud-logging.ts` § toCloudLogEntry);
 * an entry with no stack is ingested by Logs Explorer and then silently skipped by
 * Error Reporting — ERROR severity, `serviceContext` attached, and invisible in the
 * one tool you would alert from. Measured on a day of production logs: 82 of 185
 * ERROR entries had no stack and no error group, and they were the interesting ones
 * (invariants not clean, idempotency keys orphaned by a crash).
 *
 * `stackBoundary` is the frame to cut ABOVE, so the synthetic stack starts at the
 * `log.error(...)` call site instead of inside this module. That makes the group key
 * the call site — stable — rather than the message text, which is not.
 */
function describeError(
  error: unknown,
  stackBoundary?: (...args: never[]) => unknown,
): { message: string; stack?: string } {
  // Redacted like `debug_info`: an exception message often quotes the value that broke it,
  // and an email or card in it would otherwise reach the sink verbatim.
  if (error instanceof Error) {
    return {
      message: redactString(error.message),
      ...(error.stack ? { stack: redactString(error.stack) } : {}),
    };
  }
  const message =
    typeof error === "string" ? redactString(error) : safeStringify(redactSensitive(error));
  const synthetic = new Error(message);
  // V8 only. Elsewhere the stack still exists, it just includes this frame.
  if (stackBoundary && typeof Error.captureStackTrace === "function") {
    Error.captureStackTrace(synthetic, stackBoundary);
  }
  return { message, ...(synthetic.stack ? { stack: synthetic.stack } : {}) };
}

/**
 * The ambient correlation fields, with no `service` — read fresh on every call,
 * because the async contexts change between lines.
 *
 * Split out of `contextFields` so the ROOT logger can carry them too, via pino's
 * `mixin`. Before that split the enrichment lived only in the `createLogger`
 * facade, so anything logging through the raw pino instance — Fastify's own
 * per-request lines, graphile's queue lines — came out with no traceId, no source
 * and no actor, EVEN WHEN a trace context was active around it. That is the
 * highest-volume log in the system and it was the one you could not correlate:
 * a request line and the error it produced shared no id, so "show me everything
 * about this failing call" had no answer. Measured with scripts/probe-log-shape.ts.
 */
export function ambientLogFields(): Record<string, unknown> {
  const trace = getTraceContext();
  const event = currentEventContext();
  return {
    ...(trace?.traceId ? { traceId: trace.traceId } : {}),
    ...(trace?.inherited ? { traceInherited: true } : {}),
    ...(trace?.organizationId ? { organizationId: trace.organizationId } : {}),
    ...(trace?.businessId ? { businessId: trace.businessId } : {}),
    ...(event?.source ? { source: event.source } : {}),
    ...(event?.actor ? { actor: event.actor } : {}),
  };
}

/** Read fresh on every call — the async contexts change between lines. */
function contextFields(service: string): Record<string, unknown> {
  const trace = getTraceContext();
  const event = currentEventContext();
  return {
    service,
    ...(trace?.traceId ? { traceId: trace.traceId } : {}),
    ...(trace?.inherited ? { traceInherited: true } : {}),
    ...(trace?.organizationId ? { organizationId: trace.organizationId } : {}),
    ...(trace?.businessId ? { businessId: trace.businessId } : {}),
    ...(event?.source ? { source: event.source } : {}),
    ...(event?.actor ? { actor: event.actor } : {}),
  };
}

/**
 * A module logger. `debug_info` is a free-form object of
 * whatever context makes the line useful.
 *
 * ```ts
 * const log = createLogger('checkout')
 * log.log('checkout completed', { session: ctx.sessionPublicId, mode: ctx.mode })
 * log.error(err, { session: ctx.sessionPublicId })
 * ```
 */
export interface ServiceLogger {
  log(message: string, debugInfo?: unknown): void;
  info(message: string, debugInfo?: unknown): void;
  warn(message: string, debugInfo?: unknown): void;
  /** Accepts an Error (message + stack extracted), a string, or anything else. */
  error(error: unknown, debugInfo?: unknown): void;
  /**
   * The process is going down, or a component of it has died unrecoverably.
   *
   * Distinct from `error` because it answers a different question. Everything that
   * goes wrong in a billing engine is an `error` — a declined card, a failed renewal,
   * a gateway timeout — and during an incident the query you actually want is "did
   * something CRASH?", which was unanswerable while a process death and a routine 500
   * shared a severity. Maps to pino `fatal` → Cloud Logging `CRITICAL`.
   */
  fatal(error: unknown, debugInfo?: unknown): void;
  /**
   * `error`, for a failure that RECURS ON A SCHEDULE.
   *
   * A per-item failure inside a clock pass repeats every tick until the underlying
   * data is fixed — at `* * * * *` that is 1,440 identical ERROR entries per day per
   * broken item, each with a full stack, all restating one fact. This logs the first
   * occurrence in full, counts identical repeats silently, and says how many it stood
   * for when the window next opens (`repeatsSuppressed`).
   *
   * `key` identifies the RECURRENCE — normally `event:subjectId`. The error's own
   * message is appended automatically, so the same subscription failing a DIFFERENT
   * way reports immediately rather than hiding behind the first failure's window.
   *
   * Only ever use this where the failure is ALSO recorded durably (a `clock_ticks`
   * row, an outbox attempt). Suppression is for the log, never for the record.
   */
  recurringError(key: string, error: unknown, debugInfo?: Record<string, unknown>): void;
  debug(message: string, debugInfo?: unknown): void;
  /** Maps to pino's `trace` level. */
  verbose(message: string, debugInfo?: unknown): void;
}

// ── Repeat suppression ───────────────────────────────────────────────────────
/**
 * How long one recurrence key stays quiet after reporting. An hour turns a
 * permanently-broken item from 1,440 identical ERROR entries a day into 24, each
 * carrying the count it stands for.
 *
 * A constant rather than a config knob for now — deliberately. Promote it to
 * `platform/config` the first time an operator actually wants to widen it during an
 * incident; until then it is one less env var that can be set wrong.
 */
export const LOG_REPEAT_WINDOW_MS = 60 * 60 * 1000;

/** Bound on distinct recurrence keys held in memory. Well above any real fleet. */
const MAX_REPEAT_KEYS = 5_000;

interface RepeatState {
  /** When this key last spoke. The window is measured from here, not from first sight. */
  lastReportAt: number;
  /** Occurrences swallowed since then. */
  suppressed: number;
}

const repeatState = new Map<string, RepeatState>();

/**
 * Decide whether this occurrence speaks. Returns the number of repeats it stands for
 * when it should be logged, or `null` when it should stay quiet.
 *
 * Exported for `verify:logging`, which drives it with an injected clock — a test that
 * had to wait an hour to prove the window reopens would simply never be written.
 */
export function claimRecurrence(
  key: string,
  now: number = Date.now(),
  windowMs: number = LOG_REPEAT_WINDOW_MS,
): { suppressed: number } | null {
  // A non-positive window disables suppression outright, which is what you want while
  // debugging: every occurrence, no bookkeeping, no surprises.
  if (windowMs <= 0) return { suppressed: 0 };

  const existing = repeatState.get(key);
  if (existing) {
    if (now - existing.lastReportAt < windowMs) {
      existing.suppressed++;
      return null;
    }
    const suppressed = existing.suppressed;
    existing.lastReportAt = now;
    existing.suppressed = 0;
    return { suppressed };
  }

  if (repeatState.size >= MAX_REPEAT_KEYS) pruneRepeatState(now, windowMs);
  repeatState.set(key, { lastReportAt: now, suppressed: 0 });
  return { suppressed: 0 };
}

/**
 * Drop keys whose window has lapsed; if that frees nothing, drop the oldest half.
 * A key evicted early costs one duplicate log line — never a lost one — so this
 * stays a cheap sweep rather than an LRU.
 */
function pruneRepeatState(now: number, windowMs: number): void {
  for (const [k, v] of repeatState) {
    if (now - v.lastReportAt >= windowMs && v.suppressed === 0) repeatState.delete(k);
  }
  if (repeatState.size < MAX_REPEAT_KEYS) return;
  const oldest = [...repeatState.entries()]
    .sort((a, b) => a[1].lastReportAt - b[1].lastReportAt)
    .slice(0, Math.ceil(MAX_REPEAT_KEYS / 2));
  for (const [k] of oldest) repeatState.delete(k);
}

/** Test seam: `verify:logging` needs a clean slate between cases. */
export function resetRecurrenceState(): void {
  repeatState.clear();
}

/**
 * `base` defaults to the shared root logger. It exists so a caller can bind a
 * different pino destination — used by `verify:logging` to assert on the REAL
 * field assembly (rather than a mirrored copy of it), and available if a future
 * caller wants a differently-configured sink.
 */
export function createLogger(service: string, base: Logger = logger): ServiceLogger {
  const emit = (
    level: "info" | "warn" | "debug" | "trace",
    message: string,
    debugInfo: unknown,
  ): void => {
    const bounded = boundDebugInfo(debugInfo);
    base[level](
      { ...contextFields(service), ...(bounded !== undefined ? { debug_info: bounded } : {}) },
      message,
    );
  };
  // `boundary` is handed to `describeError` so `Error.captureStackTrace` cuts that
  // frame and everything above it — a string-reported failure gets a stack starting
  // where it was actually reported. Which is why the two emitters below are NAMED
  // rather than inline arrows: each passes itself as its own boundary.
  const failureLine = (
    error: unknown,
    debugInfo: unknown,
    boundary: (...args: never[]) => unknown,
  ): { payload: Record<string, unknown>; message: string } => {
    const { message, stack } = describeError(error, boundary);
    const bounded = boundDebugInfo(debugInfo);
    return {
      payload: {
        ...contextFields(service),
        error_message: message,
        ...(stack ? { stack } : {}),
        ...(bounded !== undefined ? { debug_info: bounded } : {}),
      },
      message,
    };
  };

  const emitError = (error: unknown, debugInfo?: unknown): void => {
    const { payload, message } = failureLine(error, debugInfo, emitError);
    base.error(payload, message);
  };

  const emitFatal = (error: unknown, debugInfo?: unknown): void => {
    const { payload, message } = failureLine(error, debugInfo, emitFatal);
    base.fatal(payload, message);
  };

  const recurringError = (
    key: string,
    error: unknown,
    debugInfo?: Record<string, unknown>,
  ): void => {
    // The error's own message joins the key so a DIFFERENT failure on the same subject
    // is never hidden by the first one's open window.
    const { message } = describeError(error);
    const claim = claimRecurrence(`${service}\u0000${key}\u0000${message}`);
    if (!claim) return;
    emitError(
      error,
      claim.suppressed > 0
        ? {
            ...debugInfo,
            repeatsSuppressed: claim.suppressed,
            repeatWindowMs: LOG_REPEAT_WINDOW_MS,
          }
        : debugInfo,
    );
  };

  return {
    log: (message, debugInfo) => emit("info", message, debugInfo),
    info: (message, debugInfo) => emit("info", message, debugInfo),
    warn: (message, debugInfo) => emit("warn", message, debugInfo),
    debug: (message, debugInfo) => emit("debug", message, debugInfo),
    verbose: (message, debugInfo) => emit("trace", message, debugInfo),
    error: emitError,
    fatal: emitFatal,
    recurringError,
  };
}

/**
 * Route process-level crashes through the logger (and get them out of the queue
 * before the process dies). This is what winston's `handleExceptions` /
 * `handleRejections` do; pino has no equivalent, so it is
 * wired explicitly at each entry point.
 *
 * `onFatal` decides the exit — the API and the worker have different shutdown
 * obligations, and neither should be dictated by the logging module. Default:
 * log an unhandled rejection and keep serving (Node's default would kill the
 * process), but let a genuinely uncaught exception be fatal.
 *
 * Returns a disposer, so tests and short-lived scripts can unregister.
 */
export function captureProcessErrors(
  service: string,
  onFatal: (kind: "uncaughtException" | "unhandledRejection", error: unknown) => void = (kind) => {
    if (kind === "uncaughtException") process.exit(1);
  },
): () => void {
  const log = createLogger(service);

  const handle = (kind: "uncaughtException" | "unhandledRejection") => (error: unknown) => {
    try {
      log.fatal(error, { event: kind });
    } catch {
      // eslint-disable-next-line no-console
      console.error(`[${service}] ${kind}:`, safeStringify(error));
    }
    // Best-effort: give the sink a moment to ship the line we just wrote, then
    // hand control back. `flush` never rejects, so the `finally` always runs.
    void flushCloudLogging().finally(() => onFatal(kind, error));
  };

  const onException = handle("uncaughtException");
  const onRejection = handle("unhandledRejection");
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
}
