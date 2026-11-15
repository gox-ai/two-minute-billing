/// <reference lib="dom" />
// Unit tests pull this file into the engine program, which has no DOM lib.
/**
 * Where the user last pressed, so a dialog can open from that control (`DIALOG_FROM_CLICK`).
 * One capture listener per document: a pointer press keeps its point; Enter/Space keeps the
 * focused control's box (a menu item may unmount before the dialog mounts).
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Press {
  /** `performance.now()` at the press. */
  t: number;
  /** The pointer's viewport point, or null for a key press. */
  point: { x: number; y: number } | null;
  /** The pressed control's viewport box at key-down (key presses only). */
  box: Box | null;
  target: EventTarget | null;
}

/** A press older than this did not open the dialog: open from the centre. */
export const PRESS_MAX_AGE_MS = 1000;

/** How far outside its own box (in %) a dialog's origin may sit. */
export const ORIGIN_CLAMP = { min: -25, max: 125 } as const;

let last: Press | null = null;
let installed = false;

export function installPressOrigin() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const opts = { capture: true, passive: true } as const;
  document.addEventListener(
    "pointerdown",
    (e) => {
      last = {
        t: performance.now(),
        point: { x: e.clientX, y: e.clientY },
        box: null,
        target: e.target,
      };
    },
    opts,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
      const el = e.target instanceof Element ? e.target : null;
      const r = el?.getBoundingClientRect();
      last = {
        t: performance.now(),
        point: null,
        box: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
        target: e.target,
      };
    },
    opts,
  );
}

export function lastPress(): Press | null {
  return last;
}

/** The viewport point a dialog opened at `now` grows from, or null for the centre. */
export function pressPoint(
  press: Press | null,
  now: number,
  maxAge = PRESS_MAX_AGE_MS,
): { x: number; y: number } | null {
  if (!press || now - press.t > maxAge || now < press.t) return null;
  if (press.point) return press.point;
  const b = press.box;
  if (!b || (b.width === 0 && b.height === 0)) return null;
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

const clamp = (v: number) => Math.min(ORIGIN_CLAMP.max, Math.max(ORIGIN_CLAMP.min, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A viewport point as a percentage of `box`, clamped to `ORIGIN_CLAMP`, for `transform-origin`.
 * Null for an empty box.
 */
export function originPercent(
  point: { x: number; y: number },
  box: Box,
): { x: number; y: number } | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return {
    x: round1(clamp(((point.x - box.left) / box.width) * 100)),
    y: round1(clamp(((point.y - box.top) / box.height) * 100)),
  };
}

/**
 * The box a dialog will settle in, measured mid-entrance. Its keyframes scale about the centre
 * until the origin is set, so the measured centre is the final one; the size comes from the
 * untransformed `offsetWidth/Height`.
 */
export function settledBox(
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
): Box {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return { left: cx - width / 2, top: cy - height / 2, width, height };
}
