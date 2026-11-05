/**
 * Per-business email settings resolver (mirrors resolveDunningConfig). Emails are
 * OPT-IN: a business with no `email_config` (all imported/existing businesses)
 * sends nothing, so turning tmbilling on never suddenly emails a merchant's
 * customers. A merchant enables it explicitly and may disable individual types.
 */
import { config as appConfig } from "@/platform/config";

/**
 * Every customer-facing billing email we can send.
 *
 * Grouped by what triggers them, because the three groups behave differently and the
 * distinction decides where a new type's logic belongs:
 *
 * - **Event-driven** — enqueued by the `enqueueEmails` sink when a billing event fires.
 *   Adding one is a line in `emailTypeForEvent` plus a template.
 * - **Reminder** — enqueued from a time-relative event emitted by `runRemindersPass`
 *   ("N days before X"). The events log is the dedup ledger, so one fires per occurrence.
 * - **Ad-hoc** — sent only when an operator asks (the per-record `Email` action).
 *   Never fired by the engine; see adhoc-service.ts.
 *
 * Every entry here needs a template in DEFAULT_TEMPLATES and a var list in TEMPLATE_VARS —
 * both are exhaustive `Record<EmailType, …>`, so the compiler enforces it.
 */
export type EmailType =
  // ── invoicing & payments (event-driven) ──
  | "invoice_issued"
  /**
   * `invoice_issued` for an invoice the customer pays themselves (auto-collection off,
   * money due): the due date and a Pay now button. Chosen at enqueue by the same rule that
   * decides the button (`isPayableOfflineInvoice`), so neither template needs a condition.
   * Until a business customises it, it falls back to that business's `invoice_issued`
   * override, and its on/off switch follows `invoice_issued`'s.
   */
  | "invoice_to_pay"
  | "invoice_overdue"
  | "payment_receipt"
  | "payment_failed"
  // A mandate debit above ₹15,000 that the rail paused for the payer's
  // additional-factor authentication. Distinct from payment_failed on purpose:
  // nothing has failed, and telling a customer to "update your payment details"
  // when their card is fine is how a recoverable renewal turns into churn.
  | "payment_authentication_required"
  /**
   * A PARKED invoice's reminder: the refusal is one only the customer can clear, so we
   * are not retrying and will not, and the subscription ends when the window does.
   *
   * Distinct from `dunning_retry`, which promises another attempt — the one thing this
   * must never say. Telling a parked customer "we'll try again soon" when the mandate is
   * dead or the card expired is a promise the engine has deliberately decided not to keep,
   * and it removes the only reason they would act.
   */
  | "dunning_action_required"
  /**
   * The provider ACCEPTED a refund that has not settled yet — the refund is initiated,
   * and the common case on real rails: a card refund takes 5–10 days and a
   * bank/UPI refund several days, during which the customer can see neither the original
   * charge reversed nor any acknowledgement that it is coming.
   *
   * Distinct from `refund_issued` on purpose, and the distinction is the point: telling
   * someone their money "has been refunded" while it is still in flight generates exactly
   * the support ticket the email was meant to prevent, and it is the one claim a billing
   * system cannot walk back gracefully.
   */
  | "refund_initiated"
  | "refund_issued"
  | "credit_note_issued"
  | "credit_note_applied"
  // ── subscription lifecycle (event-driven) ──
  | "subscription_activated"
  | "subscription_changed"
  | "subscription_renewed"
  | "subscription_paused"
  | "subscription_resumed"
  | "subscription_canceled"
  | "subscription_canceled_nonpayment"
  // ── trial lifecycle (event-driven) ──
  // All three are expected to be switched on: without them a trial funnel goes quiet.
  // `trial_ending` below is the time-relative warning; these three are the things that
  // actually happened.
  | "trial_started"
  | "trial_expired"
  | "trial_extended"
  // ── payment method (event-driven) ──
  | "card_expiring"
  | "card_expired"
  /**
   * The instrument was refused in a way that will not fix itself — distinct from
   * `card_expired`, which names a date the customer can read off their card. Fires
   * when the payment method becomes invalid.
   */
  | "payment_method_invalid"
  /**
   * The RAIL's standing authorization to auto-debit has ended — a mandate end date
   * passing, reported by the gateway independently of any printed card expiry. Distinct
   * from BOTH of the above: `card_expired` would print the card's own (often
   * far-future) expiry beside a sentence about the mandate, and `payment_method_invalid`
   * is written for an outright refusal, not a lapsed authorization. Rail-neutral on
   * purpose — the same event fires for card, UPI Autopay and e-mandate.
   */
  | "mandate_expired"
  // ── time-relative reminders ──
  | "trial_ending"
  | "renewal_reminder"
  | "cancellation_reminder"
  // Before the due date of an invoice the customer pays (reminder_config.payment_due).
  | "payment_due_reminder"
  // Before a scheduled pause / resume (reminder_config.pause / resume).
  | "pause_reminder"
  | "resume_reminder"
  // NPCI/RBI pre-debit notice for mandate rails — a compliance artifact, not a
  // courtesy: the payer must be told >=24h before every mandate debit.
  | "pre_debit_notification"
  // The payer's copy of an ACH debit authorization we took (Reg E 12 CFR 1005.10(b)).
  | "ach_authorization_copy"
  // A buyer left a checkout after giving their email (E6). Off until the business switches
  // it on: this is mail about a purchase the customer did not make.
  | "checkout_reminder"
  // ── usage controls (design G5 §5); usage_alert and spend_limit_reached only when the
  // control has email on ──
  | "usage_alert"
  | "spend_limit_reached"
  | "credit_auto_topup_failed"
  // The advance notice before an automatic top-up debits a mandate (a legal notice, like
  // pre_debit_notification).
  | "credit_topup_debit_notice"
  // ── operator-initiated (ad-hoc) ──
  | "invoice_sent"
  | "payment_request"
  | "payment_method_request"
  | "credit_note_sent"
  // ── system: sent only by the engine, on the customer's own request ──
  // The portal sign-in code (storefront Phase 4). Never an automatic toggle, never ad hoc.
  | "portal_sign_in_code";

