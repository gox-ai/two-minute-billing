"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, Archive, ArchiveRestore, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { archiveCatalogItem, restoreCatalogItem } from "@/app/actions";

/**
 * Row menu for a plan/addon/charge: References group (jump to associated
 * subscriptions) + Quick Actions (edit on a full page, archive/restore).
 */
export function ProductRowMenu({
  biz,
  id,
  label,
  active,
}: {
  biz: string;
  id: string;
  label: string;
  active: boolean;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  async function runArchiveToggle() {
    const fn = active ? archiveCatalogItem : restoreCatalogItem;
    const res = await fn("products", biz, id);
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
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            References
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => router.push(`/businesses/${biz}/subscriptions?plan=${id}`)}
          >
            <Users className="size-4" />
            View associated Subscriptions
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Quick Actions
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => router.push(`/businesses/${biz}/catalog/products/${id}/edit`)}
          >
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
