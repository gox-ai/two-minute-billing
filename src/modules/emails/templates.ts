import type { EmailType } from "./config";
import { formatMoney as formatPlatformMoney } from "@/platform/currency";
import { escapeHtml, emailHtmlToText } from "./sanitize";
import { renderBody, renderText } from "./template-lang";
import { accountBrand, type AccountBrand } from "./account-brand";

/**
 * Built-in billing email templates. One subject + HTML + text per type, rendered
 * with a tiny `{{var}}` substitution (no template dependency). Deliberately
 * self-contained and inline-styled — the console dev sink and any future ESP both
 * receive final rendered strings; the email_messages row stores them verbatim.
 */

/**
 * Everything a template may substitute. Optional throughout because which keys are
 * populated depends on the type — TEMPLATE_VARS is the per-type contract, and a key a
 * template references but the enqueue path never sets renders as EMPTY TEXT, silently.
 * That is why adding a var here is only half the job: the enqueue path must populate it
 * and TEMPLATE_VARS must advertise it.
 *
 * Dates are pre-formatted strings in the BUSINESS timezone, not Dates — rendering a raw
 * ISO timestamp into customer mail is how "expires 2026-08-09T18:30:00.000Z" ships.
 */
export interface RenderVars {
  businessName: string;
  customerName: string;
  /** portal_sign_in_code: the 6-digit code. Never stored; the logged copy is masked. */
  code?: string;
  /** checkout_reminder: what the buyer left, e.g. "Credit pack × 2". */
  orderSummary?: string;
  /** checkout_reminder: the link back to their order. The button's URL, never the merchant's. */
  checkoutUrl?: string;
  /**
   * Brand Styles (0185). NOT `{{var}}` substitution material — these are consumed by
   * the shell around the merchant's body, never by the body itself, so a merchant
   * editing a template cannot move or delete their own logo (or inject a URL into an
   * `src`). `logoUrl` is the wide wordmark; `iconUrl` is the square fallback for
   * where a wordmark does not fit; `brandColor` is `#RRGGBB`, validated at the API.
   */
  logoUrl?: string;
  iconUrl?: string;
  brandColor?: string;
  amount?: string; // pre-formatted "1,234.00 USD"
  invoiceNumber?: string;
  currency?: string;
  reason?: string;
  declineMessage?: string;
  portalUrl?: string;
  /**
   * Shell-only, like `logoUrl`: an `invoice_issued` / `invoice_sent` mail for an open
   * auto-collect-off invoice, which gets a "Pay now" button because nothing else will
   * collect it.
   */
  invoicePayable?: boolean;
  // subscription
  planName?: string;
  subscriptionId?: string;
  // dates (pre-formatted, business timezone)
  renewalDate?: string;
  trialEndDate?: string;
  pauseDate?: string;
  resumeDate?: string;
  cancelDate?: string;
  dueDate?: string;
  /** Pre-debit notice: the day the mandate will be debited. */
  debitDate?: string;
  /** Pre-debit notice: the mandate's provider reference, which NPCI requires be quoted. */
  mandateReference?: string;
  /** Pre-debit notice: the rail in the buyer's words ("UPI Autopay", "card", "bank account"). */
  mandateRail?: string;
  /** Pre-debit notice: present on an ACH debit under our authorization (revoked with the business). */
  achDebit?: string;
  /** ACH authorization copy: the accepted text, exactly as stored. */
  authorizationText?: string;
  /** ACH authorization copy: the text version the payer accepted. */
  authorizationVersion?: string;
  /** ACH authorization copy: when the payer accepted it, business-local. */
  acceptedAt?: string;
  /** Whole days until the thing being warned about, as a bare number ("5"). */
  daysUntil?: string;
  /**
   * Parked-dunning reminder: the day the collections window CLOSES and the business's
   * final action applies. Its own var rather than `dueDate` — the invoice's due date is
   * long past by the time anything is parked, and the two dates being different is the
   * entire content of the reminder.
   */
  deadline?: string;
  /**
   * When collections will try this charge again, on a failure that armed a retry.
   *
   * Optional and often ABSENT, deliberately: a failure that parked, exhausted or was
   * stopped has no next attempt, and the `payment_failed` template says so by omitting
   * the sentence rather than by printing an empty date. The absence is the honest state,
   * which is why this is not an `always` var — see the note beside it in TEMPLATE_VARS.
   */
  nextAttemptDate?: string;
  // payment method
  cardBrand?: string;
  cardLast4?: string;
  cardExpiry?: string; // "08/2026"
  /**
   * The instrument in the buyer's words — "card", "UPI mandate", "payment method".
   *
   * Goes in the SUBJECT ("[Important] We couldn't charge your card"). Distinct from
   * `cardBrand`: that is "Visa", this is the kind of thing it is, and it stays meaningful
   * on a rail that has no brand at all. Falls back to the generic "payment method" rather
   * than rendering empty, because a subject line with a hole in it is worse than a vague
   * one.
   */
  paymentMethodType?: string;
  // credit notes & refunds
  creditNoteNumber?: string;
  creditAmount?: string;
  refundAmount?: string;
  /** Operator's covering note on an ad-hoc send. Empty on engine-fired mail. */
  note?: string;
  // usage controls
  /** Usage alert: what was used, e.g. "80% of your monthly spend limit". */
  alertSummary?: string;
  /** Usage alert / spend limit: the measured value now, formatted ("$400.00", "1,200 units"). */
  usageValue?: string;
  /** Spend limit or the alert's reference value, formatted. Absent when there is none. */
  limitValue?: string;
  /** Spend limit: the interval in words ("daily", "weekly", "monthly", "billing period"). */
  intervalLabel?: string;
  /** When the interval or period resets, business-local. */
  resetDate?: string;
  /** Spend limit: present when the limit is hard (new requests are refused). */
  hardLimit?: string;
  /** Automatic top-up failure: the bank's reason in the payer's words, when it may be shown. */
  declineReason?: string;
  /**
   * The facts card — label/value rows under the body ("Invoiced amount / Payment
   * method / Due since / Failure reason").
   *
   * Rendered BY THE SHELL from resolver-supplied rows, never from merchant markup, so
   * it needs no sanitising and a template edit cannot break or forge it. That is also
   * why it is a var rather than something the body writes: the merchant chooses the
   * words around the numbers, the engine owns the numbers.
   *
   * Only add a row the resolver actually has. A card line whose value is blank reads as
   * a bug to the customer, which is worse than a card with three rows instead of five —
   * the same rule that governs dead controls in the dashboard.
   */
  facts?: Array<{ label: string; value: string }>;
  /**
   * The primary call to action.
   *
   * Replaces the shell's old hardcoded "Manage billing" button, which every email got
   * whether or not it was the useful next step. `url` is engine-built; see the outbox
   * resolver for why it is not a portal bearer token.
   */
  action?: { label: string; url: string };
  /**
   * The business's footer ("Thanks, the Fernhill team"): written once, used by every email
   * that has no footer of its own. Template syntax, rendered like a body.
   */
  footerNote?: string;
}

/**
 * Format integer minor units + currency for an email, e.g. (129900, 'USD') → "$1,299.00".
 *
 * Delegates to the platform formatter rather than dividing by 100 here. It used to do
 * both things wrong at once: the hardcoded divisor made a ¥1000 charge read "10.00 JPY",
 * and the `1,299.00 USD` shape disagreed with every other surface the same customer
 * sees — the invoice document and the portal both render `₹1,485.62`, so only the email
 * put the code last. A customer comparing an email against their invoice should not have
 * to work out whether they are looking at the same number.
 */
export function formatMoney(amountMinor: number | bigint, currency: string): string {
  return formatPlatformMoney(amountMinor, currency);
}

export interface TemplateDef {
  subject: string;
  heading: string;
  body: string; // sanitised HTML subset (or plain paragraphs) in the template-lang syntax
  /**
   * This email's own footer, same syntax and allowlist as `body`. Null/empty uses the
   * business footer (`footerNote`), else `DEFAULT_FOOTER`.
   */
  footer?: string | null;
  /** Button text; null/absent keeps the engine's label. The URL is always engine-built. */
  ctaLabel?: string | null;
  /** False hides the facts card. Absent means shown. */
  showFacts?: boolean;
  /** Order of the movable sections; absent means BLOCK_ORDER_DEFAULT. */
  blockOrder?: BlockKey[] | null;
}

/** The sections a merchant may reorder. Logo + heading stay first, the letterhead last. */
export const BLOCK_KEYS = ["body", "action", "facts", "footer"] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];
export const BLOCK_ORDER_DEFAULT: BlockKey[] = ["body", "action", "facts", "footer"];

/**
 * The footer every email ends on until the business sets its own (`footerNote`) or the
 * template overrides it (`footer`).
 */
export const DEFAULT_FOOTER = "Thanks,\n{{businessName}} team";

/** Which footer an email ends on: its own, else the business's, else `DEFAULT_FOOTER`. */
export function resolveFooter(
  def: Pick<TemplateDef, "footer">,
  businessFooter?: string | null,
): string {
  return def.footer?.trim() || businessFooter?.trim() || DEFAULT_FOOTER;
}

export function isBlockOrder(v: unknown): v is BlockKey[] {
  return (
    Array.isArray(v) && v.length === BLOCK_KEYS.length && BLOCK_KEYS.every((k) => v.includes(k))
  );
}

/**
 * The built-ins. A business that has never edited a template renders from these, so the
 * template store is purely additive: an empty `email_templates` table behaves exactly as
 * the code did before it existed.
 *
 * Voice: a person at the business writing to a customer they know. Say what happened, what
 * happens next, and the one thing to do, then stop. No "Action needed:" subjects, no system
 * words. The portal link is always set, so "the button below" needs no guard. None carries
 * a `footer`, so every built-in ends on the business's footer (`DEFAULT_FOOTER` until one
 * is set). Replies may reach a platform address, so none of them says "just reply".
 */
