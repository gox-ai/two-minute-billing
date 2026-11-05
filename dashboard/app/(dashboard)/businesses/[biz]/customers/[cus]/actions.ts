"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { apiPatch, apiPost } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { actionOk, actionError, parseForm } from "@/lib/action-result";
import { fmtDateTime, money } from "@/lib/format";
import { businessTz } from "@/lib/business-tz-server";
import type { ActionResult } from "@/lib/action-result";
import type { SecretLinkResult } from "@/lib/secret-link";

const cusUrl = (biz: string, cus: string) => `/businesses/${biz}/customers/${cus}`;

/** A required non-negative (or, with `positive`, strictly positive) whole `amount_minor`. */
const zWholeAmount = (message: string, positive = false) =>
  z
    .string()
    .trim()
    .refine((v) => v !== "" && /^\d+$/.test(v) && (!positive || Number(v) > 0), message);
/** An optional 3-letter ISO currency code — blank is fine, the caller defaults it. */
const zCurrencyOpt = z
  .string()
  .trim()
  .refine((v) => v === "" || v.length === 3, "Enter a 3-letter currency code");

// ── Promotional credits ──────────────────────────────────────────────────────

const promoCreditSchema = z.object({
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
  action: z.enum(["add", "deduct", "set"], { message: "Select an action" }),
  amount_minor: zWholeAmount("Enter a non-negative whole amount"),
  currency: zCurrencyOpt,
  description: z.string().max(500).optional(),
});

export async function managePromoCreditsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(promoCreditSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, cus, action, description } = parsed.data;
  const amount = Number(parsed.data.amount_minor);
  const currency = (parsed.data.currency || "USD").toUpperCase();
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/promotional_credits`, {
    action,
    amount_minor: amount,
    currency,
    ...(description ? { description } : {}),
  });
  revalidatePath(cusUrl(biz, cus));
  return res.ok
    ? actionOk(
        `Promotional credits ${action === "add" ? "added" : action === "deduct" ? "deducted" : "set"}`,
      )
    : actionError(
        res.error ?? "We could not change the promotional credits.",
        res.status === 409 ? { code: "conflict" } : undefined,
      );
}

// ── Record excess payment ────────────────────────────────────────────────────

const excessPaymentSchema = z.object({
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
  amount_minor: zWholeAmount("Enter a positive whole amount", true),
  currency: zCurrencyOpt,
  description: z.string().max(500).optional(),
  source: z.enum(["offline", "card"]).optional(),
});

export async function recordExcessPaymentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("credits:manage", "ops");
  const parsed = parseForm(excessPaymentSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, cus, description } = parsed.data;
  const amount = Number(parsed.data.amount_minor);
  const currency = (parsed.data.currency || "USD").toUpperCase();
  const source = parsed.data.source ?? "offline";

  // Both sources grow the same excess-payment bucket; they differ in whether money
  // moves. 'card' runs a real gateway charge via the wallet top-up endpoint (type
  // 'paid' credits EXCESS_PAYMENT), so a failed charge must credit nothing — which
  // is why it can't just be folded into record_excess_payment.
  const res =
    source === "card"
      ? await apiPost(`/v1/businesses/${biz}/customers/${cus}/wallet/topup`, {
          amount_minor: amount,
          currency,
          type: "paid",
        })
      : await apiPost(`/v1/businesses/${biz}/customers/${cus}/record_excess_payment`, {
          amount_minor: amount,
          currency,
          ...(description ? { description } : {}),
        });
  revalidatePath(cusUrl(biz, cus));
  return res.ok
    ? actionOk(
        source === "card" ? "Card charged. Excess payment recorded." : "Excess payment recorded",
      )
    : actionError(
        res.error ?? "We could not record the excess payment.",
        res.status === 409 ? { code: "conflict" } : undefined,
      );
}

// ── Refund excess credit ─────────────────────────────────────────────────────

const refundExcessSchema = z.object({
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
  pay: z.string().min(1, "The payment ID is missing. Reload the page."),
  amount_minor: zWholeAmount("Enter a positive amount", true),
  reason: z.string().max(500).optional(),
});

/**
 * Pays back money a payment left on the customer's excess credit. The engine routes a
 * payment on no invoice through the excess path — drawn from the credit, never booked as a
 * revenue refund — and refuses more than the payment still holds.
 */
export async function refundExcessPaymentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:refund", "manager");
  const parsed = parseForm(refundExcessSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, cus, pay, reason } = parsed.data;
  const res = await apiPost(`/v1/businesses/${biz}/payments/${pay}/refund`, {
    amount_minor: Number(parsed.data.amount_minor),
    ...(reason ? { reason } : {}),
  });
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok) return actionError(res.error ?? "We could not refund the payment.");
  const r = res.data as { status?: string; amount_minor?: number; currency?: string };
  const amount = r.amount_minor != null && r.currency ? money(r.amount_minor, r.currency) : null;
  if (r.status === "pending")
    return actionOk(
      `${amount ? `${amount} refund` : "Refund"} accepted by the gateway. It settles soon.`,
    );
  return actionOk(amount ? `${amount} refunded to the customer.` : "Refund sent to the customer.");
}

// ── Collect payment ──────────────────────────────────────────────────────────

const collectPaymentSchema = z.object({
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
  payment_method_id: z.string().trim().optional(),
});

/**
 * Collect the ticked invoices, each charged on its own, oldest first (the engine's
 * `collect_payment` with `invoice_ids`). The engine answers 200 even when a card is
 * declined — nothing charged is still a successful CALL — so the outcome is read from
 * what it did, and "nothing collected" comes back as an error the dialog shows.
 */
export async function collectPaymentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const parsed = parseForm(collectPaymentSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, cus } = parsed.data;
  const invoiceIds = formData
    .getAll("invoice_ids")
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (invoiceIds.length === 0) return actionError("Select at least one invoice to collect");
  const body: Record<string, unknown> = { invoice_ids: invoiceIds };
  const pmId = parsed.data.payment_method_id ?? "";
  if (pmId) body.payment_method_id = pmId;
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/collect_payment`, body);
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok)
    return actionError(
      res.error ?? "We could not collect the payment.",
      res.status === 409 ? { code: "conflict" } : undefined,
    );
  const data = res.data as
    | {
        charged?: number;
        applied?: { refundable?: number; excess?: number };
        invoices?: Array<{ id: string; status: string; amount_due_minor: number }>;
      }
    | undefined;
  const rows = data?.invoices ?? [];
  const paid = rows.filter((r) => r.status === "paid").length;
  const stillDue = rows.filter((r) => r.status !== "paid" && r.amount_due_minor > 0).length;
  const moved =
    (data?.charged ?? 0) + (data?.applied?.refundable ?? 0) + (data?.applied?.excess ?? 0);
  if (moved === 0)
    return actionError(
      "We did not collect any money yet. The charge was declined or is still pending. The invoice's payments show which.",
    );
  return actionOk(
    `${paid} invoice${paid === 1 ? "" : "s"} paid` +
      (stillDue ? ` · ${stillDue} still due. A charge failed, so we did not try the others.` : ""),
  );
}

