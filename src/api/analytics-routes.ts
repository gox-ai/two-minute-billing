import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { MEASURES } from "@/modules/metrics/daily/measures";
import { MeasureRefused } from "@/modules/metrics/daily/query";
import {
  businessesByPublicIds,
  cacheControlFor,
  lastSyncedAt,
  MAX_SPLIT_LIMIT,
  resolveAnalytics,
  resolveScope,
  serialiseMeasure,
  type AnalyticsRequest,
  type AnalyticsScope,
  type ScopeLivemode,
} from "@/modules/metrics/daily/public-query";
import { CURRENT_REFRESH_SECONDS } from "@/modules/metrics/daily/freshness";
import { badRequest, requirePerm } from "./helpers";
import { LIMITS } from "./limits";

/**
 * The analytics API — one endpoint, not six.
 *
 * `GET /v1/analytics/measures` says what exists, `GET /v1/analytics` answers one question and
 * `POST /v1/analytics/query` answers a board's worth in one round trip. Reads only, so no
 * `Idempotency-Key`.
 *
 * Every payload states its own unit, its `kind`, the timezone its window was resolved in and
 * how complete it is, because a caller cannot read this file to find out.
 */

/**
 * Most refusals are the caller asking for something coherent that does not exist — 422.
 *
 * Where the refusal has a finite set of valid answers, they ride along as DATA (`param`,
 * `options`) beside the sentence. A client should never have to parse prose to offer the
 * choices back to a user, and a sentence is free to be reworded without breaking anyone.
 */
function refused(
  reply: FastifyReply,
  message: string,
  detail?: { param?: string; options?: string[] },
) {
  return reply.code(422).send({
    error: {
      type: "invalid_request_error",
      message,
      ...(detail?.param ? { param: detail.param } : {}),
      ...(detail?.options ? { options: detail.options } : {}),
    },
  });
}

/**
 * At most this many questions per batch: a board, not a crawl.
 *
 * 24 was too few for the screens that exist. A page asking more has to split into chunks,
 * and chunking costs the one property this endpoint is FOR — every slot in a batch carries
 * the same `as_of`, which is what stops two tiles on one screen disagreeing about when they
 * were true. Two chunks are two instants. Business Home needed 28 for one tab and 31 for
 * another, so it chunked, and the screen stated the first chunk's instant for figures that
 * came from the second.
 *
 * Raised rather than made a per-slot refusal, because the 25th question does not fail
 * gracefully today: the whole request 400s, so one tile too many blanks the board.
 */
const MAX_BATCH = 48;

/** Questions in flight at once per batch — bounded so one board cannot drain the pool. */
const BATCH_CONCURRENCY = 4;

/** A business public id: the prefix and the generated length, nothing else. */
const BUSINESS_ID_RE = /^biz_[A-Za-z0-9]{24}$/;

/**
 * Shapes only — the VALUE sets stay in the engine.
 *
 * `grain`, `range`, `split`, `compare` and `measure` are closed sets, and the engine refuses an
 * unknown one with a sentence plus `param`/`options`. Enumerating them here instead would turn
 * a batch's one bad tile into a 400 that blanks the whole board, which is the opposite of what
 * this endpoint promises. So each carries the length a short code can have, and the engine
 * still says which ones exist.
 */
const querySchema = z.object({
  key: z.string().min(1).max(64).optional(),
  measure: z.string().min(1).max(LIMITS.code),
  grain: z.string().max(LIMITS.code).optional(),
  range: z.string().max(LIMITS.code).optional(),
  // A calendar date is exactly YYYY-MM-DD; the engine checks the digits and says so.
  start: z.string().length(10).optional(),
  end: z.string().length(10).optional(),
  split: z.string().max(LIMITS.code).optional(),
  split_limit: z.number().int().positive().max(MAX_SPLIT_LIMIT).optional(),
  currency: z.string().length(3).optional(),
  compare: z.string().max(LIMITS.code).optional(),
  shape: z.string().max(LIMITS.code).optional(),
  segment: z.string().min(1).max(64).optional(),
  business: z.string().regex(BUSINESS_ID_RE, "business must be a business id").optional(),
});

