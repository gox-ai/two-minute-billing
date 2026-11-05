import type {
  AddressFieldLocks,
  CheckoutFieldKey,
  CheckoutFieldState,
  PortalFieldKey,
  PortalFieldState,
} from "@/lib/api";

// Shared by the page, its form and its action. Mirrors src/modules/checkout/field-config.ts.

/** Mirrors `DEFAULT_CHECKOUT_FIELD_CONFIG`. */
export const CHECKOUT_DEFAULTS: Record<CheckoutFieldKey, CheckoutFieldState> = {
  "customer.first_name": "show",
  "customer.last_name": "show",
  "customer.email": "show",
  "customer.phone": "show",
  "customer.company": "show",
  "customer.tax_registration_number": "show",
  "billing.line1": "mandatory",
  "billing.line2": "show",
  "billing.line3": "show",
  "billing.city": "mandatory",
  "billing.state": "show",
  "billing.state_code": "mandatory",
  "billing.postal_code": "mandatory",
  "billing.country": "mandatory",
  "invoice.po_number": "hide",
  "shipping.address": "hide",
};

/** Mirrors the engine's portal defaults. */
export const PORTAL_DEFAULTS: Record<PortalFieldKey, PortalFieldState> = {
  "customer.first_name": "show",
  "customer.last_name": "show",
  "customer.phone": "mandatory",
  "customer.company": "show",
  "customer.tax_registration_number": "show",
  "billing.line1": "mandatory",
  "billing.line2": "show",
  "billing.line3": "show",
  "billing.city": "mandatory",
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

/** Country decides the region list and the postal format, so it is never hidden. */
export const neverHidden = (k: string) => k === "billing.country";

/** Tax setup forces these to Required on both surfaces. */
export function lockedBy(locks: AddressFieldLocks | null | undefined, k: string): string | null {
  if (k === "billing.country" && locks?.country)
    return "Tax is set up, so country must stay required.";
  if (k === "billing.state_code" && locks?.state_code)
    return "GST is set up, so state must stay required.";
  return null;
}

/** Only an explicit valid value opts out of the default; a lock wins over both. */
export function resolveCheckout(
  cfg: Partial<Record<CheckoutFieldKey, CheckoutFieldState>> | null | undefined,
  locks: AddressFieldLocks | null | undefined,
): Record<CheckoutFieldKey, CheckoutFieldState> {
  return Object.fromEntries(
    CHECKOUT_KEYS.map((k) => {
      const raw = cfg?.[k];
      const ok =
        raw !== undefined && CHECKOUT_STATES.includes(raw) && !(raw === "hide" && neverHidden(k));
      return [k, lockedBy(locks, k) ? "mandatory" : ok ? raw : CHECKOUT_DEFAULTS[k]];
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
      const ok =
        raw !== undefined && PORTAL_STATES.includes(raw) && !(raw === "hide" && neverHidden(k));
      return [k, lockedBy(locks, k) ? "mandatory" : ok ? raw : PORTAL_DEFAULTS[k]];
    }),
  ) as Record<PortalFieldKey, PortalFieldState>;
}
