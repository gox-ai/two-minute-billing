import { config } from "@/platform/config";
import { gatewayDefinition } from "./gateway-catalog";

const trimBase = (base: string | undefined) => (base ?? "").replace(/\/+$/, "");

/** Credentials key holding the URL the account is registered under at its gateway. */
export const WEBHOOK_URL_KEY = "webhook_url";

/** The base new registrations use: `GATEWAY_WEBHOOK_BASE_URL`, else `WEBHOOK_BASE_URL`. */
export function gatewayWebhookBaseUrl(): string | undefined {
  return config.GATEWAY_WEBHOOK_BASE_URL || config.WEBHOOK_BASE_URL || undefined;
}

/**
 * The public URL a gateway posts this account's webhooks to. The account id rides in
 * `?id=`, or in the path for a gateway that refuses a query string. `base` defaults to
 * the one new registrations use.
 */
export function gatewayNotificationUrl(
  gatewayKey: string,
  gatewayAccountPublicId: string,
  base: string | undefined = gatewayWebhookBaseUrl(),
): string {
  const gw = encodeURIComponent(gatewayKey);
  const id = encodeURIComponent(gatewayAccountPublicId);
  const path = gatewayDefinition(gatewayKey)?.webhook.accountIdInPath
    ? `/v1/gateway_webhooks/${gw}/${id}`
    : `/v1/gateway_webhooks/${gw}?id=${id}`;
  return `${trimBase(base)}${path}`;
}

/**
 * The URL this account is registered under now. Registrations made before the account
 * stored `webhook_url` all used `WEBHOOK_BASE_URL`. An account with nothing registered
 * gets the URL new registrations use.
 */
export function accountNotificationUrl(
  row: { gatewayKey: string; publicId: string },
  creds: Record<string, unknown>,
): string {
  const stored = creds[WEBHOOK_URL_KEY];
  if (typeof stored === "string" && stored) return stored;
  const registered =
    (typeof creds.webhook_endpoint_id === "string" && creds.webhook_endpoint_id) ||
    (typeof creds.webhook_id === "string" && creds.webhook_id);
  return registered
    ? gatewayNotificationUrl(row.gatewayKey, row.publicId, config.WEBHOOK_BASE_URL)
    : gatewayNotificationUrl(row.gatewayKey, row.publicId);
}

/**
 * Every URL a delivery for this account may have been signed for: the registered one first,
 * then the old and new bases (a move leaves retries on the old URL in flight).
 */
export function accountNotificationUrlCandidates(
  row: { gatewayKey: string; publicId: string },
  creds: Record<string, unknown>,
): string[] {
  const urls = [
    accountNotificationUrl(row, creds),
    gatewayNotificationUrl(row.gatewayKey, row.publicId, config.WEBHOOK_BASE_URL),
    gatewayNotificationUrl(row.gatewayKey, row.publicId),
  ];
  return urls.filter((u, i) => urls.indexOf(u) === i);
}
