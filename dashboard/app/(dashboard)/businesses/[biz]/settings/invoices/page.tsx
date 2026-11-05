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
import { saveInvoicePageAction } from "./actions";

export const dynamic = "force-dynamic";

// Settings → Invoices: the title, the number format, the invoice-only fields and the
// default note. Payment terms, round-off and pending invoices live under Billing rules;
// fields SHARED with credit notes are on Settings → Documents.
export default async function InvoiceSettings({ params }: { params: Promise<{ biz: string }> }) {
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
  // An absent key resolves to the engine's documented default — never `false` by accident.
  const inv = b.invoice_customization?.invoice ?? null;
  const numbering = inv?.numbering ?? null;
  const title = inv?.title ?? "invoice";
  const fmt = {
    prefix: b.invoice_prefix ?? "INV",
    next: b.invoice_next_number ?? 1,
    dynamicPrefix: numbering?.dynamic_prefix ?? "none",
    separator1: numbering?.separator1 ?? "hyphen",
    separator2: numbering?.separator2 ?? "hyphen",
    increment: numbering?.increment ?? 1,
    fiscalYearStartMonth: numbering?.fiscal_year_start_month ?? 1,
  } as const;
  const fields = {
    show_invoice_status: inv?.show_status ?? true,
    show_billing_period: inv?.show_billing_period ?? true,
    show_next_billing: inv?.show_next_billing ?? true,
    show_credit_note_number: inv?.show_credit_note_number ?? false,
    show_custom_fields: inv?.show_custom_fields ?? false,
    show_zero_value_lines: inv?.show_zero_value_lines ?? true,
  };
  const NAMES: Record<keyof typeof fields, string> = {
    show_invoice_status: "status",
    show_billing_period: "billing period",
    show_next_billing: "next billing date",
    show_credit_note_number: "credit note numbers",
    show_custom_fields: "custom fields",
    show_zero_value_lines: "zero-value lines",
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
      title="Invoices"
      crumbs={[{ label: "Settings", href: base }, { label: "Invoices" }]}
      description="What we call your invoices, how we number them, which fields they show, and the note at the bottom."
    >
      <ActionForm action={saveInvoicePageAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Title", value: title === "tax_invoice" ? "TAX INVOICE" : "INVOICE" },
                {
                  label: "Next invoice",
                  value: <span className="font-mono">{nextNumber}</span>,
                },
                {
                  label: "Shows",
                  value: shown.length
                    ? capitalise(shown.map((k) => NAMES[k]).join(", "))
                    : "None of the optional fields",
                },
                {
                  label: "PO number",
                  value: b.inherit_subscription_po_number ? "From the subscription" : "Not printed",
                },
                { label: "Default note", value: b.default_invoice_notes ? "Set" : "None" },
              ]}
            />
          }
          save={{
            label: "Save invoice settings",
            note: "Numbering applies to the next invoice. The title, fields and note show on every invoice that someone views or downloads, including past ones.",
          }}
        >
          <SettingsCard title="Title">
            <SettingRow
              label="Invoice title"
              htmlFor="invoice_title"
              help="India's GST regime requires “TAX INVOICE” on a taxable supply."
              control={
                <SelectField
                  name="invoice_title"
                  defaultValue={title}
                  className="w-full sm:w-56"
                  options={[
                    { value: "invoice", label: "INVOICE" },
                    { value: "tax_invoice", label: "TAX INVOICE" },
                  ]}
                />
              }
            />
          </SettingsCard>

          {/* No periodic counter reset, deliberately: invoice numbers are unique per
              business, so a counter returning to 1 would fail the INSERT on the billing path. */}
          <SettingsCard
            title="Numbering"
            meta="The counter only counts up, so changing the format never repeats a number"
          >
            <DocumentNumberingFields
              prefix="inv_"
              label="invoice"
              numberPrefix={fmt.prefix}
              nextNumber={fmt.next}
              timezone={tz}
              dynamicPrefix={fmt.dynamicPrefix}
              separator1={fmt.separator1}
              separator2={fmt.separator2}
              increment={fmt.increment}
              fiscalYearStartMonth={fmt.fiscalYearStartMonth}
              prefixFieldName="invoice_prefix"
              nextNumberFieldName="invoice_next_number"
            />
          </SettingsCard>

          <SettingsCard
            title="Invoice fields"
            meta="Invoice only. Shared fields are under Documents"
          >
            <SettingRow
              label="Invoice status"
              placement="end"
              control={toggle("show_invoice_status", "Show the invoice status")}
            />
            <SettingRow
              label="Billing period"
              placement="end"
              control={toggle("show_billing_period", "Show the billing period")}
            />
            <SettingRow
              label="Next billing date"
              placement="end"
              control={toggle("show_next_billing", "Show the next billing date")}
            />
            <SettingRow
              label="Credit note number"
              help="Lists any credit notes raised against the invoice."
              placement="end"
              control={toggle("show_credit_note_number", "Show credit note numbers")}
            />
            <SettingRow
              label="Custom fields"
              help={
                <>
                  Up to 3. You select each field under{" "}
                  <Link href={`${base}/custom-fields`} className="text-primary hover:underline">
                    Custom fields
                  </Link>
                  . We do not show a field that has no value on the customer or subscription.
                </>
              }
              placement="end"
              control={toggle("show_custom_fields", "Show custom fields")}
            />
            <SettingRow
              label="PO number from the subscription"
              help="New invoices print the purchase order number set on their subscription. A PO number set on the invoice itself always prints. Invoices that already exist do not change."
              placement="end"
              control={
                <SettingSwitch
                  name="inherit_subscription_po_number"
                  label="Print the subscription's PO number"
                  defaultChecked={b.inherit_subscription_po_number ?? false}
                />
              }
            />
            <SettingRow
              label="Zero-value line items"
              help="A line billed at 0, for example a free plan or a $0 add-on. Off hides it from the printed invoice. A discounted line still prints, so the discount has a line to refer to."
              placement="end"
              control={toggle("show_zero_value_lines", "Show zero-value line items")}
            />
          </SettingsCard>

          <SettingsCard title="Default note">
            <SettingRow
              label="Default invoice note"
              htmlFor="default_invoice_notes"
              errorFor="default_invoice_notes"
              help="Shows at the bottom of every invoice, unless the customer has their own invoice note. Plain text."
              control={
                <Input
                  id="default_invoice_notes"
                  name="default_invoice_notes"
                  defaultValue={b.default_invoice_notes ?? ""}
                  maxLength={2000}
                  placeholder="Shows at the bottom of every invoice"
                />
              }
            />
          </SettingsCard>

          {/* "Void with credit note" is deliberately NOT offered: `voidInvoice` already
              mirrors the invoice's ledger entries and the only credit-note path posts its
              own AR reversal, so it would double-credit AR. Tracked in docs/PROGRESS.md. */}
          <SettingsCard title="Related settings" padded>
            <p className="m-0 text-sm text-muted-foreground">
              <Link href={`${base}/documents`} className="text-primary hover:underline">
                Documents
              </Link>{" "}
              has the fields that invoices share with credit notes: the customer ID, addresses, the
              payments footer and the signature. Payment terms, round-off and pending invoices are
              under{" "}
              <Link href={`${base}/billing-rules`} className="text-primary hover:underline">
                Billing rules
              </Link>
              .
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
