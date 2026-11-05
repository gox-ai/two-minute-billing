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
import { fmtDateShort } from "@/lib/format";
import { useBusinessTz } from "@/components/business-tz";
import type { CouponSet } from "@/lib/api";

/** Coupon sets list on the shared `ListPage` chrome. */
export function CouponSetsTable({
  page,
  biz,
  rows,
  createSlot,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: CouponSet[];
  /** The "Create Coupon Set" dialog trigger. */
  createSlot?: React.ReactNode;
}) {
  const tz = useBusinessTz();
  const columns = React.useMemo<ColumnDef<CouponSet>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Coupon Set Info",
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
        header: "Parent Coupon",
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
        header: "Archived Codes",
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
        header: "Created At",
        cell: ({ row }) => (
          <TextCell className="tabular-nums">{fmtDateShort(row.original.created_at, tz)}</TextCell>
        ),
      },
    ],
    [biz, tz],
  );

  const segments = React.useMemo<ListSegment<CouponSet>[]>(
    () => [
      { id: "all", label: "All Coupon Sets" },
      // Was `redeemed_count < total_count`, which matched a set whose only
      // remaining codes were archived — i.e. nothing actually redeemable.
      { id: "available", label: "With Unredeemed Codes", match: (s) => s.unredeemed_count > 0 },
      // Literally true of its members: every code was redeemed by a customer.
      // A set exhausted by archiving is NOT "fully redeemed" — it lands in
      // "No Codes Left" below, which was previously unreachable.
      {
        id: "exhausted",
        label: "Fully Redeemed",
        match: (s) => s.total_count > 0 && s.redeemed_count === s.total_count,
      },
      {
        id: "none_left",
        label: "No Codes Left",
        match: (s) => s.total_count > 0 && s.unredeemed_count === 0,
      },
      { id: "empty", label: "No Codes Yet", match: (s) => s.total_count === 0 },
    ],
    [],
  );

  const filterFields = React.useMemo<ListFilterField<CouponSet>[]>(
    () => [
      { id: "name", label: "Name", group: "Identity", value: (s) => s.name },
      { id: "id", label: "Coupon Set Id", group: "Identity", value: (s) => s.id },
      { id: "coupon", label: "Parent Coupon", group: "Identity", value: (s) => s.coupon },
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
        label: "Archived Codes",
        type: "number",
        group: "Other",
        value: (s) => s.archived_count,
      },
      {
        id: "created_at",
        label: "Created At",
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
      entity={{ singular: "Coupon Set", plural: "Coupon Sets" }}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      savedViews={{ entity: "coupon_sets", biz }}
      createSlot={createSlot}
      searchPlaceholder="Search for ID / Name…"
      exportName="coupon-sets"
      persistKey={`coupon-sets:${biz}`}
      rowHref={(s) => `/businesses/${biz}/catalog/coupon_sets/${s.id}`}
      defaultSort={{ id: "name", desc: false }}
      emptyState={
        <EmptyState
          icon={<Ticket />}
          title="No coupon sets"
          description="No coupon sets match this view, filter or search."
        />
      }
    />
  );
}
