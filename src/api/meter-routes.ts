import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { withTenant } from "@/platform/db";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  addUsageKey,
  archiveMeter,
  createMeter,
  getMeter,
  listMeters,
  listUsageKeys,
  meterIsUsed,
  MeterConflictError,
  MeterRuleError,
  removeUsageKey,
  serializeMeter,
  serializeUsageKey,
  updateMeter,
  UsageKeyConflictError,
  type Meter,
  type MeterDefinition,
} from "@/modules/metering/meters";
import { METER_AGGREGATIONS, type MeterAggregation } from "@/modules/metering/usage-sql";
import { badRequest, conflict, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const filterValue = z.union([z.string().max(255), z.number(), z.boolean()]);
const definition = {
  name: z.string().min(1).max(200),
  event_name: z.string().min(1).max(255),
  aggregation: z.enum(METER_AGGREGATIONS as [MeterAggregation, ...MeterAggregation[]]),
  value_property: z.string().min(1).max(255).nullable().optional(),
  unique_property: z.string().min(1).max(255).nullable().optional(),
  recurring: z.boolean().optional(),
  time_unit: z.enum(["hour", "day"]).nullable().optional(),
  filters: z.record(z.string().min(1).max(255), z.array(filterValue).min(1).max(100)).optional(),
  group_by: z.array(z.string().min(1).max(255)).max(5).optional(),
  // 0475: properties a spend limit may name.
  limit_dimensions: z.array(z.string().min(1).max(255)).max(3).optional(),
  // 0457: the model price list key each combination maps to. Null = not mapped.
  price_list: z
    .object({
      provider: z.string().min(1).max(100).optional(),
      provider_key: z.string().min(1).max(255).optional(),
      model_key: z.string().min(1).max(255).optional(),
      token_type: z.string().min(1).max(100).optional(),
      token_type_key: z.string().min(1).max(255).optional(),
    })
    .strict()
    .nullable()
    .optional(),
  // 0457: the currency of event cost for events that name none. Null = the price's currency.
  cost_currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .nullable()
    .optional(),
};
const createBody = z.object({ id: z.string().min(1).max(100).optional(), ...definition });
const patchBody = z.object({
  name: definition.name.optional(),
  event_name: definition.event_name.optional(),
  aggregation: definition.aggregation.optional(),
  value_property: definition.value_property,
  unique_property: definition.unique_property,
  recurring: definition.recurring,
  time_unit: definition.time_unit,
  filters: definition.filters,
  group_by: definition.group_by,
  limit_dimensions: definition.limit_dimensions,
  price_list: definition.price_list,
  cost_currency: definition.cost_currency,
  expected_version: z.number().int().positive().optional(),
});
const keyBody = z.object({ key: z.string().min(1).max(255) });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().max(100).optional(),
  status: z.enum(["active", "archived"]).optional(),
  include_archived: z.enum(["true", "false"]).optional(),
});

type Def = Partial<MeterDefinition>;
function toDefinition(d: z.infer<typeof patchBody>): Def {
  const out: Def = {};
  if (d.name !== undefined) out.name = d.name;
  if (d.event_name !== undefined) out.eventName = d.event_name;
  if (d.aggregation !== undefined) out.aggregation = d.aggregation;
  if (d.value_property !== undefined) out.valueProperty = d.value_property;
  if (d.unique_property !== undefined) out.uniqueProperty = d.unique_property;
  if (d.recurring !== undefined) out.recurring = d.recurring;
  if (d.time_unit !== undefined) out.timeUnit = d.time_unit;
  if (d.filters !== undefined) out.filters = d.filters;
  if (d.group_by !== undefined) out.groupBy = d.group_by;
  if (d.limit_dimensions !== undefined) out.limitDimensions = d.limit_dimensions;
  if (d.price_list !== undefined) out.priceList = d.price_list;
  if (d.cost_currency !== undefined) out.costCurrency = d.cost_currency;
  return out;
}

const meterError = (reply: Parameters<typeof badRequest>[0], e: unknown) => {
  if (e instanceof MeterRuleError) return badRequest(reply, e.message);
  if (e instanceof MeterConflictError) return conflict(reply, e.message);
  throw e;
};

