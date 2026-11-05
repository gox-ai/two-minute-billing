import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { permissionDef } from "@/modules/auth/permissions";
import { getSubscriptionByPublicId } from "@/modules/subscriptions/service";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  SellingPriceError,
  serializeSellingOverride,
  setItemSellingPrice,
} from "@/modules/subscriptions/selling-price";
import {
  MAX_HISTORY_DAYS,
  customerUsageHistory,
  serializeUsageHistory,
} from "@/modules/metering/usage-history";
import {
  MARGIN_GROUP_BY,
  serializeMarginReport,
  usageMargin,
  type MarginGroupBy,
} from "@/modules/metrics/usage-margin";
import { LIMITS } from "./limits";
import {
  badRequest,
  callerHolds,
  missingPermission,
  notFound,
  requirePerm,
  resolveBusiness,
} from "./helpers";
import { parseRequest } from "./strict-params";

/**
 * Usage views of the model price list (design G1b § 5.1): a customer's own selling price on
 * an item, usage by day, and the usage margin report.
 */

const DAY_MS = 86_400_000;
const decimal = z.string().max(60);
const sellingBody = z.object({
  markup_percent: decimal.nullable().optional(),
  rates: z
    .array(
      z.object({
        match: z.record(z.string(), z.string().max(255)),
        unit_amount_decimal: decimal.optional(),
        markup_percent: decimal.optional(),
      }),
    )
    .max(500)
    .nullable()
    .optional(),
});

const historyQuery = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  meter: z.string().min(1).max(100).optional(),
  group_by: z.string().max(1000).optional(),
  interval: z.enum(["day"]).optional(),
  include: z.enum(["cost"]).optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .optional(),
});

const marginQuery = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  group_by: z.enum(MARGIN_GROUP_BY as [MarginGroupBy, ...MarginGroupBy[]]).optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .optional(),
  customer: z.string().min(1).max(LIMITS.id).optional(),
});

/** [from, to) of at most `maxDays`, or the reason it is refused. */
function rangeOf(
  q: { from: string; to: string },
  maxDays: number,
): { from: Date; to: Date } | string {
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (to.getTime() <= from.getTime()) return "to must be after from.";
  if (to.getTime() - from.getTime() > maxDays * DAY_MS)
    return `The range can be at most ${maxDays} days. Make the range shorter.`;
  return { from, to };
}

export async function registerUsageViewRoutes(app: FastifyInstance) {
  // ── A customer's selling price on a model price list item ─────────────────────
  app.patch(
    "/v1/businesses/:biz/subscriptions/:sub/items/:item",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(sellingBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { sub: subId, item } = req.params as { sub: string; item: string };
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub) return notFound(reply, `We could not find the subscription ${subId}.`);
      try {
        const r = await setItemSellingPrice({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: sub.id,
          itemPublicId: item,
          change: {
            ...(parsed.data.markup_percent !== undefined
              ? { markupPercent: parsed.data.markup_percent }
              : {}),
            ...(parsed.data.rates !== undefined
              ? {
                  rates:
                    parsed.data.rates?.map((x) => ({
                      match: x.match,
                      unitAmountDecimal: x.unit_amount_decimal ?? null,
                      markupPercent: x.markup_percent ?? null,
                    })) ?? null,
                }
              : {}),
          },
        });
        if (!r) return notFound(reply, `We could not find the subscription item ${item}.`);
        return {
          object: "subscription_item",
          id: r.item.publicId,
          subscription: sub.publicId,
          selling_price: serializeSellingOverride(r.override),
        };
      } catch (e) {
        if (e instanceof SellingPriceError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // ── Usage by day for one customer ──────────────────────────────────────────────
  app.get(
    "/v1/businesses/:biz/customers/:cus/usage",
    { preHandler: [authenticate, requirePerm("usage:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseRequest(historyQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const withCost = q.data.include === "cost";
      if (withCost && !callerHolds(req, "usage_margin:view"))
        return missingPermission(reply, permissionDef("usage_margin:view")!, !!req.hasOperator);
      const range = rangeOf(q.data, MAX_HISTORY_DAYS);
      if (typeof range === "string") return badRequest(reply, range);
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) return notFound(reply, `We could not find the customer ${cusId}.`);
      const h = await customerUsageHistory({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        ...range,
        ...(q.data.meter ? { meterKey: q.data.meter } : {}),
        ...(q.data.group_by != null
          ? {
              groupBy: q.data.group_by
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : {}),
        ...(withCost ? { costCurrency: q.data.currency ?? business.defaultCurrency ?? "USD" } : {}),
      });
      if (!h) return notFound(reply, `We could not find the meter ${q.data.meter}.`);
      return { customer: customer.publicId, ...serializeUsageHistory(h, { cost: withCost }) };
    },
  );

  // ── Usage margin report ────────────────────────────────────────────────────────
  app.get(
    "/v1/businesses/:biz/reports/usage_margin",
    { preHandler: [authenticate, requirePerm("usage_margin:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseRequest(marginQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const range = rangeOf(q.data, 366);
      if (typeof range === "string") return badRequest(reply, range);
      let customerId: string | undefined;
      if (q.data.customer) {
        const c = await getCustomerByPublicId(req.organization!.id, business.id, q.data.customer);
        if (!c) return notFound(reply, `We could not find the customer ${q.data.customer}.`);
        customerId = c.id;
      }
      const groupBy = q.data.group_by ?? "customer";
      const r = await usageMargin({
        organizationId: req.organization!.id,
        businessId: business.id,
        ...range,
        groupBy,
        ...(q.data.currency ? { currency: q.data.currency } : {}),
        ...(customerId ? { customerId } : {}),
      });
      return {
        ...serializeMarginReport(r, groupBy),
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      };
    },
  );
}
