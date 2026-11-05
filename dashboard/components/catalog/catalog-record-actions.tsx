"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { archiveCatalogItem, restoreCatalogItem } from "@/app/actions";

type Resource = "products" | "prices" | "product_groups";

/**
 * Archive / Restore as a More-menu row, with its confirm. The engine's DELETE on
 * these resources is a soft archive; Restore PATCHes `active: true`.
 */
export function ArchiveRestoreItem({
  biz,
  resource,
  id,
  active,
  noun,
  archiveLabel = "Archive",
  archiveDescription,
  restoreDescription,
  afterArchiveHref,
}: {
  biz: string;
  resource: Resource;
  id: string;
  active: boolean;
  /** "Team plan", "price"… used in the title and the toast. */
  noun: string;
  archiveLabel?: string;
  archiveDescription: string;
  restoreDescription: string;
  /** Navigate here after archiving instead of refreshing in place. */
  afterArchiveHref?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function run() {
    const res = await (active ? archiveCatalogItem : restoreCatalogItem)(resource, biz, id);
    if (!res.ok) {
      toast.error(res.error ?? "We could not complete the action.");
      return;
    }
    const subject = noun.charAt(0).toUpperCase() + noun.slice(1);
    toast.success(active ? `${subject} ${archiveLabel.toLowerCase()}d.` : `${subject} restored.`);
    if (active && afterArchiveHref) router.push(afterArchiveHref);
    else router.refresh();
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        className={active ? "text-destructive" : undefined}
        onClick={() => setOpen(true)}
      >
        {active ? archiveLabel : "Restore"}
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={active ? `${archiveLabel} ${noun}?` : `Restore ${noun}?`}
        description={active ? archiveDescription : restoreDescription}
        confirmLabel={active ? archiveLabel : "Restore"}
        destructive={active}
        onConfirm={run}
      />
    </>
  );
}
