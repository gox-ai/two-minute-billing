"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { SwitchField } from "@/components/ui/switch";
import { useDefaultState } from "@/lib/use-default-state";

/**
 * A settings switch with its state spelled out beside it ("On" / "Off", or `text`).
 * Same form contract as `SwitchField`: with `name`, a hidden input posts "on" only
 * while checked. Controlled (`checked` + `onCheckedChange`) or not (`defaultChecked`).
 */
export function SettingSwitch({
  name,
  label,
  defaultChecked,
  checked,
  onCheckedChange,
  text,
  disabled,
  className,
}: {
  name?: string;
  /** Accessible name. */
  label: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Visible text instead of On/Off — e.g. the setting's own name in a group header. */
  text?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const [internal, setInternal] = useDefaultState(!!defaultChecked);
  const controlled = checked !== undefined;
  const on = controlled ? checked : internal;
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm font-medium", className)}>
      <SwitchField
        name={name}
        checked={on}
        disabled={disabled}
        ariaLabel={label}
        className="touch-target relative"
        onCheckedChange={(next) => {
          if (!controlled) setInternal(next);
          onCheckedChange?.(next);
        }}
      />
      <span aria-hidden={text ? undefined : true} className={cn(!text && "whitespace-nowrap")}>
        {text ?? (on ? "On" : "Off")}
      </span>
    </span>
  );
}
