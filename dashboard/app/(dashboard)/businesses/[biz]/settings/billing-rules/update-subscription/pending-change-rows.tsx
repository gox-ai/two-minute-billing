"use client";

import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";
import { useFieldError } from "@/components/form/action-form";
import { PENDING_CHANGE_EXPIRY_HOURS, PENDING_CHANGE_EXPIRY_HOURS_SLOW } from "@/lib/billing-rules";

/**
 * `pending_change_expiry_hours` / `_slow`: how long a change held for payment
 * (`failed_change_charge: apply_when_paid`) waits for its invoice. Never past the term end.
 */
export function PendingChangeExpiryRows({
  hours,
  slowHours,
  applies,
}: {
  hours: number;
  slowHours: number;
  /** The saved rule is `apply_when_paid`; otherwise the rows wait for that choice. */
  applies: boolean;
}) {
  const note = applies ? undefined : "Used when the charge for a change is set to Apply when paid.";
  return (
    <>
      <SettingRow
        label="Time to pay for a change"
        htmlFor="pending_change_expiry_hours"
        help={`How long a change waits for its invoice to be paid. After this time, or at the end of the term if that is sooner, we void the invoice and the change does not apply. From ${PENDING_CHANGE_EXPIRY_HOURS.min} to ${PENDING_CHANGE_EXPIRY_HOURS.max} hours.`}
        errorFor="pending_change_expiry_hours"
        placement="end"
        control={<HoursField name="pending_change_expiry_hours" defaultValue={hours} />}
        consequence={note}
      />
      <SettingRow
        label="Time to pay with a slow method"
        htmlFor="pending_change_expiry_hours_slow"
        help={`The same time for a bank debit, a mandate, an offline invoice, or a payment that is still in progress. It also stops at the end of the term. From ${PENDING_CHANGE_EXPIRY_HOURS_SLOW.min} to ${PENDING_CHANGE_EXPIRY_HOURS_SLOW.max} hours.`}
        errorFor="pending_change_expiry_hours_slow"
        placement="end"
        control={<HoursField name="pending_change_expiry_hours_slow" defaultValue={slowHours} />}
        consequence={note}
      />
    </>
  );
}

/** Whole hours, 120px; its own error key marks it. */
function HoursField({ name, defaultValue }: { name: string; defaultValue: number }) {
  const error = useFieldError(name);
  return (
    <span className="inline-flex items-center gap-2">
      <Input
        id={name}
        name={name}
        type="number"
        inputMode="numeric"
        step="any"
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        className="w-30 tabular-nums"
      />
      <span className="text-sm text-muted-foreground">hours</span>
    </span>
  );
}
