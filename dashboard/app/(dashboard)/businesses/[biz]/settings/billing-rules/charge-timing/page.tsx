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
import { saveChargeTimingAction } from "../invoice-rules-actions";
import { ChoiceRow } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { CHARGE_TIMING_LABELS } from "./labels";

export const dynamic = "force-dynamic";

// Billing rules → Charge timing (`invoice_rules_config.charge_timing`, 0486). With
// `on_due_date` a renewal leaves the invoice `posted` and the due-date pass
// (invoicing/due.ts) charges it.
// Not offered: "Customer chooses". The customer portal has no control for it yet.
const OPTIONS = [
  {
    value: "at_creation",
    label: CHARGE_TIMING_LABELS.at_creation,
    consequence: "We charge a renewal invoice when we create it, also when it has payment terms.",
  },
  {
    value: "on_due_date",
    label: CHARGE_TIMING_LABELS.on_due_date,
    consequence:
      "A renewal invoice with payment terms stays open until its due date. Then we charge it. If the charge fails, dunning starts then. An invoice with no payment terms is charged at once.",
  },
];

export default async function ChargeTimingSettings({
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

  const timing = b.invoice_rules_config?.charge_timing ?? "at_creation";

  return (
    <SettingsPage
      title="Charge timing"
      crumbs={ruleCrumbs(biz, "Charge timing")}
      description="When we charge an automatically collected invoice that has payment terms."
    >
      <ActionForm action={saveChargeTimingAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary items={[{ label: "Charge", value: CHARGE_TIMING_LABELS[timing] }]} />
          }
          save={{ note: "Applies to renewals from now on." }}
        >
          <SettingsCard title="Charge timing" meta="Auto-collection on">
            <ChoiceRow
              name="charge_timing"
              label="When we charge"
              help="Payment terms come from the subscription, the customer or the business, in that order."
              defaultValue={timing}
              options={OPTIONS}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
