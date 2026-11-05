import { describe, it, expect } from "vitest";
import {
  nextSubPeriodEnd,
  subPeriodDue,
  subPeriodFields,
  supportsMonthlyUsage,
} from "@/modules/subscriptions/sub-periods";
import {
  appendSegment,
  commitmentSegment,
  proratedCommitment,
  termSegments,
} from "@/modules/subscriptions/commitment";
import { termUsageWindow } from "@/modules/subscriptions/usage-window";
import { DEFAULT_BILLING_MODE, type BillingMode } from "@/modules/subscriptions/billing-mode";

const utc = DEFAULT_BILLING_MODE;
const kolkata: BillingMode = { anchor: "day", proration: "whole_day", timezone: "Asia/Kolkata" };
const d = (s: string) => new Date(s);

describe("sub-period boundaries", () => {
  it("allows month-family terms of 2+ months only", () => {
    expect(supportsMonthlyUsage("year", 1)).toBe(true);
    expect(supportsMonthlyUsage("month", 3)).toBe(true);
    expect(supportsMonthlyUsage("month", 1)).toBe(false);
    expect(supportsMonthlyUsage("week", 52)).toBe(false);
    expect(supportsMonthlyUsage("day", 365)).toBe(false);
  });

  it("a 31st anchor does not drift: each boundary is taken from the term start", () => {
    const start = d("2027-01-31T00:00:00Z");
    const end = d("2028-01-31T00:00:00Z");
    const ends: string[] = [];
    let after = start;
    for (let i = 0; i < 12; i++) {
      after = nextSubPeriodEnd(start, end, after, 31, utc);
      ends.push(after.toISOString().slice(0, 10));
    }
    expect(ends).toEqual([
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
      "2027-07-31",
      "2027-08-31",
      "2027-09-30",
      "2027-10-31",
      "2027-11-30",
      "2027-12-31",
      "2028-01-31",
    ]);
  });

  it("leap year: a 29 Feb start lands on the last day of short months", () => {
    const start = d("2028-02-29T00:00:00Z");
    const end = d("2029-02-28T00:00:00Z");
    expect(nextSubPeriodEnd(start, end, start, 29, utc).toISOString()).toBe(
      "2028-03-29T00:00:00.000Z",
    );
    expect(nextSubPeriodEnd(start, end, d("2029-01-29T00:00:00Z"), 29, utc)).toEqual(end);
  });

  it("keeps local midnight in a non-UTC zone", () => {
    // 1 Jan 2027 00:00 IST = 31 Dec 2026 18:30 UTC.
    const start = d("2026-12-31T18:30:00Z");
    const end = d("2027-12-31T18:30:00Z");
    expect(nextSubPeriodEnd(start, end, start, 1, kolkata).toISOString()).toBe(
      "2027-01-31T18:30:00.000Z",
    );
  });

  it("DST zone: the boundary stays on local midnight across the change", () => {
    const ny: BillingMode = { anchor: "day", proration: "whole_day", timezone: "America/New_York" };
    // 1 Mar 2027 00:00 EST = 05:00Z; 1 Apr 2027 00:00 EDT = 04:00Z.
    const start = d("2027-03-01T05:00:00Z");
    const end = d("2028-03-01T05:00:00Z");
    expect(nextSubPeriodEnd(start, end, start, 1, ny).toISOString()).toBe(
      "2027-04-01T04:00:00.000Z",
    );
  });

  it("no sub-period when the flag is off or the term is too short", () => {
    const base = { billingPeriodUnit: "year", billingPeriod: 1, billingAnchorDay: 1 };
    const t0 = d("2027-01-01T00:00:00Z");
    const t1 = d("2028-01-01T00:00:00Z");
    expect(subPeriodFields({ ...base, billUsageMonthly: false }, t0, t1, utc)).toEqual({
      currentSubPeriodStart: null,
      currentSubPeriodEnd: null,
    });
    expect(
      subPeriodFields(
        { ...base, billUsageMonthly: true, billingPeriodUnit: "month", billingPeriod: 1 },
        t0,
        d("2027-02-01T00:00:00Z"),
        utc,
      ).currentSubPeriodEnd,
    ).toBeNull();
    expect(subPeriodFields({ ...base, billUsageMonthly: true }, t0, t1, utc)).toEqual({
      currentSubPeriodStart: t0,
      currentSubPeriodEnd: d("2027-02-01T00:00:00Z"),
    });
  });

  it("is due inside the term only", () => {
    const sub = {
      status: "active",
      currentPeriodStart: d("2027-01-01T00:00:00Z"),
      currentPeriodEnd: d("2028-01-01T00:00:00Z"),
      currentSubPeriodEnd: d("2027-02-01T00:00:00Z"),
    };
    expect(subPeriodDue(sub, d("2027-01-31T23:59:59Z"))).toBe(false);
    expect(subPeriodDue(sub, d("2027-02-01T00:00:00Z"))).toBe(true);
    expect(
      subPeriodDue({ ...sub, currentSubPeriodEnd: sub.currentPeriodEnd }, d("2028-02-01")),
    ).toBe(false);
    expect(subPeriodDue({ ...sub, status: "paused" }, d("2027-03-01"))).toBe(false);
  });

  it("the term window starts at the usage cursor and can close at a boundary", () => {
    const term = {
      currentPeriodStart: d("2027-01-01T00:00:00Z"),
      currentPeriodEnd: d("2028-01-01T00:00:00Z"),
    };
    expect(termUsageWindow(term)).toEqual({
      start: term.currentPeriodStart,
      end: term.currentPeriodEnd,
    });
    const cursor = d("2027-12-01T00:00:00Z");
    expect(termUsageWindow({ ...term, currentSubPeriodStart: cursor })).toEqual({
      start: cursor,
      end: term.currentPeriodEnd,
    });
    // A cursor left behind by an earlier term is ignored.
    expect(
      termUsageWindow({ ...term, currentSubPeriodStart: d("2026-12-01T00:00:00Z") })?.start,
    ).toEqual(term.currentPeriodStart);
    expect(
      termUsageWindow(
        { ...term, currentSubPeriodStart: d("2027-02-01T00:00:00Z") },
        { until: d("2027-03-01T00:00:00Z") },
      ),
    ).toEqual({ start: d("2027-02-01T00:00:00Z"), end: d("2027-03-01T00:00:00Z") });
  });
});

