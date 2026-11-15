import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { badRequest, resolveBusiness, requirePerm } from "./helpers";
import {
  startTimeTravel,
  travelForward,
  stopTimeTravel,
  getTimeTravel,
  wipeTestBusinessData,
  TimeTravelError,
} from "@/modules/time-travel/service";
import { resetTestBusiness, ResetTestBusinessError } from "@/modules/tenancy/reset-test-business";
import { TenancyError } from "@/modules/tenancy/service";
import { timeTravels } from "@db/schema";

function serialize(tm: typeof timeTravels.$inferSelect | null) {
  if (!tm)
    return {
      object: "time_travel",
      status: "not_enabled",
      simulated_now: null,
      genesis_time: null,
    };
  return {
    object: "time_travel",
    status: tm.status,
    genesis_time: tm.genesisTime,
    simulated_now: tm.simulatedNow,
    error: tm.error ?? null,
    updated_at: tm.updatedAt,
  };
}

// Time travel is destructive and moves a whole business's clock: test and all-mode keys only.
// A test key reaches only test businesses, and the service refuses a live business too.
// `await reply` is load-bearing: callers bare-`return` on false, and on these
// idempotent write routes the async idempotencyOnSend hook leaves the 403 in flight,
// which used to make Fastify double-send and crash the process (see
// platform/reply-guard.ts). Awaiting the thenable reply parks until it is flushed.
async function requireTestOrAllKey(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (req.keyLivemode !== "test" && req.keyLivemode !== "all") {
    await reply.code(403).send({
      error: {
        type: "forbidden",
        message: "A live key cannot use the test tools. Use a test key.",
      },
    });
    return false;
  }
  return true;
}

/** H4 (TL-4): Time Travel routes — test businesses only; test or all-mode keys. */
export async function registerTimeTravelRoutes(app: FastifyInstance): Promise<void> {
  const startBody = z.object({ genesis_time: z.string().datetime() });
  const travelBody = z.object({
    to_time: z.string().datetime(),
    step_days: z.number().int().positive().max(366).optional(),
  });
  const stopBody = z.object({ wipe: z.boolean().optional() });

  // start_afresh: enable + pin the clock at genesis_time.
  app.post(
    "/v1/businesses/:biz/time_travel/start",
    {
      preHandler: [authenticate, requirePerm("test_tools:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireTestOrAllKey(req, reply))) return;
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const p = startBody.safeParse(req.body);
      if (!p.success) return badRequest(reply, p.error);
      try {
        const tm = await startTimeTravel({
          orgId: req.organization!.id,
          bizId: biz.id,
          genesisTime: new Date(p.data.genesis_time),
        });
        return reply.code(201).send(serialize(tm));
      } catch (e) {
        if (e instanceof TimeTravelError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // travel_forward: advance the simulated clock, driving the billing pipeline.
  app.post(
    "/v1/businesses/:biz/time_travel/advance",
    {
      preHandler: [authenticate, requirePerm("test_tools:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireTestOrAllKey(req, reply))) return;
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const p = travelBody.safeParse(req.body);
      if (!p.success) return badRequest(reply, p.error);
      try {
        const r = await travelForward({
          orgId: req.organization!.id,
          bizId: biz.id,
          toTime: new Date(p.data.to_time),
          stepDays: p.data.step_days,
        });
        const tm = await getTimeTravel(req.organization!.id, biz.id);
        return reply.code(200).send({ ...serialize(tm), steps: r.steps, from: r.from, to: r.to });
      } catch (e) {
        if (e instanceof TimeTravelError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // status.
  app.get(
    "/v1/businesses/:biz/time_travel",
    { preHandler: [authenticate, requirePerm("test_tools:view")] },
    async (req, reply) => {
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const tm = await getTimeTravel(req.organization!.id, biz.id);
      return serialize(tm);
    },
  );

  // stop (destroy): wipe simulated data + return to real-clock operation.
  app.post(
    "/v1/businesses/:biz/time_travel/stop",
    {
      preHandler: [authenticate, requirePerm("test_tools:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireTestOrAllKey(req, reply))) return;
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      const p = stopBody.safeParse(req.body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      try {
        const r = await stopTimeTravel({
          orgId: req.organization!.id,
          bizId: biz.id,
          wipe: p.data.wipe,
        });
        const tm = await getTimeTravel(req.organization!.id, biz.id);
        return reply.code(200).send({ ...serialize(tm), wiped: r.wiped });
      } catch (e) {
        if (e instanceof TimeTravelError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
  // Delete a test business's customers and transactions (catalog and settings stay).
  app.delete(
    "/v1/businesses/:biz/test_data",
    {
      preHandler: [authenticate, requirePerm("test_tools:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireTestOrAllKey(req, reply))) return;
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      try {
        const r = await wipeTestBusinessData({ orgId: req.organization!.id, bizId: biz.id });
        return reply.code(200).send({ object: "test_data_deletion", deleted: r.wiped });
      } catch (e) {
        if (e instanceof TimeTravelError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );
  // Reset a test business to a new test twin of its live business: same ids, nothing else kept.
  app.post(
    "/v1/businesses/:biz/test_data/reset",
    {
      preHandler: [authenticate, requirePerm("test_tools:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if (!(await requireTestOrAllKey(req, reply))) return;
      const biz = await resolveBusiness(req, reply);
      if (!biz) return;
      try {
        const r = await resetTestBusiness({ orgId: req.organization!.id, bizId: biz.id });
        return reply
          .code(200)
          .send({ object: "test_data_reset", business: biz.publicId, deleted: r.deleted });
      } catch (e) {
        if (e instanceof ResetTestBusinessError || e instanceof TenancyError)
          return badRequest(reply, e.message);
        throw e;
      }
    },
  );
}
