"use client";

import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectField } from "@/components/ui/select-field";
import { portalPayRequestAction } from "./actions";

/**
 * "Pay <total>" for one payment request: charges a SAVED payment method for the whole
 * live total. The select shows only when the buyer has more than one method; it starts on
 * their primary one.
 */
export function PayRequestForm({
  preq,
  label,
  methods,
  defaultMethod,
}: {
  preq: string;
  /** The button text, e.g. "Pay ₹4,500.00". */
  label: string;
  /** Labels are resolved server-side with the portal's own method names. */
  methods: Array<{ value: string; label: string }>;
  defaultMethod: string;
}) {
  return (
    <ActionForm
      action={portalPayRequestAction}
      className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end"
    >
      <input type="hidden" name="preq" value={preq} />
      {methods.length > 1 ? (
        <SelectField
          name="payment_method"
          ariaLabel="Payment method"
          defaultValue={defaultMethod}
          options={methods}
          size="sm"
          className="sm:w-60"
        />
      ) : (
        <input type="hidden" name="payment_method" value={defaultMethod} />
      )}
      <SubmitButton size="sm">{label}</SubmitButton>
    </ActionForm>
  );
}
