/**
 * Usage controls (design G5 §5): spend limits, limit tiers, usage alerts with their
 * per-threshold states, and credit runway. Operator routes here; the buyer's own limits are
 * in `portal-usage-control-routes.ts`.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { withTenant, type Tx } from "@/platform/db";
import { creditUnits, meters, products, subscriptions } from "@db/schema";
import { businessWallClock } from "@/platform/clock";
import { businessTimeZone, newRateCache, type RateCache } from "@/modules/usage-controls/measure";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  archiveTier,
  createSpendLimit,
  createTier,
  deleteSpendLimit,
  getSpendLimit,
  getTier,
  listSpendLimits,
  limitStanding,
  listTiers,
  serializeSpendLimit,
  serializeTier,
  updateSpendLimit,
  updateTier,
  UsageControlConflictError,
  UsageControlNotFoundError,
  UsageControlRuleError,
  type SpendLimit,
} from "@/modules/usage-controls/limits";
import {
  alertStates,
  createAlert,
  deleteAlert,
  getAlert,
  listAlerts,
  serializeAlert,
  updateAlert,
} from "@/modules/usage-controls/alerts";
import { measureRunway } from "@/modules/usage-controls/measure";
import { badRequest, conflict, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const INTERVAL = z.enum(["day", "week", "month", "period"]);
const CURRENCY = z.string().regex(/^[A-Za-z]{3}$/, "Send a 3-letter ISO currency code");
const MINOR = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const spendLimitBody = z.object({
  scope: z.enum(["customer", "subscription", "property"]),
  subscription: z.string().min(1).max(100).optional(),
  property_key: z.string().min(1).max(64).optional(),
  property_value: z.string().min(1).max(255).nullable().optional(),
  meters: z.array(z.string().min(1).max(100)).min(1).max(50).nullable().optional(),
  interval: INTERVAL,
  amount_minor: MINOR,
  currency: CURRENCY,
  mode: z.enum(["hard", "soft"]).optional(),
});
export const spendLimitPatch = z.object({
  amount_minor: MINOR.optional(),
  meters: z.array(z.string().min(1).max(100)).min(1).max(50).nullable().optional(),
});
const tierAmounts = z
  .object({ day: MINOR, week: MINOR, month: MINOR, period: MINOR })
  .partial()
  .refine((a) => Object.keys(a).length > 0, "Set at least one amount.");
const tierBody = z.object({ currency: CURRENCY, level_minor: MINOR, amounts: tierAmounts });
const tierPatch = z.object({ amounts: tierAmounts });
const threshold = z.object({
  value: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  unit: z.enum(["minor", "units", "percent", "days"]),
});
const alertBody = z.object({
  kind: z.enum(["usage_quantity", "spend", "credit_balance", "credit_runway"]),
  customer: z.string().min(1).max(100).optional(),
  product: z.string().min(1).max(100).optional(),
  meter: z.string().min(1).max(100).optional(),
  interval: INTERVAL.optional(),
  currency: CURRENCY.optional(),
  unit: z.string().min(1).max(100).optional(),
  thresholds: z.array(threshold).min(1).max(10),
  email: z.boolean().optional(),
});
const alertPatch = z.object({
  thresholds: z.array(threshold).min(1).max(10).optional(),
  email: z.boolean().optional(),
});

/** Map a usage-control error to its response; rethrow anything else. */
export function sendUsageControlError(reply: FastifyReply, e: unknown) {
  if (e instanceof UsageControlRuleError)
    return reply
      .code(422)
      .send({ error: { type: "invalid_request_error", message: e.message, param: e.param } });
  if (e instanceof UsageControlNotFoundError) return notFound(reply, e.message);
  if (e instanceof UsageControlConflictError) return conflict(reply, e.message);
  throw e;
}

/** Meter keys → ids for one business; a missing key is a 422 naming it. */
export async function meterIdsFor(
  tx: Tx,
  businessId: string,
  keys: string[] | null | undefined,
): Promise<string[] | null> {
  if (!keys) return null;
  const rows = await tx
    .select({ id: meters.id, key: meters.key })
    .from(meters)
    .where(and(eq(meters.businessId, businessId), inArray(meters.key, keys)));
  const missing = keys.filter((k) => !rows.some((r) => r.key === k));
  if (missing.length)
    throw new UsageControlRuleError(`No such meter: ${missing.join(", ")}`, "meters");
  return rows.map((r) => r.id);
}

