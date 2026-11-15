"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { IdCell, InfoCell, TextCell } from "@/components/patterns/list-cells";
import { EmptyState } from "@/components/states";
import { Ticket } from "lucide-react";
import { fmtDate } from "@/lib/format-date";
import { useBusinessTz } from "@/components/business-tz";
import type { CouponSet } from "@/lib/api";

/** Coupon sets list on the shared `ListPage` chrome. */
export function CouponSetsTable({
  page,
  biz,
  rows,
  createSlot,
  emptyAction,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: CouponSet[];
  /** The "Create Coupon Set" dialog trigger. */
  createSlot?: React.ReactNode;
  /** The empty state's one action; the header holds `createSlot`. */
  emptyAction?: React.ReactNode;
}) {
  const tz = useBusinessTz();
  const columns = React.useMemo<ColumnDef<CouponSet>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Coupon set info",
        cell: ({ row }) => (
          <InfoCell
            title={<span className="block max-w-80 wrap-anywhere">{row.original.name}</span>}
            href={`/businesses/${biz}/catalog/coupon_sets/${row.original.id}`}
            sub={row.original.id}
          />
        ),
      },
      {
        accessorKey: "coupon",
        header: "Parent coupon",
        cell: ({ row }) => (
          <IdCell
            id={row.original.coupon}
            href={`/businesses/${biz}/catalog/coupons/${row.original.coupon}`}
          />
        ),
      },
      {
        accessorKey: "total_count",
        header: "Codes",
        meta: { align: "right" },
        cell: ({ row }) => <span className="text-sm tabular-nums">{row.original.total_count}</span>,
      },
      {
        id: "redeemed",
        header: "Redeemed",
        accessorFn: (s) => s.redeemed_count,
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {row.original.redeemed_count} / {row.original.total_count}
          </span>
        ),
      },
      {
        id: "remaining",
        header: "Unredeemed",
        // Server-counted, NOT total − redeemed: an archived code is withdrawn,
        // not available, and subtracting would advertise it as redeemable.
        accessorFn: (s) => s.unredeemed_count,
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">{row.original.unredeemed_count}</span>
        ),
      },
      {
        id: "archived",
        header: "Archived codes",
        accessorFn: (s) => s.archived_count,
        meta: { align: "right" },
        // Archived is a terminal state → neutral, never a semantic colour.
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground tabular-nums">
            {row.original.archived_count}
          </span>
        ),
      },
      {
        accessorKey: "created_at",
        header: "Created at",
        cell: ({ row }) => (
          <TextCell className="tabular-nums">{fmtDate(row.original.created_at, tz)}</TextCell>
        ),
      },
    ],
    [biz, tz],
  );

  const segments = React.useMemo<ListSegment<CouponSet>[]>(
    () => [
      { id: "all", label: "All coupon sets" },
      // Was `redeemed_count < total_count`, which matched a set whose only
      // remaining codes were archived — i.e. nothing actually redeemable.
      { id: "available", label: "With unredeemed codes", match: (s) => s.unredeemed_count > 0 },
      // Literally true of its members: every code was redeemed by a customer.
      // A set exhausted by archiving is NOT "fully redeemed" — it lands in
      // "No codes left" below, which was previously unreachable.
      {
        id: "exhausted",
        label: "Fully redeemed",
        match: (s) => s.total_count > 0 && s.redeemed_count === s.total_count,
      },
      {
        id: "none_left",
        label: "No codes left",
        match: (s) => s.total_count > 0 && s.unredeemed_count === 0,
      },
      { id: "empty", label: "No codes yet", match: (s) => s.total_count === 0 },
    ],
    [],
  );

  const filterFields = React.useMemo<ListFilterField<CouponSet>[]>(
    () => [
      { id: "name", label: "Name", group: "Identity", value: (s) => s.name },
      { id: "id", label: "Coupon set ID", group: "Identity", value: (s) => s.id },
      { id: "coupon", label: "Parent coupon", group: "Identity", value: (s) => s.coupon },
      {
        id: "total_count",
        label: "Codes",
        type: "number",
        group: "Other",
        value: (s) => s.total_count,
      },
      {
        id: "redeemed_count",
        label: "Redeemed",
        type: "number",
        group: "Other",
        value: (s) => s.redeemed_count,
      },
      // Server-counted, like the column — never total − redeemed (see the Unredeemed
      // column's note): archiving withdraws a code without redeeming it.
      {
        id: "unredeemed_count",
        label: "Unredeemed",
        type: "number",
        group: "Other",
        value: (s) => s.unredeemed_count,
      },
      {
        id: "archived_count",
        label: "Archived codes",
        type: "number",
        group: "Other",
        value: (s) => s.archived_count,
      },
      {
        id: "created_at",
        label: "Created at",
        type: "date",
        group: "Dates",
        value: (s) => s.created_at,
      },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Coupon set", plural: "Coupon sets" }}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      savedViews={{ entity: "coupon_sets", biz }}
      createSlot={createSlot}
      searchPlaceholder="Search by ID or name"
      exportName="coupon-sets"
      persistKey={`coupon-sets:${biz}`}
      rowHref={(s) => `/businesses/${biz}/catalog/coupon_sets/${s.id}`}
      defaultSort={{ id: "name", desc: false }}
      emptyState={
        <EmptyState
          icon={<Ticket />}
          title="No coupon sets"
          description={
            rows.length === 0
              ? "A coupon set holds many single-use codes for one coupon. Create one to issue codes in bulk."
              : "No coupon sets match this view, filter or search."
          }
          action={rows.length === 0 ? emptyAction : undefined}
        />
      }
    />
  );
}