export const DEFAULT_TEMPLATES: Record<EmailType, TemplateDef> = {
  invoice_to_pay: {
    subject: "Invoice {{invoiceNumber}} for {{amount}} is due on {{dueDate}}",
    heading: "Your invoice is ready to pay",
    body: "Hi {{customerName}},\n\nYour invoice {{invoiceNumber}} for {{amount}} is ready. It is due on {{dueDate}}.\n\nYou can pay it on a secure page with the button below. If your accounts team pays your invoices, you can forward this email to them.",
  },
  // Sent when the invoice is raised, before the charge: never state its outcome.
  invoice_issued: {
    subject: "Your {{businessName}} invoice {{invoiceNumber}} for {{amount}}",
    heading: "Your invoice is ready",
    body: "Hi {{customerName}},\n\nYour invoice {{invoiceNumber}} for {{amount}} is ready. We will collect it automatically from the payment method on your account.\n\nThe details are below. You can forward this email to your accounts team.",
  },
  payment_receipt: {
    subject: "Payment received: {{amount}}, thank you",
    heading: "Thank you for your payment",
    body: "Hi {{customerName}},\n\nWe received your payment of {{amount}}. Thank you.\n\nThis email is your receipt. Keep it for your records.",
  },
  // No retry is promised in the text: a failure that parked, exhausted or hit a merchant's
  // stop has none. When one is armed, the facts card shows "Next attempt".
  payment_failed: {
    subject: "Your {{amount}} payment to {{businessName}} was not successful",
    heading: "Your payment was not successful",
    body: "Hi {{customerName}},\n\nWe tried to collect {{amount}}, but the payment was not successful. Reason: {{declineMessage}}\n\nTo keep your subscription active, pay this amount as soon as possible.\n\nUse the button below to pay now or to change your payment details.",
  },
  /**
   * ⚠️ IT MUST NOT PROMISE A RETRY — that is the whole difference from `payment_failed`,
   * and the reason this is a second template rather than a reworded first.
   *
   * A park means the engine has decided not to re-present the debit, because nothing about
   * re-presenting it can work: the mandate is dead, the card expired, the bank
   * authentication lapsed. "We'll try again soon" would be false, and worse than false —
   * it tells the one customer whose action is the only thing that can settle the invoice
   * that they need not act.
   *
   * So it says the three things that are true and load-bearing: nothing further will be
   * attempted, the reason in the payer's own terms, and the date this stops.
   */
  dunning_action_required: {
    subject: "Action needed: change your {{businessName}} payment details by {{deadline}}",
    heading: "We need new payment details",
    body: "Hi {{customerName}},\n\nWe could not collect {{amount}} for invoice {{invoiceNumber}}. Reason: {{declineMessage}}\n\nThe same payment method will fail again, so we will not retry it. To pay this invoice, add a new payment method or change your current one.\n\nYou can add one with the button below. Pay this invoice by {{deadline}}. If your team needs more time for an approval, or wants to pay in a different way, contact us before then.",
  },
  // RBI/NPCI: a mandate debit above ₹15,000 stops and waits for the payer's
  // additional-factor authentication. We CANNOT send the authentication link — the
  // issuing bank generates and sends it — so this mail must not pretend to. Its job
  // is to tell the customer the request is real, that it expires, and that paying
  // through the portal settles it if the bank's link never arrives or has lapsed.
  // The URL itself is never written into the text; the button carries it.
  payment_authentication_required: {
    subject: "Approve your {{amount}} payment to {{businessName}}",
    heading: "Your bank needs your approval",
    body: "Hi {{customerName}},\n\nWe requested {{amount}}. Your bank needs your approval before it can take the payment.\n\nYour bank may send you the request by SMS, by email, or in your banking or UPI app. This depends on your payment method. You can also complete the payment with the button below.",
  },
  subscription_canceled_nonpayment: {
    subject: "Your {{businessName}} subscription ended",
    heading: "Your subscription ended",
    body: "Hi {{customerName}},\n\nWe could not collect payment for your subscription, so we canceled it.\n\nOften this is not intentional. For example, your bank replaced your card, or an approval did not complete. If you want to continue with {{businessName}}, contact us and we will start your subscription again.",
  },

  // ── invoicing & payments ────────────────────────────────────────────────────
  invoice_overdue: {
    subject: "Invoice {{invoiceNumber}} for {{amount}} is past due",
    heading: "Your invoice is past due",
    body: "Hi {{customerName}},\n\nInvoice {{invoiceNumber}} for {{amount}} was due on {{dueDate}}. We did not receive payment yet.\n\nYou can pay it with the button below. If you already paid, thank you. You can ignore this reminder. If there is a problem with the invoice, contact us and we will correct it.",
  },
  // Accepted by the provider, not yet settled. The wording promises only what has actually
  // happened — a refund was started — because this mail can land days before the money does.
  refund_initiated: {
    subject: "We started your refund of {{refundAmount}}",
    heading: "We started your refund",
    body: "Hi {{customerName}},\n\nWe started a refund of {{refundAmount}} to the payment method that you paid with.\n\nBanks and card issuers usually need a few working days to complete a refund. It may not show on your statement immediately. If you do not receive it after ten working days, contact us and we will investigate.",
  },
  refund_issued: {
    subject: "We sent your refund of {{refundAmount}}",
    heading: "We sent your refund",
    body: "Hi {{customerName}},\n\nWe sent your refund of {{refundAmount}}. It can take a few working days to show on your statement. This depends on your bank.\n\nIf you do not see it after one week, contact us and we will investigate.",
  },
  credit_note_issued: {
    subject: "Credit note {{creditNoteNumber}} for {{creditAmount}} from {{businessName}}",
    heading: "A credit for your account",
    body: "Hi {{customerName}},\n\nWe issued credit note {{creditNoteNumber}} for {{creditAmount}} to your account. The details are below. You can forward this email to your accounts team for their records.",
  },
  credit_note_applied: {
    subject: "We applied a {{creditAmount}} credit to invoice {{invoiceNumber}}",
    heading: "We applied your credit",
    body: "Hi {{customerName}},\n\nWe applied credit note {{creditNoteNumber}} to invoice {{invoiceNumber}}. This decreases the amount due on the invoice by {{creditAmount}}. The details are below for your records.",
  },

  // ── subscription lifecycle ──────────────────────────────────────────────────
  subscription_activated: {
    subject: "Your {{businessName}} subscription is active",
    heading: "Your subscription is active",
    body: "Hi {{customerName}},\n\nThank you for choosing {{businessName}}. Your {{planName}} subscription is now active. Your next renewal is on {{renewalDate}}.\n\nIf you need help as you start, contact us.",
  },
  subscription_changed: {
    subject: "Your {{businessName}} plan changed",
    heading: "Your plan changed",
    body: "Hi {{customerName}},\n\nYour subscription is now on {{planName}}.\n\nIf you did not expect this change, contact us and we will investigate immediately.",
  },
  subscription_renewed: {
    subject: "Your {{businessName}} subscription renewed",
    heading: "Your subscription renewed",
    body: "Hi {{customerName}},\n\nThank you for continuing with us. Your {{planName}} subscription renewed. Your next renewal is on {{renewalDate}}.\n\nIf your account needs changes for this term, contact us. For example, a different invoice recipient or new billing details.",
  },
  subscription_paused: {
    subject: "Your {{businessName}} subscription is paused",
    heading: "Your subscription is paused",
    body: "Hi {{customerName}},\n\nYour {{planName}} subscription is paused from {{pauseDate}}. We do not bill you while it is paused.\n\nWhen you want to continue, contact us and we will resume it for you.",
  },
  subscription_resumed: {
    subject: "Your {{businessName}} subscription resumed",
    heading: "Welcome back",
    body: "Hi {{customerName}},\n\nWe are glad to have you back. Your {{planName}} subscription resumed on {{resumeDate}}. Billing continues as usual. Your next renewal is on {{renewalDate}}.",
  },
  subscription_canceled: {
    subject: "Your {{businessName}} subscription is canceled",
    heading: "Your subscription is canceled",
    body: "Hi {{customerName}},\n\nThis email confirms that your {{planName}} subscription is canceled. It ends on {{cancelDate}}.\n\nIf we could do something better, tell us. If you want to return, contact us and we will start your subscription again.",
  },

  // ── payment method ──────────────────────────────────────────────────────────
  card_expiring: {
    subject: "Your card ending {{cardLast4}} expires soon",
    heading: "Your card expires soon",
    body: "Hi {{customerName}},\n\nThe {{cardBrand}} card ending {{cardLast4}} that we charge for your subscription expires {{cardExpiry}}.\n\nTo prevent a failed payment, add your new card with the button below. If you already changed your card, you can ignore this email.",
  },
  card_expired: {
    subject: "Your card ending {{cardLast4}} is expired",
    heading: "Your card is expired",
    body: "Hi {{customerName}},\n\nThe {{cardBrand}} card ending {{cardLast4}} that we charge for your subscription is expired. Your next payment will fail.\n\nTo keep your subscription active, add a new card with the button below.",
  },
  // Deliberately does NOT name a date or an expiry: the instrument was refused, which is
  // not the same as "your card ran out" and telling a customer their card expired when it
  // did not sends them looking for a problem that is not there.
  payment_method_invalid: {
    subject: "We can no longer charge your {{paymentMethodType}}",
    heading: "Your payment method needs attention",
    body: "Hi {{customerName}},\n\nWe can no longer charge your {{paymentMethodType}}. This can occur for different reasons. You can usually correct it.\n\nTo keep your subscription active, add a new payment method with the button below.",
  },
  // Rail-neutral, and deliberately so: fires for card, UPI Autopay and e-mandate alike
  // (`emails/outbox.ts` routes here whenever `expiry_reason === 'mandate'`). Names
  // neither a card nor a date — a card mandate's own printed expiry is routinely years
  // away even after its MANDATE has lapsed, and a upi/emandate instrument has no printed
  // expiry to name at all. The one thing that clears it is a fresh authorization, so
  // that is the one thing the body asks for.
  mandate_expired: {
    subject: "Renew your automatic payment authorization with {{businessName}}",
    heading: "Your automatic payment authorization ended",
    body: "Hi {{customerName}},\n\nThe authorization that lets us collect your subscription payments automatically is no longer active. Your payment method is not the problem. Only the permission to charge it automatically needs renewal.\n\nUse the button below to give a new authorization, so that we can collect your next payment.",
  },

  // ── trial lifecycle ─────────────────────────────────────────────────────────
  trial_started: {
    subject: "Welcome to {{businessName}}: your trial started",
    heading: "Welcome",
    body: "Hi {{customerName}},\n\nWelcome! Your {{planName}} trial started. It continues until {{trialEndDate}}. We do not charge you during the trial.\n\nIf you have a question or a problem, contact us. We want you to try it fully before you decide.",
  },
  trial_expired: {
    subject: "Your {{businessName}} trial ended",
    heading: "Your trial ended",
    body: "Hi {{customerName}},\n\nYour {{planName}} trial ended on {{trialEndDate}}. Thank you for trying us.\n\nIf you want to continue, contact us and we will help you start. If something stopped you, tell us about it.",
  },
  trial_extended: {
    subject: "We extended your {{businessName}} trial to {{trialEndDate}}",
    heading: "You have more time",
    body: "Hi {{customerName}},\n\nWe extended your {{planName}} trial. It now continues until {{trialEndDate}}. You do not have to do anything.",
  },

  // ── time-relative reminders ─────────────────────────────────────────────────
  // These name the date, never "in N days": the count is whole days and "in 1 days" is
  // exactly the tell of a machine.
  trial_ending: {
    subject: "Your {{businessName}} trial ends on {{trialEndDate}}",
    heading: "Your trial ends soon",
    body: "Hi {{customerName}},\n\nYour {{planName}} trial ends on {{trialEndDate}}.\n\nIf you want to change plans or have a question before then, contact us.",
  },
  renewal_reminder: {
    subject: "Your {{businessName}} subscription renews on {{renewalDate}}",
    heading: "Your renewal is soon",
    body: "Hi {{customerName}},\n\nYour {{planName}} subscription renews on {{renewalDate}}.\n\nIf you want to change your plan, cancel, or change your billing details, contact us before {{renewalDate}}.",
  },
  // NPCI/RBI pre-debit notice. The three facts the rule requires — amount, date and
  // mandate reference — are all in the body on purpose; this mail is a compliance
  // artifact before it is a courtesy, and an operator editing it must be able to see
  // what may not be removed. `{{amount}}` is absent when the rate is unknown, and the
  // wording falls back rather than showing a false ₹0.00.
  pre_debit_notification: {
    subject: "Upcoming automatic payment on {{debitDate}}",
    heading: "Advance notice of your next payment",
    body: 'Hi {{customerName}},\n\nThis is advance notice of an automatic payment. On {{debitDate}}, {{businessName}} will automatically debit {{amount | default: "your subscription amount"}} for your {{planName}} subscription. We use your {{mandateRail}} mandate (reference {{mandateReference}}).\n\nIf you agree to this payment, you do not have to do anything. {{#if achDebit}}To stop this payment, tell us, or remove the bank account in your billing portal, at least 3 business days before {{debitDate}}.{{else}}To stop this payment, cancel the mandate with your bank, or in the app that you used to create it, before {{debitDate}}.{{/if}} This also stops all future automatic payments. If you only have a question about this payment, contact us first.',
  },
  // Reg E 12 CFR 1005.10(b): whoever takes the authorization gives the payer a copy.
  // `{{authorizationText}}` is the stored text, never a fresh rendering.
  ach_authorization_copy: {
    subject: "Your bank debit authorization for {{businessName}}",
    heading: "Your copy of the bank debit authorization",
    body: "Hi {{customerName}},\n\nYou authorized {{businessName}} to debit your bank account{{#if cardLast4}} ending {{cardLast4}}{{/if}}. This is your copy of the authorization. You accepted version {{authorizationVersion}} on {{acceptedAt}}.\n\n{{authorizationText}}\n\nTo cancel this authorization, tell {{businessName}}, or remove the bank account in your billing portal. Do this at least 3 business days before the next debit. Keep this email for your records.",
  },
  checkout_reminder: {
    subject: "Your {{businessName}} order is waiting",
    heading: "Complete your order",
    body: "Hi {{customerName}},\n\nYou started an order with {{businessName}} and did not complete it: {{orderSummary}}.\n\nTo complete your order, select the button. The link works for a limited time. If you do not want the order, you do not have to do anything.",
    ctaLabel: "Return to your order",
  },
  usage_alert: {
    subject: "Usage alert: {{alertSummary}}",
    heading: "Usage alert",
    body: "Hi {{customerName}},\n\n{{alertSummary}}. Your usage is now {{usageValue}}.{{#if limitValue}} The limit is {{limitValue}}.{{/if}}{{#if resetDate}} This resets on {{resetDate}}.{{/if}}\n\nIf you have a question about your usage, contact us.",
  },
  spend_limit_reached: {
    subject: "You reached your {{intervalLabel}} spend limit",
    heading: "Spend limit reached",
    body: "Hi {{customerName}},\n\nYour spend is {{usageValue}}. Your {{intervalLabel}} limit is {{limitValue}}.{{#if hardLimit}} We stop new requests until {{resetDate}}.{{else}} This is a notice only. Your service continues.{{/if}}\n\nTo change the limit, contact us.",
  },
  credit_auto_topup_failed: {
    subject: "We could not add credit to your account",
    heading: "Automatic top-up is off",
    body: "Hi {{customerName}},\n\nWe could not add credit to your account.{{#if declineReason}} Your bank declined the payment ({{declineReason}}).{{/if}} Automatic top-up is now off.\n\nUpdate your payment method, then turn on automatic top-up again.",
  },
  // Legal notice before an automatic top-up debits a mandate: amount, date and mandate
  // reference must stay in the body.
  credit_topup_debit_notice: {
    subject: "Upcoming automatic payment on {{debitDate}}",
    heading: "Advance notice of an automatic top-up",
    body: "Hi {{customerName}},\n\nWe will charge {{amount}} to your {{mandateRail}} mandate (reference {{mandateReference}}) on {{debitDate}} to add credit to your account.\n\nIf you agree to this payment, you do not have to do anything. To stop this payment, turn off automatic top-up in your billing portal, or cancel the mandate with your bank, before {{debitDate}}.",
  },
  // Only for an invoice nothing will charge (auto-collection off): it asks the customer to pay.
  payment_due_reminder: {
    subject: "Reminder: invoice {{invoiceNumber}} is due on {{dueDate}}",
    heading: "Your invoice is due soon",
    body: "Hi {{customerName}},\n\nInvoice {{invoiceNumber}} for {{amount}} is due on {{dueDate}}.\n\nYou can pay it with the button below. If you already paid, thank you. You can ignore this reminder.",
  },
  pause_reminder: {
    subject: "Your {{businessName}} subscription pauses on {{pauseDate}}",
    heading: "Your subscription pauses soon",
    body: "Hi {{customerName}},\n\nYour {{planName}} subscription pauses on {{pauseDate}}. We do not bill you while it is paused.\n\nIf you want to keep it active, contact us before {{pauseDate}}.",
  },
  resume_reminder: {
    subject: "Your {{businessName}} subscription resumes on {{resumeDate}}",
    heading: "Your subscription resumes soon",
    body: "Hi {{customerName}},\n\nYour {{planName}} subscription resumes on {{resumeDate}}. Billing continues from that date.\n\nIf you want to change this date, contact us before {{resumeDate}}.",
  },
  cancellation_reminder: {
    subject: "Your {{businessName}} subscription ends on {{cancelDate}}",
    heading: "Your subscription is ending",
    body: "Hi {{customerName}},\n\nYour {{planName}} subscription ends on {{cancelDate}}.\n\nIf you want to keep it, contact us before {{cancelDate}} and we will do this for you. If not, you do not have to do anything. Thank you for being our customer.",
  },

  // ── operator-initiated (ad-hoc) ─────────────────────────────────────────────
  // The operator's covering `{{note}}` sits on its own line, which is dropped when empty.
  invoice_sent: {
    subject: "Your invoice from {{businessName}}",
    heading: "Here is your invoice",
    body: "Hi {{customerName}},\n\n{{note}}\n\nThis is invoice {{invoiceNumber}} for {{amount}}, due on {{dueDate}}. The details are below. You can forward this email to your accounts team.",
  },
  payment_request: {
    subject: "Payment request from {{businessName}}, due {{dueDate}}",
    heading: "Payment request",
    body: "Hi {{customerName}},\n\n{{note}}\n\nInvoice {{invoiceNumber}} has {{amount}} to pay. It is due on {{dueDate}}.\n\nYou can pay it with the button below. If you already paid, thank you. You can ignore this request.",
  },
  payment_method_request: {
    subject: "Request to change your payment details for {{businessName}}",
    heading: "A request about your payment details",
    body: "Hi {{customerName}},\n\n{{note}}\n\nWe ask you to change the payment method on your account. This keeps your subscription active without interruption.\n\nThe button below opens the correct page.",
  },
  credit_note_sent: {
    subject: "Credit note {{creditNoteNumber}} from {{businessName}}",
    heading: "Your credit note",
    body: "Hi {{customerName}},\n\n{{note}}\n\nThis is credit note {{creditNoteNumber}} for {{creditAmount}}. The details are below. You can forward this email to your accounts team for their records.",
  },
  portal_sign_in_code: {
    subject: "Your sign-in code for {{businessName}}",
    heading: "Your sign-in code",
    body: "Use this code to sign in to your billing account:\n\n{{code}}\n\nThe code works for 10 minutes. If you did not ask for this code, you can ignore this email.",
    showFacts: false,
  },
};

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * One merge variable, as offered to the template editor.
 *
 * `always: false` means the outbox populates it only in some cases (an invoice number on
 * a payment email exists only when the payment is linked to an invoice). A missing key
 * renders EMPTY, silently — so the editor has to say which are conditional, or a merchant
 * writes "invoice {{invoiceNumber}}" and ships mail reading "invoice ".
 */