/** The public form of a limit: subscription public id and meter keys. */
/** The instant, zone and rate cache a list of limits is measured at. */
export async function standingAt(
  tx: Tx,
  businessId: string,
): Promise<{ now: Date; tz: string; cache: RateCache }> {
  return {
    now: await businessWallClock(businessId),
    tz: await businessTimeZone(tx, businessId),
    cache: newRateCache(),
  };
}

export async function spendLimitView(
  tx: Tx,
  l: SpendLimit,
  customerPublicId: string,
  at?: Awaited<ReturnType<typeof standingAt>>,
) {
  const [sub] = l.subscriptionId
    ? await tx
        .select({ p: subscriptions.publicId })
        .from(subscriptions)
        .where(eq(subscriptions.id, l.subscriptionId))
        .limit(1)
    : [];
  const ms = l.meterIds?.length
    ? await tx.select({ key: meters.key }).from(meters).where(inArray(meters.id, l.meterIds))
    : null;
  return serializeSpendLimit(
    l,
    {
      customer: customerPublicId,
      subscription: sub?.p ?? null,
      meters: ms ? ms.map((m) => m.key) : null,
    },
    await limitStanding(tx, l, at ?? (await standingAt(tx, l.businessId))),
  );
}

export async function registerUsageControlRoutes(app: FastifyInstance) {
  const read = { preHandler: [authenticate, requirePerm("usage_controls:view")] };

  // ── Spend limits ──
  app.get("/v1/businesses/:biz/customers/:cus/spend_limits", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const { cus } = req.params as { cus: string };
    const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
    if (!customer) return notFound(reply, `No such customer: ${cus}`);
    const rows = await listSpendLimits(req.organization!.id, business.id, customer.id);
    const data = await withTenant(req.organization!.id, async (tx) => {
      const at = await standingAt(tx, business.id);
      const out = [];
      for (const l of rows) out.push(await spendLimitView(tx, l, customer.publicId, at));
      return out;
    });
    return { object: "list", data };
  });

  app.post(
    "/v1/businesses/:biz/customers/:cus/spend_limits",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus } = req.params as { cus: string };
      const parsed = parseRequest(spendLimitBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const b = parsed.data;
      try {
        const refs = await withTenant(req.organization!.id, async (tx) => {
          const [sub] = b.subscription
            ? await tx
                .select({ id: subscriptions.id })
                .from(subscriptions)
                .where(
                  and(
                    eq(subscriptions.businessId, business.id),
                    eq(subscriptions.customerId, customer.id),
                    eq(subscriptions.publicId, b.subscription),
                  ),
                )
                .limit(1)
            : [];
          if (b.subscription && !sub)
            throw new UsageControlNotFoundError(`No such subscription: ${b.subscription}`);
          return {
            subscriptionId: sub?.id ?? null,
            meterIds: await meterIdsFor(tx, business.id, b.meters),
          };
        });
        const l = await createSpendLimit({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          fields: {
            scope: b.scope,
            subscriptionId: refs.subscriptionId,
            propertyKey: b.property_key ?? null,
            propertyValue: b.property_value ?? null,
            meterIds: refs.meterIds,
            interval: b.interval,
            amountMinor: BigInt(b.amount_minor),
            currency: b.currency,
            mode: b.mode ?? "hard",
            setBy: "operator",
          },
        });
        const view = await withTenant(req.organization!.id, (tx) =>
          spendLimitView(tx, l, customer.publicId),
        );
        return reply.code(201).send(view);
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.get("/v1/businesses/:biz/customers/:cus/spend_limits/:limit", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const { cus, limit } = req.params as { cus: string; limit: string };
    const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
    if (!customer) return notFound(reply, `No such customer: ${cus}`);
    const view = await withTenant(req.organization!.id, async (tx) => {
      const l = await getSpendLimit(tx, business.id, customer.id, limit);
      return l && l.active ? spendLimitView(tx, l, customer.publicId) : null;
    });
    if (!view) return notFound(reply, `No such spend limit: ${limit}`);
    return view;
  });

  app.patch(
    "/v1/businesses/:biz/customers/:cus/spend_limits/:limit",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, limit } = req.params as { cus: string; limit: string };
      const parsed = parseRequest(spendLimitPatch, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      try {
        const meterIds =
          parsed.data.meters === undefined
            ? undefined
            : await withTenant(req.organization!.id, (tx) =>
                meterIdsFor(tx, business.id, parsed.data.meters),
              );
        const l = await updateSpendLimit({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          limit,
          ...(parsed.data.amount_minor != null
            ? { amountMinor: BigInt(parsed.data.amount_minor) }
            : {}),
          ...(meterIds !== undefined ? { meterIds } : {}),
        });
        return withTenant(req.organization!.id, (tx) => spendLimitView(tx, l, customer.publicId));
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/customers/:cus/spend_limits/:limit",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, limit } = req.params as { cus: string; limit: string };
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      try {
        const l = await deleteSpendLimit({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          limit,
        });
        return { object: "spend_limit", id: l.publicId, deleted: true };
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  // ── Limit tiers ──
  app.get("/v1/businesses/:biz/spend_limit_tiers", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = req.query as { include_archived?: string };
    const rows = await listTiers(req.organization!.id, business.id, {
      includeArchived: q.include_archived === "true",
    });
    return { object: "list", data: rows.map(serializeTier) };
  });

  app.post(
    "/v1/businesses/:biz/spend_limit_tiers",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(tierBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const t = await createTier({
          organizationId: req.organization!.id,
          businessId: business.id,
          currency: parsed.data.currency,
          levelMinor: BigInt(parsed.data.level_minor),
          amounts: parsed.data.amounts,
        });
        return reply.code(201).send(serializeTier(t));
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.get("/v1/businesses/:biz/spend_limit_tiers/:tier", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const { tier } = req.params as { tier: string };
    const t = await withTenant(req.organization!.id, (tx) => getTier(tx, business.id, tier));
    if (!t) return notFound(reply, `No such limit tier: ${tier}`);
    return serializeTier(t);
  });

  app.patch(
    "/v1/businesses/:biz/spend_limit_tiers/:tier",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { tier } = req.params as { tier: string };
      const parsed = parseRequest(tierPatch, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const t = await updateTier({
          organizationId: req.organization!.id,
          businessId: business.id,
          tier,
          amounts: parsed.data.amounts,
        });
        return serializeTier(t);
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/spend_limit_tiers/:tier",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { tier } = req.params as { tier: string };
      try {
        const t = await archiveTier({
          organizationId: req.organization!.id,
          businessId: business.id,
          tier,
        });
        return serializeTier(t);
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  // ── Usage alerts ──
  app.get("/v1/businesses/:biz/usage_alerts", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = req.query as { customer?: string; product?: string };
    const org = req.organization!.id;
    const filter: { customerId?: string; productId?: string } = {};
    if (q.customer) {
      const c = await getCustomerByPublicId(org, business.id, q.customer);
      if (!c) return notFound(reply, `No such customer: ${q.customer}`);
      filter.customerId = c.id;
    }
    if (q.product) {
      const [p] = await withTenant(org, (tx) =>
        tx
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.businessId, business.id), eq(products.publicId, q.product!)))
          .limit(1),
      );
      if (!p) return notFound(reply, `No such product: ${q.product}`);
      filter.productId = p.id;
    }
    const rows = await listAlerts(org, business.id, filter);
    const data = await withTenant(org, (tx) => Promise.all(rows.map((a) => serializeAlert(tx, a))));
    return { object: "list", data };
  });

  app.post(
    "/v1/businesses/:biz/usage_alerts",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(alertBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const b = parsed.data;
      if (!!b.customer === !!b.product)
        return badRequest(
          reply,
          "Send customer (one customer) or product (every subscription to it).",
        );
      const org = req.organization!.id;
      try {
        const refs = await withTenant(org, async (tx) => {
          let customerId: string | null = null;
          let productId: string | null = null;
          if (b.customer) {
            const c = await getCustomerByPublicId(org, business.id, b.customer);
            if (!c) throw new UsageControlNotFoundError(`No such customer: ${b.customer}`);
            customerId = c.id;
          }
          if (b.product) {
            const [p] = await tx
              .select({ id: products.id })
              .from(products)
              .where(and(eq(products.businessId, business.id), eq(products.publicId, b.product)))
              .limit(1);
            if (!p) throw new UsageControlNotFoundError(`No such product: ${b.product}`);
            productId = p.id;
          }
          const meterIds = b.meter ? await meterIdsFor(tx, business.id, [b.meter]) : null;
          let unitId: string | null = null;
          if (b.unit) {
            const [u] = await tx
              .select({ id: creditUnits.id })
              .from(creditUnits)
              .where(and(eq(creditUnits.businessId, business.id), eq(creditUnits.key, b.unit)))
              .limit(1);
            if (!u) throw new UsageControlRuleError(`No such credit unit: ${b.unit}`, "unit");
            unitId = u.id;
          }
          return { customerId, productId, meterId: meterIds?.[0] ?? null, unitId };
        });
        const a = await createAlert({
          organizationId: org,
          businessId: business.id,
          fields: {
            kind: b.kind,
            scope: b.customer ? "customer" : "plan",
            customerId: refs.customerId,
            productId: refs.productId,
            meterId: refs.meterId,
            interval: b.interval ?? null,
            currency: b.currency ?? null,
            unitId: refs.unitId,
            thresholds: b.thresholds,
            email: b.email,
          },
        });
        const view = await withTenant(org, (tx) => serializeAlert(tx, a));
        return reply.code(201).send(view);
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.get("/v1/businesses/:biz/usage_alerts/:alert", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const { alert } = req.params as { alert: string };
    const org = req.organization!.id;
    const view = await withTenant(org, async (tx) => {
      const a = await getAlert(tx, business.id, alert);
      if (!a || !a.active) return null;
      const base = await serializeAlert(tx, a);
      // A customer alert carries its state inline.
      return a.customerId ? { ...base, states: await alertStates(tx, a, a.customerId) } : base;
    });
    if (!view) return notFound(reply, `No such usage alert: ${alert}`);
    return view;
  });

  app.patch(
    "/v1/businesses/:biz/usage_alerts/:alert",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { alert } = req.params as { alert: string };
      const parsed = parseRequest(alertPatch, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const a = await updateAlert({
          organizationId: req.organization!.id,
          businessId: business.id,
          alert,
          ...(parsed.data.thresholds ? { thresholds: parsed.data.thresholds } : {}),
          ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
        });
        return withTenant(req.organization!.id, (tx) => serializeAlert(tx, a));
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/usage_alerts/:alert",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { alert } = req.params as { alert: string };
      try {
        const a = await deleteAlert({
          organizationId: req.organization!.id,
          businessId: business.id,
          alert,
        });
        return { object: "usage_alert", id: a.publicId, deleted: true };
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.get("/v1/businesses/:biz/usage_alerts/:alert/states", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const { alert } = req.params as { alert: string };
    const q = req.query as { customer?: string };
    const org = req.organization!.id;
    const out = await withTenant(org, async (tx) => {
      const a = await getAlert(tx, business.id, alert);
      if (!a || !a.active) return { error: `No such usage alert: ${alert}` };
      let customerId = a.customerId;
      if (q.customer) {
        const c = await getCustomerByPublicId(org, business.id, q.customer);
        if (!c) return { error: `No such customer: ${q.customer}` };
        if (a.customerId && a.customerId !== c.id)
          return { error: `The alert ${alert} is for another customer.` };
        customerId = c.id;
      }
      if (!customerId) return { bad: "A plan alert needs customer." };
      return { data: await alertStates(tx, a, customerId) };
    });
    if ("bad" in out) return badRequest(reply, out.bad!);
    if ("error" in out) return notFound(reply, out.error!);
    return { object: "list", alert, data: out.data };
  });

  // ── Credit runway ──
  app.get("/v1/businesses/:biz/customers/:cus/credit_runway", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const { cus } = req.params as { cus: string };
    const q = req.query as { currency?: string };
    if (q.currency !== undefined && !/^[A-Za-z]{3}$/.test(q.currency))
      return badRequest(reply, "Send a 3-letter ISO currency code");
    const org = req.organization!.id;
    const customer = await getCustomerByPublicId(org, business.id, cus);
    if (!customer) return notFound(reply, `No such customer: ${cus}`);
    const currency = (
      q.currency ??
      customer.currency ??
      business.defaultCurrency ??
      "USD"
    ).toUpperCase();
    const r = await withTenant(org, (tx) =>
      measureRunway(tx, { businessId: business.id, customerId: customer.id, currency }),
    );
    return runwayView(customer.publicId, currency, r);
  });
}

export function runwayView(
  customer: string,
  currency: string,
  r: Awaited<ReturnType<typeof measureRunway>>,
) {
  return {
    object: "credit_runway" as const,
    customer,
    currency,
    estimate: true,
    runway_days: r.runwayDays,
    runs_out_at: r.runsOutAt?.toISOString() ?? null,
    balance_minor: Number(r.balanceMinor),
    burn_minor_per_day: r.burnMinorPerDay == null ? null : Number(r.burnMinorPerDay),
    spend_last_7_days_minor: Number(r.spend7dMinor),
    auto_topup_minor: Number(r.autoTopupMinor),
    message:
      r.runwayDays == null
        ? "Not enough usage to estimate"
        : `Runs out in about ${r.runwayDays} ${r.runwayDays === 1 ? "day" : "days"}`,
  };
}
