"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Settings2, Archive, ArchiveRestore, Landmark } from "lucide-react";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { TextCell } from "@/components/patterns/list-cells";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/states";
import { archiveTaxRegion, restoreTaxRegion } from "@/app/actions";
import { REGIME_LABEL, intraTotalBps, interTotalBps, pct } from "@/lib/tax-format";
import type { TaxRegion } from "@/lib/api";

/**
 * Taxable regions — one row per country, drilling into the region detail page where the
 * component vector lives. The row shows `country · price type · registration number`
 * plus the resolved RATE, because a region with no components taxes nothing and that
 * must be visible from the list rather than only after drilling in.
 */
export function TaxRegionsTable({
  page,
  biz,
  rows,
  /** The page's own "Add region" dialog, so the zero-state can be the button. */
  createAction,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: TaxRegion[];
  createAction?: React.ReactNode;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState<TaxRegion | null>(null);

  async function runArchiveToggle(r: TaxRegion) {
    const res = await (r.enabled ? archiveTaxRegion : restoreTaxRegion)(biz, r.id);
    if (res.ok) {
      toast.success(r.enabled ? `Archived ${r.country}` : `Restored ${r.country}`);
      router.refresh();
    } else {
      toast.error(res.error ?? "We could not change the region.");
    }
  }

  const columns = React.useMemo<ColumnDef<TaxRegion>[]>(
    () => [
      {
        accessorKey: "country",
        header: "Country",
        cell: ({ row }) => <span className="text-sm font-medium">{row.original.country}</span>,
      },
      {
        id: "regime",
        header: "Regime",
        accessorFn: (r) => r.regime,
        cell: ({ row }) => <TextCell>{REGIME_LABEL[row.original.regime]}</TextCell>,
      },
      {
        id: "rate",
        header: "Rate",
        meta: { align: "right" },
        accessorFn: (r) => interTotalBps(r.components),
        cell: ({ row }) => {
          const r = row.original;
          const intra = intraTotalBps(r.components);
          const inter = interTotalBps(r.components);
          if (r.components.length === 0) {
            // An honest "nothing configured" beats rendering 0.00%, which reads as a
            // deliberate zero rate.
            return <span className="text-sm text-muted-foreground">Not configured</span>;
          }
          // A GST region has two branches; show both when they differ, one when they
          // agree (they normally do — IGST is CGST + SGST by law).
          return (
            <span className="text-sm tabular-nums">
              {r.regime === "gst" && intra !== inter ? `${pct(intra)} / ${pct(inter)}` : pct(inter)}
            </span>
          );
        },
      },
      {
        id: "price_type",
        header: "Prices",
        accessorFn: (r) => r.price_type,
        cell: ({ row }) => (
          <TextCell>
            {row.original.price_type === "inclusive" ? "Tax inclusive" : "Tax exclusive"}
          </TextCell>
        ),
      },
      {
        id: "registration_number",
        header: "Registration",
        accessorFn: (r) => r.registration_number ?? "",
        cell: ({ row }) => (
          <TextCell>
            {row.original.registration_number
              ? `${(row.original.registration_label ?? "Tax reg").toUpperCase()} ${row.original.registration_number}`
              : null}
          </TextCell>
        ),
      },
      {
        accessorKey: "enabled",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.enabled ? "enabled" : "disabled"} />,
      },
    ],
    [],
  );

  const segments = React.useMemo<ListSegment<TaxRegion>[]>(
    () => [
      { id: "all", label: "All Regions" },
      { id: "enabled", label: "Enabled", match: (r) => r.enabled },
      { id: "archived", label: "Archived", match: (r) => !r.enabled },
      // The one broken state this screen can have: an enabled region with no component
      // vector taxes nothing, silently, on every invoice it touches. It is why the Rate
      // column says "Not configured" instead of 0.00%.
      {
        id: "unconfigured",
        label: "Enabled, No Rate",
        match: (r) => r.enabled && r.components.length === 0,
      },
    ],
    [],
  );

  /**
   * `serializeTaxRegion` (src/api/tax-routes.ts) emits the whole row, so every gate on
   * the region detail page is filterable here — which is the point: "where do we accept
   * reverse charge?" and "which regions zero-rate exports?" were previously questions
   * you answered by opening each country in turn.
   */
  const filterFields = React.useMemo<ListFilterField<TaxRegion>[]>(
    () => [
      {
        id: "country",
        label: "Country",
        type: "select",
        group: "Identity",
        options: [...new Set(rows.map((r) => r.country))]
          .sort()
          .map((v) => ({ value: v, label: v })),
        value: (r) => r.country,
      },
      { id: "id", label: "Region Id", group: "Identity", value: (r) => r.id },
      {
        id: "enabled",
        label: "Enabled",
        type: "boolean",
        group: "Status",
        value: (r) => r.enabled,
      },
      // Derived: a region with an empty component vector applies no tax at all.
      {
        id: "configured",
        label: "Rate configured",
        type: "boolean",
        group: "Status",
        hint: "No: the region charges no tax",
        value: (r) => r.components.length > 0,
      },
      {
        id: "regime",
        label: "Regime",
        type: "select",
        group: "Tax",
        options: Object.entries(REGIME_LABEL).map(([value, label]) => ({ value, label })),
        value: (r) => r.regime,
      },
      {
        id: "price_type",
        label: "Price type",
        type: "select",
        group: "Tax",
        options: [
          { value: "exclusive", label: "Tax exclusive" },
          { value: "inclusive", label: "Tax inclusive" },
        ],
        value: (r) => r.price_type,
      },
      // Basis points, and the INTER-state total — the same number the Rate column
      // sorts on. Not `money`: a rate is not an amount and has no currency.
      {
        id: "rate_bps",
        label: "Rate (basis points)",
        type: "number",
        group: "Tax",
        hint: "1800 = 18%. Inter-state total, as sorted by the Rate column",
        value: (r) => interTotalBps(r.components),
      },
      {
        id: "registration_number",
        label: "Registration number",
        group: "Tax",
        value: (r) => r.registration_number,
      },
      {
        id: "registration_label",
        label: "Registration label",
        group: "Tax",
        hint: "e.g. GSTIN, VAT",
        value: (r) => r.registration_label,
      },
      {
        id: "collect_registration_number",
        label: "Collect customer registration number",
        type: "boolean",
        group: "Tax",
        value: (r) => r.collect_registration_number,
      },
      // India GST: the seller state the place-of-supply rule is evaluated against.
      {
        id: "home_state_code",
        label: "Home state code",
        group: "Tax",
        value: (r) => r.home_state_code,
      },
      {
        id: "reverse_charge_enabled",
        label: "Reverse charge",
        type: "boolean",
        group: "Tax",
        value: (r) => r.reverse_charge_enabled,
      },
      {
        id: "sez_igst_enabled",
        label: "SEZ — charge IGST",
        type: "boolean",
        group: "Tax",
        value: (r) => r.sez_igst_enabled,
      },
      {
        id: "sez_zero_rated_enabled",
        label: "SEZ — zero rated",
        type: "boolean",
        group: "Tax",
        value: (r) => r.sez_zero_rated_enabled,
      },
      {
        id: "export_igst_enabled",
        label: "Export — charge IGST",
        type: "boolean",
        group: "Tax",
        value: (r) => r.export_igst_enabled,
      },
      {
        id: "export_zero_rated_enabled",
        label: "Export — zero rated",
        type: "boolean",
        group: "Tax",
        value: (r) => r.export_zero_rated_enabled,
      },
      {
        id: "created_at",
        label: "Created At",
        type: "date",
        group: "Dates",
        value: (r) => r.created_at,
      },
    ],
    [rows],
  );

  return (
    <>
      <ListPage
        page={page}
        entity={{ singular: "Region", plural: "Regions" }}
        columns={columns}
        data={rows}
        segments={segments}
        filterFields={filterFields}
        savedViews={{ entity: "tax_regions", biz }}
        searchPlaceholder="Search regions…"
        exportName="tax-regions"
        persistKey={`tax-regions:${biz}`}
        defaultSort={{ id: "country", desc: false }}
        rowHref={(r) => `/businesses/${biz}/catalog/tax/${r.id}`}
        rowMenu={(r) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={`Actions for ${r.country}`}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => router.push(`/businesses/${biz}/catalog/tax/${r.id}`)}
              >
                <Settings2 className="size-4" />
                Configure
              </DropdownMenuItem>
              <DropdownMenuItem
                variant={r.enabled ? "destructive" : "default"}
                onSelect={() => setConfirming(r)}
              >
                {r.enabled ? <Archive className="size-4" /> : <ArchiveRestore className="size-4" />}
                {r.enabled ? "Archive" : "Restore"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        emptyState={
          <EmptyState
            icon={<Landmark />}
            title="No tax regions"
            description="Create a region for each country where you collect tax."
            action={createAction}
          />
        }
      />

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && setConfirming(null)}
        title={
          confirming?.enabled
            ? `Archive ${confirming?.country}?`
            : `Restore ${confirming?.country}?`
        }
        description={
          confirming?.enabled
            ? "We stop applying tax to new invoices for this country. Existing invoices keep their tax. You can restore the region later."
            : "We apply tax to new invoices for this country again."
        }
        confirmLabel={confirming?.enabled ? "Archive" : "Restore"}
        destructive={confirming?.enabled}
        onConfirm={() => {
          if (confirming) return runArchiveToggle(confirming);
        }}
      />
    </>
  );
}
