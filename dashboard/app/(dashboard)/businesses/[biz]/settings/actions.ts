"use server";

import {
  DEFAULT_HEADROOM_BPS as DEFAULT_MANDATE_HEADROOM_BPS,
  DEFAULT_RAIL_CAP_MINOR as DEFAULT_MANDATE_RAIL_CAP_MINOR,
} from "./billing-rules/mandates/defaults";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import type { ReminderConfig, ReminderLeadDays } from "@/lib/api";
import { parseForm, actionOk, actionError, type ActionResult } from "@/lib/action-result";
import {
  getBusiness,
  updateBusiness,
  setCurrencyRate,
  removeCurrencyRate,
  type BusinessSettingsPatch,
} from "@/lib/api/business-settings";
import {
  saveSmtpSettings,
  testSmtpConnection,
  sendTestEmail,
  saveEmailTemplate,
  saveSesSettings,
  deleteSuppression,
  type SmtpSettingsPatch,
  type SesSettingsPatch,
  type EmailTemplateDraft,
  type EmailBlockKey,
} from "@/lib/api/emails";
import { BILLING_MODES, isBillingModeId } from "@/lib/billing-mode";
import { toMinor } from "@/lib/money";
import { parseDunningForm } from "./dunning/parse";
import {
  ALLOWANCE_UPGRADES,
  PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS,
  PLAN_CREDIT_DOWNGRADES,
  PLAN_CREDIT_FIRST_WINDOWS,
  PLAN_CREDIT_PAUSES,
  PLAN_CREDIT_UPGRADES,
  timingRulesFromForm,
  type AllowanceResets,
  type BillingRulesPatch,
} from "@/lib/billing-rules";
import {
  createPaymentInstruction,
  updatePaymentInstruction,
  archivePaymentInstruction,
} from "@/lib/api/payment-instructions";

// Sectioned business-settings save. Each Settings card posts with a
// `section` discriminator so an empty field in one card can't clobber another
// card's values. Returns ActionResult for <ActionForm> toasts.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** '' → null (explicit clear). */
const strOrNull = (fd: FormData, k: string) => (str(fd, k) === "" ? null : str(fd, k));
/** A whole number inside the bounds, else null (empty = "use the built-in value"). */
const intOrNull = (fd: FormData, k: string, min: number, max: number) => {
  const n = Number(str(fd, k));
  return str(fd, k) !== "" && Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const num = (fd: FormData, k: string): number | null => {
  const v = str(fd, k);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Checkbox present in the section's form → true/false by checked state. */
const bool = (fd: FormData, k: string) => fd.get(k) === "on";

function saveResult(
  res: { ok: boolean; status: number; error?: string },
  label: string,
): ActionResult {
  if (res.ok) return actionOk(`${label} saved`);
  if (res.status === 409)
    return actionError(res.error ?? "Someone changed this business after you opened it.", {
      code: "conflict",
    });
  return actionError(res.error ?? `We could not save the ${label.toLowerCase()}.`);
}

async function patch(
  biz: string,
  body: BusinessSettingsPatch,
  fd: FormData,
  label: string,
): Promise<ActionResult> {
  const ev = num(fd, "expected_version");
  if (ev != null && ev > 0) body.expected_version = ev;
  const res = await updateBusiness(biz, body);
  revalidatePath(`/businesses/${biz}/settings`);
  return saveResult(res, label);
}

const emailOrBlank = z.union([
  z.literal(""),
  z.string().trim().max(320).email("Enter a valid email address."),
]);
const urlOrBlank = z.union([
  z.literal(""),
  z.string().trim().max(2000).url("Enter a valid URL (https://…)."),
]);

const generalSchema = z.object({
  biz: z.string().min(1),
  name: z.string().trim().min(1, "Enter the business name.").max(200, "Max 200 characters"),
  contact_email: emailOrBlank.optional(),
  support_email: emailOrBlank.optional(),
  phone: z.string().trim().max(50).optional(),
  website: urlOrBlank.optional(),
  timezone: z.string().trim().max(64).optional(),
  week_start: z.enum(["sunday", "monday"]).optional(),
  fiscal_year_start_month: z.coerce.number().int().min(1).max(12).optional(),
  tax_registration_number: z.string().trim().max(64).optional(),
  /** Whose identity heads this business's invoices — see the settings row's help text. */
  invoice_issuer: z.enum(["business", "organization"]).optional(),
  default_tax_code: z.string().trim().max(20).optional(),
  // Posted by <AddressFields prefix="addr_">. `line3` and `state_code` are new:
  // the hand-rolled block this replaced had neither, so the seller's region was
  // never captured in the form tax resolution reads. The engine re-validates the
  // whole address (country ↔ state_code ↔ postal_code) and returns a field-pathed
  // 400, so the rules are not restated here — only shapes and lengths.
  addr_line1: z.string().trim().max(200).optional(),
  addr_line2: z.string().trim().max(200).optional(),
  addr_line3: z.string().trim().max(200).optional(),
  addr_city: z.string().trim().max(100).optional(),
  addr_state: z.string().trim().max(100).optional(),
  addr_state_code: z.string().trim().max(10).optional(),
  addr_postal_code: z.string().trim().max(20).optional(),
  addr_country: z
    .union([
      z.literal(""),
      z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/, "Use a 2-letter ISO 3166-1 country code, for example US."),
    ])
    .optional(),
});

export async function saveGeneralAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const { data, error } = parseForm(generalSchema, fd);
  if (error) return error;
  const body: BusinessSettingsPatch = {
    name: data.name,
    contact_email: data.contact_email || null,
    support_email: data.support_email || null,
    phone: data.phone || null,
    website: data.website || null,
    timezone: data.timezone || null,
    ...(data.week_start ? { week_start: data.week_start } : {}),
    ...(data.fiscal_year_start_month
      ? { fiscal_year_start_month: data.fiscal_year_start_month }
      : {}),
    tax_registration_number: data.tax_registration_number || null,
    ...(data.invoice_issuer ? { invoice_issuer: data.invoice_issuer } : {}),
    default_tax_code: data.default_tax_code || null,
  };
  const address = {
    line1: data.addr_line1 || null,
    line2: data.addr_line2 || null,
    line3: data.addr_line3 || null,
    city: data.addr_city || null,
    state: data.addr_state || null,
    state_code: data.addr_state_code ? data.addr_state_code.toUpperCase() : null,
    postal_code: data.addr_postal_code || null,
    country: data.addr_country ? data.addr_country.toUpperCase() : null,
  };
  body.address = Object.values(address).some((v) => v != null) ? address : null;
  return patch(data.biz, body, fd, "Business profile");
}

/**
 * The BASE currency, on its own.
 *
 * Split out of the old whole-page `saveCurrenciesAction` (deleted) because that action
 * always sent `currencies` and `exchange_rates` alongside, so a form posting one field
 * re-posted stale copies of the other two — and an absent `currencies` input meant
 * "unrestricted", i.e. a price-type save could silently enable every currency. Each
 * control on the currencies screen now writes exactly its own field: this one, the price
 * type below, and the per-currency rate/remove pair.
 *
 * Changing this does NOT convert existing rates. Every additional currency's rate is
 * quoted against the base, so after a change each one means something different than it
 * did — which is why the dialog says so and the screen asks the operator to review them.
 */
export async function saveBaseCurrencyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const def = str(fd, "default_currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(def)) return actionError("Select a base currency.");
  // The base must be one of the enabled currencies, or the business would be selling in a
  // currency it does not list. The engine keeps the list; we add rather than replace.
  const b = await getBusiness(biz);
  const enabled = b?.currencies ?? null;
  const body: BusinessSettingsPatch = { default_currency: def };
  if (enabled && !enabled.map((c) => c.toUpperCase()).includes(def)) {
    body.currencies = [...enabled, def];
  }
  return patch(biz, body, fd, "Base currency");
}

/** The default price type new prices inherit. */
export async function savePriceTypeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const priceType = str(fd, "default_tax_behavior");
  if (priceType !== "exclusive" && priceType !== "inclusive")
    return actionError("Select a price type.");
  return patch(biz, { default_tax_behavior: priceType }, fd, "Price type");
}

/**
 * Stop transacting in a currency: drops it from the enabled list and deletes its rate,
 * in one engine call. The base currency is refused there, not here — the engine owns that
 * rule and duplicating it would let the two disagree.
 */
export async function removeCurrencyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const currency = str(fd, "currency").toUpperCase();
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  if (!/^[A-Z]{3}$/.test(currency)) return actionError("The currency is missing. Reload the page.");
  const res = await removeCurrencyRate(biz, currency);
  if (!res.ok) return actionError(res.error ?? `We could not remove ${currency}.`);
  revalidatePath(`/businesses/${biz}/settings/currencies`);
  return actionOk(
    `${currency} removed. We also removed its rate. Existing invoices keep their rates.`,
  );
}

/**
 * Set one currency's exchange-rate source — the write behind the Manage-currency dialog.
 *
 * Reports what ACTUALLY happened rather than a bare "Saved": choosing auto triggers a
 * live provider fetch, and that fetch can fail while the setting itself is stored fine.
 * Saying "Saved" there would describe the request and not the rate — the mail-transport
 * lesson, which cost a day when a success message did not name its mechanism.
 */
