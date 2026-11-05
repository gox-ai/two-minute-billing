// Usage controls (design G5 § 5): spend limits, limit tiers, alerts, runway, automatic top-up,
// threshold invoicing, the rate-change preview and the usage widget. Server-only.
import { apiGet, apiGetOrNull, apiWrite } from "@/lib/api";
import type {
  AlertKind,
  AlertThreshold,
  AutoTopupMethod,
  AutoTopupSchedule,
  AutoTopupTrigger,
  LimitInterval,
} from "@/lib/usage-controls";

interface List<T> {
  object: "list";
  data: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

const b = (biz: string) => `/v1/businesses/${biz}`;
const c = (biz: string, cus: string) => `${b(biz)}/customers/${encodeURIComponent(cus)}`;
const enc = encodeURIComponent;

// ── Spend limits ───────────────────────────────────────────────────────────────

export interface SpendLimit {
  object: "spend_limit";
  /** `slim_…` */
  id: string;
  customer: string;
  scope: "customer" | "subscription" | "property";
  subscription: string | null;
  property_key: string | null;
  /** null = each value gets the amount. */
  property_value: string | null;
  /** null = all meters. */
  meters: string[] | null;
  interval: LimitInterval;
  amount_minor: number;
  currency: string;
  mode: "hard" | "soft";
  set_by: "operator" | "customer";
  active: boolean;
  /** The amount that applies: a customer limit you set, raised by a reached limit tier. */
  effective_amount_minor: number;
  /** Spend in the current interval. Null for an each-value property limit. */
  spent_minor: number | null;
  /** Spend is at or above the effective amount. Null when spend is null. */
  reached: boolean | null;
  resets_at: string | null;
  created_at: string;
}

export interface SpendLimitWrite {
  scope?: SpendLimit["scope"];
  subscription?: string;
  property_key?: string;
  property_value?: string | null;
  meters?: string[] | null;
  interval?: LimitInterval;
  amount_minor?: number;
  currency?: string;
  mode?: SpendLimit["mode"];
}

export const listSpendLimits = (biz: string, cus: string) =>
  apiGet<List<SpendLimit>>(`${c(biz, cus)}/spend_limits`);
export const createSpendLimit = (biz: string, cus: string, body: SpendLimitWrite) =>
  apiWrite(`${c(biz, cus)}/spend_limits`, body, "POST");
export const updateSpendLimit = (biz: string, cus: string, id: string, body: SpendLimitWrite) =>
  apiWrite(`${c(biz, cus)}/spend_limits/${enc(id)}`, body, "PATCH");
export const deleteSpendLimit = (biz: string, cus: string, id: string) =>
  apiWrite(`${c(biz, cus)}/spend_limits/${enc(id)}`, {}, "DELETE");

// ── Limit tiers ────────────────────────────────────────────────────────────────

export interface SpendLimitTier {
  object: "spend_limit_tier";
  /** `sltr_…` */
  id: string;
  currency: string;
  level_minor: number;
  amounts: Partial<Record<LimitInterval, number>>;
  active: boolean;
  created_at: string;
}

export const listSpendLimitTiers = (biz: string) =>
  apiGet<List<SpendLimitTier>>(`${b(biz)}/spend_limit_tiers`);
export const createSpendLimitTier = (
  biz: string,
  body: { currency: string; level_minor: number; amounts: SpendLimitTier["amounts"] },
) => apiWrite(`${b(biz)}/spend_limit_tiers`, body, "POST");
export const deleteSpendLimitTier = (biz: string, id: string) =>
  apiWrite(`${b(biz)}/spend_limit_tiers/${enc(id)}`, {}, "DELETE");

// ── Alerts ─────────────────────────────────────────────────────────────────────

export interface AlertThresholdState {
  value: number;
  unit: AlertThreshold["unit"];
  state: "armed" | "triggered" | "resolved";
  /** Minor units or days as a number; a quantity as a decimal string. */
  last_value: number | string | null;
  triggered_at: string | null;
  resolved_at: string | null;
  resolve_reason: string | null;
  period_key: string | null;
  resets_at: string | null;
}

export interface UsageAlert {
  object: "usage_alert";
  /** `ualt_…` */
  id: string;
  kind: AlertKind;
  scope: "customer" | "plan";
  customer: string | null;
  product: string | null;
  meter: string | null;
  interval: LimitInterval | null;
  currency: string | null;
  unit: string | null;
  thresholds: AlertThreshold[];
  email: boolean;
  active: boolean;
  created_at: string;
}

/** One subject of an alert (the customer, or one of its subscriptions to the plan). */
export interface AlertStateSubject {
  subject: "customer" | "subscription";
  subscription: string | null;
  period_key: string | null;
  resets_at: string | null;
  thresholds: AlertThresholdState[];
}

export interface UsageAlertWrite {
  kind: AlertKind;
  /** One of `customer` (a customer alert) or `product` (a plan alert). */
  customer?: string;
  product?: string;
  meter?: string;
  interval?: LimitInterval;
  currency?: string;
  thresholds: AlertThreshold[];
  email: boolean;
}

export const listUsageAlerts = (biz: string, filter: { customer?: string; product?: string }) => {
  const q = new URLSearchParams({ limit: "100" });
  if (filter.customer) q.set("customer", filter.customer);
  if (filter.product) q.set("product", filter.product);
  return apiGet<List<UsageAlert>>(`${b(biz)}/usage_alerts?${q}`);
};
export const listUsageAlertStates = (biz: string, alert: string, customer: string) =>
  apiGet<List<AlertStateSubject>>(
    `${b(biz)}/usage_alerts/${enc(alert)}/states?customer=${enc(customer)}`,
  );
export const createUsageAlert = (biz: string, body: UsageAlertWrite) =>
  apiWrite(`${b(biz)}/usage_alerts`, body, "POST");
export const deleteUsageAlert = (biz: string, id: string) =>
  apiWrite(`${b(biz)}/usage_alerts/${enc(id)}`, {}, "DELETE");

// ── Runway ─────────────────────────────────────────────────────────────────────

export interface CreditRunway {
  object: "credit_runway";
  currency: string;
  balance_minor: number;
  burn_minor_per_day: number | null;
  /** null = not enough usage to estimate. */
  runway_days: number | null;
  runs_out_at: string | null;
  /** What an active automatic top-up can still add this month (counted in the runway). */
  auto_topup_minor: number;
}

export const getCreditRunway = (biz: string, cus: string, currency?: string) =>
  apiGetOrNull<CreditRunway>(
    `${c(biz, cus)}/credit_runway${currency ? `?currency=${enc(currency)}` : ""}`,
  );

// ── Automatic top-up ───────────────────────────────────────────────────────────

export interface AutoTopup {
  object: "auto_topup";
  /** `atu_…` */
  id: string;
  customer: string;
  currency: string;
  unit: string | null;
  trigger: AutoTopupTrigger;
  threshold_minor: number | null;
  schedule: AutoTopupSchedule | null;
  method: AutoTopupMethod;
  amount_minor: number | null;
  target_minor: number | null;
  monthly_cap_minor: number;
  max_runs_per_day: number;
  /** null = the customer's charge order. */
  payment_method: string | null;
  grant: { priority?: number; expires_after_months?: number | null; tax_treatment?: string };
  status: "active" | "disabled";
  disabled_reason: string | null;
  disabled_at: string | null;
  /** The last "threshold too low" notice (weekly check); null = none. */
  threshold_low_at: string | null;
  /** The notice lead on the payment method (read and save responses). */
  lead_time?: {
    lead_hours: number;
    burn_minor_per_day: number | null;
    required_threshold_minor: number | null;
    warning: string | null;
  };
}

export interface AutoTopupWrite {
  currency: string;
  trigger: AutoTopupTrigger;
  threshold_minor?: number;
  schedule?: AutoTopupSchedule;
  method: AutoTopupMethod;
  amount_minor?: number;
  target_minor?: number;
  monthly_cap_minor: number;
  max_runs_per_day: number;
  payment_method?: string | null;
  grant: { priority?: number; expires_after_months?: number | null; tax_treatment: string };
}

export interface AutoTopupRun {
  object: "auto_topup_run";
  /** `atur_…` */
  id: string;
  trigger: AutoTopupTrigger;
  amount_minor: number;
  currency: string;
  status: "created" | "notice_sent" | "charging" | "pending" | "succeeded" | "failed" | "cancelled";
  invoice: string | null;
  charge_after: string | null;
  decline_code: string | null;
  failure_message: string | null;
  created_at: string;
}

export const getAutoTopup = (biz: string, cus: string, currency: string) =>
  apiGetOrNull<AutoTopup>(`${c(biz, cus)}/auto_topup?currency=${enc(currency)}`);
export const saveAutoTopup = (biz: string, cus: string, body: AutoTopupWrite) =>
  apiWrite(`${c(biz, cus)}/auto_topup`, body, "PUT");
export const setAutoTopupEnabled = (biz: string, cus: string, currency: string, on: boolean) =>
  apiWrite(
    `${c(biz, cus)}/auto_topup/${on ? "enable" : "disable"}?currency=${enc(currency)}`,
    {},
    "POST",
  );
export const listAutoTopupRuns = (biz: string, cus: string) =>
  apiGet<List<AutoTopupRun>>(`${c(biz, cus)}/auto_topup/runs?limit=20`);

// ── Threshold invoicing ────────────────────────────────────────────────────────

export interface UsageInvoiceThreshold {
  object: "usage_invoice_threshold";
  scope: "plan" | "subscription";
  product: string | null;
  subscription: string | null;
  currency: string;
  /** null on a subscription row that turns invoicing early off. */
  amount_minor: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export const listUsageInvoiceThresholds = (
  biz: string,
  filter: { product?: string; subscription?: string },
) => {
  const q = new URLSearchParams();
  if (filter.product) q.set("product", filter.product);
  if (filter.subscription) q.set("subscription", filter.subscription);
  return apiGet<List<UsageInvoiceThreshold>>(`${b(biz)}/usage_invoice_thresholds?${q}`);
};
export const putPlanUsageThreshold = (
  biz: string,
  product: string,
  currency: string,
  amountMinor: number,
) =>
  apiWrite(
    `${b(biz)}/products/${enc(product)}/usage_invoice_thresholds/${enc(currency)}`,
    { amount_minor: amountMinor },
    "PUT",
  );
export const deletePlanUsageThreshold = (biz: string, product: string, currency: string) =>
  apiWrite(
    `${b(biz)}/products/${enc(product)}/usage_invoice_thresholds/${enc(currency)}`,
    {},
    "DELETE",
  );
/** `amountMinor` null = no early invoices for this subscription. */
export const putSubscriptionUsageThreshold = (
  biz: string,
  sub: string,
  amountMinor: number | null,
) =>
  apiWrite(
    `${b(biz)}/subscriptions/${enc(sub)}/usage_invoice_threshold`,
    { amount_minor: amountMinor },
    "PUT",
  );
/** Remove the override: the subscription follows its plan again. */
export const deleteSubscriptionUsageThreshold = (biz: string, sub: string) =>
  apiWrite(`${b(biz)}/subscriptions/${enc(sub)}/usage_invoice_threshold`, {}, "DELETE");

// ── Rate-change preview ────────────────────────────────────────────────────────

export interface RateChangePreview {
  object: "rate_change_preview";
  price: string;
  currency: string;
  totals: {
    customers: number;
    old_minor: number;
    new_minor: number;
    diff_minor: number;
    diff_bps: number | null;
  };
  customers_without_usage: number;
  truncated: boolean;
  data: Array<{
    customer: string;
    customer_name: string | null;
    subscriptions: string[];
    period_start: string | null;
    period_end: string | null;
    old_minor: number;
    new_minor: number;
    diff_minor: number;
    diff_bps: number | null;
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

export const previewRateChange = (biz: string, price: string, body: Record<string, unknown>) =>
  apiWrite(`${b(biz)}/prices/${enc(price)}/rate_change_preview`, body, "POST");

// ── Usage widget ───────────────────────────────────────────────────────────────

export interface UsageWidgetSettings {
  object: "usage_widget_settings";
  origins: string[];
  script_url: string | null;
  script_integrity: string;
}

export const getUsageWidgetSettings = (biz: string) =>
  apiGet<UsageWidgetSettings>(`${b(biz)}/settings/usage_widget`);
export const saveUsageWidgetOrigins = (biz: string, origins: string[]) =>
  apiWrite(`${b(biz)}/settings/usage_widget`, { origins }, "PUT");
