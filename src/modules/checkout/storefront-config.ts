/**
 * Storefront config — buyer-surface preferences for the hosted checkout and the customer
 * portal, 0243.
 *
 * ── What this governs ─────────────────────────────────────────────────────────
 * Four independent switches, none of them financial:
 *   · `hide_zero_value_lines` — suppress $0 line items on the checkout and portal VIEWS.
 *     Deliberately SEPARATE from `invoice_customization.invoice.show_zero_value_lines`,
 *     the printed-document twin owned elsewhere (see that file's docblock and migration
 *     0243). A merchant can reasonably want a tidy checkout and a complete invoice —
 *     one flag cannot serve both.
 *   · `collect_po_number` — ask the buyer for a PO number during checkout. `po_number`
 *     already exists on both `invoices` and `subscriptions`; nothing ever collected it.
 *   · `default_return_url` / `default_cancel_url` — fallback redirect targets for the
 *     checkout's add-card step (`POST /checkout/v1/setup`), which otherwise REQUIRES both
 *     on every call.
 *
 * ── Portal self-service permissions (2026-09-09) ──────────────────────────────
 * Three more switches, and they are the FIRST per-buyer-action gates this product has —
 * every portal route was previously open to every portal session. Each one gates a route
 * that ALREADY WORKS, which is the whole reason only these three were shipped:
 * a rule gating an action we do not have would be a
 * control reaching nothing (CLAUDE.md rule 0). Change / cancel / pause / resume /
 * reactivate have no portal route at all, so they get no setting until they do.
 *   · `allow_invoice_download` — `GET /portal/v1/invoices/:inv/pdf`
 *   · `allow_invoice_payment`  — `POST /portal/v1/invoices/:inv/collect`
 *   · `allow_remove_payment_method` — `DELETE /portal/v1/payment_methods/:pm`
 * All three default TRUE, because all three routes are open to every buyer today and a
 * default of false would silently withdraw a working feature on deploy.
 *
 * ── Buyer-initiated cancellation (2026-09-09) ─────────────────────────────────
 * `allow_cancel_subscription` + `cancel_timing` gate a route that is BRAND NEW, and so
 * they default the other way round: **OFF**. The three permissions above default on
 * because withdrawing a working feature would be the change; this one defaults off
 * because GRANTING buyers the ability to cancel themselves is the change, and no merchant
 * asked for it by deploying. Same rule both times — the default is whatever leaves a
 * business exactly as it was.
 *
 * ── Pause / resume / reactivate (2026-09-09) ──────────────────────────────────
 * `allow_pause_resume` is ONE key on purpose. Pausing and resuming are one capability from
 * the buyer's side, and splitting them creates a trap: pause-without-resume leaves a buyer
 * unable to restart something they stopped, which is worse than not offering pause. A
 * merchant who wants only one direction has the operator surface.
 *
 * `allow_reactivate` covers UNDOING A PENDING CANCELLATION — a subscription still active
 * with `cancel_at_period_end`. It deliberately does NOT restart an already-cancelled
 * subscription: `reactivateSubscription` reports `billable` for that case and the caller
 * has to charge the new period, which needs the business's charges-handling decision and
 * can fail at the gateway. That is a checkout, not a one-click portal action, so the route
 * refuses it with a message pointing at the merchant.
 *
 * `cancel_timing` is the MERCHANT's choice, never the buyer's, and is not accepted as a
 * request parameter. A buyer picking "immediately" would decide whether the merchant keeps
 * the term they have already been paid for; that is a commercial policy, not a preference.
 * Default `end_of_term`: the buyer keeps what they paid for and the merchant keeps the
 * term, which is the outcome neither party can object to.
 *
 * ── Shape and style ───────────────────────────────────────────────────────────
 * Modelled on `resolveCreditsFlexibility` (modules/customers/credits-flexibility.ts) and
 * `resolveInvoiceCustomization` (modules/invoicing/customization.ts): one nullable jsonb
 * column on `businesses`, a PURE resolver, a docblock per field naming its default, and the
 * house rule that **only an explicit valid value opts out** — checked against the literal
 * type, never truthiness. Null / absent / malformed → DEFAULT_STOREFRONT_CONFIG, which is
 * exactly today's behaviour: every line prints, the checkout never asks for a PO number,
 * and the add-card call still requires both URLs on every request.
 */

import { emailHtmlToText, sanitizeEmailHtml } from "@/modules/emails/sanitize";

