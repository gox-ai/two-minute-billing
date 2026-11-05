import { and, eq } from "drizzle-orm";
import { computeLineAmount, isMeteredPrice } from "@/modules/catalog/pricing";
import type { PriceSnapshot } from "@/modules/catalog/pricing";
import type { Tx } from "@/platform/db";
import {
  computeSubscriptionMrr,
  discountsForMrr,
  netMrrForDiscounts,
  type ActiveDiscountForMrr,
} from "@/modules/subscriptions/service";
import { appliedCoupons, coupons, type prices } from "@db/schema";

type Price = typeof prices.$inferSelect;

const UNITS_PER_YEAR: Record<string, bigint> = { day: 365n, week: 52n, month: 12n, year: 1n };

/**
 * Monthly Recurring Revenue contribution of one subscription item, in integer
 * minor units. Normalizes any recurring interval to a monthly figure:
 *   monthly = periodAmount × unitsPerYear / (intervalCount × 12)   (rounded)
 *
 * Excluded from MRR (return 0):
 *  - one_time prices (not recurring),
 *  - metered prices (usage, or a percentage model over usage — not committed recurring revenue, per
 *    standard SaaS MRR definitions; surfaced separately as usage revenue).
 *
 * Pure + currency-agnostic — callers group by currency. Exported for unit tests.
 */
export function monthlyRecurringMinor(price: Price, quantity: number): bigint {
  if (price.type !== "recurring") return 0n;
  if (isMeteredPrice(price)) return 0n;

  const periodAmount = computeLineAmount(price, quantity);
  if (periodAmount <= 0n) return 0n;

  return monthlyNormalizedMinor(periodAmount, price.interval ?? "month", price.intervalCount ?? 1);
}

/**
 * Normalize a per-period minor-unit amount to a monthly figure:
 *   monthly = amount × unitsPerYear / (intervalCount × 12)   (rounded half up)
 *
 * Shared by `monthlyRecurringMinor` (plan/addon item amounts) and coupon MRR
 * netting (a fixed-amount recurring discount is itself a per-period amount
 * that needs the same monthly normalization before it nets off MRR).
 */
export function monthlyNormalizedMinor(
  amountMinor: bigint,
  interval: string,
  intervalCount: number,
): bigint {
  const unitsPerYear = UNITS_PER_YEAR[interval] ?? 12n;
  const count = BigInt(intervalCount || 1);

  const numerator = amountMinor * unitsPerYear;
  const denom = count * 12n;
  // Round half up: (num + denom/2) / denom.
  return (numerator + denom / 2n) / denom;
}

/** ARR = MRR × 12. */
export function annualFromMonthly(monthlyMinor: bigint): bigint {
  return monthlyMinor * 12n;
}

/**
 * Load the active discounts of a business's subscriptions in the shape the MRR
 * rule consumes, grouped by subscription id.
 *
 * leftJoin, not innerJoin: MANUAL discounts (`source='manual'`) have no coupon
 * row — and an imported subscription-level `discounts[]` entry becomes one. An
 * innerJoin silently drops every one of them, which is the same mistake that once
 * made `recomputeSubscriptionMrr` report gross.
 */
export async function loadActiveDiscounts(
  tx: Tx,
  businessId: string,
): Promise<Map<string, ActiveDiscountForMrr[]>> {
  const rows = await tx
    .select({
      subscriptionId: appliedCoupons.subscriptionId,
      source: appliedCoupons.source,
      remainingPeriods: appliedCoupons.remainingPeriods,
      totalPeriods: appliedCoupons.totalPeriods,
      manualKind: appliedCoupons.manualKind,
      manualPercentOffBps: appliedCoupons.manualPercentOffBps,
      manualAmountOffMinor: appliedCoupons.manualAmountOffMinor,
      manualCurrency: appliedCoupons.manualCurrency,
      couponKind: coupons.kind,
      couponPercentOffBps: coupons.percentOffBps,
      couponAmountOffMinor: coupons.amountOffMinor,
      couponCurrency: coupons.currency,
      couponDurationType: coupons.durationType,
    })
    .from(appliedCoupons)
    .leftJoin(coupons, eq(appliedCoupons.couponId, coupons.id))
    .where(and(eq(appliedCoupons.businessId, businessId), eq(appliedCoupons.status, "active")))
    // The recompute's order, so both net a stack the same way (see netMrrForDiscounts).
    .orderBy(appliedCoupons.createdAt, appliedCoupons.id);

  const out = new Map<string, ActiveDiscountForMrr[]>();
  for (const r of rows) {
    const arr = out.get(r.subscriptionId) ?? [];
    arr.push({
      source: r.source,
      remainingPeriods: r.remainingPeriods,
      totalPeriods: r.totalPeriods,
      manualKind: r.manualKind,
      manualPercentOffBps: r.manualPercentOffBps,
      manualAmountOffMinor: r.manualAmountOffMinor,
      manualCurrency: r.manualCurrency,
      coupon:
        r.couponDurationType != null
          ? {
              kind: r.couponKind!,
              percentOffBps: r.couponPercentOffBps,
              amountOffMinor: r.couponAmountOffMinor,
              currency: r.couponCurrency,
              durationType: r.couponDurationType,
            }
          : null,
    });
    out.set(r.subscriptionId, arr);
  }
  return out;
}

