/**
 * Two Minute Billing TypeScript SDK (`@two-minute-billing/sdk`) — a thin, typed,
 * dependency-free client over the REST API. Mirrors the OpenAPI surface (see /openapi.json).
 *
 *   const tmb = new Tmbilling({ apiKey: 'sk_test_…' })
 *   const biz = await tmb.businesses.create({ name: 'Fernhill Analytics', default_currency: 'USD' })
 *   const cus = await tmb.customers.create(biz.id, { email: 'maya@example.com' })
 */

export interface TmbillingOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class TmbillingError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "TmbillingError";
  }
}

import type { UsageEventBatchResult } from "./ai-usage.js";
export * from "./ai-usage.js";

// Response types are DERIVED from the OpenAPI-generated schema (sdk/schema.d.ts,
// produced by `pnpm sdk:generate`) so the SDK can't drift from the spec.
import type { components } from "./schema.js";
type S = components["schemas"];
export type Organization = S["Organization"];
export type Business = S["Business"];
export type Product = S["Product"];
export type ProductGroup = S["ProductGroup"];
export type Price = S["Price"];
export type Customer = S["Customer"];
export type PaymentMethod = S["PaymentMethod"];
export type PaymentIntent = S["PaymentIntent"];
export type PaymentAttempt = S["PaymentAttempt"];
export type Subscription = S["Subscription"] & {
  latest_invoice?: { id: string; status: string; total_minor: number };
};
export type Invoice = S["Invoice"];
export type TaxProfile = S["TaxProfile"];
export type TaxRegion = S["TaxRegion"];
export type TaxRateComponent = S["TaxRateComponent"];
export type TaxStateRegistration = S["TaxStateRegistration"];
export type WebhookEndpoint = S["WebhookEndpoint"];
export interface List<T> {
  object: "list";
  data: T[];
}

// ── Write-body + sub-resource types (CP-0..CP-6) ─────────────────────────────
export interface CustomerAddressWrite {
  line1?: string;
  line2?: string;
  line3?: string;
  city?: string;
  state?: string;
  state_code?: string;
  postal_code?: string;
  country?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  phone?: string;
}
export interface CustomerWrite {
  email?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  phone?: string | null;
  currency?: string | null;
  locale?: string | null;
  auto_collection?: "on" | "off";
  net_term_days?: number;
  invoice_notes?: string | null;
  address?: CustomerAddressWrite | null;
  shipping_address?: Record<string, unknown> | null;
  tax_exempt?: boolean;
  vat_number?: string | null;
  withholding_rate_bps?: number;
  metadata?: Record<string, unknown> | null;
}
export interface ContactWrite {
  first_name?: string | null;
  last_name?: string | null;
  email?: string;
  phone?: string | null;
  label?: string | null;
  enabled?: boolean;
  send_account_email?: boolean;
  send_billing_email?: boolean;
}
export interface Contact {
  object: "contact";
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  label: string | null;
  enabled: boolean;
  send_account_email: boolean;
  send_billing_email: boolean;
  created_at: string;
  updated_at: string;
  resource_version: number;
}
/** Slug id a merchant chooses for a catalogue object, e.g. `pro`. `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`. */
export type Slug = string;
export interface ProductWrite {
  name?: string;
  external_name?: string | null;
  description?: string | null;
  kind?: "plan" | "addon" | "charge";
  /** HSN/SAC tax classification code. */
  tax_code?: string | null;
  unit_of_measure?: string | null;
  metered?: boolean;
  enabled_for_checkout?: boolean;
  enabled_in_portal?: boolean;
  redirect_url?: string | null;
  addon_applies_to_all?: boolean;
  metadata?: Record<string, unknown> | null;
  product_group?: string;
}
/** Create-only: the product's slug id (omit to derive one from the name). */
export interface ProductCreate extends ProductWrite {
  name: string;
  id?: Slug;
}
export interface PriceTier {
  upToMinor: number | null;
  unitAmountMinor?: number;
  flatAmountMinor?: number;
}
type TrialUnit = "day" | "week" | "month" | "year";
type PriceTrialEndAction = "activate_subscription" | "cancel_subscription";
/** Fields a price accepts on create and (as nullable) on update. */
export interface PriceFields {
  name?: string | null;
  external_name?: string | null;
  description?: string | null;
  amount_minor?: number | null;
  tiers?: PriceTier[] | null;
  package_size?: number | null;
  free_units?: number | null;
  percentage_bps?: number | null;
  trial_period?: number | null;
  trial_period_unit?: TrialUnit | null;
  trial_end_action?: PriceTrialEndAction | null;
  billing_cycles?: number | null;
  free_quantity?: number | null;
  invoice_notes?: string | null;
  show_description_in_invoices?: boolean;
  show_description_in_quotes?: boolean;
  tax_code?: string | null;
  sku?: string | null;
  accounting_code?: string | null;
  accounting_category_code?: string | null;
  is_taxable?: boolean;
  tax_behavior?: "inclusive" | "exclusive";
  metadata?: Record<string, unknown> | null;
  /** Meter prices: the default rate, minor units per `quantity_divisor` units, ≤ 12 dp. */
  unit_amount_decimal?: string | null;
  /** `event_cost` and `model_price_list` prices: a decimal percent. */
  markup_percent?: string | null;
  /** `model_price_list` prices: the markup applies to the list price (default) or your cost. */
  markup_base?: "list" | "cost" | null;
  /** Meter prices: the rate card. Replaced whole on update. */
  rates?: PriceRateWrite[];
}
/** One rate-card row: group values over some of the meter's `group_by`, and their rate. */
export interface PriceRateWrite {
  match: Record<string, string>;
  /** A fixed rate. On a `model_price_list` price, set this or `markup_percent`, not both. */
  unit_amount_decimal?: string;
  /** `model_price_list` prices: a markup for these values over the price's markup base. */
  markup_percent?: string;
}
export interface PriceCreate extends PriceFields {
  /** Bill from this meter's events (models usage, tiered, volume, package). Fixed after create. */
  meter?: string;
  /** The rate is per this many units, e.g. 1000000 for "per 1M tokens". Fixed after create. */
  quantity_divisor?: number | string;
  /** rate (default), event_amount, event_cost or model_price_list. Fixed after create. */
  amount_source?: "rate" | "event_amount" | "event_cost" | "model_price_list";
  product: string;
  /** The price's slug id (omit to derive one). */
  id?: Slug;
  model:
    | "flat"
    | "per_unit"
    | "tiered"
    | "volume"
    | "stairstep"
    | "usage"
    | "package"
    | "percentage";
  currency: string;
  type?: "recurring" | "one_time";
  interval?: "day" | "week" | "month" | "year";
  interval_count?: number;
  usage_aggregation?: "sum" | "max" | "last" | "count" | "min" | "avg" | "unique";
}
export type CouponCreate = S["CouponCreate"];
export type CouponUpdate = S["CouponUpdate"];
export interface PaymentLinkItem {
  price: string;
  quantity?: number;
  /** The buyer may choose a quantity between these (both absent = fixed). */
  min_quantity?: number;
  max_quantity?: number;
  /** The buyer may remove this line. */
  optional?: boolean;
}
export interface PaymentLink {
  object: "payment_link";
  id: string;
  name: string;
  active: boolean;
  mode: string;
  show_on_pricing_page: boolean;
  redirect_url: string | null;
  cancel_url: string | null;
  url: string;
  items: Required<PaymentLinkItem>[];
  opens: number;
  completions: number;
  created_at: string;
}
export interface CheckoutSessionCreate {
  /** Single-item sugar for `items: [{ price, quantity }]`. Not with `items`. */
  price?: string;
  quantity?: number;
  items?: Array<{ price: string; quantity?: number }>;
  coupons?: string[];
  /** `create` (default) subscribes a new customer; `change` edits `subscription`; `purchase` sells one-time items. */
  mode?: "create" | "change" | "purchase";
  /** mode `purchase`: an existing customer. */
  customer_id?: string;
  /** mode `change`: the subscription to change. */
  subscription?: string;
  replace_items_list?: boolean;
  reset_term?: boolean;
  reactivate?: boolean;
  reactivate_from?: string;
  replace_coupon_list?: boolean;
  redirect_url?: string;
  cancel_url?: string;
  pass_thru_content?: string;
  metadata?: Record<string, unknown>;
  /** mode `create`: defaults for the buyer's details step. */
  customer?: { email?: string; tax_registration_number?: string };
  billing_address?: CustomerAddressWrite;
}
export type EventList = S["EventList"];

