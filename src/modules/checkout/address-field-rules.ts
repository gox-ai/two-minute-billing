/**
 * Address field rules shared by hosted checkout and the buyer portal (0334).
 *
 * - The PORTAL matrix: the checkout's address keys plus `customer.tax_registration_number`,
 *   with a fourth state, `read_only` — the portal edits a customer that already exists, so a
 *   stored value is there to show and keep.
 * - The tax guard: a business with tax set up must collect the country (and, under GST, the
 *   state), whatever the matrix says. Applied at runtime and refused at save time.
 * - `addressRequirementIssues`: the config-driven completeness check both routes run.
 *
 * Pure. The tax regimes come in from the caller (`liveTaxRegimes` in `modules/tax`).
 */
import { countryFor, subdivisionName, subdivisionsFor } from "@/platform/geo";
import {
  ADDRESS_MATRIX_FIELDS,
  type AddressMatrixField,
  type AddressMatrixKey,
  type CheckoutFieldConfig,
} from "./field-config";

const blank = (v: string | null | undefined) => !(v ?? "").trim();

// ── Portal matrix ─────────────────────────────────────────────────────────────

export type PortalFieldState = "show" | "hide" | "mandatory" | "read_only";

export type PortalFieldKey = AddressMatrixKey | "customer.tax_registration_number";

const PORTAL_FIELD_STATES: readonly PortalFieldState[] = ["show", "hide", "mandatory", "read_only"];

export type PortalFieldConfig = Record<PortalFieldKey, PortalFieldState>;

/**
 * What the portal form requires when a business has stored nothing: the contact name, the
 * country and the postal code (tax needs the last two). Line 1, city and phone are optional;
 * the state is derived from the postal code, and stays required under a GST lock.
 */
export const DEFAULT_PORTAL_FIELD_CONFIG: PortalFieldConfig = {
  "customer.first_name": "mandatory",
  "customer.last_name": "show",
  "customer.phone": "show",
  "customer.company": "show",
  "billing.line1": "show",
  "billing.line2": "show",
  "billing.line3": "show",
  "billing.city": "show",
  "billing.state": "show",
  "billing.state_code": "mandatory",
  "billing.postal_code": "mandatory",
  "billing.country": "mandatory",
  "customer.tax_registration_number": "show",
};

export const PORTAL_FIELD_KEYS = Object.keys(DEFAULT_PORTAL_FIELD_CONFIG) as PortalFieldKey[];

/**
 * Stored jsonb → every key resolved. Only a valid state opts out of a key's default. A hidden
 * country is allowed unless a lock keeps it (`withAddressFieldLocks`).
 */
export function resolvePortalFieldConfig(
  biz: { portalFieldConfig?: unknown } | null | undefined,
): PortalFieldConfig {
  const raw = biz?.portalFieldConfig;
  const stored =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as PortalFieldConfig;
  for (const key of PORTAL_FIELD_KEYS) {
    const v = stored[key];
    out[key] =
      typeof v === "string" && (PORTAL_FIELD_STATES as readonly string[]).includes(v)
        ? (v as PortalFieldState)
        : DEFAULT_PORTAL_FIELD_CONFIG[key];
  }
  return out;
}

/** Portal keys whose incoming value is ignored: the stored value stays. */
export function isPortalKeyLocked(cfg: PortalFieldConfig, key: PortalFieldKey): boolean {
  return cfg[key] === "hide" || cfg[key] === "read_only";
}

/**
 * `billing.state` and `billing.state_code` are one region: kept only when BOTH are locked,
 * so a stored name never sits next to a new code.
 */
export function isPortalRegionLocked(cfg: PortalFieldConfig): boolean {
  return isPortalKeyLocked(cfg, "billing.state") && isPortalKeyLocked(cfg, "billing.state_code");
}

/**
 * The address a portal save stores: incoming values for editable keys, stored values for
 * hidden/read-only ones. An editable region takes name and code from the input together;
 * a code without a name gets the name derived from the code.
 */
export function mergePortalAddress(
  cfg: PortalFieldConfig,
  stored: Record<AddressMatrixField, string | null>,
  incoming: Partial<Record<AddressMatrixField, string | null>>,
): { address: Record<AddressMatrixField, string | null>; keptAny: boolean } {
  const address = { ...stored };
  let keptAny = false;
  for (const { key, field } of ADDRESS_MATRIX_FIELDS) {
    if (field === "state" || field === "state_code") continue;
    if (isPortalKeyLocked(cfg, key)) keptAny = true;
    else address[field] = incoming[field] ?? null;
  }
  if (isPortalRegionLocked(cfg)) {
    keptAny = true;
  } else {
    address.state_code = incoming.state_code ?? null;
    address.state = incoming.state ?? null;
    if (blank(address.state) && !blank(address.state_code) && address.country) {
      address.state = subdivisionName(address.country, address.state_code);
    }
  }
  return { address, keptAny };
}

