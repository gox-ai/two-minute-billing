import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getMe } from "@/lib/api";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
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
import { saveGeneralAction, saveViesValidationAction } from "../actions";
import { TimezoneSelect } from "@/components/form/timezone-select";
import { AddressFields } from "@/components/customers/address-fields";
import { PhoneField } from "@/components/ui/phone-field";
import { getCountries } from "@/lib/api/geo";
import { CalendarRows, IssuerRow, VatRow } from "./profile-fields";
import { FISCAL_MONTHS } from "./fiscal-months";

export const dynamic = "force-dynamic";

// Settings → Business profile: identity, the invoice issuer, time zone, reporting
// calendar and address (one form), plus the VIES switch (its own form and action).
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
        <Link href="/settings" className={buttonVariants({ variant: "outline", size: "sm" })}>
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
      <SettingsColumns
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
                  fyMonth === 1 ? "calendar year" : `fiscal year from ${FISCAL_MONTHS[fyMonth - 1]}`
                }`,
              },
              { label: "Address", value: addressLine || "Not set" },
              { label: "EU VAT numbers", value: vies ? "Checked against VIES" : "Not checked" },
            ]}
          />
        }
      >
        <ActionForm action={saveGeneralAction} className="flex flex-col gap-5">
          <input type="hidden" name="biz" value={biz} />
          {b.resource_version != null ? (
            <input type="hidden" name="expected_version" value={b.resource_version} />
          ) : null}

          <SettingsCard title="Identity" meta="Printed on your documents" padded>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field name="name" label="Business name" required className="sm:col-span-2">
                <Input name="name" defaultValue={b.name} required maxLength={200} />
              </Field>
              <Field name="contact_email" label="Contact email">
                <Input
                  name="contact_email"
                  type="email"
                  defaultValue={b.contact_email ?? ""}
                  maxLength={320}
                  placeholder="billing@company.com"
                />
              </Field>
              <Field
                name="support_email"
                label="Support email"
                help="Printed in the contact line of invoices and credit notes."
              >
                <Input
                  name="support_email"
                  type="email"
                  defaultValue={b.support_email ?? ""}
                  maxLength={320}
                  placeholder="support@company.com"
                />
              </Field>
              {/* Dial code + national number, posting one E.164 `phone`. The address
                  country seeds the dial code. */}
              <PhoneField
                name="phone"
                countries={countries}
                defaultValue={b.phone}
                countryCode={addr?.country ?? null}
              />
              <Field
                name="website"
                label="Website"
                help="Printed beside the support email on your documents."
              >
                <Input
                  name="website"
                  type="url"
                  defaultValue={b.website ?? ""}
                  maxLength={2000}
                  placeholder="https://…"
                />
              </Field>
              <Field name="tax_registration_number" label="Tax registration #" help="GSTIN / VAT.">
                <Input
                  name="tax_registration_number"
                  defaultValue={b.tax_registration_number ?? ""}
                  maxLength={64}
                  className="font-mono"
                />
              </Field>
              <Field
                name="default_tax_code"
                label="Default HSN/SAC code"
                help="Used on an invoice line whose plan, addon or charge has no code of its own (India GST)."
              >
                <Input
                  name="default_tax_code"
                  defaultValue={b.default_tax_code ?? ""}
                  maxLength={20}
                  className="font-mono"
                />
              </Field>
            </div>
          </SettingsCard>

          <SettingsCard title="Invoice issuer">
            <IssuerRow saved={issuer} orgUsable={orgUsable} />
          </SettingsCard>

          <SettingsCard title="Time zone">
            <SettingRow
              label="Business time zone"
              htmlFor="timezone"
              help="Sets billing days, invoice dates and every date in the dashboard. If you change it, we recalculate stored analytics in the background."
              control={<TimezoneSelect name="timezone" defaultValue={b.timezone} />}
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
            padded
          >
            {/* `includeContact={false}`: name and phone live under Identity.
                `requireCore={false}`: a business can be set up before its address is known. */}
            <AddressFields
              countries={countries}
              value={addr ?? null}
              prefix="addr_"
              includeContact={false}
              requireCore={false}
            />
          </SettingsCard>

          <div>
            <SubmitButton>Save business profile</SubmitButton>
          </div>
        </ActionForm>

        <ActionForm action={saveViesValidationAction}>
          <input type="hidden" name="biz" value={biz} />
          {b.resource_version != null ? (
            <input type="hidden" name="expected_version" value={b.resource_version} />
          ) : null}
          <SettingsCard
            title="VAT validation"
            footer={
              <SubmitButton size="sm" variant="outline">
                Save VAT validation
              </SubmitButton>
            }
          >
            <VatRow saved={vies} />
          </SettingsCard>
        </ActionForm>
      </SettingsColumns>
    </SettingsPage>
  );
}
