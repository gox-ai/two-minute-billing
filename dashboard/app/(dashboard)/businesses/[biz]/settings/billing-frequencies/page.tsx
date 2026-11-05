import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { BillingFrequenciesField } from "@/components/settings/billing-frequencies-field";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveBillingFrequenciesAction } from "../actions";

export const dynamic = "force-dynamic";

// The field's labels, for the server-rendered summary (a client module's helpers cannot
// be called here). Keep in step with STANDARD in billing-frequencies-field.tsx.
const NAMED: Record<string, string> = {
  "day:1": "Daily",
  "week:1": "Weekly",
  "day:14": "14 Days",
  "month:1": "Monthly",
  "month:3": "Quarterly",
  "month:6": "Half-yearly",
  "year:1": "Yearly",
  "year:10": "10 Years",
};
const frequencyLabel = (f: { interval: string; count: number }) =>
  NAMED[`${f.interval}:${f.count}`] ??
  `${f.count > 1 ? `${f.count} ` : ""}${f.interval}${f.count > 1 ? "s" : ""}`;

// Settings → Billing frequencies: the allow-list createPrice enforces for RECURRING
// prices. One-time prices carry no interval and are never restricted.
export default async function BillingFrequencySettings({
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

  const saved = b.billing_frequencies ?? [];

  return (
    <SettingsPage
      title="Billing frequencies"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Billing frequencies" },
      ]}
      description="Which billing frequencies recurring prices for plans and add-ons may use."
    >
      <ActionForm action={saveBillingFrequenciesAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Allowed",
                  value: saved.length ? saved.map(frequencyLabel).join(", ") : "Any frequency",
                },
              ]}
            />
          }
          save={{ note: "Prices that already exist keep their frequency." }}
        >
          <SettingsCard title="Frequencies offered" meta="Leave all unchecked to allow any">
            <div className="px-5 py-4">
              <BillingFrequenciesField defaultValue={b.billing_frequencies} />
            </div>
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
