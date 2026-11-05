"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Gauge } from "lucide-react";
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
import { meterAggregationLabel } from "@/lib/meters";
import type { Meter } from "@/lib/api/meters";

export interface MeterRow extends Meter {
  /** Events received in the last 24 hours; null when the count could not be read. */
  events_24h: number | null;
}

/** Catalog → Meters. A bounded list: client paging, sort and filter. */
export function MetersTable({
  page,
  biz,
  rows,
  canManage,
}: {
  page?: ListPageHeader;
  biz: string;
  rows: MeterRow[];
  canManage: boolean;
}) {
  const tz = useBusinessTz();
  const base = `/businesses/${biz}/catalog/meters`;
  const columns = React.useMemo<ColumnDef<MeterRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Meter",
        cell: ({ row }) => (
          <InfoCell
            title={<span className="block max-w-80 wrap-anywhere">{row.original.name}</span>}
            href={`${base}/${row.original.id}`}
            sub={row.original.id}
          />
        ),
      },
      {
        accessorKey: "event_name",
        header: "Event name",
        cell: ({ row }) => <TextCell className="font-mono">{row.original.event_name}</TextCell>,
      },
      {
        id: "aggregation",
        header: "Aggregation",
        accessorFn: (m) => meterAggregationLabel(m.aggregation),
        cell: ({ row }) => <TextCell>{meterAggregationLabel(row.original.aggregation)}</TextCell>,
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusChip status={row.original.status} />,
      },
      {
        id: "events_24h",
        header: "Events in last 24 hours",
        accessorFn: (m) => m.events_24h ?? -1,
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="text-sm tabular-nums">
            {row.original.events_24h == null
              ? "—"
              : row.original.events_24h.toLocaleString("en-US")}
          </span>
        ),
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <TextCell className="tabular-nums">{fmtDateShort(row.original.created_at, tz)}</TextCell>
        ),
      },
    ],
    [base, tz],
  );

  const segments = React.useMemo<ListSegment<MeterRow>[]>(
    () => [
      { id: "active", label: "Active", match: (m) => m.status === "active" },
      { id: "archived", label: "Archived", match: (m) => m.status === "archived" },
      { id: "all", label: "All meters" },
    ],
    [],
  );

  const filterFields = React.useMemo<ListFilterField<MeterRow>[]>(
    () => [
      { id: "name", label: "Name", group: "Identity", value: (m) => m.name },
      { id: "meter_id", label: "Meter ID", group: "Identity", value: (m) => m.id },
      { id: "event_name", label: "Event name", group: "Identity", value: (m) => m.event_name },
      {
        id: "created_at",
        label: "Created",
        type: "date",
        group: "Dates",
        value: (m) => m.created_at,
      },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Meter", plural: "Meters" }}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      createAction={canManage ? { label: "Create meter", href: `${base}/new` } : undefined}
      searchPlaceholder="Search for ID, name or event name…"
      exportName="meters"
      persistKey={`meters:${biz}`}
      rowHref={(m) => `${base}/${m.id}`}
      defaultSort={{ id: "name", desc: false }}
      emptyState={
        <EmptyState
          icon={<Gauge />}
          title="No meters"
          description="A meter counts the usage events that your app sends. Create a meter, then add a price that bills from it."
        />
      }
    />
  );
}
