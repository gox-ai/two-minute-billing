"use client";

import * as React from "react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { invoiceOpAction } from "@/app/actions";

/**
 * Void with a reason, for a business that requires one (`required_reasons.void_invoice`).
 * Posts `void_reason_code` through the same `invoiceOpAction` as the plain void button.
 */
export function VoidInvoiceDialog({
  biz,
  invoice,
  warning,
  confirmLabel = "Void",
}: {
  biz: string;
  invoice: string;
  /** The in-flight payment warning the plain confirm shows. */
  warning?: React.ReactNode;
  confirmLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Void invoice
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Void invoice?</DialogTitle>
            <DialogDescription asChild>
              <div>
                {warning}
                <span className="block">
                  This reverses revenue, tax and AR and restores any applied credit. You cannot undo
                  this.
                </span>
              </div>
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={invoiceOpAction}
            onSuccess={() => setOpen(false)}
            className="space-y-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="inv" value={invoice} />
            <input type="hidden" name="op" value="void" />
            <Field
              name="void_reason_code"
              label="Reason"
              required
              help="This business requires a reason for each void. We store it on the invoice."
            >
              <Input name="void_reason_code" maxLength={100} required />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton variant="destructive">{confirmLabel}</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
