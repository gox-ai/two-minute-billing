// Model prices, your cost, usage history and usage margin. Server-only (imports the API client).
// Shapes follow design G1b § 5.1. Decimals cross the API as strings; `unit_amount_decimal` is in
// minor units per `quantity_divisor` units (the rate-card encoding).
import { apiGet, apiGetOrNull, apiWrite, type PagedList } from "@/lib/api";
import {
  UNLISTED_COSTS_PAGE,
  type UnlistedCostFilters,
  type UnlistedCostPage,
} from "@/lib/model-prices";

/** One dated list row (`mpr_…`). Platform-wide; prices are USD. */
export interface ModelPrice {
  object: "model_price";
  id: string;
  provider: string;
  model: string;
  /** Display name from the source, when it has one. */
  model_name?: string | null;
  token_type: string;
  /** The same value as `token_type`. */
  price_kind?: string;
  /** token | request | image | audio_second | … */
  unit?: string;
  /** Price tier; null = none. */
  quality?: string | null;
  resolution?: string | null;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: number | string;
  /** Our applied-from instant. Null when the row is the model's first price ("-infinity"). */
  effective_from: string | null;
  /** The source's own date (YYYY-MM-DD). */
  source_effective_from: string | null;
  source: string;
  source_version: string | null;
  rounded?: boolean;
  /** When the model was last in the source feed. */
  last_seen_at?: string | null;
}

/** "Your cost" (`mco_…`): a price the organization negotiated. */
export interface ModelCostOverride {
  object: "model_cost_override";
  id: string;
  provider: string | null;
  model: string;
  token_type: string;
  price_kind?: string;
  unit?: string;
  quality?: string | null;
  resolution?: string | null;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: number | string;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at?: string;
}

/** A row of the price list screen: the list price now and your cost now. */
export interface ModelPriceListRow extends ModelPrice {
  /** Your cost live now (or at `as_of`), else null. */
  cost: ModelCostOverride | null;
  /** The model is in a business's usage of the last 35 days. */
  used?: boolean;
}

export interface ModelPriceHistory {
  object: "model_price_history";
  provider: string | null;
  model: string;
  prices: ModelPrice[];
  costs: ModelCostOverride[];
}

export interface ModelPriceSource {
  object: "model_price_source";
  url: string;
  licence: string;
  checked_at: string | null;
  last_success_at: string | null;
  check_error: string | null;
  upstream_version: string | null;
  /** A batch is held for staff review; bills use the last prices. */
  held: boolean;
  /** The next scheduled check, when known. */
  next_check_at?: string | null;
  /** Providers in the list, for the filter. Absent → no provider filter. */
  providers?: string[];
  /** Every feed with its own state; the top-level fields are the first. */
  sources?: ModelPriceFeed[];
}

/** One feed of the price list. */
export interface ModelPriceFeed {
  source: string;
  url: string;
  licence: string;
  /** `all`, or `media` only (images, video, audio, characters). */
  prices: "all" | "media";
  checked_at: string | null;
  last_success_at: string | null;
  check_error: string | null;
  upstream_version: string | null;
}

const ORG = "/v1/organization";

export interface ModelPriceFilters {
  provider?: string;
  q?: string;
  token_type?: string;
  unit?: string;
  model?: string;
  has_cost?: boolean;
  used?: boolean;
  /** A business id (biz_…): only the models it used in the last 35 days. */
  business?: string;
  limit?: number;
  starting_after?: string;
}

export function listModelPrices(f: ModelPriceFilters = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === "" || v === false) continue;
    q.set(k, String(v));
  }
  const qs = q.toString();
  return apiGet<PagedList<ModelPriceListRow>>(`${ORG}/model_prices${qs ? `?${qs}` : ""}`);
}

/** One model's reported cost against the list price of the same tokens (last 7 days, USD). */
export interface ModelPriceDrift {
  object: "model_price_drift";
  provider: string;
  model: string;
  reported_cost_minor: number;
  list_cost_minor: number;
  /** (reported ÷ list − 1) × 100. Positive: the calls cost more than the list. */
  difference_percent: number;
}

export const getModelPriceDrift = (business?: string) =>
  apiGet<{ object: "list"; data: ModelPriceDrift[] }>(
    `${ORG}/model_prices/drift${business ? `?business=${encodeURIComponent(business)}` : ""}`,
  );

export const getModelPrice = (id: string) =>
  apiGetOrNull<ModelPrice>(`${ORG}/model_prices/${encodeURIComponent(id)}`);

export function getModelPriceHistory(key: {
  provider?: string | null;
  model: string;
  token_type?: string;
  unit?: string | null;
}) {
  const q = new URLSearchParams({ model: key.model });
  if (key.provider) q.set("provider", key.provider);
  if (key.token_type) q.set("token_type", key.token_type);
  if (key.unit) q.set("unit", key.unit);
  return apiGet<ModelPriceHistory>(`${ORG}/model_prices/history?${q}`);
}

/**
 * Your cost rows whose key has no row on the price list (a model the list does not have, or a
 * quality or resolution it does not price), newest first. The list read cannot show them.
 * Ended rows are left out: they stay in the key's history. One page per read, narrowed by the
 * price list's search and its provider and unit filters.
 */
