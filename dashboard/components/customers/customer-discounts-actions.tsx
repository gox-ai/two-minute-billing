"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectOption } from "@/components/ui/select-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  addCustomerCouponAction,
  removeCustomerCouponAction,
} from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/actions";

/** Apply a coupon from the catalog to the customer (`POST …/customers/:cus/discounts`). */
export function AddCustomerCouponDialog({
  biz,
  cus,
  options,
}: {
  biz: string;
  cus: string;
  /** Active coupons not already on the customer; value is the coupon code. */
  options: SelectOption[];
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={options.length === 0}>
          <Plus aria-hidden className="size-4" />
          Add coupon
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add coupon</DialogTitle>
          <DialogDescription>
            The coupon discounts the next invoices of this customer. Each invoice that it discounts
            counts toward its duration.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={addCustomerCouponAction}
          onSuccess={() => setOpen(false)}
          resetOnSuccess
          className="space-y-3"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <Field name="coupon" label="Coupon" required>
            <SelectField name="coupon" options={options} placeholder="Select a coupon" required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <SubmitButton>Add coupon</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveCustomerCouponButton({
  biz,
  cus,
  discount,
  code,
}: {
  biz: string;
  cus: string;
  discount: string;
  code: string;
}) {
  const [open, setOpen] = React.useState(false);
  async function confirm() {
    const fd = new FormData();
    fd.set("biz", biz);
    fd.set("cus", cus);
    fd.set("discount", discount);
    const res = await removeCustomerCouponAction(null, fd);
    if (res.ok) toast.success(res.message ?? "Coupon removed.");
    else toast.error(res.message ?? "We could not remove the coupon.");
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Remove coupon ${code}`}
        onClick={() => setOpen(true)}
      >
        <X className="size-4" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Remove coupon?"
        description={`Later invoices do not get the ${code} discount. Invoices that we already created keep it.`}
        confirmLabel="Remove coupon"
        destructive
        onConfirm={confirm}
      />
    </>
  );
}
