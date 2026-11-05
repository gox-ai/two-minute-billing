import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend, idempotentNoStore } from "@/platform/idempotency";
import {
  resolveBusiness,
  badRequest,
  notFound,
  conflict,
  parseListQuery,
  listResponse,
  requirePerm,
  callerHolds,
  missingPermission,
} from "./helpers";
import { permissionDef } from "@/modules/auth/permissions";
import {
  assertGatewayOffered,
  createGatewayAccount,
  listGatewayAccounts,
  getGatewayAccount,
  updateGatewayAccount,
  deleteGatewayAccount,
  verifyGatewayAccount,
  getGatewayAccountBalance,
  setDefaultGatewayAccount,
  serializeGatewayAccount,
  listGatewayCatalog,
  SUPPORTED_GATEWAY_KEYS,
  GatewayError,
  GatewayAccountInUseError,
  type GatewayAccount,
} from "@/modules/gateway/service";
import { writeAuditLog } from "@/modules/audit/service";
import { resolveAdapter } from "@/providers/registry";
import { config } from "@/platform/config";
import {
  getWebhookEndpointInfo,
  provisionWebhookEndpoint,
  saveOperatorWebhookSecret,
  registerWebhookEndpointOnCreate,
  removeWebhookEndpointOnDelete,
} from "@/modules/gateway/webhook-endpoint";
import {
  getGatewayWebhook,
  replayGatewayWebhook,
  serializeGatewayWebhook,
  listGatewayWebhooksPage,
  GATEWAY_WEBHOOK_FILTER_OPS,
  GATEWAY_WEBHOOK_SORT_FIELDS,
} from "@/modules/gateway/inbound";
import {
  getGatewayRequestLog,
  serializeGatewayRequestLog,
  listGatewayRequestLogsPage,
  GATEWAY_REQUEST_FILTER_OPS,
  GATEWAY_REQUEST_SORT_FIELDS,
} from "@/modules/gateway/activity";
import { parseRequest } from "./strict-params";
import { LIMITS } from "./limits";

// Write-only: encrypted at rest, never echoed. Keys are the provider's own
// field names (e.g. `secret_key`, `webhook_secret`) — bounded, not arbitrary
// blobs — and values must be non-empty strings (every credential the
// dashboard collects is a pasted token/secret, never a nested structure).
const credentialsSchema = z.record(z.string().min(1).max(100), z.string().min(1).max(10000));

const createBody = z.object({
  gateway_key: z.enum(SUPPORTED_GATEWAY_KEYS),
  label: z.string().min(1).max(200),
  credentials: credentialsSchema.default({}),
  currencies: z.array(z.string().length(3)).min(1).nullable().optional(),
  method_types: z.array(z.string().min(1)).min(1).nullable().optional(),
  international_enabled: z.boolean().optional(),
});

const updateBody = z.object({
  label: z.string().min(1).max(200).optional(),
  credentials: credentialsSchema.optional(),
  currencies: z.array(z.string().length(3)).min(1).nullable().optional(),
  method_types: z.array(z.string().min(1)).min(1).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  default: z.boolean().optional(),
  international_enabled: z.boolean().optional(),
});

/**
 * A bare hostname — no scheme, no path, no port. That is the shape Stripe registers, and
 * accepting `https://…` here would register a domain that never matches the storefront
 * and leave the operator staring at an inactive wallet with no reason given.
 */
const walletDomainBody = z.object({
  /**
   * OPTIONAL, and omitting it is the normal case: the domain that matters is the
   * STOREFRONT's, which this deployment already names in `PORTAL_BASE_URL` — a separate
   * host from the dashboard in production (`portal.…` vs `app.…`). Only the engine knows
   * it, so asking the operator to type it invites registering the wrong one, and it is
   * the dashboard's own hostname that would be wrong most plausibly of all.
   */
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(
      /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i,
      "Pass a bare hostname such as billing.example.com. Do not include a scheme, port or path",
    )
    .optional(),
});

/**
 * The storefront host wallets must be registered for. Bare hostname — Stripe registers a
 * domain, not an origin, so the scheme and port are dropped.
 */
function configuredStorefrontDomain(): string | null {
  const raw = config.PORTAL_BASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw).hostname || null;
  } catch {
    return null;
  }
}

