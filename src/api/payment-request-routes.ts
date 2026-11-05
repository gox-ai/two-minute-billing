import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import {
  badRequest,
  conflict,
  listResponse,
  notFound,
  parseListQuery,
  requirePerm,
  resolveBusiness,
} from "./helpers";
import { parseRequest } from "./strict-params";
import {
  cancelPaymentRequest,
  chargePaymentRequest,
  createPaymentRequest,
  getPaymentRequest,
  listPaymentRequestsPage,
  PaymentRequestError,
  recordPaymentRequestPayment,
  sendPaymentRequestEmail,
  serializePaymentRequest,
} from "@/modules/payment-requests/service";
import { CollectionInFlightError } from "@/modules/invoicing/service";
import { AdhocEmailError } from "@/modules/emails/adhoc-service";
import { createLogger } from "@/platform/logger";

const log = createLogger("payment-requests");

const createBody = z.object({
  invoices: z.array(z.string().min(1).max(64)).min(1).max(50),
  mode: z.enum(["charge", "link"]),
  payment_method: z.string().min(1).max(64).optional(),
  email: z.string().email().max(320).optional(),
});
const chargeBody = z.object({ payment_method: z.string().min(1).max(64).optional() });
const recordBody = z.object({
  amount_minor: z.number().int().positive(),
  method: z.enum(["cash", "cheque", "bank_transfer", "other"]).optional(),
  reference: z.string().max(200).optional(),
  // Unix seconds; the payment date. Defaults to now.
  date: z.number().int().positive().optional(),
});
const cancelBody = z.object({ reason: z.string().max(200).optional() });
const sendBody = z.object({
  to: z.string().email().max(320).optional(),
  note: z.string().max(2000).optional(),
});

function mapError(reply: FastifyReply, e: unknown) {
  if (e instanceof PaymentRequestError) {
    if (e.code === "not_found") return notFound(reply, e.message);
    if (e.code === "conflict") return conflict(reply, e.message);
    return badRequest(reply, e.message);
  }
  if (e instanceof CollectionInFlightError)
    return conflict(
      reply,
      `We could not charge the payment request. A payment on invoice ${e.invoicePublicId} is in progress. Try again when it completes.`,
    );
  if (e instanceof AdhocEmailError) return badRequest(reply, e.message);
  throw e;
}

/**
 * Payment requests (0388). Writes need `ops`, the same as Collect payment on a customer;
 * reads need a key.
 */
export async function registerPaymentRequestRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/customers/:cus/payment_requests",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { cus } = req.params as { cus: string };
      const orgId = req.organization!.id;
      try {
        let view = await createPaymentRequest({
          organizationId: orgId,
          businessId: business.id,
          customerPublicId: cus,
          invoicePublicIds: parsed.data.invoices,
          mode: parsed.data.mode,
          paymentMethodPublicId: parsed.data.payment_method,
          email: parsed.data.email,
          createdBy: req.operatorUserId ?? "api_key",
        });
        const pid = view.request.publicId;
        if (parsed.data.mode === "charge") {
          try {
            view = await chargePaymentRequest({
              organizationId: orgId,
              businessId: business.id,
              paymentRequestPublicId: pid,
              initiator: "merchant",
            });
          } catch (e) {
            // A decline leaves the request open with its error and mails the link.
            if (!(e instanceof PaymentRequestError) && !(e instanceof CollectionInFlightError))
              throw e;
            view = (await getPaymentRequest(orgId, business.id, pid)) ?? view;
          }
        } else {
          await sendPaymentRequestEmail({
            organizationId: orgId,
            businessId: business.id,
            paymentRequestPublicId: pid,
          }).catch((e) =>
            log.warn("payment request email not sent at create", {
              request: pid,
              error: (e as Error)?.message,
            }),
          );
        }
        return reply.code(201).send(serializePaymentRequest(view));
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/payment_requests",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseListQuery(req, reply, {
        filterOps: {},
        sortFields: ["created_at"],
        bareParams: ["customer", "status"],
        includeDeleted: "none",
      });
      if (!q) return;
      const bare = req.query as Record<string, string | undefined>;
      const page = await listPaymentRequestsPage(req.organization!.id, business.id, {
        customerPublicId: bare.customer,
        status: bare.status,
        startingAfter: q.startingAfter,
        limit: q.limit,
      });
      return listResponse(page, serializePaymentRequest);
    },
  );

  app.get(
    "/v1/businesses/:biz/payment_requests/:preq",
    { preHandler: [authenticate, requirePerm("payments:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { preq } = req.params as { preq: string };
      const view = await getPaymentRequest(req.organization!.id, business.id, preq);
      if (!view) return notFound(reply, `No such payment request: ${preq}`);
      return serializePaymentRequest(view);
    },
  );

  app.post(
    "/v1/businesses/:biz/payment_requests/:preq/charge",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(chargeBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { preq } = req.params as { preq: string };
      try {
        const view = await chargePaymentRequest({
          organizationId: req.organization!.id,
          businessId: business.id,
          paymentRequestPublicId: preq,
          paymentMethodPublicId: parsed.data.payment_method,
          initiator: "merchant",
        });
        return serializePaymentRequest(view);
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/payment_requests/:preq/record_payment",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(recordBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { preq } = req.params as { preq: string };
      try {
        const view = await recordPaymentRequestPayment({
          organizationId: req.organization!.id,
          businessId: business.id,
          paymentRequestPublicId: preq,
          amountMinor: parsed.data.amount_minor,
          method: parsed.data.method,
          reference: parsed.data.reference,
          occurredAt: parsed.data.date ? new Date(parsed.data.date * 1000) : undefined,
        });
        return serializePaymentRequest(view);
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/payment_requests/:preq/cancel",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(cancelBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { preq } = req.params as { preq: string };
      try {
        const view = await cancelPaymentRequest({
          organizationId: req.organization!.id,
          businessId: business.id,
          paymentRequestPublicId: preq,
          reason: parsed.data.reason,
        });
        return serializePaymentRequest(view);
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );

  app.post(
    "/v1/businesses/:biz/payment_requests/:preq/send",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(sendBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { preq } = req.params as { preq: string };
      try {
        const res = await sendPaymentRequestEmail({
          organizationId: req.organization!.id,
          businessId: business.id,
          paymentRequestPublicId: preq,
          to: parsed.data.to,
          note: parsed.data.note,
        });
        return { object: "payment_request_email", ...res };
      } catch (e) {
        return mapError(reply, e);
      }
    },
  );
}
