/// <reference types="react/canary" />
"use client";

import * as React from "react";
import { ViewTransition } from "react";
import { useLinkStatus } from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { LARGE_TITLE_COLLAPSE } from "@/lib/motion";
import {
  armSharedTitle,
  dropSharedTitle,
  landSharedTitle,
  sharedTitlePending,
  type SharedTitleSession,
} from "@/lib/shared-title";

/**
 * Page navigation, as an app moves. ONE view transition, on `<main>` only, so the rail, the top bar
 * and Billy stay still (they are the root snapshot, which globals.css does not animate).
 *
 * The kind of move is decided BEFORE React commits and written to `<html data-nav-motion>`,
 * which the `::view-transition-*` rules read:
 *   push — a link deeper in the tree (or browser forward): the new page slides in from the right
 *   pop  — a link back up (or browser back): the reverse
 *   tab  — a rail item, a tab strip, or anything we cannot classify: a quick cross-fade
 *
 * `main` is keyed by pathname: only a pathname change animates. A search-param change (a tab
 * on `?tab=`, a filter) and `router.refresh()` after a save never move the page.
 */

type Motion = "push" | "pop" | "tab";

const depth = (path: string) => path.split("/").filter(Boolean).length;

const SKELETON = '[aria-busy="true"][aria-label^="Loading"]';

/** First client mount = a hard load, which plays the archetype entrances instead. */
let hydrated = false;

export function RouteMain({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <ViewTransition key={pathname} enter="page-in" exit="page-out" default="none">
      <RouteMainBox className={className}>{children}</RouteMainBox>
    </ViewTransition>
  );
}

function RouteMainBox({ className, children }: { className?: string; children: React.ReactNode }) {
  // Entered by navigation: the view transition is this page's entrance, so globals.css
  // turns the `.anim-*` entrances off inside it (one entrance, never two).
  const [entered] = React.useState(() => hydrated);
  // The transition landed on a skeleton: the real content arrives after it, and fades in
  // (globals.css) instead of hard-swapping.
  const ref = React.useRef<HTMLElement>(null);
  const [skeleton, setSkeleton] = React.useState(false);
  React.useLayoutEffect(() => {
    const main = ref.current;
    if (!main) return;
    if (entered && main.querySelector(SKELETON)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSkeleton(true);
      return;
    }
    // A skeleton leaving later (a search-param tab, a Suspense boundary): mark main before
    // the paint, so what replaces it never starts from nothing.
    const mo = new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.removedNodes)
          if (n instanceof Element && (n.matches(SKELETON) || n.querySelector(SKELETON))) {
            main.dataset.routeSkeleton = "";
            mo.disconnect();
            return;
          }
    });
    mo.observe(main, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [entered]);
  React.useEffect(() => {
    hydrated = true;
  }, []);
  return (
    <main
      ref={ref}
      className={className}
      data-route-entered={entered || undefined}
      data-route-skeleton={skeleton || undefined}
    >
      {/* The compact title's sticky host (components/large-title.tsx); takes no space. */}
      {LARGE_TITLE_COLLAPSE ? <div data-compact-slot className="sticky top-0 z-20 h-0" /> : null}
      {children}
    </main>
  );
}

type VT = { skipTransition: () => void; ready: Promise<void>; finished: Promise<void> };
type StartVT = (arg: (() => unknown) | { update?: () => unknown; types?: string[] }) => VT;

/**
 * No-stall guard. A view transition waits for a rendered frame to snapshot the old page;
 * a window that renders no frames (occluded, throttled, a CDP-driven browser) would hold the
 * navigation forever. If the update has not run 400ms after the start, skip the transition:
 * the browser then runs the update at once and the page swaps without animating. One still
 * running at 1.5s (every animation here ends by 420ms) is skipped the same way.
 * It also hands a pending shared title (lib/shared-title.ts) to the navigation's new page.
 */
function guardViewTransitions() {
  const d = document as Document & { startViewTransition?: StartVT; __vtGuard?: boolean };
  if (!d.startViewTransition || d.__vtGuard) return;
  d.__vtGuard = true;
  const start = d.startViewTransition.bind(d);
  d.startViewTransition = (arg) => {
    let ran = false;
    let shared: SharedTitleSession | null = null;
    const update = (fn?: (() => unknown) | null) => {
      ran = true;
      const r = fn?.();
      if (!sharedTitlePending()) return r;
      // Name the landing end once the update (and React's font/image wait) is done.
      return Promise.resolve(r).finally(() => (shared = landSharedTitle()));
    };
    const wrapped =
      typeof arg === "function" ? () => update(arg) : { ...arg, update: () => update(arg?.update) };
    const t = start(wrapped);
    let guarded = false;
    let done = false;
    const end = () => {
      done = true;
      dropSharedTitle(shared);
    };
    t.finished.then(end, end);
    window.setTimeout(() => {
      if (ran) return;
      guarded = true;
      t.skipTransition();
    }, 400);
    // The same with no frames mid-animation: React holds the next commit (a Suspense
    // reveal) until this one finishes, so a frozen animation would freeze the page.
    window.setTimeout(() => {
      if (!done) t.skipTransition();
    }, 1500);
    // React reports an aborted transition as an error; a guarded skip is expected, so it
    // reaches React as the "invalid state" skip it already treats as silent.
    const ready = t.ready.catch((e: unknown) => {
      throw guarded
        ? new DOMException("Transition was aborted because of invalid state", "InvalidStateError")
        : e;
    });
    return new Proxy(t, {
      get: (target, key) =>
        key === "ready"
          ? ready
          : typeof target[key as keyof VT] === "function"
            ? (target[key as keyof VT] as () => void).bind(target)
            : target[key as keyof VT],
    });
  };
}