const batchSchema = z.object({
  queries: z.array(querySchema).min(1).max(MAX_BATCH),
  grain: z.string().max(LIMITS.code).optional(),
  range: z.string().max(LIMITS.code).optional(),
  start: z.string().length(10).optional(),
  end: z.string().length(10).optional(),
  currency: z.string().length(3).optional(),
  compare: z.string().max(LIMITS.code).optional(),
  business: z.string().regex(BUSINESS_ID_RE, "business must be a business id").optional(),
  livemode: z.enum(["live", "test"]).optional(),
});

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  /**
   * Discovery. An integrator reads this instead of hard-coding a list, which is what lets us
   * add a measure without breaking anybody.
   */
  app.get(
    "/v1/analytics/measures",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async () => {
      return { object: "list", data: MEASURES.map(serialiseMeasure) };
    },
  );

  /**
   * When the figures were last refreshed by the 5-minute cron — for a "synced N minutes ago"
   * line. `business` narrows it; omitted, the organization's least-recently synced business.
   */
  app.get(
    "/v1/analytics/sync",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (q.business != null && !BUSINESS_ID_RE.test(q.business)) {
        return badRequest(reply, "business must be a business id");
      }
      if (q.livemode != null && q.livemode !== "live" && q.livemode !== "test") {
        return refused(reply, "livemode is either `live` or `test`.", {
          param: "livemode",
          options: ["live", "test"],
        });
      }
      try {
        const scope = await scopeFor(
          req.organization!.id,
          q.business,
          effectiveMode(req.keyLivemode, q.livemode),
        );
        const at = await lastSyncedAt(scope);
        return reply.header("cache-control", "private, no-store").send({
          object: "analytics_sync",
          business: scope.businessPublicId,
          synced_at: at?.toISOString() ?? null,
          refresh_seconds: CURRENT_REFRESH_SECONDS,
        });
      } catch (e) {
        if (e instanceof MeasureRefused)
          return refused(reply, e.message, { param: e.param, options: e.options });
        throw e;
      }
    },
  );

  /** One measure over one window. `business` is a filter — omit it to answer org-wide. */
  app.get(
    "/v1/analytics",
    { preHandler: [authenticate, requirePerm("reports:view")] },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      if (!q.measure) return badRequest(reply, "measure is required");
      if (q.split_limit != null && !/^\d+$/.test(q.split_limit)) {
        return refused(reply, "split_limit must be a whole number.", { param: "split_limit" });
      }
      if (q.livemode != null && q.livemode !== "live" && q.livemode !== "test") {
        return refused(reply, "livemode is either `live` or `test`.", {
          param: "livemode",
          options: ["live", "test"],
        });
      }
      const orgId = req.organization!.id;

      try {
        const scope = await scopeFor(orgId, q.business, effectiveMode(req.keyLivemode, q.livemode));
        const result = await resolveAnalytics(scope, {
          measure: q.measure,
          grain: q.grain,
          range: q.range,
          start: q.start,
          end: q.end,
          split: q.split,
          splitLimit: q.split_limit != null ? Number(q.split_limit) : undefined,
          currency: q.currency,
          compare: q.compare,
          shape: q.shape,
          segment: q.segment,
        });
        return reply.header("cache-control", cacheControlFor(result)).send(result);
      } catch (e) {
        if (e instanceof MeasureRefused)
          return refused(reply, e.message, { param: e.param, options: e.options });
        throw e;
      }
    },
  );

  /**
   * Several measures in ONE round trip — a twelve-widget board is one request.
   *
   * A refused question fails ALONE: it comes back as an error object in its own slot with the
   * same 422 sentence, and the other eleven still answer. One bad tile must not blank a board.
   */
  app.post(
    "/v1/analytics/query",
    { preHandler: [authenticate, requirePerm("reports:query")] },
    async (req, reply) => {
      const parsed = batchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const body = parsed.data;
      const orgId = req.organization!.id;
      const now = new Date();

      // Scopes are resolved once per business named, not once per question: twelve tiles on one
      // business must not cost twelve business look-ups.
      // The promise is cached, not the scope: questions run concurrently, and several
      // arriving for one business must share one look-up.
      const scopes = new Map<string, Promise<AnalyticsScope>>();
      const scopeOnce = (publicId: string | undefined) => {
        const cacheKey = publicId ?? "";
        let hit = scopes.get(cacheKey);
        if (!hit) {
          hit = (async () =>
            scopeFor(orgId, publicId, effectiveMode(req.keyLivemode, body.livemode)))();
          scopes.set(cacheKey, hit);
        }
        return hit;
      };

      const answer = async (qy: (typeof body.queries)[number], i: number) => {
        const key = qy.key ?? `q${i}`;
        const request: AnalyticsRequest = {
          measure: qy.measure,
          grain: qy.grain ?? body.grain,
          range: qy.range ?? body.range,
          start: qy.start ?? body.start,
          end: qy.end ?? body.end,
          split: qy.split,
          splitLimit: qy.split_limit,
          currency: qy.currency ?? body.currency,
          compare: qy.compare ?? body.compare,
          shape: qy.shape,
          segment: qy.segment,
        };
        try {
          const scope = await scopeOnce(qy.business ?? body.business);
          return { key, ...(await resolveAnalytics(scope, request, now)) };
        } catch (e) {
          if (!(e instanceof MeasureRefused)) throw e;
          return {
            key,
            object: "analytics_error" as const,
            measure: qy.measure,
            status: 422,
            error: {
              type: "invalid_request_error",
              message: e.message,
              ...(e.param ? { param: e.param } : {}),
              ...(e.options ? { options: e.options } : {}),
            },
          };
        }
      };

      // A few at a time, in the caller's order. One after another, a 30-tile board paid the
      // sum of its reads; every slot still answers at the same `now`.
      const data: Awaited<ReturnType<typeof answer>>[] = new Array(body.queries.length);
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(BATCH_CONCURRENCY, body.queries.length) }, async () => {
          while (next < body.queries.length) {
            const i = next++;
            data[i] = await answer(body.queries[i]!, i);
          }
        }),
      );

      return reply
        .header("cache-control", "private, no-store")
        .send({ object: "analytics_batch", as_of: now.toISOString(), data });
    },
  );
}

