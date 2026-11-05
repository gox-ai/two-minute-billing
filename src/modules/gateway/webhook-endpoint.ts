/**
 * Per-gateway-account webhook endpoint config.
 *
 * We never ask the operator for a signing secret. Each account gets a
 * **Notification URL** (carrying the gateway account id, `?id=gw_…`) and, for
 * gateways that use a shared secret, a secret WE generate for the operator to
 * paste into the gateway dashboard:
 *
 *   stripe   → we hold the account's secret key, so we CREATE the webhook endpoint
 *              at Stripe via the adapter and store the `whsec_…` Stripe returns.
 *              Nothing to ask, nothing to paste.
 *   paypal   → no shared secret exists; we create the endpoint and store its
 *              `webhook_id`, which PayPal's verify API needs. Nothing to paste.
 *   razorpay → RazorPay's merchant API DOES manage webhooks, and its create call
 *              takes the signing secret — so we generate the secret, register the
 *              endpoint with it ourselves, and keep it. Nothing to paste either.
 *              If registration fails (a merchant without webhook API access, or a
 *              WEBHOOK_BASE_URL whose host RazorPay can't resolve), we keep the
 *              generated secret and show it for pasting.
 *   tmtest   → in-process; no external endpoint.
 *
 * The secret is stored inside the account's encrypted credentials blob under
 * `webhook_secret` (`webhook_id` for PayPal) — the same keys `buildAdapter` already
 * reads, so verification picks it up with no further wiring.
 */
import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { encryptCredentials, decryptCredentials } from "@/platform/secrets";
import { resolveAdapter } from "@/providers/registry";
import { gatewayNotificationUrl } from "@/providers/notification-url";
import { GATEWAYS, gatewayDefinition, type WebhookEndpointMode } from "@/providers/gateway-catalog";
import type { ProvisionedWebhook } from "@/providers/types";
import { gatewayAccounts } from "@db/schema";
import type { GatewayAccount } from "./service";
import { GatewayError } from "./service";
import { createLogger } from "@/platform/logger";

const log = createLogger("gateway");

const webhookSecretMode = (gatewayKey: string) =>
  gatewayDefinition(gatewayKey)?.webhook.secret ?? "none";

/**
 * Gateways whose RECURRING debits settle ASYNCHRONOUSLY ON EVERY RAIL — the charge
 * call returns `pending` and only the inbound webhook can turn it into cash.
 *
 * For these the endpoint is load-bearing rather than observability: without it a live
 * account registers mandates, debits real money, and never marks an invoice paid.
 * Two consumers enforce that — the vault-setup preconditions refuse to register a new
 * mandate (`assertVaultPreconditions`, payment-methods/service.ts, on BOTH the intent
 * and the legacy path), and the `async_gateway_has_webhook` invariant reports existing
 * accounts — so the rule lives HERE, next to the endpoint code, rather than being
 * copied into both and drifting.
 *
 * Declared per gateway as `settlement.alwaysAsync` (today: RazorPay, async on every rail).
 *
 * ⚠️ This coarse set is NOT the whole rule any more — see `settlesAsynchronously`
 * below. It stays exported because the ops invariant scans accounts, not requests,
 * and has no method vector to reason about; it therefore still reports only the
 * always-async gateways. Widening it there needs `method_types` in that query
 * (follow-up in the `async_gateway_has_webhook` invariant check).
 */
export const ASYNC_SETTLEMENT_GATEWAY_KEYS: ReadonlySet<string> = new Set(
  Object.values(GATEWAYS)
    .filter((g) => g.settlement.alwaysAsync)
    .map((g) => g.key),
);

