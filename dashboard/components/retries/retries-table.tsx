"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { ListPage, type ListSegment, type ListPageHeader } from "@/components/patterns/list-page";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { makeListSource } from "@/lib/list-source";
import { InfoCell, MoneyCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { StatusChip, Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { fmtDateTimeShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useBusinessTz } from "@/components/business-tz";
import { type RetryRow } from "@/lib/api/retries";
import {
  retryStatusLabel,
  DEFAULT_RETRY_SORT,
  DEFAULT_RETRY_STATE,
  type RetryState,
} from "@/lib/retries-format";
import { RotateCcw } from "lucide-react";

/** Every sort on this screen opens descending: the newest or largest first. */
function descFirst(cols: ColumnDef<RetryRow>[]): ColumnDef<RetryRow>[] {
  return cols.map((c) => ({ ...c, sortDescFirst: true }));
}

/**
 * "Invoices under retry".
 *
 * The one screen that answers "what is failing to collect, and why". Everything
 * here was already stored; it was just spread across invoice rows and per-invoice
 * cards with no single place to look.
 */
export function RetriesTable({
  page,
  biz,
  rows,
  total,
  hasMore,
  nextCursor,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: RetryRow[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}) {
  const tz = useBusinessTz();
  const fetchPage = makeListSource<RetryRow>("retries", biz);

  const columns = React.useMemo<ColumnDef<RetryRow>[]>(
    () =>
      descFirst([
        {
          id: "invoice",
          header: "Invoice",
          accessorFn: (r) => `${r.invoice_number ?? ""} ${r.invoice}`,
          cell: ({ row }) => (
            <InfoCell
              title={
                <span className={cn(!row.original.invoice_number && "font-mono")}>
                  {row.original.invoice_number ?? row.original.invoice}
                </span>
              }
              // A number-less invoice already shows its id as the title.
              sub={row.original.invoice_number ? row.original.invoice : undefined}
              href={`/businesses/${biz}/invoices/${row.original.invoice}`}
            />
          ),
        },
        {
          id: "customer",
          header: "Customer",
          accessorFn: (r) => r.customer_name ?? r.customer ?? "",
          cell: ({ row }) => {
            const r = row.original;
            if (!r.customer) return <TextCell />;
            return (
              <CustomerInfoCell
                id={r.customer}
                name={r.customer_name}
                email={r.customer_email}
                href={`/businesses/${biz}/customers/${r.customer}`}
              />
            );
          },
        },
        {
          id: "amount_due",
          header: "Amount Due",
          accessorFn: (r) => r.amount_due_minor,
          meta: { align: "right" },
          cell: ({ row }) => (
            <MoneyCell minor={row.original.amount_due_minor} currency={row.original.currency} />
          ),
        },
        {
          id: "retry_status",
          header: "Retry Status",
          accessorFn: (r) => retryStatusLabel(r),
          cell: ({ row }) => (
            <StatusChip status={row.original.dunning_status ?? row.original.status} />
          ),
        },
        {
          id: "next_attempt_at",
          header: "Next Retry",
          accessorFn: (r) => r.next_attempt_at ?? "",
          cell: ({ row }) => (
            <TextCell>
              {row.original.next_attempt_at ? (
                fmtDateTimeShort(row.original.next_attempt_at, tz)
              ) : (
                // No retry scheduled is the actionable state, not a blank cell.
                <span className="text-muted-foreground">None scheduled</span>
              )}
            </TextCell>
          ),
        },
        {
          id: "attempts",
          header: "Attempts",
          accessorFn: (r) => r.attempt_count,
          meta: { align: "right" },
          cell: ({ row }) => <TextCell>{String(row.original.attempt_count)}</TextCell>,
        },
        {
          id: "retryable",
          // Read off the latest failed attempt per page, so the engine cannot sort on it.
          enableSorting: false,
          header: "Retryable",
          accessorFn: (r) =>
            r.last_failure_retriable === null ? "" : r.last_failure_retriable ? "soft" : "hard",
          cell: ({ row }) => {
            const v = row.original.last_failure_retriable;
            // null = we never recorded a verdict for this attempt. Show "Unknown"
            // rather than guessing — calling an unclassified failure "Hard" would
            // tell an operator to stop chasing money that is still collectible.
            if (v === null)
              return <TextCell>{<span className="text-muted-foreground">Unknown</span>}</TextCell>;
            return <Chip tone={v ? "tan" : "red"}>{v ? "Soft failure" : "Hard failure"}</Chip>;
          },
        },
        {
          id: "last_error",
          enableSorting: false,
          header: "Last Error",
          accessorFn: (r) => [r.last_error_code, r.last_error_text].filter(Boolean).join(" "),
          cell: ({ row }) => {
            const { last_error_code: code, last_error_text: text } = row.original;
            if (!code && !text) return <TextCell />;
            // One line, cut at the column; the full "(code) message" is the tooltip.
            return (
              <TruncateCell
                value={[code ? `(${code})` : null, text].filter(Boolean).join(" ")}
                width="max-w-md"
                className="text-foreground"
              >
                {code ? <span className="text-muted-foreground">({code}) </span> : null}
                {text}
              </TruncateCell>
            );
          },
        },
        {
          id: "payment_source",
          enableSorting: false,
          header: "Payment Source",
          accessorFn: (r) =>
            [r.payment_method_brand, r.payment_method_last4].filter(Boolean).join(" "),
          cell: ({ row }) => {
            const { payment_method_brand: brand, payment_method_last4: last4 } = row.original;
            if (!brand && !last4) return <TextCell />;
            return (
              <span className="flex items-center gap-1.5 text-sm">
                {/* The payer's own network mark, as the portal shows it. */}
                <InstrumentMark brand={brand} last4={last4} className="h-3.5 w-6" />
                <span className="capitalize">{brand}</span>
                {last4 ? <span className="text-muted-foreground">ending {last4}</span> : null}
              </span>
            );
          },
        },
        {
          id: "gateway",
          enableSorting: false,
          header: "Gateway",
          accessorFn: (r) => r.gateway_key ?? "",
          cell: ({ row }) => (
            <TextCell>
              <span className="capitalize">{row.original.gateway_key}</span>
            </TextCell>
          ),
        },
        {
          id: "retry_started_at",
          header: "Retry Started On",
          accessorFn: (r) => r.retry_started_at,
          cell: ({ row }) => (
            <TextCell>{fmtDateTimeShort(row.original.retry_started_at, tz)}</TextCell>
          ),
        },
      ]),
    [biz, tz],
  );

  /**
   * ⚠ Still no `filterFields` and no `savedViews`. `/retries` has no column map, so a
   * filter bar's every row would return the full list under a narrowed label — the
   * payment-intent `scope.status` shape (see /api/lists/[entity]/route.ts) and the
   * deleted emails `attempts` filter. A saved view stores filters + search + sort, so
   * on this list all of it would be stored and then ignored.
   *
   * The segments below are NOT that: `dunning_state` is translated into the engine's
   * own `state` param and resolved in SQL, so it genuinely narrows and its `total` is
   * the segment's. Adding a real column map (`RETRY_FILTER_OPS` + `parseListQuery`)
   * is what unlocks the rest — the row already carries `dunning_status`,
   * `attempt_count`, `last_error_code`, `last_failure_retriable`, `next_attempt_at`,
   * `gateway_key`, `amount_due_minor`.
   */
  /**
   * A partition of "under retry", not a set of hand-picked views — every row is in
   * exactly one, so nothing can hide from all of them. Resolved in SQL by
   * `RETRY_STATE` (modules/invoicing/retries.ts) via the one narrowing `/retries`
   * honours, so each count is the segment's own.
   *
   * Why the default is the work: 97% of the rows on the book that prompted this were
   * already collected (341 of 350, measured 2026-09-10) — a screen opening on those
   * buries the nine nobody has dealt with, and it is what made an operator ask why a
   * paid invoice was listed under retry. Recovered rows stay one click away, because
   * a retry that worked is an outcome this screen exists to report.
   */
  const segments = React.useMemo<ListSegment<RetryRow>[]>(() => {
    const defined: { id: RetryState; label: string }[] = [
      { id: "attention", label: "Needs attention" },
      { id: "recovered", label: "Recovered" },
      { id: "given_up", label: "Given up" },
      { id: "all", label: "All" },
    ];
    /**
     * `DEFAULT_RETRY_STATE` sorted to the FRONT, rather than trusting the order above.
     *
     * `ListPage` builds its `ssrQueryKey` from `segments[0].filters` and skips the
     * mount refetch when the live query matches, so segment zero must be the state the
     * page server-rendered its first page with. That used to be a comment saying "do
     * not reorder these"; breaking it paints one segment's rows under another's
     * heading and nothing errors, which is the same "narrowed label over an unfiltered
     * page" this file warns about twice. A comment cannot hold an invariant whose
     * violation is silent — so the order is derived from the constant instead, and
     * reordering the list above is now harmless.
     */
    const ordered = [...defined].sort(
      (a, b) => Number(b.id === DEFAULT_RETRY_STATE) - Number(a.id === DEFAULT_RETRY_STATE),
    );
    return ordered.map((s) => ({
      id: s.id,
      label: s.label,
      // "all" is the whole set, so it narrows with no filter at all — which also makes
      // it the correct SSR key if it is ever made the default.
      filters: s.id === "all" ? [] : [{ field: "dunning_state", op: "is", value: s.id }],
    }));
  }, []);

  return (
    <ListPage
      page={page}
      entity={{ singular: "Retry", plural: "Retries" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      defaultSort={{ id: DEFAULT_RETRY_SORT.field, desc: DEFAULT_RETRY_SORT.desc }}
      // `listRetries` forwards only `limit` and `starting_after` — no `q` — so a search
      // box here would filter nothing. Hidden rather than shipped dead.
      searchable={false}
      // Gateway and Retry Started On are context, not the first thing you scan for.
      initialHidden={["gateway", "retry_started_at"]}
      emptyState={
        <EmptyState
          icon={<RotateCcw />}
          // ONE node serves all four segments, so it cannot name any of them: written
          // as "Nothing needs attention", it greeted an empty **Given up** with the
          // wrong sentence (measured — that segment is 0 on this book).
          title="Nothing in this segment"
          description="Invoices move between segments while dunning processes them. Select a different segment, or select All to see all invoices under retry."
        />
      }
    />
  );
}
