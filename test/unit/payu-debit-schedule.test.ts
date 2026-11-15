import { describe, it, expect } from "vitest";
import { payuDebitSchedule } from "@/providers/payu";

/** An instant on a fixed day, in IST. */
const ist = (hhmm: string, day = "2026-11-11") => new Date(`${day}T${hhmm}:00+05:30`);
const hoursAfter = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 3_600_000;

describe("payuDebitSchedule: the debit day keeps at least an hour", () => {
  it("a card notice sent in the day is due 24 h later, the same day", () => {
    const now = ist("10:00");
    const s = payuDebitSchedule(now, now, 24, false);
    expect(hoursAfter(now, s.executableAfter)).toBe(24);
    expect(s.debitDate).toBe("2026-11-12");
  });

  it("a card notice sent after 23:00 IST moves to the start of the day after", () => {
    const now = ist("23:15");
    const s = payuDebitSchedule(now, now, 24, false);
    expect(s.executableAfter.toISOString()).toBe(ist("00:00", "2026-11-13").toISOString());
    expect(s.debitDate).toBe("2026-11-13");
    expect(hoursAfter(now, s.executableAfter)).toBe(24.75);
  });

  it("23:00 IST exactly still leaves the hour", () => {
    const now = ist("23:00");
    const s = payuDebitSchedule(now, now, 24, false);
    expect(hoursAfter(now, s.executableAfter)).toBe(24);
  });

  it("a UPI notice is due no sooner than 25 h, clear of NPCI's blocked hours", () => {
    for (const hhmm of ["09:00", "12:00", "18:00", "23:30"]) {
      const now = ist(hhmm);
      const s = payuDebitSchedule(now, now, 25, true);
      const at = new Date(s.executableAfter.getTime() + 5.5 * 3_600_000);
      const m = at.getUTCHours() * 60 + at.getUTCMinutes();
      expect(hoursAfter(now, s.executableAfter)).toBeGreaterThanOrEqual(25);
      expect((m >= 600 && m < 780) || (m >= 1020 && m < 1290)).toBe(false);
    }
  });
});
