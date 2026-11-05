import type { FastifyRequest } from "fastify";
import { lt } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { apiServerErrors } from "@db/schema";
import { createLogger, redactSensitive } from "@/platform/logger";
import { getTraceContext } from "@/platform/trace";

const log = createLogger("ops.api-errors");

/** Rows older than this are deleted by `sweepApiServerErrors`. */
export const API_ERROR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Rows one process writes per minute. A crash loop under load must not become a write storm. */
export const API_ERROR_MAX_PER_MINUTE = 120;
const STACK_FRAMES = 15;

let windowStart = 0;
let windowCount = 0;
let windowDropped = 0;

const redact = (s: string, cap: number) => String(redactSensitive(s)).slice(0, cap);

/**
 * Record an unhandled API failure (a 5xx from `setErrorHandler`) for the back-office error
 * feed. Fire-and-forget: a failed write is logged and never changes the response.
 */
export function recordApiServerError(req: FastifyRequest, err: Error, status: number): void {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    if (windowDropped)
      log.warn("api server errors over the per-minute cap were not recorded", {
        event: "api_error_record_capped",
        dropped: windowDropped,
      });
    windowStart = now;
    windowCount = 0;
    windowDropped = 0;
  }
  if (windowCount >= API_ERROR_MAX_PER_MINUTE) {
    windowDropped++;
    return;
  }
  windowCount++;

  const trace = getTraceContext();
  const code = (err as { code?: unknown }).code;
  const stack = (err.stack ?? "")
    .split("\n")
    .slice(1, STACK_FRAMES + 1)
    .join("\n");
  systemDb
    .insert(apiServerErrors)
    .values({
      method: req.method,
      route: req.routeOptions?.url ?? "(unrouted)",
      status,
      errorName: err.name || "Error",
      errorCode: typeof code === "string" || typeof code === "number" ? String(code) : null,
      message: redact(err.message || "(no message)", 2_000),
      stack: stack ? redact(stack, 4_000) : null,
      organizationRef: trace?.organizationId ?? null,
      businessRef: trace?.businessId ?? null,
      traceId: trace?.traceId ?? null,
    })
    .catch((e: unknown) =>
      log.error("could not record api server error", {
        event: "api_error_record_failed",
        error: e instanceof Error ? e.message : String(e),
      }),
    );
}

/** Retention. Runs as a clock pass, like the other sweeps. */
export async function sweepApiServerErrors(now: Date): Promise<{ deleted: number }> {
  const deleted = await systemDb
    .delete(apiServerErrors)
    .where(lt(apiServerErrors.createdAt, new Date(now.getTime() - API_ERROR_RETENTION_MS)))
    .returning({ id: apiServerErrors.id });
  return { deleted: deleted.length };
}

/** Test seam — the per-minute cap is module state. */
export function resetApiErrorCap(): void {
  windowStart = 0;
  windowCount = 0;
  windowDropped = 0;
}
