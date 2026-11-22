// Typed fetchers for GET /v1/businesses/:biz/checkout_report and /portal_report. Read-only,
// SERVER-ONLY. Days are business-zone civil days, inclusive; money is integer minor units in
// `currency`; rates are basis points; durations are seconds.
import { apiGet } from "@/lib/api";

export interface DayPoint {
  date: string;
  label: string;
}

export interface CheckoutFigures {
  opened: number;
  completed: number;
  conversion_bps: number | null;
  revenue_minor: number;
  aov_minor: number | null;
  abandoned: number;
  recovered: number;
  recovered_revenue_minor: number;
  median_complete_seconds: number | null;
}

export interface CheckoutReport {
  object: "checkout_report";
  business: string;
  start: string;
  end: string;
  previous_start: string;
  previous_end: string;
  timezone: string;
  currency: string;
  missing_rates: string[];
  filters: {
    payment_link: string | null;
    /** The product filter. The API still names it `plan`. */
    plan: string | null;
    country: string | null;
    device: VisitDevice | null;
  };
  options: {
    payment_links: Array<{ id: string; name: string }>;
    countries: string[];
    devices: VisitDevice[];
  };
  live: { active_now: number; opened_last_30_minutes: number; per_minute: number[] };
  totals: CheckoutFigures;
  previous: CheckoutFigures | null;
  days: DayPoint[];
  series: {
    opened: number[];
    completed: number[];
    conversion_bps: Array<number | null>;
    revenue_minor: number[];
    aov_minor: Array<number | null>;
    abandoned: number[];
    recovered: number[];
    median_complete_seconds: Array<number | null>;
  };
  previous_series: { completed: number[] } | null;
  funnel: Array<{
    step: string;
    label: string;
    sessions: number;
    median_seconds_from_previous: number | null;
  }>;
  links: Array<{
    payment_link: string | null;
    name: string | null;
    opened: number;
    completed: number;
    conversion_bps: number | null;
    revenue_minor: number;
    aov_minor: number | null;
    median_complete_seconds: number | null;
  }>;
  payment_methods: Array<{
    method: string;
    gateway: string | null;
    paid: number;
    revenue_minor: number;
  }>;
  failures: {
    attempts: number;
    failed_attempts: number;
    sessions_with_failure: number;
    paid_after_failure: number;
    reasons: Array<{ reason: string; sessions: number }>;
    other_sessions: number;
  };
  recovery: {
    reminded: number;
    reminders_sent: number;
    recovered: number;
    recovered_revenue_minor: number;
    by_reminder: Array<{ reminder: number; recovered: number }>;
  };
  coupons: {
    sessions_with_coupon: number;
    completed_with_coupon: number;
    conversion_with_coupon_bps: number | null;
    sessions_without_coupon: number;
    completed_without_coupon: number;
    conversion_without_coupon_bps: number | null;
    discount_minor: number;
    codes: Array<{ code: string; sessions: number; completed: number }>;
  };
  countries: Array<{ country: string; completed: number }>;
  time_to_complete: Array<{ band: string; label: string; completed: number }>;
  tracking: CheckoutTracking;
}

/** First-party visit tracking (storefront-analytics). */
export type VisitDevice = "desktop" | "mobile" | "tablet";

export interface TrackedRow {
  /** Country code, device, or browser; null when unknown. */
  key: string | null;
  views: number;
  completed: number;
  conversion_bps: number | null;
  revenue_minor: number;
}

export interface CheckoutTracking {
  /** First tracked view of any window; null before tracking began. */
  since: string | null;
  views: number;
  completed: number;
  channels: Array<
    TrackedRow & { channel: string; source: string; medium: string; campaign: string | null }
  >;
  countries: TrackedRow[];
  devices: TrackedRow[];
  browsers: TrackedRow[];
  step_time: Array<{ step: string; visits: number; median_ms: number }>;
}

export interface PortalTracking {
  since: string | null;
  visits: number;
  sections: Array<{ section: string; visits: number }>;
  countries: Array<{ key: string | null; visits: number }>;
  devices: Array<{ key: string | null; visits: number }>;
  browsers: Array<{ key: string | null; visits: number }>;
  pdf_downloads: number;
  visits_with_pdf: number;
}

