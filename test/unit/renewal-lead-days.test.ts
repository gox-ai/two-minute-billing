import { describe, it, expect } from "vitest";
import { renewalLeadDays } from "@/modules/subscriptions/reminders";

const base = { currentPeriodStart: null, currentPeriodEnd: null };

describe("renewal reminder lead time", () => {
  it("yearly plans get 30 days, everything else 5", () => {
    expect(renewalLeadDays({ ...base, billingPeriod: 1, billingPeriodUnit: "year" })).toBe(30);
    expect(renewalLeadDays({ ...base, billingPeriod: 12, billingPeriodUnit: "month" })).toBe(30);
    expect(renewalLeadDays({ ...base, billingPeriod: 1, billingPeriodUnit: "month" })).toBe(5);
    expect(renewalLeadDays({ ...base, billingPeriod: 3, billingPeriodUnit: "month" })).toBe(5);
    expect(renewalLeadDays({ ...base, billingPeriod: 2, billingPeriodUnit: "week" })).toBe(5);
  });

  it("with no period on the row, a year-long term counts as yearly", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const year = { billingPeriod: null, billingPeriodUnit: null, currentPeriodStart: start };
    expect(renewalLeadDays({ ...year, currentPeriodEnd: new Date("2027-01-01T00:00:00Z") })).toBe(
      30,
    );
    expect(renewalLeadDays({ ...year, currentPeriodEnd: new Date("2026-02-01T00:00:00Z") })).toBe(
      5,
    );
  });
});
