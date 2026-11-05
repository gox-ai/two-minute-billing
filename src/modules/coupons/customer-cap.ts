/**
 * How many coupon codes a buyer can enter on one checkout or one subscription
 * (`businesses.max_customer_coupon_codes`, 0495, 1–10, default 1). Codes an operator applies
 * through the dashboard or the API do not count toward the cap.
 *
 * Portal, at a cap of 1: no code while ANY discount is live, operator ones included (stacking
 * is a pricing decision). Above 1 the merchant has allowed stacking, and only buyer codes count.
 */
import { and, count, eq, sql } from "drizzle-orm";
import { appliedCoupons } from "@db/schema";
import type { Tx } from "@/platform/db";

export const MAX_CUSTOMER_COUPON_CODES = 10;

/** The refusal when the buyer is at the cap. */
export function customerCouponCapMessage(cap: number): string {
  return cap === 1
    ? "You can enter 1 coupon code. Remove the other code first."
    : `You can enter ${cap} coupon codes. Remove one of the codes first.`;
}

/** Codes the buyer can still enter on a subscription. Pure. */
export function portalCouponCodesLeft(
  cap: number,
  live: { entered: number; total: number },
): number {
  if (cap <= 1) return live.total > 0 ? 0 : 1;
  return Math.max(0, cap - live.entered);
}

/** Active discounts on the subscription: all of them, and those the customer entered. */
export async function liveDiscountCounts(
  tx: Tx,
  subscriptionId: string,
): Promise<{ entered: number; total: number }> {
  const [r] = await tx
    .select({
      total: count(),
      entered: sql<number>`count(*) filter (where ${appliedCoupons.enteredByCustomer})`,
    })
    .from(appliedCoupons)
    .where(
      and(eq(appliedCoupons.subscriptionId, subscriptionId), eq(appliedCoupons.status, "active")),
    );
  return { entered: Number(r?.entered ?? 0), total: Number(r?.total ?? 0) };
}
