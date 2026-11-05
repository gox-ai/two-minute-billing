import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import {
  productStats,
  priceStats,
  productGroupStats,
  type UsageStats,
} from "@/modules/catalog/stats";
import { couponStats, listCouponRedemptionsPage } from "@/modules/coupons/service";
import { resolveBusiness, notFound, parseListQuery, listResponse, requirePerm } from "./helpers";

/** Money per currency, minor units — never summed across currencies. */
function money(rows: Array<{ currency: string; amountMinor: bigint }>) {
  return rows.map((r) => ({ currency: r.currency, amount_minor: Number(r.amountMinor) }));
}

function usage(s: UsageStats) {
  return {
    active_subscriptions: s.activeSubscriptions,
    in_trial_subscriptions: s.inTrialSubscriptions,
    mrr: money(s.mrr),
  };
}

/** Read-only usage figures for the catalog detail pages. */
export async function registerCatalogStatsRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/products/:prod/stats",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { prod } = req.params as { prod: string };
      const s = await productStats(req.organization!.id, business.id, prod);
      if (!s) return notFound(reply, `No such product: ${prod}`);
      return { object: "product_stats", product: prod, ...usage(s) };
    },
  );

  app.get(
    "/v1/businesses/:biz/prices/:price/stats",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { price } = req.params as { price: string };
      const s = await priceStats(req.organization!.id, business.id, price);
      if (!s) return notFound(reply, `No such price: ${price}`);
      return { object: "price_stats", price, ...usage(s) };
    },
  );

  app.get(
    "/v1/businesses/:biz/product_groups/:grp/stats",
    { preHandler: [authenticate, requirePerm("catalog:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { grp } = req.params as { grp: string };
      const s = await productGroupStats(req.organization!.id, business.id, grp);
      if (!s) return notFound(reply, `No such product group: ${grp}`);
      return {
        object: "product_group_stats",
        product_group: grp,
        ...usage(s),
        products: s.products.map((p) => ({ product: p.productPublicId, ...usage(p) })),
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/coupons/:cpn/stats",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cpn } = req.params as { cpn: string };
      const s = await couponStats(req.organization!.id, business.id, cpn);
      if (!s) return notFound(reply, `No such coupon: ${cpn}`);
      return {
        object: "coupon_stats",
        coupon: cpn,
        redemptions: s.redemptions,
        discount_given: money(s.discountGiven),
        discount_gross: money(s.discountGiven.map((d) => ({ ...d, amountMinor: d.grossMinor }))),
        discount_reversed: money(
          s.discountGiven.map((d) => ({ ...d, amountMinor: d.reversedMinor })),
        ),
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/coupons/:cpn/redemptions",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseListQuery(req, reply, { filterOps: {}, sortFields: [] });
      if (!q) return;
      if (q.search || q.filters.length > 0)
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "Redemptions support only limit and starting_after",
          },
        });
      const { cpn } = req.params as { cpn: string };
      const page = await listCouponRedemptionsPage(req.organization!.id, business.id, cpn, {
        limit: q.limit,
        startingAfter: q.startingAfter,
      });
      if (!page) return notFound(reply, `No such coupon: ${cpn}`);
      return listResponse(page, (r) => ({
        object: "coupon_redemption",
        id: r.publicId,
        coupon: cpn,
        status: r.status,
        remaining_periods: r.remainingPeriods,
        customer: r.customerPublicId,
        subscription: r.subscriptionPublicId,
        invoice: r.invoicePublicId,
        redeemed_at: r.redeemedAt,
        discount_minor: Number(r.discountMinor),
        currency: r.currency,
      }));
    },
  );
}
