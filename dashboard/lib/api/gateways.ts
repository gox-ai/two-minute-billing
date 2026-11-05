// Typed fetchers for the Gateway Accounts surface. Server-only — imports the
// frozen api client ({ apiGet, apiWrite }); never pull this into a client
// component. Route shapes mirror the backend serializer:
//   - gateway_accounts: src/modules/gateway/service.ts  serializeGatewayAccount
// Client-safe types and helpers live in components/gateways/gateway-meta.ts.
import { cache } from "react";
import { apiGet, apiWrite } from "@/lib/api";
import type { GatewayCatalogEntry } from "@/components/gateways/gateway-meta";

export {
  gatewayDisplayName,
  type GatewayCatalogEntry,
  type CredentialFieldMeta,
} from "@/components/gateways/gateway-meta";

interface List<T> {
  object: "list";
  data: T[];
}

export interface GatewayAccount {
  object: "gateway_account";
  id: string;
  gateway_key: string;
  label: string;
  livemode: boolean;
  currencies: string[] | null;
  method_types: string[] | null;
  /** "International payments". Null: the gateway has no such switch. */
  international_enabled?: boolean | null;
  status: "active" | "disabled";
  /** True iff the account's credentials include a non-empty webhook_secret. Never the value itself. */
  webhook_secret_configured: boolean;
  /** True when this account is the business default (set via PATCH {default:true}). */
  default?: boolean;
  created_at: string;
  updated_at: string;
  resource_version?: number;
}

/**
 * Per-account webhook endpoint config.
 * `mode` decides what the UI shows:
 *   self_provisioned → tmbilling registered the endpoint at the provider; no secret to copy.
 *   paste_required   → show Notification URL + the secret WE generated (Show/Copy).
 *   secret_in        → the operator pastes the GATEWAY's secret into us (write-only).
 *   url_only         → register the URL at the gateway; the API keys verify, no secret.
 *   not_applicable   → gateway has no external webhooks (tmtest).
 */
export interface GatewayWebhookEndpoint {
  object: "gateway_webhook_endpoint";
  id: string;
  gateway_key: string;
  notification_url: string;
  /** Only populated for paste_required gateways when fetched with reveal=true. */
  secret: string | null;
  webhook_id: string | null;
  mode: "self_provisioned" | "paste_required" | "secret_in" | "url_only" | "not_applicable";
  configured: boolean;
  instructions: string[];
}

export function getGatewayWebhookEndpoint(biz: string, gwa: string, reveal = false) {
  const qs = reveal ? "?reveal=true" : "";
  return apiGet<GatewayWebhookEndpoint>(
    `/v1/businesses/${biz}/gateway_accounts/${gwa}/webhook_endpoint${qs}`,
  );
}

/**
 * Store the secret a `secret_in` gateway minted. Not the account PATCH: its `credentials`
 * replace every operator key, so a PATCH carrying only this would wipe the API keys.
 */
export function saveGatewayWebhookSecret(biz: string, gwa: string, secret: string) {
  return apiWrite(
    `/v1/businesses/${biz}/gateway_accounts/${gwa}/webhook_endpoint`,
    { webhook_secret: secret },
    "POST",
  );
}

/** Register our Notification URL with the provider (or mint the shared secret). */
export function provisionGatewayWebhookEndpoint(biz: string, gwa: string, force = false) {
  return apiWrite(
    `/v1/businesses/${biz}/gateway_accounts/${gwa}/webhook_endpoint`,
    { force },
    "POST",
  );
}

/**
 * One storefront domain's wallet status at the gateway. `active` and `detail` are the
 * GATEWAY's verdict — `detail` normally says the association file could not be fetched,
 * which is the actual reason an Apple Pay button does not appear.
 */
export interface WalletDomainStatus {
  object: "wallet_domain";
  gateway_account: string;
  domain: string;
  enabled: boolean;
  wallets: Array<{ wallet: string; active: boolean; detail?: string }>;
}

/**
 * Register a storefront domain so wallet buttons may render on it, and re-verify it.
 * Omit `domain` to use the deployment's configured storefront host — the API resolves it,
 * because only the API knows it.
 */
export function registerWalletDomain(biz: string, gwa: string, domain?: string) {
  return apiWrite(
    `/v1/businesses/${biz}/gateway_accounts/${gwa}/wallet_domains`,
    domain ? { domain } : {},
    "POST",
  );
}

/** One named check inside a health probe (Adyen: `allowed_origins`). */
export interface GatewayHealthCheck {
  key: string;
  /** `unchecked`: the check could not run; it does not fail the account. */
  status: "ok" | "failed" | "unchecked";
  message: string;
  steps?: string[];
}

export interface GatewayVerifyResult {
  object: "gateway_account_verification";
  id: string;
  ok: boolean;
  detail?: string;
  checks?: GatewayHealthCheck[];
}

