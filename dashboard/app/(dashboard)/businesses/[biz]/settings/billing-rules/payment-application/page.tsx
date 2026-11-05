import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import {
  EXCESS_PAYMENT_LABELS,
  INVOICE_ORDER_LABELS,
  SEVERAL_DUE_LABELS,
  paymentApplication,
} from "@/lib/billing-rules";
import { saveBillingRulesAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, TimeTravelNote, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";

export const dynamic = "force-dynamic";

// Billing rules → Payment application (billing_rules_config.payment_application).
// `customer_chooses` needs portal screens that do not exist yet (Pay all, select invoices,
// refund an overpayment), so it is offered only when the API already set it.
const CUSTOMER_CHOOSES: Choice = {
  value: "customer_chooses",
  label: "The customer selects in the portal",
  consequence: "This value was set through the API. The portal does not show this choice yet.",
};

const SEVERAL_DUE: Choice[] = [
  {
    value: "separate",
    label: SEVERAL_DUE_LABELS.separate,
    consequence: "We charge each due invoice in its own payment.",
  },
  {
    value: "combined",
    label: SEVERAL_DUE_LABELS.combined,
    consequence:
      "When the retries of two or more invoices of one customer are due at the same time, we charge them in one payment. Each invoice keeps its own dunning schedule. We charge one each when the payment method is not a card, when the card has a mandate or needs advance notice to the bank (for example UPI Autopay, e-NACH and RBI card mandates), or when the total is more than the card limit.",
  },
];

const ORDER: Choice[] = [
  {
    value: "oldest_first",
    label: INVOICE_ORDER_LABELS.oldest_first,
    consequence:
      "A payment or credit that cannot pay every open invoice pays the invoice with the earliest due date first.",
  },
  {
    value: "newest_first",
    label: INVOICE_ORDER_LABELS.newest_first,
    consequence:
      "A payment or credit that cannot pay every open invoice pays the invoice with the latest due date first.",
  },
];

const EXCESS: Choice[] = [
  {
    value: "credit",
    label: EXCESS_PAYMENT_LABELS.credit,
    consequence: "The amount more than the invoice is customer credit. It pays the next invoice.",
  },
  {
    value: "refund",
    label: EXCESS_PAYMENT_LABELS.refund,
    consequence:
      "We return the amount more than the invoice to the card that paid it. A bank debit and an offline payment stay customer credit, and you can refund them by hand.",
  },
];

const withCurrent = (options: Choice[], current: string) =>
  current === "customer_chooses" ? [...options, CUSTOMER_CHOOSES] : options;

export default async function PaymentApplicationSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const pa = paymentApplication(b);

  return (
    <SettingsPage
      title="Payment application"
      crumbs={ruleCrumbs(biz, "Payment application")}
      description="How we charge several due invoices, which open invoice a payment pays first, and what we do with a payment that is more than the invoice."
    >
      <ActionForm action={saveBillingRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <>
              <SettingsSummary
                items={[
                  {
                    label: "Several due invoices",
                    value: SEVERAL_DUE_LABELS[pa.several_due_invoices],
                  },
                  { label: "Open invoices", value: INVOICE_ORDER_LABELS[pa.invoice_order] },
                  { label: "Excess payment", value: EXCESS_PAYMENT_LABELS[pa.excess_payment] },
                ]}
              />
              <TimeTravelNote biz={biz} />
            </>
          }
          save={{ note: "Applies to the next charge, payment and collection." }}
        >
          <SettingsCard title="Charges" meta="Automatic retries">
            <ChoiceRow
              name="pa_several_due_invoices"
              label="Several due invoices"
              defaultValue={pa.several_due_invoices}
              options={withCurrent(SEVERAL_DUE, pa.several_due_invoices)}
            />
          </SettingsCard>
          <SettingsCard title="Open invoices" meta="Collect payment and payment requests">
            <ChoiceRow
              name="pa_invoice_order"
              label="Pay first"
              defaultValue={pa.invoice_order}
              options={withCurrent(ORDER, pa.invoice_order)}
            />
          </SettingsCard>
          <SettingsCard title="Excess payment" meta="Card payments">
            <ChoiceRow
              name="pa_excess_payment"
              label="When a payment is more than the invoice"
              defaultValue={pa.excess_payment}
              options={withCurrent(EXCESS, pa.excess_payment)}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
