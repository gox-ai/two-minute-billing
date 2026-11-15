import { describe, expect, it } from "vitest";
import {
  MARGIN,
  box,
  inflate,
  isClear,
  overlap,
  paintsBox,
  placeBeside,
  placeCard,
  placeSheet,
  reach,
  sideOrder,
  type Box,
  type Paint,
} from "../../dashboard/lib/coach-placement";

const VP = box(0, 0, 1440, 900);
const CARD = { width: 340, height: 200 };
const rectOf = (s: { left: number; top: number }, c = CARD) =>
  box(s.left, s.top, c.width, c.height);
const inside = (r: Box, vp: Box) =>
  r.left >= vp.left + MARGIN &&
  r.top >= vp.top + MARGIN &&
  r.right <= vp.right - MARGIN &&
  r.bottom <= vp.bottom - MARGIN;

describe("placeCard", () => {
  it("tries the preferred side, its opposite, below, then above", () => {
    expect(sideOrder("right")).toEqual(["right", "left", "bottom", "top"]);
    expect(sideOrder("bottom")).toEqual(["bottom", "top"]);
  });

  it("puts the card right of a rail item", () => {
    const target = box(8, 200, 200, 36);
    const s = placeCard({ card: CARD, viewport: VP, target });
    expect(s.how).toBe("right");
    expect(overlap(rectOf(s), target)).toBe(0);
    expect(inside(rectOf(s), VP)).toBe(true);
  });

  it("never covers the assistant bubble in the bottom-right corner", () => {
    const target = box(1440 - 24 - 52 - 8, 900 - 16 - 52 - 8, 68, 68);
    const s = placeCard({ card: CARD, viewport: VP, target });
    expect(s.how).toBe("left");
    expect(overlap(rectOf(s), target)).toBe(0);
    expect(inside(rectOf(s), VP)).toBe(true);
  });

  it("keeps clear of an open menu below the target", () => {
    const target = box(600, 300, 200, 36);
    const menu = box(600, 340, 220, 300);
    const vp = box(0, 0, 900, 900);
    const s = placeCard({ card: CARD, viewport: vp, target, keepOut: [menu] });
    const r = rectOf(s);
    expect(overlap(r, target)).toBe(0);
    expect(overlap(r, menu)).toBe(0);
    expect(inside(r, vp)).toBe(true);
  });

  it("slides along the side to clear a menu that blocks the aligned spot", () => {
    const target = box(100, 100, 200, 36);
    const menu = box(320, 90, 400, 120);
    const s = placeCard({ card: CARD, viewport: VP, target, keepOut: [menu] });
    const r = rectOf(s);
    expect(overlap(r, target)).toBe(0);
    expect(overlap(r, menu)).toBe(0);
  });

  it("falls back to the spot that covers least of the target", () => {
    // No room above the target, a menu fills the space below: covering the menu wins.
    const vp = box(0, 0, 400, 480);
    const target = box(150, 150, 100, 40);
    const menu = box(0, 200, 400, 280);
    const s = placeCard({ card: CARD, viewport: vp, target, keepOut: [menu] });
    expect(s.how).toBe("fallback");
    expect(overlap(rectOf(s), target)).toBe(0);
  });

  it("covers the target as little as possible when it cannot avoid it", () => {
    const vp = box(0, 0, 380, 260);
    const target = box(20, 20, 340, 220);
    const s = placeCard({ card: CARD, viewport: vp, target });
    expect(s.how).toBe("fallback");
    const least = overlap(rectOf(s), target);
    // Every spot that keeps the margin covers at least as much.
    for (let left = MARGIN; left <= 380 - MARGIN - 340; left += 2)
      for (let top = MARGIN; top <= 260 - MARGIN - 200; top += 2)
        expect(overlap(box(left, top, 340, 200), target)).toBeGreaterThanOrEqual(least);
  });

  it("stays beside the target, covering as little of the bar and summary card as it can", () => {
    // A form's Save at the right end of its sticky bar, a summary card in the right column:
    // no side spot clears both, so it takes the side spot covering least of them, not a corner.
    const target = box(1300, 840, 110, 36);
    const bar = box(240, 828, 1200, 60);
    const summary = box(1000, 120, 420, 520);
    const s = placeCard({ card: CARD, viewport: VP, target, avoid: [bar, summary] });
    const r = rectOf(s);
    expect(overlap(r, target)).toBe(0);
    expect(s.how).not.toBe("corner");
    expect(overlap(r, bar)).toBe(0);
    expect(overlap(r, summary)).toBeLessThan(CARD.width * CARD.height * 0.1);
  });

  it("slides past the assistant bubble to stay beside a Save in the bottom bar", () => {
    const target = box(1252, 840, 150, 52);
    const bubble = box(1364, 772, 52, 52);
    const bar = box(248, 838, 1192, 62);
    const summary = box(1028, 62, 362, 308);
    const card = { width: 300, height: 131 };
    const s = placeCard({ card, viewport: VP, target, keepOut: [bubble], avoid: [bar, summary] });
    const r = rectOf(s, card);
    for (const k of [target, bubble, bar, summary]) expect(overlap(r, k)).toBe(0);
    // Above the button, not in a far corner.
    expect(s.how).toBe("top");
    expect(r.left < target.right && r.right > target.left).toBe(true);
  });

  it("stays beside a Save inside the summary card instead of jumping to a corner", () => {
    // Settings: Save sits at the bottom of the right-hand summary card, which is an avoid rect.
    const vp = box(0, 0, 1488, 903);
    const target = box(1100, 620, 350, 44);
    const summary = box(1082, 72, 388, 630);
    const card = { width: 300, height: 131 };
    const s = placeCard({ card, viewport: vp, target, avoid: [summary] });
    const r = rectOf(s, card);
    expect(overlap(r, target)).toBe(0);
    expect(s.how).not.toBe("corner");
    // Beside the target: shares its vertical or horizontal span.
    const sharesY = r.top < target.bottom && r.bottom > target.top;
    const sharesX = r.left < target.right && r.right > target.left;
    expect(sharesY || sharesX).toBe(true);
  });

  it("covers an avoid rect rather than the target or a menu", () => {
    // A summary card spans the whole page: no spot clears it, so it is the one covered.
    const target = box(400, 400, 100, 40);
    const menu = box(380, 450, 300, 400);
    const avoid = box(0, 0, 1440, 900);
    const s = placeCard({ card: CARD, viewport: VP, target, keepOut: [menu], avoid: [avoid] });
    const r = rectOf(s);
    expect(overlap(r, target)).toBe(0);
    expect(overlap(r, menu)).toBe(0);
  });

  it("stays inside the viewport less the margin", () => {
    for (const target of [box(0, 0, 40, 40), box(1400, 860, 40, 40), box(700, 880, 40, 20)]) {
      const s = placeCard({ card: CARD, viewport: VP, target });
      expect(inside(rectOf(s), VP)).toBe(true);
      expect(overlap(rectOf(s), target)).toBe(0);
    }
  });

  it("respects a viewport cut by the docked panel", () => {
    const vp = box(0, 0, 1040, 900);
    const target = box(900, 400, 120, 36);
    const s = placeCard({ card: CARD, viewport: vp, target });
    expect(rectOf(s).right).toBeLessThanOrEqual(1040 - MARGIN);
    expect(overlap(rectOf(s), target)).toBe(0);
  });

  it("centres near the top when there is no target", () => {
    const s = placeCard({ card: CARD, viewport: VP, target: null });
    expect(s.how).toBe("center");
    expect(s.left).toBe((1440 - 340) / 2);
  });
});

