"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { CheckboxField } from "@/components/ui/checkbox";
import { SelectAnswer, ToggleAnswer } from "@/components/patterns/settings-page";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { RichBodyEditor } from "@/components/emails/rich-body-editor";
import { SwitchRow, ErrorLinkedInput } from "../_components/hosted-rows";

export interface PortalDefaults {
  invoiceDownload: boolean;
  invoicePayment: boolean;
  removePaymentMethod: boolean;
  cancel: boolean;
  cancelTiming: "end_of_term" | "immediately";
  pauseResume: boolean;
  reactivate: boolean;
  /** Restart an ended subscription through a checkout. */
  restart: boolean;
  restartPrice: "current" | "keep";
  /** Days after the end; null = any time. */
  restartWindowDays: number | null;
  restartOpenInvoices: "pay_first" | "allow";
  skipRenewal: boolean;
  /** 1–12 renewals per 12 months. */
  skipRenewalLimit: number;
  /** Saved portal link-error message; '' = the default copy. */
  linkErrorHtml: string;
  /** Portal Pay now with a new card: offer a save box, always save, or never. */
  portalSaveNew: "offer" | "always" | "never";
  /** Portal asks why when a customer deletes their last payment method. */
  askDeleteReason: boolean;
  /** Portal usage so far on metered subscriptions (default on). */
  showUsage: boolean;
  /** Portal projected usage at window end (default off). */
  showUsageProjection: boolean;
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
      placement="below"
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

export function PortalFields({
  d,
  base,
  planPrices = [],
}: {
  d: PortalDefaults;
  base: string;
  /** Recurring plan prices, for the downgrade offer. */
  planPrices?: Array<{ value: string; label: string }>;
}) {
  const [download, setDownload] = useDefaultState(d.invoiceDownload);
  const [pay, setPay] = useDefaultState(d.invoicePayment);
  const [removePm, setRemovePm] = useDefaultState(d.removePaymentMethod);
  const [cancel, setCancel] = useDefaultState(d.cancel);
  const [timing, setTiming] = useDefaultState<string>(d.cancelTiming);
  const [portalSaveNew, setPortalSaveNew] = useDefaultState<string>(d.portalSaveNew);
  const [askDeleteReason, setAskDeleteReason] = useDefaultState(d.askDeleteReason);
  const [pause, setPause] = useDefaultState(d.pauseResume);
  const [reactivate, setReactivate] = useDefaultState(d.reactivate);
  const [restart, setRestart] = useDefaultState(d.restart);
  const [restartPrice, setRestartPrice] = useDefaultState<string>(d.restartPrice);
  const [restartWindow, setRestartWindow] = useDefaultState<string>(
    d.restartWindowDays == null ? "" : String(d.restartWindowDays),
  );
  const [restartInvoices, setRestartInvoices] = useDefaultState<string>(d.restartOpenInvoices);
  const [skip, setSkip] = useDefaultState(d.skipRenewal);
  const [skipLimit, setSkipLimit] = useDefaultState(String(d.skipRenewalLimit));
  const [usage, setUsage] = useDefaultState(d.showUsage);
  const [projection, setProjection] = useDefaultState(d.showUsageProjection);
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

  const billingRules = (
    <Link href={`${base}/billing-rules`} className="text-primary hover:underline">
      Billing rules
    </Link>
  );

  return (
    <>
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
            placement="end"
            label="Seat changes"
            help="Seats are the quantity of a per-seat plan."
            control={
              <SelectAnswer
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
              placement="end"
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
                    className="w-20"
                    aria-label="Minimum seats"
                  />
                  <ErrorLinkedInput
                    name="seat_max"
                    type="number"
                    min={1}
                    defaultValue={d.seatMax ?? ""}
                    placeholder="Max"
                    className="w-20"
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
            placement="end"
            label="Move to a shorter billing period"
            help="For example, from yearly to monthly. A move to a longer period is always allowed."
            control={
              <SelectAnswer
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
            placement="end"
            label="Charge for an upgrade"
            help="When the price of an upgrade is invoiced."
            control={
              <SelectAnswer
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
            placement="end"
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
            placement="end"
            label="When a customer's cancellation takes effect"
            htmlFor="cancel_timing"
            help="Your choice, not the customer's."
            control={
              <SelectAnswer
                name="cancel_timing"
                value={timing}
                onValueChange={setTiming}
                ariaLabel="When a customer's cancellation takes effect"
                options={[
                  { value: "end_of_term", label: "At the end of the current term" },
                  { value: "immediately", label: "Immediately" },
                ]}
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
            placement="end"
            label="Ask for a reason when a customer cancels in the portal"
            help={
              <>
                Uses your cancel reason codes. This is only for customers in the portal. Cancels by
                your team follow {billingRules}.
              </>
            }
            control={
              <SelectAnswer
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
              placement="end"
              label="Pause length"
              control={
                <SelectAnswer
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
                placement="end"
                label="The customer selects the length"
                help="From 1 month to the pause length above."
                control={
                  <ToggleAnswer
                    name="retention_pause_choice"
                    defaultChecked={d.retentionPauseChoice}
                    label="The customer selects the length"
                  />
                }
              />
            </div>
          </div>
          <SettingRow
            placement="end"
            label="Offer a cheaper plan before the customer cancels"
            help="The plan change starts at the next renewal (now, during a trial)."
            control={
              <SelectAnswer
                name="retention_downgrade_price"
                value={retDowngrade}
                onValueChange={setRetDowngrade}
                ariaLabel="Offer a cheaper plan before the customer cancels"
                options={[{ value: "", label: "No plan offer" }, ...planPrices]}
              />
            }
          />
          <SettingRow
            placement="end"
            label="Offer a coupon before the customer cancels"
            help="The code of an existing coupon. Customers can get it only from this offer, not from a coupon box. Empty means no discount offer."
            control={
              <Input
                name="retention_coupon"
                defaultValue={d.retentionCoupon}
                placeholder="Coupon code"
                className="w-72"
                aria-label="Coupon code to offer"
              />
            }
          />
          <SettingRow
            placement="end"
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
            placement="end"
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
          on="This works only while the subscription is active. To let customers reactivate a subscription after it ends, use the next setting."
          off="A scheduled cancellation goes ahead unless you undo it."
        />
        <SwitchRow
          name="allow_restart"
          label="Let customers reactivate an ended subscription"
          help="A Reactivate subscription action in the portal. It opens a checkout where the customer pays for a new term."
          checked={restart}
          onChange={setRestart}
          on="The subscription starts again only after the payment succeeds. If the payment fails, the subscription stays cancelled."
          off="After a subscription ends, the portal tells the customer to contact you."
        />
        {/* Hidden, not unmounted, while restart is off: the three keep their saved values. */}
        <div className={cn(!restart && "hidden")}>
          <SettingRow
            placement="end"
            label="Price of the new term"
            htmlFor="restart_price"
            control={
              <SelectAnswer
                name="restart_price"
                value={restartPrice}
                onValueChange={setRestartPrice}
                ariaLabel="Price of the new term"
                options={[
                  { value: "current", label: "Current price of the plan" },
                  { value: "keep", label: "Price the subscription had" },
                ]}
              />
            }
            consequence={
              restartPrice === "keep"
                ? "The customer pays the same price as before the subscription ended."
                : "The customer pays the plan's price today. A custom price that you set on the subscription stays."
            }
          />
          <SettingRow
            placement="end"
            label="Days after the end that a customer can reactivate"
            htmlFor="restart_window_days"
            errorFor="restart_window_days"
            help="From 1 to 3650. Leave empty for no limit."
            control={
              <ErrorLinkedInput
                id="restart_window_days"
                name="restart_window_days"
                type="number"
                inputMode="numeric"
                min={1}
                max={3650}
                step={1}
                defaultValue={d.restartWindowDays ?? ""}
                onChange={(e) => setRestartWindow(e.target.value)}
                className="w-30 tabular-nums"
              />
            }
            consequence={
              restartWindow.trim() === ""
                ? "Customers can reactivate at any time after the subscription ends."
                : /^[1-9]\d{0,3}$/.test(restartWindow.trim()) && Number(restartWindow) <= 3650
                  ? `Customers can reactivate for ${restartWindow.trim()} day${restartWindow.trim() === "1" ? "" : "s"} after the subscription ends. After that, the portal tells them to contact you.`
                  : "Enter a whole number from 1 to 3650, or leave the field empty."
            }
          />
          <SettingRow
            placement="end"
            label="Unpaid invoices of the subscription"
            htmlFor="restart_open_invoices"
            control={
              <SelectAnswer
                name="restart_open_invoices"
                value={restartInvoices}
                onValueChange={setRestartInvoices}
                ariaLabel="Unpaid invoices of the subscription"
                options={[
                  { value: "pay_first", label: "Customer pays them first" },
                  { value: "allow", label: "They do not stop a reactivation" },
                ]}
              />
            }
            consequence={
              restartInvoices === "allow"
                ? "The unpaid invoices stay open. Dunning and your write-off rules still apply to them."
                : "The portal shows the unpaid invoices first. The customer can reactivate after they pay them."
            }
          />
        </div>
      </SettingsCard>

      <SettingsCard title="Pay now with a new card" meta="Self-serve portal">
        <SettingRow
          placement="end"
          label="Save the new payment method"
          htmlFor="portal_save_new_method"
          help="When a customer pays an invoice in the portal with a card or PayPal account that is not saved. Only on payment gateways that can save it during the payment."
          control={
            <SelectAnswer
              name="portal_save_new_method"
              value={portalSaveNew}
              onValueChange={setPortalSaveNew}
              ariaLabel="Save the new payment method"
              options={[
                { value: "offer", label: "Ask the customer" },
                { value: "always", label: "Always" },
                { value: "never", label: "Never" },
              ]}
            />
          }
          consequence={
            portalSaveNew === "always"
              ? "We save the payment method with the payment and show the customer why. We use it for their later invoices."
              : portalSaveNew === "never"
                ? "We charge the customer once and do not keep the payment method."
                : "The customer selects if we keep the payment method. The option is on when they have no working payment method."
          }
        />
      </SettingsCard>

      <SettingsCard title="Delete a payment method" meta="Self-serve portal">
        <SwitchRow
          name="portal_ask_delete_reason"
          label="Ask why when a customer deletes their last payment method"
          help="Shows a short question with four reasons. The answer is optional."
          checked={askDeleteReason}
          onChange={setAskDeleteReason}
          on="When a customer deletes their last payment method, the portal asks why before it deletes it."
          off="The portal deletes the payment method and asks no question."
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
          placement="end"
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
              className="w-20 tabular-nums"
              aria-label="API portal link hours"
            />
          }
        />
        <SettingRow
          placement="end"
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
              className="w-20 tabular-nums"
              aria-label="Email portal link days"
            />
          }
        />
        <SettingRow
          placement="end"
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
              className="w-20 tabular-nums"
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
          placement="end"
          label="Back link in the portal"
          htmlFor="portal_return_url"
          errorFor="portal_return_url"
          help="The portal shows “Back to” your business with this https link. Empty means the return URL on the Checkout page."
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
    </>
  );
}
