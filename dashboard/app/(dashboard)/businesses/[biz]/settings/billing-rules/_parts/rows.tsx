"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { SelectField } from "@/components/ui/select-field";
import { SettingRow } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { CheckboxField } from "@/components/ui/checkbox";

export interface Choice {
  value: string;
  label: string;
  /** What this value does, shown under the control while it is picked. */
  consequence?: React.ReactNode;
}

/** A select setting whose consequence follows the live (unsaved) pick. */
export function ChoiceRow({
  name,
  label,
  help,
  more,
  options,
  defaultValue,
  value: controlled,
  onValueChange,
  children,
}: {
  name: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  more?: React.ReactNode;
  options: Choice[];
  defaultValue?: string;
  /** Controlled use, for a page whose other rows react to this one. */
  value?: string;
  onValueChange?: (v: string) => void;
  children?: React.ReactNode;
}) {
  const [internal, setInternal] = useDefaultState(defaultValue ?? "");
  const value = controlled ?? internal;
  const picked = options.find((o) => o.value === value);
  return (
    <SettingRow
      label={label}
      htmlFor={name}
      help={help}
      more={more}
      errorFor={name}
      control={
        <div className="max-w-sm">
          <SelectField
            name={name}
            value={value}
            onValueChange={(v) => {
              if (controlled === undefined) setInternal(v);
              onValueChange?.(v);
            }}
            options={options.map(({ value: v, label: l }) => ({ value: v, label: l }))}
          />
        </div>
      }
      consequence={picked?.consequence}
    >
      {children}
    </SettingRow>
  );
}

/**
 * A choice whose value may not be saved yet. It shows `defaultValue` and marks it with
 * `<name>_unset`, so a Save of other rows does not store it; a change of the select, or the
 * "Save" checkbox, stores it.
 */
export function UnsavedChoiceRow({
  saved,
  saveLabel,
  ...row
}: React.ComponentProps<typeof ChoiceRow> & { saved: boolean; saveLabel: string }) {
  const [touched, setTouched] = React.useState(false);
  return (
    <>
      {!saved && !touched ? (
        <input type="hidden" name={`${row.name}_unset`} value={row.defaultValue ?? ""} />
      ) : null}
      <ChoiceRow {...row} onValueChange={() => setTouched(true)}>
        {saved || touched ? null : <CheckboxField name={`${row.name}_save`} label={saveLabel} />}
      </ChoiceRow>
    </>
  );
}

/** A switch setting whose consequence follows the live (unsaved) state. */
export function SwitchRow({
  name,
  label,
  help,
  more,
  defaultChecked,
  on,
  off,
}: {
  name: string;
  label: string;
  help?: React.ReactNode;
  more?: React.ReactNode;
  defaultChecked: boolean;
  on: React.ReactNode;
  off: React.ReactNode;
}) {
  const [checked, setChecked] = useDefaultState(defaultChecked);
  return (
    <SettingRow
      label={label}
      help={help}
      more={more}
      placement="end"
      control={
        <SettingSwitch name={name} label={label} checked={checked} onCheckedChange={setChecked} />
      }
      consequence={checked ? on : off}
    />
  );
}