/**
 * The gateways an account can be created for, with their names, credential fields and
 * methods. `cache()` dedupes within one render pass.
 */
export const getGatewayCatalog = cache(async (): Promise<GatewayCatalogEntry[]> => {
  const res = await apiGet<List<GatewayCatalogEntry>>("/v1/gateways");
  return res.data;
});

/**
 * The catalogue for a list page's filter and labels. A failed fetch leaves the gateway
 * filter empty rather than failing the whole list.
 */
export const getGatewayCatalogOrEmpty = () => getGatewayCatalog().catch(() => []);

export function listGatewayAccounts(biz: string, includeDisabled = true) {
  const qs = includeDisabled ? "?include_disabled=true" : "";
  return apiGet<List<GatewayAccount>>(`/v1/businesses/${biz}/gateway_accounts${qs}`);
}

/** Mirrors the `/balance` route (src/api/gateway-routes.ts). */
export type GatewayBalance =
  | { object: "gateway_balance"; id: string; supported: false }
  | {
      object: "gateway_balance";
      id: string;
      supported: true;
      available: false;
      reason: "not_permitted" | "unavailable";
      message: string;
    }
  | {
      object: "gateway_balance";
      id: string;
      supported: true;
      available: true;
      as_of: string | null;
      balances: Array<{
        currency: string;
        available_minor: number;
        withheld_minor: number;
        total_minor: number;
      }>;
    };

/**
 * The one gateway account a refund of this invoice goes through, resolved by the engine
 * the way the refund resolves it (an imported payment carries no account of its own).
 * Null when none or several. Never throws: the balance notice is optional.
 */
export async function invoiceRefundAccount(
  biz: string,
  invoice: string,
): Promise<{ id: string; name: string } | null> {
  const r = await apiGet<{
    gateway_account: { id: string; label: string; gateway_key: string } | null;
  }>(`/v1/businesses/${biz}/invoices/${invoice}/refund_gateway_account`).catch(() => null);
  const acc = r?.gateway_account;
  return acc ? { id: acc.id, name: acc.label } : null;
}

/** The merchant's balance held at the gateway, read live. */
export function getGatewayBalance(biz: string, gwa: string, currency?: string) {
  const qs = currency ? `?currency=${encodeURIComponent(currency)}` : "";
  return apiGet<GatewayBalance>(`/v1/businesses/${biz}/gateway_accounts/${gwa}/balance${qs}`);
}

export function getGatewayAccount(biz: string, gwa: string) {
  return apiGet<GatewayAccount>(`/v1/businesses/${biz}/gateway_accounts/${gwa}`);
}

export function createGatewayAccount(
  biz: string,
  body: {
    gateway_key: string;
    label: string;
    credentials?: Record<string, string>;
    currencies?: string[] | null;
    method_types?: string[] | null;
    international_enabled?: boolean;
  },
) {
  // apiWrite attaches a per-invocation Idempotency-Key automatically.
  return apiWrite(`/v1/businesses/${biz}/gateway_accounts`, body, "POST");
}

export function updateGatewayAccount(
  biz: string,
  gwa: string,
  body: {
    label?: string;
    credentials?: Record<string, string>;
    currencies?: string[] | null;
    method_types?: string[] | null;
    international_enabled?: boolean;
    status?: "active" | "disabled";
    default?: boolean;
  },
) {
  return apiWrite(`/v1/businesses/${biz}/gateway_accounts/${gwa}`, body, "PATCH");
}

export function deleteGatewayAccount(biz: string, gwa: string) {
  return apiWrite(`/v1/businesses/${biz}/gateway_accounts/${gwa}`, {}, "DELETE");
}

export function verifyGatewayAccount(biz: string, gwa: string) {
  return apiWrite(`/v1/businesses/${biz}/gateway_accounts/${gwa}/verify`, {}, "POST");
}

/**
 * Set a gateway account as the business default (businesses.default_gateway_account_id).
 *
 * NOTE: PATCH /v1/businesses/:biz does NOT accept `default_gateway_account_id`
 * (updateBusinessBody strips unknown keys, so it would silently no-op). The
 * backend-supported path is PATCH on the gateway account with `default: true`,
 * which calls setDefaultGatewayAccount() in src/modules/gateway/service.ts.
 */
export function setDefaultGatewayAccount(biz: string, gwa: string) {
  return apiWrite(`/v1/businesses/${biz}/gateway_accounts/${gwa}`, { default: true }, "PATCH");
}

/** The gateway-account serializer marks the business default with `default: true`. */
export async function getDefaultGatewayAccountId(biz: string): Promise<string | null> {
  const rows = await listGatewayAccounts(biz);
  return rows.data.find((r) => r.default)?.id ?? null;
}

// Re-exported: the narrowing itself moved to `lib/payment-method-avs.ts`, which touches
// nothing server-only, so the client component that also needs it can import it.
export { avsCheckOf, type PaymentMethodAvsCheck } from "@/lib/payment-method-avs";
