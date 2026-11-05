"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pagination for a record page's cards. Two sources, one footer:
 *   - `useLocalPages`  — the whole list is already loaded; pages are slices.
 *   - `useCursorPages` — the engine pages it; the next page is fetched through
 *     `/api/lists/<entity>` on demand and cached, so Previous never refetches.
 * Neither navigates, so paging never reloads the page or scrolls it.
 */
export interface PagerState {
  /** 0-based. */
  index: number;
  size: number;
  /** Rows on the current page. */
  shown: number;
  /** Known total, or null when the engine did not count. */
  total: number | null;
  hasPrev: boolean;
  hasNext: boolean;
  loading?: boolean;
  error?: string | null;
  prev: () => void;
  next: () => void;
}

export function useLocalPages<T>(rows: T[], size = 10) {
  const [index, setIndex] = React.useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  // A list that shrank (a filter, a toggle) must not strand us past its end.
  const at = Math.min(index, pages - 1);
  const slice = rows.slice(at * size, at * size + size);
  const pager: PagerState = {
    index: at,
    size,
    shown: slice.length,
    total: rows.length,
    hasPrev: at > 0,
    hasNext: at < pages - 1,
    prev: () => setIndex(Math.max(0, at - 1)),
    next: () => setIndex(Math.min(pages - 1, at + 1)),
  };
  return { rows: slice, pager, reset: () => setIndex(0) };
}

/** The first page, as the server rendered it, plus where the rest comes from. */
export interface CursorSource<T> {
  rows: T[];
  hasMore: boolean;
  nextCursor: string | null;
  total: number | null;
  /** `/api/lists/<entity>`; omit and the rows are paged locally. */
  entity?: string;
  /** Fixed scope params (`customer`, `subscription`, `resource_id`…). */
  params?: Record<string, string | undefined>;
  /** Builder filters, `field:op:value`. */
  filters?: string[];
}

/** Without an `entity` the rows are the whole list, so they are cut into pages here. */
function firstPages<T>(source: CursorSource<T>, size: number): T[][] {
  if (source.entity) return [source.rows];
  const out: T[][] = [];
  for (let i = 0; i < source.rows.length; i += size) out.push(source.rows.slice(i, i + size));
  return out.length ? out : [[]];
}

export function useCursorPages<T>(biz: string, source: CursorSource<T>, size = 10) {
  const [pages, setPages] = React.useState<T[][]>(() => firstPages(source, size));
  const [cursors, setCursors] = React.useState<(string | null)[]>([
    source.hasMore ? source.nextCursor : null,
  ]);
  const [total, setTotal] = React.useState(source.total);
  const [index, setIndex] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // A refresh hands us a new first page: start over from it. Keyed on EVERY row, not the
  // first — a save that changes row 3 (a status, an amount) must not leave it stale.
  const rowsKey = JSON.stringify(source.rows);
  React.useEffect(() => {
    const fresh = firstPages(source, size);
    setPages(fresh);
    setCursors([source.hasMore ? source.nextCursor : null]);
    setTotal(source.total);
    // Cursor pages past the first are dropped, so only a local list can keep its place.
    setIndex((i) => (source.entity ? 0 : Math.min(i, fresh.length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, source.total]);

  const next = async () => {
    if (loading) return;
    if (pages[index + 1]) return setIndex(index + 1);
    const cursor = cursors[index];
    if (!cursor || !source.entity) return;
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ biz, limit: String(size), starting_after: cursor });
      for (const [k, v] of Object.entries(source.params ?? {})) if (v) sp.set(k, v);
      for (const f of source.filters ?? []) sp.append("filter", f);
      const res = await fetch(`/api/lists/${source.entity}?${sp.toString()}`);
      const json = (await res.json()) as {
        data?: T[];
        has_more?: boolean;
        next_cursor?: string | null;
        total?: number | null;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setPages((p) => [...p, json.data ?? []]);
      setCursors((c) => [...c, json.has_more ? (json.next_cursor ?? null) : null]);
      if (json.total != null) setTotal(json.total);
      setIndex(index + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const rows = pages[index] ?? [];
  const pager: PagerState = {
    index,
    size,
    shown: rows.length,
    total,
    hasPrev: index > 0,
    hasNext: Boolean(pages[index + 1]) || Boolean(cursors[index] && source.entity),
    loading,
    error,
    prev: () => setIndex(Math.max(0, index - 1)),
    next: () => void next(),
  };
  return { rows, pager };
}

/** "11–20 of 124  ‹ ›". Renders nothing while everything fits on one page. */
export function Pager({ pager, className }: { pager: PagerState; className?: string }) {
  if (!pager.hasPrev && !pager.hasNext) return null;
  const from = pager.index * pager.size + 1;
  const to = pager.index * pager.size + pager.shown;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-t px-5 py-2.5 text-sm text-muted-foreground",
        className,
      )}
    >
      <span className="tabular-nums">
        {pager.error ? (
          <span className="text-destructive">We could not load more rows: {pager.error}</span>
        ) : (
          <>
            {from}–{to}
            {pager.total != null ? ` of ${pager.total}` : pager.hasNext ? " of many" : ""}
          </>
        )}
      </span>
      <span className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="px-2"
          aria-label="Previous page"
          disabled={!pager.hasPrev || pager.loading}
          onClick={pager.prev}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="px-2"
          aria-label="Next page"
          disabled={!pager.hasNext || pager.loading}
          onClick={pager.next}
        >
          <ChevronRight aria-hidden className="size-4" />
        </Button>
      </span>
    </div>
  );
}

/**
 * Pages server-rendered rows (table rows, list items) without making the server
 * component a client one: the rows arrive as nodes and only the slice renders.
 * Put `<PagedItems>` where the rows go and `<PagedFooter>` after the container.
 */
const PagedCtx = React.createContext<{ rows: React.ReactNode[]; pager: PagerState } | null>(null);

export function Paged({
  items,
  size = 10,
  children,
}: {
  items: React.ReactNode[];
  size?: number;
  children: React.ReactNode;
}) {
  const { rows, pager } = useLocalPages(items, size);
  return <PagedCtx.Provider value={{ rows, pager }}>{children}</PagedCtx.Provider>;
}

export function PagedItems() {
  const ctx = React.useContext(PagedCtx);
  return <>{ctx?.rows}</>;
}

export function PagedFooter({ className }: { className?: string }) {
  const ctx = React.useContext(PagedCtx);
  return ctx ? <Pager pager={ctx.pager} className={className} /> : null;
}
