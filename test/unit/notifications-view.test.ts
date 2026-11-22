import { describe, expect, it } from "vitest";
import {
  aboveText,
  dayLabel,
  deviceLabel,
  groupByDay,
  keyBytes,
  timeOfDay,
} from "../../dashboard/lib/notifications-view";

describe("aboveText", () => {
  it("reads Any amount with no limit", () => {
    expect(aboveText(undefined)).toBe("Any amount");
    expect(aboveText({ USD: 0 })).toBe("Any amount");
  });
  it("shows up to two limits in full, then a count", () => {
    expect(aboveText({ INR: 1_000_000, USD: 10_000 })).toBe("₹10,000 · $100.00");
    expect(aboveText({ INR: 1, USD: 1, EUR: 1 })).toBe("3 limits");
  });
});

describe("bell day groups", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  it("uses the row's business zone, not UTC", () => {
    // 20:00 UTC on 15 Nov is 01:30 on 16 Nov in Kolkata.
    expect(dayLabel("2026-11-15T20:00:00Z", "Asia/Kolkata", now)).toBe("Today");
    expect(dayLabel("2026-11-15T20:00:00Z", "UTC", now)).toBe("Yesterday");
    expect(dayLabel("2026-11-12T20:00:00Z", "UTC", now)).toBe("12 Nov 2026");
    expect(timeOfDay("2026-11-15T20:00:00Z", "Asia/Kolkata")).toBe("01:30");
  });
  it("groups consecutive rows by label", () => {
    const rows = [
      { created_at: "2026-11-16T09:00:00Z" },
      { created_at: "2026-11-16T08:00:00Z" },
      { created_at: "2026-11-15T08:00:00Z" },
    ];
    expect(groupByDay(rows, () => "UTC", now).map((g) => [g.label, g.rows.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
    ]);
  });
});

describe("deviceLabel", () => {
  it("names browser and system", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
  });
});

it("decodes a base64url VAPID key", () => {
  expect([...keyBytes("AQID_w")]).toEqual([1, 2, 3, 255]);
});