/**
 * ⚠️ This array is `readonly EmailType[]`, so a MISSING entry is not a type error —
 * only a wrong one is. It is the list that drives the settings toggles, the template
 * editor and `resolveEmailConfig`'s per-type parse, so anything absent here is an
 * email the merchant can neither see, edit, nor switch off. `pre_debit_notification`
 * was omitted for exactly that reason and shipped unmanageable; `emailTypesAreExhaustive`
 * in the unit tests now pins the two together.
 */
export const EMAIL_TYPES: readonly EmailType[] = [
  "invoice_issued",
  "invoice_to_pay",
  "invoice_overdue",
  "payment_receipt",
  "payment_failed",
  "payment_authentication_required",
  "dunning_action_required",
  "refund_initiated",
  "refund_issued",
  "credit_note_issued",
  "credit_note_applied",
  "subscription_activated",
  "subscription_changed",
  "subscription_renewed",
  "subscription_paused",
  "subscription_resumed",
  "subscription_canceled",
  "subscription_canceled_nonpayment",
  "trial_started",
  "trial_expired",
  "trial_extended",
  "card_expiring",
  "card_expired",
  "payment_method_invalid",
  "mandate_expired",
  "trial_ending",
  "renewal_reminder",
  "cancellation_reminder",
  "payment_due_reminder",
  "pause_reminder",
  "resume_reminder",
  "pre_debit_notification",
  "ach_authorization_copy",
  "checkout_reminder",
  "usage_alert",
  "spend_limit_reached",
  "credit_auto_topup_failed",
  "credit_topup_debit_notice",
  "invoice_sent",
  "payment_request",
  "payment_method_request",
  "credit_note_sent",
  "portal_sign_in_code",
];

/** Sent by the engine because the customer asked for it; no toggle, operators cannot send it. */
export const SYSTEM_EMAIL_TYPES: readonly EmailType[] = ["portal_sign_in_code"];

/**
 * Types an operator sends by hand; the engine never fires them. Kept separate so the
 * settings screen does not offer an on/off toggle for an email that only exists when
 * somebody clicks Send — a toggle there would gate nothing.
 */
export const ADHOC_EMAIL_TYPES: readonly EmailType[] = [
  "invoice_sent",
  "payment_request",
  "payment_method_request",
  "credit_note_sent",
];

