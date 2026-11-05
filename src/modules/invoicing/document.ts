import type { LineRating } from "@/modules/metering/rating";
import { sellerTaxIdFor } from "@/modules/tax/settings";
import { and, eq, inArray } from "drizzle-orm";
import { currencyExponent } from "@/platform/currency";
import { fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import { withTenant, type Tx } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { billingContact, invoiceContactName, type NameFields } from "@/modules/customers/names";
import {
  invoices,
  invoiceLineItems,
  customers,
  businesses,
  organizations,
  payments,
  subscriptions,
  invoiceLineDiscounts,
  appliedCoupons,
  coupons,
  couponSetCodes,
  creditNotes,
  customFieldDefinitions,
} from "@db/schema";
import {
  resolveInvoiceCustomization,
  formatSellerAddress,
  taxRegLabelFor,
  MAX_INVOICE_CUSTOM_FIELDS,
  type InvoiceCustomization,
} from "./customization";
import { loadPaymentInstructions, selectPaymentInstructions } from "./payment-instructions";
import { customerTaxIdOf, fromFrozen, invoiceNotesOf } from "./billing-snapshot";

/**
 * A fully-resolved, presentation-ready invoice. Money stays in integer minor
 * units (bigint) + a 3-char currency — formatting happens in the renderers
 * (PDF / HTML), never here, so both outputs share ONE source of truth and can
 * never drift. Built by {@link assembleInvoiceDocument}.
 */
const log = createLogger("invoicing.document");

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
  HKD: "HK$",
  NZD: "NZ$",
  AED: "د.إ",
};

/**
 * Symbol for a currency code, or the code + space when we don't have one.
 *
 * That space is a NON-BREAKING one (\u00A0), matching what `Intl.NumberFormat` emits for
 * the same case. Two reasons, and the second is why it is worth a comment: a code and its
 * amount should never wrap onto separate lines, and the other surfaces this customer sees
 * are rendered by Intl — a plain space here made the invoice disagree with the email and
 * the portal for every currency without a symbol, invisibly.
 */
export function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency}\u00A0`;
}

/**
 * Format integer minor units as a grouped, symbol-prefixed amount (e.g. ₹1,485.62).
 *
 * Kept on bigint rather than delegating to `platform/currency.formatMoney`: this renders
 * a TAX DOCUMENT, and going through `Number` would silently lose precision on a large
 * enough amount. The divisor is the currency's exponent, not a hardcoded 100 — a
 * zero-decimal currency has no minor part at all, so `¥1000` must print as `¥1,000` and
 * not `¥10.00`, which is a 100× misstatement on a document a tax authority may read.
 */
export function formatMoney(minor: bigint, currency: string): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const exp = currencyExponent(currency);
  const scale = 10n ** BigInt(exp);
  const whole = (abs / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = neg ? "-" : "";
  if (exp === 0) return `${sign}${currencySymbol(currency)}${whole}`;
  const frac = (abs % scale).toString().padStart(exp, "0");
  return `${sign}${currencySymbol(currency)}${whole}.${frac}`;
}

/**
 * A line's quantity and unit price as the dashboard shows them: the decimal fields when
 * stored (meter lines), else the integer ones. Every significant place of the rate is kept.
 */
export function lineFigures(
  l: {
    quantity: number;
    quantityDecimal: string | null;
    unitAmountMinor: bigint;
    unitAmountDecimal: string | null;
  },
  currency: string,
): { quantity: string; unitPrice: string } {
  const quantity =
    l.quantityDecimal != null
      ? groupDecimal(formatFixed12(fixed12FromNumeric(l.quantityDecimal)))
      : String(l.quantity);
  if (l.unitAmountDecimal == null)
    return { quantity, unitPrice: formatMoney(l.unitAmountMinor, currency) };
  const exp = currencyExponent(currency);
  const minor = fixed12FromNumeric(l.unitAmountDecimal);
  const neg = minor < 0n;
  const major = formatFixed12(((neg ? -minor : minor) * 10n ** BigInt(12 - exp)) / 10n ** 12n);
  const [whole, frac = ""] = major.split(".");
  const shown = exp === 0 && !frac ? whole! : `${whole}.${frac.padEnd(exp, "0")}`;
  return {
    quantity,
    unitPrice: `${neg ? "-" : ""}${currencySymbol(currency)}${groupDecimal(shown)}`,
  };
}

const groupDecimal = (d: string) => {
  const [whole, frac] = d.split(".");
  const g = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${g}.${frac}` : g;
};

/** "Jul 24, 2026" in the given IANA timezone. */
export function formatDateInTz(d: Date | null, timeZone: string): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(d));
}

// Node's ICU 'short' timeZoneName gives a fixed offset ("GMT+5:30") for most
// zones rather than the common abbreviation an invoice wants ("IST").
// Cover the common IANA zones explicitly; fall back to the ICU
// offset string for anything else (still correct, just less colloquial).
const TZ_ABBREVIATIONS: Record<string, string> = {
  "Asia/Kolkata": "IST",
  "Asia/Calcutta": "IST",
  "America/New_York": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Los_Angeles": "PT",
  "Europe/London": "GMT/BST",
  "Europe/Paris": "CET",
  "Europe/Berlin": "CET",
  "Asia/Singapore": "SGT",
  "Asia/Tokyo": "JST",
  "Asia/Dubai": "GST",
  "Australia/Sydney": "AEST",
  UTC: "UTC",
};

/** "23 Jul 2026 22:27 IST" in the given IANA timezone. */
export function formatDateTimeInTz(d: Date, timeZone: string): string {
  const dt = new Date(d);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(dt);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dt);
  const tz =
    TZ_ABBREVIATIONS[timeZone] ??
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
      .formatToParts(dt)
      .find((p) => p.type === "timeZoneName")?.value ??
    timeZone;
  return `${date} ${time} ${tz}`;
}

function paymentMethodLabel(providerKey: string, _providerChargeId: string | null): string {
  if (providerKey === "offline") return "Offline Payment";
  return providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
}

