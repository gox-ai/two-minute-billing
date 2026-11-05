"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { EditDrawer } from "@/components/edit-drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioField } from "@/components/ui/radio-group";
import { SelectField } from "@/components/ui/select-field";
import { toMajorInput } from "@/lib/money";
import {
  removeUsageInvoiceThresholdAction,
  saveUsageInvoiceThresholdAction,
} from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";
import { ConfirmActionButton } from "./controls";

/** Plan: "Invoice usage early" — one recurring amount per currency. */
export function PlanUsageThresholdButton({
  biz,
  product,
  currencies,
  returnTo,
}: {
  biz: string;
  product: string;
  currencies: string[];
  returnTo: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [cur, setCur] = useDefaultState(currencies[0] ?? "");
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Set amount
      </Button>
      <EditDrawer
        open={open}
        onOpenChange={setOpen}
        title="Invoice usage early"
        description="We raise an invoice each time the unbilled usage of a subscription reaches this amount. Discounts and the minimum apply on the invoice at the end of the period."
      >
        <ActionForm
          action={saveUsageInvoiceThresholdAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="product" value={product} />
          <input type="hidden" name="enabled" value="on" />
          <input type="hidden" name="return_to" value={returnTo} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field name="currency" label="Currency">
              <SelectField
                name="currency"
                value={cur}
                onValueChange={setCur}
                options={currencies.map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field name="amount" label={`Unbilled usage (${cur})`}>
              <Input name="amount" inputMode="decimal" className="tabular-nums" />
            </Field>
          </div>
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
    </>
  );
}

/** Subscription: use the plan's amount, an own amount, or turn it off for this subscription. */
export function SubscriptionUsageThresholdButton({
  biz,
  subscription,
  currency,
  override,
  returnTo,
}: {
  biz: string;
  subscription: string;
  currency: string;
  /** The subscription's own row: null = it follows the plan. */
  override: { amount_minor: number | null; active: boolean } | null;
  returnTo: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [choice, setChoice] = useDefaultState<string>(
    !override ? "" : override.active ? "on" : "off",
  );
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Edit
      </Button>
      <EditDrawer open={open} onOpenChange={setOpen} title="Invoice usage early">
        <ActionForm
          action={saveUsageInvoiceThresholdAction}
          onSuccess={() => setOpen(false)}
          className="flex flex-col gap-4 py-2"
        >
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="subscription" value={subscription} />
          <input type="hidden" name="currency" value={currency} />
          <input type="hidden" name="return_to" value={returnTo} />
          <Field name="enabled" label="For this subscription">
            <RadioField
              name="enabled"
              value={choice}
              onValueChange={setChoice}
              ariaLabel="For this subscription"
              options={[
                { value: "on", label: "Invoice early at its own amount" },
                { value: "off", label: "Do not invoice early" },
              ]}
            />
          </Field>
          {choice === "on" ? (
            <Field name="amount" label={`Unbilled usage (${currency})`}>
              <Input
                name="amount"
                inputMode="decimal"
                defaultValue={toMajorInput(override?.amount_minor ?? null, currency)}
                className="tabular-nums"
              />
            </Field>
          ) : null}
          <div className="flex justify-end">
            <SubmitButton>Save</SubmitButton>
          </div>
        </ActionForm>
      </EditDrawer>
      {override ? (
        <ConfirmActionButton
          action={removeUsageInvoiceThresholdAction}
          fields={{ biz, subscription, return_to: returnTo }}
          label="Use the plan setting"
          title="Use the plan setting?"
          description="The subscription follows the plan's amount again."
          confirmLabel="Use the plan setting"
        />
      ) : null}
    </>
  );
}
