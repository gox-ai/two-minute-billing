"use client";

import * as React from "react";
import { GripVertical } from "lucide-react";
import {
  type Box,
  type Side,
  box,
  clampToViewport,
  inflate,
  placeCard,
  placeSheet,
} from "@/lib/coach-placement";
import { cn } from "@/lib/utils";

/**
 * Shared by the product tour and the "Show me" guide: places the card clear of its target and
 * of any open menu, re-places it when the page moves, and lets the member drag it away.
 */

/** Below this the card docks to the bottom as a sheet. */
const SHEET_BELOW = 640;
/** The highlight ring sits this far outside the target; the card stays clear of it. */
const RING = 8;
const STEP_PX = 16;

const MENUS = [
  "[data-radix-popper-content-wrapper]",
  "[role=menu]",
  "[role=listbox]",
  ...[
    "popover-content",
    "dropdown-menu-content",
    "dropdown-menu-sub-content",
    "select-content",
    "hover-card-content",
  ].map((s) => `[data-state=open][data-slot=${s}]`),
  // The assistant bubble and its nudge float above every page.
  '[data-tour="assistant"]',
  "[data-billy-nudge]",
].join(", ");

const toBox = (r: DOMRect): Box => box(r.left, r.top, r.width, r.height);

/** Open menus, listboxes and popovers, plus the assistant bubble. Never the card itself. */
function keepOuts(card: HTMLElement | null): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(MENUS)) {
    if (card?.contains(el) || el.closest("[data-coach-card], [data-assistant-panel]")) continue;
    // Radix keeps a closed popper mounted until its exit animation ends.
    if (el.querySelector(":scope > [data-state=closed]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push(toBox(r));
  }
  return out;
}

/** The page's sticky action bar and side summary cards: covered only when nothing else fits. */
const AVOID = "[data-action-bar], main aside";

function avoids(card: HTMLElement | null): Box[] {
  const out: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(AVOID)) {
    if (card?.contains(el) || el.closest("[data-coach-card], [data-assistant-panel]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight)
      out.push(toBox(r));
  }
  return out;
}

/** The window, less the assistant panel when it is docked on the right. */
function viewport(): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const panel = document.querySelector("[data-assistant-panel]")?.getBoundingClientRect();
  const right = panel && panel.width > 0 && panel.left > vw / 2 ? panel.left : vw;
  return box(0, 0, right, vh);
}

function scrollParent(el: Element | null): Element {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Runs `fn` once per frame at most; a timer covers a browser that delivers no frames. */
function throttle(fn: () => void): { run: () => void; cancel: () => void } {
  let pending = false;
  let timer = 0;
  const fire = () => {
    if (!pending) return;
    pending = false;
    window.clearTimeout(timer);
    fn();
  };
  return {
    run: () => {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame?.(fire);
      timer = window.setTimeout(fire, 50);
    },
    cancel: () => {
      pending = false;
      window.clearTimeout(timer);
    },
  };
}

interface Placed {
  key: string;
  left: number;
  top: number;
  sheet: boolean;
  target: Box | null;
}

const same = (a: Placed | null, b: Placed) =>
  !!a &&
  a.key === b.key &&
  Math.round(a.left) === Math.round(b.left) &&
  Math.round(a.top) === Math.round(b.top) &&
  a.sheet === b.sheet &&
  JSON.stringify(a.target) === JSON.stringify(b.target);

export function useCoachCard({
  cardRef,
  stepKey,
  measureTarget,
  targetEl,
  keepOut,
  width,
  prefer = "right",
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  /** Null while no card shows. A new key drops the dragged position. */
  stepKey: string | null;
  /** The target's rect, read on every re-place. */
  measureTarget: () => DOMRect | null;
  /** The target element, for the phone-width scroll. */
  targetEl?: () => Element | null;
  /** More rects the card must not cover, read on every re-place (the target's section title). */
  keepOut?: () => DOMRect[];
  width: number;
  prefer?: Side;
}) {
  // Both keyed by step, so a new step starts auto-placed and not dragging.
  const [state, setState] = React.useState<Placed | null>(null);
  const [dragKey, setDragKey] = React.useState<string | null>(null);
  const placed = state && state.key === stepKey ? state : null;
  const dragging = !!stepKey && dragKey === stepKey;
  // Set when the member moves the card; kept for the rest of this step.
  const dragged = React.useRef<{ key: string; left: number; top: number } | null>(null);
  const scrolledFor = React.useRef<string | null>(null);
  const live = React.useRef({ measureTarget, targetEl, keepOut, prefer, stepKey });
  React.useLayoutEffect(() => {
    live.current = { measureTarget, targetEl, keepOut, prefer, stepKey };
  });

  const measure = React.useCallback(() => {
    const card = cardRef.current;
    const {
      stepKey: key,
      measureTarget: read,
      targetEl: elOf,
      keepOut: extra,
      prefer: side,
    } = live.current;
    const more = () => (extra?.() ?? []).filter((r) => r.width > 0 && r.height > 0).map(toBox);
    if (!card || !key) return;
    const win = box(0, 0, window.innerWidth, window.innerHeight);
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const sheet = window.innerWidth < SHEET_BELOW;
    // Twice at most: once more after the phone-width scroll.
    for (let pass = 0; pass < 2; pass++) {
      const raw = read();
      const target = raw ? inflate(toBox(raw), RING) : null;
      let at: { left: number; top: number };
      if (dragged.current?.key === key) {
        at = clampToViewport(dragged.current, size, win);
      } else if (sheet) {
        const s = placeSheet({
          height: size.height,
          viewport: win,
          target,
          keepOut: [...keepOuts(card), ...more()],
          scrolled: scrolledFor.current === key,
        });
        if (s.scrollBy && pass === 0) {
          scrolledFor.current = key;
          // Instant: a smooth scroll is frame-driven and can stall.
          scrollParent(elOf?.() ?? null).scrollBy({ top: s.scrollBy });
          continue;
        }
        at = s;
      } else {
        const vp = viewport();
        at = placeCard({
          card: size,
          viewport: vp,
          target,
          keepOut: [...keepOuts(card), ...more()],
          avoid: avoids(card),
          prefer: side,
        });
      }
      const next = { key, left: at.left, top: at.top, sheet, target: raw ? toBox(raw) : null };
      setState((prev) => (same(prev, next) ? prev : next));
      return;
    }
  }, [cardRef]);

  // A new step: auto-placement again, measured before paint.
  React.useLayoutEffect(() => {
    dragged.current = null;
    measure();
  }, [stepKey, measure]);

  // Follow scroll, resize, the card's own size, and menus opening or closing.
  React.useEffect(() => {
    if (!stepKey) return;
    const t = throttle(measure);
    window.addEventListener("resize", t.run);
    window.addEventListener("scroll", t.run, true);
    const ro = new ResizeObserver(t.run);
    if (cardRef.current) ro.observe(cardRef.current);
    const mo = new MutationObserver(t.run);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-expanded", "hidden", "style"],
    });
    return () => {
      t.cancel();
      window.removeEventListener("resize", t.run);
      window.removeEventListener("scroll", t.run, true);
      ro.disconnect();
      mo.disconnect();
    };
  }, [stepKey, measure, cardRef]);

  const moveTo = (left: number, top: number) => {
    if (!stepKey) return;
    dragged.current = { key: stepKey, left, top };
    measure();
  };

  const start = React.useRef<{ id: number; dx: number; dy: number; x: number; y: number } | null>(
    null,
  );
  const handleProps = {
    "data-coach-handle": "",
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !placed) return;
      // The card's buttons keep working: a drag never starts on one.
      const hit = e.target as Element;
      if (hit.closest("button:not([data-coach-grip]), a, input, select, textarea, [role=button]"))
        return;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // No active pointer with that id (a synthetic event): drag without capture.
      }
      start.current = {
        id: e.pointerId,
        dx: e.clientX - placed.left,
        dy: e.clientY - placed.top,
        x: e.clientX,
        y: e.clientY,
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      if (!dragging && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 3) return;
      if (!dragging) setDragKey(stepKey);
      moveTo(e.clientX - s.dx, e.clientY - s.dy);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (start.current?.id !== e.pointerId) return;
      start.current = null;
      setDragKey(null);
      if (e.currentTarget.hasPointerCapture?.(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onPointerCancel: () => {
      start.current = null;
      setDragKey(null);
    },
  };

  const onGripKey = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? STEP_PX * 4 : STEP_PX;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-d, 0],
      ArrowRight: [d, 0],
      ArrowUp: [0, -d],
      ArrowDown: [0, d],
    };
    const v = by[e.key];
    if (!v || !placed) return;
    e.preventDefault();
    moveTo(placed.left + v[0], placed.top + v[1]);
  };

  // Hidden until measured; the layout effect places it before the first paint.
  const style: React.CSSProperties = placed
    ? placed.sheet
      ? { left: placed.left, top: placed.top, width: "calc(100vw - 32px)" }
      : { left: placed.left, top: placed.top, width, maxWidth: "calc(100vw - 32px)" }
    : { left: 0, top: 0, width, visibility: "hidden" };

  return { style, target: placed?.target ?? null, dragging, handleProps, onGripKey };
}

/** The drag grip: also moves the card with the arrow keys. */
export function CoachGrip({
  onKeyDown,
  dragging,
}: {
  onKeyDown: (e: React.KeyboardEvent) => void;
  dragging: boolean;
}) {
  return (
    <button
      type="button"
      data-coach-grip
      aria-label="Move this card"
      title="Move this card"
      onKeyDown={onKeyDown}
      className={cn(
        "-ml-1.5 inline-flex size-6 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
        dragging ? "cursor-grabbing" : "cursor-grab",
      )}
    >
      <GripVertical className="size-4" aria-hidden />
    </button>
  );
}
