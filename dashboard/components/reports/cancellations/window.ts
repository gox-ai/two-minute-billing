/**
 * The window a cancellation figure is quoted over, and the buckets its trend is cut into.
 *
 * Dates are CIVIL days resolved in the BUSINESS timezone, because that is what the list
 * API's date operators compare against (`list-query.ts` casts each bound with the
 * business zone). Computing them in the server's own zone would move the boundary by a
 * day for half the world, and the figure would disagree with the list it links to.
 *
 * Plain data and plain functions, deliberately not a `"use client"` module: the page
 * resolves the window on the server and the picker only writes `?range=`.
 */

export interface CancellationRange {
  id: string;
  label: string;
}

/** The windows offered. Each resolves to explicit bounds — no preset is left to the reader. */
export const CANCELLATION_RANGES: ReadonlyArray<CancellationRange> = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "6m", label: "Last 6 months" },
  { id: "12m", label: "Last 12 months" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "this_year", label: "This year" },
];

export const DEFAULT_RANGE = "12m";

export interface CancellationBucket {
  key: string;
  label: string;
  /** Inclusive civil-day bounds, exactly as `canceled_at[between]` reads them. */
  start: string;
  end: string;
}

export interface CancellationWindow {
  rangeId: string;
  rangeLabel: string;
  start: string;
  end: string;
  grain: "week" | "month";
  buckets: CancellationBucket[];
}

const DAY_MS = 86_400_000;
const civil = (day: string) => new Date(`${day}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => iso(new Date(civil(day).getTime() + n * DAY_MS));
const startOfMonth = (day: string) => `${day.slice(0, 7)}-01`;

/** Month arithmetic on a month START only, so no day-of-month clamping is needed. */
function addMonths(monthStart: string, n: number): string {
  const d = civil(monthStart);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
}
const endOfMonth = (day: string) => addDays(addMonths(startOfMonth(day), 1), -1);

const MONTH_LABEL = new Intl.DateTimeFormat("en", {
  timeZone: "UTC",
  month: "short",
  year: "numeric",
});
const DAY_LABEL = new Intl.DateTimeFormat("en", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});

/** Today, as the business reckons it. Falls back to UTC on a zone the runtime rejects. */
export function todayInBusinessZone(timezone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** One bucket per calendar month the window touches, clipped to the window at both ends. */
function monthBuckets(start: string, end: string): CancellationBucket[] {
  const out: CancellationBucket[] = [];
  for (let m = startOfMonth(start); m <= end; m = addMonths(m, 1)) {
    const last = endOfMonth(m);
    out.push({
      key: m,
      label: MONTH_LABEL.format(civil(m)),
      start: m < start ? start : m,
      end: last > end ? end : last,
    });
  }
  return out;
}

/** Seven-day buckets from the window's first day; the last one is clipped, never extended. */
function weekBuckets(start: string, end: string): CancellationBucket[] {
  const out: CancellationBucket[] = [];
  for (let s = start; s <= end; s = addDays(s, 7)) {
    const last = addDays(s, 6);
    out.push({ key: s, label: DAY_LABEL.format(civil(s)), start: s, end: last > end ? end : last });
  }
  return out;
}

/**
 * Resolve a preset into bounds plus its trend buckets.
 *
 * Month-grained presets start on a month BOUNDARY so the trend is twelve comparable
 * months rather than thirteen with two half-height ends — a partial bucket at each edge
 * reads as a collapse and a recovery that did not happen.
 */
export function resolveCancellationWindow(
  rangeId: string,
  timezone: string | null | undefined,
  now = new Date(),
  /** The business's `fiscal_year_start_month`; "This year" runs from its fiscal year start. */
  fiscalYearStartMonth = 1,
): CancellationWindow {
  const today = todayInBusinessZone(timezone, now);
  const known = CANCELLATION_RANGES.find((r) => r.id === rangeId);
  const id = known?.id ?? DEFAULT_RANGE;

  let start = addMonths(startOfMonth(today), -11);
  let end = today;
  let grain: "week" | "month" = "month";

  if (id === "30d") {
    start = addDays(today, -29);
    grain = "week";
  } else if (id === "90d") {
    start = addDays(today, -89);
    grain = "week";
  } else if (id === "6m") {
    start = addMonths(startOfMonth(today), -5);
  } else if (id === "this_month") {
    start = startOfMonth(today);
    grain = "week";
  } else if (id === "last_month") {
    start = addMonths(startOfMonth(today), -1);
    end = endOfMonth(start);
    grain = "week";
  } else if (id === "this_year") {
    const month = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4)) - (month < fiscalYearStartMonth ? 1 : 0);
    start = `${year}-${String(fiscalYearStartMonth).padStart(2, "0")}-01`;
  }

  return {
    rangeId: id,
    rangeLabel: (known ?? CANCELLATION_RANGES.find((r) => r.id === DEFAULT_RANGE)!).label,
    start,
    end,
    grain,
    buckets: grain === "month" ? monthBuckets(start, end) : weekBuckets(start, end),
  };
}

/** The window as a reader states it: "1 Oct 2025 – 22 Sep 2026". */
export function windowLabel(win: CancellationWindow): string {
  return spanLabel(win.start, win.end);
}

/** An inclusive `YYYY-MM-DD` span as the page heading prints it. */
export function spanLabel(start: string, end: string): string {
  const fmt = new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${fmt.format(civil(start))} – ${fmt.format(civil(end))}`;
}

/** The same number of days immediately before `win` — what a headline is compared with. */
export function previousWindow(win: CancellationWindow): { start: string; end: string } {
  const days = Math.round((civil(win.end).getTime() - civil(win.start).getTime()) / DAY_MS) + 1;
  return { start: addDays(win.start, -days), end: addDays(win.start, -1) };
}