export async function saveCurrencyRateAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const currency = str(fd, "currency").toUpperCase();
  const source = str(fd, "source");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  if (!/^[A-Z]{3}$/.test(currency)) return actionError("The currency is missing. Reload the page.");
  if (source !== "manual" && source !== "auto") return actionError("Select a rate source.");

  let res;
  if (source === "manual") {
    const raw = str(fd, "rate");
    const n = Number(raw);
    if (raw === "" || !Number.isFinite(n) || n <= 0) {
      return actionError(`Enter a positive number for the ${currency} rate.`, {
        errors: { rate: "Positive number" },
      });
    }
    // The operator's own string, not `String(n)`: a typed `94.9537410` keeps its
    // precision through `numeric(20,10)`, and re-formatting it here would not.
    res = await setCurrencyRate(biz, currency, { source: "manual", rate: raw });
  } else {
    res = await setCurrencyRate(biz, currency, { source: "auto" });
  }
  if (!res.ok) return actionError(res.error ?? `We could not save ${currency}.`);
  revalidatePath(`/businesses/${biz}/settings/currencies`);

  if (source === "manual") return actionOk(`${currency} rate set to ${res.rate?.rate ?? "—"}`);
  // Auto: the setting is stored either way, so the message has to distinguish a rate that
  // arrived from one that did not.
  return res.rate?.last_error
    ? actionOk(
        `${currency} set to auto, but the rate did not update: ${res.rate.last_error}. ` +
          `We still use the previous rate. The daily refresh will retry.`,
      )
    : actionOk(
        `${currency} set to auto. Rate ${res.rate?.rate ?? "—"} from ${res.rate?.provider ?? "the provider"}.`,
      );
}

export async function saveBillingFrequenciesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  // Repeated hidden inputs "interval:count" from <BillingFrequenciesField>; none = unrestricted.
  const valid = new Set(["day", "week", "month", "year"]);
  const seen = new Set<string>();
  const freqs: Array<{ interval: "day" | "week" | "month" | "year"; count: number }> = [];
  for (const raw of fd.getAll("billing_frequencies")) {
    const [interval, countStr] = String(raw).split(":");
    const count = Number(countStr);
    if (!valid.has(interval!) || !Number.isInteger(count) || count < 1) continue;
    const k = `${interval}:${count}`;
    if (seen.has(k)) continue;
    seen.add(k);
    freqs.push({ interval: interval as "day" | "week" | "month" | "year", count });
  }
  const body: BusinessSettingsPatch = { billing_frequencies: freqs.length > 0 ? freqs : null };
  return patch(biz, body, fd, "Billing frequencies");
}

/**
 * Invoice numbering + default note. Round-off, payment terms and pending
 * invoices each have their own Billing rules page now, so this action must NOT
 * send those keys — `patch` only forwards what's in the body, which is what
 * keeps the split pages from clobbering each other.
 */
export async function saveInvoicingAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const notes = str(fd, "default_invoice_notes");
  if (notes.length > 2000)
    return actionError("The invoice note is too long. Use 2000 characters or fewer.", {
      errors: { default_invoice_notes: "Max 2000 characters" },
    });
  const body: BusinessSettingsPatch = {
    default_invoice_notes: notes === "" ? null : notes,
    inherit_subscription_po_number: fd.get("inherit_subscription_po_number") === "on",
  };
  const prefix = str(fd, "invoice_prefix");
  if (!prefix)
    return actionError("Enter a number prefix.", { errors: { invoice_prefix: "Required" } });
  if (prefix.length > 20)
    return actionError("The number prefix is too long. Use 20 characters or fewer.", {
      errors: { invoice_prefix: "Max 20 characters" },
    });
  body.invoice_prefix = prefix;
  const nextNo = num(fd, "invoice_next_number");
  if (nextNo != null) {
    if (!Number.isInteger(nextNo) || nextNo < 1)
      return actionError("Enter a whole number of 1 or more for the next invoice number.", {
        errors: { invoice_next_number: "Must be ≥ 1" },
      });
    body.invoice_next_number = nextNo;
  }
  return patch(biz, body, fd, "Invoice settings");
}

type CustomizationDto = NonNullable<BusinessSettingsPatch["invoice_customization"]>;

const DYNAMIC_PREFIXES = [
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

/**
 * `invoice_customization` is ONE jsonb column, but its sections live on THREE screens
 * (Documents, Invoices, Credit notes). A PATCH replaces the whole object, so a page
 * posting only its own section would silently blank the other two — turning off every
 * invoice field the moment somebody edited a credit-note title.
 *
 * So each action re-reads the stored object and merges its own section over it, exactly as
 * `patchEmailConfig` does for `email_config` and for the same reason. The form's
 * `expected_version` still rides along, so "changed since you loaded this page" is caught
 * by the same 409; the read here is for merging, not for locking.
 */
async function patchCustomization(
  biz: string,
  section: Partial<CustomizationDto>,
  fd: FormData,
  label: string,
): Promise<ActionResult> {
  let current: CustomizationDto | null = null;
  try {
    current = (await getBusiness(biz))?.invoice_customization ?? null;
  } catch {
    // A read failure must not be reported as a save: the merge would be a guess, and
    // guessing here means writing `false` over a merchant's enabled fields.
    return actionError("We could not read the current document settings. We saved nothing.");
  }
  const merged: CustomizationDto = {
    ...current,
    ...section,
    // Nested sections merge a level down too, so a page owning `invoice.title` does not
    // drop the `invoice.numbering` its own other card wrote.
    ...(section.invoice || current?.invoice
      ? { invoice: { ...current?.invoice, ...section.invoice } }
      : {}),
    ...(section.credit_note || current?.credit_note
      ? { credit_note: { ...current?.credit_note, ...section.credit_note } }
      : {}),
  };
  return patch(biz, { invoice_customization: merged }, fd, label);
}

/** The numbering FORMAT fields, read off whichever page posted them. */
function numberingFrom(fd: FormData, prefix: string) {
  const sep = (k: string): "none" | "hyphen" =>
    str(fd, `${prefix}${k}`) === "none" ? "none" : "hyphen";
  const dyn = str(fd, `${prefix}dynamic_prefix`);
  const inc = num(fd, `${prefix}increment`);
  const fym = num(fd, `${prefix}fiscal_year_start_month`);
  return {
    // Unknown value → 'none', matching the engine resolver rather than throwing.
    dynamic_prefix: (DYNAMIC_PREFIXES.includes(dyn) ? dyn : "none") as NonNullable<
      NonNullable<CustomizationDto["invoice"]>["numbering"]
    >["dynamic_prefix"],
    separator1: sep("separator1"),
    separator2: sep("separator2"),
    increment: inc != null && Number.isInteger(inc) && inc >= 1 && inc <= 1000 ? inc : 1,
    // 1–12; the engine defaults an absent value to the calendar year.
    fiscal_year_start_month: fym != null && fym >= 1 && fym <= 12 ? fym : 1,
  };
}

/**
 * Settings → Documents. The fields BOTH documents share, the seller-address format,
 * and the signature.
 *
 * Every switch here is rendered by this page, so `bool()` reading absent-as-false is
 * correct: an unchecked switch posts nothing and genuinely means false.
 */
export async function saveDocumentFieldsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const format = str(fd, "address_format");
  const addressFormat = (
    ["expanded", "single_line", "custom"].includes(format) ? format : "expanded"
  ) as "expanded" | "single_line" | "custom";
  const customAddress = strOrNull(fd, "custom_address");
  if (addressFormat === "custom" && !customAddress)
    return actionError("Enter the address to print, or select another format.", {
      errors: { custom_address: "Required for a custom format" },
    });

  const caption = strOrNull(fd, "signature_caption");
  if (caption && caption.length > 500)
    return actionError("The signature line is too long. Use 500 characters or fewer.", {
      errors: { signature_caption: "Max 500 characters" },
    });
  const imageUrl = strOrNull(fd, "signature_image_url");
  // https only: the invoice HTML view is served under a CSP of `img-src 'self' https:
  // data:`, so an http:// image renders in the PDF (fetched server-side) and is silently
  // blocked in the browser. Rejecting here beats shipping that asymmetry.
  if (imageUrl && !/^https:\/\/\S+$/i.test(imageUrl))
    return actionError("Enter an https image URL.", {
      errors: { signature_image_url: "Must be an https:// URL" },
    });

  return patchCustomization(
    biz,
    {
      common: {
        address_format: addressFormat,
        custom_address: customAddress,
        show_customer_id: bool(fd, "show_customer_id"),
        show_subscription_id: bool(fd, "show_subscription_id"),
        show_customer_info: bool(fd, "show_customer_info"),
        show_shipping_info: bool(fd, "show_shipping_info"),
        show_payment_stub: bool(fd, "show_payment_stub"),
        show_exchange_rate: bool(fd, "show_exchange_rate"),
      },
      signature: {
        image_url: imageUrl,
        caption,
        position: str(fd, "signature_position") === "bottom_left" ? "bottom_left" : "bottom_right",
      },
    },
    fd,
    "Document fields",
  );
}

/** Settings → Invoices → the title, the number FORMAT, and the invoice-only fields. */
export async function saveInvoiceDocumentAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const title = str(fd, "invoice_title") === "tax_invoice" ? "tax_invoice" : "invoice";
  return patchCustomization(
    biz,
    {
      invoice: {
        title,
        show_status: bool(fd, "show_invoice_status"),
        show_billing_period: bool(fd, "show_billing_period"),
        show_next_billing: bool(fd, "show_next_billing"),
        show_credit_note_number: bool(fd, "show_credit_note_number"),
        show_custom_fields: bool(fd, "show_custom_fields"),
        // 0243. Named for what it DOES at the render site — true prints them, which is
        // today's behaviour.
        show_zero_value_lines: bool(fd, "show_zero_value_lines"),
        numbering: numberingFrom(fd, "inv_"),
      },
    },
    fd,
    "Invoice document settings",
  );
}

/** Settings → Credit notes → the title, the number FORMAT, the fields, and the note. */
export async function saveCreditNoteDocumentAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const notes = strOrNull(fd, "cn_notes");
  if (notes && notes.length > 2000)
    return actionError("The credit note note is too long. Use 2000 characters or fewer.", {
      errors: { cn_notes: "Max 2000 characters" },
    });
  const title = str(fd, "cn_title") === "refund" ? "refund" : "credit_note";
  return patchCustomization(
    biz,
    {
      credit_note: {
        title,
        show_status: bool(fd, "show_cn_status"),
        show_service_period: bool(fd, "show_service_period"),
        show_invoice_date: bool(fd, "show_cn_invoice_date"),
        // 0243. WHICH dates the period IS, not whether it prints — `show_service_period`
        // above is the printing flag and the two are easy to confuse. The default stays
        // `invoice_line_dates`, today's behaviour: switching to `credit_note_date` would
        // change which period a credit reverses on every existing business.
        service_period_basis:
          str(fd, "service_period_basis") === "credit_note_date"
            ? "credit_note_date"
            : "invoice_line_dates",
        notes,
        numbering: numberingFrom(fd, "cn_"),
      },
    },
    fd,
    "Credit note document settings",
  );
}