describe("placeBeside (Billy's nudge)", () => {
  // 1440x900: the rail takes 248px, so <main> runs from x 248; the bubble sits 24px in, 16px up.
  const MAIN = box(248, 0, 1192, 900);
  const BUBBLE = box(1364, 832, 52, 52);
  const NUDGE = { width: 224, height: 104 };
  const clear = (r: Box, rects: Box[]) => rects.every((k) => overlap(r, k) === 0);

  it("hides on a subscription page where the items card fills the foot", () => {
    // Subscription items: a row's name and amount, the total, and the note line under it.
    const content = [
      box(312, 740, 208, 16),
      box(1300, 740, 76, 16),
      box(1290, 780, 86, 16),
      box(312, 812, 448, 16),
    ];
    const s = placeBeside({
      card: NUDGE,
      viewport: MAIN,
      target: BUBBLE,
      keepOut: content,
      prefer: "left",
    });
    // No corner: the bottom-left one is where it covered the note line.
    expect(s).toBeNull();
  });

  it("hides on a customer page where the payment methods empty state sits by the bubble", () => {
    const card = { width: 224, height: 84 };
    const content = [box(1132, 812, 168, 16), box(1150, 840, 130, 32), box(1052, 720, 140, 20)];
    const s = placeBeside({
      card,
      viewport: MAIN,
      target: BUBBLE,
      keepOut: content,
      prefer: "left",
    });
    expect(s).toBeNull();
  });

  it("shows left of the bubble at the foot of the page, in the room the page keeps for it", () => {
    // --billy-clear = 16 + 104 + 16: the last line ends 136px above the window's bottom.
    const content = [box(288, 740, 1112, 16), box(1300, 700, 76, 16)];
    const s = placeBeside({
      card: NUDGE,
      viewport: MAIN,
      target: BUBBLE,
      keepOut: content,
      prefer: "left",
    });
    expect(s?.how).toBe("left");
    const r = rectOf(s!, NUDGE);
    expect(clear(r, [BUBBLE, ...content])).toBe(true);
    expect(inside(r, MAIN)).toBe(true);
    const near = reach(BUBBLE, NUDGE);
    expect(r.left >= near.left && r.top >= near.top && r.right <= near.right).toBe(true);
  });

  it("never covers a sticky save bar under the lifted bubble", () => {
    const bar = box(248, 838, 1192, 62);
    const bubble = box(1364, 900 - 62 - 16 - 52, 52, 52);
    const s = placeBeside({
      card: NUDGE,
      viewport: MAIN,
      target: bubble,
      keepOut: [bar],
      prefer: "left",
    });
    expect(s).not.toBeNull();
    const r = rectOf(s!, NUDGE);
    expect(clear(r, [bar, bubble])).toBe(true);
    expect(r.top < bubble.bottom && r.bottom > bubble.top).toBe(true);
  });

  it("returns null with no target", () => {
    expect(placeBeside({ card: NUDGE, viewport: MAIN, target: null })).toBeNull();
  });

  // Credit note at 1440x900: the Comments card's header sits left of the bubble. Its title
  // ends 9px short of the spot, so text alone left the header free.
  const NUDGE_B4 = { width: 224, height: 84 };
  const COMMENTS_TITLE = inflate(box(1049, 824, 70, 18), 8);
  const COMMENTS_CARD = inflate(box(1029, 807, 361, 200), 8);

  it("covers a card header when only its text is kept out (the gap)", () => {
    const s = placeBeside({
      card: NUDGE_B4,
      viewport: MAIN,
      target: BUBBLE,
      keepOut: [COMMENTS_TITLE],
      prefer: "left",
    });
    expect(s).not.toBeNull();
    expect(overlap(rectOf(s!, NUDGE_B4), COMMENTS_CARD)).toBeGreaterThan(0);
  });

  it("hides over a card once the card's box is kept out", () => {
    const s = placeBeside({
      card: NUDGE_B4,
      viewport: MAIN,
      target: BUBBLE,
      keepOut: [COMMENTS_TITLE, COMMENTS_CARD],
      prefer: "left",
    });
    expect(s).toBeNull();
  });
});

