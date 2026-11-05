"use client";

import { useDefaultState } from "@/lib/use-default-state";
import { SelectField } from "@/components/ui/select-field";
import { SettingRow } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { FISCAL_MONTHS } from "./fiscal-months";

/**
 * Whose identity heads this business's invoices and credit notes. The engine prints the organization
 * only while it has an address or a tax number; otherwise the business stands in.
 */
export function IssuerRow({ saved, orgUsable }: { saved: string; orgUsable: boolean }) {
  const [issuer, setIssuer] = useDefaultState(saved);
  return (
    <SettingRow
      label="Invoice issued by"
      htmlFor="invoice_issuer"
      errorFor="invoice_issuer"
      help="Whose name, address and tax registration head this business's invoices and credit notes."
      control={
        <SelectField
          name="invoice_issuer"
          value={issuer}
          onValueChange={setIssuer}
          className="w-full sm:w-72"
          options={[
            { value: "business", label: "This business" },
            { value: "organization", label: "The organization (registered entity)" },
          ]}
        />
      }
      consequence={
        issuer !== "organization"
          ? "Invoices and credit notes show this business's own name, address and tax number at the top."
          : orgUsable
            ? "Invoices and credit notes show the organization's legal name, address and tax number at the top. The logo and contact details stay those of this business."
            : "The organization has no address or tax number yet, so invoices and credit notes show this business's own details. Enter the entity details under Settings → Organization."
      }
      more="Select the organization when several businesses bill under one registered company. The buyer claims input tax credit against the tax number on the document."
    />
  );
}

/** Week start and fiscal year, each with what the CURRENT choice does to reports. */
export function CalendarRows({ weekStart, fyMonth }: { weekStart: string; fyMonth: string }) {
  const [week, setWeek] = useDefaultState(weekStart);
  const [fy, setFy] = useDefaultState(fyMonth);
  const m = Number(fy) || 1;
  return (
    <>
      <SettingRow
        label="Week starts on"
        htmlFor="week_start"
        help="Weekly charts, “This week” and “Previous week” run from this day."
        control={
          <SelectField
            name="week_start"
            value={week}
            onValueChange={setWeek}
            className="w-full sm:w-44"
            options={[
              { value: "sunday", label: "Sunday" },
              { value: "monday", label: "Monday" },
            ]}
          />
        }
        consequence={`A reporting week runs ${week === "monday" ? "Monday to Sunday" : "Sunday to Saturday"}.`}
      />
      <SettingRow
        label="Fiscal year starts in"
        htmlFor="fiscal_year_start_month"
        help="Quarters, “This quarter” and “Year to date” use this setting."
        control={
          <SelectField
            name="fiscal_year_start_month"
            value={fy}
            onValueChange={setFy}
            className="w-full sm:w-56"
            options={FISCAL_MONTHS.map((label, i) => ({
              value: String(i + 1),
              label: i === 0 ? `${label} (calendar year)` : label,
            }))}
          />
        }
        consequence={fiscalLine(m)}
      />
    </>
  );
}

/** Mirrors `yearLabel`: a fiscal year is named by the year it ends in. */
export function fiscalLine(month: number): string {
  if (month === 1) return "Years are calendar years: Q1 is January to March.";
  const start = FISCAL_MONTHS[month - 1];
  const end = FISCAL_MONTHS[(month + 10) % 12];
  return `Q1 starts in ${start}. We name a year by the year it ends in: ${start} 2026 – ${end} 2027 is FY2027.`;
}

/** The VIES switch, with what its CURRENT position does. */
export function VatRow({ saved }: { saved: boolean }) {
  const [on, setOn] = useDefaultState(saved);
  return (
    <SettingRow
      label="Validate EU VAT numbers against VIES"
      help="When we check a customer's VAT number, we ask VIES, the EU Commission's lookup service."
      placement="end"
      control={
        <SettingSwitch
          name="vies_validation_enabled"
          label="Validate EU VAT numbers against VIES"
          checked={on}
          onCheckedChange={setOn}
        />
      }
      consequence={
        on
          ? "On: when we check a customer's VAT number, we ask VIES and record its verdict."
          : "Off: when we check a customer's VAT number, we do not ask VIES. We mark the number as not checked and clear any earlier verdict."
      }
      more="VIES can have outages that we do not control. Disable this setting to stop the lookup during an outage. This never changes the VAT number itself."
    />
  );
}
