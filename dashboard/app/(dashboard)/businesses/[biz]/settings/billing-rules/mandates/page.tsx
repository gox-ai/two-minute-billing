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
import { saveMandateSizingAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { MandateRows } from "./mandate-rows";
import { DEFAULT_HEADROOM_BPS, DEFAULT_RAIL_CAP_MINOR } from "./defaults";

export const dynamic = "force-dynamic";

// Billing rules → Mandates (`mandate_config`, resolveMandateHeadroomConfig). Preselects the
// resolved values; a value equal to the platform default is saved as unset.
export default async function MandateSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  const bps = Number(b.mandate_config?.headroom_bps ?? DEFAULT_HEADROOM_BPS);
  const capMinor = Number(b.mandate_config?.rail_ceiling_cap_minor ?? DEFAULT_RAIL_CAP_MINOR);
  const multiple = bps / 10_000;
  const capRupees = Math.round(capMinor / 100);

  return (
    <SettingsPage
      title="Mandates"
      crumbs={ruleCrumbs(biz, "Mandates")}
      description="How large a recurring-payment mandate we ask the customer to approve, for UPI Autopay, e-mandate and card mandates."
    >
      <ActionForm action={saveMandateSizingAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Ceiling", value: `${multiple}× the next charge` },
                { label: "Cap", value: `₹${capRupees.toLocaleString("en-IN")}` },
              ]}
            />
          }
          save={{
            note: "Applies to mandates that customers approve from now on. Existing mandates keep their ceiling.",
          }}
        >
          <SettingsCard title="Mandate size" meta="Automatic payments">
            <MandateRows multiple={multiple} capRupees={capRupees} />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