export interface TemplateVar {
  key: keyof RenderVars;
  always: boolean;
}

/** Set on every type — so the only variables a business-wide footer may use. */
export const COMMON_TEMPLATE_VARS: TemplateVar[] = [
  { key: "businessName", always: true },
  { key: "customerName", always: true },
  // Always set: falls back to the dashboard origin (portal-link.ts), so templates may say
  // "the button below" without a guard.
  { key: "portalUrl", always: true },
];

/**
 * Which variables each type actually populates — read off resolveRecipient in outbox.ts,
 * not guessed. Advertising a variable the outbox never sets would be the same defect as
 * shipping a control with no backend field.
 */
export const TEMPLATE_VARS: Record<EmailType, TemplateVar[]> = {
  // An offline invoice always has a due date: a null one means "due on issue".
  invoice_to_pay: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "invoiceNumber", always: true },
    { key: "currency", always: true },
    { key: "dueDate", always: true },
  ],
  invoice_issued: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "invoiceNumber", always: true },
    { key: "currency", always: true },
  ],
  invoice_overdue: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "invoiceNumber", always: true },
    { key: "dueDate", always: true },
    { key: "currency", always: true },
    // The method a failed charge used. Empty when nothing was charged (a send-invoice
    // invoice), so guard it: "{{#if paymentMethodType}}…{{/if}}".
    { key: "paymentMethodType", always: false },
  ],
  payment_receipt: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "currency", always: false },
    { key: "invoiceNumber", always: false },
  ],
  payment_failed: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "currency", always: false },
    { key: "declineMessage", always: true },
    { key: "invoiceNumber", always: false },
    /**
     * `always: false`, and it is carried on the FACTS CARD rather than in the body.
     *
     * Most failures arm a retry and carry a date; one that parked, exhausted or hit a
     * merchant's stop does not. A bare body sentence would render "We'll try again on ."
     * at a customer, so the built-in leaves it to the card, where `add()` drops a blank row.
     */
    { key: "nextAttemptDate", always: false },
    // The method the failed charge used, in the payer's words.
    { key: "paymentMethodType", always: false },
  ],
  dunning_action_required: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "invoiceNumber", always: true },
    { key: "currency", always: true },
    // Why we cannot retry, in the payer's terms. `always` — an "update your details"
    // with no reason is the mail people ignore, and the decline vocabulary always has one.
    { key: "declineMessage", always: true },
    // The date the subscription ends. `always`, because it is what makes this a reminder
    // with a consequence rather than a nag, and a blank there reads as no deadline at all.
    { key: "deadline", always: true },
  ],
  // `amount` is `always` here where payment_failed marks it optional: this event is
  // emitted only from bookPending, which always knows the amount it just charged.
  payment_authentication_required: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "currency", always: true },
    { key: "invoiceNumber", always: false },
    { key: "mandateRail", always: false },
  ],
  refund_initiated: [
    ...COMMON_TEMPLATE_VARS,
    { key: "refundAmount", always: true },
    { key: "currency", always: true },
    { key: "invoiceNumber", always: false },
  ],
  refund_issued: [
    ...COMMON_TEMPLATE_VARS,
    { key: "refundAmount", always: true },
    { key: "currency", always: true },
    { key: "invoiceNumber", always: false },
  ],
  credit_note_issued: [
    ...COMMON_TEMPLATE_VARS,
    { key: "creditNoteNumber", always: true },
    { key: "creditAmount", always: true },
    { key: "currency", always: true },
  ],
  credit_note_applied: [
    ...COMMON_TEMPLATE_VARS,
    { key: "creditNoteNumber", always: true },
    { key: "creditAmount", always: true },
    { key: "invoiceNumber", always: true },
    { key: "currency", always: true },
  ],

  subscription_activated: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "renewalDate", always: true },
  ],
  subscription_changed: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    // Empty while a cancellation is scheduled: it will not renew.
    { key: "renewalDate", always: false },
  ],
  subscription_renewed: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "renewalDate", always: true },
    { key: "amount", always: false },
  ],
  subscription_paused: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "pauseDate", always: true },
  ],
  subscription_resumed: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "resumeDate", always: true },
    { key: "renewalDate", always: true },
  ],
  subscription_canceled: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "cancelDate", always: true },
    { key: "reason", always: false },
  ],
  subscription_canceled_nonpayment: [...COMMON_TEMPLATE_VARS, { key: "reason", always: false }],

  card_expiring: [
    ...COMMON_TEMPLATE_VARS,
    { key: "cardBrand", always: true },
    { key: "cardLast4", always: true },
    { key: "cardExpiry", always: true },
  ],
  card_expired: [
    ...COMMON_TEMPLATE_VARS,
    { key: "cardBrand", always: true },
    { key: "cardLast4", always: true },
    { key: "cardExpiry", always: true },
  ],
  // `cardBrand`/`cardLast4` are `always: false` here where the two above mark them true:
  // this fires for any refused instrument, and a UPI mandate or a wallet has no brand and
  // no last four. `paymentMethodType` is the one thing every rail can name.
  payment_method_invalid: [
    ...COMMON_TEMPLATE_VARS,
    { key: "paymentMethodType", always: true },
    { key: "cardBrand", always: false },
    { key: "cardLast4", always: false },
  ],
  // No `cardBrand`/`cardLast4` here at all, unlike `payment_method_invalid` above: this
  // fires for the SAME rails that carry no printed instrument identity as often as not
  // (upi, emandate), and the body never names the card either — see the template.
  mandate_expired: [...COMMON_TEMPLATE_VARS, { key: "paymentMethodType", always: true }],

  // Trial lifecycle. `trialEndDate` is `always` on all three: it is the date the mail is
  // about, and a trial email that cannot name its own date is not worth sending.
  trial_started: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "trialEndDate", always: true },
  ],
  trial_expired: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "trialEndDate", always: true },
  ],
  trial_extended: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "trialEndDate", always: true },
  ],

  trial_ending: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "trialEndDate", always: true },
    { key: "daysUntil", always: true },
  ],
  renewal_reminder: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "renewalDate", always: true },
    { key: "daysUntil", always: true },
    { key: "amount", always: false },
  ],
  cancellation_reminder: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "cancelDate", always: true },
    { key: "daysUntil", always: true },
  ],
  payment_due_reminder: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "invoiceNumber", always: true },
    { key: "dueDate", always: true },
    { key: "daysUntil", always: true },
    { key: "currency", always: true },
  ],
  pause_reminder: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "pauseDate", always: true },
    { key: "daysUntil", always: true },
  ],
  resume_reminder: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "resumeDate", always: true },
    { key: "daysUntil", always: true },
  ],
  checkout_reminder: [
    ...COMMON_TEMPLATE_VARS,
    { key: "orderSummary", always: true },
    { key: "amount", always: false },
  ],
  ach_authorization_copy: [
    ...COMMON_TEMPLATE_VARS,
    { key: "authorizationText", always: true },
    { key: "authorizationVersion", always: true },
    { key: "acceptedAt", always: true },
    { key: "cardLast4", always: false },
  ],
  usage_alert: [
    ...COMMON_TEMPLATE_VARS,
    { key: "alertSummary", always: true },
    { key: "usageValue", always: true },
    { key: "limitValue", always: false },
    { key: "resetDate", always: false },
  ],
  spend_limit_reached: [
    ...COMMON_TEMPLATE_VARS,
    { key: "usageValue", always: true },
    { key: "limitValue", always: true },
    { key: "intervalLabel", always: true },
    { key: "resetDate", always: true },
    { key: "hardLimit", always: false },
  ],
  credit_auto_topup_failed: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "declineReason", always: false },
  ],
  credit_topup_debit_notice: [
    ...COMMON_TEMPLATE_VARS,
    { key: "amount", always: true },
    { key: "debitDate", always: true },
    { key: "mandateRail", always: true },
    { key: "mandateReference", always: true },
  ],
  pre_debit_notification: [
    ...COMMON_TEMPLATE_VARS,
    { key: "planName", always: true },
    { key: "subscriptionId", always: true },
    { key: "debitDate", always: true },
    { key: "daysUntil", always: true },
    { key: "mandateRail", always: true },
    { key: "mandateReference", always: true },
    { key: "achDebit", always: false },
    // Absent when the recurring rate is unknown — see the resolver.
    { key: "amount", always: false },
  ],

  invoice_sent: [
    ...COMMON_TEMPLATE_VARS,
    { key: "invoiceNumber", always: true },
    { key: "amount", always: true },
    { key: "currency", always: true },
    { key: "dueDate", always: true },
    { key: "note", always: false },
  ],
  payment_request: [
    ...COMMON_TEMPLATE_VARS,
    { key: "invoiceNumber", always: true },
    { key: "amount", always: true },
    { key: "dueDate", always: true },
    { key: "currency", always: true },
    { key: "note", always: false },
  ],
  payment_method_request: [...COMMON_TEMPLATE_VARS, { key: "note", always: false }],
  portal_sign_in_code: [...COMMON_TEMPLATE_VARS, { key: "code", always: true }],
  credit_note_sent: [
    ...COMMON_TEMPLATE_VARS,
    { key: "creditNoteNumber", always: true },
    { key: "creditAmount", always: true },
    { key: "currency", always: true },
    { key: "note", always: false },
  ],
};

