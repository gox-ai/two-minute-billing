import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  USAGE_FILTER_KINDS,
  USAGE_FILTER_OPS,
  USAGE_SORT_FIELDS,
  UsageInvoicedError,
  UsageLevelLockedError,
  deleteUsage,
  getUsage,
  listUsagePage,
  serializeUsage,
} from "@/modules/metering/service";
import {
  UNBILLED_FILTER_KINDS,
  UNBILLED_FILTER_OPS,
  UNBILLED_SORT_FIELDS,
  UnbilledChargeStateError,
  deleteUnbilledCharge,
  estimateInvoiceUnbilledChargesNow,
  invoiceUnbilledChargesNow,
  listUnbilledChargesPage,
  type UnbilledChargeRow,
} from "@/modules/subscriptions/items";
import { UnbilledChargesChangedError } from "@/modules/invoicing/service";
import { inclusivePeriodEnd, serializeInvoice } from "@/modules/invoicing/serialize";
import { getSubscriptionByPublicId } from "@/modules/subscriptions/service";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  currentUsage,
  currentUsageForCustomer,
  serializeCurrentUsage,
} from "@/modules/subscriptions/current-usage";
import { LIMITS } from "./limits";
import {
  badRequest,
  callerHolds,
  conflict,
  listResponse,
  notFound,
  parseListQuery,
  requirePerm,
  resolveBusiness,
} from "./helpers";
import { parseRequest } from "./strict-params";

/**
 * Usage records and unbilled charges at business level: list, retrieve and correct.
 * Recording usage (`POST …/subscriptions/:sub/usage`) and queueing a charge
 * (`POST …/subscriptions/:sub/charges`) stay on the subscription routes.
 */
