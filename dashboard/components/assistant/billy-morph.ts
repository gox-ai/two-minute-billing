import { flushSync } from "react-dom";

/**
 * Bubble ⇄ panel as ONE shape. A same-document view transition
 * names the bubble `billy`, swaps to the panel inside the update, and names the panel
 * `billy`: the browser morphs the one group between the two rects, and globals.css
 * (`::view-transition-*(billy)`, keyed on `<html data-billy-morph>`) draws the skin — the
 * radius, the three-colour ring settling into the border, the late content fade.
 *
 * Not a React state machine: the names live on the DOM for the length of one transition.
 * The route guard (components/route-motion.tsx) skips a transition that stalls, and a skip
 * still runs the update, so Billy always opens.
 */
/** `still`: shown as it was after a reload. `dock` / `float`: app/motion/billy-push.css. */
export type BillyEntry = "morph" | "reveal" | "slide" | "dock" | "float" | "still";

const NAME = "billy";

export const bubbleEl = () =>
  document.querySelector<HTMLElement>('.billy-bubble:not([data-state="closed"])');
export const panelEl = () => document.querySelector<HTMLElement>("aside[data-assistant-panel]");

type StartVT = (cb: () => void) => { finished: Promise<void>; ready: Promise<void> };
const startVT = () => (document as { startViewTransition?: StartVT }).startViewTransition;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How this open or close should move, from what the browser and the page offer. */
export function billyEntry(from: HTMLElement | null): BillyEntry {
  if (reduced() || !from || from.getBoundingClientRect().width === 0) return "slide";
  const vt = (document as { startViewTransition?: unknown }).startViewTransition;
  return typeof vt === "function" && document.visibilityState === "visible" ? "morph" : "reveal";
}

/** The panel's shape at the far end of a morph: a column, a floating window, or a phone's full screen. */
export type BillyShape = "dock" | "float" | "phone";

/**
 * One shape between two boxes: bubble → panel (`open`), panel → bubble (`close`), or side
 * panel ⇄ floating window (`swap`, `shape` is where it lands). The page under it is live, so
 * `<main>`'s edge eases on the morph's clock while the shape grows (billy-push.css).
 */
export function billyMorph(
  dir: "open" | "close" | "swap",
  shape: BillyShape,
  from: HTMLElement,
  update: () => void,
  after: () => void,
) {
  const html = document.documentElement;
  html.dataset.billyMorph = dir;
  html.dataset.billyShape = shape;
  html.dataset.billyMoving = "";
  from.style.viewTransitionName = NAME;
  let to: HTMLElement | null = null;
  const t = startVT()!.call(document, () => {
    from.style.viewTransitionName = "";
    flushSync(update);
    to = dir === "close" ? bubbleEl() : panelEl();
    if (to) to.style.viewTransitionName = NAME;
  });
  const done = () => {
    if (to) to.style.viewTransitionName = "";
    delete html.dataset.billyMorph;
    delete html.dataset.billyShape;
    delete html.dataset.billyMoving;
    after();
  };
  t.finished.then(done, done);
  t.ready.catch(() => {});
}

/** Where the panel docks (`data-billy-push`) it is a column beside the page. */
export const billyDocks = () => document.documentElement.dataset.billyPush !== undefined;

let moving = 0;
/**
 * Mark a docked move. While `<html data-billy-moving>` is set, `<main>`'s edge eases on the
 * panel's clock (app/motion/billy-push.css), so the page makes room as the panel arrives.
 * Off otherwise: a window resize or a drag must not ease behind the pointer.
 */
export function billyMoving(ms: number) {
  const html = document.documentElement;
  html.dataset.billyMoving = "";
  window.clearTimeout(moving);
  moving = window.setTimeout(() => delete html.dataset.billyMoving, ms + 60);
}

/** The fallback reveal's start: the bubble's rect as `inset()` lengths inside the panel. */
export function revealInset(bubble: DOMRect, panel: DOMRect) {
  return {
    "--rv-t": `${Math.max(0, bubble.top - panel.top)}px`,
    "--rv-r": `${Math.max(0, panel.right - bubble.right)}px`,
    "--rv-b": `${Math.max(0, panel.bottom - bubble.bottom)}px`,
    "--rv-l": `${Math.max(0, bubble.left - panel.left)}px`,
  };
}
