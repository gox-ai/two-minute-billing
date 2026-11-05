/**
 * Invoice & Credit Note customization — what goes ON the printed document.
 *
 * Three tabs on the settings screen: *General Settings* / *Invoices* / *Credit Notes*.
 *
 * ── What this governs, and what it deliberately does not ─────────────────────
 * These settings decide what the PDF and the HTML view PRINT. They do NOT touch
 * `serialize.ts` — `invoice.customer_id` stays in the API resource whether or not the
 * document shows it. Conflating the two would make a presentation toggle silently
 * change an integration's payload.
 *
 * Consumed at exactly one place: `assembleInvoiceDocument` (`./document.ts`), which
 * already loads the business row. Suppressed fields leave that function as null / [] so
 * `renderInvoicePdf` and `renderInvoiceHtml` need no settings dependency of their own and
 * cannot drift apart. Credit notes inherit the whole mechanism because
 * `CreditNoteDocument` IS `InvoiceDocument`.
 *
 * ── Shape and style ─────────────────────────────────────────────────────────
 * Modelled on `resolveCreditsFlexibility` (`modules/customers/credits-flexibility.ts`)
 * and `resolveEmailConfig` (`modules/emails/config.ts`): one nullable jsonb column on
 * `businesses`, a PURE resolver, a docblock per field naming its default, and the house
 * rule that **only an explicit valid value opts out**. A null, absent or malformed stored
 * value resolves to DEFAULT_CUSTOMIZATION, which is precisely what the renderers did
 * before this column existed — so no existing invoice changes appearance until a merchant
 * touches the screen.
 *
 * That rule is why the three "not rendered today" flags default to FALSE
 * (`showShippingInfo`, `showCreditNoteNumber`, `showCustomFields`) while everything
 * already on the document defaults to TRUE. The defaults encode current behaviour, not a
 * view about what a good invoice shows.
 */

/** How the seller's address block is laid out. `expanded` is the historical rendering. */
export type AddressFormat = "expanded" | "single_line" | "custom";

/** Big word top-right of an invoice. India's GST regime wants "TAX INVOICE". */
export type InvoiceTitleStyle = "invoice" | "tax_invoice";

/** Big word top-right of a credit note. */
export type CreditNoteTitleStyle = "credit_note" | "refund";

/**
 * The period stamp between the static prefix and the counter. `none` is the historical
 * format (`INV-42`).
 *
 * Rendered in the BUSINESS timezone: a number is a legal identifier on a tax document,
 * so "which year is it" must be answered where the seller is, not in UTC.
 */
export type DynamicPrefix =
  | "none"
  | "yyyy"
  | "fy"
  | "mmyyyy"
  | "mm-yyyy"
  | "yyyymm"
  | "yyyy-mm"
  | "ddmmyyyy"
  | "dd-mm-yyyy"
  | "yyyymmdd"
  | "yyyy-mm-dd"
  | "mmddyyyy"
  | "mm-dd-yyyy";

const DYNAMIC_PREFIXES: readonly DynamicPrefix[] = [
  "none",
  "yyyy",
  "fy",
  "mmyyyy",
  "mm-yyyy",
  "yyyymm",
  "yyyy-mm",
  "ddmmyyyy",
  "dd-mm-yyyy",
  "yyyymmdd",
  "yyyy-mm-dd",
  "mmddyyyy",
  "mm-dd-yyyy",
];

/** What joins the segments of a number. */
export type NumberSeparator = "none" | "hyphen";

/**
 * Which bottom corner the signature block sits in. Pinned to the FOOT of the page rather
 * than following the content flow, because that is where a signature belongs on a printed
 * document — a short invoice would otherwise sign itself halfway up the page.
 */
export type SignaturePosition = "bottom_right" | "bottom_left";

