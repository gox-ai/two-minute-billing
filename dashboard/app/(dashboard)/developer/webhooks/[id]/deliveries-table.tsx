"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { ListPage, type ListFilterField, type ListSegment } from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { IdCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { DeliveryStatusChip } from "@/components/webhooks/delivery-status-chip";
import { EmptyState } from "@/components/states";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDateTime } from "@/lib/format-date";
import { EVENT_TYPES } from "@/lib/api/event-types";
import type { WebhookDeliveryDetail } from "@/lib/api/developer";
import { HttpStatusChip, LogDetailDrawer, LogJsonBlock } from "@/components/webhooks/log-detail";
import { Button } from "@/components/ui/button";
import { Loader2, ScanSearch, Webhook } from "lucide-react";
import { inspectDeliveryEventAction, redeliverAction } from "../../actions";
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
  const [detail, setDetail] = React.useState<WebhookDeliveryDetail | null>(null);

  // Only `created_at` sorts on the engine (the keyset index), so the other heads do not.
  const columns = React.useMemo<ColumnDef<WebhookDeliveryDetail>[]>(
    () => [
      {
        id: "last_attempt_at",
        header: "Last attempt",
        enableSorting: false,
        accessorFn: (d) => d.last_attempt_at ?? "",
        // The next retry sits under the last attempt: as its own column it pushed the table
        // wider than the card, and the sticky actions column covered it.
        cell: ({ row }) => {
          const d = row.original;
          return (
            <span className="flex flex-col whitespace-nowrap">
              <TextCell>{d.last_attempt_at ? fmtDateTime(d.last_attempt_at, tz) : null}</TextCell>
              {d.next_attempt_at ? (
                <span className="text-xs text-muted-foreground">
                  Next retry {fmtDateTime(d.next_attempt_at, tz)}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "event",
        header: "Event",
        enableSorting: false,
        accessorFn: (d) => d.event,
        cell: ({ row }) => <IdCell id={row.original.event} />,
      },
      {
        id: "event_type",
        header: "Event type",
        enableSorting: false,
        meta: { grow: true },
        accessorFn: (d) => d.event_type,
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.event_type}</span>,
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        accessorFn: (d) => d.status,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <DeliveryStatusChip status={row.original.status} />
            {row.original.last_error ? (
              <TruncateCell value={row.original.last_error} width="max-w-40" className="text-xs" />
            ) : null}
          </span>
        ),
      },
      {
        id: "http_status",
        header: "Status code",
        enableSorting: false,
        accessorFn: (d) => d.last_response_status ?? "",
        cell: ({ row }) => {
          const s = row.original.last_response_status;
          if (s == null) return <TextCell>{null}</TextCell>;
          return <HttpStatusChip status={s} />;
        },
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
        accessorKey: "created_at",
        id: "created_at",
        header: "Created",
        cell: ({ row }) => (
          <TextCell className="whitespace-nowrap">
            {fmtDateTime(row.original.created_at, tz)}
          </TextCell>
        ),
      },
    ],
    [tz],
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

  // The engine refuses a resend while the event has a pending delivery here. Only the first
  // page is known here; a pending row further back still gets the engine's refusal.
  const queuedEvents = React.useMemo(
    () => new Set(rows.filter((r) => r.status === "pending").map((r) => r.event)),
    [rows],
  );

  return (
    <>
      <ListPage
        entity={{ singular: "Delivery", plural: "Deliveries" }}
        columns={columns}
        data={rows}
        server={{ total, hasMore, nextCursor, fetchPage }}
        segments={segments}
        filterFields={filterFields}
        defaultSort={{ id: "created_at", desc: true }}
        sortOptions={[{ id: "created_at", label: "Created" }]}
        searchPlaceholder="Search by delivery, event or object ID"
        exportName={`webhook-deliveries-${endpointId}`}
        persistKey={`webhook_deliveries:${endpointId}`}
        // Created is close to the first attempt; it stays sortable and in the column chooser.
        initialHidden={["created_at"]}
        rowMenu={(d) => (
          <span className="flex items-center gap-1">
            <RedeliverButton
              endpointId={endpointId}
              deliveryId={d.id}
              redeliverAction={redeliverAction}
              queued={queuedEvents.has(d.event)}
              ghost
            />
            {/* Icon-only in a narrow list, where the row's title needs the width. */}
            <Button variant="ghost" size="sm" onClick={() => setDetail(d)} aria-label="Inspect">
              <ScanSearch className="hidden size-3.5 list-narrow:block" />
              <span className="list-narrow:sr-only">Inspect</span>
            </Button>
          </span>
        )}
        emptyState={
          <EmptyState
            icon={<Webhook />}
            title="No deliveries"
            description="No deliveries match this view or search. Deliveries show here after the system sends events to this endpoint."
          />
        }
      />
      <DeliveryDrawer delivery={detail} tz={tz} onClose={() => setDetail(null)} />
    </>
  );
}

/** The delivery's own fields and the event payload it carried, loaded on open. */
function DeliveryDrawer({
  delivery,
  tz,
  onClose,
}: {
  delivery: WebhookDeliveryDetail | null;
  tz: string;
  onClose: () => void;
}) {
  const [event, setEvent] = React.useState<{ id: string; data?: unknown; error?: string } | null>(
    null,
  );
  const eventId = delivery?.event;
  React.useEffect(() => {
    if (!eventId) return;
    let live = true;
    void inspectDeliveryEventAction(eventId).then((res) => {
      if (!live) return;
      setEvent(
        res.ok ? { id: eventId, data: res.event.data } : { id: eventId, error: res.message },
      );
    });
    return () => {
      live = false;
    };
  }, [eventId]);
  const loaded = event && event.id === eventId ? event : null;

  return (
    <LogDetailDrawer
      open={!!delivery}
      onClose={onClose}
      title={delivery?.event_type ?? "Delivery"}
      description={delivery ? "Webhook delivery" : undefined}
      rows={
        delivery
          ? [
              { label: "Delivery", value: <IdCell id={delivery.id} /> },
              { label: "Status", value: <DeliveryStatusChip status={delivery.status} /> },
              { label: "Event", value: <IdCell id={delivery.event} /> },
              {
                label: "Status code",
                value:
                  delivery.last_response_status != null ? (
                    <HttpStatusChip status={delivery.last_response_status} />
                  ) : null,
              },
              { label: "Attempts", value: delivery.attempts },
              {
                label: "Error",
                value: delivery.last_error ? (
                  <span className="text-destructive">{delivery.last_error}</span>
                ) : null,
              },
              { label: "Created", value: fmtDateTime(delivery.created_at, tz) },
              {
                label: "Last attempt",
                value: delivery.last_attempt_at ? fmtDateTime(delivery.last_attempt_at, tz) : null,
              },
              {
                label: "Next retry",
                value: delivery.next_attempt_at ? fmtDateTime(delivery.next_attempt_at, tz) : null,
              },
            ]
          : []
      }
    >
      {!loaded ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading the event.
        </p>
      ) : loaded.error ? (
        <p className="text-sm text-destructive">{loaded.error}</p>
      ) : (
        <LogJsonBlock title="Payload" value={loaded.data} empty="No payload stored." />
      )}
    </LogDetailDrawer>
  );
}