export interface InvoiceDocument {
  seller: {
    name: string;
    addressLines: string[];
    supportEmail: string | null;
    website: string | null;
    logoUrl: string | null;
    /**
     * The square mark. The PDF falls back to it when the wordmark cannot be embedded —
     * pdfkit takes PNG/JPEG only, and a merchant whose wordmark is an SVG
     * would otherwise get no mark at all on the one document a customer keeps.
     */
    iconUrl: string | null;
    taxRegId: string | null;
    /**
     * What to CALL `taxRegId` — "GSTIN", "VAT" or "Tax ID", from the issuer's country.
     * Resolved here rather than in the renderers, which used to hardcode "GSTIN" and so
     * mislabelled every non-Indian seller's number. See `taxRegLabelFor`.
     */
    taxRegLabel: string;
    /** IANA timezone for rendering dates/times on the invoice (default UTC). */
    timezone: string;
  };
  /**
   * Big word top-right — "INVOICE" / "TAX INVOICE" / "CREDIT NOTE" / "REFUND", resolved
   * from the business's customization by whichever assembler built this document.
   *
   * Lives HERE rather than in `DocumentLabels` because it is the one piece of document
   * wording a merchant can change, and two sources for it would let the PDF and the HTML
   * disagree about what the document is called.
   */
  title: string;
  billTo: {
    /**
     * Customer public id (cus_…), shown as "Customer ID". NULL when the business turns
     * that field off; the renderers skip the row rather than printing an empty label.
     */
    id: string | null;
    name: string;
    email: string | null;
    addressLines: string[];
    taxRegId: string | null;
    /** What to CALL `taxRegId` for THIS customer's country. See the seller's field. */
    taxRegLabel: string;
  };
  /**
   * SHIP TO. `invoices.shipping_address` has been snapshotted all along but was never
   * printed; empty unless the business turns the field on AND an address was captured.
   */
  shipTo: { name: string | null; addressLines: string[] };
  /**
   * Subscription context for the invoice, when it bills one. Each field is independently
   * nullable because the business toggles them independently — an all-null subscription
   * block is dropped by the renderers rather than drawn as an empty heading.
   */
  subscription: {
    id: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    nextBillingDate: Date | null;
  } | null;
  /** Succeeded payments applied to this invoice (for the "Payments" footer). */
  payments: Array<{ amountMinor: bigint; paidAt: Date; method: string }>;
  meta: {
    /** Human invoice number ("INV-42") when assigned, else the public id. */
    number: string;
    /** System public id (inv_…) — always present, shown as the reference. */
    id: string;
    /** Null when the business hides the status chip. */
    status: string | null;
    issuedDate: Date;
    dueDate: Date | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    poNumber: string | null;
    notes: string | null;
    /**
     * On a CREDIT NOTE, the issue date of the invoice being credited — the "Invoice date"
     * field on the Credit Notes tab. Always null on an invoice, whose own date is
     * `issuedDate`.
     */
    relatedInvoiceDate: Date | null;
    /**
     * Human numbers of the credit notes issued against this invoice. Empty unless the
     * business turns the field on, so an invoice with credit notes renders exactly as it
     * did before 0239 by default.
     */
    creditNoteNumbers: string[];
    /**
     * The issue-time FX snapshot (0228), as "1 <base> = <rate> <currency>". Null unless the
     * business prints it AND the document is in another currency than the one the rate is
     * against AND a rate was recorded.
     */
    exchangeRate: { base: string; rate: string; currency: string } | null;
  };
  /**
   * Merchant-picked custom fields (`custom_field_definitions.show_on_invoice`), already
   * resolved to label/value pairs and capped at MAX_INVOICE_CUSTOM_FIELDS. Empty unless
   * enabled, so the renderers draw the block only when it has content — the same rule the
   * Discount and HSN/SAC columns follow.
   */
  customFields: Array<{ label: string; value: string }>;
  /**
   * Signature block, shown on invoices AND credit notes. Null when the business has set
   * neither an image nor a caption. `imageUrl` goes through `loadLogo`, so it inherits
   * the same PNG/JPEG/SVG handling and short timeout as the logo.
   */
  signature: {
    imageUrl: string | null;
    caption: string | null;
    /** Which bottom corner it is pinned to. */
    position: "bottom_right" | "bottom_left";
  } | null;
  /**
   * How an offline payer is told where to send the money. Empty when the business has
   * configured none, which is every business until it does — so the document is
   * unchanged by default. Selection rules: `./payment-instructions.ts`.
   */
  paymentInstructions: Array<{
    kind: string;
    title: string;
    description: string | null;
    fields: Array<{ label: string; value: string }>;
  }>;
  chargeLines: Array<{
    description: string;
    period: { start: Date; end: Date } | null;
    quantity: number;
    unitAmountMinor: bigint;
    /** Meter lines: the units and rate as decimals (`lineFigures` prints them). */
    quantityDecimal: string | null;
    unitAmountDecimal: string | null;
    /** GROSS, before any discount — `line_items[].amount`. */
    amountMinor: bigint;
    /**
     * Discount attributed to this line, BOTH stages — `line_items[].discount_amount`, and
     * the "Discount" column on the printed invoice. Positive magnitude. 0 for every
     * line on an undiscounted invoice, so the column is only rendered when some line has one.
     */
    discountMinor: bigint;
    /**
     * The part of `discountMinor` that is ALREADY inside `totals.subtotalMinor` — the
     * item-level stage. The renderers print `amountMinor − this` in the Amount column, so
     * the line total reads correctly and Σ Amount IS the Sub Total.
     * The document-level remainder is not netted here: it applies to the subtotal, not to
     * a line, and already has its own row in `discountLines`.
     */
    itemLevelDiscountMinor: bigint;
    /**
     * HSN/SAC classification snapshotted at issue (India GST). Null outside that regime
     * and on anything issued before the codes shipped, so — exactly like `discountMinor`
     * above — the renderers show the column only when some line actually carries one, and
     * a non-Indian invoice looks precisely as it did before.
     */
    taxCode: string | null;
    /** How a usage line was rated (0380): tier rows and level, printed under the line. */
    rating?: LineRating | null;
  }>;
  /**
   * Aggregate discount rows shown BELOW the subtotal — the DOCUMENT-level stage only
   * (0169). The item-level stage is already inside `totals.subtotalMinor`, so printing it
   * here too would show the same money twice and the document would not add up.
   */
  discountLines: Array<{ description: string; amountMinor: bigint }>;
  /**
   * The "DISCOUNT" footer — one entry per (discount, stage), naming what actually
   * reduced this invoice. The totals ladder shows the document-level money and the Amount
   * column absorbs the item-level money, but neither says WHY, and an item-level coupon
   * was invisible on the printed invoice entirely.
   *
   * All three sources appear, because a customer can be looking at any of them: a catalog
   * COUPON (by the code they redeemed, set code included), a MANUAL discount an operator
   * keyed in, and the customer's own PROMOTIONAL CREDITS.
   */
  discountDetails: Array<{
    source: "coupon" | "manual" | "promotional_credits";
    /** The code the customer would quote back — a set's own code where there is one. */
    code: string | null;
    /** `invoice_name ?? code`; printed only when it differs from `code`. */
    label: string | null;
    /** 1-based positions in `chargeLines`, printed as "applied on line item #1". */
    lineNumbers: number[];
    /** Positive magnitude. */
    amountMinor: bigint;
    /** Already inside the Sub Total, or applied to it. */
    scope: "item_level" | "document_level";
  }>;
  taxLines: Array<{ label: string; amountMinor: bigint }>;
  /** Round-off delta (kind='rounding'); may be ±, 0 when no rounding applied. */
  roundingMinor: bigint;
  totals: {
    subtotalMinor: bigint;
    discountTotalMinor: bigint;
    taxTotalMinor: bigint;
    roundingMinor: bigint;
    withholdingMinor: bigint;
    /**
     * `invoice.total`: `subtotalMinor − discountTotalMinor + taxTotalMinor
     * (± rounding)`. NET of the promotional slice, which is one of the `discountLines`
     * — NOT the stored `invoices.total_minor`, which is the gross taxed claim the ledger
     * debits to AR.
     */
    totalMinor: bigint;
    /**
     * The POST-tax buckets only. Promotional credit is applied pre-tax and prints as a
     * discount above the total, so it is deliberately absent here: carrying it in both
     * places is how the same money gets subtracted twice on one document.
     */
    creditsApplied: { refundable: bigint; excess: bigint };
    amountPaidMinor: bigint;
    amountDueMinor: bigint;
    currency: string;
  };
}

