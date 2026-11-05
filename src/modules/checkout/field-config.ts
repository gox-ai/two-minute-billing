/**
 * Checkout field matrix — which of the fields hosted checkout collects show, hide,
 * or are required (0245).
 *
 * ── THREE states ──────────────────────────────────────────────────────────────
 * Every field is `show | hide | mandatory`. Read-only, pre-filled-parameter and
 * shipping-inheritance states are absent deliberately, not by oversight:
 * `read_only` needs a pre-populated value the mint does not carry, `hidden_parameter`
 * needs a caller-supplied value channel this checkout has no slot for, and the
 * shipping section takes one switch (`shipping.address`) rather than a state per field:
 * the buyer either copies the billing address or types a whole one. See
 * `.claude/MEMORY.md` (2026-09-08) for the recorded decision.
 *
 * ── This is ALSO the AVS control ──────────────────────────────────────────────
 * AVS is not a second screen here. It is checked gateway-side — we already send address +
 * `postal_code` to Stripe — so the only real lever is whether `postal_code` is actually
 * collected. Setting `billing.postal_code` to `mandatory` on this matrix IS switching on
 * ZIP verification.
 *
 * ── Shape and style ────────────────────────────────────────────────────────────
 * Modelled on `resolveStorefrontConfig` (`./storefront-config.ts`) and
 * `resolveCreditsFlexibility` (`modules/customers/credits-flexibility.ts`): one nullable
 * jsonb column on `businesses`, a PURE resolver, a docblock per field naming its default,
 * and the house rule that **only an explicit, VALID value opts out** — checked against
 * the literal union, never truthiness, so a malformed stored value (a typo, a stale
 * fourth state from a rolled-back build) resolves to that field's own default rather than
 * silently becoming permissive.
 *
 * ── Why the defaults are NOT uniform ───────────────────────────────────────────
 * Every default here is today's `checkoutCustomerBody` zod contract (`checkout-routes.ts`),
 * field by field — a business that never touches this screen must see the exact
 * requiredness it has always had:
 *   - `billing.line1`   → today `z.string().min(1)`      → **mandatory**
 *   - `billing.country` → today `z.string().length(2)`   → **mandatory**
 *   - `billing.city` / `billing.state_code` / `billing.postal_code` → **mandatory** (0334):
 *     the old completeness check required them unconditionally, so `show` was never
 *     honoured. Region and postal code apply only where the country has them
 *     (`addressRequirementIssues` in `./address-field-rules.ts`).
 *   - every other field → today `.optional()`            → **show**
 *
 * `billing.country` can never be `hide` (0334): it decides the region list and postal
 * format. A stored `hide` resolves to the default.
 *   - `invoice.po_number` → not collected before 0243     → **hide**, and this matrix
 *     never overrides `storefront_config.collect_po_number` (`./storefront-config.ts`):
 *     that switch decides whether the field is on the form AT ALL; this one only decides
 *     its requiredness once it is.
 *   - `shipping.address` → a SECTION switch, not collected before 0360 → **hide**.
 *     `show` = the buyer may add a shipping address; `mandatory` = they must. What a sent
 *     address must hold is fixed: {@link SHIPPING_ADDRESS_REQUIREMENTS}.
 */

/** Show / hide / require, per checkout field. */
export type CheckoutFieldState = "show" | "hide" | "mandatory";

/** The fields hosted checkout actually collects. */
export type CheckoutFieldKey =
  | "customer.first_name"
  | "customer.last_name"
  | "customer.email"
  | "customer.phone"
  | "customer.company"
  | "customer.tax_registration_number"
  | "billing.line1"
  | "billing.line2"
  | "billing.line3"
  | "billing.city"
  | "billing.state"
  | "billing.state_code"
  | "billing.postal_code"
  | "billing.country"
  | "invoice.po_number"
  | "shipping.address";

const CHECKOUT_FIELD_KEYS: readonly CheckoutFieldKey[] = [
  "customer.first_name",
  "customer.last_name",
  "customer.email",
  "customer.phone",
  "customer.company",
  "customer.tax_registration_number",
  "billing.line1",
  "billing.line2",
  "billing.line3",
  "billing.city",
  "billing.state",
  "billing.state_code",
  "billing.postal_code",
  "billing.country",
  "invoice.po_number",
  "shipping.address",
];

const FIELD_STATES: readonly CheckoutFieldState[] = ["show", "hide", "mandatory"];

/** The fully-resolved matrix: every key, always present. */
export type CheckoutFieldConfig = Record<CheckoutFieldKey, CheckoutFieldState>;

