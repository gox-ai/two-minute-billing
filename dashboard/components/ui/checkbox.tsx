"use client";

import * as React from "react";
import { useDefaultState, useFormResetSync } from "@/lib/use-default-state";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Checkbox. Replaces the native OS widget, of which the app had 31 across 28
 * files — an unstyled control sitting next to designed ones is the loudest
 * "unfinished" signal in the whole dashboard.
 *
 * Supports the indeterminate state (`checked="indeterminate"`), which the native
 * element could only express through an imperative DOM property.
 *
 * This is the bare control. For anything inside a server-action form, use
 * {@link CheckboxField}, which handles form submission correctly.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer touch-target relative size-4 shrink-0 rounded-[4px] border border-input bg-card shadow-xs transition-shadow outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "data-[state=checked]:border-solid data-[state=checked]:bg-solid data-[state=checked]:text-solid-foreground",
        "data-[state=indeterminate]:border-solid data-[state=indeterminate]:bg-solid data-[state=indeterminate]:text-solid-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {props.checked === "indeterminate" ? (
          <Minus className="size-3.5" />
        ) : (
          <Check className="size-3.5" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/**
 * Form-safe checkbox with its label and optional hint.
 *
 * The native element posts nothing at all when unchecked, and every server
 * action in this app reads `formData.get('x') === 'on'`. A wrapper that always
 * emitted a hidden input would therefore change behaviour: unchecked would post
 * `''` instead of being absent, and any `formData.has(...)` check would flip.
 *
 * So the hidden input is rendered ONLY while checked — byte-for-byte the same
 * FormData the native element produced. Server actions need no changes.
 *
 * Note the deliberate exception: forms using the `<field>_present` sentinel
 * pattern (see `app/actions.ts`) keep their own separate hidden input, because
 * that sentinel distinguishes "false" from "not submitted" and is orthogonal
 * to this.
 */
function CheckboxField({
  name,
  value = "on",
  label,
  hint,
  defaultChecked,
  checked: controlledChecked,
  onCheckedChange,
  disabled,
  className,
}: {
  name?: string;
  /** Submitted value while checked. Actions compare against 'on'. */
  value?: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  defaultChecked?: boolean;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = React.useId();
  const [internal, setInternal] = useDefaultState(!!defaultChecked);
  const isControlled = controlledChecked !== undefined;
  const on = isControlled ? controlledChecked : internal;

  // React 19 resets the form after every server action — see `useFormResetSync`.
  const ref = React.useRef<HTMLDivElement>(null);
  const isResetting = useFormResetSync(ref, () => {
    if (!isControlled) setInternal(!!defaultChecked);
  });

  const handle = (next: boolean | "indeterminate") => {
    if (isResetting()) return;
    const bool = next === true;
    if (!isControlled) setInternal(bool);
    onCheckedChange?.(bool);
  };

  return (
    <div ref={ref} className={cn("flex items-start gap-2.5", className)}>
      {name && on ? <input type="hidden" name={name} value={value} /> : null}
      <Checkbox
        id={id}
        checked={on}
        onCheckedChange={handle}
        disabled={disabled}
        className="mt-0.5"
      />
      {label || hint ? (
        <div className="flex min-w-0 flex-col gap-0.5">
          {label ? (
            <label
              htmlFor={id}
              className={cn("text-sm font-medium", disabled ? "opacity-50" : "cursor-pointer")}
            >
              {label}
            </label>
          ) : null}
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export { Checkbox, CheckboxField };
