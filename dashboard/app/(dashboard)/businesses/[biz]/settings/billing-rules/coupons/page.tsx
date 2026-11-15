import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import {
  CUSTOMER_COUPON_LABELS,
  MID_TERM_COUPON_LABELS,
  couponBillingRules,
} from "@/lib/billing-rules";
import { saveBillingRulesAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";

export const dynamic = "force-dynamic";

// Billing rules → Coupons (billing_rules_config.mid_term_coupons, .customer_coupons).
// Renewals and plan changes always take the subscription's coupons; this page sets the rest.

const MID_TERM: Choice[] = [
  {
    value: "skip",
    label: MID_TERM_COUPON_LABELS.skip,
    consequence:
      "An invoice between renewals gets no coupon discount. Examples are an add-on, an unbilled charge and a change of the term end.",
  },
  {
    value: "unbilled_and_edits",
    label: MID_TERM_COUPON_LABELS.unbilled_and_edits,
    consequence:
      "Invoices for unbilled charges and for a change of the term end get the coupons. A charge that we invoice at once, for example an add-on, gets no discount.",
  },
  {
    value: "all",
    label: MID_TERM_COUPON_LABELS.all,
    consequence: "Each invoice between renewals gets the subscription's coupons.",
  },
];

const CUSTOMER: Choice[] = [
  {
    value: "fallback",
    label: CUSTOMER_COUPON_LABELS.fallback,
    consequence: "A customer coupon applies only when the invoice has no other coupon.",
  },
  {
    value: "stack",
    label: CUSTOMER_COUPON_LABELS.stack,
    consequence: "A customer coupon applies together with the other coupons on the invoice.",
  },
];

export default async function CouponRuleSettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const rules = couponBillingRules(b);

  return (
    <SettingsPage
      title="Coupons"
      crumbs={ruleCrumbs(biz, "Coupons")}
      description="Which invoices between renewals get a subscription's coupons, and how a customer coupon works with other coupons."
    >
      <ActionForm action={saveBillingRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Invoices between renewals",
                  value: MID_TERM_COUPON_LABELS[rules.mid_term_coupons],
                },
                {
                  label: "Customer coupons",
                  value: CUSTOMER_COUPON_LABELS[rules.customer_coupons],
                },
              ]}
            />
          }
          save={{ note: "Applies to invoices issued from now on." }}
        >
          <SettingsCard title="Subscription coupons" meta="Between renewals">
            <ChoiceRow
              name="mid_term_coupons"
              label="Coupons on invoices between renewals"
              help="Renewals and plan changes always get the coupons."
              defaultValue={rules.mid_term_coupons}
              options={MID_TERM}
            />
          </SettingsCard>
          <SettingsCard title="Customer coupons" meta="Applied to the customer">
            <ChoiceRow
              name="customer_coupons"
              label="With other coupons"
              defaultValue={rules.customer_coupons}
              options={CUSTOMER}
            />
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
