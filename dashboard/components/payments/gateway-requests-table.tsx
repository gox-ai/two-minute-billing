"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListServerFilter,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { Chip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { EditDrawer } from "@/components/edit-drawer";
import { Button } from "@/components/ui/button";
import { fmtDateTime, fmtDateTimeShort } from "@/lib/format";
import type { GatewayRequestLog } from "@/lib/api/payments";
import { Activity } from "lucide-react";
import { useBusinessTz } from "@/components/business-tz";
import { mergeOptions, HTTP_METHOD_OPTIONS } from "@/lib/filter-options";
import { gatewayFilterOptions, type GatewayCatalogEntry } from "@/components/gateways/gateway-meta";
import { GatewayLabel } from "@/components/partner-logo";

/** The declared gateways; `mergeOptions` adds anything the data carries beyond them. */

/**
 * Operators the engine implements, per column kind — `GATEWAY_REQUEST_FILTER_OPS` is
 * `opsFromSpecs(GATEWAY_REQUEST_FILTERS)`, so each field gets the WHOLE table for its
 * kind from `src/platform/list-query.ts`. These lists were previously a subset of that
 * (no set membership, no ranges, no relative windows), which quietly withheld operators
 * the endpoint already answered.
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

/** Distinct, sorted select options from the loaded rows. */
function options(values: (string | null | undefined)[]) {
  return [...new Set(values.filter((v): v is string => !!v))]
    .sort()
    .map((v) => ({ value: v, label: v }));
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-all">{children}</dd>
    </div>
  );
}

/** Truncate the middle of a URL so the scheme/host and path tail stay visible. */
function truncateMiddle(s: string, max = 64): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function statusTone(status: number | null, error: string | null): "green" | "tan" | "red" | "gray" {
  if (status == null) return error ? "red" : "gray";
  if (status >= 500) return "red";
  if (status >= 400) return "tan";
  return "green";
}