// ── Assign payment method role ───────────────────────────────────────────────

export async function assignPaymentMethodRoleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payment_methods:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const cus = String(formData.get("cus") ?? "").trim();
  const pm = String(formData.get("pm") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  if (!biz || !cus || !pm)
    return actionError("The business, customer or payment method ID is missing. Reload the page.");
  if (!["primary", "backup", "none"].includes(role)) return actionError("The role is not valid.");
  const res = await apiPost(
    `/v1/businesses/${biz}/customers/${cus}/payment_methods/${pm}/assign_role`,
    { role },
  );
  revalidatePath(cusUrl(biz, cus));
  return res.ok
    ? actionOk(`Role set to ${role}`)
    : actionError(
        res.error ?? "We could not change the payment method role.",
        res.status === 409 ? { code: "conflict" } : undefined,
      );
}

// ── Change billing date ──────────────────────────────────────────────────────

const billingDateSchema = z.object({
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
  billing_date: z
    .string()
    .trim()
    .refine(
      (v) => v === "" || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 31),
      "Enter a day between 1 and 31",
    ),
  billing_date_mode: z.enum(["using_defaults", "manually_set"], {
    message: "Select a billing date mode",
  }),
});

export async function changeBillingDateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const parsed = parseForm(billingDateSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, cus, billing_date_mode: billingDateMode } = parsed.data;
  const billingDate =
    parsed.data.billing_date === "" ? undefined : Number(parsed.data.billing_date);
  const body: Record<string, unknown> = { billing_date_mode: billingDateMode };
  if (billingDate != null) body.billing_date = billingDate;
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/change_billing_date`, body);
  revalidatePath(cusUrl(biz, cus));
  return res.ok
    ? actionOk("Billing date changed")
    : actionError(
        res.error ?? "We could not change the billing date.",
        res.status === 409 ? { code: "conflict" } : undefined,
      );
}

// ── Add charge / quick charge (one-time invoice) ─────────────────────────────

/** One drafted charge line as the takeover's repeater serialises it. */
interface DraftLine {
  description?: string;
  amountMinor?: number;
  quantity?: number;
  price?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
}

/**
 * Create ONE invoice from every charge drafted on the takeover — both `Add Charge`
 * and `Create Quick Charge` repeat before committing, so N charges produce one
 * invoice the customer actually receives.
 *
 * Replaces a single-line dialog that asked for minor units (typing 800 for ₹800
 * billed ₹8.00) and mislabelled its "collect now" checkbox as "Quick Charge" —
 * which means ad-hoc, not collect-immediately.
 */
export async function addChargeAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("invoices:manage", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const cus = String(formData.get("cus") ?? "").trim();
  const currency = String(formData.get("currency") ?? "")
    .trim()
    .toUpperCase();
  const collect = formData.get("collect") != null;
  const applyTax = formData.get("apply_tax") != null;
  if (!biz || !cus) return actionError("The business or customer ID is missing. Reload the page.");

  let drafts: DraftLine[];
  try {
    drafts = JSON.parse(String(formData.get("lines") ?? "[]")) as DraftLine[];
  } catch {
    return actionError("We could not read the charges. Add them again.");
  }
  if (!Array.isArray(drafts) || drafts.length === 0) return actionError("Add at least one charge");

  const lines = drafts.map((d) => ({
    ...(d.description ? { description: d.description } : {}),
    ...(d.amountMinor != null ? { amount_minor: d.amountMinor } : {}),
    ...(d.quantity != null && d.quantity > 0 ? { quantity: d.quantity } : {}),
    ...(d.price ? { price: d.price } : {}),
    ...(d.periodStart ? { period_start: d.periodStart } : {}),
    ...(d.periodEnd ? { period_end: d.periodEnd } : {}),
  }));
  // Every line must resolve to an amount somehow: a catalog price rates itself,
  // an ad-hoc line must carry both a description and an amount. The API enforces
  // this too, but catching it here names the offending line.
  const bad = lines.findIndex(
    (l) => !("price" in l) && (!("description" in l) || !("amount_minor" in l)),
  );
  if (bad >= 0) return actionError(`Charge ${bad + 1} needs a description and an amount.`);

  const res = await apiPost(`/v1/businesses/${biz}/invoices`, {
    customer: cus,
    ...(currency.length === 3 ? { currency } : {}),
    lines,
    collect,
    apply_tax: applyTax,
  });
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok)
    return actionError(
      res.error ?? "We could not add the charge.",
      res.status === 409 ? { code: "conflict" } : undefined,
    );
  const inv = (res.data as { id?: string } | undefined)?.id;
  const n = lines.length;
  // The takeover is its own page, so success lands back on the record.
  return actionOk(
    `${n === 1 ? "Charge" : `${n} charges`} invoiced${inv ? ` on invoice ${inv}` : ""}`,
    cusUrl(biz, cus),
  );
}

// ── Record offline payment ───────────────────────────────────────────────────

const offlinePaymentSchema = z.object({
  biz: z.string().min(1, "The business ID is missing. Reload the page."),
  cus: z.string().min(1, "The customer ID is missing. Reload the page."),
  invoice: z.string().trim().min(1, "Select an invoice"),
  amount_minor: z
    .string()
    .trim()
    .refine((v) => v === "" || (/^\d+$/.test(v) && Number(v) > 0), "Enter a positive whole amount"),
  method: z.string().max(50).optional(),
});

export async function recordOfflinePaymentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const parsed = parseForm(offlinePaymentSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, cus, invoice, method } = parsed.data;
  const amount = parsed.data.amount_minor === "" ? undefined : Number(parsed.data.amount_minor);
  const res = await apiPost(`/v1/businesses/${biz}/invoices/${invoice}/pay`, {
    ...(amount != null ? { amount_minor: amount } : {}),
    ...(method ? { method } : {}),
  });
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok)
    return actionError(
      res.error ?? "We could not record the offline payment.",
      res.status === 409 ? { code: "conflict" } : undefined,
    );
  // Money over the outstanding balance becomes an excess-payment credit on the
  // customer rather than an over-application to the invoice — report it, so the
  // operator knows their surplus is on the customer and not lost.
  const d = res.data as { excess_credited_minor?: number; currency?: string } | undefined;
  const excess = d?.excess_credited_minor ?? 0;
  return actionOk(
    excess > 0
      ? `Offline payment recorded. We credited ${money(excess, d?.currency ?? "USD")} above the balance as an excess payment.`
      : "Offline payment recorded",
  );
}

// ── Validate VAT ─────────────────────────────────────────────────────────────

export async function validateVatAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const cus = String(formData.get("cus") ?? "").trim();
  if (!biz || !cus) return actionError("The business or customer ID is missing. Reload the page.");
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/validate_vat`, {});
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok)
    return actionError(
      res.error ?? "We could not check the VAT number.",
      res.status === 409 ? { code: "conflict" } : undefined,
    );
  const data = res.data as { vat_number_status?: string } | undefined;
  return actionOk(`VAT status: ${data?.vat_number_status ?? "checked"}`);
}