/**
 * Method types that settle asynchronously on a gateway whose CARD rail does not.
 *
 * Stripe used to be absent from the async rule entirely, on the grounds that "Stripe
 * card renewals settle synchronously, so a missing endpoint there costs visibility,
 * not money." That is true of a plain card and false of everything else Stripe
 * declares: its own `capabilities.methods` carries `us_bank_account`, `sepa_debit` and
 * `bank_transfer`, which its own comment describes as settling ASYNCHRONOUSLY
 * ("ACH/SEPA take days… the terminal outcome arrives only as an inbound webhook"). On
 * those rails a live Stripe account with no endpoint has RazorPay's exact problem:
 * it collects money we can never reconcile.
 *
 * Flipping Stripe on WHOLESALE would be the wrong fix — it would refuse card-only
 * add-cards, which are the common case and are genuinely fine — so the rule is
 * METHOD-AWARE instead: the requested method types (or, when the caller named none,
 * the account's own `method_types`) decide.
 *
 * Both vocabularies are listed on purpose. The values reaching us are either the
 * canonical instrument types stored on `gateway_accounts.method_types` (which is what
 * routing matches on) or the wider REQUEST vocabulary a buyer surface may send
 * (`METHOD_TYPE_MAP` in providers/stripe.ts); every entry below maps to a bank debit
 * either way. Card presentations (`wallet`, `apple_pay`, `google_pay`, `link`) are
 * deliberately absent — they are cards, and they settle like cards.
 *
 * ⚠️ Known gap, stated rather than hidden: an INDIAN Stripe account's e-mandate CARD
 * renewals are async too (Stripe parks an off-session India debit in
 * `payment_intent.processing` for the RBI 26-hour pre-debit window). Account country
 * is not on `gateway_accounts` and cannot be known here without a gateway round-trip,
 * so that case is left to the settlement poll and the ops invariant rather than
 * guessed at from the method vector.
 */
// Declared per gateway as `settlement.asyncMethods`.

/**
 * Would a mandate registered on this account, for these method types, settle
 * asynchronously — i.e. is the inbound webhook the ONLY thing that can turn a debit
 * into cash?
 *
 * `methodTypes` is the EFFECTIVE vector: what the caller asked for, else the
 * account's `method_types`. Null/empty means "the gateway's own default", which for
 * every adapter we ship is the card rail — synchronous everywhere except on the
 * always-async gateways above.
 */
export function settlesAsynchronously(
  gatewayKey: string,
  methodTypes?: readonly string[] | null,
): boolean {
  const settlement = gatewayDefinition(gatewayKey)?.settlement;
  if (settlement?.alwaysAsync) return true;
  const asyncMethods = settlement?.asyncMethods;
  if (!asyncMethods) return false;
  return (methodTypes ?? []).some((m) => asyncMethods.includes(m));
}

/**
 * A second webhook secret that still verifies deliveries, kept in the credentials blob:
 *  - `previous`: the secret a rotation replaced. Deliveries signed before the rotation are
 *    still in flight or in the gateway's retry queue (Adyen re-signs nothing).
 *  - `unconfirmed`: a secret we sent in a rotation whose answer we did not get. The gateway
 *    may hold it. The first delivery it verifies promotes it (only the gateway and we know it).
 */
export const WEBHOOK_SECRET_FALLBACK = {
  secret: "webhook_secret_fallback",
  until: "webhook_secret_fallback_until",
  kind: "webhook_secret_fallback_kind",
} as const;
export type WebhookSecretFallbackKind = "previous" | "unconfirmed";
/** Long enough for a gateway's retry schedule to drain; short, because a rotation may follow a leak. */
export const PREVIOUS_WEBHOOK_SECRET_MS = 24 * 60 * 60 * 1000;
/** Long enough for the operator to retry the rotation, or for one delivery to settle it. */
export const UNCONFIRMED_WEBHOOK_SECRET_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a replaced secret still verifies: the gateway's retry window, else 24 h. */
export function previousWebhookSecretMs(gatewayKey: string | null | undefined): number {
  const days = gatewayDefinition(gatewayKey)?.webhookRetryDays;
  return days ? days * 24 * 60 * 60 * 1000 : PREVIOUS_WEBHOOK_SECRET_MS;
}

export function setWebhookSecretFallback(
  creds: Record<string, unknown>,
  secret: string,
  kind: WebhookSecretFallbackKind,
  gatewayKey?: string | null,
  now: Date = new Date(),
): void {
  const ms =
    kind === "previous" ? previousWebhookSecretMs(gatewayKey) : UNCONFIRMED_WEBHOOK_SECRET_MS;
  creds[WEBHOOK_SECRET_FALLBACK.secret] = secret;
  creds[WEBHOOK_SECRET_FALLBACK.until] = new Date(now.getTime() + ms).toISOString();
  creds[WEBHOOK_SECRET_FALLBACK.kind] = kind;
}

