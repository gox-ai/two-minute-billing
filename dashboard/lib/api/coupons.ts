/**
 * Coupon-domain fetchers — server-only (imports apiGet from the frozen lib/api).
 * All NEW fetchers go here; listCoupons/listCouponSets/listCouponSetCodes live in
 * lib/api.ts and are re-exported below for convenience.
 */

import type { Coupon, CouponSet, CouponCode, Product } from "@/lib/api";

export type { Coupon, CouponSet, CouponCode, Product };

/** Extended coupon shape that includes fields the API returns but the base type omits. */
export interface CouponDetail extends Coupon {
  apply_on?: "invoice_amount" | "each_specified_item" | null;
  invoice_name?: string | null;
  valid_from?: string | null;
  redeem_by?: string | null;
  duration_in_periods?: number | null;
  status?: "future" | "active" | "expired" | "archived";
  created_at?: string;
  /** CAT-2 scoping — `null` unless `apply_on === 'each_specified_item'`. */
  item_constraints?: ItemConstraint[] | null;
  metadata?: Record<string, unknown> | null;
}

/** Fetch one coupon by id via the list endpoint (no single-GET route exists). */
export async function getCoupon(biz: string, id: string): Promise<CouponDetail | null> {
  const { listCoupons } = await import("@/lib/api");
  const res = await listCoupons(biz, { includeArchived: true });
  return (res.data as CouponDetail[]).find((c) => c.id === id || c.code === id) ?? null;
}

/**
 * A kind MISSING from a coupon's `item_constraints` is an implicit `none` — the engine's
 * `couponMatchesLine` requires a matching row — so never render absence as "all".
 */
export interface ItemConstraint {
  item_kind: "plan" | "addon" | "charge";
  constraint_type: "all" | "specific" | "none";
  product_ids?: string[];
}

/** Re-exports so callers can import everything from one place. */
export { listCoupons, listCouponSets, listCouponSetCodes } from "@/lib/api";
