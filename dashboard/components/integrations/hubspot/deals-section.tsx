import type {
  ConnectedHubSpot,
  HubSpotProperty,
  HubSpotSubscriptionStatus,
} from "@/lib/api/hubspot";
import {
  getHubSpotLocalFields,
  getHubSpotPipelines,
  getHubSpotProperties,
} from "@/lib/api/hubspot";
import { Alert } from "@/components/ui/alert";
import { CheckboxField } from "@/components/ui/checkbox";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { SelectAnswer, SettingRow, ToggleAnswer } from "@/components/patterns/settings-page";
import { RecordCard } from "@/components/patterns/record-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { FieldMappingEditor } from "@/components/integrations/hubspot/field-mapping-editor";
import { saveHubSpotDealsAction } from "@/app/(dashboard)/businesses/[biz]/integrations/hubspot/actions-deals";

const STATUSES: Array<{ value: HubSpotSubscriptionStatus; label: string }> = [
  { value: "future", label: "Future" },
  { value: "in_trial", label: "In trial" },
  { value: "active", label: "Active" },
  { value: "non_renewing", label: "Non-renewing" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
];

const LOCAL_LABEL: Record<string, string> = {
  id: "Subscription ID",
  status: "Status",
  plan: "Plan",
  plan_id: "Plan price ID",
  plan_amount: "Plan amount",
  plan_quantity: "Plan quantity",
  mrr: "MRR",
  arr: "ARR",
  next_billing_at: "Next billing date",
  next_billing_amount: "Next billing amount",
  current_term_start: "Current term start",
  current_term_end: "Current term end",
  trial_end: "Trial end",
  cancelled_at: "Cancelled at",
  auto_collection: "Auto-collection",
  billing_period: "Billing period",
  currency: "Currency",
  coupon: "Coupon codes",
};

const TOKENS = ["{customer_id}", "{subscription_id}", "{customer_name}", "{company}", "{plan}"];

const localOption = (value: string): ComboboxOption =>
  value.startsWith("cf_")
    ? { value, label: `${value.slice(3)} (custom field)`, keywords: value }
    : { value, label: LOCAL_LABEL[value] ?? value, keywords: value };

const remoteOption = (p: HubSpotProperty): ComboboxOption => ({
  value: p.name,
  label: p.label,
  keywords: p.name,
  hint: p.unique ? `${p.name} · unique` : p.name,
});

/** The saved value stays selectable even when discovery failed or the property is gone. */
const withValue = <T extends { value: string; label: string }>(
  options: T[],
  value: string | null | undefined,
) =>
  !value || options.some((o) => o.value === value)
    ? options
    : [{ value, label: value } as T, ...options];

/** Subscriptions → deals: which sync, how they match, what they carry, and where they sit. */
export async function DealsSection({ biz, hs }: { biz: string; hs: ConnectedHubSpot }) {
  const d = hs.settings.deals;
  const [dealProps, pipelines, locals] = await Promise.all([
    getHubSpotProperties(biz, "deals")
      .then((r) => r.data)
      .catch(() => null),
    getHubSpotPipelines(biz)
      .then((r) => r.data)
      .catch(() => null),
    getHubSpotLocalFields(biz).catch(() => null),
  ]);

  const writable = (dealProps ?? []).filter((p) => p.writable);
  const dealTargets = writable.map(remoteOption);
  // Unique properties first: HubSpot then refuses a second deal carrying the same id.
  const idOptions = withValue(
    [
      { value: "", label: "Do not match on a property" },
      ...writable.filter((p) => p.unique).map(remoteOption),
      ...writable.filter((p) => !p.unique).map(remoteOption),
    ],
    d.subscriptionIdProperty,
  );
  const dealLocals = (locals?.deals ?? []).map(localOption);
  const pipeline = pipelines?.find((p) => p.id === d.pipelineId) ?? null;
  const stageOptions = [
    { value: "", label: "Do not change stage" },
    ...(pipeline?.stages ?? []).map((s) => ({
      value: s.id,
      label: s.closed ? `${s.label} (closed)` : s.label,
    })),
  ];

  return (
    <ActionForm action={saveHubSpotDealsAction} className="space-y-3">
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="saved_pipeline_id" value={d.pipelineId ?? ""} />
      {pipelines ? <input type="hidden" name="pipelines_loaded" value="1" /> : null}
      {!dealProps || !pipelines ? (
        <Alert tone="warning" title="We could not load the HubSpot deal properties or pipelines.">
          {pipelines
            ? "The property lists below show only what is already saved."
            : "The pipeline and stages stay as saved until HubSpot responds."}{" "}
          You can still save the other deal settings.
        </Alert>
      ) : null}
      <RecordCard
        title="Deals"
        flush
        footer={
          <div className="flex justify-end">
            <SubmitButton size="sm" variant="outline">
              Save deal sync
            </SubmitButton>
          </div>
        }
      >
        <div className="divide-y">
          <SettingRow question="Sync subscriptions to deals?">
            <ToggleAnswer
              name="enabled"
              defaultChecked={d.enabled}
              label="Sync subscriptions to deals"
            />
          </SettingRow>
          <SettingRow
            question="Which subscription statuses sync?"
            help="We do not sync a subscription in a different status, and we do not change its deal."
          >
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-left">
              {STATUSES.map((s) => (
                <CheckboxField
                  key={s.value}
                  name="statuses"
                  value={s.value}
                  label={s.label}
                  defaultChecked={d.statuses.includes(s.value)}
                />
              ))}
            </div>
          </SettingRow>
          <SettingRow question="When a subscription has no deal yet">
            <SelectAnswer
              name="mode"
              defaultValue={d.mode}
              options={[
                { value: "link_or_create", label: "Link a matching deal, or create one" },
                { value: "create", label: "Always create a new deal" },
              ]}
            />
          </SettingRow>
          <SettingRow
            question="Deal property holding the subscription ID"
            help="We link a deal to the subscription if its value equals the subscription ID. We write the ID here on new deals. Select a property with unique values. HubSpot then refuses a duplicate, so a retried sync cannot create a second deal."
          >
            <Combobox
              name="subscription_id_property"
              size="sm"
              className="sm:w-60"
              ariaLabel="Deal property holding the subscription ID"
              defaultValue={d.subscriptionIdProperty ?? ""}
              options={idOptions}
            />
          </SettingRow>
          <SettingRow
            question="Also match an open deal on the customer's contact?"
            help="If no deal has the subscription ID, we link the newest open deal on the customer's contact. No other subscription can hold that deal."
          >
            <ToggleAnswer
              name="match_by_association"
              defaultChecked={d.matchByAssociation}
              label="Match an open deal on the customer's contact"
            />
          </SettingRow>
          <SettingRow
            question="When a linked subscription changes"
            help='Updates also stop when "When a linked customer changes here" is set to leave HubSpot as it is.'
          >
            <SelectAnswer
              name="on_change"
              defaultValue={d.onChange}
              options={[
                { value: "update", label: "Update the deal" },
                { value: "nothing", label: "Leave the deal as it is" },
              ]}
            />
          </SettingRow>
          <SettingRow
            question="Deal amount"
            help="In the currency of the subscription. MRR is what the subscription earns now, so it is 0 during a trial."
          >
            <SelectAnswer
              name="amount"
              defaultValue={d.amount}
              options={[
                { value: "mrr", label: "MRR" },
                { value: "arr", label: "ARR (MRR × 12)" },
                { value: "next_billing_amount", label: "Next billing amount" },
              ]}
            />
          </SettingRow>
          <SettingRow question="Deal name" help={`Tokens: ${TOKENS.join(" ")}`}>
            <Input
              name="name_format"
              aria-label="Deal name format"
              className="h-8 sm:w-72"
              defaultValue={d.nameFormat}
              maxLength={200}
              required
            />
          </SettingRow>
          <SettingRow
            question="Pipeline"
            help="We create new deals in this pipeline."
            note="A change of pipeline clears the stage map. Save. Then map the stages of the new pipeline."
          >
            <SelectField
              name="pipeline_id"
              size="sm"
              className="sm:w-60"
              ariaLabel="Deal pipeline"
              defaultValue={d.pipelineId ?? ""}
              disabled={!pipelines}
              options={withValue(
                [
                  { value: "", label: "HubSpot default pipeline" },
                  ...(pipelines ?? []).map((p) => ({ value: p.id, label: p.label })),
                ],
                d.pipelineId,
              )}
            />
          </SettingRow>
          <div className="space-y-3 px-5 py-4">
            <div>
              <div className="text-sm font-medium text-foreground">Deal stage for each status</div>
              <p className="mt-1 text-xs text-muted-foreground">
                A status set to "Do not change stage" keeps an existing deal in its current stage. A
                new deal starts in the first stage of the pipeline.
              </p>
            </div>
            {!d.pipelineId ? (
              <p className="text-sm text-muted-foreground">
                To map the stages, select a pipeline and save it.
              </p>
            ) : !pipeline ? (
              <p className="text-sm text-muted-foreground">
                {pipelines
                  ? "The saved pipeline is not in HubSpot now. Select a different pipeline."
                  : "Stages load when HubSpot responds."}
              </p>
            ) : (
              <div className="space-y-2">
                {STATUSES.map((s) => (
                  <div key={s.value} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <span className="text-sm text-foreground sm:w-40">{s.label}</span>
                    <SelectField
                      name={`stage_${s.value}`}
                      size="sm"
                      className="sm:w-64"
                      ariaLabel={`Deal stage for ${s.label}`}
                      defaultValue={d.stageMap[s.value] ?? ""}
                      options={withValue(stageOptions, d.stageMap[s.value])}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-3 px-5 py-4">
            <div>
              <div className="text-sm font-medium text-foreground">Deal fields</div>
              <p className="mt-1 text-xs text-muted-foreground">
                We always send name, amount, currency, pipeline and stage. Map up to 15 more fields.
              </p>
            </div>
            <FieldMappingEditor
              name="deal_fields"
              defaultRows={d.fields}
              remoteOptions={dealTargets}
              localOptions={dealLocals}
            />
          </div>
        </div>
      </RecordCard>
    </ActionForm>
  );
}