/** The engine-fired types — the ones the per-type opt-in toggles actually govern. */
export const AUTOMATIC_EMAIL_TYPES: readonly EmailType[] = EMAIL_TYPES.filter(
  (t) => !ADHOC_EMAIL_TYPES.includes(t) && !SYSTEM_EMAIL_TYPES.includes(t),
);

export interface EmailConfig {
  enabled: boolean;
  fromName: string | null;
  /**
   * Envelope From. Null falls back to the deployment-wide MAIL_FROM. Kept beside the
   * display name rather than in `smtp_config` because it is sender IDENTITY, not
   * transport — it stays meaningful for a business sending through the shared relay.
   */
  fromAddress: string | null;
  replyTo: string | null;
  /**
   * Copied on EVERY send — automatic, ad-hoc and test. Usually an internal archive or
   * accounts box. `bcc` is the useful one; `cc` is visible to the customer, so a merchant
   * who puts an internal address there has published it.
   */
  cc: string[];
  bcc: string[];
  /** Prepended to every rendered subject, e.g. `[Fernhill]`. Null adds nothing. */
  subjectPrefix: string | null;
  /**
   * Per-email attachment rules (0301), for the types in `EMAIL_DOCUMENT` only. A type absent
   * here gets `DEFAULT_ATTACHMENT_RULE`: the PDF attached, nothing skipped — an invoice email
   * with no invoice in it is the surprising one.
   */
  attachments: Partial<Record<EmailType, AttachmentRule>>;
  /**
   * The business footer ("Thanks, the Fernhill team"): ends every email that has no footer
   * of its own. Template syntax (common variables only), sanitised like a body. Null uses
   * `DEFAULT_FOOTER`. The key keeps its old name so stored configs and API clients carry on.
   */
  footerNote: string | null;
  /** Per-type override; a type absent here inherits `enabled`. */
  types: Partial<Record<EmailType, boolean>>;
  /** Attach the numbered receipt PDF to `payment_receipt` (0387). Default off. */
  attachReceiptPdf: boolean;
  /**
   * Where the email's links and button go: the hosted portal (default), or the merchant's
   * own page. `merchant_url` with no valid `merchantUrl` resolves to `portal`.
   */
  linkTarget: EmailLinkTarget;
  /** The merchant's page, http(s). Kept when the target goes back to the portal. */
  merchantUrl: string | null;
}

export type EmailLinkTarget = "portal" | "merchant_url";

/** An absolute http(s) URL, or null. */
export function httpUrlOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Which of a customer's additional contacts each email is copied to: `billing` reaches
 * contacts flagged "send billing emails" (money: invoices, payments, dunning, refunds,
 * credit notes, payment methods), `account` those flagged "send account emails" (the
 * subscription and trial lifecycle). Exhaustive, so a new type must pick one.
 */
export const EMAIL_AUDIENCE: Record<EmailType, "billing" | "account"> = {
  invoice_issued: "billing",
  invoice_to_pay: "billing",
  invoice_overdue: "billing",
  payment_due_reminder: "billing",
  invoice_sent: "billing",
  payment_receipt: "billing",
  payment_failed: "billing",
  payment_authentication_required: "billing",
  payment_request: "billing",
  dunning_action_required: "billing",
  refund_initiated: "billing",
  refund_issued: "billing",
  credit_note_issued: "billing",
  credit_note_applied: "billing",
  credit_note_sent: "billing",
  pre_debit_notification: "billing",
  ach_authorization_copy: "billing",
  card_expiring: "billing",
  card_expired: "billing",
  payment_method_invalid: "billing",
  payment_method_request: "billing",
  mandate_expired: "billing",
  subscription_canceled_nonpayment: "account",
  portal_sign_in_code: "account",
  subscription_activated: "account",
  subscription_changed: "account",
  subscription_renewed: "account",
  subscription_paused: "account",
  subscription_resumed: "account",
  subscription_canceled: "account",
  trial_started: "account",
  trial_expired: "account",
  trial_extended: "account",
  trial_ending: "account",
  renewal_reminder: "account",
  cancellation_reminder: "account",
  pause_reminder: "account",
  resume_reminder: "account",
  checkout_reminder: "billing",
  usage_alert: "billing",
  spend_limit_reached: "billing",
  credit_auto_topup_failed: "billing",
  credit_topup_debit_notice: "billing",
};

