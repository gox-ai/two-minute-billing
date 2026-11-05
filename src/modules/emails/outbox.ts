import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { systemDb, type Tx } from "@/platform/db";
import { scanBusinessFilterNullable, fairShareFor } from "@/platform/clock";
import { runBounded } from "@/platform/concurrency";
import { registerEventSink, type EventRow } from "@/modules/events/emit";
import { resourceTypeOf } from "@/modules/events/registry";
import {
  emailMessages,
  events,
  businesses,
  customers,
  invoices,
  payments,
  subscriptions,
  subscriptionItems,
  prices,
  products,
  creditNotes,
  refunds,
  paymentMethods,
  paymentMethodAuthorizations,
  transactions,
} from "@db/schema";
import { publicId } from "@/platform/ids";
import { config } from "@/platform/config";
import {
  dependencyKey,
  loadOpenDependencies,
  recordFailure,
  recordSuccess,
  type DependencyKind,
} from "@/platform/circuit-breaker";
// Dates in customer mail are BUSINESS-LOCAL calendar dates ("Aug 9, 2026"), never the raw
// timestamp — the same formatter the invoice PDF/HTML renders with, so an email and the
// document it refers to can never name two different days for one instant.
import { formatDateInTz } from "@/modules/invoicing/document";
import { accountHolderName } from "@/modules/customers/names";
import { MailerSendError, type MailAttachment } from "@/providers/mailer";
import { resolveMailer } from "./mailer-resolver";
import {
  resolveEmailConfig,
  isEmailTypeEnabled,
  attachmentRule,
  resolveSender,
  applySubjectPrefix,
  merchantLink,
  type EmailType,
  type EmailConfig,
} from "./config";
import { invoicePdf, creditNotePdf, receiptPdfForEvent } from "./attachments";
import { isSuppressed } from "./suppression";
import { TEST_MODE_SKIP_REASON, testModeAllows } from "./test-mode";
import { customerCopies, uniqueAddresses } from "./contact-copies";
import { renderEmail, formatMoney, blocksFor, brandWords, type RenderVars } from "./templates";
import { loadTemplateOverride } from "./template-service";
import { emailPortalLink, portalEntryUrl } from "./portal-link";
import { isPayableOfflineInvoice } from "./payable";
import { paysForLiveSubscription } from "./charged-card";
import { createLogger } from "@/platform/logger";
import { spendLimitMailVars, usageAlertMailVars } from "@/modules/usage-controls/mail";

const log = createLogger("emails.outbox");

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];

/** First app frame — `invoice-pdf.ts:629` — the one thing an error message cannot say. */
function originFrame(e: unknown): string | null {
  const stack = e instanceof Error ? e.stack : null;
  if (!stack) return null;
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes("node_modules")) continue;
    const m = /\/([^/\s)]+\.[cm]?tsx?):(\d+):\d+/.exec(line);
    if (m) return `${m[1]}:${m[2]}`;
  }
  return null;
}

/** The event's resource payload: buildEventData nests fields under the resource-type key. */
function resourceOf(ev: EventRow): Record<string, unknown> {
  const key = resourceTypeOf(ev.type as Parameters<typeof resourceTypeOf>[0]);
  const data = (ev.data ?? {}) as Record<string, unknown>;
  return (data[key] as Record<string, unknown> | undefined) ?? {};
}

