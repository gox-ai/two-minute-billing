import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness, type UnbilledEventOption } from "@/lib/api/business-settings";
import { billingModeIdOf, billingModeLabel } from "@/lib/billing-mode";
import { listDeclineRules } from "@/lib/api/decline-rules";
import type { Business } from "@/lib/api";
import { ErrorState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import {
  SettingsCard,
  SettingsPage,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { RuleLink } from "./_parts/shared";
import {
  DECLINED_REFUND_LABELS,
  EXCESS_PAYMENT_LABELS,
  MANDATE_REVOKED_LABELS,
  SEVERAL_DUE_LABELS,
  TRIAL_END_LABELS,
  billingRules,
  paymentApplication,
  resetRules,
  CREDIT_UPGRADE_LABELS,
  CREDIT_PAUSE_LABELS,
} from "@/lib/billing-rules";
import { CHARGE_TIMING_LABELS } from "./charge-timing/labels";

export const dynamic = "force-dynamic";

// Billing rules hub: every rule with its current value, read off the real field.
//
// Deliberately omitted, with the reason (see PROGRESS.md § deferred):
//   Account hierarchy .......... no parent/child on customers
//   Multi-decimal support ...... money is integer minor units (locked decision #4)
//   Contract terms ............. no term-commitment model
//   Price override ............. always allowed via price_snapshot; no toggle to expose
//   Multiple coupons ........... already unconditional; no toggle to expose
//   Manual discounts ........... no non-coupon discount model
//   Offline payment methods .... payment_methods.type is card|upi|wallet only
//   Gift/Orders/Shipping, Consolidated invoicing, Zero-value line items,
//   Fraud monitor, Card address verification, Accounting fields
//                            ... no backend
export default async function BillingRules({ params }: { params: Promise<{ biz: string }> }) {
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
  const rules = `${base}/billing-rules`;

  // Every value below mirrors its engine resolver's default for an absent key.
  const cancelOption = b.default_cancel_option ?? "immediately";
  const prorate = b.default_prorate_on_change ?? false;
  const invoiceNow = b.default_invoice_immediately ?? false;
  const rounding = b.invoice_rounding ?? "none";
  const collectOnPm = b.dunning_config?.collect_on_payment_method_update ?? true;
  // An absent key inherits `collect_on_payment_method_update`, as resolveDunningConfig does.
  const requireChargeOnReactivation =
    b.dunning_config?.require_successful_charge_on_reactivation ?? collectOnPm;
  // Fetched, not guessed; a failure degrades to no value and the row still links.
  const overriddenRules = await listDeclineRules(biz)
    .then((r) => r.data.filter((x) => x.override != null).length)
    .catch(() => null);

  const creditSlots = [
    b.credits_flexibility?.refundable?.recurring,
    b.credits_flexibility?.refundable?.one_time,
    b.credits_flexibility?.excess?.recurring,
    b.credits_flexibility?.excess?.one_time,
  ];
  const restrictedCreditSlots = creditSlots.filter((s) => s != null && s.mode !== "auto").length;

  // on_change / on_one_time_charge inherit `default_invoice_immediately` while unset.
  const inherited: UnbilledEventOption = invoiceNow ? "invoice_immediately" : "add_to_unbilled";
  const unbilled = [
    b.unbilled_charges_config?.on_create ?? "invoice_immediately",
    b.unbilled_charges_config?.on_change ?? inherited,
    b.unbilled_charges_config?.on_one_time_charge ?? inherited,
  ];
  const retained = unbilled.filter((v) => v === "add_to_unbilled").length;

  const unbilledOnPause = b.pause_config?.unbilled_on_pause ?? "retain";
  // pauseSubscriptionWithOptions stops dunning only on an explicit "stop".
  const dunningOnPause = b.pause_config?.dunning_on_pause ?? "continue";

  const br = billingRules(b);
  const pa = paymentApplication(b);
  const resets = resetRules(b);
  // Invoice rules (0486): the read resolves every key; fallbacks equal the engine defaults.
  const ir = b.invoice_rules_config;
  const requiredCount = Object.values(br.required_reasons).filter(Boolean).length;

  const backdatingEnabled = b.backdating_config?.enabled ?? true;
  const backdatingCutoff = b.backdating_config?.cutoff_day_of_month ?? null;

  const mode = billingModeIdOf(b);
  const attention: AttentionItem[] =
    mode === "day_based_legacy" && !b.timezone
      ? [
          {
            key: "billing-mode-utc",
            tone: "warning",
            title: "We count midnight-aligned terms in UTC",
            detail:
              "Billing mode starts each term at midnight in this business's time zone, but no time zone is set.",
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
      title="Billing rules"
      description="How billing behaves when subscriptions change, how we build invoices, and how we collect payment. Each rule shows its current value."
      crumbs={[{ label: "Settings", href: base }, { label: "Billing rules" }]}
      attention={attention}
    >
      <SettingsCard
        title="Customers & subscriptions"
        meta="When subscriptions are changed, paused or cancelled"
      >
        <RuleLink
          title="Subscription cancellation"
          description="Timing, credits, unbilled charges and unpaid invoices when a subscription is cancelled."
          value={cancelOption === "end_of_term" ? "At end of term" : "Immediately"}
          href={`${rules}/subscription-cancellation`}
        />
        <RuleLink
          title="Trial end"
          description="What happens to a subscription when its trial ends."
          value={TRIAL_END_LABELS[br.trial_end_action]}
          href={`${rules}/trial-end`}
        />
        <RuleLink
          title="Auto-collection for new customers"
          description="The auto-collection setting a new customer gets when you create it without one."
          value={br.new_customer_auto_collection === "on" ? "On" : "Off"}
          href={`${rules}/new-customers`}
        />
        <RuleLink
          title="Required reasons"
          description="Actions that need a reason: cancellation, void, credit note and refund."
          value={requiredCount === 0 ? "None required" : `${requiredCount} of 4 required`}
          href={`${rules}/required-reasons`}
        />
        <RuleLink
          title="Update subscription"
          description="Invoicing, proration, conditions and timing for plan changes, and proration for a term-end change."
          value={`${invoiceNow ? "Invoice now" : "Bill at renewal"} · upgrades ${
            br.upgrade_proration === "prorated" ? "prorated" : "not prorated"
          } · ${prorate ? "prorate term changes" : "no term proration"}`}
          href={`${rules}/update-subscription`}
        />
        <RuleLink
          title="Pause and resume"
          description="Unbilled charges, retries and unpaid invoices when a subscription is paused and resumed."
          value={`${unbilledOnPause === "invoice" ? "Invoice unbilled" : "Keep unbilled"} · ${
            dunningOnPause === "continue" ? "keep retrying" : "stop retries"
          }`}
          href={`${rules}/pause-resume`}
        />
        <RuleLink
          title="Backdating"
          description="Whether operations may use a past date, and how far back."
          value={
            !backdatingEnabled
              ? "Not allowed"
              : backdatingCutoff == null
                ? "Allowed, no cut-off"
                : `Allowed until day ${backdatingCutoff}`
          }
          href={`${rules}/backdating`}
        />
      </SettingsCard>

      <SettingsCard title="Billing & invoices" meta="How we measure periods and build invoices">
        <RuleLink
          title="Billing mode"
          description="Measure billing periods to the exact instant of signup, or in calendar days."
          value={billingModeLabel(b)}
          href={`${rules}/billing-mode`}
        />
        <RuleLink
          title="Round-off invoice amount"
          description="Round the invoice total, after tax, to the nearest whole unit."
          value={rounding === "nearest_unit" ? "Round to nearest unit" : "No rounding"}
          href={`${rules}/round-off`}
        />
        <RuleLink
          title="Zero-value invoices"
          description="Whether we send the invoice email for an invoice whose total is zero."
          value={
            b.email_config?.attachments?.invoice_issued?.skipZeroSend === true
              ? "Finalize, do not send"
              : "Finalize and send"
          }
          href={`${rules}/zero-value-invoices`}
        />
        <RuleLink
          title="Small invoices"
          description="Charge a renewal invoice with a small amount due, or write it off."
          value={
            (ir?.small_invoice_action ?? "charge") === "write_off"
              ? "Write off below a limit"
              : "Charge anyway"
          }
          href={`${rules}/small-invoices`}
        />
        <RuleLink
          title="Credits flexibility"
          description="Whether we apply refundable credits and excess payments to invoices automatically, and up to what amount."
          value={
            restrictedCreditSlots === 0
              ? "Auto-apply everything"
              : `${restrictedCreditSlots} of 4 restricted`
          }
          href={`${rules}/credits-flexibility`}
        />
        <RuleLink
          title="Unbilled charges"
          description="For each event, invoice a charge at once or hold it as unbilled. Also, hold renewal invoices as pending for usage."
          value={
            retained === 0 ? "Always invoice immediately" : `${retained} of 3 held as unbilled`
          }
          href={`${rules}/unbilled-charges`}
        />
        <RuleLink
          title="Usage close"
          description="An extra wait, in minutes, before we close a period's usage events and bill them. For prices on a meter."
          value={
            (b.usage_close_delay_minutes ?? 0) === 0
              ? "No extra wait"
              : `${b.usage_close_delay_minutes} minutes extra`
          }
          href={`${rules}/usage-close`}
        />
      </SettingsCard>

      <SettingsCard title="Payments" meta="How and when we collect payment">
        <RuleLink
          title="Payment terms"
          description="The credit period an invoice gets before it is due, when neither the subscription nor the customer sets one."
          value={b.default_due_days ? `Net ${b.default_due_days}` : "Due on issue"}
          href={`${rules}/payment-terms`}
        />
        <RuleLink
          title="Charge timing"
          description="When we charge an automatically collected invoice that has payment terms."
          value={CHARGE_TIMING_LABELS[ir?.charge_timing ?? "at_creation"]}
          href={`${rules}/charge-timing`}
        />
        <RuleLink
          title="Card limit"
          description="The largest invoice amount that a customer can pay by card, for each currency."
          value={cardLimitValue(b.card_payment_limits)}
          href={`${rules}/card-limit`}
        />
        <RuleLink
          title="Chargeback management"
          description="What happens to the invoice, the subscription and collection when a customer disputes a payment."
          value={chargebackValue(b.chargeback_config)}
          href={`${rules}/chargebacks`}
        />
        <RuleLink
          title="Error handling"
          description="For each gateway error, whether we retry the payment and whether we tell the customer why."
          value={
            overriddenRules == null
              ? undefined
              : overriddenRules > 0
                ? `${overriddenRules} changed`
                : "Defaults"
          }
          href={`${base}/decline-rules`}
          external
        />
        <RuleLink
          title="Payment collection when a payment method is added"
          description="Collect unpaid invoices as soon as a customer adds or updates a payment method. Set on the Dunning page."
          value={collectOnPm ? "On" : "Off"}
          href={`${base}/dunning`}
          external
        />
        <RuleLink
          title="Mandates"
          description="How large a UPI Autopay, e-mandate or card mandate we ask the customer to approve."
          value={
            b.mandate_config?.headroom_bps || b.mandate_config?.rail_ceiling_cap_minor
              ? "Changed"
              : "Defaults"
          }
          href={`${rules}/mandates`}
        />
        <RuleLink
          title="Subscription reactivation"
          description="If a reactivation charge fails, whether we refuse the reactivation or continue and let dunning collect the invoice."
          value={requireChargeOnReactivation ? "Charge required" : "Reactivates anyway"}
          href={`${rules}/subscription-reactivation`}
        />
        <RuleLink
          title="Payment application"
          description="How we charge several due invoices, which open invoice a payment pays first, and what we do with an excess payment."
          value={`${SEVERAL_DUE_LABELS[pa.several_due_invoices]} · ${EXCESS_PAYMENT_LABELS[pa.excess_payment]}`}
          href={`${rules}/payment-application`}
        />
        <RuleLink
          title="Credit and allowance resets"
          description="What credits and allowances that renew on their own schedule do on a plan change, in a short first window, during a pause and after a cancellation."
          value={`Upgrade: ${CREDIT_UPGRADE_LABELS[resets.planCredits.on_upgrade].toLowerCase()} · Pause: ${CREDIT_PAUSE_LABELS[resets.planCredits.on_pause].toLowerCase()}`}
          href={`${rules}/credit-resets`}
        />
        <RuleLink
          title="Revoked mandate"
          description="What happens when a payment fails because the customer stopped the mandate."
          value={MANDATE_REVOKED_LABELS[br.mandate_revoked]}
          href={`${rules}/mandate-revoked`}
        />
        {/* Collection rules (2.12, 2.15). */}
        <RuleLink
          title="Short payments and declined refunds"
          description="Write off a small shortfall on a recorded payment, and what happens when the gateway declines a refund."
          value={`${
            Object.keys(br.partial_payment_write_off).length ? "Write-off on" : "Write-off off"
          } · ${DECLINED_REFUND_LABELS[br.declined_refund]}`}
          href={`${rules}/payment-shortfalls-refunds`}
        />
      </SettingsCard>
    </SettingsPage>
  );
}

/** "No limit", or the currencies that have one. */
function cardLimitValue(limits: Business["card_payment_limits"]): string {
  const set = Object.keys(limits ?? {});
  return set.length === 0 ? "No limit" : `Limit for ${set.sort().join(", ")}`;
}

type ChargebackConfig = NonNullable<Business["chargeback_config"]>;

/** Everything the policy does, not only the on-loss half. */
function chargebackValue(cfg: ChargebackConfig | null | undefined): string {
  const verb = (a: string) => (a.startsWith("cancel") ? "cancels" : "pauses");
  const opened = cfg?.on_initiated_subscription ?? "no_action";
  const lost = cfg?.on_lost_subscription ?? "no_action";
  const parts = [
    opened !== "no_action" && `${verb(opened)} when opened`,
    lost !== "no_action" && `${verb(lost)} on loss`,
    (cfg?.on_lost_invoice ?? "no_action") === "credit_note" && "credit note on loss",
    cfg?.stop_collecting_all && "stops collection",
  ].filter(Boolean) as string[];
  if (!parts.length) return "Record only";
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
