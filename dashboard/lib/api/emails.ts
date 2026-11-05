// Typed fetchers for the customer billing-email log. Server-only.
import { apiGet, apiWrite, listQuery, type ListParams, type PagedList } from "@/lib/api";

// Transport vocabulary lives in lib/email-types.ts so the CLIENT-side log can share one
// copy — this module is server-only, and the hand-made duplicate that fact forced is what
// let `ses` be missed in both places. Re-exported here so existing importers are unchanged.
export {
  DELIVERING_TRANSPORTS,
  isRealDelivery,
  transportLabel,
  type EmailTransport,
} from "@/lib/email-types";
import { type EmailTransport } from "@/lib/email-types";

export interface EmailMessage {
  object: "email_message";
  id: string;
  type: string;
  to: string;
  /** Additional contacts copied on this message. */
  cc?: string[];
  subject: string;
  status: string;
  /** Which transport carried it. Read together with `status` — see isRealDelivery. */
  transport: EmailTransport;
  /**
   * What the provider said AFTER accepting it, when feedback arrived over SNS. Separates
   * "the mailbox is full" (transient) from "there is no such person" (permanent) — both
   * leave the message undelivered, and only one is worth acting on.
   */
  bounce_type: "permanent" | "transient" | "undetermined" | "complaint" | null;
  attempts: number;
  last_error: string | null;
  provider_message_id: string | null;
  body_html: string;
  body_text: string;
  /** When the body was deleted after its retention period; both bodies are empty after. */
  body_removed_at: string | null;
  created_at: string;
  sent_at: string | null;
}

/** Legacy flat filters (still honoured by the endpoint) + the shared list params. */
export interface EmailFilters extends ListParams {
  type?: string;
  status?: string;
  customer?: string;
}

/**
 * One page of the business's billing-email log, optionally scoped to a
 * customer. **Paginated** (docs/GUIDE.md §3.4) — pass `limit`/`startingAfter`
 * (or use `ListPage`'s server mode) rather than assuming this is everything.
 */
export function listEmails(biz: string, filters: EmailFilters = {}) {
  const { type, status, customer, ...list } = filters;
  const flat = Object.entries({ type, status, customer }).filter(([, v]) => v) as Array<
    [string, string]
  >;
  const q = listQuery({ ...list, scope: { ...list.scope, ...Object.fromEntries(flat) } });
  return apiGet<PagedList<EmailMessage>>(`/v1/businesses/${biz}/emails${q ? `?${q}` : ""}`);
}

export function resendEmail(biz: string, id: string) {
  return apiWrite(`/v1/businesses/${biz}/emails/${id}/resend`, {}, "POST");
}

/**
 * A permanent refusal by the relay (SMTP 5xx) — terminal on the first attempt, never
 * retried. Distinct from `failed`, which means we exhausted retries on an inconclusive
 * error: `bounced` says the ADDRESS is bad (the merchant's data), `failed` usually says the
 * relay was unreachable (ours). Collapsing them makes the log unable to tell you which.
 */
export function isBounced(status: string): boolean {
  return status === "bounced";
}

// ── Activity summary ──────────────────────────────────────────────────────────

/**
 * Send counts for the settings hub. `delivered` and `not_delivered` are separate
 * because `status: 'sent'` is not a delivery claim — the console sink accepts a message
 * and delivers nothing (see isRealDelivery). Render them as two facts, never as a sum.
 */
export interface EmailActivity {
  object: "email_activity";
  window_days: number;
  delivered: number;
  not_delivered: number;
  pending: number;
  /** Gave up after the retry budget — inconclusive, usually our problem. */
  failed: number;
  /** The relay permanently refused the address (5xx). Terminal, never retried. */
  bounced: number;
  last_sent_at: string | null;
}

export function getEmailActivity(biz: string, windowDays = 30) {
  return apiGet<EmailActivity>(`/v1/businesses/${biz}/emails/activity?window_days=${windowDays}`);
}