/** The invoice a payment was for, in either the thin or the enriched payload. */
function invoiceRefOf(ev: EventRow): string | undefined {
  const inv = resourceOf(ev).invoice;
  const id = typeof inv === "string" ? inv : (inv as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id ? id : undefined;
}

/** `invoices.origin_token` prefix of an automatic top-up's invoice (`usage-controls/auto-topup`). */
const AUTO_TOPUP_ORIGIN_PREFIX = "atu:";

/** Cancellations dunning caused — a different email from a cancellation the buyer chose. */
const NONPAYMENT_CANCEL_REASONS = new Set(["not_paid", "no_card"]);

/**
 * Why a subscription was cancelled, from the event.
 *
 * Two shapes, because `buildEventContent` REPLACES the thin `{id, status, reason}` payload
 * the canceller emitted with a full subscription snapshot whenever the snapshot loads — and
 * the snapshot spells the same value `cancel_reason` (it is `subscriptions.cancel_reason`).
 * Reading only `reason` meant every enriched dunning cancellation fell through to the
 * ordinary cancellation branch.
 */
function cancelReasonOf(ev: EventRow): string | undefined {
  const res = resourceOf(ev);
  const raw = res.reason ?? res.cancel_reason;
  return typeof raw === "string" && raw ? raw : undefined;
}

/**
 * The subscription's status from the event.
 *
 * Safe under enrichment for the same reason `cancelReasonOf` is: the thin payload spells
 * it `status` and so does the snapshot that replaces it, so either shape answers.
 */
function statusOf(ev: EventRow): string | undefined {
  const raw = resourceOf(ev).status;
  return typeof raw === "string" && raw ? raw : undefined;
}

/**
 * The billing document this message is about, as a PDF attachment.
 *
 * One helper for both kinds because the decision is the same one: a message that names a
 * document should carry it. An "invoice issued" email with no invoice in it is worse
 * than one that did not arrive — nothing tells the merchant it went out incomplete.
 *
 * `email_messages_one_document_ck` guarantees at most one of the two columns is set, so the
 * branch below is a choice between them rather than an accumulation.
 */
async function documentAttachment(
  row: {
    type: string;
    invoiceId: string | null;
    creditNoteId: string | null;
    organizationId: string;
    businessId: string | null;
    eventId?: string | null;
  },
  cfg: EmailConfig,
): Promise<MailAttachment[]> {
  const docs = await invoiceOrCreditNoteAttachment(row, cfg);
  // The numbered receipt, when the business turned it on (0387). Off by default.
  if (row.type === "payment_receipt" && cfg.attachReceiptPdf && row.eventId && row.businessId)
    docs.push(...(await receiptPdfForEvent(row.organizationId, row.businessId, row.eventId)));
  return docs;
}

async function invoiceOrCreditNoteAttachment(
  row: {
    type: string;
    invoiceId: string | null;
    creditNoteId: string | null;
    organizationId: string;
    businessId: string | null;
  },
  cfg: EmailConfig,
): Promise<MailAttachment[]> {
  const rule = attachmentRule(cfg, row.type as EmailType);
  if (!row.businessId || !rule?.pdf) return [];

  if (row.invoiceId) {
    /**
     * The column is the internal uuid — a real FK, so a deleted invoice nulls it rather than
     * leaving a dangling reference — but the document assemblers address records by their
     * PUBLIC id, as every route does. One lookup bridges the two rather than weakening the
     * column to a plain string or overloading the assembler's contract. Passing the uuid
     * straight through returned null and sent the mail with no PDF, silently.
     */
    const [inv] = await systemDb
      .select({ publicId: invoices.publicId, totalMinor: invoices.totalMinor })
      .from(invoices)
      .where(eq(invoices.id, row.invoiceId))
      .limit(1);
    if (!inv || (rule.skipZeroPdf && inv.totalMinor === 0n)) return [];
    return invoicePdf(row.organizationId, row.businessId, inv.publicId);
  }

  if (row.creditNoteId) {
    const [cn] = await systemDb
      .select({ publicId: creditNotes.publicId })
      .from(creditNotes)
      .where(eq(creditNotes.id, row.creditNoteId))
      .limit(1);
    if (!cn) return [];
    return creditNotePdf(row.organizationId, row.businessId, cn.publicId);
  }

  return [];
}

/**
 * Map a billing event to the customer email it should trigger (null = no email).
 *
 * Exported for `test/unit/email-routing.test.ts` — the same reason `classifySmtpError` and
 * `classifySesError` are exported: it is a pure function whose branches decide what a customer
 * is told, and several of them (dunning cancellations, trial starts, unsettled refunds) are
 * reachable only through a provider state a live suite cannot easily produce.
 */
export function emailTypeForEvent(ev: EventRow): EmailType | null {
  switch (ev.type) {
    // An ACH authorization we took: the payer gets a copy (Reg E 1005.10(b)).
    case "payment_source_updated":
      return str((ev.data as Record<string, unknown> | null)?.ach_authorization)
        ? "ach_authorization_copy"
        : null;
    // ── invoicing & payments ──
    case "invoice_generated":
      return "invoice_issued";
    case "invoice_payment_due":
      return "invoice_overdue";
    // A payment-request child is one slice of one charge: the request's own
    // `payment_request_paid` sends the single receipt mail.
    case "payment_succeeded":
      return str(resourceOf(ev).payment_request) ? null : "payment_receipt";
    case "payment_request_paid":
      return "payment_receipt";
    // A declined signup or reactivation has no invoice: nothing to pay, no subscription to
    // keep, and the mail would say both. A settled charge reversed later carries no invoice
    // ref either, but is a real failure the customer must hear about.
    // A debit we cancelled is not a failure the payer caused or must act on.
    case "payment_failed":
      if (resourceOf(ev).code === "debit_cancelled") return null;
      return invoiceRefOf(ev) || resourceOf(ev).code === "late_failure" ? "payment_failed" : null;
    case "payment_authentication_required":
      return "payment_authentication_required";
    // A parked invoice's reminder. Deliberately NOT the failure notice: nothing was
    // attempted, and a park is the engine deciding nothing further will be.
    case "invoice_dunning_reminder":
      return "dunning_action_required";
    case "refund_created":
      // A refund the provider has only ACCEPTED is not money the customer has back yet:
      // card refunds take 5–10 days, bank/UPI several. Only an explicit `pending` routes to
      // the softer email — anything else (including a missing status on an older row) keeps
      // the previous behaviour, so this can never downgrade a genuinely settled refund.
      return statusOf(ev) === "pending" ? "refund_initiated" : "refund_issued";
    // The other half of that pair: the provider confirmed an accepted refund landed. A
    // refund that settled synchronously never raises this, so the customer gets exactly one
    // mail either way — `refund_issued` at acceptance, or `refund_initiated` then this.
    case "refund_settled":
      return "refund_issued";
    case "credit_note_created":
      return "credit_note_issued";
    case "credit_note_allocated":
      return "credit_note_applied";
    // ── subscription lifecycle ──
    case "subscription_activated":
      return "subscription_activated";
    // A subscription that STARTS in trial is a welcome, not an activation — in-trial and
    // active subscriptions are separate mail. The same event
    // fires with `status: 'active'` when a future-dated subscription starts (renewal.ts),
    // which correctly falls through to no email: activation has its own event above.
    case "subscription_started":
      return statusOf(ev) === "in_trial" ? "trial_started" : null;
    case "subscription_changed": {
      // A trial extension is its own email; an ordinary change is not. Read from the
      // ENVELOPE, because the resource payload is replaced by the snapshot on enrichment.
      const env = (ev.data ?? {}) as Record<string, unknown>;
      if (env.trial_end_extended === true) return "trial_extended";
      // Metadata, PO number, collection settings: nothing the customer bought changed.
      if (env.settings_only === true) return null;
      return "subscription_changed";
    }
    case "subscription_renewed":
      return "subscription_renewed";
    case "subscription_paused":
      return "subscription_paused";
    case "subscription_resumed":
      return "subscription_resumed";
    case "subscription_canceled": {
      const reason = cancelReasonOf(ev);
      // A trial that ran out is not churn and must not read like it. `trial_ended` is the
      // reason `cancelTrialThatDidNotConvert` stamps (subscriptions/renewal.ts), and it
      // used to take the ordinary-cancellation branch — so a customer who simply never
      // subscribed was told their subscription had been cancelled.
      // `ended_trial` covers a cardless trial cancelled as `no_card`: nobody tried to collect.
      if (
        reason === "trial_ended" ||
        (ev.data as Record<string, unknown> | null)?.ended_trial === true
      )
        return "trial_expired";
      return reason && NONPAYMENT_CANCEL_REASONS.has(reason)
        ? "subscription_canceled_nonpayment"
        : "subscription_canceled";
    }
    // ── payment method ──
    case "payment_source_expiring":
    // A lead-day notice (reminder_config.card_expiring): the same email, the same switch.
    case "payment_source_expiry_reminder":
      return "card_expiring";
    case "payment_source_expired": {
      /**
       * A LAPSED MANDATE IS NOT AN EXPIRED CARD, and `card_expired` cannot say so.
       *
       * Its copy reads "The {{cardBrand}} card ending {{cardLast4}} … has expired" and its
       * facts card prints "Expires: {{cardExpiry}}" — the PRINTED expiry. On the card rail
       * RazorPay sets the mandate's own end date independently (measured 2026-09-01:
       * end-of-month IST instants against cards printed 01/2099), so that mail would tell a
       * payer their card expired and then print 01/2099 underneath. On `upi` / `emandate`
       * there is no card at all and the placeholders fall back to
       * "The payment card ending •••• has expired. Expires: soon."
       *
       * `mandate_expired` is the rail-neutral template written for exactly this: it names
       * neither a card nor a date, and asks for the one thing that clears it — a fresh
       * authorization. Routed by the `expiry_reason` the sweep stamps top-level, because
       * `events/content.ts` replaces `data.payment_source` wholesale on enrichment, so
       * anything nested there is gone by the time this runs.
       */
      const reason = (ev.data as Record<string, unknown> | null)?.expiry_reason;
      return reason === "mandate" ? "mandate_expired" : "card_expired";
    }
    case "payment_source_invalidated":
      // A dead mandate on a working card: ask for a new authorization, not a new card.
      return (ev.data as Record<string, unknown> | null)?.invalid_reason === "mandate"
        ? "mandate_expired"
        : "payment_method_invalid";
    // ── time-relative reminders (emitted by runRemindersPass) ──
    case "subscription_trial_ending":
      return "trial_ending";
    case "subscription_renewal_reminder":
      return "renewal_reminder";
    case "subscription_cancellation_reminder":
      return "cancellation_reminder";
    case "subscription_pause_reminder":
      return "pause_reminder";
    case "subscription_resume_reminder":
      return "resume_reminder";
    case "invoice_payment_due_reminder":
      return "payment_due_reminder";
    case "subscription_pre_debit_notification":
      return "pre_debit_notification";
    // Usage controls: an alert mails only when it asks to; a limit follows the business's
    // opt-in switch for `spend_limit_reached` (isEmailTypeEnabled).
    case "usage_alert_triggered":
      return (ev.data as Record<string, unknown> | null)?.email === true ? "usage_alert" : null;
    case "spend_limit_reached":
      return "spend_limit_reached";
    // Automatic top-up: the decline, and our own advance notice (a gateway notice is the bank's).
    case "credit_auto_topup_failed":
      return "credit_auto_topup_failed";
    case "credit_auto_topup_scheduled":
      return (ev.data as Record<string, unknown> | null)?.notice_by === "ours"
        ? "credit_topup_debit_notice"
        : null;
    default:
      return null;
  }
}

/**
 * A mandate rail in the payer's words. The raw codes (`upi`, `emandate`) printed into mail
 * as "your upi mandate"; these read as "your UPI Autopay mandate" / "your bank account
 * mandate". An unknown rail passes through rather than vanishing.
 */
export function railLabel(rail: string | null | undefined): string {
  if (!rail) return "";
  return (
    (
      {
        upi: "UPI Autopay",
        emandate: "bank account",
        card: "card",
        sepa_core: "SEPA Direct Debit",
        ach: "US bank account (ACH)",
      } as Record<string, string>
    )[rail] ?? rail
  );
}

interface Resolved {
  customerId: string;
  toAddress: string;
  /** Additional contacts copied on this email type. */
  ccAddresses: string[];
  /** The customer's BCC list on document emails (0486). */
  bccAddresses: string[];
  vars: RenderVars;
  /** Carried through from the per-type resolver onto the row; see TypeVars.invoiceId. */
  invoiceId?: string | null;
  creditNoteId?: string | null;
}

/** What one per-type resolver knows: who the mail is for, and the vars only it can fill. */
interface TypeVars {
  customerId: string;
  /** Type-specific vars; the shared tail adds businessName / customerName / portalUrl. */
  vars: Partial<RenderVars>;
  /**
   * The invoice this email is about, when it is about one. Persisted on the row so DELIVERY
   * can render its PDF — the rendered invoice NUMBER in `vars` is a string, not a way back
   * to the document.
   */
  invoiceId?: string | null;
  /** The credit note it is about, for the same reason. Mutually exclusive with invoiceId. */
  creditNoteId?: string | null;
  /** A recipient other than the customer's email: the payer named on an ACH authorization. */
  toAddress?: string;
}

/** Everything a per-type resolver needs, resolved once by {@link resolveRecipient}. */
interface EventCtx {
  tx: Tx;
  ev: EventRow;
  bizId: string;
  /** `data[<resource_type>]` — the enriched resource snapshot when one loaded. */
  res: Record<string, unknown>;
  /** The whole envelope: credit-note events carry `amount_minor` / `invoice` at top level. */
  raw: Record<string, unknown>;
  /** The resource's public id (`events.resource_id`) — set for every mapped event. */
  resourceId: string;
  /** The business's IANA zone; defaults to UTC exactly like `businessTimezone()`. */
  tz: string;
  /** When the event happened — the reference point for "as of" dates and countdowns. */
  at: Date;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number"
    ? v
    : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))
      ? Number(v)
      : undefined;

/** Date | ISO string → Date. Snapshot dates survive the jsonb round-trip as strings. */
function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** A business-local calendar date ("Aug 9, 2026"). Undefined when there is no date. */
function localDate(v: unknown, tz: string): string | undefined {
  const d = asDate(v);
  return d ? formatDateInTz(d, tz) : undefined;
}

/** Whole days from `from` until `target`, as the bare number the reminder templates print. */
function daysBetween(target: Date, from: Date): string {
  return String(Math.max(0, Math.ceil((target.getTime() - from.getTime()) / 86_400_000)));
}

/**
 * The plan this subscription is for, as a customer would name it. Prefers the PLAN
 * product (a subscription can also carry add-ons and one-off charges) and falls back to
 * whatever product is on it. Never empty: `planName` is an always-populated var, so a
 * missing product would otherwise ship "Your  subscription is now active".
 */
async function planNameFor(tx: Tx, subscriptionId: string): Promise<string> {
  const rows = await tx
    .select({ name: products.name, kind: products.kind })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(products, eq(prices.productId, products.id))
    .where(eq(subscriptionItems.subscriptionId, subscriptionId));
  return rows.find((r) => r.kind === "plan")?.name ?? rows[0]?.name ?? "current plan";
}

function invoiceVars(inv: typeof invoices.$inferSelect): Partial<RenderVars> {
  return {
    amount: formatMoney(inv.totalMinor, inv.currency),
    invoiceNumber: inv.number ?? inv.publicId,
    currency: inv.currency,
  };
}

const invoiceByPublicId = async (c: EventCtx, pid: string) => {
  const [inv] = await c.tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.businessId, c.bizId), eq(invoices.publicId, pid)))
    .limit(1);
  return inv ?? null;
};

// ── per-type resolvers ────────────────────────────────────────────────────────
// One function per email family. They only differ in WHICH record names the customer
// and which vars that record can fill; the recipient gate and the common vars are the
// shared tail in resolveRecipient.

