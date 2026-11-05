/**
 * Per-business tax settings (0489), stored in `businesses.tax_settings`:
 *
 *   { behavior_by_currency?: { "<CUR>": "inclusive" | "exclusive" },
 *     seller_tax_ids?: { "<CC>": "<registration id>" },
 *     rounding?: "per_invoice_total" | "per_line" }
 *
 * NULL, an absent key or a malformed value resolves to today's behaviour:
 *   · no per-currency price type — a new price with no `tax_behavior` is exclusive;
 *   · no destination ids — the invoice prints the issuer's own tax id;
 *   · `per_invoice_total` — each component is rounded once on the pooled base, then
 *     allocated across the lines (`computeInvoiceTax`).
 *
 * The customer-level override lives on `customers.tax_behavior`, not here.
 */

export type TaxBehavior = "inclusive" | "exclusive";
export const TAX_BEHAVIORS = ["inclusive", "exclusive"] as const;

export const TAX_ROUNDINGS = ["per_invoice_total", "per_line"] as const;
export type TaxRounding = (typeof TAX_ROUNDINGS)[number];
export const DEFAULT_TAX_ROUNDING: TaxRounding = "per_invoice_total";

/** Most destinations a business can list. A registration per country, not per state. */
export const MAX_SELLER_TAX_IDS = 60;
export const MAX_SELLER_TAX_ID_LENGTH = 64;

/** VAT-number prefixes that are not ISO country codes, with the code customers carry. */
export const VAT_PREFIX_ISO: Readonly<Record<string, string>> = { UK: "GB", EL: "GR" };

export interface TaxSettings {
  behaviorByCurrency: Record<string, TaxBehavior>;
  sellerTaxIds: Record<string, string>;
  rounding: TaxRounding;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pure. Only an explicit valid value opts out of today's behaviour. */
export function resolveTaxSettings(raw: unknown): TaxSettings {
  const src = isObject(raw) ? raw : {};
  const behaviorByCurrency: Record<string, TaxBehavior> = {};
  if (isObject(src.behavior_by_currency)) {
    for (const [cur, v] of Object.entries(src.behavior_by_currency)) {
      if (CURRENCY_RE.test(cur) && (v === "inclusive" || v === "exclusive"))
        behaviorByCurrency[cur] = v;
    }
  }
  const sellerTaxIds: Record<string, string> = {};
  if (isObject(src.seller_tax_ids)) {
    for (const [cc, v] of Object.entries(src.seller_tax_ids)) {
      if (!COUNTRY_RE.test(cc) || typeof v !== "string") continue;
      const id = v.trim();
      if (id && id.length <= MAX_SELLER_TAX_ID_LENGTH) sellerTaxIds[cc] = id;
      if (Object.keys(sellerTaxIds).length >= MAX_SELLER_TAX_IDS) break;
    }
  }
  const rounding = (TAX_ROUNDINGS as readonly unknown[]).includes(src.rounding)
    ? (src.rounding as TaxRounding)
    : DEFAULT_TAX_ROUNDING;
  return { behaviorByCurrency, sellerTaxIds, rounding };
}

/** The API's view: the three business fields, resolved. */
export function serializeTaxSettings(raw: unknown): {
  tax_behavior_by_currency: Record<string, TaxBehavior>;
  seller_tax_ids: Record<string, string>;
  tax_rounding: TaxRounding;
} {
  const s = resolveTaxSettings(raw);
  return {
    tax_behavior_by_currency: s.behaviorByCurrency,
    seller_tax_ids: s.sellerTaxIds,
    tax_rounding: s.rounding,
  };
}

/**
 * Apply a PATCH. Each present key replaces its whole sub-value (a map is sent whole, so a
 * removed currency or country is removed); `null` clears that key back to today's
 * behaviour. Returns undefined when the patch names none of the three keys.
 */
export function mergeTaxSettings(
  stored: unknown,
  patch: {
    tax_behavior_by_currency?: Record<string, TaxBehavior> | null;
    seller_tax_ids?: Record<string, string> | null;
    tax_rounding?: TaxRounding;
  },
): Record<string, unknown> | undefined {
  const touched =
    patch.tax_behavior_by_currency !== undefined ||
    patch.seller_tax_ids !== undefined ||
    patch.tax_rounding !== undefined;
  if (!touched) return undefined;
  const next: Record<string, unknown> = isObject(stored) ? { ...stored } : {};
  if (patch.tax_behavior_by_currency !== undefined) {
    if (patch.tax_behavior_by_currency === null) delete next.behavior_by_currency;
    else next.behavior_by_currency = patch.tax_behavior_by_currency;
  }
  if (patch.seller_tax_ids !== undefined) {
    if (patch.seller_tax_ids === null) delete next.seller_tax_ids;
    else
      next.seller_tax_ids = Object.fromEntries(
        Object.entries(patch.seller_tax_ids)
          .map(([cc, id]) => [cc, id.trim()] as const)
          .filter(([, id]) => id.length > 0),
      );
  }
  if (patch.tax_rounding !== undefined) next.rounding = patch.tax_rounding;
  return next;
}

/** The price type a new price in `currency` takes when the request names none. Null = no rule. */
export function newPriceTaxBehavior(raw: unknown, currency: string): TaxBehavior | null {
  return resolveTaxSettings(raw).behaviorByCurrency[currency.toUpperCase()] ?? null;
}

/** The seller registration to print for a supply to `country`, or null to keep the issuer's. */
export function sellerTaxIdFor(raw: unknown, country: string | null | undefined): string | null {
  if (!country) return null;
  return resolveTaxSettings(raw).sellerTaxIds[country.toUpperCase()] ?? null;
}
