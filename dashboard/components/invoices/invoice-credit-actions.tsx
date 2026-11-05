"use client";

import * as React from "react";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { DateTimeField } from "@/components/form/datetime-field";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/form/money-input";
import { SelectField } from "@/components/ui/select-field";
import { RadioField } from "@/components/ui/radio-group";
import { GatewayBalanceNotice } from "@/components/gateways/gateway-balance-notice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money, toMajor, toMajorInput } from "@/lib/format";
import { offlineMethodOptions } from "@/lib/offline-methods";
import { creditReasonOptions } from "@/lib/credit-reason-codes";
import { recordOfflinePaymentAction } from "@/app/actions";
import {
  createInvoiceCreditNoteAction,
  refundInvoiceAction,
  recordInvoiceOfflineRefundAction,
} from "@/app/(dashboard)/businesses/[biz]/credit_notes/actions";

/**
 * The invoice's "Payment and Credit Actions" — three dialogs: Create a Credit note ·
 * Record an offline refund · Issue a refund.
 *
 * ── WHY DIALOGS AND NOT THE TAKEOVER ──────────────────────────────────────────
 * We already had the line-by-line credit-note takeover, and it was the ONLY way in.
 * Crediting or refunding a whole invoice — the common case — therefore cost a page
 * load and one input per line, including remembering to credit the tax line or the
 * refund silently came out tax-exclusive. These dialogs ask for one amount and hide
 * the line editor behind "Advanced ›": one amount, allocated
 * across the invoice's lines server-side (`lib/credit-allocation.ts`), with the
 * takeover still one click away for line-level control.
 *
 * Every field here posts to a real route — `POST /credit_notes`, `/:cn/refund`,
 * `/:cn/record_refund`. The two refund dialogs are composites (credit note, then pay
 * it out), which is why they live on one server action each rather than in the form.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────
 * "Chargeback" is not a refund method here. `OFFLINE_REFUND_METHODS` in the engine is
 * `cash | check | bank_transfer | other`, and the route enforces it as a zod enum — so
 * offering it would 400 on submit. Omitted rather than rendered dead (CLAUDE.md); we
 * carry `chargeback` as a credit-note *reason* instead, which is arguably where it
 * belongs.
 */

/** Shared amount field: major units in, integer minor out under `amount_minor`. */
function AmountField({
  currency,
  maxMinor,
  help,
}: {
  currency: string;
  maxMinor: number;
  help: string;
}) {
  return (
    <Field name="amount_minor" label="Amount" help={help}>
      <MoneyInput
        name="amount_minor"
        currency={currency}
        max={toMajor(maxMinor, currency)}
        defaultMajor={toMajorInput(maxMinor, currency)}
      />
    </Field>
  );
}

/** Which reasons this business requires (`billing_rules_config.required_reasons`). */
export interface RequiredReasons {
  /** The credit note's reason code (`create_credit_note`). */
  code?: boolean;
  /** The refund's reason, posted as `reason` (`refund`). */
  note?: boolean;
}

function ReasonFields({ required = {} }: { required?: RequiredReasons }) {
  return (
    <>
      <Field name="reason_code" label="Reason code" required={required.code}>
        <SelectField name="reason_code" ariaLabel="Reason code" options={creditReasonOptions()} />
      </Field>
      {required.note ? (
        <Field
          name="reason"
          label="Reason"
          required
          help="This business requires a reason for each refund. We store this text on the credit note and the refund."
        >
          <Input name="reason" maxLength={500} required />
        </Field>
      ) : (
        <Field name="reason" label="Note" help="Optional. We store this text on the credit note.">
          <Input name="reason" maxLength={500} placeholder="optional" />
        </Field>
      )}
      {/* Goes to the Comments timeline, not the record. */}
      <Field
        name="comment"
        label="Comment"
        help="Optional. We add this text to the Comments timeline."
      >
        <Input name="comment" maxLength={500} placeholder="optional" />
      </Field>
    </>
  );
}

/**
 * "Create a Credit note — Apply to the entire Invoice amount or edit for custom price."
 * The `Create Credit Note to` select maps 1:1 onto our `kind`; its wording names the
 * outcome instead of the type ("Adjust the amount due" / "Provide refundable credits").
 */
