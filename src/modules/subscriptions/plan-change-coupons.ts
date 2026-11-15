/**
 * Coupons on a plan change (`billing_rules_config.plan_change_coupons`).
 *
 * `changeSubscription` removes the codes this returns before it bills, and
 * `estimateChange` prices the change without them, so the preview and the booking drop
 * the same coupons. Manual discounts are never dropped: an operator set them on purpose.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  appliedCoupons,
  businesses,
  couponItemConstraints,
  coupons,
  prices,
  products,
} from "@db/schema";
import { resolveLifecycleConfig, type PlanChangeCoupons } from "./lifecycle-config";

/**
 * Whether a coupon that names plans or billing periods still covers `plan`. A coupon that
 * names neither (`all` with any period, `none`, or one on the invoice total) stays.
 */
export function couponCoversPlan(
  coupon: { applyOn: string | null },
  planConstraint: {
    constraintType: string;
    productIds: unknown;
    priceIds: unknown;
    billingPeriods?: unknown;
  } | null,
  plan: {
    productPublicId: string;
    pricePublicId: string;
    interval?: string | null;
    intervalCount?: number | null;
  },
): boolean {
  if (coupon.applyOn !== "each_specified_item") return true;
  if (!planConstraint || planConstraint.constraintType === "none") return true;
  const periods = Array.isArray(planConstraint.billingPeriods)
    ? (planConstraint.billingPeriods as Array<{ interval: string; interval_count: number }>)
    : [];
  if (
    periods.length &&
    !periods.some((p) => p.interval === plan.interval && p.interval_count === plan.intervalCount)
  )
    return false;
  if (planConstraint.constraintType !== "specific") return true;
  const ids = Array.isArray(planConstraint.productIds) ? planConstraint.productIds : [];
  const priceIds = Array.isArray(planConstraint.priceIds) ? planConstraint.priceIds : [];
  return ids.includes(plan.productPublicId) || priceIds.includes(plan.pricePublicId);
}

/**
 * The codes of the active coupons a move onto `newPlan` removes: under `rule` when the call
 * sets one, else the business rule.
 */
export async function couponsLeftBehind(
  tx: Tx,
  input: {
    businessId: string;
    subscriptionId: string;
    newPlan: { productId: string; pricePublicId: string };
    rule?: PlanChangeCoupons;
  },
): Promise<string[]> {
  const rule = input.rule ?? (await businessRule(tx, input.businessId));
  if (rule === "keep") return [];
  const active = await tx
    .select({ id: coupons.id, code: coupons.code, applyOn: coupons.applyOn })
    .from(appliedCoupons)
    .innerJoin(coupons, eq(coupons.id, appliedCoupons.couponId))
    .where(
      and(
        eq(appliedCoupons.subscriptionId, input.subscriptionId),
        eq(appliedCoupons.status, "active"),
      ),
    );
  if (active.length === 0) return [];
  if (rule === "drop") return [...new Set(active.map((c) => c.code))];

  const [prod] = await tx
    .select({ publicId: products.publicId })
    .from(products)
    .where(eq(products.id, input.newPlan.productId))
    .limit(1);
  const [price] = await tx
    .select({ interval: prices.interval, intervalCount: prices.intervalCount })
    .from(prices)
    .where(
      and(
        eq(prices.businessId, input.businessId),
        eq(prices.publicId, input.newPlan.pricePublicId),
      ),
    )
    .limit(1);
  const plan = {
    productPublicId: prod?.publicId ?? "",
    pricePublicId: input.newPlan.pricePublicId,
    interval: price?.interval ?? null,
    intervalCount: price?.intervalCount ?? null,
  };
  const cons = await tx
    .select()
    .from(couponItemConstraints)
    .where(
      and(
        inArray(
          couponItemConstraints.couponId,
          active.map((c) => c.id),
        ),
        eq(couponItemConstraints.itemKind, "plan"),
      ),
    );
  const byCoupon = new Map(cons.map((c) => [c.couponId, c]));
  return [
    ...new Set(
      active
        .filter((c) => !couponCoversPlan(c, byCoupon.get(c.id) ?? null, plan))
        .map((c) => c.code),
    ),
  ];
}

async function businessRule(tx: Tx, businessId: string): Promise<PlanChangeCoupons> {
  const [biz] = await tx
    .select({ billingRulesConfig: businesses.billingRulesConfig })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return resolveLifecycleConfig(biz).planChangeCoupons;
}
