/**
 * Operator-initiated ("ad-hoc") billing email — the per-record `Email` action.
 *
 * The engine never fires these types (see ADHOC_EMAIL_TYPES in config.ts). They exist
 * because a human looked at one invoice, customer or credit note and decided to mail it,
 * so this path is deliberately shaped like `sendTestEmail` rather than like the outbox:
 * resolve → render → send NOW → record a terminal row. The operator is watching a spinner;
 * handing their click to the billing clock would answer them a minute later at best.
 *
 * Two decisions here look wrong at a glance and are not:
 *
 * 1. **No `email_config.enabled` gate.** That flag governs AUTOMATIC engine mail, so a
 *    business that has not opted in never surprises its customers. An operator pressing
 *    Send has already made that decision for this one message: a merchant can email an
 *    invoice from the invoice page without first switching on automated billing mail. Gating here would make the button silently do
 *    nothing, which is worse than either outcome. (The per-type toggles are likewise not
 *    consulted: `AUTOMATIC_EMAIL_TYPES` excludes these four, so there is no toggle to read.)
 *
 * 2. **The required record is resolved before anything is rendered, and a miss throws.**
 *    A missing `{{var}}` renders as empty text, silently (see RenderVars) — "Invoice  for "
 *    is a worse outcome than a 400, because it is already in the customer's inbox.
 */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businesses, creditNotes, customers, emailMessages, invoices } from "@db/schema";
import { accountHolderName } from "@/modules/customers/names";
import { publicId } from "@/platform/ids";
import {
  ADHOC_EMAIL_TYPES,
  resolveEmailConfig,
  attachmentRule,
  resolveSender,
  applySubjectPrefix,
  merchantLink,
  type EmailType,
} from "./config";
import { resolveMailer } from "./mailer-resolver";
import { invoicePdf, creditNotePdf } from "./attachments";
import { customerCopies, uniqueAddresses } from "./contact-copies";
import { isSuppressed } from "./suppression";
import { testModeAllows } from "./test-mode";
import { renderEmail, formatMoney, TEMPLATE_VARS, blocksFor, type RenderVars } from "./templates";
import { loadTemplateOverride } from "./template-service";
import { emailPortalLink, portalEntryUrl } from "./portal-link";
import { isPayableOfflineInvoice } from "./payable";
import { invoiceOutstanding } from "@/modules/invoicing/service";
import { createLogger } from "@/platform/logger";

const log = createLogger("emails.adhoc");

/** Anything the caller can fix by changing the request: bad type, missing record, no recipient. */
export class AdhocEmailError extends Error {}

export interface AdhocEmailInput {
  type: EmailType;
  /**
   * PUBLIC ids (`cus_…` / `inv_…` / `cn_…`) — the ids the API and the dashboard hold.
   * Which one is required depends on `type`; see REQUIRED_RECORD.
   */
  customerId?: string | null;
  invoiceId?: string | null;
  creditNoteId?: string | null;
  /** `payment_request` only: a grouped request (`preq_…`) instead of one invoice (0388). */
  paymentRequestId?: string | null;
  /** Override the recipient. Defaults to the customer's billing email. */
  to?: string | null;
  /** The operator's covering message, rendered as `{{note}}`. Optional. */
  note?: string | null;
}

export interface AdhocEmailResult {
  ok: boolean;
  error: string | null;
  transport: string;
  email_id: string;
}

/** Which record each ad-hoc type cannot be composed without. */
const REQUIRED_RECORD: Record<string, "invoice" | "credit_note" | "customer"> = {
  invoice_sent: "invoice",
  payment_request: "invoice",
  credit_note_sent: "credit_note",
  payment_method_request: "customer",
};

/** "Jul 24, 2026" in the business timezone. Templates take pre-formatted date STRINGS —
 *  a raw ISO timestamp in customer mail reads as "due 2026-08-09T18:30:00.000Z". */
function formatDateInTz(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(d));
}

/**
 * Send one ad-hoc email immediately and record it.
 *
 * Throws `AdhocEmailError` for anything the caller can correct (unknown type, missing
 * record, no recipient) — those are 400s. A transport refusal is NOT an error: it comes
 * back as `ok: false` with the relay's own message, because "your SMTP host rejected this"
 * is the useful answer, not an API failure.
 */
