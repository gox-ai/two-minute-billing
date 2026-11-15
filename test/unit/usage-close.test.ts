import { describe, expect, it } from "vitest";
import {
  USAGE_CLOSE_BASE_MINUTES,
  USAGE_GRACE_MAX_MINUTES,
  effectiveGraceByInterval,
  effectiveUsageGraceMinutes,
  minutesBetween,
  nominalIntervalMinutes,
  usageCloseAt,
} from "@/modules/subscriptions/usage-close";

describe("usage grace window", () => {
  it("caps the grace at half the plan interval", () => {
    expect(effectiveUsageGraceMinutes(USAGE_GRACE_MAX_MINUTES, { unit: "day" })).toBe(720);
    expect(effectiveUsageGraceMinutes(USAGE_GRACE_MAX_MINUTES, { unit: "week" })).toBe(5040);
    // A month counts 28 days.
    expect(effectiveUsageGraceMinutes(USAGE_GRACE_MAX_MINUTES, { unit: "month" })).toBe(20160);
    expect(effectiveUsageGraceMinutes(USAGE_GRACE_MAX_MINUTES, { unit: "year" })).toBe(43200);
    expect(effectiveUsageGraceMinutes(43200, { unit: "day", count: 3 })).toBe(2160);
  });

  it("caps the grace at half the new term", () => {
    expect(effectiveUsageGraceMinutes(180, { unit: "month" }, 100)).toBe(50);
    expect(effectiveUsageGraceMinutes(180, { unit: "month" }, 30 * 1440)).toBe(180);
  });

  it("zero stays zero and negatives clamp", () => {
    expect(effectiveUsageGraceMinutes(0, { unit: "day" })).toBe(0);
    expect(effectiveUsageGraceMinutes(-5, { unit: "day" })).toBe(0);
  });

  it("closes at boundary + base + grace", () => {
    const b = new Date("2026-03-01T00:00:00Z");
    expect(usageCloseAt(b, 180).toISOString()).toBe("2026-03-01T03:06:00.000Z");
    expect(usageCloseAt(b, 0).getTime() - b.getTime()).toBe(USAGE_CLOSE_BASE_MINUTES * 60_000);
    expect(minutesBetween(b, usageCloseAt(b, 180))).toBe(186);
  });

  it("reports the effective value per interval", () => {
    expect(
      effectiveGraceByInterval(43200, [
        { unit: "day", count: 1 },
        { unit: "year", count: 1 },
      ]),
    ).toEqual([
      { unit: "day", count: 1, minutes: 720, capped: true },
      { unit: "year", count: 1, minutes: 43200, capped: false },
    ]);
    expect(nominalIntervalMinutes(null)).toBe(28 * 1440);
  });
});
