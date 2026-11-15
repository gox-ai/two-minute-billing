import { describe, expect, it } from "vitest";
import {
  effectiveGraceRange,
  graceMinutesFrom,
  graceUnitFor,
  graceUnitMax,
} from "../../dashboard/lib/usage-grace";

// The save action scales the typed value with this; a mis-scaled number must never save.
describe("usage grace typed value", () => {
  it("scales to minutes up to 30 days", () => {
    expect(graceMinutesFrom("30", "days")).toBe(43_200);
    expect(graceMinutesFrom("720", "hours")).toBe(43_200);
    expect(graceMinutesFrom("43200", "minutes")).toBe(43_200);
    expect(graceMinutesFrom("0", "days")).toBe(0);
    expect(graceMinutesFrom(" 3 ", "hours")).toBe(180);
  });

  it("refuses a value over 30 days instead of saving it as minutes", () => {
    expect(graceMinutesFrom("31", "days")).toBeNull();
    expect(graceMinutesFrom("45", "days")).toBeNull();
    expect(graceMinutesFrom("721", "hours")).toBeNull();
    expect(graceMinutesFrom("43201", "minutes")).toBeNull();
  });

  it("refuses fractions, empty, negative and unknown units", () => {
    expect(graceMinutesFrom("1.5", "hours")).toBeNull();
    expect(graceMinutesFrom("2.5", "minutes")).toBeNull();
    expect(graceMinutesFrom("", "days")).toBeNull();
    expect(graceMinutesFrom(null, "days")).toBeNull();
    expect(graceMinutesFrom("-1", "minutes")).toBeNull();
    expect(graceMinutesFrom("1e3", "minutes")).toBeNull();
    expect(graceMinutesFrom("5", "weeks")).toBeNull();
    expect(graceMinutesFrom("5", null)).toBeNull();
  });

  it("caps the field per unit and shows stored minutes in the largest whole unit", () => {
    expect([graceUnitMax("minutes"), graceUnitMax("hours"), graceUnitMax("days")]).toEqual([
      43_200, 720, 30,
    ]);
    expect(graceUnitFor(43_200)).toBe("days");
    expect(graceUnitFor(180)).toBe("hours");
    expect(graceUnitFor(90)).toBe("minutes");
    expect(graceUnitFor(0)).toBe("minutes");
  });

  it("summarizes the wait after the per-plan cap", () => {
    expect(effectiveGraceRange(43_200, [{ unit: "month", count: 1 }])).toEqual({
      low: 20_160,
      high: 20_160,
    });
    expect(
      effectiveGraceRange(43_200, [
        { unit: "month", count: 1 },
        { unit: "year", count: 1 },
      ]),
    ).toEqual({ low: 20_160, high: 43_200 });
    expect(effectiveGraceRange(600, [])).toEqual({ low: 600, high: 600 });
  });
});
