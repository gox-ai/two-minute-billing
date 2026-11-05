// Server-only API client for the tmbilling REST API. Authenticates as the SIGNED-IN
// OPERATOR by forwarding their session cookie (0198) — there is no API key here any
// more, and no shared secret in dashboard env. Never imported into client components:
// the session cookie is HttpOnly and must not be readable from page script.
//
// See `authHeaders` below for what the key used to do and why removing it was a fix
// rather than a simplification.

import type { AllowanceReset } from "./reset";
import type { BillingRulesConfig, PaymentApplication } from "@/lib/billing-rules";

/** The dunning end action for the subscription (2.17). */
export type FinalSubscriptionAction =
  | "cancel"
  | "cancel_at_term_end"
  | "pause"
  | "stop_charging"
  | "retain";
import { cookies } from "next/headers";

import { forwardedFor } from "./forwarded-for";
import { allows, currentUser } from "./session";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

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
/** Per-field state on the portal's billing form: the checkout states plus `read_only`. */
export type PortalFieldState = "show" | "hide" | "mandatory" | "read_only";
/** The fields the portal's billing form collects. */
export type PortalFieldKey =
  | "customer.first_name"
  | "customer.last_name"
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
  | "billing.country";
/** Address fields that tax setup forces to `mandatory` on both surfaces. */
export interface AddressFieldLocks {
  /** Any tax region exists. */
  country: boolean;
  /** A GST tax region exists. */
  state_code: boolean;
}

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

/** The reminder kinds whose lead days a business sets (0376). */
export type ReminderKind = "trial_ending" | "renewal" | "renewal_yearly" | "cancellation";
/** Days before the date, 1–90, at most 5 per kind. */
export type ReminderLeadDays = Record<ReminderKind, number[]>;
/** Kinds that can be Off: `[]` = Off. At most 3 lead days. */
export type OptionalReminderKind = "payment_due" | "pause" | "resume";
/** Card expiry notice: in the expiry month, or up to 3 lead days before the card expires. */
export type CardExpiringTiming = "expiry_month" | number[];
/** The whole resolved `reminder_config`, as the business returns it. */
export type ReminderConfig = ReminderLeadDays &
  Record<OptionalReminderKind, number[]> & { card_expiring: CardExpiringTiming };

export interface Organization {
  id: string;
  name: string;
  /**
   * Display timezone for ORG-SCOPED screens — `/audit`, `/developer` — which span
   * every business in the account and so have no single business zone to render in
   * (`components/business-tz.tsx`). Null means UTC, the constant those screens used before
   * this setting existed.
   *
   * Never a billing input: term boundaries and proration key off `Business.timezone`.
   */
  timezone: string | null;
  /**
   * The REGISTERED entity, printed on invoices a business issues under the organization
   * (`Business.invoice_issuer === 'organization'`). Several businesses billing under one
   * company is the common Indian shape: the GSTIN belongs to the entity, and a buyer
   * claiming input tax credit needs the invoice to name it.
   *
   * `legal_name` is separate from `name`: `name` is what the account is called in this
   * UI, the legal name is what a tax document must say. Null falls back to `name`.
   */
  legal_name?: string | null;
  address?: Record<string, string | null | undefined> | null;
  tax_registration_number?: string | null;
  /**
   * Which currency analytics opens on (0268). Converts nothing and makes nothing summable
   * — it only chooses which currency's figure is shown first when a book spans several.
   * Null is a real state: "not chosen", and analytics then refuses and names the options.
   */
  base_currency?: string | null;
  /** Square logo shown in the sidebar at organization level (0322). Null = the product mark. */
  icon_url?: string | null;
}
export interface BusinessAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
}
/** One credit kind's two invoice-class slots — see `credits_flexibility` on Business. */
export interface CreditsFlexibilitySlots {
  recurring?: CreditsFlexibilitySlot;
  one_time?: CreditsFlexibilitySlot;
}
export interface CreditsFlexibilitySlot {
  mode: "auto" | "none" | "limit";
  limit_minor?: number | null;
}

/**
 * One currency's reporting rate and where it came from (engine 0229).
 *
 * `rate` is a STRING because the column is exact `numeric(20,10)` — parsing it into a
 * number to display it is how `94.9537410000` becomes `94.95374099999999`.
 */
export interface CurrencyRate {
  currency: string;
  rate: string | null;
  source: "manual" | "auto";
  /** When the rate we HOLD was published by its source — not when we last checked. */
  updated_at: string | null;
  provider: string | null;
  /** Why this currency's last auto refresh failed; the previous rate still stands. */
  last_error: string | null;
}

/** Staff mail settings (0489). Mirrors `serializeTeamAlertsConfig` in team-alerts/config.ts. */
export interface TeamAlertsConfig {
  recipients: string[];
  overdue: { enabled: boolean; thresholds: Record<string, number> };
  webhook_failures: { enabled: boolean };
  daily_digest: { enabled: boolean };
  /** At the time of a free credit grant above `credit_config.grant_limits` (0495). */
  large_grants?: { enabled: boolean };
}

/** A team alert address and whether it gets alerts (0495). */
export interface TeamAlertRecipient {
  email: string;
  state: "member" | "confirmed" | "pending";
  last_sent_at: string | null;
}

