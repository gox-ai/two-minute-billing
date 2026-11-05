import {
  isCreditsLink,
  normalizeAllowanceReset,
  resetRefusal,
} from "@/modules/credits/reset-windows";
import { creditsLinkRefusal, subscriptionLinkRefusal } from "@/modules/credits/allowance";
import type { AllowanceReset } from "@db/schema";
import type { FastifyInstance } from "fastify";
import { parseRequest } from "./strict-params";
import { z } from "zod";
import { LIMITS } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  createFeature,
  listFeatures,
  getFeatureByKey,
  setPlanEntitlement,
  listPlanEntitlements,
  setSubscriptionEntitlement,
  effectiveEntitlements,
  checkEntitlement,
  getFeature,
  updateFeature,
  setFeatureActive,
} from "@/modules/entitlements/service";
import { getProductByPublicId } from "@/modules/catalog/service";
import { getSubscriptionByPublicId } from "@/modules/subscriptions/service";
import { resolveBusiness, badRequest, notFound, requirePerm } from "./helpers";
import { meters, type features } from "@db/schema";
import { eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";

function serializeFeature(f: typeof features.$inferSelect, meterKeys?: Map<string, string>) {
  return {
    object: "feature",
    id: f.publicId,
    key: f.key,
    name: f.name,
    type: f.type,
    unit: f.unit,
    description: f.description,
    active: f.active,
    // A meter feature linked to a meter counts its usage (0467).
    meter: f.meterId ? (meterKeys?.get(f.meterId) ?? null) : null,
    created_at: f.createdAt,
  };
}

/** Meter id → key for a business (feature `meter`). */
async function meterKeyMap(
  organizationId: string,
  businessId: string,
): Promise<Map<string, string>> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({ id: meters.id, key: meters.key })
      .from(meters)
      .where(eq(meters.businessId, businessId)),
  );
  return new Map(rows.map((r) => [r.id, r.key]));
}

/** The meter for a feature `meter` key: only a meter feature may link one. */
async function featureMeterId(
  organizationId: string,
  businessId: string,
  type: string,
  key: string | null | undefined,
): Promise<{ id: string | null } | { error: string } | undefined> {
  if (key === undefined) return undefined;
  if (key === null) return { id: null };
  if (type !== "meter") return { error: "Only a meter feature can link a meter." };
  const keys = await meterKeyMap(organizationId, businessId);
  const id = [...keys.entries()].find(([, k]) => k === key)?.[0];
  return id ? { id } : { error: `No such meter: ${key}` };
}

const createFeatureBody = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9_]+$/, "key must be lowercase a-z, 0-9, _"),
  name: z.string().min(1).max(200),
  type: z.enum(["switch", "quota", "meter"]),
  unit: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  meter: z.string().min(1).max(100).nullable().optional(),
});

// key and type are fixed after create: every grant's value is typed by them.
const updateFeatureBody = z.object({
  name: z.string().min(1).max(200).optional(),
  unit: z.string().max(50).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  meter: z.string().min(1).max(100).nullable().optional(),
});

const archivedFeature = (key: string) =>
  `feature ${key} is archived. Reactivate it before you grant it`;

// value semantics validated against the feature type at the service boundary;
// here we accept the string ("true"/"false", an integer, or "unlimited").
const valueSchema = z.string().min(1).max(50);

const resetField = z.record(z.string(), z.unknown()).nullable().optional();
const setPlanEntBody = z.object({
  feature: z.string().max(LIMITS.id).min(1),
  value: valueSchema,
  reset: resetField,
});
const setSubEntBody = z.object({
  feature: z.string().max(LIMITS.id).min(1),
  value: valueSchema,
  reset: resetField,
});

/**
 * An allowance's reset (G3b): meter features only; every interval, the hour included, or the
 * credits link (checked by the caller). Returns the reset to store (null = the next invoice's
 * window, undefined = keep), or an error message.
 */
function allowanceReset(
  feature: { type: string },
  raw: unknown,
  term?: { interval: string | null; intervalCount: number | null },
): { reset: AllowanceReset | null | undefined } | { error: string } {
  if (raw === undefined) return { reset: undefined };
  if (raw === null) return { reset: null };
  if (feature.type !== "meter")
    return { error: "We could not save the entitlement. Only a meter feature can have a reset." };
  try {
    const r = normalizeAllowanceReset(raw);
    if (isCreditsLink(r)) return { reset: r };
    const refusal = resetRefusal(r, {
      target: "allowance",
      interval: term?.interval ?? null,
      intervalCount: term?.intervalCount ?? null,
    });
    if (refusal) return { error: `We could not save the entitlement. ${refusal}` };
    return { reset: r && r.every !== "term" ? (r as AllowanceReset) : null };
  } catch (e) {
    return { error: `We could not save the entitlement. reset: ${(e as Error).message}.` };
  }
}