export interface PortalFigures {
  visits: number;
  customers: number;
  visits_with_action: number;
  action_rate_bps: number | null;
  paid_minor: number;
  invoices_paid: number;
  recovered_from_failed_emails_minor: number;
  methods_added: number;
  cancellations: number;
  save_rate_bps: number | null;
}

export type PortalActionKey =
  | "paid_invoice"
  | "added_method"
  | "made_primary"
  | "updated_details"
  | "deleted_method"
  | "changed_plan"
  | "paused"
  | "cancelled";

export interface PortalReport {
  object: "portal_report";
  business: string;
  start: string;
  end: string;
  previous_start: string;
  previous_end: string;
  timezone: string;
  currency: string;
  missing_rates: string[];
  filters: {
    arrived_from: string | null;
    plan: string | null;
    country: string | null;
    device: VisitDevice | null;
  };
  options: { arrivals: string[]; countries: string[]; devices: VisitDevice[] };
  live: { active_now: number; visits_last_30_minutes: number; per_minute: number[] };
  totals: PortalFigures;
  previous: PortalFigures | null;
  days: DayPoint[];
  series: {
    visits: number[];
    customers: number[];
    visits_with_action: number[];
    action_rate_bps: Array<number | null>;
    paid_minor: number[];
    recovered_from_failed_emails_minor: number[];
    methods_added: number[];
    cancellations: number[];
  };
  previous_series: { visits: number[]; visits_with_action: number[] } | null;
  funnel: Array<{ step: string; label: string; sessions: number }>;
  arrivals: Array<{
    arrival: string;
    visits: number;
    customers: number;
    visits_with_action: number;
    action_rate_bps: number | null;
    paid_minor: number;
  }>;
  actions: Array<{ action: PortalActionKey; label: string; count: number }>;
  payments: {
    saved_method: number;
    new_method: number;
    methods: Array<{
      method: string;
      paid: number;
      amount_minor: number;
      failed: number;
      success_rate_bps: number | null;
    }>;
  };
  payment_methods: {
    added: number;
    deleted: number;
    made_primary: number;
    delete_reasons: Array<{ reason: string; count: number }>;
  };
  plan_changes: { changed_plan: number; paused: number; cancelled: number };
  retention: {
    hold_days: number;
    started: number;
    saw_offer: number;
    accepted: number;
    saved: number;
    lost: number;
    cancelled: number;
    offers: Array<{ offer: string; accepted: number; saved: number }>;
    reasons: Array<{ reason: string | null; started: number; saved: number }>;
  };
  recent: Array<{
    session: string;
    at: string;
    customer: string;
    customer_name: string | null;
    arrival: string;
    actions: PortalActionKey[];
    paid_minor: number;
  }>;
  tracking: PortalTracking;
}

interface WindowOpts {
  start: string;
  end: string;
  compare: boolean;
  /** Visit-tracking filters. */
  country?: string;
  device?: string;
}

function windowQuery(opts: WindowOpts) {
  const qs = new URLSearchParams({
    start: opts.start,
    end: opts.end,
    compare: String(opts.compare),
  });
  if (opts.country) qs.set("country", opts.country);
  if (opts.device) qs.set("device", opts.device);
  return qs;
}

export function getCheckoutReport(
  biz: string,
  opts: WindowOpts & { paymentLink?: string; product?: string },
) {
  const qs = windowQuery(opts);
  if (opts.paymentLink) qs.set("payment_link", opts.paymentLink);
  if (opts.product) qs.set("product", opts.product);
  return apiGet<CheckoutReport>(`/v1/businesses/${biz}/checkout_report?${qs}`);
}

export function getPortalReport(
  biz: string,
  opts: WindowOpts & { arrivedFrom?: string; plan?: string },
) {
  const qs = windowQuery(opts);
  if (opts.arrivedFrom) qs.set("arrived_from", opts.arrivedFrom);
  if (opts.plan) qs.set("plan", opts.plan);
  return apiGet<PortalReport>(`/v1/businesses/${biz}/portal_report?${qs}`);
}