/**
 * Settings → Documents → payment instructions, the two GLOBAL switches only. The
 * instruction rows are their own resource (`/v1/businesses/:biz/payment_instructions`).
 */
export async function savePaymentInstructionSettingsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  return patchCustomization(
    biz,
    {
      payment_instructions: {
        mode: str(fd, "pi_mode") === "preferred_offline" ? "preferred_offline" : "all",
        personalize: bool(fd, "pi_personalize"),
      },
    },
    fd,
    "Payment instruction settings",
  );
}

/** Billing rules → Unbilled charges (pending renewal invoices). */
export async function savePendingInvoicesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const autoClose = num(fd, "auto_close_pending_after_days");
  if (autoClose != null && (!Number.isInteger(autoClose) || autoClose < 0 || autoClose > 365))
    return actionError("Enter an auto-close window from 0 to 365 days.", {
      errors: { auto_close_pending_after_days: "0–365" },
    });
  const body: BusinessSettingsPatch = {
    create_pending_invoices: bool(fd, "create_pending_invoices"),
    auto_close_pending_after_days: autoClose,
  };
  return patch(biz, body, fd, "Unbilled charge settings");
}

type EmailConfigDto = NonNullable<BusinessSettingsPatch["email_config"]>;

/**
 * `email_config` is ONE jsonb column, but the switches and the sender identity now live on
 * two different pages. A PATCH replaces the whole object, so a page that posted only its
 * own half would silently blank the other's — turning sending off every time somebody
 * edited the From name.
 *
 * So each page's action re-reads the stored config and merges its own fields over it. The
 * form's `expected_version` still rides along, so "changed since you loaded this page" is
 * caught by the same 409 as before; the read here is for merging, not for locking.
 */
async function patchEmailConfig(
  biz: string,
  fields: Partial<EmailConfigDto>,
  fd: FormData,
  label: string,
): Promise<ActionResult> {
  let current: EmailConfigDto | null = null;
  try {
    current = (await getBusiness(biz))?.email_config ?? null;
  } catch {
    // A read failure must not be reported as a save; the merge would be a guess.
    return actionError("We could not read the current email settings. We saved nothing.");
  }
  // Only the keys the API takes. `Required` makes a key added to `EmailConfigDto` fail to
  // compile until it is listed here. A stored key the API no longer takes would 400.
  const base: Required<EmailConfigDto> = {
    // Opt-in: absent config means off, matching resolveEmailConfig.
    enabled: current?.enabled ?? false,
    fromName: current?.fromName ?? null,
    fromAddress: current?.fromAddress ?? null,
    replyTo: current?.replyTo ?? null,
    cc: current?.cc ?? [],
    bcc: current?.bcc ?? [],
    subjectPrefix: current?.subjectPrefix ?? null,
    footerNote: current?.footerNote ?? null,
    types: current?.types ?? {},
    attachments: current?.attachments ?? {},
    attachReceiptPdf: current?.attachReceiptPdf === true,
    linkTarget: current?.linkTarget ?? "portal",
    merchantUrl: current?.merchantUrl ?? null,
  };
  const merged: EmailConfigDto = { ...base, ...fields };
  const res = await patch(biz, { email_config: merged }, fd, label);
  revalidatePath(`/businesses/${biz}/settings/emails`);
  return res;
}

/**
 * The hub: the master switch and the per-type mutes. `email_config` is opt-in — a business
 * with no config sends nothing, so a merchant must turn it on explicitly. Per-type entries
 * are only written for types that actually rendered a switch (`email_type_present`), so an
 * absent type inherits `enabled`, matching resolveEmailConfig.
 */
export async function saveEmailsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const enabled = bool(fd, "emails_enabled");
  // Every automatic type renders a switch, so an unchecked one is a real "muted" signal.
  const types: Record<string, boolean> = {};
  for (const t of fd.getAll("email_type_present").map(String)) {
    types[t] = fd.get(`email_type_${t}`) != null;
  }
  // Sent only when the switch rendered: an unchecked switch posts nothing.
  const receipt =
    fd.get("attach_receipt_pdf_present") === "1"
      ? { attachReceiptPdf: fd.get("attach_receipt_pdf") != null }
      : {};
  // Email links: the hosted portal, or the merchant's own http(s) page.
  let links: Partial<EmailConfigDto> = {};
  if (fd.get("link_target") != null) {
    const linkTarget = str(fd, "link_target") === "merchant_url" ? "merchant_url" : "portal";
    const merchantUrl = strOrNull(fd, "merchant_url");
    if (merchantUrl && (!/^https?:\/\/[^\s/]+/i.test(merchantUrl) || merchantUrl.length > 2048))
      return actionError("Correct the highlighted fields.", {
        errors: { merchant_url: "Enter a URL that starts with http:// or https://." },
      });
    if (linkTarget === "merchant_url" && !merchantUrl)
      return actionError("Correct the highlighted fields.", {
        errors: { merchant_url: "Enter the URL for email links." },
      });
    links = { linkTarget, merchantUrl };
  }
  return patchEmailConfig(biz, { enabled, types, ...receipt, ...links }, fd, "Email settings");
}

/** Settings → Email notifications → Sender. Identity only; transport is the SMTP page. */
export async function saveEmailSenderAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const replyTo = strOrNull(fd, "reply_to");
  if (replyTo && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyTo))
    return actionError("Enter a valid email address for Reply-to.", {
      errors: { reply_to: "Invalid email" },
    });
  if (replyTo && replyTo.length > 320)
    return actionError("The Reply-to address is too long.", {
      errors: { reply_to: "Max 320 characters" },
    });
  const fromName = strOrNull(fd, "from_name");
  if (fromName && fromName.length > 120)
    return actionError("The From name is too long. Use 120 characters or fewer.", {
      errors: { from_name: "Max 120 characters" },
    });
  const fromAddress = strOrNull(fd, "from_address");
  if (fromAddress && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromAddress))
    return actionError("Enter a valid email address for From address.", {
      errors: { from_address: "Invalid email" },
    });
  if (fromAddress && fromAddress.length > 320)
    return actionError("The From address is too long.", {
      errors: { from_address: "Max 320 characters" },
    });

  // CC/BCC come in as one comma- or newline-separated field, because that is how an
  // operator thinks about them; the API takes an array. Rejecting the whole save on one
  // typo'd address is deliberate: silently dropping the bad one would mean the merchant
  // believes an address is archiving their invoices when it is not.
  const parseList = (key: "cc" | "bcc"): { list: string[] } | ActionResult => {
    const raw = str(fd, key);
    if (!raw) return { list: [] };
    const parts = raw
      .split(/[,\n;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const list: string[] = [];
    for (const p of parts) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p))
        return actionError(`“${p}” is not a valid email address.`, {
          errors: { [key]: "Invalid email address" },
        });
      if (p.length > 320)
        return actionError("An address is too long.", { errors: { [key]: "Max 320 characters" } });
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      list.push(p);
    }
    if (list.length > 10)
      return actionError(`Enter 10 ${key.toUpperCase()} addresses or fewer.`, {
        errors: { [key]: "Max 10 addresses" },
      });
    return { list };
  };
  const cc = parseList("cc");
  if (!("list" in cc)) return cc;
  const bcc = parseList("bcc");
  if (!("list" in bcc)) return bcc;

  const subjectPrefix = strOrNull(fd, "subject_prefix");
  if (subjectPrefix && subjectPrefix.length > 40)
    return actionError("The subject prefix is too long. Use 40 characters or fewer.", {
      errors: { subject_prefix: "Max 40 characters" },
    });

  // Capped at the length the resolver truncates to, so the merchant is told rather than
  // having their footer silently cut on the way through resolveEmailConfig.
  // A textarea posts CRLF and may keep trailing spaces; save clean "\n"-separated lines.
  const rawFooter = strOrNull(fd, "footer_note");
  const footerNote = rawFooter
    ? rawFooter
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim() || null
    : null;
  if (footerNote && footerNote.length > 1000)
    return actionError("The footer is too long. Use 1,000 characters or fewer.", {
      errors: { footer_note: "Max 1,000 characters" },
    });

  return patchEmailConfig(
    biz,
    {
      fromName,
      fromAddress,
      replyTo,
      cc: cc.list,
      bcc: bcc.list,
      subjectPrefix,
      footerNote,
    },
    fd,
    "Sender",
  );
}

/** Save a per-business override of one built-in email template. */
const BLOCK_KEYS = ["body", "action", "facts", "footer"] as const;

