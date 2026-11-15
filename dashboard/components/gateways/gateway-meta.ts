// Client-safe gateway types and helpers (no server imports). WHICH gateways exist, and
// their names, credential fields and methods, come from the API's catalogue
// (`GET /v1/gateways`, built from src/providers/gateway-catalog.ts) — fetch it with
// `getGatewayCatalog()` in lib/api/gateways.ts and pass it down. Nothing here lists
// gateways, so a new one needs no dashboard change.

export interface CredentialFieldMeta {
  key: string;
  label: string;
  placeholder: string | null;
  hint: string | null;
  /** The account can be created without it. Absent on an older API = required. */
  optional?: boolean;
}

export interface MethodTypeMeta {
  value: string;
  label: string;
  hint: string | null;
  /** False: not offered to buyers yet. Absent on an older API = offered. */
  available?: boolean;
  unavailable_reason?: string | null;
}

/** One id shape's page on the gateway's dashboard (src/providers/gateway-catalog.ts). */
export interface GatewayDashboardLink {
  object: string;
  /** The whole id must match. */
  id_pattern: string;
  /** `{id}` is the URL-encoded id. */
  live_url: string;
  test_url: string;
  /** False while the URL is not yet checked against the gateway. */
  confirmed: boolean;
}

export interface GatewayCatalogEntry {
  object: "gateway";
  key: string;
  display_name: string;
  note: string | null;
  /** Moves no real money; the API refuses it on a live business. */
  simulated: boolean;
  /** False: the API refuses a new account ("Coming soon"). Absent on an older API = offered. */
  available?: boolean;
  unavailable_reason?: string | null;
  credential_fields: CredentialFieldMeta[];
  method_types: MethodTypeMeta[];
  /** Who owns the webhook signing material — see `webhook_secret` in the API catalogue. */
  webhook_secret: "provider_minted" | "shared" | "credential" | "operator_pasted" | "none";
  /** Fallback steps when the account's webhook-endpoint route is unavailable. */
  webhook_instructions: string[];
  /** The notification URL carries the account id in the path, not in `?id=`. */
  webhook_account_id_in_path?: boolean;
  /** `payment`: takes a payment now. `setup`: saves a payment method. */
  intent_purposes?: Array<"payment" | "setup">;
  /** The gateway registers storefront domains for wallet buttons. Absent on an older API. */
  wallet_domains?: boolean;
  /** Deep links into the gateway's own dashboard, per id shape. Absent on an older API. */
  dashboard_links?: GatewayDashboardLink[];
  /** The currencies an account can route. Null or absent: any currency. */
  currencies?: string[] | null;
  /** Set when the account has an "International payments" switch: off = this currency only. */
  international_domestic_currency?: string | null;
}

export const gatewayEntry = (catalog: readonly GatewayCatalogEntry[], key: string | null) =>
  catalog.find((g) => g.key === key);

export const gatewayDisplayName = (key: string, catalog: readonly GatewayCatalogEntry[]): string =>
  gatewayEntry(catalog, key)?.display_name ?? key;

/** `{ value, label }` per gateway, for a list filter. */
export const gatewayFilterOptions = (catalog: readonly GatewayCatalogEntry[]) =>
  catalog.map((g) => ({ value: g.key, label: g.display_name }));

export const methodTypeLabel = (
  catalog: readonly GatewayCatalogEntry[],
  gatewayKey: string,
  value: string,
): string =>
  gatewayEntry(catalog, gatewayKey)?.method_types.find((m) => m.value === value)?.label ?? value;

/**
 * A deep link to this object on the GATEWAY's own dashboard, or `null` when its catalogue
 * entry declares no link for that id shape. The id then renders as plain text rather than a
 * link that lands on a 404. Which shapes are linked, and which are not yet confirmed, is
 * declared per gateway in `dashboardLinks` (src/providers/gateway-catalog.ts).
 * A test business opens the gateway's test mode; with no mode known, test is assumed.
 */
export function gatewayObjectUrl(
  catalog: readonly GatewayCatalogEntry[] | null | undefined,
  gatewayKey: string | null,
  idAtGateway: string | null,
  livemode: "live" | "test" | null,
): string | null {
  const id = idAtGateway?.trim();
  if (!id || !gatewayKey || !catalog) return null;
  for (const link of gatewayEntry(catalog, gatewayKey)?.dashboard_links ?? []) {
    let matches = false;
    try {
      matches = new RegExp(link.id_pattern).test(id);
    } catch {
      continue;
    }
    if (!matches) continue;
    const template = livemode === "live" ? link.live_url : link.test_url;
    return template.replace("{id}", encodeURIComponent(id));
  }
  return null;
}
