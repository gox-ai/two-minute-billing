import { describe, expect, it } from "vitest";
import {
  EASE_GLIDE,
  PRESS,
  PULL,
  RUBBER,
  SWIPE,
  bezierTimeFor,
  isPreciseWheel,
  lockAxis,
  nativeGestures,
  pressDelay,
  pullArmed,
  pullProgress,
  refreshDone,
  rubberband,
  rubberbandInverse,
  swipeCommits,
  swipeProgress,
  velocityOf,
} from "../../dashboard/lib/gestures";

describe("rubberband", () => {
  it("starts near 1:1, then resists, and never reaches the dimension", () => {
    expect(rubberband(1, 600)).toBeCloseTo(0.55, 2);
    expect(rubberband(100, 600)).toBeLessThan(100);
    expect(rubberband(200, 600) - rubberband(100, 600)).toBeLessThan(rubberband(100, 600));
    expect(rubberband(1e7, 600)).toBeLessThan(600);
  });

  it("keeps the sign and is zero at zero", () => {
    expect(rubberband(-80, 240)).toBeCloseTo(-rubberband(80, 240), 9);
    expect(rubberband(0, 240)).toBe(0);
    expect(rubberband(50, 0)).toBe(0);
  });

  it("inverts, so a band caught mid-settle resumes where it is", () => {
    for (const d of [-300, -20, 5, 80, 400]) {
      expect(rubberbandInverse(rubberband(d, 240), 240)).toBeCloseTo(d, 6);
    }
  });
});

describe("isPreciseWheel", () => {
  it("takes trackpad pixels and refuses mouse notches", () => {
    expect(isPreciseWheel({ deltaMode: 0, deltaY: 3.5, wheelDeltaY: -10 })).toBe(true);
    expect(isPreciseWheel({ deltaMode: 0, deltaY: 100, wheelDeltaY: -120 })).toBe(false);
    expect(isPreciseWheel({ deltaMode: 0, deltaY: 53.3, wheelDeltaY: -120 })).toBe(false);
    expect(isPreciseWheel({ deltaMode: 1, deltaY: 3 })).toBe(false);
  });
});

describe("swipe back", () => {
  it("locks an axis only past the slop", () => {
    expect(lockAxis(3, 2)).toBeNull();
    expect(lockAxis(12, 3)).toBe("x");
    expect(lockAxis(9, 9)).toBe("y");
  });

  it("clamps progress to the track", () => {
    expect(swipeProgress(-20, 240)).toBe(0);
    expect(swipeProgress(120, 240)).toBe(0.5);
    expect(swipeProgress(999, 240)).toBe(1);
  });

  it("commits past half way, or on a flick, and never while moving back", () => {
    expect(swipeCommits(SWIPE.commitProgress, 0)).toBe(true);
    expect(swipeCommits(0.3, 0)).toBe(false);
    expect(swipeCommits(0.15, 0.6)).toBe(true);
    expect(swipeCommits(0.05, 2)).toBe(false);
    expect(swipeCommits(0.9, -0.5)).toBe(false);
  });

  it("measures velocity over the last 100ms only", () => {
    const s = [
      { t: 0, x: 0 },
      { t: 500, x: 10 },
      { t: 550, x: 30 },
      { t: 600, x: 50 },
    ];
    expect(velocityOf(s)).toBeCloseTo(0.4, 6);
    expect(velocityOf([])).toBe(0);
  });

  it("continues the pop from the finger: time in reaches the same progress", () => {
    const [x1, y1, x2, y2] = EASE_GLIDE;
    // Out of the curve at the returned time fraction, by bisection on its x.
    const out = (t: number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 50; i++) {
        const m = (lo + hi) / 2;
        const x = 3 * x1 * m * (1 - m) ** 2 + 3 * x2 * m * m * (1 - m) + m ** 3;
        if (x < t) lo = m;
        else hi = m;
      }
      const m = (lo + hi) / 2;
      return 3 * y1 * m * (1 - m) ** 2 + 3 * y2 * m * m * (1 - m) + m ** 3;
    };
    for (const p of [0.1, 0.3, 0.5, 0.8])
      expect(out(bezierTimeFor(p, EASE_GLIDE))).toBeCloseTo(p, 4);
    expect(bezierTimeFor(0, EASE_GLIDE)).toBe(0);
    expect(bezierTimeFor(1, EASE_GLIDE)).toBe(1);
    // The glide curve front-loads: half the distance comes well before half the time.
    expect(bezierTimeFor(0.5, EASE_GLIDE)).toBeLessThan(0.3);
  });
});

