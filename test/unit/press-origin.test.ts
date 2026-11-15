import { describe, expect, it } from "vitest";
import {
  ORIGIN_CLAMP,
  PRESS_MAX_AGE_MS,
  originPercent,
  pressPoint,
  settledBox,
  type Press,
} from "../../dashboard/lib/press-origin";

const box = { left: 400, top: 200, width: 500, height: 300 };

describe("originPercent", () => {
  it("maps a point inside the box to its percentage", () => {
    expect(originPercent({ x: 400, y: 200 }, box)).toEqual({ x: 0, y: 0 });
    expect(originPercent({ x: 650, y: 350 }, box)).toEqual({ x: 50, y: 50 });
    expect(originPercent({ x: 900, y: 500 }, box)).toEqual({ x: 100, y: 100 });
  });

  it("keeps a point just outside the box", () => {
    expect(originPercent({ x: 350, y: 530 }, box)).toEqual({ x: -10, y: 110 });
  });

  it("clamps a far press so the dialog does not fly in", () => {
    expect(originPercent({ x: 0, y: 2000 }, box)).toEqual({
      x: ORIGIN_CLAMP.min,
      y: ORIGIN_CLAMP.max,
    });
  });

  it("rounds to one decimal", () => {
    expect(originPercent({ x: 401, y: 201 }, box)).toEqual({ x: 0.2, y: 0.3 });
  });

  it("returns null for an empty box", () => {
    expect(originPercent({ x: 1, y: 1 }, { ...box, width: 0 })).toBeNull();
    expect(originPercent({ x: 1, y: 1 }, { ...box, height: Number.NaN })).toBeNull();
  });
});

describe("settledBox", () => {
  it("keeps the measured centre and uses the untransformed size", () => {
    // Measured at scale .9 about the centre: 450x270 around (650, 350).
    const scaled = { left: 425, top: 215, width: 450, height: 270 };
    expect(settledBox(scaled, 500, 300)).toEqual(box);
  });
});

describe("pressPoint", () => {
  const pointer: Press = { t: 1000, point: { x: 10, y: 20 }, box: null, target: null };
  const key: Press = {
    t: 1000,
    point: null,
    box: { left: 100, top: 40, width: 80, height: 32 },
    target: null,
  };

  it("uses the pointer position", () => {
    expect(pressPoint(pointer, 1200)).toEqual({ x: 10, y: 20 });
  });

  it("uses the control's centre for a key press", () => {
    expect(pressPoint(key, 1200)).toEqual({ x: 140, y: 56 });
  });

  it("falls back to the centre for a stale, missing or future press", () => {
    expect(pressPoint(pointer, 1000 + PRESS_MAX_AGE_MS + 1)).toBeNull();
    expect(pressPoint(null, 1000)).toBeNull();
    expect(pressPoint(pointer, 999)).toBeNull();
  });

  it("falls back to the centre for a key press with no box", () => {
    expect(pressPoint({ ...key, box: null }, 1200)).toBeNull();
    expect(pressPoint({ ...key, box: { left: 5, top: 5, width: 0, height: 0 } }, 1200)).toBeNull();
  });
});
