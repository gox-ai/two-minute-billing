"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Archive, ArchiveRestore } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { archiveCatalogItem, restoreCatalogItem } from "@/app/actions";

type CatalogResource = "products" | "prices" | "coupons" | "product_groups";

/**
 * Per-row action menu for catalog tables: Edit (delegated to the parent via
 * onEdit) + Archive / Restore with a confirm step, toast, and refresh.
 */
export function CatalogRowMenu({
  resource,
  biz,
  id,
  label,
  active,
  onEdit,
}: {
  resource: CatalogResource;
  biz: string;
  id: string;
  /** human label for confirm/toast copy (e.g. product name or coupon code) */
  label: string;
  active: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  async function runArchiveToggle() {
    const fn = active ? archiveCatalogItem : restoreCatalogItem;
    const res = await fn(resource, biz, id);
    if (res.ok) {
      toast.success(active ? `Archived ${label}` : `Restored ${label}`);
      router.refresh();
    } else {
      toast.error(res.error ?? "We could not complete the action.");
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
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil className="size-4" />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            variant={active ? "destructive" : "default"}
            onSelect={() => setConfirmOpen(true)}
          >
            {active ? <Archive className="size-4" /> : <ArchiveRestore className="size-4" />}
            {active ? "Archive" : "Restore"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={active ? `Archive ${label}?` : `Restore ${label}?`}
        description={
          active
            ? "Active lists and pickers do not show it. Existing subscriptions continue to work. You can restore it later."
            : "Active lists and pickers show it again."
        }
        confirmLabel={active ? "Archive" : "Restore"}
        destructive={active}
        onConfirm={runArchiveToggle}
      />
    </>
  );
}
