"use server";

import { currencyForCountry } from "@/lib/country-currency";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiPost, apiWrite, apiPatch, apiPut, apiDelete, listCustomers } from "@/lib/api";
import { requirePermission, requireUser } from "@/lib/session";
import { optUtcDateTime } from "@/lib/zod-utc";
import { money } from "@/lib/format";
import { subdivisionName } from "@/lib/countries";
import { getSubdivisions } from "@/lib/api/geo";
import {
  parseForm,
  actionOk,
  actionError,
  numberFromForm,
  slugField,
  type ActionResult,
} from "@/lib/action-result";
import { checkMetadata, metadataFromForm } from "@/lib/metadata-form";
import { meterPriceFields } from "@/lib/meter-price-form";
import { grantsCreditFields } from "@/lib/grants-credit-form";

// Server actions (BFF): run server-side, authenticated as the SIGNED-IN OPERATOR by
// forwarding their session cookie (0198). It used to be a single org-scoped API key,
// which is why this note once explained that the key "carries no per-user role" — the
// credential now does carry one, and the rule below is unchanged regardless.
//
// Each action re-checks the human's permission with requirePermission() BEFORE mutating.
// The page-level form gating is presentational only: an action is a network-invokable
// POST endpoint addressed by an id that ships in the public client bundle, so a guard on
// the page that renders the form does not protect the action. 23 actions were missing
// this check until 2026-08-27 (audit H4) — the guard belongs at the entry point, and
// before any try/catch, or a redirect() from it is swallowed and returned as a result.

