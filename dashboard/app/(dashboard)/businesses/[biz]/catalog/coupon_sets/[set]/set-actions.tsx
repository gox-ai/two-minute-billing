"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  addCouponSetCodesAction,
  deleteUnusedCodesAction,
  renameCouponSetAction,
} from "@/app/(dashboard)/businesses/[biz]/catalog/coupon_sets/actions";

/** Header primary: add explicit codes, or generate a count. */
export function AddCodesDialog({ biz, set }: { biz: string; set: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden className="size-4" />
          Add codes
        </Button>
      </DialogTrigger>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add codes</DialogTitle>
          <DialogDescription>
            Paste explicit codes, one on each line or separated by commas. To generate codes, leave
            the box empty and enter a count.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={addCouponSetCodesAction}
          onSuccess={() => setOpen(false)}
          resetOnSuccess
          className="space-y-3"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="set" value={set} />
          <Field name="codes" label="Explicit codes">
            <Textarea
              name="codes"
              rows={5}
              placeholder={"SPRING-001\nSPRING-002\nSPRING-003"}
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex gap-2">
            <Field name="count" label="Or number to generate" className="flex-1">
              <Input
                name="count"
                type="number"
                min={1}
                max={10000}
                placeholder="100"
                className="tabular-nums"
              />
            </Field>
            <Field name="code_prefix" label="Code prefix" className="flex-1">
              <Input
                name="code_prefix"
                maxLength={20}
                placeholder="Optional"
                className="font-mono"
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Add codes</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** Danger zone: delete every code not yet redeemed. */
export function DeleteUnusedCodesButton({
  biz,
  set,
  unusedCount,
}: {
  biz: string;
  set: string;
  unusedCount: number;
}) {
  const [open, setOpen] = React.useState(false);

  async function confirm() {
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("set", set);
    const res = await deleteUnusedCodesAction(null, fd);
    if (res.ok) toast.success(res.message ?? "Unused codes deleted");
    else toast.error(res.message ?? "We could not delete the unused codes.");
  }

  return (
    <>
      <Button
        variant="outline"
        className="shrink-0 text-destructive hover:text-destructive"
        disabled={unusedCount === 0}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden className="size-4" />
        Delete unused codes
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete all unused codes?"
        description={`This permanently deletes ${unusedCount} unredeemed code(s) from this set. We keep redeemed and archived codes. You cannot undo this.`}
        confirmLabel="Delete unused codes"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}

/** More-menu item: rename the set. */
export function RenameCouponSetDialog({
  biz,
  set,
  name,
}: {
  biz: string;
  set: string;
  name: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button">Rename set</button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Rename coupon set</DialogTitle>
          <DialogDescription>The codes and their parent coupon do not change.</DialogDescription>
        </DialogHeader>
        <ActionForm
          action={renameCouponSetAction}
          onSuccess={() => setOpen(false)}
          className="space-y-3"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="set" value={set} />
          <Field name="name" label="Name" required>
            <Input name="name" defaultValue={name} maxLength={200} required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Rename</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
