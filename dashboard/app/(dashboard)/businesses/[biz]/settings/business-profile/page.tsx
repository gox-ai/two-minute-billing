import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getMe } from "@/lib/api";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { saveGeneralAction } from "../actions";
import { TimezoneSelect } from "@/components/form/timezone-select";
import { AddressFields } from "@/components/customers/address-fields";
import { PhoneField } from "@/components/ui/phone-field";
import { getCountries } from "@/lib/api/geo";
import { CalendarRows, IssuerRow, VatRow } from "./profile-fields";
import { FISCAL_MONTHS } from "./fiscal-months";

export const dynamic = "force-dynamic";

// Settings → Business profile: identity, the invoice issuer, time zone, reporting
// calendar, address and the VIES switch — one form, one Save.
export default async function BusinessProfileSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!b)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;

  const addr = b.address;
  // Server-fetched so the country picker is correct on first paint.
  const [countries, org] = await Promise.all([getCountries(), getMe().catch(() => null)]);
  // Mirrors the engine: the organization heads an invoice or credit note only with an address or a tax id.
  const orgUsable = !!org && (!!org.address || !!org.tax_registration_number);
  const issuer = b.invoice_issuer ?? "business";
  const weekStart = b.week_start ?? "sunday";
  const fyMonth = b.fiscal_year_start_month ?? 1;
  const vies = b.vies_validation_enabled ?? true;
  const addressLine = addr
    ? [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
        .filter((l) => l && String(l).trim())
        .join(", ")
    : "";

  const attention: AttentionItem[] = [];
  if (issuer === "organization" && org && !orgUsable)
    attention.push({
      key: "issuer-fallback",
      tone: "warning",
      title: "The organization does not issue invoices and credit notes yet",
      detail:
        "This business is set to issue under the organization. But the organization has no address or tax number, so invoices and credit notes show this business's details.",
      actions: (
        <Link href="/settings/legal" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Complete the entity
        </Link>
      ),
    });
  if (!addressLine)
    attention.push({
      key: "no-address",
      tone: "warning",
      title: "No business address",
      detail: "Invoices and credit notes print without a seller address until you add one.",
      actions: (
        <a href="#address" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Add the address
        </a>
      ),
    });

  return (
    <SettingsPage
      title="Business profile"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Business profile" },
      ]}
      description="Your business identity, address, time zone and reporting calendar. Identity and address appear on invoices, credit notes and customer emails."
      attention={attention}
    >
      <ActionForm action={saveGeneralAction} className="flex flex-col gap-5">
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <input type="hidden" name="vies_fields" value="1" />
        <SettingsColumns
          save={{ label: "Save business profile" }}
          summary={
            <SettingsSummary
              items={[
                { label: "Business name", value: b.name },
                {
                  label: "Invoices issued by",
                  value:
                    issuer === "organization"
                      ? orgUsable
                        ? "The organization"
                        : "This business, because the organization details are not complete"
                      : "This business",
                },
                { label: "Time zone", value: b.timezone ?? "Not set" },
                {
                  label: "Reporting calendar",
                  value: `Weeks start ${weekStart === "monday" ? "Monday" : "Sunday"} · ${
                    fyMonth === 1
                      ? "calendar year"
                      : `fiscal year from ${FISCAL_MONTHS[fyMonth - 1]}`
                  }`,
                },
                { label: "Address", value: addressLine || "Not set" },
                { label: "EU VAT numbers", value: vies ? "Checked against VIES" : "Not checked" },
              ]}
            />
          }
        >
          <SettingsCard title="Identity" meta="Printed on your documents">
            <SettingRow
              label="Business name"
              htmlFor="name"
              errorFor="name"
              placement="end"
              control={
                <Input
                  id="name"
                  name="name"
                  defaultValue={b.name}
                  required
                  maxLength={200}
                  className="w-full sm:w-72"
                />
              }
            />
            <SettingRow
              label="Contact email"
              htmlFor="contact_email"
              errorFor="contact_email"
              placement="end"
              control={
                <Input
                  id="contact_email"
                  name="contact_email"
                  type="email"
                  defaultValue={b.contact_email ?? ""}
                  maxLength={320}
                  placeholder="billing@company.com"
                  className="w-full sm:w-72"
                />
              }
            />
            <SettingRow
              label="Support email"
              htmlFor="support_email"
              errorFor="support_email"
              placement="end"
              help="Printed in the contact line of invoices and credit notes."
              control={
                <Input
                  id="support_email"
                  name="support_email"
                  type="email"
                  defaultValue={b.support_email ?? ""}
                  maxLength={320}
                  placeholder="support@company.com"
                  className="w-full sm:w-72"
                />
              }
            />
            {/* Dial code + national number, posting one E.164 `phone`. The address
                country seeds the dial code. */}
            <SettingRow
              label="Phone"
              placement="end"
              control={
                <PhoneField
                  name="phone"
                  label={<span className="sr-only">Phone</span>}
                  countries={countries}
                  defaultValue={b.phone}
                  countryCode={addr?.country ?? null}
                  className="w-full sm:w-72"
                />
              }
            />
            <SettingRow
              label="Website"
              htmlFor="website"
              errorFor="website"
              placement="end"
              help="Printed beside the support email on your documents."
              control={
                <Input
                  id="website"
                  name="website"
                  type="url"
                  defaultValue={b.website ?? ""}
                  maxLength={2000}
                  placeholder="https://…"
                  className="w-full sm:w-72"
                />
              }
            />
            <SettingRow
              label="Tax registration number"
              htmlFor="tax_registration_number"
              errorFor="tax_registration_number"
              placement="end"
              help="Your GSTIN or VAT number."
              control={
                <Input
                  id="tax_registration_number"
                  name="tax_registration_number"
                  defaultValue={b.tax_registration_number ?? ""}
                  maxLength={64}
                  className="w-full font-mono sm:w-72"
                />
              }
            />
            <SettingRow
              label="Default HSN/SAC code"
              htmlFor="default_tax_code"
              errorFor="default_tax_code"
              placement="end"
              help="Used on an invoice line whose plan, add-on or charge has no code of its own (India GST)."
              control={
                <Input
                  id="default_tax_code"
                  name="default_tax_code"
                  defaultValue={b.default_tax_code ?? ""}
                  maxLength={20}
                  className="w-full font-mono sm:w-30"
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="Invoice issuer">
            <IssuerRow saved={issuer} orgUsable={orgUsable} />
          </SettingsCard>

          <SettingsCard title="Time zone">
            <SettingRow
              label="Business time zone"
              htmlFor="timezone"
              placement="end"
              help="Sets billing days, invoice dates and every date in the dashboard. If you change it, we recalculate stored analytics in the background."
              control={
                <TimezoneSelect
                  name="timezone"
                  defaultValue={b.timezone}
                  className="w-full sm:w-72"
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="Reporting calendar" meta="Analytics only. Billing does not change">
            <CalendarRows weekStart={weekStart} fyMonth={String(fyMonth)} />
            <p className="m-0 px-5 py-3 text-xs text-muted-foreground">
              If you change either setting, we recalculate stored weekly, quarterly and yearly
              figures in the background.
            </p>
          </SettingsCard>

          <SettingsCard
            id="address"
            title="Business address"
            meta="On every invoice and credit note"
          >
            {/* `includeContact={false}`: name and phone live under Identity.
                `requireCore={false}`: a business can be set up before its address is known. */}
            <AddressFields
              countries={countries}
              value={addr ?? null}
              prefix="addr_"
              includeContact={false}
              requireCore={false}
              layout="rows"
            />
          </SettingsCard>

          <SettingsCard title="VAT validation">
            <VatRow saved={vies} />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