function setMotion(m: Motion | null) {
  const html = document.documentElement;
  if (m) html.dataset.navMotion = m;
  else delete html.dataset.navMotion;
}

/** The anchor a click will follow in this app, or null. */
function appLink(e: MouseEvent): URL | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement) || a.hasAttribute("download")) return null;
  if (a.target && a.target !== "_self") return null;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return null;
  if (url.pathname === location.pathname && url.search === location.search) return null;
  return url;
}

function classify(a: Element | null, url: URL): Motion {
  // Moving sideways between sections or tabs is a tab switch, not a push.
  if (a?.closest(".app-rail, [data-nav-tabs], [data-segment-ready], [role=tablist]")) return "tab";
  const from = depth(location.pathname);
  const to = depth(url.pathname);
  if (to < from || location.pathname.startsWith(`${url.pathname}/`)) return "pop";
  return "push";
}

/**
 * Mounted once in the signed-in shell: classifies each navigation, and draws the pending bar.
 * The bar starts on the click (after 80ms, so a prefetched page does not flash it) and finishes
 * when the URL changes; a click that never navigates lets it go after 8s.
 */
export function NavMotion() {
  return (
    <React.Suspense fallback={null}>
      <NavMotionInner />
    </React.Suspense>
  );
}

function NavMotionInner() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [phase, setPhase] = React.useState<"idle" | "loading" | "done">("idle");
  const timers = React.useRef<number[]>([]);
  const lastIndex = React.useRef<number | null>(null);
  const lastPath = React.useRef(pathname);

  const clear = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
  };

  React.useEffect(() => {
    guardViewTransitions();
    const nav = (window as { navigation?: { currentEntry?: { index: number } } }).navigation;
    const onClick = (e: MouseEvent) => {
      const url = appLink(e);
      if (!url) return;
      const a = (e.target as Element).closest("a");
      const m = classify(a, url);
      setMotion(m);
      armSharedTitle(m, location.pathname, url.pathname, a);
      clear();
      timers.current.push(
        window.setTimeout(() => setPhase("loading"), 80),
        window.setTimeout(() => setPhase("idle"), 8000),
      );
    };
    // Browser back/forward. React commits a popstate synchronously, outside any view
    // transition, so this listener (registered before the router's: child effects run
    // first) wraps it in one: snapshot the old <main>, replay the event to the router
    // inside the update, and pair old and new <main> under one name.
    let replaying = false;
    const onPop = (e: PopStateEvent) => {
      if (replaying) return;
      const i = nav?.currentEntry?.index;
      const m: Motion =
        i != null && lastIndex.current != null && i > lastIndex.current ? "push" : "pop";
      setMotion(m);
      const start = (document as { startViewTransition?: StartVT }).startViewTransition;
      // A gesture the browser already animates, or a hidden tab: let the router swap at once.
      if (
        !start ||
        document.visibilityState !== "visible" ||
        (e as { hasUAVisualTransition?: boolean }).hasUAVisualTransition
      )
        return;
      e.stopImmediatePropagation();
      // The URL already changed; the page being left is the last one rendered.
      armSharedTitle(m, lastPath.current, location.pathname);
      const name = `page-${m}`;
      const old = document.querySelector("main");
      if (old) old.style.viewTransitionName = name;
      const t = start.call(document, async () => {
        if (old) old.style.viewTransitionName = "";
        replaying = true;
        window.dispatchEvent(new PopStateEvent("popstate", { state: e.state }));
        replaying = false;
        // The router's restore commits in a microtask; let it land, then name the new page.
        await new Promise((r) => setTimeout(r, 0));
        const now = document.querySelector("main");
        if (now) {
          now.style.viewTransitionName = name;
          window.setTimeout(() => now.style.removeProperty("view-transition-name"), 1000);
        }
      });
      // A skipped transition (the guard above, or a newer one) still swaps the page.
      t.ready.catch(() => {});
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  // Arrived: finish the bar, and drop the motion once the transition has run.
  React.useEffect(() => {
    const nav = (window as { navigation?: { currentEntry?: { index: number } } }).navigation;
    lastIndex.current = nav?.currentEntry?.index ?? null;
    lastPath.current = pathname;
    clear();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhase((p) => (p === "idle" ? p : "done"));
    timers.current.push(
      window.setTimeout(() => setPhase("idle"), 400),
      window.setTimeout(() => setMotion(null), 800),
    );
    return clear;
  }, [pathname, search]);

  return (
    <div
      aria-hidden
      data-nav-progress={phase}
      className="nav-progress pointer-events-none fixed inset-x-0 top-0 z-60 h-0.5 origin-left bg-brand"
    />
  );
}

/** Inside a rail `<Link>`: marks it pending at once, so the row lights before the page lands. */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return pending ? <span data-link-pending aria-hidden className="hidden" /> : null;
}
