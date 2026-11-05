import { describe, expect, it } from "vitest";
import { resetTermFor, resolveLifecycleConfig } from "@/modules/subscriptions/lifecycle-config";
import { creditHandlingFor } from "@/modules/subscriptions/downgrade-credit";
import { couponCoversPlan } from "@/modules/subscriptions/plan-change-coupons";
import { pickResumeAnchor } from "@/modules/subscriptions/service";

describe("lifecycle config", () => {
  it("unset, null and malformed resolve to today's behaviour", () => {
    for (const raw of [null, undefined, {}, { plan_change_term: "nope", downgrade_credit: 3 }]) {
      const c = resolveLifecycleConfig({ billingRulesConfig: raw });
      expect(c.planChangeTerm).toBe("keep_anchor");
      expect(c.planChangeCoupons).toBe("keep");
      expect(c.downgradeCredit).toBe("credit_balance");
      expect(c.reactivationCharges).toBe("invoice_immediately");
    }
  });

  it("the call's reset_term wins; only a plan move follows the rule", () => {
    expect(resetTermFor("reset_on_upgrade", "upgrade", true)).toBe(true);
    expect(resetTermFor("reset_on_upgrade", "downgrade", true)).toBeUndefined();
    expect(resetTermFor("reset_on_any_change", "same", true)).toBe(true);
    expect(resetTermFor("reset_on_any_change", "upgrade", false)).toBeUndefined();
    expect(resetTermFor("keep_anchor", "upgrade", true, true)).toBe(true);
    expect(resetTermFor("reset_on_any_change", "upgrade", true, false)).toBe(false);
  });

  it("credit handling: the customer's choice counts only under customer_chooses", () => {
    expect(creditHandlingFor("credit_balance", "refund")).toBe("credit_balance");
    expect(creditHandlingFor("refund")).toBe("refund");
    expect(creditHandlingFor("customer_chooses")).toBe("credit_balance");
    expect(creditHandlingFor("customer_chooses", "refund")).toBe("refund");
  });

  it("a coupon limited to plans covers only the plans it names", () => {
    const plan = { productPublicId: "prod_b", pricePublicId: "price_b" };
    expect(couponCoversPlan({ applyOn: "invoice_amount" }, null, plan)).toBe(true);
    expect(couponCoversPlan({ applyOn: "each_specified_item" }, null, plan)).toBe(true);
    const only = (productIds: string[], priceIds: string[] = []) => ({
      constraintType: "specific",
      productIds,
      priceIds,
    });
    expect(couponCoversPlan({ applyOn: "each_specified_item" }, only(["prod_a"]), plan)).toBe(
      false,
    );
    expect(couponCoversPlan({ applyOn: "each_specified_item" }, only(["prod_b"]), plan)).toBe(true);
    expect(couponCoversPlan({ applyOn: "each_specified_item" }, only([], ["price_b"]), plan)).toBe(
      true,
    );
  });

  it("a resume keeps the billing day when set on purpose or when the month clamps it", () => {
    // Resumed 28 Feb 2027 on a 31st-anchored subscription: the 31st stays.
    expect(pickResumeAnchor(31, { year: 2027, month: 1, day: 28 }, false)).toBe(31);
    // Resumed on the 10th: the 10th is the new day.
    expect(pickResumeAnchor(31, { year: 2027, month: 2, day: 10 }, false)).toBe(10);
    // Manually set billing day: kept.
    expect(pickResumeAnchor(5, { year: 2027, month: 2, day: 10 }, true)).toBe(5);
  });
});