// --- shared helpers ---
const catalogUrl = (biz: string, page: string) => `/businesses/${biz}/catalog/${page}`;
const cusUrl = (biz: string, cus: string) => `/businesses/${biz}/customers/${cus}`;
const subUrl = (biz: string, sub: string) => `/businesses/${biz}/subscriptions/${sub}`;
const withQuery = (base: string, q: Record<string, string | undefined>) => {
  const params = Object.entries(q)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`);
  return params.length ? `${base}?${params.join("&")}` : base;
};
/** Parse a numeric form field; '' or non-finite → undefined (never NaN/null in a body). */
function numOpt(formData: FormData, key: string): number | undefined {
  const v = String(formData.get(key) ?? "").trim();
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// --- Shared zod fragments for the customer/address forms (createCustomer, editCustomerAction) ---
// These validate FORMAT only, ahead of the existing procedural body-building below (which still
// owns "blank means clear vs blank means omit" semantics via nullableField/numOpt) — parseForm is
// used purely as a gate that returns per-field errors before any request is made. Blank is always
// accepted here (both create-omit and edit-clear are legitimate ""), the regex only fires on a
// non-empty value.
const trimStr = (v: unknown) => (typeof v === "string" ? v.trim() : v);
/** Digits, spaces and + ( ) - . — mirrors PHONE_RE in components/customers/address-fields.tsx
 *  and the backend's copy in src/api/customer-routes.ts; keep all three in lock-step. */
const zPhone = z.preprocess(
  trimStr,
  z.union([
    z.undefined(),
    z.literal(""),
    z.string().regex(/^\+?[\d\s().-]{6,20}$/, "Enter a valid phone number"),
  ]),
);
/** Lenient on purpose — see the backend comment on `vatNumberField` in customer-routes.ts. */
const zVatNumber = z.preprocess(
  trimStr,
  z.union([
    z.undefined(),
    z.literal(""),
    z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .-]{0,49}$/, "Enter a valid VAT/GST number"),
  ]),
);
const zEmail = z.preprocess(
  trimStr,
  z.union([z.undefined(), z.literal(""), z.string().email("Enter a valid email address")]),
);
/** Blank posts '' from a number input we leave empty; treat as "not provided", not 0. */
const zBoundedInt = (min: number, max: number) =>
  z.preprocess(
    (v) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : v),
    z.coerce.number().int().min(min).max(max).optional(),
  );
/** A one-time secret handed back in the action's result, shown once by the caller. */
export interface SecretActionResult extends ActionResult {
  reveal?: { label: string; secret: string };
}
const withSecret = (
  r: ActionResult,
  label: string,
  secret: string | undefined,
): SecretActionResult => (secret ? { ...r, reveal: { label, secret } } : r);

// --- Org-level (overview) ---

/**
 * Open the test mode of a live business that predates test modes: the engine creates its
 * test twin (a copy of the live settings) on first call. Then land on the same section.
 */
export async function openTestModeAction(formData: FormData) {
  await requirePermission("test_mode:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const section = String(formData.get("section") ?? "");
  const res = await apiPost(`/v1/businesses/${encodeURIComponent(biz)}/test_mode`, {});
  if (!res.ok) throw new Error(`We could not open test mode. ${res.error ?? ""}`.trim());
  const twin = (res.data as { id: string }).id;
  // The shell's business list now has a new row, and the live row a test_business_id.
  revalidatePath("/", "layout");
  redirect(
    `/businesses/${encodeURIComponent(twin)}${/^[a-z_]+$/.test(section) ? `/${section}` : ""}`,
  );
}

export async function createBusiness(formData: FormData) {
  const user = await requirePermission("businesses:create", "manager");
  const name = String(formData.get("name") ?? "").trim();
  const currency = String(formData.get("default_currency") ?? "")
    .trim()
    .toUpperCase();
  if (!name) return;
  // Creates the live business and its test mode together.
  const res = await apiPost("/v1/businesses", {
    name,
    // Required (0499). The form presets it from the sign-up country; a submit that arrives
    // before the picker hydrates carries no value, so fall back to the same preset.
    default_currency:
      currency.length === 3 ? currency : currencyForCountry(user.organization_country),
  });
  revalidatePath("/");
  const created = res.data as { id?: string; test_business_id?: string | null } | undefined;
  const testId = created?.test_business_id;
  // A locked organization cannot change its live business (0354), and a first business
  // starts in test mode, where the tour and the setup steps are safe to try.
  const first = formData.get("first") === "1";
  if (res.ok && testId && (first || user.organization_live_access !== "enabled")) {
    redirect(`/businesses/${testId}`);
  }
  if (res.ok && first && created?.id) redirect(`/businesses/${created.id}`);
}

// Format-only gate ahead of createCustomer's own body-building below — see the
// comment on the shared zod fragments above. `biz` has no visible field to blame
// (hidden input, always set from the route), so its message is a fallback only.
const createCustomerSchema = z
  .object({
    biz: z.string().min(1, "The business ID is missing. Reload the page."),
    email: zEmail,
    phone: zPhone,
    vat_number: zVatNumber,
    net_term_days: zBoundedInt(0, 365),
    addr_phone: zPhone,
    ship_phone: zPhone,
  })
  .passthrough();

export async function createCustomer(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const parsed = parseForm(createCustomerSchema, formData);
  if (parsed.error) return parsed.error;
  const biz = parsed.data.biz;
  const s = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v ? v : undefined;
  };
  // Billing address: same `addr_*` field set + <AddressFields> component as the
  // edit page, so create and edit stay in lock-step (line3, state_code, contact
  // sub-fields — this used to be a 6-field flat block with none of those).
  const address: Record<string, string | undefined> = {};
  for (const key of [
    "line1",
    "line2",
    "line3",
    "city",
    "state",
    "state_code",
    "postal_code",
    "country",
    "first_name",
    "last_name",
    "company",
    "phone",
  ]) {
    const v = s(`addr_${key}`);
    if (v) address[key] = key === "country" ? v.toUpperCase() : v;
  }
  const hasAddress = Object.keys(address).length > 0;
  // Shipping address (ship_*), omitted entirely when every field is blank so we
  // don't store an object of nulls on create.
  const ship: Record<string, string | undefined> = {};
  if (formData.get("ship_fields") === "1") {
    for (const key of [
      "line1",
      "line2",
      "line3",
      "city",
      "state",
      "state_code",
      "postal_code",
      "country",
      "first_name",
      "last_name",
      "company",
      "phone",
    ]) {
      const v = s(`ship_${key}`);
      if (v) ship[key] = key === "country" ? v.toUpperCase() : v;
    }
  }
  // Flat `cf_<api_name>` custom fields — the route collects these off the raw body.
  // Required ones MUST be sent or createCustomer's validateAndCoerce rejects the
  // create; blanks are sent as '' and treated as "not provided" by the service.
  const customFields: Record<string, string> = {};
  for (const key of new Set(formData.keys())) {
    if (!key.startsWith("cf_")) continue;
    const all = formData.getAll(key);
    customFields[key] = String(all[all.length - 1] ?? "");
  }
  const res = await apiPost(`/v1/businesses/${biz}/customers`, {
    ...customFields,
    ...(Object.keys(ship).length ? { shipping_address: ship } : {}),
    email: s("email"),
    first_name: s("first_name"),
    last_name: s("last_name"),
    company: s("company"),
    phone: s("phone"),
    currency: s("currency"),
    locale: s("locale"),
    auto_collection: formData.get("auto_collection") === "off" ? "off" : "on",
    net_term_days: numOpt(formData, "net_term_days") ?? undefined,
    invoice_notes: s("invoice_notes"),
    tax_exempt: formData.get("tax_exempt") === "true" ? true : undefined,
    email_notifications:
      formData.get("email_fields") === "1"
        ? formData.get("email_notifications") === "on"
        : undefined,
    dunning_excluded:
      formData.get("dunning_fields") === "1"
        ? formData.get("dunning_excluded") === "on"
        : undefined,
    exclude_from_reporting:
      formData.get("reporting_fields") === "1"
        ? formData.get("exclude_from_reporting") === "on"
        : undefined,
    // '' = "Business settings", which is the create default: send only a chosen policy.
    dunning_policy: formData.get("dunning_policy_field") === "1" ? s("dunning_policy") : undefined,
    vat_number: s("vat_number"),
    tax_registration_number: s("tax_registration_number"),
    tax_behavior: ((tb) => (tb === "inclusive" || tb === "exclusive" ? tb : undefined))(
      formData.get("tax_behavior"),
    ),
    ...(hasAddress ? { address } : {}),
  });
  if (!res.ok)
    return actionError(
      res.error ?? "We could not create the customer.",
      res.param === "metadata" ? { errors: { metadata: res.error ?? "" } } : undefined,
    );
  revalidatePath(`/businesses/${biz}/customers`);
  // A create lands on its new record (a URL change, so a redirect, not an in-place result).
  const newCus = (res.data as { id?: string } | undefined)?.id;
  redirect(
    newCus
      ? withQuery(cusUrl(biz, newCus), { msg: "Customer created" })
      : `/businesses/${biz}/customers`,
  );
}

export async function createContactAction(formData: FormData) {
  await requirePermission("customers:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const cus = String(formData.get("cus") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  if (!biz || !cus || !email) return;
  const s = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v ? v : undefined;
  };
  await apiPost(`/v1/businesses/${biz}/customers/${cus}/contacts`, {
    email,
    first_name: s("first_name"),
    last_name: s("last_name"),
    phone: s("phone"),
    label: s("label"),
    send_billing_email: formData.get("send_billing_email") === "on",
    send_account_email: formData.get("send_account_email") === "on",
  });
  revalidatePath(`/businesses/${biz}/customers/${cus}`);
}

export async function updateContactAction(formData: FormData) {
  await requirePermission("customers:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const cus = String(formData.get("cus") ?? "");
  const con = String(formData.get("con") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  if (!biz || !cus || !con || !email) return;
  // A blank field clears the stored value.
  const s = (k: string) => String(formData.get(k) ?? "").trim() || null;
  await apiPatch(`/v1/businesses/${biz}/customers/${cus}/contacts/${con}`, {
    email,
    first_name: s("first_name"),
    last_name: s("last_name"),
    label: s("label"),
    send_billing_email: formData.get("send_billing_email") === "on",
    send_account_email: formData.get("send_account_email") === "on",
  });
  revalidatePath(`/businesses/${biz}/customers/${cus}`);
}

export async function deleteContactAction(formData: FormData) {
  await requirePermission("customers:manage", "manager");
  const biz = String(formData.get("biz") ?? "");
  const cus = String(formData.get("cus") ?? "");
  const con = String(formData.get("con") ?? "");
  if (!biz || !cus || !con) return;
  await apiDelete(`/v1/businesses/${biz}/customers/${cus}/contacts/${con}`);
  revalidatePath(`/businesses/${biz}/customers/${cus}`);
}

// --- Catalog (M3) ---

// Map a product `kind` to its catalog sub-page.
const KIND_PAGE: Record<string, string> = { plan: "plans", addon: "addons", charge: "charges" };
const productPageFor = (kind?: string) => KIND_PAGE[kind ?? "plan"] ?? "plans";

const productKindSchema = z.enum(["plan", "addon", "charge"]);

const createProductSchema = z.object({
  biz: z.string().min(1),
  kind: productKindSchema.default("plan"),
  product_group: z.string().trim().min(1, "Select a product group").max(100),
  name: z
    .string()
    .trim()
    .min(1, "Internal name is required")
    .max(200, "Keep it under 200 characters"),
  external_name: z.string().trim().max(200, "Keep it under 200 characters").optional(),
  description: z.string().trim().max(2000).optional(),
  // The field always posts; "" means "make one from the name".
  code: slugField("Product ID").optional().or(z.literal("")),
  unit_of_measure: z.string().trim().max(100).optional(),
  tax_code: z.string().trim().max(20, "Keep it under 20 characters").optional(),
  redirect_url: z.string().trim().max(2000).optional(),
  // Addons/charges only: "applies to every plan", so no attached_items row is needed.
  // The column, its zod and its serializer all existed; nothing in the dashboard wrote it.
  addon_applies_to_all: z.string().optional(),
  metered: z.string().optional(),
  metadata: metadataFromForm,
  // "1" → also create the first price from the `pp_`-prefixed fields.
  with_price: z.string().optional(),
  return_to: z.string().optional(),
});

/** The new-plan form's `pp_` fields as a price FormData for `product`. */
function firstPriceForm(formData: FormData, biz: string, product: string): FormData {
  const fd = new FormData();
  fd.set("biz", biz);
  fd.set("product", product);
  for (const [k, v] of formData.entries()) if (k.startsWith("pp_")) fd.append(k.slice(3), v);
  return fd;
}
const prefixErrors = (r: ActionResult): ActionResult => ({
  ...r,
  errors: r.errors
    ? Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [`pp_${k}`, v]))
    : undefined,
});

export async function createProductAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(createProductSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  // Validate the price before creating anything, so a typo cannot leave a priceless plan.
  if (d.with_price === "1") {
    const check = parseForm(createPriceFormSchema, firstPriceForm(formData, d.biz, "pending"));
    if (check.error) return prefixErrors(check.error);
  }
  const res = await apiPost(`/v1/businesses/${d.biz}/products`, {
    name: d.name,
    kind: d.kind,
    ...(d.description ? { description: d.description } : {}),
    product_group: d.product_group,
    // The engine names it `id`; `code` was silently dropped, so every id was derived.
    ...(d.code ? { id: d.code } : {}),
    ...(d.metered === "on" ? { metered: true } : {}),
    ...(d.metadata ? { metadata: d.metadata } : {}),
    external_name: d.external_name,
    unit_of_measure: d.unit_of_measure,
    tax_code: d.tax_code,
    redirect_url: d.redirect_url,
    // Only meaningful for an attachable item; sending it for a plan would be noise the
    // engine ignores, and the form does not render the control there.
    ...(d.kind !== "plan" ? { addon_applies_to_all: d.addon_applies_to_all === "on" } : {}),
  });
  const back = d.return_to || catalogUrl(d.biz, productPageFor(d.kind));
  revalidatePath(back);
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "That ID is already in use", {
        errors: { code: res.error ?? "That ID is already in use" },
      });
    return actionError(res.error ?? "We could not create the product.");
  }
  const prod = (res.data as { id?: string } | undefined)?.id ?? "";
  const newUrl = prod ? `${catalogUrl(d.biz, "products")}/${prod}` : undefined;
  if (d.with_price === "1") {
    const priced = await createPriceV2Action(null, firstPriceForm(formData, d.biz, prod));
    if (!priced.ok) {
      // Two calls, not one transaction: the product exists, so reopen on its price form.
      const g = (k: string) => String(formData.get(`pp_${k}`) ?? "");
      redirect(
        withQuery(`${catalogUrl(d.biz, "products")}/${prod}/prices/new`, {
          currency: g("currency"),
          interval: g("type") === "one_time" ? undefined : g("interval"),
          type: g("type") === "one_time" ? "one_time" : undefined,
          error: `${d.name} was created, but its price was not: ${priced.message ?? "unknown error"}`,
        }),
      );
    }
    return actionOk(`${d.name} created with its first price`, newUrl);
  }
  return actionOk(`${d.name} created`, newUrl);
}

const importProductsSchema = z.object({
  biz: z.string().min(1),
  kind: productKindSchema.default("plan"),
  csv: z.string().trim().min(1, "Add at least one row"),
});

export async function importProductsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(importProductsSchema, formData);
  if (parsed.error) return parsed.error;
  const { biz, kind, csv } = parsed.data;
  const lines = csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let created = 0;
  const failed: string[] = [];
  for (const line of lines) {
    const comma = line.indexOf(",");
    const name = (comma === -1 ? line : line.slice(0, comma)).trim();
    const description = comma === -1 ? "" : line.slice(comma + 1).trim();
    if (!name) continue;
    const res = await apiPost(`/v1/businesses/${biz}/products`, {
      name,
      kind,
      ...(description ? { description } : {}),
    });
    if (res.ok) created++;
    else failed.push(name);
  }
  const page = productPageFor(kind);
  revalidatePath(catalogUrl(biz, page));
  if (failed.length) return actionError(`Imported ${created}; failed: ${failed.join(", ")}`);
  return actionOk(`Imported ${created}`);
}

const priceModelSchema = z.enum([
  "flat",
  "per_unit",
  "tiered",
  "volume",
  "stairstep",
  "usage",
  "package",
  "percentage",
  "graduated_percentage",
]);

const TIER_MODELS = ["tiered", "volume", "stairstep", "graduated_percentage"];

/** One tier row, matching the shape `PricingFields` serializes into the hidden `tiers` input. */
const priceTierRowSchema = z.object({
  upToMinor: z.number().int().positive().nullable(),
  unitAmountMinor: z.number().int().nonnegative().optional(),
  flatAmountMinor: z.number().int().nonnegative().optional(),
  rateBps: z.number().int().nonnegative().max(10000).optional(),
});

/** The engine's tier rules (src/modules/catalog/pricing.ts `tierListIssues`), for a field error. */
function tierRuleError(tiers: { upToMinor: number | null }[]): string | null {
  let prev = 0;
  for (const [i, t] of tiers.entries()) {
    const last = i === tiers.length - 1;
    if (t.upToMinor == null) {
      if (!last) return "Only the last tier can have no upper limit.";
      continue;
    }
    if (last) return "The last tier must have no upper limit. Leave its upper limit empty.";
    if (t.upToMinor <= prev) return "Each tier must end above the tier before it.";
    prev = t.upToMinor;
  }
  return null;
}

/** Parses + validates the tiers JSON string — a malformed payload is a field error, not a 500. */
const tiersFromForm = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (!raw || raw === "[]") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "We could not read the tier rows. Enter them again.",
      });
      return z.NEVER;
    }
    const result = z.array(priceTierRowSchema).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: 'Each tier needs a valid "up to" quantity and a per-unit or flat amount',
      });
      return z.NEVER;
    }
    const rule = tierRuleError(result.data);
    if (rule) {
      ctx.addIssue({ code: "custom", message: rule });
      return z.NEVER;
    }
    return result.data;
  });

const createPriceFormSchema = z
  .object({
    biz: z.string().min(1),
    product: z.string().trim().min(1, "Select a product").max(100),
    // Caller-named price id. Optional: blank lets the
    // engine derive `<product>-<CUR>-<Frequency>`, which is what every imported row uses.
    id: slugField("Price ID").optional().or(z.literal("")),
    model: priceModelSchema,
    type: z.enum(["recurring", "one_time"]).default("recurring"),
    currency: z
      .string()
      .trim()
      .length(3, "Select a currency")
      .transform((v) => v.toUpperCase()),
    interval: z.enum(["day", "week", "month", "year"]).optional(),
    interval_count: numberFromForm({ min: 1, message: "Frequency count must be at least 1" }),
    trial_period: numberFromForm({ min: 0, message: "Trial period must be zero or more" }),
    trial_period_unit: z.enum(["day", "week", "month", "year"]).optional(),
    trial_end_action: z.enum(["activate_subscription", "cancel_subscription"]).optional(),
    billing_cycles: numberFromForm({ min: 1, message: "Billing cycles must be at least 1" }),
    external_name: z.string().trim().max(200, "Keep it under 200 characters").optional(),
    name: z.string().trim().max(200, "Keep it under 200 characters").optional(),
    price_description: z.string().trim().max(2000).optional(),
    invoice_notes: z.string().trim().max(2000).optional(),
    show_desc_present: z.string().optional(),
    show_description_in_invoices: z.string().optional(),
    amount_minor: numberFromForm({
      min: 0,
      message: "Enter a non-negative whole number of minor units",
    }),
    usage_aggregation: z
      .enum(["sum", "max", "last", "count", "min", "avg", "unique", "weighted_sum"])
      .optional(),
    usage_recurring: z.string().optional(),
    usage_time_unit: z.enum(["hour", "day"]).optional(),
    package_size: numberFromForm({ min: 1, message: "Package size must be at least 1" }),
    percentage_bps: numberFromForm({
      min: 1,
      max: 10000,
      message: "Enter basis points from 1 to 10000 (10000 = 100%)",
    }),
    free_units: numberFromForm({ min: 0, message: "Free units must be zero or more" }),
    minimum_amount_minor: numberFromForm({ min: 0, message: "Minimum spend must be zero or more" }),
    bill_usage_monthly: z.string().optional(),
    commitment_amount_minor: numberFromForm({
      min: 1,
      message: "Minimum commitment must be more than zero",
    }),
    portal_min_quantity: numberFromForm({ min: 1, message: "Enter 1 or more" }),
    portal_max_quantity: numberFromForm({ min: 1, message: "Enter 1 or more" }),
    tiers: tiersFromForm,
    // A meter price posts its own fields; `meterPriceFields` reads them.
    meter_present: z.string().optional(),
    is_taxable_present: z.string().optional(),
    is_taxable: z.string().optional(),
    // HSN/SAC at the price (migration 0184). Overrides the product's code; blank
    // falls through to the product, then to the business default — the precedence
    // `__taxCodeForLine` enforces.
    tax_code: z.string().trim().max(20, "Keep it under 20 characters").optional(),
    // Descriptive only — nothing in the engine reads these.
    sku: z.string().trim().max(200).optional(),
    accounting_code: z.string().trim().max(200).optional(),
    accounting_category_code: z.string().trim().max(200).optional(),
    tax_behavior: z.enum(["inclusive", "exclusive"]).optional(),
    metadata: metadataFromForm,
    return_to: z.string().optional(),
  })
  .refine((v) => v.type !== "recurring" || !!v.interval, {
    message: "Select a billing frequency",
    path: ["interval"],
  })
  .refine(
    (v) =>
      !["flat", "per_unit", "usage", "package"].includes(v.model) ||
      v.amount_minor != null ||
      (v.model === "usage" && v.meter_present === "1"),
    {
      message: "Enter an amount for this pricing model",
      path: ["amount_minor"],
    },
  )
  .refine((v) => v.model !== "package" || v.package_size != null, {
    message: "Package size is required for package pricing",
    path: ["package_size"],
  })
  .refine((v) => v.model !== "percentage" || v.percentage_bps != null, {
    message: "Percentage (bps) is required for percentage pricing",
    path: ["percentage_bps"],
  })
  .refine((v) => !TIER_MODELS.includes(v.model) || (v.tiers && v.tiers.length > 0), {
    message: "Add at least one tier",
    path: ["tiers"],
  })
  .refine(
    (v) => v.model !== "graduated_percentage" || (v.tiers ?? []).every((t) => t.rateBps != null),
    { message: "Enter a rate for each tier.", path: ["tiers"] },
  );

/** Create a price for any of the 7 billing models; builds the model-specific body. */
export async function createPriceV2Action(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(createPriceFormSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const metered = d.model === "usage" ? meterPriceFields(formData, "create") : null;
  if (metered && !metered.ok)
    return actionError(metered.message, { errors: { [metered.field]: metered.message } });
  const credit = grantsCreditFields(formData);
  if (credit && !credit.ok)
    return actionError(credit.message, { errors: { [credit.field]: credit.message } });

  const body: Record<string, unknown> = {
    product: d.product,
    model: d.model,
    type: d.type,
    currency: d.currency,
  };
  if (d.interval_count) body.interval_count = d.interval_count;
  // CP-5: real trial + price depth.
  if (d.trial_period != null) {
    body.trial_period = d.trial_period;
    body.trial_period_unit = d.trial_period_unit ?? "day";
    if (d.trial_end_action) body.trial_end_action = d.trial_end_action;
  }
  if (d.billing_cycles != null) body.billing_cycles = d.billing_cycles;
  if (d.external_name) body.external_name = d.external_name;
  if (d.name) body.name = d.name;
  if (d.price_description) body.description = d.price_description;
  if (d.invoice_notes) body.invoice_notes = d.invoice_notes;
  if (d.show_desc_present === "1")
    body.show_description_in_invoices = d.show_description_in_invoices === "on";
  if (d.type === "recurring" && d.interval) body.interval = d.interval;
  if (["flat", "per_unit", "usage", "package"].includes(d.model) && d.amount_minor != null)
    body.amount_minor = d.amount_minor;
  // The form posts an aggregation only when the price bills recorded usage.
  if (d.usage_aggregation && d.type === "recurring") {
    body.usage_aggregation = d.usage_aggregation;
    if (d.usage_recurring === "on") body.usage_recurring = true;
    if (d.usage_aggregation === "weighted_sum" && d.usage_time_unit)
      body.usage_time_unit = d.usage_time_unit;
  } else if (d.model === "usage" && d.usage_aggregation) {
    body.usage_aggregation = d.usage_aggregation;
  }
  if (d.model === "package" && d.package_size != null) body.package_size = d.package_size;
  if ((d.model === "package" || d.model === "percentage") && d.free_units != null)
    body.free_units = d.free_units;
  if (d.model === "percentage" && d.percentage_bps != null) body.percentage_bps = d.percentage_bps;
  if (TIER_MODELS.includes(d.model)) body.tiers = d.tiers;
  if (d.type === "recurring" && d.minimum_amount_minor != null)
    body.minimum_amount_minor = d.minimum_amount_minor;
  if (d.type === "recurring" && d.bill_usage_monthly === "on") body.bill_usage_monthly = true;
  if (d.type === "recurring" && d.commitment_amount_minor != null)
    body.commitment_amount_minor = d.commitment_amount_minor;
  if (d.portal_min_quantity != null) body.portal_min_quantity = d.portal_min_quantity;
  if (d.portal_max_quantity != null) body.portal_max_quantity = d.portal_max_quantity;
  if (d.is_taxable_present === "1") body.is_taxable = d.is_taxable === "on";
  if (d.metadata) body.metadata = d.metadata;
  if (d.tax_behavior === "inclusive" || d.tax_behavior === "exclusive")
    body.tax_behavior = d.tax_behavior;
  if (d.id) body.id = d.id;
  if (d.tax_code) body.tax_code = d.tax_code;
  if (d.sku) body.sku = d.sku;
  if (d.accounting_code) body.accounting_code = d.accounting_code;
  if (d.accounting_category_code) body.accounting_category_code = d.accounting_category_code;
  // A meter price takes its aggregation from the meter and its rate from the rate card.
  if (metered) {
    delete body.usage_aggregation;
    delete body.amount_minor;
    Object.assign(body, metered.body);
  }
  if (credit?.ok && credit.value) body.grants_credit = credit.value;

  const res = await apiPost(`/v1/businesses/${d.biz}/prices`, body);
  const successUrl = d.return_to || catalogUrl(d.biz, "prices");
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "That price ID is already in use", {
        errors: { id: res.error ?? "That price ID is already in use" },
      });
    return actionError(res.error ?? "We could not create the price.");
  }
  revalidatePath(successUrl);
  return actionOk(`Price ${(res.data as { id?: string } | undefined)?.id ?? ""} created`);
}

// --- Money operations (M4) ---

/**
 * Add a taxable region (a country). `gst` regions get their CGST/SGST/IGST vector on
 * the region detail page — a country with no components yet taxes nothing, and the
 * detail page says so, rather than this form pretending to collect a single rate.
 */
export async function createTaxRegionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("taxes:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const country = String(formData.get("country") ?? "")
    .trim()
    .toUpperCase();
  const regime = String(formData.get("regime") ?? "flat").trim();
  const priceType = String(formData.get("price_type") ?? "exclusive").trim();
  const homeState = String(formData.get("home_state_code") ?? "")
    .trim()
    .toUpperCase();
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  if (country.length !== 2)
    return actionError("Enter a 2-letter ISO country code", {
      errors: { country: "Enter a 2-letter ISO country code" },
    });
  // Place of supply is what makes a GST region work at all; without the seller's own
  // state every supply would resolve as inter-state.
  if (regime === "gst" && !homeState)
    return actionError("A GST region needs the state your business is registered in", {
      errors: { home_state_code: "Select the state your business is registered in" },
    });
  const res = await apiPost(`/v1/businesses/${biz}/tax_regions`, {
    country,
    regime,
    price_type: priceType,
    ...(homeState ? { home_state_code: homeState } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not add the region.");
  revalidatePath(catalogUrl(biz, "tax"));
  return actionOk(`Region ${country} added`);
}

// --- Catalog edit / archive (FE-1) ---

/** '' → null (clear the field); absent → undefined (leave unchanged). */
function nullableField(formData: FormData, key: string): string | null | undefined {
  if (!formData.has(key)) return undefined;
  const v = String(formData.get(key) ?? "").trim();
  return v === "" ? null : v;
}

/** Zod equivalent of `nullableField`: '' → null (clear on PATCH), absent → undefined (unchanged). */
function zNullableString(max: number, message?: string) {
  return z
    .string()
    .max(max, message)
    .optional()
    .transform((v) => (v === undefined ? undefined : v.trim() === "" ? null : v.trim()));
}

const editProductSchema = z.object({
  biz: z.string().min(1),
  prod: z.string().min(1),
  kind: productKindSchema.optional(),
  name: z
    .string()
    .trim()
    .min(1, "Internal name is required")
    .max(200, "Keep it under 200 characters"),
  description: zNullableString(2000),
  // Blank/absent is silently ignored (a locked, hidden field always resends the
  // current group) — never a validation error, matching the pre-existing UI.
  product_group: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
  external_name: zNullableString(200, "Keep it under 200 characters"),
  unit_of_measure: zNullableString(100),
  tax_code: zNullableString(20, "Keep it under 20 characters"),
  redirect_url: zNullableString(2000),
  addon_applies_to_all_present: z.string().optional(),
  addon_applies_to_all: z.string().optional(),
  metered_present: z.string().optional(),
  metered: z.string().optional(),
  metadata_present: z.string().optional(),
  metadata: metadataFromForm,
  // Optimistic concurrency: the engine refuses the save if someone else saved first.
  expected_version: numberFromForm({ min: 0 }),
  return_to: z.string().optional(),
});

export async function editProductAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(editProductSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const body: Record<string, unknown> = { name: d.name };
  if (d.description !== undefined) body.description = d.description;
  if (d.kind) body.kind = d.kind;
  if (d.product_group) body.product_group = d.product_group;
  if (d.external_name !== undefined) body.external_name = d.external_name;
  if (d.unit_of_measure !== undefined) body.unit_of_measure = d.unit_of_measure;
  if (d.tax_code !== undefined) body.tax_code = d.tax_code;
  if (d.redirect_url !== undefined) body.redirect_url = d.redirect_url;
  if (d.addon_applies_to_all_present === "1")
    body.addon_applies_to_all = d.addon_applies_to_all === "on";
  if (d.metered_present === "1") body.metered = d.metered === "on";
  if (d.metadata_present === "1") body.metadata = d.metadata;
  if (d.expected_version != null) body.expected_version = d.expected_version;
  const res = await apiPatch(`/v1/businesses/${d.biz}/products/${d.prod}`, body);
  const back = d.return_to || catalogUrl(d.biz, productPageFor(d.kind || "plan"));
  revalidatePath(back);
  if (!res.ok) {
    if (res.status === 409)
      return actionError(
        "Someone else saved this since you opened it. Reload to see their version.",
        {
          code: "conflict",
        },
      );
    return actionError(res.error ?? "We could not update the product.");
  }
  return actionOk(`Product ${d.prod} updated`);
}

const editPriceSchema = z.object({
  biz: z.string().min(1),
  price: z.string().min(1),
  name: zNullableString(200, "Keep it under 200 characters"),
  amount_minor: numberFromForm({
    min: 0,
    message: "Enter a non-negative whole number of minor units",
  }),
  is_taxable_present: z.string().optional(),
  is_taxable: z.string().optional(),
  tax_behavior: z.enum(["inclusive", "exclusive"]).optional(),
  external_name: zNullableString(200, "Keep it under 200 characters"),
  description: zNullableString(2000),
  billing_cycles_present: z.string().optional(),
  billing_cycles: numberFromForm({ min: 1, message: "Billing cycles must be at least 1" }),
  trial_present: z.string().optional(),
  trial_period: numberFromForm({ min: 0, message: "Trial period must be zero or more" }),
  trial_period_unit: z.enum(["day", "week", "month", "year"]).optional(),
  invoice_notes_present: z.string().optional(),
  invoice_notes: zNullableString(2000),
  tax_code: zNullableString(20, "Keep it under 20 characters"),
  sku: zNullableString(200),
  accounting_code: zNullableString(200),
  accounting_category_code: zNullableString(200),
  show_desc_present: z.string().optional(),
  show_description_in_invoices: z.string().optional(),
  // Model-specific terms; posted only by the fields the price's model renders.
  tiers: tiersFromForm,
  package_size: numberFromForm({ min: 1, message: "Package size must be at least 1" }),
  free_units: numberFromForm({ min: 0, message: "Free units must be zero or more" }),
  percentage_bps: numberFromForm({
    min: 1,
    max: 10000,
    message: "Enter a percentage from 0.01 to 100",
  }),
  minimum_present: z.string().optional(),
  minimum_amount_minor: numberFromForm({ min: 0, message: "Minimum spend must be zero or more" }),
  term_billing_present: z.string().optional(),
  bill_usage_monthly: z.string().optional(),
  commitment_amount_minor: numberFromForm({
    min: 1,
    message: "Minimum commitment must be more than zero",
  }),
  portal_seats_present: z.string().optional(),
  portal_min_quantity: numberFromForm({ min: 1, message: "Enter 1 or more" }),
  portal_max_quantity: numberFromForm({ min: 1, message: "Enter 1 or more" }),
  trial_end_action: z.enum(["activate_subscription", "cancel_subscription"]).optional(),
  metadata_present: z.string().optional(),
  metadata: metadataFromForm,
  expected_version: numberFromForm({ min: 0 }),
  return_to: z.string().optional(),
});

export async function editPriceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(editPriceSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const body: Record<string, unknown> = {};
  if (d.name !== undefined) body.name = d.name;
  if (d.amount_minor != null) body.amount_minor = d.amount_minor;
  if (d.is_taxable_present === "1") body.is_taxable = d.is_taxable === "on";
  if (d.tax_behavior === "inclusive" || d.tax_behavior === "exclusive")
    body.tax_behavior = d.tax_behavior;
  if (d.external_name !== undefined) body.external_name = d.external_name;
  if (d.description !== undefined) body.description = d.description;
  if (d.billing_cycles_present === "1") body.billing_cycles = d.billing_cycles ?? null;
  if (d.trial_present === "1") {
    body.trial_period = d.trial_period ?? null;
    if (d.trial_period_unit) body.trial_period_unit = d.trial_period_unit;
  }
  if (d.invoice_notes_present === "1") body.invoice_notes = d.invoice_notes ?? null;
  if (d.tax_code !== undefined) body.tax_code = d.tax_code;
  if (d.sku !== undefined) body.sku = d.sku;
  if (d.accounting_code !== undefined) body.accounting_code = d.accounting_code;
  if (d.accounting_category_code !== undefined)
    body.accounting_category_code = d.accounting_category_code;
  if (d.show_desc_present === "1")
    body.show_description_in_invoices = d.show_description_in_invoices === "on";
  if (formData.has("tiers") && d.tiers) body.tiers = d.tiers;
  if (formData.has("package_size") && d.package_size != null) body.package_size = d.package_size;
  if (formData.has("free_units")) body.free_units = d.free_units ?? null;
  if (formData.has("percentage_bps") && d.percentage_bps != null)
    body.percentage_bps = d.percentage_bps;
  if (d.minimum_present === "1") body.minimum_amount_minor = d.minimum_amount_minor ?? null;
  if (d.term_billing_present === "1") {
    body.bill_usage_monthly = d.bill_usage_monthly === "on";
    body.commitment_amount_minor = d.commitment_amount_minor ?? null;
  }
  if (d.portal_seats_present === "1") {
    body.portal_min_quantity = d.portal_min_quantity ?? null;
    body.portal_max_quantity = d.portal_max_quantity ?? null;
  }
  if (d.trial_present === "1" && d.trial_end_action) body.trial_end_action = d.trial_end_action;
  if (d.metadata_present === "1") body.metadata = d.metadata;
  const metered = meterPriceFields(formData, "edit");
  if (metered && !metered.ok)
    return actionError(metered.message, { errors: { [metered.field]: metered.message } });
  if (metered) Object.assign(body, metered.body);
  const credit = grantsCreditFields(formData);
  if (credit && !credit.ok)
    return actionError(credit.message, { errors: { [credit.field]: credit.message } });
  if (credit) body.grants_credit = credit.value;
  if (d.expected_version != null) body.expected_version = d.expected_version;
  const res = await apiPatch(`/v1/businesses/${d.biz}/prices/${d.price}`, body);
  const back = d.return_to || catalogUrl(d.biz, "prices");
  revalidatePath(back);
  if (!res.ok) {
    if (res.status === 409)
      return actionError(
        "Someone else saved this since you opened it. Reload to see their version.",
        {
          code: "conflict",
        },
      );
    return actionError(res.error ?? "We could not update the price.");
  }
  return actionOk(`Price ${d.price} updated`);
}

const createProductGroupSchema = z.object({
  biz: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, "Product group name is required")
    .max(200, "Keep it under 200 characters"),
  code: slugField("Product group ID").optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional(),
});

export async function createProductGroupAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(createProductGroupSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const res = await apiPost(`/v1/businesses/${d.biz}/product_groups`, {
    name: d.name,
    // The engine names it `id`; `code` was silently dropped.
    ...(d.code ? { id: d.code } : {}),
    ...(d.description ? { description: d.description } : {}),
  });
  revalidatePath(catalogUrl(d.biz, "product_groups"));
  if (!res.ok) {
    if (res.status === 409)
      return actionError(res.error ?? "That ID is already in use", {
        errors: { code: res.error ?? "That ID is already in use" },
      });
    return actionError(res.error ?? "We could not create the product group.");
  }
  const grp = (res.data as { id?: string } | undefined)?.id;
  return actionOk(`${d.name} created`, grp && `${catalogUrl(d.biz, "product_groups")}/${grp}`);
}

export async function importProductGroupsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const csv = String(formData.get("csv") ?? "");
  if (!biz) return actionError("The business ID is missing. Reload the page.");
  if (!csv.trim())
    return actionError("Add at least one row", { errors: { csv: "Add at least one row" } });
  const lines = csv
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let created = 0;
  const failed: string[] = [];
  for (const line of lines) {
    const comma = line.indexOf(",");
    const name = (comma === -1 ? line : line.slice(0, comma)).trim();
    const description = comma === -1 ? "" : line.slice(comma + 1).trim();
    if (!name) continue;
    const res = await apiPost(`/v1/businesses/${biz}/product_groups`, {
      name,
      ...(description ? { description } : {}),
    });
    if (res.ok) created++;
    else failed.push(name);
  }
  revalidatePath(catalogUrl(biz, "product_groups"));
  if (failed.length && !created)
    return actionError(`Nothing was imported. Failed: ${failed.join(", ")}`);
  if (failed.length)
    return { ...actionOk(`Imported ${created}; failed: ${failed.join(", ")}`), warning: true };
  return actionOk(`Imported ${created} product ${created === 1 ? "group" : "groups"}`);
}

const editProductGroupSchema = z.object({
  biz: z.string().min(1),
  grp: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, "Product group name is required")
    .max(200, "Keep it under 200 characters"),
  description: zNullableString(2000),
});

export async function editProductGroupAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(editProductGroupSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  const body: Record<string, unknown> = { name: d.name };
  if (d.description !== undefined) body.description = d.description;
  const res = await apiPatch(`/v1/businesses/${d.biz}/product_groups/${d.grp}`, body);
  revalidatePath(catalogUrl(d.biz, "product_groups"));
  if (!res.ok) return actionError(res.error ?? "We could not update the product group.");
  return actionOk(`Group ${d.grp} updated`);
}

const createCouponSetSchema = z.object({
  biz: z.string().min(1),
  coupon: z.string().trim().min(1, "Select a parent coupon").max(100),
  name: z.string().trim().min(1, "Set name is required").max(200, "Keep it under 200 characters"),
  count: numberFromForm({ min: 1, max: 10000, message: "Enter a whole number from 1 to 10,000" }),
  code_prefix: z.string().trim().max(20, "Keep the prefix under 20 characters").optional(),
});

export async function createCouponSetAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("coupons:manage", "manager");
  const parsed = parseForm(createCouponSetSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (d.count == null)
    return actionError("Number of codes is required.", {
      errors: { count: "Number of codes is required." },
    });
  const res = await apiPost(`/v1/businesses/${d.biz}/coupon_sets`, {
    coupon: d.coupon,
    name: d.name,
    count: d.count,
    ...(d.code_prefix ? { code_prefix: d.code_prefix } : {}),
  });
  revalidatePath(catalogUrl(d.biz, "coupon_sets"));
  if (!res.ok) return actionError(res.error ?? "We could not generate the coupon set.");
  return actionOk(`${d.name}: ${d.count} codes generated`);
}

type CatalogResource = "products" | "prices" | "coupons" | "product_groups";

// Products are split across three kind pages; revalidate all of them.
function revalidateCatalog(biz: string, resource: CatalogResource) {
  if (resource === "products") {
    for (const page of ["plans", "addons", "charges"]) revalidatePath(catalogUrl(biz, page));
  } else {
    revalidatePath(catalogUrl(biz, resource));
  }
}

/** Soft-archive (active=false) a catalog item. Callable from a confirm dialog; returns a result. */
export async function archiveCatalogItem(resource: CatalogResource, biz: string, id: string) {
  await requirePermission(resource === "coupons" ? "coupons:manage" : "catalog:manage", "manager");
  const res = await apiDelete(`/v1/businesses/${biz}/${resource}/${id}`);
  revalidateCatalog(biz, resource);
  return { ok: res.ok, error: res.error };
}

/** Restore (active=true) a previously archived catalog item. */
export async function restoreCatalogItem(resource: CatalogResource, biz: string, id: string) {
  await requirePermission(resource === "coupons" ? "coupons:manage" : "catalog:manage", "manager");
  const res = await apiPatch(`/v1/businesses/${biz}/${resource}/${id}`, { active: true });
  revalidateCatalog(biz, resource);
  return { ok: res.ok, error: res.error };
}

// `walletTopupAction` removed: the inline "Wallet top-up" form it served duplicated
// the rail's Manage credits / Record excess payment actions under a balance figure
// that summed two buckets. The one thing only it could do — charge the card on file
// into the excess bucket — now lives as the "card" source of `recordExcessPaymentAction`
// (customers/[cus]/actions.ts), which still posts to `/wallet/topup` with type 'paid'.
// The backend wallet module and its endpoints are unchanged.

// --- Developer: API keys + webhook management (M6) ---

export async function createWebhookEndpoint(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<SecretActionResult> {
  await requirePermission("webhooks:manage", "developer");
  const url = String(formData.get("url") ?? "").trim();
  if (!url) return actionError("Endpoint URL is required", { errors: { url: "Required" } });
  const business = String(formData.get("business") ?? "").trim();
  /**
   * The endpoint's NAME, stored as `description` (which is what the column has always been called
   * and what the API already accepts — this only ever missing from the create form).
   *
   * It is what heads each card on the event screen. Without it that heading falls back to the
   * `whe_…` public id, so an operator looking at an event delivered to three subscribers saw three
   * opaque ids instead of "Analytics sync", "CRM", "Slack alerts". Optional, because
   * an endpoint with no name is still a working endpoint and the id remains a correct fallback.
   */
  const description = String(formData.get("description") ?? "").trim();
  // Derived from the business when scoped, and REQUIRED when not, because this dashboard's
  // credential reaches both partitions. Without it every all-businesses endpoint failed to create.
  const livemode = String(formData.get("livemode") ?? "test").trim() === "live" ? "live" : "test";
  const res = await apiPost("/v1/webhook_endpoints", {
    url,
    ...(business ? { business } : { livemode }),
    ...(description ? { description } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not add the endpoint.");
  revalidatePath("/developer");
  const secret = (res.data as { signing_secret?: string } | undefined)?.signing_secret;
  return withSecret(actionOk("Endpoint added"), "Webhook signing secret", secret);
}

export async function createApiKeyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<SecretActionResult> {
  await requirePermission("api_keys:manage", "developer");
  const livemode = String(formData.get("livemode") ?? "test").trim();
  // Anything but an explicit "read" mints a write key, matching the API. A typo must not
  // quietly produce a weaker credential than the operator believes they created.
  const access = keyAccessFromForm(formData);
  if ("error" in access) return actionError(access.error);
  // Blank means the operator left the box empty — that is "unnamed", not a name of "",
  // so it is omitted from the body rather than sent as an empty string.
  const name = String(formData.get("name") ?? "").trim();
  // Days from now; blank or "never" sends no expiry, which is the API's default.
  const days = Number(String(formData.get("expires_in_days") ?? "").trim());
  const expiresAt =
    Number.isInteger(days) && days > 0
      ? new Date(Date.now() + days * 86_400_000).toISOString()
      : undefined;
  const res = await apiPost("/v1/api_keys", {
    livemode,
    ...access.body,
    ...(name ? { name } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not create the API key.");
  revalidatePath("/developer");
  const secret = (res.data as { secret?: string } | undefined)?.secret;
  return withSecret(actionOk("API key created"), "New API key", secret);
}

/**
 * The access fields of the key form: `access` = full | read | custom, and for custom one
 * `perm_<resource>` per resource. Full and read keep the key on its scope (no map).
 */
function keyAccessFromForm(
  fd: FormData,
):
  | { body: { scope?: "read" | "write"; permissions?: Record<string, string> | null } }
  | { error: string } {
  const access = String(fd.get("access") ?? "full");
  if (access === "read") return { body: { scope: "read", permissions: null } };
  if (access !== "custom") return { body: { scope: "write", permissions: null } };
  const map: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith("perm_") && (v === "read" || v === "write")) map[k.slice(5)] = v;
  }
  if (Object.keys(map).length === 0) return { error: "Select access for at least one resource." };
  return { body: { permissions: map } };
}

/** Change an API key's access (0391). */
export async function updateApiKeyAccessAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("api_keys:manage", "developer");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return actionError("The API key ID is missing. Reload the page.");
  const access = keyAccessFromForm(formData);
  if ("error" in access) return actionError(access.error);
  const res = await apiPatch(`/v1/api_keys/${id}`, {
    permissions: access.body.permissions ?? null,
    ...(access.body.scope ? { scope: access.body.scope } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not change the access of the API key.");
  revalidatePath("/developer");
  return actionOk("Access changed");
}

/** Overlaps the rotate dialog offers, in seconds. The API accepts 0 to 7 days. */
const ROTATION_OVERLAPS = new Set([0, 3_600, 86_400, 604_800]);

export async function rotateApiKeyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<SecretActionResult> {
  await requirePermission("api_keys:manage", "developer");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return actionError("The API key ID is missing. Reload the page.");
  const overlap = Number(String(formData.get("overlap_seconds") ?? "86400"));
  if (!ROTATION_OVERLAPS.has(overlap))
    return actionError("Select when the old key stops.", {
      errors: { overlap_seconds: "Select a value." },
    });
  const res = await apiPost(`/v1/api_keys/${id}/rotate`, { overlap_seconds: overlap });
  if (!res.ok) return actionError(res.error ?? "We could not rotate the API key.");
  revalidatePath("/developer");
  const secret = (res.data as { secret?: string } | undefined)?.secret;
  return withSecret(actionOk("API key rotated"), "New API key", secret);
}

export async function revokeApiKeyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("api_keys:manage", "developer");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return actionError("The API key ID is missing. Reload the page.");
  const res = await apiPost(`/v1/api_keys/${id}/revoke`, {});
  if (!res.ok) return actionError(res.error ?? "We could not revoke the API key.");
  revalidatePath("/developer");
  return actionOk(`API key ${id} revoked`);
}

export async function toggleWebhookAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("webhooks:manage", "developer");
  const id = String(formData.get("id") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!id) return actionError("The endpoint ID is missing. Reload the page.");
  const res = await apiWrite(`/v1/webhook_endpoints/${id}`, { enabled }, "PATCH");
  if (!res.ok) return actionError(res.error ?? "We could not update the endpoint.");
  revalidatePath("/developer");
  return actionOk(`Endpoint ${enabled ? "enabled" : "disabled"}`);
}

export async function deleteWebhookAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("webhooks:manage", "developer");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return actionError("The endpoint ID is missing. Reload the page.");
  const res = await apiWrite(`/v1/webhook_endpoints/${id}`, {}, "DELETE");
  if (!res.ok) return actionError(res.error ?? "We could not delete the endpoint.");
  revalidatePath("/developer");
  return actionOk("Endpoint deleted");
}

export async function rotateWebhookSecretAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<SecretActionResult> {
  await requirePermission("webhooks:manage", "developer");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return actionError("The endpoint ID is missing. Reload the page.");
  const res = await apiPost(`/v1/webhook_endpoints/${id}/rotate_secret`, {});
  if (!res.ok) return actionError(res.error ?? "We could not rotate the secret.");
  revalidatePath("/developer");
  const secret = (res.data as { signing_secret?: string } | undefined)?.signing_secret;
  return withSecret(actionOk("Signing secret rotated"), "New signing secret", secret);
}

// --- Settings (M7) ---

/**
 * Save the organization's own settings — its name and its display timezone (0216).
 *
 * `timezone` is sent whenever the form CARRIED the field, including as `''`, which the
 * API reads as "clear it" (→ UTC). `formData.has` rather than a truthiness check: `''`
 * and "not on this form" are different intents, and collapsing them would make clearing
 * the setting impossible. `name` keeps its old truthiness guard — the API has no
 * "clear the name".
 *
 * One action for both fields, but /settings gives each row its OWN form: a request
 * carries only the field that row owns, and the API patches only what it is sent — so
 * saving a time zone can never overwrite a name someone else changed a second ago.
 */
export async function updateOrgAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("settings:manage", "admin");
  const name = String(formData.get("name") ?? "").trim();
  const hasTz = formData.has("timezone");
  const timezone = String(formData.get("timezone") ?? "").trim();

  /**
   * The registered entity, for businesses that issue invoices under the organization.
   *
   * Each SettingRow posts its OWN form, so a request carries only the fields that row
   * owns and `formData.has` is what distinguishes "left alone" from "cleared" — sending
   * an absent field as '' would blank a GSTIN the operator never touched.
   */
  const hasLegal = formData.has("legal_name");
  const hasGstin = formData.has("tax_registration_number");
  const hasBaseCurrency = formData.has("base_currency");
  // The logo row's Remove button submits `icon_url_remove`; an empty field clears too.
  const hasIcon = formData.has("icon_url");
  const iconUrl =
    formData.get("icon_url_remove") === "1"
      ? null
      : String(formData.get("icon_url") ?? "").trim() || null;
  // Same `addr_*` field set the customer forms post, from the same <AddressFields>.
  const addr: Record<string, string> = {};
  for (const key of [
    "line1",
    "line2",
    "line3",
    "city",
    "state",
    "state_code",
    "postal_code",
    "country",
  ]) {
    const v = String(formData.get(`addr_${key}`) ?? "").trim();
    if (v) addr[key] = key === "country" ? v.toUpperCase() : v;
  }
  // `addr_fields` marks the address ROW as the one that submitted: without it, every
  // other row would post an empty address object and wipe the entity's address.
  const hasAddress = formData.get("addr_fields") === "1";

  const res = await apiWrite(
    "/v1/organization",
    {
      ...(name ? { name } : {}),
      ...(hasTz ? { timezone } : {}),
      ...(hasLegal ? { legal_name: String(formData.get("legal_name") ?? "").trim() || null } : {}),
      ...(hasGstin
        ? {
            tax_registration_number:
              String(formData.get("tax_registration_number") ?? "").trim() || null,
          }
        : {}),
      ...(hasAddress ? { address: Object.keys(addr).length > 0 ? addr : null } : {}),
      // Empty clears back to "not chosen" — a real state, not a missing one; analytics
      // then refuses and names the options rather than guessing.
      ...(hasBaseCurrency
        ? { base_currency: String(formData.get("base_currency") ?? "").trim() || null }
        : {}),
      ...(hasIcon ? { icon_url: iconUrl } : {}),
    },
    "PATCH",
  );
  revalidatePath("/settings");
  // The logo is drawn in the sidebar on every signed-in page.
  if (hasIcon) revalidatePath("/", "layout");
  // Every org-scoped screen formats with this value, and they are cached per route —
  // without these the operator saves a zone and /audit keeps rendering the old one until
  // something else happens to invalidate it.
  revalidatePath("/audit");
  revalidatePath("/developer");
  if (!res.ok) return actionError(res.error ?? "We could not update the organization.");
  return actionOk("Organization updated");
}

// --- Tax regions: settings, component vector, state registrations ---

const taxRegionUrl = (biz: string, txg: string) => `${catalogUrl(biz, "tax")}/${txg}`;

/** Percent string ("9" / "9.5") → basis points. Blank/invalid → null. */
function bpsFromPercent(raw: FormDataEntryValue | null): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  // Percents carry at most 2 decimals in bps; round rather than truncate so 9.005
  // does not silently become 9.00.
  return Math.round(n * 100);
}

/**
 * Save the region's own settings — regime, price type, registration, reverse charge and
 * the SEZ/export gates. One Save per page, matching every other settings page here.
 *
 * Only switches actually rendered by the form are sent: `SwitchField` posts nothing when
 * off, so each one is read through `formData.has()` against an explicit list rather than
 * inferred, or turning a switch OFF would look like "not mentioned" and never persist.
 */
export async function saveTaxRegionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("taxes:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const txg = String(formData.get("txg") ?? "").trim();
  if (!biz || !txg) return actionError("The tax region ID is missing. Reload the page.");

  const SWITCHES = [
    "collect_registration_number",
    "reverse_charge_enabled",
    "show_reverse_charge_note",
    "sez_igst_enabled",
    "sez_zero_rated_enabled",
    "export_igst_enabled",
    "export_zero_rated_enabled",
  ] as const;
  const body: Record<string, unknown> = {};
  for (const k of SWITCHES) body[k] = formData.get(k) === "on";

  const text = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };
  for (const k of [
    "registration_label",
    "registration_number",
    "reverse_charge_note",
    "sez_igst_note",
    "sez_zero_rated_note",
    "export_igst_note",
    "export_zero_rated_note",
  ]) {
    if (formData.has(k)) body[k] = text(k);
  }
  if (formData.has("price_type")) body.price_type = String(formData.get("price_type"));
  if (formData.has("home_state_code")) {
    const hs = String(formData.get("home_state_code") ?? "")
      .trim()
      .toUpperCase();
    body.home_state_code = hs === "" ? null : hs;
  }
  // Showing the reverse-charge note with no text would print an empty line on the
  // invoice — refuse rather than persist a half-configured note.
  if (body.show_reverse_charge_note === true && !body.reverse_charge_note) {
    return actionError('Enter the reverse-charge note, or disable "Show note on reverse charge"');
  }

  const res = await apiPatch(`/v1/businesses/${biz}/tax_regions/${txg}`, body);
  if (!res.ok) return actionError(res.error ?? "We could not save the tax region.");
  revalidatePath(taxRegionUrl(biz, txg));
  revalidatePath(catalogUrl(biz, "tax"));
  return actionOk("Tax settings saved");
}

/**
 * Replace one state scope's component vector. Sent as a whole vector, not per row:
 * CGST and SGST/UTGST are two halves of one decision.
 *
 * For a GST region the form collects CGST + SGST + optional Cess as PERCENTS and IGST is
 * derived as CGST + SGST — the law makes an inter-state supply attract the same total, so
 * deriving it removes the only way to configure the two branches inconsistently.
 */
export async function saveTaxComponentsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("taxes:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const txg = String(formData.get("txg") ?? "").trim();
  const regime = String(formData.get("regime") ?? "flat");
  const stateCodeRaw = String(formData.get("state_code") ?? "")
    .trim()
    .toUpperCase();
  const stateCode = stateCodeRaw === "" ? null : stateCodeRaw;
  if (!biz || !txg) return actionError("The tax region ID is missing. Reload the page.");

  let components: Array<{ name: string; rate_bps: number; applies_to: "intra" | "inter" | "both" }>;
  if (regime === "gst") {
    const cgst = bpsFromPercent(formData.get("cgst"));
    const sgst = bpsFromPercent(formData.get("sgst"));
    const cess = bpsFromPercent(formData.get("cess"));
    if (cgst == null || sgst == null)
      return actionError("Enter CGST and SGST/UTGST as percentages from 0 to 100");
    components = [
      { name: "CGST", rate_bps: cgst, applies_to: "intra" },
      { name: "SGST/UTGST", rate_bps: sgst, applies_to: "intra" },
      { name: "IGST", rate_bps: cgst + sgst, applies_to: "inter" },
      ...(cess != null && cess > 0
        ? [{ name: "Cess", rate_bps: cess, applies_to: "both" as const }]
        : []),
    ];
  } else {
    const name = String(formData.get("name") ?? "").trim();
    const rate = bpsFromPercent(formData.get("rate"));
    if (!name) return actionError("Enter the tax name, for example VAT");
    if (rate == null) return actionError("Enter the rate as a percentage from 0 to 100");
    components = [{ name, rate_bps: rate, applies_to: "both" }];
  }

  const res = await apiPut(`/v1/businesses/${biz}/tax_regions/${txg}/components`, {
    ...(stateCode ? { state_code: stateCode } : {}),
    components,
  });
  if (!res.ok) return actionError(res.error ?? "We could not save the tax rates.");
  revalidatePath(taxRegionUrl(biz, txg));
  return actionOk(stateCode ? `Rates saved for ${stateCode}` : "Rates saved");
}

/** Upsert one state's seller registration (India: that state's GSTIN). */
export async function saveTaxStateRegistrationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("taxes:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const txg = String(formData.get("txg") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim();
  const stateCode = String(formData.get("state_code") ?? "")
    .trim()
    .toUpperCase();
  // The form no longer asks for the state NAME — it is derived from the code, so the
  // two cannot disagree. Falls back to whatever the form sent for countries where we
  // ship no list and the field is still free text.
  const { data: subs, aliases } = await getSubdivisions(country);
  const stateName =
    subdivisionName(subs, stateCode, aliases) || String(formData.get("state_name") ?? "").trim();
  const number = String(formData.get("registration_number") ?? "").trim();
  if (!biz || !txg) return actionError("The tax region ID is missing. Reload the page.");
  if (!stateCode) return actionError("Select a state");
  const res = await apiPut(`/v1/businesses/${biz}/tax_regions/${txg}/state_registrations`, {
    state_code: stateCode,
    ...(stateName ? { state_name: stateName } : {}),
    registration_number: number === "" ? null : number,
  });
  if (!res.ok) return actionError(res.error ?? "We could not save the state registration.");
  revalidatePath(taxRegionUrl(biz, txg));
  return actionOk(`Registration saved for ${stateCode}`);
}

export async function deleteTaxStateRegistration(biz: string, txg: string, txs: string) {
  await requirePermission("taxes:manage", "manager");
  const res = await apiDelete(
    `/v1/businesses/${biz}/tax_regions/${txg}/state_registrations/${txs}`,
  );
  revalidatePath(taxRegionUrl(biz, txg));
  return { ok: res.ok, error: res.error };
}

/** Archive (enabled=false) a tax region. Returns a result for a confirm dialog. */
export async function archiveTaxRegion(biz: string, id: string) {
  await requirePermission("taxes:manage", "manager");
  const res = await apiDelete(`/v1/businesses/${biz}/tax_regions/${id}`);
  revalidatePath(catalogUrl(biz, "tax"));
  return { ok: res.ok, error: res.error };
}

/** Restore (enabled=true) a tax region. */
export async function restoreTaxRegion(biz: string, id: string) {
  await requirePermission("taxes:manage", "manager");
  const res = await apiPatch(`/v1/businesses/${biz}/tax_regions/${id}`, { enabled: true });
  revalidatePath(catalogUrl(biz, "tax"));
  return { ok: res.ok, error: res.error };
}

// --- FE-2: Customer edit / archive ---

// Format-only gate ahead of editCustomerAction's own body-building below (which
// still owns null-vs-absent via nullableField) — see the comment on the shared
// zod fragments above.
const editCustomerSchema = z
  .object({
    biz: z.string().min(1, "The business ID is missing. Reload the page."),
    cus: z.string().min(1, "The customer ID is missing. Reload the page."),
    email: zEmail,
    phone: zPhone,
    vat_number: zVatNumber,
    net_term_days: zBoundedInt(0, 365),
    withholding_rate_bps: zBoundedInt(0, 10000),
    addr_phone: zPhone,
    ship_phone: zPhone,
  })
  .passthrough();

export async function editCustomerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const parsed = parseForm(editCustomerSchema, formData);
  if (parsed.error) return parsed.error;
  const biz = parsed.data.biz;
  const cus = parsed.data.cus;
  const body: Record<string, unknown> = {};
  const email = nullableField(formData, "email");
  if (email !== undefined) body.email = email;
  // No `name`: no customer form has ever posted one (there is no such input), and the
  // API now 400s on the field — so this read was dead code that would have turned the
  // first `name` input anyone added into a failing save. `customers.name` is deprecated;
  // the editable identity is first_name/last_name/company, above and in `addr_*`.
  const address: Record<string, string | null> = {};
  let hasAddr = false;
  // Full rich address (line3, state_code + billing contact sub-fields). NB the
  // service REPLACES the whole address on update (applyAddress), so any form
  // that posts addr_* fields must post the complete set or it clears the rest.
  for (const key of [
    "line1",
    "line2",
    "line3",
    "city",
    "state",
    "state_code",
    "postal_code",
    "country",
    "first_name",
    "last_name",
    "company",
    "phone",
  ]) {
    const v = nullableField(formData, `addr_${key}`);
    if (v !== undefined) {
      address[key] = key === "country" && v ? v.toUpperCase() : v;
      hasAddr = true;
    }
  }
  if (hasAddr) body.address = address;
  // Shipping address (ship_*). Gated on a marker field so that clearing every input
  // CLEARS the address, instead of an all-blank block being indistinguishable from
  // "this form doesn't edit shipping". The route folds an all-null object to null.
  if (formData.get("ship_fields") === "1") {
    const ship: Record<string, string | null> = {};
    for (const key of [
      "line1",
      "line2",
      "line3",
      "city",
      "state",
      "state_code",
      "postal_code",
      "country",
      "first_name",
      "last_name",
      "company",
      "phone",
    ]) {
      const v = nullableField(formData, `ship_${key}`);
      ship[key] = key === "country" && v ? v.toUpperCase() : (v ?? null);
    }
    body.shipping_address = Object.values(ship).some((v) => v !== null) ? ship : null;
  }
  // Custom fields (SET-4) post as flat `cf_<api_name>` keys, which the customer
  // routes collect off the raw body. getAll + last-value, because a boolean field
  // posts a hidden `false` followed by `true` when its box is checked — see
  // CustomFieldsFields. Empty string is meaningful: it CLEARS the field.
  for (const key of new Set(formData.keys())) {
    if (!key.startsWith("cf_")) continue;
    const all = formData.getAll(key);
    body[key] = String(all[all.length - 1] ?? "");
  }
  // Tax status: a checkbox posts 'on' only when checked, so a hidden marker field
  // distinguishes "unchecked" from "field absent".
  if (formData.get("tax_fields") === "1") body.tax_exempt = formData.get("tax_exempt") === "on";
  if (formData.get("email_fields") === "1")
    body.email_notifications = formData.get("email_notifications") === "on";
  if (formData.get("dunning_fields") === "1")
    body.dunning_excluded = formData.get("dunning_excluded") === "on";
  if (formData.get("reporting_fields") === "1")
    body.exclude_from_reporting = formData.get("exclude_from_reporting") === "on";
  // The policy select posts '' for "Business settings", which clears the policy. Sent only
  // when it changed, so a save never re-asserts a policy archived since it was assigned.
  if (formData.get("dunning_policy_field") === "1") {
    const policy = String(formData.get("dunning_policy") ?? "").trim();
    const was = String(formData.get("dunning_policy_was") ?? "").trim();
    if (policy !== was) body.dunning_policy = policy || null;
  }
  const vat = nullableField(formData, "vat_number");
  if (vat !== undefined) body.vat_number = vat;
  const wh = numOpt(formData, "withholding_rate_bps");
  if (wh != null) body.withholding_rate_bps = wh;
  // Tax treatment is only PRESENT when the customer's region offers a choice — the field
  // omits its select otherwise (see TaxTreatmentField), and an absent key correctly
  // leaves the stored treatment alone rather than resetting it to 'default'.
  const treatment = formData.get("tax_treatment");
  if (typeof treatment === "string" && treatment !== "") body.tax_treatment = treatment;
  const taxReg = nullableField(formData, "tax_registration_number");
  if (taxReg !== undefined) body.tax_registration_number = taxReg;
  // '' = each price decides (null).
  if (formData.get("tax_behavior_field") === "1") {
    const tb = formData.get("tax_behavior");
    body.tax_behavior = tb === "inclusive" || tb === "exclusive" ? tb : null;
  }
  // CP-1/CP-2 depth fields.
  for (const [field, key] of [
    ["first_name", "first_name"],
    ["last_name", "last_name"],
    ["company", "company"],
    ["phone", "phone"],
    ["locale", "locale"],
    ["invoice_notes", "invoice_notes"],
  ] as const) {
    const v = nullableField(formData, field);
    if (v !== undefined) body[key] = v;
  }
  const ac = formData.get("auto_collection");
  if (ac === "on" || ac === "off") body.auto_collection = ac;
  const nt = numOpt(formData, "net_term_days");
  if (nt != null) body.net_term_days = nt;
  // Currency must be CLEARABLE. The old `if (cur.length === 3)` silently dropped a
  // cleared value, so once set the preference could never be removed — and the
  // CurrencySelect "None" choice posts `" "` (Radix forbids an empty item value),
  // which trims to '' here and so must map to an explicit null, not to "absent".
  // `updateCustomerBody.currency` is `.nullable()` and the service clears on null.
  const cur = nullableField(formData, "currency");
  if (cur !== undefined) body.currency = cur === null ? null : cur.toUpperCase();
  // JSON metadata. Gated on a marker field, like tax/shipping, so an emptied box
  // CLEARS the column (`updateCustomerBody.metadata` is `.nullable()`) while a form
  // that doesn't edit metadata leaves it alone. Parsed here rather than posted
  // blindly: the API would 400 on a non-object, and the operator would lose the
  // whole edit to a message that named no field.
  if (formData.get("metadata_fields") === "1") {
    const md = checkMetadata(String(formData.get("metadata") ?? ""));
    if (!md.ok)
      return {
        ok: false,
        message: "Correct the highlighted fields.",
        errors: { metadata: md.error },
      };
    body.metadata = md.value;
  }
  // Copies of the customer's document emails (0486), on the full edit form only.
  if (formData.get("billing_copies_fields") === "1") {
    const errors: Record<string, string> = {};
    for (const key of ["billing_cc_emails", "billing_bcc_emails"] as const) {
      const list = String(formData.get(key) ?? "")
        .split(/[\s,;]+/)
        .map((a) => a.trim())
        .filter(Boolean);
      if (list.length > 10) errors[key] = "Enter 10 email addresses or fewer.";
      else if (list.some((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)))
        errors[key] = "Enter valid email addresses, separated by commas.";
      else body[key] = list;
    }
    if (Object.keys(errors).length)
      return { ok: false, message: "Correct the highlighted fields.", errors };
  }
  const ev = numOpt(formData, "expected_version");
  if (ev != null) body.expected_version = ev;
  const res = await apiPatch(`/v1/businesses/${biz}/customers/${cus}`, body);
  revalidatePath(cusUrl(biz, cus));
  if (!res.ok) {
    // 409 (optimistic-concurrency conflict, CP-0): the caller's onSuccess won't
    // fire and the toast offers Reload — same contract as every other dialog
    // action here, not a redirect-away-from-your-edits.
    // A metadata rule names the field it refused, so the message lands on the metadata box.
    return actionError(
      res.error ?? "We could not update the customer.",
      res.status === 409
        ? { code: "conflict" }
        : res.param === "metadata"
          ? { errors: { metadata: res.error ?? "" } }
          : undefined,
    );
  }
  // The full-page edit leaves for the record (a URL change); an in-page dialog stays put.
  const returnTo = String(formData.get("return_to") ?? "");
  if (returnTo === cusUrl(biz, cus)) redirect(withQuery(returnTo, { msg: "Customer updated" }));
  return actionOk("Customer updated");
}

export async function archiveCustomerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const cus = String(formData.get("cus") ?? "").trim();
  if (!biz || !cus) return actionError("The customer ID is missing. Reload the page.");
  const res = await apiDelete(`/v1/businesses/${biz}/customers/${cus}`);
  if (!res.ok) return actionError(res.error ?? "We could not archive the customer.");
  revalidatePath(cusUrl(biz, cus));
  revalidatePath(`/businesses/${biz}/customers`);
  return actionOk("Customer archived");
}

export async function restoreCustomerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("customers:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const cus = String(formData.get("cus") ?? "").trim();
  if (!biz || !cus) return actionError("The customer ID is missing. Reload the page.");
  const res = await apiPatch(`/v1/businesses/${biz}/customers/${cus}`, { active: true });
  if (!res.ok) return actionError(res.error ?? "We could not restore the customer.");
  revalidatePath(cusUrl(biz, cus));
  revalidatePath(`/businesses/${biz}/customers`);
  return actionOk("Customer restored");
}

// --- FE-2: Payment methods (set default / detach) ---

// `setDefaultPaymentMethodAction` was removed 2026-09-14 with its only caller, the
// "Set default" button — `POST …/:pm/default` is a one-line alias for assigning the
// `primary` role, so it duplicated "Make primary" (`AssignRoleButton`) exactly. Next
// exposes an endpoint for every exported server action, so an orphaned one is a live
// mutation surface, not dead code. The API route itself is untouched for integrators.

export async function detachPaymentMethodAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payment_methods:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const cus = String(formData.get("cus") ?? "").trim();
  const pm = String(formData.get("pm") ?? "").trim();
  if (!biz || !cus || !pm) return actionError("The payment method ID is missing. Reload the page.");
  const res = await apiDelete(`/v1/businesses/${biz}/customers/${cus}/payment_methods/${pm}`);
  if (!res.ok) return actionError(res.error ?? "We could not detach the payment method.");
  revalidatePath(cusUrl(biz, cus));
  return actionOk("Payment method detached");
}

// --- FE-2: Subscription add-ons / charges / schedule / reactivate / discount ---

/**
 * Delete a subscription.
 *
 * Redirects to the LIST, not back to the detail page: the subscription is gone, so the
 * page it was deleted from now 404s.
 */
export async function deleteSubscriptionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  if (!biz || !sub) return actionError("The subscription ID is missing. Reload the page.");
  const res = await apiDelete(`/v1/businesses/${biz}/subscriptions/${sub}`);
  // A failure stays on the record it could not delete.
  if (!res.ok) return actionError(res.error ?? "We could not delete the subscription.");
  revalidatePath(`/businesses/${biz}/subscriptions`);
  revalidatePath(subUrl(biz, sub));
  redirect(`/businesses/${biz}/subscriptions`);
}

/**
 * Add one or more one-time charges to a subscription from the takeover repeater —
 * `Add Charge` / `Create Quick Charge` at subscription scope.
 *
 * Posts `charges[]` so "Invoice immediately" raises ONE invoice for all of them
 * rather than one per charge. Deferring produces one unbilled row each.
 */
export async function addSubscriptionChargesAction(
  _prev: import("@/lib/action-result").ActionResult | null,
  formData: FormData,
): Promise<import("@/lib/action-result").ActionResult> {
  const { actionError } = await import("@/lib/action-result");
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  const invoiceNow = String(formData.get("invoice_now") ?? "") === "true";
  if (!biz || !sub) return actionError("The subscription ID is missing. Reload the page.");

  let drafts: Array<{
    description?: string;
    amountMinor?: number;
    quantity?: number;
    price?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
  }>;
  try {
    drafts = JSON.parse(String(formData.get("lines") ?? "[]"));
  } catch {
    return actionError("We could not read the drafted charges. Add them again.");
  }
  if (!Array.isArray(drafts) || drafts.length === 0) return actionError("Add at least one charge");

  const charges = drafts.map((d) => ({
    ...(d.description ? { description: d.description } : {}),
    ...(d.amountMinor != null ? { amount_minor: d.amountMinor } : {}),
    ...(d.quantity != null && d.quantity > 0 ? { quantity: d.quantity } : {}),
    ...(d.price ? { price: d.price } : {}),
    ...(d.periodStart ? { period_start: d.periodStart } : {}),
    ...(d.periodEnd ? { period_end: d.periodEnd } : {}),
  }));
  const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/charges`, {
    charges,
    invoice_now: invoiceNow,
  });
  revalidatePath(subUrl(biz, sub));
  if (!res.ok) return actionError(res.error ?? "We could not add the charges.");
  const n = charges.length;
  const noun = n === 1 ? "Charge" : `${n} charges`;
  redirect(
    withQuery(subUrl(biz, sub), {
      msg: invoiceNow
        ? `${noun} invoiced and collected`
        : `${noun} added to unbilled charges. We bill them at the next renewal.`,
    }),
  );
}

