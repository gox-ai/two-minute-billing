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
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";

export const dynamic = "force-dynamic";

// Billing rules → Auto-collection for new customers
// (billing_rules_config.new_customer_auto_collection).
const OPTIONS: Choice[] = [
  {
    value: "on",
    label: "On",
    consequence: "We charge the customer's payment method when an invoice is due.",
  },
  {
    value: "off",
    label: "Off",
    consequence:
      "We send each invoice to the customer, and the customer pays it. We do not charge a payment method.",
  },
];

export default async function NewCustomerSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const value = billingRules(b).new_customer_auto_collection;

  return (
    <SettingsPage
      title="Auto-collection for new customers"
      crumbs={ruleCrumbs(biz, "Auto-collection for new customers")}
      description="The auto-collection setting a new customer gets when you create it without one."
    >
      <ActionForm action={saveBillingRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[{ label: "New customers", value: value === "on" ? "On" : "Off" }]}
            />
          }
          save={{
            note: "Applies to customers created after you save. Existing customers keep their setting.",
          }}
        >
          <SettingsCard title="New customers" meta="Created in the dashboard or the API">
            <ChoiceRow
              name="new_customer_auto_collection"
              label="Auto-collection"
              help="You can change it for each customer and each subscription."
              defaultValue={value}
              options={OPTIONS}
              more="Customers from the hosted checkout always get auto-collection on, because they gave a payment method at checkout."
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
