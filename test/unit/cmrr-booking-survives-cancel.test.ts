import { describe, expect, it } from "vitest";
import {
  committedAt,
  frozenStopBooking,
  nonRenewingAt,
  type StockRow,
} from "@/modules/metrics/stocks";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

// A yearly subscription booked to stop at the end of its final term, 2025-09-28 → 2026-09-26.
const booked: StockRow = {
  id: "sub",
  status: "active",
  currency: "USD",
  createdAt: d("2023-09-15"),
  startDate: d("2023-09-15"),
  startedAt: d("2023-09-15"),
  canceledAt: null,
  cancelAtPeriodEnd: true,
  cancelScheduledAt: null,
  currentPeriodStart: d("2025-09-28"),
  currentPeriodEnd: d("2026-09-26"),
  trialEnd: null,
  trialStart: null,
  billingPeriod: 1,
  billingPeriodUnit: "year",
  remainingBillingCycles: 0,
};

/** What the term-end cancel in `renewal.ts` writes. */
const cancelAtTermEnd = (s: StockRow, now: Date, keep = true): StockRow => ({
  ...s,
  status: "cancelled",
  canceledAt: now,
  cancelAtPeriodEnd: false,
  cancelBookedAt: keep ? frozenStopBooking(s, now) : null,
});

const DAYS = ["2025-09-27", "2026-03-31", "2026-06-29", "2026-08-13"].map(d);

describe("a term-end cancel keeps the date its stop was booked", () => {
  const after = cancelAtTermEnd(booked, d("2026-09-26"));

  it("CMRR history is the same before and after the cancel lands", () => {
    for (const at of DAYS) expect(committedAt(after, at)).toBe(committedAt(booked, at));
    expect(committedAt(after, d("2026-03-31"))).toBe(false);
    expect(committedAt(after, d("2025-09-27"))).toBe(true);
  });

  it("non-renewing history is the same before and after", () => {
    for (const at of DAYS) expect(nonRenewingAt(after, at)).toBe(nonRenewingAt(booked, at));
  });

  it("without the kept booking the cancel re-dates the stop (the regression)", () => {
    const lost = cancelAtTermEnd(booked, d("2026-09-26"), false);
    expect(committedAt(lost, d("2026-03-31"))).toBe(true);
  });

  it("an immediate cancel before a far-off scheduled stop is booked no later than itself", () => {
    const scheduled: StockRow = {
      ...booked,
      cancelAtPeriodEnd: false,
      cancelScheduledAt: d("2027-06-01"),
      billingPeriodUnit: "month",
    };
    const now = d("2026-01-10");
    expect(frozenStopBooking(scheduled, now)).toEqual(now);
  });

  it("a subscription that simply ran out its cycles keeps nothing, so stays committed to its end", () => {
    const exhausted: StockRow = { ...booked, cancelAtPeriodEnd: false };
    expect(frozenStopBooking(exhausted, d("2026-09-26"))).toBeNull();
    expect(committedAt(cancelAtTermEnd(exhausted, d("2026-09-26")), d("2026-08-13"))).toBe(true);
  });
});
