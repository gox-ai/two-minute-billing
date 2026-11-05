import type { ConnectedHubSpot, HubSpotProperty } from "@/lib/api/hubspot";
import { getHubSpotLocalFields, getHubSpotProperties } from "@/lib/api/hubspot";
import { Alert } from "@/components/ui/alert";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { SelectField } from "@/components/ui/select-field";
import { SwitchField } from "@/components/ui/switch";
import { SelectAnswer, SettingRow, ToggleAnswer } from "@/components/patterns/settings-page";
import { RecordCard } from "@/components/patterns/record-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { FieldMappingEditor } from "@/components/integrations/hubspot/field-mapping-editor";
import { saveHubSpotCustomersAction } from "@/app/(dashboard)/businesses/[biz]/integrations/hubspot/actions-customers";

const LOCAL_LABEL: Record<string, string> = {
  id: "Customer ID",
  email: "Email",
  first_name: "First name",
  last_name: "Last name",
  phone: "Phone",
  company: "Company name",
  locale: "Language",
  preferred_currency: "Preferred currency",
  auto_collection: "Auto-collection",
  net_term_days: "Net term (days)",
  vat_number: "VAT number",
  billing_line1: "Billing address line 1",
  billing_city: "Billing city",
  billing_state: "Billing state",
  billing_zip: "Billing postcode",
  billing_country: "Billing country",
  mrr: "MRR",
  total_dues: "Total dues",
  created_at: "Customer since",
  subscription_id: "Subscription ID",
  subscription_status: "Subscription status",
  subscription_plan_id: "Subscription plan price ID",
  subscription_plan_amount: "Subscription plan amount",
  subscription_mrr: "Subscription MRR",
  subscription_currency: "Subscription currency",
};

const localOption = (value: string): ComboboxOption =>
  value.startsWith("cf_")
    ? { value, label: `${value.slice(3)} (custom field)`, keywords: value }
    : { value, label: LOCAL_LABEL[value] ?? value, keywords: value };

const remoteOption = (p: HubSpotProperty): ComboboxOption => ({
  value: p.name,
  label: p.label,
  keywords: p.name,
  hint: p.name,
});

/** The saved value stays selectable even when discovery failed or the property is gone. */
const withValue = (options: ComboboxOption[], value: string | undefined) =>
  !value || options.some((o) => o.value === value)
    ? options
    : [{ value, label: value }, ...options];

