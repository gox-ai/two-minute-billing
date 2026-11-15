"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { Activity } from "lucide-react";
import {
  ListPage,
  type ListFilterField,
  type ListPageHeader,
  type ListSegment,
  type ListServerFilter,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { TextCell } from "@/components/patterns/list-cells";
import { Chip } from "@/components/patterns/chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/states";
import { fmtDateTime } from "@/lib/format-date";
import { HTTP_METHOD_OPTIONS } from "@/lib/filter-options";
import { useDisplayTz } from "@/components/business-tz";
import { cn } from "@/lib/utils";
import { callerLabel, statusTone, type RequestLogSummary } from "@/lib/request-log-types";

/** Operator lists from the request log contract, per column kind. */
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
const DATE_OPS = ["on", "before", "after", "on_or_before", "on_or_after", "between", "in_last"];
/** `api_key` and `business` are bare exact-match params, so `is` is the only operator. */
const BARE_OPS = ["is"];

/**
 * The path as the row shows it: without `/v1/businesses/<biz>`, which the Business column
 * names. Any other path shows whole.
 */
function shortPath(path: string, business: string | null): string {
  if (!business) return path;
  const prefix = `/v1/businesses/${business}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length - 1) : path;
}

/**
 * A path on one line, cut in the middle: the last segment (the action or the id) stays
 * whole. The full path, business segment included, is in the tooltip.
 */
function PathText({ full, shown }: { full: string; shown: string }) {
  const cut = shown.lastIndexOf("/");
  const head = cut > 0 ? shown.slice(0, cut) : "";
  const tail = cut > 0 ? shown.slice(cut) : shown;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex min-w-0 font-mono text-xs whitespace-nowrap text-foreground">
          {head ? <span className="min-w-0 truncate">{head}</span> : null}
          <span className="max-w-full shrink-0 truncate">{tail}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="font-mono break-all">{full}</TooltipContent>
    </Tooltip>
  );
}

/** One line, cut at the end; the whole value is in the tooltip. */
function OneLine({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("block min-w-0 truncate", className)}>{children ?? value}</span>
      </TooltipTrigger>
      <TooltipContent className="break-all">{value}</TooltipContent>
    </Tooltip>
  );
}

/** The org's API request log, server-paginated through `/api/lists/request_logs`. */
export function RequestLogsTable({
  page,
  rows,
  total,
  hasMore,
  nextCursor,
  apiKeys,
  businesses,
  initialFilters,
}: {
  page?: ListPageHeader;
  rows: RequestLogSummary[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Every key of the organization, revoked ones included. */
  apiKeys: Array<{ id: string; label: string }>;
  businesses: Array<{ id: string; name: string }>;
  initialFilters?: ListServerFilter[];
}) {
  const tz = useDisplayTz();
  const fetchPage = React.useMemo(
    () => makeListSource<RequestLogSummary>("request_logs", undefined),
    [],
  );
  const bizName = React.useMemo(() => new Map(businesses.map((b) => [b.id, b.name])), [businesses]);

  const columns = React.useMemo<ColumnDef<RequestLogSummary>[]>(
    () => [
      {
        id: "created_at",
        header: "Time",
        enableSorting: false,
        accessorFn: (r) => r.created_at,
        meta: { phone: "hide" },
        cell: ({ row }) => <TextCell>{fmtDateTime(row.original.created_at, tz)}</TextCell>,
      },
      {
        id: "request",
        header: "Request",
        meta: { grow: true, phone: "title" },
        enableSorting: false,
        // The export and the tooltip keep the full path; the cell drops the business segment.
        accessorFn: (r) => `${r.method} ${r.path}`,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="flex w-0 min-w-full flex-col">
              {/* The keyboard's way into the row; a click anywhere on the row opens it too. */}
              <Link
                href={`/developer/logs/${r.id}`}
                className="flex min-w-0 items-center gap-2 hover:underline"
              >
                <Chip tone="blue" className="shrink-0 font-mono text-xs">
                  {r.method}
                </Chip>
                <PathText full={r.path} shown={shortPath(r.path, r.business)} />
              </Link>
              <span className="mt-0.5 hidden truncate text-xs text-muted-foreground list-narrow:block">
                {[
                  fmtDateTime(r.created_at, tz),
                  r.duration_ms != null ? `${r.duration_ms} ms` : null,
                  callerLabel(r),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        accessorFn: (r) => r.status ?? "",
        cell: ({ row }) => {
          const r = row.original;
          const chip = (
            <Chip tone={statusTone(r.status)} className="tabular-nums">
              {r.status ?? "No reply"}
            </Chip>
          );
          return r.error_type ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{chip}</span>
              </TooltipTrigger>
              <TooltipContent className="font-mono">{r.error_type}</TooltipContent>
            </Tooltip>
          ) : (
            chip
          );
        },
      },
      {
        id: "error_type",
        header: "Error type",
        enableSorting: false,
        accessorFn: (r) => r.error_type ?? "",
        meta: { phone: "hide" },
        cell: ({ row }) =>
          row.original.error_type ? (
            <OneLine
              value={row.original.error_type}
              className="max-w-48 font-mono text-xs text-muted-foreground"
            />
          ) : (
            <TextCell>—</TextCell>
          ),
      },
      {
        id: "duration_ms",
        header: "Duration",
        enableSorting: false,
        accessorFn: (r) => r.duration_ms ?? "",
        meta: { align: "right", phone: "hide" },
        cell: ({ row }) => (
          <TextCell>
            {row.original.duration_ms != null ? `${row.original.duration_ms} ms` : "—"}
          </TextCell>
        ),
      },
      {
        id: "caller",
        header: "Key or member",
        enableSorting: false,
        accessorFn: (r) => callerLabel(r),
        meta: { phone: "hide" },
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <OneLine value={callerLabel(row.original)} className="max-w-48 text-sm" />
            {row.original.api_key?.revoked ? <Chip>Revoked</Chip> : null}
          </span>
        ),
      },
      {
        id: "business",
        header: "Business",
        enableSorting: false,
        accessorFn: (r) => (r.business ? (bizName.get(r.business) ?? r.business) : ""),
        meta: { phone: "hide" },
        cell: ({ row }) => {
          const b = row.original.business;
          if (!b) return <TextCell>—</TextCell>;
          const name = bizName.get(b) ?? b;
          return (
            <Link
              href={`/businesses/${b}`}
              className="block max-w-40 text-sm text-primary hover:underline"
            >
              <OneLine value={name} className="max-w-40" />
            </Link>
          );
        },
      },
      {
        id: "livemode",
        header: "Mode",
        enableSorting: false,
        accessorFn: (r) => r.livemode ?? "",
        meta: { phone: "hide" },
        cell: ({ row }) =>
          row.original.livemode ? (
            <Chip tone={row.original.livemode === "test" ? "tan" : "gray"}>
              {row.original.livemode === "test" ? "Test" : "Live"}
            </Chip>
          ) : (
            <TextCell>—</TextCell>
          ),
      },
    ],
    [tz, bizName],
  );

  // Status classes compile to `status[gte]` + `status[lt]`, so they narrow the whole log.
  const segments = React.useMemo<ListSegment<RequestLogSummary>[]>(
    () => [
      { id: "all", label: "All requests" },
      {
        id: "ok",
        label: "Succeeded (2xx)",
        filters: [
          { field: "status", op: "gte", value: "200" },
          { field: "status", op: "lt", value: "300" },
        ],
      },
      {
        id: "client",
        label: "Refused (4xx)",
        filters: [
          { field: "status", op: "gte", value: "400" },
          { field: "status", op: "lt", value: "500" },
        ],
      },
      {
        id: "server",
        label: "Server errors (5xx)",
        filters: [{ field: "status", op: "gte", value: "500" }],
      },
      { id: "writes", label: "Writes", filters: [{ field: "kind", op: "is", value: "write" }] },
      { id: "reads", label: "Reads", filters: [{ field: "kind", op: "is", value: "read" }] },
    ],
    [],
  );

  /** Exactly the contract's filterable columns plus its two bare params. */
  const filterFields = React.useMemo<ListFilterField<RequestLogSummary>[]>(
    () => [
      { id: "created_at", label: "Time", type: "date", group: "Dates", serverOps: DATE_OPS },
      {
        id: "status",
        label: "HTTP status",
        type: "number",
        group: "Response",
        serverOps: NUM_OPS,
      },
      {
        id: "duration_ms",
        label: "Duration (ms)",
        type: "number",
        group: "Response",
        serverOps: NUM_OPS,
      },
      { id: "error_type", label: "Error type", group: "Response", serverOps: TEXT_OPS },
      {
        id: "method",
        label: "Method",
        type: "select",
        group: "Request",
        options: HTTP_METHOD_OPTIONS,
        serverOps: ENUM_OPS,
      },
      {
        id: "kind",
        label: "Reads or writes",
        type: "select",
        group: "Request",
        options: [
          { value: "read", label: "Read" },
          { value: "write", label: "Write" },
        ],
        serverOps: ENUM_OPS,
      },
      { id: "path", label: "Path", group: "Request", serverOps: TEXT_OPS },
      { id: "route", label: "Route pattern", group: "Request", serverOps: TEXT_OPS },
      {
        id: "idempotency_key",
        label: "Idempotency key",
        group: "Request",
        serverOps: TEXT_OPS,
      },
      {
        id: "api_key",
        label: "API key",
        type: "select",
        group: "Caller",
        options: apiKeys.map((k) => ({ value: k.id, label: k.label })),
        serverOps: BARE_OPS,
      },
      {
        id: "source",
        label: "Source",
        type: "select",
        group: "Caller",
        options: [
          { value: "api", label: "API" },
          { value: "dashboard", label: "Dashboard" },
        ],
        serverOps: ENUM_OPS,
      },
      {
        id: "business",
        label: "Business",
        type: "select",
        group: "Scope",
        options: businesses.map((b) => ({ value: b.id, label: b.name })),
        serverOps: BARE_OPS,
      },
      {
        id: "livemode",
        label: "Mode",
        type: "select",
        group: "Scope",
        options: [
          { value: "live", label: "Live" },
          { value: "test", label: "Test" },
        ],
        serverOps: ENUM_OPS,
      },
      { id: "customer", label: "Customer ID", group: "Scope", serverOps: TEXT_OPS },
      { id: "trace_id", label: "Trace ID", group: "Scope", serverOps: TEXT_OPS },
    ],
    [apiKeys, businesses],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Request", plural: "Requests" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      segments={segments}
      filterFields={filterFields}
      initialFilters={initialFilters}
      // Error type is on the status chip's tooltip; the business already names the mode.
      initialHidden={["error_type", "livemode"]}
      // No `savedViews`: the engine's saved-view entity list has no `request_logs` entry yet.
      // The endpoint returns newest first and takes no sort parameter.
      defaultSort={null}
      searchPlaceholder="Search by request ID, path or idempotency key"
      exportName="request-logs"
      persistKey="request_logs"
      rowHref={(r) => `/developer/logs/${r.id}`}
      emptyState={
        <EmptyState
          icon={<Activity />}
          title="No requests"
          description="No API requests match this view or search."
        />
      }
    />
  );
}