export interface StorefrontConfig {
  /**
   * Default FALSE — every line item is shown today. Governs the CHECKOUT and PORTAL
   * views only — see the file docblock for why the printed-document flag is separate.
   */
  hideZeroValueLines: boolean;
  /**
   * Default FALSE — the checkout never asks today, even though `po_number` has been a
   * column on `invoices` and `subscriptions` all along.
   */
  collectPoNumber: boolean;
  /**
   * Default null. Fallback `return_url` for `POST /checkout/v1/setup`, which otherwise
   * requires one on every call. An explicit `return_url` on the call always wins over this
   * default — it only fills the gap when the caller sends none.
   *
   * A stored value that is not a valid, parseable http(s) URL resolves to `null`, never to
   * a broken (or script-executing) redirect — see {@link sanitizeUrl}.
   */
  defaultReturnUrl: string | null;
  /** Fallback `cancel_url` — see {@link StorefrontConfig.defaultReturnUrl}. Default null. */
  defaultCancelUrl: string | null;
  /**
   * May a buyer download an invoice PDF from the portal? Default TRUE —
   * `GET /portal/v1/invoices/:inv/pdf` is open to every portal session today.
   */
  allowInvoiceDownload: boolean;
  /**
   * May a buyer pay an unpaid invoice from the portal? Default TRUE —
   * `POST /portal/v1/invoices/:inv/collect` is open today.
   *
   * Turning this OFF does not stop collection; the engine still charges on its own
   * schedule and dunning still runs. It only removes the buyer's own "Pay now", which is
   * what a merchant collecting strictly by mandate or invoice-and-transfer wants.
   */
  allowInvoicePayment: boolean;
  /**
   * May a buyer remove a stored payment method? Default TRUE —
   * `DELETE /portal/v1/payment_methods/:pm` is open today.
   *
   * The reason a merchant turns this off is an active mandate: a buyer who deletes the
   * instrument behind a live subscription leaves nothing to charge at renewal, and the
   * first anyone hears of it is a failed collection. We do NOT refuse that deletion
   * ourselves — the route has no such guard — so this switch is currently the only way to
   * prevent it.
   */
  allowRemovePaymentMethod: boolean;
  /**
   * May a buyer cancel their own subscription from the portal? Default FALSE — the route
   * is new, and a deploy must not hand every merchant's buyers a cancel button nobody
   * asked for. See the file docblock on why this default is the opposite of the three
   * above and still the same rule.
   */
  allowCancelSubscription: boolean;
  /**
   * WHEN a buyer-initiated cancellation takes effect. Default `end_of_term`.
   *
   * The merchant's choice, deliberately not the buyer's: `immediately` decides whether the
   * merchant keeps a term they have already been paid for. Money handling is NOT set here
   * — `cancelSubscriptionWithOptions` resolves the business's own 0242 defaults for AR,
   * refundable credits and unbilled charges, so a buyer cancel and an operator cancel on
   * the same business settle money identically.
   */
  cancelTiming: "immediately" | "end_of_term";
  /**
   * May a buyer pause and resume their own subscription? Default FALSE. One key for both
   * directions — see the file docblock on why splitting them would be a trap. Pause uses
   * the business's own 0242 `pause_config` defaults for unbilled charges and dunning.
   */
  allowPauseResume: boolean;
  /**
   * May a buyer undo a pending cancellation? Default FALSE. Covers a subscription that is
   * still active with `cancel_at_period_end`; an already-cancelled one is refused, because
   * restarting it charges money immediately. See the file docblock.
   */
  allowReactivate: boolean;
  /**
   * May a buyer skip an upcoming renewal of their own subscription? Default FALSE. Capped by
   * `skipRenewalLimit` skips per 12 months; operators are not capped.
   */
  allowSkipRenewal: boolean;
  /** Most renewals a buyer may skip in 12 months (1–12). Default 3. */
  skipRenewalLimit: number;
  /**
   * What the portal says when a buyer cannot get in — an expired, spent, revoked or
   * unknown link, or a session that ended. Merchant-authored rich text, sanitised on
   * READ with the email allowlist, so a row written by any path renders safely. Default
   * null: the portal's own "ask for a new link" copy.
   */
  portalLinkErrorHtml: string | null;
  /**
   * Whether a one-time purchase keeps the buyer's payment method for later. Default `ask`:
   * the buyer decides, so the merchant does not decide consent for them. `never` pays
   * without vaulting; `always` vaults first and charges the saved method.
   */
  oneTimeSavePaymentMethod: "never" | "always" | "ask";
  /** Show the buyer their usage so far on metered subscriptions. Default TRUE. */
  portalShowUsage: boolean;
  /** Also show the projected usage at window end. Default FALSE: a projection reads as a promise. */
  portalShowUsageProjection: boolean;
  /** Hosted checkout layout. Default `steps` (today); new businesses get `one_page`. */
  checkoutLayout: "steps" | "one_page";
  /** Put Apple Pay / Google Pay above the form where the gateway supports them. */
  walletsFirst: boolean;
  /** Buyer must tick "I agree that <business> charges <amount> every <period> until I cancel." */
  recurringConsent: boolean;
  /** Buyer must accept the terms (and privacy policy when set). Needs `termsUrl`. */
  requireTerms: boolean;
  termsUrl: string | null;
  privacyUrl: string | null;
  /** Offer an optional marketing opt-in; stored on the customer. */
  marketingConsent: boolean;
  /** Ask for a bot check after this many failed payments from one IP in 24 h. Null = off. */
  botCheckAfterFailures: number | null;
  /**
   * Portal plan changes (Phase 2). Which plans and add-ons a customer sees is each product's
   * own "show in portal" flag (`products.enabled_in_portal`); these decide what they may do.
   */
  allowPlanChanges: boolean;
  /** Seats = the quantity of a per-unit plan. `increase` = no decreases. */
  seatChanges: "off" | "increase" | "both";
  seatMin: number | null;
  seatMax: number | null;
  allowAddonChanges: boolean;
  /** A move to a shorter billing period (yearly → monthly). */
  shorterPeriod: "always" | "never" | "after_12_months";
  /** When an upgrade is invoiced. `business_default` = Billing rules → unbilled charges. */
  chargeUpgrade: "business_default" | "now" | "next_invoice";
  /** Subscription statuses that may change. */
  changeStatuses: string[];
  /** The customer may withdraw a change scheduled for the end of the term. */
  allowCancelScheduledChange: boolean;
  /** Portal cancel flow (Phase 3). Ask for a reason: today the portal asks, optionally. */
  cancelReason: "off" | "optional" | "required";
  /** Offer a pause before the cancel. */
  retentionPause: boolean;
  /** Pause length in months (1–12), or null = no end date. */
  retentionPauseMonths: number | null;
  /** The customer picks 1 to `retentionPauseMonths` months. */
  retentionPauseChoice: boolean;
  /** Offer a move to this cheaper plan price (public id), or null = no downgrade offer. */
  retentionDowngradePrice: string | null;
  /** Offer this coupon code, or null = no discount offer. */
  retentionCoupon: string | null;
  /** Offer "Contact us" with this http(s) URL, or null. */
  retentionContactUrl: string | null;
  /** A customer who took an offer before is not offered one again. */
  retentionOfferOnce: boolean;
  // ── Portal access (Phase 4) ──
  /** The signed-out portal offers "email me a code" (a typed code, never a link). */
  portalEmailCode: boolean;
  /** Entry window of a link an integration mints, in hours (1–24). Null = 1 hour. */
  portalLinkHours: number | null;
  /** Entry window of a link in an email, in days (1–14). Null = 5 days. */
  portalEmailLinkDays: number | null;
  /** How long a portal session lasts once open, in hours (1–168). Null = 72 hours. */
  portalSessionHours: number | null;
  portalHideCancelledSubscriptions: boolean;
  /** Hides invoices with a zero total. An invoice with an amount due is never hidden. */
  portalHideZeroInvoices: boolean;
  portalHideVoidedInvoices: boolean;
  /** Single-action links (Phase 4b): which tasks a link may open on. All on = today's links work as before. */
  portalActions: { payInvoice: boolean; updateCard: boolean; changePlan: boolean; cancel: boolean };
  /** Where the portal sends the customer back to. Null = `defaultReturnUrl`. */
  portalReturnUrl: string | null;
}

