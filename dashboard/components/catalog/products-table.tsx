"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/data-table";
import {
  ListPage,
  createAction,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { InfoCell, TextCell } from "@/components/patterns/list-cells";
import { ProductRowMenu } from "@/components/catalog/product-row-menu";
import { EmptyState } from "@/components/states";
import { fmtDateShort } from "@/lib/format";
import { Package } from "lucide-react";
import type { Product, ProductGroup } from "@/lib/api";
import { useBusinessTz } from "@/components/business-tz";

interface ProductColumnOpts {
  biz: string;
  hideKind?: boolean;
  groups?: ProductGroup[];
}

/** The plan/addon/charge columns — shared by the list page + the group detail table. */
function useProductColumns({ biz, hideKind, groups = [] }: ProductColumnOpts) {
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const groupName = React.useCallback(
    (id?: string) => groups.find((g) => g.id === id)?.name ?? "—",
    [groups],
  );

  return React.useMemo<ColumnDef<Product>[]>(
    () => [
      {
        accessorKey: "name",
        header: hideKind ? "Name" : "Product",
        cell: ({ row }) => (
          <InfoCell
            status={row.original.active ? "active" : "archived"}
            title={<span className="block max-w-80 wrap-anywhere">{row.original.name}</span>}
            href={`/businesses/${biz}/catalog/products/${row.original.id}`}
            sub={row.original.id}
          />
        ),
      },
      ...(hideKind
        ? []
        : [
            {
              accessorKey: "kind",
              header: "Kind",
              cell: ({ row }) => (
                <span className="text-sm capitalize">{row.original.kind ?? "plan"}</span>
              ),
            } as ColumnDef<Product>,
          ]),
      {
        id: "group",
        header: "Product Group",
        accessorFn: (p) => p.product_group ?? "",
        cell: ({ row }) => (
          <span className="block max-w-80 text-sm wrap-anywhere">
            {groupName(row.original.product_group)}
          </span>
        ),
      },
      // No "Display in checkout" / "Display in self-serve portal" columns: the flags are
      // stored, but no checkout or portal reads them.
      {
        accessorKey: "updated_at",
        header: "Last modified",
        cell: ({ row }) => {
          const d = row.original.updated_at ?? row.original.created_at;
          return <TextCell>{d ? fmtDateShort(d, tz) : null}</TextCell>;
        },
      },
    ],
    [biz, hideKind, groupName],
  );
}

/**
 * Products table **embedded** in another page (e.g. a product group's detail
 * page) — plain table, no list chrome. Full list screens use `ProductsListPage`.
 */
export function ProductsTable({
  biz,
  rows,
  hideKind,
  groups = [],
}: ProductColumnOpts & { rows: Product[] }) {
  // Dates render in the business timezone, not UTC (see components/business-tz).
  const tz = useBusinessTz();
  const columns = useProductColumns({ biz, hideKind, groups });
  return (
    <DataTable
      columns={columns}
      data={rows}
      searchPlaceholder="Search for ID / Name…"
      countLabel="Products"
      exportName="products"
      columnChooser
      persistKey={`products:${biz}`}
      rowMenu={(p) => <ProductRowMenu biz={biz} id={p.id} label={p.name} active={p.active} />}
      onRowHref={(p) => `/businesses/${biz}/catalog/products/${p.id}`}
      emptyState={
        <EmptyState
          icon={<Package />}
          title="No products"
          description="No products match your search."
        />
      }
    />
  );
}

/** Distinct, sorted select options from the loaded rows. */
function options(values: (string | null | undefined)[], label?: (v: string) => string) {
  return [...new Set(values.filter((v): v is string => !!v))]
    .sort()
    .map((v) => ({ value: v, label: label?.(v) ?? v }));
}

/**
 * The Plans / Add-ons / Charges list screen — same `ListPage` chrome as every
 * other list, with the kind-specific wording and create/import actions.
 */
export function ProductsListPage({
  page,
  biz,
  rows,
  kind,
  entity,
  createHref,
  groups = [],
  importSlot,
  topBarExtras,
  emptyDescription,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: Product[];
  kind: "plan" | "addon" | "charge";
  /** e.g. `{ singular: 'Plan', plural: 'Plans' }`. */
  entity: { singular: string; plural: string };
  createHref: string;
  groups?: ProductGroup[];
  /** The CSV import dialog trigger. */
  importSlot?: React.ReactNode;
  /** e.g. the show-archived toggle / "filtered to group" chip. */
  topBarExtras?: React.ReactNode;
  /** Shown when the business genuinely has none of these yet. */
  emptyDescription?: string;
}) {
  const columns = useProductColumns({ biz, hideKind: true, groups });

  const segments = React.useMemo<ListSegment<Product>[]>(
    () => [
      { id: "all", label: `All ${entity.plural}` },
      { id: "active", label: "Active", match: (p) => p.active },
      { id: "archived", label: "Archived", match: (p) => !p.active },
      // Metered items price off usage, so they are the ones whose invoices depend on
      // usage arriving — worth isolating without opening every product.
      { id: "metered", label: "Metered", match: (p) => !!p.metered },
    ],
    [entity.plural],
  );

  const groupLabel = React.useCallback(
    (id: string) => groups.find((g) => g.id === id)?.name ?? id,
    [groups],
  );
  const filterFields = React.useMemo<ListFilterField<Product>[]>(
    () => [
      { id: "name", label: "Name", group: "Identity", value: (p) => p.name },
      // The name shown to the CUSTOMER (checkout, portal, invoice) when it differs
      // from the internal one — the pair is exactly what an audit of customer-facing
      // wording needs, and only this field is searchable by it.
      {
        id: "external_name",
        label: "External Name",
        group: "Identity",
        value: (p) => p.external_name,
      },
      { id: "id", label: `${entity.singular} Id`, group: "Identity", value: (p) => p.id },
      { id: "description", label: "Description", group: "Other", value: (p) => p.description },
      { id: "active", label: "Active", type: "boolean", group: "Status", value: (p) => p.active },
      {
        id: "product_group",
        label: "Product Group",
        type: "select",
        group: "Configuration",
        options: options(
          rows.map((p) => p.product_group),
          groupLabel,
        ),
        value: (p) => p.product_group,
      },
      {
        id: "unit_of_measure",
        label: "Unit of Measure",
        group: "Configuration",
        value: (p) => p.unit_of_measure,
      },
      {
        id: "metered",
        label: "Metered",
        type: "boolean",
        group: "Configuration",
        value: (p) => !!p.metered,
      },
      {
        id: "redirect_url",
        label: "After-payment page",
        group: "Configuration",
        value: (p) => p.redirect_url,
      },
      // Addons only. `addon_applies_to_all` is undefined on a plan or a charge, so on
      // those two lists the field would answer "No" for every row — a filter that
      // narrows nothing while looking like it narrows something.
      ...(kind === "addon"
        ? [
            {
              id: "addon_applies_to_all",
              label: "Applies to all plans",
              type: "boolean" as const,
              group: "Configuration",
              value: (p: Product) => !!p.addon_applies_to_all,
            },
          ]
        : []),
      // HSN/SAC. Null means "fall back to the business default_tax_code", which is why
      // `is empty` is the useful question here — see the Product type.
      {
        id: "tax_code",
        label: "Tax Code (HSN/SAC)",
        group: "Tax",
        hint: "If empty, the business default applies",
        value: (p) => p.tax_code,
      },
      {
        id: "updated_at",
        label: "Last modified",
        type: "date",
        group: "Dates",
        value: (p) => p.updated_at ?? p.created_at,
      },
      {
        id: "created_at",
        label: "Created At",
        type: "date",
        group: "Dates",
        value: (p) => p.created_at,
      },
    ],
    [rows, entity.singular, groupLabel, kind],
  );

  return (
    <ListPage
      page={page}
      entity={entity}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      // One entity key for Plans / Add-ons / Charges: they are the same table filtered
      // to one `kind` (see KindCatalog), the row shape is identical, and every field
      // above means the same thing on all three — so a view saved on one is legible on
      // the others. `kind` is deliberately NOT a filter field for the same reason it is
      // not a column here: each page has already narrowed to it.
      savedViews={{ entity: "products", biz }}
      createAction={createAction(entity.singular, createHref)}
      importSlot={importSlot}
      topBarExtras={topBarExtras}
      searchPlaceholder="Search for ID / Name…"
      exportName={kind === "plan" ? "plans" : kind === "addon" ? "addons" : "charges"}
      persistKey={`${kind}s:${biz}`}
      rowHref={(p) => `/businesses/${biz}/catalog/products/${p.id}`}
      rowMenu={(p) => <ProductRowMenu biz={biz} id={p.id} label={p.name} active={p.active} />}
      // No created-at column here — this list sorts by Last modified.
      defaultSort={{ id: "updated_at", desc: true }}
      emptyState={
        <EmptyState
          icon={<Package />}
          title={`No ${entity.plural.toLowerCase()}`}
          description={
            rows.length === 0
              ? (emptyDescription ?? `No ${entity.plural.toLowerCase()} yet.`)
              : `No ${entity.plural.toLowerCase()} match this view, filter or search.`
          }
        />
      }
    />
  );
}
