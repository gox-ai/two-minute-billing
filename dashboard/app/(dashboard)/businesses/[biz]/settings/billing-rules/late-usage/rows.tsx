"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { majorStep, toMajorInput } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { useFieldError } from "@/components/form/action-form";
import { LATE_USAGE_MIN_INTERVAL_HOURS, LATE_USAGE_WAIT_HOURS } from "@/lib/billing-rules";

/**
 * `late_usage_invoices`: the switch and, while it is on, the smallest amount to invoice per
 * currency. While it is off the amounts do not post, so the stored ones are kept.
 */
export function LateUsageRows({
  defaultEnabled,
  minimum,
  waitHours,
  minIntervalHours,
  currencies,
}: {
  defaultEnabled: boolean;
  minimum: Record<string, number>;
  waitHours: number;
  minIntervalHours: number;
  currencies: string[];
}) {
  const [enabled, setEnabled] = useDefaultState(defaultEnabled);
  return (
    <>
      <SettingRow
        label="Late usage after a cancellation"
        help="A customer gets late usage invoices at the price of the period that the usage belongs to."
        placement="end"
        control={
          <SettingSwitch
            name="late_usage_enabled"
            label="Late usage after a cancellation"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        }
        consequence={
          enabled
            ? "Late usage of a cancelled subscription goes on one more invoice, when no active subscription of the customer bills that meter. The invoice has no coupons. We try to collect it one time, and dunning does not start for it."
            : "Late usage that arrives after the last invoice of a cancelled subscription is not billed."
        }
        more="We wait until the first late event is as old as the wait below, so that events that arrive together go on one invoice. When a new subscription of the customer bills the same meter, the late usage goes on that subscription's next invoice instead."
      />
      <SettingRow
        label="Wait before the invoice"
        htmlFor="late_wait_hours"
        help={`How old the first late event must be before we create the invoice. Late events that arrive in this time go on the same invoice. From ${LATE_USAGE_WAIT_HOURS.min} to ${LATE_USAGE_WAIT_HOURS.max} hours.`}
        errorFor="late_wait_hours"
        placement="end"
        control={<HoursField name="late_wait_hours" defaultValue={waitHours} disabled={!enabled} />}
      />
      <SettingRow
        label="Time between invoices"
        htmlFor="late_min_interval_hours"
        help={`A customer gets at most one late usage invoice in this time. 24 hours: one each day. From ${LATE_USAGE_MIN_INTERVAL_HOURS.min} to ${LATE_USAGE_MIN_INTERVAL_HOURS.max} hours.`}
        errorFor="late_min_interval_hours"
        placement="end"
        control={
          <HoursField
            name="late_min_interval_hours"
            defaultValue={minIntervalHours}
            disabled={!enabled}
          />
        }
      />
      <SettingRow
        label="Smallest amount to invoice"
        help="When the late usage is less than this amount, we do not create the invoice. The usage stays and goes on an invoice when more usage arrives. Leave a currency empty to invoice any amount."
        errorFor="late_minimum"
        control={
          currencies.length === 0 ? (
            <p className="m-0 text-sm text-muted-foreground">
              Set a default currency on the business profile first.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {currencies.map((cur) => (
                <li key={cur} className="flex flex-wrap items-center gap-2.5">
                  <span className="w-12 text-sm font-medium">{cur}</span>
                  <Input
                    name={`late_minimum:${cur}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={majorStep(cur)}
                    defaultValue={minimum[cur] != null ? toMajorInput(minimum[cur], cur) : ""}
                    placeholder="No minimum"
                    disabled={!enabled}
                    className="w-30 tabular-nums"
                    aria-label={`Smallest late-usage amount to invoice in ${cur}`}
                  />
                </li>
              ))}
            </ul>
          )
        }
        consequence={
          enabled
            ? "Late usage below the amount waits. It is not lost."
            : "Enable late usage after a cancellation to set an amount."
        }
      />
    </>
  );
}

/** Whole hours, 120px; its own error key marks it. */
function HoursField({
  name,
  defaultValue,
  disabled,
}: {
  name: string;
  defaultValue: number;
  disabled: boolean;
}) {
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
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className="w-30 tabular-nums"
      />
      <span className="text-sm text-muted-foreground">hours</span>
    </span>
  );
}
