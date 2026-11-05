"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form/field";
import { Combobox } from "@/components/ui/combobox";
import type { Country } from "@/lib/countries";
import { composePhone, dialForCountry, isValidComposedPhone, splitPhone } from "@/lib/phone";
import { useDefaultState } from "@/lib/use-default-state";

/**
 * Phone entry: a dial-code picker plus the national number, posting ONE E.164 value.
 *
 * WHY A PICKER. The field was a bare text box with the help text "Include the country
 * code for international numbers", which is a request, not a guarantee — a number
 * saved without one is ambiguous, and the engine cannot validate it against any
 * country's rules. Choosing the dial code makes the country explicit, and the value
 * that reaches the API is always E.164.
 *
 * WHAT IT POSTS. A single hidden input under `name`, holding `+<dial><national>` — the
 * storage format gateways and SMS providers expect, and what `businesses.phone` and
 * the address `phone` column already hold. The two visible inputs are unnamed on
 * purpose, so a form never has to learn about the split. Empty national number posts
 * empty, so clearing the field still clears the column.
 *
 * The dial code defaults to the address country's, which is the right answer nearly
 * always and is a real resolved default rather than a placeholder — the value shown
 * is the value that will be saved.
 */
export function PhoneField({
  name,
  label = "Phone",
  countries,
  defaultValue,
  /** Country whose dial code seeds an empty field — usually the address country. */
  countryCode,
  help,
  required,
  className,
}: {
  name: string;
  label?: React.ReactNode;
  countries: Country[];
  defaultValue?: string | null;
  countryCode?: string | null;
  help?: React.ReactNode;
  required?: boolean;
  className?: string;
}) {
  const initial = React.useMemo(
    () => splitPhone(defaultValue, countries),
    [defaultValue, countries],
  );

  const seedDial = React.useMemo(() => {
    if (initial.dial) return initial.dial;
    return countries.find((c) => c.code === (countryCode ?? "").toUpperCase())?.dial_code ?? "";
  }, [initial.dial, countries, countryCode]);

  /**
   * Re-seed when the SERVER's own value moves — a save, or another form on the page causing a
   * refresh. This was the one field primitive with no re-seed at all (money and datetime both
   * have one), so it kept its mount-time number and the hidden input below posted that back.
   *
   * `compareBy` keys the re-seed on `defaultValue` alone, deliberately: `seedDial` also moves
   * with `countryCode`, and following the address country is a DIFFERENT rule that the effect
   * below owns along with its `touched` guard. Comparing on `seedDial` would let a country
   * change overwrite a dial code the user had already chosen.
   */
  const compareByDefault = React.useCallback(() => defaultValue ?? "", [defaultValue]);
  const [dial, setDial] = useDefaultState(seedDial, compareByDefault);
  const [national, setNational] = useDefaultState(initial.national, compareByDefault);

  // Follow the address country (`dialForCountry`). On checkout the phone sits above the
  // country, so a number is often typed before any dial code exists.
  const touched = React.useRef(Boolean(initial.national));
  React.useEffect(() => {
    const next = countries.find((c) => c.code === (countryCode ?? "").toUpperCase())?.dial_code;
    if (next) setDial((d) => dialForCountry(d, touched.current, next));
  }, [countryCode, countries]);

  /**
   * One entry per DIAL CODE, not per country: +1 is shared by the US, Canada and ~20
   * Caribbean states, so a country-keyed list would show twenty identical "+1" rows.
   *
   * THE LABEL IS THE BARE CODE and the countries are the row's hint, which is the split a
   * searchable picker makes possible and a plain select did not. As one `+65 · Singapore`
   * string it was unfindable: Radix's typeahead matches the START of the label, so typing
   * "65" matched nothing (every label starts `+`) and typing "singapore" matched nothing
   * either. Now the code is what the trigger shows — the only part that fits beside the
   * number input — and the country names are search terms.
   *
   * Sorted NUMERICALLY. The old `localeCompare` on the rendered label ordered these as
   * text, which interleaves `+1`, `+20`, `+211`, `+212`, `+27` in a list you could not
   * search — the two defects compounded.
   */
  const options = React.useMemo(() => {
    const byDial = new Map<string, string[]>();
    for (const c of countries) {
      if (!c.dial_code) continue;
      byDial.set(c.dial_code, [...(byDial.get(c.dial_code) ?? []), c.name]);
    }
    return [...byDial.entries()]
      .map(([d, names]) => ({
        value: d,
        label: `+${d}`,
        hint:
          names.length > 2
            ? `${names.slice(0, 2).join(", ")} +${names.length - 2}`
            : names.join(", "),
        keywords: names.join(" "),
      }))
      .sort((a, b) => Number(a.value) - Number(b.value) || a.value.localeCompare(b.value));
  }, [countries]);

  // What posts: E.164, with a typed trunk 0 or repeated dial code dropped (`composePhone`).
  const value = composePhone(dial, national, countries);
  const error =
    value && !isValidComposedPhone(value, countries) ? "Enter a valid phone number" : undefined;
  const missingDial = national.trim() && !value && !dial ? "Select a country code" : undefined;

  return (
    /* Field takes exactly ONE child: it clones it to inject `id` / `aria-invalid`,
       and with two children it silently renders them as-is instead — so the hidden
       input lives outside, and the visible number input carries the id the label
       points at. */
    <div className={className}>
      <Field name={name} label={label} help={help} required={required} error={error ?? missingDial}>
        <div className="flex gap-2">
          <Combobox
            value={dial}
            onValueChange={setDial}
            ariaLabel="Country dial code"
            placeholder="Code"
            searchPlaceholder="Search country or code…"
            emptyMessage="No matching country."
            // Narrower than the 176px the old select needed, because the trigger now shows
            // just `+65` instead of `+65 · Singapore` truncated mid-word.
            className="w-28 shrink-0"
            contentClassName="w-72"
            options={options}
          />
          <Input
            id={name}
            type="tel"
            value={national}
            onChange={(e) => {
              touched.current = true;
              setNational(e.target.value);
            }}
            maxLength={20}
            // `required` belongs on THIS input, not just on the label. The posted value is the
            // hidden composed field below, and a hidden input is barred from constraint
            // validation — so marking only the Field would draw an asterisk the browser never
            // enforces. This input is unnamed, which does not matter: validation applies to the
            // control, not to whether it posts.
            required={required}
            autoComplete="tel-national"
            /* NO EXAMPLE NUMBER. This said "98765 43210" — an Indian mobile — in a
               primitive the operator dashboard, checkout and the buyer portal all share,
               so a US or EU merchant's customers were shown a format their own number
               does not have. There is no per-country example to swap in (the country
               reference carries `postal_hint`, nothing equivalent for phone), and the
               labelled field beside a dial-code chooser is already unambiguous. An
               example that is right for one launch market and wrong everywhere else is
               worse than none. */
            aria-label={typeof label === "string" ? label : "Phone number"}
            className="flex-1"
          />
        </div>
      </Field>
      {/* The only named input: what the form actually posts. */}
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
