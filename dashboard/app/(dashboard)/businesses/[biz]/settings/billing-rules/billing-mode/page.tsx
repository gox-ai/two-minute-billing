import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { buttonVariants } from "@/components/ui/button";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { BILLING_MODES, billingModeIdOf } from "@/lib/billing-mode";
import { saveBillingModeAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { BillingModeField } from "./mode-field";

export const dynamic = "force-dynamic";

// Billing rules → Billing mode. Stored as two axes (anchor × proration); the page offers
// the three real modes by name and writes both (lib/billing-mode.ts). The mode is read
// live by the engine (billingModeFor), so it reaches existing subscriptions' next
// proration and renewal too — only dates already stored stay put.
export default async function BillingModeSettings({
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

  const base = `/businesses/${biz}/settings`;
  const mode = billingModeIdOf(b);
  const timezone = b.timezone || null;

  // Midnight-aligned terms floor to start-of-day in the business time zone; with none
  // set that silently means UTC.
  const attention: AttentionItem[] =
    mode === "day_based_legacy" && !timezone
      ? [
          {
            key: "no-timezone",
            tone: "warning",
            title: "Terms are aligned to midnight UTC",
            detail:
              "Midnight-aligned terms start at the beginning of the day in this business's time zone. This business has no time zone.",
            actions: (
              <Link
                href={`${base}/business-profile`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Set a time zone
              </Link>
            ),
          },
        ]
      : [];

  return (
    <SettingsPage
      title="Billing mode"
      crumbs={ruleCrumbs(biz, "Billing mode")}
      description="How we measure the billing period of a subscription: when terms start and end, and how we count proration."
      attention={attention}
    >
      <ActionForm action={saveBillingModeAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                { label: "Billing mode", value: BILLING_MODES[mode].label },
                { label: "Time zone", value: timezone ?? "Not set. We use UTC." },
              ]}
            />
          }
          save={{
            note: "From now on, new terms, renewals and mid-term changes use this mode. Dates that are already set do not change.",
          }}
        >
          <SettingsCard title="Billing period" meta="Select one">
            <BillingModeField defaultValue={mode} timezone={timezone} />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
