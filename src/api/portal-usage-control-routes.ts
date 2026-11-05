/**
 * Portal spend limits (design G5 §3.2, Decision 7): the buyer views every limit, and adds,
 * lowers or deletes its own hard limits on the account or a usage property — never above
 * the provider's limit for the same scope and interval. Operator rows are read-only here.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticatePortal } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { withTenant } from "@/platform/db";
import { customers } from "@db/schema";
import { eq } from "drizzle-orm";
import {
  createSpendLimit,
  deleteSpendLimit,
  listSpendLimits,
  tierOnlyLimits,
  updateSpendLimit,
} from "@/modules/usage-controls/limits";
import { measureRunway } from "@/modules/usage-controls/measure";
import { liveMeteredItems } from "@/modules/credits/usage";
import { badRequest } from "./helpers";
import { parseRequest } from "./strict-params";
import {
  meterIdsFor,
  runwayView,
  sendUsageControlError,
  spendLimitView,
  standingAt,
} from "./usage-control-routes";

const MINOR = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const buyerLimitBody = z.object({
  scope: z.enum(["customer", "property"]),
  property_key: z.string().min(1).max(64).optional(),
  property_value: z.string().min(1).max(255).nullable().optional(),
  meters: z.array(z.string().min(1).max(100)).min(1).max(50).nullable().optional(),
  interval: z.enum(["day", "week", "month", "period"]),
  amount_minor: MINOR,
  currency: z.string().regex(/^[A-Za-z]{3}$/, "Send a 3-letter ISO currency code"),
});
const buyerLimitPatch = z.object({ amount_minor: MINOR });

async function customerPublicId(org: string, customerId: string): Promise<string> {
  const [c] = await withTenant(org, (tx) =>
    tx
      .select({ p: customers.publicId })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1),
  );
  return c!.p;
}

export async function registerPortalUsageControlRoutes(app: FastifyInstance) {
  app.get("/portal/v1/spend_limits", { preHandler: authenticatePortal }, async (req) => {
    const ctx = req.portalSession!;
    const cus = await customerPublicId(ctx.organizationId, ctx.customerId);
    const rows = await listSpendLimits(ctx.organizationId, ctx.businessId, ctx.customerId);
    // The buyer sees hard limits only; a soft limit is the provider's notice setting. A
    // provider's customer limit shows the amount that applies (a reached tier raises it), and
    // a tier with no provider limit for its interval is listed as the provider's limit.
    const data = await withTenant(ctx.organizationId, async (tx) => {
      const at = await standingAt(tx, ctx.businessId);
      const out: Array<Record<string, unknown>> = [];
      for (const l of rows.filter((x) => x.mode === "hard" && x.scope !== "subscription"))
        out.push({ ...(await spendLimitView(tx, l, cus, at)), editable: l.setBy === "customer" });
      for (const t of await tierOnlyLimits(tx, ctx.customerId, rows))
        out.push({
          object: "spend_limit",
          id: t.tier.publicId,
          customer: cus,
          scope: "customer",
          subscription: null,
          property_key: null,
          property_value: null,
          meters: null,
          interval: t.interval,
          amount_minor: Number(t.amountMinor),
          effective_amount_minor: Number(t.amountMinor),
          currency: t.currency,
          mode: "hard",
          set_by: "operator",
          active: true,
          editable: false,
        });
      // The buyer may add a limit once it has usage to limit, even with no limit yet.
      const canAdd =
        out.length > 0 || (await liveMeteredItems(tx, { customerId: ctx.customerId })).length > 0;
      return { out, canAdd };
    });
    return { object: "list", data: data.out, can_add: data.canAdd };
  });

  app.post(
    "/portal/v1/spend_limits",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const parsed = parseRequest(buyerLimitBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const b = parsed.data;
      try {
        const meterIds = await withTenant(ctx.organizationId, (tx) =>
          meterIdsFor(tx, ctx.businessId, b.meters),
        );
        const l = await createSpendLimit({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          fields: {
            scope: b.scope,
            propertyKey: b.property_key ?? null,
            propertyValue: b.property_value ?? null,
            meterIds,
            interval: b.interval,
            amountMinor: BigInt(b.amount_minor),
            currency: b.currency,
            mode: "hard",
            setBy: "customer",
          },
        });
        const cus = await customerPublicId(ctx.organizationId, ctx.customerId);
        const view = await withTenant(ctx.organizationId, (tx) => spendLimitView(tx, l, cus));
        return reply.code(201).send({ ...view, editable: true });
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.patch(
    "/portal/v1/spend_limits/:limit",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { limit } = req.params as { limit: string };
      const parsed = parseRequest(buyerLimitPatch, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const l = await updateSpendLimit({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          limit,
          amountMinor: BigInt(parsed.data.amount_minor),
          asBuyer: true,
        });
        const cus = await customerPublicId(ctx.organizationId, ctx.customerId);
        const view = await withTenant(ctx.organizationId, (tx) => spendLimitView(tx, l, cus));
        return { ...view, editable: true };
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.delete(
    "/portal/v1/spend_limits/:limit",
    { preHandler: [authenticatePortal, idempotency], onSend: idempotencyOnSend },
    async (req, reply) => {
      const ctx = req.portalSession!;
      const { limit } = req.params as { limit: string };
      try {
        const l = await deleteSpendLimit({
          organizationId: ctx.organizationId,
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          limit,
          asBuyer: true,
        });
        return { object: "spend_limit", id: l.publicId, deleted: true };
      } catch (e) {
        return sendUsageControlError(reply, e);
      }
    },
  );

  app.get("/portal/v1/credit_runway", { preHandler: authenticatePortal }, async (req, reply) => {
    const ctx = req.portalSession!;
    const q = req.query as { currency?: string };
    if (q.currency !== undefined && !/^[A-Za-z]{3}$/.test(q.currency))
      return badRequest(reply, "Send a 3-letter ISO currency code");
    const cus = await customerPublicId(ctx.organizationId, ctx.customerId);
    const currency = await withTenant(ctx.organizationId, async (tx) => {
      if (q.currency) return q.currency.toUpperCase();
      const [c] = await tx
        .select({ c: customers.currency })
        .from(customers)
        .where(eq(customers.id, ctx.customerId))
        .limit(1);
      return (c?.c ?? "USD").toUpperCase();
    });
    const r = await withTenant(ctx.organizationId, (tx) =>
      measureRunway(tx, { businessId: ctx.businessId, customerId: ctx.customerId, currency }),
    );
    return runwayView(cus, currency, r);
  });
}