// ── Clear personal data (GDPR / irreversible) ────────────────────────────────

const clearPersonalDataSchema = z
  .object({
    biz: z.string().min(1, "The business ID is missing. Reload the page."),
    cus: z.string().min(1, "The customer ID is missing. Reload the page."),
    confirm_id: z.string().trim(),
  })
  .refine((d) => d.confirm_id === d.cus, {
    message: "The customer ID does not match. Type it exactly to confirm.",
    path: ["confirm_id"],
  });

export async function clearPersonalDataAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "admin");
  const parsed = parseForm(clearPersonalDataSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, cus } = parsed.data;
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/clear_personal_data`, {});
  revalidatePath(cusUrl(biz, cus));
  return res.ok
    ? actionOk("Personal data cleared. We deleted the PII and the saved cards at the gateway.")
    : actionError(
        res.error ?? "We could not clear the personal data.",
        res.status === 409 ? { code: "conflict" } : undefined,
      );
}

// ── Customer portal link (P14) ───────────────────────────────────────────────

/**
 * Mint a customer-scoped portal link (self-serve payment-method management).
 * The token is shown ONCE, in the reveal dialog that called this — never in the URL.
 *
 * `link_kind: 'email'` — five days, not the API default's one hour.
 *
 * The two kinds exist because the entry window is about how the link TRAVELS
 * (`customer-portal/service.ts`): `api` assumes an integration mints one and redirects a
 * user it has already authenticated, so nothing waits and an hour is generous. This
 * button is the opposite shape — an operator mints a link, copies it out of the dialog,
 * and hands it to a customer, usually by mail. It is read the next morning, after a
 * weekend, or when someone is back from leave. An hour there means a dead link.
 *
 * This action was sending no kind at all, so it took the one-hour default while the
 * label below promised **72 hours** — the session ceiling, which is a different clock
 * entirely and only starts once the buyer arrives. Operators were told they had three
 * days and had one hour.
 *
 * The label now renders the API's own `access_expires_at` rather than restating a
 * duration, so it cannot drift from the value again — which is how it broke the first
 * time. It also says **single-use**, because that is the property an operator has to
 * know before sending it: the entry credential is spent by the first GET of
 * `/portal/s/<token>`, and mail clients and security scanners PREFETCH links, so a link
 * can arrive already burned. That hazard is real and tracked; widening the window does
 * not fix it, and it is not made worse here.
 */
export async function createPortalLinkAction(biz: string, cus: string): Promise<SecretLinkResult> {
  await requirePermission("customers:manage", "ops");
  if (!biz || !cus)
    return { ok: false, error: "The business or customer ID is missing. Reload the page." };
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/portal_sessions`, {
    link_kind: "email",
  });
  if (!res.ok) return { ok: false, error: res.error ?? "We could not create the portal link." };
  // `access_expires_at` is when the LINK stops opening; `expires_at` is the ceiling on
  // the session it mints. The operator is handing over a link, so the first is the only
  // one that answers "how long do they have?".
  const data = res.data as {
    token: string;
    url?: string;
    access_expires_at: string;
    expires_at: string;
  };
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  // Only the exchange route (`/portal/s/<token>`) and `/portal` actually exist — the
  // pre-W1 `/portal/<token>` path 404s. This fallback only fires when PORTAL_BASE_URL
  // is unset and `data.url` is absent.
  const url = data.url ?? `${origin}/portal/s/${data.token}`;
  return {
    ok: true,
    label: `Payment method portal link. It works one time only, until ${fmtDateTime(data.access_expires_at, await businessTz(biz))}`,
    secret: url,
  };
}