/** Every default here is "what the engine already does". See the file docblock. */
export const DEFAULT_STOREFRONT_CONFIG: StorefrontConfig = {
  hideZeroValueLines: false,
  collectPoNumber: false,
  defaultReturnUrl: null,
  defaultCancelUrl: null,
  allowInvoiceDownload: true,
  allowInvoicePayment: true,
  allowRemovePaymentMethod: true,
  allowCancelSubscription: false,
  cancelTiming: "end_of_term",
  allowPauseResume: false,
  allowReactivate: false,
  allowSkipRenewal: false,
  skipRenewalLimit: 3,
  portalLinkErrorHtml: null,
  oneTimeSavePaymentMethod: "ask",
  portalShowUsage: true,
  portalShowUsageProjection: false,
  checkoutLayout: "steps",
  walletsFirst: false,
  recurringConsent: false,
  requireTerms: false,
  termsUrl: null,
  privacyUrl: null,
  marketingConsent: false,
  botCheckAfterFailures: null,
  allowPlanChanges: false,
  seatChanges: "off",
  seatMin: null,
  seatMax: null,
  allowAddonChanges: false,
  shorterPeriod: "always",
  chargeUpgrade: "business_default",
  changeStatuses: ["active", "in_trial"],
  allowCancelScheduledChange: true,
  cancelReason: "optional",
  retentionPause: false,
  retentionPauseMonths: 3,
  retentionPauseChoice: false,
  retentionDowngradePrice: null,
  retentionCoupon: null,
  retentionContactUrl: null,
  retentionOfferOnce: true,
  portalEmailCode: false,
  portalLinkHours: null,
  portalEmailLinkDays: null,
  portalSessionHours: null,
  portalHideCancelledSubscriptions: false,
  portalHideZeroInvoices: false,
  portalHideVoidedInvoices: false,
  portalActions: { payInvoice: true, updateCard: true, changePlan: true, cancel: true },
  portalReturnUrl: null,
};