export async function removeDiscountAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  if (!biz || !sub) return actionError("The subscription ID is missing. Reload the page.");
  const res = await apiDelete(`/v1/businesses/${biz}/subscriptions/${sub}/discount`);
  if (!res.ok) return actionError(res.error ?? "We could not remove the discount.");
  revalidatePath(subUrl(biz, sub));
  return actionOk("Discount removed");
}

// --- FE-3: Manual invoice + lifecycle ops + offline payment ---

const invUrlFor = (biz: string, inv: string) => `/businesses/${biz}/invoices/${inv}`;

const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  amount_minor: z.number().int(),
  quantity: z.number().int().positive().optional(),
});

const createInvoiceSchema = z.object({
  biz: z.string().min(1),
  customer: z.string().trim().min(1, "Customer is required"),
  currency: z.string().trim().optional(),
  lines: z.string(),
  collect: z.string().optional(),
  apply_tax: z.string().optional(),
  // Backend requires a POSITIVE day count when net terms are set; unbounded above
  // there, but a sane ceiling here catches a fat-fingered year-as-days typo.
  net_days: numberFromForm({ min: 1, max: 3650, message: "Net days must be between 1 and 3650" }),
});

/** Create a one-off / manual invoice. lines come as a JSON array from the form. */
export async function createInvoiceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("invoices:manage", "ops");
  const { data, error } = parseForm(createInvoiceSchema, formData);
  if (error) return error;

  let parsedLines: unknown;
  try {
    parsedLines = JSON.parse(data.lines || "[]");
  } catch {
    return actionError("Invalid line items", { errors: { lines: "Invalid line items" } });
  }
  const linesResult = z
    .array(invoiceLineSchema)
    .min(1, "Add at least one line item")
    .safeParse(parsedLines);
  if (!linesResult.success) {
    return actionError("Add at least one line item with a description and amount", {
      errors: { lines: linesResult.error.issues[0]?.message ?? "Invalid line items" },
    });
  }

  const currency = (data.currency ?? "").toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency))
    return actionError("Currency must be a 3-letter code", {
      errors: { currency: "3-letter ISO code" },
    });

  const invoicesUrl = `/businesses/${data.biz}/invoices`;
  const res = await apiPost(`/v1/businesses/${data.biz}/invoices`, {
    customer: data.customer,
    ...(currency ? { currency } : {}),
    lines: linesResult.data,
    collect: data.collect != null,
    apply_tax: data.apply_tax != null,
    ...(data.net_days != null ? { net_days: data.net_days } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not create the invoice.");
  revalidatePath(invoicesUrl);
  const newInv = (res.data as { id?: string } | undefined)?.id;
  return actionOk("Invoice created", newInv ? invUrlFor(data.biz, newInv) : undefined);
}

/** Generic invoice lifecycle op: void | write_off | collect | retry. */
export async function invoiceOpAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const op = String(formData.get("op") ?? "").trim();
  await requirePermission(
    op === "void" || op === "write_off" ? "invoices:void" : "invoices:collect",
    "ops",
  );
  const biz = String(formData.get("biz") ?? "").trim();
  const inv = String(formData.get("inv") ?? "").trim();
  if (!biz || !inv || !["void", "write_off", "collect", "retry"].includes(op))
    return actionError("Unknown invoice operation");
  // The page the op was taken from (the subscription page collects an invoice in place),
  // revalidated alongside the invoice; only a same-app path is honoured.
  const backRaw = String(formData.get("back") ?? "");
  const back = backRaw.startsWith(`/businesses/${biz}/`) ? backRaw : null;
  // Collect / retry may name the one card to charge; blank keeps the usual order.
  const pm = String(formData.get("payment_method_id") ?? "").trim();
  const body: Record<string, string> =
    (op === "collect" || op === "retry") && pm ? { payment_method_id: pm } : {};
  // Free text, stored on the invoice. Some businesses require it (required_reasons).
  const voidReason = String(formData.get("void_reason_code") ?? "").trim();
  if (op === "void" && voidReason) body.void_reason_code = voidReason;
  const res = await apiPost(`/v1/businesses/${biz}/invoices/${inv}/${op}`, body);
  revalidatePath(invUrlFor(biz, inv));
  if (back) revalidatePath(back);
  const labels: Record<string, string> = {
    void: "voided",
    write_off: "written off",
    collect: "collection attempted",
    retry: "retry attempted",
  };
  if (!res.ok) return actionError(res.error ?? `Could not ${op.replace("_", " ")} the invoice`);
  return actionOk(`Invoice ${labels[op]}`);
}

/**
 * Confirmation copy for a recorded offline payment. When the money handed over
 * exceeded the outstanding balance the engine credits the remainder to the
 * customer's excess-payment balance instead of applying it here — say so, or the
 * operator has no way to know where their money went.
 */
// NOT exported: in a 'use server' module every export must be an async server
// action, so a plain string helper has to stay module-local.
function offlinePaymentMessage(data: unknown, hadAmount: boolean): string {
  const d = data as
    | { excess_credited_minor?: number; excess_refunded_minor?: number; currency?: string }
    | undefined;
  const base = hadAmount ? "Offline payment recorded" : "Invoice marked paid";
  const returned = d?.excess_refunded_minor ?? 0;
  if (returned > 0)
    return `${base}. We recorded ${money(returned, d?.currency ?? "USD")} above the balance as returned to the payer.`;
  const excess = d?.excess_credited_minor ?? 0;
  if (excess <= 0) return base;
  return `${base}. We credited ${money(excess, d?.currency ?? "USD")} above the balance to the customer as an excess payment.`;
}

/** Record an offline/manual payment (or mark-paid by omitting the amount). */
export async function recordOfflinePaymentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("payments:collect", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const inv = String(formData.get("inv") ?? "").trim();
  const amount = numOpt(formData, "amount_minor");
  const method = String(formData.get("method") ?? "").trim();
  // DateTimeField posts a UTC ISO instant; blank means "now".
  const date = String(formData.get("date") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const comment = String(formData.get("comment") ?? "").trim();
  // Posted only when the operator changed them; omitted = the business rule.
  const shortfall = String(formData.get("shortfall") ?? "").trim();
  const excess = String(formData.get("excess") ?? "").trim();
  if (!biz || !inv) return actionError("The invoice ID is missing. Reload the page.");
  if (date && Number.isNaN(new Date(date).getTime()))
    return actionError("Correct the highlighted fields.", {
      errors: { date: "Enter a valid date and time." },
    });
  const res = await apiPost(`/v1/businesses/${biz}/invoices/${inv}/pay`, {
    ...(amount != null ? { amount_minor: amount } : {}),
    ...(method ? { method } : {}),
    ...(date ? { date } : {}),
    ...(reference ? { reference } : {}),
    ...(comment ? { comment } : {}),
    ...(shortfall === "write_off" || shortfall === "leave_due" ? { shortfall } : {}),
    ...(excess === "credit" || excess === "refund" ? { excess } : {}),
  });
  if (!res.ok) return actionError(res.error ?? "We could not record the payment.");
  revalidatePath(invUrlFor(biz, inv));
  return actionOk(offlinePaymentMessage(res.data, amount != null));
}

// --- Comments (the per-record notes box) ----------------------------------

/**
 * Add a note to an invoice / credit note / customer. Polymorphic because the
 * backend table is: one action serves every screen that shows the box.
 */
export async function addCommentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("comments:manage", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const resourceType = String(formData.get("resource_type") ?? "").trim();
  const resourceId = String(formData.get("resource_id") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const back = String(formData.get("back") ?? "").trim();
  if (!body) return actionError("Write a comment first", { errors: { body: "Required" } });
  if (!biz || !resourceType || !resourceId)
    return actionError("The record ID is missing. Reload the page.");
  const res = await apiPost(`/v1/businesses/${biz}/comments`, {
    resource_type: resourceType,
    resource_id: resourceId,
    body,
  });
  if (!res.ok) return actionError(res.error ?? "We could not add the comment.");
  if (back) revalidatePath(back);
  return actionOk("Comment added");
}

export async function deleteCommentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("comments:manage", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const id = String(formData.get("id") ?? "").trim();
  const back = String(formData.get("back") ?? "").trim();
  if (!biz || !id) return actionError("The comment ID is missing. Reload the page.");
  const res = await apiWrite(`/v1/businesses/${biz}/comments/${id}`, undefined, "DELETE");
  if (!res.ok) return actionError(res.error ?? "We could not delete the comment.");
  if (back) revalidatePath(back);
  return actionOk("Comment deleted");
}

// --- Invoice operator fields ("Update PO Number" / "Update address") -------

/**
 * PATCH the non-financial fields on an invoice. Only sends what the form
 * actually carried: the route treats `undefined` as "leave alone" and `null` as
 * "clear", so editing the PO number must not blank the address snapshot.
 */
export async function updateInvoiceFieldsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("invoices:manage", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const inv = String(formData.get("inv") ?? "").trim();
  if (!biz || !inv) return actionError("The invoice ID is missing. Reload the page.");
  const body: Record<string, unknown> = {};

  if (formData.has("po_number")) {
    const po = String(formData.get("po_number") ?? "").trim();
    body.po_number = po || null;
  }
  if (formData.has("expected_payment_date")) {
    const d = String(formData.get("expected_payment_date") ?? "").trim();
    body.expected_payment_date = d || null;
  }
  // The address form posts every field; empty strings become nulls so clearing a
  // line actually clears it rather than storing "".
  const addressFrom = (prefix: string) => {
    const keys = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "company",
      "line1",
      "line2",
      "line3",
      "city",
      "state",
      "postal_code",
      "country",
    ];
    if (!keys.some((k) => formData.has(`${prefix}_${k}`))) return undefined;
    const out: Record<string, string | null> = {};
    for (const k of keys) {
      const v = String(formData.get(`${prefix}_${k}`) ?? "").trim();
      out[k] = v || null;
    }
    return out;
  };
  const billing = addressFrom("billing");
  const shipping = addressFrom("shipping");
  if (billing) body.billing_address = billing;
  if (shipping) body.shipping_address = shipping;

  const res = await apiWrite(`/v1/businesses/${biz}/invoices/${inv}`, body, "PATCH");
  if (!res.ok) return actionError(res.error ?? "We could not update the invoice.");
  revalidatePath(invUrlFor(biz, inv));
  return actionOk("Invoice updated");
}

// --- Catalog: applicable addons + differential pricing (CP-6 UI) ---

const productUrl = (biz: string, prod: string) => `/businesses/${biz}/catalog/products/${prod}`;

/** Upsert a differential price cell (addon price when attached to a given plan). */
const setDifferentialPriceSchema = z.object({
  biz: z.string().min(1),
  addon: z.string().min(1),
  plan: z.string().trim().min(1, "Plan is required").max(100),
  currency: z
    .string()
    .trim()
    .length(3, "Currency is required")
    .transform((v) => v.toUpperCase()),
  interval: z.string().optional(),
  amount_minor: numberFromForm({
    min: 0,
    message: "Enter a non-negative whole number of minor units",
  }),
});

export async function setDifferentialPriceAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("catalog:manage", "manager");
  const parsed = parseForm(setDifferentialPriceSchema, formData);
  if (parsed.error) return parsed.error;
  const d = parsed.data;
  if (d.amount_minor == null) {
    return actionError("Enter an amount", { errors: { amount_minor: "Amount is required" } });
  }
  const res = await apiWrite(
    `/v1/businesses/${d.biz}/products/${d.addon}/differential_prices`,
    {
      plan: d.plan,
      currency: d.currency,
      interval: d.interval || null,
      amount_minor: d.amount_minor,
    },
    "PUT",
  );
  revalidatePath(productUrl(d.biz, d.addon));
  if (!res.ok) return actionError(res.error ?? "We could not set the differential price.");
  return actionOk("Differential price set");
}

// --- Subscription create (line builder + estimate rail) -------------------

/**
 * Dry-run estimate of a new subscription's first invoice (no writes) — powers
 * the live preview rail on the subscription create page.
 */
/**
 * Server-side customer search for the pickers (manual invoice, subscription create).
 *
 * Replaces a `listCustomers(biz, { limit: 1000 })` bulk read that both pickers then
 * filtered IN THE BROWSER. The failure was silent and the worst kind: customer 1001
 * simply could not be found — no "showing 1000 of N", no hint, just a search that
 * confidently returned nothing, so an operator concluded the customer did not exist.
 *
 * `q` is the list endpoint's own free-text search over id/email/name/company/phone and
 * runs in SQL (`src/api/customer-routes.ts`), so the cap below bounds the RESULT set
 * rather than the searchable set. `⚠️ pg_trgm`: that search compiles to an unindexed
 * ILIKE '%…%' — fine at ~50k rows, a seq scan beyond, and already logged.
 */
/** One row of a customer picker — everything a caller needs without a second fetch. */
export interface PickerCustomer {
  id: string;
  label: string;
  sub: string | null;
  /**
   * Carried, not looked up in a bulk array. Both callers read a real field off the
   * CHOSEN customer — the manual-invoice form drives its money fields' exponent off
   * `effective_currency`, the subscription form names the auto-collection the new
   * subscription will INHERIT — and both used to resolve it with
   * `customers.find(c => c.id === cus)` over the 1000-row read. Dropping that read
   * without carrying these would have made every searched-for customer silently fall
   * back to the "unknown" arm.
   */
  effective_currency: string | null;
  auto_collection: "on" | "off" | null;
}

export async function searchCustomersAction(
  biz: string,
  q: string,
): Promise<
  { ok: true; customers: PickerCustomer[]; capped: boolean } | { ok: false; error: string }
> {
  // Same bar as the forms that use it (both are manager-gated writes); a picker must
  // not be a way to enumerate customers from a lower role.
  await requirePermission("customers:view", "manager");
  if (!biz) return { ok: false, error: "The business ID is missing. Reload the page." };
  // 25 is a picker, not a page: enough to scan without scrolling, and the search box
  // is how you get past it. `has_more` from the endpoint's own cursor tells us whether
  // to say so on screen — the point of this whole change is that a cap is never silent.
  const limit = 25;
  try {
    const page = await listCustomers(biz, { q: q.trim() || undefined, limit });
    return {
      ok: true,
      capped: page.has_more === true,
      customers: page.data.map((c) => ({
        id: c.id,
        label: c.name ?? c.email ?? c.id,
        sub: c.name ? (c.email ?? null) : null,
        effective_currency: c.effective_currency ?? null,
        auto_collection: (c.auto_collection as "on" | "off" | null | undefined) ?? null,
      })),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function estimateNewSubscriptionAction(
  biz: string,
  cus: string,
  items: Array<{ price: string; quantity: number; unit_price_minor?: number }>,
  /**
   * The applied signup coupon, as the create call sends it (`coupon_ids`). The rail used
   * to quote the undiscounted total while the line list right beside it showed the
   * discount, because this parameter did not exist and the code never left the form.
   */
  couponCode?: string,
  /** The signup manual discount, same shape the create call posts. */
  discount?: { type: "percent" | "amount"; value: number; duration: "one_time" | "forever" },
): Promise<{ ok: true; estimate: unknown } | { ok: false; error: string }> {
  await requirePermission("subscriptions:estimate", "manager");
  if (!biz || !cus || items.length === 0)
    return { ok: false, error: "Select a customer and at least one price" };
  const res = await apiPost(`/v1/businesses/${biz}/customers/${cus}/subscription_estimate`, {
    items,
    ...(couponCode ? { coupon_ids: [couponCode] } : {}),
    ...(discount ? { discount } : {}),
  });
  return res.ok
    ? { ok: true, estimate: res.data }
    : { ok: false, error: res.error ?? "We could not calculate the estimate." };
}

/** '' → undefined for optional text/enum fields. */
const optStr = z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().optional());
const optEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (v === "" || v == null ? undefined : v), z.enum(values).optional());
/** '' → undefined; otherwise a non-negative integer (trial/net-term days). */
const optNonNegInt = z.preprocess(
  (v) => (v === "" || v == null ? undefined : Number(v)),
  z.number().int().min(0).optional(),
);
/** '' → undefined; otherwise a positive number (manual-discount value — percent can be fractional). */
const optPositiveNum = z.preprocess(
  (v) => (v === "" || v == null ? undefined : Number(v)),
  z.number().positive().optional(),
);

const createSubSchema = z.object({
  biz: z.string().min(1),
  cus: z.string().min(1),
  items: z.string().min(1),
  subscription_id: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.string().max(50).optional(),
  ),
  trial_days: optNonNegInt,
  start_date: optUtcDateTime,
  auto_collection: optEnum(["on", "off"] as const),
  net_term_days: z.preprocess(
    (v) => (v === "" || v == null ? undefined : Number(v)),
    z.number().int().min(0).max(365).optional(),
  ),
  po_number: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.string().max(100).optional(),
  ),
  invoice_notes: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.string().max(2000).optional(),
  ),
  create_pending_invoices: optStr,
  bill_usage_monthly: optStr,
  commitment_present: optStr,
  commitment_amount_minor: optStr,
  invoice_immediately: optStr,
  on_charge_failure: optEnum(["refuse", "dun"] as const),
  coupon_code: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.string().max(100).optional(),
  ),
  md_type: optEnum(["percent", "amount"] as const),
  md_value: optPositiveNum,
  md_duration: optEnum(["one_time", "forever"] as const),
});

