"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { normalizeStateCode } from "@/lib/countries";
import { useSubdivisions } from "@/lib/use-subdivisions";

/**
 * The state / place-of-supply picker. STRICTLY SELECTABLE for the countries we ship
 * a list for (India, the US); a plain input everywhere else.
 *
 * Why it is not free text: `state_code` is what tax resolution matches on. A typo,
 * a display name ("California"), or a non-canonical variant of an Indian code resolves
 * NO place of supply — the rate component never applies and the line is taxed at
 * zero. That is a wrong number on an invoice, not a visible error, so the set of
 * enterable values has to be closed. The backend enforces the same closed set
 * (`src/platform/subdivisions.ts`); this control just makes it impossible to get
 * there by hand.
 *
 * The free-text fallback is deliberate, not laziness: for a country whose
 * subdivisions we have not verified, a half-accurate list would reject real
 * addresses. Those countries get a country-wide rate and no sub-national tax
 * anyway, so the value is a label rather than a key.
 */
export function StateSelect({
  name,
  country,
  defaultValue,
  required,
  placeholder,
  className,
  ariaLabel,
  exclude,
}: {
  name: string;
  country: string | null | undefined;
  defaultValue?: string | null;
  required?: boolean;
  placeholder?: string;
  className?: string;
  /** Mirrored onto the trigger — a <label> wrapping a button swallows the click. */
  ariaLabel?: string;
  /** Codes to hide (e.g. states already registered). */
  exclude?: readonly string[];
}) {
  const { subs, aliases, regionLabel, loading, failed, reload } = useSubdivisions(country);
  // Fold before matching so an imported code (`OD`) selects the row our
  // list calls `OR`, instead of rendering as an empty picker over a valid value.
  const current = normalizeStateCode(defaultValue, aliases);

  /**
   * A FAILED LOAD IS NOT "THIS COUNTRY HAS NONE", and treating them alike was the bug this
   * control shares with the address form (docs/PROGRESS.md § Open bugs, 2026-08-22). The
   * old rule — `loading || subs.length === 0` → free text — meant a flaky request silently
   * turned a closed set into an open one, which for a place-of-supply code is the exact
   * failure the docstring above says must not happen: a value outside the list resolves NO
   * place of supply and the line is taxed at zero, with no error anywhere.
   *
   * So the three states are now told apart: in flight → the picker, disabled; failed → the
   * picker holding whatever was stored, plus a retry; genuinely empty → free text.
   */
  if (failed) {
    return (
      <div className="space-y-1.5">
        <Combobox
          name={name}
          defaultValue={current}
          options={current ? [{ value: current, label: current }] : []}
          required={required}
          placeholder={placeholder ?? `Select ${regionLabel.toLowerCase()}`}
          emptyMessage={`We could not load the ${regionLabel.toLowerCase()} list.`}
          ariaLabel={ariaLabel}
          className={className}
        />
        <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={reload}>
          Retry
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <Combobox
        name={name}
        defaultValue={current}
        options={current ? [{ value: current, label: current }] : []}
        required={required}
        disabled
        placeholder="Loading…"
        ariaLabel={ariaLabel}
        className={className}
      />
    );
  }

  // Loaded, and genuinely empty: this country has no subdivisions we ship. Free text is
  // correct here — see the docstring on why a half-accurate list would be worse.
  if (subs.length === 0) {
    return (
      <Input
        name={name}
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder ?? "State"}
        maxLength={6}
        required={required}
        aria-label={ariaLabel}
        className={className}
      />
    );
  }

  const hidden = new Set((exclude ?? []).map((c) => normalizeStateCode(c, aliases)));
  // Never hide the value already saved — excluding it would silently blank the field
  // and the next save would clear a correct setting.
  const options = subs
    .map((s) => ({ value: s.code, label: s.name, keywords: s.code }))
    .filter((s) => !hidden.has(s.value) || s.value === current);

  return (
    <Combobox
      name={name}
      defaultValue={current}
      options={options}
      required={required}
      placeholder={placeholder ?? `Select ${regionLabel.toLowerCase()}`}
      searchPlaceholder={`Search ${regionLabel.toLowerCase()} or code…`}
      emptyMessage={`No matching ${regionLabel.toLowerCase()}.`}
      ariaLabel={ariaLabel}
      className={className}
    />
  );
}
