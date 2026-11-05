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
import { saveUsageCloseDelayAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { UsageCloseDelayRow } from "./delay-row";

export const dynamic = "force-dynamic";

// Billing rules → Usage close (`usage_close_delay_minutes`, 0454). A subscription with a
// meter price renews once usage folding has passed period end + this delay, capped at 30 min.
export default async function UsageCloseSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  const delay = b.usage_close_delay_minutes ?? 0;

  return (
    <SettingsPage
      title="Usage close"
      crumbs={ruleCrumbs(biz, "Usage close")}
      description="When we stop counting a period's usage events and bill them. This applies to subscriptions with a price on a meter."
    >
      <ActionForm action={saveUsageCloseDelayAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Usage closes",
                  value: `About ${6 + delay} minutes after the period ends`,
                },
              ]}
            />
          }
          save={{ note: "Applies to periods that end from now on." }}
        >
          <SettingsCard title="Usage" meta="Meter prices">
            <UsageCloseDelayRow defaultValue={delay} />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
