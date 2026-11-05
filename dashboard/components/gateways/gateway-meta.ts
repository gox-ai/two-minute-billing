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
 * A deep link to this object on the GATEWAY's own dashboard, or `null` when we have
 * no confirmed URL for that gateway and id shape — the id then renders as plain text
 * rather than as a link that lands on someone's 404.
 *
 * - **Stripe** puts the MODE in the path (`/test/…`, omitted for live). Confirmed by
 *   Stripe's own `request_log_url` in our gateway request logs
 *   (`https://dashboard.stripe.com/acct_…/test/workbench/logs?…`). A charge and a
 *   payment intent share `/payments/<id>`. We do not store the `acct_…` id, so the
 *   link resolves against whichever Stripe account the operator is signed into.
 *   A REFUND (`re_…`) gets no link on purpose: Stripe has no refund page of its own —
 *   its docs route you to a refund through its payment's timeline.
 * - **Razorpay** has no mode segment; its dashboard's own Test/Live toggle decides.
 * - **PayPal** splits by HOST (`www.paypal.com` / `www.sandbox.paypal.com`) and only a
 *   CAPTURE id resolves. `captureResult` falls back to the ORDER id when PayPal returns
 *   no capture object, and an order id opens nothing in Activity — PayPal's own docs
 *   separate the two by length ("a valid transaction ID is 17 characters long, except
 *   for an order ID, which is 19"), so the length is the test. ⚠️ The `/activity/payment/`
 *   path itself is the ONE shape here not confirmed against a document or a live URL:
 *   PayPal publishes no per-transaction deep link. If it misses, this line is the fix.
 * - The offline / simulated keys (`tmtest`, `offline_*`, `shadow`) get nothing: there is
 *   no gateway dashboard to reach.
 */
export function gatewayObjectUrl(
  gatewayKey: string | null,
  idAtGateway: string | null,
  livemode: "live" | "test" | null,
): string | null {
  const id = idAtGateway?.trim();
  if (!id) return null;
  switch (gatewayKey) {
    case "stripe": {
      const mode = livemode === "live" ? "" : "/test";
      return id.startsWith("pi_") || id.startsWith("ch_")
        ? `https://dashboard.stripe.com${mode}/payments/${encodeURIComponent(id)}`
        : null;
    }
    case "razorpay":
      return id.startsWith("pay_")
        ? `https://dashboard.razorpay.com/app/payments/${encodeURIComponent(id)}`
        : null;
    case "paypal": {
      const host = livemode === "live" ? "www.paypal.com" : "www.sandbox.paypal.com";
      return /^[A-Z0-9]{17}$/i.test(id)
        ? `https://${host}/activity/payment/${encodeURIComponent(id)}`
        : null;
    }
    default:
      return null;
  }
}
