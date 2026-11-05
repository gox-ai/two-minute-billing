import type { AnalyticsResult } from "@/lib/analytics-api";

/**
 * What SHAPE of answer this is — read off the payload, the same thinking as
 * `reports/dashboard-grid.tsx`'s `roleOf`: form follows what actually came back,
 * not a declaration.
 *
 * - `figure` — one number, nothing else.
 * - `trend` — a series over time.
 * - `rows` — split by a dimension, one total per key.
 * - `hero` — split by a dimension WITH each key carrying its own series: a
 *   dimension × period matrix. That is wide by construction (a split_limit of 8
 *   over 12 months is already 8 rows × 12 columns) and must never render at
 *   quarter width — fourteen columns there is not a small table, it is an
 *   unreadable one.
 */
export type MeasureTileRole = "figure" | "trend" | "rows" | "hero";

export function roleOfResult(
  r: Pick<AnalyticsResult, "series" | "split" | "shape">,
): MeasureTileRole {
  // A `totals` answer SAYS it carries no series, so read the declaration rather than infer
  // it from empty arrays — an empty series is also what a quiet period looks like.
  if (r.shape === "totals") return r.split ? "rows" : "figure";
  if (r.split) {
    return r.split.series.some((s) => s.points.length > 0) ? "hero" : "rows";
  }
  if (r.series.length > 0) return "trend";
  return "figure";
}

/**
 * A grid-span FLOOR by role, for any screen that arranges measure tiles in a
 * responsive grid (a board, a dashboard) — same idea as `dashboard-grid.tsx`'s
 * `FLOOR`/`SPAN`. `hero` is pinned to the full row: fourteen columns at quarter
 * width is not a small table, it is an unreadable one.
 */
export const HERO_MIN_SPAN = "md:col-span-2 xl:col-span-4";
