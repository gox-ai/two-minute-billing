import type * as React from "react";

/**
 * Font size for a headline figure inside an `@container`: its class size (`1em` of the
 * parent) when it fits, smaller when it does not, so a figure never breaks or spills.
 * 0.6em is a safe width for one character of a formatted amount.
 */
export function fitFigure(text: string): React.CSSProperties {
  return { fontSize: `min(1em, ${(100 / (Math.max(text.length, 1) * 0.6)).toFixed(2)}cqi)` };
}
