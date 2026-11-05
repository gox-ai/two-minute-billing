import { config } from "@/platform/config";
import { gatewayDefinition } from "./gateway-catalog";

/**
 * The public URL a gateway posts this account's webhooks to. The account id rides in
 * `?id=`, or in the path for a gateway that refuses a query string.
 */
export function gatewayNotificationUrl(gatewayKey: string, gatewayAccountPublicId: string): string {
  const base = (config.WEBHOOK_BASE_URL ?? "").replace(/\/+$/, "");
  const gw = encodeURIComponent(gatewayKey);
  const id = encodeURIComponent(gatewayAccountPublicId);
  const path = gatewayDefinition(gatewayKey)?.webhook.accountIdInPath
    ? `/v1/gateway_webhooks/${gw}/${id}`
    : `/v1/gateway_webhooks/${gw}?id=${id}`;
  return `${base}${path}`;
}
