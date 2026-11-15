import { describe, it, expect } from "vitest";
import { midTermCouponsApply } from "@/modules/subscriptions/mid-term-coupons";
import { resolveBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";

describe("mid_term_coupons", () => {
  it("skip discounts no mid-term invoice", () => {
    for (const s of ["unbilled", "edit", "charge"] as const)
      expect(midTermCouponsApply("skip", s)).toBe(false);
  });
  it("unbilled_and_edits leaves a charge invoiced at once at list price", () => {
    expect(midTermCouponsApply("unbilled_and_edits", "unbilled")).toBe(true);
    expect(midTermCouponsApply("unbilled_and_edits", "edit")).toBe(true);
    expect(midTermCouponsApply("unbilled_and_edits", "charge")).toBe(false);
  });
  it("all discounts every mid-term invoice", () => {
    for (const s of ["unbilled", "edit", "charge"] as const)
      expect(midTermCouponsApply("all", s)).toBe(true);
  });
  it("an unset or unknown value resolves to skip", () => {
    expect(resolveBillingRulesConfig(null).midTermCoupons).toBe("skip");
    expect(
      resolveBillingRulesConfig({ billingRulesConfig: { mid_term_coupons: "some" } })
        .midTermCoupons,
    ).toBe("skip");
  });
});
