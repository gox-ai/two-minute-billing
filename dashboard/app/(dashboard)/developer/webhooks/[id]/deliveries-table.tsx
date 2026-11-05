"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { ListPage, type ListFilterField, type ListSegment } from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { Chip } from "@/components/patterns/chip";
import { DeliveryStatusChip } from "@/components/webhooks/delivery-status-chip";
import { EmptyState } from "@/components/states";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDateTimeShort } from "@/lib/format";
import { EVENT_TYPES } from "@/lib/api/event-types";
import type { WebhookDeliveryDetail } from "@/lib/api/developer";
import { Webhook } from "lucide-react";
import { redeliverAction } from "../../actions";
import { RedeliverButton } from "./redeliver-button";

/**
 * Operators per field, as `WEBHOOK_DELIVERY_FILTER_OPS` (src/modules/webhooks/endpoints.ts)
 * accepts them. A select offers the subset that makes sense for a closed list.
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
];
const ENUM_OPS = ["is", "is_not", "in", "not_in"];
const NUM_OPS = ["is", "is_not", "gt", "gte", "lt", "lte", "between"];
const DATE_OPS = [
  "on",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "between",
  "in_last",
  "is_present",
];
const HTTP_STATUS_OPS = ["is", "in"];

/** `webhook_deliveries.status`. */
const STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "delivered", label: "Delivered" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
  { value: "superseded", label: "Superseded" },
];

/** One endpoint's delivery log: server-paged, filtered in SQL. */
export function DeliveriesTable({
  endpointId,
  rows,
  total,
  hasMore,
  nextCursor,
}: {
  endpointId: string;
  /** First page, server-rendered; later pages stream in through `/api/lists`. */
  rows: WebhookDeliveryDetail[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}) {
  const fetchPage = React.useMemo(
    () =>
      makeListSource<WebhookDeliveryDetail>("webhook_deliveries", undefined, {
        params: { endpoint: endpointId },
      }),
    [endpointId],
  );
  const tz = useDisplayTz();

  // Only `created_at` sorts on the engine (the keyset index), so the other heads do not.
  const columns = React.useMemo<ColumnDef<WebhookDeliveryDetail>[]>(
    () => [
      {
        id: "event",
        header: "Event",
        enableSorting: false,
        accessorFn: (d) => d.event,
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">{row.original.event}</span>
        ),
      },
      {
        id: "event_type",
        header: "Type",
        enableSorting: false,
        accessorFn: (d) => d.event_type,
        cell: ({ row }) => <Chip className="font-mono">{row.original.event_type}</Chip>,
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        accessorFn: (d) => d.status,
        cell: ({ row }) => <DeliveryStatusChip status={row.original.status} />,
      },
      {
        id: "attempts",
        header: "Attempts",
        enableSorting: false,
        meta: { align: "right" },
        accessorFn: (d) => d.attempts,
        cell: ({ row }) => <TextCell>{row.original.attempts}</TextCell>,
      },
      {
        id: "last_attempt_at",
        header: "Last attempt",
        enableSorting: false,
        accessorFn: (d) => d.last_attempt_at ?? "",
        cell: ({ row }) => (
          <TextCell className="whitespace-nowrap">
            {row.original.last_attempt_at
              ? fmtDateTimeShort(row.original.last_attempt_at, tz)
              : null}
          </TextCell>
        ),
      },
      {
        id: "http_status",
        header: "HTTP",
        enableSorting: false,
        accessorFn: (d) => d.last_response_status ?? "",
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span className="flex flex-col">
              <TextCell>{d.last_response_status ?? null}</TextCell>
              {d.last_error ? (
                <TruncateCell value={d.last_error} className="font-mono text-xs" />
              ) : null}
            </span>
          );
        },
      },
      {
        id: "next_attempt_at",
        header: "Next retry",
        enableSorting: false,
        accessorFn: (d) => d.next_attempt_at ?? "",
        cell: ({ row }) => (
          <TextCell className="whitespace-nowrap">
            {row.original.next_attempt_at
              ? fmtDateTimeShort(row.original.next_attempt_at, tz)
              : null}
          </TextCell>
        ),
      },
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <TextCell className="whitespace-nowrap">
            {fmtDateTimeShort(row.original.created_at, tz)}
          </TextCell>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        cell: ({ row, table }) => {
          const d = row.original;
          // The engine refuses a resend while the event has a pending delivery here. Only
          // loaded rows are known; a pending row further back still gets the engine's refusal.
          const queued = table
            .getCoreRowModel()
            .rows.some((r) => r.original.event === d.event && r.original.status === "pending");
          return (
            <RedeliverButton
              endpointId={endpointId}
              deliveryId={d.id}
              redeliverAction={redeliverAction}
              queued={queued}
            />
          );
        },
      },
    ],
    [endpointId, tz],
  );

  const segments = React.useMemo<ListSegment<WebhookDeliveryDetail>[]>(
    () => [
      { id: "all", label: "All deliveries" },
      { id: "failed", label: "Failed", filters: [{ field: "status", op: "is", value: "failed" }] },
      {
        id: "pending",
        label: "Pending",
        filters: [{ field: "status", op: "is", value: "pending" }],
      },
      {
        id: "delivered",
        label: "Delivered",
        filters: [{ field: "status", op: "is", value: "delivered" }],
      },
      {
        id: "no_response",
        label: "No response",
        filters: [{ field: "http_status", op: "is", value: "timeout" }],
      },
    ],
    [],
  );

  const filterFields = React.useMemo<ListFilterField<WebhookDeliveryDetail>[]>(
    () => [
      { id: "id", label: "Delivery ID", group: "Identity", serverOps: TEXT_OPS },
      { id: "event", label: "Event ID", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "event_type",
        label: "Event type",
        type: "select",
        group: "Identity",
        options: EVENT_TYPES.map((t) => ({ value: t, label: t })),
        serverOps: ENUM_OPS,
      },
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Delivery",
        options: STATUS_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "http_status",
        label: "HTTP status",
        group: "Delivery",
        serverOps: HTTP_STATUS_OPS,
        hint: "An exact code (404), a class (4xx), a range (404-412) or 'timeout' for no response.",
        keywords: "response code 4xx 5xx timeout",
      },
      {
        id: "attempts",
        label: "Attempts",
        type: "number",
        group: "Delivery",
        serverOps: NUM_OPS,
      },
      { id: "created_at", label: "Created", type: "date", group: "Dates", serverOps: DATE_OPS },
      {
        id: "last_attempt_at",
        label: "Last attempt",
        type: "date",
        group: "Dates",
        serverOps: DATE_OPS,
      },
    ],
    [],
  );

  return (
    <ListPage
      entity={{ singular: "Delivery", plural: "Deliveries" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      defaultSort={{ id: "created_at", desc: true }}
      sortOptions={[{ id: "created_at", label: "Created" }]}
      searchPlaceholder="Search for delivery ID / event ID / object ID…"
      exportName={`webhook-deliveries-${endpointId}`}
      persistKey={`webhook_deliveries:${endpointId}`}
      emptyState={
        <EmptyState
          icon={<Webhook />}
          title="No deliveries"
          description="No deliveries match this view or search. Deliveries show here after the system sends events to this endpoint."
        />
      }
    />
  );
}
