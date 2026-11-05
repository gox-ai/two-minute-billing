import type { BillingRulesPatch } from "@/lib/billing-rules";
import type { FinalSubscriptionAction } from "@/lib/api";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, listBusinesses } from "@/lib/api";
import type { TeamAlertRecipient } from "@/lib/api";
import type {
  Business,
  CreditsFlexibilitySlots,
  CurrencyRate,
  InvoiceRulesConfig,
  PortalFieldKey,
  PortalFieldState,
  ReminderConfig,
  TeamAlertsConfig,
} from "@/lib/api";
export type { AddressFieldLocks, PortalFieldKey, PortalFieldState } from "@/lib/api";

/**
 * Fetch a single business by public id.
 *
 * NOTE: the API has no GET /v1/businesses/:biz (list only), so we resolve via
 * the list endpoint. The list serializer returns the full business object
 * (serializeBusiness), so no settings fields are lost.
 */
export async function getBusiness(biz: string): Promise<Business | undefined> {
  const { data } = await listBusinesses();
  return data.find((b) => b.id === biz);
}

/**
 * The pause and resume defaults a business resolves to, plus its locked keys — mirrors
 * `resolvePauseConfig` (src/modules/subscriptions/pause-config.ts); keep the two in step.
 */
export function resolveResumeDefaults(b: Pick<Business, "pause_config"> | null | undefined): {
  pauseOption: "immediately" | "end_of_term";
  unbilledOnPause: "retain" | "invoice";
  dunningOnPause: "continue" | "stop";
  chargesOnResume: "invoice_immediately" | "add_to_unbilled_charges";
  unpaidInvoicesOnResume: "no_action" | "schedule_payment_collection";
  locked: string[];
} {
  const cfg = b?.pause_config ?? null;
  const charges: string | undefined = cfg?.charges_on_resume;
  return {
    pauseOption: cfg?.pause_option === "end_of_term" ? "end_of_term" : "immediately",
    unbilledOnPause: cfg?.unbilled_on_pause === "invoice" ? "invoice" : "retain",
    dunningOnPause: cfg?.dunning_on_pause === "stop" ? "stop" : "continue",
    chargesOnResume:
      charges === "add_to_unbilled_charges" || charges === "next_renewal"
        ? "add_to_unbilled_charges"
        : "invoice_immediately",
    unpaidInvoicesOnResume:
      cfg?.unpaid_invoices_on_resume === "schedule_payment_collection"
        ? "schedule_payment_collection"
        : "no_action",
    locked: Array.isArray(cfg?.locked) ? cfg.locked : [],
  };
}

/**
 * Set ONE currency's rate source — `PUT /v1/businesses/:biz/currencies/:ccy`.
 *
 * Separate from the settings patch on purpose: this is the only writer of a currency's
 * rate, so the bulk save cannot silently overwrite an auto rate with a stale typed one.
 *
 * `auto` fetches inline, and a FAILED fetch still returns 200 — the currency is auto, the
 * previous rate stands, and `last_error` says why it did not move. Read the returned row
 * rather than assuming success meant a new rate.
 */
export async function setCurrencyRate(
  biz: string,
  currency: string,
  body: { source: "manual"; rate: string } | { source: "auto" },
): Promise<{ ok: boolean; error?: string; rate?: CurrencyRate }> {
  const res = await apiPut(
    `/v1/businesses/${encodeURIComponent(biz)}/currencies/${encodeURIComponent(currency)}`,
    body,
  );
  return { ok: res.ok, error: res.error, rate: res.data as CurrencyRate | undefined };
}

/**
 * Stop transacting in a currency — `DELETE /v1/businesses/:biz/currencies/:ccy`.
 *
 * Drops the currency from the enabled list AND its rate, in one call, because either half
 * alone leaves something untrue behind. The base currency is refused by the engine.
 */
export async function removeCurrencyRate(
  biz: string,
  currency: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiDelete(
    `/v1/businesses/${encodeURIComponent(biz)}/currencies/${encodeURIComponent(currency)}`,
  );
  return { ok: res.ok, error: res.error };
}

