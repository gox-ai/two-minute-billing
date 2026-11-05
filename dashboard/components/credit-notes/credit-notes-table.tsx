"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  createAction,
  type ListFilterField,
  type ListSegment,
  type ListServerFilter,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { InfoCell, MoneyCell, TextCell } from "@/components/patterns/list-cells";
import { StatusBadge } from "@/components/status-badge";
import { creditNoteChipStatus } from "@/lib/credit-note-status";
import { EmptyState } from "@/components/states";
import { fmtDateShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { FileMinus } from "lucide-react";
import type { CreditNote } from "@/lib/api/credit-notes";
import { moneyCell } from "@/lib/table-export";
import { KindBadge, reasonLabel } from "@/components/credit-notes/chips";
import { useBusinessTz } from "@/components/business-tz";

/**
 * Operators the engine implements, mirroring `src/platform/list-query.ts` term for term
 * (`CREDIT_NOTE_FILTER_OPS` is `opsFromSpecs` over the same tables). Five of nine text
 * operators and three of nine date ones were offered here, so "is one of", "is between"
 * and the relative windows were unaskable on a list the engine could already answer.
 */
const TEXT_OPS = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "is_present",
];
const ENUM_OPS = ["is", "is_not", "in", "not_in", "is_present"];
const NUM_OPS = ["is", "is_not", "gt", "gte", "lt", "lte", "between", "is_present"];
const DATE_OPS = [
  "on",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
  "in_last",
  "in_next",
  "is_present",
];

/**
 * The same lists without `is_present`, for a NOT NULL column.
 *
 * `opsFromSpecs` hands every field of a kind the whole operator table, so the engine
 * accepts `status[is_present]=false` — and answers it with zero rows, always, because the
 * column cannot be null. "is empty" / "is not empty" there is a control that can never do
 * anything, so the pair is dropped per FIELD rather than per kind.
 */
const withoutPresence = (ops: string[]) => ops.filter((o) => o !== "is_present");
const TEXT_OPS_NN = withoutPresence(TEXT_OPS);
const ENUM_OPS_NN = withoutPresence(ENUM_OPS);
const NUM_OPS_NN = withoutPresence(NUM_OPS);
const DATE_OPS_NN = withoutPresence(DATE_OPS);

/**
 * Amount fields stay `type: 'number'` in MINOR UNITS rather than `'money'`.
 *
 * `money` would let the operator type 1,299.00 and send 129900, but it needs ONE exponent
 * for the whole column and a credit note inherits its invoice's currency — so this list
 * is mixed-currency wherever the business is (`currency` is a filter right here). A JPY
 * note has exponent 0, so a field pinned at 2 would send 100× the bound that was typed
 * and silently change which rows match. Minor units are exact for every row.
 */
const MINOR_HINT = "Integer minor units. For example, 129900 is 1,299.00 in a two-decimal currency";

/**
 * Closed vocabularies, spelled out rather than derived from the loaded page: options
 * built from one page of rows silently omit every value that occurs only later in the
 * business, so a status the operator can see is unfilterable until they scroll a row
 * carrying it into view. `kind` and `status` are the unions in
 * `dashboard/lib/api/credit-notes.ts`, which mirror the schema's own comments.
 */
const KIND_OPTIONS = [
  { value: "adjustment", label: "Adjustment" },
  { value: "refundable", label: "Refundable" },
];

const STATUS_OPTIONS = [
  { value: "adjusted", label: "Adjusted" },
  { value: "refund_due", label: "Refund Due" },
  { value: "refunded", label: "Refunded" },
  { value: "voided", label: "Voided" },
];

/**
 * Reason codes, and there are NINE, not the five the API accepts.
 *
 * `REASON_CODES` in `src/api/credit-note-routes.ts` is the vocabulary a CALLER may send;
 * the engine issues notes with four more of its own — `order_cancellation`
 * (`invoicing/ops.ts`, a dunning-period reversal), `term_change`
 * (`subscriptions/proration.ts`, a shortened term), `refund` (`refunds/service.ts`) and
 * `refund_restore` (`credit-notes/service.ts`). Offering only the API's five would leave
 * every engine-issued note unfilterable, which is most of them on a busy business.
 *
 * ⚠ `REASON_LABEL` in `components/credit-notes/chips.tsx` (which the Reason COLUMN reads)
 * knows six of the nine, so the three engine-only codes render there with underscores
 * replaced. Same labels belong in both places.
 */
