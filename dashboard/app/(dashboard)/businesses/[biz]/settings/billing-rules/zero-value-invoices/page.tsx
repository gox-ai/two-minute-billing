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
import { couponBillingRules, ZERO_INVOICE_PAID_LABELS } from "@/lib/billing-rules";
import { saveZeroValueInvoicesAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
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

// `zero_invoice_paid_event`: one-off = a one-time purchase, a manual or API invoice, a credit
// purchase or an automatic top-up. An ad-hoc charge is not one-off, also with no subscription.
const PAID_EVENT: Choice[] = [
  {
    value: "never",
    label: ZERO_INVOICE_PAID_LABELS.never,
    consequence:
      "We send no invoice_paid event for an invoice with a total of zero. The invoice_generated event still goes out.",
  },
  {
    value: "one_off",
    label: ZERO_INVOICE_PAID_LABELS.one_off,
    consequence:
      "We send invoice_paid with an amount of 0 for a one-time purchase, a manual invoice, a credit purchase or an automatic top-up. We do not send it for other invoices, for example a renewal.",
  },
  {
    value: "all",
    label: ZERO_INVOICE_PAID_LABELS.all,
    consequence:
      "We send invoice_paid with an amount of 0 for each invoice with a total of zero, also for renewals and plan changes.",
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
  const paidEvent = couponBillingRules(b).zero_invoice_paid_event;

  return (
    <SettingsPage
      title="Zero-value invoices"
      crumbs={ruleCrumbs(biz, "Zero-value invoices")}
      description="What we do with an invoice whose total is zero, for example after a 100% discount or on a free plan, and which webhooks we send for it."
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
                { label: "invoice_paid event", value: ZERO_INVOICE_PAID_LABELS[paidEvent] },
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
          <SettingsCard title="Webhooks" meta="invoice_paid">
            <ChoiceRow
              name="zero_invoice_paid_event"
              label="Send invoice_paid for a total of zero"
              help="For webhooks and integrations that start work when an invoice is paid."
              defaultValue={paidEvent}
              options={PAID_EVENT}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