/** Everything PATCH /v1/businesses/:biz accepts (mirror of updateBusinessBody in src/api/routes.ts). */
/** Invoice-now vs retain-as-unbilled, per lifecycle event (0242). */
/** What a chargeback does to a subscription (0244). */
/** Show / hide / require, per checkout field (0245). */
export type CheckoutFieldState = "show" | "hide" | "mandatory";
/** The fields the checkout actually collects. */
export type CheckoutFieldKey =
  | "customer.first_name"
  | "customer.last_name"
  | "customer.email"
  | "customer.phone"
  | "customer.company"
  | "customer.tax_registration_number"
  | "billing.line1"
  | "billing.line2"
  | "billing.line3"
  | "billing.city"
  | "billing.state"
  | "billing.state_code"
  | "billing.postal_code"
  | "billing.country"
  | "invoice.po_number"
  | "shipping.address";

export type ChargebackSubscriptionAction =
  | "cancel_immediately"
  | "cancel_end_of_term"
  | "pause_indefinitely"
  | "pause_end_of_term"
  | "no_action";

export type UnbilledEventOption = "invoice_immediately" | "add_to_unbilled";
/**
 * How an out-of-term resume bills its new term — the engine's `ResumeChargesHandling`.
 * The API returns a retired `next_renewal` as `add_to_unbilled_charges`.
 */
export type ChargesOnResume = "invoice_immediately" | "add_to_unbilled_charges";

