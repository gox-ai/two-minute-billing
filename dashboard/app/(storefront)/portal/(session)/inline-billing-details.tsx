"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form/field";
import { ActionForm } from "@/components/form/action-form";
import {
  AddressFields,
  type AddressFieldKey,
  type AddressFieldState,
} from "@/components/customers/address-fields";
import type { Country } from "@/lib/api/geo";
import type { PortalMe } from "@/lib/portal-api";
import { portalUpdateMeAction } from "./actions";
import { portalFieldStates, prefilled, taxIdHelp } from "./billing-details";

/** Fields the buyer always sees here: country and postal code decide the tax; city and state fill in from the postal code. */
const ALWAYS: readonly AddressFieldKey[] = [
  "country",
  "postal_code",
  "city",
  "state_code",
  "state",
];

/**
 * The few billing details that are still missing, asked inside "Add a payment method". It saves
 * through the same action and the same `AddressFields` as the Billing details editor, so the
 * rules cannot differ: the business's portal field rules decide what each field is, and
 * `billing_details_missing` (from the engine, the same check the save runs) decides which ones
 * show. Every other field posts its stored value, because a save replaces the whole address.
 * When the save succeeds the page refreshes, and the add-card row continues into the gateway form.
 */
export function InlineBillingDetails({ me, countries }: { me: PortalMe; countries: Country[] }) {
  const missing = new Set(me.customer.billing_details_missing ?? []);
  const base = portalFieldStates(me.field_config) ?? {};
  const fieldStates: Partial<Record<AddressFieldKey, AddressFieldState>> = {};
  for (const k of [
    "first_name",
    "last_name",
    "company",
    "phone",
    "line1",
    "line2",
    "line3",
    "city",
    "state",
    "state_code",
    "postal_code",
    "country",
  ] as AddressFieldKey[]) {
    const s = base[k] ?? "show";
    fieldStates[k] =
      s === "hide" || s === "read_only"
        ? s
        : ALWAYS.includes(k)
          ? s
          : missing.has(k)
            ? "mandatory"
            : "hide";
  }
  // A name that is missing is asked for, even where the portal rules leave first name optional.
  if (missing.has("first_name") && fieldStates.last_name === "hide") fieldStates.last_name = "show";

  const taxIdState = me.field_config?.["customer.tax_registration_number"] ?? "show";
  const needsTaxId = taxIdState === "mandatory" && !me.customer.tax_registration_number;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        We need a few details before you can save a payment method. They also set the tax on your
        invoices.
      </p>
      <ActionForm action={portalUpdateMeAction} className="flex flex-col gap-4">
        <AddressFields
          countries={countries}
          value={prefilled(me)}
          requireContactName
          contactHeading="Your name (printed on your invoices)"
          fieldStates={fieldStates}
        />
        {needsTaxId ? (
          <Field
            name="tax_registration_number"
            label="Tax registration number"
            required
            help={taxIdHelp(me.customer.address.country, true)}
          >
            <Input
              name="tax_registration_number"
              required
              maxLength={50}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
        ) : null}
        <div className="flex justify-end">
          <Button type="submit">Continue</Button>
        </div>
      </ActionForm>
    </div>
  );
}
