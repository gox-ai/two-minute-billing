import { describe, it, expect } from "vitest";
import {
  E12,
  faceMinorFor,
  formatSteps,
  hasRate,
  isUnrated,
  MONEY_RATE,
  stepsForMinor,
  unitRate,
} from "@/modules/credits/units";
import { unitsLeftAfterDraw } from "@/modules/credits/balance";

const unit = (minorPerUnitE12: bigint | null, decimals = 0) => ({ minorPerUnitE12, decimals });

describe("a credit unit with no rate", () => {
  it("reads as rate 0 and has no face value", () => {
    const rate = unitRate(unit(null, 1));
    expect(hasRate(rate)).toBe(false);
    expect(faceMinorFor(150n, rate)).toBe(0n);
    expect(isUnrated(unit(null))).toBe(true);
  });

  it("never converts money to units", () => {
    expect(() => stepsForMinor(100n, unitRate(unit(null)))).toThrow(RangeError);
  });

  it("leaves money and a unit with a rate as they were", () => {
    expect(isUnrated(null)).toBe(false);
    expect(unitRate(null)).toBe(MONEY_RATE);
    const rate = unitRate(unit(60n * E12, 1));
    expect(hasRate(rate)).toBe(true);
    expect(isUnrated(unit(60n * E12))).toBe(false);
    // 1 credit = 60 minor; 15.0 credits = 150 steps.
    expect(faceMinorFor(150n, rate)).toBe(900n);
    expect(stepsForMinor(900n, rate)).toBe(150n);
  });

  it("counts in steps of the unit's decimals", () => {
    // decimals 1: half a credit is 5 steps, 15 credits are 150.
    expect(formatSteps(5n, 1)).toBe("0.5");
    expect(formatSteps(150n, 1)).toBe("15");
    expect(formatSteps(12345n, 4)).toBe("1.2345");
  });
});

describe("unitsLeftAfterDraw", () => {
  it("keeps every unit of a grant with no rate, whatever money usage drew", () => {
    const g = { unit: unitRate(unit(null, 1)), unitsLeft: 150n, faceLeft: 0n };
    expect(unitsLeftAfterDraw(g, 0n)).toBe(150n);
  });

  it("takes the drawn money off a unit with a rate, as before", () => {
    const g = { unit: unitRate(unit(60n * E12, 1)), unitsLeft: 150n, faceLeft: 900n };
    expect(unitsLeftAfterDraw(g, 0n)).toBe(150n);
    expect(unitsLeftAfterDraw(g, 300n)).toBe(100n);
    expect(unitsLeftAfterDraw(g, 900n)).toBe(0n);
    expect(unitsLeftAfterDraw(g, 5000n)).toBe(0n);
  });

  it("treats money as one step per minor unit", () => {
    expect(unitsLeftAfterDraw({ unit: null, unitsLeft: 500n, faceLeft: 500n }, 120n)).toBe(380n);
  });
});

describe("amounts in sentences people read", () => {
  it("groups the whole part only", async () => {
    const { groupDigits, unitAmountText } = await import("@/modules/credits/grant-limits");
    expect(groupDigits("999")).toBe("999");
    expect(groupDigits("1000")).toBe("1,000");
    expect(groupDigits("12500.5")).toBe("12,500.5");
    expect(groupDigits("1234567.123456")).toBe("1,234,567.123456");
    const unit = { name: "API call", pluralName: "API calls", decimals: 1 };
    expect(unitAmountText(125000n, unit)).toBe("12,500 API calls");
    expect(unitAmountText(10n, unit)).toBe("1 API call");
  });
});
