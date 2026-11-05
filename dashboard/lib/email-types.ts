/**
 * The billing email types, for display. Mirrors EMAIL_TYPES in
 * src/modules/emails/config.ts — an entry here that the engine does not know would be
 * written into email_config and then silently ignored by resolveEmailConfig, and a
 * template editor for it would 400 on save.
 *
 * Shared by Settings → Email notifications and the per-type template editor so the two
 * cannot drift into calling the same email different things.
 */
import { type AdhocEmailType } from "@/lib/api/emails";

export interface EmailTypeMeta {
  key: string;
  label: string;
  description: string;
  group: EmailGroup;
  /**
   * True for types only an operator can send, from the record's own `Email` action.
   * The settings screen shows them but renders NO on/off toggle: the engine never fires
   * them, so a toggle there would gate nothing — a dead control.
   */
  adhoc?: boolean;
  /**
   * True for types the engine sends because the CUSTOMER asked (the portal sign-in code).
   * No toggle, not in the enabled count, not operator-sendable; the template is editable.
   */
  system?: boolean;
}

export type EmailGroup =
  | "Invoices & payments"
  | "Subscription lifecycle"
  | "Payment methods"
  | "Reminders"
  | "Sent by you"
  | "Customer portal";

export const EMAIL_GROUPS: EmailGroup[] = [
  "Invoices & payments",
  "Subscription lifecycle",
  "Payment methods",
  "Reminders",
  "Sent by you",
  "Customer portal",
];

/**
 * What each group is FOR, shown beside it on the settings hub. Lives here next to the
 * groups themselves so a new group cannot reach the screen without a description — the
 * hub's left column would otherwise render an unexplained heading.
 */
export const EMAIL_GROUP_DESCRIPTIONS: Record<EmailGroup, string> = {
  "Invoices & payments":
    "Keep customers posted about invoices, receipts, failed charges, refunds and credit notes.",
  "Subscription lifecycle":
    "Tell customers when a subscription starts, changes, pauses, renews or ends.",
  "Payment methods":
    "Warn customers before a stored card stops working, so a renewal does not fail silently.",
  Reminders:
    "Time-relative nudges sent ahead of a trial converting, a term renewing, a pause, a resume, a cancellation taking effect or an invoice falling due.",
  "Sent by you":
    "Emails an operator sends by hand from a customer, invoice or credit note. The master switch does not govern these.",
  "Customer portal":
    "Emails a customer asks for in the billing portal, such as a sign-in code. We send them only when asked. The master switch does not govern these.",
};

