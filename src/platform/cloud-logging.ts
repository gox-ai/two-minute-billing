import { Writable } from "node:stream";
import { hostname, networkInterfaces } from "node:os";
import { config } from "./config";
import { getSizeKB, safeStringify, truncateLogPayload } from "./log-truncation";

/**
 * Google Cloud Logging sink for pino.
 *
 * Field names and size discipline follow the common Cloud Logging transport shape,
 * so several services are queryable with one Logs Explorer filter and a traceId
 * that crosses the boundary lines their entries up.
 *
 * Shape of the thing: `createCloudLoggingStream()` returns a Writable that pino's
 * multistream feeds NDJSON. Each line is parsed, converted to a LogEntry, and
 * queued; a batch is flushed on size or on a timer. Nothing here can throw into
 * the caller — a logging sink that takes down a billing request is worse than no
 * sink at all — so every failure path ends at `console.error` and a counter.
 *
 * Deliberately in-process (a Writable) rather than a pino worker-thread
 * transport: the API and worker both need `flushCloudLogging()` on shutdown to be
 * *awaitable*, and the fatal-error paths in `worker.ts` log and then exit —
 * a thread-stream hand-off can lose exactly those last entries, which are the
 * ones you actually wanted.
 */

// ── Wire format ──────────────────────────────────────────────────────────────

/** pino numeric level → Cloud Logging severity (LogSeverity enum names). */
const SEVERITY_BY_LEVEL: Array<{ min: number; severity: string }> = [
  { min: 60, severity: "CRITICAL" },
  { min: 50, severity: "ERROR" },
  { min: 40, severity: "WARNING" },
  { min: 30, severity: "INFO" },
  { min: 20, severity: "DEBUG" },
  { min: 10, severity: "DEBUG" },
];

export function severityFor(level: number): string {
  for (const { min, severity } of SEVERITY_BY_LEVEL) if (level >= min) return severity;
  return "DEFAULT";
}

/**
 * GCP rejects a LogEntry over 256KB, and the cap applies to the *protobuf*
 * encoding — `google.protobuf.Struct` runs 40–50% over the JSON size for typical
 * text-heavy payloads. 170KB × 1.5 keeps us under the cap; truncation aims lower
 * still so a truncated entry never lands near the edge. (Both numbers were tuned
 * against real rejections.)
 */
const MAX_SAFE_JSON_KB = 170;
const TRUNCATION_TARGET_KB = 155;

/** Server IPv4, resolved once — the `ip` field on every line. */
const serverIp = Object.values(networkInterfaces() ?? {})
  .flatMap((list) => list ?? [])
  .find((net) => net.family === "IPv4" && !net.internal)?.address;

/** A parsed pino line, as it arrives from the stream. */
type PinoLine = Record<string, unknown> & { level?: number; time?: number; msg?: string };

export interface CloudLogEntry {
  severity: string;
  timestamp: Date;
  /** `projects/<id>/traces/<traceId>` — what makes Logs Explorer group an execution. */
  trace?: string;
  labels: Record<string, string>;
  payload: Record<string, unknown>;
}

/**
 * Turn one pino line into the entry we send. Exported for `verify:logging`, which
 * asserts on the real conversion rather than a re-implementation of it.
 *
 * Two shaping decisions worth stating:
 *
 *  - **`message` carries the stack** for errors. Cloud Error Reporting groups by
 *    parsing a stack out of the entry's `message`; a stack's first line is already
 *    `<Name>: <message>`, so prepending our own message would just duplicate it.
 *    The clean text stays available in `error_message`.
 *  - **`serviceContext` rides on error entries**, which is what makes them show up
 *    in Error Reporting at all rather than only in Logs Explorer.
 */
