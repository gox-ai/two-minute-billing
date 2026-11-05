import { ProviderRefusalError } from "@/providers/types";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LIMITS, httpUrl, redirectUrl } from "./limits";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { getCustomerByPublicId } from "@/modules/customers/service";
import {
  vaultPaymentMethod,
  PaymentMethodConfigError,
  PaymentMethodVaultError,
  listPaymentMethods,
  setDefaultPaymentMethod,
  assignPaymentMethodRole,
  PrimaryDemotionError,
  detachPaymentMethod,
  VaultSetupUnsupportedError,
  attachVaultedPaymentMethod,
  deletePaymentMethodLocally,
  PaymentMethodInUseError,
} from "@/modules/payment-methods/service";
import { GatewayRouterError } from "@/modules/gateway/router";
import { beginVaultSetup, serializeVaultSetup } from "./vault-setup";
import {
  serializePaymentMethods,
  serializePaymentMethodWithGateway,
} from "@/modules/payment-methods/serialize";
import { collectOutstandingForNewPaymentMethod } from "@/modules/invoicing/service";
import { resolveBusiness, badRequest, conflict, notFound, requirePerm } from "./helpers";
import { createLogger } from "@/platform/logger";
import { parseRequest } from "./strict-params";
import { REAL_GATEWAY_KEYS } from "@/providers/gateway-catalog";

const log = createLogger("payment-methods");

const vaultBody = z.object({
  token: z.string().max(LIMITS.id).min(1), // provider token from hosted fields / SDK
  provider: z.enum(REAL_GATEWAY_KEYS).optional(),
  gateway_account: z.string().max(LIMITS.id).optional(), // route the vault through this gateway account (C10)
  /** Collect open invoices now and when its mandate confirms. Omitted = the business rule. */
  collect_open_invoices: z.boolean().optional(),
});

const setupBody = z.object({
  provider: z.enum(REAL_GATEWAY_KEYS),
  return_url: redirectUrl(),
  cancel_url: redirectUrl(),
});

