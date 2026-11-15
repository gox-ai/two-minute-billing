"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  EASE_GLIDE,
  RUBBER,
  SWIPE,
  bezierTimeFor,
  isPreciseWheel,
  lockAxis,
  nativeGestures,
  pullProgress,
  rubberband,
  rubberbandInverse,
  swipeCommits,
  swipeProgress,
  velocityOf,
  type Sample,
} from "@/lib/gestures";
import { PULL_TO_REFRESH, RUBBER_BAND_SCROLL, SWIPE_BACK, motionMs } from "@/lib/motion";
import { pageRefreshIn } from "@/lib/page-refresh";
import { PullIndicator, createPull, type Pull } from "@/components/pull-refresh";

/**
 * Touch and trackpad gestures on the shell's one scroller, <main>. Flags in lib/motion.ts.
 *
 * Rubber band: past the top or bottom, content follows the trackpad or finger with growing
 * resistance, then springs back. Off where the platform bounces on its own (iOS, macOS);
 * elsewhere <main> gets `overscroll-behavior-y: none`, so a native effect never doubles it.
 *
 * Swipe back: a left-edge touch swipe or a two-finger trackpad swipe drags the page right
 * (the pop's shape), and past the threshold goes back through `history.back()`, so
 * route-motion's pop and NavMotion still own the navigation. Chromium only: there
 * `overscroll-behavior-x: none` turns the browser's own history swipe off. Other browsers
 * keep theirs.
 *
 * Pull to refresh: a pull down that STARTS with <main> at its top shows a chip; released
 * past the arm point, it runs the page's own Refresh (lib/page-refresh.ts), else
 * `router.refresh()`. It rides the band where the band runs; elsewhere (native bounce,
 * reduced motion) it reads the finger or wheel without moving the content.
 *
 * Mounted once beside <NavMotion>; it re-attaches to each new <main> (keyed by pathname).
 */
export function MainGestures() {
  const pathname = usePathname();
  const router = useRouter();
  const [routing, startRouting] = React.useTransition();
  const routingRef = React.useRef(false);
  const indicator = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    routingRef.current = routing;
  });
  React.useEffect(() => {
    const main = document.querySelector<HTMLElement>("main");
    if (!main) return;
    const native = nativeGestures(navigator);
    const bandOn = RUBBER_BAND_SCROLL && !native.elasticOverscroll;
    const swipeOn = SWIPE_BACK && !native.ownsHistorySwipe;
    const chip = PULL_TO_REFRESH ? indicator.current : null;
    if (!bandOn && !swipeOn && !chip) return;
    const run = () => {
      const page = pageRefreshIn(main);
      if (page) {
        if (!page.pending()) page.refresh();
        return page.pending;
      }
      startRouting(() => router.refresh());
      return () => routingRef.current;
    };
    return attach(main, bandOn, swipeOn, chip ? createPull(chip, main, run) : null);
  }, [pathname, router]);
  return PULL_TO_REFRESH ? <PullIndicator ref={indicator} /> : null;
}

/** Elements that own their own drag, and text the finger may be selecting. */
const DRAG_OWNERS = ".touch-none, [data-sheet-grabber], [data-coach-card], [data-no-gesture]";
const TEXT = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

let reduceQuery: MediaQueryList | null = null;
const reducedMotion = () =>
  (reduceQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)")).matches;
/** A modal dialog or sheet is open (Radix locks the body). */
const modalOpen = () => document.body.hasAttribute("data-scroll-locked");

type HistoryEntry = { url: string | null; sameDocument: boolean };
type NavigationLike = {
  canGoBack?: boolean;
  currentEntry?: { index: number } | null;
  entries?: () => HistoryEntry[];
};

/** The previous entry is a page of this app, in this document, on another path. */
function canSwipeBack(): boolean {
  const nav = (window as { navigation?: NavigationLike }).navigation;
  if (!nav?.canGoBack || !nav.currentEntry || !nav.entries) return false;
  const prev = nav.entries()[nav.currentEntry.index - 1];
  if (!prev?.sameDocument || !prev.url) return false;
  return new URL(prev.url).pathname !== location.pathname;
}

function scrolls(el: Element, axis: "x" | "y"): boolean {
  const s = getComputedStyle(el);
  const o = axis === "x" ? s.overflowX : s.overflowY;
  if (o !== "auto" && o !== "scroll") return false;
  return axis === "x" ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;
}

