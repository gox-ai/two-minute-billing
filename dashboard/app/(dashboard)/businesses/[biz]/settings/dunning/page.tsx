import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { buttonVariants } from "@/components/ui/button";
import {
  SettingsCard,
  SettingsColumns,
  SettingsLinkRow,
  SettingsPage,
  SettingsSummary,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { listDunningPolicies } from "@/lib/api/dunning-policies";
import { saveDunningAction } from "../actions";
import { DunningFields } from "./dunning-form";
import { dunningDefaults, dunningSummaryItems } from "./defaults";

export const dynamic = "force-dynamic";

// Settings → Dunning. "Collect on payment method update" lives inside dunning_config,
// so it is saved with the schedule; Billing rules links here for that row.
export default async function DunningSettings({ params }: { params: Promise<{ biz: string }> }) {
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

  // Every default is what `resolveDunningConfig` resolves for this business, so the
  // screen previews the real outcome.
  const d = dunningDefaults(b.dunning_config, b, { legacyDays: true });

  // Non-critical: without the count the row still links to the list.
  const policies = await listDunningPolicies(biz).catch(() => null);
  const policyCount = policies?.data.length;
  const policyCustomers = policies?.data.reduce((n, p) => n + p.customer_count, 0) ?? 0;

  // With no period an offline invoice's chase never closes: it is never retried, so
  // the period is the only thing that can end it.
  const attention: AttentionItem[] =
    d.dunOffline && d.periodDays == null
      ? [
          {
            key: "offline-no-period",
            tone: "warning",
            title: "Dunning for offline invoices has no end date",
            detail:
              "Send-invoice dunning is enabled, but no dunning period is set. We send a reminder for an unpaid offline invoice on each retry day. The invoice stays open until someone pays it or writes it off.",
            actions: (
              <a href="#period" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Set a dunning period
              </a>
            ),
          },
        ]
      : [];

  return (
    <SettingsPage
      title="Dunning for failed payments"
      crumbs={[{ label: "Settings", href: `/businesses/${biz}/settings` }, { label: "Dunning" }]}
      description="What we do when a customer’s payment fails. It sets which declines we retry and when. It also sets what happens to an unpaid invoice and its subscription."
      attention={attention}
    >
      <SettingsCard
        title="Customer policies"
        meta="Different dunning settings for selected customers"
      >
        <SettingsLinkRow
          title="Dunning policies"
          description="Named sets of these settings. Assign a policy to a customer to use it in place of the business settings below."
          value={
            policyCount == null
              ? undefined
              : policyCount === 0
                ? "None"
                : `${policyCount} ${policyCount === 1 ? "policy" : "policies"} · ${policyCustomers} ${policyCustomers === 1 ? "customer" : "customers"}`
          }
          href={`/businesses/${biz}/settings/dunning/policies`}
        />
      </SettingsCard>

      <ActionForm action={saveDunningAction}>
        <input type="hidden" name="biz" value={biz} />
        {b.resource_version != null ? (
          <input type="hidden" name="expected_version" value={b.resource_version} />
        ) : null}
        <SettingsColumns
          summary={<SettingsSummary items={dunningSummaryItems(d)} />}
          save={{ note: "Changes apply to the next payment that fails." }}
        >
          <DunningFields d={d} />
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