/**
 * The MRR figure the REPORTS should use for each subscription, keyed by id.
 *
 * Almost always this is the cached `subscriptions.mrr` column — the canonical
 * figure in the system, owned end to end by `recomputeSubscriptionMrr` (price
 * snapshots, discount netting, 0 while in trial). Reports must not re-derive it:
 * summing the item rows is GROSS, because the items carry no discounts, and that
 * is how the dashboard came to report a book at 10.2× the real MRR.
 *
 * The ONE exception is a CANCELLED subscription. Its column is deliberately 0
 * (`mrr: 0`, since it bills nothing), but the analytics need the rate it
 * CARRIED WHILE LIVE — for the
 * historical MRR series, where it was live in earlier buckets, and for the
 * cancellation-MRR series, which measures exactly what was lost.
 *
 * That rate is READ, not reconstructed: `subscriptions.last_earning_mrr` (0271) holds the
 * netted figure the subscription last carried while it was earning, stored by
 * `recomputeSubscriptionMrr` at a moment when it was still knowable.
 *
 * WHY IT IS STORED. Re-rating a dead subscription from its surviving items is what this
 * function used to do, and it is wrong in one direction only: the items survive a
 * cancellation, THE DISCOUNTS DO NOT. An `applied_coupons` row is consumed, removed or ends
 * with the subscription, and `loadActiveDiscounts` reads only rows still `active` — so for
 * essentially every churned subscription the discount set is empty and the netting returns
 * GROSS LIST PRICE. Measured on a heavily comped book: 708 subscriptions live in one past
 * month re-rated at $63.4K of list against ~$2.7K they were actually billed, which more
 * than doubled every historical bucket while today's figure (read off the column for live
 * rows) stayed right.
 *
 * The re-rate SURVIVES as the fallback for a row with nothing stored — one cancelled
 * before 0271 and not yet backfilled. It is still gross for a comped row, so it is a floor
 * on the regression, not a second definition: nothing gets worse than it already was.
 *
 * One approximation is unchanged either way: a rate is a single number per subscription,
 * so one whose plan changed before it churned is measured at its final rate rather than at
 * its rate in each past bucket. We keep no composition history to do better.
 */
export function reportingMrrBySubscription(input: {
  subs: Array<{
    id: string;
    status: string;
    mrr: bigint | null;
    /** 0271. The rate it last carried while earning; null = never recorded (pre-0271). */
    lastEarningMrr?: bigint | null;
  }>;
  items: Array<{
    subscriptionId: string;
    price: typeof prices.$inferSelect;
    quantity: number;
    snapshot: unknown;
  }>;
  /** Active discounts per subscription id (empty for subscriptions with none). */
  discounts: Map<string, ActiveDiscountForMrr[]>;
  /** Billing cadence per subscription id — a fixed-amount discount normalizes against it. */
  cadence: Map<string, { interval: string; intervalCount: number }>;
}): Map<string, bigint> {
  const itemsBySub = new Map<string, typeof input.items>();
  for (const it of input.items) {
    const arr = itemsBySub.get(it.subscriptionId) ?? [];
    arr.push(it);
    itemsBySub.set(it.subscriptionId, arr);
  }

  const out = new Map<string, bigint>();
  for (const s of input.subs) {
    if (s.status !== "cancelled") {
      out.set(s.id, s.mrr ?? 0n);
      continue;
    }
    // Stored while it was still knowable — including a stored 0, which is the answer for a
    // comped subscription and the exact case the re-rate below gets wrong.
    if (s.lastEarningMrr != null) {
      out.set(s.id, s.lastEarningMrr);
      continue;
    }
    const own = itemsBySub.get(s.id) ?? [];
    if (own.length === 0) {
      out.set(s.id, s.mrr ?? 0n);
      continue;
    }
    const gross = computeSubscriptionMrr(
      own.map((r) => ({
        price: r.price,
        quantity: r.quantity,
        snapshot: r.snapshot as PriceSnapshot | null,
      })),
    );
    const cad = input.cadence.get(s.id);
    out.set(
      s.id,
      netMrrForDiscounts(
        gross,
        discountsForMrr(input.discounts.get(s.id) ?? []),
        cad?.interval ?? "month",
        cad?.intervalCount ?? 1,
      ),
    );
  }
  return out;
}
