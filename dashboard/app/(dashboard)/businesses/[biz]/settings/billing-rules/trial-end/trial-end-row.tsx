"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { SettingRow } from "@/components/settings/settings-layout";
import { SelectAnswer } from "@/components/patterns/settings-page";
import type { Choice } from "../_parts/rows";

/** The trial-end action, end-placed, with the consequence of the live pick. */
export function TrialEndRow({
  defaultValue,
  options,
}: {
  defaultValue: string;
  options: Choice[];
}) {
  const [value, setValue] = useDefaultState(defaultValue);
  return (
    <SettingRow
      label="When a trial ends"
      htmlFor="trial_end_action"
      help="A plan price can set its own trial-end action. That action wins."
      placement="end"
      errorFor="trial_end_action"
      control={
        <SelectAnswer
          name="trial_end_action"
          ariaLabel="When a trial ends"
          value={value}
          onValueChange={setValue}
          options={options.map(({ value: v, label }) => ({ value: v, label }))}
        />
      }
      consequence={options.find((o) => o.value === value)?.consequence}
      more="When you end a trial from the subscription page, we always activate the subscription."
    />
  );
}