/**
 * Written into `storefront_config` when a business is CREATED: the best option for a new
 * merchant. The resolver defaults above stay today's behaviour, so existing businesses only
 * change when someone changes their settings.
 */
export const NEW_BUSINESS_STOREFRONT_CONFIG = {
  checkout_layout: "one_page",
  wallets_first: true,
  recurring_consent: true,
  bot_check_after_failures: 3,
  allow_plan_changes: true,
  seat_changes: "both",
  allow_addon_changes: true,
  shorter_period: "after_12_months",
  retention_pause: true,
  retention_pause_months: 3,
  retention_pause_choice: true,
  portal_email_code: true,
  portal_hide_zero_invoices: true,
  portal_hide_voided_invoices: true,
} as const;

/**
 * The storefront config a newly created business starts with. Only a PERSON gets the
 * recommended settings: the organization's first key is dashboard-kind too, and every
 * integration and test that creates businesses with it must keep the engine defaults.
 */
export function initialStorefrontConfig(creator: {
  hasOperator?: boolean;
}): Record<string, unknown> | undefined {
  return creator.hasOperator === true ? { ...NEW_BUSINESS_STOREFRONT_CONFIG } : undefined;
}

/** The stored jsonb shape (snake_case, like every other business config blob). */
interface StoredStorefrontConfig {
  hide_zero_value_lines?: unknown;
  collect_po_number?: unknown;
  default_return_url?: unknown;
  default_cancel_url?: unknown;
  allow_invoice_download?: unknown;
  allow_invoice_payment?: unknown;
  allow_remove_payment_method?: unknown;
  allow_cancel_subscription?: unknown;
  cancel_timing?: unknown;
  allow_pause_resume?: unknown;
  allow_reactivate?: unknown;
  allow_skip_renewal?: unknown;
  skip_renewal_limit?: unknown;
  portal_link_error_html?: unknown;
  one_time_save_payment_method?: unknown;
  portal_show_usage?: unknown;
  portal_show_usage_projection?: unknown;
  checkout_layout?: unknown;
  wallets_first?: unknown;
  recurring_consent?: unknown;
  require_terms?: unknown;
  terms_url?: unknown;
  privacy_url?: unknown;
  marketing_consent?: unknown;
  bot_check_after_failures?: unknown;
  allow_plan_changes?: unknown;
  seat_changes?: unknown;
  seat_min?: unknown;
  seat_max?: unknown;
  allow_addon_changes?: unknown;
  shorter_period?: unknown;
  charge_upgrade?: unknown;
  change_statuses?: unknown;
  allow_cancel_scheduled_change?: unknown;
  cancel_reason?: unknown;
  retention_pause?: unknown;
  retention_pause_months?: unknown;
  retention_pause_choice?: unknown;
  retention_downgrade_price?: unknown;
  retention_coupon?: unknown;
  retention_contact_url?: unknown;
  retention_offer_once?: unknown;
  portal_email_code?: unknown;
  portal_link_hours?: unknown;
  portal_email_link_days?: unknown;
  portal_session_hours?: unknown;
  portal_hide_cancelled_subscriptions?: unknown;
  portal_hide_zero_invoices?: unknown;
  portal_hide_voided_invoices?: unknown;
  portal_actions?: unknown;
  portal_return_url?: unknown;
}

