"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { chooseListLayout, type ListLayout } from "@/lib/list-layout";
import { observeSettledResize } from "@/lib/settled-resize";
import { shouldStack, tableNeed } from "@/lib/use-fit-stack";

const BUSY = ["data-billy-resizing", "data-billy-moving"];

/**
 * Which list layout to mount, from the width of the list's own card and of its table.
 *
 * `probe` is a zero-height element inside the card that is 1px wide only while the card's
 * `list-narrow` container query matches, so the hook reads the same verdict CSS applies and
 * the two can never disagree at a fractional width. `body` holds the layouts: when the table
 * mounted in a wide card is wider than the card, the rows stack too, and go back to the table
 * once the card has room for the width the table needed. `content` changes when the rows or
 * the visible columns do: a stacked list then tries the table again.
 *
 * The server cannot know the width, so the server render, the hydration and the rest of the
 * stream mount `both` and CSS shows the right one. Only after `load` does the unused layout
 * unmount: while the server still streams, a part of the list may be a pending Suspense
 * segment, and unmounting the layout that holds it makes the late segment land on a removed
 * node (a hydration error, then a client re-render).
 *
 * A client navigation mounts `both` for its first commit and drops one in a layout effect,
 * before the first paint: the card has no width until it is in the DOM. Each try of the table
 * is measured in a layout effect and undone before the paint when it does not fit.
 *
 * While Billy's edge is dragged or the panel moves (`<html data-billy-resizing>`,
 * `data-billy-moving`) the mounted layout stays, and app/motion/billy-push.css keeps it shown:
 * a swap mid-move rebuilds every row in one frame. It swaps once the page has settled.
 */
export function useListLayout(
  probe: React.RefObject<HTMLElement | null>,
  body: React.RefObject<HTMLElement | null>,
  content: unknown,
): ListLayout {
  const [narrow, setNarrow] = React.useState<boolean | null>(null);
  // The width the table needed when it last did not fit the card; null while it fits.
  const [need, setNeed] = React.useState<number | null>(null);
  const layout = chooseListLayout(narrow, need !== null);
  const state = React.useRef({ layout, need, content });
  React.useLayoutEffect(() => {
    state.current.layout = layout;
    state.current.need = need;
  });

  const table = React.useCallback(
    () => body.current?.querySelector<HTMLElement>(":scope > [data-slot=table-container] > table"),
    [body],
  );
  // The table's need when it does not fit the card, else null.
  const overflow = React.useCallback(() => {
    const t = table();
    const room = body.current?.clientWidth ?? 0;
    if (!t) return null;
    const n = tableNeed(t);
    return shouldStack(n, room, false) ? n : null;
  }, [body, table]);

  // A mounted table is measured after each commit that may change its width.
  React.useLayoutEffect(() => {
    const s = state.current;
    const changed = s.content !== content;
    s.content = content;
    // A measurement, committed before the paint.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (layout === "table") {
      const n = overflow();
      if (n !== null) setNeed(n);
    } else if (changed && need !== null) setNeed(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [layout, content, need, overflow]);

  React.useLayoutEffect(() => {
    const el = probe.current;
    const box = body.current;
    if (!el || !box) return;
    const read = () => el.offsetWidth > 0;
    const html = document.documentElement;
    const settled = () =>
      document.readyState === "complete" && !BUSY.some((a) => html.hasAttribute(a));
    const sync = () => {
      const { layout: now, need: n } = state.current;
      let next = n;
      if (n !== null && !shouldStack(n, box.clientWidth, true)) next = null;
      else if (n === null && now === "table") next = overflow();
      flushSync(() => {
        setNarrow(read());
        setNeed(next);
      });
    };
    const onLoad = () => sync();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (document.readyState === "complete") setNarrow(read());
    else window.addEventListener("load", onLoad, { once: true });
    // The probe changes size only when the verdict flips; the body with the card and the
    // table with its content. Commit in the same frame, so the layout CSS has just shown is
    // mounted before the paint.
    const ro = new ResizeObserver(() => {
      if (settled()) sync();
    });
    ro.observe(el);
    ro.observe(box);
    const mo = new MutationObserver(() => {
      if (settled()) sync();
    });
    mo.observe(html, { attributeFilter: BUSY });
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("load", onLoad);
    };
  }, [probe, body, overflow]);

  // A table whose content grows wider without the card changing size.
  React.useLayoutEffect(() => {
    const t = layout === "table" ? table() : null;
    if (!t) return;
    return observeSettledResize(t, () => {
      if (document.readyState !== "complete" || state.current.need !== null) return;
      const n = overflow();
      if (n !== null) flushSync(() => setNeed(n));
    });
  }, [layout, table, overflow]);

  return layout;
}
