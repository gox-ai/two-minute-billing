import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { MANDATE_REVOKED_LABELS, billingRules } from "@/lib/billing-rules";
import { saveBillingRulesAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, TimeTravelNote, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";

export const dynamic = "force-dynamic";

// Billing rules → Revoked mandate (billing_rules_config.mandate_revoked). Applies when a
// charge fails with revocation_of_authorization or debit_not_authorized.
const ACTIONS = (dunningHref: string): Choice[] => [
  {
    value: "follow_dunning",
    label: MANDATE_REVOKED_LABELS.follow_dunning,
    consequence: (
      <>
        We stop the retries. The invoice and the subscription then get the end action that you set
        on{" "}
        <Link href={dunningHref} className="text-primary hover:underline">
          Dunning
        </Link>
        .
      </>
    ),
  },
  {
    value: "cancel_now",
    label: MANDATE_REVOKED_LABELS.cancel_now,
    consequence:
      "We stop the retries and cancel the subscription now. The invoice gets the dunning end action.",
  },
  {
    value: "cancel_at_term_end",
    label: MANDATE_REVOKED_LABELS.cancel_at_term_end,
    consequence:
      "We stop the retries. The subscription stays active until the current term ends, then cancels. The invoice gets the dunning end action.",
  },
  {
    value: "pause",
    label: MANDATE_REVOKED_LABELS.pause,
    consequence:
      "We stop the retries and pause the subscription now. The invoice gets the dunning end action.",
  },
  {
    value: "request_new_mandate",
    label: MANDATE_REVOKED_LABELS.request_new_mandate,
    consequence:
      "The subscription stays active, and we hold the invoice. We email the customer to add a new payment method, and we collect the invoice when they add one. If they do not add one before dunning ends, the invoice and the subscription get the dunning end action.",
  },
];

export default async function MandateRevokedSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const action = billingRules(b).mandate_revoked;

  return (
    <SettingsPage
      title="Revoked mandate"
      crumbs={ruleCrumbs(biz, "Revoked mandate")}
      description="What happens when a payment fails because the customer cancelled the mandate or told the bank to stop the debit."
    >
      <ActionForm action={saveBillingRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <>
              <SettingsSummary
                items={[{ label: "Revoked mandate", value: MANDATE_REVOKED_LABELS[action] }]}
              />
              <TimeTravelNote biz={biz} />
            </>
          }
          save={{ note: "Applies to the next payment that fails for this reason." }}
        >
          <SettingsCard title="Revoked mandate" meta="Payments the customer stopped">
            <ChoiceRow
              name="mandate_revoked"
              label="When a mandate is revoked"
              defaultValue={action}
              options={ACTIONS(`/businesses/${biz}/settings/dunning`)}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
