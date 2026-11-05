"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectField } from "@/components/ui/select-field";
import { MoneyInput } from "@/components/form/money-input";
import { DateTimeField } from "@/components/form/datetime-field";
import { RailButton } from "@/components/patterns/action-rail";
import { money, toMajor } from "@/lib/format";
import {
  cancelPaymentRequestAction,
  chargePaymentRequestAction,
  recordPaymentRequestPaymentAction,
  sendPaymentRequestAction,
} from "@/app/(dashboard)/businesses/[biz]/payment_requests/actions";
import type { PaymentMethod } from "@/lib/api";
import { pmLabel } from "./request-payment-dialog";

/** The API's record_payment methods. "Check" is the label; `cheque` is the stored value. */
const RECORD_METHOD_OPTIONS = [
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Check" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "other", label: "Other" },
];

interface Common {
  biz: string;
  preq: string;
  cus: string;
  /** `primary` renders a filled button for the record header; else a rail item. */
  trigger?: "primary" | "rail";
}

function Trigger({
  trigger,
  open,
  onOpen,
  danger,
  children,
}: {
  trigger: "primary" | "rail";
  open: boolean;
  onOpen: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return trigger === "primary" ? (
    <Button onClick={onOpen} aria-haspopup="dialog" aria-expanded={open}>
      {children}
    </Button>
  ) : (
    <RailButton opensDialog expanded={open} onClick={onOpen} danger={danger}>
      {children}
    </RailButton>
  );
}

function Hidden({ biz, preq, cus }: Common) {
  return (
    <>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="preq" value={preq} />
      <input type="hidden" name="cus" value={cus} />
    </>
  );
}

export function ChargeRequestButton({
  pms,
  defaultPm,
  totalMinor,
  currency,
  trigger = "rail",
  ...ids
}: Common & {
  pms: PaymentMethod[];
  /** The request's own method, else the customer's primary. */
  defaultPm: string | null;
  totalMinor: number;
  currency: string;
}) {
  const [open, setOpen] = React.useState(false);
  const first = pms.find((p) => p.id === defaultPm) ?? pms[0];
  return (
    <>
      <Trigger trigger={trigger} open={open} onOpen={() => setOpen(true)}>
        Charge
      </Trigger>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Charge the payment request</DialogTitle>
            <DialogDescription>
              We charge the total that is still due, {money(totalMinor, currency)}, as one payment.
              If the charge fails, the request stays open.
            </DialogDescription>
          </DialogHeader>
          {pms.length === 0 ? (
            <>
              <p className="m-0 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                This customer has no saved payment method. Send the request again so that the
                customer can pay in the portal.
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Close
                </Button>
              </DialogFooter>
            </>
          ) : (
            <ActionForm
              action={chargePaymentRequestAction}
              onSuccess={() => setOpen(false)}
              className="flex flex-col gap-4"
            >
              <Hidden {...ids} />
              <Field name="payment_method" label="Payment method">
                <SelectField
                  name="payment_method"
                  ariaLabel="Payment method"
                  defaultValue={first?.id ?? ""}
                  options={pms.map((p) => ({ value: p.id, label: pmLabel(p) }))}
                />
              </Field>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton>Charge {money(totalMinor, currency)}</SubmitButton>
              </DialogFooter>
            </ActionForm>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RecordRequestPaymentButton({
  totalMinor,
  currency,
  trigger = "rail",
  ...ids
}: Common & { totalMinor: number; currency: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Trigger trigger={trigger} open={open} onOpen={() => setOpen(true)}>
        Record payment
      </Trigger>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record payment</DialogTitle>
            <DialogDescription>
              Record money that you received outside a gateway, for example cash or a bank transfer.
              We apply it to the invoices in the order of the request. {money(totalMinor, currency)}{" "}
              is due.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={recordPaymentRequestPaymentAction}
            onSuccess={() => setOpen(false)}
            className="flex flex-col gap-4"
          >
            <Hidden {...ids} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="amount_minor" label="Amount" required>
                <MoneyInput
                  name="amount_minor"
                  currency={currency}
                  required
                  defaultMajor={toMajor(totalMinor, currency)}
                />
              </Field>
              <Field name="method" label="Method">
                <SelectField
                  name="method"
                  ariaLabel="Payment method"
                  placeholder="Select a method"
                  options={RECORD_METHOD_OPTIONS}
                />
              </Field>
            </div>
            <Field
              name="date"
              label="Payment date"
              help="The date when the money arrived. Leave blank to use the current time."
            >
              <DateTimeField name="date" />
            </Field>
            <Field
              name="reference"
              label="Reference"
              help="Optional. For example, a check number or a bank transaction ID."
            >
              <Input name="reference" maxLength={200} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Record payment</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SendRequestButton({
  defaultTo,
  trigger = "rail",
  ...ids
}: Common & { defaultTo: string | null }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Trigger trigger={trigger} open={open} onOpen={() => setOpen(true)}>
        Send again
      </Trigger>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send the payment request again</DialogTitle>
            <DialogDescription>
              We email the customer the invoices, the total that is still due and a link to pay it.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={sendPaymentRequestAction}
            onSuccess={() => setOpen(false)}
            className="flex flex-col gap-4"
          >
            <Hidden {...ids} />
            <Field
              name="to"
              label="Send to"
              help={defaultTo ? `Leave blank to send to ${defaultTo}.` : undefined}
            >
              <Input
                name="to"
                type="email"
                maxLength={320}
                required={!defaultTo}
                placeholder={defaultTo ?? "email@example.com"}
              />
            </Field>
            <Field name="note" label="Note" help="Optional. We add it to the email.">
              <Textarea name="note" rows={3} maxLength={2000} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Send</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CancelRequestButton({ trigger = "rail", ...ids }: Common) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Trigger trigger={trigger} open={open} onOpen={() => setOpen(true)} danger>
        Cancel request
      </Trigger>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel the payment request?</DialogTitle>
            <DialogDescription>
              The customer can no longer pay this request. The invoices stay open, and you can pay
              or request them again. You cannot undo this.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={cancelPaymentRequestAction}
            onSuccess={() => setOpen(false)}
            className="flex flex-col gap-4"
          >
            <Hidden {...ids} />
            <Field name="reason" label="Reason" help="Optional. Only your team sees it.">
              <Input name="reason" maxLength={200} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Keep the request
              </Button>
              <SubmitButton variant="destructive">Cancel request</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