async function resolveInvoice(c: EventCtx, emailType: EmailType): Promise<TypeVars | null> {
  const inv = await invoiceByPublicId(c, str(c.res.id) ?? c.resourceId);
  if (!inv) return null;
  const vars = invoiceVars(inv);
  // A null due date means "due on issue", so the issue date is the date it is due.
  if (emailType === "invoice_to_pay") vars.dueDate = localDate(inv.dueDate ?? inv.createdAt, c.tz);
  if (emailType === "invoice_overdue") {
    // A null due date means "due on issue" (see invoices.due_date), so the issue date IS
    // the date it was due — the template states it either way and must not read "due on".
    vars.dueDate = localDate(inv.dueDate ?? inv.createdAt, c.tz);
    vars.paymentMethodType = await attemptedMethodWords(c, { invoiceId: inv.id });
  }
  if (emailType === "payment_due_reminder") {
    // The due date the reminder pass counted down to; no date, no reminder.
    const due = asDate(c.raw.due_at) ?? inv.dueDate;
    if (!due) return null;
    vars.dueDate = localDate(due, c.tz);
    vars.daysUntil = daysBetween(due, c.at);
    vars.amount = formatMoney(inv.amountDueMinor ?? inv.totalMinor, inv.currency);
  }
  return { customerId: inv.customerId, vars, invoiceId: inv.id };
}

async function resolvePayment(c: EventCtx, emailType: EmailType): Promise<TypeVars | null> {
  const data = c.res;
  const currency = str(data.currency);
  let amount: string | undefined;
  if (typeof data.amount_minor === "number" && currency)
    amount = formatMoney(data.amount_minor, currency);
  const declineMessage =
    emailType === "payment_failed"
      ? (str(data.message) ?? str(data.code) ?? "card declined")
      : undefined;
  /**
   * When collections will try again — present only when the failure actually armed a
   * retry. A park, an exhaustion or a merchant's stop carries none, and the facts card
   * drops a blank row, so the mail never promises an attempt that is not coming.
   */
  const nextAttemptDate =
    emailType === "payment_failed" ? localDate(data.next_attempt_at, c.tz) : undefined;
  let invoiceNumber: string | undefined;
  let customerId: string | null = null;
  let invoiceId: string | null = null;

  // Resolve the customer via the linked invoice, else via the payment record itself.
  const invoicePid = str(data.invoice) ?? str((data.invoice as { id?: unknown } | undefined)?.id);
  if (invoicePid) {
    const inv = await invoiceByPublicId(c, invoicePid);
    customerId = inv?.customerId ?? null;
    if (inv) invoiceNumber = inv.number ?? inv.publicId;
    // A receipt is about an invoice too — attach it to the receipt, not only to the
    // original invoice mail, because the receipt is the copy people keep.
    invoiceId = inv?.id ?? null;
  }
  // The payment itself fills what the event and the invoice did not: the customer when no
  // invoice is linked, and the amount whenever the event carried none.
  // A payment request names its customer directly.
  if (!customerId && str(data.customer)) {
    const [cus] = await c.tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.businessId, c.bizId), eq(customers.publicId, str(data.customer)!)))
      .limit(1);
    customerId = cus?.id ?? null;
  }
  if (!customerId || !amount) {
    const [pay] = await c.tx
      .select()
      .from(payments)
      .where(
        and(eq(payments.businessId, c.bizId), eq(payments.publicId, str(data.id) ?? c.resourceId)),
      )
      .limit(1);
    customerId ??= pay?.customerId ?? null;
    if (pay && !amount) amount = formatMoney(pay.amountMinor, pay.currency);
  }
  if (!customerId) return null;
  // Advertised in TEMPLATE_VARS for the AFA notice, so it has to be populated here —
  // the rail is on the event because the wording a merchant may want differs by it
  // ("your bank" vs "your UPI app").
  const mandateRail =
    emailType === "payment_authentication_required" ? railLabel(str(data.mandate_rail)) : undefined;
  const tried =
    emailType === "payment_failed" ||
    emailType === "payment_authentication_required" ||
    emailType === "payment_receipt"
      ? await attemptedMethod(c, { paymentPid: str(data.id) ?? c.resourceId, invoiceId })
      : undefined;
  const paymentMethodType =
    emailType === "payment_failed" && tried ? paymentMethodWords(tried.type) : undefined;
  // Only a card has a number worth printing; a mandate's last4 is not one the payer knows.
  const cardVars =
    tried?.type === "card" && tried.last4
      ? { cardBrand: brandWords(tried.brand) ?? "Card", cardLast4: tried.last4 }
      : {};
  return {
    customerId,
    vars: {
      amount,
      currency,
      invoiceNumber,
      declineMessage,
      mandateRail,
      nextAttemptDate,
      paymentMethodType,
      ...cardVars,
    },
    invoiceId,
  };
}

/**
 * The method a failed charge used, in the payer's words — that payment when named, else the
 * invoice's latest charge that reached a method. Undefined when nothing was charged (a
 * send-invoice invoice), never the customer's card by default: "we couldn't charge your
 * card" about a charge that never happened is false.
 */
async function attemptedMethodWords(
  c: EventCtx,
  ref: { paymentPid?: string | null; invoiceId?: string | null },
): Promise<string | undefined> {
  const tried = await attemptedMethod(c, ref);
  return tried ? paymentMethodWords(tried.type) : undefined;
}

/**
 * The method behind that payment, else the invoice's latest payment, else its latest
 * attempt. The attempt covers a charge still awaiting the payer's approval, which has no
 * payment row yet.
 */
async function attemptedMethod(
  c: EventCtx,
  ref: { paymentPid?: string | null; invoiceId?: string | null },
): Promise<{ type: string; brand: string | null; last4: string | null } | undefined> {
  const method = {
    type: paymentMethods.type,
    brand: paymentMethods.brand,
    last4: paymentMethods.last4,
  };
  const viaPayment = async (where: ReturnType<typeof and>) => {
    const [row] = await c.tx
      .select(method)
      .from(payments)
      .innerJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .where(where)
      .orderBy(desc(payments.createdAt))
      .limit(1);
    return row;
  };
  const viaAttempt = async (invoiceId: string) => {
    const [row] = await c.tx
      .select(method)
      .from(transactions)
      .innerJoin(paymentMethods, eq(paymentMethods.id, transactions.paymentMethodId))
      .where(and(eq(transactions.businessId, c.bizId), eq(transactions.invoiceId, invoiceId)))
      .orderBy(desc(transactions.occurredAt))
      .limit(1);
    return row;
  };
  return (
    (ref.paymentPid
      ? await viaPayment(
          and(eq(payments.businessId, c.bizId), eq(payments.publicId, ref.paymentPid)),
        )
      : undefined) ??
    (ref.invoiceId
      ? ((await viaPayment(
          and(eq(payments.businessId, c.bizId), eq(payments.invoiceId, ref.invoiceId)),
        )) ?? (await viaAttempt(ref.invoiceId)))
      : undefined)
  );
}

/**
 * The parked reminder. The pass supplies both facts the template needs, because neither
 * can be read back off the invoice here: `decline_message` comes from the payment that
 * parked it, and `deadline` from `parkedDunningDeadline` over the business's config.
 *
 * Both are declared `always` in TEMPLATE_VARS, so a missing one is a rendering hole rather
 * than a softer email — which is why they are carried on the event rather than re-derived.
 */
async function resolveDunningReminder(c: EventCtx): Promise<TypeVars | null> {
  const inv = await invoiceByPublicId(c, c.resourceId);
  if (!inv) return null;
  return {
    customerId: inv.customerId,
    vars: {
      ...invoiceVars(inv),
      declineMessage: str(c.res.decline_message) ?? undefined,
      deadline: str(c.res.deadline) ?? undefined,
    },
  };
}

async function resolveRefund(c: EventCtx): Promise<TypeVars | null> {
  const [ref] = await c.tx
    .select()
    .from(refunds)
    .where(and(eq(refunds.businessId, c.bizId), eq(refunds.publicId, c.resourceId)))
    .limit(1);
  // The refund names the payment it reverses; the payment names the customer.
  const payPid = str(c.res.payment);
  const [pay] = ref
    ? await c.tx.select().from(payments).where(eq(payments.id, ref.paymentId)).limit(1)
    : payPid
      ? await c.tx
          .select()
          .from(payments)
          .where(and(eq(payments.businessId, c.bizId), eq(payments.publicId, payPid)))
          .limit(1)
      : [];
  if (!pay) return null;
  const amountMinor = ref ? ref.amountMinor : num(c.res.amount_minor);
  const currency = ref?.currency ?? str(c.res.currency) ?? pay.currency;
  if (amountMinor === undefined) return null;
  let invoiceNumber: string | undefined;
  if (pay.invoiceId) {
    const [inv] = await c.tx.select().from(invoices).where(eq(invoices.id, pay.invoiceId)).limit(1);
    invoiceNumber = inv ? (inv.number ?? inv.publicId) : undefined;
  }
  return {
    customerId: pay.customerId,
    vars: { refundAmount: formatMoney(amountMinor, currency), currency, invoiceNumber },
  };
}