export interface Estimate {
  object: "estimate";
  currency: string;
  lines: Array<{ description: string; amount_minor: number }>;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  immediate_charge: boolean;
}

// ── Usage metering (G1a) ─────────────────────────────────────────────────────
// Hand-written until the meter routes are in sdk/schema.d.ts; then derive them from it.
export type MeterAggregation =
  | "sum"
  | "count"
  | "min"
  | "max"
  | "avg"
  | "last"
  | "unique"
  | "weighted_sum";
export interface MeterWrite {
  name?: string;
  event_name?: string;
  aggregation?: MeterAggregation;
  /** Required except for `count`. */
  value_property?: string | null;
  /** `unique` only. */
  unique_property?: string | null;
  /** sum, last, max and unique only. */
  recurring?: boolean;
  /** `weighted_sum` only. */
  time_unit?: "hour" | "day" | null;
  /** An event counts only when every listed property has one of its values. */
  filters?: Record<string, Array<string | number | boolean>>;
  /** Up to 5 property names, in order. */
  group_by?: string[];
  /** Maps events to a model price list key, for cost and `model_price_list` prices. */
  price_list?: MeterPriceList | null;
  /** Currency of the events' `cost`. Null = the price's currency. */
  cost_currency?: string | null;
}
/** A fixed value or the event property that holds it. `model_key` defaults to "model". */
export interface MeterPriceList {
  provider?: string;
  provider_key?: string;
  model_key?: string;
  token_type?: string;
  token_type_key?: string;
}
export interface Meter extends Required<Omit<MeterWrite, "filters">> {
  object: "meter";
  id: string;
  filters: Record<string, Array<string | number | boolean>>;
  status: "active" | "archived";
  /** True once the meter has a counted event or a price: only `name` can change. */
  locked: boolean;
  created_at: string;
}
// ── Model prices, your cost and margin (G1b) ───────────────────────────────────
// Hand-written until the routes are in sdk/schema.d.ts. Decimals are strings; amounts are
// minor units per `quantity_divisor` units ("300" per 1000000 = $3.00 per 1M tokens).
export interface ModelPrice {
  object: "model_price";
  /** mpr_… — the id an invoice line cites in `rating.segments[].model_price_id`. */
  id: string;
  provider: string;
  model: string;
  token_type: string;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: number | string;
  /** When we started to bill with this price. Null = the model's first price. */
  effective_from: string | null;
  /** The source's own date. */
  source_effective_from: string | null;
  source: string;
  source_version: string | null;
}
export interface ModelCostOverride {
  object: "model_cost_override";
  /** mco_… */
  id: string;
  provider: string | null;
  model: string;
  token_type: string;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: number | string;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
}
export interface ModelCostOverrideCreate {
  /** Omit to use the cost for the model under any provider. */
  provider?: string;
  model: string;
  token_type: string;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor?: number | string;
  /** Now or later; omit for now. */
  effective_from?: string;
  note?: string;
}
export interface UsageMarginRow {
  key: string;
  label?: string | null;
  revenue_minor: number;
  cost_minor: number;
  margin_minor: number;
  margin_percent: string | null;
  lines_without_cost: number;
}

export interface UsageEventInput {
  /** 1–255 characters, unique per business: the idempotency key of this event. */
  key: string;
  /** A usage key of the customer, or the customer id. */
  customer: string;
  event_name: string;
  /** RFC 3339 with `Z` or an offset; within 35 days back and 5 minutes ahead. */
  timestamp?: string;
  /** Flat: up to 50 keys of string, number or boolean. */
  properties?: Record<string, string | number | boolean>;
  /** Major-unit decimal strings, up to 12 decimal places. */
  amount?: string;
  cost?: string;
  currency?: string;
}
export interface UsageEvent {
  object: "usage_event";
  id: string;
  key: string;
  /** `cus_…`, or null while no usage key matches. */
  customer: string | null;
  customer_key: string;
  event_name: string;
  timestamp: string;
  properties: Record<string, string | number | boolean>;
  amount: string | null;
  cost: string | null;
  currency: string | null;
  status: "matched" | "unmatched" | "voided";
  /** Keys of the meters it counts toward. */
  meters: string[];
  /** e.g. `no_meter`, `currency_mismatch`. */
  flags: string[];
  created_at: string;
  voided_at: string | null;
  void_reason: string | null;
}
export interface UsageKey {
  object: "usage_key";
  key: string;
  customer: string;
  created_at: string;
}

interface Req {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

export class Tmbilling {
  private apiKey: string;
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: TmbillingOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:4000").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async request<T>(req: Req): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    // Only declare a JSON body when one is actually sent — bodyless POSTs
    // (reactivate/pause/resume) must not advertise application/json with an
    // empty body, which the server rejects.
    if (req.body != null) headers["Content-Type"] = "application/json";
    // Every write carries an Idempotency-Key, minted here when the caller does not supply
    // one (audit L6). The engine requires the header on mutating routes, and an SDK for a
    // BILLING API that makes the caller remember it has the default backwards: the failure
    // it prevents is a double charge on a network retry, and the person most likely to
    // forget is the one integrating for the first time.
    //
    // A caller who passes `idempotencyKey` still wins, which is what makes a deliberate
    // retry of the SAME logical operation possible — reuse the value to replay, mint a new
    // one for a fresh attempt.
    if (req.method !== "GET") {
      headers["Idempotency-Key"] = req.idempotencyKey ?? crypto.randomUUID();
    }
    const res = await this.fetchImpl(`${this.baseUrl}${req.path}`, {
      method: req.method,
      headers,
      body: req.body != null ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = (json as { error?: { type?: string; message?: string } }).error;
      throw new TmbillingError(
        res.status,
        e?.type ?? "api_error",
        e?.message ?? res.statusText,
        json,
      );
    }
    return json as T;
  }

  me = (): Promise<Organization> => this.request({ method: "GET", path: "/v1/me" });

