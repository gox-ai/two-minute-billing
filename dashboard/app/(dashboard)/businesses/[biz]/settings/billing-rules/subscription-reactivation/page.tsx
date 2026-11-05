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
import { saveReactivationAction } from "../../actions";
import { ChoiceRow, SwitchRow } from "../_parts/rows";
import { REACTIVATION_CHARGE_LABELS, lifecycleRules } from "@/lib/billing-rules";
import { FormIds, ruleCrumbs } from "../_parts/shared";

export const dynamic = "force-dynamic";

// Billing rules → Subscription reactivation. Split out of the Dunning page's
// "collect on payment method update": the two are independent preferences.
export default async function ReactivationSettings({
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

  const base = `/businesses/${biz}/settings`;
  const cfg = b.dunning_config;
  // Resolved as resolveDunningConfig does: an absent key inherits
  // `collect_on_payment_method_update`, the field it was split out of.
  const explicit = cfg?.require_successful_charge_on_reactivation;
  const requireCharge = explicit ?? cfg?.collect_on_payment_method_update ?? true;
  const charges = lifecycleRules(b).reactivation_charges;

  return (
    <SettingsPage
      title="Subscription reactivation"
      crumbs={ruleCrumbs(biz, "Subscription reactivation")}
      description="How a reactivation bills its new term, and what happens when its charge fails."
    >
      <ActionForm action={saveReactivationAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Failed reactivation charge",
                  value: requireCharge
                    ? "Reactivation refused"
                    : "Reactivates anyway, and dunning collects the invoice",
                },
                explicit == null && {
                  label: "Source",
                  value: "Not saved. Uses the payment collection setting on Dunning",
                },
                { label: "New term charge", value: REACTIVATION_CHARGE_LABELS[charges] },
              ]}
            />
          }
          save={{ note: "Applies to the next reactivation." }}
        >
          <SettingsCard title="Reactivation" meta="Cancelled subscriptions">
            <SwitchRow
              name="require_successful_charge_on_reactivation"
              label="Require a successful charge to reactivate"
              help="We charge the card before anything changes."
              defaultChecked={requireCharge}
              on="If the charge fails, we refuse the reactivation. We raise no invoice, and the subscription stays cancelled. We record only the failed payment. The API returns 402."
              off="The subscription reactivates anyway. Dunning then tries to collect the unpaid invoice, as after a failed renewal."
              more={
                <>
                  This setting does not apply when you create a subscription. We always refuse a
                  failed first charge. On the Reactivate screen, you can select a different outcome
                  for one reactivation. Until you save this setting, it uses the setting for{" "}
                  <Link href={`${base}/dunning`} className="text-primary hover:underline">
                    payment collection when a payment method is added
                  </Link>
                  .
                </>
              }
            />
            {/* billing_rules_config.reactivation_charges. A reactivation that continues the
            current term charges nothing. Keeping the old billing day is not offered: the
            first term would be shorter and we have no prorated first charge. */}
            <ChoiceRow
              name="reactivation_charges"
              label="Charge for the new term"
              help="Applies when a reactivation starts a new term and the request does not select. The reactivation form shows this selection."
              defaultValue={charges}
              options={[
                {
                  value: "invoice_immediately",
                  label: REACTIVATION_CHARGE_LABELS.invoice_immediately,
                  consequence:
                    "We invoice the new term when the subscription reactivates and collect it.",
                },
                {
                  value: "add_to_unbilled_charges",
                  label: REACTIVATION_CHARGE_LABELS.add_to_unbilled_charges,
                  consequence:
                    "The full amount of the new term waits as an unbilled charge for the next invoice. We charge nothing now.",
                },
              ]}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
