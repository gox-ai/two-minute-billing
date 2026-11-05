import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  resolveBusiness,
  badRequest,
  notFound,
  conflict,
  requirePerm,
  VersionConflictError,
} from "./helpers";
import { parseRequest } from "./strict-params";
import { dunningPolicyConfigObject } from "./dunning-config-schema";
import {
  archiveDunningPolicy,
  createDunningPolicy,
  DunningPolicyConflictError,
  DunningPolicyError,
  getDunningPolicy,
  listDunningPolicies,
  serializeDunningPolicy,
  updateDunningPolicy,
} from "@/modules/dunning-policies/service";

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(64),
  description: z.string().max(2000).nullable().optional(),
  config: dunningPolicyConfigObject,
});

const updateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  code: z.string().trim().min(1).max(64).optional(),
  description: z.string().max(2000).nullable().optional(),
  config: dunningPolicyConfigObject.optional(),
  expected_version: z.number().int().nonnegative().optional(),
});

/**
 * Named dunning policies (0386). Same permission as `PATCH business.dunning_config`,
 * which holds the business config a policy stands in for.
 */
export async function registerDunningPolicyRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/dunning_policies",
    {
      preHandler: [authenticate, requirePerm("dunning_policies:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await createDunningPolicy({
          organizationId: req.organization!.id,
          businessId: business.id,
          name: parsed.data.name,
          code: parsed.data.code,
          description: parsed.data.description,
          config: parsed.data.config,
        });
        return reply.code(201).send(serializeDunningPolicy(row, 0));
      } catch (e) {
        if (e instanceof DunningPolicyConflictError) return conflict(reply, e.message);
        if (e instanceof DunningPolicyError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/dunning_policies",
    { preHandler: [authenticate, requirePerm("dunning_policies:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseRequest(
        z.object({ include_archived: z.enum(["true", "false"]).optional() }),
        req.query ?? {},
      );
      if (!q.success) return badRequest(reply, q.error);
      const rows = await listDunningPolicies(req.organization!.id, business.id, {
        includeArchived: q.data.include_archived === "true",
      });
      return {
        object: "list",
        data: rows.map((r) => serializeDunningPolicy(r.policy, r.customerCount)),
        has_more: false,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/dunning_policies/:dpol",
    { preHandler: [authenticate, requirePerm("dunning_policies:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { dpol } = req.params as { dpol: string };
      const found = await getDunningPolicy(req.organization!.id, business.id, dpol);
      if (!found) return notFound(reply, `No such dunning policy: ${dpol}`);
      return serializeDunningPolicy(found.policy, found.customerCount);
    },
  );

  app.patch(
    "/v1/businesses/:biz/dunning_policies/:dpol",
    {
      preHandler: [authenticate, requirePerm("dunning_policies:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { dpol } = req.params as { dpol: string };
      try {
        const row = await updateDunningPolicy({
          organizationId: req.organization!.id,
          businessId: business.id,
          publicId: dpol,
          name: parsed.data.name,
          code: parsed.data.code,
          description: parsed.data.description,
          config: parsed.data.config,
          expectedVersion: parsed.data.expected_version,
        });
        if (!row) return notFound(reply, `No such dunning policy: ${dpol}`);
        const found = await getDunningPolicy(req.organization!.id, business.id, dpol);
        return serializeDunningPolicy(row, found?.customerCount);
      } catch (e) {
        if (e instanceof VersionConflictError) return conflict(reply, e.message);
        if (e instanceof DunningPolicyConflictError) return conflict(reply, e.message);
        if (e instanceof DunningPolicyError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/dunning_policies/:dpol/archive",
    {
      preHandler: [authenticate, requirePerm("dunning_policies:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { dpol } = req.params as { dpol: string };
      try {
        const row = await archiveDunningPolicy({
          organizationId: req.organization!.id,
          businessId: business.id,
          publicId: dpol,
        });
        if (!row) return notFound(reply, `No such dunning policy: ${dpol}`);
        return serializeDunningPolicy(row, 0);
      } catch (e) {
        if (e instanceof DunningPolicyConflictError) return conflict(reply, e.message);
        throw e;
      }
    },
  );
}