/**
 * A boolean with an explicit fallback. `typeof === 'boolean'` rather than truthiness, so a
 * hand-edited `"false"` string or a stray `0` does not silently flip the switch, and an
 * ABSENT key takes the documented default rather than reading as `false`.
 */
function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * A stored URL, sanitised. A non-string, an empty/over-long string, an unparseable value,
 * or anything other than http/https resolves to `null` — never to a broken redirect.
 *
 * Scheme-restricted for the same reason `httpUrl()` (src/api/limits.ts) is: this value is
 * handed straight to a browser redirect, and the write-time schema for this column
 * (`storefront_config` on `updateBusinessBody`, src/api/routes.ts) validates shape with
 * plain `.url()`, which — unlike `httpUrl()` — does not reject a `javascript:` URL. This
 * resolver is the one place every reader goes through, so it is where that gets caught
 * regardless of what got written.
 */
function sanitizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? trimmed : null;
}

/** Max stored length of the portal link-error message; the route enforces the same. */
export const PORTAL_LINK_ERROR_HTML_MAX = 5000;

/** Sanitised rich text, or null when absent, over-long or empty once markup is stripped. */
function sanitizeRichText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > PORTAL_LINK_ERROR_HTML_MAX) return null;
  const html = sanitizeEmailHtml(raw).trim();
  return emailHtmlToText(html).trim() ? html : null;
}

/**
 * Resolve a business's effective storefront config. Pure; a null / absent / malformed
 * stored value resolves to {@link DEFAULT_STOREFRONT_CONFIG} — exactly what the checkout
 * and portal did before this column existed.
 */