/** The editor's draft, posted as hidden fields by both Save and Send test. */
function templateDraftFrom(fd: FormData): EmailTemplateDraft | { error: ActionResult } {
  const subject = str(fd, "subject");
  const heading = str(fd, "heading");
  const body = str(fd, "body");
  if (!subject)
    return { error: actionError("Enter a subject.", { errors: { subject: "Required" } }) };
  if (!heading)
    return { error: actionError("Enter a heading.", { errors: { heading: "Required" } }) };
  if (!body) return { error: actionError("Enter a body.", { errors: { body: "Required" } }) };
  if (subject.length > 500)
    return {
      error: actionError("The subject is too long.", { errors: { subject: "Max 500 characters" } }),
    };
  if (heading.length > 200)
    return {
      error: actionError("The heading is too long.", { errors: { heading: "Max 200 characters" } }),
    };
  if (body.length > 20_000)
    return {
      error: actionError("The body is too long.", { errors: { body: "Max 20,000 characters" } }),
    };
  const footer = str(fd, "footer");
  if (footer.length > 20_000)
    return {
      error: actionError("The footer is too long.", {
        errors: { footer: "Max 20,000 characters" },
      }),
    };
  const cta = str(fd, "cta_label");
  if (cta.length > 60)
    return {
      error: actionError("The button text is too long.", {
        errors: { cta_label: "Max 60 characters" },
      }),
    };
  const order = str(fd, "block_order").split(",").filter(Boolean);
  const blockOrder =
    order.length === BLOCK_KEYS.length && BLOCK_KEYS.every((k) => order.includes(k))
      ? (order as EmailBlockKey[])
      : null;
  return {
    subject,
    heading,
    body,
    footer: footer || null,
    // Only sent when the form carries the field, i.e. the type has a button / card.
    ...(fd.has("cta_label") ? { cta_label: cta || null } : {}),
    ...(fd.has("show_facts") ? { show_facts: str(fd, "show_facts") === "on" } : {}),
    block_order: blockOrder,
  };
}

/**
 * One email type's attachment rule, saved the moment a switch moves. Business config, not
 * template wording, so it never creates a template override. Other types' rules are carried
 * through by `patchEmailConfig`'s merge.
 */
export async function saveAttachmentRuleAction(
  biz: string,
  type: string,
  rule: { pdf: boolean; skipZeroPdf: boolean; skipZeroSend: boolean },
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  if (!biz || !type)
    return actionError("The business ID or the email type is missing. Reload the page.");
  let current: Record<string, { pdf: boolean; skipZeroPdf: boolean; skipZeroSend: boolean }>;
  try {
    current = (await getBusiness(biz))?.email_config?.attachments ?? {};
  } catch {
    return actionError("We could not read the current email settings. We saved nothing.");
  }
  const res = await patchEmailConfig(
    biz,
    { attachments: { ...current, [type]: rule } },
    new FormData(),
    "Attachments",
  );
  revalidatePath(`/businesses/${biz}/settings/emails/templates/${type}`);
  return res;
}

/** Send the editor's current draft (saved or not) to one address. */
export async function sendTemplateTestAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const type = str(fd, "type");
  if (!biz || !type)
    return actionError("The business ID or the template type is missing. Reload the page.");
  const to = str(fd, "test_to");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
    return actionError("Enter a valid address for the test email.", {
      errors: { test_to: "Invalid email" },
    });
  const draft = templateDraftFrom(fd);
  if ("error" in draft) return draft.error;

  const res = await sendTestEmail(biz, { to, type, draft });
  revalidatePath(`/businesses/${biz}/emails`);
  if (!res.ok) return actionError(res.error ?? "We could not send the test email.");
  const data = res.data as { ok?: boolean; error?: string | null; transport?: string } | undefined;
  if (!data?.ok) return actionError(data?.error ?? "The transport rejected the test email.");
  return data.transport === "console"
    ? actionOk(
        `We wrote the email to the console dev sink. Nothing was delivered to ${to}. Enable a custom SMTP relay to send real email.`,
      )
    : actionOk(`Test email sent to ${to}.`);
}

export async function saveTemplateAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const type = str(fd, "type");
  if (!biz || !type)
    return actionError("The business ID or the template type is missing. Reload the page.");

  const draft = templateDraftFrom(fd);
  if ("error" in draft) return draft.error;

  const res = await saveEmailTemplate(biz, type, draft);
  revalidatePath(`/businesses/${biz}/settings/emails/templates/${type}`);
  revalidatePath(`/businesses/${biz}/settings/emails`);
  return saveResult(res, "Template");
}

/**
 * Transport, one form per relay — SMTP here, SES below.
 *
 * These replaced a single `saveDeliveryAction` that posted a method radio plus BOTH
 * credential sets at once. Splitting them follows the data (`smtp_config` and `ses_config`
 * are separate resources behind separate routes) and removes a real hazard: one form
 * carrying two credentials meant every save of either one rewrote the other.
 *
 * The credential must not ride the business PATCH — that route echoes what it wrote, which
 * would put a password in a response body for no reason. The dedicated /emails/smtp and
 * /emails/ses routes never return the secret half.
 *
 * `activate` is what makes this the business's transport. A business has exactly one
 * (`businesses_mail_transport_ck`), and the engine turns the other off **in the same
 * UPDATE** — so one PATCH is atomic and the old disable-then-enable dance is gone, along
 * with the window between the two calls where both were briefly on.
 *
 * "Fall back to the deployment relay" is deliberately NOT offered. That fallback exists in
 * the engine for platform mail (invites, password resets) and for local dev, but it is not a
 * valid setting for a BUSINESS: customer mail sent through the platform's own relay would
 * carry the wrong sending domain, fail the merchant's SPF/DKIM, and spend the platform's
 * sending reputation on someone else's mail.
 *
 * Credentials for the transport you are NOT using are stored rather than rejected, so
 * switching back is cheap. Only the one being activated is validated — and the engine
 * validates it again, including the saved-secret check this layer cannot see.
 */
export async function saveSmtpTransportAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const activate = bool(fd, "activate");
  const host = strOrNull(fd, "smtp_host");
  const port = num(fd, "smtp_port");
  const encryption = str(fd, "smtp_encryption");
  const username = strOrNull(fd, "smtp_username");
  const password = str(fd, "smtp_password");
  const clearPassword = bool(fd, "smtp_clear_password");

  if (activate && !host) {
    return actionError("Enter an SMTP host to send through SMTP.", {
      errors: { smtp_host: "Required" },
    });
  }
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535))
    return actionError("Enter a port from 1 to 65535.", {
      errors: { smtp_port: "Invalid port" },
    });
  if (!["tls", "starttls", "none"].includes(encryption))
    return actionError("Select an encryption mode.");
  // Clearing the credential and asking to send through it in the same submit is a
  // contradiction. The engine would reject it; saying so here names both fields.
  if (activate && clearPassword) {
    return actionError(
      "SMTP cannot send your email without a password. Clear one of the two options.",
      {
        errors: { smtp_clear_password: "Conflicts with sending through SMTP" },
      },
    );
  }

  const body: SmtpSettingsPatch = {
    enabled: activate,
    host,
    port,
    encryption: encryption as SmtpSettingsPatch["encryption"],
    username,
  };
  // The tri-state that keeps a merchant from wiping their own credential by editing the
  // port: send the password ONLY when they actually typed one, or explicitly asked to clear.
  if (clearPassword) body.password = "";
  else if (password) body.password = password;

  const res = await saveSmtpSettings(biz, body);
  revalidateDelivery(biz);
  return saveResult(res, "SMTP settings");
}

/** Amazon SES — the API alternative to the SMTP form above, same `activate` semantics. */
export async function saveSesTransportAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const activate = bool(fd, "activate");
  const region = strOrNull(fd, "ses_region");
  const accessKeyId = strOrNull(fd, "ses_access_key_id");
  const configurationSet = strOrNull(fd, "ses_configuration_set");
  const secret = str(fd, "ses_secret");
  const clearSecret = bool(fd, "ses_clear_secret");

  if (activate) {
    if (!region)
      return actionError("Enter an AWS region to send through SES.", {
        errors: { ses_region: "Required" },
      });
    if (!accessKeyId) {
      return actionError("Enter an AWS access key ID to send through SES.", {
        errors: { ses_access_key_id: "Required" },
      });
    }
    if (clearSecret) {
      return actionError(
        "SES cannot send your email without a secret key. Clear one of the two options.",
        {
          errors: { ses_clear_secret: "Conflicts with sending through SES" },
        },
      );
    }
  }

  const body: SesSettingsPatch = { enabled: activate, region, accessKeyId, configurationSet };
  if (clearSecret) body.secretAccessKey = "";
  else if (secret) body.secretAccessKey = secret;

  const res = await saveSesSettings(biz, body);
  revalidateDelivery(biz);
  return saveResult(res, "Amazon SES settings");
}

/**
 * Every screen that reports the transport, not just the form that changed it. The hub's
 * strip, its "not being delivered" banner and the OTHER transport's page all read the same
 * two settings, and the other transport's `enabled` flag flips server-side — so the page
 * that was not submitted is stale the moment this one saves.
 */
function revalidateDelivery(biz: string) {
  for (const p of ["", "/smtp", "/ses", "/test"])
    revalidatePath(`/businesses/${biz}/settings/emails/delivery${p}`);
  revalidatePath(`/businesses/${biz}/settings/emails`);
}

/**
 * Lift a suppression, so this business can email the address again.
 *
 * Deliberately reversible: a mailbox that was full in March may be fine in June, and a
 * suppression added from one bad bounce should not be a life sentence the merchant cannot
 * overturn. The revalidate is what makes the row disappear from the list immediately —
 * without it the operator clicks Remove and the address is still sitting there.
 */
export async function removeSuppressionAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const address = str(fd, "address");
  if (!biz || !address)
    return actionError("The business ID or the address is missing. Reload the page.");
  const res = await deleteSuppression(biz, address);
  revalidatePath(`/businesses/${biz}/settings/emails/suppressions`);
  revalidatePath(`/businesses/${biz}/settings/emails`);
  if (!res.ok) return actionError(res.error ?? `We could not remove ${address}.`);
  return actionOk(`${address} removed. We can email it again.`);
}

/** Open a connection and authenticate. Writes nothing; reports what the relay said. */
export async function testSmtpConnectionAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const res = await testSmtpConnection(biz);
  if (!res.ok) return actionError(res.error ?? "We could not connect to the SMTP server.");
  const data = res.data as { ok?: boolean; error?: string | null } | undefined;
  return data?.ok
    ? actionOk("Connected to the SMTP server and authenticated.")
    : actionError(data?.error ?? "The SMTP server refused the connection.");
}

