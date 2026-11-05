"use client";

import * as React from "react";
import { useActionState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/action-result";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useFormStatus } from "react-dom";

function SeedButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="default" size="sm" disabled={pending} className="gap-1.5">
      {pending && <Loader2 className="size-3 animate-spin" />}
      Seed sample data
    </Button>
  );
}

interface SampleDataSectionProps {
  biz: string;
  seedAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
  removeAction: (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
}

export function SampleDataSection({ biz, seedAction, removeAction }: SampleDataSectionProps) {
  const router = useRouter();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteLoading, setDeleteLoading] = React.useState(false);

  const handleSeed = React.useCallback(
    async (prev: ActionResult | null, formData: FormData): Promise<ActionResult> => {
      const result = await seedAction(prev, formData);
      if (result.ok && result.message) toast.success(result.message);
      else if (!result.ok && result.message) toast.error(result.message);
      router.refresh();
      return result;
    },
    [seedAction, router],
  );

  const [, seedFormAction] = useActionState<ActionResult | null, FormData>(handleSeed, null);

  async function handleRemoveConfirm() {
    setDeleteLoading(true);
    try {
      const fd = new FormData();
      fd.set("biz", biz);
      const result = await removeAction(null, fd);
      if (result.ok && result.message) toast.success(result.message);
      else if (!result.ok && result.message) toast.error(result.message);
      router.refresh();
    } finally {
      setDeleteLoading(false);
      setDeleteOpen(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Add a small set of demo records to this test business: 2 products, 2 prices, 1 coupon and 1
        customer. Each record has the tag{" "}
        <span className="font-mono text-xs">metadata.sample=true</span>. Seeding is idempotent. It
        first deletes all existing sample records. It does not create subscriptions or invoices.
      </p>
      <div className="flex flex-wrap gap-2">
        <form action={seedFormAction}>
          <input type="hidden" name="biz" value={biz} />
          <SeedButton />
        </form>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
          disabled={deleteLoading}
        >
          {deleteLoading && <Loader2 className="size-3 animate-spin" />}
          Delete sample data
        </Button>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete sample data?"
        description="This permanently deletes all records tagged metadata.sample=true on this test business: products, prices, coupons and customers. You cannot undo this."
        confirmLabel="Delete sample data"
        destructive
        onConfirm={handleRemoveConfirm}
      />
    </div>
  );
}
