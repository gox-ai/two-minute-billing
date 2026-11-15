import { describe, expect, it } from "vitest";
import {
  unitGrantLimitsBody,
  unitLimitInput,
  unitLimitSteps,
} from "../../dashboard/lib/unit-grant-limits";

const credit = { unit: "credit", plural: "credits", decimals: 1, max: "", alert: "" };

describe("unit grant limits: typed units to the smallest step", () => {
  it("converts with the unit's decimals", () => {
    expect(unitLimitSteps("100", 1)).toBe(1000);
    expect(unitLimitSteps("12.5", 2)).toBe(1250);
    expect(unitLimitSteps(" 7 ", 0)).toBe(7);
  });
  it("empty is no limit, and 0 is a limit", () => {
    expect(unitLimitSteps("", 2)).toBeNull();
    expect(unitLimitSteps("0", 0)).toBe(0);
    expect(unitLimitSteps("0.0", 1)).toBe(0);
  });
  it("refuses more decimal places than the unit has, and text that is not a number", () => {
    expect(unitLimitSteps("1.5", 0)).toBeUndefined();
    expect(unitLimitSteps("0.00", 1)).toBeUndefined();
    expect(unitLimitSteps("-1", 0)).toBeUndefined();
    expect(unitLimitSteps("1e3", 0)).toBeUndefined();
  });
  it("shows a stored limit as it was typed", () => {
    expect(unitLimitInput(1250, 2)).toBe("12.5");
    expect(unitLimitInput(1000, 1)).toBe("100");
    expect(unitLimitInput(5, 2)).toBe("0.05");
    expect(unitLimitInput(0, 2)).toBe("0");
    expect(unitLimitInput(42, 0)).toBe("42");
    expect(unitLimitInput(null, 2)).toBe("");
    for (const [steps, decimals] of [
      [1, 4],
      [10_000, 4],
      [123_456, 3],
    ] as const)
      expect(unitLimitSteps(unitLimitInput(steps, decimals), decimals)).toBe(steps);
  });
});

describe("unit grant limits: the value the form sends", () => {
  it("sets both bounds in the smallest step", () => {
    const r = unitGrantLimitsBody([{ ...credit, max: "100", alert: "50" }], {});
    expect(r).toEqual({
      ok: true,
      value: { credit: { max_units: 1000, alert_above_units: 500 } },
    });
  });
  it("one empty field is null, both empty removes the unit", () => {
    expect(unitGrantLimitsBody([{ ...credit, alert: "5" }], {})).toEqual({
      ok: true,
      value: { credit: { max_units: null, alert_above_units: 50 } },
    });
    expect(unitGrantLimitsBody([credit], { credit: { max_units: 10 } })).toEqual({
      ok: true,
      value: {},
    });
  });
  it("keeps the stored limit of a unit that has no fields", () => {
    const r = unitGrantLimitsBody([{ ...credit, max: "1" }], { render: { max_units: 9 } });
    expect(r).toEqual({
      ok: true,
      value: { render: { max_units: 9 }, credit: { max_units: 10, alert_above_units: null } },
    });
  });
  it("the alert amount must not be more than the maximum; equal is allowed", () => {
    expect(unitGrantLimitsBody([{ ...credit, max: "5", alert: "5.1" }], {})).toEqual({
      ok: false,
      errors: {
        unit_grant_alert_credit: "The alert amount for credits must not be more than the maximum.",
      },
    });
    expect(unitGrantLimitsBody([{ ...credit, max: "5", alert: "5" }], {}).ok).toBe(true);
  });
  it("names the field that is not a number, with the unit's decimals", () => {
    expect(unitGrantLimitsBody([{ ...credit, max: "1.25" }], {})).toEqual({
      ok: false,
      errors: {
        unit_grant_max_credit:
          "Enter the maximum for credits as a number with up to 1 decimal place.",
      },
    });
    expect(
      unitGrantLimitsBody(
        [{ ...credit, unit: "render", plural: "renders", decimals: 0, alert: "1.5" }],
        {},
      ),
    ).toEqual({
      ok: false,
      errors: { unit_grant_alert_render: "Enter the alert amount for renders as a whole number." },
    });
  });
});
