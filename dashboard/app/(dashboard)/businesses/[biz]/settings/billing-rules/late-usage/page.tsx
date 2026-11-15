import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { billingRules } from "@/lib/billing-rules";
import { money } from "@/lib/format";
import { plural } from "@/lib/labels";
import { businessCurrencies } from "../_parts/currency-amounts";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";
import { saveLateUsageAction } from "./actions";
import { LateUsageRows } from "./rows";

export const dynamic = "force-dynamic";

// Billing rules → Late usage after a cancellation (billing_rules_config.late_usage_invoices).
export default async function LateUsageSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const late = billingRules(b).late_usage_invoices;
  const set = Object.entries(late.minimum);

  return (
    <SettingsPage
      title="Late usage after a cancellation"
      crumbs={ruleCrumbs(biz, "Late usage after a cancellation")}
      description="What we do with usage for an invoiced period that arrives after the last invoice of a cancelled subscription."
    >
      <ActionForm action={saveLateUsageAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Late usage", value: late.enabled ? "One more invoice" : "Not billed" },
                {
                  label: "Smallest amount",
                  value: set.length ? set.map(([c, m]) => money(m, c)).join(", ") : "Any amount",
                },
                { label: "Wait before the invoice", value: plural(late.wait_hours, "hour") },
                {
                  label: "Invoices for one customer",
                  value: `At most one each ${plural(late.min_interval_hours, "hour")}`,
                },
              ]}
            />
          }
          save={{
            note: "When you enable this setting, we also invoice late usage from the last 36 days that is not billed yet.",
          }}
        >
          <SettingsCard title="Late usage" meta="Usage after a cancellation">
            <LateUsageRows
              defaultEnabled={late.enabled}
              minimum={late.minimum}
              waitHours={late.wait_hours}
              minIntervalHours={late.min_interval_hours}
              currencies={businessCurrencies(b, late.minimum)}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
