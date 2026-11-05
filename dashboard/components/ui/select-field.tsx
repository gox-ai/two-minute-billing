"use client";

import * as React from "react";
import { useDefaultState, useFormResetSync } from "@/lib/use-default-state";

import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The form-safe Select.
 *
 * Radix `Select` cannot represent an empty option — `<SelectItem value="">`
 * throws — but this app has 21 `<option value="">` native options ("All product
 * groups", "No manual discount", "— none —"). Converting those naively either
 * crashes or silently posts a sentinel string where the server action expects an
 * empty value, which on a billing form means charging the wrong thing.
 *
 * So the empty choice is mapped to a private sentinel for Radix's benefit only,
 * and the REAL value is posted through a hidden input. `''` in, `''` out — server
 * actions and Zod schemas need no changes.
 *
 * Works uncontrolled (pass `name` + `defaultValue`, as in a server-action form)
 * or controlled (pass `value` + `onValueChange`).
 */
const EMPTY = "__empty__";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  /** Optional group heading; consecutive options sharing one are grouped. */
  group?: string;
}

export function SelectField({
  name,
  options,
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  placeholder,
  className,
  id,
  ariaLabel,
  disabled,
  required,
  size = "default",
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  name?: string;
  options: SelectOption[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  /**
   * Trigger height: 36px default, 32px `sm`. Use `sm` in a compact toolbar so the
   * select lines up with the 32px inputs beside it — shadcn sets the height with
   * `data-[size=default]:h-9`, which out-specifies a plain `h-8` in `className`,
   * so passing a height that way silently does nothing (it left the Events filter
   * bar's select 4px taller than everything beside it).
   */
  size?: "sm" | "default";
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [internal, setInternal] = useDefaultState(defaultValue);

  /**
   * Own the trigger's id instead of waiting for `Field` to clone it in.
   *
   * `Field` injects `id: children.props.id ?? name` by cloning its child, and that clone does
   * NOT reach this component during SSR — instrumented on the server: `id=undefined,
   * server=true`, while the browser pass had `id="invoice_issuer"`. So the server emitted a
   * trigger with no id, the client wanted one, and React does not patch attribute mismatches
   * ("This won't be patched up") — leaving `<label for="invoice_issuer">` pointing at an element
   * that does not exist. Clicking the label did nothing and the control had no accessible name.
   *
   * A plain `<Input>` is unaffected because the page renders it in the RSC pass, where the clone
   * does land. Deriving from `name` here is identical on both passes, so the mismatch cannot
   * occur regardless of how the clone behaves.
   */
  const triggerId = id ?? name;
  const isControlled = controlledValue !== undefined;
  const real = isControlled ? controlledValue : internal;

  const handleChange = (next: string) => {
    if (isResetting()) return;
    const normalised = next === EMPTY ? "" : next;
    if (!isControlled) setInternal(normalised);
    onValueChange?.(normalised);
  };

  /**
   * React 19 resets the form after every action and Radix answers by restoring the value the
   * control had when it MOUNTED — dragging our state, and therefore the hidden input, backwards.
   *
   * This component was believed exempt because it never hands Radix a `name`. It is not: Radix
   * renders its bubble native-select element regardless, that element participates in the form's
   * `reset`, and the restored value comes back through `onValueChange`. Measured — a saved
   * `invoice_issuer` reverted at +700ms while the server held the new value, so the next submit
   * posted the old one and silently undid the change.
   *
   * The ref sits on the root rather than the trigger so this does not depend on Radix forwarding
   * one. `useFormResetSync` re-applies in a microtask, landing after Radix's own reset listener.
   */
  const rootRef = React.useRef<HTMLDivElement>(null);
  const isResetting = useFormResetSync(rootRef, () => {
    if (!isControlled) setInternal(defaultValue);
  });

  // Group consecutive options that declare the same `group`.
  const groups: Array<{ label?: string; items: SelectOption[] }> = [];
  for (const opt of options) {
    const last = groups[groups.length - 1];
    if (last && last.label === opt.group) last.items.push(opt);
    else groups.push({ label: opt.group, items: [opt] });
  }

  // The EMPTY sentinel only has a matching <SelectItem> when some option
  // actually declares value: ''. If none does, there's no item to remap to —
  // so an empty `real` must reach Radix as '' (unclaimed by any item), which
  // is exactly what makes SelectValue fall back to the placeholder.
  const hasEmptyOption = options.some((o) => o.value === "");

  return (
    <div ref={rootRef} className={cn("relative", !name && "contents")}>
      {/*
        The actual form field. Radix's own hidden input is not used, because it would post the
        sentinel rather than the empty string.

        WHY THIS IS NOT `type="hidden"` WHEN REQUIRED. A hidden input is BARRED FROM CONSTRAINT
        VALIDATION by the HTML spec, so `required` on one is decorative: the asterisk renders and
        the browser submits the empty form anyway. Eleven call sites passed `required` believing
        it did something. On the checkout address form that meant "State *" could be left blank
        on an invoice that needs it for tax.

        So when required, it is a REAL control — kept out of sight but not out of the validation
        tree. `sr-only` and `display:none` both make it unfocusable, and Chrome then refuses to
        submit while logging "An invalid form control is not focusable", which is a worse failure
        than the one being fixed. One transparent pixel pinned under the trigger keeps it
        focusable, so the browser scrolls to it and anchors the bubble on the control the buyer
        actually sees.
      */}
      {name ? (
        required ? (
          <input
            name={name}
            value={real}
            required
            // NOT `readOnly`, and this was measured, not assumed: a readonly input is barred
            // from constraint validation exactly like a hidden one, so the first version of
            // this fix blocked nothing either. Verified in-browser — with readOnly the form
            // reported valid on an empty required select; without it the form is invalid and
            // names this control. `onChange` is the no-op React needs for a controlled input
            // the user never types into; the Radix trigger above is what actually sets it.
            onChange={() => {}}
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-3 size-px opacity-0"
          />
        ) : (
          <input type="hidden" name={name} value={real} />
        )
      ) : null}
      <Select
        value={real === "" ? (hasEmptyOption ? EMPTY : "") : real}
        onValueChange={handleChange}
        disabled={disabled}
      >
        <SelectTrigger
          id={triggerId}
          size={size}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          className={cn("w-full", className)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g, gi) =>
            g.label ? (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.items.map((o) => (
                  <SelectItem
                    key={o.value || EMPTY}
                    value={o.value === "" ? EMPTY : o.value}
                    disabled={o.disabled}
                  >
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ) : (
              g.items.map((o) => (
                <SelectItem
                  key={o.value || EMPTY}
                  value={o.value === "" ? EMPTY : o.value}
                  disabled={o.disabled}
                >
                  {o.label}
                </SelectItem>
              ))
            ),
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
