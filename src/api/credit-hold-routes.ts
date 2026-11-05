/**
 * Credit holds and the access check (design G3 §3.7, §3.9).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { parseJsonExact } from "@/modules/metering/json-source";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  CaptureEventError,
  captureCreditHold,
  createCreditHold,
  CreditRefusedError,
  getCreditHold,
  HoldFinalError,
  HoldInputError,
  listCreditHolds,
  releaseCreditHold,
  serializeHold,
} from "@/modules/credits/holds";
import { MAX_HOLD_SECONDS } from "@/modules/credits/policy";
import { AccessInputError, checkAccess } from "@/modules/credits/access";
import { badRequest, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const log = createLogger("credit-hold-routes");

const scopeSchema = z.record(z.string().min(1).max(64), z.string().max(255));

const createHoldBody = z.object({
  amount_minor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Send a 3-letter ISO currency code")
    .optional(),
  meter: z.string().min(1).max(100).optional(),
  scope: scopeSchema.optional(),
  expires_in: z.number().int().min(1).max(MAX_HOLD_SECONDS).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const captureBody = z.object({
  usage_event: z.unknown().optional(),
  usage_event_id: z.string().min(1).max(255).optional(),
});

function sendHoldError(reply: FastifyReply, e: unknown) {
  if (e instanceof CreditRefusedError)
    return reply.code(402).send({
      error: { type: "credit_error", code: e.code, message: e.message, ...e.detail },
    });
  if (e instanceof HoldFinalError)
    return reply.code(409).send({
      error: { type: "conflict_error", code: "hold_final", message: e.message, status: e.status },
    });
  if (e instanceof CaptureEventError)
    return reply.code(e.error.code === "invalid_request" ? 400 : 422).send({
      error: { type: "invalid_request_error", code: e.error.code, message: e.error.message },
    });
  if (e instanceof HoldInputError)
    return e.code === "not_found" ? notFound(reply, e.message) : badRequest(reply, e.message);
  throw e;
}

function scopeFromQuery(q: Record<string, unknown>): Record<string, string> | null | string {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    const m = /^scope\[([^\]]{1,64})\]$/.exec(k);
    if (!m) continue;
    if (typeof v !== "string") return `${k} must be a single value.`;
    out[m[1]!] = v;
  }
  const n = Object.keys(out).length;
  if (n > 10) return "scope may have at most 10 keys.";
  return n ? out : null;
}

const ACCESS_KEYS = new Set(["meter", "estimate", "customer_key"]);

export async function registerCreditHoldRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/customers/:cus/credit_holds",
    {
      preHandler: [authenticate, requirePerm("credit_holds:manage"), idempotency],
      onSend: idempotencyOnSend,
      config: { requestLog: "meta" },
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus } = req.params as { cus: string };
      const parsed = parseRequest(createHoldBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      try {
        const { hold, customerPublicId } = await createCreditHold({
          organizationId: req.organization!.id,
          businessId: business.id,
          customerId: customer.id,
          amountMinor: BigInt(parsed.data.amount_minor),
          currency: parsed.data.currency,
          meterKey: parsed.data.meter ?? null,
          scope: parsed.data.scope ?? null,
          expiresInSeconds: parsed.data.expires_in,
          metadata: parsed.data.metadata ?? null,
        });
        return reply
          .code(201)
          .send(
            serializeHold(hold, { customer: customerPublicId, meter: parsed.data.meter ?? null }),
          );
      } catch (e) {
        return sendHoldError(reply, e);
      }
    },
  );

  // Capture reads usage event numbers from their source text, as ingest does.
  await app.register(async (app) => {
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
      try {
        done(null, parseJsonExact(body as string));
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    });
    app.post(
      "/v1/businesses/:biz/credit_holds/:hold/capture",
      {
        preHandler: [authenticate, requirePerm("credit_holds:manage"), idempotency],
        onSend: idempotencyOnSend,
        config: { requestLog: "meta" },
      },
      async (req, reply) => {
        const business = await resolveBusiness(req, reply);
        if (!business) return;
        const { hold } = req.params as { hold: string };
        const parsed = parseRequest(captureBody, req.body);
        if (!parsed.success) return badRequest(reply, parsed.error);
        try {
          const r = await captureCreditHold({
            organizationId: req.organization!.id,
            businessId: business.id,
            holdPublicId: hold,
            usageEvent: parsed.data.usage_event,
            usageEventKey: parsed.data.usage_event_id,
          });
          return serializeHold(r.hold, r.refs);
        } catch (e) {
          return sendHoldError(reply, e);
        }
      },
    );
  });

  app.post(
    "/v1/businesses/:biz/credit_holds/:hold/release",
    {
      preHandler: [authenticate, requirePerm("credit_holds:manage"), idempotency],
      onSend: idempotencyOnSend,
      config: { requestLog: "meta" },
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { hold } = req.params as { hold: string };
      try {
        const r = await releaseCreditHold({
          organizationId: req.organization!.id,
          businessId: business.id,
          holdPublicId: hold,
        });
        return serializeHold(r.hold, r.refs);
      } catch (e) {
        return sendHoldError(reply, e);
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/credit_holds",
    { preHandler: [authenticate, requirePerm("credits:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = (req.query ?? {}) as Record<string, string | undefined>;
      const unknown = Object.keys(q).filter(
        (k) => !["customer", "status", "limit", "starting_after"].includes(k),
      );
      if (unknown.length) return badRequest(reply, `Unknown parameter: ${unknown.join(", ")}`);
      const limit = q.limit === undefined ? 25 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return badRequest(reply, "limit must be a whole number from 1 to 100.");
      if (q.status && !["held", "captured", "released", "expired"].includes(q.status))
        return badRequest(reply, "status must be held, captured, released or expired.");
      let customerId: string | undefined;
      if (q.customer) {
        const c = await getCustomerByPublicId(req.organization!.id, business.id, q.customer);
        if (!c) return notFound(reply, `No such customer: ${q.customer}`);
        customerId = c.id;
      }
      const page = await withTenant(req.organization!.id, (tx) =>
        listCreditHolds(tx, {
          businessId: business.id,
          customerId,
          status: q.status,
          limit,
          startingAfter: q.starting_after,
        }),
      );
      return {
        object: "list",
        data: page.data,
        has_more: page.hasMore,
        next_cursor: page.hasMore ? (page.data.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/credit_holds/:hold",
    { preHandler: [authenticate, requirePerm("credits:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { hold } = req.params as { hold: string };
      const r = await withTenant(req.organization!.id, (tx) =>
        getCreditHold(tx, business.id, hold),
      );
      if (!r) return notFound(reply, `No such credit hold: ${hold}`);
      return serializeHold(r.hold, r.refs);
    },
  );

  const access = async (
    req: FastifyRequest,
    reply: FastifyReply,
    by: { cus?: string; customerKey?: string },
  ) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = (req.query ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(q).filter(
      (k) => !ACCESS_KEYS.has(k) && !/^scope\[[^\]]+\]$/.test(k),
    );
    if (unknown.length) return badRequest(reply, `Unknown parameter: ${unknown.join(", ")}`);
    const scope = scopeFromQuery(q);
    if (typeof scope === "string") return badRequest(reply, scope);
    let estimate: bigint | null = null;
    if (q.estimate !== undefined) {
      if (typeof q.estimate !== "string" || !/^\d{1,15}$/.test(q.estimate))
        return badRequest(reply, "estimate must be a whole number of minor units.");
      estimate = BigInt(q.estimate);
    }
    if (q.meter !== undefined && typeof q.meter !== "string")
      return badRequest(reply, "meter must be a single value.");
    let customerId: string | undefined;
    if (by.cus) {
      const c = await getCustomerByPublicId(req.organization!.id, business.id, by.cus);
      if (!c) return notFound(reply, `No such customer: ${by.cus}`);
      customerId = c.id;
    }
    try {
      const r = await checkAccess({
        organizationId: req.organization!.id,
        businessId: business.id,
        customerId,
        customerKey: by.customerKey,
        meterKey: (q.meter as string | undefined) ?? null,
        estimateMinor: estimate,
        scope,
      });
      return { object: "access_check", ...r };
    } catch (e) {
      if (e instanceof AccessInputError)
        return e.notFound ? notFound(reply, e.message) : badRequest(reply, e.message);
      log.error(e, { event: "access_check_failed" });
      throw e;
    }
  };

  app.get(
    "/v1/businesses/:biz/customers/:cus/access",
    { preHandler: [authenticate, requirePerm("credits:view")], config: { requestLog: "meta" } },
    async (req, reply) => access(req, reply, { cus: (req.params as { cus: string }).cus }),
  );

  app.get(
    "/v1/businesses/:biz/access",
    { preHandler: [authenticate, requirePerm("credits:view")], config: { requestLog: "meta" } },
    async (req, reply) => {
      const key = (req.query as { customer_key?: unknown }).customer_key;
      if (typeof key !== "string" || !key) return badRequest(reply, "Send customer_key.");
      return access(req, reply, { customerKey: key });
    },
  );
}
