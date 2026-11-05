import { isIP } from "node:net";
import { systemDb } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { apiRequestLogs } from "@db/schema";
import { redactQuery, storedBody } from "./redact";

const log = createLogger("request-log");

/**
 * The in-process buffer between `onResponse` and the table. Pushing is synchronous and never
 * throws; a timer drains it in multi-row inserts on the system connection (rows span
 * organizations). A crash loses at most the last second or two: the log is a debugging aid, and
 * the authoritative records (idempotency, events, audit, ledger) are transactional.
 */

/** What `capture.ts` hands over: raw references, nothing parsed or redacted yet. */
export interface CapturedRequest {
  id: string;
  startedAt: Date;
  organizationId: string;
  businessId: string | null;
  livemode: string | null;
  source: "api" | "dashboard";
  apiKeyId: string | null;
  memberUserId: string | null;
  method: string;
  path: string;
  route: string | null;
  query: string | null;
  kind: "read" | "write";
  status: number | null;
  durationMs: number | null;
  idempotencyKey: string | null;
  idempotencyOutcome: string | null;
  errorType: string | null;
  traceId: string | null;
  customerId: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Parsed request JSON, a marker object, or null. */
  requestBody: unknown;
  /** Serialized response JSON (string), a marker object, or null. */
  responseBody: unknown;
  /** Rough size, for the buffer ceiling. */
  bytes: number;
}

export const FLUSH_MS = 1_000;
export const FLUSH_ROWS = 250;
/** Past this, new rows keep their metadata and drop bodies; past twice it, rows drop. */
export const BUFFER_MAX_ROWS = 5_000;
export const BUFFER_MAX_BYTES = 32 * 1024 * 1024;

let buffer: CapturedRequest[] = [];
let bufferBytes = 0;
/** One failed batch waits for one more attempt, then is dropped. */
let retry: Array<typeof apiRequestLogs.$inferInsert> | null = null;
let flushing: Promise<{ rows: number }> | null = null;
let timer: NodeJS.Timeout | null = null;
let kicked = false;

const stats = { dropped: 0, droppedBodies: 0, failedInserts: 0 };
let lastDropWarn = 0;

type Writer = (rows: Array<typeof apiRequestLogs.$inferInsert>) => Promise<unknown>;
const dbWriter: Writer = (rows) => systemDb.insert(apiRequestLogs).values(rows);
let writer: Writer = dbWriter;

function warnDropped(reason: string): void {
  const now = Date.now();
  if (now - lastDropWarn < 60_000) return;
  lastDropWarn = now;
  log.warn("request log rows dropped", { event: "request_log_dropped", reason, ...stats });
}

/** Queue one request. Synchronous; never throws, never blocks the reply. */
export function pushRequestLog(entry: CapturedRequest): void {
  try {
    const rows = buffer.length;
    if (rows >= BUFFER_MAX_ROWS * 2 || bufferBytes >= BUFFER_MAX_BYTES * 2) {
      stats.dropped++;
      warnDropped("buffer_full");
      return;
    }
    if (rows >= BUFFER_MAX_ROWS || bufferBytes >= BUFFER_MAX_BYTES) {
      entry.requestBody = entry.requestBody == null ? null : { _omitted: "buffer_full" };
      entry.responseBody = entry.responseBody == null ? null : { _omitted: "buffer_full" };
      entry.bytes = 0;
      stats.droppedBodies++;
      warnDropped("buffer_bodies_dropped");
    }
    buffer.push(entry);
    bufferBytes += entry.bytes;
    if (buffer.length >= FLUSH_ROWS && !kicked) {
      kicked = true;
      setImmediate(() => {
        kicked = false;
        void flushRequestLogs();
      });
    }
  } catch {
    stats.dropped++;
  }
}

function responseJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return { _omitted: "content_type", type: "text", bytes: Buffer.byteLength(raw) };
  }
}

/** Customer ids: generated `cus_…` or a caller-chosen id (`CUSTOMER_ID_RE`). */
const CUS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

/** The customer a write names: `customer` in either body, or a customer object returned. */
function customerFrom(req: unknown, res: unknown): string | null {
  for (const b of [req, res]) {
    if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
    const o = b as Record<string, unknown>;
    if (typeof o.customer === "string" && CUS_RE.test(o.customer)) return o.customer;
    if (typeof o.customer_id === "string" && CUS_RE.test(o.customer_id)) return o.customer_id;
    if (o.object === "customer" && typeof o.id === "string" && CUS_RE.test(o.id)) return o.id;
  }
  return null;
}

