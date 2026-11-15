// Credit unit overdraft overrides and the credit reports. Server-only (imports the API client).
// Pure helpers and shared types are in `lib/credit-settings.ts`.
import { apiGet, apiGetOrNull, apiWrite } from "@/lib/api";
import type { OverdraftSource, RollForwardRow } from "@/lib/credit-settings";

const b = (biz: string) => `/v1/businesses/${encodeURIComponent(biz)}`;
const c = (biz: string, cus: string) => `${b(biz)}/customers/${encodeURIComponent(cus)}`;

export interface CreditOverdraftLimit {
  object: "credit_overdraft_limit";
  unit: string;
  level: "unit" | "plan" | "customer";
  product: string | null;
  product_name: string | null;
  customer: string | null;
  customer_name: string | null;
  overdraft_limit: number;
  overdraft_limit_decimal: string;
}

export interface CustomerCreditOverdraftLimit {
  object: "customer_credit_overdraft_limit";
  unit: string;
  unit_name: string;
  decimals: number;
  overdraft_limit: number;
  overdraft_limit_decimal: string;
  source: OverdraftSource;
  customer_override: number | null;
}

/** Every plan override of a unit (bounded by the number of plans). */
export async function listPlanOverdraftLimits(biz: string, unit: string) {
  const out: CreditOverdraftLimit[] = [];
  let after: string | null = null;
  do {
    const q = new URLSearchParams({ level: "plan", limit: "1000" });
    if (after) q.set("starting_after", after);
    const page: { data: CreditOverdraftLimit[]; has_more: boolean; next_cursor: string | null } =
      await apiGet(`${b(biz)}/credit_units/${encodeURIComponent(unit)}/overdraft_limits?${q}`);
    out.push(...page.data);
    after = page.has_more ? page.next_cursor : null;
  } while (after);
  return out;
}

export const setPlanOverdraftLimit = (biz: string, unit: string, product: string, steps: number) =>
  apiWrite(
    `${b(biz)}/credit_units/${encodeURIComponent(unit)}/overdraft_limits/plans/${encodeURIComponent(product)}`,
    { overdraft_limit: steps },
    "PUT",
  );
export const removePlanOverdraftLimit = (biz: string, unit: string, product: string) =>
  apiWrite(
    `${b(biz)}/credit_units/${encodeURIComponent(unit)}/overdraft_limits/plans/${encodeURIComponent(product)}`,
    {},
    "DELETE",
  );

export const listCustomerOverdraftLimits = (biz: string, cus: string) =>
  apiGet<{ object: "list"; data: CustomerCreditOverdraftLimit[] }>(
    `${c(biz, cus)}/credit_overdraft_limits`,
  );
export const setCustomerOverdraftLimit = (biz: string, cus: string, unit: string, steps: number) =>
  apiWrite(
    `${c(biz, cus)}/credit_overdraft_limits/${encodeURIComponent(unit)}`,
    { overdraft_limit: steps },
    "PUT",
  );
export const removeCustomerOverdraftLimit = (biz: string, cus: string, unit: string) =>
  apiWrite(`${c(biz, cus)}/credit_overdraft_limits/${encodeURIComponent(unit)}`, {}, "DELETE");

export interface CreditRunwayUnits {
  object: "credit_runway";
  unit: string;
  runway_days: number | null;
  runs_out_at: string | null;
  balance_units_decimal: string;
  burn_units_per_day_decimal: string | null;
  units_last_7_days_decimal: string;
  message: string;
}
export const getUnitRunway = (biz: string, cus: string, unit: string) =>
  apiGetOrNull<CreditRunwayUnits>(`${c(biz, cus)}/credit_runway?unit=${encodeURIComponent(unit)}`);

export interface CreditDeferredRevenue {
  object: "credit_deferred_revenue";
  time_zone: string;
  from: string;
  to: string;
  data: RollForwardRow[];
  ledger_closing: Array<{ currency: string; credit_grants_paid_minor: number }>;
}
export const getDeferredRevenue = (
  biz: string,
  p: { from?: string; to?: string; currency?: string; unit?: string },
) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  const s = q.toString();
  return apiGet<CreditDeferredRevenue>(
    `${b(biz)}/reports/credit_deferred_revenue${s ? `?${s}` : ""}`,
  );
};

export interface RefusedDemandRow {
  day?: string;
  customer?: string;
  customer_name?: string | null;
  meter: string;
  meter_name: string;
  unit: string;
  refused_events: number;
  customers: number;
  refused_quantity: string;
  refused_units_decimal: string;
}
export const getRefusedDemand = (
  biz: string,
  p: { from: string; to: string; group_by: "meter" | "day" | "customer" },
) =>
  apiGet<{ object: "credit_refused_demand"; data: RefusedDemandRow[]; has_more: boolean }>(
    `${b(biz)}/reports/credit_refused_demand?${new URLSearchParams({ ...p, limit: "500" })}`,
  );

export interface GrantActivityLine {
  id: string;
  kind: string;
  created_at: string;
  units: number;
  units_decimal: string;
  cost_minor: number;
  invoice: string | null;
  invoice_number: string | null;
  settlement: string | null;
  meter: string | null;
  meter_name: string | null;
}
export interface CreditGrantActivity {
  object: "credit_grant_activity";
  grant: string;
  customer: string;
  unit: string | null;
  currency: string;
  category: "paid" | "promotional";
  status: string;
  purchased_units: number;
  purchased_units_decimal: string;
  cost_basis_minor: number;
  used_units: number;
  used_units_decimal: string;
  revenue_recognised_minor: number;
  expired_units: number;
  expired_units_decimal: string;
  breakage_minor: number;
  voided_units: number;
  voided_units_decimal: string;
  refunded_minor: number;
  credited_minor: number;
  remaining_units: number;
  remaining_units_decimal: string;
  remaining_cost_minor: number;
  data: GrantActivityLine[];
  has_more: boolean;
  next_cursor: string | null;
}
export const getGrantActivity = (biz: string, cus: string, grant: string, after?: string) =>
  apiGetOrNull<CreditGrantActivity>(
    `${c(biz, cus)}/credit_grants/${encodeURIComponent(grant)}/activity?limit=200${
      after ? `&starting_after=${encodeURIComponent(after)}` : ""
    }`,
  );
