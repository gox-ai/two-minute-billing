import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { checkoutSessions } from "@db/schema";
import { authenticateCheckout, authenticatePortal } from "@/platform/auth";
import { withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import {
  recordBuyerClientError,
  type BuyerClientErrorScope,
} from "@/modules/ops/buyer-client-errors";
import { recordBrowserFailureOnOpenIntent } from "@/modules/payment-intents/service";
import { browserFailureCode, hasGatewaySignal } from "@/modules/payment-intents/browser-failure";
import { badRequest, refusedByRateLimit } from "./helpers";
import { parseRequest } from "./strict-params";

const log = createLogger("api.buyer-client-errors");

/** Reports per session per minute. A page that loops on an error must not fill the table. */
export const BUYER_CLIENT_ERROR_RATE_PER_SESSION = 30;

const short = (max: number) => z.string().trim().max(max).nullish();

/**
 * What the storefront reports when it shows a buyer a payment error (`reportBuyerError`).
 * Telemetry: no idempotency key, and a repeat inside a few seconds is dropped by the service.
 */
export const buyerClientErrorBody = z.object({
  text: z.string().trim().min(1).max(1000),
  step: short(64),
  page: short(200),
  gateway: short(40),
  type: short(80),
  code: short(80),
  decline_code: short(80),
  param: short(40),
  gateway_message: short(300),
  field_error: z.boolean().optional(),
  /** Our intent the page was confirming: the refusal is booked on its open attempt. */
  payment_intent: z
    .string()
    .regex(/^pi_[A-Za-z0-9]+$/)
    .max(64)
    .nullish(),
});

type Body = z.output<typeof buyerClientErrorBody>;
type Owner = { customerId: string | null; intentPublicIds?: readonly (string | null)[] };

/**
 * Book a gateway's refusal on the intent's open attempt, for the operator. Only the session's
 * own intent, only operator text, never over a reason already written: see
 * `recordBrowserFailureOnOpenIntent`.
 */
async function bookOnIntent(scope: BuyerClientErrorScope, body: Body, owner: () => Promise<Owner>) {
  if (!body.payment_intent || !body.gateway || !hasGatewaySignal(body)) return;
  const gateway = body.gateway;
  const outcome = await recordBrowserFailureOnOpenIntent({
    organizationId: scope.organizationId,
    businessId: scope.businessId,
    intentPublicId: body.payment_intent,
    owner: await owner(),
    gatewayKey: gateway,
    failureCode: (purpose) =>
      browserFailureCode(gateway, { ...body, message: body.gateway_message ?? null }, purpose),
    gatewayMessage: body.gateway_message ?? null,
    gatewayError: {
      type: body.type ?? null,
      code: body.code ?? null,
      decline_code: body.decline_code ?? null,
      param: body.param ?? null,
      message: body.gateway_message ?? null,
    },
    actor: scope.sessionPublicId,
  });
  if (outcome !== "booked")
    log.info("browser-reported refusal not booked", {
      event: "browser_failure_not_booked",
      outcome,
      surface: scope.surface,
      gateway,
    });
}

async function record(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: BuyerClientErrorScope,
  owner: () => Promise<Owner>,
) {
  if (
    await refusedByRateLimit(req, reply, {
      scope: "buyer_client_error",
      keys: [
        {
          kind: "resource",
          value: scope.sessionPublicId,
          limit: BUYER_CLIENT_ERROR_RATE_PER_SESSION,
        },
      ],
    })
  )
    return;
  const parsed = parseRequest(buyerClientErrorBody, req.body);
  if (!parsed.success) return badRequest(reply, parsed.error);
  const r = await recordBuyerClientError(scope, parsed.data);
  if (r.recorded && r.leak)
    log.warn("a buyer read text that is not our wording", {
      event: "buyer_error_leak",
      surface: scope.surface,
      gateway: parsed.data.gateway ?? null,
      code: parsed.data.decline_code ?? parsed.data.code ?? null,
    });
  if (r.recorded) await bookOnIntent(scope, parsed.data, owner);
  return reply.code(204).send();
}

export async function registerBuyerClientErrorRoutes(app: FastifyInstance) {
  app.post("/checkout/v1/client_errors", { preHandler: authenticateCheckout }, (req, reply) => {
    const ctx = req.checkoutSession!;
    return record(
      req,
      reply,
      {
        surface: "checkout",
        sessionPublicId: ctx.sessionPublicId,
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerId: ctx.resultingCustomerId ?? null,
      },
      // The intents this session began, or its customer once it has one.
      async () => {
        const [s] = await withTenant(ctx.organizationId, (tx) =>
          tx
            .select({
              setup: checkoutSessions.setupPaymentIntent,
              charge: checkoutSessions.chargePaymentIntent,
            })
            .from(checkoutSessions)
            .where(eq(checkoutSessions.id, ctx.sessionId))
            .limit(1),
        );
        return {
          customerId: ctx.resultingCustomerId ?? null,
          intentPublicIds: [s?.setup ?? null, s?.charge ?? null],
        };
      },
    );
  });
  app.post("/portal/v1/client_errors", { preHandler: authenticatePortal }, (req, reply) => {
    const ctx = req.portalSession!;
    return record(
      req,
      reply,
      {
        surface: "portal",
        sessionPublicId: ctx.sessionPublicId,
        organizationId: ctx.organizationId,
        businessId: ctx.businessId,
        customerId: ctx.customerId,
      },
      async () => ({ customerId: ctx.customerId }),
    );
  });
}
