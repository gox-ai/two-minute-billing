/**
 * Billy's floating window: a compact card anchored to one corner of the page area. Anchored,
 * not placed: a bottom corner grows upward as the answer arrives, so it never leaves the
 * screen. A drag moves it freely; on release it snaps to the nearest corner. Pure, so it is
 * unit-tested.
 */
export const CORNER_KEY = "tmb.assistant.corner";
export const FLOAT_W = 380;
export const FLOAT_MARGIN = 16;

export type BillyCorner = { side: "left" | "right"; vert: "top" | "bottom" };
export const DEFAULT_CORNER: BillyCorner = { side: "right", vert: "bottom" };

/** The page area the window may sit in: beside the rail, under any banner. */
export type FloatArea = { left: number; top: number; right: number; bottom: number };
type Box = { left: number; top: number; width: number; height: number };

/** A stored corner: only the four known values, else bottom right. */
export function parseStoredCorner(raw: unknown): BillyCorner {
  if (typeof raw !== "string") return DEFAULT_CORNER;
  const [vert, side] = raw.split("-");
  return (vert === "top" || vert === "bottom") && (side === "left" || side === "right")
    ? { side, vert }
    : DEFAULT_CORNER;
}
export const storeCorner = (c: BillyCorner) => `${c.vert}-${c.side}`;

/** The corner whose quadrant holds the window's centre. */
export function nearestCorner(box: Box, area: FloatArea): BillyCorner {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return {
    side: cx < (area.left + area.right) / 2 ? "left" : "right",
    vert: cy < (area.top + area.bottom) / 2 ? "top" : "bottom",
  };
}

/** A dragged position kept inside the area, less the margin. */
export function clampFloat(x: number, y: number, box: Box, area: FloatArea) {
  const lim = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  return {
    x: lim(x, area.left + FLOAT_MARGIN, area.right - FLOAT_MARGIN - box.width),
    y: lim(y, area.top + FLOAT_MARGIN, area.bottom - FLOAT_MARGIN - box.height),
  };
}