/** The document an email type is about, for the types that are about one. */
export const EMAIL_DOCUMENT: Partial<Record<EmailType, "invoice" | "credit_note">> = {
  invoice_issued: "invoice",
  invoice_to_pay: "invoice",
  invoice_overdue: "invoice",
  payment_due_reminder: "invoice",
  invoice_sent: "invoice",
  payment_receipt: "invoice",
  payment_failed: "invoice",
  payment_authentication_required: "invoice",
  credit_note_issued: "credit_note",
  credit_note_applied: "credit_note",
  credit_note_sent: "credit_note",
};

/**
 * The types that can be about a zero-value invoice (a free trial's first invoice, a 100%
 * coupon). A payment or an overdue reminder never is, so a zero rule there would be a
 * control that does nothing.
 */
export const ZERO_VALUE_PDF_TYPES: ReadonlySet<EmailType> = new Set([
  "invoice_issued",
  "invoice_sent",
]);
/**
 * Of those, the ones the engine may decline to send at all. Not `invoice_sent`: an operator
 * pressing "Send invoice" asked for that email, and silently not sending it would be a lie.
 */
export const ZERO_VALUE_SEND_TYPES: ReadonlySet<EmailType> = new Set(["invoice_issued"]);

export interface AttachmentRule {
  /** Attach the document's PDF. */
  pdf: boolean;
  /** …except when the invoice total is zero. */
  skipZeroPdf: boolean;
  /** Don't send the email at all when the invoice total is zero. */
  skipZeroSend: boolean;
}

export const DEFAULT_ATTACHMENT_RULE: AttachmentRule = {
  pdf: true,
  skipZeroPdf: false,
  skipZeroSend: false,
};

/** The rule in force for a type, or null when the type carries no document. */
export function attachmentRule(cfg: EmailConfig, type: EmailType): AttachmentRule | null {
  if (!EMAIL_DOCUMENT[type]) return null;
  return cfg.attachments[type] ?? DEFAULT_ATTACHMENT_RULE;
}

function parseAttachments(raw: unknown): Partial<Record<EmailType, AttachmentRule>> {
  const out: Partial<Record<EmailType, AttachmentRule>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const t of EMAIL_TYPES) {
    const r = (raw as Record<string, unknown>)[t] as Record<string, unknown> | undefined;
    if (!EMAIL_DOCUMENT[t] || !r || typeof r !== "object") continue;
    // A zero rule only survives on a type that can be about a zero-value invoice.
    out[t] = {
      pdf: r.pdf !== false,
      skipZeroPdf: ZERO_VALUE_PDF_TYPES.has(t) && r.skipZeroPdf === true,
      skipZeroSend: ZERO_VALUE_SEND_TYPES.has(t) && r.skipZeroSend === true,
    };
  }
  return out;
}

/** CRLF → LF, trailing spaces off each line, blank lines at either end dropped. */
export function normalizeLines(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/** Cap so a footer cannot become a second email body. */
export const MAX_FOOTER_NOTE_CHARS = 1000;

/** Cap so a malformed write cannot turn one invoice email into a hundred recipients. */
const MAX_COPY_RECIPIENTS = 10;

function parseAddressList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    // De-duplicated case-insensitively: two spellings of one mailbox would otherwise
    // put two copies of every invoice in it.
    if (t && !out.some((e) => e.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= MAX_COPY_RECIPIENTS) break;
  }
  return out;
}

/**
 * Stored keys no reader uses. `attachInvoicePdf` became `attachDocumentPdf` (2026-08-29,
 * with no data migration), which 0301 replaced with `attachments`; 0492 removes both from
 * stored rows. Dropped on read and on write, so a client that sends back what it read
 * is not refused for a key it never set.
 */
export const LEGACY_EMAIL_CONFIG_KEYS = ["attachInvoicePdf", "attachDocumentPdf"] as const;

export function withoutLegacyEmailKeys<T>(raw: T): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...(raw as Record<string, unknown>) };
  for (const k of LEGACY_EMAIL_CONFIG_KEYS) delete out[k];
  return out as T;
}

