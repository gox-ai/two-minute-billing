"use client";

import * as React from "react";
import { createCustomer, editCustomerAction } from "@/app/actions";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MetadataField, type MetadataEditorData } from "@/components/form/metadata-field";
import { PhoneField } from "@/components/ui/phone-field";
import { CurrencySelect } from "@/components/form/currency-select";
import { AddressFields } from "@/components/customers/address-fields";
import { LocaleSelect } from "@/components/customers/locale-select";
import { CustomFieldsFields } from "@/components/customers/custom-fields-fields";
import { TaxTreatmentField } from "@/components/customers/tax-treatment-field";
import { SelectField } from "@/components/ui/select-field";
import {
  ChoiceCards,
  FormCard,
  FormFrame,
  LockedField,
  SummaryCard,
  SwitchRow,
  Wide,
  useFormModel,
} from "@/components/catalog/form-kit";
import { TREATMENT_LABEL } from "@/lib/tax-format";
import type { Crumb } from "@/components/page-header";
import type { Customer, CustomerAddress, TaxRegion, TaxTreatment } from "@/lib/api";
import type { Country } from "@/lib/api/geo";
import type { CustomFieldDefinition } from "@/lib/api/custom-fields";

const ADDRESS_KEYS = [
  "line1",
  "line2",
  "line3",
  "city",
  "state",
  "state_code",
  "postal_code",
  "country",
] as const;

type Snapshot = Record<string, string>;

/** The values the form would post right now, re-read on every edit. */
function useFormSnapshot(formRef: React.RefObject<HTMLFormElement | null>, seed: Snapshot) {
  const [snap, setSnap] = React.useState<Snapshot>(seed);
  React.useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    let queued = false;
    const read = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const next: Snapshot = {};
        new FormData(form).forEach((v, k) => {
          if (typeof v === "string") next[k] = v;
        });
        setSnap((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      });
    };
    // Primitives post through hidden inputs that change without an input event.
    const observer = new MutationObserver(read);
    observer.observe(form, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["value"],
    });
    const onReset = () => setTimeout(read, 0);
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    form.addEventListener("reset", onReset);
    read();
    return () => {
      observer.disconnect();
      form.removeEventListener("input", read);
      form.removeEventListener("change", read);
      form.removeEventListener("reset", onReset);
    };
  }, [formRef]);
  return snap;
}

function addressSeed(prefix: string, a: CustomerAddress | null | undefined): Snapshot {
  const out: Snapshot = {};
  for (const k of ADDRESS_KEYS) {
    const v = (a as Record<string, unknown> | null | undefined)?.[k];
    if (typeof v === "string") out[`${prefix}${k}`] = v;
  }
  return out;
}

function addressLine(s: Snapshot, prefix: string): string | null {
  const g = (k: string) => (s[`${prefix}${k}`] ?? "").trim();
  const region = [g("state") || g("state_code"), g("postal_code")].filter(Boolean).join(" ");
  const parts = [g("line1"), g("line2"), g("line3"), g("city"), region, g("country")].filter(
    Boolean,
  );
  return parts.length ? parts.join(", ") : null;
}

/** The dunning policy picker's data. Absent when the policies could not be read: no field renders. */
export interface CustomerDunningOptions {
  /** Live policies, plus the customer's own one when it is archived. */
  policies: Array<{ id: string; name: string; archived: boolean }>;
  /** What the business settings do, in one sentence. */
  businessLine: string;
}

export type CustomerFormProps = {
  biz: string;
  crumbs: Crumb[];
  currencies: string[] | null;
  countries: Country[];
  cfDefs: CustomFieldDefinition[];
  dunning?: CustomerDunningOptions;
} & (
  | {
      mode: "new";
      customer?: undefined;
      taxRegions?: undefined;
      /** `billing_rules_config.new_customer_auto_collection`, preselected. */
      defaultAutoCollection?: "on" | "off";
    }
  | {
      mode: "edit";
      customer: Customer;
      taxRegions: TaxRegion[];
      metadataEditor: MetadataEditorData | null;
    }
);