const REASON_OPTIONS = [
  { value: "write_off", label: "Write-off" },
  { value: "subscription_change", label: "Subscription change" },
  { value: "term_change", label: "Term change" },
  { value: "subscription_cancellation", label: "Subscription cancellation" },
  { value: "order_cancellation", label: "Order cancellation" },
  { value: "chargeback", label: "Chargeback" },
  { value: "refund", label: "Refund" },
  { value: "refund_restore", label: "Refund (credit restored)" },
  { value: "other", label: "Other" },
];

/** The `Channel` union in `src/platform/event-context.ts` — drives the Channel column. */
const CHANNEL_OPTIONS = [
  { value: "api", label: "API" },
  { value: "dashboard", label: "Dashboard" },
  { value: "system", label: "System (billing clock)" },
  { value: "import", label: "Import" },
];

/**
 * Credit-notes list on the shared `ListPage` chrome — the old inline type/status
 * selects are now segments + the filter builder.
 */
export function CreditNotesTable({
  page,
  biz,
  rows,
  createHref,
  total,
  hasMore,
  nextCursor,
  invoice,
  initialFilters,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** First page, server-rendered. */
  rows: CreditNote[];
  /** Create href — carries the `?invoice=` prefill when the list is scoped. */
  createHref: string;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** When set, the list is scoped to one invoice. */
  invoice?: string;
  /**
   * Deep-link filters from the page's `?customer=` / `?kind=` / `?status=`.
   *
   * These used to narrow the SERVER-RENDERED first page only. The table was told
   * nothing, so it showed no filter pills and no "Clear filters" — and, worse, the
   * very next `fetchPage` (a Load more, a sort, any filter change) sent the query
   * WITHOUT them and silently repopulated the table with every credit note in the
   * business, under a header still claiming it was filtered to one customer. Same
   * silent-lie class as the invoice `?subscription=` bug. See ListPage.initialFilters.
   */
  initialFilters?: ListServerFilter[];
}) {
  const fetchPage = React.useMemo(
    () => makeListSource<CreditNote>("credit_notes", biz, { params: { invoice } }),
    [biz, invoice],
  );
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();

  const columns = React.useMemo<ColumnDef<CreditNote>[]>(
    () => [
      {
        id: "number",
        header: "Credit Note",
        accessorFn: (c) => c.number ?? c.id,
        cell: ({ row }) => (
          <InfoCell
            title={
              <span className={cn(!row.original.number && "font-mono")}>
                {row.original.number ?? row.original.id}
              </span>
            }
            href={`/businesses/${biz}/credit_notes/${row.original.id}`}
            sub={row.original.number ? row.original.id : undefined}
          />
        ),
      },
      {
        id: "invoice",
        header: "Invoice",
        accessorFn: (c) => `${c.invoice_number ?? ""} ${c.invoice}`,
        cell: ({ row }) => (
          <InfoCell
            title={
              <span className={cn(!row.original.invoice_number && "font-mono")}>
                {row.original.invoice_number ?? row.original.invoice}
              </span>
            }
            href={`/businesses/${biz}/invoices/${row.original.invoice}`}
            sub={row.original.invoice_number ? row.original.invoice : undefined}
          />
        ),
      },
      {
        accessorKey: "kind",
        header: "Type",
        cell: ({ row }) => <KindBadge kind={row.original.kind} />,
      },
      {
        id: "reason",
        header: "Reason",
        accessorFn: (c) => reasonLabel(c.reason_code),
        cell: ({ row }) => (
          <TextCell className="capitalize">{reasonLabel(row.original.reason_code)}</TextCell>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={creditNoteChipStatus(row.original)} />,
      },
      {
        id: "total",
        header: "Total",
        accessorFn: (c) => c.total_minor,
        meta: {
          align: "right",
          exportAs: [
            moneyCell<CreditNote>(
              "Total",
              (r) => r.total_minor,
              (r) => r.currency,
            ),
            { header: "Currency", value: (r) => r.currency ?? "" },
          ],
        },
        cell: ({ row }) => (
          <MoneyCell minor={row.original.total_minor} currency={row.original.currency} />
        ),
      },
      {
        id: "available",
        header: "Available",
        accessorFn: (c) => c.available_minor,
        // Blank unless refundable, as on screen.
        meta: {
          align: "right",
          exportAs: [
            moneyCell<CreditNote>(
              "Available",
              (r) => (r.kind === "refundable" ? r.available_minor : null),
              (r) => r.currency,
            ),
          ],
        },
        cell: ({ row }) => {
          const c = row.original;
          if (c.kind !== "refundable") return <TextCell />;
          return <MoneyCell minor={c.available_minor} currency={c.currency} />;
        },
      },
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Created",
        cell: ({ row }) => <TextCell>{fmtDateShort(row.original.created_at, tz)}</TextCell>,
      },
      // The index leads with the customer. Voided On is optional, so it starts hidden.
      {
        id: "customer",
        header: "Customer",
        accessorFn: (c) => c.customer_name ?? c.customer ?? "",
        cell: ({ row }) => {
          const c = row.original;
          if (!c.customer) return <TextCell>{c.customer_name ?? null}</TextCell>;
          return (
            <CustomerInfoCell id={c.customer} name={c.customer_name} email={c.customer_email} />
          );
        },
      },
      {
        id: "voided_at",
        header: "Voided On",
        accessorFn: (c) => c.voided_at ?? "",
        cell: ({ row }) => (
          <TextCell>
            {row.original.voided_at ? fmtDateShort(row.original.voided_at, tz) : null}
          </TextCell>
        ),
      },
    ],
    [biz],
  );

  const segments = React.useMemo<ListSegment<CreditNote>[]>(
    () => [
      { id: "all", label: "All Credit Notes" },
      {
        id: "refundable",
        label: "Refundable",
        filters: [{ field: "kind", op: "is", value: "refundable" }],
      },
      {
        id: "adjustment",
        label: "Adjustment",
        filters: [{ field: "kind", op: "is", value: "adjustment" }],
      },
      {
        id: "refund_due",
        label: "Refund Due",
        filters: [{ field: "status", op: "is", value: "refund_due" }],
      },
      {
        id: "refunded",
        label: "Refunded",
        filters: [{ field: "status", op: "is", value: "refunded" }],
      },
      // A Voided view: the Voided On column was already here with no way to narrow to
      // the rows that carry it.
      { id: "voided", label: "Voided", filters: [{ field: "status", op: "is", value: "voided" }] },
      // Credit an operator can still spend. `available_minor` is total − allocated −
      // refunded computed in SQL — the same subtraction the Available column prints — so
      // this is not "status is refund_due", which stays true on a fully allocated note.
      {
        id: "available",
        label: "Credit Available",
        filters: [{ field: "available_minor", op: "gt", value: "0" }],
      },
      // Bad debt, by the coded reason rather than by kind: a ledger reconciliation has to
      // separate written-off invoices from genuine customer credits, and both are
      // `adjustment` notes.
      {
        id: "write_offs",
        label: "Write-offs",
        filters: [{ field: "reason_code", op: "is", value: "write_off" }],
      },
    ],
    [],
  );

  /**
   * Every column in the engine's `LIST_FILTERS` map
   * (`src/modules/credit-notes/service.ts`), which is the authority on what exists — 10 of
   * the 20 were offered here, so the other half were columns the API could narrow on and
   * no operator could reach.
   */
  const filterFields = React.useMemo<ListFilterField<CreditNote>[]>(
    () => [
      { id: "number", label: "Credit Note Number", group: "Identity", serverOps: TEXT_OPS },
      { id: "id", label: "Credit Note Id", group: "Identity", serverOps: TEXT_OPS_NN },
      {
        id: "invoice",
        label: "Invoice Id",
        group: "Identity",
        serverOps: TEXT_OPS_NN,
        keywords: "document credited",
      },

      {
        id: "kind",
        label: "Type",
        type: "select",
        group: "Status",
        options: KIND_OPTIONS,
        serverOps: ENUM_OPS_NN,
        hint: "Adjustment reduces an unpaid invoice. Refundable gives credit that you can refund",
      },
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: STATUS_OPTIONS,
        serverOps: ENUM_OPS_NN,
      },

      { id: "customer", label: "Customer Id", group: "Customer", serverOps: TEXT_OPS_NN },
      { id: "customer_name", label: "Customer Name", group: "Customer", serverOps: TEXT_OPS },
      { id: "customer_email", label: "Customer Email", group: "Customer", serverOps: TEXT_OPS },

      {
        id: "currency",
        label: "Currency",
        group: "Amounts",
        serverOps: ENUM_OPS_NN,
        // Free text rather than a select on purpose: unlike status, the currency
        // vocabulary is ISO-4217, not a closed set this list can enumerate honestly.
        hint: "ISO-4217 code, for example INR or USD",
      },
      {
        id: "subtotal_minor",
        label: "Sub Total (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: "Minor units. The gross reversal before tax. It equals Total on a note that records no gross amount of its own",
      },
      {
        id: "total_minor",
        label: "Total (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: MINOR_HINT,
      },
      {
        id: "allocated_minor",
        label: "Allocated (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: "Minor units. Credit already applied to invoices",
        keywords: "applied",
      },
      {
        id: "refunded_minor",
        label: "Refunded (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: MINOR_HINT,
      },
      {
        id: "available_minor",
        label: "Available (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS_NN,
        hint: "Minor units. Total − allocated − refunded. This is the credit that you can still use",
        keywords: "remaining unused",
      },

      { id: "created_at", label: "Created", type: "date", group: "Dates", serverOps: DATE_OPS_NN },
      // `status` records THAT a note was voided; this is the only way to bound a void to
      // a period, which is what a period-end reconciliation needs.
      { id: "voided_at", label: "Voided On", type: "date", group: "Dates", serverOps: DATE_OPS },

      {
        id: "reason_code",
        label: "Reason",
        type: "select",
        group: "Other",
        options: REASON_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "reason",
        label: "Reason Note",
        group: "Other",
        serverOps: TEXT_OPS,
        hint: "The free-text note from when the credit note was issued, in addition to the coded reason",
      },
      {
        id: "channel",
        label: "Channel",
        type: "select",
        group: "Other",
        options: CHANNEL_OPTIONS,
        serverOps: ENUM_OPS,
        hint: "Empty on credit notes issued before we started to record the channel",
      },
      {
        id: "imported",
        label: "Imported",
        type: "boolean",
        group: "Other",
        serverOps: ["is"],
        hint: "Imported archive rows have no ledger postings. Use this filter to find which credit notes are in the ledger",
      },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Credit Note", plural: "Credit Notes" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      initialHidden={["voided_at"]}
      filterFields={filterFields}
      savedViews={{ entity: "credit_notes", biz }}
      initialFilters={initialFilters}
      sortOptions={[
        { id: "created_at", label: "Created" },
        { id: "total_minor", label: "Total" },
        { id: "status", label: "Status" },
        // Backed by `LIST_SORTS.available_minor` (arithmetic on three columns the row
        // already carries); the Credit Available view above is what it is for.
        { id: "available_minor", label: "Available" },
      ]}
      createAction={createAction("Credit Note", createHref)}
      searchPlaceholder="Search for number / ID…"
      exportName="credit-notes"
      persistKey={`credit-notes:${biz}`}
      rowHref={(c) => `/businesses/${biz}/credit_notes/${c.id}`}
      emptyState={
        <EmptyState
          icon={<FileMinus />}
          title="No credit notes"
          description="No credit notes match this view, filter or search."
        />
      }
    />
  );
}
