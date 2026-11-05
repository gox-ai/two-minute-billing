import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { billingRules } from "@/lib/billing-rules";
import { saveBillingRulesAction } from "../../actions";
import { SwitchRow } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";

export const dynamic = "force-dynamic";

// Billing rules → Required reasons (billing_rules_config.required_reasons). The API refuses
// the action (400) without the reason; the dialogs mark the field required.
export default async function RequiredReasonsSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const r = billingRules(b).required_reasons;
  const yes = (v: boolean) => (v ? "Required" : "Optional");
  const codes = (
    <Link
      href={`/businesses/${biz}/settings/reason-codes`}
      className="text-primary hover:underline"
    >
      Reason codes
    </Link>
  );

  return (
    <SettingsPage
      title="Required reasons"
      crumbs={ruleCrumbs(biz, "Required reasons")}
      description="Actions that need a reason before we do them. This applies in the dashboard and in the API."
    >
      <ActionForm action={saveBillingRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <input type="hidden" name="required_reasons_form" value="1" />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Cancel a subscription", value: yes(r.cancel_subscription) },
                { label: "Void an invoice", value: yes(r.void_invoice) },
                { label: "Create a credit note", value: yes(r.create_credit_note) },
                { label: "Refund", value: yes(r.refund) },
              ]}
            />
          }
          save={{ note: "Applies to the next action." }}
        >
          <SettingsCard title="Reasons" meta="Operators and API calls">
            <SwitchRow
              name="require_reason_cancel_subscription"
              label="Cancel a subscription"
              help={<>The cancellation reasons come from {codes}.</>}
              defaultChecked={r.cancel_subscription}
              on="A cancellation without a reason code fails."
              off="A reason code is optional."
              more="Cancellations that the system does, for example after dunning, do not need a reason."
            />
            <SwitchRow
              name="require_reason_void_invoice"
              label="Void an invoice"
              defaultChecked={r.void_invoice}
              on="A void without a reason fails."
              off="A reason is optional."
            />
            <SwitchRow
              name="require_reason_create_credit_note"
              label="Create a credit note"
              defaultChecked={r.create_credit_note}
              on="A credit note without a reason code fails."
              off="A reason code is optional."
            />
            <SwitchRow
              name="require_reason_refund"
              label="Refund"
              defaultChecked={r.refund}
              on="A refund of a payment or a credit note without a reason fails."
              off="A reason is optional."
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
