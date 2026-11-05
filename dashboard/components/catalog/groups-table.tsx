"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ListPage,
  type ListFilterField,
  type ListSegment,
  type ListPageHeader,
} from "@/components/patterns/list-page";
import { InfoCell, TruncateCell } from "@/components/patterns/list-cells";
import { GroupRowMenu } from "@/components/catalog/group-row-menu";
import { EmptyState } from "@/components/states";
import { Layers } from "lucide-react";
import type { ProductGroup } from "@/lib/api";

/**
 * Product groups list on the shared `ListPage` chrome. Our route/model is
 * `product_groups`; the display wording is "Product Group".
 */
export function GroupsTable({
  page,
  biz,
  rows,
  createSlot,
  importSlot,
}: {
  /** The page header, drawn by the list (see ListPage.page). */
  page?: ListPageHeader;
  biz: string;
  rows: ProductGroup[];
  /** The "Create Product Group" dialog trigger (create is a modal here). */
  createSlot?: React.ReactNode;
  /** The CSV import dialog trigger. */
  importSlot?: React.ReactNode;
}) {
  const columns = React.useMemo<ColumnDef<ProductGroup>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Product Group",
        cell: ({ row }) => (
          <InfoCell
            title={<span className="block max-w-80 wrap-anywhere">{row.original.name}</span>}
            href={`/businesses/${biz}/catalog/product_groups/${row.original.id}`}
            sub={row.original.id}
          />
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => <TruncateCell value={row.original.description} width="max-w-md" />,
      },
    ],
    [biz],
  );

  const segments = React.useMemo<ListSegment<ProductGroup>[]>(
    () => [
      { id: "all", label: "All Product Groups" },
      { id: "active", label: "Active", match: (g) => g.active },
      { id: "archived", label: "Archived", match: (g) => !g.active },
    ],
    [],
  );

  /**
   * The whole of what `serializeProductGroup` emits (src/api/catalog-routes.ts):
   * id, name, description, active, created_at. `code` is on the TS type but the list
   * serializer does not emit it, so there is deliberately no Code filter — it would
   * match nothing.
   */
  const filterFields = React.useMemo<ListFilterField<ProductGroup>[]>(
    () => [
      { id: "name", label: "Name", group: "Identity", value: (g) => g.name },
      { id: "id", label: "Product Group Id", group: "Identity", value: (g) => g.id },
      { id: "description", label: "Description", group: "Other", value: (g) => g.description },
      { id: "active", label: "Active", type: "boolean", group: "Status", value: (g) => g.active },
      {
        id: "created_at",
        label: "Created At",
        type: "date",
        group: "Dates",
        value: (g) => g.created_at,
      },
    ],
    [],
  );

  return (
    <ListPage
      page={page}
      entity={{ singular: "Product Group", plural: "Product Groups" }}
      columns={columns}
      data={rows}
      segments={segments}
      filterFields={filterFields}
      // `item_groups` — our route/model is `product_groups`, but the saved-view entity
      // vocabulary uses a different noun for it (see LIST_VIEW_ENTITIES).
      savedViews={{ entity: "item_groups", biz }}
      createSlot={createSlot}
      importSlot={importSlot}
      searchPlaceholder="Search for ID / Name…"
      exportName="product-groups"
      persistKey={`groups:${biz}`}
      rowHref={(g) => `/businesses/${biz}/catalog/product_groups/${g.id}`}
      rowMenu={(g) => <GroupRowMenu biz={biz} id={g.id} label={g.name} group={g} />}
      defaultSort={{ id: "name", desc: false }}
      emptyState={
        <EmptyState
          icon={<Layers />}
          title="No product groups"
          description="No product groups match this view, filter or search."
        />
      }
    />
  );
}