/**
 * Render a real template with sample data and send it now. Reports the transport that
 * carried it, because "sent" through the console sink means nothing arrived — the single
 * most misleading thing this screen could say.
 */
export async function sendTestEmailAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const to = str(fd, "test_to");
  const type = str(fd, "test_type");
  if (!to)
    return actionError("Enter an address for the test email.", { errors: { test_to: "Required" } });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
    return actionError("Enter a valid email address.", {
      errors: { test_to: "Invalid email" },
    });
  if (!type) return actionError("Select the email to send.", { errors: { test_type: "Required" } });

  const res = await sendTestEmail(biz, { to, type });
  revalidatePath(`/businesses/${biz}/emails`);
  // The hub's activity counts move the moment a test is sent.
  revalidatePath(`/businesses/${biz}/settings/emails`);
  if (!res.ok) return actionError(res.error ?? "We could not send the test email.");
  const data = res.data as { ok?: boolean; error?: string | null; transport?: string } | undefined;
  if (!data?.ok) return actionError(data?.error ?? "The transport rejected the test email.");
  return data.transport === "console"
    ? actionOk(
        `We wrote the email to the console dev sink. Nothing was delivered to ${to}. Enable a custom SMTP relay to send real email.`,
      )
    : actionOk(`Test email sent to ${to} through ${data.transport}.`);
}

export async function saveCreditNotesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const body: BusinessSettingsPatch = {};
  const prefix = str(fd, "credit_note_prefix");
  if (!prefix)
    return actionError("Enter a number prefix.", { errors: { credit_note_prefix: "Required" } });
  if (prefix.length > 20)
    return actionError("The number prefix is too long. Use 20 characters or fewer.", {
      errors: { credit_note_prefix: "Max 20 characters" },
    });
  body.credit_note_prefix = prefix;
  const nextNo = num(fd, "credit_note_next_number");
  if (nextNo != null) {
    if (!Number.isInteger(nextNo) || nextNo < 1)
      return actionError("Enter a whole number of 1 or more for the next credit note number.", {
        errors: { credit_note_next_number: "Must be ≥ 1" },
      });
    body.credit_note_next_number = nextNo;
  }
  if (Object.keys(body).length === 0) return actionError("There are no changes to save.");
  return patch(biz, body, fd, "Credit-note settings");
}

/** Settings → Receipts. Only the prefix: receipts are batch-numbered, so the counter is not settable. */
export async function saveReceiptSettingsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const prefix = str(fd, "receipt_prefix");
  if (!prefix)
    return actionError("Enter a number prefix.", { errors: { receipt_prefix: "Required" } });
  if (prefix.length > 20)
    return actionError("The number prefix is too long. Use 20 characters or fewer.", {
      errors: { receipt_prefix: "Max 20 characters" },
    });
  const res = await patch(biz, { receipt_prefix: prefix }, fd, "Receipt settings");
  revalidatePath(`/businesses/${biz}/settings/receipts`);
  return res;
}

export async function saveDunningAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  // Parsed by the same helper as the named policies, so both read the form identically.
  const parsed = parseDunningForm(fd);
  if ("error" in parsed) return parsed.error;
  const { perInvoice, days, collectOnPm, cancelNoPmAtRenewal } = parsed.data;

  // The API assigns `dunning_config` whole, so start from the stored one: keys this
  // form does not render (`require_successful_charge_on_reactivation`, owned by
  // Billing rules → Subscription reactivation) must survive a save here.
  let current;
  try {
    current = await getBusiness(biz);
  } catch (e) {
    return actionError((e as Error).message);
  }
  if (!current) return actionError(`We could not find the business ${biz}.`);
  // An empty schedule means "use the engine default (1, 3, 5, 7)": drop the stored
  // `retries` rather than sending [], so resolveDunningConfig falls back.
  const { retries: _storedRetries, ...kept } = current.dunning_config ?? {};

  const body: BusinessSettingsPatch = {
    dunning_config: {
      ...kept,
      ...perInvoice,
      collect_on_payment_method_update: collectOnPm,
      no_payment_method_at_renewal: cancelNoPmAtRenewal ? "cancel" : "follow_final_action",
    },
    // Keep the legacy column in sync for anything still reading it; null when the
    // merchant cleared the schedule, so both sources agree on "use the default".
    dunning_retry_days: days.length ? days : null,
  };
  return patch(biz, body, fd, "Dunning settings");
}

/** Settings → Subscription reminders: lead days per kind (0376), posted as "15, 3". */
export async function saveReminderTimingAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const kinds = ["trial_ending", "renewal", "renewal_yearly", "cancellation"] as const;
  const cfg = {} as ReminderLeadDays;
  const errors: Record<string, string> = {};
  for (const k of kinds) {
    const field = `lead_days_${k}`;
    const parts = str(fd, field)
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");
    const days = parts.map(Number);
    if (days.length === 0) errors[field] = "Enter at least one value.";
    else if (days.some((n) => !Number.isInteger(n) || n < 1 || n > 90))
      errors[field] = "Enter whole numbers of days from 1 to 90, with commas between them.";
    else if (days.length > 5) errors[field] = "Enter 5 values or fewer.";
    else if (new Set(days).size !== days.length) errors[field] = "Enter each value one time only.";
    else cfg[k] = days;
  }
  // Off (or the expiry month) unless "Days before" is selected; then 1 to 3 values.
  const more: Partial<ReminderConfig> = {};
  for (const k of ["payment_due", "pause", "resume", "card_expiring"] as const) {
    if (fd.get(`timing_${k}`) == null) continue;
    if (str(fd, `timing_${k}`) !== "days") {
      if (k === "card_expiring") more.card_expiring = "expiry_month";
      else more[k] = [];
      continue;
    }
    const field = `lead_days_${k}`;
    const days = str(fd, field)
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "")
      .map(Number);
    if (days.length === 0) errors[field] = "Enter at least one value.";
    else if (days.some((n) => !Number.isInteger(n) || n < 1 || n > 90))
      errors[field] = "Enter whole numbers of days from 1 to 90, with commas between them.";
    else if (days.length > 3) errors[field] = "Enter 3 values or fewer.";
    else if (new Set(days).size !== days.length) errors[field] = "Enter each value one time only.";
    else more[k] = days;
  }
  if (Object.keys(errors).length > 0)
    return actionError("Correct the highlighted fields.", { errors });
  return patch(biz, { reminder_config: { ...cfg, ...more } }, fd, "Reminder settings");
}

/**
 * Billing rules → Subscription reactivation.
 *
 * ⚠️ READ-THEN-MERGE, and it is not defensive coding — it is required. The settings API
 * assigns the column whole (`routes.ts`: `dunningConfig: d.dunning_config`), so a patch
 * carrying only this one key would REPLACE the stored config and drop the retry schedule,
 * the final action and the dunning period onto engine defaults. Every other writer of
 * this column renders every field and can rebuild it from the form; this page renders one
 * toggle, so it has to supply the rest itself.
 */
export async function saveReactivationAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  let current;
  try {
    current = await getBusiness(biz);
  } catch (e) {
    return actionError((e as Error).message);
  }
  if (!current) return actionError(`We could not find the business ${biz}.`);

  const body: BusinessSettingsPatch = {
    dunning_config: {
      ...(current.dunning_config ?? {}),
      // A switch posts nothing while unchecked, so presence IS the value.
      require_successful_charge_on_reactivation:
        fd.get("require_successful_charge_on_reactivation") != null,
    },
  };
  const rules = billingRulesFromForm(fd);
  if (rules) body.billing_rules_config = rules;
  return patch(biz, body, fd, "Reactivation settings");
}

/** Billing rules → Subscription cancellation. */
export async function saveCancellationAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const body: BusinessSettingsPatch = {};
  const cancel = str(fd, "default_cancel_option");
  if (cancel === "immediately" || cancel === "end_of_term") body.default_cancel_option = cancel;
  const credit = str(fd, "default_credit_option_for_cancel");
  if (credit === "prorate" || credit === "full" || credit === "none")
    body.default_credit_option_for_cancel = credit;
  // 'no_action' is the engine default and MUST be selectable — omitting it here
  // silently upgraded businesses to `invoice`, billing charges that were free before.
  const unbilled = str(fd, "default_unbilled_on_cancel");
  if (unbilled === "no_action" || unbilled === "invoice" || unbilled === "delete")
    body.default_unbilled_on_cancel = unbilled;
  // 0242: the two halves POST …/cancel already accepted per call. Same guard as the
  // three above — an unlisted value is dropped rather than sent, so a hand-edited form
  // cannot post a state the engine would reject.
  const ar = str(fd, "default_ar_handling_on_cancel");
  if (
    ar === "no_action" ||
    ar === "schedule_payment_collection" ||
    ar === "write_off" ||
    ar === "void"
  )
    body.default_ar_handling_on_cancel = ar;
  const refundable = str(fd, "default_refundable_credits_on_cancel");
  if (refundable === "no_action" || refundable === "schedule_refund")
    body.default_refundable_credits_on_cancel = refundable;
  const rules = billingRulesFromForm(fd);
  if (rules) body.billing_rules_config = rules;
  return patch(biz, body, fd, "Cancellation settings");
}

/**
 * Billing rules → Unbilled charges, 0242.
 *
 * Eight independent lifecycle events, each invoice-now or retain. The whole object is
 * sent every save: these are radio groups, so an absent key means "the merchant chose
 * nothing", which is not the same as "leave it as it was" — read-modify-write on a
 * partially-posted form is how a matrix silently loses a row.
 */
export async function saveUnbilledChargesMatrixAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  // THREE events. The other five either name operations this engine does not have, or
  // (reactivate, trial→active) are real operations with no invoice-now-vs-defer decision
  // point for a preference to reach.
  const EVENTS = ["on_create", "on_change", "on_one_time_charge"] as const;

  // Only an explicit choice is written. "follow" (or anything else) leaves the key unset,
  // so the event keeps following `default_invoice_immediately` on Update subscription.
  const cfg: NonNullable<BusinessSettingsPatch["unbilled_charges_config"]> = {};
  for (const k of EVENTS) {
    const v = str(fd, k);
    if (v === "invoice_immediately" || v === "add_to_unbilled") cfg[k] = v;
  }
  return patch(biz, { unbilled_charges_config: cfg }, fd, "Unbilled charge settings");
}

