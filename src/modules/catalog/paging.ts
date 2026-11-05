/**
 * Opt-in paging for the catalog and coupon lists.
 *
 * Those lists return the WHOLE set when called without `limit`/`starting_after`, and the
 * dashboard depends on that. `field[op]` filters, `sort_by` and `q` apply either way; a
 * caller that pages also gets the shared envelope (`platform/list-query.ts`) and a cursor.
 * Catalogs are small and unindexed on most sort keys, so the cursor is offset-based.
 */
import { and, type Column, type SQL } from "drizzle-orm";
import {
  clampLimit,
  filterConditions,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { businessTimezone } from "@/platform/business-tz";
import type { Tx } from "@/platform/db";

/** A validated page request (the route's `parseListQuery` result). */
export interface CatalogPageRequest {
  filters: ListFilter[];
  search?: string;
  sortField?: string;
  sortDesc?: boolean;
  limit?: number;
  startingAfter?: string;
  /** Explicit row offset, when the list grammar supplies one; wins over the cursor. */
  offset?: number;
  /** Filter/sort only: return every matching row, no page limit. */
  unbounded?: boolean;
}

/** Row cap for an unbounded read — `limit + 1` must still fit a Postgres int. */
const UNBOUNDED_LIMIT = 2_147_483_646;

export interface PagePlan {
  where: SQL | undefined;
  orderBy: SQL[];
  limit: number;
  offset: number;
}

/** WHERE / ORDER BY / LIMIT / OFFSET for one page. Default order: newest first. */
export async function planPage(
  tx: Tx,
  businessId: string,
  req: CatalogPageRequest,
  opts: {
    specs: Record<string, FilterSpec>;
    sorts: Record<string, Column | SQL>;
    defaultSort: string;
    tiebreak: Column;
    searchColumns: Column[];
    base: Array<SQL | undefined>;
  },
): Promise<PagePlan> {
  const tz = await businessTimezone(tx, businessId);
  const conds = [
    ...opts.base,
    ...filterConditions(opts.specs, req.filters, tz),
    searchCondition(opts.searchColumns, req.search),
  ].filter((c): c is SQL => c != null);
  const sortCol = opts.sorts[req.sortField ?? opts.defaultSort] ?? opts.sorts[opts.defaultSort]!;
  return {
    where: conds.length ? and(...conds) : undefined,
    orderBy: pageOrder(sortCol, opts.tiebreak, req.sortDesc ?? true, false),
    limit: req.unbounded ? UNBOUNDED_LIMIT : clampLimit(req.limit),
    offset: req.unbounded ? 0 : (req.offset ?? parseCursor(req.startingAfter).offset),
  };
}

/** Trim the probe row and mint the next cursor. */
export function finishPage<T>(rows: T[], plan: PagePlan, total: number | null): ListPage<T> {
  return toPage(rows, plan.limit, {
    keyset: false,
    offset: plan.offset,
    keyOf: () => "",
    total,
  });
}
