import { describe, expect, it } from "vitest";
import {
  axisMinInterval,
  blankSeriesNote,
  isBlankSeries,
  sparkRange,
  successRates,
  waterfallFloor,
} from "../../dashboard/components/charts/axis";
import { measureValueTight } from "../../dashboard/components/analytics/format";

describe("isBlankSeries", () => {
  it("is blank when every bucket is zero or a gap", () => {
    expect(isBlankSeries([0, null, 0, undefined])).toBe(true);
    expect(isBlankSeries([])).toBe(true);
  });
  it("is not blank with one non-zero bucket, negative included", () => {
    expect(isBlankSeries([0, 0, 3])).toBe(false);
    expect(isBlankSeries([null, -2])).toBe(false);
  });
});

describe("axisMinInterval", () => {
  it("never ticks a count in halves", () => {
    expect(axisMinInterval("count")).toBe(1);
  });
  it("never ticks money below one unit of its currency", () => {
    expect(axisMinInterval("money", "USD")).toBe(100);
    expect(axisMinInterval("money", "JPY")).toBe(1);
  });
  it("leaves a percent axis to the chart", () => {
    expect(axisMinInterval("percent")).toBeUndefined();
  });
});

describe("blankSeriesNote", () => {
  it("reads the series label as a sentence and keeps an acronym", () => {
    expect(blankSeriesNote("Credits used")).toBe("No credits used in this period.");
    expect(blankSeriesNote("MRR lost")).toBe("No MRR lost in this period.");
  });
});

describe("waterfallFloor", () => {
  it("starts at zero when the movement still reads from there", () => {
    expect(waterfallFloor(100, 180)).toEqual({ floor: 0, broken: false });
  });
  it("breaks the axis two swings under the lowest total for a small movement", () => {
    const { floor, broken } = waterfallFloor(253.5, 314.9);
    expect(broken).toBe(true);
    expect(floor).toBeCloseTo(253.5 - 2 * 61.4, 5);
  });
  it("never floats a book that is zero or negative", () => {
    expect(waterfallFloor(-10, 50)).toEqual({ floor: -10, broken: false });
  });
});

describe("measureValueTight", () => {
  it("rounds money to three significant figures", () => {
    expect(measureValueTight(13_109_000, "money", "INR")).toBe("₹131K");
    expect(measureValueTight(2_733_000, "money", "INR")).toBe("₹27.3K");
    expect(measureValueTight(83_250, "money", "INR")).toBe("₹833");
  });
  it("keeps an absent value absent and other units whole", () => {
    expect(measureValueTight(null, "money", "USD")).toBe("—");
    expect(measureValueTight(1234, "count", null)).toBe("1,234");
  });
});

describe("successRates", () => {
  it("gives a bucket with no attempts no rate, not a zero one", () => {
    expect(successRates([4, 0, null, 2], [1, 0, null, null])).toEqual([0.75, null, null, 1]);
  });
});

describe("sparkRange", () => {
  it("keeps the data's own range by default, and a flat run at the floor", () => {
    expect(sparkRange([2, 5, 3])).toEqual({ lo: 2, hi: 5 });
    expect(sparkRange([3, 3])).toEqual({ lo: 3, hi: 4 });
  });
  it("never draws a rate narrower than its minimum span", () => {
    expect(sparkRange([0.99, 1], 0.2)).toEqual({ lo: 0.8, hi: 1 });
    expect(sparkRange([1, 1], 0.2)).toEqual({ lo: 0.8, hi: 1 });
    expect(sparkRange([0.5, 1], 0.2)).toEqual({ lo: 0.5, hi: 1 });
  });
});
