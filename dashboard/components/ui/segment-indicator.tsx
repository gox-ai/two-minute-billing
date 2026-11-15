"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type Box = { x: number; y: number; w: number; h: number };

/** The selected segment: a Radix tab, or a `segmentItem(true)` link/button. */
const ACTIVE = '[role="tab"][data-state="active"], .segment-on';

/**
 * The segmented control's selected pill, as ONE element that slides to the new segment.
 *
 * Render it as the first child of a `SEGMENT_TRACK` (or a default `TabsList`). It measures
 * the active segment in layout space (sub-pixel, with any ancestor scale divided out), so a
 * parent mid-animation cannot skew it. Until it has measured, the segment paints its own
 * pill — server HTML and a first paint look identical, and nothing shifts. Once placed, the
 * track gets `data-segment-ready` and globals.css hides the segment's own pill.
 *
 * A URL nav keeps the slide only while React keeps the nav mounted (a search-param change on
 * the same page); a nav to another page mounts a new track, which starts in place.
 */
export function SegmentIndicator({ className }: { className?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [box, setBox] = React.useState<Box | null>(null);
  const [placed, setPlaced] = React.useState(false);

  React.useLayoutEffect(() => {
    const track = ref.current?.parentElement;
    if (!track) return;

    const measure = () => {
      const active = track.querySelector<HTMLElement>(ACTIVE);
      const t = track.getBoundingClientRect();
      const r = active?.getBoundingClientRect();
      // Hidden or collapsed: let the segment paint itself.
      if (!active || !r || r.width === 0 || t.width === 0) {
        track.removeAttribute("data-segment-ready");
        setBox(null);
        return;
      }
      // Rects carry any ancestor transform (a takeover mid-pop is scaled); divide it out
      // against the track's untransformed layout width so the pill lands in layout space.
      const k = t.width / (Number.parseFloat(getComputedStyle(track).width) || t.width);
      const next = {
        x: (r.left - t.left) / k - track.clientLeft + track.scrollLeft,
        y: (r.top - t.top) / k - track.clientTop + track.scrollTop,
        w: r.width / k,
        h: r.height / k,
      };
      setBox((b) =>
        b && b.x === next.x && b.y === next.y && b.w === next.w && b.h === next.h ? b : next,
      );
      track.setAttribute("data-segment-ready", "");
    };

    measure();
    const ro = new ResizeObserver(measure);
    const observeAll = () => {
      ro.disconnect();
      ro.observe(track);
      for (const c of track.children) ro.observe(c);
    };
    observeAll();
    // Selection is a class or data-state change; a re-render can also swap the children.
    const mo = new MutationObserver((records) => {
      if (records.some((r) => r.type === "childList")) observeAll();
      measure();
    });
    mo.observe(track, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-state", "aria-selected", "aria-current"],
    });
    return () => {
      ro.disconnect();
      mo.disconnect();
      track.removeAttribute("data-segment-ready");
    };
  }, []);

  // The first placement must not animate in from 0,0.
  React.useEffect(() => {
    if (box && !placed) setPlaced(true);
  }, [box, placed]);

  return (
    <span
      ref={ref}
      aria-hidden
      data-slot="segment-indicator"
      className={cn(
        "pointer-events-none absolute top-0 left-0 -z-10 rounded-md bg-raised shadow-xs",
        placed && "transition-[transform,width,height] duration-(--dur) ease-(--ease-spring)",
        !box && "invisible",
        className,
      )}
      style={
        box
          ? { transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: box.h }
          : undefined
      }
    />
  );
}
