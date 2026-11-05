import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { resolveBusiness, badRequest, notFound, conflict, requirePerm } from "./helpers";
import {
  listReasonCodes,
  resolveOfferedReasons,
  createReasonCode,
  updateReasonCode,
  deleteReasonCode,
  ReasonCodeError,
  ReasonCodeConflictError,
  REASON_CODE_APPLIES_TO,
  type ReasonCodeAppliesTo,
} from "@/modules/reason-codes/service";
import { reasonCodes as reasonCodesTable } from "@db/schema";
import { parseRequest } from "./strict-params";

const APPLIES_TO = REASON_CODE_APPLIES_TO as unknown as [
  ReasonCodeAppliesTo,
  ...ReasonCodeAppliesTo[],
];

const createBody = z.object({
  applies_to: z.enum(APPLIES_TO),
  code: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  position: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

const updateBody = z.object({
  label: z.string().min(1).max(200).optional(),
  position: z.number().int().min(0).optional(),
  enabled: z.boolean().optional(),
});

function serialize(r: typeof reasonCodesTable.$inferSelect) {
  return {
    object: "reason_code",
    id: r.publicId,
    applies_to: r.appliesTo,
    code: r.code,
    label: r.label,
    position: r.position,
    enabled: r.enabled,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    resource_version: r.resourceVersion,
  };
}

/**
 * Reason codes API (Settings → Reason Codes). Business-scoped
 * config listing the reasons an operator may pick when cancelling a subscription
 * or issuing a refund.
 *
 * These definitions drive what a picker OFFERS; they do not validate what is
 * stored. `subscriptions.cancel_reason_code` and `refunds.reason` keep accepting
 * any string, so imported records and API clients using their own vocabulary
 * are unaffected.
 */
export async function registerReasonCodeRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/reason_codes",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await createReasonCode({
          organizationId: req.organization!.id,
          businessId: business.id,
          appliesTo: parsed.data.applies_to,
          code: parsed.data.code,
          label: parsed.data.label,
          position: parsed.data.position,
          enabled: parsed.data.enabled,
        });
        return reply.code(201).send(serialize(row));
      } catch (e) {
        if (e instanceof ReasonCodeConflictError) return conflict(reply, e.message);
        if (e instanceof ReasonCodeError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/reason_codes",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { applies_to?: string; offered?: string };
      const appliesTo = q.applies_to as ReasonCodeAppliesTo | undefined;
      if (appliesTo && !REASON_CODE_APPLIES_TO.includes(appliesTo)) {
        return badRequest(reply, `Unknown applies_to: ${appliesTo}`);
      }

      // `offered=true` returns what a picker should show — enabled only, in order,
      // with the built-in defaults substituted when the business defined none.
      if (q.offered === "true") {
        if (!appliesTo) return badRequest(reply, "applies_to is required when offered=true");
        const { reasons, isFallback } = await resolveOfferedReasons(
          req.organization!.id,
          business.id,
          appliesTo,
        );
        return { object: "list", data: reasons, is_fallback: isFallback };
      }

      const rows = await listReasonCodes(req.organization!.id, business.id, appliesTo);
      return { object: "list", data: rows.map(serialize) };
    },
  );

  app.patch(
    "/v1/businesses/:biz/reason_codes/:rsn",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { rsn } = req.params as { rsn: string };
      try {
        const row = await updateReasonCode(req.organization!.id, business.id, rsn, parsed.data);
        if (!row) return notFound(reply, `No such reason code: ${rsn}`);
        return serialize(row);
      } catch (e) {
        if (e instanceof ReasonCodeError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/reason_codes/:rsn",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { rsn } = req.params as { rsn: string };
      const ok = await deleteReasonCode(req.organization!.id, business.id, rsn);
      if (!ok) return notFound(reply, `No such reason code: ${rsn}`);
      return reply.code(204).send();
    },
  );
}