export function resolveStorefrontConfig(
  biz: { storefrontConfig?: unknown } | null | undefined,
): StorefrontConfig {
  const raw = (biz?.storefrontConfig ?? null) as StoredStorefrontConfig | null;
  return {
    hideZeroValueLines: flag(
      raw?.hide_zero_value_lines,
      DEFAULT_STOREFRONT_CONFIG.hideZeroValueLines,
    ),
    collectPoNumber: flag(raw?.collect_po_number, DEFAULT_STOREFRONT_CONFIG.collectPoNumber),
    defaultReturnUrl: sanitizeUrl(raw?.default_return_url),
    defaultCancelUrl: sanitizeUrl(raw?.default_cancel_url),
    // `flag` checks the literal type, so only an explicit `false` withdraws a permission —
    // a malformed or absent key leaves the buyer able to do what they can do today.
    allowInvoiceDownload: flag(
      raw?.allow_invoice_download,
      DEFAULT_STOREFRONT_CONFIG.allowInvoiceDownload,
    ),
    allowInvoicePayment: flag(
      raw?.allow_invoice_payment,
      DEFAULT_STOREFRONT_CONFIG.allowInvoicePayment,
    ),
    allowRemovePaymentMethod: flag(
      raw?.allow_remove_payment_method,
      DEFAULT_STOREFRONT_CONFIG.allowRemovePaymentMethod,
    ),
    allowCancelSubscription: flag(
      raw?.allow_cancel_subscription,
      DEFAULT_STOREFRONT_CONFIG.allowCancelSubscription,
    ),
    // Checked against the literal values, never coerced: an unrecognised string must fall
    // back to `end_of_term` rather than being read as "immediately", because the two
    // differ by a term's revenue.
    cancelTiming:
      raw?.cancel_timing === "immediately" || raw?.cancel_timing === "end_of_term"
        ? raw.cancel_timing
        : DEFAULT_STOREFRONT_CONFIG.cancelTiming,
    allowPauseResume: flag(raw?.allow_pause_resume, DEFAULT_STOREFRONT_CONFIG.allowPauseResume),
    allowReactivate: flag(raw?.allow_reactivate, DEFAULT_STOREFRONT_CONFIG.allowReactivate),
    allowSkipRenewal: flag(raw?.allow_skip_renewal, DEFAULT_STOREFRONT_CONFIG.allowSkipRenewal),
    skipRenewalLimit:
      Number.isInteger(raw?.skip_renewal_limit) &&
      (raw!.skip_renewal_limit as number) >= 1 &&
      (raw!.skip_renewal_limit as number) <= 12
        ? (raw!.skip_renewal_limit as number)
        : DEFAULT_STOREFRONT_CONFIG.skipRenewalLimit,
    portalLinkErrorHtml: sanitizeRichText(raw?.portal_link_error_html),
    oneTimeSavePaymentMethod:
      raw?.one_time_save_payment_method === "never" ||
      raw?.one_time_save_payment_method === "always" ||
      raw?.one_time_save_payment_method === "ask"
        ? raw.one_time_save_payment_method
        : DEFAULT_STOREFRONT_CONFIG.oneTimeSavePaymentMethod,
    portalShowUsage: flag(raw?.portal_show_usage, DEFAULT_STOREFRONT_CONFIG.portalShowUsage),
    portalShowUsageProjection: flag(
      raw?.portal_show_usage_projection,
      DEFAULT_STOREFRONT_CONFIG.portalShowUsageProjection,
    ),
    checkoutLayout:
      raw?.checkout_layout === "one_page" || raw?.checkout_layout === "steps"
        ? raw.checkout_layout
        : DEFAULT_STOREFRONT_CONFIG.checkoutLayout,
    walletsFirst: flag(raw?.wallets_first, DEFAULT_STOREFRONT_CONFIG.walletsFirst),
    recurringConsent: flag(raw?.recurring_consent, DEFAULT_STOREFRONT_CONFIG.recurringConsent),
    // Terms without a URL would ask the buyer to accept nothing: off until a URL resolves.
    requireTerms:
      flag(raw?.require_terms, DEFAULT_STOREFRONT_CONFIG.requireTerms) &&
      sanitizeUrl(raw?.terms_url) !== null,
    termsUrl: sanitizeUrl(raw?.terms_url),
    privacyUrl: sanitizeUrl(raw?.privacy_url),
    marketingConsent: flag(raw?.marketing_consent, DEFAULT_STOREFRONT_CONFIG.marketingConsent),
    botCheckAfterFailures:
      Number.isInteger(raw?.bot_check_after_failures) &&
      (raw!.bot_check_after_failures as number) >= 1 &&
      (raw!.bot_check_after_failures as number) <= 20
        ? (raw!.bot_check_after_failures as number)
        : DEFAULT_STOREFRONT_CONFIG.botCheckAfterFailures,
    allowPlanChanges: flag(raw?.allow_plan_changes, DEFAULT_STOREFRONT_CONFIG.allowPlanChanges),
    seatChanges:
      raw?.seat_changes === "off" ||
      raw?.seat_changes === "increase" ||
      raw?.seat_changes === "both"
        ? raw.seat_changes
        : DEFAULT_STOREFRONT_CONFIG.seatChanges,
    seatMin: seatBound(raw?.seat_min),
    seatMax: seatBound(raw?.seat_max),
    allowAddonChanges: flag(raw?.allow_addon_changes, DEFAULT_STOREFRONT_CONFIG.allowAddonChanges),
    shorterPeriod:
      raw?.shorter_period === "always" ||
      raw?.shorter_period === "never" ||
      raw?.shorter_period === "after_12_months"
        ? raw.shorter_period
        : DEFAULT_STOREFRONT_CONFIG.shorterPeriod,
    chargeUpgrade:
      raw?.charge_upgrade === "now" || raw?.charge_upgrade === "next_invoice"
        ? raw.charge_upgrade
        : "business_default",
    changeStatuses:
      Array.isArray(raw?.change_statuses) &&
      (raw!.change_statuses as unknown[]).every(
        (v) => typeof v === "string" && CHANGE_STATUSES.has(v),
      )
        ? [...new Set(raw!.change_statuses as string[])]
        : DEFAULT_STOREFRONT_CONFIG.changeStatuses,
    allowCancelScheduledChange: flag(
      raw?.allow_cancel_scheduled_change,
      DEFAULT_STOREFRONT_CONFIG.allowCancelScheduledChange,
    ),
    cancelReason:
      raw?.cancel_reason === "off" || raw?.cancel_reason === "required"
        ? raw.cancel_reason
        : DEFAULT_STOREFRONT_CONFIG.cancelReason,
    retentionPause: flag(raw?.retention_pause, DEFAULT_STOREFRONT_CONFIG.retentionPause),
    // Explicit null = no end date; absent or malformed = the default length.
    retentionPauseMonths:
      raw?.retention_pause_months === null
        ? null
        : Number.isInteger(raw?.retention_pause_months) &&
            (raw!.retention_pause_months as number) >= 1 &&
            (raw!.retention_pause_months as number) <= 12
          ? (raw!.retention_pause_months as number)
          : DEFAULT_STOREFRONT_CONFIG.retentionPauseMonths,
    retentionPauseChoice: flag(
      raw?.retention_pause_choice,
      DEFAULT_STOREFRONT_CONFIG.retentionPauseChoice,
    ),
    retentionDowngradePrice: shortText(raw?.retention_downgrade_price),
    retentionCoupon: shortText(raw?.retention_coupon),
    retentionContactUrl: sanitizeUrl(raw?.retention_contact_url),
    retentionOfferOnce: flag(
      raw?.retention_offer_once,
      DEFAULT_STOREFRONT_CONFIG.retentionOfferOnce,
    ),
    portalEmailCode: flag(raw?.portal_email_code, DEFAULT_STOREFRONT_CONFIG.portalEmailCode),
    portalLinkHours: boundedInt(raw?.portal_link_hours, 1, 24),
    portalEmailLinkDays: boundedInt(raw?.portal_email_link_days, 1, 14),
    portalSessionHours: boundedInt(raw?.portal_session_hours, 1, 168),
    portalHideCancelledSubscriptions: flag(
      raw?.portal_hide_cancelled_subscriptions,
      DEFAULT_STOREFRONT_CONFIG.portalHideCancelledSubscriptions,
    ),
    portalHideZeroInvoices: flag(
      raw?.portal_hide_zero_invoices,
      DEFAULT_STOREFRONT_CONFIG.portalHideZeroInvoices,
    ),
    portalHideVoidedInvoices: flag(
      raw?.portal_hide_voided_invoices,
      DEFAULT_STOREFRONT_CONFIG.portalHideVoidedInvoices,
    ),
    portalActions: ((a) => ({
      payInvoice: flag(a?.pay_invoice, true),
      updateCard: flag(a?.update_card, true),
      changePlan: flag(a?.change_plan, true),
      cancel: flag(a?.cancel, true),
    }))(
      raw?.portal_actions && typeof raw.portal_actions === "object"
        ? (raw.portal_actions as Record<string, unknown>)
        : null,
    ),
    // https only: it is a link out of the portal.
    portalReturnUrl: ((u) => (u?.startsWith("https://") ? u : null))(
      sanitizeUrl(raw?.portal_return_url),
    ),
  };
}

