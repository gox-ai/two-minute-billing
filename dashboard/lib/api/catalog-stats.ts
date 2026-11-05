// Usage figures for the catalog detail pages, the coupon redemption history, and the
// coupon-set rename. Server-only. Shapes mirror src/api/catalog-stats-routes.ts.
import { apiGet, apiWrite, listQuery, type ListParams, type PagedList } from "@/lib/api";

/** Minor units in one currency. Never sum across currencies. */
export interface MoneyByCurrency {
  currency: string;
  amount_minor: number;
}

/**
 * "Active" = stored `active` + `in_trial` (non_renewing included). MRR is each
 * subscription's net MRR apportioned to its items; a trialling one counts but adds 0.
 */
export interface UsageStats {
  active_subscriptions: number;
  /** Of `active_subscriptions`, how many are in trial. */
  in_trial_subscriptions: number;
  mrr: MoneyByCurrency[];
}

export interface ProductStats extends UsageStats {
  object: "product_stats";
  product: string;
}

export interface PriceStats extends UsageStats {
  object: "price_stats";
  price: string;
}

export interface ProductGroupStats extends UsageStats {
  object: "product_group_stats";
  product_group: string;
  /** Every product in the group, archived included. */
  products: Array<{ product: string } & UsageStats>;
}

export interface CouponStats {
  object: "coupon_stats";
  coupon: string;
  /** Every application, set codes included; removed ones still count. */
  redemptions: number;
  /** Net of credit notes (gross − reversed), per invoice currency. */
  discount_given: MoneyByCurrency[];
  /** Taken off non-voided invoices. */
  discount_gross: MoneyByCurrency[];
  /** Credited back by non-voided credit notes. */
  discount_reversed: MoneyByCurrency[];
}

export interface CouponRedemption {
  object: "coupon_redemption";
  /** The applied discount id (`disc_…`). */
  id: string;
  coupon: string;
  status: "active" | "exhausted" | "removed";
  /** null = forever. */
  remaining_periods: number | null;
  customer: string;
  subscription: string | null;
  /** First non-voided invoice it discounted; null until one has. */
  invoice: string | null;
  redeemed_at: string;
  discount_minor: number;
  currency: string;
}

const enc = encodeURIComponent;

export const getProductStats = (biz: string, prod: string) =>
  apiGet<ProductStats>(`/v1/businesses/${biz}/products/${enc(prod)}/stats`);

export const getPriceStats = (biz: string, price: string) =>
  apiGet<PriceStats>(`/v1/businesses/${biz}/prices/${enc(price)}/stats`);

export const getProductGroupStats = (biz: string, grp: string) =>
  apiGet<ProductGroupStats>(`/v1/businesses/${biz}/product_groups/${enc(grp)}/stats`);

export const getCouponStats = (biz: string, cpn: string) =>
  apiGet<CouponStats>(`/v1/businesses/${biz}/coupons/${enc(cpn)}/stats`);

/** Cursor-paged, newest first. Only `limit` and `startingAfter` are honoured. */
export function listCouponRedemptions(biz: string, cpn: string, params: ListParams = {}) {
  const q = listQuery({ limit: params.limit, startingAfter: params.startingAfter });
  return apiGet<PagedList<CouponRedemption>>(
    `/v1/businesses/${biz}/coupons/${enc(cpn)}/redemptions${q ? `?${q}` : ""}`,
  );
}

export const renameCouponSet = (biz: string, set: string, name: string) =>
  apiWrite(`/v1/businesses/${biz}/coupon_sets/${enc(set)}`, { name }, "PATCH");
