/**
 * Words for a coupon's item scope — shared by the coupon form (client) and the coupon page
 * (server), so it is a plain module, not a "use client" one.
 */
import { intervalLabel } from "@/lib/format";
import type { Price } from "@/lib/api";
import type { BillingPeriod, Product } from "@/lib/api/coupons";

const DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

/** "Monthly" / "Every 3 months". */
export function periodLabel(p: BillingPeriod): string {
  return p.interval_count === 1
    ? intervalLabel(p.interval)
    : `Every ${p.interval_count} ${p.interval}s`;
}

/** ", yearly only" / ", monthly or yearly only" — appended to a scope sentence. */
export function periodSuffix(periods: BillingPeriod[]): string {
  if (!periods.length) return "";
  return `, ${periods.map((p) => periodLabel(p).toLowerCase()).join(" or ")} only`;
}

export const periodOf = (p: Price): BillingPeriod | null =>
  p.type === "one_time" || !p.interval
    ? null
    : { interval: p.interval as BillingPeriod["interval"], interval_count: p.interval_count ?? 1 };

const periodDays = (p: BillingPeriod | null) => (p ? DAYS[p.interval] * p.interval_count : 0);

/** "USD · Yearly" — a price's currency and cadence. */
export function priceCadence(p: Price): string {
  const per = periodOf(p);
  return `${p.currency.toUpperCase()} · ${per ? periodLabel(per) : "One-time"}`;
}

/** "Platform Pro · USD · Yearly", for summaries and chips. */
export function priceLabel(id: string, prices: Price[], products: Product[]): string {
  const pr = prices.find((x) => x.id === id);
  if (!pr) return id;
  return `${products.find((p) => p.id === pr.product)?.name ?? pr.product} · ${priceCadence(pr)}`;
}

export const byCadence = (a: Price, b: Price) =>
  a.currency.localeCompare(b.currency) || periodDays(periodOf(a)) - periodDays(periodOf(b));