export interface Business {
  id: string;
  name: string;
  livemode: "live" | "test";
  /** On a test business: its live mode. Null on live and on standalone test businesses. */
  live_business_id?: string | null;
  /** On a live business: its test mode. Null until test mode is first opened. */
  test_business_id?: string | null;
  default_currency: string | null;
  currencies?: string[] | null;
  exchange_rates?: Record<string, number> | null;
  /** The same rates WITH provenance — prefer this over `exchange_rates` for display. */
  currency_rates?: CurrencyRate[] | null;
  billing_frequencies?: Array<{
    interval: "day" | "week" | "month" | "year";
    count: number;
  }> | null;
  provider_config?: unknown;
  status: string;
  address?: BusinessAddress | null;
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
  /** 0495: coupon codes a buyer can enter on one checkout or subscription (1–10). */
  max_customer_coupon_codes?: number;
  timezone?: string | null;
  /** Reporting calendar (0293): where analytics cuts weeks, quarters and years. */
  week_start?: "sunday" | "monday";
  /** 1–12; 1 is the calendar year. */
  fiscal_year_start_month?: number;
  tax_registration_number?: string | null;
  /**
   * Whose identity heads this business's invoices: 'business' (default) or
   * 'organization'. The seller block follows it; brand and contact do not.
   */
  invoice_issuer?: "business" | "organization";
  /** Default HSN/SAC for this business's supplies (India GST); products may override it. */
  default_tax_code?: string | null;
  invoice_prefix?: string;
  invoice_next_number?: number;
  default_invoice_notes?: string | null;
  default_due_days?: number | null;
  /** Extra minutes (0–24) before a period's usage closes, for apps that buffer events (0454). */
  usage_close_delay_minutes?: number;
  // Credits Flexibility (0219) — whether refundable credits and excess payments
  // auto-apply, per credit kind × invoice class. An absent slot (or a null config)
  // means auto-apply, unlimited: the engine's default, and what every business had
  // before the setting existed. `limit_minor` is integer minor units.
  credits_flexibility?: {
    refundable?: CreditsFlexibilitySlots;
    excess?: CreditsFlexibilitySlots;
  } | null;
  dunning_retry_days?: number[] | null;
  // Dunning structured config (supersedes dunning_retry_days when set). Every
  // member is optional: the API accepts partial configs, so a stored config may
  // carry only the toggles the merchant changed.
  dunning_config?: {
    retries?: Array<{ after_days: number }>;
    final_action?: {
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
     * Whether a reactivation whose charge FAILS is refused, leaving the subscription
     * cancelled. Split out of the field above on 2026-09-07; ABSENT means it inherits
     * that field's value, so a business configured before the split is unaffected —
     * which is why a screen must resolve it rather than defaulting it to true.
     */
    require_successful_charge_on_reactivation?: boolean;
    // A hard decline ends dunning immediately (default on).
    skip_retries_for_hard_failures?: boolean;
    // Master dunning switch (default on).
    enabled?: boolean;
    // Days after the due date at whose end the final action applies (null = none).
    dunning_period_days?: number | null;
    dun_trial_and_future_subscriptions?: boolean;
    dun_one_time_invoices?: boolean;
    // Dun auto-collect-off (send-invoice) invoices, so an unpaid one reaches the
    // final action instead of sitting not_paid forever.
    // Needs dunning_period_days — offline invoices have no retries to end a window.
    dun_offline_invoices?: boolean;
    // Dunning mode; absent reads as `fixed`. See the note in lib/api/business-settings.ts:
    // a writer that omits it silently downgrades a smart business.
    mode?: "fixed" | "smart";
    // `cancel`: a renewal with no payment method at all cancels, even under `retain`.
    no_payment_method_at_renewal?: "follow_final_action" | "cancel";
    // Smart mode only: retry timing by decline class instead of the offsets. Absent = off.
    adaptive_timing?: boolean;
    park_hard_declines?: boolean;
    // Currency code → minimum amount due, in minor units, before dunning chases an invoice.
    minimum_amounts?: Record<string, number>;
  } | null;
  // Invoice behaviour
  create_pending_invoices?: boolean;
  auto_close_pending_after_days?: number | null;
  invoice_rounding?: "none" | "nearest_unit";
  /** Card limit per currency, minor units (0482). Null = no limit. */
  card_payment_limits?: Record<string, number> | null;
  // Credit notes
  credit_note_prefix?: string;
  credit_note_next_number?: number;
  // Receipts (0387): the prefix is settable, the counter is not (receipts are batch-numbered).
  receipt_prefix?: string;
  receipt_next_number?: number;
  // Billing-rule defaults
  default_prorate_on_change?: boolean;
  default_invoice_immediately?: boolean;
  default_cancel_option?: "immediately" | "end_of_term";
  default_credit_option_for_cancel?: "prorate" | "full" | "none";
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
    /** Keys a dashboard or API pause/resume cannot override (enforced by the engine routes). */
    locked?: string[] | null;
  } | null;
  /** Billing rules (0481). The read returns every key resolved; a PATCH merges keys. */
  billing_rules_config?:
    | (BillingRulesConfig & {
        /** Payment application (2.51, 2.66, 2.69), resolved. */
        payment_application?: PaymentApplication;
      })
    | null;
  /** Invoice rules (0486). The read returns every key resolved; a PATCH merges keys. */
  invoice_rules_config?: InvoiceRulesConfig | null;
  /** Mandate sizing (resolveMandateHeadroomConfig). Absent keys use the platform defaults. */
  mandate_config?: { headroom_bps?: number; rail_ceiling_cap_minor?: number } | null;
  /** Invoices print their subscription's PO number (0246). Pre-0246 businesses are false. */
  inherit_subscription_po_number?: boolean;
  /** Backdating window (0242). null/absent → permissive resolver defaults. */
  backdating_config?: {
    enabled?: boolean;
    allowed_actions?: Array<"create" | "change" | "cancel" | "reactivate">;
    /** 1..10, or null for no restriction. */
    cutoff_day_of_month?: number | null;
    allow_past_invoice_date_on_create?: boolean;
    allow_past_invoice_date_on_change?: boolean;
  } | null;
  /** Reminder lead days per kind (0376), resolved: always every kind, largest first. */
  reminder_config?: ReminderConfig;
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
  /** Portal billing-form matrix, resolved: every key present. */
  portal_field_config?: Partial<Record<PortalFieldKey, PortalFieldState>> | null;
  /** Fields tax setup keeps required; their pickers render locked. */
  address_field_locks?: AddressFieldLocks | null;
  /** What the checkout and portal do. */
  storefront_config?: {
    hide_zero_value_lines?: boolean;
    collect_po_number?: boolean;
    /** Fallback for the checkout mint, which requires these per call today. */
    default_return_url?: string | null;
    default_cancel_url?: string | null;
    /**
     * Portal self-service permissions (2026-09-09). All three default TRUE, so read them
     * as `!== false` — `=== true` would render an unconfigured business as "off" while the
     * engine treats it as on.
     */
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
  // Term anchoring.
  anchor_granularity?: "instant" | "day";
  proration_granularity?: "exact" | "whole_day";
  // Default price type new prices inherit.
  default_tax_behavior?: "exclusive" | "inclusive";
  // Tax settings (0489): price type per currency, seller tax ID per destination, rounding.
  tax_behavior_by_currency?: Record<string, "inclusive" | "exclusive"> | null;
  seller_tax_ids?: Record<string, string> | null;
  tax_rounding?: "per_invoice_total" | "per_line";
  // Customer-facing billing emails; null/absent = disabled (opt-in).
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
    /** The merchant's sign-off, under the button on every email. Plain text, max 300. */
    footerNote?: string | null;
    /**
     * Per-email attachment rules, keyed by email type. An absent type attaches the PDF and
     * skips nothing — render it as ON.
     */
    attachments?: Record<string, { pdf: boolean; skipZeroPdf: boolean; skipZeroSend: boolean }>;
    types?: Record<string, boolean>;
    /** Attach the numbered receipt PDF to the payment confirmation email. Off unless true. */
    attachReceiptPdf?: boolean;
    /** Where email links go. Absent = the hosted portal. */
    linkTarget?: "portal" | "merchant_url";
    /** The merchant's page for email links (http/https). */
    merchantUrl?: string | null;
  } | null;
  /** Team alerts (0489), resolved: every key present, all off when unset. */
  team_alerts_config?: TeamAlertsConfig;
  /**
   * What the printed invoice / credit note SHOWS (0239). Governs the DOCUMENT only —
   * hiding the customer id here does NOT remove `customer_id` from this resource.
   *
   * Every key is optional and absence is meaningful: the engine's resolver
   * (`resolveInvoiceCustomization`) maps an absent key to the pre-0239 rendering, so a
   * screen must render an unset value as its DOCUMENTED default, not as `false`. Half
   * these flags default to true.
   */
  invoice_customization?: {
    common?: {
      address_format?: "expanded" | "single_line" | "custom";
      custom_address?: string | null;
      /** Defaults TRUE when absent. */
      show_customer_id?: boolean;
      /** Defaults TRUE when absent. */
      show_subscription_id?: boolean;
      /** Billing address + the customer's tax id. Defaults TRUE when absent. */
      show_customer_info?: boolean;
      /** Defaults FALSE — never printed before 0239. */
      show_shipping_info?: boolean;
      /** The Payments/Refunds footer. Defaults TRUE when absent. */
      show_payment_stub?: boolean;
      show_exchange_rate?: boolean;
    };
    signature?: {
      /** A URL, like logo_url — there is no upload path. PNG/JPEG/SVG. */
      image_url?: string | null;
      /** Plain text, max 500. */
      caption?: string | null;
      /** Which bottom corner of the page it is pinned to. Defaults to bottom_right. */
      position?: "bottom_right" | "bottom_left";
    };
    payment_instructions?: {
      mode?: "all" | "preferred_offline";
      /** Honour each instruction's currency/country targeting. Defaults FALSE. */
      personalize?: boolean;
    };
    invoice?: {
      title?: "invoice" | "tax_invoice";
      show_status?: boolean;
      show_billing_period?: boolean;
      show_next_billing?: boolean;
      /** Defaults FALSE — never printed before 0239. */
      show_credit_note_number?: boolean;
      /** 0243. True prints them — today's behaviour. */
      show_zero_value_lines?: boolean;
      /** Defaults FALSE — never printed before 0239. */
      show_custom_fields?: boolean;
      numbering?: DocumentNumbering;
    };
    credit_note?: {
      title?: "credit_note" | "refund";
      show_status?: boolean;
      show_service_period?: boolean;
      /**
       * 0243. WHICH dates the period IS, not whether it prints (`show_service_period` is
       * the printing flag). Default `invoice_line_dates` is today's behaviour.
       */
      service_period_basis?: "invoice_line_dates" | "credit_note_date";
      show_invoice_date?: boolean;
      /** Business-wide note; prints BELOW the per-note reason, never instead of it. */
      notes?: string | null;
      numbering?: DocumentNumbering;
    };
    /** Receipt numbering format (0387); defaults as credit notes. */
    receipt?: {
      numbering?: DocumentNumbering;
    };
  } | null;
  updated_at?: string;
  resource_version?: number;
}

/**
 * The FORMAT half of document numbering: `<prefix><sep1><dynamic><sep2><counter>`.
 * The prefix and counter are their own top-level fields (`invoice_prefix` /
 * `invoice_next_number`) because they are written on the billing path.
 *
 * There is deliberately no periodic reset — `invoices_business_number_uq` makes numbers
 * unique per business, so a resetting counter would fail an invoice INSERT.
 */
export interface DocumentNumbering {
  dynamic_prefix?:
    | "none"
    | "yyyy"
    | "fy"
    | "mmyyyy"
    | "mm-yyyy"
    | "yyyymm"
    | "yyyy-mm"
    | "ddmmyyyy"
    | "dd-mm-yyyy"
    | "yyyymmdd"
    | "yyyy-mm-dd"
    | "mmddyyyy"
    | "mm-dd-yyyy";
  separator1?: "none" | "hyphen";
  separator2?: "none" | "hyphen";
  increment?: number;
  /** 1-12. Defaults to 1 (calendar year); India would set 4. Only used by `fy`. */
  fiscal_year_start_month?: number;
}

