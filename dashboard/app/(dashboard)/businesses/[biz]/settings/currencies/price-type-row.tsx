"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { SelectField } from "@/components/ui/select-field";
import { SettingRow } from "@/components/settings/settings-layout";

/** The dashboard's starting price type for a new price, with what the current choice does. */
export function PriceTypeRow({ saved }: { saved: "exclusive" | "inclusive" }) {
  const [value, setValue] = useDefaultState<string>(saved);
  return (
    <SettingRow
      label="Default price type"
      htmlFor="default_tax_behavior"
      help="What a new price starts as when you create it in the dashboard. You can change it on each price."
      control={
        <SelectField
          name="default_tax_behavior"
          value={value}
          onValueChange={setValue}
          className="w-full sm:w-96"
          options={[
            { value: "exclusive", label: "Tax exclusive — tax added on top" },
            { value: "inclusive", label: "Tax inclusive — price already includes tax" },
          ]}
        />
      }
      consequence={
        value === "inclusive"
          ? "New prices start tax inclusive: the amount you enter is what the customer pays, tax included."
          : "New prices start tax exclusive: we add tax on top of the amount you enter."
      }
      more="Existing prices keep their own setting. A currency can have its own price type on Settings → Tax. A price created through the API is tax exclusive unless it says otherwise or its currency has a price type."
    />
  );
}