export function clearWebhookSecretFallback(creds: Record<string, unknown>): void {
  delete creds[WEBHOOK_SECRET_FALLBACK.secret];
  delete creds[WEBHOOK_SECRET_FALLBACK.until];
  delete creds[WEBHOOK_SECRET_FALLBACK.kind];
}

/** The fallback secret, if one exists and its window is still open. */
export function activeWebhookSecretFallback(
  creds: Record<string, unknown>,
  now: Date = new Date(),
): { secret: string; kind: WebhookSecretFallbackKind } | null {
  const secret = creds[WEBHOOK_SECRET_FALLBACK.secret];
  const until = creds[WEBHOOK_SECRET_FALLBACK.until];
  if (typeof secret !== "string" || !secret || typeof until !== "string") return null;
  const end = Date.parse(until);
  if (!Number.isFinite(end) || end <= now.getTime()) return null;
  return {
    secret,
    kind: creds[WEBHOOK_SECRET_FALLBACK.kind] === "unconfirmed" ? "unconfirmed" : "previous",
  };
}

/** Keep the replaced secret valid for a bounded window, so in-flight deliveries still verify. */
function rotateWebhookSecret(
  creds: Record<string, unknown>,
  next: string | undefined,
  gatewayKey: string,
): void {
  if (!next) return;
  const current = typeof creds.webhook_secret === "string" ? creds.webhook_secret : "";
  if (current && current !== next) setWebhookSecretFallback(creds, current, "previous", gatewayKey);
  else if (current === next && activeWebhookSecretFallback(creds)?.kind === "unconfirmed")
    clearWebhookSecretFallback(creds);
  creds.webhook_secret = next;
}

/** Refusal while a second signing secret is held for an endpoint being replaced. */
export const WEBHOOK_CHANGE_IN_PROGRESS =
  "We could not register the webhook. A webhook change is in progress on this account. " +
  "Finish it with promote, then try again.";

/** A URL-safe high-entropy secret, in the shape gateways accept as a signing key. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The public URL a gateway should POST to for this account. The account's public id
 * rides in `?id=` so inbound events are attributed to the exact account (see
 * `ingestGatewayWebhook`).
 */
export function buildNotificationUrl(input: {
  gatewayKey: string;
  gatewayAccountPublicId: string;
}): string {
  // ONE shape for every gateway. The per-business path segment and Stripe's separate
  // `/v1/webhooks/stripe` path were removed 2026-08-01.
  return gatewayNotificationUrl(input.gatewayKey, input.gatewayAccountPublicId);
}

export interface WebhookEndpointInfo {
  gateway_key: string;
  notification_url: string;
  /**
   * The shared secret to paste into the gateway dashboard — present ONLY for
   * gateways that need manual pasting (razorpay). Self-provisioning gateways
   * return null because there is nothing for the operator to copy.
   */
  secret: string | null;
  /** PayPal's endpoint id, once provisioned. */
  webhook_id: string | null;
  mode: WebhookEndpointMode;
  configured: boolean;
  /** Operator-facing setup steps, numbered. */
  instructions: string[];
}

/**
 * Read (and if needed mint) the webhook endpoint config for one gateway account.
 * Pass `reveal: true` to include the shared secret — the dashboard's Show/Copy
 * action, kept behind an explicit flag so secrets never leak into list payloads.
 */
