import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { TRIAL_END_LABELS, billingRules } from "@/lib/billing-rules";
import { saveBillingRulesAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, TimeTravelNote, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";

export const dynamic = "force-dynamic";

// Billing rules → Trial end (billing_rules_config.trial_end_action). "Customer chooses" is
// not offered: it needs a buyer-portal step that does not exist yet.
const ACTIONS: Choice[] = [
  {
    value: "activate",
    label: TRIAL_END_LABELS.activate,
    consequence:
      "The first paid term starts, and we invoice and collect it. If the subscription collects automatically and the customer has no payment method, we cancel it.",
  },
  {
    value: "cancel",
    label: TRIAL_END_LABELS.cancel,
    consequence: "The subscription ends with the trial. We raise no invoice.",
  },
  {
    value: "pause",
    label: TRIAL_END_LABELS.pause,
    consequence:
      "We pause the subscription and raise no invoice. When you resume it, the first paid term starts and we bill it.",
  },
];

export default async function TrialEndSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const action = billingRules(b).trial_end_action;

  return (
    <SettingsPage
      title="Trial end"
      crumbs={ruleCrumbs(biz, "Trial end")}
      description="What happens to a subscription when its trial ends."
    >
      <ActionForm action={saveBillingRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <>
              <SettingsSummary
                items={[{ label: "At trial end", value: TRIAL_END_LABELS[action] }]}
              />
              <TimeTravelNote biz={biz} />
            </>
          }
          save={{ note: "Applies to the next trial that ends." }}
        >
          <SettingsCard title="Trial end" meta="Trials that end on their own">
            <ChoiceRow
              name="trial_end_action"
              label="When a trial ends"
              help="A plan price can set its own trial-end action. That action wins."
              defaultValue={action}
              options={ACTIONS}
              more="When you end a trial from the subscription page, we always activate the subscription."
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
