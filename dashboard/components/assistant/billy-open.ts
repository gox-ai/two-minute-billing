// Plain module (no "use client"): the dashboard layout renders the script below.
import {
  BILLY_LAYOUT_SCRIPT,
  MODE_KEY,
  OPEN_KEY,
  WIDTH_KEY,
  billyLayout,
  parseStoredMode,
  parseStoredWidth,
  type BillyLayout,
  type BillyMode,
} from "@/lib/billy-width";

export { OPEN_KEY };

/**
 * Stamps `<html data-billy-open>`, `data-billy-push` and `--billy-w` before first paint, so
 * the page is already narrowed where the panel docks (app/motion/billy-push.css) and a
 * reload does not shift. Any failure leaves the page full width.
 */
export const BILLY_OPEN_SCRIPT = BILLY_LAYOUT_SCRIPT;

export function markBillyOpen(open: boolean) {
  const html = document.documentElement;
  if (open) html.dataset.billyOpen = "";
  else delete html.dataset.billyOpen;
}

/** The open panel takes its width from `<main>` here, instead of covering the page. */
export const billyPushes = () => {
  const d = document.documentElement.dataset;
  return d.billyOpen !== undefined && d.billyPush !== undefined;
};

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string) {
  try {
    window.localStorage.setItem(key, v);
  } catch {
    /* the choice resets on reload */
  }
}

/*
 * The operator's width and mode, and the layout they give now. The width is kept when a
 * narrower window clamps the applied width, so widening the window restores it.
 */
let pref = parseStoredWidth(null);
let mode: BillyMode = "dock";
export type BillyState = BillyLayout & { mode: BillyMode };
let current: BillyState | null = null;
const listeners = new Set<() => void>();

/** The one source of the width: `--billy-w` on `<html>`, read by the panel and by `<main>`. */
function stamp(): BillyState {
  const html = document.documentElement;
  const l = billyLayout(window.innerWidth, html.dataset.nav === "collapsed", pref, mode);
  html.style.setProperty("--billy-w", `${l.width}px`);
  html.toggleAttribute("data-billy-push", l.push);
  return { ...l, mode };
}

const same = (a: BillyState, b: BillyState) =>
  a.width === b.width &&
  a.max === b.max &&
  a.min === b.min &&
  a.room === b.room &&
  a.push === b.push &&
  a.resizable === b.resizable &&
  a.mode === b.mode;

function publish(s: BillyState) {
  if (current && same(current, s)) return;
  current = s;
  for (const f of listeners) f();
}

/** Reads the stored width and mode and stamps them; the dock calls it once on mount. */
export function initBillyLayout() {
  pref = parseStoredWidth(read(WIDTH_KEY));
  mode = parseStoredMode(read(MODE_KEY));
  publish(stamp());
}

/** Re-applies the choices after the window or the rail changed. */
export function restampBilly() {
  publish(stamp());
}

/**
 * Sets the width. A drag calls it per frame without `commit` (no store write, no React
 * render) and once with `commit` on release.
 */
export function setBillyWidth(w: number, commit: boolean): BillyState {
  pref = w;
  const s = stamp();
  if (commit) {
    write(WIDTH_KEY, String(pref));
    publish(s);
  }
  return s;
}

export function setBillyMode(m: BillyMode) {
  mode = m;
  write(MODE_KEY, m);
  publish(stamp());
}

export const subscribeBillyLayout = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};
export const billyLayoutNow = () => current;