export async function sendAdhocEmail(
  organizationId: string,
  businessId: string,
  input: AdhocEmailInput,
): Promise<AdhocEmailResult> {
  const type = input.type;
  if (!ADHOC_EMAIL_TYPES.includes(type)) {
    throw new AdhocEmailError(
      `'${type}' is not an operator-sendable email type. Sendable types: ${ADHOC_EMAIL_TYPES.join(", ")}`,
    );
  }
  const note = input.note?.trim() || undefined;

  // ── Resolve the record, the recipient and every merge variable, in one snapshot ──
  // For the zero-value attachment rule, read once while the invoice is loaded.
  let invoiceTotalMinor: bigint | null = null;
  const loaded = await withTenant(organizationId, async (tx) => {
    const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
    if (!biz) throw new AdhocEmailError("Business not found");
    const tz = biz.timezone || "UTC";

    const vars: RenderVars = {
      businessName: biz.name,
      customerName: "",
      note,
      // Brand Styles (0185), read by the SHELL and not substituted into the body — so a
      // merchant template can neither reference nor displace them. Automatic mail has
      // carried these since 0185 and this path did not, which meant the one email an
      // operator sends by hand was the one that arrived unbranded: `brandedShell` falls
      // back to `#111111`, so a merchant's accent colour became a black button and their
      // logo became plain text.
      logoUrl: biz.logoUrl ?? undefined,
      iconUrl: biz.iconUrl ?? undefined,
      brandColor: biz.brandColor ?? undefined,
      // Same treatment as the outbox: the portal button appears only when the deployment
      // has a portal to point at. `portalEntryUrl()`, not the bare `PORTAL_BASE_URL` this
      // used to read — that is the deployment ROOT, so the button skipped `/portal`
      // entirely. The pre-authenticated link replaces this below, when a button renders.
      portalUrl: portalEntryUrl(),
    };
    let customerRowId: string | null = null;

    if (type === "payment_request" && input.paymentRequestId) {
      // A grouped request: every open invoice it holds, and the live total.
      const { loadPaymentRequestView } = await import("@/modules/payment-requests/service");
      const view = await loadPaymentRequestView(tx, businessId, input.paymentRequestId);
      if (!view)
        throw new AdhocEmailError(
          `Payment request '${input.paymentRequestId}' was not found in this business.`,
        );
      const open = view.lines.filter((l) => l.state === "open");
      if (open.length === 0)
        throw new AdhocEmailError(
          `Payment request '${input.paymentRequestId}' has nothing to pay.`,
        );
      customerRowId = view.request.customerId;
      vars.invoiceNumber = open.map((l) => l.invoice.number ?? l.invoice.publicId).join(", ");
      vars.currency = view.request.currency;
      vars.amount = formatMoney(view.amountMinor, view.request.currency);
      const due = open.map((l) => l.invoice.dueDate ?? l.invoice.createdAt);
      vars.dueDate = formatDateInTz(new Date(Math.min(...due.map((d) => d.getTime()))), tz);
    } else if (type === "invoice_sent" || type === "payment_request") {
      if (!input.invoiceId)
        throw new AdhocEmailError(`An invoice is required to send a '${type}' email.`);
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, input.invoiceId)))
        .limit(1);
      if (!inv)
        throw new AdhocEmailError(`Invoice '${input.invoiceId}' was not found in this business.`);
      customerRowId = inv.customerId;
      vars.invoiceNumber = inv.number ?? inv.publicId;
      vars.currency = inv.currency;
      // `invoice_sent` forwards the document, so it states the invoice TOTAL.
      // `payment_request` asks for money, so it states what is still OUTSTANDING —
      // quoting the total on a part-paid invoice asks the customer to pay twice for the
      // part they already settled.
      // The stored due never has cash taken off, so the outstanding is computed.
      const minor =
        type === "payment_request"
          ? (await invoiceOutstanding(tx, inv)).remainingMinor
          : inv.totalMinor;
      vars.amount = formatMoney(minor, inv.currency);
      invoiceTotalMinor = inv.totalMinor;
      // A null due date means "due on issue", so the issue date is the date it was due.
      vars.dueDate = formatDateInTz(inv.dueDate ?? inv.createdAt, tz);
      if (type === "invoice_sent") vars.invoicePayable = await isPayableOfflineInvoice(tx, inv);
    } else if (type === "credit_note_sent") {
      if (!input.creditNoteId)
        throw new AdhocEmailError(`A credit note is required to send a '${type}' email.`);
      const [cn] = await tx
        .select()
        .from(creditNotes)
        .where(
          and(eq(creditNotes.businessId, businessId), eq(creditNotes.publicId, input.creditNoteId)),
        )
        .limit(1);
      if (!cn)
        throw new AdhocEmailError(
          `Credit note '${input.creditNoteId}' was not found in this business.`,
        );
      customerRowId = cn.customerId;
      vars.creditNoteNumber = cn.number ?? cn.publicId;
      vars.creditAmount = formatMoney(cn.totalMinor, cn.currency);
      vars.currency = cn.currency;
    } else {
      // payment_method_request — nothing to attach but the customer being asked.
      if (!input.customerId)
        throw new AdhocEmailError(`A customer is required to send a '${type}' email.`);
    }

    const [cust] = customerRowId
      ? await tx.select().from(customers).where(eq(customers.id, customerRowId)).limit(1)
      : await tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.businessId, businessId),
              eq(customers.publicId, input.customerId as string),
            ),
          )
          .limit(1);
    if (!cust) throw new AdhocEmailError("The customer for this record was not found.");
    // The greeting is the ACCOUNT HOLDER, deliberately NOT the invoice rule the document
    // itself uses: a buyer whose invoices are addressed to their company's accounts-payable
    // contact should still be greeted by their own name, not "Hi Accounts Payable,".
    // See `customers/names.ts` — the two chains disagree on purpose.
    vars.customerName = accountHolderName(cust) ?? "there";

    // Explicit `to` wins — an operator mailing an invoice to a buyer's accounts inbox is
    // the common case, and it must not rewrite the customer's stored billing address.
    const toAddress = input.to?.trim() || cust.email;
    if (!toAddress) {
      throw new AdhocEmailError(
        `${vars.customerName} has no billing email address. Add one to the customer, or supply a recipient.`,
      );
    }

    // Every variable the type promises must actually carry a value. TEMPLATE_VARS is the
    // published contract (the template editor renders it), so it is also the check: an
    // `always: true` key left empty would ship "Invoice  for " to a real customer, and no
    // part of the render path fails on it.
    const blank = TEMPLATE_VARS[type]
      .filter((v) => v.always)
      .filter((v) => !String((vars as unknown as Record<string, unknown>)[v.key] ?? "").trim())
      .map((v) => v.key);
    if (blank.length) {
      throw new AdhocEmailError(
        `Cannot compose a '${type}' email: ${blank.join(", ")} ${blank.length === 1 ? "is" : "are"} missing on the selected record.`,
      );
    }

    // A merchant's customised template governs an ad-hoc send exactly as it governs an
    // automatic one — read in the same snapshot as the record, so an edit cannot land
    // between the lookup and the render.
    const override = await loadTemplateOverride(tx, businessId, type);
    // Copies whenever it goes to the customer's own billing address — left blank, or as the
    // dashboard sends it, pre-filled. An operator who changed the recipient asked for that
    // one person.
    const toCustomer = !!cust.email && toAddress.toLowerCase() === cust.email.trim().toLowerCase();
    const copies = toCustomer
      ? await customerCopies(tx, cust.id, type, toAddress)
      : { cc: [], bcc: [] };
    return {
      biz,
      customerRowId: cust.id,
      toAddress,
      ccAddresses: copies.cc,
      bccAddresses: copies.bcc,
      vars,
      override,
    };
  });

  const { biz, customerRowId, toAddress, ccAddresses, bccAddresses, vars, override } = loaded;
  if (!(await testModeAllows(biz, toAddress))) {
    throw new AdhocEmailError(
      "We could not send the email. In test mode, we send email only to the addresses of team members. Change the recipient to the email of a team member.",
    );
  }
  const emailCfg = resolveEmailConfig(biz);
  const merchantUrl = merchantLink(emailCfg);
  // Through the outbox's own `blocksFor`, like every other render path. An operator's
  // "Request payment" is the email most in need of a Pay-now button and a card stating
  // what is owed, and it was going out with neither — the same missing step that left the
  // preview and the test send stripped. `test/unit/email-paths-agree.test.ts` now fails
  // if a render path forgets it, which is how this one was found.
  const adhocVars: RenderVars = {
    ...vars,
    ...(merchantUrl ? { portalUrl: merchantUrl } : {}),
    ...(emailCfg.footerNote ? { footerNote: emailCfg.footerNote } : {}),
  };
  const blocks = blocksFor(type, adhocVars);
  /**
   * A REAL destination for the button — the same mint automatic mail does, and for the
   * reason `portal-link.ts` records: an unauthenticated portal URL starts a login instead
   * of doing the job the button names. `payment_method_request` is the email most in need
   * of it, since asking a customer to update their card IS the entire message.
   *
   * Minted only when a button will actually render, so no credential is created for an
   * email nobody can press, and in its own transaction — this path writes the message row
   * after the send, so there is no caller transaction to join.
   */
  // A merchant URL goes out as it is: no portal session for a page that is not ours.
  if (blocks.action && !merchantUrl) {
    const link = await withTenant(organizationId, (tx) =>
      emailPortalLink(
        tx,
        { organizationId, businessId, customerId: customerRowId },
        { kind: blocks.action!.kind, invoiceId: input.invoiceId ?? null },
      ),
    );
    if (link) blocks.action.url = link;
  }
  const rendered = renderEmail(type, { ...adhocVars, ...blocks }, override);
  const mailer = resolveMailer(biz);
  const id = publicId("em");
  const now = new Date();

  /**
   * The document itself, attached — the whole point of "Send invoice".
   *
   * This path forwarded the document by NAME only: an operator pressing "Send invoice" sent
   * an email that described an invoice and carried nothing, which is the last place that
   * should happen. Automatic mail grew attachments in 0211/0213 and this did not, purely
   * because it does not go through the outbox.
   *
   * The per-email attachment rule governs it exactly as it governs automatic mail, so a
   * merchant who turned attachments off is not overridden by an operator action.
   */
  const rule = attachmentRule(emailCfg, type);
  const attachments =
    !rule?.pdf || (rule.skipZeroPdf && invoiceTotalMinor === 0n)
      ? []
      : type === "invoice_sent" && input.invoiceId
        ? await invoicePdf(organizationId, businessId, input.invoiceId)
        : type === "credit_note_sent" && input.creditNoteId
          ? await creditNotePdf(organizationId, businessId, input.creditNoteId)
          : [];

  const contactCc: string[] = [];
  for (const a of ccAddresses) {
    if (!(await isSuppressed(businessId, a)) && (await testModeAllows(biz, a))) contactCc.push(a);
  }

  const customerBcc: string[] = [];
  for (const a of bccAddresses) {
    if (!(await isSuppressed(businessId, a)) && (await testModeAllows(biz, a))) customerBcc.push(a);
  }
  const sender = resolveSender(emailCfg);
  const cc = uniqueAddresses([...contactCc, ...sender.cc], [toAddress]);

  let ok = true;
  let error: string | null = null;
  let providerMessageId: string | null = null;
  try {
    const res = await mailer.send({
      to: toAddress,
      ...sender,
      cc,
      bcc: uniqueAddresses([...customerBcc, ...(sender.bcc ?? [])], [toAddress, ...cc]),
      subject: applySubjectPrefix(emailCfg, rendered.subject),
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: id,
      ...(attachments.length ? { attachments } : {}),
    });
    providerMessageId = res.providerMessageId;
  } catch (e) {
    ok = false;
    error = (e as Error).message ?? "send failed";
    log.warn("ad-hoc email send failed", { error });
  }

  // Terminal on both paths — `sent` or `failed`, `attempts: 1`, `nextAttemptAt: null`.
  // A one-shot the operator initiated must never be handed to the billing clock: six
  // silent retries over six hours of a message someone chose to send by hand is not a
  // retry policy, it is a mail loop they cannot see. If it failed, they press Send again.
  await withTenant(organizationId, async (tx) => {
    await tx.insert(emailMessages).values({
      publicId: id,
      organizationId,
      businessId,
      customerId: customerRowId,
      eventId: null,
      type,
      toAddress,
      ccAddresses,
      bccAddresses,
      subject: rendered.subject,
      bodyHtml: rendered.html,
      bodyText: rendered.text,
      status: ok ? "sent" : "failed",
      transport: mailer.kind,
      attempts: 1,
      lastError: error,
      providerMessageId,
      lastAttemptAt: now,
      nextAttemptAt: null,
      sentAt: ok ? now : null,
    });
  });

  return { ok, error, transport: mailer.kind, email_id: id };
}

/** Which record a caller must supply for a given type — exported so a UI can say so before submitting. */
export function requiredRecordFor(type: EmailType): "invoice" | "credit_note" | "customer" | null {
  return REQUIRED_RECORD[type] ?? null;
}
