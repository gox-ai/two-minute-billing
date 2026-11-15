"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { chooseListLayout, type ListLayout } from "@/lib/list-layout";

/**
 * Which list layout to mount, from the width of the list's own card.
 *
 * `probe` is a zero-height element inside the card that is 1px wide only while the card's
 * `list-narrow` container query matches, so the hook reads the same verdict CSS applies and
 * the two can never disagree at a fractional width.
 *
 * The server cannot know the width, so the server render, the hydration and the rest of the
 * stream mount `both` and CSS shows the right one. Only after `load` does the unused layout
 * unmount: while the server still streams, a part of the list may be a pending Suspense
 * segment, and unmounting the layout that holds it makes the late segment land on a removed
 * node (a hydration error, then a client re-render).
 *
 * A client navigation mounts `both` for its first commit and drops one in a layout effect,
 * before the first paint: the card has no width until it is in the DOM.
 *
 * While Billy's edge is dragged or the panel moves (`<html data-billy-resizing>`,
 * `data-billy-moving`) the mounted layout stays, and app/motion/billy-push.css keeps it shown:
 * a swap mid-move rebuilds every row in one frame. It swaps once the page has settled.
 */
const BUSY = ["data-billy-resizing", "data-billy-moving"];

export function useListLayout(probe: React.RefObject<HTMLElement | null>): ListLayout {
  const [narrow, setNarrow] = React.useState<boolean | null>(null);

  React.useLayoutEffect(() => {
    const el = probe.current;
    if (!el) return;
    const read = () => el.offsetWidth > 0;
    const onLoad = () => setNarrow(read());
    // A measurement, committed before the paint.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (document.readyState === "complete") setNarrow(read());
    else window.addEventListener("load", onLoad, { once: true });
    // The probe changes size only when the verdict flips. Commit in the same frame, so the
    // layout CSS has just shown is mounted before the paint.
    const html = document.documentElement;
    const settled = () =>
      document.readyState === "complete" && !BUSY.some((a) => html.hasAttribute(a));
    const ro = new ResizeObserver(() => {
      if (!settled()) return;
      const next = read();
      flushSync(() => setNarrow(next));
    });
    ro.observe(el);
    const mo = new MutationObserver(() => {
      if (settled()) flushSync(() => setNarrow(read()));
    });
    mo.observe(html, { attributeFilter: BUSY });
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("load", onLoad);
    };
  }, [probe]);

  return chooseListLayout(narrow);
}
