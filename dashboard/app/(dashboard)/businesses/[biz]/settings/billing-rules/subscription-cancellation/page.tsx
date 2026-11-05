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
import { saveCancellationAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, TimeTravelNote, ruleCrumbs } from "../_parts/shared";
import { FINAL_PERIOD_LABELS, billingRules } from "@/lib/billing-rules";

export const dynamic = "force-dynamic";

// Billing rules → Subscription cancellation. Defaults for an omitted option on a cancel
// (cancelSubscriptionWithOptions). Including the cancellation day in the billing period
// has no field yet, so it is omitted rather than rendered dead.

const TIMING: Choice[] = [
  {
    value: "immediately",
    label: "Cancel immediately",
    consequence: "The subscription ends at the moment of cancellation.",
  },
  {
    value: "end_of_term",
    label: "Cancel at end of term",
    consequence: "The subscription stays active until its current term ends, then cancels.",
  },
];

const CREDITS: Choice[] = [
  { value: "none", label: "Do not issue credits", consequence: "No credit for the unused time." },
  {
    value: "prorate",
    label: "Issue prorated credits",
    consequence:
      "A credit note for the unused part of the term: refundable if the term was paid, an adjustment if it was not.",
  },
  {
    value: "full",
    label: "Issue full credits",
    consequence:
      "A credit note for the whole current term: refundable if it was paid, an adjustment if it was not.",
  },
];

const UNBILLED: Choice[] = [
  {
    value: "no_action",
    label: "Leave them unbilled",
    consequence: "Unbilled charges stay on the account as they are.",
  },
  { value: "invoice", label: "Invoice charges", consequence: "We invoice the unbilled charges." },
  { value: "delete", label: "Delete charges", consequence: "We delete the unbilled charges." },
];

const UNPAID: Choice[] = [
  { value: "no_action", label: "Keep as unpaid", consequence: "Unpaid invoices stay open." },
  {
    value: "schedule_payment_collection",
    label: "Collect payment",
    consequence:
      "We charge each unpaid invoice at once. An invoice whose charge fails stays open for dunning.",
  },
  {
    value: "write_off",
    label: "Write off",
    consequence: "We write off every unpaid invoice with an amount due.",
  },
  { value: "void", label: "Void invoices", consequence: "We void every unpaid invoice." },
];

const REFUNDABLE: Choice[] = [
  {
    value: "no_action",
    label: "Keep credits",
    consequence: "Refundable credits stay on the account.",
  },
  {
    value: "schedule_refund",
    label: "Refund",
    consequence:
      "We refund the balance of every refundable credit note that the customer holds. This includes all of them, not only the credit notes of this subscription.",
  },
];

// billing_rules_config.specific_date_cancel_final_period. Billing is in advance, so the
// term is already invoiced; each choice is the credit we raise when the date arrives.
const FINAL_PERIOD: Choice[] = [
  {
    value: "full_period",
    label: FINAL_PERIOD_LABELS.full_period,
    consequence: "The customer pays for the whole term. We issue no credit.",
  },
  {
    value: "prorated",
    label: FINAL_PERIOD_LABELS.prorated,
    consequence:
      "We issue a credit note for the time after the cancellation date: refundable if the term was paid, an adjustment if it was not.",
  },
  {
    value: "nothing",
    label: FINAL_PERIOD_LABELS.nothing,
    consequence:
      "We issue a credit note for the whole term: refundable if it was paid, an adjustment if it was not.",
  },
];

const labelOf = (list: Choice[], v: string) => list.find((o) => o.value === v)?.label ?? v;

export default async function CancellationSettings({
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
  // Engine defaults (db/schema/tenancy.ts), not whatever reads nicely.
  const cancelOption = b.default_cancel_option ?? "immediately";
  const creditOption = b.default_credit_option_for_cancel ?? "none";
  const unbilledOption = b.default_unbilled_on_cancel ?? "no_action";
  const arOption = b.default_ar_handling_on_cancel ?? "no_action";
  const refundableOption = b.default_refundable_credits_on_cancel ?? "no_action";
  const finalPeriod = billingRules(b).specific_date_cancel_final_period;

  return (
    <SettingsPage
      title="Subscription cancellation"
      crumbs={ruleCrumbs(biz, "Subscription cancellation")}
      description="What a cancellation does when the request does not specify: when it takes effect, what we credit, and what happens to amounts still owed."
    >
      <ActionForm action={saveCancellationAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <>
              <SettingsSummary
                items={[
                  { label: "Timing", value: labelOf(TIMING, cancelOption) },
                  { label: "Unused time", value: labelOf(CREDITS, creditOption) },
                  { label: "Cancel on a date", value: labelOf(FINAL_PERIOD, finalPeriod) },
                  { label: "Unbilled charges", value: labelOf(UNBILLED, unbilledOption) },
                  { label: "Unpaid invoices", value: labelOf(UNPAID, arOption) },
                  { label: "Refundable credits", value: labelOf(REFUNDABLE, refundableOption) },
                ]}
              />
              <TimeTravelNote biz={biz} />
            </>
          }
          save={{ note: "Applies to the next cancellation that does not set its own options." }}
        >
          <SettingsCard title="Timing and credits" meta="When it ends, what is credited">
            <ChoiceRow
              name="default_cancel_option"
              label="When a subscription is cancelled"
              defaultValue={cancelOption}
              options={TIMING}
              more={
                <>
                  Dunning does not use these defaults. When dunning stops, it cancels at once with
                  no credit. The invoice then gets the final action set on{" "}
                  <Link href={`${base}/dunning`} className="text-primary hover:underline">
                    Dunning
                  </Link>
                  . A cancellation from a lost chargeback uses these defaults.
                </>
              }
            />
            <ChoiceRow
              name="default_credit_option_for_cancel"
              label="Credit for the unused part of the term"
              help="When a subscription is cancelled mid-term."
              defaultValue={creditOption}
              options={CREDITS}
            />
            <ChoiceRow
              name="specific_date_cancel_final_period"
              label="Last term of a cancellation on a date"
              help="When a subscription is set to cancel on a date in the middle of a term."
              defaultValue={finalPeriod}
              options={FINAL_PERIOD}
              more="A credit option sent with the cancellation request replaces this setting."
            />
          </SettingsCard>

          <SettingsCard title="What is left on the account" meta="Unbilled, unpaid, refundable">
            <ChoiceRow
              name="default_unbilled_on_cancel"
              label="Unbilled charges"
              help="One-off or prorated amounts gathered since the last invoice."
              defaultValue={unbilledOption}
              options={UNBILLED}
            />
            <ChoiceRow
              name="default_ar_handling_on_cancel"
              label="Unpaid invoices"
              help="The cancelled subscription's open invoices."
              defaultValue={arOption}
              options={UNPAID}
            />
            <ChoiceRow
              name="default_refundable_credits_on_cancel"
              label="Refundable credits"
              help="Refunds run through the normal refund flow."
              defaultValue={refundableOption}
              options={REFUNDABLE}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