  businesses = {
    create: (
      body: { name: string; default_currency?: string; livemode?: "live" | "test" },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<Business>({
        method: "POST",
        path: "/v1/businesses",
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: () => this.request<List<Business>>({ method: "GET", path: "/v1/businesses" }),
    /** Update business settings (profile, invoice config, dunning schedule, provider). */
    update: (
      biz: string,
      body: {
        name?: string;
        default_currency?: string;
        provider_config?: unknown;
        address?: Record<string, string | null> | null;
        contact_email?: string | null;
        support_email?: string | null;
        phone?: string | null;
        website?: string | null;
        logo_url?: string | null;
        /** Brand Styles: square mark, browser tab, and `#RRGGBB` accent. */
        icon_url?: string | null;
        favicon_url?: string | null;
        brand_color?: string | null;
        timezone?: string | null;
        tax_registration_number?: string | null;
        invoice_prefix?: string;
        invoice_next_number?: number;
        default_invoice_notes?: string | null;
        default_due_days?: number | null;
        dunning_retry_days?: number[] | null;
        /** Checkout and portal presentation; omitted keys keep their defaults. */
        storefront_config?: Record<string, unknown> | null;
      },
    ) => this.request<Business>({ method: "PATCH", path: `/v1/businesses/${biz}`, body }),
  };

  products = {
    create: (biz: string, body: ProductCreate, opts?: { idempotencyKey?: string }) =>
      this.request<Product>({
        method: "POST",
        path: `/v1/businesses/${biz}/products`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string, opts?: { includeArchived?: boolean; group?: string }) => {
      const qs = new URLSearchParams();
      if (opts?.includeArchived) qs.set("include_archived", "true");
      if (opts?.group) qs.set("group", opts.group);
      const q = qs.toString();
      return this.request<List<Product>>({
        method: "GET",
        path: `/v1/businesses/${biz}/products${q ? `?${q}` : ""}`,
      });
    },
    /** Edit a product. Pass active:false to archive, active:true to restore. `expected_version` → 409 on stale. */
    update: (
      biz: string,
      prod: string,
      body: ProductWrite & { active?: boolean; expected_version?: number },
    ) =>
      this.request<Product>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/products/${prod}`,
        body,
      }),
    archive: (biz: string, prod: string) =>
      this.request<Product>({ method: "DELETE", path: `/v1/businesses/${biz}/products/${prod}` }),
    /** Set the plans an add-on applies to, with optional per-plan applicability (CP-6). */
    setApplicablePlans: (
      biz: string,
      prod: string,
      plans: string[],
      applicability?: Record<string, "mandatory" | "recommended" | "optional">,
    ) =>
      this.request<{ object: "applicable_plans"; addon: string; plans: string[] }>({
        method: "PUT",
        path: `/v1/businesses/${biz}/products/${prod}/applicable_plans`,
        body: { plans, applicability },
      }),
    applicablePlans: (biz: string, prod: string) =>
      this.request<{
        object: "applicable_plans";
        addon: string;
        applies_to_all: boolean;
        plans: string[];
        applicability: Record<string, string>;
      }>({ method: "GET", path: `/v1/businesses/${biz}/products/${prod}/applicable_plans` }),
    /** Differential pricing for an add-on when attached to a specific plan (CP-6). */
    listDifferentialPrices: (biz: string, prod: string) =>
      this.request<{
        object: "list";
        addon: string;
        data: Array<{
          id: string;
          plan: string;
          currency: string;
          interval: string | null;
          amount_minor: number;
        }>;
      }>({ method: "GET", path: `/v1/businesses/${biz}/products/${prod}/differential_prices` }),
    setDifferentialPrice: (
      biz: string,
      prod: string,
      body: {
        plan: string;
        currency: string;
        interval?: "day" | "week" | "month" | "year" | null;
        amount_minor: number;
      },
    ) =>
      this.request<{
        object: "differential_price";
        id: string;
        addon: string;
        plan: string;
        currency: string;
        interval: string | null;
        amount_minor: number;
      }>({
        method: "PUT",
        path: `/v1/businesses/${biz}/products/${prod}/differential_prices`,
        body,
      }),
  };

  productGroups = {
    create: (
      biz: string,
      body: { name: string; code?: string; description?: string; id?: Slug },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<ProductGroup>({
        method: "POST",
        path: `/v1/businesses/${biz}/product_groups`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string, opts?: { includeArchived?: boolean }) =>
      this.request<List<ProductGroup>>({
        method: "GET",
        path: `/v1/businesses/${biz}/product_groups${opts?.includeArchived ? "?include_archived=true" : ""}`,
      }),
    get: (biz: string, grp: string) =>
      this.request<ProductGroup>({
        method: "GET",
        path: `/v1/businesses/${biz}/product_groups/${grp}`,
      }),
    /** Edit a group. Pass active:false to archive (blocked if it has active products), true to restore. */
    update: (
      biz: string,
      grp: string,
      body: { name?: string; code?: string | null; description?: string | null; active?: boolean },
    ) =>
      this.request<ProductGroup>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/product_groups/${grp}`,
        body,
      }),
    archive: (biz: string, grp: string) =>
      this.request<ProductGroup>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/product_groups/${grp}`,
      }),
  };

  prices = {
    create: (biz: string, body: PriceCreate, opts?: { idempotencyKey?: string }) =>
      this.request<Price>({
        method: "POST",
        path: `/v1/businesses/${biz}/prices`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string, opts?: { includeArchived?: boolean }) =>
      this.request<List<Price>>({
        method: "GET",
        path: `/v1/businesses/${biz}/prices${opts?.includeArchived ? "?include_archived=true" : ""}`,
      }),
    /** Edit a price. Applies to NEW subscriptions only (live subs keep their snapshot). */
    update: (
      biz: string,
      price: string,
      body: PriceFields & { active?: boolean; expected_version?: number },
    ) =>
      this.request<Price>({ method: "PATCH", path: `/v1/businesses/${biz}/prices/${price}`, body }),
    archive: (biz: string, price: string) =>
      this.request<Price>({ method: "DELETE", path: `/v1/businesses/${biz}/prices/${price}` }),
  };

  customers = {
    create: (biz: string, body: CustomerWrite, opts?: { idempotencyKey?: string }) =>
      this.request<Customer>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string, opts?: { includeArchived?: boolean }) =>
      this.request<List<Customer>>({
        method: "GET",
        path: `/v1/businesses/${biz}/customers${opts?.includeArchived ? "?include_archived=true" : ""}`,
      }),
    get: (biz: string, cus: string) =>
      this.request<Customer>({ method: "GET", path: `/v1/businesses/${biz}/customers/${cus}` }),
    /** Edit a customer; pass active:false to archive, active:true to restore. `expected_version` → 409 on stale. */
    update: (
      biz: string,
      cus: string,
      body: CustomerWrite & { active?: boolean; expected_version?: number },
    ) =>
      this.request<Customer>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/customers/${cus}`,
        body,
      }),
    archive: (biz: string, cus: string) =>
      this.request<Customer>({ method: "DELETE", path: `/v1/businesses/${biz}/customers/${cus}` }),
    /** Additional Contacts (CP-3). */
    listContacts: (biz: string, cus: string) =>
      this.request<List<Contact>>({
        method: "GET",
        path: `/v1/businesses/${biz}/customers/${cus}/contacts`,
      }),
    createContact: (
      biz: string,
      cus: string,
      body: ContactWrite,
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<Contact>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/contacts`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    updateContact: (biz: string, cus: string, con: string, body: Partial<ContactWrite>) =>
      this.request<Contact>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/customers/${cus}/contacts/${con}`,
        body,
      }),
    deleteContact: (biz: string, cus: string, con: string) =>
      this.request<{ object: "contact"; id: string; deleted: boolean }>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/customers/${cus}/contacts/${con}`,
      }),
  };

  paymentMethods = {
    create: (
      biz: string,
      cus: string,
      body: {
        token: string;
        provider?: string;
        /** Collect open invoices now and when its mandate confirms. Omitted = business rule. */
        collect_open_invoices?: boolean;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<
        PaymentMethod & { collected_invoices?: Array<{ invoice: string; status: string }> }
      >({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/payment_methods`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string, cus: string) =>
      this.request<List<PaymentMethod>>({
        method: "GET",
        path: `/v1/businesses/${biz}/customers/${cus}/payment_methods`,
      }),
    /** Make this the customer's default payment method. */
    setDefault: (biz: string, cus: string, pm: string) =>
      this.request<PaymentMethod>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/payment_methods/${pm}/default`,
      }),
    /** Detach (delete) a payment method. */
    detach: (biz: string, cus: string, pm: string) =>
      this.request<{ object: "payment_method"; id: string; deleted: boolean }>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/customers/${cus}/payment_methods/${pm}`,
      }),
    /** Begin a buyer-side vault flow — Stripe returns client_secret (Elements); PayPal/RazorPay return approval_url/checkout. */
    setup: (
      biz: string,
      cus: string,
      body: { provider: "stripe" | "paypal" | "razorpay"; return_url: string; cancel_url: string },
    ) =>
      this.request<{
        object: "vault_setup";
        provider: string;
        setup_token: string;
        mode: "redirect" | "checkout" | "client_secret";
        approval_url?: string;
        client_secret?: string;
        publishable_key?: string;
      }>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/payment_methods/setup`,
        body,
      }),
    /**
     * Mint a customer-scoped portal session (P14): a short-lived link the buyer
     * opens at /portal/<token> to manage their own payment methods. The token
     * is returned exactly once.
     */
    createPortalSession: (biz: string, cus: string, opts?: { idempotencyKey?: string }) =>
      this.request<{
        object: "portal_session";
        id: string;
        status: "created";
        /**
         * The SINGLE-USE entry credential. Good for one hour (`access_expires_at`) and
         * spent the first time the link is opened — do not persist or re-send it.
         */
        token: string;
        url?: string;
        /** When the LINK stops working. */
        access_expires_at: string;
        /** Ceiling on the SESSION the link's exchange will mint — not on the link. */
        expires_at: string;
      }>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/portal_sessions`,
        body: {},
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  /**
   * Payment intents — a CONTAINER of attempts at a gateway, for one of two purposes.
   *
   * `payment` authorizes a priced charge later captured INTO an invoice; `setup` is
   * a ZERO-amount authorization whose product is a vaulted instrument (Stripe
   * `seti_…`) and which moves no money. Each try is a `payment_attempt` — a buyer
   * who fails 3DS twice before succeeding leaves three, and a retry never
   * overwrites the earlier ones.
   */
  paymentIntents = {
    /**
     * Create an intent and its first attempt. The buyer's challenge lives on the
     * returned `attempt`, so there is nothing to fetch before rendering it.
     *
     * `purpose: 'payment'` needs `payment_method` + a positive `amount_minor` and
     * takes no `customer`. `purpose: 'setup'` needs `customer` and takes neither a
     * payment method nor an amount.
     */
    create: (
      biz: string,
      body: {
        purpose?: "payment" | "setup";
        payment_method?: string;
        customer?: string;
        amount_minor?: number;
        currency: string;
        invoice?: string;
        subscription?: string;
        return_url?: string;
        cancel_url?: string;
        method_types?: string[];
        session?: "on_session" | "off_session";
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<S["PaymentIntentWithAttempt"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/payment_intents`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Cursor-paginated. An unrecognised `status`/`purpose` is a 400, never an empty page. */
    list: (
      biz: string,
      opts?: {
        status?: string;
        purpose?: "payment" | "setup";
        limit?: number;
        startingAfter?: string;
      },
    ) => {
      const qs = new URLSearchParams();
      if (opts?.status) qs.set("status", opts.status);
      if (opts?.purpose) qs.set("purpose", opts.purpose);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      if (opts?.startingAfter) qs.set("starting_after", opts.startingAfter);
      const q = qs.toString();
      return this.request<S["PaymentIntentList"]>({
        method: "GET",
        path: `/v1/businesses/${biz}/payment_intents${q ? `?${q}` : ""}`,
      });
    },
    /** The intent plus `attempts[]`, oldest first. */
    get: (biz: string, pi: string) =>
      this.request<S["PaymentIntentWithAttempts"]>({
        method: "GET",
        path: `/v1/businesses/${biz}/payment_intents/${pi}`,
      }),
    /** Just the attempt history. `trace_id` correlates an attempt to its gateway logs. */
    attempts: (biz: string, pi: string) =>
      this.request<List<PaymentAttempt>>({
        method: "GET",
        path: `/v1/businesses/${biz}/payment_intents/${pi}/attempts`,
      }),
    /**
     * ⚠️ TEST BUSINESSES ONLY — force-pass the challenge at the simulated gateway.
     * A live business gets a 400: a real gateway authorizes over its own webhook.
     */
    authorize: (biz: string, pi: string, opts?: { idempotencyKey?: string }) =>
      this.request<PaymentIntent>({
        method: "POST",
        path: `/v1/businesses/${biz}/payment_intents/${pi}/authorize`,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Mint attempt N+1 — only while the intent is open and the latest attempt failed. */
    retry: (biz: string, pi: string, opts?: { idempotencyKey?: string }) =>
      this.request<S["PaymentIntentWithAttempt"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/payment_intents/${pi}/retry`,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /**
     * Release an authorized, unconsumed intent. A gateway with no true void
     * (RazorPay) returns 400 naming it — we never substitute a refund.
     */
    void: (biz: string, pi: string, opts?: { idempotencyKey?: string }) =>
      this.request<S["PaymentIntentWithAttempt"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/payment_intents/${pi}/void`,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /**
     * Consume an authorized intent: `purpose: 'payment'` captures into `invoice`
     * (required, and its amount due must equal the intent's amount);
     * `purpose: 'setup'` takes no body and returns the vaulted `payment_method`.
     */
    consume: (
      biz: string,
      pi: string,
      body?: { invoice?: string },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<S["PaymentIntentConsumeResult"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/payment_intents/${pi}/consume`,
        body: body ?? {},
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  subscriptions = {
    create: (
      biz: string,
      cus: string,
      body: {
        /** Your own subscription id (3-64 chars: letters, digits, `_`, `-`). Omit for a generated one. */
        id?: string;
        items: Array<{
          price: string;
          quantity?: number;
          unit_price_minor?: number;
          free_quantity?: number;
          billing_cycles?: number;
          metadata?: Record<string, unknown>;
        }>;
        /** 0 = no trial; omitted = the price's own trial. */
        trial_days?: number;
        /** An exact trial end, in place of `trial_days`. */
        trial_end?: string;
        /** `false` queues the first charge on the next invoice instead of invoicing now. */
        invoice_immediately?: boolean;
        /** Coupons applied at signup. */
        coupon_ids?: string[];
        discount?: {
          type: "percent" | "amount";
          value: number;
          duration: "one_time" | "forever";
          note?: string;
        };
        /** An already-authorized `pi_…` to settle the first invoice with. */
        payment_intent?: string;
        /** A declined first charge: `refuse` (default) creates nothing, `dun` creates it. */
        on_charge_failure?: "refuse" | "dun";
        start_date?: string;
        billing_anchor?: string;
        auto_collection?: "on" | "off";
        net_term_days?: number;
        po_number?: string;
        invoice_notes?: string;
        metadata?: Record<string, unknown>;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<
        Subscription & {
          latest_invoice?: { id: string; status: string; total_minor: number };
          payment_error?: { code: string; message: string };
        }
      >({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/subscriptions`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string) =>
      this.request<List<Subscription>>({
        method: "GET",
        path: `/v1/businesses/${biz}/subscriptions`,
      }),
    get: (biz: string, sub: string) =>
      this.request<Subscription>({
        method: "GET",
        path: `/v1/businesses/${biz}/subscriptions/${sub}`,
      }),
    /**
     * Change items on a running subscription.
     *
     * `invoice_immediately` decides where the proration CHARGE lands: `true` raises the
     * invoice now and collects it, `false` queues the lines as unbilled charges for the
     * next renewal. OMITTED resolves the business's own
     * `default_invoice_immediately` setting (which ships off), so pass it explicitly
     * whenever the caller means "invoice now" regardless of that setting. `reset_term`
     * restarts the term at the change date; a frequency change triggers one anyway.
     */
    change: (
      biz: string,
      sub: string,
      body: {
        changes?: Array<{
          item: string;
          price?: string;
          quantity?: number;
          unit_price_minor?: number;
        }>;
        /** Items to add; with `changes` and `removes`, at least one list must be non-empty. */
        adds?: Array<{ price: string; quantity?: number; unit_price_minor?: number }>;
        /** Subscription item ids to remove. */
        removes?: string[];
        at?: string;
        reset_term?: boolean;
        prorate?: boolean;
        invoice_immediately?: boolean;
        metadata?: Record<string, unknown> | null;
        /** Each of these overrides the business rule for this call. Omitted = the rule. */
        on_charge_failure?: "start_dunning" | "next_renewal";
        coupons?: "keep" | "drop" | "keep_if_valid";
        downgrade_credit?: "credit_balance" | "refund";
        /** `prorated` is upgrade only (400 on a downgrade). */
        plan_credits?: "full" | "prorated" | "next_window";
        /** Upgrade only (400 on a downgrade). */
        allowances?: "new_window" | "keep_used" | "prorated";
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<{
        object: string;
        subscription: string;
        proration_invoice: { id: string; status: string; total_minor: number } | null;
        credit_note?: { id: string; total_minor: number; status: string } | null;
        credit_refunds?: Array<{
          credit_note: string;
          refunded_minor: number;
          kept_minor: number;
          reason?: string;
        }>;
      }>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/change`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Dry-run preview of a change (proration + tax). No writes. */
    estimate: (
      biz: string,
      sub: string,
      body: {
        changes: Array<{
          item: string;
          price?: string;
          quantity?: number;
          unit_price_minor?: number;
        }>;
        /** As on `change`: the preview drops the same coupons. */
        coupons?: "keep" | "drop" | "keep_if_valid";
        /** As on `change`: decides `change_policy.credit_handling`. */
        downgrade_credit?: "credit_balance" | "refund";
      },
    ) =>
      this.request<Estimate>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/estimate`,
        body,
      }),
    /** Dry-run preview of a NEW subscription's first invoice. */
    estimateNew: (
      biz: string,
      cus: string,
      body: { items: Array<{ price: string; quantity?: number }> },
    ) =>
      this.request<Estimate>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/subscription_estimate`,
        body,
      }),
    cancel: (
      biz: string,
      sub: string,
      body?: {
        cancel_option?: "immediately" | "end_of_term" | "specific_date" | "end_of_billing_term";
        cancel_at?: string;
        credit_option_for_current_term_charges?: "none" | "prorate" | "full";
        unbilled_charges_option?: "invoice" | "delete";
        account_receivables_handling?:
          | "no_action"
          | "schedule_payment_collection"
          | "write_off"
          | "void";
        refundable_credits_handling?: "no_action" | "schedule_refund";
        cancel_reason_code?: string;
        at_period_end?: boolean;
        cancel_reason?: string;
        include_cancellation_day_in_billing?: boolean;
        /** specific_date only: the last term's credit. Omitted = business rule. */
        final_period?: "full_period" | "prorated" | "nothing";
        /** end_of_term / specific_date: credit windows after the request. Omitted = business rule. */
        plan_credits?: { on_cancel_at_period_end?: "grant_started_window" | "stop_at_request" };
      },
    ) =>
      this.request<Subscription>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/cancel`,
        body: body ?? {},
      }),
    pause: (
      biz: string,
      sub: string,
      body?: {
        pause_option?: "immediately" | "end_of_term" | "specific_date" | "billing_cycles";
        pause_date?: string;
        skip_billing_cycles?: number;
        unbilled_charges_handling?: "invoice" | "delete" | "no_action";
        dunning_handling?: "continue" | "stop";
        resume_date?: string;
        /** Credit windows while paused, for this pause only. Omitted = business rule. */
        plan_credits?: { on_pause?: "skip" | "keep_granting" | "shift" };
      },
    ) =>
      this.request<Subscription>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/pause`,
        ...(body ? { body } : {}),
      }),
    /** In-term resumes charge nothing; after the term ended, the new term is billed. */
    resume: (
      biz: string,
      sub: string,
      body?: {
        charges_handling?: "invoice_immediately" | "add_to_unbilled_charges";
        unpaid_invoices_handling?: "no_action" | "schedule_payment_collection";
      },
    ) =>
      this.request<Subscription & { latest_invoice?: string | null }>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/resume`,
        ...(body ? { body } : {}),
      }),
    reactivate: (
      biz: string,
      sub: string,
      body?: {
        items?: Array<{ price: string; quantity?: number; unit_price_minor?: number | null }>;
        billing_cycles?: number | null;
        trial_end?: string;
        charges_handling?: "invoice_immediately" | "add_to_unbilled_charges";
        /** A failed charge: `refuse` keeps it cancelled, `dun` reactivates. Omitted = business rule. */
        on_charge_failure?: "refuse" | "dun";
        coupon_code?: string;
        manual_discount?: {
          type: "percent" | "amount";
          value: number;
          duration?: "one_time" | "forever";
        };
      },
    ) =>
      this.request<
        Subscription & {
          latest_invoice?: { id: string; status: string; total_minor: number };
          payment_error?: { code: string; message: string };
        }
      >({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/reactivate`,
        ...(body ? { body } : {}),
      }),
    /** Schedule a future-dated cancel/pause/resume/change. */
    schedule: (
      biz: string,
      sub: string,
      body: {
        type: "cancel" | "pause" | "resume" | "change";
        effective_at: string;
        changes?: Array<{
          item: string;
          price?: string;
          quantity?: number;
          unit_price_minor?: number;
        }>;
      },
    ) =>
      this.request<{
        object: "scheduled_change";
        id: string;
        type: string;
        effective_at: string;
        status: string;
      }>({ method: "POST", path: `/v1/businesses/${biz}/subscriptions/${sub}/schedule`, body }),
    scheduledChanges: (biz: string, sub: string) =>
      this.request<List<{ object: "scheduled_change"; id: string; type: string; status: string }>>({
        method: "GET",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/scheduled_changes`,
      }),
    cancelScheduledChange: (biz: string, sch: string) =>
      this.request<{ object: "scheduled_change"; id: string; status: string }>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/scheduled_changes/${sch}`,
      }),
    /** Add an item (add-on) to a subscription — prorated charge now. */
    /**
     * Add an item/add-on to a running subscription.
     *
     * `invoice_immediately` is the same Invoicing Option `change` carries: `true` raises
     * the prorated invoice now, `false` queues an unbilled charge for the next renewal
     * (the response then carries `unbilled_charges` instead of `proration_invoice`).
     * OMITTED resolves the business's `default_invoice_immediately` — pass it explicitly
     * to invoice now regardless of that setting.
     */
    addItem: (
      biz: string,
      sub: string,
      body: {
        price: string;
        quantity?: number;
        unit_price_minor?: number;
        invoice_immediately?: boolean;
      },
    ) =>
      this.request<{
        object: "subscription_item";
        id: string;
        price: string;
        quantity: number;
        proration_invoice: unknown;
        unbilled_charges?: Array<{ id: string; amount_minor: number }>;
      }>({ method: "POST", path: `/v1/businesses/${biz}/subscriptions/${sub}/items`, body }),
    /** Remove an item — credit unused time to the customer balance. */
    removeItem: (biz: string, sub: string, item: string) =>
      // `credit_notes` is every note the removal issued — one per invoice that charged
      // the item; `credit_note` is the largest of them.
      this.request<{
        object: "subscription_item";
        id: string;
        removed: boolean;
        credit_note: { id: string; total_minor: number; status: string } | null;
        credit_notes: Array<{ id: string; total_minor: number; status: string }>;
      }>({ method: "DELETE", path: `/v1/businesses/${biz}/subscriptions/${sub}/items/${item}` }),
    /** Add a one-time ad-hoc charge (invoice now, or fold into next renewal). */
    charge: (
      biz: string,
      sub: string,
      body: { description: string; amount_minor: number; invoice_now?: boolean },
    ) =>
      this.request<{ object: string }>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/charges`,
        body,
      }),
    recordUsage: (
      biz: string,
      sub: string,
      body: {
        item: string;
        quantity: number;
        unique_key?: string;
        timestamp?: string;
        idempotency_key?: string;
      },
    ) =>
      this.request<{ object: "usage_record"; id: string; quantity: number }>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/usage`,
        body,
      }),
  };

  invoices = {
    list: (biz: string, opts?: { customer?: string }) =>
      this.request<List<Invoice>>({
        method: "GET",
        path: `/v1/businesses/${biz}/invoices${opts?.customer ? `?customer=${opts.customer}` : ""}`,
      }),
    get: (biz: string, inv: string) =>
      this.request<Invoice>({ method: "GET", path: `/v1/businesses/${biz}/invoices/${inv}` }),
    /** Create a manual / one-off invoice (Net-D via net_days; collect to charge now). */
    create: (
      biz: string,
      body: {
        customer: string;
        currency?: string;
        lines: Array<{ description: string; amount_minor: number; quantity?: number }>;
        collect?: boolean;
        net_days?: number;
        apply_tax?: boolean;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<Invoice>({
        method: "POST",
        path: `/v1/businesses/${biz}/invoices`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    void: (biz: string, inv: string) =>
      this.request<Invoice>({ method: "POST", path: `/v1/businesses/${biz}/invoices/${inv}/void` }),
    writeOff: (biz: string, inv: string) =>
      this.request<Invoice>({
        method: "POST",
        path: `/v1/businesses/${biz}/invoices/${inv}/write_off`,
      }),
    /** Attempt collection now (also exposed as /retry for dunning). */
    collect: (biz: string, inv: string) =>
      this.request<Invoice>({
        method: "POST",
        path: `/v1/businesses/${biz}/invoices/${inv}/collect`,
      }),
    /** Record an offline/manual payment (or mark-paid by omitting amount). */
    pay: (
      biz: string,
      inv: string,
      body?: {
        amount_minor?: number;
        method?: string;
        /** Less than due: `write_off` (within the business limit) or `leave_due`. Omitted = rule. */
        shortfall?: "write_off" | "leave_due";
        /** More than due: `credit` (default) or `refund` (recorded as returned to the payer). */
        excess?: "credit" | "refund";
      },
    ) =>
      this.request<Invoice & { excess_credited_minor?: number; excess_refunded_minor?: number }>({
        method: "POST",
        path: `/v1/businesses/${biz}/invoices/${inv}/pay`,
        body: body ?? {},
      }),
    /**
     * Apply the customer's refundable / excess credit to this invoice DELIBERATELY —
     * the explicit counterpart to auto-application, and the only way to spend credit
     * when the business has set Credits Flexibility to "do not auto-apply".
     *
     * Post nothing to apply as much as the invoice can absorb (refundable first, then
     * excess); `amount_minor` caps the total; `refundable_minor` / `excess_minor` name
     * exact amounts, and are REFUSED rather than clamped if they do not fit.
     */
    applyCredits: (
      biz: string,
      inv: string,
      body?: {
        refundable_minor?: number;
        excess_minor?: number;
        amount_minor?: number;
        comment?: string;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<
        Invoice & {
          applied: { refundable_minor: number; excess_minor: number; total_minor: number };
          customer_balance_after: {
            currency: string;
            refundable_minor: number;
            excess_minor: number;
          };
        }
      >({
        method: "POST",
        path: `/v1/businesses/${biz}/invoices/${inv}/apply_credits`,
        body: body ?? {},
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  payments = {
    /** Refund a payment — omit amount_minor for the full remaining amount. */
    refund: (
      biz: string,
      pay: string,
      body?: {
        amount_minor?: number;
        reason?: string;
        /** A later gateway decline: `block` or `issue_credit`. Omitted = the business rule. */
        on_decline?: "block" | "issue_credit";
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<S["Refund"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/payments/${pay}/refund`,
        body: body ?? {},
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  wallet = {
    topUp: (
      biz: string,
      cus: string,
      body: { amount_minor: number; currency: string; type?: "paid" | "granted" },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<{
        object: "wallet_topup";
        id: string;
        credit_type: string;
        amount_minor: number;
        currency: string;
        balance_minor: number;
      }>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/wallet/topup`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    get: (biz: string, cus: string, currency?: string) =>
      this.request<{ object: "wallet"; customer: string; currency: string; balance_minor: number }>(
        {
          method: "GET",
          path: `/v1/businesses/${biz}/customers/${cus}/wallet${currency ? `?currency=${currency}` : ""}`,
        },
      ),
  };

  creditNotes = {
    issue: (
      biz: string,
      body: {
        invoice: string;
        credit_method: "refund" | "balance";
        items: Array<{ description: string; amount_minor: number }>;
        reason?: string;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<S["CreditNote"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/credit_notes`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  coupons = {
    create: (biz: string, body: CouponCreate, opts?: { idempotencyKey?: string }) =>
      this.request<S["Coupon"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/coupons`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Apply a coupon (by code) to a subscription. */
    apply: (biz: string, sub: string, code: string, opts?: { idempotencyKey?: string }) =>
      this.request<{ object: "discount"; id: string; subscription: string; status: string }>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/discount`,
        body: { code },
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Edit a coupon (name) / archive-restore (active). */
    update: (biz: string, cpn: string, body: CouponUpdate) =>
      this.request<S["Coupon"]>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/coupons/${cpn}`,
        body,
      }),
    archive: (biz: string, cpn: string) =>
      this.request<S["Coupon"]>({ method: "DELETE", path: `/v1/businesses/${biz}/coupons/${cpn}` }),
    /** Remove the active discount from a subscription (coupon- or manual-sourced). */
    removeDiscount: (biz: string, sub: string) =>
      this.request<{ object: "discount"; subscription: string; removed: boolean }>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/discount`,
      }),
    /** Apply a manual discount (percent or fixed amount) to a subscription — no coupon object. */
    applyManual: (
      biz: string,
      sub: string,
      body: {
        type: "percent" | "amount";
        value: number;
        duration: "one_time" | "forever";
        note?: string;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<{
        object: "discount";
        id: string;
        subscription: string;
        source: "manual";
        status: string;
        remaining_periods: number | null;
      }>({
        method: "POST",
        path: `/v1/businesses/${biz}/subscriptions/${sub}/manual_discount`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  paymentLinks = {
    create: (
      biz: string,
      body: {
        name: string;
        items: PaymentLinkItem[];
        show_on_pricing_page?: boolean;
        redirect_url?: string;
        cancel_url?: string;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<PaymentLink>({
        method: "POST",
        path: `/v1/businesses/${biz}/payment_links`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string, opts?: { product?: string; includeArchived?: boolean }) => {
      const qs = new URLSearchParams();
      if (opts?.product) qs.set("product", opts.product);
      if (opts?.includeArchived) qs.set("include_archived", "true");
      const q = qs.toString();
      return this.request<List<PaymentLink>>({
        method: "GET",
        path: `/v1/businesses/${biz}/payment_links${q ? `?${q}` : ""}`,
      });
    },
    get: (biz: string, plink: string) =>
      this.request<PaymentLink>({
        method: "GET",
        path: `/v1/businesses/${biz}/payment_links/${plink}`,
      }),
    /** `active: false` archives the link. */
    update: (
      biz: string,
      plink: string,
      body: {
        name?: string;
        active?: boolean;
        show_on_pricing_page?: boolean;
        redirect_url?: string | null;
        cancel_url?: string | null;
      },
    ) =>
      this.request<PaymentLink>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/payment_links/${plink}`,
        body,
      }),
  };

  checkoutSessions = {
    /** Mint a hosted-checkout link. The response carries the one-time `token` and `url`. */
    create: (biz: string, body: CheckoutSessionCreate, opts?: { idempotencyKey?: string }) =>
      this.request<S["CheckoutSessionCreated"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/checkout_sessions`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    get: (biz: string, id: string) =>
      this.request<S["CheckoutSession"]>({
        method: "GET",
        path: `/v1/businesses/${biz}/checkout_sessions/${id}`,
      }),
    revoke: (biz: string, id: string, opts?: { idempotencyKey?: string }) =>
      this.request<S["CheckoutSessionRevoked"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/checkout_sessions/${id}/revoke`,
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  /** Meters: what to count from usage events. The id is a slug you choose. */
  meters = {
    create: (biz: string, body: MeterWrite & { id?: string }, opts?: { idempotencyKey?: string }) =>
      this.request<Meter>({
        method: "POST",
        path: `/v1/businesses/${biz}/meters`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Paged by id: pass the previous `next_cursor` as `startingAfter`. */
    list: (biz: string, opts?: { limit?: number; startingAfter?: string }) => {
      const qs = new URLSearchParams();
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      if (opts?.startingAfter) qs.set("starting_after", opts.startingAfter);
      const q = qs.toString();
      return this.request<List<Meter> & { has_more: boolean; next_cursor: string | null }>({
        method: "GET",
        path: `/v1/businesses/${biz}/meters${q ? `?${q}` : ""}`,
      });
    },
    get: (biz: string, meter: string) =>
      this.request<Meter>({ method: "GET", path: `/v1/businesses/${biz}/meters/${meter}` }),
    /** After the first counted event or price, only `name` can change. */
    update: (biz: string, meter: string, body: MeterWrite, opts?: { idempotencyKey?: string }) =>
      this.request<Meter>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/meters/${meter}`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    archive: (biz: string, meter: string, opts?: { idempotencyKey?: string }) =>
      this.request<Meter>({
        method: "POST",
        path: `/v1/businesses/${biz}/meters/${meter}/archive`,
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  /**
   * Usage events. The event `key` is the idempotency key: a repeat with the same key is a
   * `duplicate` and changes nothing, whatever its timestamp or values.
   */
  usageEvents = {
    send: (biz: string, event: UsageEventInput) =>
      this.request<{ event: UsageEvent; status: "created" | "duplicate" }>({
        method: "POST",
        path: `/v1/businesses/${biz}/usage_events`,
        body: event,
      }),
    /** 1–500 events in one request, with a result for each. */
    sendBatch: (biz: string, events: UsageEventInput[]) =>
      this.request<UsageEventBatchResult>({
        method: "POST",
        path: `/v1/businesses/${biz}/usage_events/batch`,
        body: { events },
      }),
    list: (
      biz: string,
      opts?: {
        customer?: string;
        customerKey?: string;
        meter?: string;
        key?: string;
        status?: "matched" | "unmatched" | "voided";
        limit?: number;
        startingAfter?: string;
      },
    ) => {
      const qs = new URLSearchParams();
      if (opts?.customer) qs.set("customer", opts.customer);
      if (opts?.customerKey) qs.set("customer_key", opts.customerKey);
      if (opts?.meter) qs.set("meter", opts.meter);
      if (opts?.key) qs.set("key", opts.key);
      if (opts?.status) qs.set("status", opts.status);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      if (opts?.startingAfter) qs.set("starting_after", opts.startingAfter);
      const q = qs.toString();
      return this.request<{
        object: "list";
        data: UsageEvent[];
        has_more: boolean;
        next_cursor: string | null;
      }>({ method: "GET", path: `/v1/businesses/${biz}/usage_events${q ? `?${q}` : ""}` });
    },
    /** Allowed while no finalized invoice bills the event. `timestamp` is needed after 35 days. */
    void: (
      biz: string,
      body: { key: string; timestamp?: string; reason?: string },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<{ event: UsageEvent; status: "voided" }>({
        method: "POST",
        path: `/v1/businesses/${biz}/usage_events/void`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  /** The keys usage events use to name a customer. The `cus_…` id always works too. */
  usageKeys = {
    list: (biz: string, cus: string) =>
      this.request<List<UsageKey>>({
        method: "GET",
        path: `/v1/businesses/${biz}/customers/${cus}/usage_keys`,
      }),
    add: (biz: string, cus: string, key: string, opts?: { idempotencyKey?: string }) =>
      this.request<UsageKey>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/usage_keys`,
        body: { key },
        idempotencyKey: opts?.idempotencyKey,
      }),
    remove: (biz: string, cus: string, key: string, opts?: { idempotencyKey?: string }) =>
      this.request<UsageKey>({
        method: "POST",
        path: `/v1/businesses/${biz}/customers/${cus}/usage_keys/remove`,
        body: { key },
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  /** The AI model price list (organization level). Prices are USD, updated two times a day. */
  modelPrices = {
    list: (opts?: {
      provider?: string;
      model?: string;
      tokenType?: string;
      /** Only rows with your cost. */
      hasCost?: boolean;
      /** Only models in usage of the last 35 days. */
      used?: boolean;
      asOf?: string;
      limit?: number;
      startingAfter?: string;
    }) => {
      const qs = new URLSearchParams();
      if (opts?.provider) qs.set("provider", opts.provider);
      if (opts?.model) qs.set("model", opts.model);
      if (opts?.tokenType) qs.set("token_type", opts.tokenType);
      if (opts?.hasCost) qs.set("has_cost", "true");
      if (opts?.used) qs.set("used", "true");
      if (opts?.asOf) qs.set("as_of", opts.asOf);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      if (opts?.startingAfter) qs.set("starting_after", opts.startingAfter);
      const q = qs.toString();
      return this.request<{
        object: "list";
        data: Array<ModelPrice & { cost: ModelCostOverride | null }>;
        has_more: boolean;
        next_cursor: string | null;
      }>({ method: "GET", path: `/v1/organization/model_prices${q ? `?${q}` : ""}` });
    },
    /** One dated row, such as the one an invoice line cites. */
    get: (id: string) =>
      this.request<ModelPrice>({ method: "GET", path: `/v1/organization/model_prices/${id}` }),
    /** Every dated list row and cost row for one model. */
    history: (opts: { model: string; provider?: string; tokenType?: string }) => {
      const qs = new URLSearchParams({ model: opts.model });
      if (opts.provider) qs.set("provider", opts.provider);
      if (opts.tokenType) qs.set("token_type", opts.tokenType);
      return this.request<{
        object: "model_price_history";
        prices: ModelPrice[];
        costs: ModelCostOverride[];
      }>({ method: "GET", path: `/v1/organization/model_prices/history?${qs}` });
    },
    /** Where the list comes from, and the last check. */
    source: () =>
      this.request<{
        object: "model_price_source";
        url: string;
        licence: string;
        checked_at: string | null;
        last_success_at: string | null;
        check_error: string | null;
        upstream_version: string | null;
        held: boolean;
      }>({ method: "GET", path: "/v1/organization/model_prices/source" }),
  };

  /** Your cost: provider prices you negotiated. Used for cost, margin and cost-plus prices. */
  modelCostOverrides = {
    create: (body: ModelCostOverrideCreate, opts?: { idempotencyKey?: string }) =>
      this.request<ModelCostOverride>({
        method: "POST",
        path: "/v1/organization/model_cost_overrides",
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (opts?: { model?: string; limit?: number; startingAfter?: string }) => {
      const qs = new URLSearchParams();
      if (opts?.model) qs.set("model", opts.model);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      if (opts?.startingAfter) qs.set("starting_after", opts.startingAfter);
      const q = qs.toString();
      return this.request<{
        object: "list";
        data: ModelCostOverride[];
        has_more: boolean;
        next_cursor: string | null;
      }>({ method: "GET", path: `/v1/organization/model_cost_overrides${q ? `?${q}` : ""}` });
    },
    /** Ends the cost at `effective_to` (now or later; omit for now). */
    end: (id: string, body?: { effective_to?: string }, opts?: { idempotencyKey?: string }) =>
      this.request<ModelCostOverride>({
        method: "POST",
        path: `/v1/organization/model_cost_overrides/${id}/end`,
        body: body ?? {},
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Only a cost that has not started. */
    delete: (id: string, opts?: { idempotencyKey?: string }) =>
      this.request<{ id: string; deleted: true }>({
        method: "DELETE",
        path: `/v1/organization/model_cost_overrides/${id}`,
        idempotencyKey: opts?.idempotencyKey,
      }),
  };

  /** Usage by day and margin. */
  usage = {
    /** A customer's usage by day in the business time zone; ≤ 92 days. */
    byDay: (
      biz: string,
      cus: string,
      opts: { from: string; to: string; meter?: string; includeCost?: boolean },
    ) => {
      const qs = new URLSearchParams({ from: opts.from, to: opts.to, interval: "day" });
      if (opts.meter) qs.set("meter", opts.meter);
      if (opts.includeCost) qs.set("include", "cost");
      return this.request<{
        object: "list";
        data: Array<{
          date: string;
          meter: string;
          group: Record<string, string>;
          quantity: string;
          cost_minor?: number | null;
          cost_currency?: string | null;
        }>;
      }>({ method: "GET", path: `/v1/businesses/${biz}/customers/${cus}/usage?${qs}` });
    },
    /** Revenue after discounts and line credit notes, before tax, minus cost. */
    margin: (
      biz: string,
      opts: {
        from: string;
        to: string;
        currency?: string;
        groupBy?: "customer" | "model" | "meter";
        customer?: string;
      },
    ) => {
      const qs = new URLSearchParams({ from: opts.from, to: opts.to });
      if (opts.currency) qs.set("currency", opts.currency);
      if (opts.groupBy) qs.set("group_by", opts.groupBy);
      if (opts.customer) qs.set("customer", opts.customer);
      return this.request<{
        object: "usage_margin";
        currency: string;
        rows: UsageMarginRow[];
        totals: Omit<UsageMarginRow, "key" | "label">;
      }>({ method: "GET", path: `/v1/businesses/${biz}/reports/usage_margin?${qs}` });
    },
  };

  events = {
    /** Cursor-paginated, newest first. */
    list: (
      biz: string,
      opts?: {
        type?: string;
        resourceType?: string;
        resourceId?: string;
        customer?: string;
        source?: string;
        occurredAfter?: string;
        occurredBefore?: string;
        limit?: number;
        startingAfter?: string;
      },
    ) => {
      const qs = new URLSearchParams();
      if (opts?.type) qs.set("type", opts.type);
      if (opts?.resourceType) qs.set("resource_type", opts.resourceType);
      if (opts?.resourceId) qs.set("resource_id", opts.resourceId);
      if (opts?.customer) qs.set("customer", opts.customer);
      if (opts?.source) qs.set("source", opts.source);
      if (opts?.occurredAfter) qs.set("occurred_after", opts.occurredAfter);
      if (opts?.occurredBefore) qs.set("occurred_before", opts.occurredBefore);
      if (opts?.limit != null) qs.set("limit", String(opts.limit));
      if (opts?.startingAfter) qs.set("starting_after", opts.startingAfter);
      const q = qs.toString();
      return this.request<S["EventList"]>({
        method: "GET",
        path: `/v1/businesses/${biz}/events${q ? `?${q}` : ""}`,
      });
    },
  };

  couponSets = {
    /** Create a coupon set: `count` unique single-use codes inheriting a parent coupon's rules. */
    create: (biz: string, body: S["CouponSetCreate"], opts?: { idempotencyKey?: string }) =>
      this.request<S["CouponSet"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/coupon_sets`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string) =>
      this.request<List<S["CouponSet"]>>({
        method: "GET",
        path: `/v1/businesses/${biz}/coupon_sets`,
      }),
    get: (biz: string, set: string) =>
      this.request<S["CouponSet"]>({
        method: "GET",
        path: `/v1/businesses/${biz}/coupon_sets/${set}`,
      }),
    codes: (
      biz: string,
      set: string,
      opts?: { status?: "not_redeemed" | "redeemed" | "archived" },
    ) =>
      this.request<List<S["CouponCode"]>>({
        method: "GET",
        path: `/v1/businesses/${biz}/coupon_sets/${set}/codes${opts?.status ? `?status=${opts.status}` : ""}`,
      }),
  };

  /**
   * Metadata key rules: rules for dot paths (`billing.po`) in customer and subscription
   * `metadata`. While `metadata_validation` is on, every later write is checked; a refusal is a
   * 400 with `param: "metadata"`. `updateSettings` sets both.
   */
  metadataRules = {
    create: (biz: string, body: S["MetadataKeyRuleCreate"], opts?: { idempotencyKey?: string }) =>
      this.request<S["MetadataKeyRule"]>({
        method: "POST",
        path: `/v1/businesses/${biz}/metadata_key_rules`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string, opts?: { entity_type?: "customer" | "subscription" }) =>
      this.request<List<S["MetadataKeyRule"]>>({
        method: "GET",
        path: `/v1/businesses/${biz}/metadata_key_rules${opts?.entity_type ? `?entity_type=${opts.entity_type}` : ""}`,
      }),
    update: (
      biz: string,
      rule: string,
      body: S["MetadataKeyRuleUpdate"],
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<S["MetadataKeyRule"]>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/metadata_key_rules/${rule}`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    archive: (biz: string, rule: string, opts?: { idempotencyKey?: string }) =>
      this.request<S["MetadataKeyRule"]>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/metadata_key_rules/${rule}`,
        idempotencyKey: opts?.idempotencyKey,
      }),
    settings: (biz: string) =>
      this.request<S["MetadataRuleSettings"]>({
        method: "GET",
        path: `/v1/businesses/${biz}/metadata_rule_settings`,
      }),
    updateSettings: (
      biz: string,
      body: S["MetadataRuleSettingsUpdate"],
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<S["MetadataRuleSettings"]>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/metadata_rule_settings`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Paths already in use, from recent records; values only for few, short values. */
    observedKeys: (biz: string, entity_type: "customer" | "subscription") =>
      this.request<S["MetadataObservedKeyList"]>({
        method: "GET",
        path: `/v1/businesses/${biz}/metadata_observed_keys?entity_type=${entity_type}`,
      }),
  };

  /** Tax profiles: the rates for one CLASS of product (assigned per product). */
  taxProfiles = {
    create: (
      biz: string,
      body: { name: string; is_default?: boolean },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<TaxProfile>({
        method: "POST",
        path: `/v1/businesses/${biz}/tax_profiles`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string) =>
      this.request<List<TaxProfile>>({ method: "GET", path: `/v1/businesses/${biz}/tax_profiles` }),
  };

  /**
   * Tax regions: one country under one profile, carrying the component vector, the
   * seller's registrations, and the treatments customers there may be assigned.
   */
  taxRegions = {
    create: (
      biz: string,
      body: {
        country: string;
        regime?: "gst" | "vat" | "sales_tax" | "flat";
        price_type?: "exclusive" | "inclusive";
        tax_profile_id?: string;
        /** The SELLER's state — decides intra- vs inter-state supply under `gst`. */
        home_state_code?: string;
        registration_label?: string;
        registration_number?: string;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<TaxRegion>({
        method: "POST",
        path: `/v1/businesses/${biz}/tax_regions`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    list: (biz: string) =>
      this.request<List<TaxRegion>>({ method: "GET", path: `/v1/businesses/${biz}/tax_regions` }),
    retrieve: (biz: string, txg: string) =>
      this.request<TaxRegion>({ method: "GET", path: `/v1/businesses/${biz}/tax_regions/${txg}` }),
    /** Edit regime, price type, registration, reverse charge and the SEZ/export gates. */
    update: (biz: string, txg: string, body: Record<string, unknown>) =>
      this.request<TaxRegion>({
        method: "PATCH",
        path: `/v1/businesses/${biz}/tax_regions/${txg}`,
        body,
      }),
    archive: (biz: string, txg: string) =>
      this.request<TaxRegion>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/tax_regions/${txg}`,
      }),
    /**
     * Replace one state scope's component vector WHOLESALE — omit `state_code` for the
     * region default. CGST and SGST/UTGST are two halves of one decision, so this is a
     * PUT: a partial write would leave the region taxing at a rate nobody chose.
     */
    setComponents: (
      biz: string,
      txg: string,
      body: {
        state_code?: string | null;
        components: Array<{
          name: string;
          rate_bps: number;
          applies_to?: "intra" | "inter" | "both";
        }>;
      },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<List<TaxRateComponent>>({
        method: "PUT",
        path: `/v1/businesses/${biz}/tax_regions/${txg}/components`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    /** Upsert the seller's registration in one state (India: that state's GSTIN). */
    setStateRegistration: (
      biz: string,
      txg: string,
      body: { state_code: string; state_name?: string; registration_number?: string | null },
      opts?: { idempotencyKey?: string },
    ) =>
      this.request<TaxStateRegistration>({
        method: "PUT",
        path: `/v1/businesses/${biz}/tax_regions/${txg}/state_registrations`,
        body,
        idempotencyKey: opts?.idempotencyKey,
      }),
    deleteStateRegistration: (biz: string, txg: string, txs: string) =>
      this.request<{ object: string; id: string; deleted: boolean }>({
        method: "DELETE",
        path: `/v1/businesses/${biz}/tax_regions/${txg}/state_registrations/${txs}`,
      }),
  };

  webhookEndpoints = {
    create: (body: { url: string }) =>
      this.request<WebhookEndpoint>({ method: "POST", path: "/v1/webhook_endpoints", body }),
    list: () =>
      this.request<List<WebhookEndpoint>>({ method: "GET", path: "/v1/webhook_endpoints" }),
  };
}