export function resolveEmailConfig(biz: { emailConfig?: unknown } | null | undefined): EmailConfig {
  const raw = (biz?.emailConfig ?? null) as {
    enabled?: unknown;
    fromName?: unknown;
    fromAddress?: unknown;
    replyTo?: unknown;
    cc?: unknown;
    bcc?: unknown;
    subjectPrefix?: unknown;
    footerNote?: unknown;
    attachments?: unknown;
    types?: unknown;
    attachReceiptPdf?: unknown;
    linkTarget?: unknown;
    merchantUrl?: unknown;
  } | null;
  const types: Partial<Record<EmailType, boolean>> = {};
  if (raw?.types && typeof raw.types === "object") {
    for (const t of EMAIL_TYPES) {
      const v = (raw.types as Record<string, unknown>)[t];
      if (typeof v === "boolean") types[t] = v;
    }
  }
  return {
    enabled: raw?.enabled === true,
    fromName: typeof raw?.fromName === "string" ? raw.fromName : null,
    fromAddress: typeof raw?.fromAddress === "string" && raw.fromAddress ? raw.fromAddress : null,
    replyTo: typeof raw?.replyTo === "string" ? raw.replyTo : null,
    cc: parseAddressList(raw?.cc),
    bcc: parseAddressList(raw?.bcc),
    subjectPrefix:
      typeof raw?.subjectPrefix === "string" && raw.subjectPrefix.trim()
        ? raw.subjectPrefix.trim()
        : null,
    // A browser textarea posts CRLF, and a line can carry trailing spaces; store and render
    // plain "\n"-separated lines.
    footerNote:
      typeof raw?.footerNote === "string" && raw.footerNote.trim()
        ? normalizeLines(raw.footerNote).slice(0, MAX_FOOTER_NOTE_CHARS)
        : null,
    attachments: parseAttachments(raw?.attachments),
    types,
    attachReceiptPdf: raw?.attachReceiptPdf === true,
    linkTarget:
      raw?.linkTarget === "merchant_url" && httpUrlOrNull(raw?.merchantUrl)
        ? "merchant_url"
        : "portal",
    merchantUrl: httpUrlOrNull(raw?.merchantUrl),
  };
}

/** The merchant's page when the business sends links there; null = the hosted portal. */
export function merchantLink(cfg: EmailConfig): string | null {
  return cfg.linkTarget === "merchant_url" ? cfg.merchantUrl : null;
}

/**
 * The envelope every send path must use.
 *
 * This exists because the `fromX || MAIL_FROM_X` fallback was open-coded in three send
 * paths and a fourth read (the settings view), and the settings screen's *fourth* copy of
 * the rule was wrong for two years — it claimed the From name fell back to the business
 * name. One function, so a new field like `cc` cannot reach two of the three senders.
 */
export interface SenderIdentity {
  from: string;
  fromName: string;
  replyTo: string | null;
  cc: string[];
  bcc: string[];
}

export function resolveSender(cfg: EmailConfig): SenderIdentity {
  return {
    from: cfg.fromAddress || appConfig.MAIL_FROM,
    fromName: cfg.fromName || appConfig.MAIL_FROM_NAME,
    replyTo: cfg.replyTo,
    cc: cfg.cc,
    bcc: cfg.bcc,
  };
}

/**
 * Prepend the merchant's subject prefix. Applied at SEND time, not at render time, so it
 * reaches ad-hoc and test sends too — and so `email_messages.subject` keeps the rendered
 * template subject, which is what the template editor's preview is comparable against.
 */
export function applySubjectPrefix(cfg: EmailConfig, subject: string): string {
  return cfg.subjectPrefix ? `${cfg.subjectPrefix} ${subject}` : subject;
}

/**
 * Off until the business switches them on: mail about a purchase the customer did not make,
 * and spend-limit notices the business may already send itself.
 */
export const OPT_IN_EMAIL_TYPES: readonly EmailType[] = [
  "checkout_reminder",
  "spend_limit_reached",
];

/** A specific email type is sent only when emails are enabled AND not turned off for that type. */
export function isEmailTypeEnabled(cfg: EmailConfig, type: EmailType): boolean {
  if (!cfg.enabled) return false;
  // Split out of invoice_issued: until switched on its own, it follows that switch, so a
  // business that muted invoice mail does not start receiving it for offline invoices.
  if (type === "invoice_to_pay" && cfg.types.invoice_to_pay === undefined)
    return cfg.types.invoice_issued !== false;
  // Opt-in: only an explicit switch-on sends it (see the type's own note).
  if (OPT_IN_EMAIL_TYPES.includes(type)) return cfg.types[type] === true;
  return cfg.types[type] !== false;
}