async function resolveCreditNote(c: EventCtx, emailType: EmailType): Promise<TypeVars | null> {
  const [cn] = await c.tx
    .select()
    .from(creditNotes)
    .where(and(eq(creditNotes.businessId, c.bizId), eq(creditNotes.publicId, c.resourceId)))
    .limit(1);
  if (!cn) return null;
  const [inv] = await c.tx.select().from(invoices).where(eq(invoices.id, cn.invoiceId)).limit(1);
  // ISSUED states the note's face value; APPLIED states what THIS allocation took off the
  // invoice, which is the top-level `amount_minor` on the allocation event (a note can be
  // allocated across several invoices, so its total would overstate each one).
  const appliedMinor =
    emailType === "credit_note_applied"
      ? (num(c.raw.amount_minor) ?? Number(cn.totalMinor))
      : Number(cn.totalMinor);
  return {
    customerId: cn.customerId,
    vars: {
      creditNoteNumber: cn.number ?? cn.publicId,
      creditAmount: formatMoney(appliedMinor, cn.currency),
      currency: cn.currency,
      ...(inv ? { invoiceNumber: inv.number ?? inv.publicId } : {}),
    },
    // The document this mail is about, so delivery can attach its PDF. NOT the invoice it
    // was applied to, even though the invoice number is rendered above: a credit-note email
    // that attached the invoice would hand the customer the wrong document.
    creditNoteId: cn.id,
  };
}

async function resolveCard(c: EventCtx, emailType: EmailType): Promise<TypeVars | null> {
  const [pm] = await c.tx
    .select()
    .from(paymentMethods)
    .where(and(eq(paymentMethods.businessId, c.bizId), eq(paymentMethods.publicId, c.resourceId)))
    .limit(1);
  if (!pm) return null;
  const month = pm.expMonth ?? num(c.res.exp_month);
  const year = pm.expYear ?? num(c.res.exp_year);
  return {
    customerId: pm.customerId,
    vars: {
      // "The {{cardBrand}} card ending …" — an unbranded method still has to read as a
      // sentence, so fall back to a word rather than to nothing.
      cardBrand: brandWords(pm.brand) ?? "payment",
      // The expiry emails are always about a card, so "••••" keeps their sentence whole.
      // A refused method may be a mandate with no card number at all: leave it empty there,
      // or the email reads "your UPI mandate ending ••••".
      cardLast4:
        pm.last4 ??
        str(c.res.last4) ??
        (emailType === "payment_method_invalid" ? undefined : "••••"),
      cardExpiry: month && year ? `${String(month).padStart(2, "0")}/${year}` : "soon",
      paymentMethodType: paymentMethodWords(pm.type ?? str(c.res.type)),
    },
  };
}

/**
 * The instrument in the buyer's words, for `customer_payment_method.type`.
 *
 * The column holds our provider-facing vocabulary (`card`, `upi`, `emandate`); a customer
 * reading "we couldn't charge your emandate" learns nothing. Anything unrecognised falls
 * back to the generic phrase rather than leaking the raw enum into a subject line.
 */
function paymentMethodWords(type: string | undefined): string {
  switch (type) {
    case "card":
      return "card";
    case "upi":
      return "UPI mandate";
    case "emandate":
    case "nach":
      return "bank mandate";
    case "wallet":
      return "wallet";
    case "paypal":
      return "PayPal account";
    default:
      return "payment method";
  }
}

/** The payer's copy of an ACH authorization: the stored row, word for word. */
async function resolveAchAuthorization(c: EventCtx): Promise<TypeVars | null> {
  const pma = str(c.raw.ach_authorization);
  if (!pma) return null;
  const [row] = await c.tx
    .select()
    .from(paymentMethodAuthorizations)
    .where(
      and(
        eq(paymentMethodAuthorizations.businessId, c.bizId),
        eq(paymentMethodAuthorizations.publicId, pma),
      ),
    )
    .limit(1);
  if (!row) return null;
  const [pm] = await c.tx
    .select({ last4: paymentMethods.last4 })
    .from(paymentMethods)
    .where(eq(paymentMethods.id, row.paymentMethodId))
    .limit(1);
  const utc = row.acceptedAt.toISOString().slice(11, 16);
  return {
    customerId: row.customerId,
    ...(row.payerEmail ? { toAddress: row.payerEmail } : {}),
    vars: {
      authorizationText: row.text,
      authorizationVersion: row.textVersion,
      acceptedAt: `${formatDateInTz(row.acceptedAt, c.tz)}, ${utc} UTC`,
      ...(pm?.last4 ? { cardLast4: pm.last4 } : {}),
    },
  };
}

/** Usage alerts and spend limits: the customer named on the payload; words from the payload. */
async function resolveUsageControl(c: EventCtx, emailType: EmailType): Promise<TypeVars | null> {
  const cus = str(c.raw.customer);
  if (!cus) return null;
  const [row] = await c.tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, c.bizId), eq(customers.publicId, cus)))
    .limit(1);
  if (!row) return null;
  const fmt = (d: Date) => formatDateInTz(d, c.tz);
  return {
    customerId: row.id,
    vars:
      emailType === "usage_alert" ? usageAlertMailVars(c.raw, fmt) : spendLimitMailVars(c.raw, fmt),
  };
}

/** Automatic top-up mail: the amount, the decline reason or the debit date and mandate. */
async function resolveAutoTopup(c: EventCtx, emailType: EmailType): Promise<TypeVars | null> {
  const pick = (k: string) => c.res[k] ?? c.raw[k];
  const cus = str(pick("customer"));
  if (!cus) return null;
  const [row] = await c.tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, c.bizId), eq(customers.publicId, cus)))
    .limit(1);
  if (!row) return null;
  const minor = pick("amount_minor");
  const currency = str(pick("currency"));
  const amount = typeof minor === "number" && currency ? formatMoney(minor, currency) : undefined;
  if (emailType === "credit_auto_topup_failed") {
    const reason = str(c.raw.decline_reason);
    return {
      customerId: row.id,
      vars: { ...(amount ? { amount } : {}), ...(reason ? { declineReason: reason } : {}) },
    };
  }
  // ISO 8601 on the event (unix seconds on an event written before 2026-11-02).
  const at = c.raw.debit_at;
  const debitAt = asDate(typeof at === "number" ? at * 1000 : at);
  if (!debitAt || !amount) return null;
  return {
    customerId: row.id,
    vars: {
      amount,
      debitDate: formatDateInTz(debitAt, c.tz),
      mandateRail: str(c.raw.mandate_rail) ?? "bank",
      mandateReference: str(c.raw.mandate_reference) ?? "",
    },
  };
}