// ── Reminder schedule ─────────────────────────────────────────────────────────

/**
 * When the time-relative reminders fire. Deployment-wide constants today, so
 * `configurable` is false and the UI must render these read-only — an input here would
 * post nowhere. Fetched rather than hardcoded because a screen may only state a default it
 * can read: the rows used to say "a few days before", vague because the real number lived
 * in a module constant nothing carried out.
 */
export interface EmailReminderSchedule {
  object: "email_reminder_schedule";
  configurable: boolean;
  /**
   * Per business (0376). `lead_days` is every lead day, largest first; `days_before` the
   * first. The `yearly_*` pair is the renewal notice on yearly plans. `configurable` is
   * false for the pre-debit notice, whose timing the mandate rules fix.
   */
  data: Array<{
    type: string;
    /** Null when the reminder is off (payment due, pause, resume, card expiry). */
    days_before: number | null;
    lead_days: number[];
    configurable: boolean;
    /** card_expiring only: true = sent in the card's expiry month, not on lead days. */
    expiry_month?: boolean;
    yearly_days_before?: number;
    yearly_lead_days?: number[];
  }>;
}

export function getEmailReminderSchedule(biz: string) {
  return apiGet<EmailReminderSchedule>(`/v1/businesses/${biz}/emails/reminders`);
}

// ── Templates ─────────────────────────────────────────────────────────────────

export interface EmailTemplate {
  object: "email_template";
  /** Null when this is the built-in — no override row exists for this (business, type). */
  id: string | null;
  type: string;
  subject: string;
  heading: string;
  body: string;
  /** This email's own footer; null uses `default_footer`. */
  footer: string | null;
  /** The business footer, else the built-in one. */
  default_footer: string;
  /** Button text override; null keeps `default_cta_label`. */
  cta_label: string | null;
  show_facts: boolean;
  block_order: EmailBlockKey[];
  /** The engine's button label, or null when this type never has a button. */
  default_cta_label: string | null;
  has_facts: boolean;
  /** The built-in wording, for "reset to default" as a draft. */
  built_in: { subject: string; heading: string; body: string };
  customized: boolean;
  /** Set while this type uses another type's customised template (e.g. Invoice issued). */
  inherits_from: string | null;
  /** `always: false` means the engine populates it only sometimes; it renders empty otherwise. */
  variables: Array<{ key: string; label: string; always: boolean; sample: string | null }>;
  /** This business's attachment rule for the email; null when it is about no document. */
  attachments: EmailAttachmentsView | null;
  updated_at: string | null;
}

export interface EmailAttachmentsView {
  document: "invoice" | "credit_note";
  pdf: boolean;
  skip_zero_pdf: boolean;
  skip_zero_send: boolean;
  can_skip_zero_pdf: boolean;
  can_skip_zero_send: boolean;
}

export type EmailBlockKey = "body" | "action" | "facts" | "footer";

/** An editor draft, in the API's shape. */
export interface EmailTemplateDraft {
  subject: string;
  heading: string;
  body: string;
  footer?: string | null;
  cta_label?: string | null;
  show_facts?: boolean;
  block_order?: EmailBlockKey[] | null;
}

export interface EmailTemplateIssue {
  field: "subject" | "heading" | "body" | "footer" | "cta_label";
  severity: "error" | "warning";
  message: string;
}

export interface EmailPreview {
  object: "email_preview";
  subject: string;
  html: string;
  text: string;
  customized: boolean;
  issues: EmailTemplateIssue[];
}

export function listEmailTemplates(biz: string) {
  return apiGet<{ object: "list"; data: EmailTemplate[] }>(
    `/v1/businesses/${biz}/emails/templates`,
  );
}

export function getEmailTemplate(biz: string, type: string) {
  return apiGet<EmailTemplate>(`/v1/businesses/${biz}/emails/templates/${type}`);
}

