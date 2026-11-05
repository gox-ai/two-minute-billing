import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { resolveBusiness, notFound, requirePerm, badRequest, conflict } from "./helpers";
import { parseRequest } from "./strict-params";
import { listDisputesPage, getDispute, serializeDispute } from "@/modules/disputes/service";
import {
  DISPUTE_REASONS,
  DisputeError,
  recordDisputeOutcome,
  recordOperatorDispute,
} from "@/modules/disputes/operator";

const recordBody = z.object({
  amount_minor: z.number().int().positive(),
  reason: z.enum(DISPUTE_REASONS),
  processor_reference: z.string().max(200).optional(),
  // Unix seconds: when the processor opened the case. Default now.
  opened_at: z.number().int().positive().optional(),
});
const outcomeBody = z.object({ outcome: z.enum(["won", "lost"]) });

function mapError(reply: FastifyReply, e: unknown) {
  if (e instanceof DisputeError) {
    if (e.code === "not_found") return notFound(reply, e.message);
    if (e.code === "conflict") return conflict(reply, e.message);
    return badRequest(reply, e.message);
  }
  throw e;
}

/**
 * Disputes / chargebacks. Gateway disputes are created and moved ONLY by the inbound
 * webhook pipeline (`handleDisputeEvent`). The two writes here serve gateways with no
 * dispute feed (`capabilities.disputeFeed: false`): a person records the chargeback and
 * its outcome, and the same transitions book it.
 */
export async function registerDisputeRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/disputes",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as Record<string, string | undefined>;
      if (q.sort != null && q.sort !== "created" && q.sort !== "evidence_due_by") {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "sort must be `created` or `evidence_due_by`",
            param: "sort",
          },
        });
      }
      /**
       * Paginated as of 2026-09-09. This used to return a bare `{object,data}` capped at
       * fifty, so a business past that could not reach the rest and no client could tell.
       * `before` is kept because it is public API surface; `starting_after` is the cursor
       * every other list already speaks.
       */
      const page = await listDisputesPage(req.organization!.id, business.id, {
        status: q.status,
        open: q.open === "true",
        sort: q.sort as "created" | "evidence_due_by" | undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        startingAfter: q.starting_after,
        before: q.before ? new Date(q.before) : undefined,
        payment: q.payment || undefined,
      });
      return {
        object: "list",
        data: page.data.map(serializeDispute),
        has_more: page.hasMore,
        next_cursor: page.nextCursor,
        total: page.total,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/disputes/:id",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getDispute(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, "Dispute not found");
      return serializeDispute(row);
    },
  );

  app.post(
    "/v1/businesses/:biz/payments/:pay/disputes",
    {
      preHandler: [authenticate, requirePerm("payments:refund"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(recordBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { pay } = req.params as { pay: string };
      try {
        const row = await recordOperatorDispute({
          organizationId: req.organization!.id,
          businessId: business.id,
          paymentPublicId: pay,
          amountMinor: BigInt(parsed.data.amount_minor),
          reason: parsed.data.reason,
          processorReference: parsed.data.processor_reference ?? null,
          openedAt: parsed.data.opened_at ? new Date(parsed.data.opened_at * 1000) : undefined,
        });
        return reply.code(201).send(serializeDispute(row));
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/disputes/:id/outcome",
    {
      preHandler: [authenticate, requirePerm("payments:refund"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(outcomeBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { id } = req.params as { id: string };
      try {
        const row = await recordDisputeOutcome({
          organizationId: req.organization!.id,
          businessId: business.id,
          disputePublicId: id,
          outcome: parsed.data.outcome,
        });
        return serializeDispute(row);
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );
}