async function resolveSubscription(c: EventCtx, emailType: EmailType): Promise<TypeVars | null> {
  const [sub] = await c.tx
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.businessId, c.bizId), eq(subscriptions.publicId, c.resourceId)))
    .limit(1);
  if (!sub) return null;
  const customerId = sub.customerId;

  // The non-payment cancellation template speaks only of the cancellation itself
  // (TEMPLATE_VARS: common + reason), so it takes none of the lifecycle vars below.
  if (emailType === "subscription_canceled_nonpayment") {
    return { customerId, vars: { reason: sub.cancelReason ?? cancelReasonOf(c.ev) } };
  }

  const base: Partial<RenderVars> = {
    subscriptionId: sub.publicId,
    planName: await planNameFor(c.tx, sub.id),
  };
  // The next billing date: the term's end, or the trial's end while trialling (no term yet).
  const renewalDate = localDate(sub.currentPeriodEnd ?? sub.trialEnd, c.tz);

  switch (emailType) {
    case "subscription_activated":
      return { customerId, vars: { ...base, renewalDate } };
    // A subscription set to cancel does not renew, so the "Next renewal" row would lie.
    case "subscription_changed":
      return {
        customerId,
        vars: {
          ...base,
          ...(sub.cancelAtPeriodEnd || sub.cancelScheduledAt ? {} : { renewalDate }),
        },
      };
    case "subscription_renewed": {
      // The renewal's own invoice is the latest one on the subscription.
      const [inv] = await c.tx
        .select({ totalMinor: invoices.totalMinor, currency: invoices.currency })
        .from(invoices)
        .where(and(eq(invoices.businessId, c.bizId), eq(invoices.subscriptionId, sub.id)))
        .orderBy(desc(invoices.createdAt))
        .limit(1);
      return {
        customerId,
        vars: {
          ...base,
          renewalDate,
          ...(inv ? { amount: formatMoney(inv.totalMinor, inv.currency) } : {}),
        },
      };
    }
    case "subscription_paused":
      // Pause takes effect the moment the event fires (a SCHEDULED pause emits
      // subscription_pause_scheduled, which maps to no email), so the event's own
      // timestamp is the pause date.
      return { customerId, vars: { ...base, pauseDate: localDate(c.at, c.tz) } };
    case "subscription_resumed":
      return { customerId, vars: { ...base, resumeDate: localDate(c.at, c.tz), renewalDate } };
    case "subscription_canceled":
      return {
        customerId,
        vars: {
          ...base,
          cancelDate: localDate(sub.canceledAt ?? c.at, c.tz),
          reason: sub.cancelReason ?? sub.cancelReasonCode ?? undefined,
        },
      };
    // ── trial lifecycle. All three state the trial's own boundary, and TEMPLATE_VARS
    // marks `trialEndDate` `always` for each, so a subscription whose trial end we cannot
    // resolve sends nothing rather than "your trial runs until ".
    //
    // `trial_expired` reads the trial end even though the subscription is by then
    // cancelled: the boundary is the fact the email is about, and `canceledAt` would say
    // the same day in the normal case but drift whenever the clock ran late.
    case "trial_started":
    case "trial_expired":
    case "trial_extended": {
      const end = asDate(sub.trialEnd) ?? asDate(c.res.trial_end);
      if (!end) return null;
      return { customerId, vars: { ...base, trialEndDate: formatDateInTz(end, c.tz) } };
    }
    // ── reminders: a countdown with no date is not a warning, it is noise. Each of
    // these needs the date it counts down to; with none resolvable we send nothing
    // rather than mail reading "ends on , in  days".
    case "trial_ending": {
      const end = asDate(sub.trialEnd) ?? asDate(c.res.trial_end);
      if (!end) return null;
      return {
        customerId,
        vars: {
          ...base,
          trialEndDate: formatDateInTz(end, c.tz),
          daysUntil: daysBetween(end, c.at),
        },
      };
    }
    case "renewal_reminder": {
      // `renewal_at` / `cancel_at` are the OCCURRENCE the reminder pass warned about,
      // carried at the envelope's top level (runRemindersPass dedupes on them). Prefer
      // them: re-deriving the date here could name a different day than the warning
      // that was already deduped and sent.
      const next =
        asDate(c.raw.renewal_at) ??
        asDate(c.res.next_billing_at) ??
        asDate(c.res.current_period_end) ??
        asDate(sub.currentPeriodEnd);
      if (!next) return null;
      const renewalMinor =
        typeof c.raw.expected_amount_minor === "number" ? c.raw.expected_amount_minor : null;
      const renewalCurrency = typeof c.raw.currency === "string" ? c.raw.currency : sub.currency;
      return {
        customerId,
        vars: {
          ...base,
          renewalDate: formatDateInTz(next, c.tz),
          daysUntil: daysBetween(next, c.at),
          // Written by the reminder pass (runRemindersPass). Absent when there was no
          // estimate: an empty amount, never a guessed one.
          ...(renewalMinor != null ? { amount: formatMoney(renewalMinor, renewalCurrency) } : {}),
        },
      };
    }
    case "pre_debit_notification": {
      // The NPCI/RBI notice. Every var here is one of the three facts the rule names
      // — amount, date, mandate reference — and all three come off the envelope the
      // reminder pass wrote rather than being re-derived: the pass deduped on that
      // exact debit date, so re-deriving risks naming a different day than the notice
      // that was already sent for this occurrence.
      const debitAt = asDate(c.raw.debit_at) ?? asDate(sub.currentPeriodEnd);
      if (!debitAt) return null;
      const amountMinor =
        typeof c.raw.expected_amount_minor === "number" ? c.raw.expected_amount_minor : null;
      const currency = typeof c.raw.currency === "string" ? c.raw.currency : sub.currency;
      return {
        customerId,
        vars: {
          ...base,
          debitDate: formatDateInTz(debitAt, c.tz),
          daysUntil: daysBetween(debitAt, c.at),
          // Absent rather than zero when the rate is unknown: the template renders an
          // empty amount, which is honest, where "₹0.00" would be a false promise.
          ...(amountMinor != null ? { amount: formatMoney(amountMinor, currency) } : {}),
          mandateReference:
            typeof c.raw.mandate_reference === "string" ? c.raw.mandate_reference : "",
          mandateRail: railLabel(typeof c.raw.mandate_rail === "string" ? c.raw.mandate_rail : ""),
          ...(c.raw.mandate_rail === "ach" ? { achDebit: "yes" } : {}),
        },
      };
    }
    // The effective date is the one the reminder pass deduped on (top-level on the envelope).
    case "pause_reminder":
    case "resume_reminder": {
      const key = emailType === "pause_reminder" ? "pause_at" : "resume_at";
      const at = asDate(c.raw[key]);
      if (!at) return null;
      const date = formatDateInTz(at, c.tz);
      return {
        customerId,
        vars: {
          ...base,
          ...(emailType === "pause_reminder" ? { pauseDate: date } : { resumeDate: date }),
          daysUntil: daysBetween(at, c.at),
        },
      };
    }
    case "cancellation_reminder": {
      const ends =
        asDate(c.raw.cancel_at) ??
        asDate(c.res.cancel_scheduled_at) ??
        asDate(c.res.canceled_at) ??
        asDate(sub.cancelScheduledAt) ??
        (sub.cancelAtPeriodEnd ? asDate(sub.currentPeriodEnd) : null) ??
        asDate(sub.canceledAt);
      if (!ends) return null;
      return {
        customerId,
        vars: {
          ...base,
          cancelDate: formatDateInTz(ends, c.tz),
          daysUntil: daysBetween(ends, c.at),
        },
      };
    }
    default:
      return null;
  }
}

/** Resolve recipient + template vars for a mapped event, honoring the customer's send_billing_email flag. */
async function resolveRecipient(
  tx: Tx,
  ev: EventRow,
  emailType: EmailType,
  // Widened for Brand Styles (0185): the shell needs the brand, not just the name.
  business: {
    name: string;
    timezone: string | null;
    logoUrl: string | null;
    iconUrl: string | null;
    brandColor: string | null;
    /** The merchant's sign-off, rendered by the shell on every email. */
    footerNote?: string | null;
    /** The merchant's page for links and the button (`merchantLink`); null = the portal. */
    merchantUrl?: string | null;
  },
): Promise<Resolved | null> {
  const bizId = ev.businessId;
  if (!bizId) return null;
  const res = resourceOf(ev);
  const resourceId = ev.resourceId ?? str(res.id);
  if (!resourceId) return null;

  const c: EventCtx = {
    tx,
    ev,
    bizId,
    res,
    raw: (ev.data ?? {}) as Record<string, unknown>,
    resourceId,
    // Same default as businessTimezone() in platform/business-tz.ts; the business row is
    // already loaded by the caller, so this costs no extra query.
    tz: business.timezone ?? "UTC",
    at: ev.createdAt ?? new Date(),
  };

  let part: TypeVars | null = null;
  switch (emailType) {
    case "invoice_issued":
    case "invoice_to_pay":
    case "invoice_overdue":
    case "payment_due_reminder":
      part = await resolveInvoice(c, emailType);
      break;
    case "payment_receipt":
    case "payment_failed":
    case "payment_authentication_required":
      part = await resolvePayment(c, emailType);
      break;
    case "dunning_action_required":
      part = await resolveDunningReminder(c);
      break;
    // Both halves of the refund pair read the same resource — the refund and its invoice.
    // Omitting `refund_initiated` here is silent: `emailTypeForEvent` names the type, this
    // switch finds no recipient, and the mail is simply never enqueued. `verify:refund-settlement`
    // is what catches that, since nothing about it is a type error.
    case "refund_initiated":
    case "refund_issued":
      part = await resolveRefund(c);
      break;
    case "credit_note_issued":
    case "credit_note_applied":
      part = await resolveCreditNote(c, emailType);
      break;
    case "card_expiring":
    case "card_expired":
    case "payment_method_invalid":
    case "mandate_expired":
      part = await resolveCard(c, emailType);
      break;
    case "ach_authorization_copy":
      part = await resolveAchAuthorization(c);
      break;
    case "usage_alert":
    case "spend_limit_reached":
      part = await resolveUsageControl(c, emailType);
      break;
    case "credit_auto_topup_failed":
    case "credit_topup_debit_notice":
      part = await resolveAutoTopup(c, emailType);
      break;
    case "subscription_activated":
    case "subscription_changed":
    case "subscription_renewed":
    case "subscription_paused":
    case "subscription_resumed":
    case "subscription_canceled":
    case "subscription_canceled_nonpayment":
    case "trial_ending":
    case "trial_started":
    case "trial_expired":
    case "trial_extended":
    case "renewal_reminder":
    case "cancellation_reminder":
    case "pause_reminder":
    case "resume_reminder":
      part = await resolveSubscription(c, emailType);
      break;
    // The ad-hoc types are sent by an operator, never by this sink (see config.ts).
    default:
      return null;
  }
  if (!part) return null;

  const [cust] = await tx
    .select()
    .from(customers)
    .where(eq(customers.id, part.customerId))
    .limit(1);
  // Recipient = the customer's primary billing email; contacts flagged for this email's
  // audience are copied. The business-level opt-in (email_config.enabled) is the gate; a
  // customer with no email is skipped.
  if (!cust?.email) return null;

  // Greeting = the ACCOUNT HOLDER (structured first/last, then company, then the legacy
  // `name` column, then the address). NOT the billing-address contact the invoice itself is
  // addressed to: automatic mail lands in a person's inbox, and "Hi Accounts Payable," is a
  // worse greeting than none. See `customers/names.ts` — the ad-hoc sender applies the same
  // rule, and this line used to be a fourth divergent copy of it. `cust.email` is non-null
  // here (guarded above) so the fallback can never leave the greeting empty.
  const customerName = accountHolderName(cust) ?? cust.email;
  const vars: RenderVars = {
    businessName: business.name,
    customerName,
    // Brand Styles (0185). Spread BEFORE `part.vars` like the rest of the shared
    // tail, but note these are read by the shell, not substituted into the body —
    // a merchant template cannot reference or displace them.
    logoUrl: business.logoUrl ?? undefined,
    iconUrl: business.iconUrl ?? undefined,
    brandColor: business.brandColor ?? undefined,
    portalUrl: business.merchantUrl ?? portalEntryUrl(),
    ...(business.footerNote ? { footerNote: business.footerNote } : {}),
    ...part.vars,
  };
  // Card and button LAST, computed from the finished var set — they read `amount`,
  // `invoiceNumber` and the rest, so they cannot be built before `part.vars` is merged.
  const blocks = blocksFor(emailType, vars);

  // A REAL destination for the button, when there is a button.
  //
  // Both actions used to point at `/portal/request`, the page that asks the buyer for
  // their email so it can send them a link — so "Pay now" did not pay, it started a
  // login, and the two buttons differed only in their label. A pre-authenticated link is
  // the difference between a button that works and a button that lies.
  //
  // Minted ONLY when a button will actually render: a welcome email has no action, and a
  // portal_sessions row per email nobody can press is a credential minted for nothing.
  // Inside the caller's transaction, so the link and the message row commit together.
  // A merchant URL is used as it is: no portal session is minted for a page that is not ours.
  if (blocks.action && !business.merchantUrl) {
    const link = await emailPortalLink(
      tx,
      { organizationId: cust.organizationId, businessId: bizId, customerId: part.customerId },
      { kind: blocks.action.kind, invoiceId: part.invoiceId ?? null },
    );
    if (link) blocks.action = { ...blocks.action, url: link };
  }

  const copies = await customerCopies(tx, part.customerId, emailType, cust.email);
  return {
    customerId: part.customerId,
    toAddress: part.toAddress ?? cust.email,
    ccAddresses: copies.cc,
    bccAddresses: copies.bcc,
    vars: { ...vars, ...blocks },
    invoiceId: part.invoiceId ?? null,
    creditNoteId: part.creditNoteId ?? null,
  };
}

