/**
 * An imported discount span → our billing-period count.
 *
 * The bug being pinned: a source says "10% off for 12 MONTHS" (wall-clock) and we consume a
 * discount once per INVOICE, so importing 12 verbatim gives a yearly-billed customer
 * twelve YEARS of discount. The fix counts the invoices that fall inside the window.
 */
import { describe, it, expect } from "vitest";
import { discountSpanInBillingPeriods } from "../../src/modules/migration/import";

const span = (periods: number, unit: "day" | "week" | "month" | "year") => ({ periods, unit });
const monthly = { interval: "month" as const, intervalCount: 1 };
const yearly = { interval: "year" as const, intervalCount: 1 };
const quarterly = { interval: "month" as const, intervalCount: 3 };

describe("discountSpanInBillingPeriods — the case that was wrong", () => {
  it("12 months on a YEARLY plan is ONE period, not twelve", () => {
    // The whole point. Twelve was twelve years of discount.
    expect(discountSpanInBillingPeriods(span(12, "month"), yearly)).toEqual({
      periods: 1,
      approximate: false,
    });
  });

  it("12 months on a MONTHLY plan is still twelve — the common case is unchanged", () => {
    expect(discountSpanInBillingPeriods(span(12, "month"), monthly)).toEqual({
      periods: 12,
      approximate: false,
    });
  });
});

describe("discountSpanInBillingPeriods — counting invoices inside the window", () => {
  it("counts the invoice instants in [0, W), so a partial period still counts", () => {
    // Months 0 and 12 are inside an 18-month window; month 24 is not.
    expect(discountSpanInBillingPeriods(span(18, "month"), yearly).periods).toBe(2);
  });

  it("a window shorter than one billing period still covers the first invoice", () => {
    // The signup invoice is raised at t=0, inside any non-empty window.
    expect(discountSpanInBillingPeriods(span(1, "month"), yearly).periods).toBe(1);
  });

  it("divides exactly when the window is a multiple of the cadence", () => {
    expect(discountSpanInBillingPeriods(span(6, "month"), quarterly).periods).toBe(2);
    expect(discountSpanInBillingPeriods(span(2, "year"), yearly).periods).toBe(2);
  });

  it("a year-spanned discount on a monthly plan is twelve periods", () => {
    expect(discountSpanInBillingPeriods(span(1, "year"), monthly).periods).toBe(12);
  });

  it("never returns 0 — a limited discount always covers at least the first invoice", () => {
    expect(discountSpanInBillingPeriods(span(1, "day"), yearly).periods).toBeGreaterThanOrEqual(1);
  });
});

describe("discountSpanInBillingPeriods — which answers are EXACT", () => {
  it("month↔year is exact (integer months, no calendar guess)", () => {
    expect(discountSpanInBillingPeriods(span(24, "month"), yearly)).toEqual({
      periods: 2,
      approximate: false,
    });
  });

  it("day↔week is exact too — a week is exactly seven days", () => {
    expect(
      discountSpanInBillingPeriods(span(4, "week"), { interval: "day", intervalCount: 7 }),
    ).toEqual({ periods: 4, approximate: false });
    expect(
      discountSpanInBillingPeriods(span(14, "day"), { interval: "week", intervalCount: 1 }),
    ).toEqual({ periods: 2, approximate: false });
  });

  it("MIXED units are flagged approximate — a month is 28-31 days, so there is no exact answer", () => {
    // Reported, not hidden: the caller warns so an operator can check the real dates.
    expect(discountSpanInBillingPeriods(span(90, "day"), monthly).approximate).toBe(true);
    expect(
      discountSpanInBillingPeriods(span(3, "month"), { interval: "day", intervalCount: 30 })
        .approximate,
    ).toBe(true);
  });

  it("…and the mixed answer is still sensible: 90 days of a monthly plan is 3 invoices", () => {
    expect(discountSpanInBillingPeriods(span(90, "day"), monthly).periods).toBe(3);
  });

  it("365 days on a monthly plan is 12, not 13 — the calendar month is 365/12, not 30", () => {
    // A 30-day month would give ceil(365/30) = 13 and hand over a free period.
    expect(discountSpanInBillingPeriods(span(365, "day"), monthly).periods).toBe(12);
  });

  it("float noise cannot round a whole number up", () => {
    // 12/12 must be 1. Without the fixed-point guard a 0.9999999 ratio ceils to 2.
    expect(
      discountSpanInBillingPeriods(span(36, "month"), { interval: "month", intervalCount: 12 })
        .periods,
    ).toBe(3);
  });
});
