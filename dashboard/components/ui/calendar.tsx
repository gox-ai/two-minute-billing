"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";

/**
 * A month grid that picks a DATE RANGE, built from `Date` rather than a date library.
 *
 * The repo had no date dependency and no `type="date"` input, which is why a picker was
 * skipped before — there was no consumer. The board's window is one, so this is the
 * primitive rather than a second dependency.
 *
 * ⚠️ EVERY DATE HERE IS A CALENDAR DATE, held as `YYYY-MM-DD` and computed in UTC.
 * The engine takes exactly that (`start`/`end`, ten characters) and resolves it in the
 * business's own zone. Building these off a LOCAL `new Date()` would shift the day either
 * side of midnight for anyone west of UTC, so a board opened in New York at 9pm would ask
 * for tomorrow. Construct with `Date.UTC` and read with `getUTC*`, never the local pair.
 */

export type Ymd = string;

const pad = (n: number) => String(n).padStart(2, "0");

/** `Date` → `YYYY-MM-DD`, read in UTC. */
export function ymd(d: Date): Ymd {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `YYYY-MM-DD` → a UTC midnight `Date`. Returns null for anything else. */
export function parseYmd(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects 2026-02-31 and friends, which `Date.UTC` would roll forward into March.
  return ymd(dt) === s ? dt : null;
}

/** Today as a calendar date, in UTC — the same basis as everything else here. */
export function todayYmd(): Ymd {
  return ymd(new Date());
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** The day cells of one month, with leading blanks so the 1st lands on its weekday. */
function monthCells(year: number, month: number): Array<Ymd | null> {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const cells: Array<Ymd | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(ymd(new Date(Date.UTC(year, month, d))));
  return cells;
}

export interface DateRange {
  start: Ymd | null;
  end: Ymd | null;
}

/**
 * `select="range"`: click once to set the start, again to set the end; a second click BEFORE the
 * start reorders the pair rather than refusing it, because dragging a window backwards is a
 * normal thing to do and an error toast for it would be theatre.
 *
 * `select="start"` / `"end"`: this grid sets ONE side of the range and shades the rest, for a
 * picker that shows the two ends side by side. Days that would invert the range are disabled.
 */
export function Calendar({
  value,
  onChange,
  max = todayYmd(),
  min,
  select = "range",
  className,
}: {
  value: DateRange;
  onChange: (next: DateRange) => void;
  /** Latest selectable day; defaults to today — a board cannot answer the future. */
  max?: Ymd;
  min?: Ymd;
  select?: "range" | "start" | "end";
  className?: string;
}) {
  // The month shown follows the side this grid edits, so a typed date brings its month into view.
  const focus = select === "end" ? (value.end ?? value.start) : value.start;
  // With nothing picked, a start grid opens a month before the end grid, so the two side by
  // side cover the last two months rather than repeating one.
  const fallback = parseYmd(max) ?? new Date();
  const anchor =
    parseYmd(focus) ??
    (select === "start"
      ? new Date(Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth() - 1, 1))
      : fallback);
  const [view, setView] = useDefaultState(
    { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() },
    () => focus,
  );

  const cells = monthCells(view.year, view.month);
  const { start, end } = value;

  const step = (months: number) =>
    setView((v) => {
      const d = new Date(Date.UTC(v.year, v.month + months, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });

  const pick = (day: Ymd) => {
    if (select === "start") return onChange({ start: day, end });
    if (select === "end") return onChange({ start, end: day });
    // A complete range starts over; a half-open one closes.
    if (!start || (start && end)) return onChange({ start: day, end: null });
    return day < start ? onChange({ start: day, end: start }) : onChange({ start, end: day });
  };

  const navBtn =
    "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className={cn("w-64 select-none", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className={navBtn}
          onClick={() => step(-1)}
          aria-label="Previous month"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-sm font-medium">
          {MONTHS[view.month]} {view.year}
        </span>
        <button type="button" className={navBtn} onClick={() => step(1)} aria-label="Next month">
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-y-1">
        {WEEKDAYS.map((w) => (
          <span key={w} className="pb-1 text-center text-xs text-muted-foreground">
            {w}
          </span>
        ))}
        {cells.map((day, i) => {
          if (day == null) return <span key={`b${i}`} />;
          const disabled =
            (max != null && day > max) ||
            (min != null && day < min) ||
            (select === "start" && end != null && day > end) ||
            (select === "end" && start != null && day < start);
          const isStart = day === start;
          const isEnd = day === end;
          const inRange = start != null && end != null && day > start && day < end;
          return (
            <button
              key={day}
              type="button"
              disabled={disabled}
              onClick={() => pick(day)}
              aria-label={day}
              aria-pressed={isStart || isEnd}
              className={cn(
                "mx-auto inline-flex size-8 items-center justify-center rounded-md text-xs tabular-nums transition-colors",
                "disabled:pointer-events-none disabled:opacity-30",
                isStart || isEnd
                  ? "bg-solid font-medium text-solid-foreground"
                  : inRange
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent",
              )}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
