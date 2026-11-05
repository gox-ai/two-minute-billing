"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createProductGroupAction, editProductGroupAction } from "@/app/actions";
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
import { LockedField, slugError, suggestSlug, useFormModel } from "@/components/catalog/form-kit";
import type { ProductGroup } from "@/lib/api";
import type { ActionResult } from "@/lib/action-result";

/**
 * Product group create / edit body. ID is optional on create (blank derives one)
 * and read-only on edit — products point at it.
 */
export function ProductGroupForm({
  biz,
  group,
  onDone,
  cancelHref,
}: {
  biz: string;
  group?: ProductGroup;
  /** Gets the result on save; nothing on Cancel. */
  onDone: (result?: ActionResult) => void;
  /** Page use: Cancel is a link. Dialog use: Cancel closes. */
  cancelHref?: string;
}) {
  const formRef = React.useRef<HTMLFormElement>(null);
  const [v, set] = useFormModel(
    { name: group?.name ?? "", code: "", description: group?.description ?? "" },
    formRef,
  );
  const codeError = group ? undefined : slugError(v.code, suggestSlug(v.name) || "core-plans");
  return (
    <ActionForm
      action={group ? editProductGroupAction : createProductGroupAction}
      onSuccess={onDone}
      formRef={formRef}
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="biz" value={biz} />
      {group ? <input type="hidden" name="grp" value={group.id} /> : null}
      <Field name="name" label="Product group name" required>
        <Input
          name="name"
          value={v.name}
          onChange={(e) => set("name", e.target.value)}
          required
          maxLength={200}
        />
      </Field>
      {group ? (
        <LockedField
          label="Product group ID"
          value={group.id}
          mono
          reason="You cannot change it. Products refer to it."
        />
      ) : (
        <Field
          name="code"
          label="Product group ID"
          error={codeError}
          help="If you leave it empty, we generate one."
        >
          <Input
            name="code"
            value={v.code}
            onChange={(e) => set("code", e.target.value)}
            placeholder={suggestSlug(v.name) || "core-plans"}
            maxLength={100}
            className="font-mono"
          />
        </Field>
      )}
      <Field name="description" label="Description">
        <Textarea
          name="description"
          value={v.description}
          onChange={(e) => set("description", e.target.value)}
          rows={3}
          maxLength={2000}
        />
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        {cancelHref ? (
          <Button asChild variant="outline">
            <Link href={cancelHref}>Cancel</Link>
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => onDone()}>
            Cancel
          </Button>
        )}
        <SubmitButton>{group ? "Save changes" : "Create group"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

/** The same form in a dialog — with a trigger button, or controlled by the caller. */
export function ProductGroupDialog({
  biz,
  group,
  productCount,
  triggerLabel,
  open: openProp,
  onOpenChange,
}: {
  biz: string;
  group?: ProductGroup;
  productCount?: number;
  triggerLabel?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const router = useRouter();
  const [own, setOwn] = React.useState(false);
  const open = openProp ?? own;
  const setOpen = onOpenChange ?? setOwn;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {triggerLabel ? (
        <DialogTrigger asChild>
          <Button>{triggerLabel}</Button>
        </DialogTrigger>
      ) : null}
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{group ? "Edit product group" : "Create product group"}</DialogTitle>
          <DialogDescription>
            {group
              ? `${group.name}${productCount != null ? ` · ${productCount} product${productCount === 1 ? "" : "s"}` : ""}`
              : "Group plans, addons and charges for reporting and for the catalog lists."}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ProductGroupForm
            biz={biz}
            group={group}
            onDone={(r) => {
              setOpen(false);
              if (r?.redirectTo) router.push(r.redirectTo);
              else router.refresh();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
