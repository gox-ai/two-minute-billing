"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListServerFilter,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { makeListSource } from "@/lib/list-source";
import { InfoCell, TextCell } from "@/components/patterns/list-cells";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/states";
import { fmtDateTimeShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EVENT_TYPES } from "@/lib/api/event-types";
import type { EventRecord } from "@/lib/api/developer";
import { Activity } from "lucide-react";
import { useBusinessTz } from "@/components/business-tz";
import { accountHolderName } from "@/lib/names";

/**
 * The engine's operator tables, copied verbatim from `src/platform/list-query.ts`
 * (reached here through `EVENT_FILTER_OPS`). Narrowing them by hand is how `is one of`,
 * `between` and `in the last N days` came to exist in SQL and be unreachable from the
 * screen.
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

/**
 * ⚠ Filtering on one of these DROPS THE IMPORTED TABLE from the query — for the page and
 * for the total (`NATIVE_ONLY_FILTER_FIELDS` / `importedApplicable` in
 * src/modules/events/service.ts). Only `id`, `type` and `occurred_at` exist on both sides
 * of the union; everything else about an imported row lives inside its archived payload,
 * where the serializer digs it out per row, and a SQL filter re-deriving those fallbacks
 * is the "list lies about being filtered" bug.
 *
 * That behaviour is correct — an imported event has no `resource_type` at all — but it is
 * invisible: the row count changes for a reason nothing on screen explains. So every one
 * of these fields carries the warning in its own `hint`.
 */
const NATIVE_ONLY =
  "Shows only events raised here. Imported history does not have this field, so those rows are not in the count.";

/** `source` on the events table: EventSource in src/platform/event-context.ts. */
const SOURCE_OPTIONS = [
  { value: "api", label: "API" },
  { value: "dashboard", label: "Dashboard" },
  { value: "scheduled_job", label: "Billing clock / jobs" },
  { value: "migration", label: "Migration" },
  { value: "system", label: "System" },
  { value: "hubspot", label: "HubSpot" },
];

