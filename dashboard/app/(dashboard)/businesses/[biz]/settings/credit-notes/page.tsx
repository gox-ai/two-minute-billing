import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { DocumentNumberingFields } from "@/components/settings/document-numbering-fields";
import { composeDocumentNumber } from "@/lib/document-numbering";
import { businessTz } from "@/lib/business-tz-server";
import { saveCreditNotePageAction } from "./actions";

export const dynamic = "force-dynamic";

// Settings → Credit notes: the title, the number format, the credit-note-only fields
// and a business-wide note. Fields SHARED with invoices are on Settings → Documents.
export default async function CreditNoteSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  const base = `/businesses/${biz}/settings`;
  const tz = await businessTz(biz);
  // An absent key resolves to the engine's documented default.
  const cn = b.invoice_customization?.credit_note ?? null;
  const numbering = cn?.numbering ?? null;
  const title = cn?.title ?? "credit_note";
  const basis = cn?.service_period_basis ?? "invoice_line_dates";
  const fmt = {
    prefix: b.credit_note_prefix ?? "CN",
    next: b.credit_note_next_number ?? 1,
    dynamicPrefix: numbering?.dynamic_prefix ?? "none",
    separator1: numbering?.separator1 ?? "hyphen",
    separator2: numbering?.separator2 ?? "hyphen",
    increment: numbering?.increment ?? 1,
    fiscalYearStartMonth: numbering?.fiscal_year_start_month ?? 1,
  } as const;
  const fields = {
    show_cn_status: cn?.show_status ?? true,
    show_service_period: cn?.show_service_period ?? true,
    show_cn_invoice_date: cn?.show_invoice_date ?? true,
  };
  const NAMES: Record<keyof typeof fields, string> = {
    show_cn_status: "status",
    show_service_period: "service period",
    show_cn_invoice_date: "invoice date",
  };
  const shown = (Object.keys(fields) as Array<keyof typeof fields>).filter((k) => fields[k]);
  const nextNumber = composeDocumentNumber({
    prefix: fmt.prefix,
    counter: fmt.next,
    dynamicPrefix: fmt.dynamicPrefix,
    separator1: fmt.separator1,
    separator2: fmt.separator2,
    fiscalYearStartMonth: fmt.fiscalYearStartMonth,
    at: new Date(),
    timezone: tz,
  });

  const toggle = (name: keyof typeof fields, label: string) => (
    <SettingSwitch name={name} label={label} defaultChecked={fields[name]} />
  );

  return (
    <SettingsPage
      title="Credit notes"
      crumbs={[{ label: "Settings", href: base }, { label: "Credit notes" }]}
      description="What we call your credit notes, how we number them, which fields they show, and a standing note."
    >
      <ActionForm action={saveCreditNotePageAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Title", value: title === "refund" ? "REFUND" : "CREDIT NOTE" },
                {
                  label: "Next credit note",
                  value: <span className="font-mono">{nextNumber}</span>,
                },
                {
                  label: "Shows",
                  value: shown.length
                    ? capitalise(shown.map((k) => NAMES[k]).join(", "))
                    : "None of the optional fields",
                },
                fields.show_service_period && {
                  label: "Service period",
                  value:
                    basis === "credit_note_date"
                      ? "The credit note's own date"
                      : "The credited invoice line's dates",
                },
                { label: "Standing note", value: cn?.notes ? "Set" : "None" },
              ]}
            />
          }
          save={{
            label: "Save credit note settings",
            note: "Numbering applies to the next credit note. The title, fields and note show on every credit note that someone views or downloads, including past ones.",
          }}
        >
          <SettingsCard title="Title">
            <SettingRow
              label="Credit note title"
              htmlFor="cn_title"
              help="Use “REFUND” for a note that returns cash and does not credit the account."
              control={
                <SelectField
                  name="cn_title"
                  defaultValue={title}
                  className="w-full sm:w-56"
                  options={[
                    { value: "credit_note", label: "CREDIT NOTE" },
                    { value: "refund", label: "REFUND" },
                  ]}
                />
              }
            />
          </SettingsCard>

          <SettingsCard
            title="Numbering"
            meta="The counter only counts up, so changing the format never repeats a number"
          >
            <DocumentNumberingFields
              prefix="cn_"
              label="credit note"
              numberPrefix={fmt.prefix}
              nextNumber={fmt.next}
              timezone={tz}
              dynamicPrefix={fmt.dynamicPrefix}
              separator1={fmt.separator1}
              separator2={fmt.separator2}
              increment={fmt.increment}
              fiscalYearStartMonth={fmt.fiscalYearStartMonth}
              prefixFieldName="credit_note_prefix"
              nextNumberFieldName="credit_note_next_number"
            />
          </SettingsCard>

          <SettingsCard
            title="Credit note fields"
            meta="Credit note only. Shared fields are under Documents"
          >
            <SettingRow
              label="Credit note status"
              placement="end"
              control={toggle("show_cn_status", "Show the credit note status")}
            />
            <SettingRow
              label="Service period"
              help="The period covered by each credited line."
              placement="end"
              control={toggle("show_service_period", "Show the service period")}
            />
            <SettingRow
              label="Service period basis"
              htmlFor="service_period_basis"
              help="Which dates a credited line reports, when the service period is shown."
              control={
                <SelectField
                  name="service_period_basis"
                  defaultValue={basis}
                  className="w-full sm:w-56"
                  options={[
                    { value: "invoice_line_dates", label: "Invoice line dates" },
                    { value: "credit_note_date", label: "Credit note date" },
                  ]}
                />
              }
              more="Invoice line dates keep the credit tied to the period that was originally billed. Credit note date moves it to the date of the credit. Speak to your accountant before you change this. It changes which period the credit reverses for revenue recognition."
            />
            <SettingRow
              label="Invoice date"
              help="The date of the invoice being credited."
              placement="end"
              control={toggle("show_cn_invoice_date", "Show the invoice date")}
            />
          </SettingsCard>

          <SettingsCard title="Standing note">
            <SettingRow
              label="Default credit note note"
              htmlFor="cn_notes"
              errorFor="cn_notes"
              // Additive: each note's own reason prints first, this below it.
              help="Shows on every credit note, below the reason for that note. Plain text."
              control={
                <Input
                  id="cn_notes"
                  name="cn_notes"
                  defaultValue={cn?.notes ?? ""}
                  maxLength={2000}
                  placeholder="For example: Credits are non-refundable and expire 12 months from issue"
                />
              }
            />
          </SettingsCard>

          <SettingsCard title="Related settings" padded>
            <p className="m-0 text-sm text-muted-foreground">
              <Link href={`${base}/documents`} className="text-primary hover:underline">
                Documents
              </Link>{" "}
              has the fields that credit notes share with invoices: the customer ID, addresses, the
              payments footer and the signature.
            </p>
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}

function capitalise(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
