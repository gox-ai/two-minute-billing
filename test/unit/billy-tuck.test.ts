import { describe, expect, it } from "vitest";
import { TUCK_SLOP, nextAnchor, tuckBubble } from "../../dashboard/lib/billy-tuck";

const at = (top: number, anchor: number) => ({
  top,
  anchor,
  clientHeight: 800,
  scrollHeight: 3000,
});

describe("tuckBubble", () => {
  it("leaves when the page scrolls down past the slop", () => {
    expect(tuckBubble(false, at(400, 300))).toBe(true);
  });
  it("comes back when the page scrolls up", () => {
    expect(tuckBubble(true, at(300, 400))).toBe(false);
  });
  it("keeps the last decision for a small movement", () => {
    expect(tuckBubble(true, at(403, 400))).toBe(true);
    expect(tuckBubble(false, at(403, 400))).toBe(false);
  });
  it("shows at the top and at the end, where the page keeps room for it", () => {
    expect(tuckBubble(true, at(0, 0))).toBe(false);
    expect(tuckBubble(true, at(2200, 1800))).toBe(false);
  });
  it("ignores a rubber-band overscroll above the top", () => {
    expect(tuckBubble(true, at(-30, 0))).toBe(false);
  });
});

describe("nextAnchor", () => {
  it("follows only once the page moved past the slop", () => {
    expect(nextAnchor(at(400 + TUCK_SLOP, 400))).toBe(400);
    expect(nextAnchor(at(400 + TUCK_SLOP + 1, 400))).toBe(400 + TUCK_SLOP + 1);
  });
  it("adds up a slow scroll until it decides", () => {
    let anchor = 100;
    let tucked = false;
    for (let top = 102; top <= 130; top += 2) {
      const p = at(top, anchor);
      tucked = tuckBubble(tucked, p);
      anchor = nextAnchor(p);
    }
    expect(tucked).toBe(true);
  });
});
