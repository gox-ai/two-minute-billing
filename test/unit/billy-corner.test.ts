import { describe, expect, it } from "vitest";
import {
  clampFloat,
  DEFAULT_CORNER,
  nearestCorner,
  parseStoredCorner,
  storeCorner,
} from "../../dashboard/lib/billy-corner";

const area = { left: 248, top: 26, right: 1440, bottom: 900 };
const box = (left: number, top: number) => ({ left, top, width: 380, height: 400 });

describe("billy floating window", () => {
  it("reads only the four corners from storage", () => {
    expect(parseStoredCorner("top-left")).toEqual({ side: "left", vert: "top" });
    expect(parseStoredCorner(storeCorner({ side: "right", vert: "top" }))).toEqual({
      side: "right",
      vert: "top",
    });
    for (const bad of [null, "", "middle-left", "top", 3]) {
      expect(parseStoredCorner(bad)).toEqual(DEFAULT_CORNER);
    }
  });

  it("snaps to the quadrant of the window's centre, measured inside the page area", () => {
    expect(nearestCorner(box(260, 40), area)).toEqual({ side: "left", vert: "top" });
    expect(nearestCorner(box(1000, 480), area)).toEqual({ side: "right", vert: "bottom" });
    // Left of the viewport's middle (720) but right of the page area's middle (844).
    expect(nearestCorner(box(670, 480), area).side).toBe("right");
  });

  it("keeps a drag inside the area, less the margin", () => {
    expect(clampFloat(0, 0, box(0, 0), area)).toEqual({ x: 264, y: 42 });
    expect(clampFloat(5000, 5000, box(0, 0), area)).toEqual({ x: 1044, y: 484 });
  });
});