describe("pull to refresh", () => {
  it("is zero at rest and for a pull the wrong way", () => {
    expect(pullProgress(0, 600)).toBe(0);
    expect(pullProgress(-50, 600)).toBe(0);
  });

  it("arms where the band has moved the content armAt px", () => {
    for (const dim of [RUBBER.wheelDimension, RUBBER.touchDimension]) {
      const at = rubberbandInverse(PULL.armAt, dim);
      expect(pullArmed(pullProgress(at - 1, dim))).toBe(false);
      expect(pullArmed(pullProgress(at + 1, dim))).toBe(true);
    }
  });

  it("takes a deliberate pull to arm, longer on a trackpad than a finger", () => {
    const wheel = rubberbandInverse(PULL.armAt, RUBBER.wheelDimension);
    const touch = rubberbandInverse(PULL.armAt, RUBBER.touchDimension);
    expect(touch).toBeGreaterThan(100);
    expect(wheel).toBeGreaterThan(touch);
    expect(wheel).toBeLessThan(200);
  });

  it("rises with the pull and stops at maxProgress", () => {
    expect(pullProgress(80, 600)).toBeLessThan(pullProgress(120, 600));
    expect(pullProgress(1e6, 600)).toBe(PULL.maxProgress);
  });

  it("spins at least minMs, waits for pending, and never past the timeout", () => {
    expect(refreshDone(0, false)).toBe(false);
    expect(refreshDone(PULL.minMs - 1, false)).toBe(false);
    expect(refreshDone(PULL.minMs, false)).toBe(true);
    expect(refreshDone(PULL.minMs * 4, true)).toBe(false);
    expect(refreshDone(PULL.timeoutMs, true)).toBe(true);
  });
});

describe("row press", () => {
  it("waits on touch and pen, never on a mouse", () => {
    expect(pressDelay("mouse")).toBe(0);
    expect(pressDelay("touch")).toBe(PRESS.touchDelayMs);
    expect(pressDelay("pen")).toBe(PRESS.touchDelayMs);
  });
});

describe("nativeGestures", () => {
  const chrome = { brands: [] };
  it("leaves Apple platforms to their own bounce and history swipe", () => {
    const iphone = nativeGestures({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    });
    expect(iphone).toEqual({ elasticOverscroll: true, ownsHistorySwipe: true });
    const ipad = nativeGestures({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      maxTouchPoints: 5,
    });
    expect(ipad).toEqual({ elasticOverscroll: true, ownsHistorySwipe: true });
    const safari = nativeGestures({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(safari).toEqual({ elasticOverscroll: true, ownsHistorySwipe: true });
  });

  it("bounces natively on a Mac in Chromium, but the page owns the swipe there", () => {
    const g = nativeGestures({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      userAgentData: chrome,
    });
    expect(g).toEqual({ elasticOverscroll: true, ownsHistorySwipe: false });
  });

  it("runs both on Chromium elsewhere, and only the band in other engines", () => {
    const win = nativeGestures({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      userAgentData: chrome,
    });
    expect(win).toEqual({ elasticOverscroll: false, ownsHistorySwipe: false });
    const firefox = nativeGestures({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    });
    expect(firefox).toEqual({ elasticOverscroll: false, ownsHistorySwipe: true });
  });
});