/** Full create-subscription action: multi-line items + billing/invoicing options + optional coupon. */
export async function createSubscriptionFullAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const { data, error } = parseForm(createSubSchema, formData);
  if (error) return error;

  let items: Array<{
    price: string;
    quantity: number;
    unit_price_minor?: number;
    billing_cycles?: number;
  }>;
  try {
    items = JSON.parse(data.items);
  } catch {
    return actionError("We could not read the line items. Add them again.");
  }
  if (!Array.isArray(items) || items.length === 0) {
    return actionError("Select a customer and add at least one plan");
  }
  if (
    data.md_type === "percent" &&
    data.md_value != null &&
    (data.md_value < 1 || data.md_value > 100)
  ) {
    return actionError("Percent must be between 1 and 100", {
      errors: { md_value: "Must be between 1 and 100" },
    });
  }

  const body: Record<string, unknown> = { items };
  if (data.subscription_id) body.id = data.subscription_id;
  // `trial_days` is deliberately three-way (createSubBody in src/api/subscription-routes.ts):
  // OMITTED = auto-apply the plan price's configured `trial_period`, 0 = explicit no-trial
  // (`trial_end:0`), N = a trial of N days. A truthiness test dropped the explicit 0, so
  // an operator who typed 0 to suppress a plan's trial silently got the trial anyway — while
  // the create form previewed an immediate charge. `!= null` keeps all three reachable
  // (the schema's `optNonNegInt` already maps '' → undefined).
  if (data.trial_days != null) body.trial_days = data.trial_days;
  if (data.start_date) body.start_date = new Date(data.start_date).toISOString();
  if (data.auto_collection) body.auto_collection = data.auto_collection;
  if (data.net_term_days != null) body.net_term_days = data.net_term_days;
  if (data.po_number) body.po_number = data.po_number;
  if (data.invoice_notes) body.invoice_notes = data.invoice_notes;
  // Send the explicit boolean both ways. Only 'true' used to be forwarded, so choosing
  // "Immediately" posted nothing, the column stayed NULL, and the engine fell back to
  // the business default — which could be the opposite of what the operator picked.
  if (data.create_pending_invoices === "true") body.create_pending_invoices = true;
  else if (data.create_pending_invoices === "false") body.create_pending_invoices = false;
  // Monthly usage billing and the commitment: explicit, preselected from the plan price.
  if (data.bill_usage_monthly === "true") body.bill_usage_monthly = true;
  else if (data.bill_usage_monthly === "false") body.bill_usage_monthly = false;
  if (data.commitment_present === "1")
    body.commitment_amount_minor = data.commitment_amount_minor
      ? Number(data.commitment_amount_minor)
      : null;
  // SIGNUP invoicing — a different field from `create_pending_invoices` (renewals).
  // Explicit both ways for the same reason: an omitted value is a silent default,
  // and this screen states which one will happen.
  if (data.invoice_immediately === "true") body.invoice_immediately = true;
  else if (data.invoice_immediately === "false") body.invoice_immediately = false;
  // Sent only when it differs from the engine's default (`refuse`).
  if (data.on_charge_failure === "dun") body.on_charge_failure = "dun";
  // A signup coupon goes IN the create call, via `coupon_ids`, which exists precisely
  // for this: the route applies it once the subscription exists but BEFORE the first
  // invoice is planned, so `peekDiscounts` discounts that invoice. This used to be a
  // `POST …/discount` AFTER create — by which time the first invoice had already been
  // raised and charged at full price, so the customer never received the discount they
  // were promised at signup. It also means a bad code now refuses the whole signup
  // (the route deletes the provisional subscription) instead of leaving a subscription
  // whose first invoice silently ignored the coupon.
  if (data.coupon_code) body.coupon_ids = [data.coupon_code];
  // The manual discount now rides the SAME call, for the same reason and with the same
  // semantics. It was the last survivor of the pattern described just above: created
  // first, discounted second, so the first invoice was raised and charged at full price
  // and the discount only reached the NEXT renewal. Worse, it failed as a WARNING — the
  // operator got a green "Subscription created" banner with "manual discount failed"
  // inside it, which is how a guard comparing our status column to `'trialing'` (a value
  // it never holds) went unnoticed: every in-trial signup discount was silently refused.
  //
  // A discount passed with the create call lands on the first invoice (sub_total 700 →
  // discount 175 → total 525).
  if (data.md_type && data.md_value != null) {
    body.discount = {
      type: data.md_type,
      value: data.md_value,
      duration: data.md_duration === "forever" ? "forever" : "one_time",
    };
  }

  const res = await apiPost(`/v1/businesses/${data.biz}/customers/${data.cus}/subscriptions`, body);
  if (!res.ok) return actionError(res.error ?? "We could not create the subscription.");
  const created = res.data as
    | {
        id?: string;
        latest_invoice?: { id?: string } | null;
        payment_error?: { code?: string };
      }
    | undefined;
  const newSub = created?.id;

  revalidatePath(`/businesses/${data.biz}/subscriptions`);
  // `on_charge_failure: dun`: created, but the first invoice is still open.
  if (created?.payment_error && created.latest_invoice?.id)
    return actionOk(
      `Subscription created. The payment failed (${created.payment_error.code ?? "declined"}). Dunning will collect invoice ${created.latest_invoice.id}.`,
      newSub ? subUrl(data.biz, newSub) : `/businesses/${data.biz}/subscriptions`,
    );
  return actionOk(
    "Subscription created",
    newSub ? subUrl(data.biz, newSub) : `/businesses/${data.biz}/subscriptions`,
  );
}

