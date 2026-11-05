"use client";

import * as React from "react";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { SettingRow } from "@/components/settings/settings-layout";

const OPTIONS = [
  { value: "exclusive", label: "Tax exclusive — tax added on top" },
  { value: "inclusive", label: "Tax inclusive — price already includes tax" },
];

/**
 * One currency's price type. A currency with no saved value posts `behavior_<CUR>_unset`
 * and stays unset on save, unless the operator changes the select or ticks "Save this
 * value": an unset currency follows the API's real fallback (exclusive), and writing the
 * preselected value would change it for every API-created price.
 */
export function CurrencyPriceTypeRow({
  currency,
  saved,
  dashboardDefault,
}: {
  currency: string;
  saved: "inclusive" | "exclusive" | null;
  /** What the dashboard's new-price form starts with for an unset currency. */
  dashboardDefault: "inclusive" | "exclusive";
}) {
  const [touched, setTouched] = React.useState(false);
  const name = `behavior_${currency}`;
  const unset = saved === null && !touched;
  return (
    <>
      {unset ? <input type="hidden" name={`${name}_unset`} value="1" /> : null}
      <SettingRow
        label={currency}
        htmlFor={name}
        help={
          saved === null
            ? `Not set. A new ${currency} price through the API is tax exclusive. In the dashboard, a new price starts as ${dashboardDefault === "inclusive" ? "tax inclusive" : "tax exclusive"}, the default price type.`
            : `A new ${currency} price starts with this price type, in the dashboard and through the API. You can change it on each price. Existing prices keep their price type.`
        }
        control={
          <div className="flex w-full flex-col gap-2 sm:w-96">
            <SelectField
              name={name}
              defaultValue={saved ?? "exclusive"}
              ariaLabel={`${currency} price type`}
              className="w-full"
              options={OPTIONS}
              onValueChange={() => setTouched(true)}
            />
            {unset ? <CheckboxField name={`${name}_save`} label="Save this value" /> : null}
          </div>
        }
      />
    </>
  );
}