export async function registerMeterRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/meters",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseRequest(listQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const limit = q.data.limit ?? 100;
      const page = await listMeters({
        organizationId: req.organization!.id,
        businessId: business.id,
        limit,
        startingAfter: q.data.starting_after,
        status: q.data.status ?? (q.data.include_archived === "true" ? undefined : "active"),
      });
      const locked = await withTenant(req.organization!.id, async (tx) =>
        Promise.all(page.data.map((m) => meterIsUsed(tx, m))),
      );
      return {
        object: "list",
        data: page.data.map((m, i) => ({ ...serializeMeter(m), locked: locked[i] })),
        has_more: page.hasMore,
        next_cursor: page.hasMore ? page.data.at(-1)!.key : null,
      };
    },
  );

  app.post(
    "/v1/businesses/:biz/meters",
    {
      preHandler: [authenticate, requirePerm("meters:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const m = await createMeter({
          organizationId: req.organization!.id,
          businessId: business.id,
          key: parsed.data.id,
          definition: toDefinition(parsed.data) as MeterDefinition,
        });
        return reply.code(201).send({ ...serializeMeter(m), locked: false });
      } catch (e) {
        return meterError(reply, e);
      }
    },
  );

  const withLock = async (orgId: string, m: Meter) => ({
    ...serializeMeter(m),
    locked: await withTenant(orgId, (tx) => meterIsUsed(tx, m)),
  });

  app.get(
    "/v1/businesses/:biz/meters/:meter",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const key = (req.params as { meter: string }).meter;
      const m = await getMeter(req.organization!.id, business.id, key);
      if (!m) return notFound(reply, `No such meter: ${key}`);
      return withLock(req.organization!.id, m);
    },
  );

  app.patch(
    "/v1/businesses/:biz/meters/:meter",
    {
      preHandler: [authenticate, requirePerm("meters:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const key = (req.params as { meter: string }).meter;
      const parsed = parseRequest(patchBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        if (parsed.data.expected_version !== undefined) {
          const cur = await getMeter(req.organization!.id, business.id, key);
          if (cur && cur.resourceVersion !== parsed.data.expected_version)
            return conflict(
              reply,
              `We could not change the meter. It changed since you loaded it (version ${cur.resourceVersion}). Load it again.`,
            );
        }
        const m = await updateMeter({
          organizationId: req.organization!.id,
          businessId: business.id,
          key,
          patch: toDefinition(parsed.data),
        });
        if (!m) return notFound(reply, `No such meter: ${key}`);
        return withLock(req.organization!.id, m);
      } catch (e) {
        return meterError(reply, e);
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/meters/:meter/archive",
    {
      preHandler: [authenticate, requirePerm("meters:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const key = (req.params as { meter: string }).meter;
      try {
        const m = await archiveMeter({
          organizationId: req.organization!.id,
          businessId: business.id,
          key,
        });
        if (!m) return notFound(reply, `No such meter: ${key}`);
        return serializeMeter(m);
      } catch (e) {
        return meterError(reply, e);
      }
    },
  );

  // ── Customer usage keys ──
  const customerOf = async (orgId: string, bizId: string, cus: string) =>
    getCustomerByPublicId(orgId, bizId, cus);

  app.get(
    "/v1/businesses/:biz/customers/:cus/usage_keys",
    { preHandler: [authenticate, requirePerm("customers:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cus = (req.params as { cus: string }).cus;
      const customer = await customerOf(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const keys = await listUsageKeys(req.organization!.id, business.id, customer.id);
      return { object: "list", data: keys.map((k) => serializeUsageKey(k, customer.publicId)) };
    },
  );

  app.post(
    "/v1/businesses/:biz/customers/:cus/usage_keys",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cus = (req.params as { cus: string }).cus;
      const parsed = parseRequest(keyBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await customerOf(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      try {
        const k = await addUsageKey({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          key: parsed.data.key,
        });
        return reply.code(201).send(serializeUsageKey(k, customer.publicId));
      } catch (e) {
        if (e instanceof UsageKeyConflictError) return conflict(reply, e.message);
        throw e;
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/customers/:cus/usage_keys/remove",
    {
      preHandler: [authenticate, requirePerm("customers:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cus = (req.params as { cus: string }).cus;
      const parsed = parseRequest(keyBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await customerOf(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const removed = await removeUsageKey({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        key: parsed.data.key,
      });
      if (!removed) return notFound(reply, `No such usage key: ${parsed.data.key}`);
      return serializeUsageKey(removed, customer.publicId);
    },
  );
}
