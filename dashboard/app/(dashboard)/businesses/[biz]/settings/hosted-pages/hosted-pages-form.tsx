"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { useFieldError } from "@/components/form/action-form";
import { SelectField } from "@/components/ui/select-field";
import { CheckboxField } from "@/components/ui/checkbox";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { SettingSwitch } from "@/components/settings/setting-switch";
import { RichBodyEditor } from "@/components/emails/rich-body-editor";

export interface HostedPagesDefaults {
  coupons: boolean;
  /** Coupon codes a buyer can enter on one checkout or subscription (1–10, 0495). */
  couponCodeLimit: number;
  invoiceDownload: boolean;
  invoicePayment: boolean;
  removePaymentMethod: boolean;
  cancel: boolean;
  cancelTiming: "end_of_term" | "immediately";
  pauseResume: boolean;
  reactivate: boolean;
  skipRenewal: boolean;
  /** 1–12 renewals per 12 months. */
  skipRenewalLimit: number;
  hideZeroLines: boolean;
  collectPoNumber: boolean;
  returnUrl: string;
  cancelUrl: string;
  /** Saved portal link-error message; '' = the default copy. */
  linkErrorHtml: string;
  /** One-time purchases: keep the buyer's payment method? */
  oneTimeSave: "never" | "always" | "ask";
  /** Portal usage so far on metered subscriptions (default on). */
  showUsage: boolean;
  /** Portal projected usage at window end (default off). */
  showUsageProjection: boolean;
  /** Checkout: the buyer agrees to the recurring charge. */
  recurringConsent: boolean;
  /** Checkout: the buyer accepts the terms (needs a terms URL). */
  requireTerms: boolean;
  termsUrl: string;
  privacyUrl: string;
  /** Checkout: optional marketing opt-in. */
  marketingConsent: boolean;
  checkoutLayout: "steps" | "one_page";
  walletsFirst: boolean;
  botCheckAfterFailures: number | null;
  /** Portal plan changes (Phase 2). */
  planChanges: boolean;
  seatChanges: "off" | "increase" | "both";
  seatMin: number | null;
  seatMax: number | null;
  addonChanges: boolean;
  shorterPeriod: "always" | "never" | "after_12_months";
  chargeUpgrade: "business_default" | "now" | "next_invoice";
  changeStatuses: string[];
  cancelScheduledChange: boolean;
  /** Portal cancel flow (Phase 3). */
  cancelReason: "off" | "optional" | "required";
  retentionPause: boolean;
  retentionPauseMonths: number | null;
  retentionPauseChoice: boolean;
  retentionDowngradePrice: string;
  retentionCoupon: string;
  retentionContactUrl: string;
  retentionOfferOnce: boolean;
  /** Portal access (Phase 4). Null lifetimes = the built-in values. */
  portalEmailCode: boolean;
  portalLinkHours: number | null;
  portalEmailLinkDays: number | null;
  portalSessionHours: number | null;
  portalHideCancelledSubscriptions: boolean;
  portalHideZeroInvoices: boolean;
  portalHideVoidedInvoices: boolean;
  /** Single-action links (Phase 4b). */
  portalActions: { payInvoice: boolean; updateCard: boolean; changePlan: boolean; cancel: boolean };
  portalReturnUrl: string;
}

const DEFAULT_LINK_ERROR = "Billing links are valid for a limited time. Ask for a new link.";

/**
 * The portal's "can't get in" message. Keyed on the saved value, so the editor re-seeds
 * only when a save changes it and never fights the cursor; the hidden input posts.
 */
function LinkErrorMessage({ saved }: { saved: string }) {
  const [html, setHtml] = useDefaultState(saved);
  return (
    <SettingRow
      label="Message when a portal link cannot be used"
      help="Shows each time we refuse a customer: for an expired, used, revoked or unknown link, or for a session that ended. Sign-out has its own message."
      control={
        <div className="w-full">
          <input type="hidden" name="portal_link_error_html" value={html} />
          <RichBodyEditor
            key={saved}
            value={html}
            seed={0}
            onChange={setHtml}
            labels={{}}
            portalLinkable={false}
            compact
            ariaLabel="Message when a portal link cannot be used"
          />
        </div>
      }
      consequence={
        html.trim()
          ? "Customers see this under “This link is not valid or is expired”, with your logo and brand color."
          : `Empty, so customers see the default: “${DEFAULT_LINK_ERROR}”`
      }
    />
  );
}