export interface SignatureConfig {
  /**
   * A URL, not an upload: this follows `logo_url` / `icon_url` exactly, and
   * `loadLogo` (`./invoice-pdf.ts`) already fetches a remote image on a short timeout,
   * accepts PNG/JPEG, rasterises SVG, and warns with a reason rather than printing
   * nothing. There is no file-upload path anywhere in this repo, and adding one for the
   * signature alone would leave brand assets on the URL path and give us two mechanisms.
   */
  imageUrl: string | null;
  /**
   * The line under the signature ("Authorised by …"). PLAIN TEXT, deliberately — this
   * string is interpolated into a customer-facing PDF and an HTML view, and a
   * merchant-editable markup blob on that path is an injection surface. Escaped by the
   * HTML renderer like every other note.
   */
  caption: string | null;
  /** Default `bottom_right` — the conventional corner for a signature. */
  position: SignaturePosition;
}

/** Fields shared by invoices and credit notes — the *General Settings* tab. */
export interface CommonFields {
  /** Default `expanded`: the multi-line seller block the renderers have always drawn. */
  addressFormat: AddressFormat;
  /** The merchant's own template, only meaningful for `addressFormat: 'custom'`. */
  customAddress: string | null;
  /** Default true — printed today at `invoice-pdf.ts` "Customer ID". */
  showCustomerId: boolean;
  /** Default true — printed today in the SUBSCRIPTION band. */
  showSubscriptionId: boolean;
  /** Billing address + the customer's own tax id. Default true. */
  showCustomerInfo: boolean;
  /**
   * Default FALSE. `invoices.shipping_address` has been stored all along but never
   * printed, so true would change every existing document.
   */
  showShippingInfo: boolean;
  /** The Payments / Refunds footer. Default true. */
  showPaymentStub: boolean;
  /**
   * Print the issue-time exchange rate (0228) on a document whose currency is not the
   * business's default. Default FALSE: never printed before this field. A business a person
   * creates starts with it on (`initialDocumentConfig`).
   */
  showExchangeRate: boolean;
}

/** The *Invoices* tab, minus numbering. */
export interface InvoiceFields {
  title: InvoiceTitleStyle;
  /** Default true — the coloured status chip under the meta block. */
  showStatus: boolean;
  /** Default true. */
  showBillingPeriod: boolean;
  /** Default true. */
  showNextBilling: boolean;
  /** Default FALSE — never rendered before this column existed. */
  showCreditNoteNumber: boolean;
  /** Default FALSE — never rendered before this column existed. */
  showCustomFields: boolean;
  /**
   * Whether a zero-value charge line reaches the printed document at all. Default
   * **TRUE** — we print zero-value lines today, and that is the behaviour this column must
   * preserve for a business that never touches the screen.
   *
   * Named for what it does at the render site, rather than as the "hide zero-value line
   * items" toggle it could have been. The inversion is deliberate so the flag reads right
   * where `assembleInvoiceDocument` consumes it
   * (`if (!custom.invoice.showZeroValueLines) …` beats double-negating a "hide" flag).
   *
   * "Zero-value" means the line's GROSS `amountMinor` — the same pre-discount figure
   * `chargeLines[].amountMinor` already documents as the Amount-column basis — is 0, not
   * whether it was later fully discounted. A line with a non-zero price that a 100% coupon
   * reduced to nothing still explains what that discount applied TO (and
   * `discountDetails[].lineNumbers` still points at it); only a line billed at 0 to begin
   * with — a free plan, a $0 add-on, a proration slice that rounds to nothing — is
   * "zero-value" here.
   */
  showZeroValueLines: boolean;
}

/**
 * Where a credit note line's PRINTED service period comes from. Governs the DATE, never
 * whether the period prints at all — that is `CreditNoteFields.showServicePeriod`, an
 * entirely independent gate. Do not conflate them: a business can hide the period while
 * still having a basis configured for the day it turns the row back on, and turning the
 * basis around must not silently start (or stop) printing anything.
 */
export type ServicePeriodBasis = "invoice_line_dates" | "credit_note_date";

