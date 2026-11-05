// Typed fetcher for GET /v1/businesses/:biz/cancellation_analytics. Read-only, SERVER-ONLY.
//
// The population is the subscriptions list's own filters (status cancelled, canceled_at in the
// window, plan, interval), so every figure matches the list its drill-down opens. Money is
// integer minor units: per currency, and converted into `currency` at each cancellation day's
// rate.
import { apiGet } from "@/lib/api";

export type CancellationKind = "paying" | "trial_not_converted" | "no_mrr";
export type CancellationCause =
  | "payment_failed"
  | "no_payment_method"
  | "chargeback"
  | "term_ended"
  | "voluntary";

export interface CancellationGroup {
  count: number;
  mrr_lost_minor: number;
  mrr_lost_by_currency: Record<string, number>;
}

export interface CancellationAnalytics {
  object: "business_cancellation_analytics";
  business: string;
  start: string;
  end: string;
  currency: string;
  timezone: string;
  totals: CancellationGroup & { paying: number; involuntary: number; unconverted: number };
  kinds: Array<CancellationGroup & { kind: CancellationKind }>;
  causes: Array<CancellationGroup & { cause: CancellationCause; involuntary: boolean }>;
  reasons: Array<CancellationGroup & { reason: string | null }>;
  tenure: Array<CancellationGroup & { band: string; label: string }>;
  buckets: Array<{
    start: string;
    end: string;
    count: number;
    paying: number;
    mrr_lost_minor: number;
    involuntary_mrr_lost_minor: number;
  }>;
  top_losses: Array<{
    subscription: string;
    customer: string | null;
    customer_name: string | null;
    plan: string | null;
    canceled_at: string;
    currency: string;
    mrr_lost_minor: number;
    converted_mrr_lost_minor: number | null;
    cause: CancellationCause;
    reason: string | null;
  }>;
}

export function getCancellationAnalytics(
  biz: string,
  opts: {
    start: string;
    end: string;
    buckets?: ReadonlyArray<{ start: string; end: string }>;
    plan?: string;
    interval?: string;
  },
) {
  const qs = new URLSearchParams({ start: opts.start, end: opts.end });
  for (const b of opts.buckets ?? []) qs.append("bucket", `${b.start},${b.end}`);
  if (opts.plan) qs.set("plan", opts.plan);
  if (opts.interval) qs.set("interval", opts.interval);
  return apiGet<CancellationAnalytics>(`/v1/businesses/${biz}/cancellation_analytics?${qs}`);
}
