import type { FastifyInstance } from "fastify";
import { authenticate } from "@/platform/auth";
import { businessWallClock } from "@/platform/clock";
import {
  listCoupons,
  listCouponConstraints,
  couponStatus,
  pageCoupons,
  COUPON_PAGE_SPECS,
  COUPON_SORT_FIELDS,
} from "@/modules/coupons/service";
import { serializeCoupon } from "./coupon-routes";
import { resolveBusiness, requirePerm } from "./helpers";
import { catalogListEnvelope, catalogPageQuery, wantsListQuery } from "./catalog-list";

// Read-only endpoints that back the dev/manager/ops portal. RLS-scoped like the rest.
// NOTE: there is deliberately NO payments listing — transactions are the
// user-facing money log; the payments table is internal
// ledger machinery.

export async function registerPortalRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/coupons",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      // CAT-8 filters: kind, status (derived). include_archived surfaces archived rows.
      const q = req.query as { include_archived?: string; kind?: string; status?: string };
      const wantStatus = q.status;
      if (wantsListQuery(req)) {
        const page = catalogPageQuery(req, reply, {
          specs: COUPON_PAGE_SPECS,
          sortFields: COUPON_SORT_FIELDS,
          bareParams: ["include_archived", "kind", "status"],
        });
        if (!page) return;
        const now = await businessWallClock(business.id);
        const result = await pageCoupons(
          req.organization!.id,
          business.id,
          { includeArchived: q.include_archived === "true", kind: q.kind, status: wantStatus, now },
          page,
        );
        const scoped = await listCouponConstraints(
          req.organization!.id,
          result.data.filter((c) => c.applyOn === "each_specified_item").map((c) => c.id),
        );
        return catalogListEnvelope(page, result, (c) => serializeCoupon(c, now, scoped.get(c.id)));
      }
      const rows = await listCoupons(req.organization!.id, business.id, {
        includeArchived: q.include_archived === "true" || wantStatus === "archived",
      });
      let data = rows;
      if (q.kind) data = data.filter((c) => c.kind === q.kind);
      // Simulated business time for status derivation (finale review): a
      // time-travelled business's coupons expire in SIMULATED time.
      const bizNow = await businessWallClock(business.id);
      if (wantStatus) data = data.filter((c) => couponStatus(c, bizNow) === wantStatus);
      // One query for the page's scoping rows, and only for the coupons that use them.
      const byCoupon = await listCouponConstraints(
        req.organization!.id,
        data.filter((c) => c.applyOn === "each_specified_item").map((c) => c.id),
      );
      return {
        object: "list",
        data: data.map((c) => serializeCoupon(c, bizNow, byCoupon.get(c.id))),
      };
    },
  );
}
