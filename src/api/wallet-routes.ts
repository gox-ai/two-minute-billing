import type { FastifyInstance } from "fastify";
import { parseRequest } from "./strict-params";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { getCustomerByPublicId } from "@/modules/customers/service";
import { topUpWallet, walletBalance, WalletError } from "@/modules/wallet/service";
import { resolveBusiness, badRequest, requirePerm } from "./helpers";
import { isIsoCurrency } from "@/platform/currency";

const topUpBody = z.object({
  amount_minor: z.number().int().positive(),
  currency: z.string().length(3).refine(isIsoCurrency, "currency must be an ISO 4217 code"),
  type: z.enum(["paid", "granted"]).default("granted"),
});

export async function registerWalletRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/customers/:cus/wallet/topup",
    {
      preHandler: [authenticate, requirePerm("credits:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such customer: ${cusId}` },
        });
      const parsed = parseRequest(topUpBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const t = await topUpWallet({
          organizationId: req.organization!.id,
          businessId: business.id,
          customer,
          amountMinor: parsed.data.amount_minor,
          currency: parsed.data.currency,
          type: parsed.data.type,
        });
        const balance = await walletBalance(
          req.organization!.id,
          customer.id,
          parsed.data.currency,
        );
        return reply.code(201).send({
          object: "wallet_topup",
          id: t.publicId,
          credit_type: t.creditType,
          amount_minor: Number(t.amountMinor),
          currency: t.currency,
          balance_minor: Number(balance),
        });
      } catch (e) {
        if (e instanceof WalletError)
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: e.message,
              ...(e.retryAfter ? { retry_after: e.retryAfter.toISOString() } : {}),
            },
          });
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/customers/:cus/wallet",
    { preHandler: [authenticate, requirePerm("credits:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer)
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such customer: ${cusId}` },
        });
      const currency =
        (req.query as { currency?: string }).currency ?? business.defaultCurrency ?? "USD";
      const balance = await walletBalance(req.organization!.id, customer.id, currency);
      return { object: "wallet", customer: cusId, currency, balance_minor: Number(balance) };
    },
  );
}