export interface BusinessSettingsPatch {
  name?: string;
  /** 0–24 minutes added to the usage close after a period ends. */
  usage_close_delay_minutes?: number;
  default_currency?: string;
  currencies?: string[] | null;
  /** 1 default_currency = rate × key currency (reporting only). */
  exchange_rates?: Record<string, number> | null;
  /** Allowed billing frequencies for prices; null = unrestricted. */
  billing_frequencies?: Array<{
    interval: "day" | "week" | "month" | "year";
    count: number;
  }> | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
  contact_email?: string | null;
  support_email?: string | null;
  phone?: string | null;
  website?: string | null;
  logo_url?: string | null;
  /** Brand Styles (0185) — square mark, browser tab, and `#RRGGBB` accent. */
  icon_url?: string | null;
  favicon_url?: string | null;
  brand_color?: string | null;
  /** 0238 — may a BUYER type a coupon code on the hosted checkout / portal? */
  allow_customer_coupons?: boolean;
  max_customer_coupon_codes?: number;
  timezone?: string | null;
  week_start?: "sunday" | "monday";
  fiscal_year_start_month?: number;
  tax_registration_number?: string | null;
  /** Default HSN/SAC for this business's supplies (India GST); products may override it. */
  default_tax_code?: string | null;
  // Invoicing
  invoice_prefix?: string;
  invoice_next_number?: number;
  default_invoice_notes?: string | null;
  inherit_subscription_po_number?: boolean;
  default_due_days?: number | null;
  invoice_rounding?: "none" | "nearest_unit";
  card_payment_limits?: Record<string, number> | null;
  /**
   * Credits Flexibility (0219) — whether refundable credits and excess payments auto-apply
   * to an invoice, per credit kind × invoice class. `limit_minor` is integer MINOR UNITS and
   * is required when `mode` is `'limit'`. An absent slot means auto-apply, unlimited (the
   * engine default), so a partial object is legal; `null` resets the whole setting.
   */
  credits_flexibility?: {
    refundable?: CreditsFlexibilitySlots;
    excess?: CreditsFlexibilitySlots;
  } | null;
  create_pending_invoices?: boolean;
  auto_close_pending_after_days?: number | null;
  // Credit notes
  credit_note_prefix?: string;
  credit_note_next_number?: number;
  // Receipts: the prefix only; the counter is not settable.
  receipt_prefix?: string;
  // Dunning (structured config supersedes dunning_retry_days; null resets to engine default)
  dunning_retry_days?: number[] | null;
  dunning_config?: {
    retries?: Array<{ after_days: number }>;
    final_action?: {
      // Four final invoice actions; 'reverse' settles it as paid via
      // an adjustment credit note with reason code 'order_cancellation'.
      invoice: "not_paid" | "void" | "write_off" | "reverse";
      subscription: FinalSubscriptionAction;
    };
    // 2.48: a schedule per payment method kind; an absent kind uses `retries`.
    retries_by_method?: Partial<
      Record<"card" | "bank_debit" | "offline", Array<{ after_days: number }>>
    >;
    // 2.59: smart mode's adaptive cadences; an absent key keeps its default.
    adaptive_cadence?: {
      transient_hours?: number[];
      generic_days?: number[];
      funds_gap_days?: number | null;
      funds_max_retries?: number;
    };
    // 2.48: plan id → dpol_…; business-wide.
    plan_policies?: Record<string, string>;
    // Billing rules: auto-collect open dues when a payment method is added (default on).
    collect_on_payment_method_update?: boolean;
    /**
     * Whether a reactivation whose charge FAILS is refused. Absent = inherits
     * `collect_on_payment_method_update`, the field it was split out of on 2026-09-07,
     * so a business configured before the split reads the same either way.
     */
    require_successful_charge_on_reactivation?: boolean;
    // A hard decline ends dunning immediately (default on).
    skip_retries_for_hard_failures?: boolean;
    // Master dunning switch (default on).
    enabled?: boolean;
    // Days after the invoice due date at whose end the final action applies.
    dunning_period_days?: number | null;
    dun_trial_and_future_subscriptions?: boolean;
    dun_one_time_invoices?: boolean;
    // Dun auto-collect-off (send-invoice) invoices, so an unpaid one reaches the
    // final action instead of sitting not_paid forever.
    // Needs dunning_period_days — offline invoices have no retries to end a window.
    dun_offline_invoices?: boolean;
    /**
     * Dunning mode. Absent reads as `fixed`.
     *
     * Every writer of this column must CARRY IT FORWARD: the API assigns
     * `dunning_config` whole, so a patch that omits `mode` resets a smart business to
     * fixed silently.
     */
    mode?: "fixed" | "smart";
    // `cancel`: a renewal with no payment method at all cancels, even under `retain`.
    no_payment_method_at_renewal?: "follow_final_action" | "cancel";
    // Smart mode only: retry timing by decline class instead of the offsets. Absent = off.
    adaptive_timing?: boolean;
    park_hard_declines?: boolean;
    // Currency code → minimum amount due, in minor units, before dunning chases an invoice.
    minimum_amounts?: Record<string, number>;
  } | null;
  /** Mandate sizing — `resolveMandateHeadroomConfig` (payment-methods/service.ts). Each key
   * overrides the platform default on its own; null clears both. */
  mandate_config?: {
    headroom_bps?: number;
    rail_ceiling_cap_minor?: number;
  } | null;
  // Billing-rule defaults
  default_prorate_on_change?: boolean;
  default_invoice_immediately?: boolean;
  default_cancel_option?: "immediately" | "end_of_term";
  default_credit_option_for_cancel?: "prorate" | "full" | "none";
  // 'no_action' is the engine default — leave unbilled charges alone on cancel.
  default_unbilled_on_cancel?: "no_action" | "invoice" | "delete";
  default_ar_handling_on_cancel?:
    | "no_action"
    | "schedule_payment_collection"
    | "write_off"
    | "void";
  default_refundable_credits_on_cancel?: "no_action" | "schedule_refund";
  /** Per-event unbilled handling (0242). null/absent → resolver defaults. */
  unbilled_charges_config?: {
    on_create?: UnbilledEventOption;
    on_change?: UnbilledEventOption;
    on_one_time_charge?: UnbilledEventOption;
  } | null;
  /** Pause / resume defaults (0242). null/absent → resolver defaults. */
  pause_config?: {
    pause_option?: "immediately" | "end_of_term";
    unbilled_on_pause?: "retain" | "invoice";
    dunning_on_pause?: "continue" | "stop";
    charges_on_resume?: ChargesOnResume;
    unpaid_invoices_on_resume?: "no_action" | "schedule_payment_collection";
    /** The "prevent overriding" list. Advisory until enforcement lands. */
    locked?: string[] | null;
  } | null;
  /** Billing rules (0481). The read returns every key resolved; a PATCH merges keys. */
  billing_rules_config?: BillingRulesPatch | null;
  /** Invoice rules (0486); keys left out keep their stored value. */
  invoice_rules_config?: Partial<InvoiceRulesConfig> | null;
  /** Backdating window (0242). null/absent → permissive resolver defaults. */
  backdating_config?: {
    enabled?: boolean;
    allowed_actions?: Array<"create" | "change" | "cancel" | "reactivate">;
    /** 1..10, or null for no restriction. */
    cutoff_day_of_month?: number | null;
    allow_past_invoice_date_on_create?: boolean;
    allow_past_invoice_date_on_change?: boolean;
  } | null;
  /** Reminder lead days (0376). A kind left out keeps its list; null resets every kind. */
  reminder_config?: Partial<ReminderConfig> | null;
  // 0243 sweep. `default_credit_note_on_void` and `prorate_fixed_amount_coupons` are
  // deliberately absent: their columns exist but neither is wired, so no screen offers
  // them. See the note in src/api/routes.ts.
  /** Positive polarity: true = validate. */
  vies_validation_enabled?: boolean;
  /** Chargeback policy (0244). The invoice action is LOST-only and documentary. */
  chargeback_config?: {
    on_lost_invoice?: "credit_note" | "no_action";
    on_initiated_subscription?: ChargebackSubscriptionAction;
    on_lost_subscription?: ChargebackSubscriptionAction;
    cascade_to_other_subscriptions?: boolean;
    stop_collecting_all?: boolean;
  } | null;
  /**
   * Checkout field matrix (0245). Keys are `<section>.<field>`; three states only.
   * Making `billing.postal_code` mandatory is the AVS/ZIP-verification control.
   */
  checkout_field_config?: Partial<Record<CheckoutFieldKey, CheckoutFieldState>> | null;
  /** Portal billing-form matrix. `billing.country` refuses `hide`. */
  portal_field_config?: Partial<Record<PortalFieldKey, PortalFieldState>> | null;
  /** What the checkout and portal do. */
  storefront_config?: {
    hide_zero_value_lines?: boolean;
    collect_po_number?: boolean;
    /** Fallback for the checkout mint, which requires these per call today. */
    default_return_url?: string | null;
    default_cancel_url?: string | null;
    /** Portal self-service permissions (2026-09-09). All three default TRUE. */
    allow_invoice_download?: boolean;
    allow_invoice_payment?: boolean;
    allow_remove_payment_method?: boolean;
    /** Buyer-initiated cancellation. Defaults OFF and `end_of_term`. */
    allow_cancel_subscription?: boolean;
    cancel_timing?: "immediately" | "end_of_term";
    allow_pause_resume?: boolean;
    allow_reactivate?: boolean;
    /** Buyer may skip an upcoming renewal. Default OFF. */
    allow_skip_renewal?: boolean;
    /** Most renewals a buyer may skip in 12 months, 1–12. Default 3. Operators are not capped. */
    skip_renewal_limit?: number;
    /** Rich text the portal shows when a link can't be used; null = default copy. */
    portal_link_error_html?: string | null;
    /** One-time purchases: keep the buyer's payment method. Default `ask`. */
    one_time_save_payment_method?: "never" | "always" | "ask";
    /** Portal usage view on metered subscriptions. Default TRUE. */
    portal_show_usage?: boolean;
    /** Portal projected usage. Default FALSE. */
    portal_show_usage_projection?: boolean;
    /** Hosted checkout layout. Default `steps`; new businesses `one_page`. */
    checkout_layout?: "steps" | "one_page";
    /** Apple Pay / Google Pay above the form. Default FALSE. */
    wallets_first?: boolean;
    /** Buyer agrees to the recurring charge. Default FALSE. */
    recurring_consent?: boolean;
    /** Buyer accepts the terms; needs `terms_url`. Default FALSE. */
    require_terms?: boolean;
    terms_url?: string | null;
    privacy_url?: string | null;
    /** Optional marketing opt-in at checkout. Default FALSE. */
    marketing_consent?: boolean;
    /** Bot check after N failed payments per IP in 24 h; null = off. */
    bot_check_after_failures?: number | null;
    /** Portal plan changes (Phase 2); which plans show is each product's enabled_in_portal. */
    allow_plan_changes?: boolean;
    seat_changes?: "off" | "increase" | "both";
    seat_min?: number | null;
    seat_max?: number | null;
    allow_addon_changes?: boolean;
    shorter_period?: "always" | "never" | "after_12_months";
    charge_upgrade?: "business_default" | "now" | "next_invoice";
    change_statuses?: Array<"active" | "in_trial" | "paused">;
    allow_cancel_scheduled_change?: boolean;
    /** Portal cancel flow (Phase 3). Unset = an optional reason, no offers. */
    cancel_reason?: "off" | "optional" | "required";
    retention_pause?: boolean;
    retention_pause_months?: number | null;
    retention_pause_choice?: boolean;
    retention_downgrade_price?: string | null;
    retention_coupon?: string | null;
    retention_contact_url?: string | null;
    retention_offer_once?: boolean;
    portal_email_code?: boolean;
    portal_link_hours?: number | null;
    portal_email_link_days?: number | null;
    portal_session_hours?: number | null;
    portal_hide_cancelled_subscriptions?: boolean;
    portal_hide_zero_invoices?: boolean;
    portal_hide_voided_invoices?: boolean;
    portal_actions?: {
      pay_invoice?: boolean;
      update_card?: boolean;
      change_plan?: boolean;
      cancel?: boolean;
    };
    portal_return_url?: string | null;
  } | null;
  // Term anchoring: exact instant vs whole calendar days.
  anchor_granularity?: "instant" | "day";
  proration_granularity?: "exact" | "whole_day";
  // Default price type new prices inherit.
  default_tax_behavior?: "exclusive" | "inclusive";
  // Tax settings (0489): price type per currency, seller tax ID per destination, rounding.
  tax_behavior_by_currency?: Record<string, "inclusive" | "exclusive"> | null;
  seller_tax_ids?: Record<string, string> | null;
  tax_rounding?: "per_invoice_total" | "per_line";
  // Customer-facing billing emails. Opt-in — null/absent sends nothing.
  email_config?: {
    enabled: boolean;
    fromName?: string | null;
    /** Envelope From; null falls back to the deployment-wide MAIL_FROM. */
    fromAddress?: string | null;
    /** Null sends NO Reply-To header — there is no fallback to the support email. */
    replyTo?: string | null;
    /** Copied on every send. `cc` is visible to the customer; `bcc` is not. Max 10 each. */
    cc?: string[] | null;
    bcc?: string[] | null;
    /** Prepended to every subject at send time, e.g. "[Acme]". */
    subjectPrefix?: string | null;
    /**
     * The merchant's sign-off, rendered under the button on every email.
     * Plain text, max 300 — the resolver truncates past that.
     */
    footerNote?: string | null;
    /**
     * Per-email attachment rules, keyed by email type. An absent type attaches the PDF and
     * skips nothing — render it as ON.
     */
    attachments?: Record<string, { pdf: boolean; skipZeroPdf: boolean; skipZeroSend: boolean }>;
    types?: Record<string, boolean>;
    /** Attach the numbered receipt PDF to the payment confirmation email. */
    attachReceiptPdf?: boolean;
    /** Where email links go; `merchant_url` needs `merchantUrl`. */
    linkTarget?: "portal" | "merchant_url";
    merchantUrl?: string | null;
  } | null;
  // Team alerts (0489). Replaces the stored value; null turns every alert off.
  team_alerts_config?: TeamAlertsConfig | null;
  // Document customization (0239). Shape mirrors Business['invoice_customization'].
  invoice_customization?: NonNullable<Business["invoice_customization"]> | null;
  /**
   * Optimistic-concurrency guard. Sent when we have a serialized
   * resource_version; the backend currently ignores unknown keys (no OCC on
   * this route yet) but a future 409 is handled by the settings actions.
   */
  expected_version?: number;
}

/** PATCH business settings. Returns apiWrite's { ok, status, error?, data? }. */
export const updateBusiness = (biz: string, patch: BusinessSettingsPatch) =>
  apiPatch(`/v1/businesses/${biz}`, patch);

/** Team alert addresses and their confirmation state (0495). */
export const listTeamAlertRecipients = (biz: string) =>
  apiGet<{ data: TeamAlertRecipient[] }>(`/v1/businesses/${biz}/team_alert_recipients`);

/** Send the confirmation email to a pending address again. */
export const resendTeamAlertConfirmation = (biz: string, email: string) =>
  apiPost(`/v1/businesses/${biz}/team_alert_recipients/resend`, { email });