/** An input tied to its row's error message, so a screen reader announces it. */
function ErrorLinkedInput(props: React.ComponentProps<typeof Input> & { name: string }) {
  const error = useFieldError(props.name);
  return (
    <Input
      {...props}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${props.name}-error` : undefined}
    />
  );
}

/** A switch row whose consequence follows the live value. */
function SwitchRow({
  name,
  label,
  help,
  checked,
  onChange,
  on,
  off,
  more,
}: {
  name: string;
  label: string;
  help: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  on: React.ReactNode;
  off: React.ReactNode;
  more?: React.ReactNode;
}) {
  return (
    <SettingRow
      label={label}
      help={help}
      placement="end"
      control={
        <SettingSwitch name={name} label={label} checked={checked} onCheckedChange={onChange} />
      }
      consequence={checked ? on : off}
      more={more}
    />
  );
}

/**
 * Every hosted-page setting as one client island, so each consequence previews the
 * value on screen. Cancel timing hides while cancelling is off but stays mounted: the
 * action always reads `cancel_timing`, and an unmounted select would post nothing.
 */
export function HostedPagesFields({
  d,
  base,
  planPrices = [],
}: {
  d: HostedPagesDefaults;
  base: string;
  /** Recurring plan prices, for the downgrade offer. */
  planPrices?: Array<{ value: string; label: string }>;
}) {
  const [coupons, setCoupons] = useDefaultState(d.coupons);
  const [couponLimit, setCouponLimit] = useDefaultState(String(d.couponCodeLimit));
  const [download, setDownload] = useDefaultState(d.invoiceDownload);
  const [pay, setPay] = useDefaultState(d.invoicePayment);
  const [removePm, setRemovePm] = useDefaultState(d.removePaymentMethod);
  const [cancel, setCancel] = useDefaultState(d.cancel);
  const [timing, setTiming] = useDefaultState<string>(d.cancelTiming);
  const [oneTimeSave, setOneTimeSave] = useDefaultState<string>(d.oneTimeSave);
  const [pause, setPause] = useDefaultState(d.pauseResume);
  const [reactivate, setReactivate] = useDefaultState(d.reactivate);
  const [skip, setSkip] = useDefaultState(d.skipRenewal);
  const [skipLimit, setSkipLimit] = useDefaultState(String(d.skipRenewalLimit));
  const [hideZero, setHideZero] = useDefaultState(d.hideZeroLines);
  const [po, setPo] = useDefaultState(d.collectPoNumber);
  const [usage, setUsage] = useDefaultState(d.showUsage);
  const [projection, setProjection] = useDefaultState(d.showUsageProjection);
  const [recurringConsent, setRecurringConsent] = useDefaultState(d.recurringConsent);
  const [requireTerms, setRequireTerms] = useDefaultState(d.requireTerms);
  const [marketing, setMarketing] = useDefaultState(d.marketingConsent);
  const [layout, setLayout] = useDefaultState<string>(d.checkoutLayout);
  const [planChanges, setPlanChanges] = useDefaultState(d.planChanges);
  const [seatChanges, setSeatChanges] = useDefaultState<string>(d.seatChanges);
  const [addonChanges, setAddonChanges] = useDefaultState(d.addonChanges);
  const [shorter, setShorter] = useDefaultState<string>(d.shorterPeriod);
  const [chargeUpgrade, setChargeUpgrade] = useDefaultState<string>(d.chargeUpgrade);
  const [withdraw, setWithdraw] = useDefaultState(d.cancelScheduledChange);
  const [cancelReason, setCancelReason] = useDefaultState<string>(d.cancelReason);
  const [retPause, setRetPause] = useDefaultState(d.retentionPause);
  const [retMonths, setRetMonths] = useDefaultState<string>(
    d.retentionPauseMonths == null ? "none" : String(d.retentionPauseMonths),
  );
  const [retDowngrade, setRetDowngrade] = useDefaultState<string>(d.retentionDowngradePrice);
  const [retOnce, setRetOnce] = useDefaultState(d.retentionOfferOnce);
  const [emailCode, setEmailCode] = useDefaultState(d.portalEmailCode);
  const [hideCancelled, setHideCancelled] = useDefaultState(d.portalHideCancelledSubscriptions);
  const [hideZeroInv, setHideZeroInv] = useDefaultState(d.portalHideZeroInvoices);
  const [hideVoided, setHideVoided] = useDefaultState(d.portalHideVoidedInvoices);
  const [actPay, setActPay] = useDefaultState(d.portalActions.payInvoice);
  const [actCard, setActCard] = useDefaultState(d.portalActions.updateCard);
  const [actPlan, setActPlan] = useDefaultState(d.portalActions.changePlan);
  const [actCancel, setActCancel] = useDefaultState(d.portalActions.cancel);
  const [botCheck, setBotCheck] = useDefaultState<string>(
    d.botCheckAfterFailures == null ? "" : String(d.botCheckAfterFailures),
  );

  const billingRules = (
    <Link href={`${base}/billing-rules`} className="text-primary hover:underline">
      Billing rules
    </Link>
  );

  return (
    <>
      {/* The save replaces storefront_config whole: keep keys this form has no row for yet. */}
      {d.walletsFirst ? <input type="hidden" name="wallets_first" value="on" /> : null}
      <SettingsCard title="Checkout layout" meta="Hosted checkout">
        <SettingRow
          label="Layout"
          help="How the hosted checkout shows the customer's details and the payment. Plan changes always show a review step."
          control={
            <SelectField
              name="checkout_layout"
              value={layout}
              onValueChange={setLayout}
              ariaLabel="Checkout layout"
              options={[
                { value: "one_page", label: "One page" },
                { value: "steps", label: "Steps" },
              ]}
            />
          }
          consequence={
            layout === "one_page"
              ? "Details and payment show on one page. The payment methods show when the email and billing address are complete."
              : "The customer enters their details, then continues to a separate payment step."
          }
        />
      </SettingsCard>

      <SettingsCard title="Payment protection" meta="Hosted checkout">
        <SettingRow
          label="Check for bots after failed payments"
          help="After this many failed payments from one IP address in 24 hours, the checkout asks the customer to complete a Cloudflare Turnstile check before the next payment."
          control={
            <SelectField
              name="bot_check_after_failures"
              value={botCheck}
              onValueChange={setBotCheck}
              ariaLabel="Check for bots after failed payments"
              options={[
                { value: "", label: "Off" },
                // A value saved through the API that is not in the list still shows as itself.
                ...[...new Set(["1", "3", "5", "10", botCheck].filter(Boolean))]
                  .sort((a, b) => Number(a) - Number(b))
                  .map((n) => ({
                    value: n,
                    label: n === "1" ? "After 1 failure" : `After ${n} failures`,
                  })),
              ]}
            />
          }
          consequence={
            botCheck
              ? "Stops card testing, where a bot tries many card numbers on your checkout. Real customers see the check only after repeated failures."
              : "The checkout never asks for a bot check."
          }
        />
      </SettingsCard>

      <SettingsCard title="Consent at checkout" meta="Hosted checkout">
        <SwitchRow
          name="recurring_consent"
          label="Ask customers to agree to recurring charges"
          help="A required checkbox before payment that states the amount and how often you charge it."
          checked={recurringConsent}
          onChange={setRecurringConsent}
          on="Customers must select the box to subscribe. We keep the exact text that they agreed to, the time and the IP address, for disputes."
          off="Customers subscribe without this checkbox."
        />
        <SwitchRow
          name="require_terms"
          label="Ask customers to accept your terms"
          help="A required checkbox with links to your terms and, if you add it, your privacy policy."
          checked={requireTerms}
          onChange={setRequireTerms}
          on="Customers must accept your terms to pay. We keep the time and the IP address."
          off="Customers pay without accepting terms on the checkout."
        />
        {/* Hidden, not unmounted, while terms are off: the URLs keep their saved values. */}
        <div className={cn(!requireTerms && "hidden")}>
          <SettingRow
            label="Terms URL"
            htmlFor="terms_url"
            errorFor="terms_url"
            help="Required while customers must accept your terms. Starts with https://."
            control={
              <ErrorLinkedInput
                id="terms_url"
                name="terms_url"
                type="url"
                defaultValue={d.termsUrl}
                placeholder="https://"
                className="w-72"
                aria-label="Terms URL"
              />
            }
          />
          <SettingRow
            label="Privacy policy URL"
            help="Optional. Shows beside the terms link."
            control={
              <Input
                name="privacy_url"
                type="url"
                defaultValue={d.privacyUrl}
                placeholder="https://"
                className="w-72"
                aria-label="Privacy policy URL"
              />
            }
          />
        </div>
        <SwitchRow
          name="marketing_consent"
          label="Offer a marketing opt-in"
          help="An optional checkbox: “Send me news and offers by email.”"
          checked={marketing}
          onChange={setMarketing}
          on="We save each customer's answer and the time on the customer record."
          off="Customers see no marketing checkbox."
        />
      </SettingsCard>

      <SettingsCard title="Plan changes" meta="Self-serve portal">
        <SwitchRow
          name="allow_plan_changes"
          label="Let customers change their plan"
          help={
            <>
              Customers see the plans and add-ons that you set to Show in portal on each product.
              Upgrades start now and downgrades at the end of the term, as set in {billingRules}.
            </>
          }
          checked={planChanges}
          onChange={setPlanChanges}
          on="The plan card shows Change plan. Customers see the exact price before they confirm."
          off="Customers cannot change their plan in the portal. You can still change it for them."
        />
        {/* Hidden, not unmounted, while plan changes are off: the rows keep their saved values. */}
        <div className={cn(!planChanges && "hidden")}>
          <SettingRow
            label="Seat changes"
            help="Seats are the quantity of a per-seat plan."
            control={
              <SelectField
                name="seat_changes"
                value={seatChanges}
                onValueChange={setSeatChanges}
                ariaLabel="Seat changes"
                options={[
                  { value: "off", label: "Off" },
                  { value: "increase", label: "Increases only" },
                  { value: "both", label: "Increases and decreases" },
                ]}
              />
            }
          />
          <div className={cn(seatChanges === "off" && "hidden")}>
            <SettingRow
              label="Seat limits"
              errorFor="seat_max"
              help="Empty means no limit, or at least 1."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    name="seat_min"
                    type="number"
                    min={1}
                    defaultValue={d.seatMin ?? ""}
                    placeholder="Min"
                    className="w-24"
                    aria-label="Minimum seats"
                  />
                  <ErrorLinkedInput
                    name="seat_max"
                    type="number"
                    min={1}
                    defaultValue={d.seatMax ?? ""}
                    placeholder="Max"
                    className="w-24"
                    aria-label="Maximum seats"
                  />
                </div>
              }
            />
          </div>
          <SwitchRow
            name="allow_addon_changes"
            label="Let customers add or remove add-ons"
            help="Only add-ons set to Show in portal. A customer can always remove an add-on they have."
            checked={addonChanges}
            onChange={setAddonChanges}
            on="Customers see the add-ons and their price, and can add or remove them."
            off="Add-ons stay as they are."
          />
          <SettingRow
            label="Move to a shorter billing period"
            help="For example, from yearly to monthly. A move to a longer period is always allowed."
            control={
              <SelectField
                name="shorter_period"
                value={shorter}
                onValueChange={setShorter}
                ariaLabel="Move to a shorter billing period"
                options={[
                  { value: "always", label: "Always" },
                  { value: "after_12_months", label: "After 12 months" },
                  { value: "never", label: "Never" },
                ]}
              />
            }
          />
          <SettingRow
            label="Charge for an upgrade"
            help="When the price of an upgrade is invoiced."
            control={
              <SelectField
                name="charge_upgrade"
                value={chargeUpgrade}
                onValueChange={setChargeUpgrade}
                ariaLabel="Charge for an upgrade"
                options={[
                  { value: "business_default", label: "Follow Billing rules" },
                  { value: "now", label: "Now" },
                  { value: "next_invoice", label: "On the next invoice" },
                ]}
              />
            }
          />
          <SettingRow
            label="Subscriptions that can change"
            help="By status."
            control={
              <div className="flex flex-wrap gap-4">
                {[
                  ["active", "Active"],
                  ["in_trial", "In trial"],
                  ["paused", "Paused"],
                ].map(([value, label]) => (
                  <CheckboxField
                    key={value}
                    name={`change_status_${value}`}
                    defaultChecked={d.changeStatuses.includes(value!)}
                    label={label}
                  />
                ))}
              </div>
            }
          />
          <SwitchRow
            name="allow_cancel_scheduled_change"
            label="Let customers withdraw a scheduled change"
            help="A downgrade starts at the end of the term. Until then, the customer can withdraw it."
            checked={withdraw}
            onChange={setWithdraw}
            on="The plan card shows Withdraw change while a change is scheduled."
            off="Only you can withdraw a scheduled change."
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Coupon codes" meta="Checkout and portal">
        <SwitchRow
          name="allow_customer_coupons"
          label="Let customers add or remove a coupon code"
          help="A coupon box on the hosted checkout, and add or remove on a subscription in the portal."
          checked={coupons}
          onChange={setCoupons}
          on="Anyone who knows a code can use it. A customer can remove a coupon even if you applied it. A manual discount stays under your control."
          off="Customers see no coupon box. Off is the default, because a coupon box makes customers search for codes."
          more="A code is only as private as its coupon settings. To limit who can use it, set the validity, redemption cap and item rules of the coupon. Or issue single-use codes from a coupon set."
        />
        <div className={cn(!coupons && "hidden")}>
          <SettingRow
            label="Coupon codes a customer can enter"
            htmlFor="max_customer_coupon_codes"
            errorFor="max_customer_coupon_codes"
            help="From 1 to 10, on one checkout or on one subscription in the portal. Discounts that you apply do not count, but at 1 the portal accepts no code while a subscription has a discount."
            control={
              <ErrorLinkedInput
                id="max_customer_coupon_codes"
                name="max_customer_coupon_codes"
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                step={1}
                required={coupons}
                defaultValue={d.couponCodeLimit}
                onChange={(e) => setCouponLimit(e.target.value)}
                className="w-20 tabular-nums"
              />
            }
            consequence={
              /^([1-9]|10)$/.test(couponLimit.trim())
                ? couponLimit.trim() === "1"
                  ? "A customer can enter 1 coupon code. In the portal, only when the subscription has no discount."
                  : `A customer can enter up to ${couponLimit.trim()} coupon codes. The discounts add together, also with discounts that you apply.`
                : "Enter a whole number from 1 to 10."
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Invoices and payment methods" meta="Self-serve portal · on by default">
        <SwitchRow
          name="allow_invoice_download"
          label="Let customers download their invoices"
          help="The PDF download on the portal's invoice list and detail."
          checked={download}
          onChange={setDownload}
          on="Customers can download any of their invoices as a PDF."
          off="Customers still see their invoices but cannot download the PDF."
        />
        <SwitchRow
          name="allow_invoice_payment"
          label="Let customers pay an unpaid invoice"
          help="Pay now on an unpaid invoice in the portal."
          checked={pay}
          onChange={setPay}
          on="Customers can pay an unpaid invoice themselves, alongside automatic collection."
          off="The portal shows no Pay now. Automatic collection and dunning still run, so you still get the money."
        />
        <SwitchRow
          name="allow_remove_payment_method"
          label="Let customers remove a payment method"
          help="Removing a stored card or mandate in the portal. Customers can always add one."
          checked={removePm}
          onChange={setRemovePm}
          on="A customer can remove even the card that a live subscription uses. The next renewal then has nothing to charge."
          off="Customers can add payment methods but not remove them."
        />
      </SettingsCard>

      <SettingsCard title="Usage" meta="Self-serve portal · metered subscriptions">
        <SwitchRow
          name="portal_show_usage"
          label="Show customers their usage this period"
          help="On each subscription with a metered price: the units used so far, the amount, the tax and the total."
          checked={usage}
          onChange={setUsage}
          on="Customers see the same usage and amounts that their next invoice bills. The figures are before discounts and credits."
          off="The portal shows no usage. Customers see usage only on their invoices."
        />
        {/* Hidden, not unmounted, while usage is off: the projection keeps its saved value. */}
        <div className={cn(!usage && "hidden")}>
          <SwitchRow
            name="portal_show_usage_projection"
            label="Also show the projected usage"
            help="The usage at the end of the period if it continues at the current rate."
            checked={projection}
            onChange={setProjection}
            on="Customers see a projected total. It is an estimate, not a price that we promise."
            off="Customers see only the usage so far."
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Cancelling, pausing, skipping and reactivating"
        meta="Self-serve portal · off by default"
      >
        <SwitchRow
          name="allow_cancel_subscription"
          label="Let customers cancel their own subscription"
          help="A cancel action on the subscription in the portal."
          checked={cancel}
          onChange={setCancel}
          on={
            <>
              Every customer gets a cancel action. Your cancellation defaults under {billingRules}{" "}
              decide how we settle the money.
            </>
          }
          off="Customers have to ask you to cancel."
        />
        <div className={cn(!cancel && "hidden")}>
          <SettingRow
            label="When a customer's cancellation takes effect"
            htmlFor="cancel_timing"
            help="Your choice, not the customer's."
            control={
              <SelectField
                name="cancel_timing"
                value={timing}
                onValueChange={setTiming}
                ariaLabel="When a customer's cancellation takes effect"
                options={[
                  { value: "end_of_term", label: "At the end of the current term" },
                  { value: "immediately", label: "Immediately" },
                ]}
                className="w-full sm:w-72"
              />
            }
            consequence={
              timing === "immediately" ? (
                <>
                  The subscription ends immediately. Your cancellation defaults under {billingRules}{" "}
                  decide what happens to the unused time.
                </>
              ) : (
                "The subscription continues until the paid period ends. Then it stops."
              )
            }
          />
          <SettingRow
            label="Ask for a reason when a customer cancels in the portal"
            help={
              <>
                Uses your cancel reason codes. This is only for customers in the portal. Cancels by
                your team follow {billingRules}.
              </>
            }
            control={
              <SelectField
                name="cancel_reason"
                value={cancelReason}
                onValueChange={setCancelReason}
                ariaLabel="Ask for a reason when a customer cancels in the portal"
                options={[
                  { value: "optional", label: "Optional" },
                  { value: "required", label: "Required" },
                  { value: "off", label: "Do not ask" },
                ]}
              />
            }
          />
          <SwitchRow
            name="retention_pause"
            label="Offer a pause before the customer cancels"
            help="The customer sees the offer after the reason. They can still cancel."
            checked={retPause}
            onChange={setRetPause}
            on="The subscription pauses now and continues after the pause. No payments while paused."
            off="No pause offer."
          />
          <div className={cn(!retPause && "hidden")}>
            <SettingRow
              label="Pause length"
              control={
                <SelectField
                  name="retention_pause_months"
                  value={retMonths}
                  onValueChange={setRetMonths}
                  ariaLabel="Pause length"
                  options={[
                    ...Array.from({ length: 12 }, (_, i) => ({
                      value: String(i + 1),
                      label: `${i + 1} month${i === 0 ? "" : "s"}`,
                    })),
                    { value: "none", label: "No end date" },
                  ]}
                />
              }
            />
            <div className={cn(retMonths === "none" && "hidden")}>
              <SettingRow
                label="The customer selects the length"
                help="From 1 month to the pause length above."
                control={
                  <CheckboxField
                    name="retention_pause_choice"
                    defaultChecked={d.retentionPauseChoice}
                    label="Let the customer select"
                  />
                }
              />
            </div>
          </div>
          <SettingRow
            label="Offer a cheaper plan before the customer cancels"
            help="The plan change starts at the next renewal (now, during a trial)."
            control={
              <SelectField
                name="retention_downgrade_price"
                value={retDowngrade}
                onValueChange={setRetDowngrade}
                ariaLabel="Offer a cheaper plan before the customer cancels"
                options={[{ value: "", label: "No plan offer" }, ...planPrices]}
              />
            }
          />
          <SettingRow
            label="Offer a coupon before the customer cancels"
            help="The code of an existing coupon. Customers can get it only from this offer, not from a coupon box. Empty means no discount offer."
            control={
              <Input
                name="retention_coupon"
                defaultValue={d.retentionCoupon}
                placeholder="Coupon code"
                className="w-56"
                aria-label="Coupon code to offer"
              />
            }
          />
          <SettingRow
            label="Offer “Contact us” before the customer cancels"
            help="A link to your help or contact page. Empty means no contact offer."
            control={
              <Input
                name="retention_contact_url"
                type="url"
                defaultValue={d.retentionContactUrl}
                placeholder="https://"
                className="w-72"
                aria-label="Contact page URL"
              />
            }
          />
          <SwitchRow
            name="retention_offer_once"
            label="Make each offer one time per customer"
            help="A customer who took an offer before does not see offers again."
            checked={retOnce}
            onChange={setRetOnce}
            on="A customer gets offers until they take one."
            off="A customer sees the offers each time they start to cancel."
          />
        </div>
        <SwitchRow
          name="allow_pause_resume"
          label="Let customers pause and resume"
          help="Pause and resume on the subscription in the portal. One switch controls both, so a customer who pauses can always resume."
          checked={pause}
          onChange={setPause}
          on={
            <>
              Unbilled charges and dunning while paused follow your pause defaults under{" "}
              {billingRules}.
            </>
          }
          off="Customers have to ask you to pause or resume."
        />
        <SwitchRow
          name="allow_skip_renewal"
          label="Let customers skip a renewal"
          help="Skip and undo on the subscription in the portal. At a skipped renewal, the term moves on one period and we do not charge the recurring items. Usage and one-time charges are still invoiced."
          checked={skip}
          onChange={setSkip}
          on="Active subscriptions only. Customers cannot skip or undo less than 48 hours before a renewal."
          off="Customers have to ask you to skip a renewal. You can always skip one from the subscription."
        />
        {/* Hidden, not unmounted, while skipping is off: the limit keeps its saved value. */}
        <div className={cn(!skip && "hidden")}>
          <SettingRow
            label="Most renewals a customer can skip in 12 months"
            htmlFor="skip_renewal_limit"
            errorFor="skip_renewal_limit"
            help="From 1 to 12. This limit does not apply to skips that you make."
            control={
              <ErrorLinkedInput
                id="skip_renewal_limit"
                name="skip_renewal_limit"
                type="number"
                inputMode="numeric"
                min={1}
                max={12}
                step={1}
                required={skip}
                defaultValue={d.skipRenewalLimit}
                onChange={(e) => setSkipLimit(e.target.value)}
                className="w-20 tabular-nums"
              />
            }
            consequence={
              /^([1-9]|1[0-2])$/.test(skipLimit.trim())
                ? `A customer can skip up to ${skipLimit.trim()} renewal${skipLimit.trim() === "1" ? "" : "s"} in any 12 months.`
                : "Enter a whole number from 1 to 12."
            }
          />
        </div>
        <SwitchRow
          name="allow_reactivate"
          label="Let customers undo a cancellation"
          help="This keeps a subscription that is scheduled to cancel. We charge nothing."
          checked={reactivate}
          onChange={setReactivate}
          on="This works only while the subscription is active. After it ends, a restart bills a new period, so the portal tells the customer to contact you."
          off="A scheduled cancellation goes ahead unless you undo it."
        />
      </SettingsCard>

      <SettingsCard title="One-time purchases" meta="Checkout">
        <SettingRow
          label="Save the customer's payment method"
          htmlFor="one_time_save_payment_method"
          help="When a customer buys a one-time product from a checkout link."
          control={
            <SelectField
              name="one_time_save_payment_method"
              value={oneTimeSave}
              onValueChange={setOneTimeSave}
              ariaLabel="Save the customer's payment method"
              options={[
                { value: "ask", label: "Ask the customer" },
                { value: "always", label: "Always" },
                { value: "never", label: "Never" },
              ]}
              className="w-full sm:w-72"
            />
          }
          consequence={
            oneTimeSave === "always"
              ? "We save the payment method, then charge it. The customer can use it again for later purchases."
              : oneTimeSave === "never"
                ? "We charge the customer once and do not keep the payment method."
                : "The customer selects if we keep the payment method for later purchases."
          }
        />
      </SettingsCard>

      <SettingsCard title="Portal links" meta="Self-serve portal">
        <LinkErrorMessage saved={d.linkErrorHtml} />
        <SwitchRow
          name="portal_email_code"
          label="Let customers sign in with an email code"
          help="A customer without a working link enters their email on the portal. We send a code to that email, and they type it to sign in. We never send a sign-in link."
          checked={emailCode}
          onChange={setEmailCode}
          on="The code works for 10 minutes and for one sign-in. You can change the email under Email notifications."
          off="Customers who need to sign in have to ask you for a new link."
        />
        <SettingRow
          label="How long an API portal link works"
          help="In hours, from 1 to 24. Empty means 1 hour. This applies to links your systems get from the API."
          control={
            <Input
              name="portal_link_hours"
              type="number"
              min={1}
              max={24}
              defaultValue={d.portalLinkHours ?? ""}
              placeholder="1"
              className="w-24 tabular-nums"
              aria-label="API portal link hours"
            />
          }
        />
        <SettingRow
          label="How long a portal link in an email works"
          help="In days, from 1 to 14. Empty means 5 days."
          control={
            <Input
              name="portal_email_link_days"
              type="number"
              min={1}
              max={14}
              defaultValue={d.portalEmailLinkDays ?? ""}
              placeholder="5"
              className="w-24 tabular-nums"
              aria-label="Email portal link days"
            />
          }
        />
        <SettingRow
          label="How long a customer stays signed in"
          help="In hours, from 1 to 168. Empty means 72 hours."
          control={
            <Input
              name="portal_session_hours"
              type="number"
              min={1}
              max={168}
              defaultValue={d.portalSessionHours ?? ""}
              placeholder="72"
              className="w-24 tabular-nums"
              aria-label="Portal session hours"
            />
          }
        />
      </SettingsCard>

      <SettingsCard title="Links to one task" meta="Emails and the API">
        <p className="m-0 px-5 py-3 text-sm text-muted-foreground">
          A link can open the portal on one task. Email buttons use this for &ldquo;Pay now&rdquo;
          and &ldquo;Change payment method&rdquo;. A link from an email opens a short page with a
          Continue button first, so an email security scanner cannot use the link before your
          customer does. When a task is off, its links open the portal home.
        </p>
        <SwitchRow
          name="portal_action_pay_invoice"
          label="Pay an invoice"
          help="The link opens the invoice, ready to pay."
          checked={actPay}
          onChange={setActPay}
          on="Pay now buttons open the invoice."
          off="Pay now buttons open the portal home."
        />
        <SwitchRow
          name="portal_action_update_card"
          label="Change the payment method"
          help="The link opens the form to add a payment method."
          checked={actCard}
          onChange={setActCard}
          on="Change payment method buttons open the form."
          off="Change payment method buttons open the portal home."
        />
        <SwitchRow
          name="portal_action_change_plan"
          label="Change the plan"
          help="For links your systems get from the API. The link opens the plan change for one subscription."
          checked={actPlan}
          onChange={setActPlan}
          on="The link opens the plan change."
          off="The link opens the portal home."
        />
        <SwitchRow
          name="portal_action_cancel"
          label="Cancel a subscription"
          help="For links your systems get from the API. The link opens the cancel steps for one subscription."
          checked={actCancel}
          onChange={setActCancel}
          on="The link opens the cancel steps."
          off="The link opens the portal home."
        />
        <SettingRow
          label="Back link in the portal"
          htmlFor="portal_return_url"
          errorFor="portal_return_url"
          help="The portal shows “Back to” your business with this https link. Empty means the return URL under Checkout."
          control={
            <ErrorLinkedInput
              id="portal_return_url"
              name="portal_return_url"
              type="url"
              defaultValue={d.portalReturnUrl}
              placeholder="https://"
              className="w-72"
              aria-label="Portal back link URL"
            />
          }
        />
      </SettingsCard>

      <SettingsCard title="Hidden in the portal" meta="Self-serve portal">
        <SwitchRow
          name="portal_hide_cancelled_subscriptions"
          label="Hide cancelled subscriptions"
          help="The portal lists only subscriptions that are not cancelled."
          checked={hideCancelled}
          onChange={setHideCancelled}
          on="Customers do not see subscriptions that ended."
          off="Customers see every subscription, including the ones that ended."
        />
        <SwitchRow
          name="portal_hide_zero_invoices"
          label="Hide invoices with a zero total"
          help="An invoice with an amount to pay always shows."
          checked={hideZeroInv}
          onChange={setHideZeroInv}
          on="Customers do not see invoices for zero."
          off="Customers see every invoice, including invoices for zero."
        />
        <SwitchRow
          name="portal_hide_voided_invoices"
          label="Hide voided invoices"
          help="A customer can still open a voided invoice from a link they have."
          checked={hideVoided}
          onChange={setHideVoided}
          on="The invoice list does not show voided invoices."
          off="The invoice list shows voided invoices."
        />
      </SettingsCard>

      <SettingsCard title="Checkout" meta="Line items, PO number and redirects">
        <SwitchRow
          name="hide_zero_value_lines"
          label="Hide zero-value line items"
          help="Hides items priced at zero on the hosted checkout and the portal."
          checked={hideZero}
          onChange={setHideZero}
          on="The checkout and portal do not show zero-priced lines. Printed invoices use their own zero-value setting under Invoices."
          off="Every line shows, including those priced at zero."
        />
        <SwitchRow
          name="collect_po_number"
          label="Collect a PO number at checkout"
          help="Adds a PO number field to the hosted checkout."
          checked={po}
          onChange={setPo}
          on={
            <>
              The hosted checkout asks for a PO number and saves it on the subscription. Make it
              required under{" "}
              <Link href={`${base}/checkout-fields`} className="text-primary hover:underline">
                Checkout and portal fields
              </Link>
              .
            </>
          }
          off="The hosted checkout shows no PO number field, and we do not apply the Checkout and portal fields rule."
          more="In both cases, if the API sends a PO number when a checkout completes, we save it on the subscription."
        />
        <SettingRow
          label="Default return URL"
          htmlFor="default_return_url"
          help="Used for return_url on the checkout's add-card step when a call sends none. A value on the call always wins."
          control={
            <Input
              id="default_return_url"
              name="default_return_url"
              type="url"
              defaultValue={d.returnUrl}
              maxLength={2000}
              placeholder="https://…"
              className="w-full sm:max-w-md"
            />
          }
        />
        <SettingRow
          label="Default cancel URL"
          htmlFor="default_cancel_url"
          help="The same, for cancel_url. If the call has no value and there is no default here, we refuse the add-card step."
          control={
            <Input
              id="default_cancel_url"
              name="default_cancel_url"
              type="url"
              defaultValue={d.cancelUrl}
              maxLength={2000}
              placeholder="https://…"
              className="w-full sm:max-w-md"
            />
          }
        />
      </SettingsCard>
    </>
  );
}