/** Charge line kinds that appear in the main line-item table (not discount/tax/rounding). */
const CHARGE_KINDS = new Set(["recurring", "proration", "usage", "one_time"]);

/**
 * Whether a charge line reaches the printed document, given `invoice.show_zero_value_lines`.
 *
 * "Zero-value" is the line's GROSS `amountMinor` — the same pre-discount figure
 * `chargeLines[].amountMinor` documents as the Amount-column basis — not the amount net of
 * any item-level discount. A fully-discounted but non-zero-priced line still explains what
 * the discount footer applied to, so it always prints; only a line billed at 0 to begin with
 * (a free plan, a $0 add-on, a proration slice that rounds to nothing) is suppressible. See
 * the field's docblock (`./customization.ts`) for the full reasoning.
 */
export function shouldPrintChargeLine(showZeroValueLines: boolean, amountMinor: bigint): boolean {
  return showZeroValueLines || amountMinor !== 0n;
}

/**
 * The STREET lines of an organisation-style address jsonb (`businesses.address`, and the
 * geographic half of an invoice's `billing_address` snapshot). No contact name: the seller
 * block is headed by the business's own name and must never sprout a person's.
 */
/**
 * NOT `@/platform/geo`: that registry is loaded from the database on API boot, so it is
 * cold in a PDF rendered by a worker or a script and every country silently stayed a
 * code. `Intl` needs no warm-up and ships with Node's full ICU.
 */
const COUNTRY_NAMES = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

/**
 * "IN" → "India". An invoice is read by people and by tax officers, and a bare alpha-2
 * is neither. Falls back to the stored value, so an unknown or already-spelled country
 * still prints rather than vanishing.
 */
function countryLabel(v: unknown): string | null {
  const raw = typeof v === "string" && v.trim() ? v.trim() : null;
  if (!raw) return null;
  if (raw.length !== 2) return raw;
  const named = COUNTRY_NAMES?.of(raw.toUpperCase());
  // `of()` answers "Unknown Region" for a code it does not know, which is worse on an
  // invoice than the code itself — and it echoes the input back when ICU is trimmed.
  return !named || named === raw.toUpperCase() || /unknown/i.test(named) ? raw : named;
}

export function bizAddressLines(address: unknown): string[] {
  if (!address || typeof address !== "object") return [];
  const a = address as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const cityLine = [str(a.city), str(a.state), str(a.postal_code)].filter(Boolean).join(", ");
  // line3 is accepted by `bizAddress` and rendered by the settings form, so it has to
  // print too — otherwise a merchant fills it in and it silently never appears.
  return [
    str(a.line1),
    str(a.line2),
    str(a.line3),
    cityLine || null,
    countryLabel(a.country),
  ].filter((l): l is string => !!l);
}

/**
 * The two lines that HEAD an address block: the address's own contact, then their company.
 *
 * Both belong above the street lines (see `customers/names.ts` for the rule) and we printed
 * neither — so a buyer whose invoices go to "Accounts Payable"
 * at a differently-named legal entity had that entity appear nowhere on its own tax document,
 * which is the one place an input-tax-credit claim has to find it.
 *
 * ⚠️ `printedName` is a de-duplication guard, not a preference. Every renderer draws
 * `billTo.name` immediately above these lines, and for the ordinary customer — one person, no
 * separate billing contact — the address contact IS that name, so emitting it again gives a
 * two-line stutter. Any line equal to it is dropped, which also covers the company-only
 * customer, whose company won `invoiceContactName` and would otherwise print twice. The
 * company is never suppressed on its own account: it is a different fact from the name.
 */
function contactLines(
  contact: { first_name: string | null; last_name: string | null; company: string | null },
  printedName: string | null,
): string[] {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || null;
  return [name, contact.company].filter((l): l is string => !!l && l !== printedName);
}

/**
 * The name the BILL-TO header prints, and the ONE place that decides it.
 *
 * ⚠️ The resolution deliberately differs by path, and the next reader will want to
 * "simplify" it back — don't. When the invoice carries its own `billing_address` SNAPSHOT,
 * the name comes from that snapshot's contact and the live customer row is not consulted at
 * all: the invoice prints its own `billing_address` contact. Resolving the
 * header from the live row while the address block below it came from the snapshot put TWO
 * different names on one document the moment a customer changed their billing contact after
 * issue — the new one in the header, the old one as an address line — and the de-duplication
 * guard could not fire, because they differ. It also defeated the point of snapshotting: a
 * current row must not rewrite an already-issued document, and that has to cover the name as
 * much as the street.
 *
 * A snapshot with no contact at all (only street lines — the shape `verify-invoicing-parity`
 * writes) falls through to the customer, so taking an address snapshot never blanks a name
 * that was printing before.
 */