/** Machine event_type → human label, e.g. `subscription_changed` → "Subscription changed". */
function eventName(type: string): string {
  return type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * "Customer Info" cell: derive from the event's content
 * snapshot (`content.customer`, a full `serializeCustomer` payload — see
 * `loadCustomerSnapshot`) when present, falling back to the resource pointer
 * when there's no customer in content.
 */
function customerInfo(ev: EventRecord): string {
  return customerInfoParts(ev).text;
}

/** The label, and whether it is an id (rendered mono) rather than a name. */
function customerInfoParts(ev: EventRecord): { text: string; mono: boolean } {
  const content = ev.content as Record<string, unknown> | null;
  const customer =
    content && typeof content === "object"
      ? (content.customer as Record<string, unknown> | undefined)
      : undefined;
  if (customer) {
    const name = accountHolderName({
      first_name: asString(customer.first_name),
      last_name: asString(customer.last_name),
      company: asString(customer.company),
      email: asString(customer.email),
    });
    if (name) return { text: name, mono: false };
    const id = asString(customer.id);
    if (id) return { text: id, mono: true };
  }
  if (ev.resource) {
    return {
      text: `${ev.resource.type ?? "resource"}${ev.resource.id ? ` ${ev.resource.id}` : ""}`,
      mono: false,
    };
  }
  return { text: "—", mono: false };
}

/** Human label: admin_console → "Admin console". */
function sourceLabel(s: string | null | undefined): string {
  return s ? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—";
}

/**
 * The "Events" log: every domain event for this business, server
 * paginated (see `src/modules/events/service.ts` `listEventsUnified` — it
 * unions native events with the imported source history so a migrated site's
 * past reads like it happened here). The first page is server-rendered; later
 * pages stream in through `/api/lists/events`.
 */
export function EventsTable({
  page,
  biz,
  rows,
  total,
  hasMore,
  nextCursor,
  initialFilters,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  /** First page, server-rendered. */
  rows: EventRecord[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Deep-link filters from the URL (`?type=invoice.paid`) — see ListPage. */
  initialFilters?: ListServerFilter[];
}) {
  const fetchPage = React.useMemo(() => makeListSource<EventRecord>("events", biz), [biz]);
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();

  const columns = React.useMemo<ColumnDef<EventRecord>[]>(
    () => [
      {
        id: "event",
        header: "Event",
        accessorFn: (e) => e.event_type,
        cell: ({ row }) => {
          const ev = row.original;
          return (
            <InfoCell
              title={eventName(ev.event_type)}
              href={`/businesses/${biz}/events/${ev.id}`}
              sub={ev.id}
              // Only when the status says something. Every row carried a "Not
              // Configured" pill otherwise — 100 identical chips that push the
              // event name right and bury the rows where a delivery actually failed.
              trailing={
                ev.webhook_status && ev.webhook_status !== "not_configured" ? (
                  <StatusBadge status={ev.webhook_status} />
                ) : null
              }
            />
          );
        },
      },
      {
        id: "customer_info",
        header: "Customer Info",
        accessorFn: (e) => customerInfo(e),
        cell: ({ row }) => {
          const { text, mono } = customerInfoParts(row.original);
          return (
            <TextCell className={cn("block max-w-80 wrap-anywhere", mono && "font-mono text-xs")}>
              {text}
            </TextCell>
          );
        },
      },
      {
        id: "user",
        header: "User",
        accessorFn: (e) => e.user ?? "",
        cell: ({ row }) => (
          <span
            className="block max-w-40 truncate font-mono text-xs text-muted-foreground"
            title={row.original.user ?? undefined}
          >
            {row.original.user ?? "—"}
          </span>
        ),
      },
      {
        accessorKey: "occurred_at",
        id: "occurred_at",
        header: "Occurred On",
        cell: ({ row }) => (
          <TextCell className="whitespace-nowrap">
            {fmtDateTimeShort(row.original.occurred_at, tz)}
          </TextCell>
        ),
      },
      {
        id: "source",
        header: "Source",
        accessorFn: (e) => e.source ?? "",
        cell: ({ row }) => <TextCell>{sourceLabel(row.original.source)}</TextCell>,
      },
    ],
    [biz, tz],
  );

  /**
   * Every field in the engine's `NATIVE_EVENT_FILTERS` map, with that field's operator
   * table. No segments here, just filters — operator-SAVED views are a different thing
   * and are switched on below.
   */
  const filterFields = React.useMemo<ListFilterField<EventRecord>[]>(
    () => [
      // Both sides of the union: each table has its own public id (`evt_…` / `ievt_…`)
      // and the serializer prints both as `id`.
      { id: "id", label: "Event Id", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "type",
        label: "Event type",
        type: "select",
        group: "Identity",
        options: EVENT_TYPES.map((t) => ({ value: t, label: eventName(t) })),
        serverOps: ENUM_OPS,
      },
      // Text, not a picker, even though the vocabulary is nearly closed: the column is
      // TEXT on the engine, so it accepts `contains` / `starts_with`, and a select would
      // make those operators unreachable ("subscription%" is how the whole family is
      // pulled in one row).
      {
        id: "resource_type",
        label: "Resource type",
        group: "Identity",
        serverOps: TEXT_OPS,
        hint: NATIVE_ONLY,
        keywords: "subscription invoice customer credit_note",
      },
      {
        id: "resource_id",
        label: "Resource Id",
        group: "Identity",
        serverOps: TEXT_OPS,
        hint: NATIVE_ONLY,
      },

      {
        id: "source",
        label: "Source",
        type: "select",
        group: "Other",
        options: SOURCE_OPTIONS,
        // A FIXED list, not one built from the loaded page. It also cannot be built from
        // the page here: an IMPORTED row's serialized `source` is the source system's own
        // value out of its payload, a different vocabulary under the same name — and one
        // this filter can never match, since it drops imported rows anyway.
        serverOps: ENUM_OPS,
        hint: NATIVE_ONLY,
      },
      {
        id: "actor",
        label: "Actor",
        group: "Other",
        serverOps: TEXT_OPS,
        hint: `The actor: an API key ID, a portal email, 'billing_clock' or 'system'. ${NATIVE_ONLY}`,
        keywords: "user who api key",
      },
      {
        id: "trace_id",
        label: "Trace Id",
        group: "Other",
        serverOps: TEXT_OPS,
        hint: `The RUN. Lists only the events that one clock tick or request caused. A created_at window can also include events from a concurrent tick. ${NATIVE_ONLY}`,
        keywords: "correlation run tick request",
      },
      // Free text rather than a one-option menu: every event to date carries the column
      // default, and a select would have to be edited for a v2 the engine can ship on its
      // own. `is` / `is one of` read the same either way.
      {
        id: "api_version",
        label: "API version",
        group: "Other",
        serverOps: ENUM_OPS,
        hint: `The envelope schema version, for a consumer replaying one generation. Every event so far is 'v1'. ${NATIVE_ONLY}`,
        keywords: "envelope schema v1",
      },

      { id: "occurred_at", label: "Occurred", type: "date", group: "Dates", serverOps: DATE_OPS },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Event", plural: "Events" }}
      columns={columns}
      data={rows}
      server={{ total, hasMore, nextCursor, fetchPage }}
      filterFields={filterFields}
      savedViews={{ entity: "events", biz }}
      initialFilters={initialFilters}
      defaultSort={{ id: "occurred_at", desc: true }}
      searchPlaceholder="Search for event id / resource / actor…"
      exportName="events"
      persistKey={`events:${biz}`}
      rowHref={(e) => `/businesses/${biz}/events/${e.id}`}
      emptyState={
        <EmptyState
          icon={<Activity />}
          title="No events"
          description="No events match this view or search."
        />
      }
    />
  );
}
