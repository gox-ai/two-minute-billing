"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { RadioField } from "@/components/ui/radio-group";
import { Consequence } from "@/components/settings/settings-layout";
import { BILLING_MODES, type BillingModeId } from "@/lib/billing-mode";

const IDS = Object.keys(BILLING_MODES) as BillingModeId[];

/** The three modes as radio cards; the consequence follows the live pick. */
export function BillingModeField({
  defaultValue,
  timezone,
}: {
  defaultValue: BillingModeId;
  timezone: string | null;
}) {
  const [mode, setMode] = useDefaultState<string>(defaultValue);
  const midnight = mode === "day_based_legacy";
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <RadioField
        name="billing_mode"
        ariaLabel="Billing mode"
        value={mode}
        onValueChange={setMode}
        className={cn(
          "grid-cols-1",
          "*:relative *:rounded-xl *:border *:px-4 *:py-3.5",
          "*:has-[[data-state=checked]]:border-primary *:has-[[data-state=checked]]:bg-primary/5",
          // The whole card is the label's hit area.
          "[&_label]:after:absolute [&_label]:after:inset-0 [&_label]:after:content-['']",
        )}
        options={IDS.map((id) => ({
          value: id,
          label: BILLING_MODES[id].label,
          hint: BILLING_MODES[id].help,
        }))}
      />
      <Consequence>
        {midnight
          ? timezone
            ? `Terms start at midnight in ${timezone} and prorate in whole days.`
            : "No time zone is set, so terms start at midnight UTC."
          : mode === "day_based"
            ? "Terms start at the signup instant. Prorated credits and charges count whole days from that time of day."
            : "Terms start at the signup instant and prorate to the millisecond."}
      </Consequence>
    </div>
  );
}
