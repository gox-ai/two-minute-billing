import type { AnalyticsRange } from "@/lib/api";

/**
 * The windows this page offers — the reports API's own presets, and nothing else.
 *
 * Declared here rather than imported from `report-panel`, and that is not duplication for
 * its own sake: `report-panel` is a `'use client'` module that reaches `@/lib/api`, so a
 * VALUE imported from it drags `next/headers` into the browser bundle and 500s the route
 * (measured on the first render of this screen). A TYPE crosses safely because it erases —
 * hence `import type` above. Same trap, and the same fix, as `lib/retries-format.ts`.
 */
export const RECOVERY_RANGES: AnalyticsRange[] = ["daily", "3m", "6m", "12m"];

export const RECOVERY_RANGE_LABEL: Record<string, string> = {
  daily: "Daily",
  "3m": "Last 3 months",
  "6m": "Last 6 months",
  "12m": "Last 12 months",
};

/** The window the page answers with when the URL names none. */
export const DEFAULT_RECOVERY_RANGE: AnalyticsRange = "12m";