export function billToName(
  snapshot: unknown,
  cus: (NameFields & { publicId: string }) | null,
  fallbackId: string,
): string {
  return (
    snapshotContactName(snapshot) ?? (cus ? (invoiceContactName(cus) ?? cus.publicId) : fallbackId)
  );
}

/**
 * The alpha-2 country on an address jsonb, or null. Used to caption a tax registration
 * number; deliberately tolerant, because an address with no country is common and must
 * fall back to the neutral label rather than throwing on a billing path.
 */
function addressCountry(address: unknown): string | null {
  if (!address || typeof address !== "object") return null;
  const c = (address as Record<string, unknown>).country;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

/** The contact name held by an address snapshot: joined first+last, else the company. */
export function snapshotContactName(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const a = snapshot as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = [str(a.first_name), str(a.last_name)].filter(Boolean).join(" ").trim() || null;
  return name ?? str(a.company);
}

/**
 * An invoice's own `billing_address` SNAPSHOT, printed in full. The snapshot carries
 * `first_name`/`last_name`/`company` (the PATCH body accepts them verbatim), so those are read
 * off the object rather than off the customer — the whole point of a snapshot is that the
 * customer's current row cannot rewrite an already-issued document.
 */
export function snapshotAddressLines(address: unknown, printedName: string | null): string[] {
  if (!address || typeof address !== "object") return [];
  const a = address as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const contact = {
    first_name: str(a.first_name),
    last_name: str(a.last_name),
    company: str(a.company),
  };
  return [...contactLines(contact, printedName), ...bizAddressLines(address)];
}

/** The customer's CURRENT address, printed — the fallback when no snapshot was ever taken. */
export function customerAddressLines(
  c: typeof customers.$inferSelect,
  printedName: string | null,
): string[] {
  const str = (v: string | null) => (v && v.trim() ? v.trim() : null);
  const cityLine = [str(c.city), str(c.state), str(c.postalCode)].filter(Boolean).join(", ");
  return [
    // `billingContact` resolves the address's own contact and falls back to the account
    // holder, so a customer who never filled the contact in still gets a name and company
    // onto the document instead of a bare street line.
    ...contactLines(billingContact(c), printedName),
    ...[
      str(c.addressLine1),
      str(c.addressLine2),
      str(c.addressLine3),
      cityLine || null,
      countryLabel(c.country),
    ].filter((l): l is string => !!l),
  ];
}

/**
 * Assemble the presentation model for one invoice — seller, bill-to, meta, and
 * the pipeline-produced line groups (charges / discounts / taxes / rounding)
 * plus fully-derived totals. Returns null when the invoice doesn't exist for
 * this (org, business).
 *
 * The tax / discount / rounding breakdown is NOT recomputed here: those already
 * live as invoice_line_items keyed by `kind`, so we just group the stored rows.
 * Amount-paid is the sum of succeeded payments against the invoice (same source
 * as the serializer's `paidMinor`).
 */
/**
 * Resolve the custom fields a business has chosen to print, as label/value pairs.
 *
 * Ordered by the definition's own `position` and capped at
 * {@link MAX_INVOICE_CUSTOM_FIELDS} — the cap lives here rather than in a constraint
 * because "at most three rows per business" is not expressible as a partial unique index,
 * and a trigger enforcing it would fail an unrelated definition write.
 *
 * A definition whose value is absent, null or blank on this customer/subscription is
 * DROPPED rather than printed with an empty value: a labelled blank on an invoice reads
 * as missing data, and the merchant did not choose to say nothing.
 *
 * `archived` definitions are excluded — they reject new values, so printing them would
 * surface a field the merchant has retired.
 */
async function resolveDocumentCustomFields(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  businessId: string,
  values: { customer: unknown; subscription: unknown },
): Promise<Array<{ label: string; value: string }>> {
  const defs = await tx
    .select({
      entityType: customFieldDefinitions.entityType,
      apiName: customFieldDefinitions.apiName,
      label: customFieldDefinitions.label,
    })
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.businessId, businessId),
        eq(customFieldDefinitions.showOnInvoice, true),
        eq(customFieldDefinitions.archived, false),
      ),
    )
    .orderBy(customFieldDefinitions.position);

  const bag = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const sources: Record<string, Record<string, unknown>> = {
    customer: bag(values.customer),
    subscription: bag(values.subscription),
  };

  const out: Array<{ label: string; value: string }> = [];
  for (const d of defs) {
    if (out.length >= MAX_INVOICE_CUSTOM_FIELDS) break;
    const raw = sources[d.entityType]?.[d.apiName];
    if (raw === undefined || raw === null) continue;
    // Dates arrive as ISO strings and booleans as booleans; String() is right for every
    // dataType the definitions allow, and the value is escaped by the HTML renderer.
    const value = String(raw).trim();
    if (!value) continue;
    out.push({ label: d.label, value });
  }
  return out;
}

/**
 * The exchange-rate row a document prints, or null. Reads the row's own stamp, never the
 * business's current rate: a document states the rate it was issued at.
 */
export function printedExchangeRate(
  custom: InvoiceCustomization,
  doc: { currency: string; exchangeRate: string | null; exchangeRateBase: string | null },
): InvoiceDocument["meta"]["exchangeRate"] {
  if (!custom.common.showExchangeRate || !doc.exchangeRate || !doc.exchangeRateBase) return null;
  const base = doc.exchangeRateBase.trim().toUpperCase();
  const currency = doc.currency.toUpperCase();
  if (base === currency) return null;
  return { base, rate: printedRate(doc.exchangeRate), currency };
}

/**
 * A stored rate (`numeric(20,10)`, e.g. "94.9450549451") as printed: 4 decimal places, or 4
 * significant digits below 1 (VND→USD is 0.0000393), half up, trailing zeros dropped. String
 * arithmetic, so no float ever touches it. The stored rate is not changed.
 */
export function printedRate(stored: string, minPlaces = 4): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(stored.trim());
  if (!m) return stored;
  const lead = /^0*$/.test(m[1]!) ? ((m[2] ?? "").match(/^0*/)?.[0].length ?? 0) : 0;
  const places = Math.max(minPlaces, lead + 4);
  const frac = (m[2] ?? "").padEnd(places + 1, "0").slice(0, places + 1);
  const scaled = (BigInt(m[1]! + frac) + 5n) / 10n;
  const digits = scaled.toString().padStart(places + 1, "0");
  const int = digits.slice(0, -places);
  const dec = digits.slice(-places).replace(/0+$/, "");
  return dec ? `${int}.${dec}` : int;
}