export async function registerPaymentMethodRoutes(app: FastifyInstance) {
  app.post(
    "/v1/businesses/:biz/customers/:cus/payment_methods",
    {
      preHandler: [authenticate, requirePerm("payment_methods:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) {
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such customer: ${cusId}` },
        });
      }
      const parsed = parseRequest(vaultBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        const pm = await vaultPaymentMethod({
          organizationId: req.organization!.id,
          businessId: business.id,
          customer,
          token: parsed.data.token,
          provider: parsed.data.provider,
          gatewayAccountId: parsed.data.gateway_account,
          collectOpenInvoices: parsed.data.collect_open_invoices,
        });
        // Billing LogIQ — collect the customer's open payment_due invoices against
        // the freshly vaulted card. Best-effort: never fail the vault if a recovery
        // charge errors.
        let collected: Array<{ invoice: string; status: string }> = [];
        try {
          const res = await collectOutstandingForNewPaymentMethod({
            organizationId: req.organization!.id,
            businessId: business.id,
            customerId: customer.id,
            paymentMethodPublicId: pm.publicId,
            collectOpenInvoices: parsed.data.collect_open_invoices,
          });
          collected = res.collected;
        } catch (collectErr) {
          log.error(collectErr, {
            event: "collect_on_pm_update_failed",
            paymentMethod: pm.publicId,
          });
        }
        const view = await serializePaymentMethodWithGateway(req.organization!.id, pm);
        return reply
          .code(201)
          .send(collected.length ? { ...view, collected_invoices: collected } : view);
      } catch (e) {
        // Gateway refused the token (unapproved/expired/spent) — a 400 with the
        // reason, not a 500; the provider's own text goes to the log.
        if (e instanceof PaymentMethodVaultError) {
          log.warn("vault rejected by gateway", {
            event: "pm_vault_rejected",
            detail: e.detail,
          });
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        if (e instanceof PaymentMethodConfigError) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  // Begin a buyer-approval vault flow (off-session mandate) — PayPal/RazorPay.
  // Returns an approval_url the buyer visits; the approved setup token is then
  // completed via POST .../payment_methods { token, provider }.
  app.post(
    "/v1/businesses/:biz/customers/:cus/payment_methods/setup",
    {
      preHandler: [authenticate, requirePerm("payment_methods:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) {
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such customer: ${cusId}` },
        });
      }
      const parsed = parseRequest(setupBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        // Recorded as a zero-amount `setup` payment intent when the business has a
        // gateway account of the requested provider that the router independently
        // resolves to; otherwise the legacy env-configured provider call, unchanged
        // (see src/api/vault-setup.ts). Same response fields either way.
        const outcome = await beginVaultSetup({
          organizationId: req.organization!.id,
          businessId: business.id,
          customer,
          legacyProviderKey: parsed.data.provider,
          returnUrl: parsed.data.return_url,
          cancelUrl: parsed.data.cancel_url,
        });
        return reply.code(201).send(serializeVaultSetup(outcome));
      } catch (e) {
        // A CONFIG refusal is the caller's to fix, not a server fault: no phone on the
        // customer, a method type the gateway cannot set up, a live async-settlement
        // account with no webhook endpoint (`assertVaultPreconditions`). Only
        // `VaultSetupUnsupportedError` was mapped here, so every one of those surfaced
        // as a 500 with the actionable message buried in the log. The portal and
        // checkout routes have always mapped them to a 400 — same shape, same 400 here.
        if (
          e instanceof VaultSetupUnsupportedError ||
          e instanceof PaymentMethodConfigError ||
          // A ROUTING refusal by name (`gateway_account` that cannot handle this
          // currency/method) reaches this route now that `beginVaultSetup` rethrows it
          // rather than falling back — the buyer routes already answer 400.
          e instanceof GatewayRouterError ||
          // The gateway refused the setup request (e.g. a field it rejects).
          e instanceof ProviderRefusalError
        ) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/customers/:cus/payment_methods",
    { preHandler: [authenticate, requirePerm("payment_methods:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) {
        return reply.code(404).send({
          error: { type: "invalid_request_error", message: `No such customer: ${cusId}` },
        });
      }
      const rows = await listPaymentMethods(req.organization!.id, customer.id);
      // Optional narrowing + paging; with none of these params the reply is the full list,
      // unchanged. Other query keys stay ignored, as they always were.
      const q = req.query as Record<string, string | undefined>;
      const types = q.type ? q.type.split(",").map((s) => s.trim()) : null;
      const statuses = q.status ? q.status.split(",").map((s) => s.trim()) : null;
      const filtered = rows.filter(
        (r) => (!types || types.includes(r.type)) && (!statuses || statuses.includes(r.status)),
      );
      if (q.limit == null && q.starting_after == null) {
        return {
          object: "list",
          data: await serializePaymentMethods(req.organization!.id, filtered),
        };
      }
      const limit = q.limit != null ? Number(q.limit) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return badRequest(reply, "limit must be an integer from 1 to 100");
      let start = 0;
      if (q.starting_after) {
        const i = filtered.findIndex((r) => r.publicId === q.starting_after);
        if (i < 0)
          return badRequest(reply, `starting_after: no such payment method ${q.starting_after}`);
        start = i + 1;
      }
      const page = filtered.slice(start, start + limit);
      const hasMore = start + limit < filtered.length;
      return {
        object: "list",
        data: await serializePaymentMethods(req.organization!.id, page),
        has_more: hasMore,
        next_cursor: hasMore ? page[page.length - 1]!.publicId : null,
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/customers/:cus/payment_methods/:pm",
    { preHandler: [authenticate, requirePerm("payment_methods:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, pm } = req.params as { cus: string; pm: string };
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const row = (await listPaymentMethods(req.organization!.id, customer.id)).find(
        (r) => r.publicId === pm,
      );
      if (!row) return notFound(reply, `No such payment method: ${pm}`);
      return serializePaymentMethodWithGateway(req.organization!.id, row);
    },
  );

  // Attach an instrument already vaulted at the gateway (no re-vault, no charge).
  const permanentTokenBody = z.object({
    // `<gateway customer id>/<gateway token id>` — the `reference_id` we return — or the token alone.
    reference_id: z.string().max(LIMITS.id).min(1).optional(),
    payment_method_token: z.string().max(LIMITS.id).min(1).optional(),
    gateway_customer_id: z.string().max(LIMITS.id).min(1).optional(),
    gateway_account: z.string().max(LIMITS.id).optional(),
    type: z.string().max(50).optional(),
    replace_primary_payment_source: z.boolean().optional(),
  });
  app.post(
    "/v1/businesses/:biz/customers/:cus/payment_methods/permanent_token",
    {
      preHandler: [authenticate, requirePerm("payment_methods:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const cusId = (req.params as { cus: string }).cus;
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cusId);
      if (!customer) return notFound(reply, `No such customer: ${cusId}`);
      const parsed = parseRequest(permanentTokenBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const d = parsed.data;
      if (!!d.reference_id === !!d.payment_method_token)
        return badRequest(reply, "Pass exactly one of reference_id or payment_method_token");
      let token = d.payment_method_token;
      let gatewayCustomer = d.gateway_customer_id;
      if (d.reference_id) {
        const slash = d.reference_id.indexOf("/");
        const refCustomer = slash > 0 ? d.reference_id.slice(0, slash) : undefined;
        token = slash > 0 ? d.reference_id.slice(slash + 1) : d.reference_id;
        if (refCustomer && gatewayCustomer && refCustomer !== gatewayCustomer)
          return badRequest(reply, "reference_id and gateway_customer_id name different customers");
        gatewayCustomer = refCustomer ?? gatewayCustomer;
        if (!token) return badRequest(reply, "reference_id has no gateway token");
      }
      try {
        let pm = await attachVaultedPaymentMethod({
          organizationId: req.organization!.id,
          businessId: business.id,
          customer,
          providerPaymentMethodId: token!,
          providerCustomerId: gatewayCustomer,
          gatewayAccountId: d.gateway_account,
          type: d.type,
        });
        if (d.replace_primary_payment_source && pm.role !== "primary") {
          pm =
            (await assignPaymentMethodRole(
              req.organization!.id,
              customer.id,
              pm.publicId,
              "primary",
            )) ?? pm;
        }
        return reply
          .code(201)
          .send(await serializePaymentMethodWithGateway(req.organization!.id, pm));
      } catch (e) {
        if (e instanceof PaymentMethodVaultError) {
          log.warn("permanent token read failed at the gateway", {
            event: "pm_permanent_token_rejected",
            detail: e.detail,
          });
          return badRequest(reply, e.message);
        }
        if (e instanceof PaymentMethodConfigError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  // Remove our record only; the gateway keeps the instrument.
  app.post(
    "/v1/businesses/:biz/customers/:cus/payment_methods/:pm/delete_local",
    {
      preHandler: [authenticate, requirePerm("payment_methods:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, pm } = req.params as { cus: string; pm: string };
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      try {
        const ok = await deletePaymentMethodLocally(req.organization!.id, customer.id, pm);
        if (!ok) return notFound(reply, `No such payment method: ${pm}`);
      } catch (e) {
        if (e instanceof PaymentMethodInUseError) return conflict(reply, e.message);
        throw e;
      }
      return { object: "payment_method", id: pm, deleted: true, deleted_locally: true };
    },
  );

  // Set the customer's default payment method (collection prefers it).
  app.post(
    "/v1/businesses/:biz/customers/:cus/payment_methods/:pm/default",
    {
      preHandler: [authenticate, requirePerm("payment_methods:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, pm } = req.params as { cus: string; pm: string };
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const updated = await setDefaultPaymentMethod(req.organization!.id, customer.id, pm);
      if (!updated) return notFound(reply, `No such payment method: ${pm}`);
      return serializePaymentMethodWithGateway(req.organization!.id, updated);
    },
  );

  // Assign a collection role (primary | backup | none) to a payment method (C6).
  app.post(
    "/v1/businesses/:biz/customers/:cus/payment_methods/:pm/assign_role",
    {
      preHandler: [authenticate, requirePerm("payment_methods:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, pm } = req.params as { cus: string; pm: string };
      const parsed = parseRequest(
        z.object({ role: z.enum(["primary", "backup", "none"]) }),
        req.body,
      );
      if (!parsed.success) return badRequest(reply, parsed.error);
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      let updated;
      try {
        updated = await assignPaymentMethodRole(
          req.organization!.id,
          customer.id,
          pm,
          parsed.data.role,
        );
      } catch (e) {
        if (e instanceof PrimaryDemotionError) return conflict(reply, e.message);
        throw e;
      }
      if (!updated) return notFound(reply, `No such payment method: ${pm}`);
      return serializePaymentMethodWithGateway(req.organization!.id, updated);
    },
  );

  // Detach (delete) a payment method. Payment/subscription links are set null.
  app.delete(
    "/v1/businesses/:biz/customers/:cus/payment_methods/:pm",
    {
      preHandler: [authenticate, requirePerm("payment_methods:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { cus, pm } = req.params as { cus: string; pm: string };
      const customer = await getCustomerByPublicId(req.organization!.id, business.id, cus);
      if (!customer) return notFound(reply, `No such customer: ${cus}`);
      const ok = await detachPaymentMethod(req.organization!.id, customer.id, pm);
      if (!ok) return notFound(reply, `No such payment method: ${pm}`);
      return { object: "payment_method", id: pm, deleted: true };
    },
  );
}
