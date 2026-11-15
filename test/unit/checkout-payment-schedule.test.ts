/**
 * What the hosted checkout states about recurring money: the regular amount leaves out
 * every coupon that ends, the discounted figure is quoted only for the periods it is
 * true for, and the consent sentence says both, plus the trial.
 */
import { describe, it, expect } from "vitest";
import {
  couponSpan,
  firstPeriodsLabel,
  recurringConsentText,
  splitCouponsByDuration,
} from "../../src/modules/checkout/payment-schedule";

const month = { interval: "month", count: 1 };

describe("couponSpan", () => {
  it("reads once, repeating and forever from the catalog", () => {
    expect(couponSpan("A", { durationType: "once", durationInPeriods: null }).periods).toBe(1);
    expect(couponSpan("B", { durationType: "repeating", durationInPeriods: 3 }).periods).toBe(3);
    expect(
      couponSpan("C", { durationType: "forever", durationInPeriods: null }).periods,
    ).toBeNull();
  });
  it("counts an unknown code, or a repeating one with no count, as one that ends", () => {
    expect(couponSpan("X", null).periods).toBeUndefined();
    expect(
      couponSpan("Y", { durationType: "repeating", durationInPeriods: null }).periods,
    ).toBeUndefined();
  });
});

describe("splitCouponsByDuration", () => {
  it("keeps a coupon that never ends in the regular amount", () => {
    const s = splitCouponsByDuration([{ code: "F", periods: null }]);
    expect(s).toEqual({ lasting: ["F"], limited: [], introPeriods: null, regularAfter: null });
  });
  it("a once coupon: discounted for 1 period, regular from the 2nd", () => {
    const s = splitCouponsByDuration([{ code: "W", periods: 1 }]);
    expect(s.lasting).toEqual([]);
    expect(s.limited).toEqual(["W"]);
    expect(s.introPeriods).toBe(1);
    expect(s.regularAfter).toBe(1);
  });
  it("mixed spans: every coupon applies for the shortest, regular after the longest", () => {
    const s = splitCouponsByDuration([
      { code: "A", periods: 1 },
      { code: "B", periods: 3 },
      { code: "F", periods: null },
    ]);
    expect(s.lasting).toEqual(["F"]);
    expect(s.introPeriods).toBe(1);
    expect(s.regularAfter).toBe(3);
  });
  it("a span it cannot count: true for the first period only, regular start unknown", () => {
    const s = splitCouponsByDuration([
      { code: "A", periods: 3 },
      { code: "U", periods: undefined },
    ]);
    expect(s.introPeriods).toBe(1);
    expect(s.regularAfter).toBeNull();
  });
});

describe("recurringConsentText", () => {
  const regular = { totalMinor: 25204, currency: "USD", excludesUsage: false };
  it("states the regular amount, not the discounted one", () => {
    const t = recurringConsentText("Halyard", month, regular, {
      intro: { totalMinor: 22683, periods: 1 },
    });
    expect(t).toBe(
      "I agree that Halyard charges me $252.04 every month until I cancel. With my discount, I pay $226.83 for the first month.",
    );
  });
  it("names the trial", () => {
    const t = recurringConsentText(
      "Halyard",
      month,
      { ...regular, totalMinor: 8473 },
      { trial: { count: 14, unit: "day" } },
    );
    expect(t).toBe(
      "I agree that Halyard charges me $84.73 every month until I cancel. The first charge is when my 14-day free trial ends.",
    );
  });
  it("is unchanged with no trial and no discount that ends", () => {
    expect(recurringConsentText("Halyard", month, regular)).toBe(
      "I agree that Halyard charges me $252.04 every month until I cancel.",
    );
  });
  it("says usage and the period count", () => {
    const t = recurringConsentText(
      "Halyard",
      { interval: "month", count: 3 },
      { ...regular, excludesUsage: true },
      { intro: { totalMinor: 22683, periods: 2 } },
    );
    expect(t).toContain("$252.04, plus usage, every 3 months");
    expect(t).toContain("for each of the first 2 billing periods.");
  });
  it("without an amount yet, still names the period", () => {
    expect(recurringConsentText("Halyard", month, null)).toBe(
      "I agree that Halyard charges me for this subscription every month until I cancel.",
    );
  });
});

describe("firstPeriodsLabel", () => {
  it("reads naturally for 1 and many", () => {
    expect(firstPeriodsLabel(1, month)).toBe("the first month");
    expect(firstPeriodsLabel(3, month)).toBe("each of the first 3 months");
    expect(firstPeriodsLabel(1, { interval: "year", count: 1 })).toBe("the first year");
  });
});