export async function registerUsageRoutes(app: FastifyInstance) {
  // ── Usage records ──────────────────────────────────────────────────────────
  app.get(
    "/v1/businesses/:biz/usages",
    { preHandler: [authenticate, requirePerm("usage:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const lq = parseListQuery(req, reply, {
        filterOps: USAGE_FILTER_OPS,
        filterKinds: USAGE_FILTER_KINDS,
        sortFields: USAGE_SORT_FIELDS,
        bareParams: ["subscription", "item", "price"],
      });
      if (!lq) return;
      const q = req.query as Record<string, string | undefined>;
      const page = await listUsagePage(req.organization!.id, business.id, {
        subscriptionPublicId: q.subscription,
        itemPublicId: q.item,
        pricePublicId: q.price,
        filters: lq.filters,
        sortField: lq.sortField,
        sortDesc: lq.sortDesc,
        startingAfter: lq.startingAfter,
        limit: lq.limit,
      });
      return listResponse(page, serializeUsage);
    },
  );

  app.get(
    "/v1/businesses/:biz/usages/:id",
    { preHandler: [authenticate, requirePerm("usage:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getUsage(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, `No such usage record: ${id}`);
      return serializeUsage(row);
    },
  );

  app.delete(
    "/v1/businesses/:biz/usages/:id",
    {
      preHandler: [authenticate, requirePerm("usage:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      try {
        const row = await deleteUsage(req.organization!.id, business.id, id);
        if (!row) return notFound(reply, `No such usage record: ${id}`);
        return { ...serializeUsage(row), deleted: true };
      } catch (e) {
        if (e instanceof UsageInvoicedError || e instanceof UsageLevelLockedError)
          return conflict(reply, e.message);
        throw e;
      }
    },
  );

  // ── Unbilled charges ───────────────────────────────────────────────────────
  const serializeCharge =
    (business: Parameters<typeof inclusivePeriodEnd>[1]) => (r: UnbilledChargeRow) => ({
      object: "unbilled_charge",
      id: r.charge.publicId,
      subscription: r.subscriptionPublicId,
      customer: r.customerPublicId,
      description: r.charge.description,
      amount_minor: Number(r.charge.amountMinor),
      currency: r.charge.currency,
      status: r.charge.status,
      quantity: r.charge.quantity,
      entity_type: r.charge.entityType,
      period_start: r.charge.periodStart?.toISOString() ?? null,
      // The convention of the invoice line the charge becomes (as `/charges` answers).
      period_end: inclusivePeriodEnd(r.charge.periodEnd ?? null, business)?.toISOString() ?? null,
      invoice: r.invoicePublicId,
      created_at: r.charge.createdAt,
    });

  app.get(
    "/v1/businesses/:biz/unbilled_charges",
    { preHandler: [authenticate, requirePerm("usage:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const lq = parseListQuery(req, reply, {
        filterOps: UNBILLED_FILTER_OPS,
        filterKinds: UNBILLED_FILTER_KINDS,
        sortFields: UNBILLED_SORT_FIELDS,
        bareParams: ["subscription", "customer"],
      });
      if (!lq) return;
      const q = req.query as Record<string, string | undefined>;
      const page = await listUnbilledChargesPage(req.organization!.id, business.id, {
        subscriptionPublicId: q.subscription,
        customerPublicId: q.customer,
        filters: lq.filters,
        sortDesc: lq.sortDesc,
        startingAfter: lq.startingAfter,
        limit: lq.limit,
      });
      return listResponse(page, serializeCharge(business));
    },
  );

  app.delete(
    "/v1/businesses/:biz/unbilled_charges/:id",
    {
      preHandler: [authenticate, requirePerm("usage:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      try {
        const row = await deleteUnbilledCharge(req.organization!.id, business.id, id);
        if (!row) return notFound(reply, `No such unbilled charge: ${id}`);
        return serializeCharge(business)(row);
      } catch (e) {
        if (e instanceof UnbilledChargeStateError) return conflict(reply, e.message);
        throw e;
      }
    },
  );

  // Exactly one scope: a subscription's queued charges, or all of a customer's.
  const invoiceNowBody = z
    .object({
      subscription: z.string().max(LIMITS.id).min(1).optional(),
      customer: z.string().max(LIMITS.id).min(1).optional(),
    })
    .refine((b) => (b.subscription == null) !== (b.customer == null), {
      message: "Provide exactly one of `subscription` or `customer`",
    });

  const resolveScope = async (
    req: import("fastify").FastifyRequest,
    reply: import("fastify").FastifyReply,
    businessId: string,
  ) => {
    const parsed = parseRequest(invoiceNowBody, req.body ?? {});
    if (!parsed.success) return void badRequest(reply, parsed.error);
    const orgId = req.organization!.id;
    if (parsed.data.subscription != null) {
      const sub = await getSubscriptionByPublicId(orgId, businessId, parsed.data.subscription);
      if (!sub) return void notFound(reply, `No such subscription: ${parsed.data.subscription}`);
      return { subscriptionId: sub.id };
    }
    const cus = await getCustomerByPublicId(orgId, businessId, parsed.data.customer!);
    if (!cus) return void notFound(reply, `No such customer: ${parsed.data.customer}`);
    return { customerId: cus.id };
  };

  app.post(
    "/v1/businesses/:biz/unbilled_charges/invoice_now",
    {
      preHandler: [authenticate, requirePerm("usage:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const scope = await resolveScope(req, reply, business.id);
      if (!scope) return;
      try {
        const raised = await invoiceUnbilledChargesNow({
          organizationId: req.organization!.id,
          businessId: business.id,
          scope,
        });
        return {
          object: "list",
          data: raised.map((r) =>
            serializeInvoice(r.invoice, {
              biz: business,
              subscription: r.subscriptionPublicId,
              customer: r.customerPublicId,
            }),
          ),
        };
      } catch (e) {
        if (e instanceof UnbilledChargesChangedError) return conflict(reply, e.message);
        throw e;
      }
    },
  );

  // A read, but POST like every estimate: it takes the same body as `invoice_now`.
  app.post(
    "/v1/businesses/:biz/unbilled_charges/invoice_now_estimate",
    { preHandler: [authenticate, requirePerm("invoices:estimate")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const scope = await resolveScope(req, reply, business.id);
      if (!scope) return;
      const estimates = await estimateInvoiceUnbilledChargesNow({
        organizationId: req.organization!.id,
        businessId: business.id,
        scope,
      });
      return {
        object: "estimate",
        invoice_estimates: estimates.map(({ subscription, charges, preview: p }) => ({
          object: "invoice_estimate",
          subscription: subscription.publicId,
          currency: subscription.currency,
          lines: charges.map((c) => ({
            unbilled_charge: c.publicId,
            description: c.description,
            quantity: c.quantity,
            amount_minor: Number(c.amountMinor),
          })),
          subtotal_minor: Number(p.subtotalMinor),
          // Same document convention as a serialized invoice: promotional credit is a
          // pre-tax discount, `credits_applied` the post-tax refundable + excess.
          promotional_discount_minor: Number(p.promotionalCreditsAppliedMinor),
          tax_minor: Number(p.taxMinor),
          tax_lines: p.taxLines.map((t) => ({
            description: t.description,
            amount_minor: Number(t.amountMinor),
          })),
          total_minor: Number(p.totalMinor - p.promotionalCreditsAppliedMinor),
          withholding_minor: Number(p.withholdingMinor),
          credits_applied_minor: Number(p.creditsAppliedMinor),
          amount_due_minor: Number(p.amountDueMinor),
        })),
      };
    },
  );

  // ── Current usage (read-only, nothing stored) ──────────────────────────────
  const projectionQuery = z.object({
    include_projection: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  });

  app.get(
    "/v1/businesses/:biz/subscriptions/:sub/current_usage",
    { preHandler: [authenticate, requirePerm("usage:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseRequest(projectionQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const subId = (req.params as { sub: string }).sub;
      const sub = await getSubscriptionByPublicId(req.organization!.id, business.id, subId);
      if (!sub) return notFound(reply, `We could not find the subscription ${subId}.`);
      const view = await currentUsage({
        organizationId: req.organization!.id,
        businessId: business.id,
        subscriptionId: sub.id,
        includeProjection: q.data.include_projection,
        surface: "api",
      });
      if (!view) return notFound(reply, `We could not find the subscription ${subId}.`);
      return serializeCurrentUsage(view, { showCost: callerHolds(req, "usage_margin:view") });
    },
  );

  app.get(
    "/v1/businesses/:biz/customers/:cus/current_usage",
    { preHandler: [authenticate, requirePerm("usage:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseRequest(projectionQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) return notFound(reply, `We could not find the customer ${cusId}.`);
      const r = await currentUsageForCustomer({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        includeProjection: q.data.include_projection,
      });
      return {
        object: "list",
        customer: customer.publicId,
        data: r.data.map((v) =>
          serializeCurrentUsage(v, { showCost: callerHolds(req, "usage_margin:view") }),
        ),
        has_more: r.hasMore,
        totals: r.totals.map((t) => ({
          currency: t.currency,
          subtotal_minor: Number(t.subtotalMinor),
          tax_minor: Number(t.taxMinor),
          total_minor: Number(t.totalMinor),
          projected_total_minor:
            t.projectedTotalMinor == null ? null : Number(t.projectedTotalMinor),
        })),
      };
    },
  );
}
