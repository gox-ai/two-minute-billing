/**
 * Automatic credit top-up and usage invoice thresholds (design G5 §3.6–3.7). Every write takes
 * an `Idempotency-Key`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  AutoTopupError,
  autoTopupLead,
  getAutoTopup,
  listAutoTopupRuns,
  putAutoTopup,
  serializeAutoTopup,
  serializeAutoTopupRuns,
  setAutoTopupStatus,
} from "@/modules/usage-controls/auto-topup";
import {
  deleteUsageThreshold,
  listUsageThresholds,
  putPlanUsageThreshold,
  putSubscriptionUsageThreshold,
  serializeUsageThresholds,
  ThresholdError,
} from "@/modules/usage-controls/threshold-invoicing";
import { badRequest, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const MINOR = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const POSITIVE = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const CURRENCY = z.string().regex(/^[A-Za-z]{3}$/, "Send a 3-letter ISO currency code");

const applicability = z.union([
  z.object({ kind: z.literal("metered") }),
  z.object({
    kind: z.literal("prices"),
    prices: z.array(z.string().min(1).max(100)).min(1).max(100),
  }),
]);
export const autoTopupBody = z.object({
  currency: CURRENCY.optional(),
  unit: z.string().min(1).max(100).nullable().optional(),
  trigger: z.enum(["threshold", "schedule"]),
  threshold_minor: MINOR.nullable().optional(),
  schedule: z
    .union([
      z.object({ every: z.literal("week"), weekday: z.number().int().min(1).max(7) }),
      z.object({ every: z.literal("month"), day: z.number().int().min(1).max(31) }),
    ])
    .nullable()
    .optional(),
  method: z.enum(["fixed", "target"]),
  amount_minor: POSITIVE.nullable().optional(),
  target_minor: POSITIVE.nullable().optional(),
  monthly_cap_minor: POSITIVE,
  max_runs_per_day: z.number().int().min(1).max(10).optional(),
  payment_method: z.string().min(1).max(100).nullable().optional(),
  grant: z.object({
    tax_treatment: z.enum(["taxed_at_purchase", "taxed_at_use"]),
    priority: z.number().int().min(0).max(100).optional(),
    expires_after_months: z.number().int().min(1).max(120).nullable().optional(),
    applicability: applicability.optional(),
  }),
});
const which = z.object({
  currency: CURRENCY.optional(),
  unit: z.string().min(1).max(100).optional(),
});
const runList = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  starting_after: z.string().max(100).optional(),
});
const planThresholdBody = z.object({ amount_minor: POSITIVE });
const subThresholdBody = z.object({ amount_minor: POSITIVE.nullable() });
const thresholdList = z.object({
  product: z.string().min(1).max(100).optional(),
  subscription: z.string().min(1).max(100).optional(),
});

type Params = { cus?: string; product?: string; currency?: string; sub?: string };
const params = (req: FastifyRequest) => req.params as Params;

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof AutoTopupError || e instanceof ThresholdError)
    return e.status === 404 ? notFound(reply, e.message) : badRequest(reply, e.message);
  throw e;
}

export async function registerUsageBillingRoutes(app: FastifyInstance) {
  const read = { preHandler: [authenticate, requirePerm("usage_controls:view")] };

  // ── Automatic top-up ──
  app.get("/v1/businesses/:biz/customers/:cus/auto_topup", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(which, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    try {
      const cfg = await getAutoTopup({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerPublicId: params(req).cus!,
        currency: q.data.currency,
        unitKey: q.data.unit ?? null,
      });
      if (!cfg) return notFound(reply, "This customer has no automatic top-up.");
      return serializeAutoTopup(req.organization!.id, cfg, await autoTopupLead(cfg));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put(
    "/v1/businesses/:biz/customers/:cus/auto_topup",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(autoTopupBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      const big = (v: number | null | undefined) => (v == null ? null : BigInt(v));
      try {
        const { config, lead } = await putAutoTopup({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerPublicId: params(req).cus!,
          config: {
            currency: d.currency,
            unitKey: d.unit ?? null,
            trigger: d.trigger,
            thresholdMinor: big(d.threshold_minor),
            schedule: d.schedule ?? null,
            method: d.method,
            amountMinor: big(d.amount_minor),
            targetMinor: big(d.target_minor),
            monthlyCapMinor: BigInt(d.monthly_cap_minor),
            maxRunsPerDay: d.max_runs_per_day,
            paymentMethod: d.payment_method ?? null,
            grant: d.grant,
          },
        });
        return serializeAutoTopup(req.organization!.id, config, lead);
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  for (const action of ["enable", "disable"] as const)
    app.post(
      `/v1/businesses/:biz/customers/:cus/auto_topup/${action}`,
      {
        preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
        onSend: idempotencyOnSend,
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const q = parseRequest(which, req.query ?? {});
        if (!q.success) return badRequest(reply, q.error);
        try {
          const cfg = await setAutoTopupStatus({
            organizationId: req.organization!.id,
            businessId: business.id,
            customerPublicId: params(req).cus!,
            currency: q.data.currency,
            unitKey: q.data.unit ?? null,
            status: action === "enable" ? "active" : "disabled",
            reason: "operator",
          });
          return serializeAutoTopup(req.organization!.id, cfg);
        } catch (e) {
          return fail(reply, e);
        }
      },
    );

  app.get("/v1/businesses/:biz/customers/:cus/auto_topup/runs", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(runList, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    try {
      const page = await listAutoTopupRuns({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerPublicId: params(req).cus!,
        limit: q.data.limit ?? 25,
        startingAfter: q.data.starting_after,
      });
      return {
        object: "list",
        data: await serializeAutoTopupRuns(req.organization!.id, page.data),
        has_more: page.hasMore,
        next_cursor: page.hasMore ? page.data.at(-1)!.publicId : null,
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // ── Usage invoice thresholds ──
  app.get("/v1/businesses/:biz/usage_invoice_thresholds", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(thresholdList, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    try {
      const rows = await listUsageThresholds({
        organizationId: req.organization!.id,
        businessId: business.id,
        productPublicId: q.data.product,
        subscriptionPublicId: q.data.subscription,
      });
      return { object: "list", data: await serializeUsageThresholds(req.organization!.id, rows) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put(
    "/v1/businesses/:biz/products/:product/usage_invoice_thresholds/:currency",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(planThresholdBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const cur = params(req).currency!;
      if (!/^[A-Za-z]{3}$/.test(cur)) return badRequest(reply, "Send a 3-letter ISO currency code");
      try {
        const row = await putPlanUsageThreshold({
          organizationId: req.organization!.id,
          businessId: business.id,
          productPublicId: params(req).product!,
          currency: cur,
          amountMinor: BigInt(parsed.data.amount_minor),
        });
        return (await serializeUsageThresholds(req.organization!.id, [row]))[0];
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/products/:product/usage_invoice_thresholds/:currency",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      try {
        const gone = await deleteUsageThreshold({
          organizationId: req.organization!.id,
          businessId: business.id,
          productPublicId: params(req).product!,
          currency: params(req).currency!,
        });
        if (!gone)
          return notFound(reply, "This plan has no usage invoice threshold in that currency.");
        return { object: "usage_invoice_threshold", deleted: true };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.put(
    "/v1/businesses/:biz/subscriptions/:sub/usage_invoice_threshold",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(subThresholdBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const row = await putSubscriptionUsageThreshold({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionPublicId: params(req).sub!,
          amountMinor: parsed.data.amount_minor == null ? null : BigInt(parsed.data.amount_minor),
        });
        return (await serializeUsageThresholds(req.organization!.id, [row]))[0];
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/subscriptions/:sub/usage_invoice_threshold",
    {
      preHandler: [authenticate, requirePerm("usage_controls:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      try {
        const gone = await deleteUsageThreshold({
          organizationId: req.organization!.id,
          businessId: business.id,
          subscriptionPublicId: params(req).sub!,
        });
        if (!gone) return notFound(reply, "This subscription has no usage invoice threshold.");
        return { object: "usage_invoice_threshold", deleted: true };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
}