/**
 * Which partition the answer covers.
 *
 * An `all` credential — a platform key, or the dashboard's operator session — reaches both, so
 * it has to SAY which one it wants or it gets a figure that mixes sandbox money into a real
 * total. A key already bound to one partition may only ask for that one; anything else is the
 * caller believing it can see across, and it is told otherwise rather than quietly narrowed.
 */
function effectiveMode(key: ScopeLivemode | undefined, asked: "live" | "test" | undefined) {
  const mode = key ?? "live";
  if (!asked) return mode;
  if (mode !== "all" && asked !== mode) {
    throw new MeasureRefused(`A ${mode} key cannot ask for ${asked} figures.`, {
      param: "livemode",
      options: [mode],
    });
  }
  return asked;
}

/**
 * Resolve the `business` filter, or the whole organization when it is absent.
 *
 * The key's mode partitions BOTH: org-wide counts only the businesses the key can reach, and a
 * business outside the partition is refused in the same words as one that does not exist, so
 * mode never leaks the other partition's ids.
 */
async function scopeFor(
  orgId: string,
  publicId: string | undefined,
  livemode: ScopeLivemode = "live",
): Promise<AnalyticsScope> {
  if (!publicId) return resolveScope(orgId, null, livemode);
  const [business] = await businessesByPublicIds(orgId, [publicId]);
  if (!business || (livemode !== "all" && business.livemode !== livemode)) {
    throw new MeasureRefused(`No such business: ${publicId}`);
  }
  return resolveScope(orgId, business, livemode);
}