/** Customer create and edit: contact, billing preferences, addresses, tax, live summary. */
export function CustomerForm(props: CustomerFormProps) {
  const { biz, crumbs, currencies, countries, cfDefs, dunning } = props;
  const c = props.customer;
  const editing = props.mode === "edit";
  const formRef = React.useRef<HTMLFormElement>(null);
  const recordHref = c ? `/businesses/${biz}/customers/${c.id}` : null;
  const hasCustomFields = cfDefs.some((d) => !d.archived);

  // The two controls the kit renders controlled; everything else stays uncontrolled.
  const [v, set] = useFormModel(
    {
      auto_collection: c
        ? c.auto_collection === "off"
          ? "off"
          : "on"
        : props.mode === "new"
          ? (props.defaultAutoCollection ?? "on")
          : "on",
      tax_exempt: c?.tax_exempt ?? false,
      email_notifications: c?.email_notifications ?? true,
      dunning_excluded: c?.dunning_excluded ?? false,
      exclude_from_reporting: c?.exclude_from_reporting ?? false,
    },
    formRef,
  );

  const snap = useFormSnapshot(formRef, {
    email: c?.email ?? "",
    first_name: c?.first_name ?? "",
    last_name: c?.last_name ?? "",
    company: c?.company ?? "",
    currency: c?.currency ?? "",
    net_term_days: c ? String(c.net_term_days ?? 0) : "",
    invoice_notes: c?.invoice_notes ?? "",
    vat_number: c?.vat_number ?? "",
    withholding_rate_bps: c ? String(c.withholding_rate_bps ?? 0) : "",
    dunning_policy: c?.dunning_policy ?? "",
    ...(c?.tax_treatment ? { tax_treatment: c.tax_treatment } : {}),
    ...addressSeed("addr_", c?.address),
    ...addressSeed("ship_", c?.shipping_address),
  });

  // ── summary ──
  const t = (k: string) => (snap[k] ?? "").trim();
  const person = [t("first_name"), t("last_name")].filter(Boolean).join(" ");
  const who =
    person && t("company")
      ? `${person} at ${t("company")}`
      : person || t("company") || t("email") || "This customer";
  const currency = t("currency").toUpperCase();
  const pays = currency
    ? `pays in ${currency}`
    : c?.effective_currency
      ? `pays in ${c.effective_currency}, from their subscriptions`
      : "pays in the currency of their subscriptions";
  const net = Number(t("net_term_days")) || 0;
  const due =
    net > 0 ? `due ${net} day${net === 1 ? "" : "s"} after the invoice date` : "due on receipt";
  const collect =
    v.auto_collection === "off"
      ? `We send invoices for them to pay. Invoices are ${due}.`
      : `We charge invoices automatically. Invoices are ${due}.`;
  const billsTo = addressLine(snap, "addr_");
  const shipsTo = addressLine(snap, "ship_");
  const treatment = snap.tax_treatment as TaxTreatment | undefined;
  const bps = Number(t("withholding_rate_bps")) || 0;
  const tax = [
    v.tax_exempt ? "Tax exempt" : "Taxable",
    t("vat_number") && `VAT ${t("vat_number")}`,
    treatment && treatment !== "default" && TREATMENT_LABEL[treatment],
    bps > 0 && `Withholding ${bps / 100}%`,
  ]
    .filter(Boolean)
    .join(" · ");
  const policyName = dunning?.policies.find((p) => p.id === t("dunning_policy"))?.name;
  const dunningValue = v.dunning_excluded
    ? "Excluded"
    : policyName
      ? `Policy: ${policyName}`
      : "Business settings";

  const summary = (
    <SummaryCard
      lead={`${who} ${pays}. ${collect}`}
      rows={[
        { label: "Email", value: t("email") || "—" },
        { label: "Bills to", value: billsTo ?? "No billing address" },
        { label: "Ships to", value: shipsTo ?? "Billing address" },
        { label: "Tax", value: tax },
        { label: "Dunning", value: dunningValue },
        !!t("invoice_notes") && { label: "Invoice note", value: t("invoice_notes") },
      ]}
      note={
        editing
          ? "If another person saves this customer after you open it, Save stops. You can then reload their version."
          : "This creates the customer. Add a subscription from the customer page."
      }
    />
  );

  return (
    <ActionForm action={editing ? editCustomerAction : createCustomer} formRef={formRef}>
      <input type="hidden" name="biz" value={biz} />
      {c ? (
        <>
          <input type="hidden" name="cus" value={c.id} />
          {/* Saving the full edit returns to the record. */}
          <input type="hidden" name="return_to" value={recordHref!} />
          <input type="hidden" name="tax_fields" value="1" />
        </>
      ) : null}
      {/* Marks the shipping block present, so clearing every field CLEARS the address. */}
      <input type="hidden" name="ship_fields" value="1" />
      {/* Same marker trick: the switch posts nothing when off. */}
      <input type="hidden" name="email_fields" value="1" />
      <input type="hidden" name="dunning_fields" value="1" />
      <input type="hidden" name="reporting_fields" value="1" />
      {/* Marks the policy select present, so "Business settings" ('') posts as null. */}
      {dunning ? (
        <>
          <input type="hidden" name="dunning_policy_field" value="1" />
          <input type="hidden" name="dunning_policy_was" value={c?.dunning_policy ?? ""} />
        </>
      ) : null}
      {c?.resource_version != null ? (
        <input type="hidden" name="expected_version" value={c.resource_version} />
      ) : null}
      {/* Create posts "true"; edit's switch posts its own "on" below. */}
      {!editing && v.tax_exempt ? <input type="hidden" name="tax_exempt" value="true" /> : null}

      <FormFrame
        crumbs={crumbs}
        title={editing ? "Edit customer" : "New customer"}
        description={
          editing
            ? "Changes apply only to future invoices. Issued invoices keep the details that they were printed with."
            : "Enter who pays, how they pay and where invoices go. The customer adds payment methods from their portal."
        }
        cancelHref={recordHref ?? `/businesses/${biz}/customers`}
        submitLabel={editing ? "Save changes" : "Create customer"}
        summary={summary}
      >
        <FormCard title="Contact">
          {c ? (
            <LockedField
              label="Customer ID"
              value={c.id}
              mono
              reason="You cannot change the ID after you create the customer."
            />
          ) : (
            <LockedField
              label="Customer ID"
              value={<span className="text-muted-foreground">Generated on create</span>}
              reason="We generate the customer ID automatically."
            />
          )}
          <Field name="email" label="Email">
            <Input
              name="email"
              type="email"
              defaultValue={c?.email ?? ""}
              placeholder="email@example.com"
            />
          </Field>
          <Field name="first_name" label="First name">
            <Input
              name="first_name"
              defaultValue={c?.first_name ?? ""}
              maxLength={100}
              autoComplete="given-name"
            />
          </Field>
          <Field name="last_name" label="Last name">
            <Input
              name="last_name"
              defaultValue={c?.last_name ?? ""}
              maxLength={100}
              autoComplete="family-name"
            />
          </Field>
          <Field name="company" label="Company">
            <Input
              name="company"
              defaultValue={c?.company ?? ""}
              maxLength={200}
              autoComplete="organization"
            />
          </Field>
          {c ? (
            // Dial code + national number, posting one E.164 value; the billing country seeds the dial code.
            <PhoneField
              name="phone"
              countries={countries}
              defaultValue={c.phone}
              countryCode={c.address?.country ?? null}
            />
          ) : (
            <Field
              name="phone"
              label="Phone"
              help="Include the country code for international numbers."
            >
              <Input name="phone" placeholder="+1 555 0100" maxLength={50} autoComplete="tel" />
            </Field>
          )}
        </FormCard>

        <FormCard title="Billing preferences">
          {/* Edit never preselects a currency the record does not hold: the placeholder
              names the one in force, and None clears a pinned preference. */}
          <Field
            name="currency"
            label="Preferred currency"
            help={
              !c
                ? "We use it to select the gateway and currency for this customer."
                : c.currency
                  ? "We use it to select the gateway and currency for this customer. Select None to use the currency of their subscriptions again."
                  : "Not set. We bill in the currency of this customer’s subscriptions. Set a currency only if you want to lock it."
            }
          >
            {c ? (
              <CurrencySelect
                className="w-full"
                allowEmpty
                defaultValue={c.currency ?? undefined}
                placeholder={
                  c.effective_currency
                    ? `${c.effective_currency} (from subscriptions)`
                    : "Select currency"
                }
                options={currencies}
              />
            ) : (
              <CurrencySelect
                className="w-full"
                placeholder="Select currency"
                options={currencies}
              />
            )}
          </Field>
          <Field
            name="locale"
            label="Language / locale"
            help="We store it on the customer for invoices and emails."
          >
            <LocaleSelect defaultValue={c?.locale} className="w-full" />
          </Field>
          <Wide>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Auto-collection</span>
              <ChoiceCards
                name="auto_collection"
                ariaLabel="Auto-collection"
                value={v.auto_collection}
                onValueChange={(x) => set("auto_collection", x === "off" ? "off" : "on")}
                options={[
                  {
                    value: "on",
                    label: "On",
                    hint: "Charge the customer’s payment method when we create an invoice",
                  },
                  {
                    value: "off",
                    label: "Off: send the invoice",
                    hint: "We send the invoice and the customer pays it",
                  },
                ]}
              />
            </div>
          </Wide>
          <Wide>
            <SwitchRow
              name="email_notifications"
              label="Email notifications"
              hint="Send automatic billing emails, such as invoices, receipts and reminders. When this is disabled, you can still send them yourself."
              checked={v.email_notifications}
              onCheckedChange={(x) => set("email_notifications", x)}
            />
          </Wide>
          <Wide>
            <SwitchRow
              name="dunning_excluded"
              label="Exclude from dunning"
              hint="Do not retry failed payments or send payment reminders for this customer. The first payment attempt on a new invoice still occurs. When you disable this, dunning continues on the open invoices."
              checked={v.dunning_excluded}
              onCheckedChange={(x) => set("dunning_excluded", x)}
            />
          </Wide>
          <Wide>
            <SwitchRow
              name="exclude_from_reporting"
              label="Exclude from reports"
              hint="For an internal or test account. We do not count this customer in MRR, churn, revenue, payments or other reports. Billing does not change. Reports show the change after a short time."
              checked={v.exclude_from_reporting}
              onCheckedChange={(x) => set("exclude_from_reporting", x)}
            />
          </Wide>
          {dunning ? (
            <Wide>
              <Field
                name="dunning_policy"
                label="Dunning policy"
                help={
                  <>
                    Business settings: {dunning.businessLine}
                    {v.dunning_excluded
                      ? " This customer is excluded from dunning, so no policy applies."
                      : ""}
                  </>
                }
              >
                <SelectField
                  name="dunning_policy"
                  ariaLabel="Dunning policy"
                  defaultValue={c?.dunning_policy ?? ""}
                  options={[
                    { value: "", label: "Business settings" },
                    ...dunning.policies.map((p) => ({
                      value: p.id,
                      label: p.archived ? `${p.name} (archived)` : p.name,
                      // An archived policy is listed only because the customer still has it.
                      disabled: p.archived && p.id !== c?.dunning_policy,
                    })),
                  ]}
                />
              </Field>
            </Wide>
          ) : null}
          <Field
            name="net_term_days"
            label="Net term days"
            help="Payment is due N days after the invoice date."
          >
            <Input
              name="net_term_days"
              type="number"
              min={0}
              max={365}
              step={1}
              {...(c ? { defaultValue: c.net_term_days ?? 0 } : { placeholder: "0" })}
              className="tabular-nums"
            />
          </Field>
          {c ? (
            <Wide>
              <Field
                name="invoice_notes"
                label="Invoice note"
                help="We print it on this customer’s invoices. Leave empty to use the business default note."
              >
                <Textarea
                  name="invoice_notes"
                  rows={3}
                  maxLength={2000}
                  defaultValue={c.invoice_notes ?? ""}
                />
              </Field>
            </Wide>
          ) : (
            <Field
              name="invoice_notes"
              label="Invoice notes"
              help="We print it on every invoice for this customer."
            >
              <Input name="invoice_notes" maxLength={2000} />
            </Field>
          )}
        </FormCard>

        {/* Operators are held to no address rule, on create or edit: the business's
            checkout and portal rules bind buyers only, and the API still rejects a bad value. */}
        <FormCard title="Billing address" columns={1}>
          {c ? (
            <p className="text-xs text-muted-foreground">
              We use it to calculate tax. We also print it on this customer’s invoices.
            </p>
          ) : null}
          <AddressFields
            countries={countries}
            value={c?.address ?? null}
            prefix="addr_"
            requireCore={false}
            requireRest={false}
          />
        </FormCard>

        {/* Writes the DEFAULT entry of the address book; the customer page manages the rest. */}
        <FormCard title="Default shipping address" columns={1}>
          <p className="text-xs text-muted-foreground">
            {c
              ? "Goods ship here when a subscription has no shipping address of its own. Optional. Clear every field to stop using a default. The address stays in the customer’s shipping addresses."
              : "Optional. Goods ship here when a subscription has no shipping address of its own. You can add more shipping addresses on the customer page."}
          </p>
          <AddressFields
            countries={countries}
            value={c?.shipping_address ?? null}
            prefix="ship_"
            requireCore={false}
          />
        </FormCard>

        <FormCard title="Tax">
          <Wide>
            <SwitchRow
              name={editing ? "tax_exempt" : undefined}
              label="Tax exempt"
              hint="We do not charge tax on this customer’s invoices."
              checked={v.tax_exempt}
              onCheckedChange={(x) => set("tax_exempt", x)}
            />
          </Wide>
          <Field
            name="tax_behavior"
            label="Price type"
            help="Tax inclusive: the price includes tax, and we take the tax out of it. Tax exclusive: we add tax on top. This applies to all the customer’s invoices."
          >
            <input type="hidden" name="tax_behavior_field" value="1" />
            <SelectField
              name="tax_behavior"
              defaultValue={c?.tax_behavior ?? ""}
              ariaLabel="Price type"
              options={[
                { value: "", label: "Use the price type of each price" },
                { value: "inclusive", label: "Tax inclusive for all prices" },
                { value: "exclusive", label: "Tax exclusive for all prices" },
              ]}
            />
          </Field>
          <Field name="vat_number" label="VAT / GST number">
            <Input name="vat_number" defaultValue={c?.vat_number ?? ""} className="font-mono" />
          </Field>
          {c ? (
            <>
              <Field name="withholding_rate_bps" label="Withholding / TDS rate (bps · 1000 = 10%)">
                <Input
                  name="withholding_rate_bps"
                  type="number"
                  min={0}
                  max={10000}
                  step={1}
                  defaultValue={c.withholding_rate_bps ?? 0}
                  className="tabular-nums"
                />
              </Field>
              {/* Gated on the region for the BILLING country: its treatments are the only
                  ones the engine honours. */}
              <TaxTreatmentField
                region={props.taxRegions.find((r) => r.country === c.address?.country) ?? null}
                value={c.tax_treatment}
                registrationNumber={c.tax_registration_number}
              />
            </>
          ) : (
            <>
              <Field
                name="tax_registration_number"
                label="Tax registration number"
                help="The customer's registration number, such as a GSTIN in India. We print it on the customer's invoices."
              >
                <Input name="tax_registration_number" maxLength={50} className="font-mono" />
              </Field>
              {/* No treatment select on create: the offerable treatments depend on the
                  billing country's region, unknown until saved. Edit offers it. */}
              <Wide>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  You can set SEZ, export and reverse-charge treatments after you save. They need
                  this customer’s billing country.
                </p>
              </Wide>
            </>
          )}
        </FormCard>

        {c ? (
          <FormCard title="Email copies">
            <input type="hidden" name="billing_copies_fields" value="1" />
            <Wide>
              <Field
                name="billing_cc_emails"
                label="CC on invoices and receipts"
                help="Up to 10 email addresses, separated by commas. They see each other and the customer."
              >
                <Input
                  name="billing_cc_emails"
                  defaultValue={(c.billing_cc_emails ?? []).join(", ")}
                  placeholder="finance@example.com"
                />
              </Field>
            </Wide>
            <Wide>
              <Field
                name="billing_bcc_emails"
                label="BCC on invoices and receipts"
                help="Up to 10 email addresses, separated by commas. Other recipients do not see them."
              >
                <Input
                  name="billing_bcc_emails"
                  defaultValue={(c.billing_bcc_emails ?? []).join(", ")}
                  placeholder="records@example.com"
                />
              </Field>
            </Wide>
          </FormCard>
        ) : null}

        {hasCustomFields ? (
          // Required: create REJECTS a missing required custom field.
          <FormCard title="Custom fields" columns={1}>
            <CustomFieldsFields definitions={cfDefs} values={c?.custom_fields ?? null} />
          </FormCard>
        ) : null}

        {c ? (
          // metadata_fields marks the field present, so an emptied editor CLEARS the column.
          <FormCard title="JSON metadata" columns={1}>
            <input type="hidden" name="metadata_fields" value="1" />
            <MetadataField
              metadata={c.metadata}
              editor={props.mode === "edit" ? props.metadataEditor : null}
            />
          </FormCard>
        ) : null}
      </FormFrame>
    </ActionForm>
  );
}
