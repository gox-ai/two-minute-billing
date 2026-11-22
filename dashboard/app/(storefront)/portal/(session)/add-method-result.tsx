"use client";

import * as React from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money } from "@/lib/format";
import type { PortalMe } from "@/lib/portal-api";
import { RefusalAlert } from "../../payment-dialog";
import { PayInvoiceButton } from "./pay-invoice";
import type { AddMethodOutcome, OutcomeInvoice } from "./portal-state";

const invoiceName = (i: OutcomeInvoice) => (i.number ? `invoice ${i.number}` : "your invoice");

/** "$49.00" or "$49.00 and ₹1,999.00": one figure per currency. */
function totals(list: readonly OutcomeInvoice[]): string {
  const sums = new Map<string, number>();
  for (const i of list) sums.set(i.currency, (sums.get(i.currency) ?? 0) + i.amountMinor);
  return [...sums].map(([c, m]) => money(m, c)).join(" and ");
}

function names(list: readonly OutcomeInvoice[]): string {
  const n = list.map((i) => i.number ?? "").filter(Boolean);
  if (n.length !== list.length || n.length === 0) return "";
  return n.length === 1 ? n[0] : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/**
 * After Add card: what the new method did to the open invoices. The engine charges them
 * when the method is saved (when the business allows it); without this the buyer saw
 * "Payment method added" whether the invoice was paid, refused or never charged.
 */
export function AddMethodResult({
  outcome,
  onClose,
  me,
  scope,
}: {
  outcome: AddMethodOutcome | null;
  onClose: () => void;
  me: PortalMe;
  scope: string;
}) {
  const o = outcome;
  const payable = o ? [...o.notCollected.filter((i) => i.payable), ...o.stillDue] : [];
  const payOne = payable.length === 1 ? payable[0] : null;
  const paidTotal = o ? o.paid.reduce((n, i) => n + i.amountMinor, 0) : 0;
  const paidNames = o ? names(o.paid) : "";
  // Pay runs OUTSIDE this dialog: it hides while the Pay dialog or the gateway's form is
  // open, and comes back with the refusal if the payment fails or the buyer cancels.
  const [paying, setPaying] = React.useState<OutcomeInvoice | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (o == null) setRefusal(null);
  }, [o]);

  return (
    <>
      <Dialog open={o != null && paying == null} onOpenChange={(open) => (open ? null : onClose())}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Payment method added</DialogTitle>
          </DialogHeader>
          {o ? (
            <div className="flex flex-col gap-3">
              {o.paid.length ? (
                <Alert
                  tone="success"
                  title={
                    paidTotal > 0
                      ? `We collected ${totals(o.paid)}.`
                      : "Your credit paid the invoice."
                  }
                >
                  {o.paid.length === 1
                    ? `${capital(invoiceName(o.paid[0]))} is paid.`
                    : paidNames
                      ? `Invoices ${paidNames} are paid.`
                      : `${o.paid.length} invoices are paid.`}
                </Alert>
              ) : null}
              {o.inProgress.map((i) => (
                <Alert key={i.id} tone="warning" title="Payment in progress">
                  We are waiting for confirmation of {money(i.amountMinor, i.currency)} for{" "}
                  {invoiceName(i)}. You do not have to do anything. Do not pay again.
                </Alert>
              ))}
              {o.scheduled.map((i) => (
                <Alert key={i.id} tone="info" title="Payment scheduled">
                  We sent your bank a notice. We will take {money(i.amountMinor, i.currency)} for{" "}
                  {invoiceName(i)} in about 1 day. You do not have to do anything. Do not pay again.
                </Alert>
              ))}
              {o.notCollected.map((i) => (
                <Alert
                  key={i.id}
                  tone="error"
                  title={`We could not collect ${money(i.amountMinor, i.currency)} for ${invoiceName(i)}.`}
                >
                  {i.reason ?? "Pay the invoice now, or use a different payment method."}
                </Alert>
              ))}
              {o.stillDue.length ? (
                <Alert
                  tone="warning"
                  title={
                    o.stillDue.length === 1
                      ? `${capital(invoiceName(o.stillDue[0]))} of ${money(o.stillDue[0].amountMinor, o.stillDue[0].currency)} is still due.`
                      : `${o.stillDue.length} invoices of ${totals(o.stillDue)} are still due.`
                  }
                >
                  {o.collectionOff ? "We use this payment method for your next invoices. " : ""}
                  {payOne
                    ? `To pay it now, select Pay ${money(payOne.amountMinor, payOne.currency)}.`
                    : "Pay each one in Invoices."}
                </Alert>
              ) : null}
              {refusal ? <RefusalAlert message={refusal} step="pay_invoice" /> : null}
            </div>
          ) : null}
          <DialogFooter>
            {payOne ? (
              <>
                <Button variant="outline" onClick={onClose}>
                  Later
                </Button>
                <Button
                  className="tabular-nums"
                  onClick={() => {
                    setRefusal(null);
                    setPaying(payOne);
                  }}
                >
                  Pay {money(payOne.amountMinor, payOne.currency)}
                </Button>
              </>
            ) : (
              <Button onClick={onClose}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {paying ? (
        <PayInvoiceButton
          invoice={paying.id}
          currency={paying.currency}
          amountMinor={paying.amountMinor}
          me={me}
          scope={scope}
          headless={{
            onPaid: () => {
              setPaying(null);
              onClose();
            },
            onRefused: (message) => {
              setRefusal(message);
              setPaying(null);
            },
            onIdle: () => setPaying(null),
          }}
        />
      ) : null}
    </>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