export function toCloudLogEntry(line: PinoLine, projectId?: string): CloudLogEntry {
  const { level = 30, time, msg, hostname: _hostname, pid: _pid, ...rest } = line;
  const severity = severityFor(level);
  const traceId = typeof rest.traceId === "string" ? rest.traceId : undefined;
  const stack = typeof rest.stack === "string" ? rest.stack : undefined;

  const payload: Record<string, unknown> = {
    // Errors: the stack IS the message (see above). Everything else: the text.
    message: severity === "ERROR" || severity === "CRITICAL" ? (stack ?? msg ?? "") : (msg ?? ""),
    ...rest,
    ...(config.CLOUD_PROVIDER ? { cloud_provider: config.CLOUD_PROVIDER } : {}),
    ...(serverIp ? { ip: serverIp } : {}),
    host: hostname(),
    env: config.NODE_ENV,
    ...(process.env.pm_id ? { pm2_id: process.env.pm_id } : {}),
    ...(process.env.name ? { pm2_name: process.env.name } : {}),
    ...(severity === "ERROR" || severity === "CRITICAL"
      ? {
          serviceContext: {
            service: config.GOOGLE_CLOUD_SERVICE_CONTEXT,
            version: config.NODE_ENV,
          },
        }
      : {}),
  };

  // Labels are indexed and cheap to filter on in Logs Explorer; keep them to the
  // handful you actually narrow by, and keep every value a string (GCP requires it).
  const labels: Record<string, string> = { env: config.NODE_ENV };
  if (typeof rest.service === "string") labels.service = rest.service;
  if (typeof rest.source === "string") labels.source = rest.source;
  if (traceId) labels.traceId = traceId;
  if (typeof rest.organizationId === "string") labels.organizationId = rest.organizationId;
  if (typeof rest.businessId === "string") labels.businessId = rest.businessId;

  return {
    severity,
    timestamp: typeof time === "number" ? new Date(time) : new Date(),
    ...(traceId && projectId ? { trace: `projects/${projectId}/traces/${traceId}` } : {}),
    labels,
    payload: boundEntryPayload(payload),
  };
}

/**
 * Keep an entry under the sink's cap.
 *
 * The measure-then-send dance matters: an object with a custom `toJSON` (a Date is
 * fine, but a driver row or an Axios error is not) measures small via
 * `JSON.stringify` and then inflates at GCP's protobuf stage, which serializes the
 * raw object. Returning `JSON.parse(serialized)` hands the sink a plain-object
 * snapshot of exactly what we measured, so the two can't disagree.
 */
export function boundEntryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  let serialized: string | null = null;
  let sizeKB: number;
  let snapshot = payload;
  try {
    serialized = JSON.stringify(payload) ?? "";
    sizeKB = Buffer.byteLength(serialized, "utf8") / 1024;
  } catch {
    // Circular refs or a bigint. `safeStringify` handles both; parsing it back
    // gives a clean plain-object clone to measure and to send.
    snapshot = JSON.parse(safeStringify(payload)) as Record<string, unknown>;
    serialized = JSON.stringify(snapshot) ?? "";
    sizeKB = Buffer.byteLength(serialized, "utf8") / 1024;
  }

  if (sizeKB <= MAX_SAFE_JSON_KB) return JSON.parse(serialized) as Record<string, unknown>;

  const truncated = truncateLogPayload(snapshot, TRUNCATION_TARGET_KB, sizeKB);
  const truncatedKB = (truncated._truncatedSizeKB as number | undefined) ?? getSizeKB(truncated);
  if (truncatedKB <= MAX_SAFE_JSON_KB) return truncated;

  // Only reachable if all three truncation passes somehow failed to shrink it.
  // Keep the identity of the line (what it was, whose execution) and drop the body.
  return {
    message: `[oversized log entry reduced] ${String(payload.message ?? "").slice(0, 500)}`,
    service: payload.service,
    traceId: payload.traceId,
    error_message:
      typeof payload.error_message === "string" ? payload.error_message.slice(0, 500) : undefined,
    _originalSizeKB: parseFloat(sizeKB.toFixed(2)),
    _truncatedSizeKB: parseFloat(truncatedKB.toFixed(2)),
    _wasTruncated: true,
    _truncationMode: "dropped-body",
  };
}

// ── The stream ───────────────────────────────────────────────────────────────

/** Flush when the queue reaches this many entries… */
const BATCH_SIZE = 200;
/** …or when this long has passed since the first queued entry. */
const FLUSH_INTERVAL_MS = 2_000;
/**
 * Hard ceiling on unsent entries. If the API is unreachable, the queue must not
 * become the memory leak that takes the process down — logs are the thing we can
 * afford to lose here, and the drop is reported (once per flush) rather than silent.
 */
const MAX_QUEUE = 10_000;

/** pino level names → numbers, for the sink's own threshold. */
const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export interface CloudLoggingSink {
  stream: Writable;
  /** Send everything queued and wait for it. Call before the process exits. */
  flush(): Promise<void>;
  /** Entries dropped because the queue was full — surfaced by `/health` and verify. */
  droppedCount(): number;
}

let sink: CloudLoggingSink | null = null;

/** True when the env asked for the sink AND it could actually be constructed. */
export function cloudLoggingEnabled(): boolean {
  return config.CLOUD_LOGGING === "TRUE" && !!config.GOOGLE_CLOUD_PROJECT_ID;
}

/**
 * Build (once) the Cloud Logging sink, or return null when it is switched off.
 *
 * The `@google-cloud/logging` client is loaded lazily *and* asynchronously: it
 * pulls in gRPC and protobuf definitions, and every test, script and CLI in this
 * repo imports the logger. Entries queued before the client resolves are held and
 * sent on the first flush after it arrives — boot logs are not lost.
 */
