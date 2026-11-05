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
import { IdCell, TextCell, TruncateCell } from "@/components/patterns/list-cells";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { EmptyState } from "@/components/states";
import { EditDrawer } from "@/components/edit-drawer";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { replayGatewayWebhookAction } from "@/app/(dashboard)/businesses/[biz]/gateway_webhooks/actions";
import { fmtDateTime, fmtDateTimeShort } from "@/lib/format";
import type { GatewayWebhook } from "@/lib/api/payments";
import { Webhook } from "lucide-react";
import { useBusinessTz } from "@/components/business-tz";
import { mergeOptions } from "@/lib/filter-options";
import { gatewayFilterOptions, type GatewayCatalogEntry } from "@/components/gateways/gateway-meta";
import { GatewayLabel } from "@/components/partner-logo";

/** The declared gateways; `mergeOptions` adds anything the data carries beyond them. */

/**
 * Operators the engine implements, per column kind. `GATEWAY_WEBHOOK_FILTER_OPS` is
 * `opsFromSpecs(GATEWAY_WEBHOOK_FILTERS)`, so every field gets the whole table for its
 * kind (`src/platform/list-query.ts`) — set membership, ranges and relative windows
 * included. These lists used to be a subset and withheld operators the endpoint
 * already answered.
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

/**
 * Truncate the middle of a URL so the host and the path tail stay visible — same
 * treatment as the outbound Gateway Requests log (kept local to each table rather
 * than shared, so neither list's column can change out from under the other).
 */
function truncateMiddle(s: string, max = 56): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Tone for the status WE answered the gateway with (502 = please redeliver). */
function statusTone(status: number): "green" | "tan" | "red" {
  if (status >= 500) return "red";
  if (status >= 400) return "tan";
  return "green";
}

/**
 * Re-run a webhook stuck at `outcome: error` — the manual handle for after the gateway
 * has exhausted its own retries. Rendered only on errored rows (see `rowMenu`).
 *
 * A replay can legitimately fail AGAIN (the stored event may be permanently
 * unprocessable), so the result is surfaced verbatim rather than assumed successful.
 */