function valueValidForType(type: string, value: string): boolean {
  if (type === "switch") return value === "true" || value === "false";
  return value === "unlimited" || /^\d+$/.test(value);
}

export async function registerEntitlementRoutes(app: FastifyInstance) {
  // Create a feature in the business catalog.
  app.post(
    "/v1/businesses/:biz/features",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createFeatureBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const existing = await getFeatureByKey(req.organization!.id, business.id, parsed.data.key);
      if (existing) {
        return reply.code(409).send({
          error: {
            type: "invalid_request_error",
            message: `feature key already exists: ${parsed.data.key}`,
          },
        });
      }
      const meter = await featureMeterId(
        req.organization!.id,
        business.id,
        parsed.data.type,
        parsed.data.meter,
      );
      if (meter && "error" in meter) return badRequest(reply, meter.error);
      const f = await createFeature({
        organizationId: req.organization!.id,
        businessId: business.id,
        key: parsed.data.key,
        name: parsed.data.name,
        type: parsed.data.type,
        unit: parsed.data.unit,
        description: parsed.data.description,
        meterId: meter?.id ?? null,
      });
      return reply
        .code(201)
        .send(serializeFeature(f, await meterKeyMap(req.organization!.id, business.id)));
    },
  );

  app.get(
    "/v1/businesses/:biz/features",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const rows = await listFeatures(req.organization!.id, business.id);
      const keys = await meterKeyMap(req.organization!.id, business.id);
      return { object: "list", data: rows.map((f) => serializeFeature(f, keys)) };
    },
  );

  // One feature, by id (feat_…) or key.
  app.get(
    "/v1/businesses/:biz/features/:feature",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { feature } = req.params as { feature: string };
      const f = await getFeature(req.organization!.id, business.id, feature);
      if (!f) return notFound(reply, `No such feature: ${feature}`);
      return serializeFeature(f, await meterKeyMap(req.organization!.id, business.id));
    },
  );

  app.patch(
    "/v1/businesses/:biz/features/:feature",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.key !== undefined || body.type !== undefined || body.id !== undefined)
        return badRequest(reply, "id, key and type are immutable and cannot be changed");
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateFeatureBody, body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { feature } = req.params as { feature: string };
      const orgId = req.organization!.id;
      const f = await getFeature(orgId, business.id, feature);
      if (!f) return notFound(reply, `No such feature: ${feature}`);
      const meter = await featureMeterId(orgId, business.id, f.type, parsed.data.meter);
      if (meter && "error" in meter) return badRequest(reply, meter.error);
      const updated = await updateFeature({
        organizationId: orgId,
        businessId: business.id,
        featureId: f.id,
        name: parsed.data.name,
        unit: parsed.data.unit,
        description: parsed.data.description,
        ...(meter ? { meterId: meter.id } : {}),
      });
      return serializeFeature(updated ?? f, await meterKeyMap(orgId, business.id));
    },
  );

  // Archive = the feature grants nothing until reactivated (grants are kept).
  // DELETE archives too, like every catalog DELETE.
  for (const [method, path, active] of [
    ["post", "/v1/businesses/:biz/features/:feature/archive", false],
    ["delete", "/v1/businesses/:biz/features/:feature", false],
    ["post", "/v1/businesses/:biz/features/:feature/reactivate", true],
  ] as const) {
    app[method](
      path,
      {
        preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const { feature } = req.params as { feature: string };
        const orgId = req.organization!.id;
        const f = await getFeature(orgId, business.id, feature);
        if (!f) return notFound(reply, `No such feature: ${feature}`);
        const next = await setFeatureActive(orgId, business.id, f.id, active);
        return serializeFeature(next ?? f, await meterKeyMap(orgId, business.id));
      },
    );
  }

  // Attach a feature to a product (plan) with a granted value (upsert).
  app.post(
    "/v1/businesses/:biz/products/:prod/entitlements",
    {
      preHandler: [authenticate, requirePerm("catalog:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const prodId = (req.params as { prod: string }).prod;
      const product = await getProductByPublicId(req.organization!.id, business.id, prodId);
      if (!product)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such product: ${prodId}` },
        });
      const parsed = parseRequest(setPlanEntBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const feature = await getFeatureByKey(req.organization!.id, business.id, parsed.data.feature);
      if (!feature)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `No such feature: ${parsed.data.feature}`,
          },
        });
      if (!feature.active) return badRequest(reply, archivedFeature(feature.key));
      if (!valueValidForType(feature.type, parsed.data.value)) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `value "${parsed.data.value}" is invalid for a ${feature.type} feature`,
          },
        });
      }
      const r = allowanceReset(feature, parsed.data.reset);
      if ("error" in r) return badRequest(reply, r.error);
      if (isCreditsLink(r.reset)) {
        const refusal = await withTenant(req.organization!.id, (tx) =>
          creditsLinkRefusal(tx, product.id),
        );
        if (refusal) return badRequest(reply, refusal);
      }
      const e = await setPlanEntitlement({
        organizationId: req.organization!.id,
        businessId: business.id,
        productId: product.id,
        featureId: feature.id,
        value: parsed.data.value,
        reset: r.reset,
      });
      return reply.code(201).send({
        object: "plan_entitlement",
        id: e.publicId,
        product: product.publicId,
        feature: feature.key,
        value: e.value,
        reset: e.reset ?? null,
      });
    },
  );

  // A product's plan-level grants, as set by the POST above.
  app.get(
    "/v1/businesses/:biz/products/:prod/entitlements",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const prodId = (req.params as { prod: string }).prod;
      const product = await getProductByPublicId(req.organization!.id, business.id, prodId);
      if (!product)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such product: ${prodId}` },
        });
      const rows = await listPlanEntitlements(req.organization!.id, business.id, product.id);
      return {
        object: "list",
        product: product.publicId,
        data: rows.map(({ entitlement: e, feature: f }) => ({
          object: "plan_entitlement",
          id: e.publicId,
          product: product.publicId,
          feature: f.key,
          feature_name: f.name,
          type: f.type,
          unit: f.unit,
          value: e.value,
          reset: e.reset ?? null,
          created_at: e.createdAt,
        })),
      };
    },
  );

  // Override a feature's value for one subscription (custom deal).
  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/entitlements",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such subscription: ${subId}` },
        });
      const parsed = parseRequest(setSubEntBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const feature = await getFeatureByKey(req.organization!.id, business.id, parsed.data.feature);
      if (!feature)
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: `No such feature: ${parsed.data.feature}`,
          },
        });
      if (!feature.active) return badRequest(reply, archivedFeature(feature.key));
      if (!valueValidForType(feature.type, parsed.data.value)) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: `value "${parsed.data.value}" is invalid for a ${feature.type} feature`,
          },
        });
      }
      const r = allowanceReset(feature, parsed.data.reset, {
        interval: sub.billingPeriodUnit,
        intervalCount: sub.billingPeriod,
      });
      if ("error" in r) return badRequest(reply, r.error);
      if (isCreditsLink(r.reset)) {
        const refusal = await withTenant(req.organization!.id, (tx) =>
          subscriptionLinkRefusal(tx, sub.id),
        );
        if (refusal) return badRequest(reply, refusal);
      }
      const e = await setSubscriptionEntitlement({
        organizationId: req.organization!.id,
        businessId: business.id,
        subscriptionId: sub.id,
        featureId: feature.id,
        value: parsed.data.value,
        reset: r.reset,
      });
      return reply.code(201).send({
        object: "subscription_entitlement",
        id: e.publicId,
        subscription: sub.publicId,
        feature: feature.key,
        value: e.value,
        reset: e.reset ?? null,
      });
    },
  );

  // Effective entitlements for a subscription (plan ∪ overrides).
  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/entitlements",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such subscription: ${subId}` },
        });
      const ents = await effectiveEntitlements(req.organization!.id, sub.id);
      return { object: "list", subscription: sub.publicId, data: ents };
    },
  );

  // Check one entitlement (optionally against a required amount).
  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/entitlements/:key/check",
    { preHandler: [authenticate, requirePerm("subscriptions:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { sub: subId, key } = req.params as { sub: string; key: string };
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such subscription: ${subId}` },
        });
      const requiredRaw = (req.query as { required?: string }).required;
      const required = requiredRaw != null ? Number.parseInt(requiredRaw, 10) : undefined;
      if (requiredRaw != null && (!Number.isFinite(required) || required! < 0)) {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "required must be a non-negative integer",
          },
        });
      }
      const result = await checkEntitlement(req.organization!.id, sub.id, key, required);
      return { object: "entitlement_check", subscription: sub.publicId, ...result };
    },
  );
}