/**
 * Placeholder values for a preview or a test send — every optional key of RenderVars, so
 * no template renders a blank where a real send would show a value. Recognisably fake on
 * purpose: a test that borrowed a real customer's name and amount would be
 * indistinguishable from genuine billing mail if it reached the wrong inbox.
 *
 * Lives here, beside RenderVars, because the preview path and the test-send path both
 * need it and two copies would drift the moment a variable is added — which is exactly
 * how a preview starts showing blanks for a type that sends fine.
 */
export const SAMPLE_RENDER_VARS: Omit<RenderVars, "businessName"> = {
  customerName: "Sample Customer",
  // Preview only; a sent sign-in email always carries the engine's code.
  code: "123456",
  invoiceNumber: "INV-0001",
  amount: formatMoney(499900, "USD"),
  currency: "USD",
  reason: "card_declined",
  declineMessage: "Your card was declined by the issuing bank.",
  portalUrl: "https://billing.example.com/portal/sample",
  planName: "Pro (monthly)",
  subscriptionId: "sub_sample000000000000",
  renewalDate: "1 September 2026",
  trialEndDate: "15 August 2026",
  pauseDate: "20 August 2026",
  resumeDate: "20 September 2026",
  cancelDate: "30 September 2026",
  dueDate: "25 August 2026",
  daysUntil: "5",
  cardBrand: "Visa",
  cardLast4: "4242",
  cardExpiry: "08/2027",
  paymentMethodType: "card",
  creditNoteNumber: "CN-0001",
  creditAmount: formatMoney(120000, "USD"),
  refundAmount: formatMoney(250000, "USD"),
  note: "Adding a short note so you can see where yours appears.",
  deadline: "10 September 2026",
  nextAttemptDate: "28 August 2026",
  debitDate: "1 September 2026",
  mandateReference: "MANDATE-SAMPLE-0001",
  mandateRail: "UPI Autopay",
  authorizationText:
    "Bank account debit authorization\n\nI authorize the business to debit the bank account that I enter in the next step.",
  authorizationVersion: "ach-debit-2026-10-29",
  acceptedAt: "1 September 2026, 10:00 UTC",
  alertSummary: "You used 80% of your monthly spend limit",
  usageValue: formatMoney(40000, "USD"),
  limitValue: formatMoney(50000, "USD"),
  intervalLabel: "monthly",
  resetDate: "1 September 2026",
  hardLimit: "yes",
  declineReason: "insufficient funds",
};

/**
 * The sample values a preview or test send of `type` may use: the ones the outbox can
 * fill for that type. A template variable only another type receives is left out, so a
 * preview shows the same blank a real send would, instead of a value no customer sees.
 */
