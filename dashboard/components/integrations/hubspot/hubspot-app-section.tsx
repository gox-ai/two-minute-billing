import type { ConnectedHubSpot } from "@/lib/api/hubspot";
import { getHubSpotProperties } from "@/lib/api/hubspot";
import { Alert } from "@/components/ui/alert";
import { CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioField } from "@/components/ui/radio-group";
import { SettingRow, ToggleAnswer } from "@/components/patterns/settings-page";
import { RecordCard } from "@/components/patterns/record-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { saveHubSpotAppAction } from "@/app/(dashboard)/businesses/[biz]/integrations/hubspot/actions-app";

/** In-HubSpot features: the record card's "Create subscription" button and the workflow actions. */
export async function HubSpotAppSection({ biz, hs }: { biz: string; hs: ConnectedHubSpot }) {
  const d = hs.settings.deals;
  const dealProps = await getHubSpotProperties(biz, "deals")
    .then((r) => r.data)
    .catch(() => null);
  const portalTypes = dealProps?.find((p) => p.name === "dealtype")?.options ?? null;
  // Saved values the portal no longer offers stay visible, so saving never drops them silently.
  const known = new Set((portalTypes ?? []).map((o) => o.value));
  const dealTypes = portalTypes
    ? [
        ...portalTypes,
        ...d.editDealTypes.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v })),
      ]
    : null;
  const hasAutomation = hs.scopes.includes("automation");

  return (
    <ActionForm action={saveHubSpotAppAction} className="space-y-3">
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="deal_types_mode" value={dealTypes ? "list" : "text"} />
      {!dealTypes ? (
        <Alert tone="warning" title="We could not load the HubSpot deal types.">
          Enter the deal type values as HubSpot stores them. Put a comma between values. For
          example: existingbusiness.
        </Alert>
      ) : null}
      {!hasAutomation ? (
        <Alert tone="info" title="Workflow actions need the automation permission.">
          To use Create subscription and Edit subscription in workflows, reconnect HubSpot and
          approve workflow access.
        </Alert>
      ) : null}
      <RecordCard
        title="In HubSpot"
        flush
        footer={
          <div className="flex justify-end">
            <SubmitButton size="sm" variant="outline">
              Save HubSpot options
            </SubmitButton>
          </div>
        }
      >
        <div className="divide-y">
          <SettingRow
            question="Create subscriptions manually from HubSpot?"
            help="Shows a Create subscription button on the billing card of contacts, companies and deals. When off, subscriptions come only from workflows."
          >
            <ToggleAnswer
              name="manual_create"
              defaultChecked={d.manualCreate}
              label="Create subscriptions manually from HubSpot"
            />
          </SettingRow>
          <SettingRow
            question="Deal types that edit a subscription"
            help="In workflows, a deal of one of these types changes the subscription linked to it. Every other deal type creates a new subscription."
          >
            {dealTypes ? (
              <div className="flex flex-col gap-2 text-left">
                {dealTypes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">This portal has no deal types.</p>
                ) : (
                  dealTypes.map((o) => (
                    <CheckboxField
                      key={o.value}
                      name="edit_deal_types"
                      value={o.value}
                      label={o.label}
                      defaultChecked={d.editDealTypes.includes(o.value)}
                    />
                  ))
                )}
              </div>
            ) : (
              <Input
                name="edit_deal_types_text"
                aria-label="Deal types that edit a subscription, comma separated"
                defaultValue={d.editDealTypes.join(", ")}
                className="sm:w-72"
              />
            )}
          </SettingRow>
          <SettingRow
            question="How a deal discount reaches the subscription"
            help="Workflows pass the discount as a percentage, an amount per billing period, or a coupon code."
          >
            <RadioField
              name="discount_mode"
              ariaLabel="How a deal discount reaches the subscription"
              defaultValue={d.discountMode}
              className="text-left"
              options={[
                {
                  value: "price_override",
                  label: "Lower the plan's unit price",
                  hint: "Flat and per-unit plans only. We refuse other plans.",
                },
                {
                  value: "coupon",
                  label: "Apply it as a discount",
                  hint: "The coupon code, if the workflow gives one. If not, a discount of that percentage or amount that does not end.",
                },
                { value: "ignore", label: "Ignore deal discounts" },
              ]}
            />
          </SettingRow>
        </div>
      </RecordCard>
    </ActionForm>
  );
}
