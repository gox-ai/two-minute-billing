import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { ingestRateLimit } from "@/platform/ingest-rate";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import {
  findStoredEvent,
  ingestUsageEvents,
  serializeUsageEvent,
  usageBatchInput,
  UsageEventBilledError,
  UsageEventNotFoundError,
  voidUsageEvent,
  MAX_BATCH,
  type IngestResult,
} from "@/modules/metering/ingest";
import { parseJsonExact } from "@/modules/metering/json-source";
import { listUsageEvents, type UsageEventFilters } from "@/modules/metering/events-list";
import { badRequest, conflict, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const log = createLogger("usage-event-routes");

/** Batch bodies: 500 events of up to 8 KB of properties each, plus the envelope. */
const BATCH_BODY_LIMIT = 6 * 1024 * 1024;

const voidBody = z.object({
  key: z.string().min(1).max(255),
  timestamp: z
    .string()
    .max(64)
    .refine((v) => !Number.isNaN(Date.parse(v)), "Send an RFC 3339 timestamp")
    .optional(),
  reason: z.string().max(500).optional(),
});

const LIST_KEYS = new Set([
  "customer",
  "customer_key",
  "meter",
  "key",
  "status",
  "timestamp[gte]",
  "timestamp[lt]",
  "received[gte]",
  "received[lt]",
  "limit",
  "starting_after",
]);

/** Unix seconds or an RFC 3339 instant. */
function instant(v: string): Date | null {
  const d = /^\d{1,12}$/.test(v) ? new Date(Number(v) * 1000) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The single-event refusal: 400 for a malformed event, 422 for a refused one. */
function sendEventError(reply: FastifyReply, r: IngestResult) {
  const code = r.error!.code;
  return reply.code(code === "invalid_request" ? 400 : 422).send({
    error: { type: "invalid_request_error", code, message: r.error!.message },
  });
}

export async function registerUsageEventRoutes(app: FastifyInstance) {
  // Ingest: numbers are read from their source text, so no float rounds a value before the
  // 12-decimal check. Exempt from `Idempotency-Key`: every event carries its own key.
  await app.register(async (app) => {
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: BATCH_BODY_LIMIT },
      (_req, body, done) => {
        try {
          done(null, parseJsonExact(body as string));
        } catch (e) {
          const err = e as Error & { statusCode?: number };
          err.statusCode = 400;
          done(err, undefined);
        }
      },
    );

    app.post(
      "/v1/businesses/:biz/usage_events",
      {
        preHandler: [authenticate, requirePerm("usage_events:manage"), ingestRateLimit],
        config: { requestLog: "meta", usageIngest: true },
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body))
          return badRequest(
            reply,
            "We could not record the event. Send one event as a JSON object.",
          );
        const [r] = await ingestUsageEvents({
          organizationId: req.organization!.id,
          businessId: business.id,
          events: [body],
        });
        if (r!.status === "error") return sendEventError(reply, r!);
        const stored = await withTenant(req.organization!.id, (tx) =>
          findStoredEvent(tx, business.id, r!.key!),
        );
        return reply
          .code(r!.status === "created" ? 201 : 200)
          .send({ event: stored ? serializeUsageEvent(stored) : null, status: r!.status });
      },
    );

    app.post(
      "/v1/businesses/:biz/usage_events/batch",
      {
        preHandler: [authenticate, requirePerm("usage_events:manage"), ingestRateLimit],
        config: { requestLog: "meta", usageIngest: true },
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const raw = req.body as { events?: unknown } | null;
        if (raw && Array.isArray(raw.events) && raw.events.length > MAX_BATCH)
          return badRequest(
            reply,
            `We could not record the events. Send at most ${MAX_BATCH} events in one batch.`,
          );
        const parsed = parseRequest(usageBatchInput, raw);
        if (!parsed.success) return badRequest(reply, parsed.error);
        const results = await ingestUsageEvents({
          organizationId: req.organization!.id,
          businessId: business.id,
          events: parsed.data.events,
        });
        const count = (s: IngestResult["status"]) => results.filter((r) => r.status === s).length;
        return reply.code(200).send({
          object: "usage_event_batch",
          results: results.map((r) => ({
            index: r.index,
            key: r.key,
            status: r.status,
            ...(r.error ? { error: r.error } : {}),
          })),
          created: count("created"),
          duplicates: count("duplicate"),
          errors: count("error"),
        });
      },
    );
  });

  app.get(
    "/v1/businesses/:biz/usage_events",
    { preHandler: [authenticate, requirePerm("usage_events:view")] },
    async (req: FastifyRequest, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = (req.query ?? {}) as Record<string, string | string[] | undefined>;
      const unknown = Object.keys(q).filter((k) => !LIST_KEYS.has(k));
      if (unknown.length) return badRequest(reply, `Unknown parameter: ${unknown.join(", ")}`);
      const one = (k: string) => {
        const v = q[k];
        return Array.isArray(v) ? v[0] : v;
      };
      const limit = one("limit") === undefined ? 50 : Number(one("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        return badRequest(reply, "limit must be a whole number from 1 to 1000.");
      const status = one("status");
      if (status !== undefined && !["matched", "unmatched", "voided"].includes(status))
        return badRequest(reply, "status must be matched, unmatched or voided.");
      const filters: UsageEventFilters = {
        customer: one("customer"),
        customerKey: one("customer_key"),
        meter: one("meter"),
        key: one("key"),
        status: status as UsageEventFilters["status"],
      };
      for (const [param, field] of [
        ["timestamp[gte]", "timestampGte"],
        ["timestamp[lt]", "timestampLt"],
        ["received[gte]", "receivedGte"],
        ["received[lt]", "receivedLt"],
      ] as const) {
        const v = one(param);
        if (v === undefined) continue;
        const d = instant(v);
        if (!d) return badRequest(reply, `${param} must be unix seconds or an RFC 3339 time.`);
        filters[field] = d;
      }
      const page = await listUsageEvents({
        organizationId: req.organization!.id,
        businessId: business.id,
        filters,
        limit,
        startingAfter: one("starting_after"),
      });
      return {
        object: "list",
        data: page.data,
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
        ...(page.total !== null ? { total: page.total } : {}),
        ...(page.hasMore ? { next_offset: page.nextCursor } : {}),
      };
    },
  );

  app.post(
    "/v1/businesses/:biz/usage_events/void",
    {
      preHandler: [authenticate, requirePerm("usage_events:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(voidBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const ev = await voidUsageEvent({
          organizationId: req.organization!.id,
          businessId: business.id,
          key: parsed.data.key,
          timestamp: parsed.data.timestamp,
          reason: parsed.data.reason ?? null,
        });
        // To correct a value, send a replacement event with a new key.
        return { event: serializeUsageEvent(ev), status: "voided" };
      } catch (e) {
        if (e instanceof UsageEventNotFoundError) return notFound(reply, e.message);
        if (e instanceof UsageEventBilledError) return conflict(reply, e.message);
        log.error(e, { event: "usage_event_void_failed" });
        throw e;
      }
    },
  );
}
