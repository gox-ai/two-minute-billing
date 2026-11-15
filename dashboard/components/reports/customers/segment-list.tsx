"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useDefaultState } from "@/lib/use-default-state";
import type { SegmentCustomer, SegmentFilter } from "@/lib/api/segments";
import { loadSegmentPageAction } from "@/app/(dashboard)/businesses/[biz]/reports/customers/actions";
import { SegmentCustomerTable } from "./segment-table";

/**
 * The segment's customers with cursor paging: the server renders the first page, "Load more"
 * appends the next one for the same filters. A new predicate remounts it (keyed by the page);
 * a refresh that brings a different first page starts the list again from it.
 */
export function SegmentCustomerList({
  biz,
  filters,
  initialRows,
  initialCursor,
  total,
  fallbackCurrency,
  tz,
}: {
  biz: string;
  filters: SegmentFilter[];
  initialRows: SegmentCustomer[];
  /** null when the first page is the whole segment. */
  initialCursor: string | null;
  /** The whole filtered set, counted by the engine. */
  total: number | null;
  fallbackCurrency: string;
  tz: string | null;
}) {
  const [{ rows, cursor }, setList] = useDefaultState(
    { rows: initialRows, cursor: initialCursor },
    (l) => `${l.cursor}|${l.rows.map((r) => r.id).join(",")}`,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const loadMore = () => {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const res = await loadSegmentPageAction(biz, filters, cursor);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setList((prev) => ({
        rows: [...prev.rows, ...res.data],
        cursor: res.has_more ? res.next_cursor : null,
      }));
    });
  };

  return (
    <>
      <SegmentCustomerTable
        biz={biz}
        customers={rows}
        fallbackCurrency={fallbackCurrency}
        tz={tz}
      />
      {cursor || error ? (
        <div className="flex flex-wrap items-center gap-3 border-t px-5 py-2.5 text-xs text-muted-foreground">
          {error ? (
            <span className="text-destructive">We could not load more customers. {error}</span>
          ) : (
            <span>
              Showing {rows.length.toLocaleString("en")} of {(total ?? 0).toLocaleString("en")}. The
              count and the MRR above are for all the customers in the segment.
            </span>
          )}
          {cursor ? (
            <Button variant="outline" size="sm" onClick={loadMore} disabled={pending}>
              {pending ? "Loading…" : error ? "Try again" : "Load more"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
