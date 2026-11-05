import { describe, expect, it } from "vitest";
import {
  renewalChargesUntil,
  type RenewalScheduleRow,
} from "@/modules/metrics/daily/renewal-measures";
import { DEFAULT_BILLING_MODE } from "@/modules/subscriptions/billing-mode";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const until = d("2026-12-27"); // 90 days after 2026-09-28
const base: RenewalScheduleRow = {
  status: "active",
  trialEnd: null,
  currentPeriodEnd: d("2026-10-05"),
  cancelAtPeriodEnd: false,
  cancelScheduledAt: null,
  remainingBillingCycles: null,
  billingPeriod: 1,
  billingPeriodUnit: "month",
  billingAnchorDay: null,
};
const days = (s: Partial<RenewalScheduleRow>) =>
  renewalChargesUntil({ ...base, ...s }, until, DEFAULT_BILLING_MODE).map((x) =>
    x.toISOString().slice(0, 10),
  );

describe("renewal charges in the next 90 days", () => {
  it("a monthly plan charges at each boundary in the window", () => {
    expect(days({})).toEqual(["2026-10-05", "2026-11-05", "2026-12-05"]);
  });

  it("a weekly plan counts every renewal, not one per subscription", () => {
    expect(days({ billingPeriodUnit: "week", currentPeriodEnd: d("2026-12-01") })).toEqual([
      "2026-12-01",
      "2026-12-08",
      "2026-12-15",
      "2026-12-22",
    ]);
  });

  it("a trial's first charge is its conversion at trial end", () => {
    expect(days({ status: "in_trial", trialEnd: d("2026-11-20"), currentPeriodEnd: null })).toEqual(
      ["2026-11-20", "2026-12-20"],
    );
  });

  it("a booked cancellation stops charges at and after it", () => {
    expect(days({ cancelScheduledAt: d("2026-11-05") })).toEqual(["2026-10-05"]);
    expect(days({ cancelAtPeriodEnd: true })).toEqual([]);
  });

  it("remaining cycles are charges left, as the clock counts them", () => {
    expect(days({ remainingBillingCycles: 2 })).toEqual(["2026-10-05", "2026-11-05"]);
    expect(days({ remainingBillingCycles: 0 })).toEqual([]);
  });

  it("a boundary past the window is not counted", () => {
    expect(days({ billingPeriodUnit: "year", currentPeriodEnd: d("2027-03-01") })).toEqual([]);
  });
});
