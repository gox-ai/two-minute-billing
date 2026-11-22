"use client";

import * as React from "react";
import { ROLLING_NUMBERS } from "@/lib/motion";
import { rollParts, rollWords, type RollPart } from "@/lib/rolling-number";

const COLUMN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * A formatted figure whose digits roll to their value: from 0 on mount, from the previous
 * value when `value` changes. Non-digits stay still. Takes the already-formatted string.
 *
 * Each digit sits in a slot sized by the real digit (transparent, in flow), with the 0–9
 * column over it, so the figure keeps the plain string's width and baseline. The roll is a
 * CSS animation in the server HTML: it starts on first paint, and without it the column
 * rests on the final digit (app/motion/rolling-number.css).
 */
export function RollingNumber({ value }: { value: string }) {
  // The value this one replaced, so a change rolls from it rather than from 0.
  const [seen, setSeen] = React.useState<{ cur: string; prev: string | null }>({
    cur: value,
    prev: null,
  });
  if (seen.cur !== value) setSeen({ cur: value, prev: seen.cur });

  const parts = ROLLING_NUMBERS ? rollParts(value, seen.prev) : [];
  if (!parts.some((p) => p.kind === "digit")) return <>{value}</>;

  return (
    <span role="img" aria-label={value}>
      {/* Keyed on the value: a change remounts the columns and replays the roll. */}
      <span key={value} aria-hidden>
        {rollWords(parts).map((word, i) => {
          const first = word[0]!;
          if (first.kind === "space") return first.text;
          return (
            <span key={i} className="roll-word">
              {word.map((p, j) => (p.kind === "digit" ? <Digit key={j} part={p} /> : p.text))}
            </span>
          );
        })}
      </span>
    </span>
  );
}

function Digit({ part }: { part: Extract<RollPart, { kind: "digit" }> }) {
  const style = {
    "--roll-from": part.from,
    "--roll-to": part.to,
    "--roll-delay": `${part.delayMs}ms`,
  } as React.CSSProperties;
  return (
    <span className="roll-digit">
      <span className="roll-ghost">{part.to}</span>
      <span className="roll-window">
        <span
          className="roll-column"
          data-roll={part.from !== part.to ? "" : undefined}
          style={style}
        >
          {COLUMN.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </span>
      </span>
    </span>
  );
}
