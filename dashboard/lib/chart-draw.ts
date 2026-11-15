import type * as React from "react";
import { CHART_DRAW } from "./motion";

/**
 * Chart entrances (app/motion/charts.css). The classes are `chart-*`, not `anim-*`: a chart
 * is content, so it still draws on a page entered by navigation.
 */

/** A bar that grows from its left edge. Flag off: today's `.anim-grow`. */
export const BAR_GROW = CHART_DRAW ? "chart-bar" : "anim-grow";

/** A bar's width and its turn: 40ms per bar, capped at the twelfth. */
export function barStyle(widthPct: number | string, turn = 0): React.CSSProperties {
  const width = typeof widthPct === "number" ? `${widthPct}%` : widthPct;
  return CHART_DRAW
    ? ({ width, "--bar-turn": Math.min(Math.max(0, turn), 11) } as React.CSSProperties)
    : { width };
}

/**
 * A short, stable signature of a chart's data, for a React `key`: new data remounts the mark
 * and replays the draw; a refresh that returns the same data keeps it still. FNV-1a.
 */
export function drawKey(values: ReadonlyArray<number | string | null | undefined>): string {
  if (!CHART_DRAW) return "";
  let h = 0x811c9dc5;
  for (const v of values) {
    const s = v == null ? "~" : String(v);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