/** The *Credit Notes* tab, minus numbering. */
export interface CreditNoteFields {
  title: CreditNoteTitleStyle;
  /** Default true. */
  showStatus: boolean;
  /** Default true. */
  showServicePeriod: boolean;
  /** Default true. */
  showInvoiceDate: boolean;
  /**
   * A business-wide note for every credit note. Null by default, and null means the
   * document keeps showing `credit_notes.reason` — which is what
   * `assembleCreditNoteDocument` puts in `meta.notes` today. Additive: set it and it
   * heads the note, unset and nothing changes.
   */
  notes: string | null;
  /**
   * Which date(s) a credit note line's service period reports, when `showServicePeriod`
   * prints one at all — see that field's docblock for the distinction between WHETHER a
   * period prints and WHAT it says, which this field alone answers.
   *
   *   · `invoice_line_dates` — the credited invoice line's own `periodStart`/`periodEnd`.
   *     The DEFAULT: our credit-note lines already carry the credited line's period
   *     today, and flipping the default to `credit_note_date` would silently change which
   *     period every EXISTING business's credit notes report — on documents that affect
   *     revenue recognition. Preserving current behaviour wins; a merchant can still opt
   *     into the other basis explicitly.
   *   · `credit_note_date` — the credit note's own issue date, as both period start and end.
   */
  servicePeriodBasis: ServicePeriodBasis;
}

/**
 * How a document's human number is composed:
 *   `<prefix><sep1><dynamic><sep2><counter>`
 * and with `dynamicPrefix: 'none'` — the default — simply `<prefix><sep1><counter>`,
 * which is the historical `INV-42`.
 *
 * ⚠️ THERE IS NO PERIODIC RESET, and that is a decision rather than an omission.
 * `invoices_business_number_uq` (migration 0058) makes `(business_id, number)` unique in
 * Postgres, so a counter that returns to 1 each year collides with last year's number and
 * the invoice INSERT throws — a failed insert on the billing path is an outage, not a
 * validation error. A monotonic counter cannot collide no matter how the prefix changes,
 * so dropping reset removes the entire failure class. Re-adding it would require the
 * dynamic prefix to be at least as fine-grained as the reset period, enforced at
 * settings-save time.
 */
export interface NumberingConfig {
  dynamicPrefix: DynamicPrefix;
  /** Between the static prefix and whatever follows it. Default `hyphen` (→ `INV-42`). */
  separator1: NumberSeparator;
  /** Between the dynamic stamp and the counter. Default `hyphen`. Unused when `none`. */
  separator2: NumberSeparator;
  /** Counter step. Default 1; must be a positive integer. */
  increment: number;
  /**
   * Which month starts the fiscal year, 1–12. Only consumed by `dynamicPrefix: 'fy'`.
   *
   * Default **1** (the calendar year). tmbilling sells into India, the US and the EU, and
   * those three disagree: India runs April–March, the US federal year starts October
   * while most US companies use the calendar year, and EU practice is mostly calendar.
   * There is no default that is right for all three, so the neutral one wins — with `fy`
   * equal to the calendar year, a merchant who never touches this field gets a label that
   * is at least self-consistent rather than silently shifted by three months.
   *
   * ⚠️ A wrong fiscal year is a wrong fact on a TAX DOCUMENT, so the settings screen makes
   * this an explicit choice whenever `fy` is selected rather than letting the default
   * stand unseen. An earlier revision defaulted to 4 on the belief that this product was
   * India-only; it is not.
   */
  fiscalYearStartMonth: number;
}

/**
 * Which of the merchant's payment instructions reach an invoice.
 *
 *   · `all`                — every instruction that matches the invoice. The default.
 *   · `preferred_offline`  — only instructions for the rail the customer actually pays
 *                            on. This is meaningful only where an offline payment method
 *                            is recorded: with none there is no preference to narrow BY,
 *                            so the resolver falls back to `all` rather than printing
 *                            nothing. An invoice with no payment instructions at all is
 *                            a customer who cannot pay it.
 */
