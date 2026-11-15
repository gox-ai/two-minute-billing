import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { listPrices } from "@/lib/api";
import { resetRules } from "@/lib/billing-rules";
import {
  USAGE_CLOSE_BASE_MINUTES,
  effectiveGraceRange,
  formatGrace,
  recurringIntervals,
} from "@/lib/usage-grace";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
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

// Billing rules → Usage close (`usage_close_delay_minutes`, 0454 / 0523): the usage grace
// window. A metered renewal runs ~6 min after the period ends; its invoice waits this long.
export default async function UsageCloseSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return <ErrorState title="We could not load the usage close settings." error={e} retry />;
  }
  if (!b)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;

  const delay = b.usage_close_delay_minutes ?? 0;
  // The billing periods in the catalog: the screen names the ones whose half caps the wait.
  const prices = await listPrices(biz).catch(() => null);
  const intervals = recurringIntervals(prices?.data ?? []);
  // The summary applies the same cap as the note under the field.
  const wait = effectiveGraceRange(delay, intervals);
  const after = (m: number) => formatGrace(USAGE_CLOSE_BASE_MINUTES + m);
  const creditsWait = resetRules(b).planCredits.grant_when === "invoice_paid";

  return (
    <SettingsPage
      title="Usage close"
      crumbs={ruleCrumbs(biz, "Usage close")}
      description="How long the invoice of a period with metered usage waits for late usage events before it finalizes. This applies to subscriptions with a metered price."
    >
      <ActionForm action={saveUsageCloseDelayAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  // Under pay-before-grant the credits wait for the payment, not for this time.
                  label: creditsWait ? "Renewal" : "Renewal and plan credits",
                  value: `About ${USAGE_CLOSE_BASE_MINUTES} minutes after the period ends`,
                },
                // The hub row states this figure, so the two screens agree.
                {
                  label: "Wait for late usage",
                  value:
                    delay === 0
                      ? "No wait"
                      : wait.low === wait.high
                        ? formatGrace(wait.low)
                        : `${formatGrace(wait.low)} to ${formatGrace(wait.high)}, by plan billing period`,
                },
                {
                  label: "Invoice finalizes",
                  value:
                    wait.low === wait.high
                      ? `About ${after(wait.low)} after the period ends`
                      : `About ${after(wait.low)} to ${after(wait.high)} after the period ends, by plan billing period`,
                },
              ]}
            />
          }
          save={{ note: "Applies to periods that end from now on." }}
        >
          <SettingsCard title="Usage" meta="Metered prices">
            <UsageCloseDelayRow defaultValue={delay} intervals={intervals} />
          </SettingsCard>
          {creditsWait && delay > 0 ? (
            <Alert tone="info">
              Plan credits start when the invoice is paid. The new period&apos;s credits wait until
              this wait ends and the invoice is paid.
            </Alert>
          ) : null}
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
