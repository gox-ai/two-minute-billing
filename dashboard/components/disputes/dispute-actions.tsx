"use client";

import * as React from "react";
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
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectField } from "@/components/ui/select-field";
import { MoneyInput } from "@/components/form/money-input";
import { DateTimeField } from "@/components/form/datetime-field";
import { money, toMajor } from "@/lib/format";
import { DISPUTE_REASON_OPTIONS } from "@/lib/dispute-vocab";
import {
  disputeOutcomeAction,
  recordDisputeAction,
} from "@/app/(dashboard)/businesses/[biz]/disputes/actions";

/**
 * Record a chargeback the payment's gateway cannot report. Shown only where the engine
 * offers it (`transaction.dispute_recording`); every field posts to the record route.
 */
export function RecordDisputeButton({
  biz,
  pay,
  txn,
  availableMinor,
  currency,
  gatewayName,
}: {
  biz: string;
  pay: string;
  txn?: string;
  availableMinor: number;
  currency: string;
  gatewayName: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Record dispute
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record dispute</DialogTitle>
            <DialogDescription>
              {gatewayName} does not send disputes to us. Enter the chargeback that your card
              processor reported. We take the amount out of cash and hold it until you record the
              outcome.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={recordDisputeAction}
            onSuccess={() => setOpen(false)}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="pay" value={pay} />
            {txn ? <input type="hidden" name="txn" value={txn} /> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                name="amount_minor"
                label="Amount"
                required
                help={`At most ${money(availableMinor, currency)}.`}
              >
                <MoneyInput
                  name="amount_minor"
                  currency={currency}
                  required
                  defaultMajor={toMajor(availableMinor, currency)}
                />
              </Field>
              <Field name="reason" label="Reason" required>
                <SelectField
                  name="reason"
                  ariaLabel="Reason"
                  placeholder="Select a reason"
                  options={[...DISPUTE_REASON_OPTIONS]}
                />
              </Field>
            </div>
            <Field
              name="opened_at"
              label="Dispute date"
              help="The date when the processor opened the dispute. Leave blank to use today."
            >
              <DateTimeField name="opened_at" granularity="date" />
            </Field>
            <Field
              name="processor_reference"
              label="Processor reference"
              help="Optional. The case number that your processor gave the dispute."
            >
              <Input name="processor_reference" maxLength={200} />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Record dispute</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * "Mark as won" / "Mark as lost" on a dispute whose `outcome_settable_by_operator` is true.
 * The confirmation says what the ledger does, which depends on `fundsWithdrawn`.
 */
export function DisputeOutcomeButtons({
  biz,
  dsp,
  txn,
  amountMinor,
  currency,
  fundsWithdrawn,
}: {
  biz: string;
  dsp: string;
  txn?: string;
  amountMinor: number;
  currency: string;
  fundsWithdrawn: boolean;
}) {
  const [outcome, setOutcome] = React.useState<"won" | "lost" | null>(null);
  const amount = money(amountMinor, currency);
  const effect =
    outcome === "won"
      ? fundsWithdrawn
        ? `The processor gave the money back. We put ${amount} back into cash.`
        : "The processor did not take the money. We close the dispute as won."
      : fundsWithdrawn
        ? `The processor kept the money. We move ${amount} from held funds to dispute losses.`
        : `The processor kept the money. We record ${amount} as a dispute loss.`;
  return (
    <>
      <span className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOutcome("won")}
          aria-haspopup="dialog"
        >
          Mark as won
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOutcome("lost")}
          aria-haspopup="dialog"
        >
          Mark as lost
        </Button>
      </span>
      <Dialog open={outcome !== null} onOpenChange={(o) => !o && setOutcome(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{outcome === "won" ? "Mark as won" : "Mark as lost"}</DialogTitle>
            <DialogDescription>{effect} You cannot undo this.</DialogDescription>
          </DialogHeader>
          <ActionForm
            action={disputeOutcomeAction}
            onSuccess={() => setOutcome(null)}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="dsp" value={dsp} />
            <input type="hidden" name="outcome" value={outcome ?? ""} />
            {txn ? <input type="hidden" name="txn" value={txn} /> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOutcome(null)}>
                Cancel
              </Button>
              <SubmitButton>{outcome === "won" ? "Mark as won" : "Mark as lost"}</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
