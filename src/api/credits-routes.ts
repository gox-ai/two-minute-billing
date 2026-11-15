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
  customerByPublicId,
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
  updateCreditUnit,
  voidCreditGrant,
  type CreditUnitInput,
  type MovementKind,
} from "@/modules/credits/service";
import { createManualPaidGrant } from "@/modules/credits/paid-grant";
import { listCreditUsage } from "@/modules/credits/usage-settlement";
import { parseRateE12 } from "@/modules/credits/units";
import {
  hasPolicyPatch,
  policiesIssue,
  serializeUnits,
  serializeUnitWithPolicies,
  setUnitPolicies,
  unitPoliciesFor,
  type UnitPoliciesPatch,
} from "@/modules/credits/unit-policies";
import {
  voidReasonBody,
  voidReasonIssue,
  voidReasonsFor,
  type CreditVoidReason,
} from "@/modules/credits/void-reasons";
import { NEGATIVE_AT_RESET } from "@db/schema";
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
// Policies for usage past the credits (0528); a unit with no rate only.
const policyFields = {
  overage_minor_per_unit: rate.nullable().optional(),
  overdraft_limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  negative_balance_at_reset: z.enum(NEGATIVE_AT_RESET).optional(),
};
const unitCreate = z.object({
  id: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(100),
  plural_name: z.string().min(1).max(100).optional(),
  currency: z.string().length(3),
  // Required: a rate, or an explicit null for a unit with no rate. A missing field is 400,
  // so a client that forgets it does not get the other kind of unit.
  minor_per_unit: rate.nullable(),
  decimals: z.number().int().min(0).max(4).optional(),
  ...policyFields,
});
const unitPatch = z.object({
  name: z.string().min(1).max(100).optional(),
  plural_name: z.string().min(1).max(100).optional(),
  currency: z.string().length(3).optional(),
  minor_per_unit: rate.nullable().optional(),
  decimals: z.number().int().min(0).max(4).optional(),
  expected_version: z.number().int().positive().optional(),
  ...policyFields,
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

const usageList = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().max(100).optional(),
  meter: z.string().min(1).max(100).optional(),
});

type Params = { unit?: string; cus?: string; grant?: string };
const params = (req: FastifyRequest) => req.params as Params;

function creditError(reply: FastifyReply, e: unknown) {
  if (e instanceof CreditRuleError) return badRequest(reply, e.message);
  if (e instanceof CreditConflictError) return conflict(reply, e.message);
  if (e instanceof CreditNotFoundError) return notFound(reply, e.message);
  throw e;
}

/** The policy fields of a create or patch body; a string is the refusal. */
function policiesOf(d: {
  overage_minor_per_unit?: string | null;
  overdraft_limit?: number;
  negative_balance_at_reset?: "carry" | "forgive";
}): UnitPoliciesPatch | string {
  const out: UnitPoliciesPatch = {};
  if (d.overage_minor_per_unit === null) out.overageMinorPerUnitE12 = null;
  else if (d.overage_minor_per_unit !== undefined) {
    const r = parseRateE12(d.overage_minor_per_unit);
    if (r === null)
      return "We could not save the credit unit. The overage price must be more than 0.";
    out.overageMinorPerUnitE12 = r;
  }
  if (d.overdraft_limit !== undefined) out.overdraftSteps = BigInt(d.overdraft_limit);
  if (d.negative_balance_at_reset !== undefined) out.negativeAtReset = d.negative_balance_at_reset;
  return out;
}

// `without_refund` voids a PAID grant with no credit note: its unused cost is written off.
const grantVoidBody = voidReasonBody.extend({ without_refund: z.boolean().optional() });

type GrantViewT = Parameters<typeof serializeCreditGrant>[0];
/** The grant object with its void reason (0529); null when none was given. */
async function grantsOut(orgId: string, views: GrantViewT[]) {
  const reasons = await withTenant(orgId, (tx) =>
    voidReasonsFor(
      tx,
      views.map((v) => v.grant.id),
    ),
  );
  return views.map((v) => ({
    ...serializeCreditGrant(v),
    void_reason: reasons.get(v.grant.id) ?? null,
  }));
}

