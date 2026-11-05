import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LIMITS, couponCodeField, metadataField } from "./limits";
import { authenticate } from "@/platform/auth";
import { businessWallClock } from "@/platform/clock";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  createCoupon,
  updateCoupon,
  listCouponConstraints,
  setCouponActive,
  applyCouponToSubscription,
  removeDiscount,
  createCouponSet,
  listCouponSets,
  getCouponSet,
  listCouponSetCodes,
  addCouponSetCodes,
  archiveCouponCode,
  deleteUnusedCodes,
  couponStatus,
  getCouponByCode,
  updateCouponSet,
  archiveCouponSet,
  getCouponCode,
  pageCouponSets,
  pageCouponCodes,
  COUPON_SET_PAGE_SPECS,
  COUPON_SET_SORT_FIELDS,
  COUPON_CODE_PAGE_SPECS,
  COUPON_CODE_SORT_FIELDS,
  type CouponCodeRow,
  type CouponSetWithCounts,
  type CouponConstraint,
  CouponError,
} from "@/modules/coupons/service";
import { SlugConflictError } from "@/modules/catalog/service";
import { getSubscriptionByPublicId } from "@/modules/subscriptions/service";
import { resolveBusiness, badRequest, notFound, requirePerm } from "./helpers";
import { catalogListEnvelope, catalogPageQuery, wantsListQuery } from "./catalog-list";
import type { coupons, couponSetCodes } from "@db/schema";
import { parseRequest } from "./strict-params";

/**
 * Kept field-for-field in step with the LIST serializer in `portal-routes.ts` — a client
 * that creates a coupon and one that reads it back must not see different shapes. The
 * discount amount and `item_constraints` were missing here, so a create response could not
 * confirm what it had just stored.
 *
 * `item_constraints` is `null` for an `invoice_amount` coupon (the matcher never consults
 * them) and an array for `each_specified_item`; a kind absent from that array is an
 * implicit `none`, not `all`.
 */
function serializeCoupon(
  c: typeof coupons.$inferSelect,
  now?: Date,
  constraints?: CouponConstraint[],
) {
  return {
    object: "coupon",
    id: c.code,
    code: c.code,
    name: c.name,
    kind: c.kind,
    percent_off_bps: c.percentOffBps,
    amount_off_minor: c.amountOffMinor != null ? Number(c.amountOffMinor) : null,
    currency: c.currency,
    duration_type: c.durationType,
    duration_in_periods: c.durationInPeriods,
    apply_on: c.applyOn,
    active: c.active,
    status: couponStatus(c, now),
    invoice_name: c.invoiceName,
    valid_from: c.validFrom,
    redeem_by: c.redeemBy,
    max_redemptions: c.maxRedemptions,
    max_redemptions_per_customer: c.maxRedemptionsPerCustomer,
    times_redeemed: c.timesRedeemed,
    metadata: c.metadata,
    item_constraints:
      c.applyOn === "each_specified_item"
        ? (constraints ?? []).map((k) => ({
            item_kind: k.itemKind,
            constraint_type: k.constraintType,
            product_ids: k.productIds ?? [],
            price_ids: k.priceIds ?? [],
          }))
        : null,
  };
}

/** `serializeCoupon` + its scoping rows, for the routes that return a single coupon. */
async function serializeCouponWithConstraints(
  organizationId: string,
  c: typeof coupons.$inferSelect,
  now?: Date,
) {
  const byCoupon =
    c.applyOn === "each_specified_item"
      ? await listCouponConstraints(organizationId, [c.id])
      : undefined;
  return serializeCoupon(c, now, byCoupon?.get(c.id));
}

function serializeCouponSet(s: CouponSetWithCounts) {
  return {
    object: "coupon_set",
    id: s.set.publicId,
    name: s.set.name,
    coupon: s.couponPublicId,
    total_count: s.totalCount,
    redeemed_count: s.redeemedCount,
    // `archived` is a third status, so `total - redeemed` over-states what is
    // still redeemable. Both are emitted so no client has to guess.
    archived_count: s.archivedCount,
    unredeemed_count: s.notRedeemedCount,
    created_at: s.set.createdAt,
    archived_at: s.set.archivedAt,
    metadata: s.set.metadata,
  };
}

function serializeSetCode(
  c: typeof couponSetCodes.$inferSelect & { subscriptionPublicId: string | null },
) {
  return {
    object: "coupon_code",
    code: c.code,
    status: c.status,
    redeemed_at: c.redeemedAt,
    subscription: c.subscriptionPublicId,
  };
}

