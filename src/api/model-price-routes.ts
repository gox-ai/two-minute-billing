import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  CostOverrideConflictError,
  CostOverrideRuleError,
  createCostOverride,
  deleteCostOverride,
  endCostOverride,
  getCostOverride,
  getModelPrice,
  listCostOverrides,
  listModelPrices,
  businessIdOf,
  modelPriceHistory,
  modelPriceSourceInfo,
} from "@/modules/model-prices/service";
import { DRIFT_DAYS, listDrift } from "@/modules/metering/list-drift";
import {
  MODEL_PRICE_UNITS,
  TIER_RE,
  normalizeTier,
  type ModelPriceUnit,
} from "@/modules/model-prices/units";
import { badRequest, conflict, notFound, requirePerm } from "./helpers";
import { parseRequest } from "./strict-params";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));
const name = (max: number) => z.string().min(1).max(max);
const unit = z.enum(MODEL_PRICE_UNITS as unknown as [ModelPriceUnit, ...ModelPriceUnit[]]);
// Trimmed and lower-cased before the check, as a tier read from an event is.
const tier = z
  .string()
  .transform(normalizeTier)
  .pipe(z.string().regex(TIER_RE, 'Use at most 40 lower-case letters, digits, "_", "." or "-".'))
  .nullable();
// `price_kind` is `token_type` under its new name; either is accepted.
const kind = { token_type: name(100).optional(), price_kind: name(100).optional() };

/** `token_type` or `price_kind`; an error message when both are set and differ. */
function kindOf(d: { token_type?: string; price_kind?: string }): {
  value?: string;
  error?: string;
} {
  if (d.token_type && d.price_kind && d.token_type !== d.price_kind)
    return { error: "token_type and price_kind must be the same. Set one of them." };
  return { value: d.token_type ?? d.price_kind };
}

const listQuery = z.object({
  provider: name(100).optional(),
  model: name(200).optional(),
  ...kind,
  unit: unit.optional(),
  q: z.string().max(200).optional(),
  has_cost: bool.optional(),
  used: bool.optional(),
  business: name(100).optional(),
  as_of: instant.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  starting_after: z.string().max(100).optional(),
});
const driftQuery = z.object({ business: name(100).optional() });

/** The business id behind `?business=`; a reply when it names none in the organization. */
async function businessScope(
  organizationId: string,
  publicId: string | undefined,
  reply: FastifyReply,
): Promise<{ id: string | undefined } | null> {
  if (!publicId) return { id: undefined };
  const id = await businessIdOf(organizationId, publicId);
  if (!id) {
    notFound(reply, `No such business: ${publicId}`);
    return null;
  }
  return { id };
}