function unitPatchOf(d: z.infer<typeof unitPatch>): Partial<CreditUnitInput> | string {
  const out: Partial<CreditUnitInput> = {};
  if (d.name !== undefined) out.name = d.name;
  if (d.plural_name !== undefined) out.pluralName = d.plural_name;
  if (d.currency !== undefined) out.currency = d.currency;
  if (d.decimals !== undefined) out.decimals = d.decimals;
  if (d.minor_per_unit === null) out.minorPerUnitE12 = null;
  else if (d.minor_per_unit !== undefined) {
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
    const data = await withTenant(req.organization!.id, (tx) => serializeUnits(tx, page.data));
    return {
      object: "list",
      data,
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
      // Said in words: the schema's own refusal does not tell the caller what to send.
      if ((req.body as { minor_per_unit?: unknown } | null)?.minor_per_unit === undefined)
        return badRequest(
          reply,
          "We could not create the credit unit. minor_per_unit is missing. Send minor_per_unit: a rate, or null for a unit with no money value.",
        );
      const parsed = parseRequest(unitCreate, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const r =
        parsed.data.minor_per_unit == null ? null : parseRateE12(parsed.data.minor_per_unit);
      if (parsed.data.minor_per_unit != null && r === null)
        return badRequest(
          reply,
          "We could not save the credit unit. The rate must be more than 0.",
        );
      const policies = policiesOf(parsed.data);
      if (typeof policies === "string") return badRequest(reply, policies);
      const policyIssue = policiesIssue({ minorPerUnitE12: r }, policies);
      if (policyIssue) return badRequest(reply, policyIssue);
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
        // Checked above, so this write has nothing left to refuse.
        const p = hasPolicyPatch(policies)
          ? await withTenant(req.organization!.id, (tx) =>
              setUnitPolicies(tx, {
                organizationId: req.organization!.id,
                businessId: business.id,
                unit: u,
                patch: policies,
              }),
            )
          : undefined;
        return reply.code(201).send(serializeUnitWithPolicies(u, p));
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
    const [view] = await withTenant(req.organization!.id, (tx) => serializeUnits(tx, [u]));
    return view;
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
      const policies = policiesOf(parsed.data);
      if (typeof policies === "string") return badRequest(reply, policies);
      const orgId = req.organization!.id;
      try {
        // A rate and an overage price exclude each other: check the unit as it will be.
        const cur = await getCreditUnit(orgId, business.id, key);
        if (!cur) return notFound(reply, `No such credit unit: ${key}`);
        const stored = (await withTenant(orgId, (tx) => unitPoliciesFor(tx, [cur.id]))).get(
          cur.id,
        )!;
        const nextRate =
          patch.minorPerUnitE12 !== undefined ? patch.minorPerUnitE12 : cur.minorPerUnitE12;
        const issue = policiesIssue(
          { minorPerUnitE12: nextRate },
          {
            overageMinorPerUnitE12:
              policies.overageMinorPerUnitE12 !== undefined
                ? policies.overageMinorPerUnitE12
                : stored.overageMinorPerUnitE12,
            overdraftSteps: policies.overdraftSteps ?? stored.overdraftSteps,
            negativeAtReset: policies.negativeAtReset ?? stored.negativeAtReset,
          },
        );
        if (issue) return badRequest(reply, issue);
        const u = await updateCreditUnit({
          organizationId: orgId,
          businessId: business.id,
          key,
          patch,
          expectedVersion: parsed.data.expected_version,
        });
        if (!u) return notFound(reply, `No such credit unit: ${key}`);
        const p = hasPolicyPatch(policies)
          ? await withTenant(orgId, (tx) =>
              setUnitPolicies(tx, {
                organizationId: orgId,
                businessId: business.id,
                unit: u,
                patch: policies,
              }),
            )
          : stored;
        return serializeUnitWithPolicies(u, p);
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
      const [view] = await withTenant(req.organization!.id, (tx) => serializeUnits(tx, [u]));
      return view;
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
          return reply.code(201).send({ ...serializeCreditGrant(view!), void_reason: null });
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
        return reply.code(201).send({ ...serializeCreditGrant(view!), void_reason: null });
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
        data: await grantsOut(req.organization!.id, page.data),
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
      return (await grantsOut(req.organization!.id, [v]))[0];
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
      // The body is optional: a void with no reason records none, as before 0529.
      const parsed = parseRequest(grantVoidBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const issue = voidReasonIssue(parsed.data);
      if (issue) return badRequest(reply, issue);
      const noRefund = parsed.data.without_refund === true;
      if (noRefund && !parsed.data.reason)
        return badRequest(
          reply,
          "We could not void the credit grant. A void with no refund needs a reason. Send reason too.",
        );
      try {
        if (noRefund) {
          const v = await getCreditGrant({
            organizationId: orgId,
            businessId: business.id,
            customerPublicId: p.cus!,
            grantPublicId: p.grant!,
          });
          if (!v) return notFound(reply, `No such credit grant: ${p.grant}`);
          if (v.grant.category === "promotional")
            return badRequest(
              reply,
              "We could not void the credit grant. without_refund is for paid credit. Promotional credit has no refund. Send the request with no without_refund.",
            );
        }
        const g = await voidCreditGrant({
          organizationId: orgId,
          businessId: business.id,
          customerPublicId: p.cus!,
          grantPublicId: p.grant!,
          ...(parsed.data.reason
            ? {
                reason: {
                  reason: parsed.data.reason as CreditVoidReason,
                  note: parsed.data.note ?? null,
                  userId: req.operatorUserId ?? null,
                },
              }
            : {}),
          ...(noRefund
            ? { withoutRefund: { reason: parsed.data.note ?? parsed.data.reason! } }
            : {}),
        });
        const view = await withTenant(orgId, (tx) => grantViewById(tx, g.id));
        return (await grantsOut(orgId, [view!]))[0];
      } catch (e) {
        return creditError(reply, e);
      }
    },
  );

  // ── Credit usage: the settlements of usage paid in credits ──
  app.get("/v1/businesses/:biz/customers/:cus/credit_usage", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(usageList, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    try {
      const customer = await withTenant(req.organization!.id, (tx) =>
        customerByPublicId(tx, business.id, params(req).cus!),
      );
      const page = await listCreditUsage({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId: customer.id,
        customerPublicId: customer.publicId,
        limit: q.data.limit ?? 50,
        startingAfter: q.data.starting_after,
        meterKey: q.data.meter,
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
