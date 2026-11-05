import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import {
  ALLOWANCE_UPGRADE_LABELS,
  CREDIT_CANCEL_LABELS,
  CREDIT_DOWNGRADE_LABELS,
  CREDIT_PAUSE_LABELS,
  CREDIT_UPGRADE_LABELS,
  FIRST_WINDOW_LABELS,
  resetRules,
} from "@/lib/billing-rules";
import { saveBillingRulesAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, TimeTravelNote, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";

export const dynamic = "force-dynamic";

// Billing rules → Credit and allowance resets (billing_rules_config.plan_credits and
// .allowances, design-G3b § 6). They apply to credits and allowances that renew on their
// own clock ("Renews" on a price's Grants credit card or an allowance).

const UPGRADE: Choice[] = [
  {
    value: "full",
    label: CREDIT_UPGRADE_LABELS.full,
    consequence: "The new plan's credits for the current window are given at the change.",
  },
  {
    value: "prorated",
    label: CREDIT_UPGRADE_LABELS.prorated,
    consequence:
      "The new plan's credits are given at the change, for the part of the window that is left.",
  },
  {
    value: "next_window",
    label: CREDIT_UPGRADE_LABELS.next_window,
    consequence: "The new plan's credits start when the next window starts.",
  },
];

const DOWNGRADE: Choice[] = [
  {
    value: "next_window",
    label: CREDIT_DOWNGRADE_LABELS.next_window,
    consequence: "The new plan's credits start when the next window starts.",
  },
  {
    value: "full",
    label: CREDIT_DOWNGRADE_LABELS.full,
    consequence: "The new plan's credits for the current window are given at the change.",
  },
];

const FIRST_WINDOW: Choice[] = [
  {
    value: "full",
    label: FIRST_WINDOW_LABELS.full,
    consequence: "A window that the subscription start cuts short gives the full credits.",
  },
  {
    value: "prorated",
    label: FIRST_WINDOW_LABELS.prorated,
    consequence: "A window that the subscription start cuts short gives credits for its length.",
  },
  {
    value: "next_full_window",
    label: FIRST_WINDOW_LABELS.next_full_window,
    consequence: "The first credits come when the first full window starts.",
  },
];

const PAUSE: Choice[] = [
  {
    value: "skip",
    label: CREDIT_PAUSE_LABELS.skip,
    consequence: "A window that starts while the subscription is paused gives no credits.",
  },
  {
    value: "keep_granting",
    label: CREDIT_PAUSE_LABELS.keep_granting,
    consequence: "Each window gives credits, also while the subscription is paused.",
  },
  {
    value: "shift",
    label: CREDIT_PAUSE_LABELS.shift,
    consequence:
      "The windows stop while the subscription is paused, and start again when it resumes.",
  },
];

const CANCEL: Choice[] = [
  {
    value: "grant_started_window",
    label: CREDIT_CANCEL_LABELS.grant_started_window,
    consequence: "Each window that starts before the subscription ends gives credits.",
  },
  {
    value: "stop_at_request",
    label: CREDIT_CANCEL_LABELS.stop_at_request,
    consequence: "No window gives credits after the cancellation is scheduled.",
  },
];

const ALLOWANCE: Choice[] = [
  {
    value: "new_window",
    label: ALLOWANCE_UPGRADE_LABELS.new_window,
    consequence:
      "A new window starts at the change, with the full new allowance. Example: 1 of 1 used, then an upgrade to 3, gives 3.",
  },
  {
    value: "keep_used",
    label: ALLOWANCE_UPGRADE_LABELS.keep_used,
    consequence: "The used count stays. Example: 1 of 1 used, then an upgrade to 3, gives 2 more.",
  },
  {
    value: "prorated",
    label: ALLOWANCE_UPGRADE_LABELS.prorated,
    consequence: "The new allowance is prorated for the part of the window that is left.",
  },
];

export default async function CreditResetSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const { planCredits: pc, allowances: al } = resetRules(b);

  return (
    <SettingsPage
      title="Credit and allowance resets"
      crumbs={ruleCrumbs(biz, "Credit and allowance resets")}
      description="What credits and allowances that renew on their own schedule do on a plan change, in a short first window, during a pause and after a cancellation at the end of the term."
    >
      <ActionForm action={saveBillingRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <>
              <SettingsSummary
                items={[
                  { label: "Credits on an upgrade", value: CREDIT_UPGRADE_LABELS[pc.on_upgrade] },
                  {
                    label: "Credits on a downgrade",
                    value: CREDIT_DOWNGRADE_LABELS[pc.on_downgrade],
                  },
                  { label: "First window", value: FIRST_WINDOW_LABELS[pc.first_window] },
                  { label: "Pause", value: CREDIT_PAUSE_LABELS[pc.on_pause] },
                  {
                    label: "Cancel at term end",
                    value: CREDIT_CANCEL_LABELS[pc.on_cancel_at_period_end],
                  },
                  {
                    label: "Allowance on an upgrade",
                    value: ALLOWANCE_UPGRADE_LABELS[al.on_upgrade],
                  },
                ]}
              />
              <TimeTravelNote biz={biz} />
            </>
          }
          save={{ note: "Applies from the next window that starts and the next plan change." }}
        >
          <SettingsCard title="Plan changes" meta="Credits">
            <ChoiceRow
              name="pc_on_upgrade"
              label="On an upgrade"
              defaultValue={pc.on_upgrade}
              options={UPGRADE}
            />
            <ChoiceRow
              name="pc_on_downgrade"
              label="On a downgrade"
              defaultValue={pc.on_downgrade}
              options={DOWNGRADE}
            />
          </SettingsCard>
          <SettingsCard title="First window" meta="A price can set its own">
            <ChoiceRow
              name="pc_first_window"
              label="A window cut short by the start"
              defaultValue={pc.first_window}
              options={FIRST_WINDOW}
            />
          </SettingsCard>
          <SettingsCard title="Pause and cancellation" meta="Credits">
            <ChoiceRow
              name="pc_on_pause"
              label="While paused"
              defaultValue={pc.on_pause}
              options={PAUSE}
            />
            <ChoiceRow
              name="pc_on_cancel_at_period_end"
              label="After a cancellation at the end of the term"
              defaultValue={pc.on_cancel_at_period_end}
              options={CANCEL}
            />
          </SettingsCard>
          <SettingsCard title="Allowances" meta="Plan changes">
            <ChoiceRow
              name="al_on_upgrade"
              label="On an upgrade"
              defaultValue={al.on_upgrade}
              options={ALLOWANCE}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