/**
 * Billing rules → Pause & resume, 0242.
 *
 * `locked` is the "prevent overriding" list and is ADVISORY here — nothing enforces it
 * yet. It is still saved, because the alternative is a checkbox that discards what the
 * merchant said; the settings page says plainly that it records intent.
 */
export async function savePauseResumeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const pick = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
    const v = str(fd, k);
    return (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  };

  const cfg: NonNullable<BusinessSettingsPatch["pause_config"]> = {
    pause_option: pick("pause_option", ["immediately", "end_of_term"] as const),
    unbilled_on_pause: pick("unbilled_on_pause", ["retain", "invoice"] as const),
    dunning_on_pause: pick("dunning_on_pause", ["continue", "stop"] as const),
    charges_on_resume: pick("charges_on_resume", [
      "invoice_immediately",
      "add_to_unbilled_charges",
    ] as const),
    // The engine's own literals — a `retain`/`collect` vocabulary here would be dropped
    // by `pick` and the merchant's choice silently discarded.
    unpaid_invoices_on_resume: pick("unpaid_invoices_on_resume", [
      "no_action",
      "schedule_payment_collection",
    ] as const),
    locked: fd.getAll("locked").map(String).filter(Boolean),
  };
  return patch(biz, { pause_config: cfg }, fd, "Pause and resume settings");
}

/**
 * Billing rules → Backdating, 0242.
 *
 * The only screen in this set that TIGHTENS behaviour rather than choosing between two
 * equivalent ones, so it is the only one where a mis-save refuses work that used to
 * succeed. `cutoff_day_of_month` therefore keeps an explicit "no restriction" (empty →
 * null) instead of treating a blank as zero.
 */
export async function saveBackdatingAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  // Three, not five: reactivation and one-time charges accept no past-dated instant,
  // so there is no guard for a preference about them to reach.
  const ACTIONS = ["create", "change", "cancel", "reactivate"] as const;
  const posted = new Set(fd.getAll("allowed_actions").map(String));
  const day = num(fd, "cutoff_day_of_month");

  return patch(
    biz,
    {
      backdating_config: {
        enabled: bool(fd, "enabled"),
        allowed_actions: ACTIONS.filter((a) => posted.has(a)),
        // Out-of-range is clamped to "no restriction" rather than rejected: the API caps
        // it at 1..10, and sending 0 or 31 would 400 a form the merchant cannot see the
        // error on.
        cutoff_day_of_month: day != null && day >= 1 && day <= 10 ? day : null,
        allow_past_invoice_date_on_create: bool(fd, "allow_past_invoice_date_on_create"),
        allow_past_invoice_date_on_change: bool(fd, "allow_past_invoice_date_on_change"),
      },
    },
    fd,
    "Backdating settings",
  );
}

/** Billing rules → Update subscription. */
export async function saveUpdateSubscriptionAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const body: BusinessSettingsPatch = {
    default_prorate_on_change: bool(fd, "default_prorate_on_change"),
    default_invoice_immediately: bool(fd, "default_invoice_immediately"),
  };
  const rules = billingRulesFromForm(fd);
  if (rules) body.billing_rules_config = rules;
  return patch(biz, body, fd, "Subscription update settings");
}

/**
 * The `billing_rules_config` keys this form posted; null when it posted none. An unlisted
 * value is dropped. The reason switches post only while on, so `required_reasons_form`
 * marks a form that owns them.
 */
function billingRulesFromForm(fd: FormData): BillingRulesPatch | null {
  const out: BillingRulesPatch = {};
  const one = <T extends string>(key: keyof BillingRulesPatch, allowed: readonly T[]) => {
    const v = str(fd, key);
    if (v && (allowed as readonly string[]).includes(v)) (out as Record<string, unknown>)[key] = v;
  };
  one("trial_end_action", ["activate", "cancel", "pause"] as const);
  one("specific_date_cancel_final_period", ["full_period", "prorated", "nothing"] as const);
  one("failed_change_charge", ["start_dunning", "next_renewal"] as const);
  one("new_customer_auto_collection", ["on", "off"] as const);
  one("mandate_revoked", [
    "follow_dunning",
    "cancel_now",
    "cancel_at_term_end",
    "pause",
    "request_new_mandate",
  ] as const);
  // Payment application (2.51, 2.66, 2.69): the screen offers `customer_chooses` only when
  // it is already stored, so posting it back keeps it.
  const pa: NonNullable<BillingRulesPatch["payment_application"]> = {};
  const paOne = <K extends keyof typeof pa>(key: K, allowed: readonly string[]) => {
    const v = str(fd, `pa_${key}`);
    if (v && allowed.includes(v)) (pa as Record<string, unknown>)[key] = v;
  };
  paOne("several_due_invoices", ["separate", "combined", "customer_chooses"]);
  paOne("invoice_order", ["oldest_first", "newest_first", "customer_chooses"]);
  paOne("excess_payment", ["credit", "refund", "customer_chooses"]);
  if (Object.keys(pa).length) out.payment_application = pa;
  // Credit and allowance resets (design-G3b § 6).
  const pc: NonNullable<BillingRulesPatch["plan_credits"]> = {};
  const pcOne = <K extends keyof typeof pc>(key: K, allowed: readonly string[]) => {
    const v = str(fd, `pc_${key}`);
    if (v && allowed.includes(v)) (pc as Record<string, unknown>)[key] = v;
  };
  pcOne("on_upgrade", PLAN_CREDIT_UPGRADES);
  pcOne("on_downgrade", PLAN_CREDIT_DOWNGRADES);
  pcOne("first_window", PLAN_CREDIT_FIRST_WINDOWS);
  pcOne("on_pause", PLAN_CREDIT_PAUSES);
  pcOne("on_cancel_at_period_end", PLAN_CREDIT_CANCEL_AT_PERIOD_ENDS);
  if (Object.keys(pc).length) out.plan_credits = pc;
  const allowanceUpgrade = str(fd, "al_on_upgrade");
  if (allowanceUpgrade && (ALLOWANCE_UPGRADES as readonly string[]).includes(allowanceUpgrade))
    out.allowances = { on_upgrade: allowanceUpgrade as AllowanceResets["on_upgrade"] };
  one("upgrade_proration", ["prorated", "none"] as const);
  one("downgrade_proration", ["prorated", "none"] as const);
  one("upgrade_gate", ["off", "invoices_paid"] as const);
  one("downgrade_gate", ["off", "invoices_paid"] as const);
  Object.assign(out, timingRulesFromForm(fd));
  // Subscription lifecycle.
  one("plan_change_term", ["keep_anchor", "reset_on_upgrade", "reset_on_any_change"] as const);
  one("plan_change_coupons", ["keep", "drop", "keep_if_valid"] as const);
  one("downgrade_credit", ["credit_balance", "refund", "customer_chooses"] as const);
  one("reactivation_charges", ["invoice_immediately", "add_to_unbilled_charges"] as const);
  if (fd.get("required_reasons_form") === "1")
    out.required_reasons = {
      cancel_subscription: fd.get("require_reason_cancel_subscription") != null,
      void_invoice: fd.get("require_reason_void_invoice") != null,
      create_credit_note: fd.get("require_reason_create_credit_note") != null,
      refund: fd.get("require_reason_refund") != null,
    };
  return Object.keys(out).length ? out : null;
}

/** Billing rules → the pages that own only `billing_rules_config` keys. */
export async function saveBillingRulesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const rules = billingRulesFromForm(fd);
  if (!rules) return actionError("We could not save the settings. The form sent no values.");
  return patch(biz, { billing_rules_config: rules }, fd, "Billing rules");
}

/**
 * Billing rules → Billing mode (calendar days vs milliseconds).
 *
 * The form posts one of the three named modes; the API stores the two granularity axes
 * they map to. Sending both axes every time keeps the pair internally consistent — the
 * API rejects day-anchored + exact proration, which no mode here can produce.
 */
export async function saveBillingModeAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const mode = str(fd, "billing_mode");
  if (!mode || !isBillingModeId(mode)) return actionError("Select a billing mode.");
  const { anchor_granularity, proration_granularity } = BILLING_MODES[mode];
  const body: BusinessSettingsPatch = { anchor_granularity, proration_granularity };
  // Midnight-aligned terms floor to start-of-day in the business timezone, so a
  // timezone must actually be set or the mode silently falls back to UTC days. The
  // settings page surfaces that as a tip rather than blocking the save.
  return patch(biz, body, fd, "Billing mode");
}

/** Billing rules → Round-off invoice amount. */
/**
 * Hosted pages → may a customer type a coupon code (`allow_customer_coupons`, 0238)?
 *
 * A `SwitchField` posts nothing when it is OFF (an unchecked control has no value — the
 * hidden input renders only while checked), so absence IS the off answer here rather than
 * "not touched". Safe because this form carries exactly one control: if it was submitted
 * at all, the switch's state is on the wire one way or the other. A form that ever gains a
 * second field must switch to an explicit hidden marker.
 */
