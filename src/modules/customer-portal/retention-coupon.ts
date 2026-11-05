/**
 * The cancel flow's discount coupon (`storefront_config.retention_coupon`) is applied only by
 * an accepted retention offer. Buyer-facing coupon boxes (portal, checkout) refuse it, by
 * coupon id, so another code of the same coupon (a coupon-set code) is refused too.
 * Staff may still apply it from the dashboard or the API.
 */
import { findCouponByCode } from "@/modules/coupons/service";
import { resolveStorefrontConfig } from "@/modules/checkout/storefront-config";
import { getBusinessById } from "@/modules/tenancy/service";

export const RETENTION_COUPON_REFUSAL = "We could not apply this coupon. It is not available here.";

export async function isRetentionCouponCode(input: {
  organizationId: string;
  businessId: string;
  code: string;
}): Promise<boolean> {
  const cfg = resolveStorefrontConfig(
    await getBusinessById(input.organizationId, input.businessId),
  );
  if (!cfg.retentionCoupon) return false;
  const [offer, typed] = await Promise.all([
    findCouponByCode({ ...input, code: cfg.retentionCoupon }),
    findCouponByCode(input),
  ]);
  return !!offer && !!typed && offer.id === typed.id;
}
