import * as React from "react";

/** `09-Nov-2026` or `09-Nov-2026 22:07`: a date, with its time when it has one. */
const DATE = /(\d{1,2}-[A-Za-z]{3,4}-\d{4}(?: \d{1,2}:\d{2}(?::\d{2})?)?)/g;

function split(text: string): React.ReactNode {
  const parts = text.split(DATE);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 ? (
      <span key={i} className="whitespace-nowrap">
        {p}
      </span>
    ) : (
      p
    ),
  );
}

/** Keeps each date in a string on one line, so a narrow column never splits it at a hyphen. */
export function NoWrapDates({ children }: { children: React.ReactNode }) {
  return <>{React.Children.map(children, (c) => (typeof c === "string" ? split(c) : c))}</>;
}
