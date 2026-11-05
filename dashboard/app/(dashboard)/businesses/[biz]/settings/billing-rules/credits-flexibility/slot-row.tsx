"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { FieldLabel, SettingRow } from "@/components/settings/settings-layout";
import { SettingError } from "@/components/settings/setting-error";

const MODE_OPTIONS = [
  { value: "auto", label: "Auto-apply" },
  { value: "none", label: "Do not auto-apply" },
  { value: "limit", label: "Apply up to a limit" },
];

/**
 * One credit slot: a mode, and a per-invoice limit shown only for "Apply up to a
 * limit". The action reads the limit only in that mode; hidden, it still posts.
 */
export function CreditSlotRow({
  field,
  label,
  what,
  defaultMode,
  defaultLimit,
  currency,
  step,
  placeholder,
}: {
  field: string;
  label: string;
  /** "refundable credits" / "excess payments", for the consequence line. */
  what: string;
  defaultMode: string;
  defaultLimit: string;
  currency: string;
  step: string;
  placeholder: string;
}) {
  const [mode, setMode] = useDefaultState(defaultMode);
  const [limit, setLimit] = useDefaultState(defaultLimit);
  const shown = limit.trim() === "" ? null : `${limit} ${currency}`.trim();

  return (
    <SettingRow
      label={label}
      control={
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex w-full max-w-60 flex-col gap-1.5">
            <FieldLabel htmlFor={`${field}_mode`}>Applied</FieldLabel>
            <SelectField
              name={`${field}_mode`}
              value={mode}
              onValueChange={setMode}
              options={MODE_OPTIONS}
            />
          </div>
          <div className={cn("flex flex-col gap-1.5", mode !== "limit" && "hidden")}>
            <FieldLabel htmlFor={`${field}_limit`}>Limit per invoice</FieldLabel>
            <span className="inline-flex items-center gap-2">
              <Input
                id={`${field}_limit`}
                name={`${field}_limit`}
                type="number"
                min={0}
                step={step}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                placeholder={placeholder}
                className="w-32 text-right tabular-nums"
              />
              <span className="text-sm text-muted-foreground">{currency}</span>
            </span>
          </div>
        </div>
      }
      consequence={
        mode === "auto"
          ? `We apply all available ${what}, as far as the invoice can absorb them.`
          : mode === "none"
            ? `We never apply ${what} to an invoice automatically.`
            : shown
              ? `We apply at most ${shown} of ${what} to one invoice.`
              : "Enter the limit. You cannot save without a limit."
      }
    >
      <SettingError name={`${field}_limit`} />
    </SettingRow>
  );
}
