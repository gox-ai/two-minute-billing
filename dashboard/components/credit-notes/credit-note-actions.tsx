"use client";

import * as React from "react";
import { offlineMethodOptions } from "@/lib/offline-methods";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { DateTimeField } from "@/components/form/datetime-field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MoneyInput } from "@/components/form/money-input";
import { money, toMajor, toMajorInput } from "@/lib/format";
import {
  refundCreditNoteAction,
  recordOfflineRefundAction,
  voidCreditNoteAction,
} from "@/app/(dashboard)/businesses/[biz]/credit_notes/actions";
import type { CreditNoteKind } from "@/lib/api/credit-notes";
import { SelectField } from "@/components/ui/select-field";
import { GatewayBalanceNotice } from "@/components/gateways/gateway-balance-notice";

/** Where a trigger sits: the More menu (default), the header's primary, or a Danger zone. */
type Trigger = "menu" | "primary" | "danger";
const triggerProps = (t: Trigger) =>
  t === "primary"
    ? ({ variant: "default" } as const)
    : t === "danger"
      ? ({ variant: "destructive", size: "sm" } as const)
      : ({ variant: "outline", size: "sm", className: "h-auto p-1 text-sm" } as const);

/**
 * Refund action for a refundable credit note — the GATEWAY path (the sibling
 * `RecordOfflineRefundButton` is the no-gateway one). Opens a dialog with an
 * optional amount (blank = refund the full remaining available) — the backend
 * supports a partial `amount_minor`. Only rendered when there is unrefunded
 * credit left.
 *
 * ⚠ This was labelled “Refund to card” until 2026-08-24, which was wrong on every
 * RazorPay business — `refundCreditNote` pays out via `payOutRefundsPayable` →
 * `refundPayment` → the provider's refund on the INVOICE'S FUNDING PAYMENTS, and
 * RazorPay returns money to the source instrument (emandate/UPI/netbanking ⇒ the
 * customer's bank account). The label sent operators to the offline dialog
 * looking for a bank refund that this button already does.
 */
