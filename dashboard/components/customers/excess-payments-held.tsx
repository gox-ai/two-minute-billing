"use client";

import { MiddleEllipsis } from "@/components/patterns/id-text";

import { useDisplayTz } from "@/components/business-tz";
import * as React from "react";
import Link from "next/link";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { RepeatRefundNotice, useRepeatRefund } from "@/components/form/repeat-refund";
import { SubmitButton } from "@/components/form/submit-button";
import { MoneyInput } from "@/components/form/money-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money, toMajor } from "@/lib/format";
import { fmtDate } from "@/lib/format-date";
import type { ExcessPayment } from "@/lib/api";
import { refundExcessPaymentAction } from "@/app/(dashboard)/businesses/[biz]/customers/[cus]/actions";

/**
 * The payments behind the customer's excess credit, each refundable on its own — the way
 * money charged for a voided invoice, or an overpayment, goes back to the card it came from.
 * "Still held" is what is left after invoices used the credit, oldest payment first, so the
 * rows add up to the excess balance. Renders nothing when no payment holds any.
 */
export function ExcessPaymentsHeld({
  biz,
  cus,
  rows,
  onRefunded,
  reasonRequired = false,
}: {
  biz: string;
  cus: string;
  rows: ExcessPayment[];
  /** Re-reads the balances after a refund lands. */
  onRefunded?: () => void;
  /** `required_reasons.refund`: the API refuses a refund without a reason. */
  reasonRequired?: boolean;
}) {
  const [refunding, setRefunding] = React.useState<ExcessPayment | null>(null);
  const tz = useDisplayTz();
  if (rows.length === 0) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Held as excess credit</h3>
      {/* Below 640px each payment is a block: its id, then labelled values, then the action. */}
      <div className="sm:overflow-x-auto">
        <table className="w-full text-sm max-sm:block">
          <thead className="max-sm:hidden">
            <tr className="border-b text-xs text-muted-foreground">
              <th className="pr-4 pb-2 text-left font-medium">Payment</th>
              <th className="pr-4 pb-2 text-right font-medium whitespace-nowrap">
                Excess received
              </th>
              <th className="pr-4 pb-2 text-right font-medium whitespace-nowrap">Still held</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {rows.map((r) => (
              <tr key={r.payment} className="border-b last:border-0 max-sm:block max-sm:py-2">
                <td className="py-2 pr-4 max-sm:block max-sm:p-0 max-sm:pb-1">
                  <MiddleEllipsis value={r.payment} className="text-xs" />
                  <span className="block text-xs text-muted-foreground">
                    {r.invoice ? (
                      <>
                        Overpaid{" "}
                        <Link
                          href={`/businesses/${biz}/invoices/${r.invoice}`}
                          className="text-primary hover:underline"
                        >
                          its invoice
                        </Link>
                      </>
                    ) : (
                      "No invoice"
                    )}
                    {r.gateway ? ` · ${r.gateway}` : ""}
                    {" · "}
                    <span className="whitespace-nowrap">{fmtDate(r.created_at, tz)}</span>
                  </span>
                </td>
                <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:p-0 max-sm:py-0.5">
                  <span className="text-xs text-muted-foreground sm:hidden">Excess received</span>
                  {money(r.held_minor, r.currency)}
                </td>
                <td className="py-2 pr-4 text-right font-medium whitespace-nowrap tabular-nums max-sm:flex max-sm:justify-between max-sm:gap-3 max-sm:p-0 max-sm:py-0.5">
                  <span className="text-xs text-muted-foreground sm:hidden">Still held</span>
                  {money(r.remaining_minor, r.currency)}
                </td>
                <td className="py-2 text-right max-sm:block max-sm:p-0 max-sm:pt-1.5 max-sm:text-left">
                  {r.refundable_minor > 0 ? (
                    <Button variant="outline" size="sm" onClick={() => setRefunding(r)}>
                      Refund…
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.remaining_minor < r.held_minor) ? (
        <p className="text-xs text-muted-foreground">
          Invoices use excess credit from the oldest payment first. Still held is what is left.
        </p>
      ) : null}
      {refunding ? (
        <RefundExcessDialog
          reasonRequired={reasonRequired}
          biz={biz}
          cus={cus}
          row={refunding}
          onClose={() => setRefunding(null)}
          onDone={() => {
            setRefunding(null);
            onRefunded?.();
          }}
        />
      ) : null}
    </div>
  );
}

function RefundExcessDialog({
  biz,
  cus,
  row,
  onClose,
  onDone,
  reasonRequired,
}: {
  biz: string;
  cus: string;
  row: ExcessPayment;
  onClose: () => void;
  onDone: () => void;
  reasonRequired: boolean;
}) {
  const repeat = useRepeatRefund();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Refund excess payment</DialogTitle>
          <DialogDescription>
            We send the money back to the original payment method through{" "}
            {row.gateway ?? "the gateway"}. We also remove it from the customer&rsquo;s excess
            credit. This is not a revenue refund. We never counted this money as revenue.
          </DialogDescription>
        </DialogHeader>
        <ActionForm
          action={refundExcessPaymentAction}
          onSuccess={onDone}
          onRefused={repeat.onRefused}
          className="flex flex-col gap-4"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="cus" value={cus} />
          <input type="hidden" name="pay" value={row.payment} />
          <Field
            name="amount_minor"
            label="Amount"
            help={
              row.refundable_minor === row.remaining_minor
                ? `Up to ${money(row.refundable_minor, row.currency)}. This is the credit that this payment still holds.`
                : `Up to ${money(row.refundable_minor, row.currency)}.`
            }
          >
            <MoneyInput
              name="amount_minor"
              currency={row.currency}
              defaultMajor={toMajor(row.refundable_minor, row.currency)}
              max={toMajor(row.refundable_minor, row.currency)}
              required
            />
          </Field>
          <Field
            name="reason"
            label={reasonRequired ? "Reason" : "Reason (optional)"}
            required={reasonRequired}
            help={reasonRequired ? "This business requires a reason for each refund." : undefined}
          >
            <Input
              name="reason"
              maxLength={500}
              required={reasonRequired}
              placeholder="e.g. Charged twice for the same period"
            />
          </Field>
          <RepeatRefundNotice message={repeat.message} onClear={repeat.clear} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton>Refund</SubmitButton>
          </div>
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}