export const EMAIL_TYPES: EmailTypeMeta[] = [
  // ── Invoices & payments ──
  {
    key: "invoice_issued",
    group: "Invoices & payments",
    label: "Invoice issued",
    description: "Sent when an invoice is finalized and will be collected automatically.",
  },
  {
    key: "invoice_to_pay",
    group: "Invoices & payments",
    label: "Invoice to pay",
    description:
      "Sent instead of Invoice issued when the customer pays the invoice themselves: the due date and a Pay now button.",
  },
  {
    key: "invoice_overdue",
    group: "Invoices & payments",
    label: "Invoice overdue",
    description: "Sent when an invoice passes its due date unpaid.",
  },
  {
    key: "payment_receipt",
    group: "Invoices & payments",
    label: "Payment receipt",
    description: "Sent when a payment succeeds.",
  },
  {
    key: "payment_failed",
    group: "Invoices & payments",
    label: "Payment failed",
    description: "Sent when a charge is declined.",
  },
  {
    key: "payment_authentication_required",
    group: "Invoices & payments",
    label: "Payment needs approval",
    description:
      "Sent when a mandate debit waits for the customer’s bank approval. Nothing failed. Without this email, the debit stops and nobody knows.",
  },
  {
    key: "dunning_action_required",
    group: "Invoices & payments",
    label: "Action needed to keep the subscription",
    description:
      "Sent while collections holds an invoice that it cannot retry, for example after an expired card or a lapsed mandate. It gives the reason and the date when the subscription ends. Without it, the customer gets no message between the failure and the cancellation.",
  },
  {
    key: "refund_initiated",
    group: "Invoices & payments",
    label: "Refund initiated",
    description:
      "Sent when the provider accepts a refund that is not settled yet. Card and bank refunds take several working days. Without it, the customer sees the charge and no confirmation of the refund.",
  },
  {
    key: "refund_issued",
    group: "Invoices & payments",
    label: "Refund issued",
    description: "Sent when a refund has settled.",
  },
  {
    key: "credit_note_issued",
    group: "Invoices & payments",
    label: "Credit note issued",
    description: "Sent when a credit note is created for the customer.",
  },
  {
    key: "credit_note_applied",
    group: "Invoices & payments",
    label: "Credit note applied",
    description: "Sent when a credit note is allocated against an invoice.",
  },
  // Usage controls (design G5 § 5).
  {
    key: "usage_alert",
    group: "Invoices & payments",
    label: "Usage alert",
    description:
      "Sent when usage, spend or credit reaches a threshold of an alert. Only for alerts that have email on.",
  },
  {
    key: "spend_limit_reached",
    group: "Invoices & payments",
    label: "Spend limit reached",
    description:
      "Sent when the customer's spend reaches a spend limit. Off until you switch it on.",
  },
  {
    key: "credit_auto_topup_failed",
    group: "Invoices & payments",
    label: "Automatic top-up failed",
    description:
      "Sent when the payment for an automatic credit top-up is declined. Automatic top-up is then off, and the email tells the customer to update the payment method.",
  },

  // ── Subscription lifecycle ──
  {
    key: "subscription_activated",
    group: "Subscription lifecycle",
    label: "Subscription activated",
    description: "Sent when a subscription becomes active.",
  },
  {
    key: "subscription_changed",
    group: "Subscription lifecycle",
    label: "Subscription changed",
    description: "Sent when the plan, quantity or add-ons change.",
  },
  {
    key: "subscription_renewed",
    group: "Subscription lifecycle",
    label: "Subscription renewed",
    description: "Sent when a term renews.",
  },
  {
    key: "subscription_paused",
    group: "Subscription lifecycle",
    label: "Subscription paused",
    description: "Sent when a subscription is paused.",
  },
  {
    key: "subscription_resumed",
    group: "Subscription lifecycle",
    label: "Subscription resumed",
    description: "Sent when a paused subscription resumes.",
  },
  {
    key: "subscription_canceled",
    group: "Subscription lifecycle",
    label: "Subscription cancelled",
    description: "Sent when a subscription is cancelled for any reason other than non-payment.",
  },
  {
    key: "subscription_canceled_nonpayment",
    group: "Subscription lifecycle",
    label: "Subscription cancelled for non-payment",
    description: "Sent when dunning is exhausted and the subscription is cancelled.",
  },
  // The trial trio sits in the lifecycle group, not Reminders: these report something that
  // has already happened, where a reminder warns about something that has not. "Trial
  // ending" below is the warning; "Trial ended" here is the event.
  {
    key: "trial_started",
    group: "Subscription lifecycle",
    label: "Trial started",
    description:
      "Sent when a subscription starts its trial. This is the welcome email, not the activation email.",
  },
  {
    key: "trial_expired",
    group: "Subscription lifecycle",
    label: "Trial ended",
    description:
      "Sent when a trial ends without converting. It is not the cancellation email, because nobody failed to pay.",
  },
  {
    key: "trial_extended",
    group: "Subscription lifecycle",
    label: "Trial extended",
    description: "Sent when a trial’s end date moves later. A shorter trial sends nothing.",
  },

  // ── Payment methods ──
  {
    key: "card_expiring",
    group: "Payment methods",
    label: "Card expiring",
    description: "Sent ahead of a stored card’s expiry date.",
  },
  {
    key: "card_expired",
    group: "Payment methods",
    label: "Card expired",
    description: "Sent once a stored card has expired.",
  },
  {
    key: "payment_method_invalid",
    group: "Payment methods",
    label: "Payment method unusable",
    description:
      "Sent when a payment method is refused for a reason that will not correct itself. This is not “card expired”. Nothing expired, so the customer does not need to examine the date.",
  },
  {
    key: "mandate_expired",
    group: "Payment methods",
    label: "Auto-debit authorization ended",
    description:
      "Sent when the standing authorization of a card, UPI Autopay or e-mandate expires, or is cancelled, rejected or paused. This is not “card expired” or “payment method unusable”. The payment method itself may be good. Only the authorization to debit it automatically ended.",
  },

  // ── Reminders ──
  // No "a few days before" here: the settings hub appends the REAL lead time read from
  // GET …/emails/reminders, so restating it vaguely would both duplicate and undercut it.
  {
    key: "trial_ending",
    group: "Reminders",
    label: "Trial ending",
    description: "Warns the customer before a trial converts to a paid subscription.",
  },
  {
    key: "renewal_reminder",
    group: "Reminders",
    label: "Renewal reminder",
    description: "Warns the customer before a term renews.",
  },
  {
    key: "cancellation_reminder",
    group: "Reminders",
    label: "Cancellation reminder",
    description: "Warns the customer before a scheduled cancellation takes effect.",
  },
  {
    key: "pause_reminder",
    group: "Reminders",
    label: "Pause reminder",
    description: "Warns the customer before a scheduled pause starts.",
  },
  {
    key: "resume_reminder",
    group: "Reminders",
    label: "Resume reminder",
    description: "Tells the customer before a paused subscription resumes on its scheduled date.",
  },
  {
    key: "payment_due_reminder",
    group: "Reminders",
    label: "Payment due reminder",
    description:
      "Asks the customer to pay an invoice before its due date. Only for invoices that we do not collect automatically.",
  },
  // Off until switched on: the settings page and isEmailTypeEnabled treat it the same way.
  {
    key: "checkout_reminder",
    group: "Reminders",
    label: "Checkout reminder",
    description:
      "Reminds a customer who gave their email at checkout and did not pay. We send it one hour after they leave, and again one day later. Off until you switch it on.",
  },
  // Same rule as the three above — no lead time stated here, the hub appends the real one.
  // The compliance note stays: this is the one reminder a merchant is legally obliged to
  // send, so switching it off has a consequence the others do not have.
  {
    key: "pre_debit_notification",
    group: "Reminders",
    label: "Pre-debit notification",
    description:
      "Advance notice of an automatic mandate debit. NPCI/RBI requires it for Indian mandate rails. If you disable it, you must send this notice yourself.",
  },
  {
    key: "credit_topup_debit_notice",
    group: "Reminders",
    label: "Credit top-up debit notice",
    description:
      "Advance notice before an automatic credit top-up debits a mandate: the amount, the date and the mandate. NPCI/RBI requires it for Indian mandate rails. If you disable it, you must send this notice yourself.",
  },
  // Same kind of obligation: US law requires the payer to get a copy of the debit authorization.
  {
    key: "ach_authorization_copy",
    group: "Payment methods",
    label: "Bank debit authorization copy",
    description:
      "Sends the customer a copy of the bank debit authorization that they accepted when they saved a bank account. US law requires that the customer gets a copy. If you disable it, you must send the copy yourself.",
  },

  // ── Sent by you ──
  {
    key: "invoice_sent",
    group: "Sent by you",
    adhoc: true,
    label: "Send invoice",
    description: "Emails an invoice to the customer on request.",
  },
  {
    key: "payment_request",
    group: "Sent by you",
    adhoc: true,
    label: "Request payment",
    description: "Asks the customer to pay an outstanding invoice.",
  },
  {
    key: "payment_method_request",
    group: "Sent by you",
    adhoc: true,
    label: "Request payment method",
    description: "Asks the customer to add or update a payment method.",
  },
  {
    key: "credit_note_sent",
    group: "Sent by you",
    adhoc: true,
    label: "Send credit note",
    description: "Emails a credit note to the customer on request.",
  },

  // ── Customer portal ──
  {
    key: "portal_sign_in_code",
    group: "Customer portal",
    system: true,
    label: "Sign-in code",
    description:
      "Sends the code a customer asked for to sign in to the billing portal. You can change the words. The code is always included.",
  },
];

