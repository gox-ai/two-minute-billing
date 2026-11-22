import { describe, expect, it } from "vitest";
import { applyCreditsPlan, applyCreditsRefusal } from "../../dashboard/lib/apply-credits";

describe("applyCreditsPlan", () => {
  it("uses refundable credit first, then excess payments, up to the amount due", () => {
    expect(applyCreditsPlan(10000, 3000, 9000)).toEqual({
      refundableMinor: 3000,
      excessMinor: 7000,
      totalMinor: 10000,
      dueAfterMinor: 0,
    });
  });
  it("leaves the rest due when the credit is smaller", () => {
    expect(applyCreditsPlan(10000, 0, 2500)).toEqual({
      refundableMinor: 0,
      excessMinor: 2500,
      totalMinor: 2500,
      dueAfterMinor: 7500,
    });
  });
  it("applies nothing with no credit or nothing due", () => {
    expect(applyCreditsPlan(10000, 0, 0).totalMinor).toBe(0);
    expect(applyCreditsPlan(0, 500, 500).totalMinor).toBe(0);
  });
});

describe("applyCreditsRefusal", () => {
  it("keeps the engine's words for a payment in progress", () => {
    expect(applyCreditsRefusal(409, "A payment of ₹100.00 is in progress.")).toBe(
      "A payment of ₹100.00 is in progress.",
    );
  });
  it("says what changed and what to do for a refused amount", () => {
    expect(
      applyCreditsRefusal(400, "Only 100 minor units of refundable credit are available"),
    ).toMatch(/^We could not apply credits\. .* Reload the page/);
  });
});
