/**
 * Pure helpers for the paged item lists of a transfer run (`PlanReview`, `RunProgress`).
 * The engine filters and pages; these only count from the run's summary and merge pages.
 */
// No import from `lib/api`: the root unit tests load this module.

/** What the plan does with an item, as the review shows it. */
export type ResultKind =
  | "new"
  | "updated"
  | "deleted"
  | "unchanged"
  | "kept"
  | "blocked"
  | "left_out";

/** Queued items by status. */
export interface ItemProgress {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

type ResultTally = Record<ResultKind, number>;
interface SummaryCounts {
  results: ResultTally;
  sections: Array<{ section: string; results: ResultTally; progress: ItemProgress }>;
}

/** Items per "Show more". */
export const ITEM_PAGE = 100;
/** The engine's cap on one page. */
export const ITEM_PAGE_MAX = 500;

export const RESULT_KINDS: ResultKind[] = [
  "new",
  "updated",
  "deleted",
  "unchanged",
  "kept",
  "blocked",
  "left_out",
];

export type ResultFilter = ResultKind | "changes" | "all";

/** Same key, same list: a refresh reloads it, a new key starts over. */
export const itemQueryKey = (q: {
  section?: string;
  result?: string;
  status?: string;
  q?: string;
  limit?: number;
}) => JSON.stringify([q.section ?? "", q.result ?? "", q.status ?? "", q.q ?? ""]);

/** A refresh reloads as many items as are shown, within one page of the engine. */
export const reloadLimit = (shown: number) =>
  Math.min(ITEM_PAGE_MAX, Math.max(ITEM_PAGE, Math.ceil(shown / ITEM_PAGE) * ITEM_PAGE));

/** Result counts of one section (both pairs), or of the whole run. */
export function resultCounts(summary: SummaryCounts, section: string): ResultTally {
  if (section === "all") return summary.results;
  const out = Object.fromEntries(RESULT_KINDS.map((k) => [k, 0])) as ResultTally;
  for (const s of summary.sections)
    if (s.section === section) for (const k of RESULT_KINDS) out[k] += s.results[k];
  return out;
}

/** The results that write to the destination. */
export const CHANGE_KINDS: ResultKind[] = ["new", "updated", "deleted"];

/** How many items a result filter matches, from the counts. */
export function filterCount(counts: ResultTally, filter: ResultFilter): number {
  if (filter === "all") return RESULT_KINDS.reduce((n, k) => n + counts[k], 0);
  if (filter === "changes") return CHANGE_KINDS.reduce((n, k) => n + counts[k], 0);
  return counts[filter];
}

export type StatusFilter = "queued" | "open" | "done" | "failed" | "skipped";

/** Queued items per status filter, summed over sections. */
export function progressCounts(summary: SummaryCounts): ItemProgress {
  const out: ItemProgress = { total: 0, pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const s of summary.sections)
    for (const k of Object.keys(out) as Array<keyof ItemProgress>) out[k] += s.progress[k];
  return out;
}

export function statusCount(p: ItemProgress, f: StatusFilter): number {
  if (f === "queued") return p.total;
  if (f === "open") return p.pending + p.running;
  return p[f];
}

/** A page's items without those already pinned at the top of the list. */
export const withoutPinned = <T extends { key: string }>(items: T[], pinned: T[]) => {
  if (!pinned.length) return items;
  const keys = new Set(pinned.map((i) => i.key));
  return items.filter((i) => !keys.has(i.key));
};