function inetOrNull(ip: string | null): string | null {
  if (!ip) return null;
  const bare = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1] ?? ip.split("%")[0]!;
  return isIP(bare) ? bare : null;
}

/** Parse, redact and cap one captured request into its row. */
export function toRow(e: CapturedRequest): typeof apiRequestLogs.$inferInsert {
  const res = responseJson(e.responseBody);
  let errorType = e.errorType;
  if (!errorType && e.status != null && e.status >= 400 && res && typeof res === "object") {
    const t = (res as { error?: { type?: unknown } }).error?.type;
    if (typeof t === "string") errorType = t.slice(0, 100);
  }
  return {
    id: e.id,
    organizationId: e.organizationId,
    businessId: e.businessId,
    livemode: e.livemode === "test" || e.livemode === "live" ? e.livemode : null,
    source: e.source,
    apiKeyId: e.apiKeyId,
    memberUserId: e.memberUserId,
    method: e.method,
    path: e.path.slice(0, 2_048),
    route: e.route,
    query: e.query ? redactQuery(e.query).slice(0, 2_048) : null,
    kind: e.kind,
    status: e.status,
    durationMs: e.durationMs,
    idempotencyKey: e.idempotencyKey,
    idempotencyOutcome: e.idempotencyOutcome,
    errorType,
    traceId: e.traceId,
    customerId: e.customerId ?? customerFrom(e.requestBody, res),
    ip: inetOrNull(e.ip),
    userAgent: e.userAgent?.slice(0, 256) ?? null,
    requestBody: e.requestBody == null ? null : storedBody(e.requestBody),
    responseBody: res == null ? null : storedBody(res),
    createdAt: e.startedAt,
  };
}

async function insert(rows: Array<typeof apiRequestLogs.$inferInsert>): Promise<boolean> {
  try {
    await writer(rows);
    return true;
  } catch (err) {
    stats.failedInserts++;
    log.error(err, { event: "request_log_flush_failed", rows: rows.length });
    return false;
  }
}

async function drain(): Promise<{ rows: number }> {
  let written = 0;
  if (retry) {
    const again = retry;
    retry = null;
    if (await insert(again)) written += again.length;
    else {
      stats.dropped += again.length;
      warnDropped("insert_failed");
    }
  }
  while (buffer.length > 0) {
    const batch = buffer.splice(0, FLUSH_ROWS);
    bufferBytes = Math.max(0, bufferBytes - batch.reduce((n, e) => n + e.bytes, 0));
    const rows: Array<typeof apiRequestLogs.$inferInsert> = [];
    for (const e of batch) {
      try {
        rows.push(toRow(e));
      } catch {
        stats.dropped++;
      }
    }
    if (!rows.length) continue;
    if (await insert(rows)) written += rows.length;
    else {
      if (retry) {
        stats.dropped += rows.length;
        warnDropped("insert_failed");
      } else retry = rows;
      break;
    }
  }
  if (buffer.length === 0) bufferBytes = 0;
  return { rows: written };
}

/** Write everything buffered. Concurrent calls share one drain. */
export function flushRequestLogs(): Promise<{ rows: number }> {
  if (flushing) return flushing;
  flushing = drain().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Start the periodic flush; the disposer flushes the tail (graceful shutdown). */
export function startRequestLogFlush(): () => Promise<void> {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void flushRequestLogs(), FLUSH_MS);
  timer.unref?.();
  return async () => {
    if (timer) clearInterval(timer);
    timer = null;
    await flushRequestLogs();
    // A batch that failed once gets its second attempt now, not never.
    if (retry) await flushRequestLogs();
  };
}

export function requestLogStats(): {
  dropped: number;
  droppedBodies: number;
  failedInserts: number;
  buffered: number;
} {
  return { ...stats, buffered: buffer.length };
}

/** Test seam: replace the insert (null restores it). */
export function setRequestLogWriterForTests(w: Writer | null): void {
  writer = w ?? dbWriter;
}

/** Test seam: empty the buffer and counters. */
export function resetRequestLogBuffer(): void {
  buffer = [];
  bufferBytes = 0;
  retry = null;
  stats.dropped = 0;
  stats.droppedBodies = 0;
  stats.failedInserts = 0;
}
