/**
 * Billy's panel width: the operator drags it between MIN and MAX, and the page narrows beside
 * it only while it keeps the narrowest desktop column. Pure, so it is unit-tested; the head
 * script below repeats it in plain JS and the tests run both on the same inputs.
 */

/** The panel's open state, per browser. */
export const OPEN_KEY = "tmb.assistant.open";
/** The chosen width in px, per browser. */
export const WIDTH_KEY = "tmb.assistant.width";
/** Docked beside the page or floating over it, per browser. */
export const MODE_KEY = "tmb.assistant.mode";

export type BillyMode = "dock" | "float";

export const BILLY_MIN_W = 320;
export const BILLY_MAX_W = 640;
export const BILLY_DEFAULT_W = 400;
/** One arrow-key step on the resize handle. */
export const BILLY_STEP = 16;
/** Beside the widest panel the page keeps at least this much. */
export const PAGE_KEEP = 480;
/** The narrowest desktop page column (main at 1024px beside the expanded rail). */
export const PAGE_MIN = 776;

/** The rail's widths (globals.css `--rail-w`: 15.5rem / 4rem); below 768px it is a drawer. */
export const RAIL_EXPANDED = 248;
export const RAIL_COLLAPSED = 64;
const DRAWER_BELOW = 768;
/** Below this the panel is full screen. */
const PHONE_BELOW = 640;

export const railWidth = (viewport: number, collapsed: boolean) =>
  viewport < DRAWER_BELOW ? 0 : collapsed ? RAIL_COLLAPSED : RAIL_EXPANDED;

/** A stored width: a finite number inside the limits, else the default. */
export function parseStoredWidth(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return BILLY_DEFAULT_W;
  const n = Number(raw);
  return Number.isFinite(n) && n >= BILLY_MIN_W && n <= BILLY_MAX_W
    ? Math.round(n)
    : BILLY_DEFAULT_W;
}

/** A stored mode: only the two known values, else docked. */
export const parseStoredMode = (raw: unknown): BillyMode => (raw === "float" ? "float" : "dock");

/** Docked only when the operator wants it AND the page keeps its narrowest column beside it. */
export const billyDocks = (mode: BillyMode, room: boolean) => mode === "dock" && room;

export interface BillyLayout {
  /** The applied width in px. */
  width: number;
  min: number;
  max: number;
  /** The handle shows: the viewport has room for at least the minimum. */
  resizable: boolean;
  /** The page has room to dock the panel (at its minimum width or wider). */
  room: boolean;
  /** `<main>` gives the panel its width instead of the panel covering the page. */
  push: boolean;
}

/** The applied width and push decision for a viewport, rail state, width and mode. */
export function billyLayout(
  viewport: number,
  collapsed: boolean,
  pref: number,
  mode: BillyMode = "dock",
): BillyLayout {
  const rail = railWidth(viewport, collapsed);
  // Docked, the panel may grow only while the page keeps its narrowest column, so a drag
  // never un-docks it; floating, it may grow until the page keeps PAGE_KEEP.
  const dockMax = Math.min(BILLY_MAX_W, viewport - rail - PAGE_MIN);
  const room = dockMax >= BILLY_MIN_W;
  const max =
    mode === "dock" && room ? dockMax : Math.min(BILLY_MAX_W, viewport - rail - PAGE_KEEP);
  const resizable = viewport >= PHONE_BELOW && max >= BILLY_MIN_W;
  const width = resizable
    ? Math.min(Math.max(Math.round(pref), BILLY_MIN_W), max)
    : BILLY_DEFAULT_W;
  return {
    width,
    min: BILLY_MIN_W,
    max: Math.max(max, BILLY_MIN_W),
    resizable,
    room,
    push: billyDocks(mode, room),
  };
}

/**
 * Before first paint: `--billy-w`, `data-billy-push` and `data-billy-open` on `<html>`, so a
 * reload with the panel open does not shift (app/motion/billy-push.css). Must run after
 * the rail's script (it reads `data-nav`). The stored width only reaches the page as a
 * number checked against the limits, the mode only as a comparison. Storage failing still
 * stamps the default width.
 */
export const BILLY_LAYOUT_SCRIPT = `(function(){var d=document.documentElement,o=false,r=null,f=false;try{o=sessionStorage.getItem('${OPEN_KEY}')==='1'}catch(e){}try{r=localStorage.getItem('${WIDTH_KEY}');f=localStorage.getItem('${MODE_KEY}')==='float'}catch(e){}try{var v=window.innerWidth,l=v<${DRAWER_BELOW}?0:d.dataset.nav==='collapsed'?${RAIL_COLLAPSED}:${RAIL_EXPANDED},n=typeof r==='string'&&r.trim()!==''?Number(r):NaN,p=isFinite(n)&&n>=${BILLY_MIN_W}&&n<=${BILLY_MAX_W}?Math.round(n):${BILLY_DEFAULT_W},k=Math.min(${BILLY_MAX_W},v-l-${PAGE_MIN}),m=!f&&k>=${BILLY_MIN_W}?k:Math.min(${BILLY_MAX_W},v-l-${PAGE_KEEP}),w=v>=${PHONE_BELOW}&&m>=${BILLY_MIN_W}?Math.min(Math.max(p,${BILLY_MIN_W}),m):${BILLY_DEFAULT_W};d.style.setProperty('--billy-w',w+'px');if(!f&&k>=${BILLY_MIN_W})d.setAttribute('data-billy-push','');if(o)d.setAttribute('data-billy-open','')}catch(e){}})()`;
