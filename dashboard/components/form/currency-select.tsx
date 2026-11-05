"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field } from "@/components/form/field";

const POPULAR = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "JPY"];

function allCurrencies(): string[] {
  try {
    return Intl.supportedValuesOf("currency");
  } catch {
    return POPULAR;
  }
}

const names = new Intl.DisplayNames(["en"], { type: "currency" });

function label(code: string): string {
  const name = names.of(code);
  return name && name !== code ? `${code} — ${name}` : code;
}

/**
 * ISO-4217 currency picker that submits like a native form field (Radix
 * renders a hidden input with `name`). Popular currencies are pinned on top.
 */
export function CurrencySelect({
  name = "currency",
  defaultValue,
  placeholder = "Currency",
  allowEmpty = false,
  options,
  className,
  exclude,
  value,
  onValueChange,
  id,
}: {
  name?: string;
  /** Trigger id for `<label for>`; defaults to `name` (Field's clone doesn't reach a client primitive). */
  id?: string;
  defaultValue?: string | null;
  placeholder?: string;
  /** Render a "None" choice that submits an empty value (for optional fields). */
  allowEmpty?: boolean;
  /** Restrict to these codes (a business's enabled currencies). Null/empty = full ISO list. */
  options?: string[] | null;
  className?: string;
  /**
   * Codes to leave OUT — the currencies a business already has, so an "add currency"
   * picker cannot offer a duplicate that the write would then have to reject. Applied on
   * top of `options`, so the two compose.
   */
  exclude?: string[] | null;
  /**
   * Controlled mode. Pass both to let the caller react to the choice — e.g. the
   * credit dialogs, which show the customer's live balance in the picked currency
   * so "Set balance to" previews the real delta. Omit both for uncontrolled use.
   */
  value?: string;
  onValueChange?: (v: string) => void;
}) {
  const omit = React.useMemo(() => new Set((exclude ?? []).map((c) => c.toUpperCase())), [exclude]);
  const restricted =
    options && options.length > 0
      ? options.map((c) => c.toUpperCase()).filter((c) => !omit.has(c))
      : null;
  const popular = POPULAR.filter((c) => !omit.has(c));
  const rest = React.useMemo(
    () => allCurrencies().filter((c) => !POPULAR.includes(c) && !omit.has(c)),
    [omit],
  );
  // Radix warns if a Select gets both `value` and `defaultValue`.
  const controlled = value !== undefined;
  return (
    <Select
      name={name}
      {...(controlled
        ? { value, onValueChange }
        : { defaultValue: defaultValue?.toUpperCase() || undefined, onValueChange })}
    >
      <SelectTrigger id={id ?? name} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-72">
        {allowEmpty ? (
          <>
            <SelectItem value=" ">None</SelectItem>
            <SelectSeparator />
          </>
        ) : null}
        {restricted ? (
          restricted.map((c) => (
            <SelectItem key={c} value={c}>
              {label(c)}
            </SelectItem>
          ))
        ) : (
          <>
            <SelectGroup>
              <SelectLabel>Popular</SelectLabel>
              {popular.map((c) => (
                <SelectItem key={c} value={c}>
                  {label(c)}
                </SelectItem>
              ))}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>All currencies</SelectLabel>
              {rest.map((c) => (
                <SelectItem key={c} value={c}>
                  {label(c)}
                </SelectItem>
              ))}
            </SelectGroup>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * Multi-currency editor for business settings: a chip list of enabled
 * currencies plus a picker to add more. Submits one hidden `name` input per
 * selected code; with none selected the field is omitted (= unrestricted).
 */
export function CurrenciesField({
  name = "currencies",
  defaultValue,
  baseCurrency,
  rates,
  options,
  emptyHint,
}: {
  name?: string;
  defaultValue?: string[] | null;
  /** The currencies that may be added; null = every ISO currency. */
  options?: string[] | null;
  /** What an empty selection means, when the default text is not true here. */
  emptyHint?: string;
  /** When set, each non-base currency gets a reporting FX-rate input (1 base = rate × currency). */
  baseCurrency?: string | null;
  /** Existing rates keyed by currency code. */
  rates?: Record<string, number> | null;
}) {
  const [selected, setSelected] = useDefaultState<string[]>(
    (defaultValue ?? []).map((c) => c.toUpperCase()),
    (codes) => codes.join(","),
  );
  // Keyed on the codes, not the array: a server re-render hands over a new array each time.
  const optionKey = options ? options.join(",").toUpperCase() : null;
  const available = React.useMemo(
    () =>
      optionKey !== null
        ? [...new Set(optionKey.split(",").filter(Boolean))]
        : [...POPULAR, ...allCurrencies().filter((c) => !POPULAR.includes(c))],
    [optionKey],
  );
  const addable = available.filter((c) => !selected.includes(c));
  const base = baseCurrency?.toUpperCase() ?? null;
  return (
    <div className="flex flex-col gap-2">
      {selected.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {selected.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <span className="inline-flex w-24 items-center justify-between gap-1 rounded-md border bg-muted px-2 py-1 text-xs font-medium">
                {c}
                {c === base ? <span className="text-xs text-muted-foreground">base</span> : null}
                <input type="hidden" name={name} value={c} />
                <button
                  type="button"
                  aria-label={`Remove ${c}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setSelected((s) => s.filter((x) => x !== c))}
                >
                  ×
                </button>
              </span>
              {base && c !== base ? (
                <Field
                  name={`rate_${c}`}
                  label={`1 ${base} =`}
                  help={c}
                  className="flex flex-1 items-center gap-1.5"
                >
                  <input
                    type="number"
                    name={`rate_${c}`}
                    step="any"
                    min="0"
                    defaultValue={rates?.[c] ?? ""}
                    placeholder="rate"
                    className="h-7 w-28 rounded-md border bg-card px-2 text-xs tabular-nums"
                  />
                </Field>
              ) : null}
            </div>
          ))}
          {base ? (
            <span className="text-xs text-muted-foreground">
              Rates are for reporting only. Dashboards use them to convert other currencies to{" "}
              {base}. Charges always settle in their own currency.
            </span>
          ) : null}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">
          {emptyHint ??
            (options
              ? "No restriction. All currencies of this business are allowed."
              : "No restriction. All ISO currencies are allowed.")}
        </span>
      )}
      {addable.length === 0 ? null : (
        <Select value="" onValueChange={(c) => setSelected((s) => (s.includes(c) ? s : [...s, c]))}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Add a currency…" />
          </SelectTrigger>
          <SelectContent position="popper" className="max-h-72">
            {addable.map((c) => (
              <SelectItem key={c} value={c}>
                {label(c)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
