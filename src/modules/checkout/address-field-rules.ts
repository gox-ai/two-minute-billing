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

/** What the portal form required before 0334 (its `requireCore`: first name and phone included). */
export const DEFAULT_PORTAL_FIELD_CONFIG: PortalFieldConfig = {
  "customer.first_name": "mandatory",
  "customer.last_name": "show",
  "customer.phone": "mandatory",
  "customer.company": "show",
  "billing.line1": "mandatory",
  "billing.line2": "show",
  "billing.line3": "show",
  "billing.city": "mandatory",
  "billing.state": "show",
  "billing.state_code": "mandatory",
  "billing.postal_code": "mandatory",
  "billing.country": "mandatory",
  "customer.tax_registration_number": "show",
};

export const PORTAL_FIELD_KEYS = Object.keys(DEFAULT_PORTAL_FIELD_CONFIG) as PortalFieldKey[];

/**
 * Stored jsonb → every key resolved. Only a valid state opts out of a key's default, and
 * `billing.country` never resolves to `hide`.
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
  if (out["billing.country"] === "hide") {
    out["billing.country"] = DEFAULT_PORTAL_FIELD_CONFIG["billing.country"];
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
 * The add-card gate (`billing_details_complete`): a billing name, plus line1 and country
 * only where this surface's effective config makes them mandatory.
 */
export function billingDetailsComplete(
  cfg: Partial<Record<AddressMatrixKey, string>>,
  hasName: boolean,
  a: { line1: string | null | undefined; country: string | null | undefined },
): boolean {
  return (
    hasName &&
    (cfg["billing.line1"] !== "mandatory" || !blank(a.line1)) &&
    (cfg["billing.country"] !== "mandatory" || !blank(a.country))
  );
}

// ── Tax guard ─────────────────────────────────────────────────────────────────

/** Keys the tax setup forces to `mandatory`. Same shape on the business and portal payloads. */
export interface AddressFieldLocks {
  /** Any live tax region. */
  country: boolean;
  /** Any live tax region with `regime = 'gst'`. */
  state_code: boolean;
}

export const NO_ADDRESS_FIELD_LOCKS: AddressFieldLocks = { country: false, state_code: false };

/** Regimes of the business's live tax regions → the locks they impose. */
export function addressFieldLocksFor(regimes: readonly string[]): AddressFieldLocks {
  return { country: regimes.length > 0, state_code: regimes.includes("gst") };
}

/** Effective config = stored config with the locked keys forced to `mandatory`. */
export function withAddressFieldLocks<C extends CheckoutFieldConfig | PortalFieldConfig>(
  cfg: C,
  locks: AddressFieldLocks,
): C {
  const out = { ...cfg };
  if (locks.country) out["billing.country"] = "mandatory";
  if (locks.state_code) out["billing.state_code"] = "mandatory";
  return out;
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
  return null;
}

// ── Requiredness ──────────────────────────────────────────────────────────────

export type RequirementAddress = Partial<Record<AddressMatrixField | "zip", string | null>>;

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
