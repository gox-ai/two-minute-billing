"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { useDefaultState, useFormResetSync } from "@/lib/use-default-state";

import { cn } from "@/lib/utils";

/**
 * Switch — for settings that take effect immediately.
 *
 * Use a Switch only when the change applies on toggle. A choice that needs the
 * form to be saved is a Checkbox: a switch that silently did nothing until
 * "Save" was pressed is exactly the kind of lying control CLAUDE.md forbids.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "data-[state=checked]:bg-solid data-[state=unchecked]:bg-switch-off",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-card ring-0 transition-transform",
          "data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

/**
 * Form-safe switch. Same contract as `CheckboxField`: the hidden input exists
 * only while on, so FormData matches what the native checkbox produced and
 * `formData.get(name) === 'on'` keeps working unchanged.
 */
function SwitchField({
  name,
  value = "on",
  defaultChecked,
  checked: controlledChecked,
  onCheckedChange,
  disabled,
  ariaLabel,
  className,
}: {
  name?: string;
  value?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [internal, setInternal] = useDefaultState(!!defaultChecked);
  const isControlled = controlledChecked !== undefined;
  const on = isControlled ? controlledChecked : internal;

  // React 19 resets the form after every server action and Radix answers by
  // restoring its mount-time value — see `useFormResetSync`.
  const ref = React.useRef<HTMLButtonElement>(null);
  const isResetting = useFormResetSync(ref, () => {
    if (!isControlled) setInternal(!!defaultChecked);
  });

  return (
    <>
      {name && on ? <input type="hidden" name={name} value={value} /> : null}
      <Switch
        ref={ref}
        checked={on}
        disabled={disabled}
        aria-label={ariaLabel}
        className={className}
        onCheckedChange={(next) => {
          if (isResetting()) return;
          if (!isControlled) setInternal(next);
          onCheckedChange?.(next);
        }}
      />
    </>
  );
}

export { Switch, SwitchField };
