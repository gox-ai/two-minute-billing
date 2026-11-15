import { describe, it, expect } from "vitest";
import { serializeCoupon } from "@/api/coupon-routes";
import type { coupons } from "@db/schema";

const row = {
  id: "00000000-0000-0000-0000-000000000001",
  code: "LAUNCH100",
  name: "Launch",
  kind: "percentage",
  percentOffBps: 10000,
  amountOffMinor: null,
  currency: null,
  durationType: "once",
  durationInPeriods: null,
  applyOn: "invoice_amount",
  active: true,
  archivedAt: null,
  invoiceName: null,
  validFrom: null,
  redeemBy: null,
  maxRedemptions: null,
  maxRedemptionsPerCustomer: 1,
  perCustomerLimitBy: "email",
  timesRedeemed: 0,
  metadata: null,
} as unknown as typeof coupons.$inferSelect;

describe("coupon serializer", () => {
  // The list route used its own copy without per_customer_limit_by, so catalog.mjs,
  // which compares against the list, planned the same change on every run.
  it("returns per_customer_limit_by with the per-customer cap", () => {
    const out = serializeCoupon(row, new Date("2026-11-14T00:00:00Z"));
    expect(out.per_customer_limit_by).toBe("email");
    expect(out.max_redemptions_per_customer).toBe(1);
  });
});
