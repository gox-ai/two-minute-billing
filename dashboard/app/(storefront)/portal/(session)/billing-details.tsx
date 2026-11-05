"use client";

import * as React from "react";
import { MapPin, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
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
import { invoiceContactName } from "@/lib/names";
import { portalUpdateMeAction } from "./actions";
import { Glyph, MetaField } from "../../chrome";

/**
 * The buyer's own billing name + address, viewable and editable from the portal.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE ADD-CARD GATE. `AddCard` refuses to start a
 * vault setup until `billing_details_complete`, and used to render its own copy of
 * this field set to collect it — but that form was reachable *only* while the details
 * were missing. Once saved it disappeared, so a buyer who moved office, or whose
 * address was provisioned by an API caller that sent no address at all, had no way to
 * see or correct what we print on their invoices. The engine has accepted buyer edits
 * the whole time (`PATCH /portal/v1/me` takes the full address); nothing surfaced it.
 *
 * It is not cosmetic. The address is what resolves TAX: the rate resolver's first
 * gate is the country, and for India the state decides CGST+SGST (intra-state) vs
 * IGST (inter-state). A wrong or absent address is a wrong invoice, and the buyer is
 * the only person who actually knows it.
 *
 * This section is now the ONE editor and `AddCard` merely points at it, so the two
 * surfaces cannot drift in what they require (a contact name + line1 + country) or in
 * how they validate (the shared `AddressFields`, re-checked server-side, behind the
 * same `portalUpdateMeAction`).
 *
 * ── WHY THERE IS NO "FULL NAME" FIELD ───────────────────────────────────────────
 * There used to be one, posting `customers.name` — a column no document ever printed —
 * directly above a contact block headed "shown on invoices". The buyer typed their name
 * twice and the heading was the lie: the name on the invoice is the BILLING CONTACT
 * (`src/modules/customers/names.ts`). So the contact block IS the name field now, and it is
 * the one this form makes required. `customers.name` is still writable by an operator
 * and through the API; it is simply last in every precedence chain and nothing asks a
 * buyer for it.
 */
/** The portal matrix's address keys, as `AddressFields` names them. */
const ADDRESS_KEYS: Record<AddressFieldKey, string> = {
  first_name: "customer.first_name",
  last_name: "customer.last_name",
  company: "customer.company",
  phone: "customer.phone",
  line1: "billing.line1",
  line2: "billing.line2",
  line3: "billing.line3",
  city: "billing.city",
  state: "billing.state",
  state_code: "billing.state_code",
  postal_code: "billing.postal_code",
  country: "billing.country",
};

/** The business's portal rules per field; none from an older engine, so the defaults hold. */
function portalFieldStates(
  cfg: PortalMe["field_config"],
): Partial<Record<AddressFieldKey, AddressFieldState>> | undefined {
  if (!cfg) return undefined;
  const out: Partial<Record<AddressFieldKey, AddressFieldState>> = {};
  for (const [k, key] of Object.entries(ADDRESS_KEYS) as [AddressFieldKey, string][]) {
    const v = cfg[key];
    if (v) out[k] = v;
  }
  return out;
}

export function BillingDetails({ me, countries }: { me: PortalMe; countries: Country[] }) {
  const complete = me.customer.billing_details_complete;
  const fieldStates = portalFieldStates(me.field_config);
  const taxIdState = me.field_config?.["customer.tax_registration_number"] ?? "show";
  // Incomplete details block card setup, so the form opens itself rather than
  // hiding the fix behind an "Edit" press the buyer has no reason to make.
  const [editing, setEditing] = React.useState(!complete);

  if (editing) {
    return (
      <div className="flex flex-col gap-4">
        {!complete ? (
          <Alert tone="warning" title="We need your billing address">
            Card networks require a billing name and address before you can save a payment method.
            Your address also sets the tax on your invoices.
          </Alert>
        ) : null}
        <ActionForm
          action={portalUpdateMeAction}
          onSuccess={() => setEditing(false)}
          className="flex flex-col gap-3"
        >
          {/* Same shared field set, labels and validation as the operator customer
              page. The business's portal rules decide each field; the engine enforces
              them again and keeps the stored value of a hidden or read-only field.
              `requireContactName` applies only when no rule reaches first name: with no
              "Full name" field above it, this block is the only place a name can come from. */}
          <AddressFields
            countries={countries}
            value={me.customer.address}
            requireContactName
            contactHeading="Your name (printed on your invoices)"
            fieldStates={fieldStates}
          />
          {/*
            The buyer's OWN registration number (F-23) — same field, same copy, same
            optional-no-regex rule as the checkout's equivalent (`checkout-flow.tsx`),
            so the two surfaces cannot disagree about what a valid value looks like.
            This is the ONLY self-serve way to add it once a customer already exists
            without one (API-created, imported, or a checkout run before this shipped).
          */}
          {taxIdState === "hide" ? null : taxIdState === "read_only" ? ( // Not sent at all: an absent number leaves the stored one untouched.
            <Field name="tax_registration_number" label="Tax registration number">
              <Input
                value={me.customer.tax_registration_number ?? ""}
                placeholder="Not set"
                className="font-mono"
                readOnly
                disabled
              />
            </Field>
          ) : (
            <Field
              name="tax_registration_number"
              label="Tax registration number"
              required={taxIdState === "mandatory"}
              help={
                taxIdState === "mandatory"
                  ? "GSTIN in India. To claim input tax credit, it must be on your invoice. If you add it later, invoices that you already have do not change."
                  : "GSTIN in India. This is optional. To claim input tax credit, it must be on your invoice. If you add it later, invoices that you already have do not change."
              }
            >
              <Input
                name="tax_registration_number"
                defaultValue={me.customer.tax_registration_number ?? ""}
                required={taxIdState === "mandatory"}
                maxLength={50}
                className="font-mono"
                autoComplete="off"
              />
            </Field>
          )}
          <div className="flex gap-2 pt-1">
            <Button type="submit">Save billing details</Button>
            {/* No cancel while the details are still missing: there is nothing to
                go back to, and the add-card flow below is blocked until they exist. */}
            {complete ? (
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </ActionForm>
      </div>
    );
  }

  const lines = addressDisplayLines(me.customer.address, countries);

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Glyph>
          <MapPin />
        </Glyph>
        <div className="flex min-w-0 flex-col gap-3">
          {/* What the PDF prints, resolved by the same precedence the engine uses —
              so this line and the document cannot disagree about who is billed. */}
          <MetaField label="Billed to">
            <span className="font-medium">{invoiceContactName(me.customer) ?? "—"}</span>
          </MetaField>
          <MetaField label="Billing address">
            {lines.length === 0 ? (
              <span className="text-muted-foreground">No address on file</span>
            ) : (
              <span className="block leading-relaxed whitespace-pre-line">{lines.join("\n")}</span>
            )}
          </MetaField>
          <MetaField label="Tax registration number">
            {me.customer.tax_registration_number ? (
              <span className="font-mono">{me.customer.tax_registration_number}</span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </MetaField>
        </div>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing(true)}>
        <Pencil className="size-4" />
        Edit
      </Button>
    </div>
  );
}

/**
 * Address lines in display order, empties dropped.
 *
 * Deliberately not `addressLines` from `lib/api/invoices`: that one prints the raw
 * two-letter country code, which is fine on a dense operator table and wrong on the
 * page we ask a buyer to CHECK — "IN" is not a country name to the person reading
 * it. It also has no `state_code`, which is the field a portal address may carry
 * when the printable `state` name was never filled in.
 */
function addressDisplayLines(a: PortalMe["customer"]["address"], countries: Country[]): string[] {
  const s = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const region = s(a.state) ?? s(a.state_code);
  const cityLine = [s(a.city), region, s(a.postal_code)].filter(Boolean).join(", ");
  const code = s(a.country);
  const country = code
    ? (countries.find((c) => c.code === code.toUpperCase())?.name ?? code)
    : null;
  return [s(a.company), s(a.line1), s(a.line2), s(a.line3), cityLine || null, country].filter(
    (l): l is string => Boolean(l),
  );
}