export async function getWebhookEndpointInfo(input: {
  organizationId: string;
  businessId: string;
  gatewayAccountPublicId: string;
  reveal?: boolean;
}): Promise<WebhookEndpointInfo> {
  const row = await withTenant(input.organizationId, async (tx) => {
    const [r] = await tx
      .select()
      .from(gatewayAccounts)
      .where(
        and(
          eq(gatewayAccounts.businessId, input.businessId),
          eq(gatewayAccounts.publicId, input.gatewayAccountPublicId),
        ),
      )
      .limit(1);
    if (!r) throw new GatewayError("Gateway account not found");
    return r;
  });

  const url = buildNotificationUrl({
    gatewayKey: row.gatewayKey,
    gatewayAccountPublicId: row.publicId,
  });
  const creds = decryptCredentials(row.credentialsEnc);
  const secret = typeof creds.webhook_secret === "string" ? creds.webhook_secret : null;
  const webhookId = typeof creds.webhook_id === "string" ? creds.webhook_id : null;
  const endpointId =
    typeof creds.webhook_endpoint_id === "string" ? creds.webhook_endpoint_id : null;

  const secretMode = webhookSecretMode(row.gatewayKey);
  const mode: WebhookEndpointMode =
    secretMode === "provider_minted"
      ? "self_provisioned"
      : secretMode === "shared"
        ? // We own the secret for these. If we ALSO registered the endpoint at the
          // gateway, there is nothing for the operator to do; without an endpoint id
          // the secret still has to be pasted by hand.
          endpointId
          ? "self_provisioned"
          : "paste_required"
        : secretMode === "credential"
          ? endpointId
            ? "self_provisioned"
            : "url_only"
          : secretMode === "operator_pasted"
            ? "secret_in"
            : "not_applicable";

  return {
    gateway_key: row.gatewayKey,
    notification_url: url,
    // Only paste-required gateways ever expose a secret, and only when revealed.
    secret: mode === "paste_required" && input.reveal ? secret : null,
    webhook_id: webhookId,
    mode,
    // A `credential` gateway verifies with the API keys the account already holds, so it
    // has nothing left to configure on our side; whether the URL is registered at the
    // gateway is something only the gateway knows.
    configured:
      secretMode === "credential"
        ? true
        : mode === "self_provisioned"
          ? Boolean(secret || webhookId)
          : Boolean(secret),
    instructions: gatewayDefinition(row.gatewayKey)?.webhook.instructions(url, mode) ?? [
      "This gateway does not use external webhooks.",
    ],
  };
}

/**
 * Make this account's inbound webhooks work without the operator supplying a
 * secret. Self-provisioning gateways get their endpoint registered at the provider
 * (storing whatever material it mints); paste-required gateways get a freshly
 * generated shared secret they can copy. Safe to call repeatedly — `force` controls
 * whether an already-configured account is re-provisioned/rotated.
 */
