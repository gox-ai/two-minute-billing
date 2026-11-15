/**
 * What a hosted checkout says about recurring money: which coupons end, the regular
 * amount, and the consent sentence. Pure — no database — so the rules are unit-tested.
 */
import { formatMoney } from "@/platform/currency";

/**
 * How long one coupon discounts a subscription, in billing periods.
 * `null` = it never ends. `undefined` = it ends, but we do not know after how many.
 */
export interface CouponSpan {
  code: string;
  periods: number | null | undefined;
}

/** A catalog coupon's span: once = 1, repeating = N, forever = never ends. */
export function couponSpan(
  code: string,
  coupon: { durationType: string; durationInPeriods: number | null } | null | undefined,
): CouponSpan {
  if (!coupon) return { code, periods: undefined };
  if (coupon.durationType === "forever") return { code, periods: null };
  if (coupon.durationType === "once") return { code, periods: 1 };
  const n = coupon.durationInPeriods;
  return { code, periods: n != null && n > 0 ? n : undefined };
}

export interface CouponSplit {
  /** Coupons that never end: they belong in the regular amount. */
  lasting: string[];
  /** Coupons that end: the regular amount is what is left after they have. */
  limited: string[];
  /**
   * Periods for which EVERY coupon applies, so the discounted amount is true for exactly
   * this many periods (the shortest limited span). Null when there is no limited coupon.
   * A span we cannot count only lasts one period for certain.
   */
  introPeriods: number | null;
  /**
   * The number of discounted periods before the regular amount starts (the longest
   * limited span). Null when unknown or when there is no limited coupon.
   */
  regularAfter: number | null;
}

export function splitCouponsByDuration(spans: CouponSpan[]): CouponSplit {
  const lasting = spans.filter((s) => s.periods === null).map((s) => s.code);
  const limitedSpans = spans.filter((s) => s.periods !== null);
  if (limitedSpans.length === 0)
    return { lasting, limited: [], introPeriods: null, regularAfter: null };
  const known = limitedSpans
    .map((s) => s.periods)
    .filter((p): p is number => typeof p === "number");
  const allKnown = known.length === limitedSpans.length;
  return {
    lasting,
    limited: limitedSpans.map((s) => s.code),
    introPeriods: allKnown ? Math.min(...known) : 1,
    regularAfter: allKnown ? Math.max(...known) : null,
  };
}

export interface BillingPeriod {
  interval: string;
  count: number;
}

/** "month", "3 months". */
export function periodLabel(p: BillingPeriod): string {
  return p.count > 1 ? `${p.count} ${p.interval}s` : p.interval;
}

/** "the first month", "each of the first 3 months", "the first 3 months", "each of the first 2 billing periods". */
export function firstPeriodsLabel(n: number, p: BillingPeriod): string {
  if (p.count > 1)
    return n === 1 ? `the first ${periodLabel(p)}` : `each of the first ${n} billing periods`;
  return n === 1 ? `the first ${p.interval}` : `each of the first ${n} ${p.interval}s`;
}

/** "14-day", "1-month". */
export function trialLengthLabel(t: { count: number; unit: string }): string {
  return `${t.count}-${t.unit}`;
}

/**
 * The recurring-charge sentence the buyer agrees to. It states the REGULAR amount — what is
 * charged once every coupon that ends has ended — and adds what differs before that: the
 * free trial and the discounted first periods. No dates: the sentence is compared word for
 * word at completion, so it must not change at midnight.
 */
export function recurringConsentText(
  businessName: string,
  period: BillingPeriod,
  regular: { totalMinor: number; currency: string; excludesUsage: boolean } | null | undefined,
  extra: {
    trial?: { count: number; unit: string } | null;
    intro?: { totalMinor: number; periods: number } | null;
  } = {},
): string {
  const every = periodLabel(period);
  const usage = regular?.excludesUsage ? ", plus usage," : "";
  const base = regular
    ? `I agree that ${businessName} charges me ${formatMoney(regular.totalMinor, regular.currency)}${usage} every ${every} until I cancel.`
    : `I agree that ${businessName} charges me for this subscription every ${every} until I cancel.`;
  const trial = extra.trial
    ? ` The first charge is when my ${trialLengthLabel(extra.trial)} free trial ends.`
    : "";
  const intro =
    regular && extra.intro
      ? ` With my discount, I pay ${formatMoney(extra.intro.totalMinor, regular.currency)} for ${firstPeriodsLabel(extra.intro.periods, period)}.`
      : "";
  return `${base}${trial}${intro}`;
}