export interface CustomerAddress {
  line1: string | null;
  line2: string | null;
  line3?: string | null;
  city: string | null;
  state: string | null;
  state_code?: string | null;
  postal_code: string | null;
  country: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  phone?: string | null;
}
export interface CustomerBalance {
  currency_code: string;
  promotional_credits: number;
  refundable_credits: number;
  excess_payments: number;
}
export interface Customer {
  id: string;
  email: string | null;
  name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  phone?: string | null;
  currency?: string | null;
  /** DERIVED read-only: explicit `currency`, else the live subscriptions' currency. Use this, not `currency`, for money defaults. */ effective_currency?:
    | string
    | null;
  /** Cash collected, net of refunds, per currency (detail GET only). */
  lifetime_revenue?: Array<{
    currency: string;
    amount_minor: number;
    paid_invoices_count: number;
    first_paid_at: string | null;
  }>;
  locale?: string | null;
  auto_collection?: "on" | "off";
  net_term_days?: number;
  invoice_notes?: string | null;
  address?: CustomerAddress | null;
  /** Normalized server-side to the canonical address shape (`zip` folded into `postal_code`); null when unset. */ shipping_address?: CustomerAddress | null;
  tax_exempt?: boolean;
  /** false = no automatic billing emails to this customer. */
  email_notifications?: boolean;
  /** true = dunning makes no retries or reminders for this customer. */
  dunning_excluded?: boolean;
  /** Internal or test account: left out of every metric (0482). */
  exclude_from_reporting?: boolean;
  /** Copies of the customer's invoice, receipt and credit note emails (0486). */
  billing_cc_emails?: string[];
  billing_bcc_emails?: string[];
  /** `dpol_…` — the named dunning policy; null = the business's own dunning settings. */
  dunning_policy?: string | null;
  vat_number?: string | null;
  vat_number_status?: string | null;
  vat_validated_at?: string | null;
  withholding_rate_bps?: number;
  /** Region-gated tax treatment; 'default' resolves from place of supply. */ tax_treatment?: TaxTreatment;
  /** 0489: null = each price decides; set = every taxed line is inclusive or exclusive. */
  tax_behavior?: "inclusive" | "exclusive" | null;
  /** The customer's OWN registration number (GSTIN for India). */ tax_registration_number?:
    | string
    | null;
  metadata?: Record<string, unknown> | null;
  custom_fields?: Record<string, unknown> | null;
  active?: boolean;
  billing_date?: number | null;
  billing_date_mode?: string | null;
  pii_cleared?: boolean;
  created_at?: string;
  updated_at?: string;
  resource_version?: number;
  mrr?: Record<string, number>;
  balances?: CustomerBalance[];
  primary_payment_source_id?: string | null;
  backup_payment_source_id?: string | null;
}
/** One entry in a customer's shipping address book. */
export interface ShippingAddress extends CustomerAddress {
  object?: "shipping_address";
  id: string;
  customer_id?: string;
  label: string | null;
  is_default: boolean;
  archived: boolean;
  archived_at: string | null;
  created_at?: string;
  updated_at?: string;
}
export interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  label: string | null;
  enabled: boolean;
  send_account_email: boolean;
  send_billing_email: boolean;
  created_at?: string;
}
export interface Product {
  id: string;
  name: string;
  external_name?: string | null;
  description?: string | null;
  kind?: string;
  code?: string | null;
  product_group?: string;
  unit_of_measure?: string | null;
  /** HSN/SAC classification (India GST); null falls back to the business default_tax_code. */ tax_code?:
    | string
    | null;
  metered?: boolean;
  enabled_for_checkout?: boolean;
  enabled_in_portal?: boolean;
  redirect_url?: string | null;
  /** The buyer-facing picture (0347); set through `/api/product-image`. */
  image_url?: string | null;
  addon_applies_to_all?: boolean;
  metadata?: Record<string, unknown> | null;
  active: boolean;
  created_at?: string;
  updated_at?: string;
  resource_version?: number;
}
export type Applicability = "mandatory" | "recommended" | "optional";
export type ChargeOnEvent = "subscription_creation" | "trial_start" | "activation" | "on_demand";
export interface AttachedItemConfig {
  applicability: Applicability;
  chargeOnEvent: ChargeOnEvent;
  chargeOnce: boolean;
  defaultQuantity: number;
  billingCycles: number | null;
  /** Portal-only limits; staff may set any quantity. */
  minQuantity: number | null;
  maxQuantity: number | null;
  quantityStep: number;
  customerCanChangeQuantity: boolean;
}
export interface ApplicablePlans {
  item: string; // the attached add-on or charge
  applies_to_all: boolean;
  plans: string[];
  applicability: Record<string, Applicability>;
  config?: Record<string, AttachedItemConfig>;
}
export interface DifferentialPrice {
  id: string;
  plan: string;
  currency: string;
  interval: string | null;
  amountMinor: number | null;
  tiers?: Array<{
    upToMinor: number | null;
    unitAmountMinor?: number;
    flatAmountMinor?: number;
  }> | null;
}
export interface ProductGroup {
  id: string;
  name: string;
  code?: string | null;
  description?: string | null;
  active: boolean;
  created_at?: string;
}
export interface Tier {
  /** A quantity; a money amount (minor units) on a graduated_percentage price. */
  upToMinor: number | null;
  unitAmountMinor?: number;
  flatAmountMinor?: number;
  /** graduated_percentage only: the rate inside the tier, in basis points. */
  rateBps?: number;
}
/** One row of a meter price's rate card. `match` names a subset of the meter's group_by. */
export interface PriceRate {
  match: Record<string, string>;
  unit_amount_decimal: string | null;
  /** List-source prices: a markup over the price's markup base, in place of a fixed rate. */
  markup_percent?: string | null;
  tiers?: unknown[] | null;
}
export interface Price {
  id: string;
  product: string;
  name?: string | null;
  model: string;
  type: string;
  currency: string;
  amount_minor: number | null;
  interval: string | null;
  active?: boolean;
  interval_count?: number;
  usage_aggregation?: string | null;
  /** The measured level carries into later periods. */
  usage_recurring?: boolean;
  /** weighted_sum unit: hour | day. */
  usage_time_unit?: string | null;
  /** Read-only: the price bills measured usage, not a fixed quantity. */
  metered?: boolean;
  /** Meter prices (0453): the meter key this price bills from. Fixed after create. */
  meter?: string | null;
  /** Minor units per `quantity_divisor` units, up to 12 decimal places. */
  unit_amount_decimal?: string | null;
  quantity_divisor?: number | string | null;
  /** rate | event_amount | event_cost | model_price_list | event_cost_or_list. */
  amount_source?: string | null;
  /** event_cost and the two list sources, a decimal string. */
  markup_percent?: string | null;
  /** List sources: what the markup applies to. Null reads as `list`. */
  markup_base?: "list" | "cost" | null;
  /** The rate card: a rate for each combination of the meter's group values. */
  rates?: PriceRate[] | null;
  tiers?: Tier[] | null;
  package_size?: number | null;
  free_units?: number | null;
  percentage_bps?: number | null;
  /** Minimum spend for one billing period (recurring prices). */
  minimum_amount_minor?: number | null;
  bill_usage_monthly?: boolean;
  commitment_amount_minor?: number | null;
  /** Portal-only seat limits of a per-unit plan price; null = the business's. */
  portal_min_quantity?: number | null;
  portal_max_quantity?: number | null;
  external_name?: string | null;
  description?: string | null;
  trial_period?: number | null;
  trial_period_unit?: string | null;
  trial_end_action?: string | null;
  billing_cycles?: number | null;
  free_quantity?: number | null;
  is_taxable?: boolean;
  tax_behavior?: string;
  invoice_notes?: string | null;
  show_description_in_invoices?: boolean;
  /** Stored and returned, but nothing renders a quote yet. */
  show_description_in_quotes?: boolean;
  /** HSN/SAC for THIS price — overrides the product's, which falls back to the business default. */
  tax_code?: string | null;
  /** SKU / accounting detail. Descriptive only: the engine reads none of them. */
  sku?: string | null;
  accounting_code?: string | null;
  accounting_category_code?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
  resource_version?: number;
}
export interface SubscriptionItem {
  id?: string;
  price: string;
  quantity: number;
  price_model?: string;
  price_type?: string;
  interval: string | null;
  unit_price_minor?: number | null;
  unit_price_overridden?: boolean;
  /** List price this item departed from (set only when unit_price_overridden is true). */ catalog_amount_minor?:
    | number
    | null;
  product_name?: string;
  product_kind?: string;
  free_quantity?: number | null;
  billing_cycles?: number | null;
  /**
   * List-source items (design G1b § 3.4): this customer's selling price from the item's
   * price snapshot. Null = none; the catalog price's markup and rates apply.
   */
  selling_price?: { markup_percent: string | null; rates: PriceRate[] | null } | null;
}
export interface Discount {
  id: string;
  /** Discount source: 'coupon' (code set) or 'manual' (manual set, no coupon object). */
  source?: "coupon" | "manual";
  coupon: string | null;
  /** @deprecated alias of `coupon` kept for older call sites — prefer `coupon`. */
  code: string;
  manual?: {
    kind: "percentage" | "fixed_amount";
    percent_off_bps: number | null;
    amount_off_minor: number | null;
    currency: string | null;
    note: string | null;
  } | null;
  status: string;
  remaining_periods: number | null;
}
export interface Subscription {
  id: string;
  status: string;
  currency: string;
  customer?: string;
  customer_email?: string | null;
  customer_name?: string | null;
  /**
   * List-route only, like customer_email/customer_name above. They complete the
   * four-line Customer Info cell (name · company · email · phone) and come off the
   * joined customers row, so they cost no extra query — the projection simply never
   * selected them.
   */
  customer_company?: string | null;
  customer_phone?: string | null;
  /** NULLABLE, and the type has to say so. A trialling subscription reports no term —
   *  `serialize.ts` has returned null for both of these throughout a trial for a while, and
   *  since 2026-08-25 the columns are null in the database too. Typing them as plain
   *  `string` made every consumer look safe: `new Date(null).getTime()` is NaN, so a sort
   *  comparator silently scrambles instead of throwing, and `fmtDate(null)` renders
   *  "Invalid Date" on a customer's headline figure. Marking them nullable is what turns
   *  those into compile errors — the same lever used on the engine side. */
  current_period_start?: string | null;
  current_period_end: string | null;
  /** When the next invoice is raised. Answers this across ALL statuses — unlike
   *  current_period_end, which is null throughout a trial. See serialize.ts. */
  next_billing_at?: string | null;
  /** Metered usage is invoiced every month inside the billing period. */
  bill_usage_monthly?: boolean;
  current_sub_period_start?: string | null;
  current_sub_period_end?: string | null;
  /** Minimum commitment per billing period, or null. */
  commitment?: { amount_minor: number } | null;
  /** One period's recurring charge net of multi-period discounts, pre-tax. null when
   *  cancelled or cadences differ; absent from lifecycle responses. */
  recurring_amount_minor?: number | null;
  trial_end?: string | null;
  cancel_at_period_end?: boolean;
  canceled_at?: string | null;
  cancel_reason?: string | null;
  start_date?: string | null;
  started_at?: string | null;
  activated_at?: string | null;
  trial_start?: string | null;
  billing_period?: number | null;
  billing_period_unit?: string | null;
  remaining_billing_cycles?: number | null;
  /**
   * Per-subscription ceilings on automatic credit application, in MINOR units — the
   * subscription half of Billing rules → Credits Flexibility, which is otherwise a
   * business-wide setting. `null` = no subscription ceiling (the business setting alone
   * decides); `0` = never auto-apply to this subscription; `N` = up to N.
   *
   * The TIGHTER of the subscription and business ceilings applies, so this can only
   * narrow the business setting, never widen it (`creditApplicationLimits`).
   */
  max_refundable_credits_usage_minor?: number | null;
  max_excess_payment_usage_minor?: number | null;
  /**
   * Public id of the payment method THIS SUBSCRIPTION charges. Collection prefers
   * it over the customer's primary, so it — not the customer's card list — is what
   * the detail page must show. `null` = no override, so the customer's primary is
   * used; `undefined` = the endpoint didn't resolve it (only the detail route does).
   */
  default_payment_method?: string | null;
  auto_collection?: "on" | "off" | null;
  net_term_days?: number | null;
  po_number?: string | null;
  invoice_notes?: string | null;
  /** The subscription's own ship-to entry; null = the customer's default address. */
  shipping_address_id?: string | null;
  /** Where goods ship, resolved (the pick above, else the default); null when there is none. */
  shipping_address?: ShippingAddress | null;
  /** Free-form JSON on the subscription. Read-only for now: the PATCH route takes
   *  auto_collection / po_number / invoice_notes / custom_fields, but not this. */
  metadata?: Record<string, unknown> | null;
  /** Values keyed by the definition's `api_name`. */
  custom_fields?: Record<string, unknown> | null;
  mrr?: number | null;
  created_at?: string;
  updated_at?: string;
  resource_version?: number;
  items?: SubscriptionItem[];
  discount?: Discount | null;
  latest_invoice?: { id: string; status: string; total_minor: number };
}
export interface InvoiceLine {
  id: string;
  description: string;
  kind: string;
  quantity: number;
  unit_amount_minor: number;
  /**
   * The true quantity and rate (minor units), up to 12 decimal places. Read these: meter
   * lines carry their truth here only. Null on lines written before they existed.
   */
  quantity_decimal?: string | null;
  unit_amount_decimal?: string | null;
  /** GROSS, before any discount. */
  amount_minor: number;
  /** Discount attributed to this line, BOTH waterfall stages. */
  discount_minor?: number;
  /**
   * The part of `discount_minor` already INSIDE the invoice's `subtotal_minor`. This is the
   * one to show beside the line: the document-level remainder has its own totals row, and
   * displaying it per line as well would show the same money twice.
   */
  item_level_discount_minor?: number;
  /** What a credit note can still credit on this line, tax-inclusive (detail read only). */
  creditable_minor?: number;
  /** How a usage line was rated; null on other lines. */
  rating?: LineRating | null;
  /** Usage lines on an interim or final invoice: usage to date, and the part billed before. */
  cumulative_minor?: number | null;
  billed_before_minor?: number | null;
  /** Usage lines, `usage_margin:view` only: cost in the line's currency, fixed at rating. */
  cost_minor?: number | null;
  /** event | price_list | mixed | partial | none | no_rate */
  cost_basis?: string | null;
  price: string | null;
  period_start: string | null;
  period_end: string | null;
}
/** `lines[].rating`: the tier rows and level behind a usage line. */
export interface LineRating {
  model: string;
  aggregation: string;
  recurring: boolean;
  time_unit: string | null;
  quantity: number;
  free_quantity: number;
  billable_quantity: number;
  tiers: Array<{
    from: number;
    to: number | null;
    units: number;
    unit_amount_minor: number;
    flat_amount_minor: number;
    amount_minor: number;
  }>;
  level: { carried_in: number; closing: number; peak: number } | null;
  /** Meter lines (0454): the meter, the group values and the rate-card row used. */
  meter?: string;
  /** The meter's `group_by` properties, in order. */
  group_by?: string[] | null;
  /** The values of `group_by`, in the same order. */
  group?: string[] | null;
  rate_match?: Record<string, string> | "default" | null;
  quantity_divisor?: number | string | null;
  late_for?: { start: string; end: string } | null;
  /** Meter lines: where the unit price came from (`model_price_list`, `default_rate`, …). */
  price_source?: string | null;
  /** List-source lines (design G1b § 3.4): the dated prices this line used. */
  segments?: LineRatingSegment[] | null;
}
/** One price segment of a usage line: the rows it priced from, so anyone can check it. */
export interface LineRatingSegment {
  from: string;
  to: string;
  /** The selling rate, minor units per `quantity_divisor` units. */
  unit_amount_decimal: string;
  quantity_divisor?: string | number;
  markup_percent: string | null;
  markup_base: "list" | "cost" | null;
  /** The markup base's rate; null for a fixed or default rate, or a hidden cost base. */
  base_unit_amount_decimal?: string | null;
  rate_from: "subscription_override" | "price_rate" | "price";
  price_source?: "model_price_list" | "your_cost" | "fixed_rate" | "default_rate" | "reported_cost";
  /** The list row (`mpr_…`); `GET /v1/organization/model_prices/:id` returns it. */
  model_price_id: string | null;
  /** Only for callers with `usage_margin:view`. */
  model_cost_override_id?: string | null;
  source: string | null;
  source_version: string | null;
  source_effective_from: string | null;
}
/** One coupon's discount on one invoice, and which waterfall stage it belongs to. */
export interface InvoiceDiscount {
  label: string | null;
  /** item_level is already INSIDE subtotal_minor; document_level is applied TO it. */
  scope: "item_level" | "document_level";
  /**
   * coupon | manual | promotional_credits. `label` cannot answer this — a manual
   * discount is labelled "Discount" only because that is the engine's default invoice
   * name, and a coupon may carry the same string. Null on reads that did not load it.
   */
  source?: "coupon" | "manual" | "promotional_credits" | "credit_grants" | null;
  /** The coupon's own code, kept apart from `label` (which is `invoice_name ?? code`). */
  coupon_code?: string | null;
  /** Public ids of the lines this discount reduced — "applied on line item(s) #1". */
  line_item_ids?: string[];
  applied_coupon: string | null;
  amount_minor: number;
}
export interface Invoice {
  id: string;
  status: string;
  /** Detail read: all tax on the invoice, added and included (Σ `taxes`). */
  tax_minor?: number;
  /** usage_interim (threshold invoicing) | credit_purchase; null = an ordinary invoice. */
  purpose?: "usage_interim" | "credit_purchase" | null;
  currency: string;
  number?: string | null;
  /**
   * The FX rate in force when this invoice was FINALIZED (engine 0228): units of
   * `currency` per 1 unit of `exchange_rate_base`, as an exact decimal STRING.
   *
   * Absent/null on invoices raised before the field existed and wherever the business had
   * no rate for the currency — **which is not 1**. Display it, never arithmetic it into a
   * float.
   */
  exchange_rate?: string | null;
  exchange_rate_base?: string | null;
  /**
   * Line amounts LESS item-level discounts — NOT the
   * gross sum of the lines: a coupon scoped to a specific item price is already off this
   * number, while an invoice-amount coupon is not. See `splitInvoiceLines`.
   */
  subtotal_minor?: number;
  /** Discount already inside `subtotal_minor`. Single-invoice read only. */
  item_level_discount_minor?: number;
  /** Discount applied TO `subtotal_minor`, also present as a discount line. Single-invoice read only. */
  document_level_discount_minor?: number;
  /** Per-coupon breakdown, one entry per (coupon, stage). Single-invoice read only. */
  discounts?: InvoiceDiscount[];
  total_minor: number;
  amount_due_minor?: number | null;
  withholding_minor?: number;
  /** SNAPSHOT of the seller's state at issue — what decided CGST+SGST vs IGST. */
  seller_state_code?: string | null;
  /** SNAPSHOT of the customer's place of supply used for this invoice. */
  place_of_supply_code?: string | null;
  tax_treatment?: TaxTreatment | null;
  /** Reverse-charge / SEZ / export note to print. Null = nothing to print. */
  tax_note?: string | null;
  customer?: string;
  subscription?: string;
  period_start?: string | null;
  period_end?: string | null;
  attempt_count?: number;
  next_attempt_at?: string | null;
  paid_at?: string | null;
  imported?: boolean;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  lines?: InvoiceLine[];
}
// `reference_id` is the GATEWAY's reference for the instrument
// (`<gateway customer id>/<gateway token id>`), never our `pm_…` id — null when the
// gateway gave us no token to name, in which case the row must not be rendered.
// `gateway_account` is the `gwa_…` id, `gateway_account_label` its display name.
/**
 * The mandate a vaulted instrument was registered under, as the PROVIDER reports
 * it (RazorPay e-mandate/UPI Autopay/card). Null on a plain card-on-file.
 *
 * A null FIELD inside it means the provider did not report that one — unknown,
 * never unlimited. In particular a null `max_amount_minor` does not mean the
 * instrument can be debited for any amount; it means nobody can say.
 */