/**
 * The scroller a vertical gesture belongs to, as the browser latches it: the nearest one
 * that can still move in `dir` (1 = down), or one that contains its overscroll.
 */
function latchY(target: Element | null, main: HTMLElement, dir: number): Element {
  for (let el = target; el && el !== main; el = el.parentElement) {
    if (!scrolls(el, "y")) continue;
    const can = dir > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
    if (can || getComputedStyle(el).overscrollBehaviorY !== "auto") return el;
  }
  return main;
}

/**
 * A horizontal scroller (a wide table) keeps a sideways gesture. `strict`: any such
 * scroller, even at its edge (trackpad, which has no edge intent); otherwise only one
 * that can still scroll toward the finger.
 */
function swipeBlocked(target: Element | null, main: HTMLElement, strict: boolean): boolean {
  if (target?.closest(DRAG_OWNERS) || target?.closest(TEXT)) return true;
  for (let el = target; el && el !== main; el = el.parentElement) {
    if (scrolls(el, "x") && (strict || el.scrollLeft > 0)) return true;
  }
  return false;
}

const atTop = (m: HTMLElement) => m.scrollTop <= 0;
const atBottom = (m: HTMLElement) => m.scrollTop + m.clientHeight >= m.scrollHeight - 1;

/**
 * Sticky elements that are stuck now. While content is pulled down they would ride with it,
 * so a stuck sticky-bottom bar is held in place; pulled up, a stuck sticky-top one is.
 */
function stuckStickies(main: HTMLElement, sign: number): HTMLElement[] {
  const m = main.getBoundingClientRect();
  const out: HTMLElement[] = [];
  for (const el of main.querySelectorAll<HTMLElement>('[class*="sticky"]')) {
    if (el.closest("[data-compact-slot]") || out.some((o) => o.contains(el))) continue;
    const s = getComputedStyle(el);
    if (s.position !== "sticky" || s.translate !== "none") continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0) continue;
    if (sign > 0) {
      const b = Number.parseFloat(s.bottom);
      if (Number.isFinite(b) && Math.abs(m.bottom - r.bottom - b) < 1) out.push(el);
    } else if (main.scrollTop > 0) {
      const t = Number.parseFloat(s.top);
      if (Number.isFinite(t) && Math.abs(r.top - m.top - t) < 1) out.push(el);
    }
  }
  return out;
}

/** The band: `translate` on <main>'s content (never the compact title bar above it). */
function createBand(main: HTMLElement) {
  let over = 0; // raw distance past the edge: > 0 past the top, < 0 past the bottom
  let dim = 1;
  let parts: HTMLElement[] = [];
  let pinned: HTMLElement[] = [];
  let settling = 0;

  const all = () => [...parts, ...pinned];
  const paint = () => {
    const y = rubberband(over, dim);
    for (const el of parts) el.style.translate = `0 ${y}px`;
    for (const el of pinned) el.style.translate = `0 ${-y}px`;
  };
  const clear = () => {
    window.clearTimeout(settling);
    settling = 0;
    for (const el of all()) {
      el.style.removeProperty("translate");
      el.style.removeProperty("transition");
      el.style.removeProperty("will-change");
    }
    parts = [];
    pinned = [];
    over = 0;
  };
  const begin = (sign: number) => {
    parts = Array.from(main.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && !c.hasAttribute("data-compact-slot"),
    );
    pinned = stuckStickies(main, sign);
    for (const el of all()) {
      el.style.transition = "none";
      el.style.willChange = "translate";
    }
  };
  /** Caught mid-settle: continue from where the spring has got to. */
  const resume = () => {
    const y = Number.parseFloat(getComputedStyle(parts[0]!).translate.split(" ")[1] ?? "0") || 0;
    window.clearTimeout(settling);
    settling = 0;
    for (const el of all()) el.style.transition = "none";
    over = rubberbandInverse(y, dim);
  };

  return {
    get active() {
      return over !== 0;
    },
    /** Raw distance past the edge: > 0 past the top. */
    get over() {
      return over;
    },
    /**
     * Moves the band by `delta` (> 0 pulls content down). Returns what is left when the
     * delta carries it back past the edge, for the caller to scroll with.
     */
    pull(delta: number, dimension: number): number {
      if (settling && parts.length) resume();
      else if (over === 0) {
        if (settling) clear();
        dim = dimension;
        begin(Math.sign(delta));
      }
      const next = over + delta;
      if (over !== 0 && next !== 0 && Math.sign(next) !== Math.sign(over)) {
        clear();
        return next;
      }
      over = next;
      if (over === 0) clear();
      else paint();
      return 0;
    },
    release() {
      if (over === 0) return;
      over = 0;
      for (const el of all()) {
        el.style.transition = "translate var(--dur-slow) var(--ease-glide)";
        el.style.removeProperty("translate");
      }
      // A timer, not `transitionend`: a window that renders no frames never ends one.
      settling = window.setTimeout(clear, motionMs("--dur-slow") + 50);
    },
    reset: clear,
  };
}

