"use client";

import * as React from "react";
import { SelectAnswer } from "@/components/patterns/settings-page";
import { SettingRow } from "@/components/settings/settings-layout";

const OPTIONS = [
  { value: "exclusive", label: "Tax exclusive" },
  { value: "inclusive", label: "Tax inclusive" },
];

/**
 * One currency's price type. A currency with no saved value shows what it resolves to
 * (tax exclusive) and posts `behavior_<CUR>_unset`, so Save leaves it unset until the
 * operator changes the select: writing the shown value would also change where the
 * dashboard's new-price form starts for this currency.
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
            ? `A new ${currency} price through the API is tax exclusive. In the dashboard, a new price starts as ${dashboardDefault === "inclusive" ? "tax inclusive" : "tax exclusive"}, the default price type, until you change this value.`
            : `A new ${currency} price starts with this price type, in the dashboard and through the API. You can change it on each price. Existing prices keep their price type.`
        }
        placement="end"
        control={
          <SelectAnswer
            name={name}
            defaultValue={saved ?? "exclusive"}
            ariaLabel={`${currency} price type`}
            options={OPTIONS}
            onValueChange={() => setTouched(true)}
          />
        }
      />
    </>
  );
}