/**
 * Email fan-out: the subscriber side of the email outbox (mirrors
 * webhooks.enqueueDeliveries). Runs in the SAME tx as the emitted event. Cheapest
 * gates first — unmapped event types and email-disabled businesses cost no lookup
 * past the switch / one business read. Registered as an event sink below.
 */
export async function enqueueEmails(tx: Tx, event: EventRow): Promise<void> {
  let emailType = emailTypeForEvent(event);
  if (!emailType || !event.businessId) return;

  /**
   * The one per-EVENT "don't mail" lever. `emailTypeForEvent` decides purely from the
   * event TYPE, so it has no way to say "this occurrence, not the type in general,
   * should not reach a customer" — the mandate-expiry backlog cutover needed exactly
   * that (a webhook subscriber must still hear about the demotion; the customer should
   * not be mailed about a state they have been in for weeks) and the only mechanism
   * available before this was not emitting the event AT ALL, which silenced the webhook
   * along with the mail. A source stamps `suppress_email: true` TOP-LEVEL on the
   * envelope (survives `events/content.ts` replacing the nested resource, same as
   * `expiry_reason`); nothing else reads or sets this key today, but any future source
   * with the same shape of problem — an occurrence that should notify subscribers
   * without generating customer mail — now has a lever instead of a choice between
   * "mail everyone" and "tell no one".
   */
  if ((event.data as Record<string, unknown> | null)?.suppress_email === true) return;

  const [biz] = await tx
    .select()
    .from(businesses)
    .where(eq(businesses.id, event.businessId))
    .limit(1);
  if (!biz) return;
  const cfg = resolveEmailConfig(biz);
  // An automatic top-up's invoice is the run's own business: its decline reaches the customer
  // as `credit_auto_topup_failed`, never as an invoice to pay or a payment to retry.
  if (emailType === "invoice_issued" || emailType === "payment_failed") {
    const pid =
      emailType === "payment_failed"
        ? invoiceRefOf(event)
        : (str(resourceOf(event).id) ?? event.resourceId);
    const [own] = pid
      ? await tx
          .select({ originToken: invoices.originToken })
          .from(invoices)
          .where(and(eq(invoices.businessId, event.businessId), eq(invoices.publicId, pid)))
          .limit(1)
      : [];
    if (own?.originToken?.startsWith(AUTO_TOPUP_ORIGIN_PREFIX)) return;
  }
  // An invoice the customer pays themselves gets its own email, chosen by the same rule
  // that gives it a Pay now button.
  if (emailType === "invoice_issued") {
    const pid = str(resourceOf(event).id) ?? event.resourceId;
    const [inv] = pid
      ? await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.businessId, event.businessId), eq(invoices.publicId, pid)))
          .limit(1)
      : [];
    if (inv && (await isPayableOfflineInvoice(tx, inv))) emailType = "invoice_to_pay";
  }
  // The pass checked this when it emitted; the invoice may have changed since.
  if (emailType === "payment_due_reminder") {
    const pid = str(resourceOf(event).id) ?? event.resourceId;
    const [inv] = pid
      ? await tx
          .select()
          .from(invoices)
          .where(and(eq(invoices.businessId, event.businessId), eq(invoices.publicId, pid)))
          .limit(1)
      : [];
    if (!inv || !(await isPayableOfflineInvoice(tx, inv))) return;
  }
  if (
    emailType === "card_expiring" ||
    emailType === "card_expired" ||
    emailType === "mandate_expired"
  ) {
    const pmId = str(resourceOf(event).id) ?? event.resourceId;
    if (!pmId || !(await paysForLiveSubscription(tx, event.businessId, pmId))) return;
  }
  if (!isEmailTypeEnabled(cfg, emailType)) return;

  /**
   * ONE OPERATION, ONE MAIL.
   *
   * This sink maps one event to one message, so any operation that legitimately emits the
   * same event type twice for the same object mailed the customer twice. Measured
   * 2026-09-10: an off-session `requires_action` debit (the charge-time notice, then the
   * gateway's own two seconds later), a subscription update that changed term AND items
   * AND a coupon (three `subscription_changed` events in 157ms, three identical mails), a
   * tick where online dunning's retry branch and a `due.ts` reminder pass both reported
   * the same invoice overdue.
   *
   * Keyed on the OBJECT the event is about, never the subject: "Here is your invoice"
   * carries no invoice number, so two subscriptions billing at once look identical while
   * being perfectly correct. Two part-payments, two invoices, two subscriptions are
   * separate resources and still each get their mail.
   *
   * `sent` counts alongside `pending`, because the clock delivers mid-tick — the first
   * notice may already have gone out by the time the second is enqueued.
   *
   * Scoped to the EXECUTION (`events.trace_id`), not to a stretch of wall time. A time
   * window looked equivalent and is not: the verify suites drive the billing clock days
   * forward inside a couple of real seconds, so any wall-clock window wide enough to
   * catch a duplicate would also swallow the dunning ladder's day-8 and day-15 reminders
   * — real notices, and the ones a payer most needs. A trace is one request or one tick
   * by construction, so it cannot reach across into a later one however the clock moves.
   *
   * It is therefore a NET for duplicates inside one operation, not a substitute for
   * suppressing a known duplicate at its source: a gateway restating something in a
   * later delivery is a different execution, which is why `applyActionRequired` still
   * stamps `suppress_email` itself.
   */
  if (event.resourceId && event.traceId) {
    const [duplicate] = await tx
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .innerJoin(events, eq(events.id, emailMessages.eventId))
      .where(
        and(
          eq(emailMessages.businessId, event.businessId),
          eq(emailMessages.type, emailType),
          inArray(emailMessages.status, ["pending", "sent"]),
          eq(events.resourceId, event.resourceId),
          eq(events.traceId, event.traceId),
        ),
      )
      .limit(1);
    if (duplicate) return;
  }

  const resolved = await resolveRecipient(tx, event, emailType, {
    name: biz.name,
    timezone: biz.timezone,
    logoUrl: biz.logoUrl,
    iconUrl: biz.iconUrl,
    brandColor: biz.brandColor,
    footerNote: cfg.footerNote,
    merchantUrl: merchantLink(cfg),
  });
  if (!resolved) return;

  // The customer opted out of automatic mail: no row, the same as a muted type.
  const [optOut] = await tx
    .select({ on: customers.emailNotifications })
    .from(customers)
    .where(eq(customers.id, resolved.customerId))
    .limit(1);
  if (optOut && !optOut.on) return;

  // "Don't send for zero-value invoices": no row, the same as a muted type.
  if (attachmentRule(cfg, emailType)?.skipZeroSend && resolved.invoiceId) {
    const [inv] = await tx
      .select({ totalMinor: invoices.totalMinor })
      .from(invoices)
      .where(eq(invoices.id, resolved.invoiceId))
      .limit(1);
    if (inv?.totalMinor === 0n) return;
  }

  // Read the business's override inside THIS transaction, so a template edit cannot land
  // between the lookup and the enqueue and produce a message rendered from neither
  // version. Null = never customised, and renderEmail falls back to the built-in.
  const override = event.businessId
    ? await loadTemplateOverride(tx, event.businessId, emailType)
    : null;
  const rendered = renderEmail(emailType, resolved.vars, override);
  await tx.insert(emailMessages).values({
    publicId: publicId("em"),
    organizationId: event.organizationId,
    businessId: event.businessId,
    customerId: resolved.customerId,
    eventId: event.id,
    // The document this message is about, so delivery can attach its PDF.
    invoiceId: resolved.invoiceId ?? null,
    creditNoteId: resolved.creditNoteId ?? null,
    type: emailType,
    toAddress: resolved.toAddress,
    ccAddresses: resolved.ccAddresses,
    bccAddresses: resolved.bccAddresses,
    // Prefix applied HERE, not at delivery, so `email_messages.subject` is exactly what
    // went out. The log is what support reads to answer "what did we send this customer?",
    // and a resend re-delivers this row — applying the prefix at send time meant the same
    // row could go out twice with different subjects while the log showed neither.
    subject: applySubjectPrefix(cfg, rendered.subject),
    bodyHtml: rendered.html,
    bodyText: rendered.text,
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
  });
}

// Subscribe to emitted events (composition roots import this module so the sink
// is registered before any event fires — same pattern as webhooks/outbox.ts).
registerEventSink(enqueueEmails);

/**
 * Deliver due email messages (driven by the billing clock, alongside webhook
 * deliverPending). System-wide scan; atomic claim per row so a concurrent
 * time-travel tick can't double-send; retry with exponential backoff.
 */
/**
 * A mailer kind, as the breaker names it.
 *
 * `console` and `unconfigured` reach no network and always carry `target: null`, so they
 * never reach a breaker call at all — but the mapping has to be total, and mapping them to
 * `smtp` would be a lie waiting to be read off an ops page. They fall back to `esp`, which
 * is inert here: nothing can key on it without a target.
 */
