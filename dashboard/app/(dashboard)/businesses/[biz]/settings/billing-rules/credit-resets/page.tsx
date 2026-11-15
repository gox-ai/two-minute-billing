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
  CREDIT_DOWNGRADE_CONSEQUENCES,
  CREDIT_DOWNGRADE_LABELS,
  CREDIT_GRANT_WHEN_LABELS,
  CREDIT_PAUSE_LABELS,
  CREDIT_UNPAID_CANCEL_LABELS,
  CREDIT_UPGRADE_CONSEQUENCES,
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

const UPGRADE: Choice[] = (["full", "prorated", "next_window"] as const).map((v) => ({
  value: v,
  label: CREDIT_UPGRADE_LABELS[v],
  consequence: CREDIT_UPGRADE_CONSEQUENCES[v],
}));

const DOWNGRADE: Choice[] = (["next_window", "full", "prorated"] as const).map((v) => ({
  value: v,
  label: CREDIT_DOWNGRADE_LABELS[v],
  consequence: CREDIT_DOWNGRADE_CONSEQUENCES[v],
}));

const FIRST_WINDOW: Choice[] = [
  {
    value: "full",
    label: FIRST_WINDOW_LABELS.full,
    consequence: "A window that the subscription start cuts short grants the full credits.",
  },
  {
    value: "prorated",
    label: FIRST_WINDOW_LABELS.prorated,
    consequence: "A window that the subscription start cuts short grants credits for its length.",
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
    consequence: "A window that starts while the subscription is paused grants no credits.",
  },
  {
    value: "keep_granting",
    label: CREDIT_PAUSE_LABELS.keep_granting,
    consequence: "Each window grants credits, even while the subscription is paused.",
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
    consequence: "Each window that starts before the subscription ends grants credits.",
  },
  {
    value: "stop_at_request",
    label: CREDIT_CANCEL_LABELS.stop_at_request,
    consequence: "No window grants credits after the cancel request.",
  },
];

const GRANT_WHEN: Choice[] = [
  {
    value: "invoice_issued",
    label: CREDIT_GRANT_WHEN_LABELS.invoice_issued,
    consequence: "The credits of a period are available when its invoice is issued, paid or not.",
  },
  {
    value: "invoice_paid",
    label: CREDIT_GRANT_WHEN_LABELS.invoice_paid,
    consequence:
      "The credits of a period are pending until its invoice is paid. The customer cannot spend pending credits. We void pending credits if the invoice is voided or written off, if the subscription is cancelled for non-payment, or if the window of the credits ends before the payment.",
  },
];

const UNPAID_CANCEL: Choice[] = [
  {
    value: "keep",
    label: CREDIT_UNPAID_CANCEL_LABELS.keep,
    consequence: "Plan credits that we granted stay until they expire.",
  },
  {
    value: "void_unused",
    label: CREDIT_UNPAID_CANCEL_LABELS.void_unused,
    consequence:
      "We void the unused plan credits of each unpaid period, from the oldest unpaid period. Credits that rolled over from a paid period stay.",
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
      description="What credits and allowances that renew on their own schedule do on a plan change, in a short first window, during a pause, after a cancellation at the end of the term and while an invoice is unpaid."
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
                  { label: "Credit availability", value: CREDIT_GRANT_WHEN_LABELS[pc.grant_when] },
                  {
                    label: "Cancel for non-payment",
                    value: CREDIT_UNPAID_CANCEL_LABELS[pc.on_unpaid_cancel],
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
              more="With each option, a downgrade at the end of the term grants the full credits of the new plan when its first window starts."
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
          <SettingsCard title="Unpaid invoices" meta="Credits">
            <ChoiceRow
              name="pc_grant_when"
              label="Credit availability"
              defaultValue={pc.grant_when}
              options={GRANT_WHEN}
            />
            <ChoiceRow
              name="pc_on_unpaid_cancel"
              label="After a cancellation for non-payment"
              defaultValue={pc.on_unpaid_cancel}
              options={UNPAID_CANCEL}
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
