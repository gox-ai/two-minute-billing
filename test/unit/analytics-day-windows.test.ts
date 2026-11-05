import { describe, expect, it } from "vitest";
import { resolveWindow } from "../../src/modules/metrics/daily/public-query";

const at = (range: string, today: string) =>
  resolveWindow({ range, timezone: "Asia/Kolkata", timezoneSource: "business", today });

describe("today / yesterday windows", () => {
  it("today is the one current day", () => {
    expect(at("today", "2026-10-02")).toMatchObject({
      name: "today",
      start: "2026-10-02",
      end: "2026-10-02",
    });
  });

  it("yesterday crosses a year boundary", () => {
    expect(at("yesterday", "2026-01-01")).toMatchObject({ start: "2025-12-31", end: "2025-12-31" });
  });
});
