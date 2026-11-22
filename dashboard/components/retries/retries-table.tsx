"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { ListPage, type ListSegment, type ListPageHeader } from "@/components/patterns/list-page";
import { InstrumentMark } from "@/components/brand/instrument-mark";
import { makeListSource } from "@/lib/list-source";
import { MoneyCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { StatusChip, Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { fmtDateTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import { enumLabel } from "@/lib/labels";
import { useBusinessTz } from "@/components/business-tz";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type RetryRow } from "@/lib/api/retries";
import {
  retryStatusLabel,
  DEFAULT_RETRY_SORT,
  DEFAULT_RETRY_STATE,
  type RetryState,
} from "@/lib/retries-format";
import { RotateCcw } from "lucide-react";

/** A reminder row: auto-collection is off, so dunning sends reminders and never charges. */
function isReminder(r: RetryRow): boolean {
  return r.collection === "reminder";
}

/**
 * The next retry or reminder. A time in the past is due: the next clock tick acts on it,
 * so it reads "Due now" with the exact time in the tooltip.
 */
function NextStepCell({ row, tz, now }: { row: RetryRow; tz: string | null; now: number }) {
  const at = row.next_attempt_at;
  if (!at) {
    // No retry scheduled is the actionable state, not a blank cell.
    return (
      <TextCell>
        <span className="text-muted-foreground">None scheduled</span>
      </TextCell>
    );
  }
  const exact = fmtDateTime(at, tz);
  const due = new Date(at).getTime() <= now;
  return (
    <span className="flex flex-col text-sm whitespace-nowrap">
      {due ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="w-fit font-medium">
              Due now
            </span>
          </TooltipTrigger>
          <TooltipContent>{exact}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-muted-foreground">{exact}</span>
      )}
      {isReminder(row) ? <span className="text-xs text-muted-foreground">Reminder</span> : null}
    </span>
  );
}

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
  now,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: RetryRow[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** When the page rendered (ms). A next time at or before it reads "Due now". */
  now: number;
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
            <Link
              href={`/businesses/${biz}/invoices/${row.original.invoice}`}
              data-record-title
              className={cn(
                "inline-block text-sm font-medium whitespace-nowrap text-primary hover:underline",
                !row.original.invoice_number && "font-mono",
              )}
            >
              {row.original.invoice_number ?? row.original.invoice}
            </Link>
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
          header: "Amount due",
          accessorFn: (r) => r.amount_due_minor,
          meta: { align: "right", phone: "aside" },
          cell: ({ row }) => (
            <MoneyCell minor={row.original.amount_due_minor} currency={row.original.currency} />
          ),
        },
        {
          id: "retry_status",
          header: "Retry status",
          accessorFn: (r) => retryStatusLabel(r),
          // A given-up invoice that was later voided or written off says so: nothing will be
          // collected, and the row needs no decision.
          cell: ({ row }) => (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <StatusChip status={row.original.dunning_status ?? row.original.status} />
              {row.original.written_off ? (
                <Chip>Written off</Chip>
              ) : row.original.status === "voided" && row.original.dunning_status ? (
                <StatusChip status="voided" />
              ) : null}
            </span>
          ),
        },
        {
          id: "next_attempt_at",
          header: "Next retry",
          accessorFn: (r) => r.next_attempt_at ?? "",
          cell: ({ row }) => <NextStepCell row={row.original} tz={tz} now={now} />,
        },
        {
          id: "attempts",
          header: "Attempts",
          accessorFn: (r) => r.attempt_count,
          meta: { align: "right" },
          // A reminder is not a charge, so its count stays 0: name the row instead.
          cell: ({ row }) => (
            <TextCell>
              {isReminder(row.original) ? "Reminder" : String(row.original.attempt_count)}
            </TextCell>
          ),
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
          header: "Last error",
          accessorFn: (r) => [r.last_error_code, r.last_error_text].filter(Boolean).join(" "),
          cell: ({ row }) => {
            const { last_error_code: code, last_error_text: text } = row.original;
            if (!code && !text) return <TextCell />;
            // The code reads as words; the message follows it.
            return (
              <TruncateCell
                value={[code ? enumLabel(code) : null, text].filter(Boolean).join(": ")}
                width="max-w-64"
                className="text-foreground"
              >
                {code ? <span className="text-muted-foreground">{enumLabel(code)}. </span> : null}
                {text}
              </TruncateCell>
            );
          },
        },
        {
          id: "payment_source",
          enableSorting: false,
          header: "Payment source",
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
          header: "Retry started on",
          accessorFn: (r) => r.retry_started_at,
          cell: ({ row }) => <TextCell>{fmtDateTime(row.original.retry_started_at, tz)}</TextCell>,
        },
      ]),
    [biz, tz, now],
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
      initialHidden={["gateway", "retry_started_at", "retryable", "payment_source", "attempts"]}
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