export function CreateCreditNoteDialog({
  biz,
  invoice,
  creditableMinor,
  currency,
  advancedHref,
  defaultKind,
  requiredReasons,
}: {
  biz: string;
  invoice: string;
  creditableMinor: number;
  currency: string;
  advancedHref: string;
  /** Resolved from the invoice: a paid invoice can only be credited refundably. */
  defaultKind: "adjustment" | "refundable";
  requiredReasons?: RequiredReasons;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="link"
        size="sm"
        className="h-auto justify-start p-1 text-sm"
        onClick={() => setOpen(true)}
      >
        Create a credit note
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a credit note</DialogTitle>
            <DialogDescription>
              Credit the whole invoice or a smaller amount. We spread a smaller amount across the
              lines in proportion. {money(creditableMinor, currency)} is still creditable.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={createInvoiceCreditNoteAction}
            onSuccess={() => setOpen(false)}
            className="space-y-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="invoice" value={invoice} />
            <Field name="kind" label="This credit note should">
              <SelectField
                name="kind"
                defaultValue={defaultKind}
                ariaLabel="What this credit note should do"
                options={[
                  { value: "adjustment", label: "Adjust the amount due" },
                  { value: "refundable", label: "Provide refundable credits" },
                ]}
              />
            </Field>
            <AmountField
              currency={currency}
              maxMinor={creditableMinor}
              help={`Creditable: ${money(creditableMinor, currency)}. Lower it to credit part of the invoice.`}
            />
            <ReasonFields required={requiredReasons} />
            <DialogFooter className="items-center sm:justify-between">
              <a href={advancedHref} className="text-sm text-primary hover:underline">
                Advanced: edit line items ›
              </a>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <SubmitButton>Create credit note</SubmitButton>
              </div>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Issue a refund — a complete refund, or only a specific amount. */
export function IssueRefundDialog({
  biz,
  invoice,
  refundableMinor,
  currency,
  requiredReasons,
  gatewayAccount = null,
}: {
  biz: string;
  invoice: string;
  refundableMinor: number;
  currency: string;
  requiredReasons?: RequiredReasons;
  /** The one gateway account the refund goes through; its balance shows in the dialog. */
  gatewayAccount?: { id: string; name: string } | null;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="link"
        size="sm"
        className="h-auto justify-start p-1 text-sm"
        onClick={() => setOpen(true)}
      >
        Issue a refund
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue a refund</DialogTitle>
            <DialogDescription>
              We return the money through the payment gateway to the method that paid this invoice.
              This can be a card, or the bank account behind a mandate, UPI or netbanking payment.
              We create a refundable credit note for the amount and pay it out. If the payout fails,
              the credit note stays. You can then retry the refund from the credit note. We do not
              credit twice.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={refundInvoiceAction}
            onSuccess={() => setOpen(false)}
            className="space-y-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="invoice" value={invoice} />
            {gatewayAccount ? (
              <GatewayBalanceNotice
                biz={biz}
                account={gatewayAccount}
                currency={currency}
                refundMinor={refundableMinor}
              />
            ) : null}
            <AmountField
              currency={currency}
              maxMinor={refundableMinor}
              help={`Up to ${money(refundableMinor, currency)} is creditable. You can refund only the cash that we collected. If the card paid less, we show the exact amount.`}
            />
            <ReasonFields required={requiredReasons} />
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

/** Record a complete or partial offline refund already made. */
export function RecordInvoiceOfflineRefundDialog({
  biz,
  invoice,
  refundableMinor,
  currency,
  requiredReasons,
}: {
  biz: string;
  invoice: string;
  refundableMinor: number;
  currency: string;
  requiredReasons?: RequiredReasons;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="link"
        size="sm"
        className="h-auto justify-start p-1 text-sm"
        onClick={() => setOpen(true)}
      >
        Record an offline refund
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record an offline refund</DialogTitle>
            <DialogDescription>
              Use this for money that you returned outside a payment gateway, such as cash, check or
              bank transfer. We do not contact a gateway.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={recordInvoiceOfflineRefundAction}
            onSuccess={() => setOpen(false)}
            className="space-y-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="invoice" value={invoice} />
            <AmountField
              currency={currency}
              maxMinor={refundableMinor}
              help={`Up to ${money(refundableMinor, currency)} is creditable.`}
            />
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
            <ReasonFields required={requiredReasons} />
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

/** Record a complete or partial offline payment already received. */
export function RecordInvoiceOfflinePaymentDialog({
  biz,
  invoice,
  dueMinor,
  currency,
  writeOffLimitMinor = 0,
}: {
  biz: string;
  invoice: string;
  dueMinor: number;
  currency: string;
  /** The largest shortfall the business rule writes off on this invoice; 0 = none. */
  writeOffLimitMinor?: number;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant="link"
        size="sm"
        className="h-auto justify-start p-1 text-sm"
        onClick={() => setOpen(true)}
      >
        Record an offline payment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record an offline payment</DialogTitle>
            <DialogDescription>
              Use this for money that you received outside a payment gateway, such as cash, check or
              bank transfer. We do not charge a card.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={recordOfflinePaymentAction}
            onSuccess={() => setOpen(false)}
            className="space-y-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="inv" value={invoice} />
            <OfflinePaymentAmount
              dueMinor={dueMinor}
              currency={currency}
              writeOffLimitMinor={writeOffLimitMinor}
            />
            {/* The engine builds `offline_${method}` as the gateway key — see lib/offline-methods. */}
            <Field name="method" label="Payment method">
              <SelectField
                name="method"
                defaultValue="cash"
                ariaLabel="Payment method"
                options={offlineMethodOptions()}
              />
            </Field>
            <Field
              name="date"
              label="Payment date"
              help="The date when the money arrived. Leave blank to use the current time."
            >
              <DateTimeField name="date" />
            </Field>
            <Field
              name="reference"
              label="Reference number"
              help="Optional. For example, a check number or a bank transaction ID."
            >
              <Input name="reference" placeholder="optional" maxLength={100} />
            </Field>
            <Field
              name="comment"
              label="Note"
              help="Optional. We add this text to the Comments timeline."
            >
              <Input name="comment" maxLength={500} placeholder="optional" />
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

/**
 * The amount, and what happens to a difference from the amount due. Each choice shows only
 * when it has an effect, preselected to what the engine does without it, and posts only
 * when changed: omitted = the business rule.
 */
function OfflinePaymentAmount({
  dueMinor,
  currency,
  writeOffLimitMinor,
}: {
  dueMinor: number;
  currency: string;
  writeOffLimitMinor: number;
}) {
  const [amount, setAmount] = React.useState("");
  const [shortfall, setShortfall] = React.useState<"write_off" | "leave_due">("write_off");
  const [excess, setExcess] = React.useState<"credit" | "refund">("credit");
  const entered = amount === "" ? null : Number(amount);
  const shortMinor = entered != null && entered > 0 && entered < dueMinor ? dueMinor - entered : 0;
  const overMinor = entered != null && entered > dueMinor ? entered - dueMinor : 0;
  // The rule writes off a shortfall within the limit; above it, nothing is written off.
  const showShortfall = shortMinor > 0 && shortMinor <= writeOffLimitMinor;
  return (
    <>
      {/* MAJOR units. Blank posts '' and the action omits it, which the engine reads as
          "mark the invoice paid in full". */}
      <Field
        name="amount_minor"
        label="Amount"
        help={`Leave blank to record the full ${money(dueMinor, currency)} still due.`}
      >
        <MoneyInput
          name="amount_minor"
          currency={currency}
          placeholder="full"
          onMinorChange={setAmount}
        />
      </Field>
      {showShortfall ? (
        <div className="space-y-2">
          <span className="text-sm font-medium">
            Remaining amount: {money(shortMinor, currency)}
          </span>
          {shortfall !== "write_off" ? (
            <input type="hidden" name="shortfall" value={shortfall} />
          ) : null}
          <RadioField
            ariaLabel="Remaining amount"
            value={shortfall}
            onValueChange={(v) => setShortfall(v as typeof shortfall)}
            options={[
              {
                value: "write_off",
                label: "Write off the remaining amount",
                hint: "We create a credit note for the remaining amount. The invoice becomes paid.",
              },
              {
                value: "leave_due",
                label: "Keep the remaining amount due",
                hint: "The invoice stays open for the remaining amount.",
              },
            ]}
          />
          <p className="text-xs text-muted-foreground">
            Applies to this payment only. The business setting writes off a remaining amount of{" "}
            {money(writeOffLimitMinor, currency)} or less on this invoice.
          </p>
        </div>
      ) : null}
      {overMinor > 0 ? (
        <div className="space-y-2">
          <span className="text-sm font-medium">
            Amount more than due: {money(overMinor, currency)}
          </span>
          {excess !== "credit" ? <input type="hidden" name="excess" value={excess} /> : null}
          <RadioField
            ariaLabel="Amount more than due"
            value={excess}
            onValueChange={(v) => setExcess(v as typeof excess)}
            options={[
              {
                value: "credit",
                label: "Keep it as credit for the customer",
                hint: "We add it to the excess credit of the customer. Later invoices use it.",
              },
              {
                value: "refund",
                label: "Record that you returned it",
                hint: "You gave the money back outside a payment gateway. We record a refund with the same payment method.",
              },
            ]}
          />
          <p className="text-xs text-muted-foreground">Applies to this payment only.</p>
        </div>
      ) : null}
    </>
  );
}