// --- Business settings ---

// ─── New-style actions (ActionResult + <ActionForm> toasts) ──────────────────

/**
 * Set (or clear) how many cycles remain AFTER the current one.
 *
 * Two distinct inputs on purpose. `mode=forever` clears the cap (`null`); `mode=count`
 * takes a non-negative integer. A single box cannot express "forever" — blank would have
 * to mean either "unlimited" or "no change", and the field is exactly the kind where
 * guessing wrong cancels a paying subscription.
 */
export async function setSubscriptionBillingCyclesAction(
  _prev: import("@/lib/action-result").ActionResult | null,
  formData: FormData,
): Promise<import("@/lib/action-result").ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  const mode = String(formData.get("mode") ?? "").trim();
  if (!biz || !sub || !["forever", "count"].includes(mode))
    return { ok: false, message: "Invalid request" };

  let value: number | null = null;
  if (mode === "count") {
    const raw = String(formData.get("count") ?? "").trim();
    const n = Number(raw);
    if (raw === "" || !Number.isInteger(n) || n < 0) {
      return {
        ok: false,
        message: "Enter a whole number of renewals (0 or more)",
        errors: { count: "Whole number, 0 or more" },
      };
    }
    value = n;
  }
  const res = await apiPatch(`/v1/businesses/${biz}/subscriptions/${sub}`, {
    remaining_billing_cycles: value,
  });
  revalidatePath(subUrl(biz, sub));
  if (!res.ok) return { ok: false, message: res.error ?? "We could not save the change." };
  return {
    ok: true,
    message:
      value === null
        ? "This subscription now renews forever"
        : value === 0
          ? "The current term is now the last. The subscription cancels at term end."
          : `${value} more renewal${value === 1 ? "" : "s"} after the current term`,
  };
}

