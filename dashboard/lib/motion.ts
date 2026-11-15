/**
 * A motion token's duration in ms, for code that must wait out an exit before it unmounts
 * (globals.css owns the values). 0 under reduced motion, where every animation runs 1ms.
 */
export function motionMs(
  token:
    | "--dur"
    | "--dur-dock"
    | "--dur-out"
    | "--dur-slow"
    | "--dur-slow-out"
    | "--dur-pop"
    | "--dur-pop-out"
    | "--dur-morph",
): number {
  if (typeof window === "undefined") return 0;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : n * 1000;
}

/**
 * Large-title collapse (trial, 2026-11-09). On: as <main> scrolls, a page's large title
 * scrolls away and a compact sticky bar fades in (`components/large-title.tsx`).
 * To revert: set this to `false`. Nothing else renders or measures while it is off.
 */
export const LARGE_TITLE_COLLAPSE = true;

/**
 * Rubber-band overscroll on <main> (components/main-gestures.ts). Off on platforms that
 * already bounce natively (iOS, macOS). To revert: set this to `false`.
 */
export const RUBBER_BAND_SCROLL = true;

/**
 * Swipe-back on <main>: a left-edge touch swipe or a two-finger trackpad swipe goes back,
 * the page following the finger (components/main-gestures.ts). Chromium only; elsewhere the
 * browser keeps its own history swipe. To revert: set this to `false`.
 */
export const SWIPE_BACK = true;

/* Motion polish, 2026-11-10. Each flag turns one feature off in one line. */
/** Light ⇄ dark spreads as a circle from the control that changed it. */
export const THEME_WIPE = true;
/** Trend lines draw on, bars and sparklines grow, on first paint and on a data change. */
export const CHART_DRAW = true;
/** KPI figures roll digit by digit to their value on load and refresh. */
export const ROLLING_NUMBERS = true;
/** One highlight pill in the rail slides to the selected item. */
export const RAIL_PILL = true;
/** A list row's name glides into the record page's title during the push. */
export const SHARED_TITLE = true;
/** A dialog opens from the control that was pressed, not from the centre. */
export const DIALOG_FROM_CLICK = true;
/** Pulling <main> down past its top refreshes the page's data (components/pull-refresh.tsx). */
export const PULL_TO_REFRESH = true;
