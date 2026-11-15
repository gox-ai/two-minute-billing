/// <reference lib="dom" />
// Unit tests pull this file into the engine program, which has no DOM lib.
/**
 * Shared title, list → record (`SHARED_TITLE`, lib/motion.ts; CSS in app/motion/shared-title.css).
 *
 * A list row's name link (`a[data-record-title]`) and a record page's title
 * (`h1[data-record-title]`) are the two ends. For one push or pop, the source end is named
 * `record-title` before the old snapshot; inside the update its name comes off and the landing
 * end takes it; both are cleared when the transition finishes. Only one element holds the name
 * at any moment, so a transition never aborts on a duplicate.
 *
 * Wired from components/route-motion.tsx. The pure helpers are unit-tested
 * (test/unit/shared-title.test.ts).
 */
import { SHARED_TITLE } from "./motion";

export const SHARED_TITLE_NAME = "record-title";

type Motion = "push" | "pop" | "tab";

export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

/** Part of a non-empty box is inside the viewport. */
export function onScreen(b: Box, vw: number, vh: number): boolean {
  return b.width > 0 && b.height > 0 && b.bottom > 0 && b.right > 0 && b.top < vh && b.left < vw;
}

/** Index of the first on-screen link to `path`, or -1. */
export function pickLink(
  links: { path: string; box: Box }[],
  path: string,
  vw: number,
  vh: number,
): number {
  return links.findIndex((l) => l.path === path && onScreen(l.box, vw, vh));
}

/**
 * Which end leaves and which lands for a page move, and the record's path (the row links
 * to it). A push starts at the row; a pop starts at the title. Tabs share nothing.
 */
export function sharedTitlePlan(
  motion: Motion,
  fromPath: string,
  toPath: string,
): { from: "link" | "title"; to: "link" | "title"; recordPath: string } | null {
  if (motion === "push") return { from: "link", to: "title", recordPath: toPath };
  if (motion === "pop") return { from: "title", to: "link", recordPath: fromPath };
  return null;
}

export interface SharedTitleSession {
  from: HTMLElement;
  toPath: string;
  find: () => HTMLElement | null;
  to: HTMLElement | null;
  landed: boolean;
  timer: number;
}

let current: SharedTitleSession | null = null;

const viewport = () => [window.innerWidth, window.innerHeight] as const;

function findTitle(): HTMLElement | null {
  const h = document.querySelector<HTMLElement>("main h1[data-record-title]");
  return h && onScreen(h.getBoundingClientRect(), ...viewport()) ? h : null;
}

function findLink(path: string): HTMLElement | null {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("main a[data-record-title]")];
  const i = pickLink(
    links.map((a) => ({
      path: new URL(a.href, location.href).pathname,
      box: a.getBoundingClientRect(),
    })),
    path,
    ...viewport(),
  );
  return links[i] ?? null;
}

const unname = (el: HTMLElement | null) => el?.style.removeProperty("view-transition-name");

/** Clears a session's names. A no-op for a session that is no longer current. */
export function dropSharedTitle(s: SharedTitleSession | null) {
  if (!s || s !== current) return;
  window.clearTimeout(s.timer);
  unname(s.from);
  unname(s.to);
  current = null;
}

/** A session is waiting for its transition's update. */
export function sharedTitlePending(): boolean {
  return !!current && !current.landed;
}

/**
 * Before the old snapshot: names the leaving end of a push or pop. `anchor` is the clicked
 * link; a click push shares only when that link is a row title. Any earlier session is dropped.
 */
export function armSharedTitle(
  motion: Motion,
  fromPath: string,
  toPath: string,
  anchor?: Element | null,
) {
  dropSharedTitle(current);
  if (!SHARED_TITLE || !("startViewTransition" in document)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const plan = sharedTitlePlan(motion, fromPath, toPath);
  if (!plan) return;
  let from: HTMLElement | null;
  if (plan.from === "title") from = findTitle();
  else if (anchor) from = anchor.matches("a[data-record-title]") ? (anchor as HTMLElement) : null;
  else from = findLink(plan.recordPath);
  if (!from) return;
  from.style.viewTransitionName = SHARED_TITLE_NAME;
  const s: SharedTitleSession = {
    from,
    toPath,
    find: () => (plan.to === "title" ? findTitle() : findLink(plan.recordPath)),
    to: null,
    landed: false,
    // A click that never navigates lets the name go (the pending bar's limit).
    timer: window.setTimeout(() => dropSharedTitle(s), 8000),
  };
  current = s;
}

/**
 * Inside a view transition's update, once the new page is in the DOM: moves the name to the
 * landing end. Returns the session to drop at `finished`, or null when this transition is not
 * the awaited navigation.
 */
export function landSharedTitle(): SharedTitleSession | null {
  const s = current;
  if (!s || s.landed || location.pathname !== s.toPath) return null;
  s.landed = true;
  unname(s.from);
  const to = s.find();
  if (to && to !== s.from) {
    to.style.viewTransitionName = SHARED_TITLE_NAME;
    s.to = to;
  }
  return s;
}