export type PaymentInstructionMode = "all" | "preferred_offline";

export interface PaymentInstructionSettings {
  mode: PaymentInstructionMode;
  /**
   * Honour each instruction's `currencies` / `countries` narrowing. Default FALSE: a
   * merchant who has not opted in gets every instruction regardless of what targeting
   * the rows carry.
   */
  personalize: boolean;
}

export interface InvoiceCustomization {
  common: CommonFields;
  paymentInstructions: PaymentInstructionSettings;
  signature: SignatureConfig;
  invoice: InvoiceFields;
  creditNote: CreditNoteFields;
  invoiceNumbering: NumberingConfig;
  creditNoteNumbering: NumberingConfig;
  /** Receipt numbering (0387). Same defaults as credit notes. */
  receiptNumbering: NumberingConfig;
}

/** Every default here is "what the renderers already did". See the file docblock. */
export const DEFAULT_NUMBERING: NumberingConfig = {
  dynamicPrefix: "none",
  separator1: "hyphen",
  separator2: "hyphen",
  increment: 1,
  fiscalYearStartMonth: 1,
};

export const DEFAULT_CUSTOMIZATION: InvoiceCustomization = {
  common: {
    addressFormat: "expanded",
    customAddress: null,
    showCustomerId: true,
    showSubscriptionId: true,
    showCustomerInfo: true,
    showShippingInfo: false,
    showPaymentStub: true,
    showExchangeRate: false,
  },
  signature: { imageUrl: null, caption: null, position: "bottom_right" },
  paymentInstructions: { mode: "all", personalize: false },
  invoice: {
    title: "invoice",
    showStatus: true,
    showBillingPeriod: true,
    showNextBilling: true,
    showCreditNoteNumber: false,
    showCustomFields: false,
    showZeroValueLines: true,
  },
  creditNote: {
    title: "credit_note",
    showStatus: true,
    showServicePeriod: true,
    showInvoiceDate: true,
    notes: null,
    servicePeriodBasis: "invoice_line_dates",
  },
  invoiceNumbering: DEFAULT_NUMBERING,
  creditNoteNumbering: DEFAULT_NUMBERING,
  receiptNumbering: DEFAULT_NUMBERING,
};

/**
 * The stored customization a business a PERSON creates starts with: the recommended values
 * where they differ from today's. A key keeps the engine defaults, so integrations and tests
 * that create businesses are unchanged.
 */
export function initialDocumentConfig(creator: {
  hasOperator?: boolean;
}): Record<string, unknown> | undefined {
  return creator.hasOperator === true ? { common: { show_exchange_rate: true } } : undefined;
}

/** How many custom fields may reach the document. */
export const MAX_INVOICE_CUSTOM_FIELDS = 3;

// ── Stored shape (snake_case jsonb, all keys optional and all values unknown) ──

interface StoredNumbering {
  dynamic_prefix?: unknown;
  separator1?: unknown;
  separator2?: unknown;
  increment?: unknown;
  fiscal_year_start_month?: unknown;
}

interface StoredCustomization {
  common?: {
    address_format?: unknown;
    custom_address?: unknown;
    show_customer_id?: unknown;
    show_subscription_id?: unknown;
    show_customer_info?: unknown;
    show_shipping_info?: unknown;
    show_payment_stub?: unknown;
    show_exchange_rate?: unknown;
  };
  signature?: { image_url?: unknown; caption?: unknown; position?: unknown };
  payment_instructions?: { mode?: unknown; personalize?: unknown };
  invoice?: {
    title?: unknown;
    show_status?: unknown;
    show_billing_period?: unknown;
    show_next_billing?: unknown;
    show_credit_note_number?: unknown;
    show_custom_fields?: unknown;
    show_zero_value_lines?: unknown;
    numbering?: StoredNumbering;
  };
  credit_note?: {
    title?: unknown;
    show_status?: unknown;
    show_service_period?: unknown;
    show_invoice_date?: unknown;
    notes?: unknown;
    service_period_basis?: unknown;
    numbering?: StoredNumbering;
  };
  receipt?: { numbering?: StoredNumbering };
}