export function sampleVarsFor(type: EmailType): Omit<RenderVars, "businessName"> {
  const allowed = new Set<string>(TEMPLATE_VARS[type].map((v) => v.key));
  const templated = new Set<string>(
    Object.values(TEMPLATE_VARS).flatMap((vars) => vars.map((v) => v.key)),
  );
  return Object.fromEntries(
    Object.entries(SAMPLE_RENDER_VARS).filter(([k]) => allowed.has(k) || !templated.has(k)),
  ) as Omit<RenderVars, "businessName">;
}

/** What the editor calls each variable. Keys without an entry fall back to the key. */
export const VAR_LABELS: Partial<Record<keyof RenderVars, string>> = {
  businessName: "Business name",
  customerName: "Customer name",
  portalUrl: "Billing portal link",
  amount: "Amount",
  invoiceNumber: "Invoice number",
  currency: "Currency",
  reason: "Reason code",
  declineMessage: "Decline message",
  planName: "Plan",
  subscriptionId: "Subscription ID",
  renewalDate: "Renewal date",
  trialEndDate: "Trial end date",
  pauseDate: "Pause date",
  resumeDate: "Resume date",
  cancelDate: "Cancellation date",
  dueDate: "Due date",
  debitDate: "Debit date",
  alertSummary: "Alert summary",
  usageValue: "Usage now",
  limitValue: "Limit",
  intervalLabel: "Limit interval",
  resetDate: "Reset date",
  hardLimit: "Hard limit",
  declineReason: "Decline reason",
  mandateReference: "Mandate reference",
  mandateRail: "Mandate type",
  achDebit: "ACH debit",
  authorizationText: "Authorization text",
  authorizationVersion: "Authorization version",
  acceptedAt: "Accepted at",
  daysUntil: "Days until",
  deadline: "Deadline",
  nextAttemptDate: "Next attempt date",
  cardBrand: "Card brand",
  cardLast4: "Card last 4",
  cardExpiry: "Card expiry",
  paymentMethodType: "Payment method type",
  creditNoteNumber: "Credit note number",
  creditAmount: "Credit amount",
  refundAmount: "Refund amount",
  note: "Operator note",
};

/**
 * The chrome around every billing email: brand header, heading, body, optional call
 * to action, sign-off rule.
 *
 * Extracted because this markup existed twice (here and in the magic-link email) and
 * had already diverged by a `<p>`. It is also the ONE place a brand lands in mail —
 * merchant-editable bodies are escaped text, so the logo and the button colour can
 * only come from here, which is what stops a template edit from breaking them.
 *
 * Inline styles and a table-free single column on purpose: mail clients strip
 * stylesheets, and this has to survive Gmail, Outlook and a phone.
 */
function brandedShell(opts: {
  vars: Pick<RenderVars, "businessName" | "logoUrl" | "iconUrl" | "brandColor">;
  heading: string;
  bodyHtml: string;
  /** The template's footer text, already rendered. */
  footerHtml?: string;
  /** Section order; defaults to body, button, card. */
  order?: BlockKey[];
  cta?: { href: string; label: string };
  footnote?: string;
  /** The facts card — label/value rows the engine owns. */
  facts?: Array<{ label: string; value: string }>;
}): string {
  const { vars, heading, bodyHtml, cta, footnote, facts } = opts;
  const order = opts.order ?? BLOCK_ORDER_DEFAULT;
  // A hex colour validated at the write layer (`^#[0-9a-fA-F]{6}$`), re-checked here
  // because this string is interpolated straight into a style attribute and this
  // function is also reachable from the preview paths, which take caller-supplied vars.
  const brand =
    vars.brandColor && /^#[0-9a-fA-F]{6}$/.test(vars.brandColor) ? vars.brandColor : "#111111";
  // Wordmark first, square mark second, business NAME last. Never both images: two
  // logos stacked in a mail header reads as a rendering fault.
  const mark = vars.logoUrl ?? vars.iconUrl;
  const header = mark
    ? `<p style="margin:0 0 20px"><img src="${escapeHtml(mark)}" alt="${escapeHtml(vars.businessName)}" style="max-height:40px;max-width:200px;display:block;border:0"></p>`
    : `<p style="margin:0 0 20px;font-size:15px;font-weight:600;color:#111">${escapeHtml(vars.businessName)}</p>`;
  // The card. A bordered block of label/value rows, one per line — the shape that
  // survives a narrow phone, where a two-column table would either wrap badly or force a
  // horizontal scroll. Rows with an empty value are dropped rather than rendered blank;
  // see the `facts` docstring.
  const rows = (facts ?? []).filter((f) => f.label && f.value);
  const card = rows.length
    ? [
        '<div style="border:1px solid #eee;border-radius:6px;padding:4px 16px;margin:24px 0">',
        ...rows.map(
          (f) =>
            `<p style="margin:12px 0;font-size:14px"><span style="color:#999;display:block;font-size:12px">${escapeHtml(f.label)}</span><b style="color:#222">${escapeHtml(f.value)}</b></p>`,
        ),
        "</div>",
      ].join("")
    : "";
  const sections: Record<BlockKey, string> = {
    body: `<div style="font-size:14px;line-height:1.6">${bodyHtml}</div>`,
    footer: opts.footerHtml
      ? `<div style="font-size:14px;line-height:1.6;margin:24px 0 0">${opts.footerHtml}</div>`
      : "",
    action: cta
      ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.href)}" style="background:${brand};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta.label)}</a></p>`
      : "",
    facts: card,
  };
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">',
    header,
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h2>`,
    // Button before card by default: the action is the point of the email, the numbers
    // are the justification for it. A merchant may reorder all four.
    ...order.map((k) => sections[k]),
    footnote ? `<p style="font-size:12px;color:#999">${escapeHtml(footnote)}</p>` : "",
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0"><p style="font-size:12px;color:#999">${escapeHtml(vars.businessName)}</p>`,
    "</div>",
  ].join("");
}

/**
 * Render one email. `override` is a business's stored template; omit it (or pass null)
 * to use the built-in. A merchant controls the words, the section order and whether the
 * facts card shows; the shell (logo, colours, button URL, footer) stays engine-owned.
 */
export function renderEmail(
  type: EmailType,
  vars: RenderVars,
  override?: TemplateDef | null,
): RenderedEmail {
  const def = override ?? DEFAULT_TEMPLATES[type];
  const dict = vars as unknown as Record<string, unknown>;
  const subject = renderText(def.subject, dict);
  // Sanitise → sections → fill, never fill first: see template-lang.ts. Filling first
  // would let a customer's name or an operator's note smuggle markup that the sanitiser
  // then blesses as merchant-authored.
  const bodyHtmlInner = renderBody(def.body, dict);
  // Derived from the SAME sanitised markup, so the two halves of the message can never
  // disagree about what the merchant wrote.
  const bodyText = emailHtmlToText(bodyHtmlInner);
  const footerHtml = renderBody(resolveFooter(def, vars.footerNote), dict);
  // The button, and ONLY when there is a real next step: a type with no `action` renders
  // none, whatever the template says. The merchant owns the words, never the URL.
  const label = def.ctaLabel ? renderText(def.ctaLabel, dict).trim() : "";
  const cta = vars.action
    ? { href: vars.action.url, label: label || vars.action.label }
    : undefined;
  const facts = def.showFacts === false ? undefined : vars.facts?.filter((f) => f.label && f.value);
  const order = isBlockOrder(def.blockOrder) ? def.blockOrder : BLOCK_ORDER_DEFAULT;
  const html = brandedShell({
    vars,
    heading: renderText(def.heading, dict),
    bodyHtml: bodyHtmlInner,
    footerHtml,
    order,
    ...(cta ? { cta } : {}),
    ...(facts?.length ? { facts } : {}),
  });
  // The text half follows the same order, so a plain-text reader gets the same email.
  const textBlocks: Record<BlockKey, string> = {
    body: bodyText,
    action: cta ? `${cta.label}: ${cta.href}` : "",
    facts: (facts ?? []).map((f) => `${f.label}: ${f.value}`).join("\n\n"),
    footer: footerHtml ? emailHtmlToText(footerHtml) : "",
  };
  const text = order
    .map((k) => textBlocks[k])
    .filter(Boolean)
    .join("\n\n");
  return { subject, html, text };
}

/**
 * What a type's layout can actually contain, so the editor offers only controls that do
 * something: no button-label field on an email that never has a button.
 */
export function templateCapabilities(type: EmailType): {
  defaultCtaLabel: string | null;
  hasFacts: boolean;
} {
  const probe = { ...SAMPLE_RENDER_VARS, businessName: "", invoicePayable: true };
  const b = blocksFor(type, probe);
  return { defaultCtaLabel: b.action?.label ?? null, hasFacts: !!b.facts?.length };
}

const PAY_TYPES = new Set<EmailType>([
  "invoice_to_pay",
  "invoice_overdue",
  "payment_due_reminder",
  "payment_failed",
  "payment_authentication_required",
  "payment_request",
]);
const FIX_INSTRUMENT_TYPES = new Set<EmailType>([
  "card_expiring",
  "card_expired",
  "payment_method_invalid",
  "mandate_expired",
  "payment_method_request",
  /**
   * "Update payment method", not "Pay now" — the button must agree with the body, which
   * says the invoice needs a new instrument and will not be retried. A parked invoice IS
   * payable in the portal, so "Pay now" would not be false, but it points at the one
   * action that settles this invoice and leaves the next renewal to fail the same way.
   * Updating the instrument settles both: `collect_on_payment_method_update` (default on)
   * charges the open invoice the moment the customer adds one.
   */
  "dunning_action_required",
]);

/** A stored card network ("visa", "american_express") as printed on the card. */
export function brandWords(brand: string | null | undefined): string | undefined {
  const b = brand?.trim().toLowerCase();
  if (!b || b === "other" || b === "unknown") return undefined;
  const names: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    american_express: "American Express",
    amex: "American Express",
    rupay: "RuPay",
    discover: "Discover",
    diners: "Diners Club",
    diners_club: "Diners Club",
    jcb: "JCB",
    unionpay: "UnionPay",
    maestro: "Maestro",
  };
  return names[b] ?? b.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase());
}

/**
 * Build the facts card and the action button for one email, from the vars the
 * per-type resolver already produced.
 *
 * Derived centrally rather than in each of the fourteen resolvers: the mapping from
 * "which facts does this email state" to "which vars hold them" is one table, and a
 * table is reviewable in a way fourteen scattered literals are not.
 *
 * Every row is conditional on the var being present. A card line with a blank value
 * reads to the customer as a bug, so a fact we do not have is a fact we do not print —
 * the same rule that forbids dead controls in the dashboard. That is why there is no
 * "Status" row: nothing in `RenderVars` backs it. "Amount due" appears only where the
 * resolver puts the amount due in `amount` (`payment_due_reminder`).
 */