export function saveEmailTemplate(biz: string, type: string, body: EmailTemplateDraft) {
  return apiWrite(`/v1/businesses/${biz}/emails/templates/${type}`, body, "PUT");
}

/** Render with sample data. Pass a draft to preview unsaved edits. */
export function previewEmailTemplate(
  biz: string,
  type: string,
  draft: Partial<EmailTemplateDraft>,
) {
  return apiWrite(`/v1/businesses/${biz}/emails/templates/${type}/preview`, draft, "POST");
}

// ── SMTP transport settings ───────────────────────────────────────────────────

/**
 * Per-business SMTP transport settings.
 *
 * `password_configured` is the whole reason this is a separate resource from the business
 * PATCH: the settings screen needs to know a password EXISTS without the API ever handing
 * one back, and the generic business PATCH echoes what it wrote.
 */
/**
 * What is actually carrying this business's mail. Shared by both transport settings shapes
 * so the SMTP screen and the SES screen can never give different answers to the same
 * question — `unconfigured` means a transport is selected that throws on first send.
 */
export type EffectiveTransport = "smtp" | "ses" | "esp" | "console" | "unconfigured";

export interface SmtpSettings {
  object: "smtp_settings";
  enabled: boolean;
  host: string | null;
  port: number | null;
  encryption: "tls" | "starttls" | "none";
  username: string | null;
  password_configured: boolean;
  /** What will actually carry this business's mail right now. */
  effective_transport: EffectiveTransport;
  /** Whether mail reaches a real relay. False for the console sink, which still marks rows sent. */
  delivers: boolean;
  /**
   * The From header the engine will actually produce — this business's setting, or the
   * deployment MAIL_FROM / MAIL_FROM_NAME when blank. Render THIS as the resolved default
   * rather than guessing: the screen used to claim the From name fell back to the business
   * name, which the engine has never done.
   */
  effective_from_address: string;
  effective_from_name: string;
  from_source: "business" | "platform";
}

export interface SmtpSettingsPatch {
  enabled?: boolean;
  host?: string | null;
  port?: number | null;
  encryption?: "tls" | "starttls" | "none";
  username?: string | null;
  /** Omit to keep the stored password; '' clears it; a value replaces it. */
  password?: string;
}

export function getSmtpSettings(biz: string): Promise<SmtpSettings> {
  return apiGet<SmtpSettings>(`/v1/businesses/${biz}/emails/smtp`);
}

export function saveSmtpSettings(biz: string, body: SmtpSettingsPatch) {
  return apiWrite(`/v1/businesses/${biz}/emails/smtp`, body, "PATCH");
}

export function testSmtpConnection(biz: string) {
  return apiWrite(`/v1/businesses/${biz}/emails/smtp/test-connection`, {});
}

export function sendTestEmail(
  biz: string,
  body: { to: string; type: string; draft?: EmailTemplateDraft },
) {
  return apiWrite(`/v1/businesses/${biz}/emails/test`, body);
}

/**
 * Amazon SES, the API alternative to SMTP above. A business runs one or the other — saving
 * either with `enabled: true` switches the other off server-side, so the screen can model
 * this as a single choice.
 *
 * As with SMTP, the secret half is write-only: reads report `secret_configured`. The access
 * key ID *is* returned, because it identifies rather than authenticates the credential —
 * which is what an operator needs to see when rotating one.
 */
export interface SesSettings {
  object: "ses_settings";
  enabled: boolean;
  region: string | null;
  access_key_id: string | null;
  configuration_set: string | null;
  secret_configured: boolean;
  effective_transport: EffectiveTransport;
  delivers: boolean;
  effective_from_address: string;
  effective_from_name: string;
  from_source: "business" | "platform";
}

export interface SesSettingsPatch {
  enabled?: boolean;
  region?: string | null;
  accessKeyId?: string | null;
  configurationSet?: string | null;
  /** Omit to keep the stored key; '' clears it; a value replaces it. */
  secretAccessKey?: string;
}

