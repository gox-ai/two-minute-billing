"use client";

import * as React from "react";
import { Field } from "@/components/form/field";
import { SelectField } from "@/components/ui/select-field";
import { StateSelect } from "@/components/tax/state-select";
import { TAX_COUNTRIES } from "@/lib/countries";
import { useSubdivisions } from "@/lib/use-subdivisions";

/**
 * The "Add a taxable region" fields.
 *
 * Only India and the United States are offered. Each is supported first-class —
 * regime-aware rates and a strict state picker — and each has exactly ONE correct
 * regime, so the regime is DERIVED rather than asked for. A dropdown offering
 * "VAT" for India would be a control whose every non-default value produces a
 * wrong configuration; showing the resolved outcome instead is the honest form of
 * the same information (CLAUDE.md's copy-UI rule, `ui` skill §7).
 *
 * Countries outside this list keep working — existing flat regions still resolve —
 * they are just not offered as something NEW to configure here.
 */
const REGIME_FOR: Record<string, { value: string; label: string; blurb: string }> = {
  IN: {
    value: "gst",
    label: "GST (place of supply)",
    blurb:
      "We charge CGST + SGST/UTGST on supplies in your own state. We charge a single IGST on supplies to another state.",
  },
  US: {
    value: "sales_tax",
    label: "Sales tax",
    blurb:
      "One rate for each state where you collect tax. Add a rate for each state after you create the region.",
  },
};

export function AddRegionFields() {
  const [country, setCountry] = React.useState("IN");
  const regime = REGIME_FOR[country] ?? REGIME_FOR.IN!;
  // "State" for both today, but read from the country rather than assumed, so the
  // label stays right if a third country is ever offered here.
  const { regionLabel: countryRegionLabel } = useSubdivisions(country);

  return (
    <>
      <Field
        name="country"
        label="Country"
        required
        help="India and the United States are supported today."
      >
        <SelectField
          name="country"
          value={country}
          onValueChange={setCountry}
          options={TAX_COUNTRIES}
          ariaLabel="Country"
          required
        />
      </Field>

      {/* Derived, not chosen — posted as a hidden input so the action is unchanged. */}
      <input type="hidden" name="regime" value={regime.value} />
      <Field name="regime_display" label="Tax regime">
        <div className="rounded-md border border-border bg-muted/50 px-3 py-2">
          <p className="text-sm font-medium">{regime.label}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{regime.blurb}</p>
        </div>
      </Field>

      <Field
        name="home_state_code"
        label={`Your ${countryRegionLabel.toLowerCase()}`}
        required={country === "IN"}
        help={
          country === "IN"
            ? "The state that you supply from. It sets CGST + SGST or IGST on each invoice. GST requires it."
            : "Where your business is registered. Optional for sales tax."
        }
      >
        {/* Remounted per country so the options follow the selection rather than
            keeping a stale state from the previous country. */}
        <StateSelect
          key={country}
          name="home_state_code"
          country={country}
          required={country === "IN"}
          ariaLabel="Your registered state"
        />
      </Field>
    </>
  );
}