describe("commitment proration", () => {
  const t0 = d("2027-01-01T00:00:00Z");
  const full = d("2028-01-01T00:00:00Z");

  it("a full term owes the full amount", () => {
    expect(proratedCommitment([commitmentSegment(t0, 20_000_000n)], t0, full, full)).toBe(
      20_000_000n,
    );
  });

  it("an upgrade mid-term weighs each amount by its days (one rounding, half-up)", () => {
    const at = d("2027-07-01T00:00:00Z"); // 181 + 184 = 365 days
    const segs = appendSegment([commitmentSegment(t0, 20_000_000n)], at, 30_000_000n);
    expect(proratedCommitment(segs, t0, full, full)).toBe(25_041_096n);
  });

  it("an early end prorates to the end date", () => {
    const end = d("2027-04-01T00:00:00Z"); // day 90
    expect(proratedCommitment([commitmentSegment(t0, 20_000_000n)], t0, end, full)).toBe(
      4_931_507n,
    );
  });

  it("a short first term prorates against one whole interval", () => {
    const start = d("2027-01-15T00:00:00Z");
    const fullEnd = d("2028-01-15T00:00:00Z");
    const end = d("2028-01-01T00:00:00Z"); // 351 of 365 days
    expect(proratedCommitment([commitmentSegment(start, 36_500n)], start, end, fullEnd)).toBe(
      35_100n,
    );
  });

  it("a removed commitment owes nothing after it is removed", () => {
    const at = d("2027-07-01T00:00:00Z");
    const segs = appendSegment([commitmentSegment(t0, 36_500n)], at, null);
    expect(proratedCommitment(segs, t0, full, full)).toBe(18_100n);
  });

  it("an amount with no segments commits from the term start; empty segments waive it", () => {
    expect(termSegments({ commitmentAmountMinor: 5n, commitmentSegments: null }, t0)).toEqual([
      commitmentSegment(t0, 5n),
    ]);
    expect(termSegments({ commitmentAmountMinor: 5n, commitmentSegments: [] }, t0)).toEqual([]);
    expect(proratedCommitment([], t0, full, full)).toBe(0n);
  });
});
