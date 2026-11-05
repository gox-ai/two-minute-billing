import type { CursorSource } from "@/components/patterns/pager";

/** Rows per page in a record page's History tabs; the server's first read uses it too. */
export const HISTORY_PAGE = 10;

/** An engine page as a card's first page; a failed read degrades to an empty one. */
export function cursorSource<T>(
  page: {
    data: T[];
    has_more?: boolean;
    next_cursor?: string | null;
    total?: number | null;
  } | null,
  entity?: string,
  params?: Record<string, string | undefined>,
  filters?: string[],
): CursorSource<T> {
  return {
    rows: page?.data ?? [],
    hasMore: Boolean(page?.has_more),
    nextCursor: page?.next_cursor ?? null,
    total: page?.total ?? null,
    entity,
    params,
    filters,
  };
}