export function createCloudLoggingSink(): CloudLoggingSink | null {
  if (sink) return sink;
  if (!cloudLoggingEnabled()) return null;

  const projectId = config.GOOGLE_CLOUD_PROJECT_ID!;
  const minLevel = LEVEL_VALUES[config.CLOUD_LOGGING_LEVEL] ?? 30;

  let queue: CloudLogEntry[] = [];
  let dropped = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  // `Log` is typed loosely here so the import stays dynamic — see above.
  type LogClient = {
    write: (entries: unknown[], options?: unknown) => Promise<unknown>;
    entry: (meta: unknown, data: unknown) => unknown;
  };
  let logPromise: Promise<LogClient> | null = null;

  const getLog = () => {
    if (!logPromise) {
      logPromise = import("@google-cloud/logging")
        .then(({ Logging }) => {
          const logging = new Logging({
            projectId,
            ...(config.GOOGLE_CLOUD_CREDENTIALS_PATH
              ? { keyFilename: config.GOOGLE_CLOUD_CREDENTIALS_PATH }
              : {}),
            // Keepalive pings: an idle gRPC channel behind NAT gets its mapping
            // reaped (~3–5h TTL) while the client still believes it is connected,
            // and the next write hangs until the deadline.
            "grpc.keepalive_time_ms": 60_000,
            "grpc.keepalive_timeout_ms": 10_000,
            "grpc.keepalive_permit_without_calls": 1,
          } as ConstructorParameters<typeof Logging>[0]);
          return logging.log(config.GOOGLE_CLOUD_LOG_NAME) as unknown as LogClient;
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error("[cloud-logging] client init failed — falling back to stdout only:", err);
          throw err;
        });
    }
    return logPromise;
  };

  const send = async (batch: CloudLogEntry[]): Promise<void> => {
    if (batch.length === 0) return;
    try {
      const log = await getLog();
      const entries = batch.map((e) =>
        log.entry(
          {
            severity: e.severity,
            timestamp: e.timestamp,
            resource: { type: "global", labels: { project_id: projectId } },
            labels: e.labels,
            ...(e.trace ? { trace: e.trace } : {}),
          },
          e.payload,
        ),
      );
      // partialSuccess: one malformed entry must not reject the other 199.
      await log.write(entries, { partialSuccess: true });
    } catch (err) {
      // The sink failing is itself only ever a console line: routing it back
      // through the logger would recurse straight into this same queue.
      // eslint-disable-next-line no-console
      console.error(
        `[cloud-logging] write failed (${batch.length} entries dropped):`,
        (err as Error)?.message ?? err,
      );
    }
  };

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (dropped > 0) {
      // eslint-disable-next-line no-console
      console.error(`[cloud-logging] queue full — ${dropped} entries dropped`);
      dropped = 0;
    }
    const batch = queue;
    queue = [];
    // Chain rather than race: entries must reach GCP in the order they happened,
    // and `flush()` on shutdown must await everything still in flight.
    inFlight = inFlight.then(() => send(batch));
    return inFlight;
  };

  const enqueue = (entry: CloudLogEntry): void => {
    if (queue.length >= MAX_QUEUE) {
      dropped++;
      return;
    }
    queue.push(entry);
    if (queue.length >= BATCH_SIZE) {
      void flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
      // The flush timer must never be the reason a CLI or a test run refuses to exit.
      timer.unref?.();
    }
  };

  const stream = new Writable({
    // pino writes one NDJSON line per log call, but a stream may hand us several
    // at once (or a partial one under backpressure), so buffer the remainder.
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, callback) {
      try {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          let parsed: PinoLine;
          try {
            parsed = JSON.parse(line) as PinoLine;
          } catch {
            // Not our JSON (a stray write) — ship it as a plain INFO line rather
            // than discarding it.
            parsed = { level: 30, msg: line.slice(0, 2000) };
          }
          if ((parsed.level ?? 30) < minLevel) continue;
          enqueue(toCloudLogEntry(parsed, projectId));
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          "[cloud-logging] failed to process a log line:",
          (err as Error)?.message ?? err,
        );
      }
      // ALWAYS succeed: an errored stream is removed from pino's multistream, which
      // would silently stop cloud logging for the rest of the process's life.
      callback();
    },
    final(callback) {
      void flush().then(() => callback());
    },
  });

  sink = { stream, flush, droppedCount: () => dropped };
  return sink;
}

/**
 * Flush anything queued. Safe to call when the sink is off (resolves immediately),
 * so shutdown paths don't need to branch on it.
 */
export async function flushCloudLogging(): Promise<void> {
  await sink?.flush();
}
