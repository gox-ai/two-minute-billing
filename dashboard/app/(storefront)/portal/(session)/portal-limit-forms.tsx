"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioField } from "@/components/ui/radio-group";
import { SelectField } from "@/components/ui/select-field";
import { toMajorInput } from "@/lib/money";
import {
  portalCreateLimitAction,
  portalDeleteLimitAction,
  portalUpdateLimitAction,
} from "./usage-controls-actions";

/**
 * The edit drawer's shape with the merchant's brand: Radix portals a dialog outside the
 * storefront's brand wrapper, so `data-brand` puts it back (as the shipping dialog does).
 */
function LimitDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        data-brand
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="border-b px-6 py-4 pr-12 text-left">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

const INTERVALS = [
  { value: "day", label: "Per day" },
  { value: "week", label: "Per week (Monday to Sunday)" },
  { value: "month", label: "Per calendar month" },
  { value: "period", label: "Per billing period" },
];

/** The buyer adds its own hard limit. It cannot be more than a limit the business set. */
export function AddLimitButton({ currency }: { currency: string }) {
  const [open, setOpen] = React.useState(false);
  // Preselected so the first option shows as selected, not only focused.
  const [scope, setScope] = React.useState("customer");
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add limit
      </Button>
      <LimitDialog
        open={open}
        onOpenChange={setOpen}
        title="Add a spend limit"
        description="When your usage reaches the limit, we stop it until the limit resets. We bill the usage that we recorded before then."
      >
        <ActionForm
          action={portalCreateLimitAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="currency" value={currency} />
          <Field name="scope" label="Limit">
            <RadioField
              name="scope"
              value={scope}
              onValueChange={setScope}
              ariaLabel="Limit"
              options={[
                { value: "customer", label: "All your usage" },
                {
                  value: "property",
                  label: "Each user, team or key",
                  hint: "Your usage can carry a property, such as a user or a key.",
                },
              ]}
            />
          </Field>
          {scope === "property" ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field name="property_key" label="Property">
                <Input name="property_key" maxLength={64} />
              </Field>
              <Field name="property_value" label="Value" help="Leave empty for each value.">
                <Input name="property_value" maxLength={255} />
              </Field>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="interval" label="Interval">
              <SelectField name="interval" options={INTERVALS} placeholder="Select an interval" />
            </Field>
            <Field name="amount" label={`Amount (${currency})`}>
              <Input name="amount" inputMode="decimal" className="tabular-nums" />
            </Field>
          </div>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Save limit</SubmitButton>
          </div>
        </ActionForm>
      </LimitDialog>
    </>
  );
}

/** Change the buyer's own limit, or delete it. */
export function OwnLimitActions({
  id,
  amountMinor,
  currency,
}: {
  id: string;
  amountMinor: number;
  currency: string;
}) {
  const router = useRouter();
  const [edit, setEdit] = React.useState(false);
  const [del, setDel] = React.useState(false);
  return (
    <div className="flex items-center gap-1">
      <Button type="button" variant="ghost" size="sm" onClick={() => setEdit(true)}>
        Edit
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setDel(true)}
      >
        Delete
      </Button>
      <LimitDialog
        open={edit}
        onOpenChange={setEdit}
        title="Change your limit"
        description="Your limit cannot be more than a limit that the business set for the same usage and interval."
      >
        <ActionForm
          action={portalUpdateLimitAction}
          onSuccess={() => setEdit(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="currency" value={currency} />
          <Field name="amount" label={`Amount (${currency})`}>
            <Input
              name="amount"
              inputMode="decimal"
              defaultValue={toMajorInput(amountMinor, currency)}
              className="tabular-nums"
            />
          </Field>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => setEdit(false)}>
              Cancel
            </Button>
            <SubmitButton>Save limit</SubmitButton>
          </div>
        </ActionForm>
      </LimitDialog>
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        brand
        destructive
        title="Delete your limit?"
        description="We no longer stop your usage at this limit. Limits that the business set still apply."
        confirmLabel="Delete"
        onConfirm={async () => {
          const fd = new FormData();
          fd.set("id", id);
          const res = await portalDeleteLimitAction(null, fd);
          if (!res.ok) return void toast.error(res.message ?? "We could not delete the limit.");
          toast.success(res.message ?? "Limit deleted.");
          router.refresh();
        }}
      />
    </div>
  );
}