export interface PaymentMethodMandate {
  rail: string | null;
  status: string | null;
  max_amount_minor: number | null;
  currency: string | null;
  expires_at: string | null;
  reference: string | null;
}
/**
 * What the gateway knows about the instrument ITSELF — issuer, funding, capabilities.
 * Null when it reported none of it (a row vaulted before we started asking, or a
 * gateway that does not answer); `pnpm repair:pm-details` backfills those.
 *
 * A null field inside means that one fact is unknown. `issuer_country` in particular is
 * UNKNOWN when null, never "not India" — the engine's AFA rules read it that way, so a
 * screen must not print a conclusion it does not have.
 */
export interface PaymentMethodInstrument {
  /** `credit` | `debit` | `prepaid` | … as the gateway spells it. */
  funding: string | null;
  /** `consumer` | `business`, verbatim — the gateways disagree on spelling. */
  sub_type: string | null;
  /** Where the instrument was ISSUED (ISO-3166-1 alpha-2). */
  issuer_country: string | null;
  /** The issuing bank / PSP as the gateway names it. */
  issuer_name: string | null;
  /** Same underlying instrument across customers and accounts. Stripe only. */
  fingerprint: string | null;
  /** A usage CAPABILITY, not an origin — `issuer_country` is the origin. */
  supports_international: boolean | null;
  /** Can it be debited off-session at all. A mandate on one that cannot never collects. */
  supports_recurring: boolean | null;
  three_d_secure_supported: boolean | null;
}
export interface PaymentMethod {
  id: string;
  provider: string;
  type: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  status?: string;
  role?: "primary" | "backup" | "none" | null;
  is_default: boolean;
  gateway_account?: string | null;
  gateway_account_label?: string | null;
  reference_id?: string | null;
  mandate?: PaymentMethodMandate | null;
  instrument?: PaymentMethodInstrument | null;
  created_at: string;
  /**
   * What the gateway said about the address / CVC (0245), Stripe only. NULL means nothing
   * was captured — deliberately distinct from `"unchecked"`, which is a real verdict a
   * gateway can send. Same null-object shape as `mandate`.
   */
  avs_check?: {
    line1: string | null;
    postal_code: string | null;
    cvc: string | null;
    checked_at: string | null;
  } | null;
}
// `Wallet` / `getWallet` removed with the last dashboard caller. The backend
// `GET /v1/…/wallet` endpoint still exists; its balance is `promotional + excess`,
// which must not be shown as one figure — read `customer.balances` per bucket instead.
export interface Coupon {
  id: string;
  code: string;
  name?: string | null;
  kind: string;
  percent_off_bps: number | null;
  amount_off_minor: number | null;
  currency: string | null;
  duration_type: string;
  times_redeemed: number;
  max_redemptions: number | null;
  /** Redemptions allowed per customer; null = no cap. */
  max_redemptions_per_customer?: number | null;
  active: boolean;
}
/** `unredeemed_count` is counted server-side, NOT `total_count - redeemed_count` — archived codes are neither. */
export interface CouponSet {
  id: string;
  name: string;
  coupon: string;
  total_count: number;
  redeemed_count: number;
  archived_count: number;
  unredeemed_count: number;
  created_at?: string;
}
export interface CouponCode {
  code: string;
  status: string;
  redeemed_at?: string | null;
  /** Subscription the code was redeemed on; null until redeemed. */
  subscription?: string | null;
}
/**
 * ⚠ A NARROWER TWIN of `lib/api/credit-notes.ts`'s `CreditNote`, which declares the whole
 * serialized shape. Both are in use — the credit-notes screens import that one, the invoice
 * detail imports this — and the two must not disagree about what a field MEANS. Consolidating
 * them is worth doing and is not this change (see docs/PROGRESS.md).
 *
 * `kind` and `available_minor` were added 2026-08-31 because the invoice page needs to ask
 * "is there money left on this note to pay out". It had been asking `status === 'refund_due'`
 * instead, which is the note's BIRTH status and says nothing about a payout — and drove a
 * banner claiming a card refund had failed when none was ever attempted.
 *
 * Both really are on every list row, checked against `src/modules/credit-notes/serialize.ts`
 * before being declared here (`kind` at :52, `available_minor` at :78, and its own comment
 * argues for reporting the money fields on the LIST as well as the detail). A type that
 * over-declares what an endpoint returns is the same class of lie as a label that
 * over-claims — do not add a field here without reading the serializer.
 */
