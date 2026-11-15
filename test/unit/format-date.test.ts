import { describe, it, expect } from "vitest";
// Relative: the root `@/` alias points at src/, and this module has no imports.
import { fmtAxisDate, fmtDate, fmtDateTime, fmtRange } from "../../dashboard/lib/format-date";

describe("format-date", () => {
  it("renders one shape in the business zone", () => {
    expect(fmtDate("2026-11-09T20:31:00Z", "Asia/Kolkata")).toBe("10 Nov 2026");
    expect(fmtDateTime("2026-11-09T20:31:00Z", "Asia/Kolkata")).toBe("10 Nov 2026, 02:01");
    expect(fmtDateTime("2026-11-09T20:31:00Z", null)).toBe("9 Nov 2026, 20:31");
  });

  it("uses three-letter months, never Sept", () => {
    expect(fmtDate("2026-09-26T12:00:00Z", "UTC")).toBe("26 Sep 2026");
  });

  it("keeps a calendar date on its day in any zone", () => {
    expect(fmtDate("2026-10-12", "America/Los_Angeles")).toBe("12 Oct 2026");
    expect(fmtAxisDate("2026-10-12", "Pacific/Kiritimati")).toBe("12 Oct");
  });

  it("states the year once in a range", () => {
    expect(fmtRange("2026-10-12", "2026-11-10")).toBe("12 Oct – 10 Nov 2026");
    expect(fmtRange("2025-10-12", "2026-11-10")).toBe("12 Oct 2025 – 10 Nov 2026");
    expect(fmtRange("2026-11-10", "2026-11-10")).toBe("10 Nov 2026");
    expect(fmtRange(null, "2026-11-10")).toBe("10 Nov 2026");
  });

  it("writes nothing as a dash, and survives a bad zone", () => {
    expect(fmtDate(null, "UTC")).toBe("—");
    expect(fmtDate("not a date", "UTC")).toBe("—");
    expect(fmtDate("2026-11-10T00:00:00Z", "Not/AZone")).toBe("10 Nov 2026");
  });
});
