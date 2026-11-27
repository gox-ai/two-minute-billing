import type {
  AddressFieldLocks,
  CheckoutFieldKey,
  CheckoutFieldState,
  PortalFieldKey,
  PortalFieldState,
} from "@/lib/api";

// Shared by the page, its form and its action. Mirrors src/modules/checkout/field-config.ts;
// test/unit/field-matrix-mirror.test.ts fails when the defaults below drift from the engine.

/** Mirrors `DEFAULT_CHECKOUT_FIELD_CONFIG`. */
export const CHECKOUT_DEFAULTS: Record<CheckoutFieldKey, CheckoutFieldState> = {
  "customer.first_name": "show",
  "customer.last_name": "show",
  "customer.email": "show",
  "customer.phone": "show",
  "customer.company": "show",
  "customer.tax_registration_number": "show",
  "billing.line1": "show",
  "billing.line2": "show",
  "billing.line3": "show",
  "billing.city": "show",
  "billing.state": "show",
  "billing.state_code": "mandatory",
  "billing.postal_code": "mandatory",
  "billing.country": "mandatory",
  "invoice.po_number": "hide",
  "shipping.address": "hide",
};

/** Mirrors the engine's portal defaults. */
export const PORTAL_DEFAULTS: Record<PortalFieldKey, PortalFieldState> = {
  "customer.first_name": "mandatory",
  "customer.last_name": "show",
  "customer.phone": "show",
  "customer.company": "show",
  "customer.tax_registration_number": "show",
  "billing.line1": "show",
  "billing.line2": "show",
  "billing.line3": "show",
  "billing.city": "show",
  "billing.state": "show",
  "billing.state_code": "mandatory",
  "billing.postal_code": "mandatory",
  "billing.country": "mandatory",
};

export const CHECKOUT_KEYS = Object.keys(CHECKOUT_DEFAULTS) as CheckoutFieldKey[];
export const PORTAL_KEYS = Object.keys(PORTAL_DEFAULTS) as PortalFieldKey[];

/** The form posts each portal select under this name; checkout selects post the bare key. */
export const portalInputName = (k: PortalFieldKey) => `portal.${k}`;

export const CHECKOUT_STATES: readonly CheckoutFieldState[] = ["show", "hide", "mandatory"];
export const PORTAL_STATES: readonly PortalFieldState[] = [
  "show",
  "hide",
  "mandatory",
  "read_only",
];

/**
 * The checkout asks for a name unless it is hidden: there is no optional name there, so a
 * stored "show" reads as Required (it always behaved so).
 */
export const NAME_KEY = "customer.first_name";

/** Tax setup or the payment gateway forces these to Required on both surfaces. */
export function lockedBy(locks: AddressFieldLocks | null | undefined, k: string): string | null {
  if (k === "billing.country" && locks?.country)
    return "Tax is set up, so country must stay required.";
  if (k === "billing.country" && locks?.gateway_address)
    return "A Stripe account in India takes your payments. It needs the buyer's country, so country must stay required.";
  if (k === "billing.state_code" && locks?.state_code)
    return "GST is set up, so state must stay required.";
  return null;
}

/** A payment gateway needs this field from some buyers, so it stays visible and editable. */
export function keptVisibleBy(
  locks: AddressFieldLocks | null | undefined,
  k: string,
): string | null {
  if (!locks?.gateway_address) return null;
  if (locks.gateway_street_fill) {
    if (k === NAME_KEY)
      return "A Stripe account in India takes your payments. Buyers outside India must give their name, so this field cannot be hidden.";
    if (k === "billing.postal_code" || k === "billing.city")
      return "A Stripe account in India takes your payments. We make the street for buyers outside India from their city and state, so this field cannot be hidden.";
    return null;
  }
  if (k === "billing.line1" || k === NAME_KEY)
    return "A Stripe account in India takes your payments. Buyers outside India must give their name and street address, so this field cannot be hidden.";
  return null;
}

const keptOut = (state: string | undefined) => state === "hide" || state === "read_only";

/** Only an explicit valid value opts out of the default; a lock wins over both. */
export function resolveCheckout(
  cfg: Partial<Record<CheckoutFieldKey, CheckoutFieldState>> | null | undefined,
  locks: AddressFieldLocks | null | undefined,
): Record<CheckoutFieldKey, CheckoutFieldState> {
  return Object.fromEntries(
    CHECKOUT_KEYS.map((k) => {
      const raw = cfg?.[k];
      const ok = raw !== undefined && CHECKOUT_STATES.includes(raw);
      const v = lockedBy(locks, k) ? "mandatory" : ok ? raw : CHECKOUT_DEFAULTS[k];
      const kept = keptVisibleBy(locks, k) && keptOut(v) ? "show" : v;
      return [k, k === NAME_KEY && kept === "show" ? "mandatory" : kept];
    }),
  ) as Record<CheckoutFieldKey, CheckoutFieldState>;
}

export function resolvePortal(
  cfg: Partial<Record<PortalFieldKey, PortalFieldState>> | null | undefined,
  locks: AddressFieldLocks | null | undefined,
): Record<PortalFieldKey, PortalFieldState> {
  return Object.fromEntries(
    PORTAL_KEYS.map((k) => {
      const raw = cfg?.[k];
      const ok = raw !== undefined && PORTAL_STATES.includes(raw);
      const v = lockedBy(locks, k) ? "mandatory" : ok ? raw : PORTAL_DEFAULTS[k];
      return [k, keptVisibleBy(locks, k) && keptOut(v) ? "show" : v];
    }),
  ) as Record<PortalFieldKey, PortalFieldState>;
}
