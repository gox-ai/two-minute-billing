// Usage so far in the window the next invoice bills (`GET …/current_usage`). Read-only.
// Amounts are before discounts and credits; the exact next invoice is the renewal estimate.

import { apiGet, apiGetOrNull, type LineRatingSegment } from "@/lib/api";

/**
 * One combination of group values on a meter item (design G1b § 3.8): quantity so far, the
 * amount rated per price segment, and the projection, marked as an estimate.
 */
export interface CurrentUsageCombination {
  group: Record<string, string>;
  /** Decimal string. */
  quantity: string;
  amount_minor: number;
  /** model_price_list | reported_cost | default_rate | rate. */
  price_source?: string | null;
  projected_quantity?: string | null;
  projected_amount_minor?: number | null;
  estimate?: boolean;
  /** The price segments (not on the portal). */
  segments?: LineRatingSegment[];
  /** Cost so far, only for `usage_margin:view`. Never on the portal. */
  cost_minor?: number | null;
  cost_basis?: string | null;
  method?: "linear" | "held_level" | null;
}

export interface CurrentUsageItem {
  /** Absent on the portal. */
  item?: string;
  price?: string;
  name: string;
  model: string;
  aggregation: string;
  quantity: number;
  free_quantity: number;
  billable_quantity: number;
  amount_minor: number;
  unit_amount_minor: number;
  minimum_amount_minor?: number | null;
  projected_quantity: number | null;
  projected_amount_minor: number | null;
  projected_minimum_true_up_minor: number | null;
  method: "linear" | "held_level" | null;
  /** Meter items: one row per combination of group values. */
  combinations?: CurrentUsageCombination[];
  /** Meter items: model values with no resolved price; they bill the default rate. */
  unpriced_models?: string[];
  /** The same as list keys where the meter names a token type: what a cost row would set. */
  unpriced_keys?: Array<{
    provider: string | null;
    model: string;
    token_type: string;
    /** Null: the meter names no unit (tokens, else requests). */
    unit?: string | null;
    quality?: string | null;
    resolution?: string | null;
  }>;
  /** Projected amounts are estimates. */
  estimate?: boolean;
}

export interface CurrentUsageTotals {
  subtotal_minor: number;
  tax_minor: number;
  tax_lines: Array<{ label: string; amount_minor: number }>;
  total_minor: number;
}

/**
 * One credit-cost meter: what credits paid, what the next invoice bills in money (in the
 * totals) and the units below zero that nothing billed. Quantities and units are decimal text.
 */
export interface CurrentCreditUsage {
  meter: string;
  name: string;
  unit: string;
  unit_name: string;
  unit_plural_name: string;
  paid_quantity: string;
  paid_units: string;
  billed: Array<{
    basis: "meter" | "unit";
    /** Absent on the portal. */
    price?: string | null;
    quantity: string;
    units: string;
    amount_minor: number;
  }>;
  billed_amount_minor: number;
  overshoot_units: string;
  below_zero_quantity?: string;
}

/** "120 credits", "1 credit": a unit amount with the unit's own name. */
export const creditAmount = (
  units: string,
  m: Pick<CurrentCreditUsage, "unit_name" | "unit_plural_name">,
) =>
  `${Number(units).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${
    units === "1" ? m.unit_name : m.unit_plural_name
  }`;

export interface CurrentUsage extends CurrentUsageTotals {
  object: "current_usage";
  subscription?: string;
  currency: string;
  as_of: string;
  window: {
    start: string;
    /** Exclusive. */
    end: string;
    billed_by: "renewal" | "pending_invoice" | "term_end_invoice";
    invoice?: string | null;
  } | null;
  items: CurrentUsageItem[];
  settled_charges: Array<{
    id?: string;
    name: string;
    description: string;
    quantity: number;
    amount_minor: number;
    period_start: string | null;
    period_end: string | null;
  }>;
  projection: (CurrentUsageTotals & { minimum_true_up_minor: number }) | null;
  /** Only with a credit-cost meter, on the customer's oldest live subscription. */
  credit_usage?: CurrentCreditUsage[];
  discounts_applied: false;
  trial: {
    start: string;
    end: string;
    items: Array<{ name: string; quantity: number }>;
  } | null;
}

export interface CustomerCurrentUsage {
  object: "list";
  customer: string;
  data: CurrentUsage[];
  has_more: boolean;
  totals: Array<{
    currency: string;
    subtotal_minor: number;
    tax_minor: number;
    total_minor: number;
    projected_total_minor: number | null;
  }>;
}

/** True when the view has anything to show: metered items, settled or credit usage, trial units. */
export const hasUsage = (u: CurrentUsage | null | undefined): u is CurrentUsage =>
  !!u &&
  (u.items.length > 0 ||
    u.settled_charges.length > 0 ||
    (u.credit_usage?.length ?? 0) > 0 ||
    (u.trial?.items.length ?? 0) > 0);

export function getCurrentUsage(biz: string, sub: string) {
  return apiGetOrNull<CurrentUsage>(
    `/v1/businesses/${biz}/subscriptions/${sub}/current_usage?include_projection=true`,
  );
}

/** Cost fields come only when the caller holds `usage_margin:view`. */
export function getCustomerCurrentUsage(biz: string, cus: string) {
  return apiGet<CustomerCurrentUsage>(
    `/v1/businesses/${biz}/customers/${cus}/current_usage?include_projection=true`,
  );
}