/** `serializeSetCode` plus the set and coupon the code belongs to. */
function serializeCodeRow(r: CouponCodeRow) {
  return {
    ...serializeSetCode({ ...r.code, subscriptionPublicId: r.subscriptionPublicId }),
    coupon_set: r.setPublicId,
    coupon: r.couponPublicId,
  };
}

const createSetBody = z.object({
  coupon: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  count: z.number().int().min(1).max(10000),
  code_prefix: z.string().max(20).optional(),
  // Caller-named slug id; omitted = derived from the name.
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
    .optional(),
  metadata: metadataField().optional(),
});

const updateSetBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  /** Replaced wholesale, not merged. `null` clears it. */
  metadata: metadataField().nullable().optional(),
});

/**
 * CAT-2 per-item-kind scoping, shared by create and update. At most one entry per kind —
 * `coupon_item_constraints_uq` enforces that in the database, and a duplicate here would
 * otherwise surface as a 500.
 */
const itemConstraints = z
  .array(
    z.object({
      item_kind: z.enum(["plan", "addon", "charge"]),
      constraint_type: z.enum(["all", "specific", "none"]),
      product_ids: z.array(z.string().min(1).max(100)).optional(),
      // 'specific' only: prices of this item kind; a line matches its product OR its price.
      price_ids: z.array(z.string().min(1).max(100)).max(500).optional(),
    }),
  )
  .max(3)
  .refine((ks) => new Set(ks.map((k) => k.item_kind)).size === ks.length, {
    message: "one entry per item_kind",
  });

const updateBody = z.object({
  name: z.string().max(200).nullable().optional(),
  active: z.boolean().optional(),
  // CAT-5: editable coupon fields.
  redeem_by: z.string().datetime().nullable().optional(),
  max_redemptions: z.number().int().positive().nullable().optional(),
  max_redemptions_per_customer: z.number().int().positive().nullable().optional(),
  invoice_name: z.string().max(200).nullable().optional(),
  valid_from: z.string().datetime().nullable().optional(),
  /**
   * Replaces the scoping rows WHOLESALE — a kind you omit loses its row and becomes an
   * implicit `none`. 400 on an `invoice_amount` coupon.
   */
  item_constraints: itemConstraints.optional(),
  /**
   * The discount rules, editable ONLY while the coupon has never been redeemed
   * (`times_redeemed === 0`). `updateCoupon` enforces it and answers
   * with a 400 naming the redemption count; the check lives there, not here, because it
   * needs the stored row.
   */
  kind: z.enum(["percentage", "fixed_amount"]).optional(),
  percent_off_bps: z.number().int().min(1).max(10000).nullable().optional(),
  amount_off_minor: z.number().int().positive().nullable().optional(),
  currency: z.string().length(3).nullable().optional(),
  duration_type: z.enum(["once", "forever", "repeating"]).optional(),
  duration_in_periods: z.number().int().positive().nullable().optional(),
  apply_on: z.enum(["invoice_amount", "each_specified_item"]).optional(),
  /** Replaced wholesale, not merged. `null` clears it. */
  metadata: metadataField().nullable().optional(),
});

const createBody = z
  .object({
    code: couponCodeField(),
    name: z.string().max(200).optional(),
    kind: z.enum(["percentage", "fixed_amount"]),
    percent_off_bps: z.number().int().min(1).max(10000).optional(),
    amount_off_minor: z.number().int().positive().optional(),
    currency: z.string().length(3).optional(),
    duration_type: z.enum(["once", "forever", "repeating"]).default("once"),
    duration_in_periods: z.number().int().positive().optional(),
    max_redemptions: z.number().int().positive().optional(),
    max_redemptions_per_customer: z.number().int().positive().optional(),
    redeem_by: z.string().datetime().optional(),
    valid_from: z.string().datetime().optional(),
    invoice_name: z.string().max(200).optional(),
    apply_on: z.enum(["invoice_amount", "each_specified_item"]).optional(),
    item_constraints: itemConstraints.optional(),
    metadata: metadataField().optional(),
  })
  .refine((v) => v.kind !== "percentage" || v.percent_off_bps != null, {
    message: "percent_off_bps required",
    path: ["percent_off_bps"],
  })
  .refine((v) => v.kind !== "fixed_amount" || v.amount_off_minor != null, {
    message: "amount_off_minor required",
    path: ["amount_off_minor"],
  })
  .refine((v) => v.duration_type !== "repeating" || v.duration_in_periods != null, {
    message: "duration_in_periods required",
    path: ["duration_in_periods"],
  });

