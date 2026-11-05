"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Trash2, Package, Puzzle, Receipt, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { archiveCatalogItem } from "@/app/actions";
import { ProductGroupDialog } from "@/components/catalog/product-group-dialog";
import type { ProductGroup } from "@/lib/api";

/**
 * Per-row action menu for the Product Groups table: a References group (jump
 * to the associated plans / add-ons / charges) and a Quick Actions group (edit,
 * delete, create).
 */
export function GroupRowMenu({
  biz,
  id,
  label,
  group,
}: {
  biz: string;
  id: string;
  label: string;
  /** Present → Edit opens the dialog in place; absent → the edit page. */
  group?: ProductGroup;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);

  const catalog = `/businesses/${biz}/catalog`;
  const show = (page: string) => () => router.push(`${catalog}/${page}?group=${id}`);
  const create = (page: string) => () => router.push(`${catalog}/${page}/new?group=${id}`);

  async function runDelete() {
    // Our DELETE archives (soft-delete): products filed under the group are kept.
    const res = await archiveCatalogItem("product_groups", biz, id);
    if (res.ok) {
      toast.success(`Deleted ${label}`);
      router.refresh();
    } else {
      toast.error(res.error ?? "We could not delete the product group.");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Row actions"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            References
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={show("plans")}>
            <Package className="size-4" />
            View associated Plans
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={show("addons")}>
            <Puzzle className="size-4" />
            View associated Add-ons
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={show("charges")}>
            <Receipt className="size-4" />
            View associated Charges
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Quick Actions
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() =>
              group ? setEditOpen(true) : router.push(`${catalog}/product_groups/${id}/edit`)
            }
          >
            <Pencil className="size-4" />
            Edit Product Group
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
            <Trash2 className="size-4" />
            Delete Product Group
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={create("plans")}>
            <Plus className="size-4" />
            Create Plan
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={create("addons")}>
            <Plus className="size-4" />
            Create Add-on
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={create("charges")}>
            <Plus className="size-4" />
            Create Charge
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {group ? (
        <ProductGroupDialog biz={biz} group={group} open={editOpen} onOpenChange={setEditOpen} />
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${label}?`}
        description="We remove the group from your catalog. We keep its plans, add-ons and charges. You can move them to a different group."
        confirmLabel="Delete"
        destructive
        onConfirm={runDelete}
      />
    </>
  );
}