export interface CreditNote {
  id: string;
  number: string | null;
  invoice: string;
  invoice_number: string | null;
  /** `refundable` pays out; `adjustment` reduced an invoice and never can. */
  kind: string;
  credit_method: string;
  status: string;
  total_minor: number;
  /** `total − allocated − refunded` — what is actually left on the note. */
  available_minor: number;
  currency: string;
  reason: string | null;
  created_at: string;
  items: Array<{ id: string; description: string; amount_minor: number }>;
}
export interface TaxRateComponent {
  id: string;
  state_code: string | null;
  name: string;
  rate_bps: number;
  applies_to: "intra" | "inter" | "both";
  sort_order: number;
}
export interface TaxStateRegistration {
  id: string;
  state_code: string;
  state_name: string | null;
  registration_number: string | null;
}
export type TaxTreatment =
  | "default"
  | "sez_igst"
  | "sez_zero_rated"
  | "export_igst"
  | "export_zero_rated"
  | "reverse_charge";
export interface TaxProfile {
  id: string;
  name: string;
  is_default: boolean;
  active: boolean;
  created_at?: string;
}
export interface TaxRegion {
  id: string;
  tax_profile_id: string;
  country: string;
  regime: "gst" | "vat" | "sales_tax" | "flat";
  price_type: "exclusive" | "inclusive";
  home_state_code: string | null;
  registration_label: string | null;
  registration_number: string | null;
  collect_registration_number: boolean;
  reverse_charge_enabled: boolean;
  show_reverse_charge_note: boolean;
  reverse_charge_note: string | null;
  sez_igst_enabled: boolean;
  sez_igst_note: string | null;
  sez_zero_rated_enabled: boolean;
  sez_zero_rated_note: string | null;
  export_igst_enabled: boolean;
  export_igst_note: string | null;
  export_zero_rated_enabled: boolean;
  export_zero_rated_note: string | null;
  enabled: boolean;
  /** Derived server-side from the gates above — the customer form must offer exactly these. */
  allowed_tax_treatments: TaxTreatment[];
  components: TaxRateComponent[];
  state_registrations: TaxStateRegistration[];
  created_at?: string;
}
export interface ScheduledChange {
  id: string;
  type: string;
  effective_at: string;
  payload: unknown;
  status: string;
  applied_at: string | null;
  attempts: number;
  last_error: string | null;
  failed_at: string | null;
  created_at: string;
}
export interface UnbilledCharge {
  id: string;
  description: string;
  amount_minor: number;
  currency: string;
  status: string;
}
export interface Entitlement {
  feature_key: string;
  feature_name: string;
  type: string;
  unit: string | null;
  value: unknown;
  source: string;
}
export interface WebhookEndpoint {
  id: string;
  url: string;
  business: string | null;
  enabled: boolean;
  /**
   * The endpoint's NAME. `serializeEndpoint` has always returned it on the LIST route too, but
   * this type omitted it, so the list could not show what identifies an endpoint to a human — and
   * the compiler could not point that out. Nullable: an endpoint created before the create form
   * asked for a name has none, and the `whe_…` id is the correct fallback.
   */
  description: string | null;
  created_at: string;
}
export interface WebhookDelivery {
  id: string;
  event: string;
  event_type: string;
  status: string;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_response_status: number | null;
  /** The receiver's reply on the last failed attempt, clipped. */
  last_error?: string | null;
  created_at: string;
}
export interface ApiKey {
  id: string;
  /** What the key is for (0248). Null for keys minted before names existed. */
  name: string | null;
  prefix: string;
  livemode: string;
  scope: "read" | "write";
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  /** 0374: when the key stops working; null = never. Set at create or by a rotation. */
  expires_at: string | null;
  /** 0391: access per resource; null = by scope. */
  permissions?: Record<string, "read" | "write"> | null;
}
export interface Event {
  id: string;
  type: string;
  data: unknown;
  created_at: string;
}
// --- Business Home analytics (GET /v1/businesses/:biz/analytics) ---
export type AnalyticsRange = "daily" | "3m" | "6m" | "12m";
export interface AnalyticsPoint {
  t: string;
  label: string;
  v: number;
}
export interface AnalyticsHeadline {
  kind: "money" | "count" | "percent";
  value: number;
  prev_value: number | null;
  prev_label: string | null;
}
export interface AnalyticsSeries {
  key: string;
  label: string;
  kind: "money" | "count" | "percent";
  forward?: boolean;
  headline: AnalyticsHeadline;
  points: AnalyticsPoint[];
}
export interface AnalyticsDelta {
  value: number;
  prev_value: number;
  change_bps: number | null;
}
export interface AnalyticsPlanRow {
  plan: string;
  plan_id: string | null;
  count: number;
  pct_bps: number;
}
export interface BusinessAnalytics {
  as_of: string;
  range: AnalyticsRange;
  granularity: "day" | "week" | "month";
  currency: string;
  converted: boolean;
  available_currencies: string[];
  missing_rates: string[];
  kpis: {
    mrr: AnalyticsDelta;
    cmrr: { value: number };
    active_subscriptions: AnalyticsDelta;
    /** The paying subset: active subscriptions carrying MRR > 0, non-renewing included. */
    paying_subscriptions: AnalyticsDelta;
    /** Paying and set to renew: excludes one booked to stop at the end of its term. */
    renewing_subscriptions: AnalyticsDelta;
    /** Retention + MRR movement over the last complete calendar month. */
    retention: {
      window_label: string;
      starting_mrr_minor: number;
      new_mrr_minor: number;
      expansion_mrr_minor: number;
      reactivation_mrr_minor: number;
      contraction_mrr_minor: number;
      churn_mrr_minor: number;
      gross_retention_bps: number | null;
      net_retention_bps: number | null;
      quick_ratio_bps: number | null;
    };
    net_billing_minor: number;
    net_payments_minor: number;
    unpaid_invoices: { count: number; amount_minor: number };
    revenue_this_month: {
      expected_minor: number;
      received_minor: number;
      last_month_minor: number;
    };
    revenue_today: { expected_minor: number; received_minor: number; yesterday_minor: number };
    signups_this_month: { count: number; last_month: number };
    signups_today: { count: number; yesterday: number };
  };
  /**
   * List-filter values (local dates, business timezone) that reproduce each strip
   * window — what the KPI figures deep-link with, so the list they open on counts
   * the same rows the figure did. Never recompute these from the browser clock.
   */
  windows: {
    today: { on: string };
    yesterday: { on: string };
    this_month: { after: string; before: string };
    last_month: { after: string; before: string };
  };
  series: AnalyticsSeries[];
  subscriptions_by_plan: { total: number; rows: AnalyticsPlanRow[] };
  /** The retention window's MRR movement, per plan. Losses are positive magnitudes. */
  mrr_movement_by_plan: Array<{
    plan: string;
    plan_id: string | null;
    new_mrr_minor: number;
    expansion_mrr_minor: number;
    reactivation_mrr_minor: number;
    contraction_mrr_minor: number;
    churn_mrr_minor: number;
    /** Signed: what this plan added to, or took from, MRR over the window. */
    net_mrr_minor: number;
  }>;
}