/**
 * A boolean with an explicit fallback. `typeof === 'boolean'` rather than truthiness, so
 * a hand-edited `"false"` string does not read as true — and, more to the point, so an
 * ABSENT key takes the documented default instead of `false`. Half these flags default
 * to true; `!!raw` would have silently blanked them.
 */
function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** A trimmed non-empty string, or null. Caps length so a document cannot be flooded. */
function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t.slice(0, max) : null;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/** A positive integer, or the fallback. A 0 or negative step would never terminate. */
function positiveInt(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
}

function resolveNumbering(raw: StoredNumbering | undefined): NumberingConfig {
  return {
    dynamicPrefix: oneOf(raw?.dynamic_prefix, DYNAMIC_PREFIXES, DEFAULT_NUMBERING.dynamicPrefix),
    separator1: oneOf(raw?.separator1, ["none", "hyphen"] as const, DEFAULT_NUMBERING.separator1),
    separator2: oneOf(raw?.separator2, ["none", "hyphen"] as const, DEFAULT_NUMBERING.separator2),
    increment: positiveInt(raw?.increment, DEFAULT_NUMBERING.increment, 1000),
    fiscalYearStartMonth: positiveInt(
      raw?.fiscal_year_start_month,
      DEFAULT_NUMBERING.fiscalYearStartMonth,
      12,
    ),
  };
}

/**
 * Resolve a business's effective document customization. Pure; a null / absent /
 * malformed stored value resolves to {@link DEFAULT_CUSTOMIZATION}, which is exactly what
 * the renderers produced before this column existed.
 */
export function resolveInvoiceCustomization(
  biz: { invoiceCustomization?: unknown } | null | undefined,
): InvoiceCustomization {
  const raw = (biz?.invoiceCustomization ?? null) as StoredCustomization | null;
  const d = DEFAULT_CUSTOMIZATION;
  return {
    common: {
      addressFormat: oneOf(
        raw?.common?.address_format,
        ["expanded", "single_line", "custom"] as const,
        d.common.addressFormat,
      ),
      customAddress: text(raw?.common?.custom_address, 2000),
      showCustomerId: flag(raw?.common?.show_customer_id, d.common.showCustomerId),
      showSubscriptionId: flag(raw?.common?.show_subscription_id, d.common.showSubscriptionId),
      showCustomerInfo: flag(raw?.common?.show_customer_info, d.common.showCustomerInfo),
      showShippingInfo: flag(raw?.common?.show_shipping_info, d.common.showShippingInfo),
      showPaymentStub: flag(raw?.common?.show_payment_stub, d.common.showPaymentStub),
      showExchangeRate: flag(raw?.common?.show_exchange_rate, d.common.showExchangeRate),
    },
    signature: {
      imageUrl: text(raw?.signature?.image_url, 2000),
      caption: text(raw?.signature?.caption, 500),
      position: oneOf(
        raw?.signature?.position,
        ["bottom_right", "bottom_left"] as const,
        d.signature.position,
      ),
    },
    paymentInstructions: {
      mode: oneOf(
        raw?.payment_instructions?.mode,
        ["all", "preferred_offline"] as const,
        d.paymentInstructions.mode,
      ),
      personalize: flag(raw?.payment_instructions?.personalize, d.paymentInstructions.personalize),
    },
    invoice: {
      title: oneOf(raw?.invoice?.title, ["invoice", "tax_invoice"] as const, d.invoice.title),
      showStatus: flag(raw?.invoice?.show_status, d.invoice.showStatus),
      showBillingPeriod: flag(raw?.invoice?.show_billing_period, d.invoice.showBillingPeriod),
      showNextBilling: flag(raw?.invoice?.show_next_billing, d.invoice.showNextBilling),
      showCreditNoteNumber: flag(
        raw?.invoice?.show_credit_note_number,
        d.invoice.showCreditNoteNumber,
      ),
      showCustomFields: flag(raw?.invoice?.show_custom_fields, d.invoice.showCustomFields),
      showZeroValueLines: flag(raw?.invoice?.show_zero_value_lines, d.invoice.showZeroValueLines),
    },
    creditNote: {
      title: oneOf(raw?.credit_note?.title, ["credit_note", "refund"] as const, d.creditNote.title),
      showStatus: flag(raw?.credit_note?.show_status, d.creditNote.showStatus),
      showServicePeriod: flag(
        raw?.credit_note?.show_service_period,
        d.creditNote.showServicePeriod,
      ),
      showInvoiceDate: flag(raw?.credit_note?.show_invoice_date, d.creditNote.showInvoiceDate),
      notes: text(raw?.credit_note?.notes, 2000),
      servicePeriodBasis: oneOf(
        raw?.credit_note?.service_period_basis,
        ["invoice_line_dates", "credit_note_date"] as const,
        d.creditNote.servicePeriodBasis,
      ),
    },
    invoiceNumbering: resolveNumbering(raw?.invoice?.numbering),
    creditNoteNumbering: resolveNumbering(raw?.credit_note?.numbering),
    receiptNumbering: resolveNumbering(raw?.receipt?.numbering),
  };
}