/** Engine-fired types only — the ones the per-type opt-in toggles actually govern. */
export const AUTOMATIC_EMAIL_TYPES = EMAIL_TYPES.filter((t) => !t.adhoc && !t.system);

export const emailTypeLabel = (key: string): string =>
  EMAIL_TYPES.find((t) => t.key === key)?.label ?? key;

export const emailTypesInGroup = (group: EmailGroup): EmailTypeMeta[] =>
  EMAIL_TYPES.filter((t) => t.group === group);

/**
 * Which ad-hoc types a given record supports — the engine rejects the others for want of
 * a record.
 *
 * It lives HERE and not next to `SendEmailDialog`, even though the dialog is its only
 * consumer, because the pages that pass it are server components: a value exported from a
 * 'use client' module reaches a server component as a client-reference proxy, not as the
 * array, so `ADHOC_TYPES_FOR.invoice` read `undefined` and `types[0]` blanked the whole
 * invoice and credit-note pages with a client-side exception. Only a module WITHOUT
 * 'use client' can hand a real value to both sides.
 */
export const ADHOC_TYPES_FOR: Record<"invoice" | "credit_note" | "customer", AdhocEmailType[]> = {
  invoice: ["invoice_sent", "payment_request"],
  credit_note: ["credit_note_sent"],
  customer: ["payment_method_request"],
};

