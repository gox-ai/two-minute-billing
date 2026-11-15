/**
 * Overdraft limits of a unit with no rate (0528): the plan and customer layers. The unit's own
 * limit is a field of the credit unit (`overdraft_limit`).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  CreditConflictError,
  CreditNotFoundError,
  CreditRuleError,
} from "@/modules/credits/service";
import {
  customerOverdraftLimits,
  listOverdraftLimits,
  setCustomerOverdraftLimit,
  setPlanOverdraftLimit,
} from "@/modules/credits/overdraft";
import { badRequest, conflict, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const limitBody = z.object({
  overdraft_limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const listQuery = z.object({
  level: z.enum(["plan", "customer"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().max(100).optional(),
});

type Params = { unit?: string; cus?: string; product?: string };
const params = (req: FastifyRequest) => req.params as Params;

function settingsError(reply: FastifyReply, e: unknown) {
  if (e instanceof CreditRuleError) return badRequest(reply, e.message);
  if (e instanceof CreditConflictError) return conflict(reply, e.message);
  if (e instanceof CreditNotFoundError) return notFound(reply, e.message);
  throw e;
}

export async function registerCreditSettingsRoutes(app: FastifyInstance) {
  const read = { preHandler: [authenticate, requirePerm("credits:view")] };

  app.get("/v1/businesses/:biz/credit_units/:unit/overdraft_limits", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(listQuery, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    try {
      const page = await listOverdraftLimits({
        organizationId: req.organization!.id,
        businessId: business.id,
        unitKey: params(req).unit!,
        level: q.data.level,
        limit: q.data.limit ?? 100,
        startingAfter: q.data.starting_after,
      });
      return {
        object: "list",
        data: page.data,
        has_more: page.hasMore,
        next_cursor: page.hasMore ? page.cursor : null,
      };
    } catch (e) {
      return settingsError(reply, e);
    }
  });

  app.put(
    "/v1/businesses/:biz/credit_units/:unit/overdraft_limits/plans/:product",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(limitBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        return await setPlanOverdraftLimit({
          organizationId: req.organization!.id,
          businessId: business.id,
          unitKey: params(req).unit!,
          productPublicId: params(req).product!,
          steps: BigInt(parsed.data.overdraft_limit),
        });
      } catch (e) {
        return settingsError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/credit_units/:unit/overdraft_limits/plans/:product",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const p = params(req);
      try {
        await setPlanOverdraftLimit({
          organizationId: req.organization!.id,
          businessId: business.id,
          unitKey: p.unit!,
          productPublicId: p.product!,
          steps: null,
        });
        return {
          object: "credit_overdraft_limit",
          unit: p.unit,
          level: "plan",
          product: p.product,
          deleted: true,
        };
      } catch (e) {
        return settingsError(reply, e);
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/customers/:cus/credit_overdraft_limits",
    read,
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      try {
        const data = await customerOverdraftLimits({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerPublicId: params(req).cus!,
        });
        return { object: "list", data };
      } catch (e) {
        return settingsError(reply, e);
      }
    },
  );

  app.put(
    "/v1/businesses/:biz/customers/:cus/credit_overdraft_limits/:unit",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(limitBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        return await setCustomerOverdraftLimit({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerPublicId: params(req).cus!,
          unitKey: params(req).unit!,
          steps: BigInt(parsed.data.overdraft_limit),
        });
      } catch (e) {
        return settingsError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/customers/:cus/credit_overdraft_limits/:unit",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      try {
        return await setCustomerOverdraftLimit({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerPublicId: params(req).cus!,
          unitKey: params(req).unit!,
          steps: null,
        });
      } catch (e) {
        return settingsError(reply, e);
      }
    },
  );
}
