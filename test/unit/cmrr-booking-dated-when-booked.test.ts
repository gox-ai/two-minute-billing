import { describe, expect, it } from "vitest";
import { committedAt, nonRenewingAt, type StockRow } from "@/modules/metrics/stocks";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// A yearly subscription, term 2025-10-22 → 2026-10-22, booked to stop at term end on 2026-10-02.
const live: StockRow = {
  id: "sub",
  status: "active",
  currency: "USD",
  createdAt: d("2025-10-08"),
  startDate: d("2025-10-08"),
  startedAt: d("2025-10-08"),
  canceledAt: null,
  cancelAtPeriodEnd: true,
  cancelScheduledAt: null,
  cancelBookedAt: d("2026-10-02"),
  currentPeriodStart: d("2025-10-22"),
  currentPeriodEnd: d("2026-10-22"),
  trialEnd: null,
  trialStart: null,
  billingPeriod: 1,
  billingPeriodUnit: "year",
  remainingBillingCycles: null,
};

describe("a term-end stop booked mid-term leaves CMRR when it was booked", () => {
  it("is committed every day before the booking", () => {
    for (const day of ["2025-11-01", "2026-04-06", "2026-08-19", "2026-10-01"])
      expect(committedAt(live, d(day))).toBe(true);
    expect(committedAt(live, d("2026-10-03"))).toBe(false);
  });

  it("is renewing until the booking, then non-renewing until the stop", () => {
    expect(nonRenewingAt(live, d("2026-04-06"))).toBe(false);
    expect(nonRenewingAt(live, d("2026-10-03"))).toBe(true);
    expect(nonRenewingAt(live, d("2026-10-23"))).toBe(false);
  });

  it("a booking from a specific-date schedule ends at that date", () => {
    const scheduled = { ...live, cancelAtPeriodEnd: false, cancelScheduledAt: d("2026-12-01") };
    expect(nonRenewingAt(scheduled, d("2026-11-15"))).toBe(true);
    expect(committedAt(scheduled, d("2026-08-19"))).toBe(true);
  });

  it("without a booking date the stop still falls back to the final term's start", () => {
    const unknown = { ...live, cancelBookedAt: null };
    expect(committedAt(unknown, d("2026-04-06"))).toBe(false);
  });
});
