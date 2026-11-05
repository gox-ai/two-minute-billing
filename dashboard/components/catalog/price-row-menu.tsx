"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Eye, Pencil, Archive, ArchiveRestore } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { archiveCatalogItem, restoreCatalogItem } from "@/app/actions";
import type { Price } from "@/lib/api";

/** Row menu for a price row in the pricing matrix: view details, edit (full page), archive/restore. */
export function PriceRowMenu({ biz, price }: { biz: string; price: Price; returnTo?: string }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const active = price.active !== false;
  const base = `/businesses/${biz}/catalog/products/${price.product}/prices/${price.id}`;

  async function runArchiveToggle() {
    const fn = active ? archiveCatalogItem : restoreCatalogItem;
    const res = await fn("prices", biz, price.id);
    if (res.ok) {
      toast.success(active ? "Price archived" : "Price restored");
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
          aria-label="Price actions"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => router.push(base)}>
            <Eye className="size-4" /> View details
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push(`${base}/edit`)}>
            <Pencil className="size-4" /> Edit
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
        title={active ? "Archive price?" : "Restore price?"}
        description={
          active
            ? "Active price lists do not show it. Live subscriptions keep their snapshotted price. You can restore it later."
            : "Active price lists show it again."
        }
        confirmLabel={active ? "Archive" : "Restore"}
        destructive={active}
        onConfirm={runArchiveToggle}
      />
    </>
  );
}