/** The page following a back swipe: `--swipe-p` drives `main[data-swiping]` (globals.css). */
function createSwipe(main: HTMLElement) {
  let p = 0;
  let drag = true;
  let samples: Sample[] = [];
  let settling = 0;

  const clear = () => {
    window.clearTimeout(settling);
    main.removeAttribute("data-swiping");
    main.style.removeProperty("--swipe-p");
  };

  const commit = () => {
    const html = document.documentElement;
    // The pop starts this far in, so it continues from the finger (globals.css, Gestures).
    html.style.setProperty("--swipe-t", bezierTimeFor(p, EASE_GLIDE).toFixed(4));
    html.dataset.swipeBack = "";
    // Drop the drag before the transition snapshots this page; capture runs before
    // NavMotion's listener, which stops the event.
    window.addEventListener("popstate", clear, { capture: true, once: true });
    window.setTimeout(() => {
      delete html.dataset.swipeBack;
      html.style.removeProperty("--swipe-t");
    }, 1200);
    window.history.back();
  };

  const settle = () => {
    if (!drag || p === 0) return clear();
    main.dataset.swiping = "settle";
    main.style.setProperty("--swipe-p", "0");
    settling = window.setTimeout(clear, motionMs("--dur") + 50);
  };

  return {
    start() {
      clear();
      p = 0;
      samples = [];
      drag = !reducedMotion();
      if (drag) main.dataset.swiping = "drag";
    },
    /** `dx` px to the right along a track `track` px long. */
    move(dx: number, track: number, t: number) {
      p = swipeProgress(dx, track);
      samples.push({ t, x: dx });
      if (samples.length > 24) samples.shift();
      if (drag) main.style.setProperty("--swipe-p", p.toFixed(4));
      return p;
    },
    /** Release: back, or home. */
    end(cancelled = false) {
      if (!cancelled && swipeCommits(p, velocityOf(samples))) commit();
      else settle();
    },
    reset: clear,
  };
}

type WheelGesture = {
  t: number;
  /** The <main> this gesture may pull to refresh: set only if it started at the top. */
  pullMain: HTMLElement | null;
  /** Pull distance where the band does not run (px of wheel). */
  pd: number;
  dx: number;
  dy: number;
  axis: "x" | "y" | null;
  mode: "pending" | "band" | "swipe" | "done";
  target: Element | null;
  latched: Element | null;
  sx: number;
};

/**
 * The trackpad gesture in flight. Module scope on purpose: it outlives the <main> it started
 * on, so a committed swipe's momentum lands on the next page as "done", not a second swipe.
 */
let g: WheelGesture | null = null;