/**
 * The add-card gate (`billing_details_complete`) and the inline form behind it: the fields
 * still missing before a payment method can be saved. A billing name is needed unless the
 * first name is hidden (any usable one counts: `hasName`); everything else follows this surface's effective config
 * through `addressRequirementIssues`, so the gate and the save check cannot disagree.
 */
export function billingDetailsMissing(
  cfg: Partial<Record<AddressMatrixKey, string>>,
  hasName: boolean,
  address: RequirementAddress,
  rules: GatewayAddressRules = {},
): AddressMatrixField[] {
  const missing = addressRequirementIssues(cfg, address, rules)
    .map((i) => i.field)
    .filter((f) => f !== "first_name");
  // A hidden first name means the business does not ask for a name at all.
  return hasName || !nameAsked(cfg) ? missing : ["first_name", ...missing];
}

/** False only when the business hides the first name: then no name is asked or required. */
export function nameAsked(cfg: Partial<Record<AddressMatrixKey, string>>): boolean {
  return cfg["customer.first_name"] !== "hide";
}

export function billingDetailsComplete(
  cfg: Partial<Record<AddressMatrixKey, string>>,
  hasName: boolean,
  address: RequirementAddress,
  rules: GatewayAddressRules = {},
): boolean {
  return billingDetailsMissing(cfg, hasName, address, rules).length === 0;
}

// ── Tax guard ─────────────────────────────────────────────────────────────────

/** Keys the tax setup forces to `mandatory`. Same shape on the business and portal payloads. */
export interface AddressFieldLocks {
  /** Any live tax region. */
  country: boolean;
  /** Any live tax region with `regime = 'gst'`. */
  state_code: boolean;
  /**
   * A payment gateway needs the name, street and country from some buyers
   * (`GatewayAddressRules.streetRequiredOutside`): country stays required, and first name and
   * line 1 may not be hidden, or read-only in the portal, or those buyers could never give them.
   */
  gateway_address: boolean;
  /**
   * With `gateway_address`: the business fills line 1 for those buyers (`fill_export_street`), so
   * line 1 may be hidden and the postal code and city, which the fill is built from, stay visible.
   */
  gateway_street_fill: boolean;
}

export const NO_ADDRESS_FIELD_LOCKS: AddressFieldLocks = {
  country: false,
  state_code: false,
  gateway_address: false,
  gateway_street_fill: false,
};

/** The business's live tax regimes and gateway rules → the locks they impose. */
export function addressFieldLocksFor(
  regimes: readonly string[],
  rules: GatewayAddressRules = {},
): AddressFieldLocks {
  return {
    country: regimes.length > 0,
    state_code: regimes.includes("gst"),
    gateway_address: Boolean(rules.streetRequiredOutside),
    gateway_street_fill: Boolean(rules.streetRequiredOutside && rules.streetFill),
  };
}

const lockedOut = (state: string | undefined) => state === "hide" || state === "read_only";

/** Keys a gateway lock keeps visible and editable (see `AddressFieldLocks.gateway_address`). */
export function gatewayKeptVisible(locks: AddressFieldLocks): readonly AddressMatrixKey[] {
  if (!locks.gateway_address) return [];
  return locks.gateway_street_fill
    ? ["customer.first_name", "billing.postal_code", "billing.city"]
    : ["customer.first_name", "billing.line1"];
}

/** Effective config = stored config with the locked keys forced to `mandatory`. */
export function withAddressFieldLocks<C extends CheckoutFieldConfig | PortalFieldConfig>(
  cfg: C,
  locks: AddressFieldLocks,
): C {
  const out = { ...cfg };
  if (locks.country) out["billing.country"] = "mandatory";
  if (locks.state_code) out["billing.state_code"] = "mandatory";
  if (locks.gateway_address) {
    out["billing.country"] = "mandatory";
    for (const k of gatewayKeptVisible(locks)) if (lockedOut(out[k])) out[k] = "show";
  }
  return out;
}

/**
 * The config a buyer's page applies: the locks, then lines 2 and 3 hidden with a hidden line 1
 * (a second street line without a first one reads as a mistake). The stored values of lines 2
 * and 3 are kept, so showing line 1 again brings them back.
 */
export function buyerFieldConfig<C extends CheckoutFieldConfig | PortalFieldConfig>(
  cfg: C,
  locks: AddressFieldLocks,
): C {
  const out = withAddressFieldLocks(cfg, locks);
  if (out["billing.line1"] !== "hide") return out;
  return { ...out, "billing.line2": "hide", "billing.line3": "hide" };
}

/**
 * Save-time guard. Takes the RESOLVED config about to be stored; returns the STE message
 * for the first locked key that is not `mandatory`, or null.
 */
