"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Coins } from "lucide-react";
import {
  ListPage,
  type ListFilterField,
  type ListPageHeader,
  type ListSegment,
} from "@/components/patterns/list-page";
import { InfoCell, TextCell } from "@/components/patterns/list-cells";
import { StatusChip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { fmtDateShort } from "@/lib/format";
import { useBusinessTz } from "@/components/business-tz";
import { rateSentence, type CreditUnit } from "@/lib/credits";

/** Settings → Credit units. A bounded list: client paging, sort and filter. */
export function CreditUnitsTable({
  page,
  biz,
  rows,
  canManage,
}: {
  page?: ListPageHeader;
  biz: string;
  rows: CreditUnit[];
  canManage: boolean;
}) {
  const tz = useBusinessTz();
  const base = `/businesses/${biz}/settings/credit-units`;
  const columns = React.useMemo<ColumnDef<CreditUnit>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Unit",
        cell: ({ row }) => (
          <InfoCell
            title={<span className="block max-w-80 wrap-anywhere">{row.original.plural_name}</span>}
            href={canManage ? `${base}/${row.original.id}` : undefined}
            sub={row.original.id}
          />
        ),
      },
      {
        id: "rate",
        header: "Value",
        accessorFn: (u) => rateSentence(u),
        cell: ({ row }) => (
          <TextCell className="tabular-nums">{rateSentence(row.original)}</TextCell>
        ),
      },
      {
        accessorKey: "decimals",
        header: "Decimal places",
        meta: { align: "right" },
        cell: ({ row }) => <span className="text-sm tabular-nums">{row.original.decimals}</span>,
      },
      {
        id: "locked",
        header: "In use",
        accessorFn: (u) => (u.locked ? "Yes" : "No"),
        cell: ({ row }) => <TextCell>{row.original.locked ? "Yes" : "No"}</TextCell>,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusChip status={row.original.status} />,
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <TextCell className="tabular-nums">{fmtDateShort(row.original.created_at, tz)}</TextCell>
        ),
      },
    ],
    [base, tz, canManage],
  );

  const segments = React.useMemo<ListSegment<CreditUnit>[]>(
    () => [
      { id: "active", label: "Active", match: (u) => u.status === "active" },
      { id: "archived", label: "Archived", match: (u) => u.status === "archived" },
      { id: "all", label: "All units" },
    ],
    [],
  );

  const filterFields = React.useMemo<ListFilterField<CreditUnit>[]>(
    () => [
      { id: "name", label: "Name", group: "Identity", value: (u) => u.name },
      { id: "unit_id", label: "Unit ID", group: "Identity", value: (u) => u.id },
      { id: "currency", label: "Currency", group: "Identity", value: (u) => u.currency },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Credit unit", plural: "Credit units" }}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      createAction={canManage ? { label: "Create credit unit", href: `${base}/new` } : undefined}
      searchPlaceholder="Search for ID or name…"
      exportName="credit-units"
      persistKey={`credit-units:${biz}`}
      rowHref={canManage ? (u) => `${base}/${u.id}` : undefined}
      defaultSort={{ id: "name", desc: false }}
      emptyState={
        <EmptyState
          icon={<Coins />}
          title="No credit units"
          description="A credit unit is your own unit of credit, for example 1 credit = USD 0.01. Grants in money need no unit."
        />
      }
    />
  );
}
