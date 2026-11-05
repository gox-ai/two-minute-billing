"use client";

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { ActionResult } from "@/lib/action-result";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";

/** Test mode only: start again with the same catalog and settings, and no customers. */
export function TestDataSection({
  biz,
  deleteAction,
}: {
  biz: string;
  deleteAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);

  async function confirm() {
    setLoading(true);
    try {
      const fd = new FormData();
      fd.set("biz", biz);
      const result = await deleteAction(null, fd);
      if (result.ok && result.message) toast.success(result.message);
      else if (!result.ok && result.message) toast.error(result.message);
      router.refresh();
    } finally {
      setLoading(false);
      setOpen(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Delete all customers in this test mode, and their subscriptions, invoices, payments and
        credit notes. The catalog, settings, gateways and webhook endpoints stay. Time Travel stops.
      </p>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
        disabled={loading}
      >
        {loading && <Loader2 className="size-3 animate-spin" />}
        Delete test data
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete test data?"
        description="This permanently deletes all customers in this test mode and all their subscriptions, invoices, payments and credit notes. You cannot undo this."
        confirmLabel="Delete test data"
        destructive
        onConfirm={confirm}
      />
    </div>
  );
}