// ── Number composition ──────────────────────────────────────────────────────

const SEP: Record<NumberSeparator, string> = { none: "", hyphen: "-" };

/**
 * Y/M/D as they read in `timezone`. `Intl` rather than the `Date` getters because those
 * answer in the host's zone, and a worker rendering an Indian invoice from a UTC box
 * would stamp the wrong day for eight and a half hours of every day.
 *
 * `en-CA` gives ISO-ordered parts, so the split is positional and needs no parsing of
 * month names.
 */
function partsInTz(at: Date, timezone: string): { y: number; m: number; d: number } {
  let iso: string;
  try {
    iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    // An unknown zone must not stop an invoice being numbered.
    iso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  }
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/**
 * The fiscal-year label, e.g. `202627` for April 2026 – March 2027 with a start month of
 * 4. It concatenates straight onto the counter: FY + counter 3381 prints `2026273381`.
 */
function fiscalYearLabel(y: number, m: number, startMonth: number): string {
  const start = m >= startMonth ? y : y - 1;
  return `${start}${String(start + 1).slice(2)}`;
}

/** The period stamp for a given instant, or "" when the prefix is `none`. */
export function dynamicPrefixValue(
  kind: DynamicPrefix,
  at: Date,
  timezone: string,
  fiscalYearStartMonth = DEFAULT_NUMBERING.fiscalYearStartMonth,
): string {
  if (kind === "none") return "";
  const { y, m, d } = partsInTz(at, timezone);
  const MM = String(m).padStart(2, "0");
  const DD = String(d).padStart(2, "0");
  switch (kind) {
    case "yyyy":
      return String(y);
    case "fy":
      return fiscalYearLabel(y, m, fiscalYearStartMonth);
    case "mmyyyy":
      return `${MM}${y}`;
    case "mm-yyyy":
      return `${MM}-${y}`;
    case "yyyymm":
      return `${y}${MM}`;
    case "yyyy-mm":
      return `${y}-${MM}`;
    case "ddmmyyyy":
      return `${DD}${MM}${y}`;
    case "dd-mm-yyyy":
      return `${DD}-${MM}-${y}`;
    case "yyyymmdd":
      return `${y}${MM}${DD}`;
    case "yyyy-mm-dd":
      return `${y}-${MM}-${DD}`;
    case "mmddyyyy":
      return `${MM}${DD}${y}`;
    case "mm-dd-yyyy":
      return `${MM}-${DD}-${y}`;
  }
}

/**
 * What to CALL a tax registration number on the document, given the country whose
 * address supplied it.
 *
 * Both renderers hardcoded `GSTIN : ` on all four tax-id sites (seller and buyer, PDF and
 * HTML). That was written when the product was believed to be India-only; tmbilling sells
 * into India, the US and the EU, so it printed a demonstrably wrong label on a legal
 * document for two of its three markets — a German seller's VAT number captioned GSTIN.
 *
 * A hardcoded country set, NOT `@/platform/geo`: that registry is loaded from the database
 * on API boot, so it is cold in a PDF rendered by a worker — the same reason
 * `countryLabel` in ./document.ts uses `Intl` instead. These are stable political facts,
 * and an unknown country falls back to the neutral "Tax ID" rather than to any
 * jurisdiction's wording.
 */
const VAT_COUNTRIES = new Set([
  // EU-27
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  // Not EU members, but VAT regimes an EU-facing merchant will meet.
  "GB",
  "NO",
  "CH",
  "IS",
  "LI",
]);

export function taxRegLabelFor(country: string | null | undefined): string {
  const c = (country ?? "").trim().toUpperCase();
  if (c === "IN") return "GSTIN";
  if (VAT_COUNTRIES.has(c)) return "VAT";
  // Covers the US, where a seller's EIN is not conventionally captioned at all, and every
  // country this list does not know. Neutral beats confidently wrong.
  return "Tax ID";
}

/**
 * Lay out the seller's address block.
 *
 *   · `expanded`    — one line per address component. The historical rendering.
 *   · `single_line` — the same components joined with ", ", for a compact letterhead.
 *   · `custom`      — the merchant's own template, split on newlines.
 *
 * ⚠️ `custom` replaces the ADDRESS ONLY. The seller's name and tax id are separate fields
 * that the renderers draw above and below this block, so a template repeating them prints
 * them twice — which is why the settings screen says so next to the textarea. Custom mode
 * cannot replace the WHOLE block without making `invoice_issuer` (which decides whose
 * legal name heads the document) unreachable.
 *
 * A `custom` format with a blank template falls back to `expanded`: an empty seller
 * address on a tax document is never what the merchant meant.
 */
export function formatSellerAddress(lines: string[], common: CommonFields): string[] {
  if (common.addressFormat === "custom") {
    const custom = (common.customAddress ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return custom.length > 0 ? custom : lines;
  }
  if (common.addressFormat === "single_line") {
    // Trailing punctuation is stripped before joining: merchant address lines often end
    // in their own comma, and a naive join rendered "Mogappair East,, Chennai" on a real
    // business's invoice. The expanded layout never showed it because each line stood
    // alone.
    const joined = lines
      .map((l) =>
        l
          .trim()
          .replace(/[,;]+$/, "")
          .trim(),
      )
      .filter(Boolean)
      .join(", ");
    return joined ? [joined] : [];
  }
  return lines;
}

/**
 * Compose a document number. The single definition of the format, shared by the assigning
 * path (`service.ts`) and the dashboard's live preview, so what a merchant is shown on the
 * settings screen is what the next invoice will actually carry.
 */
export function composeDocumentNumber(input: {
  prefix: string;
  counter: bigint | number;
  numbering: NumberingConfig;
  at: Date;
  timezone: string;
}): string {
  const { prefix, counter, numbering: n } = input;
  const stamp = dynamicPrefixValue(
    n.dynamicPrefix,
    input.at,
    input.timezone,
    n.fiscalYearStartMonth,
  );
  // With no stamp there is only ONE joint, and it takes separator1 — which is why the
  // default `hyphen` reproduces the historical `INV-42` exactly.
  return stamp
    ? `${prefix}${SEP[n.separator1]}${stamp}${SEP[n.separator2]}${counter}`
    : `${prefix}${SEP[n.separator1]}${counter}`;
}