export async function provisionWebhookEndpoint(input: {
  organizationId: string;
  businessId: string;
  gatewayAccountPublicId: string;
  force?: boolean;
}): Promise<WebhookEndpointInfo> {
  const existing = await getWebhookEndpointInfo({ ...input, reveal: false });
  if (existing.mode === "not_applicable") return existing;
  // A shared-secret account is `configured` from birth (the secret is minted at creation),
  // and `url_only` reads as configured because the keys verify. In both modes the URL may
  // still be unregistered, so they still get the registration attempt.
  const registered =
    existing.configured && existing.mode !== "paste_required" && existing.mode !== "url_only";
  if (!input.force && (registered || (existing.configured && !config.WEBHOOK_BASE_URL)))
    return getWebhookEndpointInfo({ ...input, reveal: true });
  if (!config.WEBHOOK_BASE_URL)
    throw new GatewayError(
      "WEBHOOK_BASE_URL is not configured. Set it to the public base URL of this API before you provision webhooks.",
    );

  const row = await withTenant(input.organizationId, async (tx) => {
    const [r] = await tx
      .select()
      .from(gatewayAccounts)
      .where(
        and(
          eq(gatewayAccounts.businessId, input.businessId),
          eq(gatewayAccounts.publicId, input.gatewayAccountPublicId),
        ),
      )
      .limit(1);
    if (!r) throw new GatewayError("Gateway account not found");
    return r;
  });

  const creds = decryptCredentials(row.credentialsEnc);
  // A pin migration (scripts/stripe-pin-webhook-endpoint.ts) is between create and promote:
  // re-registering would delete both endpoints at this URL and strand the next secret.
  if (typeof creds.webhook_secret_next === "string" && creds.webhook_secret_next)
    throw new GatewayError(WEBHOOK_CHANGE_IN_PROGRESS);
  const secretMode = webhookSecretMode(row.gatewayKey);
  if (secretMode === "credential" || secretMode === "operator_pasted") {
    // No secret of ours to generate: the signing key is an API credential, or the
    // operator pastes the gateway's. Register the URL when the adapter can.
    const adapter = resolveAdapter(row);
    if (!adapter.provisionWebhookEndpoint)
      return getWebhookEndpointInfo({ ...input, reveal: false });
    const provisioned = await adapter.provisionWebhookEndpoint({ url: existing.notification_url });
    if (provisioned.providerEndpointId) creds.webhook_endpoint_id = provisioned.providerEndpointId;
    if (provisioned.webhookId) creds.webhook_id = provisioned.webhookId;
  } else if (secretMode === "provider_minted") {
    const adapter = resolveAdapter(row);
    if (!adapter.provisionWebhookEndpoint)
      throw new GatewayError(`${row.gatewayKey} adapter cannot provision webhook endpoints`);
    const provisioned = await adapter.provisionWebhookEndpoint({ url: existing.notification_url });
    rotateWebhookSecret(creds, provisioned.webhookSecret, row.gatewayKey);
    if (provisioned.webhookId) creds.webhook_id = provisioned.webhookId;
    if (provisioned.providerEndpointId) creds.webhook_endpoint_id = provisioned.providerEndpointId;
  } else {
    // WE own the secret. Register the endpoint carrying it so the operator has nothing
    // to paste. Registration is best-effort: a merchant without webhook API access — or a
    // WEBHOOK_BASE_URL whose host the gateway cannot resolve — falls back to the paste
    // flow with the same secret. Only `force` rotates: the current secret may already be
    // pasted at the gateway.
    const current =
      typeof creds.webhook_secret === "string" && creds.webhook_secret
        ? creds.webhook_secret
        : null;
    const secret = !input.force && current ? current : generateWebhookSecret();
    const wasRegistered = typeof creds.webhook_endpoint_id === "string";
    const adapter = resolveAdapter(row);
    let provisioned: ProvisionedWebhook | null = null;
    if (adapter.provisionWebhookEndpoint) {
      try {
        provisioned = await adapter.provisionWebhookEndpoint({
          url: existing.notification_url,
          secret,
        });
      } catch (e) {
        log.warn("[gateway] webhook auto-registration failed; falling back to operator paste", {
          event: "gateway_webhook_autoregister_failed",
          gateway: row.gatewayKey,
          gatewayAccount: row.publicId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // A failed rotation may still have reached the gateway (a timeout says nothing), so it
    // may sign with either secret now. `current` stays primary; the new one verifies too,
    // for a bounded window, until a retry or the first delivery it verifies settles it.
    if (!provisioned && wasRegistered && current && secret !== current) {
      setWebhookSecretFallback(creds, secret, "unconfirmed");
      await withTenant(input.organizationId, async (tx) => {
        await tx
          .update(gatewayAccounts)
          .set({ credentialsEnc: encryptCredentials(creds), updatedAt: new Date() })
          .where(eq(gatewayAccounts.id, row.id));
      });
      const name = gatewayDefinition(row.gatewayKey)?.displayName ?? row.gatewayKey;
      throw new GatewayError(
        `We could not rotate the webhook secret. ${name} did not confirm the new secret, so the current secret stays active. Try again later.`,
      );
    }
    rotateWebhookSecret(creds, provisioned?.webhookSecret ?? secret, row.gatewayKey);
    if (provisioned?.providerEndpointId) creds.webhook_endpoint_id = provisioned.providerEndpointId;
    else delete creds.webhook_endpoint_id;
  }

  await withTenant(input.organizationId, async (tx) => {
    await tx
      .update(gatewayAccounts)
      .set({ credentialsEnc: encryptCredentials(creds), updatedAt: new Date() })
      .where(eq(gatewayAccounts.id, row.id));
  });

  return getWebhookEndpointInfo({ ...input, reveal: true });
}

/**
 * Store the signing secret an operator copied from the gateway's dashboard (`secret_in`,
 * an `operator_pasted` gateway). Merged into the account's credentials, so the API keys
 * stay; never echoed back.
 */
export async function saveOperatorWebhookSecret(input: {
  organizationId: string;
  businessId: string;
  gatewayAccountPublicId: string;
  webhookSecret: string;
}): Promise<WebhookEndpointInfo> {
  const existing = await getWebhookEndpointInfo({ ...input, reveal: false });
  if (existing.mode !== "secret_in")
    throw new GatewayError(
      "We could not save the webhook secret. This gateway does not use a secret that you copy from its dashboard. Do the steps on the webhook card instead.",
    );
  await withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(gatewayAccounts)
      .where(
        and(
          eq(gatewayAccounts.businessId, input.businessId),
          eq(gatewayAccounts.publicId, input.gatewayAccountPublicId),
        ),
      )
      .limit(1);
    if (!row) throw new GatewayError("Gateway account not found");
    const creds = decryptCredentials(row.credentialsEnc);
    creds.webhook_secret = input.webhookSecret;
    await tx
      .update(gatewayAccounts)
      .set({ credentialsEnc: encryptCredentials(creds), updatedAt: new Date() })
      .where(eq(gatewayAccounts.id, row.id));
  });
  return getWebhookEndpointInfo({ ...input, reveal: false });
}

/**
 * Register a new account's endpoint straight away, so its card never claims a failure
 * before anything tried. Best effort: a failure never fails the create, and the account
 * stays in whatever mode provisioning left it. Skipped without `WEBHOOK_BASE_URL`, which
 * is also what keeps tests off the network.
 */
export async function registerWebhookEndpointOnCreate(input: {
  organizationId: string;
  businessId: string;
  gatewayAccountPublicId: string;
  gatewayKey: string;
}): Promise<void> {
  if (!config.WEBHOOK_BASE_URL || webhookSecretMode(input.gatewayKey) === "none") return;
  try {
    await provisionWebhookEndpoint(input);
  } catch (e) {
    log.warn("[gateway] webhook registration on account create failed", {
      event: "gateway_webhook_register_on_create_failed",
      gateway: input.gatewayKey,
      gatewayAccount: input.gatewayAccountPublicId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export type WebhookRemovalStatus =
  | "removed"
  | "deactivated"
  | "not_found"
  | "manual"
  | "failed"
  | "not_applicable";

export interface WebhookRemovalReport {
  status: WebhookRemovalStatus;
  /** Steps for the operator, when something is left to do at the gateway. */
  instructions: string[];
}

/**
 * After a gateway account is deleted, remove its webhook registration at the gateway: only
 * the one whose URL is this account's notification URL. Best effort: it never throws, and a
 * failure leaves steps for the operator.
 */
export async function removeWebhookEndpointOnDelete(
  row: GatewayAccount,
): Promise<WebhookRemovalReport> {
  const def = gatewayDefinition(row.gatewayKey);
  if (!def || def.webhook.secret === "none") return { status: "not_applicable", instructions: [] };
  const url = buildNotificationUrl({
    gatewayKey: row.gatewayKey,
    gatewayAccountPublicId: row.publicId,
  });
  const manual = def.webhook.removalInstructions?.(url) ?? [
    `In the ${def.displayName} dashboard, delete the webhook with this URL: ${url}`,
  ];
  let adapter;
  try {
    adapter = resolveAdapter(row);
  } catch (e) {
    log.warn("[gateway] webhook removal skipped: the adapter does not resolve", {
      event: "gateway_webhook_remove_failed",
      gateway: row.gatewayKey,
      gatewayAccount: row.publicId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { status: "failed", instructions: manual };
  }
  if (!adapter.removeWebhookEndpoint)
    return def.webhook.removalInstructions
      ? { status: "manual", instructions: manual }
      : { status: "not_applicable", instructions: [] };
  // Without a public base URL we never registered anything from here.
  if (!config.WEBHOOK_BASE_URL) return { status: "manual", instructions: manual };
  try {
    const r = await adapter.removeWebhookEndpoint({ url });
    log.info("[gateway] webhook registration removed with its account", {
      event: "gateway_webhook_removed",
      gateway: row.gatewayKey,
      gatewayAccount: row.publicId,
      removed: r.removed,
    });
    if (!r.removed) return { status: "not_found", instructions: [] };
    return r.deactivatedOnly
      ? { status: "deactivated", instructions: manual }
      : { status: "removed", instructions: [] };
  } catch (e) {
    log.warn("[gateway] webhook removal at the gateway failed", {
      event: "gateway_webhook_remove_failed",
      gateway: row.gatewayKey,
      gatewayAccount: row.publicId,
      error: e instanceof Error ? e.message : String(e),
    });
    return { status: "failed", instructions: manual };
  }
}