export async function saveHostedPagesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const allowSkip = bool(fd, "allow_skip_renewal");
  const skipLimit = num(fd, "skip_renewal_limit");
  const skipLimitValid =
    skipLimit != null && Number.isInteger(skipLimit) && skipLimit >= 1 && skipLimit <= 12;
  // Checked only while skipping is on: the field is hidden, not removed, when it is off.
  if (allowSkip && !skipLimitValid)
    return actionError("Correct the highlighted fields.", {
      errors: { skip_renewal_limit: "Enter a whole number from 1 to 12." },
    });
  // Posted only while the coupon box is on (the field is hidden, not removed, when off).
  const couponLimit = num(fd, "max_customer_coupon_codes");
  const couponLimitValid =
    couponLimit != null && Number.isInteger(couponLimit) && couponLimit >= 1 && couponLimit <= 10;
  if (fd.get("allow_customer_coupons") === "on" && !couponLimitValid)
    return actionError("Correct the highlighted fields.", {
      errors: { max_customer_coupon_codes: "Enter a whole number from 1 to 10." },
    });
  const requireTerms = bool(fd, "require_terms");
  const termsUrl = strOrNull(fd, "terms_url");
  // The back link leaves the portal: https only (the engine refuses http too).
  const portalReturnUrl = strOrNull(fd, "portal_return_url");
  if (portalReturnUrl && !portalReturnUrl.startsWith("https://"))
    return actionError("Correct the highlighted fields.", {
      errors: { portal_return_url: "Enter a URL that starts with https://." },
    });
  const seatMin = num(fd, "seat_min");
  const seatMax = num(fd, "seat_max");
  if (seatMin != null && seatMax != null && seatMin > seatMax)
    return actionError("Correct the highlighted fields.", {
      errors: { seat_max: "Enter a maximum that is not less than the minimum." },
    });
  if (requireTerms && !termsUrl)
    return actionError("Correct the highlighted fields.", {
      errors: { terms_url: "Enter the URL of your terms." },
    });
  return patch(
    biz,
    {
      allow_customer_coupons: fd.get("allow_customer_coupons") === "on",
      ...(couponLimitValid ? { max_customer_coupon_codes: couponLimit } : {}),
      // 0243 — the `advanced_settings` group. Sent whole: these are switches and two
      // URLs, and a partially-posted form must not read as "leave the rest alone".
      storefront_config: {
        hide_zero_value_lines: bool(fd, "hide_zero_value_lines"),
        collect_po_number: bool(fd, "collect_po_number"),
        default_return_url: strOrNull(fd, "default_return_url"),
        default_cancel_url: strOrNull(fd, "default_cancel_url"),
        // Portal self-service permissions (2026-09-09). `bool` reads an unchecked switch as
        // false, which is what we want even though these DEFAULT to true: the form always
        // renders all three, so an absent value means the operator turned it off — not
        // "unspecified". Sent whole for the same reason as the rest of this object.
        allow_invoice_download: bool(fd, "allow_invoice_download"),
        allow_invoice_payment: bool(fd, "allow_invoice_payment"),
        allow_remove_payment_method: bool(fd, "allow_remove_payment_method"),
        allow_cancel_subscription: bool(fd, "allow_cancel_subscription"),
        // A select, so it always posts; the enum is validated by the engine and an
        // unrecognised value resolves to `end_of_term` rather than `immediately`.
        cancel_timing: str(fd, "cancel_timing") === "immediately" ? "immediately" : "end_of_term",
        allow_pause_resume: bool(fd, "allow_pause_resume"),
        allow_reactivate: bool(fd, "allow_reactivate"),
        allow_skip_renewal: allowSkip,
        ...(skipLimitValid ? { skip_renewal_limit: skipLimit } : {}),
        // Rich text from the editor; empty clears it back to the default copy.
        portal_link_error_html: strOrNull(fd, "portal_link_error_html"),
        one_time_save_payment_method: ((v) => (v === "never" || v === "always" ? v : "ask"))(
          str(fd, "one_time_save_payment_method"),
        ),
        portal_show_usage: bool(fd, "portal_show_usage"),
        portal_show_usage_projection: bool(fd, "portal_show_usage_projection"),
        recurring_consent: bool(fd, "recurring_consent"),
        require_terms: requireTerms,
        terms_url: termsUrl,
        privacy_url: strOrNull(fd, "privacy_url"),
        marketing_consent: bool(fd, "marketing_consent"),
        checkout_layout: str(fd, "checkout_layout") === "one_page" ? "one_page" : "steps",
        wallets_first: bool(fd, "wallets_first"),
        bot_check_after_failures: ((n) =>
          n != null && Number.isInteger(n) && n >= 1 && n <= 20 ? n : null)(
          num(fd, "bot_check_after_failures"),
        ),
        allow_plan_changes: bool(fd, "allow_plan_changes"),
        seat_changes: ((v) => (v === "increase" || v === "both" ? v : "off"))(
          str(fd, "seat_changes"),
        ),
        seat_min: ((n) => (n != null && Number.isInteger(n) && n >= 1 ? n : null))(
          num(fd, "seat_min"),
        ),
        seat_max: ((n) => (n != null && Number.isInteger(n) && n >= 1 ? n : null))(
          num(fd, "seat_max"),
        ),
        allow_addon_changes: bool(fd, "allow_addon_changes"),
        shorter_period: ((v) => (v === "never" || v === "after_12_months" ? v : "always"))(
          str(fd, "shorter_period"),
        ),
        charge_upgrade: ((v) => (v === "now" || v === "next_invoice" ? v : "business_default"))(
          str(fd, "charge_upgrade"),
        ),
        change_statuses: (["active", "in_trial", "paused"] as const).filter((st) =>
          bool(fd, `change_status_${st}`),
        ),
        allow_cancel_scheduled_change: bool(fd, "allow_cancel_scheduled_change"),
        cancel_reason: ((v) => (v === "off" || v === "required" ? v : "optional"))(
          str(fd, "cancel_reason"),
        ),
        retention_pause: bool(fd, "retention_pause"),
        retention_pause_months: ((v) => {
          if (v === "none") return null;
          const n = Number(v);
          return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 3;
        })(str(fd, "retention_pause_months")),
        retention_pause_choice: bool(fd, "retention_pause_choice"),
        retention_downgrade_price: strOrNull(fd, "retention_downgrade_price"),
        retention_coupon: strOrNull(fd, "retention_coupon"),
        retention_contact_url: strOrNull(fd, "retention_contact_url"),
        retention_offer_once: bool(fd, "retention_offer_once"),
        portal_email_code: bool(fd, "portal_email_code"),
        portal_link_hours: intOrNull(fd, "portal_link_hours", 1, 24),
        portal_email_link_days: intOrNull(fd, "portal_email_link_days", 1, 14),
        portal_session_hours: intOrNull(fd, "portal_session_hours", 1, 168),
        portal_hide_cancelled_subscriptions: bool(fd, "portal_hide_cancelled_subscriptions"),
        portal_hide_zero_invoices: bool(fd, "portal_hide_zero_invoices"),
        portal_hide_voided_invoices: bool(fd, "portal_hide_voided_invoices"),
        portal_actions: {
          pay_invoice: bool(fd, "portal_action_pay_invoice"),
          update_card: bool(fd, "portal_action_update_card"),
          change_plan: bool(fd, "portal_action_change_plan"),
          cancel: bool(fd, "portal_action_cancel"),
        },
        portal_return_url: portalReturnUrl,
      },
    },
    fd,
    "Hosted page settings",
  );
}

/**
 * Settings → Business profile → VIES VAT validation, 0243.
 *
 * The form posts "validate", not "disable". The point of the switch is the escape
 * hatch — VIES is a third party and goes down.
 */
export async function saveViesValidationAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  return patch(
    biz,
    { vies_validation_enabled: bool(fd, "vies_validation_enabled") },
    fd,
    "VAT validation setting",
  );
}

/**
 * Billing rules → Chargeback management, 0244.
 *
 * Sent whole: these are radio groups and two switches, and a partially-posted form must
 * not read as "leave the rest alone" on a policy that can cancel subscriptions.
 */
export async function saveChargebackAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");

  const SUB_ACTIONS = [
    "cancel_immediately",
    "cancel_end_of_term",
    "pause_indefinitely",
    "pause_end_of_term",
    "no_action",
  ] as const;
  const pickSub = (k: string) => {
    const v = str(fd, k);
    return (SUB_ACTIONS as readonly string[]).includes(v)
      ? (v as (typeof SUB_ACTIONS)[number])
      : undefined;
  };
  const invoice = str(fd, "on_lost_invoice");

  return patch(
    biz,
    {
      chargeback_config: {
        ...(invoice === "credit_note" || invoice === "no_action"
          ? { on_lost_invoice: invoice }
          : {}),
        on_initiated_subscription: pickSub("on_initiated_subscription"),
        on_lost_subscription: pickSub("on_lost_subscription"),
        cascade_to_other_subscriptions: bool(fd, "cascade_to_other_subscriptions"),
        stop_collecting_all: bool(fd, "stop_collecting_all"),
      },
    },
    fd,
    "Chargeback settings",
  );
}

export async function saveRoundOffAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const rounding = str(fd, "invoice_rounding");
  if (rounding !== "none" && rounding !== "nearest_unit")
    return actionError("Select a round-off mode.");
  return patch(biz, { invoice_rounding: rounding }, fd, "Round-off setting");
}

/**
 * Billing rules → Zero-value invoices. Writes `attachments.invoice_issued.skipZeroSend`, the
 * field the invoice email's own switch writes; the rest of that rule is kept.
 */
export async function saveZeroValueInvoicesAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const mode = str(fd, "zero_value_invoices");
  if (mode !== "finalize_and_send" && mode !== "finalize_no_send")
    return actionError("Select what we do with a zero-value invoice.");
  let current: Record<string, { pdf: boolean; skipZeroPdf: boolean; skipZeroSend: boolean }>;
  try {
    current = (await getBusiness(biz))?.email_config?.attachments ?? {};
  } catch {
    return actionError("We could not read the current email settings. We saved nothing.");
  }
  const rule = current.invoice_issued ?? { pdf: true, skipZeroPdf: false, skipZeroSend: false };
  const res = await patchEmailConfig(
    biz,
    {
      attachments: {
        ...current,
        invoice_issued: { ...rule, skipZeroSend: mode === "finalize_no_send" },
      },
    },
    fd,
    "Zero-value invoices",
  );
  revalidatePath(`/businesses/${biz}/settings/billing-rules`);
  return res;
}

