import { getMe } from "@/lib/api";
import { getCountries } from "@/lib/api/geo";
import { requirePermission } from "@/lib/session";
import { Input } from "@/components/ui/input";
import { LIMITS } from "@/lib/limits";
import { AddressFields } from "@/components/customers/address-fields";
import { SettingRow, SettingsCard, SettingsSaveBar } from "@/components/settings/settings-layout";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { OrgSettingsFrame } from "@/components/org-settings/org-settings-frame";
import { saveOrgSettingsAction } from "../save-actions";

export const dynamic = "force-dynamic";

// Settings → Legal entity: the registered entity a business can issue invoices under.
// The engine falls back to the business when these are empty, so a half-filled entity
// never blanks a seller block.
export default async function LegalEntitySettingsPage() {
  const me = await requirePermission("settings:manage", "admin");

  let org: Awaited<ReturnType<typeof getMe>>;
  let countries: Awaited<ReturnType<typeof getCountries>>;
  try {
    [org, countries] = await Promise.all([getMe(), getCountries()]);
  } catch (e) {
    return (
      <ErrorState
        title="We could not connect to the API"
        description={<span className="font-mono text-xs">{(e as Error).message}</span>}
      />
    );
  }

  return (
    <OrgSettingsFrame
      page="legal"
      description="The registered entity on invoices from each business that issues under the organization."
      liveAccessLocked={me.organization_live_access === "locked"}
    >
      <ActionForm action={saveOrgSettingsAction} className="flex flex-col gap-5">
        <SettingsCard title="Entity" meta="Printed as the seller">
          <SettingRow
            label="Legal entity name"
            htmlFor="legal_name"
            errorFor="legal_name"
            placement="end"
            help="Often longer than the organization name. Empty: those invoices use the business's own name."
            control={
              <Input
                id="legal_name"
                name="legal_name"
                defaultValue={org.legal_name ?? ""}
                maxLength={LIMITS.name}
                className="w-full sm:w-72"
              />
            }
          />
          <SettingRow
            label="Tax registration number"
            htmlFor="tax_registration_number"
            errorFor="tax_registration_number"
            placement="end"
            help="GSTIN in India, VAT ID in other countries. It must be the entity's own number: a buyer claims input tax credit against it."
            control={
              <Input
                id="tax_registration_number"
                name="tax_registration_number"
                defaultValue={org.tax_registration_number ?? ""}
                maxLength={64}
                className="w-full font-mono sm:w-72"
              />
            }
          />
        </SettingsCard>

        <SettingsCard id="address" title="Registered address" meta="The seller address">
          {/* Tells the action the address is on the page, so it writes it. */}
          <input type="hidden" name="addr_fields" value="1" />
          <AddressFields
            countries={countries}
            value={org.address ?? null}
            prefix="addr_"
            includeContact={false}
            requireCore={false}
            layout="rows"
          />
        </SettingsCard>
        <SettingsSaveBar label="Save" />
      </ActionForm>
    </OrgSettingsFrame>
  );
}
