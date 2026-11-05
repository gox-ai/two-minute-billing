"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  addUsageKeyAction,
  removeUsageKeyAction,
} from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/actions";

export function AddUsageKeyDialog({ biz, cus }: { biz: string; cus: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus aria-hidden className="size-4" />
          Add usage key
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add usage key</DialogTitle>
          <DialogDescription>
            Events that were sent with this key before are matched to this customer. A key can
            belong to one customer only.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={addUsageKeyAction}
          onSuccess={() => setOpen(false)}
          resetOnSuccess
          className="space-y-3"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <Field name="key" label="Usage key" required>
            <Input name="key" required maxLength={255} className="font-mono" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Add usage key</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveUsageKeyButton({
  biz,
  cus,
  usageKey,
}: {
  biz: string;
  cus: string;
  usageKey: string;
}) {
  const [open, setOpen] = React.useState(false);
  async function confirm() {
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("cus", cus);
    fd.set("key", usageKey);
    const res = await removeUsageKeyAction(null, fd);
    if (res.ok) toast.success(res.message ?? "Usage key removed.");
    else toast.error(res.message ?? "We could not remove the usage key.");
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove usage key ${usageKey}`}
        onClick={() => setOpen(true)}
      >
        <X className="size-4" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove usage key?"
        description={`New events with the key ${usageKey} will be unmatched. Events that we already matched stay with this customer.`}
        confirmLabel="Remove usage key"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}
