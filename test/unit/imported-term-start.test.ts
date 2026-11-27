import { describe, it, expect } from "vitest";
import { importedTermStart } from "@/modules/migration/import";

const d = (iso: string) => new Date(iso);
const NOW = d("2026-09-17T00:00:00Z");

describe("importedTermStart", () => {
  it("keeps the source's term start when it has one", () => {
    const start = d("2026-09-01T00:00:00Z");
    expect(
      importedTermStart({ currentTermStart: start }, d("2026-10-01T00:00:00Z"), "month", 1, NOW),
    ).toEqual(start);
  });

  it("a trial cancelled at trial end starts at the trial, not at import time", () => {
    const s = {
      trialStart: d("2025-07-22T18:30:00Z"),
      trialEnd: d("2025-08-05T18:29:59Z"),
      startedAt: d("2025-07-22T18:30:00Z"),
    };
    expect(importedTermStart(s, d("2025-08-05T18:30:00Z"), "month", 1, NOW)).toEqual(s.trialStart);
  });

  it("a paid subscription cancelled later starts one interval before the end", () => {
    const s = {
      trialStart: d("2025-01-01T00:00:00Z"),
      trialEnd: d("2025-01-15T00:00:00Z"),
      startedAt: d("2025-01-01T00:00:00Z"),
    };
    expect(importedTermStart(s, d("2025-06-15T00:00:00Z"), "month", 1, NOW)).toEqual(
      d("2025-05-15T00:00:00Z"),
    );
  });

  it("never starts before the subscription began", () => {
    const s = { startedAt: d("2025-06-01T00:00:00Z") };
    expect(importedTermStart(s, d("2025-06-10T00:00:00Z"), "year", 1, NOW)).toEqual(s.startedAt);
  });

  it("never starts after the term ends", () => {
    expect(importedTermStart({}, d("2025-08-05T00:00:00Z"), "month", 1, NOW)).toEqual(
      d("2025-07-05T00:00:00Z"),
    );
    const s = { startDate: d("2026-12-01T00:00:00Z") };
    expect(importedTermStart(s, d("2026-11-01T00:00:00Z"), "month", 1, NOW)).toEqual(
      d("2026-11-01T00:00:00Z"),
    );
  });
});