function ReplayButton({
  biz,
  id,
  outcome,
  type,
}: {
  biz: string;
  id: string;
  outcome: string | null;
  type: string | null;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [confirming, setConfirming] = React.useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(true)}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RotateCcw className="size-3.5" />
        )}
        <span className="ml-1">Replay</span>
      </Button>
      {/* A replay RE-RUNS money handlers: it can book a capture, settle an invoice and
          issue a refund. It used to sit only on rare `error` rows; since `ignored` became
          replayable it is on most rows in this table, one pixel from Inspect — so the
          confirmation is what keeps a misclick from moving money. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Replay this webhook?"
        confirmLabel="Replay"
        description={
          <>
            Runs the handlers for <span className="font-medium">{type ?? "this event"}</span> again
            {outcome ? (
              <>
                {" "}
                (currently <span className="font-medium">{outcome}</span>)
              </>
            ) : null}
            . This can book a capture, settle an invoice or issue a refund. Do this only after you
            examine the payload and know what the event does. We do not book the same money twice.
          </>
        }
        onConfirm={() =>
          start(async () => {
            const res = await replayGatewayWebhookAction(biz, id);
            if (res.ok) toast.success(res.message ?? "Replayed");
            else toast.error(res.message ?? "We could not replay the webhook.");
            router.refresh();
          })
        }
      />
    </>
  );
}

/** Inbound gateway-webhook log with a payload/outcome inspector drawer. */
export function GatewayWebhooksTable({
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
  rows: GatewayWebhook[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
  /**
   * Filters applied on open: the URL's (`?outcome=error`) or, with no URL scope,
   * the "This day" default the page resolves. See ListPage.initialFilters.
   */
  initialFilters?: ListServerFilter[];
}) {
  const fetchPage = React.useMemo(
    () => makeListSource<GatewayWebhook>("gateway_webhooks", biz),
    [biz],
  );
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const [detail, setDetail] = React.useState<GatewayWebhook | null>(null);

  const columns = React.useMemo<ColumnDef<GatewayWebhook>[]>(
    () => [
      {
        id: "id",
        header: "ID",
        accessorFn: (w) => w.id,
        cell: ({ row }) => <IdCell id={row.original.id} />,
      },
      {
        accessorKey: "gateway_key",
        header: "Gateway",
        cell: ({ row }) => (
          <GatewayLabel gatewayKey={row.original.gateway_key} className="text-sm" />
        ),
      },
      // Linking each callback to the transaction it affected is what turns a log row
      // into a lead. Resolved in the engine from the gateway's charge id
      // (`transactions.id_at_gateway`), so it is null — and renders blank — for a
      // callback about no charge of ours (`payment_method.updated`, a provider CLI
      // test event).
      {
        id: "transaction",
        header: "Transaction",
        accessorFn: (w) => w.transaction ?? "",
        cell: ({ row }) => (
          <IdCell
            id={row.original.transaction}
            href={
              row.original.transaction
                ? `/businesses/${biz}/transactions/${row.original.transaction}`
                : undefined
            }
          />
        ),
      },
      {
        id: "type",
        header: "Event type",
        accessorFn: (w) => w.type ?? "—",
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.type ?? "—"}</span>,
      },
      {
        id: "outcome",
        header: "Outcome",
        accessorFn: (w) => w.outcome ?? "pending",
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <StatusChip status={row.original.outcome ?? "pending"} />
            {row.original.error ? (
              <TruncateCell value={row.original.error} width="max-w-48" className="text-xs" />
            ) : null}
          </span>
        ),
      },
      // The HTTP exchange (P2). Both are null for rows written before migration 0141
      // and for events that never came in over HTTP (internal replays, verify
      // suites) — those render as the house blank, not a fabricated 200.
      {
        id: "response_status",
        header: "Status Code",
        accessorFn: (w) => w.response_status ?? "",
        cell: ({ row }) => {
          const s = row.original.response_status;
          if (s == null) return <TextCell>{null}</TextCell>;
          return <Chip tone={statusTone(s)}>{s}</Chip>;
        },
      },
      {
        id: "request_url",
        header: "URL",
        accessorFn: (w) => w.request_url ?? "",
        cell: ({ row }) => {
          const url = row.original.request_url;
          if (!url) return <TextCell>{null}</TextCell>;
          return (
            <TruncateCell
              value={url}
              width="max-w-72"
              className="font-mono text-xs text-foreground"
            >
              {truncateMiddle(url)}
            </TruncateCell>
          );
        },
      },
      {
        accessorKey: "received_at",
        id: "received_at",
        header: "Received",
        cell: ({ row }) => <TextCell>{fmtDateTimeShort(row.original.received_at, tz)}</TextCell>,
      },
      // How long each inbound webhook took ("4269 ms"). We stored `received_at` AND
      // `processed_at` all along and never subtracted them — the drill-in even prints
      // both side by side. Derived, so no schema change.
      {
        id: "duration_ms",
        header: "Duration",
        meta: { align: "right" },
        accessorFn: (w) =>
          w.processed_at
            ? new Date(w.processed_at).getTime() - new Date(w.received_at).getTime()
            : -1,
        cell: ({ row }) => {
          const { received_at: r, processed_at: p } = row.original;
          if (!p) return <TextCell>{null}</TextCell>;
          const ms = new Date(p).getTime() - new Date(r).getTime();
          // A negative delta means the two timestamps disagree; show nothing
          // rather than an impossible duration.
          return <TextCell>{ms >= 0 ? `${ms} ms` : null}</TextCell>;
        },
      },
    ],
    // `biz` (transaction links) and `tz` (date rendering) are both read above; the
    // old `[]` meant a business/timezone switch reused stale cells.
    [biz, tz],
  );

  const segments = React.useMemo<ListSegment<GatewayWebhook>[]>(
    () => [
      { id: "all", label: "All Webhooks" },
      {
        id: "processed",
        label: "Processed",
        filters: [{ field: "outcome", op: "is", value: "processed" }],
      },
      {
        id: "ignored",
        label: "Ignored",
        filters: [{ field: "outcome", op: "is", value: "ignored" }],
      },
      // On `outcome`, not on `error is_present`. The two select the same rows —
      // `handleProviderEvent` writes the message and `outcome: 'error'` in one UPDATE —
      // but `outcome` is the definitional one, and it is the field the Replay button
      // gates on, so the segment and the row action can never disagree.
      { id: "failed", label: "Failed", filters: [{ field: "outcome", op: "is", value: "error" }] },
      {
        id: "pending",
        label: "Pending",
        filters: [{ field: "outcome", op: "is_present", value: "false" }],
      },
      // We answered non-2xx, so the gateway will redeliver: the set that is still in
      // flight between us and the provider, which no other view isolates.
      {
        id: "redelivering",
        label: "We answered 5xx",
        filters: [{ field: "response_status", op: "gte", value: "500" }],
      },
    ],
    [],
  );

  /** Every column in `GATEWAY_WEBHOOK_FILTERS` (src/modules/gateway/inbound.ts). */
  const filterFields = React.useMemo<ListFilterField<GatewayWebhook>[]>(
    () => [
      { id: "id", label: "Webhook Id", group: "Identity", serverOps: TEXT_OPS },
      // The transaction this callback moved money on, as its public id (`txn_…`) —
      // resolved once at ingest, see migration 0141.
      { id: "transaction", label: "Transaction", group: "Identity", serverOps: TEXT_OPS },
      // The gateway's intent id (`seti_…`, `pi_…`) — how an intent attempt links here.
      { id: "intent", label: "Gateway intent", group: "Identity", serverOps: TEXT_OPS },
      {
        id: "gateway_key",
        label: "Gateway",
        type: "select",
        group: "Gateway",
        options: mergeOptions(
          gatewayFilterOptions(gatewayCatalog),
          rows.map((w) => w.gateway_key),
        ),
        serverOps: ENUM_OPS,
      },
      { id: "type", label: "Event type", group: "Gateway", serverOps: TEXT_OPS },
      {
        id: "outcome",
        label: "Outcome",
        type: "select",
        group: "Status",
        // The engine's own vocabulary (db/schema/platform.ts: processed | ignored |
        // error), not just what this page happens to hold — a NULL outcome means a
        // delivery still in flight, which `is empty` finds.
        options: [
          { value: "processed", label: "processed" },
          { value: "ignored", label: "ignored" },
          { value: "error", label: "error" },
        ],
        serverOps: ENUM_OPS,
      },
      { id: "error", label: "Error", group: "Status", serverOps: TEXT_OPS },
      // What WE answered the gateway with — 200 handled, 502 → please redeliver.
      {
        id: "response_status",
        label: "Status code",
        type: "number",
        group: "Delivery",
        serverOps: NUM_OPS,
      },
      { id: "request_url", label: "URL", group: "Delivery", serverOps: TEXT_OPS },
      { id: "received_at", label: "Received", type: "date", group: "Dates", serverOps: DATE_OPS },
    ],
    [rows, gatewayCatalog],
  );

  return (
    <>
      <ListPage
        page={page}
        entity={{ singular: "Webhook", plural: "Webhooks" }}
        columns={columns}
        data={rows}
        server={{ total, hasMore, nextCursor, fetchPage }}
        segments={segments}
        filterFields={filterFields}
        /**
         * ⚠ Named views and `?view=` links work here, but an operator's DEFAULT view
         * does not open automatically: the page always seeds `initialFilters` (the
         * "today" scope), and `ListPage` deliberately lets a seeded filter win over a
         * default view so a shared link keeps meaning what its sender saw. `?all=1`
         * clears the seed and the default then applies. Fixing it properly means
         * moving the day scope into `segments[0].filters` AND filtering the page's own
         * SSR fetch to match — otherwise the first paint would show every row under a
         * "Today" label, which is the exact lie this list already fixed once.
         */
        savedViews={{ entity: "gateway_webhooks", biz }}
        initialFilters={initialFilters}
        searchPlaceholder="Search for ID / gateway / event type / transaction / URL…"
        exportName="gateway-webhooks"
        persistKey={`gateway_webhooks:${biz}`}
        rowMenu={(w) => (
          <span className="flex items-center gap-1">
            {/* Errored AND ignored rows are replayable; the API 409s on a processed one,
                and an always-visible Replay would imply a processed event can be re-run,
                which would re-execute handlers that book money. `ignored` was excluded
                until 2026-09-05 — but it also covers "our code did not understand this
                yet", so a fixed handler needs a way to re-run what the broken one
                dropped. An ignored row booked nothing, so a replay cannot double-post. */}
            {w.outcome === "error" || w.outcome === "ignored" ? (
              <ReplayButton biz={biz} id={w.id} outcome={w.outcome} type={w.type} />
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setDetail(w)}>
              Inspect
            </Button>
          </span>
        )}
        emptyState={
          <EmptyState
            icon={<Webhook />}
            title="No gateway webhooks"
            description="No inbound gateway webhooks match this view or search."
          />
        }
      />

      <EditDrawer
        open={!!detail}
        onOpenChange={(o) => !o && setDetail(null)}
        title={detail ? `Webhook ${detail.id}` : "Webhook"}
        description={
          detail ? `${detail.gateway_key} · ${detail.type ?? "unknown event"}` : undefined
        }
      >
        {detail ? (
          <div className="space-y-4 pb-6">
            <dl className="divide-y">
              <DetailRow label="Outcome">
                <StatusChip status={detail.outcome ?? "pending"} />
              </DetailRow>
              <DetailRow label="Gateway">
                <GatewayLabel gatewayKey={detail.gateway_key} fit />
              </DetailRow>
              <DetailRow label="Event type">
                <span className="font-mono text-xs">{detail.type ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Provider event id">
                <span className="font-mono text-xs">{detail.provider_event_id ?? "—"}</span>
              </DetailRow>
              <DetailRow label="Transaction">
                {detail.transaction ? (
                  <IdCell
                    id={detail.transaction}
                    href={`/businesses/${biz}/transactions/${detail.transaction}`}
                  />
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="Status code">
                {detail.response_status != null ? (
                  <Chip tone={statusTone(detail.response_status)}>{detail.response_status}</Chip>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="URL">
                {detail.request_url ? (
                  <span className="font-mono text-xs">{detail.request_url}</span>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="Error">
                {detail.error ? <span className="text-destructive">{detail.error}</span> : "—"}
              </DetailRow>
              <DetailRow label="Received">{fmtDateTime(detail.received_at, tz)}</DetailRow>
              <DetailRow label="Processed">
                {detail.processed_at ? fmtDateTime(detail.processed_at, tz) : "—"}
              </DetailRow>
            </dl>

            <div>
              <p className="mb-1.5 text-sm font-medium">Headers</p>
              {detail.headers != null ? (
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(detail.headers, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No headers stored.</p>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-sm font-medium">Payload</p>
              {detail.payload != null ? (
                <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No payload stored.</p>
              )}
            </div>
          </div>
        ) : null}
      </EditDrawer>
    </>
  );
}
