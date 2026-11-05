import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { refundPayment, RefundError } from "@/modules/refunds/service";
import { refundExcessPayment, excessHeldByPayment } from "@/modules/refunds/excess";
import { cancelPendingDebit, cancelRefusedMessage } from "@/modules/payments/pending-debit";
import { withTenant } from "@/platform/db";
import { payments } from "@db/schema";
import { and, eq } from "drizzle-orm";
import {
  resolveBusiness,
  badRequest,
  badGateway,
  conflict,
  notFound,
  requirePerm,
} from "./helpers";
import { ProviderIndeterminateError } from "@/providers/types";
import { parseRequest } from "./strict-params";
import { missingReason } from "@/modules/subscriptions/billing-rules-config";
import { DECLINED_REFUND_OUTCOMES } from "@/modules/subscriptions/collection-rules-config";

const refundBody = z.object({
  amount_minor: z.number().int().positive().optional(), // omit = full remaining
  reason: z.string().max(500).optional(),
  /** A gateway decline of this refund: `block` or `issue_credit`. Omitted = the business rule. */
  on_decline: z.enum(DECLINED_REFUND_OUTCOMES).optional(),
});

export async function registerRefundRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/payments/:pay/refund",
    {
      preHandler: [authenticate, requirePerm("payments:refund"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(refundBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const noReason = missingReason(business, "refund", parsed.data.reason);
      if (noReason) return badRequest(reply, noReason);
      const payPid = (req.params as { pay: string }).pay;
      try {
        /**
         * A payment attached to no invoice is held as the customer's excess credit, never as
         * revenue — so it cannot be refunded as a revenue refund. It goes through the excess
         * path, which draws the credit under the customer lock and books no contra-revenue.
         * One that is neither attached nor held as excess has no booking we could reverse.
         */
        const route = await withTenant(req.organization!.id, async (tx) => {
          const [pay] = await tx
            .select({ invoiceId: payments.invoiceId })
            .from(payments)
            .where(and(eq(payments.businessId, business.id), eq(payments.publicId, payPid)))
            .limit(1);
          if (!pay || pay.invoiceId) return "revenue" as const;
          return (await excessHeldByPayment(tx, payPid)) > 0n
            ? ("excess" as const)
            : ("none" as const);
        });
        if (route === "none") {
          return reply.code(400).send({
            error: {
              type: "invalid_request_error",
              message: `Payment ${payPid} is on no invoice and holds no customer credit, so it has no booking to refund against`,
            },
          });
        }
        const refund =
          route === "excess"
            ? await refundExcessPayment({
                organizationId: req.organization!.id,
                businessId: business.id,
                paymentPublicId: payPid,
                amountMinor: parsed.data.amount_minor,
                reason: parsed.data.reason,
              })
            : await refundPayment({
                organizationId: req.organization!.id,
                businessId: business.id,
                paymentPublicId: payPid,
                amountMinor: parsed.data.amount_minor,
                reason: parsed.data.reason,
                // Held credit always returns to the credit on a decline, so only here.
                ...(parsed.data.on_decline ? { onDecline: parsed.data.on_decline } : {}),
              });
        return reply.code(201).send({
          object: "refund",
          id: refund.publicId,
          payment: (req.params as { pay: string }).pay,
          status: refund.status,
          amount_minor: Number(refund.amountMinor),
          currency: refund.currency,
          reason: refund.reason,
          created_at: refund.createdAt,
        });
      } catch (e) {
        if (e instanceof ProviderIndeterminateError) {
          return badGateway(
            reply,
            "We could not confirm the result of this refund with the payment provider. " +
              "Do not create a new refund. Check the payment in a few minutes.",
          );
        }
        if (e instanceof RefundError) {
          /**
           * A payment that is not in this business is a 404, like every other
           * per-business route; everything else the service refuses ("Refund amount
           * must be positive", "exceeds the remaining refundable amount", a provider
           * decline) is a genuine bad request and stays a 400.
           *
           * Discriminated on `RefundError.code`, not on the message text — the message
           * is what the caller reads, `code` is what the route branches on. Pinned by
           * `scripts/verify-bola.ts`, which asserts this route answers 404 for a
           * foreign payment id AND that no new 400 appears on its siblings.
           */
          if (e.code === "not_found") return notFound(reply, e.message);
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  /**
   * Stop a debit the gateway has not collected yet (GoCardless before submission, a Mollie
   * SEPA debit while cancelable, a Cashfree subscription payment, a Stripe bank debit while
   * processing). The gateway's own answer decides: `cancelled` books the payment failed with
   * no money moved and stops automatic collection on its invoice; a debit the gateway already
   * settled is booked as such. A refusal is a 409 and books nothing.
   */
  app.post(
    "/v1/businesses/:biz/payments/:pay/cancel_pending_debit",
    {
      preHandler: [authenticate, requirePerm("payments:refund"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(z.object({}), req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const payPid = (req.params as { pay: string }).pay;
      const orgId = req.organization!.id;
      const pay = await withTenant(orgId, async (tx) => {
        const [row] = await tx
          .select()
          .from(payments)
          .where(and(eq(payments.businessId, business.id), eq(payments.publicId, payPid)))
          .limit(1);
        return row ?? null;
      });
      if (!pay) return notFound(reply, `We could not find the payment ${payPid}.`);
      const res = await cancelPendingDebit({
        organizationId: orgId,
        businessId: business.id,
        paymentId: pay.id,
        purpose: "operator",
      });
      if (res.outcome === "not_pending")
        return conflict(
          reply,
          `We could not cancel this debit. Payment ${payPid} is not in progress.`,
        );
      if (res.outcome === "not_cancelable" || res.outcome === "unsupported")
        return reply.code(409).send({
          error: {
            type: "conflict_error",
            code: "debit_not_cancelable",
            message: cancelRefusedMessage(pay, res.outcome),
          },
        });
      const after = await withTenant(orgId, async (tx) => {
        const [row] = await tx.select().from(payments).where(eq(payments.id, pay.id)).limit(1);
        return row!;
      });
      return {
        object: "payment",
        id: after.publicId,
        status: after.status,
        // `cancelled`, or what the gateway had already done: `settled` / `failed`.
        outcome: res.outcome === "failed_at_gateway" ? "failed" : res.outcome,
        amount_minor: Number(after.amountMinor),
        currency: after.currency,
        method_type: after.methodType,
        failure_code: after.failureCode,
      };
    },
  );
}