function attach(
  main: HTMLElement,
  bandOn: boolean,
  swipeOn: boolean,
  pull: Pull | null,
): () => void {
  const html = document.documentElement;
  const band = createBand(main);
  const swipe = createSwipe(main);
  if (bandOn) main.style.overscrollBehaviorY = "none";
  // Native bounce stays; the browser's own pull to refresh (chained to the page) does not.
  else if (pull) main.style.overscrollBehaviorY = "contain";
  /** Pulls start only at rest: no refresh running, no swipe back on screen. */
  const pullReady = () =>
    !!pull && !pull.busy && atTop(main) && html.dataset.swipeBack == null && !main.dataset.swiping;
  if (swipeOn) {
    main.style.overscrollBehaviorX = "none";
    html.dataset.swipeNav = "";
  }

  // ── Trackpad ──────────────────────────────────────────────────────────────
  let idle = 0;
  let blocking = false;

  const onIdle = () => {
    band.release();
    unblock();
    if (g?.pullMain === main) {
      g.pullMain = null;
      pull?.release(!modalOpen());
    }
    if (g?.mode === "swipe") {
      swipe.end();
      g.mode = "done";
    }
  };

  const handle = (e: WheelEvent) => {
    if (e.ctrlKey) return; // pinch zoom
    if (!g || e.timeStamp - g.t > SWIPE.wheelGapMs) {
      g = {
        t: e.timeStamp,
        pullMain: pullReady() ? main : null,
        pd: 0,
        dx: 0,
        dy: 0,
        axis: null,
        mode: "pending",
        target: e.target as Element | null,
        latched: null,
        sx: 0,
      };
    }
    g.t = e.timeStamp;
    window.clearTimeout(idle);
    idle = window.setTimeout(onIdle, RUBBER.wheelIdleMs);

    if (g.mode === "pending") {
      g.dx += e.deltaX;
      g.dy += e.deltaY;
      g.axis = lockAxis(g.dx, g.dy, 6);
      if (!g.axis) return;
      if (g.axis === "x") {
        // Fingers moving right scroll left: deltaX < 0.
        const ok =
          swipeOn &&
          g.dx < 0 &&
          !modalOpen() &&
          !swipeBlocked(g.target, main, true) &&
          canSwipeBack();
        g.mode = ok ? "swipe" : "done";
        if (ok) {
          swipe.start();
          g.sx = -g.dx;
        }
      } else {
        g.mode = "band";
      }
    } else if (g.mode === "swipe") {
      g.sx -= e.deltaX;
    }

    if (g.mode === "swipe") {
      const p = swipe.move(Math.max(0, g.sx), SWIPE.trackpadTrack, e.timeStamp);
      if (p >= 1) {
        swipe.end();
        g.mode = "done";
      }
      return;
    }
    if (g.mode !== "band") return;

    const precise = isPreciseWheel(e as WheelEvent & { wheelDeltaY?: number });
    const banding = bandOn && !reducedMotion() && precise;
    const dir = Math.sign(e.deltaY);
    if (!banding) {
      band.release();
      unblock();
    } else if (band.active) {
      // The band holds the gesture: deltas move it, never the page.
      if (e.cancelable) e.preventDefault();
      band.pull(-e.deltaY, RUBBER.wheelDimension);
      if (!band.active) unblock();
    } else if (dir) {
      g.latched ??= latchY(g.target, main, dir);
      if (g.latched === main && !modalOpen() && (dir < 0 ? atTop(main) : atBottom(main))) {
        band.pull(-e.deltaY, RUBBER.wheelDimension);
        block();
      }
    }
    if (g.pullMain === main) wheelPull(g, e.deltaY, precise, banding);
  };

  /** The band's own distance where it runs; the summed deltas where it does not. */
  const wheelPull = (w: WheelGesture, deltaY: number, precise: boolean, banding: boolean) => {
    if (deltaY) w.latched ??= latchY(w.target, main, Math.sign(deltaY));
    if (!w.latched) return;
    // A notch, an inner scroller, a page that scrolled, or a modal: not a pull.
    if (!precise || w.latched !== main || main.scrollTop > 0 || modalOpen()) {
      w.pullMain = null;
      pull?.release(false);
      return;
    }
    w.pd = banding ? Math.max(0, band.over) : Math.max(0, w.pd - deltaY);
    pull?.move(pullProgress(w.pd, RUBBER.wheelDimension));
  };

  // Passive normally; a blocking listener only while the band holds the gesture, so the
  // page never waits on script to scroll.
  const onWheelPassive = (e: WheelEvent) => {
    if (!blocking) handle(e);
  };
  const onWheelBlocking = (e: WheelEvent) => handle(e);
  function block() {
    if (blocking) return;
    blocking = true;
    main.addEventListener("wheel", onWheelBlocking, { passive: false });
  }
  function unblock() {
    if (!blocking) return;
    blocking = false;
    main.removeEventListener("wheel", onWheelBlocking);
  }

  // ── Touch ─────────────────────────────────────────────────────────────────
  type TouchGesture = {
    id: number;
    x0: number;
    y0: number;
    lastY: number;
    edge: boolean;
    target: Element | null;
    mode: "pending" | "band" | "swipe" | "native";
    /** Still a pull to refresh: started at the top and has not scrolled. */
    pull: boolean;
  };
  let tg: TouchGesture | null = null;
  const track = () => Math.min(main.clientWidth, 480);
  const touchDim = () => Math.min(main.clientHeight, RUBBER.touchDimension);

  const endTouch = (cancelled: boolean) => {
    if (tg?.pull) pull?.release(!cancelled && !modalOpen());
    if (tg?.mode === "band") band.release();
    if (tg?.mode === "swipe") swipe.end(cancelled);
    tg = null;
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      endTouch(true);
      return;
    }
    const t = e.touches[0]!;
    tg = {
      id: t.identifier,
      x0: t.clientX,
      y0: t.clientY,
      lastY: t.clientY,
      edge: t.clientX - main.getBoundingClientRect().left <= SWIPE.edge,
      target: e.target as Element | null,
      mode: "pending",
      pull: pullReady(),
    };
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!tg) return;
    const t = Array.from(e.changedTouches).find((c) => c.identifier === tg!.id);
    if (!t) return;
    const dx = t.clientX - tg.x0;
    const dy = t.clientY - tg.y0;

    if (tg.mode === "pending") {
      const axis = lockAxis(dx, dy);
      if (!axis) return;
      const ownY =
        axis === "y" &&
        !modalOpen() &&
        !tg.target?.closest(DRAG_OWNERS) &&
        latchY(tg.target, main, dy > 0 ? -1 : 1) === main &&
        (dy > 0 ? atTop(main) : atBottom(main));
      if (!ownY || dy <= 0) tg.pull = false;
      // Once the browser has started scrolling, the gesture is its own.
      if (!e.cancelable) tg.mode = "native";
      else if (
        axis === "x" &&
        dx > 0 &&
        tg.edge &&
        swipeOn &&
        !modalOpen() &&
        (window.getSelection()?.isCollapsed ?? true) &&
        !swipeBlocked(tg.target, main, false) &&
        canSwipeBack()
      ) {
        tg.mode = "swipe";
        swipe.start();
      } else if (ownY && bandOn && !reducedMotion()) {
        tg.mode = "band";
      } else tg.mode = "native";
    }

    if (tg.mode === "swipe") {
      e.preventDefault();
      swipe.move(dx, track(), e.timeStamp);
    } else if (tg.mode === "band") {
      // We own this drag now: the band takes what the page cannot scroll, and a drag back
      // past the edge scrolls the page by hand.
      e.preventDefault();
      let step = t.clientY - tg.lastY;
      tg.lastY = t.clientY;
      let moved = true;
      if (!band.active) {
        const before = main.scrollTop;
        main.scrollTop = before - step;
        const rest = -step - (main.scrollTop - before);
        moved = Math.abs(rest) >= 0.5;
        step = -rest;
      }
      if (moved) {
        const left = band.pull(step, touchDim());
        if (left) main.scrollTop -= left;
      }
    }

    if (tg.pull) {
      if (main.scrollTop > 0 || modalOpen()) {
        tg.pull = false;
        pull?.release(false);
      } else {
        // The band's distance where it runs; the finger's travel where it does not.
        const d = tg.mode === "band" ? band.over : t.clientY - tg.y0;
        pull?.move(pullProgress(d, touchDim()));
      }
    }
  };

  const onTouchEnd = () => endTouch(false);
  const onTouchCancel = () => endTouch(true);

  main.addEventListener("wheel", onWheelPassive, { passive: true });
  main.addEventListener("touchstart", onTouchStart, { passive: true });
  // Passive where nothing here can claim a drag (pull to refresh only reads it).
  main.addEventListener("touchmove", onTouchMove, { passive: !bandOn && !swipeOn });
  main.addEventListener("touchend", onTouchEnd);
  main.addEventListener("touchcancel", onTouchCancel);

  return () => {
    window.clearTimeout(idle);
    unblock();
    main.removeEventListener("wheel", onWheelPassive);
    main.removeEventListener("touchstart", onTouchStart);
    main.removeEventListener("touchmove", onTouchMove);
    main.removeEventListener("touchend", onTouchEnd);
    main.removeEventListener("touchcancel", onTouchCancel);
    band.reset();
    swipe.reset();
    pull?.reset();
    main.style.removeProperty("overscroll-behavior-y");
    main.style.removeProperty("overscroll-behavior-x");
    delete html.dataset.swipeNav;
  };
}
