/**
 * Where a coach card (product tour step, "Show me" guide step) goes. Pure: the caller measures
 * the DOM and passes rects. The card must never cover its target, and should not cover an open
 * menu or any other keep-out rect.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Side = "right" | "left" | "bottom" | "top";

export interface Size {
  width: number;
  height: number;
}

export interface Spot {
  left: number;
  top: number;
  /** Where it ended up: a side of the target, a corner, a docked sheet, or the fallback. */
  how: Side | "corner" | "center" | "sheet-bottom" | "sheet-top" | "fallback";
}

export const MARGIN = 16;
export const GAP = 12;

const OPPOSITE: Record<Side, Side> = { right: "left", left: "right", bottom: "top", top: "bottom" };

export const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

export const inflate = (b: Box, by: number): Box => ({
  left: b.left - by,
  top: b.top - by,
  right: b.right + by,
  bottom: b.bottom + by,
});

/** Overlap area; 0 when the boxes only touch. */
export function overlap(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** Keep a card of `size` inside `vp` less the margin; pinned to the top-left when too big. */
export function clampToViewport(
  at: { left: number; top: number },
  size: Size,
  vp: Box,
  margin = MARGIN,
): { left: number; top: number } {
  return {
    left: Math.max(vp.left + margin, Math.min(at.left, vp.right - margin - size.width)),
    top: Math.max(vp.top + margin, Math.min(at.top, vp.bottom - margin - size.height)),
  };
}

const fitsIn = (b: Box, vp: Box, margin: number) =>
  b.left >= vp.left + margin - 0.5 &&
  b.top >= vp.top + margin - 0.5 &&
  b.right <= vp.right - margin + 0.5 &&
  b.bottom <= vp.bottom - margin + 0.5;

export interface PlaceInput {
  card: Size;
  /** The usable viewport: the window less a docked side panel. */
  viewport: Box;
  /** What the card points at, already grown by the highlight ring. Null: nothing found. */
  target: Box | null;
  /** Other rects the card must not cover: open menus, the assistant bubble. */
  keepOut?: Box[];
  /**
   * Rects the card should not cover when a clear spot exists: the page's sticky action bar,
   * a summary card. A spot clear of these AND the keep-outs wins; else they are ignored.
   */
  avoid?: Box[];
  prefer?: Side;
  gap?: number;
  margin?: number;
}

/** Sides in try order: the preferred one, its opposite, below, above. */
export function sideOrder(prefer: Side = "right"): Side[] {
  return [...new Set<Side>([prefer, OPPOSITE[prefer], "bottom", "top"])];
}

function candidates(i: Required<Omit<PlaceInput, "target">> & { target: Box | null }): Spot[] {
  const { card, viewport: vp, target: t, gap, margin } = i;
  const { width: w, height: h } = card;
  const out: Spot[] = [];
  const push = (left: number, top: number, how: Spot["how"]) =>
    out.push({ ...clampToViewport({ left, top }, card, vp, margin), how });
  if (t) {
    const cy = (t.top + t.bottom) / 2;
    const cx = (t.left + t.right) / 2;
    const rects = [...i.keepOut, ...i.avoid];
    // Still beside the target after the viewport clamp: shares some of its span.
    const near = (left: number, top: number, side: Side) => {
      const at = clampToViewport({ left, top }, card, vp, margin);
      return side === "right" || side === "left"
        ? at.top < t.bottom && at.top + h > t.top
        : at.left < t.right && at.left + w > t.left;
    };
    for (const side of sideOrder(i.prefer)) {
      // Aligned to the target's start, centre, then end: slides past a menu below the target.
      // Then slid to just clear each other rect, while still beside the target.
      if (side === "right" || side === "left") {
        const left = side === "right" ? t.right + gap : t.left - gap - w;
        for (const top of [t.top, cy - h / 2, t.bottom - h]) push(left, top, side);
        for (const r of rects)
          for (const top of [r.top - gap - h, r.bottom + gap])
            if (near(left, top, side)) push(left, top, side);
      } else {
        const top = side === "bottom" ? t.bottom + gap : t.top - gap - h;
        for (const left of [t.left, cx - w / 2, t.right - w]) push(left, top, side);
        for (const r of rects)
          for (const left of [r.left - gap - w, r.right + gap])
            if (near(left, top, side)) push(left, top, side);
      }
    }
  } else {
    push((vp.left + vp.right - w) / 2, vp.top + 64, "center");
  }
  push(vp.left, vp.top, "corner");
  push(vp.right, vp.top, "corner");
  push(vp.left, vp.bottom, "corner");
  push(vp.right, vp.bottom, "corner");
  return out;
}

/**
 * Beside the target first: a side spot fully inside the viewport, clear of every keep-out (the
 * target included) and of `avoid`; else a side spot clear of the keep-outs that covers least of
 * `avoid`. `avoid` only chooses between side spots: it never sends the card to a far corner.
 * Then a corner. None: the spot covering least of the TARGET, then the keep-outs, then `avoid`.
 */
export function placeCard(input: PlaceInput): Spot {
  const i = {
    keepOut: [],
    avoid: [],
    prefer: "right" as Side,
    gap: GAP,
    margin: MARGIN,
    ...input,
  };
  const keep = i.target ? [i.target, ...i.keepOut] : i.keepOut;
  const spots = candidates(i);
  const rectOf = (s: Spot) => box(s.left, s.top, i.card.width, i.card.height);
  const sum = (r: Box, rects: Box[]) => rects.reduce((n, k) => n + overlap(r, k), 0);
  const fits = (s: Spot, rects: Box[]) => {
    const r = rectOf(s);
    return fitsIn(r, i.viewport, i.margin) && rects.every((k) => overlap(r, k) === 0);
  };
  const beside = spots.filter((s) => s.how !== "corner");
  const corners = spots.filter((s) => s.how === "corner");
  // Least of `avoid` among side spots clear of the keep-outs; the first wins a tie.
  const leastAvoid = beside
    .filter((s) => fits(s, keep))
    .reduce<Spot | undefined>(
      (b, s) => (!b || sum(rectOf(s), i.avoid) < sum(rectOf(b), i.avoid) ? s : b),
      undefined,
    );
  const clear =
    beside.find((s) => fits(s, [...keep, ...i.avoid])) ??
    leastAvoid ??
    corners.find((s) => fits(s, [...keep, ...i.avoid])) ??
    corners.find((s) => fits(s, keep));
  if (clear) return clear;
  let best = spots[0]!;
  let bestScore = [Infinity, Infinity, Infinity];
  for (const s of spots) {
    const r = rectOf(s);
    const score = [i.target ? overlap(r, i.target) : 0, sum(r, i.keepOut), sum(r, i.avoid)];
    const better = score.findIndex((v, n) => v !== bestScore[n]);
    if (better >= 0 && score[better]! < bestScore[better]!) {
      best = s;
      bestScore = score;
    }
  }
  return { ...best, how: "fallback" };
}

/** Everything a spot beside `target` can touch: the only area whose content matters. */
export function reach(target: Box, card: Size, gap = GAP): Box {
  return {
    left: target.left - gap - card.width,
    top: target.top - gap - card.height,
    right: target.right + gap + card.width,
    bottom: target.bottom + gap + card.height,
  };
}

/**
 * Strict: a spot beside the target, inside the viewport and clear of every keep-out, or null.
 * No corner, no fallback. For a card that is optional (Billy's nudge): better unseen than on
 * top of what the operator is reading.
 */
export function placeBeside(input: Omit<PlaceInput, "avoid">): Spot | null {
  const i = { keepOut: [], prefer: "right" as Side, gap: GAP, margin: MARGIN, ...input, avoid: [] };
  if (!i.target) return null;
  const keep = [i.target, ...i.keepOut];
  return (
    candidates(i).find((s) => {
      if (s.how === "corner") return false;
      const r = box(s.left, s.top, i.card.width, i.card.height);
      return fitsIn(r, i.viewport, i.margin) && keep.every((k) => overlap(r, k) === 0);
    }) ?? null
  );
}

/** The computed style fields that decide whether an element paints a surface. */
export interface Paint {
  backgroundColor: string;
  backgroundImage: string;
  boxShadow: string;
  borderTopWidth: string;
  borderRightWidth: string;
  borderBottomWidth: string;
  borderLeftWidth: string;
  borderTopColor: string;
  borderRightColor: string;
  borderBottomColor: string;
  borderLeftColor: string;
}

/** A computed colour with zero alpha: `transparent`, `rgba(…, 0)`, `oklab(… / 0)`. */
export function isClear(color: string): boolean {
  const c = color.trim();
  return c === "transparent" || /,\s*0(\.0+)?\)$/.test(c) || /\/\s*0(\.0+)?%?\)$/.test(c);
}

