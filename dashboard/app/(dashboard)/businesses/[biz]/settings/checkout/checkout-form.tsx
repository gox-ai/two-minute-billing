"use client";

import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SelectAnswer } from "@/components/patterns/settings-page";
import { SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { SwitchRow, ErrorLinkedInput } from "../_components/hosted-rows";

export interface CheckoutDefaults {
  coupons: boolean;
  /** Coupon codes a buyer can enter on one checkout or subscription (1–10, 0495). */
  couponCodeLimit: number;
  hideZeroLines: boolean;
  collectPoNumber: boolean;
  returnUrl: string;
  cancelUrl: string;
  /** One-time purchases: keep the buyer's payment method? */
  oneTimeSave: "never" | "always" | "ask";
  /** Checkout: the buyer agrees to the recurring charge. */
  recurringConsent: boolean;
  /** Checkout: the buyer accepts the terms (needs a terms URL). */
  requireTerms: boolean;
  termsUrl: string;
  privacyUrl: string;
  /** Checkout: optional marketing opt-in. */
  marketingConsent: boolean;
  checkoutLayout: "steps" | "one_page";
  botCheckAfterFailures: number | null;
}

export function CheckoutFields({ d, base }: { d: CheckoutDefaults; base: string }) {
  const [coupons, setCoupons] = useDefaultState(d.coupons);
  const [couponLimit, setCouponLimit] = useDefaultState(String(d.couponCodeLimit));
  const [oneTimeSave, setOneTimeSave] = useDefaultState<string>(d.oneTimeSave);
  const [hideZero, setHideZero] = useDefaultState(d.hideZeroLines);
  const [po, setPo] = useDefaultState(d.collectPoNumber);
  const [recurringConsent, setRecurringConsent] = useDefaultState(d.recurringConsent);
  const [requireTerms, setRequireTerms] = useDefaultState(d.requireTerms);
  const [marketing, setMarketing] = useDefaultState(d.marketingConsent);
  const [layout, setLayout] = useDefaultState<string>(d.checkoutLayout);
  const [botCheck, setBotCheck] = useDefaultState<string>(
    d.botCheckAfterFailures == null ? "" : String(d.botCheckAfterFailures),
  );

  return (
    <>
      <SettingsCard title="Checkout layout" meta="Hosted checkout">
        <SettingRow
          placement="end"
          label="Layout"
          help="How the hosted checkout shows the customer's details and the payment. Plan changes always show a review step."
          control={
            <SelectAnswer
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
          placement="end"
          label="Check for bots after failed payments"
          help="After this many failed payments from one IP address in 24 hours, the checkout asks the customer to complete a Cloudflare Turnstile check before the next payment."
          control={
            <SelectAnswer
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
            placement="end"
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
            placement="end"
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
            placement="end"
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

      <SettingsCard title="One-time purchases" meta="Checkout">
        <SettingRow
          placement="end"
          label="Save the customer's payment method"
          htmlFor="one_time_save_payment_method"
          help="When a customer buys a one-time product from a checkout link."
          control={
            <SelectAnswer
              name="one_time_save_payment_method"
              value={oneTimeSave}
              onValueChange={setOneTimeSave}
              ariaLabel="Save the customer's payment method"
              options={[
                { value: "ask", label: "Ask the customer" },
                { value: "always", label: "Always" },
                { value: "never", label: "Never" },
              ]}
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
          placement="end"
          label="Default return URL"
          htmlFor="default_return_url"
          help="Where we send the customer after the add-card step of the checkout, when your request does not include a link. A link in the request always wins."
          control={
            <Input
              id="default_return_url"
              name="default_return_url"
              type="url"
              defaultValue={d.returnUrl}
              maxLength={2000}
              placeholder="https://…"
              className="w-full sm:w-72"
            />
          }
        />
        <SettingRow
          placement="end"
          label="Default cancel URL"
          htmlFor="default_cancel_url"
          help="Where we send the customer who cancels the add-card step, when your request does not include a link. If neither has a link, we refuse the add-card step."
          control={
            <Input
              id="default_cancel_url"
              name="default_cancel_url"
              type="url"
              defaultValue={d.cancelUrl}
              maxLength={2000}
              placeholder="https://…"
              className="w-full sm:w-72"
            />
          }
        />
      </SettingsCard>
    </>
  );
}