/**
 * Cap AUTOMATIC CREDIT APPLICATION on one subscription — the per-subscription half of
 * Billing rules → Credits Flexibility, which is otherwise business-wide.
 *
 * Three states, because two cannot express it: a blank box would have to mean either "no
 * ceiling" or "no change". Same shape as `setSubscriptionBillingCyclesAction` next door
 * and for the same reason.
 *
 *   inherit → null   the business setting alone decides
 *   none    → 0      never auto-apply this kind to this subscription
 *   limit   → N      up to N, in the subscription's own currency
 *
 * ⚠️ It can only NARROW the business setting. `creditApplicationLimits` takes the tighter
 * of the two ceilings, so a generous number here does not widen a business set to `none`.
 * The copy says so rather than letting a merchant infer it from an unchanged invoice.
 */
export async function setSubscriptionCreditUsageAction(
  _prev: import("@/lib/action-result").ActionResult | null,
  formData: FormData,
): Promise<import("@/lib/action-result").ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim();
  const mode = String(formData.get("mode") ?? "").trim();
  if (!biz || !sub || (kind !== "refundable" && kind !== "excess"))
    return { ok: false, message: "Invalid request" };
  if (!["inherit", "none", "limit"].includes(mode))
    return { ok: false, message: "Select how credit applies" };

  let minor: number | null = null;
  if (mode === "none") minor = 0;
  if (mode === "limit") {
    // The form edits MAJOR units in the subscription's currency; the API takes minor.
    const perMajor = Number(String(formData.get("minor_per_major") ?? "100")) || 100;
    const raw = String(formData.get("limit") ?? "").trim();
    const major = Number(raw);
    if (raw === "" || !Number.isFinite(major) || major < 0) {
      return {
        ok: false,
        message: "Enter the limit amount, or choose a different option",
        errors: { limit: "Amount, 0 or more" },
      };
    }
    minor = Math.round(major * perMajor);
  }

  const field =
    kind === "refundable" ? "max_refundable_credits_usage_minor" : "max_excess_payment_usage_minor";
  const res = await apiPatch(`/v1/businesses/${biz}/subscriptions/${sub}`, { [field]: minor });
  revalidatePath(subUrl(biz, sub));
  if (!res.ok) return { ok: false, message: res.error ?? "We could not save the change." };
  const label = kind === "refundable" ? "Refundable credit" : "Excess payments";
  return {
    ok: true,
    message:
      minor === null
        ? `${label} now follows the business setting for this subscription`
        : minor === 0
          ? `${label} will no longer auto-apply to this subscription`
          : `${label} will auto-apply up to the limit you set`,
  };
}