const historyQuery = z.object({
  model: name(200),
  provider: name(100).optional(),
  ...kind,
  unit: unit.optional(),
});
const costListQuery = z.object({
  model: name(200).optional(),
  provider: name(100).optional(),
  ...kind,
  unit: unit.optional(),
  q: z.string().max(200).optional(),
  listed: bool.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  starting_after: z.string().max(100).optional(),
});
const costBody = z
  .object({
    provider: name(100).nullable().optional(),
    model: name(200),
    ...kind,
    unit: unit.optional(),
    quality: tier.optional(),
    resolution: tier.optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/, "currency must be a 3-letter ISO code"),
    unit_amount_decimal: z.string().max(40),
    quantity_divisor: z.union([z.string().max(13), z.number().int().positive()]).transform(String),
    effective_from: instant.optional(),
    effective_to: instant.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((d) => !!(d.token_type ?? d.price_kind), {
    path: ["token_type"],
    message: "Invalid input: expected string, received undefined",
  });
const endBody = z.object({ effective_to: instant.optional() });

const costError = (reply: FastifyReply, e: unknown) => {
  if (e instanceof CostOverrideRuleError) return badRequest(reply, e.message);
  if (e instanceof CostOverrideConflictError) return conflict(reply, e.message);
  throw e;
};

/** The AI model price list and "your cost" (organization level, design G1b § 5.1). */
export async function registerModelPriceRoutes(app: FastifyInstance) {
  app.get(
    "/v1/organization/model_prices",
    { preHandler: [authenticate, requirePerm("model_prices:view")] },
    async (req, reply) => {
      const q = parseRequest(listQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const k = kindOf(q.data);
      if (k.error) return badRequest(reply, k.error);
      const limit = q.data.limit ?? 100;
      const scope = await businessScope(req.organization!.id, q.data.business, reply);
      if (!scope) return reply;
      const page = await listModelPrices(req.organization!.id, {
        businessId: scope.id,
        asOf: q.data.as_of,
        provider: q.data.provider,
        model: q.data.model,
        tokenType: k.value,
        unit: q.data.unit,
        q: q.data.q,
        hasCost: q.data.has_cost,
        used: q.data.used,
        limit,
        startingAfter: q.data.starting_after,
      });
      return {
        object: "list",
        data: page.data,
        has_more: page.hasMore,
        next_cursor: page.hasMore ? page.data.at(-1)!.id : null,
      };
    },
  );

  app.get(
    "/v1/organization/model_prices/history",
    { preHandler: [authenticate, requirePerm("model_prices:view")] },
    async (req, reply) => {
      const q = parseRequest(historyQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const k = kindOf(q.data);
      if (k.error) return badRequest(reply, k.error);
      return modelPriceHistory(req.organization!.id, {
        model: q.data.model,
        provider: q.data.provider,
        tokenType: k.value,
        unit: q.data.unit,
      });
    },
  );

  app.get(
    "/v1/organization/model_prices/source",
    { preHandler: [authenticate, requirePerm("model_prices:view")] },
    async (req) => modelPriceSourceInfo(req.organization!.id),
  );

  app.get(
    "/v1/organization/model_prices/drift",
    { preHandler: [authenticate, requirePerm("model_prices:view")] },
    async (req, reply) => {
      const q = parseRequest(driftQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const scope = await businessScope(req.organization!.id, q.data.business, reply);
      if (!scope) return reply;
      const now = new Date();
      const rows = await listDrift(req.organization!.id, now, scope.id);
      return {
        object: "list",
        window: {
          start: new Date(now.getTime() - DRIFT_DAYS * 86_400_000).toISOString(),
          end: now.toISOString(),
        },
        data: rows.map((r) => ({
          object: "model_price_drift",
          provider: r.provider,
          model: r.model,
          reported_cost_minor: Number(r.reportedCostMinor),
          list_cost_minor: Number(r.listCostMinor),
          difference_percent: r.differencePercent,
        })),
      };
    },
  );

  app.get(
    "/v1/organization/model_prices/:id",
    { preHandler: [authenticate, requirePerm("model_prices:view")] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = await getModelPrice(req.organization!.id, id);
      return row ?? notFound(reply, `No such model price: ${id}`);
    },
  );

  app.get(
    "/v1/organization/model_cost_overrides",
    { preHandler: [authenticate, requirePerm("model_prices:view")] },
    async (req, reply) => {
      const q = parseRequest(costListQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const k = kindOf(q.data);
      if (k.error) return badRequest(reply, k.error);
      const limit = q.data.limit ?? 100;
      const page = await listCostOverrides(req.organization!.id, {
        model: q.data.model,
        provider: q.data.provider,
        tokenType: k.value,
        unit: q.data.unit,
        q: q.data.q,
        listed: q.data.listed,
        limit,
        startingAfter: q.data.starting_after,
      });
      return {
        object: "list",
        data: page.data,
        has_more: page.hasMore,
        next_cursor: page.hasMore ? page.data.at(-1)!.id : null,
      };
    },
  );

  app.post(
    "/v1/organization/model_cost_overrides",
    {
      preHandler: [authenticate, requirePerm("model_prices:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const p = parseRequest(costBody, req.body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      const k = kindOf(p.data);
      if (k.error) return badRequest(reply, k.error);
      if (!k.value) return badRequest(reply, "token_type is required.");
      try {
        const row = await createCostOverride(req.organization!.id, {
          provider: p.data.provider,
          model: p.data.model,
          tokenType: k.value,
          unit: p.data.unit,
          quality: p.data.quality,
          resolution: p.data.resolution,
          currency: p.data.currency,
          unitAmountDecimal: p.data.unit_amount_decimal,
          quantityDivisor: p.data.quantity_divisor,
          effectiveFrom: p.data.effective_from,
          effectiveTo: p.data.effective_to,
          note: p.data.note,
        });
        return reply.code(201).send(row);
      } catch (e) {
        return costError(reply, e);
      }
    },
  );

  app.get(
    "/v1/organization/model_cost_overrides/:id",
    { preHandler: [authenticate, requirePerm("model_prices:view")] },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const row = await getCostOverride(req.organization!.id, id);
      return row ?? notFound(reply, `No such cost: ${id}`);
    },
  );

  app.post(
    "/v1/organization/model_cost_overrides/:id/end",
    {
      preHandler: [authenticate, requirePerm("model_prices:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const p = parseRequest(endBody, req.body ?? {});
      if (!p.success) return badRequest(reply, p.error);
      try {
        const row = await endCostOverride(req.organization!.id, id, p.data.effective_to);
        return row ?? notFound(reply, `No such cost: ${id}`);
      } catch (e) {
        return costError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/organization/model_cost_overrides/:id",
    {
      preHandler: [authenticate, requirePerm("model_prices:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const id = (req.params as { id: string }).id;
      try {
        const row = await deleteCostOverride(req.organization!.id, id);
        return row ?? notFound(reply, `No such cost: ${id}`);
      } catch (e) {
        return costError(reply, e);
      }
    },
  );
}