/**
 * True when the element paints a surface of its own: a card, a well, a chip, a hairline. Its
 * whole box is content then, not only its text. The page ground itself is not a surface.
 */
export function paintsBox(s: Paint, ground = ""): boolean {
  if (!isClear(s.backgroundColor) && s.backgroundColor !== ground) return true;
  if (s.backgroundImage !== "none" || s.boxShadow !== "none") return true;
  const sides = [
    [s.borderTopWidth, s.borderTopColor],
    [s.borderRightWidth, s.borderRightColor],
    [s.borderBottomWidth, s.borderBottomColor],
    [s.borderLeftWidth, s.borderLeftColor],
  ] as const;
  return sides.some(([w, c]) => parseFloat(w) > 0 && !isClear(c));
}

export interface SheetInput {
  /** Height of the card at sheet width (the viewport less both margins). */
  height: number;
  viewport: Box;
  target: Box | null;
  keepOut?: Box[];
  /** The target was already scrolled for this step: do not ask again. */
  scrolled?: boolean;
  margin?: number;
  gap?: number;
}

export type SheetSpot = Spot & { width: number; scrollBy: number };

/**
 * Phone width: a sheet docked to the bottom. When it would cover the target, first ask the
 * caller to scroll the target into the upper half (`scrollBy`, an instant scroll), then dock to
 * the top, then take the dock covering least of the target.
 */
