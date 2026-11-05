"use client";

import * as React from "react";
import { EditDrawer } from "@/components/edit-drawer";
import { Button } from "@/components/ui/button";
import { DateTimeField } from "@/components/form/datetime-field";
import { MoneyInput } from "@/components/form/money-input";
import { Field } from "@/components/form/field";
import type { DraftCharge } from "@/components/charges/charge-takeover";

/**
 * Service-period bounds are held as UTC ISO strings — `DateTimeField` shows them to the
 * operator in the business timezone and hands back UTC, so nothing here converts.
 */
function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * Ad-hoc "Add Charge" modal, opened from the Quick Charge takeover's repeater.
 * Amount, Service Period (From/To) and Description are all mandatory. "Choose
 * Currency" lives on the takeover instead, because an invoice is single-currency
 * and a per-line picker would have to lock itself after the first line.
 *
 * Amount is major units via `MoneyInput`; the draft carries minor units, which is
 * what the API takes.
 */
export function QuickChargeModal({
  open,
  onOpenChange,
  currency,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  currency: string;
  onAdd: (draft: Omit<DraftCharge, "key">) => void;
}) {
  const [description, setDescription] = React.useState("");
  const [amountMinor, setAmountMinor] = React.useState("");
  const [from, setFrom] = React.useState(nowUtc);
  const [to, setTo] = React.useState(nowUtc);
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const reset = () => {
    setDescription("");
    setAmountMinor("");
    setFrom(nowUtc());
    setTo(nowUtc());
    setErrors({});
  };

  const submit = () => {
    const minor = Number(amountMinor);
    const next: Record<string, string> = {};
    // Money rule: amount is a positive integer in MINOR units — never a float.
    if (!amountMinor || !Number.isFinite(minor) || !Number.isInteger(minor) || minor <= 0) {
      next.amount = "Enter an amount greater than zero";
    }
    if (!from) next.from_date = "From date is required";
    if (!to) next.to_date = "To date is required";
    // Already UTC ISO from DateTimeField — zone-qualified, so this parse is exact.
    if (from && to && new Date(to) < new Date(from))
      next.to_date = "To date cannot be before From date";
    if (!description.trim()) next.description = "Description is required";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    onAdd({
      description: description.trim(),
      amountMinor: minor,
      periodStart: new Date(from).toISOString(),
      periodEnd: new Date(to).toISOString(),
    });
    reset();
    onOpenChange(false);
  };

  return (
    <EditDrawer
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="Add Charge"
    >
      {/*
        NOT a <form>: this modal renders INSIDE the takeover's form, and a nested
        form is invalid HTML — the inner submit would post the outer form and create
        the invoice with the line half-entered. The Add button is a plain button.
      */}
      <div className="flex flex-col gap-4 py-4">
        <Field name="amount" label="Amount" required error={errors.amount}>
          {/* Unnamed on purpose — the draft is collected in JS, not posted here. */}
          <MoneyInput currency={currency} min={0} onMinorChange={setAmountMinor} />
        </Field>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-semibold">Service Period</legend>
          <p className="text-xs text-muted-foreground">
            The period that the charge covers. We use it for revenue recognition.
          </p>
          <Field name="from_date" label="From date" required error={errors.from_date}>
            <DateTimeField defaultValue={from} onUtcChange={setFrom} required />
          </Field>
          <Field name="to_date" label="To date" required error={errors.to_date}>
            <DateTimeField defaultValue={to} onUtcChange={setTo} required />
          </Field>
        </fieldset>

        <Field name="description" label="Description" required error={errors.description}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={3}
            className="rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={submit}>
            Add
          </Button>
        </div>
      </div>
    </EditDrawer>
  );
}
