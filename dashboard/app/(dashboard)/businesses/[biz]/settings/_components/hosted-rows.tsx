"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { useFieldError } from "@/components/form/action-form";
import { ToggleAnswer } from "@/components/patterns/settings-page";
import { SettingRow } from "@/components/settings/settings-layout";

/** An input tied to its row's error message, so a screen reader announces it. */
export function ErrorLinkedInput(props: React.ComponentProps<typeof Input> & { name: string }) {
  const error = useFieldError(props.name);
  return (
    <Input
      {...props}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${props.name}-error` : undefined}
    />
  );
}

/** A switch row whose consequence follows the live value. */
export function SwitchRow({
  name,
  label,
  help,
  checked,
  onChange,
  on,
  off,
  more,
}: {
  name: string;
  label: string;
  help: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  on: React.ReactNode;
  off: React.ReactNode;
  more?: React.ReactNode;
}) {
  return (
    <SettingRow
      label={label}
      help={help}
      placement="end"
      control={
        <ToggleAnswer name={name} label={label} checked={checked} onCheckedChange={onChange} />
      }
      consequence={checked ? on : off}
      more={more}
    />
  );
}