// ── Shipping address book ────────────────────────────────────────────────────

const SHIP_KEYS = [
  "first_name",
  "last_name",
  "company",
  "phone",
  "line1",
  "line2",
  "line3",
  "city",
  "state",
  "state_code",
  "postal_code",
  "country",
] as const;

/** The `sa_*` fields <AddressFields prefix="sa_"> posts, blank → null so an edit clears it. */
function shippingBody(formData: FormData): Record<string, string | null> {
  const body: Record<string, string | null> = {};
  for (const k of SHIP_KEYS) {
    const v = String(formData.get(`sa_${k}`) ?? "").trim();
    body[k] = v === "" ? null : k === "country" ? v.toUpperCase() : v;
  }
  const label = String(formData.get("label") ?? "").trim();
  body.label = label || null;
  return body;
}

const shipPath = (biz: string, cus: string, addr?: string) =>
  `/v1/businesses/${biz}/customers/${cus}/shipping_addresses${addr ? `/${addr}` : ""}`;

function shipIds(formData: FormData) {
  return {
    biz: String(formData.get("biz") ?? "").trim(),
    cus: String(formData.get("cus") ?? "").trim(),
    addr: String(formData.get("addr") ?? "").trim(),
  };
}

export async function saveShippingAddressAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const { biz, cus, addr } = shipIds(formData);
  if (!biz || !cus) return actionError("The business or customer ID is missing. Reload the page.");
  const body: Record<string, unknown> = shippingBody(formData);
  if (!body.line1 || !body.country)
    return actionError("Correct the highlighted fields.", {
      errors: {
        ...(body.line1 ? {} : { sa_line1: "Enter the first address line" }),
        ...(body.country ? {} : { sa_country: "Select a country" }),
      },
    });
  if (!addr && formData.get("is_default") === "on") body.is_default = true;
  const res = addr
    ? await apiPatch(shipPath(biz, cus, addr), body)
    : await apiPost(shipPath(biz, cus), body);
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok)
    return actionError(res.error ?? `We could not ${addr ? "save" : "add"} the shipping address.`);
  return actionOk(addr ? "Shipping address saved." : "Shipping address added.");
}

export async function makeDefaultShippingAddressAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const { biz, cus, addr } = shipIds(formData);
  if (!biz || !cus || !addr)
    return actionError("The customer or address ID is missing. Reload the page.");
  const res = await apiPatch(shipPath(biz, cus, addr), { is_default: true });
  revalidatePath(cusUrl(biz, cus));
  return res.ok
    ? actionOk("Default shipping address changed.")
    : actionError(res.error ?? "We could not change the default shipping address.");
}

export async function archiveShippingAddressAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const { biz, cus, addr } = shipIds(formData);
  if (!biz || !cus || !addr)
    return actionError("The customer or address ID is missing. Reload the page.");
  const res = await apiPost(`${shipPath(biz, cus, addr)}/archive`, {});
  revalidatePath(cusUrl(biz, cus));
  // A 409 names the subscription that still ships here; show it as the engine wrote it.
  return res.ok
    ? actionOk("Shipping address archived.")
    : actionError(res.error ?? "We could not archive the shipping address.");
}

export async function restoreShippingAddressAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const { biz, cus, addr } = shipIds(formData);
  if (!biz || !cus || !addr)
    return actionError("The customer or address ID is missing. Reload the page.");
  const res = await apiPost(`${shipPath(biz, cus, addr)}/restore`, {});
  revalidatePath(cusUrl(biz, cus));
  return res.ok
    ? actionOk("Address restored.")
    : actionError(res.error ?? "We could not restore the shipping address.");
}

// ── Usage keys ───────────────────────────────────────────────────────────────

const usageKeySchema = z.object({
  biz: z.string().min(1),
  cus: z.string().min(1),
  key: z.string().trim().min(1, "Enter the usage key.").max(255, "Enter 255 characters or fewer."),
});

/** Attach a usage key. Events already sent with it are matched and billed (design G1a § 3.2). */
export async function addUsageKeyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "ops");
  const parsed = parseForm(usageKeySchema, fd);
  if (parsed.error) return parsed.error;
  const { biz, cus, key } = parsed.data;
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/usage_keys`, { key });
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok)
    return actionError(res.error ?? "We could not add the usage key.", {
      requestId: res.requestId,
      ...(res.status === 409
        ? { errors: { key: res.error ?? "Another customer has this key." } }
        : {}),
    });
  return actionOk("Usage key added.");
}

/** Remove a usage key. Events already matched stay with this customer. */
export async function removeUsageKeyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "ops");
  const parsed = parseForm(usageKeySchema, fd);
  if (parsed.error) return parsed.error;
  const { biz, cus, key } = parsed.data;
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/usage_keys/remove`, { key });
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok)
    return actionError(res.error ?? "We could not remove the usage key.", {
      requestId: res.requestId,
    });
  return actionOk("Usage key removed.");
}
