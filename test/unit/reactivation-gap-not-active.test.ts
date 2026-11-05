import { describe, expect, it } from "vitest";
import { earningAt, isActiveAt, liveAt, type StockRow } from "@/modules/metrics/stocks";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// Started 2026-04-05, churned 2026-08-19, reactivated 2026-10-03 — the row now shows no cancel.
const reactivated: StockRow = {
  id: "sub",
  status: "active",
  currency: "USD",
  createdAt: d("2026-04-05"),
  startDate: d("2026-10-03"),
  startedAt: d("2026-04-05"),
  canceledAt: null,
  cancelAtPeriodEnd: false,
  cancelScheduledAt: null,
  cancelBookedAt: null,
  currentPeriodStart: d("2026-10-03"),
  currentPeriodEnd: d("2026-11-03"),
  trialEnd: null,
  trialStart: null,
  billingPeriod: 1,
  billingPeriodUnit: "month",
  remainingBillingCycles: null,
  lapses: [{ from: d("2026-08-19"), to: d("2026-10-03") }],
};

describe("a reactivated subscription is not active through the gap it was cancelled", () => {
  it("is active before the churn and from the reactivation", () => {
    expect(isActiveAt(reactivated, d("2026-08-18"))).toBe(true);
    expect(isActiveAt(reactivated, d("2026-10-03"))).toBe(true);
  });

  it("is neither live, active nor earning inside the gap", () => {
    for (const day of ["2026-08-19", "2026-08-20", "2026-10-02"]) {
      expect(liveAt(reactivated, d(day))).toBe(false);
      expect(isActiveAt(reactivated, d(day))).toBe(false);
      expect(earningAt(reactivated, d(day))).toBe(false);
    }
  });

  it("without lapses the row alone reads as live straight through", () => {
    expect(isActiveAt({ ...reactivated, lapses: undefined }, d("2026-08-20"))).toBe(true);
  });
});
