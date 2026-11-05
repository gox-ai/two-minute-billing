"use client";

import * as React from "react";
import { useDefaultState, useFormResetSync } from "@/lib/use-default-state";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Radio group. Replaces the native OS widget (21 across the app, 5 on the
 * create-subscription form alone).
 *
 * `RadioOption` is the shape this app actually needs: a label with a one-line
 * consequence underneath. Billing choices change what gets charged, so an
 * unexplained radio is a trap — see the copy-UI rule in CLAUDE.md.
 *
 * For server-action forms use {@link RadioField}, which posts the selected value.
 */
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "touch-target relative aspect-square size-4 shrink-0 rounded-full border border-input bg-card shadow-xs transition-[color,box-shadow] outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "data-[state=checked]:border-4 data-[state=checked]:border-solid",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A labelled radio with an optional consequence line. Use this rather than
 * hand-assembling a label around `RadioGroupItem`, so every option in the app
 * explains itself the same way.
 *
 * `icon` adds a third column — a glyph tile between the control and the label,
 * spanning both rows so the label and its consequence line stay one block beside
 * it. It exists for the payment-method chooser, where the options are KINDS of
 * thing (a card, a phone app, a bank) and the glyph is what the buyer scans for.
 * Decorative by definition: the label already names the option, so callers pass
 * an `aria-hidden` tile.
 */
function RadioOption({
  value,
  label,
  hint,
  icon,
  disabled,
  className,
}: {
  value: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** Decorative glyph between the radio and the label. */
  icon?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div
      className={cn(
        "grid items-start gap-x-3 gap-y-1",
        icon ? "grid-cols-[1rem_auto_1fr]" : "grid-cols-[1rem_1fr]",
        className,
      )}
    >
      <RadioGroupItem
        id={id}
        value={value}
        disabled={disabled}
        className={cn(icon ? "row-span-2 self-center" : "mt-0.5")}
      />
      {icon ? (
        <span className={cn("row-span-2 self-center", disabled ? "opacity-50" : undefined)}>
          {icon}
        </span>
      ) : null}
      <label
        htmlFor={id}
        className={cn("text-sm font-medium", disabled ? "opacity-50" : "cursor-pointer")}
      >
        {label}
      </label>
      {hint ? (
        <p className={cn("text-xs text-muted-foreground", icon ? "col-start-3" : "col-start-2")}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface RadioFieldOption {
  value: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}

/**
 * Form-safe radio group.
 *
 * Posts through an explicit hidden input rather than relying on the primitive's
 * internal bubbling, so what reaches the server is obvious from reading this
 * file. An empty `value` is legal here (unlike Select) — several forms use `''`
 * to mean "inherit from the customer", and that must post as an empty string.
 */
function RadioField({
  name,
  options,
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  className,
  ariaLabel,
}: {
  name?: string;
  options: RadioFieldOption[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const [internal, setInternal] = useDefaultState(defaultValue);
  const isControlled = controlledValue !== undefined;
  const current = isControlled ? controlledValue : internal;

  // React 19 resets the form after every server action — see `useFormResetSync`.
  const ref = React.useRef<HTMLDivElement>(null);
  const isResetting = useFormResetSync(ref, () => {
    if (!isControlled) setInternal(defaultValue);
  });

  const handle = (next: string) => {
    if (isResetting()) return;
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  };

  return (
    <>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <RadioGroup
        ref={ref}
        value={current}
        onValueChange={handle}
        aria-label={ariaLabel}
        className={className}
      >
        {options.map((o) => (
          <RadioOption
            key={o.value || "__empty"}
            value={o.value}
            label={o.label}
            hint={o.hint}
            disabled={o.disabled}
          />
        ))}
      </RadioGroup>
    </>
  );
}

export { RadioGroup, RadioGroupItem, RadioOption, RadioField };
