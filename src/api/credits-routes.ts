/**
 * Credit units, credit grants and the credit transaction list (design G3 §7). Holds and the
 * access check have their own routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { withTenant } from "@/platform/db";
import { permissionDef } from "@/modules/auth/permissions";
import {
  archiveCreditUnit,
  createCreditUnit,
  createPromotionalGrant,
  CreditConflictError,
  CreditNotFoundError,
  CreditRuleError,
  getCreditGrant,
  getCreditUnit,
  grantViewById,
  listCreditGrants,
  listCreditTransactions,
  listCreditUnits,
  MOVEMENT_KINDS,
  serializeCreditGrant,
  serializeCreditUnit,
  updateCreditUnit,
  voidCreditGrant,
  type CreditUnitInput,
  type MovementKind,
} from "@/modules/credits/service";
import { createManualPaidGrant } from "@/modules/credits/paid-grant";
import { parseRateE12 } from "@/modules/credits/units";
import {
  badRequest,
  callerHolds,
  conflict,
  missingPermission,
  notFound,
  requirePerm,
  resolveBusiness,
} from "./helpers";
import { parseRequest } from "./strict-params";

const rate = z
  .string()
  .regex(/^\d{1,18}(\.\d{1,12})?$/, "Use a decimal number with at most 12 decimal places.");
const unitCreate = z.object({
  id: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(100),
  plural_name: z.string().min(1).max(100).optional(),
  currency: z.string().length(3),
  minor_per_unit: rate,
  decimals: z.number().int().min(0).max(4).optional(),
});
const unitPatch = z.object({
  name: z.string().min(1).max(100).optional(),
  plural_name: z.string().min(1).max(100).optional(),
  currency: z.string().length(3).optional(),
  minor_per_unit: rate.optional(),
  decimals: z.number().int().min(0).max(4).optional(),
  expected_version: z.number().int().positive().optional(),
});
const unitList = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().max(100).optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const instant = z.union([z.number().int().positive(), z.iso.datetime({ offset: true })]);
const toDate = (v: number | string | undefined | null): Date | undefined | null =>
  v === undefined
    ? undefined
    : v === null
      ? null
      : typeof v === "number"
        ? new Date(v * 1000)
        : new Date(v);
const applicability = z.union([
  z.object({ kind: z.literal("metered") }),
  z.object({
    kind: z.literal("prices"),
    prices: z.array(z.string().min(1).max(100)).min(1).max(100),
  }),
  z.object({
    kind: z.literal("meters"),
    meters: z.array(z.string().min(1).max(100)).min(1).max(100),
  }),
]);
const grantCreate = z.object({
  category: z.enum(["promotional", "paid"]).optional(),
  unit: z.string().min(1).max(100).nullable().optional(),
  currency: z.string().length(3).optional(),
  amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  priority: z.number().int().min(0).max(100).optional(),
  effective_at: instant.optional(),
  expires_at: instant.nullable().optional(),
  applicability: applicability.optional(),
  on_exhausted: z.enum(["block", "bill"]).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // paid only (C4)
  price_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"]).optional(),
  mark_paid: z
    .object({
      method: z.string().min(1).max(50),
      reference: z.string().max(200).optional(),
      paid_at: instant.optional(),
    })
    .optional(),
});
const grantList = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().max(100).optional(),
  status: z.enum(["pending", "active", "expired", "voided"]).optional(),
  category: z.enum(["paid", "promotional"]).optional(),
  currency: z.string().length(3).optional(),
});
const unixOrIso = z.union([z.coerce.number().int().positive(), z.iso.datetime({ offset: true })]);
const txList = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().max(100).optional(),
  grant: z.string().max(100).optional(),
  kind: z.enum(MOVEMENT_KINDS as [MovementKind, ...MovementKind[]]).optional(),
  category: z.enum(["paid", "promotional"]).optional(),
  // `money` = grants with no custom unit.
  unit: z.string().min(1).max(100).optional(),
  invoice: z.string().max(100).optional(),
  "created[gte]": unixOrIso.optional(),
  "created[lt]": unixOrIso.optional(),
});

type Params = { unit?: string; cus?: string; grant?: string };
const params = (req: FastifyRequest) => req.params as Params;

function creditError(reply: FastifyReply, e: unknown) {
  if (e instanceof CreditRuleError) return badRequest(reply, e.message);
  if (e instanceof CreditConflictError) return conflict(reply, e.message);
  if (e instanceof CreditNotFoundError) return notFound(reply, e.message);
  throw e;
}

function unitPatchOf(d: z.infer<typeof unitPatch>): Partial<CreditUnitInput> | string {
  const out: Partial<CreditUnitInput> = {};
  if (d.name !== undefined) out.name = d.name;
  if (d.plural_name !== undefined) out.pluralName = d.plural_name;
  if (d.currency !== undefined) out.currency = d.currency;
  if (d.decimals !== undefined) out.decimals = d.decimals;
  if (d.minor_per_unit !== undefined) {
    const r = parseRateE12(d.minor_per_unit);
    if (r === null) return "We could not save the credit unit. The rate must be more than 0.";
    out.minorPerUnitE12 = r;
  }
  return out;
}

export async function registerCreditRoutes(app: FastifyInstance) {
  const read = { preHandler: [authenticate, requirePerm("credits:view")] };

  // ── Credit units ──
  app.get("/v1/businesses/:biz/credit_units", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(unitList, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const page = await listCreditUnits({
      organizationId: req.organization!.id,
      businessId: business.id,
      limit: q.data.limit ?? 100,
      startingAfter: q.data.starting_after,
      status: q.data.status,
    });
    return {
      object: "list",
      data: page.data.map(serializeCreditUnit),
      has_more: page.hasMore,
      next_cursor: page.hasMore ? page.data.at(-1)!.key : null,
    };
  });

  app.post(
    "/v1/businesses/:biz/credit_units",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(unitCreate, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const r = parseRateE12(parsed.data.minor_per_unit);
      if (r === null)
        return badRequest(
          reply,
          "We could not save the credit unit. The rate must be more than 0.",
        );
      try {
        const u = await createCreditUnit({
          organizationId: req.organization!.id,
          businessId: business.id,
          key: parsed.data.id,
          unit: {
            name: parsed.data.name,
            pluralName: parsed.data.plural_name,
            currency: parsed.data.currency,
            minorPerUnitE12: r,
            decimals: parsed.data.decimals,
          },
        });
        return reply.code(201).send(serializeCreditUnit(u));
      } catch (e) {
        return creditError(reply, e);
      }
    },
  );

  app.get("/v1/businesses/:biz/credit_units/:unit", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const key = params(req).unit!;
    const u = await getCreditUnit(req.organization!.id, business.id, key);
    if (!u) return notFound(reply, `No such credit unit: ${key}`);
    return serializeCreditUnit(u);
  });

  app.patch(
    "/v1/businesses/:biz/credit_units/:unit",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const key = params(req).unit!;
      const parsed = parseRequest(unitPatch, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const patch = unitPatchOf(parsed.data);
      if (typeof patch === "string") return badRequest(reply, patch);
      try {
        const u = await updateCreditUnit({
          organizationId: req.organization!.id,
          businessId: business.id,
          key,
          patch,
          expectedVersion: parsed.data.expected_version,
        });
        if (!u) return notFound(reply, `No such credit unit: ${key}`);
        return serializeCreditUnit(u);
      } catch (e) {
        return creditError(reply, e);
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/credit_units/:unit/archive",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const key = params(req).unit!;
      const u = await archiveCreditUnit({
        organizationId: req.organization!.id,
        businessId: business.id,
        key,
      });
      if (!u) return notFound(reply, `No such credit unit: ${key}`);
      return serializeCreditUnit(u);
    },
  );

  // ── Credit grants ──
  app.post(
    "/v1/businesses/:biz/customers/:cus/credit_grants",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(grantCreate, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      const orgId = req.organization!.id;
      const cus = params(req).cus!;
      try {
        if (d.category === "paid") {
          // A paid grant raises an invoice, so the caller also needs `invoices:manage` (C1).
          if (!callerHolds(req, "invoices:manage"))
            return missingPermission(reply, permissionDef("invoices:manage")!, !!req.hasOperator);
          if (d.price_minor === undefined)
            return badRequest(
              reply,
              "We could not create the credit grant. Paid credit needs price_minor.",
            );
          if (!d.tax_treatment)
            return badRequest(
              reply,
              "We could not create the credit grant. Set a tax treatment for paid credit.",
            );
          const { grant } = await createManualPaidGrant({
            organizationId: orgId,
            businessId: business.id,
            customerPublicId: cus,
            unitKey: d.unit ?? null,
            currency: d.currency,
            amount: BigInt(d.amount),
            priceMinor: BigInt(d.price_minor),
            taxTreatment: d.tax_treatment,
            priority: d.priority,
            expiresAt: toDate(d.expires_at),
            applicability: d.applicability,
            onExhausted: d.on_exhausted,
            metadata: d.metadata,
            markPaid: d.mark_paid
              ? {
                  method: d.mark_paid.method,
                  reference: d.mark_paid.reference,
                  paidAt: toDate(d.mark_paid.paid_at) ?? undefined,
                }
              : undefined,
            createdByUserId: req.operatorUserId ?? null,
          });
          const view = await withTenant(orgId, (tx) => grantViewById(tx, grant.id));
          return reply.code(201).send(serializeCreditGrant(view!));
        }
        if (d.price_minor !== undefined || d.tax_treatment || d.mark_paid)
          return badRequest(
            reply,
            "We could not create the credit grant. price_minor, tax_treatment and mark_paid are for paid credit only.",
          );
        const grant = await createPromotionalGrant({
          organizationId: orgId,
          businessId: business.id,
          customerPublicId: cus,
          currency: d.currency,
          unitKey: d.unit ?? null,
          amount: BigInt(d.amount),
          priority: d.priority,
          effectiveAt: toDate(d.effective_at) ?? undefined,
          expiresAt: toDate(d.expires_at),
          applicability: d.applicability,
          onExhausted: d.on_exhausted,
          metadata: d.metadata,
          createdByUserId: req.operatorUserId ?? null,
        });
        const view = await withTenant(orgId, (tx) => grantViewById(tx, grant.id));
        return reply.code(201).send(serializeCreditGrant(view!));
      } catch (e) {
        return creditError(reply, e);
      }
    },
  );

  app.get("/v1/businesses/:biz/customers/:cus/credit_grants", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(grantList, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    try {
      const page = await listCreditGrants({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerPublicId: params(req).cus!,
        limit: q.data.limit ?? 50,
        startingAfter: q.data.starting_after,
        status: q.data.status,
        category: q.data.category,
        currency: q.data.currency,
      });
      return {
        object: "list",
        data: page.data.map(serializeCreditGrant),
        has_more: page.hasMore,
        next_cursor: page.hasMore ? page.data.at(-1)!.grant.publicId : null,
      };
    } catch (e) {
      return creditError(reply, e);
    }
  });

  app.get("/v1/businesses/:biz/customers/:cus/credit_grants/:grant", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const p = params(req);
    try {
      const v = await getCreditGrant({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerPublicId: p.cus!,
        grantPublicId: p.grant!,
      });
      if (!v) return notFound(reply, `No such credit grant: ${p.grant}`);
      return serializeCreditGrant(v);
    } catch (e) {
      return creditError(reply, e);
    }
  });

  app.post(
    "/v1/businesses/:biz/customers/:cus/credit_grants/:grant/void",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const p = params(req);
      const orgId = req.organization!.id;
      try {
        const g = await voidCreditGrant({
          organizationId: orgId,
          businessId: business.id,
          customerPublicId: p.cus!,
          grantPublicId: p.grant!,
        });
        const view = await withTenant(orgId, (tx) => grantViewById(tx, g.id));
        return serializeCreditGrant(view!);
      } catch (e) {
        return creditError(reply, e);
      }
    },
  );

  // ── Credit transactions (movements) ──
  app.get("/v1/businesses/:biz/customers/:cus/credit_transactions", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(txList, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const d = q.data;
    try {
      const page = await listCreditTransactions({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerPublicId: params(req).cus!,
        limit: d.limit ?? 50,
        startingAfter: d.starting_after,
        grantPublicId: d.grant,
        kind: d.kind,
        category: d.category,
        unitKey: d.unit === "money" ? null : d.unit,
        invoicePublicId: d.invoice,
        createdGte: toDate(d["created[gte]"]) ?? undefined,
        createdLt: toDate(d["created[lt]"]) ?? undefined,
      });
      return {
        object: "list",
        data: page.data,
        has_more: page.hasMore,
        next_cursor: page.hasMore ? page.data.at(-1)!.id : null,
      };
    } catch (e) {
      return creditError(reply, e);
    }
  });
}
