"use client";

import * as React from "react";
import { observeSettledResize } from "./settled-resize";

// A stacked table goes back to a grid only with this much room to spare, so a scrollbar or a
// row that grows when stacked cannot swap it back and forth.
const SLACK = 24;

/**
 * The width a table needs laid out as a grid: its min-content width, or its `min-w-*` floor.
 * An auto-layout table never shrinks below that, so a zero width reads it in one layout.
 */
export function tableNeed(table: HTMLElement): number {
  const prev = table.style.width;
  table.style.width = "0px";
  const need = table.getBoundingClientRect().width;
  table.style.width = prev;
  return need;
}

/** Stack (true) or keep the grid, with `SLACK` of hysteresis on the way back. */
export function shouldStack(need: number, room: number, stacked: boolean): boolean {
  return stacked ? need > room - SLACK : need > room + 0.5;
}

/**
 * `<Table fit>`: sets `data-fit="stack"` on the table's container while the table, laid out as
 * a grid, is wider than the container. The `stacked:` variant (globals.css) then draws the rows
 * a phone gets. The verdict is a DOM attribute, set before the paint: React renders the same
 * markup on the server and the client, so there is no hydration mismatch and no re-render.
 * Below 640px the media query stacks the table already.
 */
export function useFitStack(box: React.RefObject<HTMLElement | null>, on: boolean) {
  React.useLayoutEffect(() => {
    const el = box.current;
    const table = el?.firstElementChild as HTMLElement | null;
    if (!on || !el || !table) return;
    const fit = () => {
      const stacked = el.getAttribute("data-fit") === "stack";
      // Measured as a grid; the attribute is back in the same task, so no frame shows it.
      el.removeAttribute("data-fit");
      if (window.innerWidth < 640) return;
      if (shouldStack(tableNeed(table), el.clientWidth, stacked))
        el.setAttribute("data-fit", "stack");
    };
    fit();
    // The container's width and the table's content both decide. A resize the swap itself
    // causes reads the same verdict, so it settles in one pass.
    const stops = [observeSettledResize(el, fit), observeSettledResize(table, fit)];
    return () => {
      for (const stop of stops) stop();
      el.removeAttribute("data-fit");
    };
  }, [box, on]);
}
