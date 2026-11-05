"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, Eye, Pencil, Copy, Archive, ArchiveRestore } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { archiveCatalogItem, restoreCatalogItem } from "@/app/actions";

export function CouponRowMenu({
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
  const base = `/businesses/${biz}/catalog/coupons`;

  async function run() {
    const fn = active ? archiveCatalogItem : restoreCatalogItem;
    const res = await fn("coupons", biz, id);
    if (res.ok) {
      toast.success(active ? `${label} archived.` : `${label} restored.`);
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
          <DropdownMenuItem onSelect={() => router.push(`${base}/${id}`)}>
            <Eye className="size-4" /> View details
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push(`${base}/${id}/edit`)}>
            <Pencil className="size-4" /> Edit Coupon
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push(`${base}/new?clone=${id}`)}>
            <Copy className="size-4" /> Clone Coupon
          </DropdownMenuItem>
          <DropdownMenuItem
            variant={active ? "destructive" : "default"}
            onSelect={() => setConfirmOpen(true)}
          >
            {active ? <Archive className="size-4" /> : <ArchiveRestore className="size-4" />}
            {active ? "Archive Coupon" : "Restore Coupon"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={active ? `Archive ${label}?` : `Restore ${label}?`}
        description={
          active
            ? "Customers cannot redeem it. Existing redemptions do not change. You can restore it later."
            : "Active coupon lists show it again."
        }
        confirmLabel={active ? "Archive" : "Restore"}
        destructive={active}
        onConfirm={run}
      />
    </>
  );
}