const applyBody = z.object({ code: z.string().max(LIMITS.code).min(1) });

export async function registerCouponRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/coupons",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const c = await createCoupon({
          organizationId: req.organization!.id,
          businessId: business.id,
          code: parsed.data.code,
          name: parsed.data.name,
          kind: parsed.data.kind,
          percentOffBps: parsed.data.percent_off_bps,
          amountOffMinor: parsed.data.amount_off_minor,
          currency: parsed.data.currency,
          durationType: parsed.data.duration_type,
          durationInPeriods: parsed.data.duration_in_periods,
          maxRedemptions: parsed.data.max_redemptions,
          maxRedemptionsPerCustomer: parsed.data.max_redemptions_per_customer,
          redeemBy: parsed.data.redeem_by ? new Date(parsed.data.redeem_by) : undefined,
          validFrom: parsed.data.valid_from ? new Date(parsed.data.valid_from) : undefined,
          invoiceName: parsed.data.invoice_name,
          applyOn: parsed.data.apply_on,
          metadata: parsed.data.metadata,
          itemConstraints: parsed.data.item_constraints?.map((k) => ({
            itemKind: k.item_kind,
            constraintType: k.constraint_type,
            productIds: k.product_ids,
            priceIds: k.price_ids,
          })),
        });
        return reply
          .code(201)
          .send(
            await serializeCouponWithConstraints(
              req.organization!.id,
              c,
              await businessWallClock(business.id),
            ),
          );
      } catch (e) {
        if (e instanceof SlugConflictError)
          return reply.code(409).send({ error: { type: "conflict_error", message: e.message } });
        if (e instanceof CouponError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    },
  );

  // Edit a coupon's metadata (name) and/or archive/restore (active).
  app.patch(
    "/v1/businesses/:biz/coupons/:cpn",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      // CAT-0 DoD: the slug id is immutable — attempting to change it is a 400, not a silent no-op.
      if ((req.body as Record<string, unknown> | null)?.id !== undefined)
        return badRequest(reply, "id is immutable and cannot be changed");
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { cpn } = req.params as { cpn: string };
      const orgId = req.organization!.id;
      const d = parsed.data;
      let c;
      try {
        c = await updateCoupon({
          organizationId: orgId,
          businessId: business.id,
          couponPublicId: cpn,
          name: d.name,
          redeemBy:
            d.redeem_by === undefined
              ? undefined
              : d.redeem_by === null
                ? null
                : new Date(d.redeem_by),
          maxRedemptions: d.max_redemptions,
          maxRedemptionsPerCustomer: d.max_redemptions_per_customer,
          invoiceName: d.invoice_name,
          validFrom:
            d.valid_from === undefined
              ? undefined
              : d.valid_from === null
                ? null
                : new Date(d.valid_from),
          metadata: d.metadata,
          kind: d.kind,
          percentOffBps: d.percent_off_bps,
          amountOffMinor: d.amount_off_minor,
          currency: d.currency,
          durationType: d.duration_type,
          durationInPeriods: d.duration_in_periods,
          applyOn: d.apply_on,
          itemConstraints: d.item_constraints?.map((k) => ({
            itemKind: k.item_kind,
            constraintType: k.constraint_type,
            productIds: k.product_ids,
            priceIds: k.price_ids,
          })),
        });
      } catch (e) {
        // item_constraints on an invoice_amount coupon — a 400, not a 500, and the same
        // mapping create already does.
        if (e instanceof CouponError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
      if (!c) return notFound(reply, `No such coupon: ${cpn}`);
      if (parsed.data.active !== undefined) {
        c = (await setCouponActive(orgId, business.id, cpn, parsed.data.active)) ?? c;
      }
      return serializeCouponWithConstraints(orgId, c, await businessWallClock(business.id));
    },
  );

  app.get(
    "/v1/businesses/:biz/coupons/:cpn",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cpn } = req.params as { cpn: string };
      const c = await getCouponByCode(req.organization!.id, business.id, cpn);
      if (!c) return notFound(reply, `No such coupon: ${cpn}`);
      return serializeCouponWithConstraints(
        req.organization!.id,
        c,
        await businessWallClock(business.id),
      );
    },
  );

  // Archive a coupon (soft — active=false; can no longer be applied).
  app.delete(
    "/v1/businesses/:biz/coupons/:cpn",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cpn } = req.params as { cpn: string };
      const c = await setCouponActive(req.organization!.id, business.id, cpn, false);
      if (!c) return notFound(reply, `No such coupon: ${cpn}`);
      return serializeCouponWithConstraints(
        req.organization!.id,
        c,
        await businessWallClock(business.id),
      );
    },
  );

  // Remove the active discount from a subscription.
  app.delete(
    "/v1/businesses/:biz/subscriptions/:sub/discount",
    {
      preHandler: [authenticate, requirePerm("subscriptions:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub) return notFound(reply, `No such subscription: ${subId}`);
      // Optional ?coupon=<code>: remove just that coupon from the stack (CAT-1); omit to remove all.
      const coupon = (req.query as { coupon?: string } | undefined)?.coupon;
      const removedCount = await removeDiscount(req.organization!.id, sub.id, coupon);
      return {
        object: "discount",
        subscription: sub.publicId,
        removed: removedCount > 0,
        removed_count: removedCount,
      };
    },
  );

  app.post(
    "/v1/businesses/:biz/subscriptions/:sub/discount",
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
      const parsed = parseRequest(applyBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const applied = await applyCouponToSubscription({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionId: sub.id,
          code: parsed.data.code,
          now: await businessWallClock(business.id),
          // A coupon scoped to other products would sit "active" and discount nothing.
          requireItemMatch: true,
        });
        return reply.code(201).send({
          object: "discount",
          id: applied.publicId,
          subscription: sub.publicId,
          status: applied.status,
          remaining_periods: applied.remainingPeriods,
        });
      } catch (e) {
        if (e instanceof SlugConflictError)
          return reply.code(409).send({ error: { type: "conflict_error", message: e.message } });
        if (e instanceof CouponError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    },
  );

  // ─── Coupon sets (bulk unique single-use codes) ──────────────────────────
  app.post(
    "/v1/businesses/:biz/coupon_sets",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createSetBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const s = await createCouponSet({
          organizationId: req.organization!.id,
          businessId: business.id,
          couponId: parsed.data.coupon,
          name: parsed.data.name,
          count: parsed.data.count,
          codePrefix: parsed.data.code_prefix,
          id: parsed.data.id,
          metadata: parsed.data.metadata,
        });
        return reply.code(201).send(serializeCouponSet(s));
      } catch (e) {
        if (e instanceof SlugConflictError)
          return reply.code(409).send({ error: { type: "conflict_error", message: e.message } });
        if (e instanceof CouponError)
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/coupon_sets",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      // Archived sets are hidden unless asked for.
      const includeArchived =
        (req.query as { include_archived?: string }).include_archived === "true";
      if (wantsListQuery(req)) {
        const page = catalogPageQuery(req, reply, {
          specs: COUPON_SET_PAGE_SPECS,
          sortFields: COUPON_SET_SORT_FIELDS,
          bareParams: ["include_archived"],
        });
        if (!page) return;
        const result = await pageCouponSets(
          req.organization!.id,
          business.id,
          { includeArchived },
          page,
        );
        return catalogListEnvelope(page, result, serializeCouponSet);
      }
      const sets = await listCouponSets(req.organization!.id, business.id, { includeArchived });
      return { object: "list", data: sets.map(serializeCouponSet) };
    },
  );

  app.get(
    "/v1/businesses/:biz/coupon_sets/:set",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { set } = req.params as { set: string };
      const s = await getCouponSet(req.organization!.id, business.id, set);
      if (!s) return notFound(reply, `No such coupon set: ${set}`);
      return serializeCouponSet(s);
    },
  );

  app.patch(
    "/v1/businesses/:biz/coupon_sets/:set",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      if ((req.body as Record<string, unknown> | null)?.id !== undefined)
        return badRequest(reply, "id is immutable and cannot be changed");
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(updateSetBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { set } = req.params as { set: string };
      const s = await updateCouponSet({
        organizationId: req.organization!.id,
        businessId: business.id,
        setPublicId: set,
        name: parsed.data.name,
        metadata: parsed.data.metadata,
      });
      if (!s) return notFound(reply, `No such coupon set: ${set}`);
      return serializeCouponSet(s);
    },
  );

  // Archive a set (soft): its unredeemed codes are archived and no codes can be added.
  app.delete(
    "/v1/businesses/:biz/coupon_sets/:set",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { set } = req.params as { set: string };
      const s = await archiveCouponSet({
        organizationId: req.organization!.id,
        businessId: business.id,
        setPublicId: set,
        now: await businessWallClock(business.id),
      });
      if (!s) return notFound(reply, `No such coupon set: ${set}`);
      return serializeCouponSet(s);
    },
  );

  // Codes across every set. Whole filtered list unless `limit`/`starting_after` asks for a page.
  app.get(
    "/v1/businesses/:biz/coupon_codes",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as { status?: string; coupon_set?: string };
      const page = catalogPageQuery(req, reply, {
        specs: COUPON_CODE_PAGE_SPECS,
        sortFields: COUPON_CODE_SORT_FIELDS,
        bareParams: ["status", "coupon_set"],
      });
      if (!page) return;
      const result = await pageCouponCodes(
        req.organization!.id,
        business.id,
        { setPublicId: q.coupon_set, status: q.status },
        page,
      );
      if (!result) return notFound(reply, `No such coupon set: ${q.coupon_set}`);
      return catalogListEnvelope(page, result, serializeCodeRow);
    },
  );

  app.get(
    "/v1/businesses/:biz/coupon_codes/:code",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { code } = req.params as { code: string };
      const r = await getCouponCode(req.organization!.id, business.id, code);
      if (!r) return notFound(reply, `No such coupon code: ${code}`);
      return serializeCodeRow(r);
    },
  );

  app.get(
    "/v1/businesses/:biz/coupon_sets/:set/codes",
    { preHandler: [authenticate, requirePerm("coupons:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { set } = req.params as { set: string };
      const status = (req.query as { status?: "not_redeemed" | "redeemed" | "archived" }).status;
      if (wantsListQuery(req)) {
        const page = catalogPageQuery(req, reply, {
          specs: COUPON_CODE_PAGE_SPECS,
          sortFields: COUPON_CODE_SORT_FIELDS,
          bareParams: ["status"],
        });
        if (!page) return;
        const result = await pageCouponCodes(
          req.organization!.id,
          business.id,
          { setPublicId: set, status },
          page,
        );
        if (!result) return notFound(reply, `No such coupon set: ${set}`);
        return catalogListEnvelope(page, result, serializeCodeRow);
      }
      const codes = await listCouponSetCodes(
        req.organization!.id,
        business.id,
        set,
        status ? { status } : undefined,
      );
      if (!codes) return notFound(reply, `No such coupon set: ${set}`);
      return { object: "list", data: codes.map(serializeSetCode) };
    },
  );

  // CAT-6: add codes to a set (generated `count` or explicit `codes`).
  app.post(
    "/v1/businesses/:biz/coupon_sets/:set/codes",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { set } = req.params as { set: string };
      const parsed = parseRequest(
        z
          .object({
            count: z.number().int().min(1).max(10000).optional(),
            codes: z.array(couponCodeField()).max(10000).optional(),
            code_prefix: z.string().max(20).optional(),
          })
          .refine((v) => v.count != null || (v.codes && v.codes.length > 0), {
            message: "count or codes required",
          }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const r = await addCouponSetCodes({
          organizationId: req.organization!.id,
          businessId: business.id,
          setPublicId: set,
          count: parsed.data.count,
          codes: parsed.data.codes,
          codePrefix: parsed.data.code_prefix,
        });
        if (!r) return notFound(reply, `No such coupon set: ${set}`);
        return reply.code(201).send({ object: "coupon_set", id: set, added: r.added });
      } catch (e) {
        if (e instanceof CouponError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // CAT-6: archive a single code (not-yet-redeemed only).
  app.post(
    "/v1/businesses/:biz/coupon_codes/:code/archive",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { code } = req.params as { code: string };
      const ok = await archiveCouponCode({
        organizationId: req.organization!.id,
        businessId: business.id,
        code,
      });
      if (!ok) return notFound(reply, `No such not-redeemed code: ${code}`);
      return { object: "coupon_code", code, status: "archived" };
    },
  );

  // CAT-6: delete all unused (not_redeemed) codes in a set.
  app.delete(
    "/v1/businesses/:biz/coupon_sets/:set/unused_codes",
    {
      preHandler: [authenticate, requirePerm("coupons:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { set } = req.params as { set: string };
      const deleted = await deleteUnusedCodes({
        organizationId: req.organization!.id,
        businessId: business.id,
        setPublicId: set,
      });
      if (deleted === null) return notFound(reply, `No such coupon set: ${set}`);
      return { object: "coupon_set", id: set, deleted };
    },
  );
}