export async function listUnlistedCosts(
  f: UnlistedCostFilters & { starting_after?: string | null } = {},
): Promise<UnlistedCostPage<ModelCostOverride>> {
  const now = Date.now();
  let cursor = f.starting_after ?? null;
  // A page of ended rows only shows nothing: read on, a few pages at most.
  for (let i = 0; ; i++) {
    const q = new URLSearchParams({ listed: "false", limit: String(UNLISTED_COSTS_PAGE) });
    if (f.q) q.set("q", f.q);
    if (f.provider) q.set("provider", f.provider);
    if (f.unit) q.set("unit", f.unit);
    if (cursor) q.set("starting_after", cursor);
    const page = await apiGet<PagedList<ModelCostOverride>>(`${ORG}/model_cost_overrides?${q}`);
    const rows = page.data.filter((c) => !c.effective_to || Date.parse(c.effective_to) > now);
    cursor = page.has_more ? (page.next_cursor ?? page.data.at(-1)?.id ?? null) : null;
    if (rows.length || !cursor || i >= 4) return { rows, nextCursor: cursor };
  }
}

export const getModelPriceSource = () =>
  apiGetOrNull<ModelPriceSource>(`${ORG}/model_prices/source`);

export interface CostOverrideWrite {
  provider?: string | null;
  model: string;
  token_type: string;
  unit?: string;
  quality?: string | null;
  resolution?: string | null;
  currency: string;
  unit_amount_decimal: string;
  quantity_divisor: string;
  /** Omit to start now. */
  effective_from?: string;
  note?: string;
}

export const createCostOverride = (body: CostOverrideWrite) =>
  apiWrite(`${ORG}/model_cost_overrides`, body, "POST");

/** `effective_to` omitted = now. */
export const endCostOverride = (id: string, effectiveTo?: string) =>
  apiWrite(
    `${ORG}/model_cost_overrides/${encodeURIComponent(id)}/end`,
    effectiveTo ? { effective_to: effectiveTo } : {},
    "POST",
  );

/** Only a row that has not started yet. */
export const deleteCostOverride = (id: string) =>
  apiWrite(`${ORG}/model_cost_overrides/${encodeURIComponent(id)}`, {}, "DELETE");

// ── Usage history and margin (business scope) ─────────────────────────────────────────────

/** One day × meter × group row of `GET …/customers/:cus/usage`. */
export interface UsageDayRow {
  /** Local date in the business time zone, YYYY-MM-DD. */
  date: string;
  meter: string;
  group: Record<string, string>;
  quantity: string;
  /** Only with `include=cost` (`usage_margin:view`), in the history's `currency`. */
  cost_minor?: number | null;
  cost_basis?: string | null;
}

export interface CustomerUsageHistory {
  object: "usage_history";
  customer: string;
  time_zone: string;
  from: string;
  to: string;
  interval: "day";
  /** The cost currency, with `include=cost`. */
  currency?: string;
  data: UsageDayRow[];
}

/** `from` / `to` are instants: [from, to), at most 92 days. */
export function getCustomerUsageHistory(
  biz: string,
  cus: string,
  p: { from: string; to: string; meter?: string; includeCost?: boolean; currency?: string },
) {
  const q = new URLSearchParams({ from: p.from, to: p.to, interval: "day" });
  if (p.meter) q.set("meter", p.meter);
  if (p.includeCost) q.set("include", "cost");
  if (p.includeCost && p.currency) q.set("currency", p.currency);
  return apiGet<CustomerUsageHistory>(`/v1/businesses/${biz}/customers/${cus}/usage?${q}`);
}

export type MarginGroupBy = "customer" | "model" | "meter" | "plan";
export type MarginScope = "billed" | "all";

export interface UsageMarginFigures {
  currency: string;
  revenue_minor: number;
  cost_minor: number;
  margin_minor: number;
  /** Decimal string, null when revenue is 0. */
  margin_percent: string | null;
  lines: number;
  lines_without_cost: number;
  /** `scope=all` only: by customer and plan every revenue line; by meter and model every usage line. */
  total_revenue_minor?: number;
  /** `scope=all` only: cost of usage no invoice line bills. */
  cost_only_minor?: number;
  cost_only_rows?: number;
  cost_only_rows_without_cost?: number;
  total_cost_minor?: number;
  total_margin_minor?: number;
  total_margin_percent?: string | null;
  /** `scope=all`, `group_by=plan`. */
  plan_fee_minor?: number;
  subscribers?: number;
}

/** A row carries its key under the group's name: `{ customer: "cus_…" }`, `{ model }`, `{ meter }`, `{ plan }`. */
export type UsageMarginRow = UsageMarginFigures &
  Partial<Record<MarginGroupBy, string>> & {
    /** `group_by=customer`: the name, else the email. */
    customer_name?: string | null;
    /** `group_by=plan`: the plan product's name; null on the no-plan row. */
    plan_name?: string | null;
    /** `group_by=meter`: the meter's name. */
    meter_name?: string | null;
  };

export interface UsageMarginReport {
  object: "usage_margin";
  group_by: MarginGroupBy;
  scope: MarginScope;
  from: string;
  to: string;
  data: UsageMarginRow[];
  /** One per currency. */
  totals: UsageMarginFigures[];
}

/** `from` / `to` are instants: [from, to), at most 366 days. */
export function getUsageMargin(
  biz: string,
  p: {
    from: string;
    to: string;
    currency?: string;
    group_by: MarginGroupBy;
    customer?: string;
    scope?: MarginScope;
  },
) {
  const q = new URLSearchParams({ from: p.from, to: p.to, group_by: p.group_by });
  if (p.currency) q.set("currency", p.currency);
  if (p.customer) q.set("customer", p.customer);
  if (p.scope) q.set("scope", p.scope);
  return apiGet<UsageMarginReport>(`/v1/businesses/${biz}/reports/usage_margin?${q}`);
}
