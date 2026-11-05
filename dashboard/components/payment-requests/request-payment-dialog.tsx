"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import { CheckboxField } from "@/components/ui/checkbox";
import { RadioField } from "@/components/ui/radio-group";
import { SelectField } from "@/components/ui/select-field";
import { RailButton } from "@/components/patterns/action-rail";
import { money, fmtDate } from "@/lib/format";
import { useBusinessTz } from "@/components/business-tz";
import { useDefaultState } from "@/lib/use-default-state";
import { createPaymentRequestAction } from "@/app/(dashboard)/businesses/[biz]/payment_requests/actions";
import type { Invoice, PaymentMethod } from "@/lib/api";

/** Statuses where the engine takes money — mirrors `OPEN_INVOICE_STATUSES`. */
const OPEN = new Set(["posted", "payment_due", "not_paid"]);
const MAX_INVOICES = 50;

const dueOf = (i: Invoice) => i.amount_due_minor ?? i.total_minor;

export const pmLabel = (pm: PaymentMethod) =>
  `${pm.brand ? pm.brand[0]!.toUpperCase() + pm.brand.slice(1) : (pm.type ?? "Card")}${
    pm.last4 ? ` ···${pm.last4}` : ""
  }${pm.role === "primary" ? " (primary)" : ""}`;

/** Rail entry on the customer page: opens the request dialog. */
export function RequestPaymentRailButton({
  biz,
  cus,
  invoices,
  pms,
  customerEmail,
}: {
  biz: string;
  cus: string;
  invoices: Invoice[];
  pms: PaymentMethod[];
  customerEmail: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const unpaid = invoices.filter((i) => OPEN.has(i.status) && dueOf(i) > 0);
  return (
    <>
      <RailButton
        opensDialog
        expanded={open}
        onClick={() => setOpen(true)}
        disabled={unpaid.length === 0}
      >
        Request payment
      </RailButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Request payment</DialogTitle>
            <DialogDescription>
              One request for several open invoices. Charge the saved payment method now, or email
              the customer a link to pay the total.
            </DialogDescription>
          </DialogHeader>
          {/* Remounts on every open, so the selection starts fresh. */}
          {open ? (
            <RequestPaymentForm
              biz={biz}
              cus={cus}
              unpaid={unpaid}
              pms={pms}
              customerEmail={customerEmail}
              onDone={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RequestPaymentForm({
  biz,
  cus,
  unpaid,
  pms,
  customerEmail,
  onDone,
}: {
  biz: string;
  cus: string;
  unpaid: Invoice[];
  pms: PaymentMethod[];
  customerEmail: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const tz = useBusinessTz();
  // One currency per request: start with every open invoice in the first one's currency.
  const firstCurrency = unpaid[0]?.currency ?? null;
  const [picked, setPicked] = React.useState<Set<string>>(
    () =>
      new Set(
        unpaid
          .filter((i) => i.currency === firstCurrency)
          .slice(0, MAX_INVOICES)
          .map((i) => i.id),
      ),
  );
  const [mode, setMode] = useDefaultState<string>(pms.length > 0 ? "charge" : "link");
  const primary = pms.find((p) => p.role === "primary") ?? pms[0];

  const chosen = unpaid.filter((i) => picked.has(i.id));
  const currency = chosen[0]?.currency ?? null;
  const total = chosen.reduce((n, i) => n + dueOf(i), 0);
  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <ActionForm
      action={createPaymentRequestAction}
      onSuccess={(r) => {
        onDone();
        if (r.redirectTo) router.push(r.redirectTo);
      }}
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="cus" value={cus} />
      <div className="-mx-6 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Invoices</span>
          <div className="flex flex-col divide-y rounded-md border">
            {unpaid.map((i) => {
              const otherCurrency = currency != null && i.currency !== currency;
              const full = !picked.has(i.id) && picked.size >= MAX_INVOICES;
              return (
                <div key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                  <CheckboxField
                    name="invoice_ids"
                    value={i.id}
                    checked={picked.has(i.id)}
                    onCheckedChange={(on) => toggle(i.id, on)}
                    disabled={otherCurrency || full}
                    label={<span className="font-mono text-xs">{i.number ?? i.id}</span>}
                    hint={
                      otherCurrency
                        ? `${i.currency}. A request takes invoices in one currency only.`
                        : i.created_at
                          ? `Created ${fmtDate(i.created_at, tz)}`
                          : undefined
                    }
                    className="flex-1"
                  />
                  <span className="text-sm font-medium tabular-nums">
                    {money(dueOf(i), i.currency)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="m-0 text-sm">
            <span className="text-muted-foreground">Total due: </span>
            <span className="font-semibold tabular-nums">
              {currency ? money(total, currency) : "Select at least one invoice"}
            </span>
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">How to request payment</span>
          <RadioField
            name="mode"
            ariaLabel="How to request payment"
            value={mode}
            onValueChange={setMode}
            options={[
              {
                value: "charge",
                label: "Charge now",
                hint:
                  pms.length > 0
                    ? "We charge the total to a saved payment method. If the charge fails, the request stays open."
                    : "This customer has no saved payment method.",
                disabled: pms.length === 0,
              },
              {
                value: "link",
                label: "Send a payment link",
                hint: "We email the customer a link to pay the total in their portal.",
              },
            ]}
          />
        </div>

        {mode === "charge" && primary ? (
          <Field name="payment_method" label="Payment method">
            <SelectField
              name="payment_method"
              ariaLabel="Payment method"
              defaultValue={primary.id}
              options={pms.map((p) => ({ value: p.id, label: pmLabel(p) }))}
            />
          </Field>
        ) : null}
        {mode === "link" ? (
          <Field
            name="email"
            label="Send to"
            help={
              customerEmail
                ? `Leave blank to send to ${customerEmail}.`
                : "This customer has no email address. Enter one."
            }
          >
            <Input
              name="email"
              type="email"
              maxLength={320}
              required={!customerEmail}
              placeholder={customerEmail ?? "email@example.com"}
            />
          </Field>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <SubmitButton disabled={picked.size === 0}>
          {mode === "charge"
            ? currency
              ? `Charge ${money(total, currency)}`
              : "Charge"
            : "Send payment link"}
        </SubmitButton>
      </DialogFooter>
    </ActionForm>
  );
}
