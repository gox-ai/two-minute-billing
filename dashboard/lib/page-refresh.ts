/// <reference lib="dom" />
import * as React from "react";

/**
 * The page's own Refresh, reachable from the shell (pull to refresh). Each `RefreshButton`
 * registers its handler and `pending` here and marks its button `data-page-refresh`; the
 * shell takes the first marked button in <main>, so a record page's header Refresh wins
 * over a list embedded below it, and a dialog's (portalled out of <main>) never counts.
 */
type Entry = { refresh: () => void; pending: boolean };
const entries = new Map<string, Entry>();

/** Registers a Refresh control. Returns the id for its `data-page-refresh` attribute. */
export function usePageRefresh(onRefresh: () => void, pending: boolean): string {
  const id = React.useId();
  const latest = React.useRef(onRefresh);
  React.useEffect(() => {
    latest.current = onRefresh;
    const entry = entries.get(id);
    if (entry) entry.pending = pending;
    else entries.set(id, { refresh: () => latest.current(), pending });
  });
  React.useEffect(() => () => void entries.delete(id), [id]);
  return id;
}

export type PageRefresh = { refresh: () => void; pending: () => boolean };

/** The Refresh control of the page in `main`, or null when it has none. */
export function pageRefreshIn(main: HTMLElement): PageRefresh | null {
  for (const el of main.querySelectorAll<HTMLElement>("[data-page-refresh]")) {
    const id = el.dataset.pageRefresh ?? "";
    const entry = entries.get(id);
    if (!entry) continue;
    return { refresh: entry.refresh, pending: () => entries.get(id)?.pending ?? false };
  }
  return null;
}