// ── Transport: how a message was carried ──────────────────────────────────────

/**
 * How a message was carried. `null` on rows written before the transport column existed —
 * rendered as "unknown" rather than assumed, since guessing is what this column retired.
 * Mirrors the `Mailer['kind']` union in src/providers/mailer/types.ts, plus NULL.
 */
export type EmailTransport = "console" | "smtp" | "esp" | "ses" | "unconfigured" | null;

/**
 * The transports that actually hand a message to something that delivers it.
 *
 * Mirrors `DELIVERING_TRANSPORTS` in src/modules/emails/service.ts, which computes the
 * hub's `delivered` count — the two must agree, or the log and the hub say different things
 * about the same message.
 *
 * ── WHY THIS LIVES HERE (2026-08-29) ──────────────────────────────────────────
 * It used to be written out twice: once in `lib/api/emails.ts` (server-only) and once,
 * inevitably, as a hand-copied duplicate inside `emails-table.tsx`, because a client
 * component cannot import from a server-only module. When `ses` was added to the engine
 * BOTH copies were missed, so genuine SES deliveries rendered grey with a transport of
 * "Unknown" and disappeared from the hub's counters entirely — the log vouching AGAINST
 * mail that had actually arrived, which is the precise failure the transport column exists
 * to prevent. This module has no 'use client' and no runtime server import, so both sides
 * can read one copy.
 */
export const DELIVERING_TRANSPORTS: readonly EmailTransport[] = ["smtp", "esp", "ses"];

/**
 * Whether a `sent` row actually reached a relay. The console sink accepts a message, logs
 * it and delivers nothing, so `status: 'sent'` alone is not a delivery claim — the log has
 * to say so plainly or it vouches for mail that never left.
 */
export function isRealDelivery(status: string, transport: EmailTransport): boolean {
  return status === "sent" && DELIVERING_TRANSPORTS.includes(transport);
}

/** Human label for the transport column. `null` predates the column — say so, don't guess. */
export function transportLabel(transport: EmailTransport): string {
  if (transport === "smtp") return "SMTP";
  if (transport === "ses") return "Amazon SES";
  if (transport === "esp") return "ESP";
  if (transport === "console") return "Console: not delivered";
  // A business with no transport of its own: the send was REFUSED, not attempted.
  if (transport === "unconfigured") return "No delivery method: not sent";
  return "Unknown";
}