/** Billing rules → Card limit (`card_payment_limits`, 0482). An empty field = no limit. */
export async function saveCardLimitAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const limits: Record<string, number> = {};
  const errors: Record<string, string> = {};
  for (const c of str(fd, "currencies")
    .split(",")
    .filter((x) => /^[A-Z]{3}$/.test(x))) {
    const raw = str(fd, `limit_${c}`);
    if (!raw) continue;
    const major = Number(raw);
    if (!Number.isFinite(major) || major < 0) errors[`limit_${c}`] = "Enter 0 or a positive amount";
    else limits[c] = toMinor(major, c);
  }
  if (Object.keys(errors).length) return actionError("Correct the highlighted fields.", { errors });
  return patch(
    biz,
    { card_payment_limits: Object.keys(limits).length ? limits : null },
    fd,
    "Card limit",
  );
}

/**
 * Billing rules → Credits Flexibility (`credits_flexibility`).
 *
 * Four independent slots — refundable/excess × recurring/one-time — each posting a mode
 * and, for "apply up to a limit", an amount the operator typed in MAJOR units. The whole
 * object is written every save (all four slots are on one form), so there is nothing to
 * merge: what the screen shows is what gets stored.
 *
 * "Apply up to a limit" with no amount is REJECTED rather than downgraded to auto-apply.
 * The engine's resolver reads a limit with no amount as unlimited, so silently accepting
 * it would tell the merchant they had capped their credit while applying all of it — the
 * exact failure this feature exists to prevent.
 */
const CREDIT_SLOTS = [
  ["refundable", "recurring"],
  ["refundable", "one_time"],
  ["excess", "recurring"],
  ["excess", "one_time"],
] as const;

export async function saveCreditsFlexibilityAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  // Minor units per major unit for the amounts on this form — the screen edits money in
  // the business's own currency and the API takes minor units.
  const perMajor = num(fd, "minor_per_major") ?? 100;
  const config: NonNullable<BusinessSettingsPatch["credits_flexibility"]> = {};
  for (const [kind, cls] of CREDIT_SLOTS) {
    const field = `${kind}_${cls}`;
    const mode = str(fd, `${field}_mode`);
    if (mode !== "auto" && mode !== "none" && mode !== "limit")
      return actionError("Select an option for every credit type.");
    if (mode !== "limit") {
      (config[kind] ??= {})[cls] = { mode };
      continue;
    }
    const major = num(fd, `${field}_limit`);
    if (major == null || !Number.isFinite(major) || major < 0)
      return actionError("Enter the limit amount, or select a different option.", {
        errors: { [`${field}_limit`]: "Required" },
      });
    (config[kind] ??= {})[cls] = { mode, limit_minor: Math.round(major * perMajor) };
  }
  return patch(biz, { credits_flexibility: config }, fd, "Credits Flexibility");
}

/** Billing rules → Payment terms (Net-D). */
export async function savePaymentTermsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const due = num(fd, "default_due_days");
  if (due != null && (!Number.isInteger(due) || due < 0 || due > 365))
    return actionError("Enter payment terms from 0 to 365 days.", {
      errors: { default_due_days: "0–365" },
    });
  return patch(biz, { default_due_days: due }, fd, "Payment terms");
}

/**
 * Brand styles (0185) — logo, icon, favicon and brand colour.
 *
 * Its own action rather than a section of the profile form because it is its own
 * screen and its own save: these four fields are what a BUYER sees, and mixing
 * them into the profile form meant saving a time zone also rewrote the brand.
 */
const brandSchema = z.object({
  biz: z.string().min(1),
  logo_url: urlOrBlank.optional(),
  icon_url: urlOrBlank.optional(),
  favicon_url: urlOrBlank.optional(),
  // Mirrors the engine's own check (`^#[0-9a-fA-F]{6}$`) so a typo is caught in the
  // form rather than as a 400. The value is interpolated into a CSS custom property
  // and an inline style, so "looks like a colour" is not good enough.
  brand_color: z
    .union([
      z.literal(""),
      z
        .string()
        .trim()
        .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color, for example #FF6700."),
    ])
    .optional(),
});

export async function saveBrandAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const { data, error } = parseForm(brandSchema, fd);
  if (error) return error;
  return patch(
    data.biz,
    {
      logo_url: data.logo_url || null,
      icon_url: data.icon_url || null,
      favicon_url: data.favicon_url || null,
      brand_color: data.brand_color ? data.brand_color.toUpperCase() : null,
    },
    fd,
    "Brand styles",
  );
}

// ── Payment instructions (0241) ─────────────────────────────────────────────
// The instruction ROWS. The two global switches that decide which of them reach an
// invoice live in `invoice_customization` and are saved by
// savePaymentInstructionSettingsAction above.

/**
 * Label/value pairs arrive as parallel repeated inputs (`pi_field_label` /
 * `pi_field_value`) so a row can be added client-side without renumbering names. Pairs
 * where either half is blank are DROPPED rather than saved: a labelled blank on an
 * invoice reads as missing data, and the merchant did not choose to say nothing.
 */
function instructionFields(fd: FormData): Array<{ label: string; value: string }> {
  const labels = fd.getAll("pi_field_label").map((v) => String(v).trim());
  const values = fd.getAll("pi_field_value").map((v) => String(v).trim());
  const out: Array<{ label: string; value: string }> = [];
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i] ?? "";
    const value = values[i] ?? "";
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** Comma or space separated codes → a normalised list. Empty means "every invoice". */
function codeList(fd: FormData, key: string): string[] {
  return [
    ...new Set(
      str(fd, key)
        .split(/[,\s]+/)
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
}

export async function createPaymentInstructionAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const title = str(fd, "pi_section_title");
  if (!title)
    return actionError("Enter a section title.", {
      errors: { pi_section_title: "Required" },
    });
  const fields = instructionFields(fd);
  if (fields.length === 0)
    return actionError("Add at least one detail with a label and a value.", {
      errors: { pi_field_label: "Add a label and a value" },
    });
  const kind = str(fd, "pi_kind") === "paypal" ? "paypal" : "bank_transfer";
  const res = await createPaymentInstruction(biz, {
    kind,
    section_title: title,
    section_id: strOrNull(fd, "pi_section_id"),
    description: strOrNull(fd, "pi_description"),
    fields,
    currencies: codeList(fd, "pi_currencies"),
    countries: codeList(fd, "pi_countries"),
    position: num(fd, "pi_position") ?? 0,
  });
  revalidatePath(`/businesses/${biz}/settings/payment-instructions`);
  return saveResult(res, "Payment instruction");
}

export async function updatePaymentInstructionAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const id = str(fd, "pi_id");
  if (!biz || !id)
    return actionError("The business ID or the instruction ID is missing. Reload the page.");
  const title = str(fd, "pi_section_title");
  if (!title)
    return actionError("Enter a section title.", {
      errors: { pi_section_title: "Required" },
    });
  const fields = instructionFields(fd);
  if (fields.length === 0)
    return actionError("Add at least one detail with a label and a value.", {
      errors: { pi_field_label: "Add a label and a value" },
    });
  const ev = num(fd, "pi_expected_version");
  const res = await updatePaymentInstruction(biz, id, {
    section_title: title,
    section_id: strOrNull(fd, "pi_section_id"),
    description: strOrNull(fd, "pi_description"),
    fields,
    currencies: codeList(fd, "pi_currencies"),
    countries: codeList(fd, "pi_countries"),
    position: num(fd, "pi_position") ?? 0,
    ...(ev != null && ev >= 0 ? { expected_version: ev } : {}),
  });
  revalidatePath(`/businesses/${biz}/settings/payment-instructions`);
  return saveResult(res, "Payment instruction");
}

/** Archive, not delete — the engine keeps the row for already-issued invoices. */
export async function archivePaymentInstructionAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  const id = str(fd, "pi_id");
  if (!biz || !id)
    return actionError("The business ID or the instruction ID is missing. Reload the page.");
  const res = await archivePaymentInstruction(biz, id);
  revalidatePath(`/businesses/${biz}/settings/payment-instructions`);
  return saveResult(res, "Payment instruction");
}

/**
 * Billing rules → Usage close (`usage_close_delay_minutes`, 0–24). The engine closes a
 * period's usage about 6 minutes after it ends plus this wait, and never later than 30.
 */
export async function saveUsageCloseDelayAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const minutes = num(fd, "usage_close_delay_minutes") ?? 0;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24)
    return actionError("Enter a wait from 0 to 24 minutes.", {
      errors: { usage_close_delay_minutes: "0–24" },
    });
  return patch(biz, { usage_close_delay_minutes: minutes }, fd, "Usage close");
}

/** Billing rules → Mandates. A value equal to the platform default is stored as unset. */
export async function saveMandateSizingAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const biz = str(fd, "biz");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  const multiple = num(fd, "mandate_multiple");
  if (multiple == null || !Number.isFinite(multiple) || multiple < 1 || multiple > 10)
    return actionError("Enter a mandate ceiling from 1 to 10 times the charge.", {
      errors: { mandate_multiple: "1–10" },
    });
  const capRupees = num(fd, "mandate_cap_rupees");
  if (capRupees == null || !Number.isInteger(capRupees) || capRupees < 1)
    return actionError("Enter the ceiling cap as a whole number of rupees, 1 or more.", {
      errors: { mandate_cap_rupees: "1 or more" },
    });
  const bps = Math.round(multiple * 10_000);
  const capMinor = capRupees * 100;
  const cfg: NonNullable<BusinessSettingsPatch["mandate_config"]> = {};
  if (bps !== DEFAULT_MANDATE_HEADROOM_BPS) cfg.headroom_bps = bps;
  if (capMinor !== DEFAULT_MANDATE_RAIL_CAP_MINOR) cfg.rail_ceiling_cap_minor = capMinor;
  return patch(biz, { mandate_config: Object.keys(cfg).length ? cfg : null }, fd, "Mandates");
}
