import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { composeDocumentNumber } from "@/lib/document-numbering";
import { businessTz } from "@/lib/business-tz-server";
import { saveReceiptSettingsAction } from "../actions";

export const dynamic = "force-dynamic";

// Settings → Receipts: the number prefix. A receipt is created by each successful
// payment and numbered by a batch job, so the counter is read-only here.
export default async function ReceiptSettings({ params }: { params: Promise<{ biz: string }> }) {
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
  const prefix = b.receipt_prefix ?? "RCPT";
  const counter = b.receipt_next_number ?? 1;
  // The engine formats receipts like credit notes; absent keys are its defaults.
  const n = b.invoice_customization?.receipt?.numbering ?? null;
  const nextNumber = composeDocumentNumber({
    prefix,
    counter,
    dynamicPrefix: n?.dynamic_prefix ?? "none",
    separator1: n?.separator1 ?? "hyphen",
    separator2: n?.separator2 ?? "hyphen",
    fiscalYearStartMonth: n?.fiscal_year_start_month ?? 1,
    at: new Date(),
    timezone: tz,
  });
  const attach = b.email_config?.attachReceiptPdf === true;

  return (
    <SettingsPage
      title="Receipts"
      crumbs={[{ label: "Settings", href: base }, { label: "Receipts" }]}
      description="We create a numbered receipt for each successful payment. A receipt is a record of money received. It is not a tax invoice."
    >
      <ActionForm action={saveReceiptSettingsAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Next receipt", value: <span className="font-mono">{nextNumber}</span> },
                {
                  label: "Payment confirmation email",
                  value: attach ? "Receipt PDF attached" : "No attachment",
                },
              ]}
            />
          }
          save={{
            label: "Save receipt settings",
            note: "The prefix applies to the next receipt that we number. Numbered receipts keep their number.",
          }}
        >
          <SettingsCard title="Numbering" meta="The counter only counts up">
            <SettingRow
              label="Number prefix"
              htmlFor="receipt_prefix"
              errorFor="receipt_prefix"
              help="Printed before the counter, for example RCPT-12. 1 to 20 characters."
              control={
                <Input
                  id="receipt_prefix"
                  name="receipt_prefix"
                  required
                  maxLength={20}
                  defaultValue={prefix}
                  className="font-mono sm:w-56"
                />
              }
            />
            <SettingRow
              label="Next number"
              help="We number receipts in the order of their payments, a few seconds after each payment. You cannot change the counter."
              control={<span className="font-mono text-sm tabular-nums">{counter}</span>}
            />
          </SettingsCard>

          <SettingsCard title="Related settings" padded>
            <p className="m-0 text-sm text-muted-foreground">
              <Link href={`${base}/emails`} className="text-primary hover:underline">
                Email notifications
              </Link>{" "}
              has the switch that attaches the receipt PDF to the payment confirmation email.
            </p>
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
