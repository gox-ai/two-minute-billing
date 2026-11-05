import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import type { DunningPolicy } from "@/lib/api/dunning-policies";
import { DunningFields, type DunningDefaults } from "../dunning-form";
import { dunningSummaryItems } from "../defaults";
import { createDunningPolicyAction, updateDunningPolicyAction } from "./actions";

/**
 * Create and edit share one form: the policy's name, code and description, then the
 * per-invoice dunning fields of the business page. The business-wide switches are not
 * rendered: a policy does not hold them.
 */
export function PolicyForm({
  biz,
  d,
  policy,
}: {
  biz: string;
  d: DunningDefaults;
  /** Absent on create. */
  policy?: DunningPolicy;
}) {
  return (
    <ActionForm action={policy ? updateDunningPolicyAction : createDunningPolicyAction}>
      <input type="hidden" name="biz" value={biz} />
      {policy ? (
        <>
          <input type="hidden" name="dpol" value={policy.id} />
          <input type="hidden" name="expected_version" value={policy.resource_version} />
        </>
      ) : null}
      <SettingsColumns
        summary={
          <SettingsSummary
            // On create nothing is saved yet: the form starts as a copy of the business settings.
            title={policy ? undefined : "Copied from the business settings"}
            items={[
              policy && {
                label: "Customers",
                value:
                  policy.customer_count === 0
                    ? "No customers use this policy"
                    : `${policy.customer_count} ${policy.customer_count === 1 ? "customer uses" : "customers use"} this policy`,
              },
              ...dunningSummaryItems(d),
            ]}
          />
        }
        save={{
          label: policy ? "Save policy" : "Create policy",
          note: policy
            ? "Changes apply to the next payment that fails for a customer with this policy."
            : "The policy applies when you assign it to a customer.",
        }}
      >
        <SettingsCard title="Policy">
          <SettingRow
            label="Name"
            htmlFor="name"
            errorFor="name"
            help="Your team sees this name on the customer page and in the customer form."
            control={
              <Input
                id="name"
                name="name"
                required
                maxLength={200}
                defaultValue={policy?.name ?? ""}
                placeholder="For example: Enterprise accounts"
              />
            }
          />
          <SettingRow
            label="Code"
            htmlFor="code"
            errorFor="code"
            help="A unique key for this policy in the API. Each policy in this business must have a different code."
            control={
              <Input
                id="code"
                name="code"
                required
                maxLength={64}
                defaultValue={policy?.code ?? ""}
                placeholder="enterprise"
                className="font-mono sm:w-72"
              />
            }
          />
          <SettingRow
            label="Description"
            htmlFor="description"
            errorFor="description"
            help="Optional. Who this policy is for."
            control={
              <Textarea
                id="description"
                name="description"
                rows={2}
                maxLength={2000}
                defaultValue={policy?.description ?? ""}
              />
            }
          />
        </SettingsCard>
        <DunningFields d={d} policy />
      </SettingsColumns>
    </ActionForm>
  );
}
