"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { currencyExponent, majorStep, toMinor } from "@/lib/money";

/**
 * Money field in MAJOR units, with the currency code rendered inside the field
 * (`INR 0.00`). Submits integer **minor** units under `<name>` via a
 * hidden input, so the server contract stays minor while the operator types what
 * they mean.
 *
 * Why this exists: our forms asked for "Amount (minor units)", so typing `800` for
 * ₹800 created an ₹8.00 charge. Minor units are a storage decision, not a form
 * decision. The step and decimal count come from the currency's ISO-4217 exponent
 * (`lib/money.ts`), so a zero-decimal currency (JPY) gets a whole-number field
 * rather than a bogus `.00`, and a three-decimal one (KWD) gets all three.
 *
 * **Blank posts an empty string, never 0.** Several call sites treat a blank amount
 * as "the full remaining balance" (`amount_minor` omitted from the API body), and
 * every server action reading it does `if (raw === '') → undefined`. Posting a 0
 * there would turn "pay the whole invoice" into "pay nothing".
 */
export function MoneyInput({
  name,
  currency,
  required,
  defaultMajor,
  min = 0,
  max,
  placeholder,
  invalid,
  className,
  inputClassName,
  id,
  onMinorChange,
  "aria-describedby": describedBy,
  "aria-invalid": ariaInvalid,
}: {
  /**
   * Submitted field name, receiving integer MINOR units. Omit inside a modal that
   * collects its value in JS (`onMinorChange`) rather than posting — an unnamed
   * field is not submitted, which is what a draft row wants.
   */
  name?: string;
  currency: string;
  required?: boolean;
  /** Prefill in major units (e.g. a catalog price converted with `toMajorInput`). */
  defaultMajor?: number | string;
  /** Minimum in MAJOR units. 0 allows a zero amount (promo "set balance to 0"). */
  min?: number;
  /**
   * Maximum in MAJOR units — a real cap (available credit, a line's own amount),
   * enforced by native constraint validation on submit as the old minor-unit
   * `max={availableMinor}` was. Omit when there is no cap.
   */
  max?: number;
  /** Overrides the exponent-derived `0.00` placeholder (e.g. "full" where blank = full). */
  placeholder?: string;
  /** Caller-side validation failed — draws the destructive border. */
  invalid?: boolean;
  className?: string;
  /** Extra classes for the inner <input> (e.g. `text-right`). */
  inputClassName?: string;
  id?: string;
  /** Called with the minor-unit string ('' when blank/unparseable). */
  onMinorChange?: (minor: string) => void;
  "aria-describedby"?: string;
  /** Injected by <Field> when the enclosing ActionForm reported an error here. */
  "aria-invalid"?: boolean;
}) {
  const [raw, setRaw] = React.useState(defaultMajor != null ? String(defaultMajor) : "");

  // Keep the visible value when the caller re-prefills (catalog pick → amount).
  React.useEffect(() => {
    if (defaultMajor != null) setRaw(String(defaultMajor));
  }, [defaultMajor]);

  const exponent = currencyExponent(currency);
  const parsed = raw.trim() === "" ? null : Number(raw);
  const valid = parsed != null && Number.isFinite(parsed);
  const minorValue = valid ? String(toMinor(parsed, currency)) : "";

  // Held in a ref so an INLINE callback (`onMinorChange={(m) => setAlloc(…)}`) is
  // safe. Keying the effect on the callback identity re-ran it every render, and a
  // caller whose handler builds a new object (a per-row allocation map) then looped
  // forever. Only a changed minor value should notify — including when the currency
  // changes under us, since the exponent moves the minor value with it.
  const notify = React.useRef(onMinorChange);
  notify.current = onMinorChange;
  React.useEffect(() => {
    notify.current?.(minorValue);
  }, [minorValue]);

  const bad = invalid || ariaInvalid;

  return (
    <div
      className={cn(
        // h-9 to match <Input> exactly. This used to be content-height (py-2 on both
        // children + the border = 39px), so a MoneyInput sat 3px taller than every
        // other control — enough to knock the LABELS out of line in any `items-end`
        // row pairing one with a text field, and 39px is not one of the system's
        // control heights (24/28/32/36) either.
        "flex h-9 items-center rounded-md border border-input bg-transparent",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/50",
        bad && "border-destructive focus-within:border-destructive",
        className,
      )}
    >
      <span className="px-3 text-sm font-medium text-muted-foreground select-none">{currency}</span>
      <input
        // Own the id: `Field`'s clone doesn't reach a client component in the server
        // render, which left the label pointing at nothing and a hydration mismatch.
        id={id ?? name}
        type="number"
        inputMode="decimal"
        step={majorStep(currency)}
        min={min}
        max={max}
        required={required}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        aria-describedby={describedBy}
        aria-invalid={bad ? true : undefined}
        placeholder={placeholder ?? (exponent === 0 ? "0" : (0).toFixed(exponent))}
        className={cn(
          // self-stretch, not py-*: the wrapper owns the height now, and the input
          // still needs to fill it so the whole field is a click target.
          "w-full min-w-0 flex-1 self-stretch rounded-r-md bg-transparent pr-3 text-sm tabular-nums outline-none placeholder:text-muted-foreground",
          inputClassName,
        )}
      />
      {/* The wire value. Empty when the field is blank or unparseable, so the
          server's own validation reports the problem rather than receiving a 0. */}
      {name ? <input type="hidden" name={name} value={minorValue} data-money-minor={name} /> : null}
    </div>
  );
}
