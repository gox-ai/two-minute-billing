"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EditDrawer } from "@/components/edit-drawer";
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

const INTERVALS = [
  { value: "day", label: "Per day" },
  { value: "week", label: "Per week (Monday to Sunday)" },
  { value: "month", label: "Per calendar month" },
  { value: "period", label: "Per billing period" },
];

/** The buyer adds its own hard limit. It cannot be more than the provider's limit. */
export function AddLimitButton({ currency }: { currency: string }) {
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState("");
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Add limit
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Add a spend limit"
        description="When your usage reaches the limit, new requests stop until the limit resets. Usage that was already sent is billed."
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
                  hint: "A property of your usage, for example user_id.",
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
              <SelectField name="interval" options={INTERVALS} placeholder="Select" />
            </Field>
            <Field name="amount" label={`Amount (${currency})`}>
              <Input name="amount" inputMode="decimal" className="tabular-nums" />
            </Field>
          </div>
          <div className="flex justify-end">
            <SubmitButton>Save limit</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

/** Lower (or change) the buyer's own limit, or delete it. */
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
      <Button type="button" variant="ghost" size="sm" onClick={() => setDel(true)}>
        Delete
      </Button>
      <EditDrawer open={edit} onOpenChange={setEdit} title="Change your limit">
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
          <div className="flex justify-end">
            <SubmitButton>Save limit</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        brand
        destructive
        title="Delete your limit?"
        description="Your usage is no longer stopped at this limit. Limits from your provider still apply."
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