/** What a `gateway_account.*` audit row may record. Never a credential value. */
function gatewayAuditView(row: GatewayAccount): Record<string, unknown> {
  return {
    gateway_key: row.gatewayKey,
    label: row.label,
    livemode: row.livemode,
    currencies: row.currencies ?? null,
    method_types: row.methodTypes ?? null,
    international_enabled: row.internationalEnabled,
    status: row.status,
  };
}

/**
 * Written here, after the service call, because the gateway service is shared with
 * the billing clock. Credentials are recorded by field NAME only.
 */
function auditGatewayAccount(
  req: FastifyRequest,
  businessId: string,
  gwaPublicId: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  return writeAuditLog({
    organizationId: req.organization!.id,
    businessId,
    action,
    resourceType: "gateway_account",
    resourceId: gwaPublicId,
    before,
    after,
  });
}

export async function registerGatewayRoutes(app: FastifyInstance) {
  app.get(
    "/v1/gateways",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async () => ({
      object: "list",
      data: listGatewayCatalog(),
    }),
  );

  app.post(
    "/v1/businesses/:biz/gateway_accounts",
    {
      preHandler: [authenticate, requirePerm("gateways:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(createBody, req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      try {
        // New accounts only. Existing accounts of a gateway that is not offered keep booking
        // webhooks, refunds and renewals: money already moves through them.
        assertGatewayOffered(parsed.data.gateway_key);
        const row = await createGatewayAccount({
          organizationId: req.organization!.id,
          businessId: business.id,
          gatewayKey: parsed.data.gateway_key,
          label: parsed.data.label,
          credentials: parsed.data.credentials,
          currencies: parsed.data.currencies ?? null,
          methodTypes: parsed.data.method_types ?? null,
          ...(parsed.data.international_enabled !== undefined
            ? { internationalEnabled: parsed.data.international_enabled }
            : {}),
        });
        await registerWebhookEndpointOnCreate({
          organizationId: req.organization!.id,
          businessId: business.id,
          gatewayAccountPublicId: row.publicId,
          gatewayKey: row.gatewayKey,
        });
        // Re-read: registration may have added webhook material to the credentials.
        const fresh =
          (await getGatewayAccount(req.organization!.id, business.id, row.publicId)) ?? row;
        await auditGatewayAccount(req, business.id, row.publicId, "gateway_account.create", null, {
          ...gatewayAuditView(fresh),
          credential_fields: Object.keys(parsed.data.credentials).sort(),
        });
        return reply.code(201).send(serializeGatewayAccount(fresh));
      } catch (e) {
        if (e instanceof GatewayError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.get(
    "/v1/businesses/:biz/gateway_accounts",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const includeDisabled =
        (req.query as { include_disabled?: string })?.include_disabled === "true";
      const rows = await listGatewayAccounts(req.organization!.id, business.id, {
        includeDisabled,
      });
      return {
        object: "list",
        data: rows.map((r) => ({
          ...serializeGatewayAccount(r),
          default: r.id === business.defaultGatewayAccountId,
        })),
      };
    },
  );

  app.get(
    "/v1/businesses/:biz/gateway_accounts/:gwa",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const row = await getGatewayAccount(req.organization!.id, business.id, gwa);
      if (!row) return notFound(reply, "Gateway account not found");
      return {
        ...serializeGatewayAccount(row),
        default: row.id === business.defaultGatewayAccountId,
      };
    },
  );

  app.patch(
    "/v1/businesses/:biz/gateway_accounts/:gwa",
    {
      preHandler: [authenticate, requirePerm("gateways:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const parsed = parseRequest(updateBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const prior = await getGatewayAccount(req.organization!.id, business.id, gwa);
      try {
        const row = await updateGatewayAccount({
          organizationId: req.organization!.id,
          businessId: business.id,
          gwaPublicId: gwa,
          label: parsed.data.label,
          credentials: parsed.data.credentials,
          currencies: parsed.data.currencies,
          methodTypes: parsed.data.method_types,
          status: parsed.data.status,
          internationalEnabled: parsed.data.international_enabled,
        });
        if (!row) return notFound(reply, "Gateway account not found");
        if (parsed.data.default === true)
          await setDefaultGatewayAccount(req.organization!.id, business.id, gwa);
        if (prior) {
          const was = gatewayAuditView(prior);
          const now = gatewayAuditView(row);
          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          for (const k of Object.keys(now)) {
            if (JSON.stringify(was[k]) === JSON.stringify(now[k])) continue;
            before[k] = was[k];
            after[k] = now[k];
          }
          const credentialFields = Object.keys(parsed.data.credentials ?? {}).sort();
          if (credentialFields.length) after.credential_fields = credentialFields;
          if (parsed.data.default === true && prior.id !== business.defaultGatewayAccountId) {
            before.default = false;
            after.default = true;
          }
          if (Object.keys(after).length) {
            await auditGatewayAccount(
              req,
              business.id,
              gwa,
              "gateway_account.update",
              before,
              after,
            );
          }
        }
        return {
          ...serializeGatewayAccount(row),
          default: parsed.data.default === true || row.id === business.defaultGatewayAccountId,
        };
      } catch (e) {
        if (e instanceof GatewayError) return badRequest(reply, e.message);
        throw e;
      }
    },
  );

  app.delete(
    "/v1/businesses/:biz/gateway_accounts/:gwa",
    {
      preHandler: [authenticate, requirePerm("gateways:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const row = await getGatewayAccount(req.organization!.id, business.id, gwa);
      let ok: boolean;
      try {
        ok = row ? await deleteGatewayAccount(req.organization!.id, business.id, gwa) : false;
      } catch (e) {
        if (e instanceof GatewayAccountInUseError) return conflict(reply, e.message);
        throw e;
      }
      if (!ok || !row) return notFound(reply, "Gateway account not found");
      await auditGatewayAccount(
        req,
        business.id,
        gwa,
        "gateway_account.delete",
        gatewayAuditView(row),
        null,
      );
      // After the delete committed: a gateway that cannot be reached never blocks it.
      const webhookRemoval = await removeWebhookEndpointOnDelete(row);
      return { object: "gateway_account", id: gwa, deleted: true, webhook_removal: webhookRemoval };
    },
  );

  app.post(
    "/v1/businesses/:biz/gateway_accounts/:gwa/verify",
    {
      preHandler: [authenticate, requirePerm("gateways:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const result = await verifyGatewayAccount(req.organization!.id, business.id, gwa);
      if (result === null) return notFound(reply, "Gateway account not found");
      return { object: "gateway_account_verification", id: gwa, ...result };
    },
  );

  // The merchant's balance at the gateway, read live — advice beside a refund (a PayPal
  // refund is paid from it). Read-only, so no Idempotency-Key.
  app.get(
    "/v1/businesses/:biz/gateway_accounts/:gwa/balance",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const q = z
        .object({
          currency: z
            .string()
            .regex(/^[A-Za-z]{3}$/)
            .optional(),
        })
        .safeParse(req.query ?? {});
      if (!q.success) return badRequest(reply, "currency must be a three-letter ISO code");
      const r = await getGatewayAccountBalance(
        req.organization!.id,
        business.id,
        gwa,
        q.data.currency?.toUpperCase(),
      );
      if (r === null) return notFound(reply, "Gateway account not found");
      if (!r.supported) return { object: "gateway_balance", id: gwa, supported: false };
      if (!r.ok)
        return {
          object: "gateway_balance",
          id: gwa,
          supported: true,
          available: false,
          reason: r.reason,
          message: r.message,
        };
      return {
        object: "gateway_balance",
        id: gwa,
        supported: true,
        available: true,
        as_of: r.asOf ? r.asOf.toISOString() : null,
        balances: r.balances.map((b) => ({
          currency: b.currency,
          available_minor: Number(b.availableMinor),
          withheld_minor: Number(b.withheldMinor),
          total_minor: Number(b.totalMinor),
        })),
      };
    },
  );

  // Per-account webhook endpoint config: the Notification URL
  // the gateway should POST to, plus — for gateways with no provisioning API
  // (RazorPay) — the secret WE generated for the operator to paste. `?reveal=true`
  // is the dashboard's Show/Copy action; secrets are omitted otherwise.
  app.get(
    "/v1/businesses/:biz/gateway_accounts/:gwa/webhook_endpoint",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const q = req.query as Record<string, string | undefined>;
      // The secret authenticates inbound webhooks: whoever can read it can forge one.
      if (q.reveal === "true" && !callerHolds(req, "gateways:manage"))
        return missingPermission(reply, permissionDef("gateways:manage")!, !!req.hasOperator);
      try {
        const info = await getWebhookEndpointInfo({
          organizationId: req.organization!.id,
          businessId: business.id,
          gatewayAccountPublicId: gwa,
          reveal: q.reveal === "true",
        });
        return { object: "gateway_webhook_endpoint", id: gwa, ...info };
      } catch (e) {
        return notFound(reply, e instanceof Error ? e.message : "Gateway account not found");
      }
    },
  );

  // Register our Notification URL with the provider (Stripe/PayPal) or mint the
  // shared secret (RazorPay). Idempotent unless `force` is passed. With `webhook_secret`,
  // store the secret the operator copied from the gateway instead (`secret_in` only).
  app.post(
    "/v1/businesses/:biz/gateway_accounts/:gwa/webhook_endpoint",
    {
      preHandler: [authenticate, requirePerm("gateways:manage"), idempotency],
      onSend: idempotencyOnSend,
      // Response body is NOT persisted: it carries the revealed gateway shared secret, which otherwise lives ENCRYPTED in `credentials_enc` — a plaintext jsonb copy is strictly worse than its origin.
      // Route stays idempotent (a retry must never mint a second credential); a replay
      // returns 409 `response_not_replayable` with `created: true`. See idempotency.ts.
      config: idempotentNoStore,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const keys = parseRequest(
        z.object({
          force: z.unknown().optional(),
          webhook_secret: z.string().trim().min(1).max(LIMITS.id).optional(),
        }),
        req.body ?? {},
      );
      if (!keys.success) return badRequest(reply, keys.error);
      const body = (req.body ?? {}) as { force?: boolean };
      const force = body.force === true;
      try {
        const prior = await getWebhookEndpointInfo({
          organizationId: req.organization!.id,
          businessId: business.id,
          gatewayAccountPublicId: gwa,
        });
        const info = keys.data.webhook_secret
          ? await saveOperatorWebhookSecret({
              organizationId: req.organization!.id,
              businessId: business.id,
              gatewayAccountPublicId: gwa,
              webhookSecret: keys.data.webhook_secret,
            })
          : await provisionWebhookEndpoint({
              organizationId: req.organization!.id,
              businessId: business.id,
              gatewayAccountPublicId: gwa,
              force,
            });
        // A provision call that found the endpoint already set up changed nothing.
        const changed =
          info.mode !== "not_applicable" &&
          (!!keys.data.webhook_secret ||
            force ||
            prior.configured !== info.configured ||
            prior.webhook_id !== info.webhook_id ||
            prior.mode !== info.mode);
        if (changed) {
          await auditGatewayAccount(
            req,
            business.id,
            gwa,
            keys.data.webhook_secret
              ? "gateway_account.set_webhook_secret"
              : force
                ? "gateway_account.rotate_webhook_secret"
                : "gateway_account.provision_webhook",
            { mode: prior.mode, configured: prior.configured },
            { gateway_key: info.gateway_key, mode: info.mode, configured: info.configured },
          );
        }
        return { object: "gateway_webhook_endpoint", id: gwa, ...info };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "We could not provision the webhook";
        if (msg.includes("not found")) return notFound(reply, msg);
        return reply.code(400).send({ error: { type: "invalid_request_error", message: msg } });
      }
    },
  );

  // Inbound gateway-webhook log + inspector (C8 / GW-6) — paginated (§3.4):
  // this log is unbounded provider callback traffic.
  app.get(
    "/v1/businesses/:biz/gateway_webhooks",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: GATEWAY_WEBHOOK_FILTER_OPS,
        sortFields: GATEWAY_WEBHOOK_SORT_FIELDS,
        bareParams: ["outcome"],
      });
      if (!parsed) return;
      // Legacy flat param, still honoured.
      const q = req.query as Record<string, string | undefined>;
      if (q.outcome) parsed.filters.push({ field: "outcome", op: "is", value: q.outcome });
      const page = await listGatewayWebhooksPage(req.organization!.id, business.id, parsed);
      return listResponse(page, serializeGatewayWebhook);
    },
  );

  app.get(
    "/v1/businesses/:biz/gateway_webhooks/:id",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getGatewayWebhook(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, "Gateway webhook not found");
      return serializeGatewayWebhook(row);
    },
  );

  /**
   * Register a storefront domain for WALLET buttons on this gateway account.
   *
   * Apple Pay renders no button on an unregistered domain and says nothing about it — no
   * error, no warning, no failed request — so "we do not support Apple Pay" is what a
   * silent configuration gap looks like from the outside. Everything else was already in
   * place: an Apple Pay token IS a card credential, `PaymentElement` surfaces the button
   * on its own, and the saved instrument already reads back as "Apple Pay".
   *
   * ADMIN, not ops: registering a domain changes what a buyer is offered on a public
   * storefront. Idempotency-keyed like any other write, and the adapter tolerates a domain
   * Stripe already knows, so pressing it twice reports status rather than erroring.
   */
  app.post(
    "/v1/businesses/:biz/gateway_accounts/:gwa/wallet_domains",
    {
      preHandler: [authenticate, requirePerm("gateways:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { gwa } = req.params as { gwa: string };
      const parsed = parseRequest(walletDomainBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const row = await getGatewayAccount(req.organization!.id, business.id, gwa);
      if (!row) return notFound(reply, "Gateway account not found");
      const adapter = resolveAdapter(row);
      if (!adapter.registerWalletDomain) {
        // 409, not 400: the request is well-formed, the GATEWAY simply has no such concept
        // — and saying "unsupported" is more useful than a validation error would be.
        return reply.code(409).send({
          error: {
            type: "invalid_request_error",
            message: `${row.gatewayKey} does not register wallet domains. No action is necessary for it.`,
          },
        });
      }
      const domain = parsed.data.domain ?? configuredStorefrontDomain();
      if (!domain) {
        return badRequest(
          reply,
          "No storefront domain to register: this deployment has no PORTAL_BASE_URL, so pass `domain` explicitly.",
        );
      }
      const status = await adapter.registerWalletDomain({ domain });
      return {
        object: "wallet_domain",
        gateway_account: row.publicId,
        domain: status.domain,
        enabled: status.enabled,
        wallets: status.wallets.map((w: { wallet: string; active: boolean; detail?: string }) => ({
          wallet: w.wallet,
          active: w.active,
          ...(w.detail ? { detail: w.detail } : {}),
        })),
      };
    },
  );

  // Replay a FAILED webhook (GW-7). The last resort once the gateway has exhausted its
  // own retries — until this existed, an `outcome='error'` row was terminal: the money
  // had moved at the gateway, our ledger never learned, and nothing would try again.
  // Idempotency-keyed like any other write, so a double-click cannot double-book.
  app.post(
    "/v1/businesses/:biz/gateway_webhooks/:id/replay",
    {
      preHandler: [authenticate, requirePerm("payments:collect"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const res = await replayGatewayWebhook(req.organization!.id, business.id, id);
      if (!res.ok) {
        if (res.reason === "not_found") return notFound(reply, res.detail);
        // 409: the row exists but is not in a replayable state. A 400 would suggest the
        // caller sent something malformed; the request is fine, the row's state is not.
        return reply.code(409).send({
          error: { type: "invalid_request_error", message: res.detail },
        });
      }
      const row = await getGatewayWebhook(req.organization!.id, business.id, id);
      return reply.code(200).send({
        replayed: true,
        outcome: res.outcome,
        webhook: row ? serializeGatewayWebhook(row) : null,
      });
    },
  );

  // Outbound gateway request log + inspector (LOG-1) — paginated (§3.4): every
  // charge/refund/vault/webhook-normalize call against a gateway lands here.
  app.get(
    "/v1/businesses/:biz/gateway_requests",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseListQuery(req, reply, {
        includeDeleted: "none",
        filterOps: GATEWAY_REQUEST_FILTER_OPS,
        sortFields: GATEWAY_REQUEST_SORT_FIELDS,
        bareParams: ["gateway", "source"],
      });
      if (!parsed) return;
      // Legacy flat params, still honoured.
      const q = req.query as Record<string, string | undefined>;
      if (q.gateway) parsed.filters.push({ field: "gateway_key", op: "is", value: q.gateway });
      if (q.source) parsed.filters.push({ field: "source", op: "is", value: q.source });
      const page = await listGatewayRequestLogsPage(req.organization!.id, business.id, parsed);
      return listResponse(page, serializeGatewayRequestLog);
    },
  );

  app.get(
    "/v1/businesses/:biz/gateway_requests/:id",
    { preHandler: [authenticate, requirePerm("gateways:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const { id } = req.params as { id: string };
      const row = await getGatewayRequestLog(req.organization!.id, business.id, id);
      if (!row) return notFound(reply, "Gateway request log not found");
      return serializeGatewayRequestLog(row);
    },
  );
}