export function blocksFor(
  emailType: EmailType,
  v: RenderVars,
): {
  facts?: Array<{ label: string; value: string }>;
  /** `kind`: the task the button names, so its portal link can open on that task (4b). */
  action?: { label: string; url: string; kind?: "pay_invoice" | "update_card" };
} {
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string | undefined): void => {
    if (value) rows.push({ label, value });
  };
  const card = v.cardBrand && v.cardLast4 ? `${v.cardBrand} ···${v.cardLast4}` : undefined;
  // The rail words are written for mid-sentence ("your card"); a facts row starts with them.
  const method = (words: string | undefined) => words && words[0]!.toUpperCase() + words.slice(1);

  switch (emailType) {
    case "invoice_issued":
    case "invoice_sent":
      add("Invoice", v.invoiceNumber);
      add("Invoiced amount", v.amount);
      break;
    case "invoice_to_pay":
      add("Invoice", v.invoiceNumber);
      add("Invoiced amount", v.amount);
      add("Due date", v.dueDate);
      break;
    case "invoice_overdue":
      add("Invoice", v.invoiceNumber);
      add("Invoiced amount", v.amount);
      add("Due since", v.dueDate);
      break;
    case "payment_due_reminder":
      add("Invoice", v.invoiceNumber);
      add("Amount due", v.amount);
      add("Due date", v.dueDate);
      break;
    case "payment_receipt":
      add("Amount paid", v.amount);
      add("Invoice", v.invoiceNumber);
      add("Payment method", card);
      break;
    case "payment_failed":
    case "payment_request":
      add("Invoiced amount", v.amount);
      add("Invoice", v.invoiceNumber);
      // The method that was tried, in words, when there is no card number to show.
      add("Payment method", card ?? method(v.paymentMethodType));
      add("Due since", v.dueDate);
      add("Failure reason", v.declineMessage);
      // Absent whenever no retry was armed — parked, exhausted, or a merchant's stop —
      // and `add` drops a blank row, so the card never promises an attempt that is not
      // coming. `payment_request` shares this case and never sets it.
      add("Next attempt", v.nextAttemptDate);
      break;
    case "payment_authentication_required":
      add("Amount", v.amount);
      add("Invoice", v.invoiceNumber);
      add("Payment method", card ?? method(v.mandateRail));
      break;
    case "refund_initiated":
      // "Refund started", not "Refunded": the facts card must not assert the settlement the
      // body is careful not to claim.
      add("Refund started", v.refundAmount);
      add("Invoice", v.invoiceNumber);
      break;
    case "refund_issued":
      add("Refunded", v.refundAmount);
      add("Invoice", v.invoiceNumber);
      break;
    case "credit_note_issued":
    case "credit_note_applied":
    case "credit_note_sent":
      add("Credit note", v.creditNoteNumber);
      add("Amount", v.creditAmount);
      add("Invoice", v.invoiceNumber);
      break;
    case "subscription_activated":
    case "subscription_changed":
      add("Plan", v.planName);
      add("Next renewal", v.renewalDate);
      break;
    // The amount rides in the card, which drops the row when there was no estimate.
    case "subscription_renewed":
    case "renewal_reminder":
      add("Plan", v.planName);
      add("Amount", v.amount);
      add("Next renewal", v.renewalDate);
      break;
    case "subscription_paused":
    case "pause_reminder":
      add("Plan", v.planName);
      add("Paused from", v.pauseDate);
      break;
    case "subscription_resumed":
    case "resume_reminder":
      add("Plan", v.planName);
      add("Resumes", v.resumeDate);
      break;
    case "subscription_canceled":
    case "subscription_canceled_nonpayment":
    case "cancellation_reminder":
      add("Plan", v.planName);
      add("Ends", v.cancelDate);
      break;
    case "trial_ending":
    case "trial_started":
    case "trial_extended":
      add("Plan", v.planName);
      add("Trial ends", v.trialEndDate);
      break;
    case "trial_expired":
      add("Plan", v.planName);
      add("Trial ended", v.trialEndDate);
      break;
    case "card_expiring":
    case "card_expired":
    case "payment_method_request":
      add("Card", card);
      add("Expires", v.cardExpiry);
      break;
    // No expiry row: this fires for a refused instrument, which may have no expiry at
    // all (a mandate) and whose expiry is not why it failed in any case.
    case "payment_method_invalid":
      add("Payment method", card ?? method(v.paymentMethodType));
      break;
    // Deliberately NO card/brand row and no expiry, even when the rail happens to be a
    // card: this template's whole point is that the AUTHORIZATION lapsed, not the
    // instrument, and printing "Visa ···4242" here would invite the reader to read this
    // as a card problem.
    case "mandate_expired":
      add("Payment method", method(v.paymentMethodType));
      break;
    case "ach_authorization_copy":
      add("Bank account", v.cardLast4 ? `···${v.cardLast4}` : undefined);
      add("Version", v.authorizationVersion);
      add("Accepted", v.acceptedAt);
      break;
    case "pre_debit_notification":
      add("Amount", v.amount);
      add("Debit date", v.debitDate);
      add("Mandate reference", v.mandateReference);
      break;
    case "checkout_reminder":
      add("Order", v.orderSummary);
      add("Total", v.amount);
      break;
    case "usage_alert":
    case "spend_limit_reached":
      add("Usage now", v.usageValue);
      add("Limit", v.limitValue);
      add("Resets on", v.resetDate);
      break;
    case "credit_auto_topup_failed":
      add("Amount", v.amount);
      break;
    case "credit_topup_debit_notice":
      add("Amount", v.amount);
      add("Debit date", v.debitDate);
      add("Mandate reference", v.mandateReference);
      break;
  }
  // The way back to an unfinished checkout is its own link, not the portal.
  if (emailType === "checkout_reminder") {
    return {
      ...(rows.length ? { facts: rows } : {}),
      ...(v.checkoutUrl ? { action: { label: "Return to your order", url: v.checkoutUrl } } : {}),
    };
  }

  const action = v.portalUrl
    ? PAY_TYPES.has(emailType) || (emailType === "invoice_sent" && v.invoicePayable)
      ? { label: "Pay now", url: v.portalUrl, kind: "pay_invoice" as const }
      : FIX_INSTRUMENT_TYPES.has(emailType)
        ? { label: "Change payment method", url: v.portalUrl, kind: "update_card" as const }
        : undefined
    : undefined;

  return { ...(rows.length ? { facts: rows } : {}), ...(action ? { action } : {}) };
}

// ── Account emails: one layout ─────────────────────────────────────────────

/**
 * The layout of every email we send a person about their own account: sign-up, invites,
 * password reset, security notices. Ours, never a business's: no merchant logo or colour,
 * because no business sent it. Tables and inline styles only, so Outlook keeps the card and
 * the button.
 */
interface AccountLayout {
  /** The line an inbox shows under the subject. */
  preheader: string;
  title: string;
  greeting: string;
  paragraphs: string[];
  facts?: Array<[string, string]>;
  /** "Did you not do this?" — set apart so it is not lost in the text. */
  callout?: string;
  action?: { label: string; url: string } | null;
  secondary?: { label: string; url: string } | null;
  /** Show the raw link under the button, for clients that block buttons. */
  linkFallback?: boolean;
  /** A red bar on the card: only for alerts that need action. */
  alert?: boolean;
  /** Why the person got this email. */
  reason: string;
}

const BRAND_HUE = "#4E4EDA";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** "Was this not you? Change …" → the question in bold. */
function calloutHtml(text: string): string {
  const q = text.indexOf("?");
  return q > 0 && q < 40
    ? `<b>${escapeHtml(text.slice(0, q + 1))}</b>${escapeHtml(text.slice(q + 1))}`
    : escapeHtml(text);
}

