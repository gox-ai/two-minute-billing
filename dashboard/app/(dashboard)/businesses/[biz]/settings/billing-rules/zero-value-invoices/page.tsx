import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveZeroValueInvoicesAction } from "../../actions";
import { ChoiceRow } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";

export const dynamic = "force-dynamic";

// Billing rules → Zero-value invoices. The engine finalizes a $0 invoice as paid; whether the
// "invoice issued" email goes out is `email_config.attachments.invoice_issued.skipZeroSend`,
// the same field as the switch in that email's template, so the two screens cannot disagree.
// Not offered: "do not create the invoice". The period invoice is the double-billing backstop
// (`invoices_opens_period_uq`) and counts item billing cycles, so skipping it is not safe.
const OPTIONS = [
  {
    value: "finalize_and_send",
    label: "Finalize and send",
    consequence:
      "We finalize the invoice as paid and send the invoice email, as for any other invoice.",
  },
  {
    value: "finalize_no_send",
    label: "Finalize, do not send",
    consequence:
      "We finalize the invoice as paid and keep it in the invoice list and the customer portal. We do not send the invoice email. Webhooks still go out.",
  },
];

export default async function ZeroValueInvoicesSettings({
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

  const mode =
    b.email_config?.attachments?.invoice_issued?.skipZeroSend === true
      ? "finalize_no_send"
      : "finalize_and_send";
  const emailsOn = b.email_config?.enabled === true;

  return (
    <SettingsPage
      title="Zero-value invoices"
      crumbs={ruleCrumbs(biz, "Zero-value invoices")}
      description="What we do with an invoice whose total is zero, for example after a 100% discount or on a free plan."
    >
      <ActionForm action={saveZeroValueInvoicesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Zero-value invoices",
                  value: OPTIONS.find((o) => o.value === mode)!.label,
                },
                { label: "Billing emails", value: emailsOn ? "On" : "Off" },
              ]}
            />
          }
          save={{ note: "Applies to invoices issued from now on." }}
        >
          <SettingsCard title="Zero-value invoices" meta="Total of zero">
            <ChoiceRow
              name="zero_value_invoices"
              label="When the invoice total is zero"
              help={
                emailsOn ? (
                  <>
                    The same setting as “Do not send for zero-value invoices” on the{" "}
                    <Link
                      href={`/businesses/${biz}/settings/emails/templates/invoice_issued`}
                      className="text-primary hover:underline"
                    >
                      invoice email
                    </Link>
                    .
                  </>
                ) : (
                  "Billing emails are off for this business, so we send no invoice email for any invoice."
                )
              }
              defaultValue={mode}
              options={OPTIONS}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