/**
 * The signature block, or null when the merchant has set neither half. Null rather than
 * a pair of nulls so the renderers can test one thing.
 */
function signatureBlock(custom: InvoiceCustomization): InvoiceDocument["signature"] {
  const { imageUrl, caption, position } = custom.signature;
  return imageUrl || caption ? { imageUrl, caption, position } : null;
}

/**
 * WHO ISSUES THIS BUSINESS'S DOCUMENTS. `businesses.invoice_issuer` = 'organization' heads
 * them with the registered entity: several businesses billing under one company is the
 * common Indian shape, the GSTIN belongs to the entity, and a buyer's input tax credit is
 * claimed against the number printed here. Invoices and credit notes share this, so a
 * note always names the same seller as the invoice it reverses.
 *
 * Returns the entity only when it is usable — an org with neither an address nor a tax id
 * would blank the seller block on a tax document, so the business stands in (logged).
 * The org is read only when asked for.
 */
export async function resolveDocumentIssuer(
  tx: Tx,
  orgId: string,
  biz: typeof businesses.$inferSelect | undefined,
): Promise<DocumentIssuer | null> {
  if (biz?.invoiceIssuer !== "organization") return null;
  const [issuer] = await tx
    .select({
      name: organizations.name,
      legalName: organizations.legalName,
      address: organizations.address,
      taxRegistrationNumber: organizations.taxRegistrationNumber,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (issuer && (issuer.address || issuer.taxRegistrationNumber)) return issuer;
  log.warn("invoice issuer is the organization but it has no address or tax id", {
    businessId: biz.id,
    impact: "FALLBACK: the business heads the document instead",
  });
  return null;
}

export interface DocumentIssuer {
  name: string;
  legalName: string | null;
  address: unknown;
  taxRegistrationNumber: string | null;
}

/**
 * The seller a document issued NOW prints — name, address, registration and its country —
 * what an invoice freezes at issue (0336/0337), so a later re-registration or a switch of
 * issuer cannot rewrite it. `id: ''` = no registration on file, itself the fact to freeze.
 */
export interface SellerAtIssue {
  name: string;
  address: unknown;
  id: string;
  country: string | null;
}

export async function sellerAtIssue(
  tx: Tx,
  orgId: string,
  biz: typeof businesses.$inferSelect | undefined,
  /** The customer's country. A seller tax id set for it (`tax_settings.seller_tax_ids`) wins. */
  destinationCountry?: string | null,
): Promise<SellerAtIssue> {
  const issuer = await resolveDocumentIssuer(tx, orgId, biz);
  const address = issuer ? issuer.address : (biz?.address ?? null);
  const destinationId = sellerTaxIdFor(biz?.taxSettings, destinationCountry);
  return {
    name: issuer ? (issuer.legalName ?? issuer.name) : (biz?.name ?? ""),
    address,
    id: destinationId ?? (issuer ? issuer.taxRegistrationNumber : biz?.taxRegistrationNumber) ?? "",
    // The label follows the registration's country (VAT for an EU id, GSTIN for India).
    country: destinationId ? destinationCountry!.toUpperCase() : addressCountry(address),
  };
}

/** The seller block with the identity frozen on the invoice, when one was. */
export function withFrozenSeller(
  seller: InvoiceDocument["seller"],
  inv: {
    sellerName: string | null;
    sellerAddress: unknown;
    sellerTaxId: string | null;
    sellerTaxCountry: string | null;
  },
  custom: InvoiceCustomization,
): InvoiceDocument["seller"] {
  if (inv.sellerTaxId == null) return seller;
  return {
    ...seller,
    ...(inv.sellerName ? { name: inv.sellerName } : {}),
    ...(inv.sellerAddress != null
      ? { addressLines: formatSellerAddress(bizAddressLines(inv.sellerAddress), custom.common) }
      : {}),
    taxRegId: inv.sellerTaxId || null,
    taxRegLabel: taxRegLabelFor(inv.sellerTaxCountry),
  };
}

/** The seller block for an invoice or a credit note, given the resolved issuer. */
export function documentSeller(
  biz: typeof businesses.$inferSelect | undefined,
  businessId: string,
  issuer: DocumentIssuer | null,
  custom: InvoiceCustomization,
): InvoiceDocument["seller"] {
  const address = issuer ? issuer.address : biz?.address;
  return {
    // Legal name first when the ENTITY issues — `organizations.name` is what the
    // operator calls the account, `legalName` is what a tax document must say.
    name: issuer ? (issuer.legalName ?? issuer.name) : (biz?.name ?? businessId),
    addressLines: formatSellerAddress(bizAddressLines(address), custom.common),
    supportEmail: biz?.supportEmail ?? null,
    website: biz?.website ?? null,
    // Brand and contact stay with the BUSINESS even when the ENTITY issues: a shared
    // registered company does not mean a shared support desk or a shared logo.
    logoUrl: biz?.logoUrl ?? null,
    iconUrl: biz?.iconUrl ?? null,
    taxRegId: issuer ? issuer.taxRegistrationNumber : (biz?.taxRegistrationNumber ?? null),
    // From the country on the address that supplied the number.
    taxRegLabel: taxRegLabelFor(addressCountry(address)),
    // Dates are billed in the BUSINESS's timezone whoever issues the document.
    timezone: biz?.timezone ?? "UTC",
  };
}

export async function assembleInvoiceDocument(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<InvoiceDocument | null> {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    if (!inv) return null;

    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    const issuer = await resolveDocumentIssuer(tx, orgId, biz);
    const [cus] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.businessId, businessId), eq(customers.id, inv.customerId)))
      .limit(1);
    const lines = await tx
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, inv.id))
      // `seq`, NOT `createdAt`: `defaultNow()` is TRANSACTION time, so every line of one
      // billing run shares it and this ordering did nothing. A customer downloading the same
      // invoice twice could get two different documents.
      .orderBy(invoiceLineItems.seq);

    // The (line, discount, stage) attribution behind the money — the same rows the API's
    // `discounts[]` is built from, loaded here so the PRINTED invoice can name its
    // discounts too. Until this, an item-level coupon left no trace on the document:
    // netted into the subtotal, with its code recorded only in the database.
    const shareRows = await tx
      .select()
      .from(invoiceLineDiscounts)
      .where(eq(invoiceLineDiscounts.invoiceId, inv.id));
    const acIds = [...new Set(shareRows.map((r) => r.appliedCouponId).filter((x) => x != null))];
    const sourceRows =
      acIds.length > 0
        ? await tx
            .select({
              id: appliedCoupons.id,
              source: appliedCoupons.source,
              code: coupons.code,
              invoiceName: coupons.invoiceName,
              // The redeemed set code beats the parent coupon's — see the API loader.
              setCode: couponSetCodes.code,
            })
            .from(appliedCoupons)
            .leftJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
            .leftJoin(couponSetCodes, eq(couponSetCodes.appliedCouponId, appliedCoupons.id))
            .where(inArray(appliedCoupons.id, acIds as string[]))
        : [];

    // Amount paid = sum of succeeded payments (cash actually collected).
    const payRows = await tx
      .select({
        amountMinor: payments.amountMinor,
        paidAt: payments.createdAt,
        providerKey: payments.providerKey,
        providerChargeId: payments.providerChargeId,
      })
      .from(payments)
      .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "succeeded")))
      .orderBy(payments.createdAt);
    const amountPaidMinor = payRows.reduce((s, p) => s + p.amountMinor, 0n);
    const paymentsList = payRows.map((p) => ({
      amountMinor: p.amountMinor,
      paidAt: p.paidAt,
      method: paymentMethodLabel(p.providerKey, p.providerChargeId),
    }));

    // Resolved once here: the gating below and the custom-field block both need it.
    const custom = resolveInvoiceCustomization(biz);

    // Subscription context (ID / billing period / next billing date), when billed.
    let subscription: InvoiceDocument["subscription"] = null;
    let subCustomFields: unknown = null;
    if (inv.subscriptionId) {
      const [sub] = await tx
        .select({
          publicId: subscriptions.publicId,
          customFields: subscriptions.customFields,
          currentPeriodStart: subscriptions.currentPeriodStart,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
        })
        .from(subscriptions)
        .where(eq(subscriptions.id, inv.subscriptionId))
        .limit(1);
      if (sub) {
        /**
         * THIS invoice's period — never the subscription's CURRENT one.
         *
         * An imported invoice object carries no top-level period; it lives on the line
         * items (`date_from`/`date_to`). So every imported invoice has
         * `invoices.period_start` NULL, and falling back to `currentPeriodStart` printed
         * TODAY's cycle on a document from a year ago — 1,927 invoices here, including
         * a whole migrated book.
         *
         * The line span is the same period wherever both exist (44,278 of 45,093 match
         * exactly, measured 2026-09-06); the remainder are prorations covering their own
         * window, which is the truer answer for those documents anyway.
         *
         * With no period on the invoice AND none on its lines (905 rows), this prints
         * NOTHING. A missing billing period is honest; the current cycle is a wrong fact
         * on a settled document.
         */
        const spans = lines.filter((l) => CHARGE_KINDS.has(l.kind) && l.periodStart && l.periodEnd);
        const periodStart =
          inv.periodStart ??
          (spans.length ? new Date(Math.min(...spans.map((l) => l.periodStart!.getTime()))) : null);
        // The period end is shown as the last covered day (next billing − 1 day).
        const rawEnd =
          inv.periodEnd ??
          (spans.length ? new Date(Math.max(...spans.map((l) => l.periodEnd!.getTime()))) : null);
        const periodEnd = rawEnd ? new Date(rawEnd.getTime() - 86_400_000) : null;
        // The next bill after THIS invoice, which is its own period end. The
        // subscription's `currentPeriodEnd` is a fact about today, not about this
        // document, and on a historical invoice it is simply wrong.
        subCustomFields = sub.customFields;
        /**
         * The three subscription rows are toggled independently, so each is nulled on its
         * own. An all-null block still exists as an object; the renderers drop the
         * heading when nothing under it survived, which is what keeps a business that
         * hides all three from getting a bare "SUBSCRIPTION" label.
         */
        // An interim usage invoice bills its term to the cut: the period is term start → the
        // cut's own day, and the next bill is the term's end, not the cut.
        const interim = inv.purpose === "usage_interim";
        const termEnd = interim
          ? (lines
              .map((l) => (l.rating as { period?: { end?: string } } | null)?.period?.end)
              .filter((e): e is string => typeof e === "string")
              .map((e) => new Date(e))[0] ??
            (sub.currentPeriodStart && inv.periodStart && sub.currentPeriodStart <= inv.periodStart
              ? sub.currentPeriodEnd
              : null))
          : null;
        subscription = {
          id: custom.common.showSubscriptionId ? sub.publicId : null,
          periodStart: custom.invoice.showBillingPeriod ? periodStart : null,
          periodEnd: custom.invoice.showBillingPeriod ? (interim ? rawEnd : periodEnd) : null,
          nextBillingDate: custom.invoice.showNextBilling ? (interim ? termEnd : rawEnd) : null,
        };
      }
    }

    /**
     * Credit notes raised against this invoice — the "Credit note number" field.
     * Only queried when the business asks for it: an invoice that hides the field must
     * not pay for a join it does not use, the same rule `resolveDocumentIssuer` follows.
     */
    const creditNoteNumbers = custom.invoice.showCreditNoteNumber
      ? (
          await tx
            .select({ number: creditNotes.number, publicId: creditNotes.publicId })
            .from(creditNotes)
            .where(eq(creditNotes.invoiceId, inv.id))
            .orderBy(creditNotes.createdAt)
        ).map((c) => c.number ?? c.publicId)
      : [];

    const customFields = custom.invoice.showCustomFields
      ? await resolveDocumentCustomFields(tx, businessId, {
          customer: cus?.customFields ?? null,
          subscription: subCustomFields,
        })
      : [];

    /**
     * Payment instructions. The billing country comes from the invoice's own address
     * SNAPSHOT first, for the same reason every other party field does: a customer moving
     * must not change which bank block an already-issued invoice showed.
     *
     * `preferredKind` maps the customer's stored provider onto an instruction kind, which
     * today means PayPal and nothing else — see the header of ./payment-instructions.ts
     * for why the unmatched case widens to "all" rather than narrowing to none.
     */
    const instructionRows = await loadPaymentInstructions(tx, businessId);
    const snapshotCountry =
      inv.billingAddress && typeof inv.billingAddress === "object"
        ? ((inv.billingAddress as Record<string, unknown>).country as string | undefined)
        : undefined;
    const paymentInstructionsForDoc = selectPaymentInstructions(
      instructionRows,
      custom.paymentInstructions,
      {
        currency: inv.currency,
        country: snapshotCountry ?? cus?.country ?? null,
        preferredKind: null,
      },
    );

    // Suppression happens BEFORE numbering: a suppressed line must not reach the document
    // at all (the module docblock's rule), and a line's "applied on line item #N" reference
    // must point at what actually printed. See `shouldPrintChargeLine` for what "zero-value"
    // means here.
    const printedChargeLines = lines
      .filter((l) => CHARGE_KINDS.has(l.kind))
      .filter((l) => shouldPrintChargeLine(custom.invoice.showZeroValueLines, l.amountMinor));
    const chargeLines = printedChargeLines.map((l) => ({
      description: l.description,
      period: l.periodStart && l.periodEnd ? { start: l.periodStart, end: l.periodEnd } : null,
      quantity: l.quantity,
      unitAmountMinor: l.unitAmountMinor,
      quantityDecimal: l.quantityDecimal != null ? String(l.quantityDecimal) : null,
      unitAmountDecimal: l.unitAmountDecimal != null ? String(l.unitAmountDecimal) : null,
      amountMinor: l.amountMinor,
      discountMinor: l.discountMinor ?? 0n,
      itemLevelDiscountMinor: shareRows
        .filter((sh) => sh.invoiceLineItemId === l.id && sh.scope === "item_level")
        .reduce((sum, sh) => sum + sh.amountMinor, 0n),
      taxCode: l.taxCode ?? null,
      rating: (l.rating as LineRating | null) ?? null,
    }));
    // Positions are 1-based over the PRINTED charge lines only — the same table the reader
    // is looking at, which excludes the synthetic discount/tax/rounding rows AND whatever
    // show_zero_value_lines just suppressed.
    const chargeLineNumber = new Map(printedChargeLines.map((l, i) => [l.id, i + 1] as const));
    // PROMOTIONAL CREDIT PRINTS AS A PRE-TAX DISCOUNT (2026-08-25). It has no
    // `kind='discount'` line item of its own — the column `invoices.total_minor` is the
    // GROSS taxed claim and `ops/invariants.ts` reconciles it against Σ line items, so a
    // line here would make that check fail — but it IS applied before tax by the engine,
    // and printing it below Total (which is what we used to do) left an India GST invoice
    // stating "IGST 18%  ₹3,225.24" under a Sub Total of ₹27,918.00, whose 18% is
    // ₹5,025.24. The taxable value the tax was actually charged on was nowhere on the
    // document. Synthesised at the head of the discount rows so the ladder reads
    //   Sub Total → discounts → tax → Total,
    // which is the arithmetic the engine performed
    // (`discounts[].entity_type = "promotional_credits"`).
    const promotionalDiscountMinor = inv.promotionalCreditsAppliedMinor ?? 0n;
    // Credit grants drawn before tax print the same way (design G3 §3.4). Post-tax grant
    // draws are a credit below the Total, like the buckets.
    const grantPreTaxMinor = inv.grantCreditsPreTaxMinor ?? 0n;
    const discountLines = [
      ...(promotionalDiscountMinor > 0n
        ? [{ description: "Promotional Credits", amountMinor: -promotionalDiscountMinor }]
        : []),
      ...(grantPreTaxMinor > 0n
        ? [{ description: "Credit grants", amountMinor: -grantPreTaxMinor }]
        : []),
      ...lines
        .filter((l) => l.kind === "discount")
        .map((l) => ({ description: l.description, amountMinor: l.amountMinor })),
    ];
    // The DISCOUNT footer. Aggregated per (applied discount, stage) exactly as the API's
    // `discounts[]` is, so the printed document and the API can never disagree about what
    // discounted this invoice.
    const detailByKey = new Map<
      string,
      InvoiceDocument["discountDetails"][number] & { lineIds: Set<string> }
    >();
    for (const sh of shareRows) {
      const src = sh.appliedCouponId ? sourceRows.find((r) => r.id === sh.appliedCouponId) : null;
      const key = `${sh.appliedCouponId ?? sh.label ?? ""}|${sh.scope}`;
      const code = src ? (src.setCode ?? src.code) : null;
      const acc = detailByKey.get(key) ?? {
        source: (src?.source === "manual" ? "manual" : "coupon") as "coupon" | "manual",
        code,
        // Only when it says something the code does not — otherwise the footer would
        // print the same string twice.
        label: src?.invoiceName && src.invoiceName !== code ? src.invoiceName : (sh.label ?? null),
        lineNumbers: [] as number[],
        amountMinor: 0n,
        scope: sh.scope as "item_level" | "document_level",
        lineIds: new Set<string>(),
      };
      acc.amountMinor += sh.amountMinor;
      if (sh.invoiceLineItemId) acc.lineIds.add(sh.invoiceLineItemId);
      detailByKey.set(key, acc);
    }
    const discountDetails: InvoiceDocument["discountDetails"] = [
      // The promotional slice leads, matching `discountLines` above.
      ...(promotionalDiscountMinor > 0n
        ? [
            {
              source: "promotional_credits" as const,
              code: null,
              label: "Promotional Credits",
              lineNumbers: [],
              amountMinor: promotionalDiscountMinor,
              scope: "document_level" as const,
            },
          ]
        : []),
      ...[...detailByKey.values()].map(({ lineIds, ...d }) => ({
        ...d,
        lineNumbers: [...lineIds]
          .map((id) => chargeLineNumber.get(id))
          .filter((n): n is number => n != null)
          .sort((x, y) => x - y),
      })),
    ];
    const taxLines = lines
      .filter((l) => l.kind === "tax")
      .map((l) => ({ label: l.description, amountMinor: l.amountMinor }));
    // Discount amounts are stored as negative contra lines — normalize the total
    // to a positive magnitude for the summary ("Discount −X").
    const discountTotalMinor = discountLines.reduce(
      (s, d) => s + (d.amountMinor < 0n ? -d.amountMinor : d.amountMinor),
      0n,
    );
    const taxTotalMinor = taxLines.reduce((s, t) => s + t.amountMinor, 0n);
    const roundingMinor = lines
      .filter((l) => l.kind === "rounding")
      .reduce((s, l) => s + l.amountMinor, 0n);

    // PO number: the real column wins. The metadata fallback stays for rows
    // imported before the column existed, which carried it in `metadata.po_number`.
    const md = (inv.metadata && typeof inv.metadata === "object" ? inv.metadata : {}) as Record<
      string,
      unknown
    >;
    const poNumber =
      inv.poNumber ??
      (typeof md.po_number === "string"
        ? md.po_number
        : typeof md.poNumber === "string"
          ? md.poNumber
          : null);
    // Notes: customer-level note wins, else the business default.
    const notes = fromFrozen(inv.notes, () => invoiceNotesOf(cus, biz));

    // BILL-TO IDENTITY. The name on the document is the BILLING ADDRESS CONTACT, not the
    // account holder — see `customers/names.ts`.
    // This used to read our own invented `customers.name` column
    // first and never look at the `billing_*` columns at all, so an invoice addressed to a
    // company's accounts-payable contact printed the person who signed up instead.
    // Resolved once here because the address block below needs it too, to avoid printing
    // the same name twice — and it MUST come from the same source as that block, which is
    // why `billToName` takes the snapshot: see its header.
    const printedName = billToName(inv.billingAddress, cus ?? null, inv.customerId);

    return {
      // "TAX INVOICE" is the India GST wording; `invoice` stays the default so nothing
      // changes for a business that has not chosen.
      title: custom.invoice.title === "tax_invoice" ? "TAX INVOICE" : "INVOICE",
      seller: withFrozenSeller(documentSeller(biz, businessId, issuer, custom), inv, custom),
      billTo: {
        id: custom.common.showCustomerId ? (cus?.publicId ?? inv.customerId) : null,
        // The NAME is not toggleable and deliberately so: the "Billing Address & Customer
        // VAT number" switch governs the address and the tax id, not who the document is
        // addressed to. An unaddressed invoice is not a document.
        name: printedName,
        email: cus?.email ?? null,
        // The invoice's own address SNAPSHOT wins over the customer's current
        // address: a customer moving house must not retroactively rewrite the
        // address printed on invoices already issued. Falls back to the customer
        // when no snapshot was ever taken.
        addressLines: !custom.common.showCustomerInfo
          ? []
          : inv.billingAddress
            ? snapshotAddressLines(inv.billingAddress, printedName)
            : cus
              ? customerAddressLines(cus, printedName)
              : [],
        // PRECEDENCE, and it matters for India: `tax_registration_number` is the
        // customer's own registration (GSTIN), collected where the region sets
        // `collect_registration_number`; `vat_number` is the EU B2B/VIES id with its own
        // validation lifecycle. They are different columns. This used to read vat_number
        // alone — the comment said "customers have no dedicated tax-reg column", true when
        // written and false since — so an Indian buyer's GSTIN never reached the invoice
        // it has to appear on, and their input tax credit could not be claimed against it.
        taxRegId: custom.common.showCustomerInfo
          ? fromFrozen(inv.customerTaxId, () => customerTaxIdOf(cus))
          : null,
        // Same snapshot-first precedence as the address itself: the label must describe
        // the country the invoice was issued to, not wherever the customer lives now.
        taxRegLabel: taxRegLabelFor(addressCountry(inv.billingAddress) ?? cus?.country),
      },
      /**
       * SHIP TO. Uses the invoice's own snapshot in preference to the customer's current
       * address, for the same reason the bill-to block does: a customer moving must not
       * rewrite a document already issued.
       */
      shipTo: custom.common.showShippingInfo
        ? (() => {
            const addr = inv.shippingAddress ?? cus?.shippingAddress ?? null;
            // `snapshotContactName` is the same resolver the bill-to header uses, and
            // passing its answer back as `printedName` gives the block the same
            // de-duplication: the contact is drawn as the heading, not twice.
            const name = snapshotContactName(addr);
            return { name, addressLines: addr ? snapshotAddressLines(addr, name) : [] };
          })()
        : { name: null, addressLines: [] },
      subscription,
      /**
       * The Payments / Refunds footer only. `totals.amountPaidMinor` is deliberately NOT
       * gated: it is a term of the arithmetic the document prints, and an invoice whose
       * ladder no longer reconciles is a worse outcome than one showing a payment the
       * merchant wanted hidden. The switch is `show_payment_stub` — the stub, not the
       * total.
       */
      payments: custom.common.showPaymentStub ? paymentsList : [],
      meta: {
        number: inv.number ?? inv.publicId,
        id: inv.publicId,
        status: custom.invoice.showStatus ? inv.status : null,
        issuedDate: inv.createdAt,
        dueDate: inv.dueDate,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        poNumber,
        notes,
        // An invoice has no "related invoice"; this slot is the credit note's.
        relatedInvoiceDate: null,
        creditNoteNumbers,
        exchangeRate: printedExchangeRate(custom, inv),
      },
      customFields,
      signature: signatureBlock(custom),
      paymentInstructions: paymentInstructionsForDoc,
      chargeLines,
      discountLines,
      discountDetails,
      taxLines,
      roundingMinor,
      totals: {
        subtotalMinor: inv.subtotalMinor,
        discountTotalMinor,
        taxTotalMinor,
        roundingMinor,
        withholdingMinor: inv.withholdingMinor ?? 0n,
        // NET of the promotional discount above — `invoice.total`, and the same number
        // `serializeInvoice` reports as `total_minor`. The stored column stays
        // the gross claim; see the comment on `promotionalDiscountMinor`.
        totalMinor: inv.totalMinor - promotionalDiscountMinor - grantPreTaxMinor,
        creditsApplied: {
          refundable: inv.refundableCreditsAppliedMinor ?? 0n,
          excess: inv.excessPaymentsAppliedMinor ?? 0n,
        },
        amountPaidMinor,
        // Remaining balance, matching the serializer's canonical semantics
        // (serialize.ts): the stored amount_due_minor is the ISSUE-TIME collectible,
        // so subtract cash already collected; a voided/written-off invoice owes 0.
        amountDueMinor:
          inv.status === "voided" || inv.writtenOff
            ? 0n
            : (() => {
                const due = (inv.amountDueMinor ?? inv.totalMinor) - amountPaidMinor;
                return due > 0n ? due : 0n;
              })(),
        currency: inv.currency,
      },
    };
  });
}