export function getSesSettings(biz: string): Promise<SesSettings> {
  return apiGet<SesSettings>(`/v1/businesses/${biz}/emails/ses`);
}

export function saveSesSettings(biz: string, body: SesSettingsPatch) {
  return apiWrite(`/v1/businesses/${biz}/emails/ses`, body, "PATCH");
}

// ── Ad-hoc (operator-initiated) send ──────────────────────────────────────────

/**
 * The four types an operator can send by hand, from a record's `Email` action.
 * Mirrors ADHOC_EMAIL_TYPES in src/modules/emails/config.ts. The other twenty-six are
 * engine-fired and carry variables only the event that produced them can supply.
 */
export type AdhocEmailType =
  | "invoice_sent"
  | "payment_request"
  | "payment_method_request"
  | "credit_note_sent";

export interface AdhocEmailBody {
  type: AdhocEmailType;
  /** Required for `payment_method_request`; derived from the record otherwise. */
  customer?: string;
  /** Required for `invoice_sent` and `payment_request`. */
  invoice?: string;
  /** Required for `credit_note_sent`. */
  credit_note?: string;
  /** Override the recipient. Defaults to the customer's billing email. */
  to?: string;
  /** The operator's covering message, rendered as {{note}}. */
  note?: string;
}

export interface AdhocEmailResult {
  ok: boolean;
  error: string | null;
  /** What carried it. `console` means the dev sink accepted it and delivered nothing. */
  transport: string | null;
  email_id: string | null;
}

/**
 * Send one ad-hoc billing email.
 *
 * **Two different `ok`s meet in here and they mean different things.** `apiWrite`'s is
 * transport-level (did the request reach the engine and come back 2xx); the body's is
 * whether the mail relay accepted the message. The endpoint deliberately answers a relay
 * refusal with a 200 + `ok: false`, so returning `apiWrite`'s flag would report "sent" for
 * a message the relay bounced. They are collapsed here, once, rather than at each caller.
 */
export async function sendAdhocEmail(biz: string, body: AdhocEmailBody): Promise<AdhocEmailResult> {
  const res = await apiWrite(`/v1/businesses/${biz}/emails/send`, body);
  if (!res.ok) {
    // A 400 from the engine — unknown type, missing record, no recipient.
    return {
      ok: false,
      error: res.error ?? `Request failed (${res.status})`,
      transport: null,
      email_id: null,
    };
  }
  const data = res.data as
    | { ok?: boolean; error?: string | null; transport?: string | null; email_id?: string | null }
    | undefined;
  return {
    ok: data?.ok === true,
    error: data?.error ?? null,
    transport: data?.transport ?? null,
    email_id: data?.email_id ?? null,
  };
}

// ── Suppression list ──────────────────────────────────────────────────────────

/**
 * An address this business must not write to again, after a hard bounce or a complaint.
 *
 * Surfaced because an invisible block is its own failure mode: "we stopped emailing this
 * customer and nobody can say why" is a support call no amount of correct bounce handling
 * excuses.
 */
export interface EmailSuppression {
  object: "email_suppression";
  address: string;
  reason: "bounce" | "complaint" | "manual";
  /** The provider's own words — `Permanent/NoEmail`, `abuse`. Null when added by hand. */
  detail: string | null;
  created_at: string;
}

export function listSuppressions(biz: string) {
  return apiGet<{ object: "list"; data: EmailSuppression[] }>(
    `/v1/businesses/${biz}/emails/suppressions`,
  );
}

/** Lift a suppression. Reversible on purpose — a mailbox full in March may be fine in June. */
export function deleteSuppression(biz: string, address: string) {
  return apiWrite(
    `/v1/businesses/${biz}/emails/suppressions/${encodeURIComponent(address)}`,
    {},
    "DELETE",
  );
}