interface List<T> {
  object: "list";
  data: T[];
}
/** A cursor-paginated list (`next_cursor` is opaque; `total` is first-page only). */
export interface PagedList<T> extends List<T> {
  has_more: boolean;
  next_cursor: string | null;
  total: number | null;
  /** `total` stopped at 10,000; more rows match. */
  total_capped?: boolean;
}

/**
 * Headers for a call to the engine: the signed-in operator's session, and nothing else.
 *
 * This used to also send a `kind='dashboard'` API key from server env, and THAT key —
 * not the session — is what told the engine which organization to serve. The session
 * was read only to put a name on the audit trail. So an operator who belonged to two
 * organizations could switch, watch the whole UI change, and still be reading and
 * writing the key's organization: `/auth/me` said org B, every `/v1/*` call answered
 * with org A's rows, status 200. Worse, a stale key in `.env.local` pointed the whole
 * dashboard at an organization the signed-in person wasn't even a member of.
 *
 * The session is now the credential (0198). The organization comes from the person, so
 * switching moves the data; the actor is exact by construction rather than best-effort;
 * and there is no shared secret sitting in dashboard env to rotate or leak.
 *
 * `cookies()` throws outside a request scope (module init, a build-time render). That
 * now means no credential at all, and the engine answers 401 — correct, and better than
 * the alternative: without a session there is no organization to serve, and the old
 * fallback quietly served the key's one.
 */
export async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  let session: string | undefined;
  try {
    session = (await cookies()).get("tmb_session")?.value;
  } catch {
    /* no request scope — the call will be refused, which is the honest outcome */
  }
  return {
    ...(session ? { cookie: `tmb_session=${session}` } : {}),
    // The caller's forwarded chain, untouched — without it the engine sees only our
    // loopback socket and stamps 127.0.0.1 on the audit row. See `lib/forwarded-for.ts`.
    ...(await forwardedFor()),
    ...(extra ?? {}),
  };
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`tmbilling API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Server-side write. `method` defaults to POST. Returns { ok, status, error?, data? }
 * so server actions can both surface failures and read the created resource (e.g. to
 * navigate to its detail page).
 */
export async function apiWrite(
  path: string,
  body: unknown,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  param?: string;
  data?: unknown;
  /** The engine's `Request-Id`, on a failure the signed-in person can open in the request log. */
  requestId?: string;
}> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: await authHeaders({
      "Content-Type": "application/json",
      // Per-call key so the engine can safely dedupe an in-flight retry of THIS
      // request. NOTE: it is unique per invocation, so it does NOT dedupe a
      // re-submitted form (that's a separate action call with a new key); guard
      // double-submits in the UI if needed.
      "Idempotency-Key": crypto.randomUUID(),
    }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (res.ok) return { ok: true, status: res.status, data: json };
  // A zod rejection puts the reasons in `details` (src/api/helpers.ts `badRequest`); fold
  // them in without the field keys, as checkout-api does, so the toast says what to fix.
  const payload = (
    json as
      | {
          error?: {
            message?: string;
            param?: string;
            details?: Record<string, string[] | undefined>;
          };
        }
      | undefined
  )?.error;
  const reasons = Object.values(payload?.details ?? {}).flatMap((m) => m ?? []);
  const error = reasons.length ? reasons.join("; ") : (payload?.message ?? res.statusText);
  // The request field the API refused, when it names one — so a form can show the error there.
  return {
    ok: false,
    status: res.status,
    error,
    param: payload?.param,
    requestId: await loggedRequestId(path, res),
  };
}

/**
 * The failed write's `Request-Id`, when it is in the request log and this person may read
 * it (`developer`). Only `/v1/*` is logged; other paths and other roles get no link.
 */
async function loggedRequestId(path: string, res: Response): Promise<string | undefined> {
  const id = res.headers.get("request-id");
  if (!id || !path.startsWith("/v1/")) return undefined;
  const user = await currentUser().catch(() => null);
  return user && allows(user, "api_logs:view", "developer") ? id : undefined;
}

/** Generic GET for domain-specific fetcher modules (dashboard/lib/api/<domain>.ts). */
export const apiGet = <T>(path: string) => api<T>(path);

/**
 * GET where 404 is an ABSENCE, not a failure — fetch-one routes whose id can go stale
 * (a drill-down opened from a list the reader loaded minutes ago).
 *
 * Only 404 is folded into `null`. Every other non-2xx still throws: a 500 rendering as
 * "not found" would tell the reader their row is gone when the API is simply broken.
 */
