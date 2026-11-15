import { describe, expect, it } from "vitest";
import { barStyle, drawKey } from "../../dashboard/lib/chart-draw";

describe("drawKey", () => {
  it("is stable for the same data and changes with it", () => {
    expect(drawKey([1, 2, 3])).toBe(drawKey([1, 2, 3]));
    expect(drawKey([1, 2, 3])).not.toBe(drawKey([1, 2, 4]));
    expect(drawKey([12, 3])).not.toBe(drawKey([1, 23]));
    expect(drawKey([null, 1])).not.toBe(drawKey([0, 1]));
  });
});

describe("barStyle", () => {
  it("caps the stagger at the twelfth bar", () => {
    expect(barStyle(50, 3)).toMatchObject({ width: "50%", "--bar-turn": 3 });
    expect(barStyle("12.5%", 40)).toMatchObject({ width: "12.5%", "--bar-turn": 11 });
  });
});
