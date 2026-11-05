/**
 * The usage ingest limiter: requests per second per ORGANIZATION, shared by every key of the
 * org, so more keys never mean more throughput. A batch is one request. The ingest routes
 * skip the per-key minute counter (`auth.ts`) and use this instead.
 *
 * The counter is upserted in its own statement, before the ingest transaction, so the hot
 * row is locked for one statement only. Fails open, like `consumeRateLimit`. Rows older than
 * two minutes are deleted by `sweepRateLimitCounters`.
 */
import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";

const log = createLogger("ingest-rate");

declare module "fastify" {
  interface FastifyContextConfig {
    /** A usage ingest route: counted per organization per second, not per key per minute. */
    usageIngest?: boolean;
  }
}

const WINDOW_MS = 1_000;

export interface IngestRateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

/**
 * Count one ingest request against the organization's 1-second window. The limit (the org's
 * own override, else the deployment default) is read in the same statement.
 */
export async function consumeIngestRate(input: {
  organizationId: string;
  now?: Date;
}): Promise<IngestRateDecision> {
  const now = input.now ?? new Date();
  const start = Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS;
  const resetAt = new Date(start + WINDOW_MS);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));
  const fallback = config.USAGE_INGEST_RATE_PER_SECOND;
  try {
    const rows = (await systemDb.execute(sql`
      insert into ingest_rate_counters (organization_id, window_start, count)
      values (${input.organizationId}, ${new Date(start).toISOString()}::timestamptz, 1)
      on conflict (organization_id, window_start)
        do update set count = ingest_rate_counters.count + 1
      returning count, (select coalesce(o.ingest_rate_limit_per_second, ${fallback}::int)
                        from organizations o where o.id = ${input.organizationId}) as "limit"`)) as unknown as Array<{
      count: number;
      limit: number | null;
    }>;
    const count = Number(rows[0]?.count ?? 0);
    const limit = Number(rows[0]?.limit ?? fallback);
    return {
      allowed: limit > 0 && count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterSeconds,
    };
  } catch (e) {
    log.error(e, {
      event: "ingest_rate_counter_failed",
      detail: "failing OPEN — this request was allowed unmetered",
    });
    return { allowed: true, limit: fallback, remaining: fallback, resetAt, retryAfterSeconds };
  }
}

/** preHandler for the ingest routes, after `authenticate`. Sets the headers; 429 when over. */
export async function ingestRateLimit(req: FastifyRequest, reply: FastifyReply) {
  if (!req.organization) return;
  const d = await consumeIngestRate({ organizationId: req.organization.id });
  reply.header("X-RateLimit-Limit", String(d.limit));
  reply.header("X-RateLimit-Remaining", String(d.remaining));
  reply.header("X-RateLimit-Reset", String(Math.floor(d.resetAt.getTime() / 1000)));
  if (d.allowed) return;
  reply.header("Retry-After", String(d.retryAfterSeconds));
  log.info("usage ingest rate limit exceeded", {
    event: "ingest_rate_limited",
    limit: d.limit,
    retry_after_s: d.retryAfterSeconds,
  });
  return reply.code(429).send({
    error: {
      type: "rate_limit_error",
      message: `We could not record the events. Your organization sent more than ${d.limit} usage requests in one second. Send again after ${d.retryAfterSeconds} seconds.`,
    },
  });
}