/** Customers → contacts and companies: scope, matching, what a match does, and field mappings. */
export async function CustomersSection({ biz, hs }: { biz: string; hs: ConnectedHubSpot }) {
  const c = hs.settings.customers;
  const [contactProps, companyProps, locals] = await Promise.all([
    getHubSpotProperties(biz, "contacts")
      .then((r) => r.data)
      .catch(() => null),
    getHubSpotProperties(biz, "companies")
      .then((r) => r.data)
      .catch(() => null),
    getHubSpotLocalFields(biz).catch(() => null),
  ]);
  const unreachable = !contactProps || !companyProps;

  const contactTargets = (contactProps ?? []).filter((p) => p.writable).map(remoteOption);
  const companyTargets = (companyProps ?? []).filter((p) => p.writable).map(remoteOption);
  const contactLocals = (locals?.contacts ?? []).map(localOption);
  const companyLocals = (locals?.companies ?? []).map(localOption);
  const customFields = (locals?.contacts ?? []).filter((f) => f.startsWith("cf_"));

  const contactMatchLocals = withValue(
    [
      { value: "email", label: "Email" },
      { value: "company", label: "Company name" },
      ...customFields.map(localOption),
    ],
    c.contactMatch.local,
  );
  const companyMatchLocals = withValue(
    [
      { value: "", label: "Do not sync companies" },
      { value: "email", label: "Email domain" },
      { value: "email_address", label: "Email address" },
      { value: "company", label: "Company name" },
      ...customFields.map(localOption),
    ],
    c.companyMatch?.local,
  );

  return (
    <ActionForm action={saveHubSpotCustomersAction} className="space-y-3">
      <input type="hidden" name="biz" value={biz} />
      {unreachable ? (
        <Alert tone="warning" title="We could not load the HubSpot properties.">
          The property lists below show only what is already saved. You can still save the other
          customer settings.
        </Alert>
      ) : null}
      <RecordCard
        title="Customers"
        flush
        footer={
          <div className="flex justify-end">
            <SubmitButton size="sm" variant="outline">
              Save customer sync
            </SubmitButton>
          </div>
        }
      >
        <div className="divide-y">
          <SettingRow question="Which customers should sync?">
            <SelectAnswer
              name="scope"
              defaultValue={c.scope}
              options={[
                { value: "all", label: "All customers" },
                { value: "active_subscriptions", label: "Only with an active subscription" },
              ]}
            />
          </SettingRow>
          <SettingRow
            question="Create a contact or company when none matches?"
            help="When off, customers link only to records that are already in HubSpot. We skip the other customers and show them on the sync log."
          >
            <ToggleAnswer
              name="create_missing"
              defaultChecked={c.createMissing}
              label="Create missing contacts and companies"
            />
          </SettingRow>
          <SettingRow
            question="Match contacts on"
            help="Our field is on the left. The HubSpot contact property that it must equal is on the right."
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <SelectField
                name="contact_match_local"
                size="sm"
                className="sm:w-44"
                ariaLabel="Our field to match contacts on"
                defaultValue={c.contactMatch.local}
                options={contactMatchLocals}
              />
              <Combobox
                name="contact_match_remote"
                size="sm"
                className="sm:w-52"
                ariaLabel="HubSpot contact property to match on"
                defaultValue={c.contactMatch.remote}
                options={withValue(contactTargets, c.contactMatch.remote)}
              />
            </div>
          </SettingRow>
          <SettingRow
            question="Match companies on"
            help="We find or create the company of each customer in HubSpot and associate it with their contact."
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <SelectField
                name="company_match_local"
                size="sm"
                className="sm:w-44"
                ariaLabel="Our field to match companies on"
                defaultValue={c.companyMatch?.local ?? ""}
                options={companyMatchLocals}
              />
              <Combobox
                name="company_match_remote"
                size="sm"
                className="sm:w-52"
                ariaLabel="HubSpot company property to match on"
                defaultValue={c.companyMatch?.remote ?? "domain"}
                options={withValue(companyTargets, c.companyMatch?.remote ?? "domain")}
              />
            </div>
          </SettingRow>
          <SettingRow
            question="Let several customers share one company?"
            help="When off, we do not link a company to a second customer if it is already linked to one. The sync log shows this."
            note={
              c.multipleCustomersPerCompany
                ? "This setting is enabled. You cannot disable it."
                : "After you enable this setting, you cannot disable it."
            }
          >
            <SwitchField
              name="multiple_customers_per_company"
              defaultChecked={c.multipleCustomersPerCompany}
              disabled={c.multipleCustomersPerCompany}
              ariaLabel="Let several customers share one company"
            />
          </SettingRow>
          <SettingRow question="When a customer matches a record already in HubSpot">
            <SelectAnswer
              name="on_match"
              defaultValue={c.onMatch}
              options={[
                { value: "fill_empty", label: "Update only empty properties" },
                { value: "overwrite", label: "Overwrite its properties" },
                { value: "link_only", label: "Link it without changes" },
              ]}
            />
          </SettingRow>
          <SettingRow
            question="When a linked customer changes here"
            help="Records that we create always get all properties."
          >
            <SelectAnswer
              name="local_change"
              defaultValue={hs.settings.updates.localChange}
              options={[
                { value: "overwrite_remote", label: "Update HubSpot" },
                { value: "nothing", label: "Leave HubSpot as it is" },
              ]}
            />
          </SettingRow>
          <SettingRow
            question="Send the billing address to custom properties?"
            help="When on, we do not change the HubSpot address fields. Map the billing fields below instead."
          >
            <ToggleAnswer
              name="billing_address_via_custom_fields"
              defaultChecked={c.billingAddressViaCustomFields}
              label="Send the billing address to custom properties"
            />
          </SettingRow>
          <div className="space-y-3 px-5 py-4">
            <div>
              <div className="text-sm font-medium text-foreground">Contact fields</div>
              <p className="mt-1 text-xs text-muted-foreground">
                We always send email, name, phone and company. Map up to 15 more fields.
              </p>
            </div>
            <FieldMappingEditor
              name="contact_fields"
              defaultRows={c.contactFields}
              remoteOptions={contactTargets}
              localOptions={contactLocals}
            />
          </div>
          <div className="space-y-3 px-5 py-4">
            <div>
              <div className="text-sm font-medium text-foreground">Company fields</div>
              <p className="mt-1 text-xs text-muted-foreground">
                We always send name and domain. Map up to 15 more fields.
              </p>
            </div>
            <FieldMappingEditor
              name="company_fields"
              defaultRows={c.companyFields}
              remoteOptions={companyTargets}
              localOptions={companyLocals}
            />
          </div>
        </div>
      </RecordCard>
    </ActionForm>
  );
}