/** Outbound gateway request/response log with a full request/response inspector drawer. */
export function GatewayRequestsTable({
  page,
  biz,
  gatewayCatalog,
  rows,
  total,
  hasMore,
  nextCursor,
  initialFilters,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** `GET /v1/gateways` — the gateway filter's options. */
  gatewayCatalog: GatewayCatalogEntry[];
  /** First page, server-rendered — later pages stream in through fetchPage. */
  rows: GatewayRequestLog[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Deep-link filters from the URL (`?gateway_key=stripe`) — see ListPage. */
  initialFilters?: ListServerFilter[];
}) {
  const fetchPage = React.useMemo(
    () => makeListSource<GatewayRequestLog>("gateway_requests", biz),
    [biz],
  );
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const [detail, setDetail] = React.useState<GatewayRequestLog | null>(null);

  const columns = React.useMemo<ColumnDef<GatewayRequestLog>[]>(
    () => [
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Time",
        cell: ({ row }) => <TextCell>{fmtDateTimeShort(row.original.created_at, tz)}</TextCell>,
      },
      {
        id: "method_url",
        header: "Request",
        accessorFn: (r) => `${r.method} ${r.url}`,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <Chip tone="blue" className="font-mono text-xs uppercase">
              {row.original.method}
            </Chip>
            <TruncateCell
              value={row.original.url}
              width="max-w-96"
              className="font-mono text-xs text-foreground"
            >
              {truncateMiddle(row.original.url)}
            </TruncateCell>
          </span>
        ),
      },
      {
        accessorKey: "gateway_key",
        header: "Gateway",
        cell: ({ row }) => (
          <GatewayLabel gatewayKey={row.original.gateway_key} className="text-sm" />
        ),
      },
      {
        id: "operation",
        header: "Operation",
        accessorFn: (r) => r.operation ?? "—",
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.operation ?? "—"}</span>
        ),
      },
      {
        id: "source",
        header: "Source",
        accessorFn: (r) => r.source ?? "—",
        cell: ({ row }) => <TextCell>{row.original.source}</TextCell>,
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => r.status ?? (r.error ? "error" : "—"),
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <Chip tone={statusTone(row.original.status, row.original.error)}>
              {row.original.status ?? (row.original.error ? "error" : "—")}
            </Chip>
            {row.original.error ? (
              <TruncateCell value={row.original.error} width="max-w-48" className="text-xs" />
            ) : null}
          </span>
        ),
      },
      {
        id: "duration_ms",
        header: "Duration",
        accessorFn: (r) => r.duration_ms ?? 0,
        meta: { align: "right" },
        cell: ({ row }) => (
          <TextCell>
            {row.original.duration_ms != null ? `${row.original.duration_ms} ms` : null}
          </TextCell>
        ),
      },
      // Migration 0137 added `trace_id` for this and the Inspect drawer already
      // shows it. Correlates one gateway call with everything else the same
      // request or job did.
      {
        id: "trace_id",
        header: "Trace ID",
        accessorFn: (r) => r.trace_id ?? "",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.trace_id ?? "—"}
          </span>
        ),
      },
    ],
    [],
  );

  const segments = React.useMemo<ListSegment<GatewayRequestLog>[]>(
    () => [
      { id: "all", label: "All Requests" },
      // `between` is inclusive at both ends (filterSql), so one condition expresses the
      // band exactly — these were two off-by-one-flavoured `gt`/`lt` bounds each.
      {
        id: "ok",
        label: "Succeeded (2xx)",
        filters: [{ field: "status", op: "between", value: "200,299" }],
      },
      {
        id: "client",
        label: "Rejected (4xx)",
        filters: [{ field: "status", op: "between", value: "400,499" }],
      },
      {
        id: "server",
        label: "Gateway errors (5xx)",
        filters: [{ field: "status", op: "gte", value: "500" }],
      },
      // `error` is only ever set when the request threw (schema: db/schema/gateway.ts) —
      // i.e. exactly the `status == null` transport-error rows.
      {
        id: "failed",
        label: "Transport errors",
        filters: [{ field: "error", op: "is_present", value: "true" }],
      },
      {
        id: "slow",
        label: "Slow (> 2s)",
        filters: [{ field: "duration_ms", op: "gt", value: "2000" }],
      },
    ],
    [],
  );

  /** Every column in `GATEWAY_REQUEST_FILTERS` (src/modules/gateway/activity.ts). */
  const filterFields = React.useMemo<ListFilterField<GatewayRequestLog>[]>(
    () => [
      { id: "id", label: "Request Log Id", group: "Identity", serverOps: TEXT_OPS },
      // Filterable in the engine (GATEWAY_REQUEST_FILTERS.trace_id) — and the
      // field the payment-intent detail page deep-links on, so an attempt's
      // "View Request/Response Logs" narrows in SQL. Without the field here
      // `ListPage` would DROP the incoming `?trace_id=` row and show everything.
      { id: "trace_id", label: "Trace ID", group: "Identity", serverOps: TEXT_OPS },
      // A transaction's or an attempt's link filters on its span (`gatewayLogsHref`).
      { id: "span_id", label: "Span ID", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "gateway_key",
        label: "Gateway",
        type: "select",
        group: "Gateway",
        options: mergeOptions(
          gatewayFilterOptions(gatewayCatalog),
          rows.map((r) => r.gateway_key),
        ),
        serverOps: ENUM_OPS,
      },
      { id: "operation", label: "Operation", group: "Gateway", serverOps: TEXT_OPS },
      { id: "source", label: "Source", group: "Gateway", serverOps: TEXT_OPS },
      {
        id: "method",
        label: "Method",
        type: "select",
        group: "Delivery",
        options: mergeOptions(
          HTTP_METHOD_OPTIONS,
          rows.map((r) => r.method),
        ),
        serverOps: ENUM_OPS,
      },
      { id: "url", label: "URL", group: "Delivery", serverOps: TEXT_OPS },
      { id: "status", label: "HTTP status", type: "number", group: "Status", serverOps: NUM_OPS },
      // `error` is set only when the request THREW, i.e. exactly the rows with no HTTP
      // status at all (db/schema/gateway.ts) — so `is empty` is "we got a response".
      { id: "error", label: "Error", group: "Status", serverOps: TEXT_OPS },
      {
        id: "duration_ms",
        label: "Duration (ms)",
        type: "number",
        group: "Status",
        serverOps: NUM_OPS,
      },
      { id: "created_at", label: "Time", type: "date", group: "Dates", serverOps: DATE_OPS },
    ],
    [rows, gatewayCatalog],
  );

  return (
    <>
      <ListPage
        page={page}
        entity={{ singular: "Request", plural: "Requests" }}
        columns={columns}
        data={rows}
        server={{ total, hasMore, nextCursor, fetchPage }}
        segments={segments}
        filterFields={filterFields}
        savedViews={{ entity: "gateway_requests", biz }}
        initialFilters={initialFilters}
        searchPlaceholder="Search for gateway / operation / source / url…"
        exportName="gateway-requests"
        persistKey={`gateway_requests:${biz}`}
        rowMenu={(r) => (
          <Button variant="ghost" size="sm" onClick={() => setDetail(r)}>
            Inspect
          </Button>
        )}
        emptyState={
          <EmptyState
            icon={<Activity />}
            title="No gateway activity"
            description="No outbound gateway requests match this view or search."
          />
        }
      />

      <EditDrawer
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail ? `${detail.method} ${detail.gateway_key}` : "Gateway request"}
        description={detail ? (detail.operation ?? detail.url) : undefined}
      >
        {detail ? (
          <div className="space-y-4 pb-6">
            <dl className="divide-y">
              <DetailRow label="Status">
                <Chip tone={statusTone(detail.status, detail.error)}>
                  {detail.status ?? (detail.error ? "error" : "—")}
                </Chip>
              </DetailRow>
              <DetailRow label="Gateway">
                <GatewayLabel gatewayKey={detail.gateway_key} fit />
              </DetailRow>
              <DetailRow label="Method">
                <span className="font-mono text-xs">{detail.method}</span>
              </DetailRow>
              <DetailRow label="URL">
                <span className="font-mono text-xs">{detail.url}</span>
              </DetailRow>
              <DetailRow label="Operation">
                <span className="font-mono text-xs">{detail.operation ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Source">{detail.source ?? "—"}</DetailRow>
              <DetailRow label="Actor">{detail.actor ?? "—"}</DetailRow>
              <DetailRow label="Duration">
                {detail.duration_ms != null ? `${detail.duration_ms} ms` : "—"}
              </DetailRow>
              <DetailRow label="Error">
                {detail.error ? <span className="text-destructive">{detail.error}</span> : "—"}
              </DetailRow>
              <DetailRow label="Trace ID">
                {detail.trace_id ? (
                  <span className="font-mono text-xs">{detail.trace_id}</span>
                ) : (
                  <span className="text-muted-foreground">
                    None. We made this call outside a trace.
                  </span>
                )}
              </DetailRow>
              <DetailRow label="Created">{fmtDateTime(detail.created_at, tz)}</DetailRow>
            </dl>

            <div>
              <p className="mb-1.5 text-sm font-medium">Request headers</p>
              {detail.request_headers != null ? (
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(detail.request_headers, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No request headers stored.</p>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-sm font-medium">Request body</p>
              {detail.request_body != null ? (
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(detail.request_body, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No request body stored.</p>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-sm font-medium">Response headers</p>
              {detail.response_headers != null ? (
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(detail.response_headers, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No response headers stored.</p>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-sm font-medium">Response body</p>
              {detail.response_body != null ? (
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(detail.response_body, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No response body stored.</p>
              )}
            </div>
          </div>
        ) : null}
      </EditDrawer>
    </>
  );
}
