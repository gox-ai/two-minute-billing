"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  createAction,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { InfoCell, TextCell } from "@/components/patterns/list-cells";
import { StatusBadge } from "@/components/status-badge";
import { Chip } from "@/components/patterns/chip";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/states";
import { fmtDateShort } from "@/lib/format";
import { Plug } from "lucide-react";
import {
  gatewayDisplayName,
  gatewayEntry,
  type GatewayCatalogEntry,
} from "@/components/gateways/gateway-meta";
import { LOGO_SIZE, PartnerLogo } from "@/components/partner-logo";
import type { GatewayAccount } from "@/lib/api/gateways";
import { useBusinessTz } from "@/components/business-tz";

/** Gateway accounts list — whole row navigates to the account detail page. */
export function GatewaysTable({
  page,
  biz,
  rows,
  catalog,
  defaultId,
  createHref,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: GatewayAccount[];
  /** `GET /v1/gateways`, for display names. */
  catalog: GatewayCatalogEntry[];
  /** Public id of the business's default gateway account (null = unknown/none). */
  defaultId: string | null;
  /** "Add gateway" target. */
  createHref?: string;
}) {
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const columns = React.useMemo<ColumnDef<GatewayAccount>[]>(
    () => [
      {
        id: "gateway",
        header: "Gateway",
        accessorFn: (g) => `${gatewayDisplayName(g.gateway_key, catalog)} ${g.label}`,
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <PartnerLogo
              brand={row.original.gateway_key}
              name={gatewayDisplayName(row.original.gateway_key, catalog)}
              {...LOGO_SIZE.row}
            />
            <InfoCell
              title={<span className="block max-w-80 wrap-anywhere">{row.original.label}</span>}
              href={`/businesses/${biz}/settings/gateways/${row.original.id}`}
              trailing={
                defaultId && row.original.id === defaultId ? (
                  <Badge variant="outline" className="border-primary/40 text-primary">
                    Default
                  </Badge>
                ) : null
              }
              sub={
                <span className="text-xs text-muted-foreground">
                  {gatewayDisplayName(row.original.gateway_key, catalog)}
                  <span className="ml-2 font-mono text-xs">{row.original.id}</span>
                </span>
              }
            />
          </div>
        ),
      },
      {
        id: "mode",
        header: "Mode",
        accessorFn: (g) => (g.livemode ? "live" : "test"),
        cell: ({ row }) => (
          <Chip
            tone={row.original.livemode ? "green" : "tan"}
            className="text-xs font-bold tracking-wide uppercase"
          >
            {row.original.livemode ? "Live" : "Test"}
          </Chip>
        ),
      },
      {
        id: "currencies",
        header: "Currencies",
        accessorFn: (g) => (g.currencies ?? []).join(" "),
        cell: ({ row }) =>
          row.original.currencies && row.original.currencies.length > 0 ? (
            <span className="flex flex-wrap gap-1">
              {row.original.currencies.map((c) => (
                <Chip key={c} className="font-mono text-xs">
                  {c}
                </Chip>
              ))}
            </span>
          ) : (
            <TextCell>All</TextCell>
          ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "created_at",
        id: "created_at",
        header: "Created",
        cell: ({ row }) => <TextCell>{fmtDateShort(row.original.created_at, tz)}</TextCell>,
      },
    ],
    [biz, catalog, defaultId, tz],
  );

  const segments = React.useMemo<ListSegment<GatewayAccount>[]>(
    () => [
      { id: "all", label: "All Gateway Accounts" },
      { id: "live", label: "Live", match: (g) => !!g.livemode },
      { id: "test", label: "Test", match: (g) => !g.livemode },
      { id: "active", label: "Active", match: (g) => g.status === "active" },
      // The account is connected but its callbacks cannot be verified, so every inbound
      // webhook is rejected — a silent failure the list otherwise shows as "Active".
      // `webhook_secret_configured` is the engine's own boolean; the secret itself is
      // never echoed (serializeGatewayAccount). Not meaningful where the catalogue says no
      // secret exists (`none`: no webhooks; `credential`: the API keys sign) or for PayPal
      // (verifies by webhook id) — those report their state on the account page.
      {
        id: "no_webhook_secret",
        label: "Webhook Secret Missing",
        match: (g) => {
          const owner = gatewayEntry(catalog, g.gateway_key)?.webhook_secret;
          return (
            !g.webhook_secret_configured &&
            owner !== "none" &&
            owner !== "credential" &&
            g.gateway_key !== "tmtest" &&
            g.gateway_key !== "paypal"
          );
        },
      },
    ],
    [catalog],
  );

  const filterFields = React.useMemo<ListFilterField<GatewayAccount>[]>(
    () => [
      { id: "label", label: "Label", group: "Identity", value: (g) => g.label },
      { id: "id", label: "Gateway Account Id", group: "Identity", value: (g) => g.id },
      {
        id: "gateway_key",
        label: "Gateway",
        type: "select",
        group: "Gateway",
        options: [...new Set(rows.map((g) => g.gateway_key))]
          .sort()
          .map((v) => ({ value: v, label: gatewayDisplayName(v, catalog) })),
        value: (g) => g.gateway_key,
      },
      // Both are `string[] | null`, joined so `contains` reads a membership test. Null
      // means "no restriction", which is why the hint spells that out rather than
      // leaving `is empty` to look like a gap.
      {
        id: "currencies",
        label: "Currency",
        group: "Gateway",
        hint: "Empty = all currencies",
        value: (g) => (g.currencies ?? []).join(","),
      },
      {
        id: "method_types",
        label: "Payment method type",
        group: "Gateway",
        hint: "Empty = all method types",
        value: (g) => (g.method_types ?? []).join(","),
      },
      {
        id: "status",
        label: "Status",
        type: "select",
        group: "Status",
        options: [
          { value: "active", label: "active" },
          { value: "disabled", label: "disabled" },
        ],
        value: (g) => g.status,
      },
      {
        id: "livemode",
        label: "Live mode",
        type: "boolean",
        group: "Status",
        value: (g) => !!g.livemode,
      },
      // `default` is NOT on the serialized row — the page resolves it separately and
      // passes it in, which is the same source the Default badge renders from.
      {
        id: "is_default",
        label: "Business default",
        type: "boolean",
        group: "Status",
        value: (g) => !!defaultId && g.id === defaultId,
      },
      {
        id: "webhook_secret_configured",
        label: "Webhook secret configured",
        type: "boolean",
        group: "Status",
        value: (g) => g.webhook_secret_configured,
      },
      {
        id: "created_at",
        label: "Created",
        type: "date",
        group: "Dates",
        value: (g) => g.created_at,
      },
      {
        id: "updated_at",
        label: "Last modified",
        type: "date",
        group: "Dates",
        value: (g) => g.updated_at,
      },
    ],
    [rows, catalog, defaultId],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Gateway Account", plural: "Gateway Accounts" }}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      savedViews={{ entity: "gateways", biz }}
      createAction={
        createHref
          ? { ...createAction("Gateway Account", createHref), label: "Add gateway" }
          : undefined
      }
      exportName="gateway-accounts"
      persistKey="gateways"
      searchPlaceholder="Search gateways…"
      rowHref={(g) => `/businesses/${biz}/settings/gateways/${g.id}`}
      emptyState={
        <EmptyState
          icon={<Plug />}
          title="No gateway accounts"
          description="Connect Stripe, PayPal, or Razorpay to start collecting payments for this business."
        />
      }
    />
  );
}