function renderAccountLayout(
  l: AccountLayout,
  brand: AccountBrand,
): { html: string; text: string } {
  const p = (t: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3F3F46">${escapeHtml(t)}</p>`;
  const logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" width="108" height="36" alt="${escapeHtml(brand.name)}" style="display:block;border:0;width:108px;height:36px">`
    : `<span style="font-size:16px;font-weight:700;color:#18181B">${escapeHtml(brand.name)}</span>`;
  const facts = l.facts?.length
    ? `<table role="presentation" width="100%" style="margin:4px 0 20px;background:#F7F7F9;border-radius:8px;border-collapse:separate"><tr><td style="padding:12px 16px"><table role="presentation">${l.facts
        .map(
          ([k, v]) =>
            `<tr><td style="padding:4px 16px 4px 0;font-size:13px;color:#71717A;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0;font-size:13px;color:#18181B">${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</table></td></tr></table>`
    : "";
  const callout = l.callout
    ? `<table role="presentation" width="100%" style="margin:0 0 20px;border-collapse:collapse"><tr><td style="padding:12px 16px;border-left:3px solid ${l.alert ? "#D92D20" : BRAND_HUE};background:${l.alert ? "#FEF3F2" : "#F4F4FD"};font-size:14px;line-height:1.55;color:#3F3F46">${calloutHtml(l.callout)}</td></tr></table>`
    : "";
  const button = l.action
    ? `<table role="presentation" style="margin:8px 0"><tr><td style="background:${BRAND_HUE};border-radius:8px"><a href="${escapeHtml(l.action.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(l.action.label)}</a></td></tr></table>`
    : "";
  const secondary = l.secondary
    ? `<p style="margin:12px 0 0;font-size:14px"><a href="${escapeHtml(l.secondary.url)}" style="color:${BRAND_HUE}">${escapeHtml(l.secondary.label)}</a></p>`
    : "";
  const fallback =
    l.linkFallback && l.action
      ? `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#71717A">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(l.action.url)}" style="color:${BRAND_HUE};word-break:break-all">${escapeHtml(l.action.url)}</a></p>`
      : "";
  const help = brand.supportEmail
    ? ` · Help: <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#71717A">${escapeHtml(brand.supportEmail)}</a>`
    : "";

  const html = [
    `<div style="margin:0;padding:32px 12px;background:#F4F4F6;font-family:${FONT}">`,
    // Preview text, then filler so the body does not run on after it in the inbox.
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(l.preheader)}${"&#8203;&nbsp;".repeat(60)}</div>`,
    `<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #E4E4E7;border-radius:12px;border-collapse:separate">`,
    l.alert
      ? `<tr><td style="height:4px;background:#D92D20;border-radius:12px 12px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>`
      : "",
    `<tr><td style="padding:28px 32px 0">${logo}</td></tr>`,
    `<tr><td style="padding:0 32px 32px">`,
    `<h1 style="margin:28px 0 16px;font-size:20px;line-height:1.3;font-weight:600;color:#18181B">${escapeHtml(l.title)}</h1>`,
    p(l.greeting),
    p(l.paragraphs[0] ?? ""),
    facts,
    ...l.paragraphs.slice(1).map(p),
    callout,
    button,
    secondary,
    fallback,
    `</td></tr></table>`,
    `<p style="max-width:560px;margin:20px auto 0;padding:0 8px;font-size:12px;line-height:1.6;color:#71717A;text-align:center">${escapeHtml(l.reason)}<br>${escapeHtml(brand.name)}${help}</p>`,
    `</div>`,
  ].join("");

  const text = [
    l.greeting,
    l.paragraphs[0],
    l.facts?.map(([k, v]) => `${k}: ${v}`).join("\n"),
    ...l.paragraphs.slice(1),
    l.callout,
    l.action ? `${l.action.label}: ${l.action.url}` : null,
    l.secondary ? `${l.secondary.label}: ${l.secondary.url}` : null,
    `${l.reason}\n${brand.name}${brand.supportEmail ? ` · Help: ${brand.supportEmail}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { html, text };
}

const greet = (name?: string | null) => (name ? `Hi ${name},` : "Hi,");

/** "Asha Rao (asha@example.com)", or the address alone. */
function inviterLabel(i: { name?: string | null; email: string }): string {
  return i.name ? `${i.name} (${i.email})` : i.email;
}

/**
 * Operator password reset (0194). The user's name is the only interpolated value; it goes
 * through `escapeHtml` in the layout like everything else.
 */
export function renderPasswordResetEmail(
  vars: { name?: string | null; link: string; ttlMinutes: number },
  brand: AccountBrand = accountBrand(),
): RenderedEmail {
  const { html, text } = renderAccountLayout(
    {
      preheader: `The link works for ${vars.ttlMinutes} minutes, one time only.`,
      title: "Reset your password",
      greeting: greet(vars.name),
      paragraphs: [
        `Someone asked to reset the password for your ${brand.name} account. Use the button below ` +
          `within ${vars.ttlMinutes} minutes. It works one time only.`,
        `If you did not ask for this, nothing changed and you can ignore this email. Your password ` +
          `does not change until someone uses the link.`,
      ],
      action: { label: "Choose a new password", url: vars.link },
      linkFallback: true,
      reason: `You get this email because you have a ${brand.name} account with this email address.`,
    },
    brand,
  );
  return { subject: `Reset your ${brand.name} password`, html, text };
}

/** Self-serve sign-up (0354): the link that creates the account. */
export function renderSignupConfirmEmail(
  vars: { name?: string | null; link: string; ttlHours: number },
  brand: AccountBrand = accountBrand(),
): RenderedEmail {
  const { html, text } = renderAccountLayout(
    {
      preheader: `Use the link within ${vars.ttlHours} hours to create your account.`,
      title: "Confirm your email address",
      greeting: greet(vars.name),
      paragraphs: [
        `Use the button below to confirm your email address and create your ${brand.name} ` +
          `account. The link works one time only, and it expires in ${vars.ttlHours} hours.`,
        `If you did not sign up, you can ignore this email. We do not create the account until ` +
          `someone uses the link.`,
      ],
      action: { label: "Confirm your email address", url: vars.link },
      linkFallback: true,
      reason: "You get this email because someone signed up with this email address.",
    },
    brand,
  );
  return { subject: `Confirm your email address for ${brand.name}`, html, text };
}

/** A one-time sign-up link that staff send to a person who asked for access (0405). */
export function renderSignupInviteEmail(
  vars: { name?: string | null; link: string; ttlDays: number },
  brand: AccountBrand = accountBrand(),
): RenderedEmail {
  const { html, text } = renderAccountLayout(
    {
      preheader: `Your sign-up link works for ${vars.ttlDays} days.`,
      title: "Create your account",
      greeting: greet(vars.name),
      paragraphs: [
        `Thank you for your request. You can now create your ${brand.name} account. Use the ` +
          `button below. The link works one time only, and it expires in ${vars.ttlDays} days.`,
        "If you did not ask for an account, you can ignore this email.",
      ],
      action: { label: "Create your account", url: vars.link },
      linkFallback: true,
      reason: "You get this email because someone asked for an account with this email address.",
    },
    brand,
  );
  return { subject: `Create your ${brand.name} account`, html, text };
}

/** To our team: a new access request while sign-up is locked (0405). Plain text. */
export function renderSignupRequestNotice(vars: {
  name: string;
  email: string;
  company: string;
  country: string | null;
  billingVolume: string | null;
  gateway: string | null;
  message: string | null;
}): RenderedEmail {
  const lines = [
    `${vars.name} <${vars.email}> asked for access.`,
    "",
    `Company: ${vars.company}`,
    `Country: ${vars.country ?? "—"}`,
    `Monthly billing: ${vars.billingVolume ?? "—"}`,
    `Payment gateway: ${vars.gateway ?? "—"}`,
    ...(vars.message ? ["", vars.message] : []),
    "",
    "To send a sign-up link, open Sign-up requests in the back-office.",
  ];
  const text = lines.join("\n");
  return {
    subject: `Access request: ${vars.name} · ${vars.company}`,
    html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    text,
  };
}

/**
 * Sent instead of the confirmation when the address already has an account, so the sign-up
 * form answers the same for every address (M9).
 */
export function renderSignupExistingAccountEmail(
  vars: { name?: string | null; signInLink: string; resetLink: string },
  brand: AccountBrand = accountBrand(),
): RenderedEmail {
  const { html, text } = renderAccountLayout(
    {
      preheader: "We did not create a new account. Sign in to the one you have.",
      title: "You already have an account",
      greeting: greet(vars.name),
      paragraphs: [
        `Someone tried to sign up for ${brand.name} with this email address. You already have an ` +
          `account, so we did not create a new one.`,
        "To use your account, sign in. If you do not know your password, reset it.",
        "If you did not try to sign up, you can ignore this email. Nothing changed.",
      ],
      action: { label: "Sign in", url: vars.signInLink },
      secondary: { label: "Reset your password", url: vars.resetLink },
      reason: "You get this email because someone tried to sign up with this email address.",
    },
    brand,
  );
  return { subject: `You already have a ${brand.name} account`, html, text };
}

/**
 * Operator invite (0197). Names the ORGANIZATION and, when a person sent it, the INVITER: an
 * invite from "someone" to "something" is indistinguishable from phishing. A seed or script
 * invite has no person, so it says "Someone".
 */
export function renderInviteEmail(
  vars: {
    name?: string | null;
    organizationName: string;
    link: string;
    ttlHours: number;
    /** The organization requires two-factor authentication (0329): say so before they join. */
    requiresTwoFactor?: boolean;
    inviter?: { name?: string | null; email: string } | null;
  },
  brand: AccountBrand = accountBrand(),
): RenderedEmail {
  const org = vars.organizationName;
  const who = vars.inviter ? inviterLabel(vars.inviter) : "Someone";
  const { html, text } = renderAccountLayout(
    {
      preheader: `Set your password to sign in. The link expires in ${vars.ttlHours} hours.`,
      title: `Join ${org}`,
      greeting: greet(vars.name),
      paragraphs: [
        `${who} added you to ${org} on ${brand.name}. Use the button below to set your password ` +
          `and sign in. The link works one time only, and it expires in ${vars.ttlHours} hours.`,
        "Nobody else knows or can see the password that you choose.",
        `If you did not expect this, you can ignore this email. Nobody can use the account until ` +
          `someone sets a password through this link.`,
      ],
      callout: vars.requiresTwoFactor
        ? `${org} requires two-factor authentication. After you sign in, you must enable it ` +
          `before you can open the organization.`
        : undefined,
      action: { label: "Choose a password", url: vars.link },
      linkFallback: true,
      reason: `You get this email because someone added this email address to ${org}.`,
    },
    brand,
  );
  const subject = vars.inviter
    ? `${vars.inviter.name || vars.inviter.email} added you to ${org} on ${brand.name}`
    : `You are now a member of ${org} on ${brand.name}`;
  return { subject, html, text };
}

/**
 * Invite for an address that already has an account (0498). Nothing changes until the person
 * signs in and accepts, so no token: the link opens the signed-in invites page.
 */
export function renderMembershipInviteEmail(
  vars: {
    name?: string | null;
    organizationName: string;
    link: string;
    inviter?: { name?: string | null; email: string } | null;
  },
  brand: AccountBrand = accountBrand(),
): RenderedEmail {
  const org = vars.organizationName;
  const who = vars.inviter ? inviterLabel(vars.inviter) : "Someone";
  const { html, text } = renderAccountLayout(
    {
      preheader: "Sign in and accept the invite. Nothing changes until you accept.",
      title: `Join ${org}`,
      greeting: greet(vars.name),
      paragraphs: [
        `${who} invited you to join ${org} on ${brand.name}. You already have an account.`,
        `To join, sign in and accept the invite. ${org} cannot see your account details until ` +
          `you accept.`,
        "If you did not expect this, decline the invite or ignore this email. Nothing changes " +
          "until you accept.",
      ],
      action: { label: "View the invite", url: vars.link },
      reason: `You get this email because someone invited this email address to ${org}.`,
    },
    brand,
  );
  const subject = vars.inviter
    ? `${vars.inviter.name || vars.inviter.email} invited you to join ${org} on ${brand.name}`
    : `You are invited to join ${org} on ${brand.name}`;
  return { subject, html, text };
}

// ── Account security notices (0328) ─────────────────────────────────────────

/** Every notice we send an operator about a change to their own account's security. */
export type AccountSecurityEmailKind =
  | "two_factor_enabled"
  | "two_factor_method_added"
  | "two_factor_method_removed"
  | "two_factor_disabled"
  | "authenticator_changed"
  | "recovery_codes_generated"
  | "recovery_code_used"
  | "password_changed"
  | "password_added"
  | "password_reset"
  | "mfa_failed_attempts"
  | "two_factor_reset_requested"
  | "two_factor_reset_completed"
  | "org_two_factor_required"
  | "org_two_factor_deadline"
  | "role_changed";

export interface AccountSecurityEmailInput {
  kind: AccountSecurityEmailKind;
  email: string;
  name?: string | null;
  at: Date;
  userAgent?: string | null;
  /** The second-factor method a method_added / method_removed notice is about. */
  method?: "totp" | "passkey";
  passkeyName?: string | null;
  /** recovery_code_used: how many remain. */
  codesLeft?: number;
  /** recovery_code_used: finishing a sign-in, or confirming it's you. */
  recoveryContext?: "sign_in" | "step_up";
  /** mfa_failed_attempts: the first factor that was right before the wrong codes. */
  firstFactor?: "password" | "google";
  /** two_factor_reset_requested: when support will turn 2FA off. */
  effectiveAt?: Date;
  /** two_factor_reset_requested: the link that stops it. */
  cancelLink?: string | null;
  /** `<dashboard>/account`, when the deployment knows its own address. */
  accountLink?: string | null;
  supportEmail?: string | null;
  /** org_two_factor_*: the organization that requires 2FA. */
  organizationName?: string;
  /** org_two_factor_required: who turned the requirement on, by name or email. */
  requiredBy?: string;
  /** org_two_factor_*: the last day without 2FA, already formatted ("8 Oct 2026"). */
  deadlineDay?: string | null;
  /** org_two_factor_deadline: the deadline is today rather than tomorrow. */
  deadlineIsToday?: boolean;
  /** role_changed: the new role's name. */
  roleName?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Thu, 8 Oct 2026 at 14:05 UTC". Operators have no stored zone, so UTC, labelled as such. */
export function formatSecurityTimestamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${WEEKDAYS[at.getUTCDay()]}, ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ` +
    `${at.getUTCFullYear()} at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
}

/** "Chrome on macOS". Coarse on purpose: it names a device, not a build. */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown browser";
}

const FIRST_FACTOR = {
  password: {
    phrase: "entered your password correctly",
    advice: "Change your password now.",
    title: "Someone may have your password",
  },
  google: {
    phrase: "signed in with your Google account",
    advice: "Secure your Google account and change its password now.",
    title: "Someone may have your Google account",
  },
} as const;

/**
 * An operator notice about their own account's security — 2FA, recovery codes, passwords,
 * support resets. Same layout as the reset and invite mails, never a business's branding.
 * Never carries a code, secret or token; the only link with power is
 * a reset's cancel link, which can only STOP a change.
 */
export function renderAccountSecurityEmail(
  v: AccountSecurityEmailInput,
  brand: AccountBrand = accountBrand(),
): RenderedEmail {
  const who = v.email;
  const passkey = v.method === "passkey";
  const help = v.supportEmail
    ? `Did you not do this? Change your password now and send an email to ${v.supportEmail}. We will help you make your account safe.`
    : "Did you not do this? Change your password now and tell your administrator.";
  const keepCodes =
    "Keep your recovery codes in a safe location. If you lose your phone, you can sign in with them.";

  let subject: string;
  let title: string;
  let paragraphs: string[];
  let showDevice = true;
  /** A red bar: only alerts that need action. */
  let alert = false;
  let action: { label: string; url: string } | null = v.accountLink
    ? { label: "Review your security settings", url: v.accountLink }
    : null;

  switch (v.kind) {
    case "two_factor_enabled":
      subject = title = "Two-factor authentication is on";
      paragraphs = [
        `You enabled two-factor authentication for ${who} with an authenticator app. When you ` +
          `sign in with a password or Google, we also ask for a code from the app.`,
        keepCodes,
        help,
      ];
      break;
    case "two_factor_method_added":
      subject = title = passkey
        ? "New passkey on your account"
        : "New authenticator app on your account";
      paragraphs = [
        passkey
          ? `Someone added a passkey${v.passkeyName ? ` (${v.passkeyName})` : ""} to ${who}. You can use it to complete a sign-in.`
          : `Someone added an authenticator app to ${who}. You can use its codes to complete a sign-in.`,
        help,
      ];
      break;
    case "two_factor_method_removed":
      subject = title = passkey
        ? "Passkey removed from your account"
        : "Authenticator app removed from your account";
      paragraphs = [
        passkey
          ? `Someone removed the passkey${v.passkeyName ? ` ${v.passkeyName}` : ""} from ${who}. You cannot sign in with it now.`
          : `Someone removed the authenticator app from ${who}. Its codes do not operate now.`,
        "Two-factor authentication stays on with your other methods.",
        help,
      ];
      break;
    case "two_factor_disabled":
      subject = "Two-factor authentication is disabled";
      title = "Two-factor authentication is off";
      paragraphs = [
        `Someone disabled two-factor authentication for ${who}. We removed your authenticator app ` +
          `and recovery codes. We also signed out your other browsers.`,
        help,
      ];
      break;
    case "authenticator_changed":
      subject = title = "New authenticator app for two-factor authentication";
      paragraphs = [
        `Two-factor authentication for ${who} uses a new authenticator app now. Codes from the old ` +
          `app do not operate now.`,
        help,
      ];
      break;
    case "recovery_codes_generated":
      subject = title = "New recovery codes for your account";
      paragraphs = [
        `Someone made new recovery codes for ${who}. Your old codes do not operate now.`,
        keepCodes,
        help,
      ];
      break;
    case "recovery_code_used": {
      const n = v.codesLeft ?? 0;
      const left =
        n === 0
          ? "You have no recovery codes left."
          : `You have ${n} ${n === 1 ? "recovery code" : "recovery codes"} left.`;
      subject = title =
        v.recoveryContext === "step_up"
          ? "Someone used a recovery code to verify your identity"
          : "Someone used a recovery code to sign in";
      paragraphs = [
        v.recoveryContext === "step_up"
          ? `Someone used one of your recovery codes to verify your identity on ${who}. ${left}`
          : `Someone signed in to ${who} with one of your recovery codes. ${left}`,
        "If you lost your phone, add your authenticator app again. Then make new recovery codes.",
        help,
      ];
      break;
    }
    case "password_changed":
      subject = `New password on your ${brand.name} account`;
      title = "Password changed";
      paragraphs = [
        `Someone changed the password for ${who}. We signed out all your other browsers.`,
        help,
      ];
      break;
    case "role_changed":
      subject = "Your role changed";
      title = "Role changed";
      paragraphs = [
        `An owner or admin changed your role in ${v.organizationName ?? "an organization"} to ${v.roleName ?? "a new role"}. This changes what you can see and do in that organization.`,
        help,
      ];
      break;
    case "password_added":
      subject = `Password added to your ${brand.name} account`;
      title = "Password added";
      paragraphs = [
        `Someone added a password to ${who}. You can sign in with the password or with Google now.`,
        help,
      ];
      break;
    case "password_reset":
      subject = `Password reset on your ${brand.name} account`;
      title = "Password reset";
      paragraphs = [
        `Someone used a reset link from this email address to change the password for ${who}. We signed out all browsers.`,
        help,
      ];
      break;
    case "mfa_failed_attempts": {
      const f = FIRST_FACTOR[v.firstFactor ?? "password"];
      subject = "Someone tried to sign in to your account";
      alert = true;
      if (action && v.firstFactor !== "google")
        action = { ...action, label: "Change your password" };
      title = f.title;
      paragraphs = [
        `Someone ${f.phrase} for ${who}. Then they entered an incorrect two-factor code 5 times. ` +
          `Two-factor authentication stopped them.`,
        `Was this not you? ${f.advice} Two-factor authentication continues to protect your account.`,
        "If this was you, you do not have to do anything. You can sign in again with your authenticator app.",
      ];
      break;
    }
    case "two_factor_reset_requested": {
      const day = v.effectiveAt ? formatSecurityTimestamp(v.effectiveAt) : "in a few days";
      subject = "Support will disable two-factor authentication soon";
      title = "We received a request to disable 2FA";
      paragraphs = [
        `Support accepted a request to disable two-factor authentication for ${who}. Support will ` +
          `disable it on ${day}.`,
        "If you did not ask for this, cancel the reset now. Your account does not change.",
        "If you asked for this, you do not have to do anything.",
      ];
      showDevice = false;
      alert = true;
      action = v.cancelLink ? { label: "Cancel the reset", url: v.cancelLink } : null;
      break;
    }
    case "two_factor_reset_completed":
      subject = "Support disabled two-factor authentication";
      title = "Two-factor authentication is off";
      paragraphs = [
        `As you asked, support disabled two-factor authentication for ${who}. We removed your ` +
          `authenticator app and recovery codes. We also signed out all browsers.`,
        "After you sign in, enable it again.",
        v.supportEmail
          ? `Did you not ask for this? Send an email to ${v.supportEmail} now.`
          : "Did you not ask for this? Tell your administrator now.",
      ];
      showDevice = false;
      break;
    case "org_two_factor_required": {
      const org = v.organizationName ?? "Your organization";
      const by = v.deadlineDay ?? "the deadline";
      subject = title = `${org} now requires two-factor authentication`;
      paragraphs = [
        `${v.requiredBy ?? "An admin"} made two-factor authentication necessary for all members of ${org}.`,
        `Enable it by ${by}. This takes approximately two minutes with a passkey or an authenticator app.`,
        `After ${by}, you must enable it before you can open ${org}. This does not apply to your other organizations.`,
        `Do you have questions? Ask ${v.requiredBy ?? "an admin"}. This person manages the settings for ${org}.`,
      ];
      showDevice = false;
      action = v.accountLink
        ? { label: "Enable two-factor authentication", url: v.accountLink }
        : null;
      break;
    }
    case "org_two_factor_deadline": {
      const org = v.organizationName ?? "your organization";
      const when = v.deadlineIsToday ? "today" : "tomorrow";
      subject = title = `Enable 2FA by ${when} to keep access to ${org}`;
      paragraphs = [
        `You have until the end of ${when}, ${v.deadlineDay ?? "the deadline"}, to enable two-factor ` +
          `authentication for ${org}. After that date, you must enable it before you can open the organization.`,
      ];
      showDevice = false;
      action = v.accountLink
        ? { label: "Enable two-factor authentication", url: v.accountLink }
        : null;
      break;
    }
  }

  const greeting = v.name ? `Hi ${v.name},` : "Hi,";
  const facts: Array<[string, string]> = [["When", formatSecurityTimestamp(v.at)]];
  if (showDevice) facts.push(["Browser", describeUserAgent(v.userAgent)]);

  // The "did you not do this?" line goes in a callout so it is not lost in the text.
  const isCallout = (p: string) => /^(Did you not|Was this not you\?)/.test(p);
  const callout = paragraphs.find(isCallout);
  const { html, text } = renderAccountLayout(
    {
      preheader: paragraphs[0]!,
      title,
      greeting,
      paragraphs: paragraphs.filter((p) => !isCallout(p)),
      facts,
      callout,
      action,
      alert,
      reason: `You get this email because you have a ${brand.name} account with this email address.`,
    },
    brand,
  );
  return { subject, html, text };
}
