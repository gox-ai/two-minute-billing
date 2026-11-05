"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { HandCoins } from "lucide-react";
import {
  ListPage,
  type ListFilterField,
  type ListPageHeader,
  type ListSegment,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { IdCell, MoneyCell, TextCell } from "@/components/patterns/list-cells";
import { StatusChip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { fmtDateTimeShort } from "@/lib/format";
import { useBusinessTz } from "@/components/business-tz";
import type { PaymentRequest } from "@/lib/api/payment-requests";

/**
 * Business-wide payment requests. Server cursor; the engine filters by `status` only
 * (a comma list), so that is the one segment axis and there is no search.
 */
export function PaymentRequestsTable({
  page,
  biz,
  rows,
  total,
  hasMore,
  nextCursor,
  customer,
}: {
  page?: ListPageHeader;
  biz: string;
  rows: PaymentRequest[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** `?customer=` from the URL: one customer's requests, sent with every page. */
  customer?: string;
}) {
  const tz = useBusinessTz();
  const fetchPage = makeListSource<PaymentRequest>("payment_requests", biz, {
    params: { customer },
  });

  const columns = React.useMemo<ColumnDef<PaymentRequest>[]>(
    () => [
      {
        id: "id",
        header: "Request",
        enableSorting: false,
        accessorFn: (r) => r.id,
        cell: ({ row }) => (
          <IdCell
            id={row.original.id}
            href={`/businesses/${biz}/payment_requests/${row.original.id}`}
            width="max-w-48"
          />
        ),
      },
      {
        id: "customer",
        header: "Customer",
        enableSorting: false,
        accessorFn: (r) => r.customer,
        cell: ({ row }) => (
          <IdCell
            id={row.original.customer}
            href={`/businesses/${biz}/customers/${row.original.customer}`}
            width="max-w-48"
          />
        ),
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        accessorFn: (r) => r.status,
        cell: ({ row }) => <StatusChip status={row.original.status} />,
      },
      {
        id: "mode",
        header: "Type",
        enableSorting: false,
        accessorFn: (r) => r.mode,
        cell: ({ row }) => (
          <TextCell>{row.original.mode === "charge" ? "Charge" : "Payment link"}</TextCell>
        ),
      },
      {
        id: "invoices",
        header: "Invoices",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (r) => r.lines.length,
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">{row.original.lines.length}</span>
        ),
      },
      {
        id: "amount_minor",
        header: "Due now",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (r) => r.amount_minor,
        cell: ({ row }) => (
          <MoneyCell minor={row.original.amount_minor} currency={row.original.currency} />
        ),
      },
      {
        id: "created_at",
        header: "Created",
        // The proxy forwards no sort: the engine returns newest first.
        enableSorting: false,
        accessorFn: (r) => r.created_at,
        cell: ({ row }) => <TextCell>{fmtDateTimeShort(row.original.created_at, tz)}</TextCell>,
      },
    ],
    [biz, tz],
  );

  // Values mirror the engine's statuses; `/api/lists/payment_requests` forwards one as `?status=`.
  const segments = React.useMemo<ListSegment<PaymentRequest>[]>(
    () => [
      { id: "all", label: "All payment requests" },
      {
        id: "active",
        label: "Open or processing",
        filters: [{ field: "status", op: "is", value: "open,processing" }],
      },
      { id: "paid", label: "Paid", filters: [{ field: "status", op: "is", value: "paid" }] },
      {
        id: "canceled",
        label: "Canceled",
        filters: [{ field: "status", op: "is", value: "canceled" }],
      },
      {
        id: "expired",
        label: "Expired",
        filters: [{ field: "status", op: "is", value: "expired" }],
      },
    ],
    [],
  );

  const filterFields = React.useMemo<ListFilterField<PaymentRequest>[]>(
    () => [
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: [
          { value: "open", label: "Open" },
          { value: "processing", label: "Processing" },
          { value: "paid", label: "Paid" },
          { value: "canceled", label: "Canceled" },
          { value: "expired", label: "Expired" },
        ],
        serverOps: ["is"],
      },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Payment request", plural: "Payment requests" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      // The engine list takes no free-text search and no sort.
      searchable={false}
      defaultSort={null}
      emptyState={
        <EmptyState
          icon={<HandCoins />}
          title="No payment requests"
          description="Create a payment request from a customer page to collect several open invoices at once."
        />
      }
    />
  );
}
