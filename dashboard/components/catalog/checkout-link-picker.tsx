"use client";

import * as React from "react";
import { SelectField, type SelectOption } from "@/components/ui/select-field";
import { SecretLinkButton } from "@/components/patterns/secret-link-button";
import type { SecretLinkResult } from "@/lib/secret-link";

/** One price picker and one mint button, instead of a button per price. */
export function CheckoutLinkPicker({
  options,
  mint,
}: {
  options: SelectOption[];
  mint: (price: string) => Promise<SecretLinkResult>;
}) {
  const [price, setPrice] = React.useState(options[0]?.value ?? "");
  return (
    // Stacked on a phone: side by side, the button left the picker too narrow to read.
    <div className="flex w-full flex-col items-start gap-2 sm:w-auto sm:flex-row sm:items-center">
      <SelectField
        size="sm"
        ariaLabel="Price"
        options={options}
        value={price}
        onValueChange={setPrice}
        className="sm:w-72"
      />
      <SecretLinkButton mint={() => mint(price)}>Create checkout link</SecretLinkButton>
    </div>
  );
}
