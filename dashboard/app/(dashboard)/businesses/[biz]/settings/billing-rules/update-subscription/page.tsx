import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveUpdateSubscriptionAction } from "../../actions";
import { ChoiceRow, SwitchRow, UnsavedChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import {
  CHANGE_GATE_LABELS,
  CHANGE_PRORATION_LABELS,
  CHANGE_TIMING_LABELS,
  FAILED_CHANGE_LABELS,
  PLAN_CHANGE_TIMING_UNSET,
  billingRules,
  DOWNGRADE_CREDIT_LABELS,
  PLAN_CHANGE_COUPON_LABELS,
  PLAN_CHANGE_TERM_LABELS,
  lifecycleRules,
} from "@/lib/billing-rules";

export const dynamic = "force-dynamic";

// Billing rules → Update subscription. Not modelled, so omitted rather than rendered
// dead: "remove mandatory add-ons on plan change", and keeping the billing day with a
// prorated term on a change of billing period (the engine always resets that term).
//
// `default_prorate_on_change` is read by changeTermEnd only; plan changes follow
// billing_rules_config.upgrade_proration / downgrade_proration (change-policy.ts).
// Left out, no backend: an un-prorated "charge / credit the full amount", and an upgrade
// gate that waits for the charge to succeed (the change commits before its charge).
// `default_invoice_immediately` is read by changeTermEnd directly, and by plan/item
// changes only through unbilled_charges_config.on_change / on_one_time_charge while
// those keys are unset (defaultInvoiceImmediately in proration.ts).
// billing_rules_config.failed_change_charge. "Undo the change" is not offered: the change,
// its credit notes and its invoice commit before the charge, and the ledger is append-only,
// so a failed charge cannot take them back as one step.
const FAILED_CHANGE: Choice[] = [
  {
    value: "start_dunning",
    label: FAILED_CHANGE_LABELS.start_dunning,
    consequence: "We retry the invoice on the dunning schedule, as for a failed renewal.",
  },
  {
    value: "next_renewal",
    label: FAILED_CHANGE_LABELS.next_renewal,
    consequence:
      "We make no retry until the current term ends. Then dunning retries the invoice on its schedule. A change that starts a new term, for example monthly to yearly, starts dunning at once.",
  },
];

// billing_rules_config.plan_change_term / plan_change_coupons / downgrade_credit
// (lifecycle-config.ts). `customer_chooses` for the credit is shown only once saved through
// the API: the customer portal has no control for it yet.
const TERM_CHOICES: Choice[] = [
  {
    value: "keep_anchor",
    label: PLAN_CHANGE_TERM_LABELS.keep_anchor,
    consequence:
      "A plan change keeps the term and its renewal date. A change to a different billing period always starts a new term.",
  },
  {
    value: "reset_on_upgrade",
    label: PLAN_CHANGE_TERM_LABELS.reset_on_upgrade,
    consequence:
      "An upgrade starts a new term today. We give credit for the unused time and charge the full new term. A downgrade keeps the term.",
  },
  {
    value: "reset_on_any_change",
    label: PLAN_CHANGE_TERM_LABELS.reset_on_any_change,
    consequence:
      "Every plan change starts a new term today. We give credit for the unused time and charge the full new term.",
  },
];

const COUPON_CHOICES: Choice[] = [
  {
    value: "keep",
    label: PLAN_CHANGE_COUPON_LABELS.keep,
    consequence: "The coupons stay on the subscription after the plan change.",
  },
  {
    value: "drop",
    label: PLAN_CHANGE_COUPON_LABELS.drop,
    consequence:
      "We remove all coupons before we bill the change. Manual discounts stay. The estimate shows the price without them.",
  },
  {
    value: "keep_if_valid",
    label: PLAN_CHANGE_COUPON_LABELS.keep_if_valid,
    consequence:
      "We remove a coupon that applies only to specific plans when the new plan is not one of them. Other coupons and manual discounts stay.",
  },
];

const creditChoices = (saved: string): Choice[] => [
  {
    value: "credit_balance",
    label: DOWNGRADE_CREDIT_LABELS.credit_balance,
    consequence: "The credit stays on the customer's account. We use it on the next invoices.",
  },
  {
    value: "refund",
    label: DOWNGRADE_CREDIT_LABELS.refund,
    consequence:
      "We refund the credit that the change did not use to the card or bank payments that paid for the customer's invoices. Bank debits go back to the bank account. We can refund only what those payments cover. The rest, for example money paid offline, stays on the account as credit.",
  },
  ...(saved === "customer_chooses"
    ? [
        {
          value: "customer_chooses",
          label: DOWNGRADE_CREDIT_LABELS.customer_chooses,
          consequence:
            "Set through the API. A change in the customer portal can send the customer's selection. The customer portal does not show this selection yet. All other changes keep the credit on the account.",
        },
      ]
    : []),
];

const PERIOD_RULE =
  "A switch to a longer billing period, for example monthly to yearly, counts as an upgrade. A switch to a shorter billing period counts as a downgrade. On the same billing period, a higher monthly amount counts as an upgrade.";

const prorationChoices = (dir: "upgrade" | "downgrade"): Choice[] => [
  {
    value: "prorated",
    label: CHANGE_PRORATION_LABELS.prorated,
    consequence:
      dir === "upgrade"
        ? "We charge the new price and give credit for the old price, for the time that remains in the term."
        : "We give credit for the old price and charge the new price, for the time that remains in the term.",
  },
  {
    value: "none",
    label: CHANGE_PRORATION_LABELS.none,
    consequence:
      dir === "upgrade"
        ? "We change the items, and we do not charge for the rest of the current term. The new price starts at the next renewal. A change to a different billing period still charges the full new term."
        : "We change the items, and we do not give credit for the rest of the current term. The new price starts at the next renewal.",
  },
];

const gateChoices = (dir: "upgrade" | "downgrade"): Choice[] => [
  {
    value: "off",
    label: CHANGE_GATE_LABELS.off,
    consequence:
      dir === "upgrade"
        ? "An upgrade can occur at any time."
        : "A downgrade can occur at any time.",
  },
  {
    value: "invoices_paid",
    label: CHANGE_GATE_LABELS.invoices_paid,
    consequence: `We refuse the ${dir} while the customer has an unpaid invoice. In the customer portal, the customer sees "Pay your open invoices before you change your plan." The dashboard and the API show the reason.`,
  },
];

const timingChoices = (dir: "upgrade" | "downgrade"): Choice[] => [
  {
    value: "now",
    label: CHANGE_TIMING_LABELS.now,
    consequence: "The change starts immediately. The dashboard and the API cannot schedule it.",
  },
  {
    value: "end_of_term",
    label: CHANGE_TIMING_LABELS.end_of_term,
    consequence:
      "The change starts at the end of the current term. During a trial, it starts immediately. A hosted checkout and the HubSpot app cannot schedule a change, so they refuse it.",
  },
  {
    value: "customer_chooses",
    label: CHANGE_TIMING_LABELS.customer_chooses,
    consequence: `The customer portal lets the customer select now or the end of the term. In the dashboard and the API, the operator or the request selects. If they do not select, ${
      dir === "upgrade" ? "an upgrade starts now" : "a downgrade starts at the end of the term"
    }.`,
  },
];

/** The summary's timing: the saved value, or what the portal does while none is saved. */
const timingSummary = (saved: string | null, portal: keyof typeof CHANGE_TIMING_LABELS) =>
  saved === null
    ? `Timing not saved (portal: ${CHANGE_TIMING_LABELS[portal].toLowerCase()})`
    : CHANGE_TIMING_LABELS[saved as keyof typeof CHANGE_TIMING_LABELS];

const TIMING_UNSET_NOTE =
  "Not saved yet. The dashboard and the API apply a change now unless you schedule it. The customer portal applies an upgrade now and a downgrade at the end of the term.";

export default async function UpdateSubscriptionSettings({
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
  const prorate = b.default_prorate_on_change ?? false;
  const invoiceNow = b.default_invoice_immediately ?? false;
  const rules = billingRules(b);
  const life = lifecycleRules(b);
  const failedChange = rules.failed_change_charge;
  // An unsaved timing shows what the portal does, with the note that says what the
  // dashboard and the API do. The `_unset` field keeps a save of other rows from pinning it.
  const upTiming = rules.upgrade_timing ?? PLAN_CHANGE_TIMING_UNSET.upgrade;
  const downTiming = rules.downgrade_timing ?? PLAN_CHANGE_TIMING_UNSET.downgrade;
  const isOption = (v: unknown) => v === "invoice_immediately" || v === "add_to_unbilled";
  const changeSet = isOption(b.unbilled_charges_config?.on_change);
  const oneTimeSet = isOption(b.unbilled_charges_config?.on_one_time_charge);
  const unbilledLink = (
    <Link href={`${base}/billing-rules/unbilled-charges`} className="text-primary hover:underline">
      Unbilled charges
    </Link>
  );
  // Which operations the invoice switch still reaches. A row set on Unbilled charges wins
  // for its event; a row left on "Follow" is decided here.
  const reach =
    changeSet && oneTimeSet ? (
      <>
        Decides term-end changes. Plan, item and one-time charges have their own choice on{" "}
        {unbilledLink}, and that choice wins. Set them to Follow again to let this switch decide
        them.
      </>
    ) : changeSet ? (
      <>
        Decides term-end changes and one-time items. Plan and item changes have their own choice on{" "}
        {unbilledLink}, and that choice wins.
      </>
    ) : oneTimeSet ? (
      <>
        Decides plan, item and term-end changes. One-time items have their own choice on{" "}
        {unbilledLink}, and that choice wins.
      </>
    ) : (
      <>
        Decides plan, item and term-end changes and one-time items. A row on {unbilledLink} set to
        anything other than Follow wins for its event.
      </>
    );

  return (
    <SettingsPage
      title="Update subscription"
      crumbs={ruleCrumbs(biz, "Update subscription")}
      description="How billing reacts when someone changes a subscription. A change request may override either default for that call. The change screen always shows its own choice."
    >
      <ActionForm action={saveUpdateSubscriptionAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Change charges",
                  value: invoiceNow ? "Invoiced immediately" : "Billed at the next renewal",
                },
                {
                  label: "Term-end changes",
                  value: prorate ? "Prorated" : "Boundary moves, no adjustment",
                },
                { label: "Failed change charge", value: FAILED_CHANGE_LABELS[failedChange] },
                {
                  label: "Upgrades",
                  value: `${CHANGE_PRORATION_LABELS[rules.upgrade_proration]} · ${timingSummary(rules.upgrade_timing, upTiming)}`,
                },
                {
                  label: "Downgrades",
                  value: `${CHANGE_PRORATION_LABELS[rules.downgrade_proration]} · ${timingSummary(rules.downgrade_timing, downTiming)}`,
                },
                {
                  label: "Term on a plan change",
                  value: PLAN_CHANGE_TERM_LABELS[life.plan_change_term],
                },
                { label: "Coupons", value: PLAN_CHANGE_COUPON_LABELS[life.plan_change_coupons] },
                {
                  label: "Credit from a change",
                  value: DOWNGRADE_CREDIT_LABELS[life.downgrade_credit],
                },
              ]}
            />
          }
          save={{ note: "Applies to the next change made without its own choice." }}
        >
          <SettingsCard title="Invoicing" meta="When change charges are billed">
            <SwitchRow
              name="default_invoice_immediately"
              label="Invoice change charges immediately"
              help={reach}
              defaultChecked={invoiceNow}
              on="A change raises its invoice immediately."
              off="Change charges stay as unbilled charges until the next renewal. We bill them then and apply tax and account credits."
            />
            <ChoiceRow
              name="failed_change_charge"
              label="When the charge for a change fails"
              help="Applies to a change charge that we invoice and collect immediately. The change stays in place."
              defaultValue={failedChange}
              options={FAILED_CHANGE}
            />
          </SettingsCard>
          <SettingsCard title="Plan changes" meta="Upgrades and downgrades">
            <ChoiceRow
              name="upgrade_proration"
              label="Proration for an upgrade"
              help={`${PERIOD_RULE} This applies to items whose price or quantity changes. We always prorate an item that you add or remove. A prorate choice on the change itself is used for that change.`}
              defaultValue={rules.upgrade_proration}
              options={prorationChoices("upgrade")}
            />
            <ChoiceRow
              name="downgrade_proration"
              label="Proration for a downgrade"
              defaultValue={rules.downgrade_proration}
              options={prorationChoices("downgrade")}
            />
            <ChoiceRow
              name="upgrade_gate"
              label="Before an upgrade"
              help="Applies to every plan change: in the customer portal, a hosted checkout, the dashboard, the HubSpot app and the API. We check a scheduled change when it is scheduled."
              defaultValue={rules.upgrade_gate}
              options={gateChoices("upgrade")}
            />
            <ChoiceRow
              name="downgrade_gate"
              label="Before a downgrade"
              defaultValue={rules.downgrade_gate}
              options={gateChoices("downgrade")}
            />
            <UnsavedChoiceRow
              saved={rules.upgrade_timing !== null}
              saveLabel="Save this timing"
              name="upgrade_timing"
              label="When an upgrade starts"
              help={
                rules.upgrade_timing === null
                  ? TIMING_UNSET_NOTE
                  : "During a trial, the customer portal starts every change immediately, because we bill nothing until the trial ends."
              }
              defaultValue={upTiming}
              options={timingChoices("upgrade")}
            />
            <UnsavedChoiceRow
              saved={rules.downgrade_timing !== null}
              saveLabel="Save this timing"
              name="downgrade_timing"
              label="When a downgrade starts"
              help={rules.downgrade_timing === null ? TIMING_UNSET_NOTE : undefined}
              defaultValue={downTiming}
              options={timingChoices("downgrade")}
            />
          </SettingsCard>
          <SettingsCard title="Term, coupons and credit" meta="What a plan change does">
            <ChoiceRow
              name="plan_change_term"
              label="Term on a plan change"
              help="Applies when the plan's price changes now. A reset term choice on the change itself is used for that change. A scheduled change keeps the term."
              defaultValue={life.plan_change_term}
              options={TERM_CHOICES}
            />
            <ChoiceRow
              name="plan_change_coupons"
              label="Coupons on a plan change"
              help="Applies when the plan's price changes, now or at a scheduled date."
              defaultValue={life.plan_change_coupons}
              options={COUPON_CHOICES}
            />
            <ChoiceRow
              name="downgrade_credit"
              label="Credit from a change"
              help="Applies when a change gives the customer credit, for example a downgrade or a removed add-on."
              defaultValue={life.downgrade_credit}
              options={creditChoices(life.downgrade_credit)}
            />
          </SettingsCard>
          <SettingsCard title="Term-end changes" meta="When you move the end of a term">
            <SwitchRow
              name="default_prorate_on_change"
              label="Prorate when you change the end of a term"
              help="Applies only when you move the end of the current term. Plan and quantity changes use the proration rows in Plan changes."
              defaultChecked={prorate}
              on="Extending or shortening a term charges or credits the time added or removed."
              off="The term boundary moves with no charge or credit."
              more="To move a customer onto a new price without a mid-term adjustment, schedule the change for the end of the term."
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
