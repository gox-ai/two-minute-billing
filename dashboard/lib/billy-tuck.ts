/**
 * Below 1024px Billy's bubble has no gutter of its own, so it leaves while the page scrolls
 * down (reading) and comes back on the way up, at the top, and at the end, where the page
 * keeps `--billy-clear` free for it. Pure, so it is unit-tested.
 */
export interface ScrollPos {
  /** `scrollTop` now. */
  top: number;
  /** `scrollTop` at the last decision. */
  anchor: number;
  clientHeight: number;
  scrollHeight: number;
}

/** Movement smaller than this keeps the last decision: a trackpad jitters. */
export const TUCK_SLOP = 8;

export function tuckBubble(tucked: boolean, p: ScrollPos, slop = TUCK_SLOP): boolean {
  if (p.top <= slop) return false;
  if (p.top + p.clientHeight >= p.scrollHeight - slop) return false;
  const moved = p.top - p.anchor;
  if (moved > slop) return true;
  if (moved < -slop) return false;
  return tucked;
}

/** The anchor for the next decision: it follows once the page moved past the slop. */
export function nextAnchor(p: ScrollPos, slop = TUCK_SLOP): number {
  return Math.abs(p.top - p.anchor) > slop ? p.top : p.anchor;
}