export function RefundCreditNoteButton({
  biz,
  cn,
  availableMinor,
  currency,
  trigger = "menu",
  label,
  reasonRequired = false,
  gatewayAccount = null,
}: {
  biz: string;
  cn: string;
  availableMinor: number;
  currency: string;
  trigger?: Trigger;
  label?: string;
  /** `required_reasons.refund`: the API refuses a refund without a reason. */
  reasonRequired?: boolean;
  /** The one gateway account the payout goes through; its balance shows in the dialog. */
  gatewayAccount?: { id: string; name: string } | null;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button {...triggerProps(trigger)} onClick={() => setOpen(true)}>
        {label ?? "Refund via gateway"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refund credit note</DialogTitle>
            <DialogDescription>
              Sends the credit back through the payment gateway to the payment method that paid the
              invoice. For a card, the money goes to the card. For a bank mandate, UPI or netbanking
              payment, the money goes to the customer&rsquo;s bank account. The amount starts at the
              full remaining {money(availableMinor, currency)}.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={refundCreditNoteAction}
            onSuccess={() => setOpen(false)}
            className="space-y-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="cn" value={cn} />
            {/* So the action can report a PARTIAL payout in real money. The gateway pays
                only what it can still reverse on this note's invoice, so a refund can
                succeed having sent less than asked. */}
            <input type="hidden" name="currency" value={currency} />
            {gatewayAccount ? (
              <GatewayBalanceNotice
                biz={biz}
                account={gatewayAccount}
                currency={currency}
                refundMinor={availableMinor}
              />
            ) : null}
            <Field
              name="amount_minor"
              label="Amount"
              help={`Available to refund: ${money(availableMinor, currency)}. Enter a lower amount for a partial refund.`}
            >
              {/* MAJOR units, prefilled with the full available credit. `MoneyInput`
                  posts integer minor under `amount_minor`, so `refundCreditNoteAction`
                  is untouched. */}
              <MoneyInput
                name="amount_minor"
                currency={currency}
                max={toMajor(availableMinor, currency)}
                defaultMajor={toMajorInput(availableMinor, currency)}
              />
            </Field>
            {/* The route already accepted `reason`; it was simply never exposed. */}
            <RefundReasonField required={reasonRequired} />
            {/* Distinct from `reason`: this lands on the credit note's Comments
                timeline, not on the refund record. Posted best-effort after the
                refund succeeds — see postDialogComment. */}
            <Field
              name="comment"
              label="Comment"
              help="Optional. We add this text to the Comments timeline."
            >
              <Input name="comment" maxLength={500} placeholder="optional" />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Issue refund</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Record an offline refund — money already returned to the customer outside any
 * gateway (cash / check / bank transfer). Books the refund against the CN's
 * available credit without a provider call.
 */
export function RecordOfflineRefundButton({
  biz,
  cn,
  availableMinor,
  currency,
  trigger = "menu",
  label,
  reasonRequired = false,
}: {
  biz: string;
  cn: string;
  availableMinor: number;
  currency: string;
  trigger?: Trigger;
  label?: string;
  /** `required_reasons.refund`: the API refuses a refund without a reason. */
  reasonRequired?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button {...triggerProps(trigger)} onClick={() => setOpen(true)}>
        {label ?? "Record an offline refund"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record an offline refund</DialogTitle>
            <DialogDescription>
              Record a complete or partial refund that you made outside a payment gateway, for
              example by cash, check or bank transfer. The amount starts at the full remaining{" "}
              {money(availableMinor, currency)}.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={recordOfflineRefundAction}
            onSuccess={() => setOpen(false)}
            className="space-y-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="cn" value={cn} />
            <Field
              name="amount_minor"
              label="Amount"
              help={`Available to refund: ${money(availableMinor, currency)}. Enter a lower amount for a partial refund.`}
            >
              {/* MAJOR units, prefilled with the full available credit. `MoneyInput`
                  posts integer minor under `amount_minor`, so
                  `recordOfflineRefundAction` is untouched. */}
              <MoneyInput
                name="amount_minor"
                currency={currency}
                max={toMajor(availableMinor, currency)}
                defaultMajor={toMajorInput(availableMinor, currency)}
              />
            </Field>
            <Field name="method" label="Refund method">
              <SelectField
                name="method"
                defaultValue="cash"
                ariaLabel="Refund method"
                options={offlineMethodOptions()}
              />
            </Field>
            <Field
              name="date"
              label="Refund date"
              help="The date when you returned the money. Leave blank to use the current time."
            >
              <DateTimeField name="date" />
            </Field>
            <Field
              name="reference"
              label="Reference number"
              help="Optional. For example, a check number or a bank transaction ID."
            >
              <Input name="reference" placeholder="optional" />
            </Field>
            {/* The route already accepted `reason` (src/api/credit-note-routes.ts);
                it was simply never exposed here, unlike the gateway refund dialog above. */}
            <RefundReasonField required={reasonRequired} />
            {/* The Comments timeline, not the refund record. Best-effort post after
                the refund succeeds. */}
            <Field
              name="comment"
              label="Comment"
              help="Optional. We add this text to the Comments timeline."
            >
              <Input name="comment" maxLength={500} placeholder="optional" />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Record refund</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Void action. Reverses the credit note's ledger. An adjustment void reopens the
 * invoice it reduced — the confirm copy warns about that. Void is forbidden by
 * the backend once any credit was refunded (or, for refundable, allocated); the
 * caller only renders this when those guards are clear.
 */
export function VoidCreditNoteButton({
  biz,
  cn,
  kind,
  trigger = "menu",
  label,
}: {
  biz: string;
  cn: string;
  kind: CreditNoteKind;
  trigger?: Trigger;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button {...triggerProps(trigger)} onClick={() => setOpen(true)}>
        {label ?? "Void credit note"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Void this credit note?"
        description={
          kind === "adjustment"
            ? "Reverses the credit note’s ledger entries and REOPENS the invoice that it reduced. The balance of that invoice becomes outstanding again. You cannot undo this."
            : "Reverses the credit note’s ledger entries and removes the refundable credit that it gave. You cannot undo this."
        }
        confirmLabel="Void"
        destructive
        onConfirm={() => triggerRef.current?.click()}
      />
      {/* Hidden form driven by the confirm dialog; ActionForm handles toast + refresh. */}
      <ActionForm action={voidCreditNoteAction} className="hidden" onSuccess={() => setOpen(false)}>
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="cn" value={cn} />
        <button ref={triggerRef} type="submit" aria-hidden tabIndex={-1} />
      </ActionForm>
    </>
  );
}

/** The refund's `reason`; required when the business says so (`required_reasons.refund`). */
function RefundReasonField({ required }: { required: boolean }) {
  return (
    <Field
      name="reason"
      label="Reason"
      required={required}
      help={
        required
          ? "This business requires a reason for each refund. The refund record shows this text."
          : "Optional. The refund record shows this text."
      }
    >
      <Input
        name="reason"
        maxLength={500}
        required={required}
        placeholder={required ? undefined : "optional"}
      />
    </Field>
  );
}
