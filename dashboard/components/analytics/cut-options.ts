/**
 * The cut vocabulary — plain data, deliberately NOT in a `"use client"` module.
 *
 * `cut-controls.tsx` is a client component, and in RSC every export of one becomes a client
 * REFERENCE rather than the value. A server component importing an array from it receives a
 * proxy, so `EXPLORE_RANGES.some(...)` throws "is not a function" — which TypeScript cannot
 * catch, because it sees the real declaration. Plain data that both sides read lives here.
 */

/** Named windows the API's `range` param accepts (`docs/.../10.analytics.md`). */
export const EXPLORE_RANGES: Array<{ id: string; label: string }> = [
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "6m", label: "Last 6 months" },
  { id: "12m", label: "Last 12 months" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "this_quarter", label: "This quarter" },
  { id: "this_year", label: "This year" },
];

export const GRAIN_LABEL: Record<string, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};