function breakerKind(kind: string): DependencyKind {
  return kind === "smtp" || kind === "ses" ? kind : "esp";
}

/**
 * Mail that announces an invoice or asks for its payment. Re-checked at send: an invoice
 * voided between enqueue and delivery is no longer owed, so the message is not sent.
 */
const VOIDED_INVOICE_STALES = new Set<string>([
  "invoice_issued",
  "invoice_to_pay",
  "invoice_overdue",
  "payment_due_reminder",
  // Not `invoice_sent`: an operator forwarding a voided invoice's copy meant to.
  "payment_request",
  "payment_failed",
  "payment_authentication_required",
  "dunning_action_required",
  "pre_debit_notification",
]);

export function staleForInvoice(type: string, invoiceStatus: string | null | undefined): boolean {
  return invoiceStatus === "voided" && VOIDED_INVOICE_STALES.has(type);
}

export async function deliverPendingEmails(now: Date): Promise<{
  attempted: number;
  sent: number;
  failed: number;
  bounced: number;
  /** Not attempted: the address is on the business's suppression list. */
  suppressed: number;
  /**
   * Not attempted: this business's relay is circuit-broken. Reported separately from
   * `suppressed` because the cause and the fix are different — a suppressed address is the
   * merchant's data, a broken circuit is their mail server — and because a pass that is
   * skipping everything must not read as a pass with nothing to do.
   */
  circuitOpen: number;
  /** Not attempted: the invoice it is about was voided after it was queued. */
  stale: number;
  /** Not attempted: a test business, and the address is not a team member's. */
  testMode: number;
  capped?: boolean;
}> {
  // BOUNDED (finding #3), same reasoning as the webhook outbox: one awaited send per row
  // with no ceiling is an unbounded tick. Oldest-due first; the next tick continues.
  //
  // FAIR (phase 2): `order by next_attempt_at limit N` alone is FIFO, and FIFO is how one
  // tenant starves the rest. A business whose relay is down accumulates the OLDEST due rows,
  // so it sorts to the front of every pass and pushes everyone else's invoices behind it —
  // measured 2026-09-01, one business holding 3,095 of 7,654 due messages, all older than
  // anyone else's, against a scan of 500. Ranking within each business first and capping the
  // rank bounds any one tenant's share of a pass without slowing a tenant that is alone.
  //
  // Two statements rather than one: the window function cannot live in a WHERE clause, and
  // selecting the ranked ids and then fetching those rows by primary key keeps the shape
  // readable — the second query is a primary-key lookup, not a second scan.
  const ranked = systemDb
    .select({
      id: emailMessages.id,
      nextAttemptAt: emailMessages.nextAttemptAt,
      rn: sql<number>`row_number() over (
        partition by ${emailMessages.businessId}
        order by ${emailMessages.nextAttemptAt}, ${emailMessages.id}
      )`.as("rn"),
    })
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.status, "pending"),
        lte(emailMessages.nextAttemptAt, now),
        scanBusinessFilterNullable(emailMessages.businessId),
      ),
    )
    .as("ranked");

  // Businesses with mail actually due right now — the divisor for the share below. A fixed
  // `rn <= 50` held a business that was ALONE in the queue to 50 messages a minute, which is
  // precisely what the comment above and `TICK_FAIR_SHARE_PER_BUSINESS`'s own note both say
  // it does not do. See `fairShareFor`.
  // Gated: OFF, the pass runs exactly the query set it always did — no count, fixed share.
  const dynamicShare = config.TICK_FAIR_SHARE_DYNAMIC === "TRUE";
  const [busy] = !dynamicShare
    ? [undefined]
    : await systemDb
        .select({ n: sql<number>`count(distinct ${emailMessages.businessId})::int` })
        .from(emailMessages)
        .where(
          and(
            eq(emailMessages.status, "pending"),
            lte(emailMessages.nextAttemptAt, now),
            scanBusinessFilterNullable(emailMessages.businessId),
          ),
        );
  const share = dynamicShare ? fairShareFor(busy?.n ?? 1) : config.TICK_FAIR_SHARE_PER_BUSINESS;

  const picked = await systemDb
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.rn, share))
    .orderBy(ranked.nextAttemptAt)
    .limit(config.TICK_SCAN_LIMIT);

  const due = picked.length
    ? await systemDb
        .select()
        .from(emailMessages)
        .where(
          inArray(
            emailMessages.id,
            picked.map((p) => p.id),
          ),
        )
        .orderBy(emailMessages.nextAttemptAt)
    : [];
  const capped = picked.length >= config.TICK_SCAN_LIMIT;

  // Businesses seen this pass. A pass is typically many rows across few businesses, and
  // the row loop needs the business for BOTH the From identity and (now) the transport,
  // so re-fetching per row was already a query per message. Scoped to the pass, never
  // longer: settings saved mid-pass take effect on the next tick, seconds later.
  const bizCache = new Map<string, typeof businesses.$inferSelect | undefined>();
  const loadBusiness = async (id: string) => {
    if (bizCache.has(id)) return bizCache.get(id);
    const [b] = await systemDb.select().from(businesses).where(eq(businesses.id, id)).limit(1);
    bizCache.set(id, b);
    return b;
  };

  let sent = 0;
  let failed = 0;
  /** Permanently refused by the relay — terminal, and NOT counted as `failed`. */
  let bounced = 0;
  /** Not attempted: the provider already told us the address is dead. */
  let suppressed = 0;
  /** Not attempted: a test business, and the address is not a team member's. */
  let testMode = 0;
  let stale = 0;
  // Same wall-clock budget as the webhook outbox (finding #3): one awaited send per row
  // with no ceiling is an unbounded pass. Checked between rows so no send is abandoned.
  const deadline = Date.now() + config.TICK_PASS_BUDGET_MS;
  let budgetSpent = false;
  let attempted = 0;
  /**
   * Which relays are currently cut off — read ONCE, here, and consulted in memory below.
   *
   * A breaker that queried per row would have reintroduced a per-row cost to remove one.
   * The snapshot is stale by at most one pass, which is right in both directions: a relay
   * that dies mid-pass costs one timeout rather than hundreds, and one that recovers
   * mid-pass waits at most a minute to be probed.
   */
  const openDeps = await loadOpenDependencies(now);
  /** Not attempted: the relay is circuit-broken and nothing was sent to it. */
  let circuitOpen = 0;
  // BOUNDED-CONCURRENT since 2026-09-11 (was serial). Every row here is a call to a relay we
  // do not own, so awaiting each before starting the next made throughput `budget ÷ latency`
  // — and on 2026-09-01 one unreachable SMTP host took this pass to 103s of a 115s sweep.
  // `TICK_EGRESS_CONCURRENCY` defaults to 1, so this is the old behaviour until stated.
  //
  // Paired with `fairShareFor` deliberately: concurrency alone would have bought nothing
  // while the scan still capped one business at 50 rows.
  //
  // Safe because the atomic claim below already assumed concurrent scanners — a travel step
  // and the real tick could always race — so the lease, not the serial loop, is what stops a
  // message being sent twice.
  // Atomic claim (push nextAttemptAt forward) so only one scanner sends a row. ONE statement for
  // the whole pick, `skip locked`, as in the webhook outbox: claimed row by row, every concurrent
  // drain tried every candidate.
  const claimedIds = new Set<string>();
  if (due.length > 0) {
    const leaseUntil = new Date(now.getTime() + 60_000).toISOString();
    const ids = "{" + due.map((r) => r.id).join(",") + "}";
    const rows = (await systemDb.execute(sql`
      update email_messages set next_attempt_at = ${leaseUntil}::timestamptz
      where id in (select id from email_messages
                   where id = any(${ids}::uuid[]) and status = 'pending'
                     and next_attempt_at <= ${now.toISOString()}::timestamptz
                   for update skip locked)
      returning id`)) as unknown as Array<{ id: string }>;
    for (const r of rows) claimedIds.add(r.id);
  }
  const run = await runBounded(
    due.filter((r) => claimedIds.has(r.id)),
    config.TICK_EGRESS_CONCURRENCY,
    async (row) => {
      attempted++;

      // Per-business From identity AND transport (both fall back to deployment config).
      const biz = row.businessId ? await loadBusiness(row.businessId) : undefined;
      const cfg = resolveEmailConfig(biz);
      const sender = resolveSender(cfg);
      // The whole row, not a hand-listed subset: resolveMailer reads whichever transport
      // columns a business has configured, and re-listing them here meant every new transport
      // had to remember to add itself at three call sites or silently never activate.
      const mailer = resolveMailer(biz ?? null);

      /**
       * The provider already told us this address is dead — do not ask it again.
       *
       * Checked at DELIVERY rather than at enqueue, because a bounce can land in between: an
       * invoice queued on Monday and sent on Tuesday must respect a suppression added on
       * Monday night. This is the point of the whole SNS path — continuing to mail addresses
       * SES has bounced is what drives the account-level bounce rate that gets sending paused.
       *
       * `skipped`, not `failed`: nothing was attempted and nothing went wrong. It is the same
       * status an email-type toggle produces, and the reason is on the row.
       */
      if (row.invoiceId && VOIDED_INVOICE_STALES.has(row.type)) {
        const [inv] = await systemDb
          .select({ status: invoices.status })
          .from(invoices)
          .where(eq(invoices.id, row.invoiceId))
          .limit(1);
        if (staleForInvoice(row.type, inv?.status)) {
          await systemDb
            .update(emailMessages)
            .set({
              status: "skipped",
              lastError: "The invoice was voided before we sent this email.",
              lastAttemptAt: now,
              nextAttemptAt: null,
            })
            .where(eq(emailMessages.id, row.id));
          stale++;
          return;
        }
      }

      if (row.businessId && (await isSuppressed(row.businessId, row.toAddress))) {
        await systemDb
          .update(emailMessages)
          .set({
            status: "skipped",
            lastError: "Address is suppressed after an earlier bounce or complaint.",
            lastAttemptAt: now,
            nextAttemptAt: null,
          })
          .where(eq(emailMessages.id, row.id));
        suppressed++;
        return;
      }

      // A test business never mails a real customer: skipped, with the reason on the row.
      if (!(await testModeAllows(biz, row.toAddress))) {
        await systemDb
          .update(emailMessages)
          .set({
            status: "skipped",
            lastError: TEST_MODE_SKIP_REASON,
            lastAttemptAt: now,
            nextAttemptAt: null,
          })
          .where(eq(emailMessages.id, row.id));
        testMode++;
        return;
      }

      /**
       * This relay is not answering, so do not call it — the whole point of the breaker.
       *
       * The row is left `pending` with its attempt count UNTOUCHED and pushed to the probe
       * time. That is deliberate: burning one of six attempts on a send we never made would
       * quietly exhaust the queue during an outage and mark blameless mail `failed`. Nothing
       * was tried, so nothing is counted.
       */
      const depKey = mailer.target
        ? dependencyKey(breakerKind(mailer.kind), row.businessId, mailer.target)
        : null;
      if (depKey && openDeps.has(depKey)) {
        await systemDb
          .update(emailMessages)
          .set({ nextAttemptAt: new Date(now.getTime() + config.CIRCUIT_BREAKER_COOLDOWN_MS) })
          .where(eq(emailMessages.id, row.id));
        circuitOpen++;
        return;
      }

      const attempts = row.attempts + 1;
      // 0249: how long this row occupied a lane. Started BEFORE `documentAttachment` on
      // purpose — an invoice PDF render is our own work, but it is work this pass waits on
      // just the same, and sizing egress concurrency off the transport alone would omit it.
      // (The webhook side times only the POST because it has no equivalent build step.)
      const attemptStartedAt = Date.now();
      try {
        const attachments = await documentAttachment(row, cfg);
        // Contacts first, then the business's own copies; a suppressed contact is dropped
        // here, at delivery, for the same reason the To address is checked above.
        const contactCc: string[] = [];
        for (const a of row.ccAddresses ?? []) {
          if (row.businessId && (await isSuppressed(row.businessId, a))) continue;
          if (await testModeAllows(biz, a)) contactCc.push(a);
        }
        const cc = uniqueAddresses([...contactCc, ...sender.cc], [row.toAddress]);
        // The customer's BCC list, checked like the CC list; then the business's own.
        const customerBcc: string[] = [];
        for (const a of row.bccAddresses ?? []) {
          if (row.businessId && (await isSuppressed(row.businessId, a))) continue;
          if (await testModeAllows(biz, a)) customerBcc.push(a);
        }
        const bcc = uniqueAddresses(
          [...customerBcc, ...(sender.bcc ?? [])],
          [row.toAddress, ...cc],
        );
        const res = await mailer.send({
          to: row.toAddress,
          ...sender,
          cc,
          bcc,
          // Already prefixed at enqueue — deliberately NOT re-applied here, or a resend
          // would stack "[Fernhill] [Fernhill] …".
          subject: row.subject,
          html: row.bodyHtml,
          text: row.bodyText,
          idempotencyKey: row.publicId,
          ...(attachments.length ? { attachments } : {}),
        });
        // `transport` is written together with `sent` and never separately: a row saying
        // sent with no transport would be the same unfalsifiable delivery claim this
        // column was added to retire.
        await systemDb
          .update(emailMessages)
          .set({
            status: "sent",
            transport: mailer.kind,
            attempts,
            lastAttemptAt: now,
            sentAt: now,
            durationMs: Date.now() - attemptStartedAt,
            providerMessageId: res.providerMessageId,
            lastError: null,
          })
          .where(eq(emailMessages.id, row.id));
        sent++;
        // The relay answered. `wasOpen` is false in the overwhelming common case, and the
        // update below is a no-op write guarded on the row actually being dirty — so a
        // healthy system does not write a breaker row per message.
        if (depKey) await recordSuccess(depKey, now, openDeps.has(depKey));
      } catch (e) {
        /**
         * Anything that is not a `MailerSendError` is OUR code throwing on the way to the
         * send, not a relay refusing — so it is an ERROR with a stack, not a delivery warning.
         * A WARNING carries no stack, Error Reporting skips entries without one, and a PDF
         * renderer crash spent three production sends looking exactly like a flaky relay.
         */
        const engineFault = !(e instanceof MailerSendError);
        const message = (e as Error).message ?? "send failed";
        // The frame is what `message` structurally cannot say, and `lastError` is what the
        // email-detail dialog puts in front of an operator. Relay refusals keep the relay's
        // own words — the stack there is ours and points at the send call, not the cause.
        const frame = engineFault ? originFrame(e) : null;
        const recorded = frame ? `${message} (at ${frame})` : message;
        /**
         * A relay that said 5xx will say 5xx again. Retrying "no such mailbox" six times over
         * six hours achieves nothing, and worse, it buries the actual reason under "gave up
         * after 6 attempts" — so the row goes terminal on the FIRST attempt, as `bounced`.
         *
         * `bounced` is a distinct status from `failed` on purpose: `failed` means we ran out
         * of attempts and the last word was inconclusive (relay down, timeout), which is
         * usually OUR problem; `bounced` means the far side refused this address, which is
         * the merchant's data problem and needs a different action. Collapsing them would
         * make the log unable to answer "is this address bad, or was the relay down?".
         *
         * Only an adapter that classified the failure can set this — a plain Error is
         * transient by default, so the console sink and the esp stub keep retrying.
         */
        const permanent = e instanceof MailerSendError && e.permanent;
        const code = e instanceof MailerSendError ? e.code : undefined;
        /**
         * Count this against the RELAY, not the message — see `MailerSendError.fault`.
         *
         * Only a transport fault qualifies. A relay that answers and refuses one message is
         * healthy, and breaking on that would suppress every other business sharing it over
         * one merchant's bad From address. The row still takes its ordinary retry path below;
         * the breaker decides whether the NEXT row even tries.
         */
        if (depKey && e instanceof MailerSendError && e.fault === "transport") {
          await recordFailure(depKey, breakerKind(mailer.kind), row.businessId, message, now);
        }
        // Record the transport on failures too — "which relay refused this" is the first
        // question asked of a failed row, and it is unrecoverable afterwards once a
        // merchant edits their SMTP settings in response.
        if (permanent) {
          await systemDb
            .update(emailMessages)
            .set({
              status: "bounced",
              transport: mailer.kind,
              attempts,
              lastAttemptAt: now,
              durationMs: Date.now() - attemptStartedAt,
              lastError: recorded,
            })
            .where(eq(emailMessages.id, row.id));
          bounced++;
          log.warn("[mailer] permanently refused — not retrying", {
            email: row.publicId,
            transport: mailer.kind,
            attempts,
            code,
            error: message,
          });
          return;
        }
        const terminal = attempts >= MAX_ATTEMPTS;
        if (terminal) {
          await systemDb
            .update(emailMessages)
            .set({
              status: "failed",
              transport: mailer.kind,
              attempts,
              lastAttemptAt: now,
              durationMs: Date.now() - attemptStartedAt,
              lastError: recorded,
            })
            .where(eq(emailMessages.id, row.id));
          failed++;
        } else {
          const backoff = BACKOFF_SECONDS[attempts - 1] ?? 21600;
          await systemDb
            .update(emailMessages)
            .set({
              transport: mailer.kind,
              attempts,
              lastAttemptAt: now,
              durationMs: Date.now() - attemptStartedAt,
              lastError: recorded,
              nextAttemptAt: new Date(now.getTime() + backoff * 1000),
            })
            .where(eq(emailMessages.id, row.id));
        }
        if (engineFault) {
          log.error(e, {
            email: row.publicId,
            transport: mailer.kind,
            attempts,
            terminal,
          });
        } else if (terminal) {
          // `failed` is written above — no further attempt is ever made, so do not promise one.
          log.warn("[mailer] delivery failed, out of attempts — giving up", {
            email: row.publicId,
            transport: mailer.kind,
            attempts,
            code,
            error: message,
          });
        } else {
          log.warn("[mailer] delivery failed, will retry", {
            email: row.publicId,
            transport: mailer.kind,
            attempts,
            code,
            error: message,
          });
        }
      }
    },
    { deadline },
  );
  budgetSpent = run.unstarted.length > 0;
  // Leased but never reached: due again now rather than when the lease runs out.
  if (run.unstarted.length > 0) {
    const ids = "{" + run.unstarted.map((r) => r.id).join(",") + "}";
    await systemDb.execute(sql`
      update email_messages set next_attempt_at = ${now.toISOString()}::timestamptz
      where id = any(${ids}::uuid[]) and status = 'pending'`);
  }
  // A row whose handler THREW rather than returning — our own code failing on the way to a
  // send, which the per-row try/catch above already classifies as an engine fault. Counted
  // as failed so a pass can never report more successes than it had rows.
  for (const outcome of run.settled) {
    if (!outcome.ok) {
      failed++;
      log.error(outcome.error, {
        event: "email_pass_failed",
        email: outcome.item.publicId,
      });
    }
  }
  return {
    attempted,
    sent,
    failed,
    bounced,
    suppressed,
    testMode,
    circuitOpen,
    stale,
    ...(capped || budgetSpent
      ? { capped: true, cappedBy: budgetSpent ? ("budget" as const) : ("scan_limit" as const) }
      : {}),
  };
}
