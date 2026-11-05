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
import { Field } from "@/components/form/field";
import { SelectField } from "@/components/ui/select-field";
import { SubmitButton } from "@/components/form/submit-button";
import { invoiceOpAction } from "@/app/actions";
import { ActionForm } from "@/components/form/action-form";
import { money } from "@/lib/format";
import type { PaymentMethod } from "@/lib/api";

const methodName = (pm: PaymentMethod) =>
  `${pm.brand ? pm.brand[0].toUpperCase() + pm.brand.slice(1) : (pm.type ?? "Card")}${
    pm.last4 ? ` •••• ${pm.last4}` : ""
  }`;

/**
 * The card choices, worded by what the engine does with each. Blank is the usual
 * order (the subscription's card, else the primary, then each backup); a named card
 * is charged ALONE — no backups — so it must not read like the same thing.
 */
export function paymentMethodOptions(pms: PaymentMethod[], firstTried?: PaymentMethod | null) {
  // The card "Automatic" starts with: the subscription's own when it has one (the caller
  // passes it), else the customer's primary.
  const first = firstTried ?? pms.find((p) => p.role === "primary");
  return [
    {
      value: "",
      label: first
        ? `Automatic: ${methodName(first)}, then backups`
        : "Automatic: primary, then backups",
    },
    ...pms.map((pm) => ({ value: pm.id, label: `Only ${methodName(pm)}` })),
  ];
}

/**
 * Collect ONE invoice now, choosing the card — the invoice's own collect (a manual
 * attempt: audited, and never spends a scheduled retry). Used on the invoice page and
 * in the subscription/customer needs-attention cards.
 */
export function CollectInvoiceDialog({
  biz,
  invoice,
  pms,
  back,
  trigger = "button",
  label = "Collect payment",
  firstTried,
}: {
  biz: string;
  invoice: { id: string; number: string | null; dueMinor: number; currency: string };
  pms: PaymentMethod[];
  /** Page to return to afterwards; defaults to the invoice page. */
  back?: string;
  trigger?: "button" | "outline" | "link";
  label?: string;
  /** The card collection tries first (a subscription's own card); defaults to the primary. */
  firstTried?: PaymentMethod | null;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      {trigger === "link" ? (
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="rounded px-1 py-0.5 text-left text-sm text-primary hover:underline"
        >
          {label}
        </button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={trigger === "outline" ? "outline" : "default"}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Collect payment</DialogTitle>
            <DialogDescription>
              Charge this invoice now. It does not use a scheduled retry.
            </DialogDescription>
          </DialogHeader>
          <ActionForm
            action={invoiceOpAction}
            onSuccess={() => setOpen(false)}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="inv" value={invoice.id} />
            <input type="hidden" name="op" value="collect" />
            {back ? <input type="hidden" name="back" value={back} /> : null}
            <div className="rounded-md border bg-muted/40 px-4 py-3">
              <p className="text-sm text-muted-foreground">{invoice.number ?? invoice.id}</p>
              <p className="mt-0.5 text-xl font-semibold tabular-nums">
                {money(invoice.dueMinor, invoice.currency)}{" "}
                <span className="text-xs font-normal text-muted-foreground">due</span>
              </p>
            </div>
            {pms.length > 0 ? (
              <Field
                name="payment_method_id"
                label="Payment method"
                help="Automatic tries each backup card if the first card declines. If you select one card, we try only that card."
              >
                <SelectField
                  name="payment_method_id"
                  ariaLabel="Payment method"
                  options={paymentMethodOptions(pms, firstTried)}
                />
              </Field>
            ) : (
              <p className="text-sm text-muted-foreground">
                The customer has no card on file. The collection will fail until they add one.
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton>Collect</SubmitButton>
            </DialogFooter>
          </ActionForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
