import { describe, expect, it } from "vitest";
import { resolveTheme, wipeOrigin, wipeRadius } from "../../dashboard/lib/theme-wipe";

describe("wipeRadius", () => {
  it("reaches the farthest corner from any point", () => {
    // From the top-left corner the far corner is the diagonal.
    expect(wipeRadius(0, 0, 300, 400)).toBe(500);
    // From the bottom-right corner, the same diagonal the other way.
    expect(wipeRadius(300, 400, 300, 400)).toBe(500);
    // From the centre, half the diagonal.
    expect(wipeRadius(150, 200, 300, 400)).toBe(250);
    // A rail control near the bottom-left: the top-right corner is farthest.
    expect(wipeRadius(30, 760, 1280, 800)).toBeCloseTo(Math.hypot(1250, 760));
  });

  it("covers every corner", () => {
    const [w, h, x, y] = [1440, 900, 212, 845];
    const r = wipeRadius(x, y, w, h);
    const corners: Array<[number, number]> = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ];
    for (const [cx, cy] of corners) expect(Math.hypot(cx - x, cy - y)).toBeLessThanOrEqual(r);
  });
});

describe("resolveTheme", () => {
  it("keeps an explicit pick and follows the device for system", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("wipeOrigin", () => {
  const rect = { left: 100, top: 700, width: 40, height: 20 };
  it("starts at the pointer for a pointer press", () => {
    expect(wipeOrigin(rect, { clientX: 105, clientY: 712, detail: 1 })).toEqual({ x: 105, y: 712 });
  });
  it("starts at the control's centre for a keyboard press", () => {
    expect(wipeOrigin(rect, { clientX: 0, clientY: 0, detail: 0 })).toEqual({ x: 120, y: 710 });
    expect(wipeOrigin(rect)).toEqual({ x: 120, y: 710 });
  });
  it("has no origin without a control or a pointer", () => {
    expect(wipeOrigin(null)).toBeNull();
  });
});