export function addressFieldLockViolation(
  cfg: CheckoutFieldConfig | PortalFieldConfig,
  locks: AddressFieldLocks,
): string | null {
  if (locks.country && cfg["billing.country"] !== "mandatory") {
    return "Billing country must stay required while tax is set up.";
  }
  if (locks.state_code && cfg["billing.state_code"] !== "mandatory") {
    return "State must stay required while GST is set up.";
  }
  if (locks.gateway_address && cfg["billing.country"] !== "mandatory") {
    return "Billing country must stay required while a Stripe account in India takes your payments.";
  }
  if (gatewayKeptVisible(locks).some((k) => lockedOut(cfg[k]))) {
    return locks.gateway_street_fill
      ? "First name, postal code and city must stay visible while a Stripe account in India takes your payments and we fill the street."
      : "First name and address line 1 must stay visible while a Stripe account in India takes your payments.";
  }
  return null;
}

// ── Requiredness ──────────────────────────────────────────────────────────────

export type RequirementAddress = Partial<Record<AddressMatrixField | "zip", string | null>>;

/** What the business's payment gateway needs on top of the field config. */
export interface GatewayAddressRules {
  /**
   * A payer whose country is not this one must give address line 1 (`streetAddressRequiredOutside`
   * on the adapter: Stripe India refuses a foreign card without it). Null/absent = no rule.
   */
  streetRequiredOutside?: string | null;
  /**
   * The business fills line 1 from the city and state for such a buyer
   * (`storefront_config.fill_export_street`), so the postal code (which fills both) is asked for
   * instead of the street.
   */
  streetFill?: boolean;
}

export interface AddressRequirementIssue {
  field: AddressMatrixField;
  message: string;
}

const LABELS: Record<AddressMatrixField, string> = {
  first_name: "First name",
  last_name: "Last name",
  phone: "Phone",
  company: "Company",
  line1: "Address line 1",
  line2: "Address line 2",
  line3: "Address line 3",
  city: "City",
  state: "State",
  state_code: "State",
  postal_code: "Postal code",
  country: "Country",
};

/**
 * Missing required fields for this config. Region and postal code are required only where
 * the country has them; city, region and postal code only once a country is given.
 * Format is not checked here (`addressRefinement` does that).
 */
export function addressRequirementIssues(
  cfg: Partial<Record<AddressMatrixKey, string>>,
  address: RequirementAddress,
  rules: GatewayAddressRules = {},
): AddressRequirementIssue[] {
  const issues: AddressRequirementIssue[] = [];
  const required = (key: AddressMatrixKey) => cfg[key] === "mandatory";
  const raw = (address.country ?? "").trim();
  const country = raw ? countryFor(raw) : null;

  for (const { key, field } of ADDRESS_MATRIX_FIELDS) {
    if (field === "city" || field === "state" || field === "state_code" || field === "postal_code")
      continue;
    if (required(key) && blank(address[field])) {
      issues.push({ field, message: `${LABELS[field]} is required.` });
    }
  }
  if (!country) return issues;

  const home = rules.streetRequiredOutside?.toUpperCase();
  if (home && country.code !== home && !required("billing.line1") && blank(address.line1)) {
    if (!rules.streetFill) {
      issues.push({ field: "line1", message: `Address line 1 is required for ${country.name}.` });
    } else if (
      blank(address.city) &&
      blank(address.postal_code) &&
      blank(address.zip) &&
      // A mandatory postal code is reported below already.
      !(country.hasPostalCode && required("billing.postal_code"))
    ) {
      // Line 1 is built from the city and state, which the postal code fills in. A postal code
      // the buyer cannot edit leaves the street (kept editable by the gateway lock).
      const postalAsked = !["hide", "read_only"].includes(cfg["billing.postal_code"] ?? "");
      issues.push(
        country.hasPostalCode && postalAsked
          ? {
              field: "postal_code",
              message: `${country.postalLabel} is required for ${country.name}.`,
            }
          : !country.hasPostalCode && !["hide", "read_only"].includes(cfg["billing.city"] ?? "")
            ? { field: "city", message: `City is required for ${country.name}.` }
            : { field: "line1", message: `Address line 1 is required for ${country.name}.` },
      );
    }
  }
  if (required("billing.city") && blank(address.city)) {
    issues.push({ field: "city", message: "City is required." });
  }
  const regionRequired = required("billing.state_code") || required("billing.state");
  const hasRegions = (subdivisionsFor(country.code) ?? []).length > 0;
  if (regionRequired && hasRegions && blank(address.state_code) && blank(address.state)) {
    issues.push({
      field: required("billing.state_code") ? "state_code" : "state",
      message: `${country.regionLabel} is required for ${country.name}.`,
    });
  }
  if (
    required("billing.postal_code") &&
    country.hasPostalCode &&
    blank(address.postal_code) &&
    blank(address.zip)
  ) {
    issues.push({
      field: "postal_code",
      message: `${country.postalLabel} is required for ${country.name}.`,
    });
  }
  return issues;
}
