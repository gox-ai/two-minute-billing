"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { FileDown, ReceiptText } from "lucide-react";
import {
  ListPage,
  type ListFilterField,
  type ListPageHeader,
  type ListServerFilter,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { MoneyCell, TextCell } from "@/components/patterns/list-cells";
import { CustomerInfoCell } from "@/components/patterns/customer-info-cell";
import { EmptyState } from "@/components/states";
import { fmtDate, fmtDateTimeShort } from "@/lib/format";
import { useBusinessTz } from "@/components/business-tz";
import type { Receipt, ReceiptScope } from "@/lib/api/receipts";
import { receiptPdfHref } from "@/lib/receipt-links";

// Mirrors OPS_BY_KIND (src/platform/list-query.ts) for RECEIPT_FILTER_SPECS' kinds.
const DATE_OPS = ["on", "before", "after", "between", "in_last"];
const NUM_OPS = ["is", "gt", "gte", "lt", "lte", "between"];
const ENUM_OPS = ["is", "in"];

/**
 * Receipts list. Server cursor: a business can hold one receipt per payment. The
 * engine sorts on `created_at` only, so it is the one sortable column.
 */
export function ReceiptsTable({
  page,
  biz,
  rows,
  total,
  hasMore,
  nextCursor,
  scope,
  initialFilters,
}: {
  page?: ListPageHeader;
  biz: string;
  rows: Receipt[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Fixed scope from the URL (`?customer=`, `?invoice=`, …), sent with every page. */
  scope?: ReceiptScope;
  initialFilters?: ListServerFilter[];
}) {
  const tz = useBusinessTz();
  const fetchPage = makeListSource<Receipt>("receipts", biz, { params: { ...scope } });

  const columns = React.useMemo<ColumnDef<Receipt>[]>(
    () => [
      {
        id: "number",
        header: "Number",
        enableSorting: false,
        accessorFn: (r) => r.number ?? "",
        cell: ({ row }) =>
          row.original.number ? (
            <span className="font-mono text-xs font-medium">{row.original.number}</span>
          ) : (
            // Numbered by a batch job seconds after the payment.
            <span className="text-xs text-muted-foreground">Not numbered yet</span>
          ),
      },
      {
        id: "customer",
        header: "Customer",
        enableSorting: false,
        accessorFn: (r) => r.payer?.name ?? r.payer?.email ?? r.customer ?? "",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.customer) return <TextCell>{r.payer?.name ?? r.payer?.email}</TextCell>;
          return (
            <CustomerInfoCell
              id={r.customer}
              name={r.payer?.name}
              email={r.payer?.email}
              href={`/businesses/${biz}/customers/${r.customer}`}
            />
          );
        },
      },
      {
        id: "amount_minor",
        header: "Amount",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (r) => r.amount_minor,
        cell: ({ row }) => (
          <MoneyCell minor={row.original.amount_minor} currency={row.original.currency} />
        ),
      },
      {
        id: "method",
        header: "Method",
        enableSorting: false,
        accessorFn: (r) => r.method,
        cell: ({ row }) => <TextCell>{row.original.method}</TextCell>,
      },
      {
        id: "invoices",
        header: "Invoices",
        enableSorting: false,
        accessorFn: (r) => r.allocations.map((a) => a.invoice_number ?? a.invoice ?? "").join(" "),
        cell: ({ row }) => {
          const a = row.original.allocations;
          if (a.length === 0) return <TextCell />;
          return (
            <span className="flex flex-col gap-0.5 text-sm">
              {a.map((x, i) =>
                x.invoice ? (
                  <Link
                    key={i}
                    href={`/businesses/${biz}/invoices/${x.invoice}`}
                    className="text-primary hover:underline"
                  >
                    {x.invoice_number ?? x.invoice}
                  </Link>
                ) : (
                  <span key={i} className="text-muted-foreground">
                    Customer credit
                  </span>
                ),
              )}
            </span>
          );
        },
      },
      {
        id: "paid_at",
        header: "Paid",
        enableSorting: false,
        accessorFn: (r) => r.paid_at,
        cell: ({ row }) => <TextCell>{fmtDate(row.original.paid_at, tz)}</TextCell>,
      },
      {
        id: "created_at",
        header: "Created",
        accessorFn: (r) => r.created_at,
        cell: ({ row }) => <TextCell>{fmtDateTimeShort(row.original.created_at, tz)}</TextCell>,
      },
      {
        id: "pdf",
        header: "PDF",
        enableSorting: false,
        meta: { align: "right" },
        cell: ({ row }) =>
          row.original.number ? (
            <a
              href={receiptPdfHref(biz, row.original.id)}
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              aria-label={`Download receipt ${row.original.number} as PDF`}
            >
              <FileDown className="size-4" aria-hidden /> PDF
            </a>
          ) : (
            <TextCell />
          ),
      },
    ],
    [biz, tz],
  );

  const filterFields = React.useMemo<ListFilterField<Receipt>[]>(
    () => [
      { id: "paid_at", label: "Paid", type: "date", group: "Dates", serverOps: DATE_OPS },
      { id: "created_at", label: "Created", type: "date", group: "Dates", serverOps: DATE_OPS },
      {
        id: "amount_minor",
        label: "Amount (minor units)",
        type: "number",
        group: "Amounts",
        serverOps: NUM_OPS,
        hint: "Integer minor units. For example, 129900 is ₹1,299.00.",
      },
      {
        id: "currency",
        label: "Currency",
        group: "Amounts",
        serverOps: ENUM_OPS,
        hint: "ISO 4217 code, for example INR.",
      },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Receipt", plural: "Receipts" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      filterFields={filterFields}
      initialFilters={initialFilters}
      searchPlaceholder="Search by receipt number or ID"
      initialHidden={["created_at"]}
      emptyState={
        <EmptyState
          icon={<ReceiptText />}
          title="No receipts"
          description="We create a receipt for each successful payment. A receipt gets its number a few seconds after the payment."
        />
      }
    />
  );
}
