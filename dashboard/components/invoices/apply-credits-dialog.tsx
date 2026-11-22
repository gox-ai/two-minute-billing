"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SubmitButton } from "@/components/form/submit-button";
import { ActionForm } from "@/components/form/action-form";
import { applyCreditsAction } from "@/app/actions";
import { money } from "@/lib/format";
import { applyCreditsPlan } from "@/lib/apply-credits";

/**
 * Apply the customer's refundable credit and excess payments to one open invoice
 * (`POST …/invoices/:inv/apply_credits`). The page offers it only when the invoice is owed
 * and the customer holds credit in its currency. The amounts shown are the amounts posted.
 */
export function ApplyCreditsDialog({
  biz,
  invoice,
  refundableMinor,
  excessMinor,
}: {
  biz: string;
  invoice: { id: string; number: string | null; dueMinor: number; currency: string };
  /** The customer's refundable credit in the invoice's currency. */
  refundableMinor: number;
  /** The customer's excess payments in the invoice's currency. */
  excessMinor: number;
}) {
  const [open, setOpen] = React.useState(false);
  const plan = applyCreditsPlan(invoice.dueMinor, refundableMinor, excessMinor);
  const m = (v: number) => money(v, invoice.currency);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="rounded-md px-1 py-0.5 text-left text-sm text-primary hover:underline"
      >
        Apply credits
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Apply credits</DialogTitle>
            <DialogDescription>
              Use the customer&rsquo;s credit to pay this invoice. Refundable credit is used first,
              then excess payments.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={applyCreditsAction}
            onSuccess={() => setOpen(false)}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="inv" value={invoice.id} />
            <input type="hidden" name="refundable_minor" value={plan.refundableMinor} />
            <input type="hidden" name="excess_minor" value={plan.excessMinor} />
            <dl className="divide-y rounded-md border bg-muted/40 text-sm tabular-nums">
              <Row label={`Amount due on ${invoice.number ?? "this invoice"}`}>
                {m(invoice.dueMinor)}
              </Row>
              <Row label="Refundable credit available">{m(refundableMinor)}</Row>
              <Row label="Excess payments available">{m(excessMinor)}</Row>
              <Row label="Credit to apply" strong>
                {m(plan.totalMinor)}
              </Row>
              <Row label="Amount due after">{m(plan.dueAfterMinor)}</Row>
            </dl>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Apply credits</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({
  label,
  children,
  strong = false,
}: {
  label: string;
  children: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2">
      <dt className="min-w-0 text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-semibold" : undefined}>{children}</dd>
    </div>
  );
}