export async function apiGetOrNull<T>(path: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, { headers: await authHeaders(), cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`tmbilling API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** POST helper (back-compat name). */
export const apiPost = (path: string, body: unknown) => apiWrite(path, body, "POST");
export const apiPatch = (path: string, body: unknown) => apiWrite(path, body, "PATCH");
/** PUT helper — for endpoints that REPLACE a whole collection (e.g. a tax component vector). */
export const apiPut = (path: string, body: unknown) => apiWrite(path, body, "PUT");
export const apiDelete = (path: string) => apiWrite(path, {}, "DELETE");

export const getMe = () => api<Organization>("/v1/me");
export const listBusinesses = () => api<List<Business>>("/v1/businesses");
/** One filter row of the list API's `field[op]=value` grammar. */
export interface ListFilterParam {
  field: string;
  op: string;
  value: string;
}
/** Shared params for every paginated list endpoint (docs/GUIDE.md §3.4). */
export interface ListParams {
  limit?: number;
  /** Opaque `next_cursor` from the previous page. */
  startingAfter?: string | null;
  /** Free-text search (the columns differ per entity). */
  q?: string;
  sort?: { field: string; desc: boolean };
  filters?: ListFilterParam[];
  includeArchived?: boolean;
  /** Fixed scoping params (e.g. `customer`, `invoice`). */
  scope?: Record<string, string | undefined>;
  /** Count `total` in full: the engine otherwise stops at 10,000. For a total shown as a figure. */
  exactTotal?: boolean;
}
/** @deprecated use `ListParams` — kept so existing customer call sites compile. */
export type CustomerListParams = ListParams;

/** Build the query string for a paginated list endpoint. */
export function listQuery(p: ListParams = {}): string {
  const qs = new URLSearchParams();
  if (p.limit != null) qs.set("limit", String(p.limit));
  if (p.startingAfter) qs.set("starting_after", p.startingAfter);
  if (p.q) qs.set("q", p.q);
  if (p.sort) qs.set(`sort_by[${p.sort.desc ? "desc" : "asc"}]`, p.sort.field);
  if (p.includeArchived) qs.set("include_archived", "true");
  for (const f of p.filters ?? []) qs.set(`${f.field}[${f.op}]`, f.value);
  for (const [k, v] of Object.entries(p.scope ?? {})) if (v) qs.set(k, v);
  if (p.exactTotal) qs.set("total", "exact");
  return qs.toString();
}

/** GET one page of a business-scoped list. */
function pagedList<T>(biz: string, path: string, params: ListParams): Promise<PagedList<T>> {
  const q = listQuery(params);
  return api<PagedList<T>>(`/v1/businesses/${biz}/${path}${q ? `?${q}` : ""}`);
}

/**
 * One page of customers. **Paginated server-side** — the engine defaults to 50
 * rows and caps at 1000, so callers that need "everything" (pickers, search)
 * must pass an explicit `limit` and cope with `has_more`.
 */
export const listCustomers = (biz: string, params: ListParams = {}) =>
  pagedList<Customer>(biz, "customers", params);
/** A payment still holding part of a customer's excess credit — what can be refunded from it. */
export interface ExcessPayment {
  payment: string;
  invoice: string | null;
  currency: string;
  payment_amount_minor: number;
  held_minor: number;
  refundable_minor: number;
  gateway: string | null;
  created_at: string;
}
export const listCustomerExcessPayments = (biz: string, cus: string) =>
  api<List<ExcessPayment>>(`/v1/businesses/${biz}/customers/${cus}/excess_payments`);

export const getCustomer = (biz: string, cus: string) =>
  api<Customer>(`/v1/businesses/${biz}/customers/${cus}`);
export const listContacts = (biz: string, cus: string) =>
  api<List<Contact>>(`/v1/businesses/${biz}/customers/${cus}/contacts`);
export const listShippingAddresses = (
  biz: string,
  cus: string,
  opts?: { includeArchived?: boolean },
) =>
  api<List<ShippingAddress>>(
    `/v1/businesses/${biz}/customers/${cus}/shipping_addresses${opts?.includeArchived ? "?include_archived=true" : ""}`,
  );
export const listPrices = (biz: string, opts?: { includeArchived?: boolean }) =>
  api<List<Price>>(
    `/v1/businesses/${biz}/prices${opts?.includeArchived ? "?include_archived=true" : ""}`,
  );
export const getPrice = (biz: string, price: string) =>
  api<Price>(`/v1/businesses/${biz}/prices/${price}`);
/**
 * One page of subscriptions (paginated — pass `limit` if you need more than the
 * engine's default 50). `customer` may be one `cus_…` or several, which is how a
 * paginated customers list hydrates its Subscription Info column.
 */
/**
 * Exact counts for several filter sets in one request, keyed by each set's `key`. Same
 * filter vocabulary as `listSubscriptions`. Throws on any failure, like a list read.
 */
export async function countSubscriptions(
  biz: string,
  queries: Array<{ key: string; filters: ListFilterParam[] }>,
): Promise<Record<string, number>> {
  const r = await apiWrite(`/v1/businesses/${biz}/subscriptions/count`, { queries });
  if (!r.ok) throw new Error(`tmbilling API subscriptions/count → ${r.status} ${r.error ?? ""}`);
  return (r.data as { counts: Record<string, number> }).counts;
}

export const listSubscriptions = (
  biz: string,
  customer?: string | string[],
  params: ListParams = {},
) => {
  const filter = Array.isArray(customer) ? customer.join(",") : customer;
  return pagedList<Subscription>(biz, "subscriptions", {
    ...params,
    scope: { ...params.scope, customer: filter },
  });
};
export const getSubscription = (biz: string, sub: string) =>
  api<Subscription>(`/v1/businesses/${biz}/subscriptions/${sub}`);
/** One page of invoices (paginated). */
export const listInvoices = (biz: string, customer?: string, params: ListParams = {}) =>
  pagedList<Invoice>(biz, "invoices", { ...params, scope: { ...params.scope, customer } });
export const getInvoice = (biz: string, inv: string) =>
  api<Invoice>(`/v1/businesses/${biz}/invoices/${inv}`);
export interface DunningJourneyAttempt {
  kind: "attempt";
  at: string;
  payment: string;
  status: string;
  amount_minor: number;
  currency: string;
  payment_method: {
    brand: string | null;
    last4: string | null;
    type: string;
    rail: string | null;
  } | null;
  failure_code: string | null;
  failure_message: string | null;
  presented: boolean;
  trigger:
    | "billing_clock"
    | "dashboard"
    | "portal"
    | "new_payment_method"
    | "offline"
    | "api"
    | null;
  actor: string | null;
  transaction: string | null;
  counted: boolean;
  offline_method: string | null;
}
export interface DunningJourneyEvent {
  kind: "event";
  at: string;
  type: string;
  actor: string | null;
}
export type DunningJourneyStep =
  | { kind: "retry" | "deadline_attempt"; at: string }
  | { kind: "hold"; at: string; until: string; reason: "parked" | "network_limit" }
  | {
      kind: "final_action";
      at: string;
      invoice: "not_paid" | "void" | "write_off" | "reverse";
      subscription: FinalSubscriptionAction | null;
    };
export interface DunningJourney {
  object: "dunning_journey";
  period_ends_at: string | null;
  history: Array<DunningJourneyAttempt | DunningJourneyEvent>;
  projection: DunningJourneyStep[] | null;
  projection_note:
    | "settled"
    | "stopped"
    | "exhausted"
    | "auto_collect_off"
    | "dunning_off"
    | "customer_excluded"
    | "below_minimum"
    | null;
}
/** Every attempt so far, and what dunning will do next if each retry fails. */
export const getDunningJourney = (biz: string, inv: string) =>
  api<DunningJourney>(`/v1/businesses/${biz}/invoices/${inv}/dunning_journey`);
export const listPaymentMethods = (biz: string, cus: string) =>
  api<List<PaymentMethod>>(`/v1/businesses/${biz}/customers/${cus}/payment_methods`);
/** Estimate of a subscription's next renewal invoice, INCLUDING tax and coupons —
 *  the "Next Billing Amount". `estimate` is null when there is no next
 *  term (cancelling / non-renewing / cycle cap reached). */
export const getRenewalEstimate = (biz: string, sub: string) =>
  api<{ object: "renewal_estimate"; subscription: string; estimate: RenewalEstimate | null }>(
    `/v1/businesses/${biz}/subscriptions/${sub}/renewal_estimate`,
  );
export interface RenewalEstimate {
  object: "estimate";
  currency: string;
  lines: Array<{ description: string; amount_minor: number }>;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  /** `tax_minor` split into the rows the invoice will print — `CGST (9.00%)` + `SGST (9.00%)`,
   *  or `IGST (18.00%)`. Sums exactly to `tax_minor`. The engine has always returned these
   *  (`EstimateTaxLine`); this type simply never declared them, so every consumer fell back
   *  to a single row called "Tax" — which is not what an Indian invoice says. */
  tax_lines?: Array<{ label: string; amount_minor: number }>;
  /** Post-tax invoice face total — the figure shown as Next Billing Amount. NET of
   *  `promotional_discount_minor`, exactly as the renewal invoice will report it. */
  total_minor: number;
  /** POST-tax buckets only (refundable + excess); the promotional bucket is pre-tax and
   *  is reported as `promotional_discount_minor`, already inside `total_minor`. */
  credits_applied_minor?: number;
  /** The pre-tax promotional slice, inside `discount_minor` and already off `total_minor`. */
  promotional_discount_minor?: number;
  /** total − credits: what would actually be collected. */
  amount_due_minor?: number;
  new_period_end: string | null;
}
export const listCouponSets = (biz: string) =>
  api<List<CouponSet>>(`/v1/businesses/${biz}/coupon_sets`);
export const listCouponSetCodes = (biz: string, set: string, status?: string) =>
  api<List<CouponCode>>(
    `/v1/businesses/${biz}/coupon_sets/${set}/codes${status ? `?status=${status}` : ""}`,
  );
export const listCoupons = (biz: string, opts?: { includeArchived?: boolean }) =>
  api<List<Coupon>>(
    `/v1/businesses/${biz}/coupons${opts?.includeArchived ? "?include_archived=true" : ""}`,
  );
export const listTaxRegions = (biz: string) =>
  api<List<TaxRegion>>(`/v1/businesses/${biz}/tax_regions`);
export const getTaxRegion = (biz: string, txg: string) =>
  api<TaxRegion>(`/v1/businesses/${biz}/tax_regions/${txg}`);
export const listTaxProfiles = (biz: string) =>
  api<List<TaxProfile>>(`/v1/businesses/${biz}/tax_profiles`);
/**
 * One page of credit notes (paginated), optionally scoped to an invoice or customer.
 *
 * `invoice` (positional) and `params.customer` are this function's OWN explicit
 * scoping args — but `params.scope` may ALREADY carry `customer`/`invoice` (the
 * `[entity]` list-page route forwards its whole `scope` object that way). Only
 * override `list.scope`'s value when the explicit arg actually has one, or an
 * unset positional arg silently clobbers a real value already sitting in
 * `list.scope` with `undefined` — which is exactly what happened here: every
 * page past the first (search/sort/scroll, routed through the list-page
 * fetcher) re-called this with `customer` unset and wiped the customer filter.
 */
export const listCreditNotes = (
  biz: string,
  invoice?: string,
  params: ListParams & { customer?: string } = {},
) => {
  const { customer, ...list } = params;
  return pagedList<CreditNote>(biz, "credit_notes", {
    ...list,
    scope: {
      ...list.scope,
      ...(invoice !== undefined ? { invoice } : {}),
      ...(customer !== undefined ? { customer } : {}),
    },
  });
};
export const listProducts = (biz: string, opts?: { includeArchived?: boolean; group?: string }) => {
  const qs = new URLSearchParams();
  if (opts?.includeArchived) qs.set("include_archived", "true");
  if (opts?.group) qs.set("group", opts.group);
  const q = qs.toString();
  return api<List<Product>>(`/v1/businesses/${biz}/products${q ? `?${q}` : ""}`);
};
export const getProduct = (biz: string, prod: string) =>
  api<Product>(`/v1/businesses/${biz}/products/${prod}`);
export const listApplicablePlans = (biz: string, prod: string) =>
  api<ApplicablePlans>(`/v1/businesses/${biz}/products/${prod}/applicable_plans`);
/** One-time charge lines billed on a subscription (newest 100 invoices), in one request. */
export const listSubscriptionOneTimeCharges = (biz: string, sub: string) =>
  api<{
    data: Array<{
      id: string;
      description: string;
      amount_minor: number;
      invoice: string;
      invoice_number: string | null;
      invoice_status: string;
      invoice_created_at: string | null;
    }>;
    has_more: boolean;
  }>(`/v1/businesses/${biz}/subscriptions/${sub}/one_time_charges`);
/** Every add-on's and charge's applicable plans in one request. */
export const listAllApplicablePlans = (biz: string) =>
  api<List<ApplicablePlans>>(`/v1/businesses/${biz}/applicable_plans`);
/** Every differential price in the business in one request, each naming its add-on. */
export const listAllDifferentialPrices = (biz: string) =>
  api<List<DifferentialPrice & { addon: string }>>(`/v1/businesses/${biz}/differential_prices`);
export const listDifferentialPrices = (biz: string, prod: string) =>
  api<List<DifferentialPrice> & { addon: string }>(
    `/v1/businesses/${biz}/products/${prod}/differential_prices`,
  );
export const listProductGroups = (biz: string, opts?: { includeArchived?: boolean }) =>
  api<List<ProductGroup>>(
    `/v1/businesses/${biz}/product_groups${opts?.includeArchived ? "?include_archived=true" : ""}`,
  );
export const getProductGroup = (biz: string, grp: string) =>
  api<ProductGroup>(`/v1/businesses/${biz}/product_groups/${grp}`);
export const listScheduledChanges = (biz: string, sub: string) =>
  api<List<ScheduledChange>>(`/v1/businesses/${biz}/subscriptions/${sub}/scheduled_changes`);
export const listUnbilledCharges = (biz: string, sub: string) =>
  api<List<UnbilledCharge>>(`/v1/businesses/${biz}/subscriptions/${sub}/unbilled_charges`);
export const listEntitlements = (biz: string, sub: string) =>
  api<List<Entitlement>>(`/v1/businesses/${biz}/subscriptions/${sub}/entitlements`);
/** A plan-level grant: one feature on one product. `value` is "true"/"false", an integer or "unlimited". */
export interface PlanEntitlement {
  id: string;
  product: string;
  feature: string;
  feature_name: string;
  type: "switch" | "quota" | "meter";
  unit: string | null;
  value: string;
  /**
   * G3b, meter features: when the allowance resets, or `{ same_as_credits: true }`; null = the
   * invoice's usage window.
   */
  reset?: AllowanceReset | null;
  created_at: string;
}
export interface Feature {
  id: string;
  key: string;
  name: string;
  type: "switch" | "quota" | "meter";
  unit: string | null;
  description: string | null;
  active: boolean;
}
export const listProductEntitlements = (biz: string, prod: string) =>
  api<List<PlanEntitlement>>(`/v1/businesses/${biz}/products/${prod}/entitlements`);
export const listFeatures = (biz: string) => api<List<Feature>>(`/v1/businesses/${biz}/features`);
export const listWebhookEndpoints = () => api<List<WebhookEndpoint>>("/v1/webhook_endpoints");
/** First page only; `listDeliveries` in lib/api/developer pages and filters. */
export const listWebhookDeliveries = (id: string) =>
  api<PagedList<WebhookDelivery>>(`/v1/webhook_endpoints/${id}/deliveries`);
export const listApiKeys = () => api<List<ApiKey>>("/v1/api_keys");
/** Custom roles (0389). Members with `roles:view` only. */
export const listRoles = () => api<List<import("@/lib/roles").CustomRole>>("/v1/roles");
export const listEvents = (limit = 50) => api<List<Event>>(`/v1/events?limit=${limit}`);

/** One entry in the report catalogue — a DECLARATION, not an answer. */
export interface ReportSummary {
  key: string;
  name: string;
  description: string;
  category: string;
  category_label: string;
  kind: "money" | "count" | "rate" | "ratio";
  shape: "flow" | "stock" | "forward";
  dimensions: string[];
  /** The granularities this report accepts; empty where it has no series to re-cut. */
  granularities?: Array<"day" | "week" | "month">;
  /** Cross-cutting tags with their labels — the catalogue's filter chips. */
  tags: Array<{ id: string; label: string }>;
  variants: Array<{ key: string; name: string }>;
}

/** One report's answer. The same envelope for every key — that is the point of the registry. */
export interface ReportResult {
  object: "report";
  key: string;
  name: string;
  description: string;
  category: string;
  /** What this report may be grouped by — the page renders a control per entry. */
  dimensions?: string[];
  /**
   * The granularities this report's series may be re-cut at — empty where it has no series
   * to re-cut, so the page renders a control only where the engine honours one.
   */
  granularities?: Array<"day" | "week" | "month">;
  kind: ReportSummary["kind"];
  shape: ReportSummary["shape"];
  range: AnalyticsRange;
  granularity: "day" | "week" | "month";
  currency: string;
  converted: boolean;
  headline: number | null;
  points: Array<{ t: string; label: string; v: number }>;
  rows?: Array<{ group: string; group_id: string | null; value: number }>;
  /**
   * A waterfall: one row per period, one column per measure. Opening and closing are the
   * book's level; the columns between them are what moved it, and every row reconciles.
   */
  table?: {
    columns: Array<{ key: string; label: string }>;
    rows: Array<{ period: string; values: number[] }>;
  };
  /** A cohort grid: one row per intake month, one column per month since. */
  matrix?: {
    columns: string[];
    base_kind: "money" | "count";
    rows: Array<{ group: string; base: number; values: Array<number | null> }>;
  };
  /** The period a single-figure report describes, e.g. "Aug 2026". */
  window_label?: string;
  as_of: string;
}

export const listReports = (biz: string) =>
  api<{ object: "list"; data: ReportSummary[] }>(`/v1/businesses/${biz}/reports`);

export const getReport = (
  biz: string,
  key: string,
  opts: {
    range?: AnalyticsRange;
    currency?: string;
    /** How finely to cut the series, independently of how far back `range` reaches. */
    granularity?: string;
    groupBy?: string;
  } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.range) qs.set("range", opts.range);
  if (opts.currency) qs.set("currency", opts.currency);
  if (opts.granularity) qs.set("granularity", opts.granularity);
  if (opts.groupBy) qs.set("group_by", opts.groupBy);
  const q = qs.toString();
  return api<ReportResult>(`/v1/businesses/${biz}/reports/${key}${q ? `?${q}` : ""}`);
};

/** Business Home: KPIs + bucketed series + plan mix. `currency` = 'ALL' or a code. */
export const getBusinessAnalytics = (
  biz: string,
  opts: { range?: AnalyticsRange; currency?: string } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.range) qs.set("range", opts.range);
  if (opts.currency) qs.set("currency", opts.currency);
  const q = qs.toString();
  return api<BusinessAnalytics>(`/v1/businesses/${biz}/analytics${q ? `?${q}` : ""}`);
};

export const API_URL = BASE;

/**
 * Base URL the BROWSER (or a third party, like a payment gateway) must be able to
 * reach this API at.
 *
 * NOT `BASE`. `TMBILLING_API_URL` is the SERVER-TO-SERVER address this Next process
 * dials the engine on, and in production that is a loopback address on the same box
 * (`http://localhost:4001`). Rendering it into an `<a href>` or a copyable field hands
 * out a URL only the server can open — which is exactly how the /developer "API
 * reference" links shipped pointing at localhost.
 *
 * Falls back to `BASE` because in local dev the two genuinely are the same origin.
 * Production must set `TMBILLING_PUBLIC_API_URL` (the engine already knows the same
 * value as `WEBHOOK_BASE_URL`); when it does not, `publicApiReachable` is false and
 * callers must degrade rather than render a dead link.
 */
export const PUBLIC_API_URL = (process.env.TMBILLING_PUBLIC_API_URL ?? BASE).replace(/\/+$/, "");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * False when `PUBLIC_API_URL` is a loopback address in a production build — i.e. the
 * deployment never set `TMBILLING_PUBLIC_API_URL` and anything we render from it would
 * be unreachable for the person reading it.
 *
 * True in development, where loopback is the correct answer.
 */
export const publicApiReachable = (() => {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    const host = new URL(PUBLIC_API_URL).hostname;
    return !LOOPBACK_HOSTS.has(host) && !host.endsWith(".localhost");
  } catch {
    return false;
  }
})();

// Presentation helpers live in lib/format (client-safe); re-exported here so the
// many server components importing them from '@/lib/api' keep working.
export { fmtDate, fmtDateTime, money, intervalLabel, INTERVAL_LABEL } from "@/lib/format";

/** `invoice_rules_config` as the business read returns it (every key resolved). */
export interface InvoiceRulesConfig {
  small_invoice_action: "charge" | "write_off";
  /** Per currency, minor units. */
  small_invoice_thresholds: Record<string, number>;
  charge_timing: "at_creation" | "on_due_date";
}