describe("paintsBox", () => {
  const NONE: Paint = {
    backgroundColor: "rgba(0, 0, 0, 0)",
    backgroundImage: "none",
    boxShadow: "none",
    borderTopWidth: "0px",
    borderRightWidth: "0px",
    borderBottomWidth: "0px",
    borderLeftWidth: "0px",
    borderTopColor: "rgb(226, 233, 242)",
    borderRightColor: "rgb(226, 233, 242)",
    borderBottomColor: "rgb(226, 233, 242)",
    borderLeftColor: "rgb(226, 233, 242)",
  };
  const GROUND = "rgb(242, 246, 251)";

  it("a plain wrapper is not a surface", () => {
    expect(paintsBox(NONE, GROUND)).toBe(false);
  });

  it("a card's fill is a surface; the page ground is not", () => {
    expect(paintsBox({ ...NONE, backgroundColor: "rgb(255, 255, 255)" }, GROUND)).toBe(true);
    expect(paintsBox({ ...NONE, backgroundColor: GROUND }, GROUND)).toBe(false);
  });

  it("a border or a shadow alone makes a surface", () => {
    expect(paintsBox({ ...NONE, borderBottomWidth: "1px" }, GROUND)).toBe(true);
    expect(paintsBox({ ...NONE, boxShadow: "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px" }, GROUND)).toBe(
      true,
    );
    expect(paintsBox({ ...NONE, backgroundImage: "linear-gradient(red, blue)" }, GROUND)).toBe(
      true,
    );
  });

  it("a transparent fill or border is not a surface", () => {
    expect(paintsBox({ ...NONE, backgroundColor: "transparent" }, GROUND)).toBe(false);
    expect(paintsBox({ ...NONE, backgroundColor: "oklab(0.9 0 0 / 0)" }, GROUND)).toBe(false);
    expect(
      paintsBox({ ...NONE, borderTopWidth: "2px", borderTopColor: "rgba(0, 0, 0, 0)" }, GROUND),
    ).toBe(false);
  });

  it("isClear reads every computed form of zero alpha", () => {
    expect(isClear("rgba(16, 24, 40, 0)")).toBe(true);
    expect(isClear("color(srgb 1 1 1 / 0)")).toBe(true);
    expect(isClear("rgba(16, 24, 40, 0.4)")).toBe(false);
    expect(isClear("rgb(16, 24, 40)")).toBe(false);
  });
});

describe("placeSheet", () => {
  const PHONE = box(0, 0, 390, 844);

  it("docks to the bottom when the target is above it", () => {
    const s = placeSheet({ height: 180, viewport: PHONE, target: box(20, 100, 200, 40) });
    expect(s.how).toBe("sheet-bottom");
    expect(s.scrollBy).toBe(0);
    expect(s.width).toBe(390 - MARGIN * 2);
  });

  it("asks for a scroll that brings the target into the upper half", () => {
    const target = box(20, 700, 200, 40);
    const s = placeSheet({ height: 180, viewport: PHONE, target });
    expect(s.scrollBy).toBeGreaterThan(0);
    const after = target.top - s.scrollBy;
    expect(after).toBeLessThan(844 / 2);
    expect(after + 40).toBeLessThan(s.top);
  });

  it("docks to the top when the scroll did not clear the target", () => {
    const target = box(20, 700, 200, 40);
    const s = placeSheet({ height: 180, viewport: PHONE, target, scrolled: true });
    expect(s.how).toBe("sheet-top");
    expect(overlap(box(s.left, s.top, s.width, 180), target)).toBe(0);
  });
});