export function placeSheet(input: SheetInput): SheetSpot {
  const { viewport: vp, target: t, height, margin = MARGIN, gap = GAP } = input;
  const keep = t ? [t, ...(input.keepOut ?? [])] : (input.keepOut ?? []);
  const width = vp.right - vp.left - margin * 2;
  const left = vp.left + margin;
  const bottomTop = Math.max(vp.top + margin, vp.bottom - margin - height);
  const docks: SheetSpot[] = [
    { left, top: bottomTop, width, how: "sheet-bottom", scrollBy: 0 },
    { left, top: vp.top + margin, width, how: "sheet-top", scrollBy: 0 },
  ];
  const covers = (s: SheetSpot, k: Box) => overlap(box(s.left, s.top, width, height), k);
  if (keep.every((k) => covers(docks[0]!, k) === 0)) return docks[0]!;
  if (t && !input.scrolled) {
    const room = bottomTop - gap - (vp.top + margin);
    const upperHalf = vp.top + (vp.bottom - vp.top) / 4;
    const want = clampN(upperHalf, vp.top + margin, vp.top + margin + room - (t.bottom - t.top));
    const by = Math.round(t.top - Math.max(vp.top + margin, want));
    if (by !== 0) return { ...docks[0]!, scrollBy: by };
  }
  if (keep.every((k) => covers(docks[1]!, k) === 0)) return docks[1]!;
  if (!t) return docks[0]!;
  return covers(docks[1]!, t) < covers(docks[0]!, t) ? docks[1]! : docks[0]!;
}
