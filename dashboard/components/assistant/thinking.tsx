"use client";

import * as React from "react";
import { BillyMark } from "./billy-mark";

/**
 * While Billy works: a breathing mark and what it is doing now, with the seconds so far. A grey
 * "Working…" line read as stalled; this one says which phase the turn is in. The status region
 * announces the phase only, never the ticking seconds. Motion is off under reduced motion.
 */
export function ThinkingIndicator({
  steps,
  hasText,
  startedAt,
}: {
  steps: Array<{ phase: "running" | "done" | "error" }>;
  hasText: boolean;
  startedAt?: number;
}) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  // Between steps the model is choosing its next one, so that is "Thinking" too: "Writing" only
  // once text arrives (a step can still follow a pause that looked like the last one).
  const label = hasText
    ? "Writing"
    : steps.some((s) => s.phase === "running")
      ? "Working"
      : "Thinking";
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className="motion-safe:animate-pulse">
        <BillyMark size={16} />
      </span>
      <span role="status" className="font-medium text-foreground">
        {label}
      </span>
      {seconds >= 3 ? (
        <span aria-hidden className="text-xs tabular-nums">
          {seconds} s
        </span>
      ) : null}
    </div>
  );
}