/** Today's zod contract, reproduced field by field. See the file docblock for why. */
export const DEFAULT_CHECKOUT_FIELD_CONFIG: CheckoutFieldConfig = {
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

/** The stored jsonb shape: a flat, partial map of the same keys to unknown. */
type StoredCheckoutFieldConfig = Partial<Record<CheckoutFieldKey, unknown>>;

/**
 * One key's stored value → its resolved state. Only an explicit member of
 * `FIELD_STATES` opts out of the default; anything else (absent, `null`, a typo, a
 * number, a stale state from a future build) resolves to that key's own default —
 * checked by literal membership, never by truthiness, so e.g. the string `"false"`
 * cannot be mistaken for a meaningful value.
 */
function resolveOne(raw: unknown, fallback: CheckoutFieldState): CheckoutFieldState {
  return typeof raw === "string" && (FIELD_STATES as readonly string[]).includes(raw)
    ? (raw as CheckoutFieldState)
    : fallback;
}

/**
 * Resolve a business's effective checkout field matrix. Pure; a null / absent /
 * malformed stored value resolves to {@link DEFAULT_CHECKOUT_FIELD_CONFIG} — exactly the
 * requiredness `checkoutCustomerBody` enforced before this column existed.
 */
export function resolveCheckoutFieldConfig(
  biz: { checkoutFieldConfig?: unknown } | null | undefined,
): CheckoutFieldConfig {
  const raw = (biz?.checkoutFieldConfig ?? null) as StoredCheckoutFieldConfig | null;
  const out = {} as CheckoutFieldConfig;
  for (const key of CHECKOUT_FIELD_KEYS) {
    out[key] = resolveOne(raw?.[key], DEFAULT_CHECKOUT_FIELD_CONFIG[key]);
  }
  if (out["billing.country"] === "hide")
    out["billing.country"] = DEFAULT_CHECKOUT_FIELD_CONFIG["billing.country"];
  return out;
}

/** Is this field required on the buyer's page? The route's single source of truth. */
export function isRequired(cfg: CheckoutFieldConfig, key: CheckoutFieldKey): boolean {
  return cfg[key] === "mandatory";
}

/**
 * Is this field hidden? A hidden field must not be required (enforced by construction:
 * `mandatory` and `hide` are distinct states in the union, so a field cannot be both),
 * and a caller sending one anyway is not refused by the route — see `checkout-routes.ts`
 * for what it does with the value instead.
 */
export function isHidden(cfg: CheckoutFieldConfig, key: CheckoutFieldKey): boolean {
  return cfg[key] === "hide";
}

// ── Address-shaped keys ──────────────────────────────────────────────────────
// Requiredness of these is checked by `addressRequirementIssues` (`./address-field-rules.ts`),
// shared with the portal.

/**
 * The (snake_case) property `checkoutCustomerBody.address` carries each address-shaped
 * matrix key under. `customer.email` and `customer.tax_registration_number` are NOT here
 * — they are not address-shaped fields, and the route checks them separately.
 */
export const ADDRESS_MATRIX_FIELDS = [
  { key: "customer.first_name", field: "first_name" },
  { key: "customer.last_name", field: "last_name" },
  { key: "customer.phone", field: "phone" },
  { key: "customer.company", field: "company" },
  { key: "billing.line1", field: "line1" },
  { key: "billing.line2", field: "line2" },
  { key: "billing.line3", field: "line3" },
  { key: "billing.city", field: "city" },
  { key: "billing.state", field: "state" },
  { key: "billing.state_code", field: "state_code" },
  { key: "billing.postal_code", field: "postal_code" },
  { key: "billing.country", field: "country" },
] as const satisfies ReadonlyArray<{ key: CheckoutFieldKey; field: string }>;

export type AddressMatrixField = (typeof ADDRESS_MATRIX_FIELDS)[number]["field"];

/** The address-shaped matrix keys, shared by the checkout and portal matrices. */
export type AddressMatrixKey = (typeof ADDRESS_MATRIX_FIELDS)[number]["key"];

/**
 * What a shipping address must hold, fed to `addressRequirementIssues`: line1, city and
 * country always; region and postal code where the country has them. Contact fields
 * are optional.
 */
export const SHIPPING_ADDRESS_REQUIREMENTS: Partial<Record<AddressMatrixKey, CheckoutFieldState>> =
  {
    "billing.line1": "mandatory",
    "billing.city": "mandatory",
    "billing.state_code": "mandatory",
    "billing.postal_code": "mandatory",
    "billing.country": "mandatory",
  };