/** An integer inside the bounds, else null (= today's built-in value). */
function boundedInt(raw: unknown, min: number, max: number): number | null {
  return Number.isInteger(raw) && (raw as number) >= min && (raw as number) <= max
    ? (raw as number)
    : null;
}

/** A short non-empty id or code, else null. */
function shortText(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() && raw.length <= 200 ? raw.trim() : null;
}

/** Statuses a portal change may start from. */
export const CHANGE_STATUSES = new Set(["active", "in_trial", "paused"]);

function seatBound(raw: unknown): number | null {
  return Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= 100000
    ? (raw as number)
    : null;
}

/**
 * Resolve the pair `POST /checkout/v1/setup` needs, given the call's own explicit values
 * (if any) and this business's resolved config. The call's own value always wins — the
 * config only fills a gap.
 *
 * Returns `null` when EITHER leg has no source at all (no argument, no configured
 * default) — the single choke point for the safety property `/checkout/v1/setup` depends
 * on: an add-card flow must never begin with nowhere to send the buyer back. The route
 * turns a `null` here into a 400; nothing else may skip this check.
 */
export function resolveCheckoutRedirect(
  config: StorefrontConfig,
  explicit: { returnUrl?: string | null; cancelUrl?: string | null },
): { returnUrl: string; cancelUrl: string } | null {
  const returnUrl = explicit.returnUrl ?? config.defaultReturnUrl;
  const cancelUrl = explicit.cancelUrl ?? config.defaultCancelUrl;
  if (!returnUrl || !cancelUrl) return null;
  return { returnUrl, cancelUrl };
}