/** Set or remove a subscription's minimum commitment. It applies from now. */
export async function setSubscriptionCommitmentAction(
  _prev: import("@/lib/action-result").ActionResult | null,
  formData: FormData,
): Promise<import("@/lib/action-result").ActionResult> {
  await requirePermission("subscriptions:manage", "ops");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  if (!biz || !sub) return { ok: false, message: "Invalid request" };
  const perMajor = Number(String(formData.get("minor_per_major") ?? "100")) || 100;
  const raw = String(formData.get("amount") ?? "").trim();
  const major = Number(raw);
  if (raw !== "" && (!Number.isFinite(major) || major <= 0))
    return {
      ok: false,
      message: "Correct the highlighted fields.",
      errors: { amount: "Enter an amount more than 0, or leave it empty for no commitment" },
    };
  const minor = raw === "" ? null : Math.round(major * perMajor);
  const res = await apiPost(`/v1/businesses/${biz}/subscriptions/${sub}/commitment`, {
    amount_minor: minor,
  });
  revalidatePath(subUrl(biz, sub));
  if (!res.ok) return { ok: false, message: res.error ?? "We could not save the change." };
  return { ok: true, message: minor === null ? "Commitment removed." : "Commitment changed." };
}

export async function setSubscriptionAutoCollectionAction(
  _prev: import("@/lib/action-result").ActionResult | null,
  formData: FormData,
): Promise<import("@/lib/action-result").ActionResult> {
  await requirePermission("subscriptions:manage", "manager");
  const biz = String(formData.get("biz") ?? "").trim();
  const sub = String(formData.get("sub") ?? "").trim();
  const value = String(formData.get("auto_collection") ?? "").trim();
  if (!biz || !sub || !["on", "off"].includes(value))
    return { ok: false, message: "Invalid request" };
  const res = await apiPatch(`/v1/businesses/${biz}/subscriptions/${sub}`, {
    auto_collection: value,
  });
  revalidatePath(subUrl(biz, sub));
  return res.ok
    ? { ok: true, message: `Auto collection is now ${value}` }
    : { ok: false, message: res.error ?? "We could not save the change." };
}
