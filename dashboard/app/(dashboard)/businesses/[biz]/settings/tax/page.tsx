import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { getCountries } from "@/lib/api/geo";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { Combobox } from "@/components/ui/combobox";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveTaxSettingsAction } from "./actions";
import { CurrencyPriceTypeRow } from "./currency-row";
import { NEW_TAX_ID_ROWS } from "@/lib/tax-settings-form";

export const dynamic = "force-dynamic";

/**
 * Settings → Tax (`tax_settings`, 0489; resolver src/modules/tax/settings.ts): the price
 * type per currency, the tax rounding rule and the seller tax ID per destination country.
 * Tax rates themselves live under Product catalog → Taxes.
 */
export default async function TaxSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let b, countries;
  try {
    [b, countries] = await Promise.all([getBusiness(biz), getCountries()]);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!b)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;

  const byCurrency = b.tax_behavior_by_currency ?? {};
  const fallback = b.default_tax_behavior === "inclusive" ? "inclusive" : "exclusive";
  const currencies = [
    ...new Set(
      [b.default_currency, ...(b.currencies ?? []), ...Object.keys(byCurrency)]
        .filter((c): c is string => !!c)
        .map((c) => c.toUpperCase()),
    ),
  ];
  const rounding = b.tax_rounding === "per_line" ? "per_line" : "per_invoice_total";
  const sellerIds = b.seller_tax_ids ?? {};
  const idCountries = Object.keys(sellerIds).sort();
  const countryName = new Map(countries.map((c) => [c.code, c.name]));
  const countryOptions = countries.map((c) => ({
    value: c.code,
    label: c.name,
    keywords: c.code,
  }));
  const label = (v: string) => (v === "inclusive" ? "Tax inclusive" : "Tax exclusive");

  return (
    <SettingsPage
      title="Tax"
      crumbs={[{ label: "Settings", href: `/businesses/${biz}/settings` }, { label: "Tax" }]}
      description="The price type of each currency, how we round tax, and your tax ID for each country that you sell to."
    >
      <ActionForm action={saveTaxSettingsAction}>
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="expected_version" value={b.resource_version} />
        <input type="hidden" name="currencies" value={currencies.join(",")} />
        <input type="hidden" name="taxid_countries" value={idCountries.join(",")} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                // What the API does: an unset currency is exclusive.
                ...currencies.map((c) => ({
                  label: `New ${c} prices`,
                  value: byCurrency[c] ? label(byCurrency[c]) : "Tax exclusive (not set)",
                })),
                {
                  label: "Tax rounding",
                  value: rounding === "per_line" ? "On each line" : "On the invoice total",
                },
                {
                  label: "Tax IDs by country",
                  value: idCountries.length ? idCountries.join(", ") : "None",
                },
              ]}
            />
          }
          save={{ note: "Applies to new prices and new invoices. Issued invoices do not change." }}
        >
          <SettingsCard title="Price type per currency" meta="For new prices">
            {currencies.length === 0 ? (
              <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
                Set a default currency on the business profile first.
              </p>
            ) : (
              currencies.map((c) => (
                <CurrencyPriceTypeRow
                  key={c}
                  currency={c}
                  saved={byCurrency[c] ?? null}
                  dashboardDefault={fallback}
                />
              ))
            )}
            <p className="m-0 border-t px-5 py-3 text-sm text-muted-foreground">
              To use one price type for all the prices of a customer, edit the customer. The default
              for other currencies is on{" "}
              <Link
                href={`/businesses/${biz}/settings/currencies`}
                className="text-primary hover:underline"
              >
                Currencies
              </Link>
              .
            </p>
          </SettingsCard>

          <SettingsCard title="Tax rounding">
            <SettingRow
              label="Round tax"
              htmlFor="tax_rounding"
              help="How we round each tax on an invoice."
              control={
                <SelectField
                  name="tax_rounding"
                  defaultValue={rounding}
                  ariaLabel="Tax rounding"
                  className="w-full sm:w-96"
                  options={[
                    { value: "per_invoice_total", label: "One time, on the invoice total" },
                    { value: "per_line", label: "On each line, then add the lines" },
                  ]}
                />
              }
              more="With more than one line, the two methods can give a tax that is different by a few cents. Estimates use the same method as the invoice."
            />
          </SettingsCard>

          <SettingsCard title="Your tax ID per country" meta="Printed on invoices">
            <p className="m-0 px-5 py-3 text-sm text-muted-foreground">
              If you have a tax registration in the country of the customer, write it here. The
              invoice then shows this tax ID in place of the business tax ID. Countries that are not
              in this list show the business tax ID.
            </p>
            {idCountries.map((cc) => (
              <SettingRow
                key={cc}
                label={countryName.get(cc) ?? cc}
                htmlFor={`taxid_${cc}`}
                help="Clear the field to remove this country."
                control={
                  <Input
                    id={`taxid_${cc}`}
                    name={`taxid_${cc}`}
                    maxLength={64}
                    defaultValue={sellerIds[cc] ?? ""}
                    className="w-full font-mono sm:w-72"
                  />
                }
              />
            ))}
            {Array.from({ length: NEW_TAX_ID_ROWS }, (_, i) => (
              <SettingRow
                key={`new_${i}`}
                label={idCountries.length || i > 0 ? "Add a country" : "Country"}
                htmlFor={`new_country_${i}`}
                errorFor={`new_taxid_${i}`}
                control={
                  <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                    <Combobox
                      name={`new_country_${i}`}
                      ariaLabel="Country"
                      placeholder="Select a country"
                      className="w-full sm:w-56"
                      options={countryOptions}
                    />
                    <Input
                      name={`new_taxid_${i}`}
                      aria-label="Tax ID"
                      placeholder="Tax ID"
                      maxLength={64}
                      className="w-full font-mono sm:w-56"
                    />
                  </div>
                }
              />
            ))}
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
