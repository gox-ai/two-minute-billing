/**
 * Proves operator-initiated ("ad-hoc") billing email — the per-record `Email` action
 * (src/modules/emails/adhoc-service.ts).
 *
 * The claims under test are the ones a reader would otherwise have to take on trust:
 *
 *  - all four ad-hoc types compose against a real record and record what carried them;
 *  - **no variable TEMPLATE_VARS marks `always: true` renders empty** — asserted by
 *    reading TEMPLATE_VARS itself, not by eyeballing four subjects, because the failure
 *    mode is silent ("Invoice  for " reaches the customer and nothing throws);
 *  - a missing required record is REJECTED rather than sent half-filled;
 *  - a business with `email_config.enabled = false` still sends — the deliberate
 *    non-gate. That flag governs automatic engine mail; the operator already decided;
 *  - a merchant's stored template override governs an ad-hoc send too;
 *  - the recorded row is terminal, so the billing clock never retries a human's one-shot.
 *
 * The mailer is a capturing fake (setMailer) — this suite is about what gets composed and
 * recorded, not about SMTP; verify:email-transport already proves the wire.
 *
 *   pnpm verify:email-adhoc
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { sendAdhocEmail, AdhocEmailError } from "@/modules/emails/adhoc-service";
import { upsertTemplate } from "@/modules/emails/template-service";
import { ADHOC_EMAIL_TYPES, type EmailType } from "@/modules/emails/config";
import { TEMPLATE_VARS, DEFAULT_TEMPLATES } from "@/modules/emails/templates";
import {
  businesses,
  creditNotes,
  customers,
  emailMessages,
  invoiceLineItems,
  invoices,
} from "@db/schema";
import { matchTemplate, stripTemplateTail } from "./lib/template-match";
import { resolveFooter } from "@/modules/emails/templates";
import { publicId } from "@/platform/ids";
import { createContact } from "@/modules/customers/contacts";
import { asTeamMembers } from "./lib/team-addresses";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail ?? "");
  }
}

const sent: OutboundEmail[] = [];

/** The message the fake mailer received most recently. Throws rather than asserting on undefined. */
function lastSent(): OutboundEmail {
  const m = sent[sent.length - 1];
  if (!m) throw new Error("expected a message to have been sent, but the mailer captured none");
  return m;
}

/** A world with one customer, one invoice and one credit note — the three records the four types attach to. */
async function fixture(
  name: string,
  opts: { emailsEnabled?: boolean; customerEmail?: string | null; brandColor?: string } = {},
) {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  await asTeamMembers(orgId, "payer@example.com"); // test mode emails only team members
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });

  return withTenant(orgId, async (tx) => {
    await tx
      .update(businesses)
      .set({
        emailConfig: { enabled: opts.emailsEnabled ?? true },
        timezone: "Asia/Kolkata",
        ...(opts.brandColor ? { brandColor: opts.brandColor } : {}),
      })
      .where(eq(businesses.id, biz.id));

    const cusPid = publicId("cus");
    const [cus] = await tx
      .insert(customers)
      .values({
        publicId: cusPid,
        organizationId: orgId,
        businessId: biz.id,
        email: opts.customerEmail === undefined ? "payer@example.com" : opts.customerEmail,
        // `customer.name` is write-only legacy since 3ab3c78 — nothing READS it, so setting
        // it here left {{customerName}} rendering the email address. Name via the real columns.
        firstName: "Ada",
        lastName: "Lovelace",
      })
      .returning();
    if (!cus) throw new Error("fixture: customer insert returned nothing");

    const invPid = publicId("inv");
    const [inv] = await tx
      .insert(invoices)
      .values({
        publicId: invPid,
        organizationId: orgId,
        businessId: biz.id,
        customerId: cus.id,
        number: "INV-42",
        status: "payment_due",
        currency: "USD",
        // Part-paid on purpose: total 1,299.00 but only 999.00 outstanding, which is what
        // separates invoice_sent (quotes the total) from payment_request (quotes the due).
        subtotalMinor: 129900n,
        totalMinor: 129900n,
        amountDueMinor: 99900n,
        dueDate: new Date("2026-09-01T00:00:00Z"),
      })
      .returning();
    if (!inv) throw new Error("fixture: invoice insert returned nothing");

    // ONE LINE, matching the subtotal. This fixture only reads the header figures, so it used
    // to skip lines entirely — but an invoice with a total and NO lines is not a valid invoice,
    // and it trips two CRITICAL invariants (`invoice_total_consistent`,
    // `invoice_subtotal_consistent`). Nothing here rolls back, so every run left another one
    // behind: 16 had accumulated by 2026-08-26, permanently reddening two checks that are
    // supposed to mean something. A critical alarm kept red by test litter is exactly how a
    // real defect goes unnoticed — the same failure that hid a 20% MRR overstatement inside 158
    // false positives earlier that day. The email assertions are unchanged: they quote
    // `total_minor` and `amount_due_minor`, which are untouched.
    await tx.insert(invoiceLineItems).values({
      publicId: publicId("il"),
      organizationId: orgId,
      businessId: biz.id,
      invoiceId: inv.id,
      description: "Fixture line",
      kind: "recurring",
      quantity: 1,
      unitAmountMinor: 129900n,
      amountMinor: 129900n,
    });

    const cnPid = publicId("cn");
    await tx.insert(creditNotes).values({
      publicId: cnPid,
      organizationId: orgId,
      businessId: biz.id,
      customerId: cus.id,
      invoiceId: inv.id,
      number: "CN-7",
      creditMethod: "balance",
      totalMinor: 29900n,
      currency: "USD",
    });

    return { orgId, bizId: biz.id, cusPid, invPid, cnPid };
  });
}

/**
 * What each `{{placeholder}}` in a template ACTUALLY rendered to, recovered from the sent
 * text by turning the template into a regex whose literal parts must match and whose
 * placeholders become captures.
 *
 * The obvious check — "the rendered text no longer contains `{{amount}}`" — passes for a
 * variable that rendered as nothing, which is precisely the defect being hunted. This
 * recovers the substituted value instead, so an empty one is visible.
 */
function renderedValues(tpl: string, text: string): Map<string, string[]> | null {
  return matchTemplate(tpl, text);
}

/** The id argument each type needs, so the four can be driven from one loop. */
function recordFor(type: EmailType, f: { cusPid: string; invPid: string; cnPid: string }) {
  if (type === "credit_note_sent") return { creditNoteId: f.cnPid };
  if (type === "payment_method_request") return { customerId: f.cusPid };
  return { invoiceId: f.invPid };
}

async function rowFor(orgId: string, emailId: string) {
  const [row] = await withTenant(orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.publicId, emailId)).limit(1),
  );
  return row;
}

async function main() {
  setMailer({
    kind: "console",
    /** In-process fake: reaches no network, so it can never be circuit-broken. */
    target: null,
    async send(msg) {
      sent.push(msg);
      return { providerMessageId: "fake-1", status: "sent" };
    },
  });

  const f = await fixture("Adhoc Co");

  // ── 1. All four types compose, send and record ──────────────────────────────
  ok(
    "ADHOC_EMAIL_TYPES still has exactly the four operator-sendable types",
    ADHOC_EMAIL_TYPES.length === 4,
    ADHOC_EMAIL_TYPES,
  );

  for (const type of ADHOC_EMAIL_TYPES) {
    const before = sent.length;
    const res = await sendAdhocEmail(f.orgId, f.bizId, {
      type,
      ...recordFor(type, f),
      note: "Thanks for your business.",
    });
    ok(`${type}: send reports ok`, res.ok, res.error);
    ok(
      `${type}: send reports the transport that carried it`,
      res.transport === "console",
      res.transport,
    );
    ok(`${type}: exactly one message left`, sent.length === before + 1, sent.length - before);

    const row = await rowFor(f.orgId, res.email_id);
    ok(`${type}: recorded in the email log with the right type`, row?.type === type, row?.type);
    ok(
      `${type}: the row records WHICH transport carried it`,
      row?.transport === "console",
      row?.transport,
    );
    ok(
      `${type}: defaults to the customer's billing email`,
      row?.toAddress === "payer@example.com",
      row?.toAddress,
    );
    ok(`${type}: attached to the customer, unlike a test send`, !!row?.customerId);
    // A one-shot an operator initiated must never reach the billing clock — six silent
    // retries over six hours of a hand-sent message is a mail loop, not a retry policy.
    ok(
      `${type}: the row is terminal, never left pending for the clock`,
      row?.status === "sent" && row?.attempts === 1 && row?.nextAttemptAt === null,
      `${row?.status}/${row?.attempts}/${row?.nextAttemptAt}`,
    );
    ok(
      `${type}: the operator's note reached the body`,
      !!row && row.bodyText.includes("Thanks for your business."),
    );

    // ── 2. Not one `always: true` variable rendered empty ─────────────────────
    // Driven off TEMPLATE_VARS rather than off a hand-written list, so a variable added
    // to a type tomorrow is covered by this assertion the moment it is declared.
    const msg = lastSent();
    const tpl = DEFAULT_TEMPLATES[type];
    // renderEmail appends the SHELL's blocks to the text part — the action button
    // ("Pay now: <url>") and one line per facts-card row ("Invoiced amount: $17.11").
    // None of it comes from the template, so it is peeled off before matching. Each is a
    // single `Label: value` line joined by a blank line. Stripping only "Manage billing:"
    // stopped working when the fixed CTA became a typed per-type action and the card
    // arrived; the same fix was needed in verify-email-events.
    // The footer follows the shell's blocks, so it comes off first.
    let bodyText = stripTemplateTail(msg.text, resolveFooter(tpl));
    for (;;) {
      const m = /\n\n[^\n]+: [^\n]+$/.exec(bodyText);
      if (!m) break;
      bodyText = bodyText.slice(0, m.index);
    }
    const bodyValues = renderedValues(tpl.body, bodyText);
    const subjectValues = renderedValues(tpl.subject, msg.subject);
    ok(`${type}: the sent body matches its template's literal text`, bodyValues !== null, msg.text);
    ok(
      `${type}: the sent subject matches its template's literal text`,
      subjectValues !== null,
      msg.subject,
    );

    for (const v of TEMPLATE_VARS[type].filter((x) => x.always)) {
      // Only meaningful for a variable the template actually references — an unused
      // declaration cannot render blank because it never renders at all.
      const occurrences = [...(bodyValues?.get(v.key) ?? []), ...(subjectValues?.get(v.key) ?? [])];
      if (!occurrences.length) continue;
      ok(
        `${type}: always-var {{${v.key}}} rendered a value, not empty text`,
        occurrences.every((s) => s.trim().length > 0),
        occurrences,
      );
    }
  }

  // ── 2b. EVERY always-var, including ones no built-in template happens to use ─
  // `currency` is `always: true` for three types and appears in none of their default
  // bodies, so the check above skips it — an unreferenced variable cannot render blank.
  // The published contract still promises it, and the template editor offers it, so a
  // merchant who inserts {{currency}} tomorrow must not get an empty string. Proven by
  // overriding each template with one that references every always-var it declares.
  const probe = await fixture("Var Probe Co");
  for (const type of ADHOC_EMAIL_TYPES) {
    const always = TEMPLATE_VARS[type].filter((v) => v.always).map((v) => v.key);
    await upsertTemplate(probe.orgId, probe.bizId, type, {
      subject: `probe ${type}`,
      heading: "probe",
      body: always.map((k) => `${k}=[{{${k}}}]`).join("\n"),
    });
    const res = await sendAdhocEmail(probe.orgId, probe.bizId, { type, ...recordFor(type, probe) });
    ok(`${type}: probe send succeeded`, res.ok, res.error);
    const text = lastSent().text;
    // `key=[]` (or whitespace only) is exactly the silent-empty failure this hunts.
    const empty = always.filter((k) => new RegExp(`${k}=\\[\\s*\\]`).test(text));
    ok(
      `${type}: every always-var it declares (${always.join(", ")}) rendered non-empty`,
      empty.length === 0,
      `${empty.join(", ")} :: ${text}`,
    );
  }

  // The rendered number is the sharpest single witness that substitution happened at all.
  //
  // Read from the BODY, not the subject. Invoice numbers were removed from all five invoice
  // subjects on 2026-08-29 — they are a document reference, not inbox scanning material, and
  // the number now reaches the customer in the body and on the attached PDF. This assertion
  // followed the number rather than being weakened: it still proves a real value was
  // substituted, just where the value now lives.
  const invoiceMsg = sent.find((m) => m.text.includes("INV-42"));
  ok(
    "invoice_sent carries the real invoice number",
    !!invoiceMsg,
    sent.map((m) => m.subject),
  );
  ok(
    "invoice_sent subject no longer quotes the number",
    !!invoiceMsg && !invoiceMsg.subject.includes("INV-42"),
    invoiceMsg?.subject,
  );
  const cnMsg = sent.find((m) => m.subject.startsWith("Credit note CN-7"));
  ok("credit_note_sent subject carries the real credit note number", !!cnMsg);

  // ── The document itself rides along ─────────────────────────────────────────
  // "Send invoice" that forwards the document by NAME only is the last place an attachment
  // should be missing, and it was: automatic mail grew attachments in 0211/0213 while this
  // path did not, purely because it does not go through the outbox.
  const invPdf = invoiceMsg?.attachments?.[0];
  ok("invoice_sent attaches the invoice PDF", !!invPdf, invoiceMsg?.attachments?.length);
  ok(
    "…named for the invoice",
    !!invPdf && /^invoice-.+\.pdf$/.test(invPdf.filename),
    invPdf?.filename,
  );
  // Real pdfkit bytes, not a placeholder buffer.
  ok("…and is a real PDF", !!invPdf && invPdf.content.subarray(0, 5).toString() === "%PDF-");

  const cnPdf = cnMsg?.attachments?.[0];
  ok("credit_note_sent attaches the CREDIT NOTE PDF", !!cnPdf, cnMsg?.attachments?.length);
  // The document must be the RIGHT one: attaching the invoice a credit note was applied to
  // would hand the customer the wrong paperwork entirely.
  ok(
    "…named for the credit note, not the invoice",
    !!cnPdf && /^credit-note-.+\.pdf$/.test(cnPdf.filename),
    cnPdf?.filename,
  );
  ok("…and is a real PDF", !!cnPdf && cnPdf.content.subarray(0, 5).toString() === "%PDF-");

  // payment_request must quote what is OUTSTANDING, not the invoice total — quoting the
  // total on a part-paid invoice asks the customer to pay the settled part twice.
  //
  // The literals are `$1,299.00`, not `1,299.00 USD`: emails moved to the platform money
  // formatter so an email and the invoice document a customer compares it against render
  // the same shape (`formatMoney` in modules/emails/templates.ts). These assertions kept
  // the old code-last shape and went red the moment that landed — invisibly, because this
  // suite was outside verify:all.
  const payReq = sent.find((m) => m.subject.startsWith("Payment request"));
  ok(
    "payment_request quotes the amount still due, not the total",
    !!payReq && payReq.text.includes("$999.00") && !payReq.text.includes("$1,299.00"),
    payReq?.text,
  );
  // invoice_sent forwards the document, so it states the total.
  ok(
    "invoice_sent quotes the invoice total",
    !!invoiceMsg && invoiceMsg.text.includes("$1,299.00"),
    invoiceMsg?.text,
  );
  // Dates reach the customer pre-formatted in the business timezone, never as an ISO stamp.
  ok(
    "a due date renders as a human date in the business timezone",
    !!payReq && payReq.text.includes("Sep 1, 2026") && !/\d{4}-\d{2}-\d{2}T/.test(payReq.text),
    payReq?.text,
  );

  // ── 3. A missing required record is rejected, not sent half-filled ──────────
  const missingCases: Array<[EmailType, Record<string, string | undefined>, string]> = [
    ["invoice_sent", {}, "invoice"],
    ["payment_request", {}, "invoice"],
    ["credit_note_sent", {}, "credit note"],
    ["payment_method_request", {}, "customer"],
  ];
  for (const [type, args, word] of missingCases) {
    const before = sent.length;
    let err: unknown = null;
    try {
      await sendAdhocEmail(f.orgId, f.bizId, { type, ...args });
    } catch (e) {
      err = e;
    }
    ok(`${type} with no ${word} is rejected`, err instanceof AdhocEmailError, err);
    ok(`${type} with no ${word} sent nothing`, sent.length === before, sent.length - before);
    ok(
      `${type}'s rejection names the missing record`,
      String((err as Error)?.message ?? "").includes(word),
      (err as Error)?.message,
    );
  }

  // An id that does not resolve is the same defect wearing a different hat.
  let badId: unknown = null;
  try {
    await sendAdhocEmail(f.orgId, f.bizId, {
      type: "invoice_sent",
      invoiceId: "inv_does_not_exist",
    });
  } catch (e) {
    badId = e;
  }
  ok("an unresolvable invoice id is rejected", badId instanceof AdhocEmailError, badId);

  // A record from ANOTHER business must not resolve — the tenant boundary, not just a typo.
  const other = await fixture("Other Co");
  let crossTenant: unknown = null;
  try {
    await sendAdhocEmail(f.orgId, f.bizId, { type: "invoice_sent", invoiceId: other.invPid });
  } catch (e) {
    crossTenant = e;
  }
  ok(
    "another business's invoice does not resolve",
    crossTenant instanceof AdhocEmailError,
    crossTenant,
  );

  // A customer with no billing email and no override has no recipient — rejected rather
  // than sent to an empty address.
  const noEmail = await fixture("No Email Co", { customerEmail: null });
  let noRecipient: unknown = null;
  try {
    await sendAdhocEmail(noEmail.orgId, noEmail.bizId, {
      type: "payment_method_request",
      customerId: noEmail.cusPid,
    });
  } catch (e) {
    noRecipient = e;
  }
  ok(
    "a customer with no billing email is rejected",
    noRecipient instanceof AdhocEmailError,
    noRecipient,
  );

  await asTeamMembers(noEmail.orgId, "accounts@buyer.test"); // test mode emails only team members
  const overridden = await sendAdhocEmail(noEmail.orgId, noEmail.bizId, {
    type: "payment_method_request",
    customerId: noEmail.cusPid,
    to: "accounts@buyer.test",
  });
  ok("an explicit recipient override sends anyway", overridden.ok, overridden.error);
  ok(
    "the override is what the row records",
    (await rowFor(noEmail.orgId, overridden.email_id))?.toAddress === "accounts@buyer.test",
  );

  // ── 4. The deliberate NON-gate: email_config.enabled = false still sends ────
  // This is the assertion that stops a future reader "fixing" the missing gate. Automatic
  // engine mail is opt-in; an operator pressing Send has already opted in for this one
  // message.
  const off = await fixture("Emails Off Co", { emailsEnabled: false });
  const offRes = await sendAdhocEmail(off.orgId, off.bizId, {
    type: "invoice_sent",
    invoiceId: off.invPid,
  });
  ok(
    "a business with email_config.enabled = false STILL sends an ad-hoc email",
    offRes.ok,
    offRes.error,
  );
  ok(
    "and the row is recorded as sent",
    (await rowFor(off.orgId, offRes.email_id))?.status === "sent",
  );

  // ── 5. A stored template override is honoured ───────────────────────────────
  await upsertTemplate(f.orgId, f.bizId, "invoice_sent", {
    subject: "CUSTOM — invoice {{invoiceNumber}}",
    heading: "Custom heading",
    body: "Dear {{customerName}}, our records show {{amount}} on {{invoiceNumber}}.",
  });
  const custom = await sendAdhocEmail(f.orgId, f.bizId, {
    type: "invoice_sent",
    invoiceId: f.invPid,
  });
  const customRow = await rowFor(f.orgId, custom.email_id);
  ok(
    "a customised template governs the ad-hoc subject",
    customRow?.subject === "CUSTOM — invoice INV-42",
    customRow?.subject,
  );
  ok(
    "a customised template governs the ad-hoc body",
    !!customRow &&
      customRow.bodyText.includes("Dear Ada Lovelace, our records show $1,299.00 on INV-42."),
    customRow?.bodyText,
  );

  // ── 6. Only the four ad-hoc types are sendable by hand ──────────────────────
  let engineType: unknown = null;
  try {
    await sendAdhocEmail(f.orgId, f.bizId, {
      type: "subscription_renewed" as EmailType,
      customerId: f.cusPid,
    });
  } catch (e) {
    engineType = e;
  }
  ok(
    "an engine-fired type cannot be sent by hand",
    engineType instanceof AdhocEmailError,
    engineType,
  );

  // ── An operator-sent email is BRANDED, and its button actually works ────────
  /**
   * Reported 2026-09-10 from a real `payment_method_request` in a customer's inbox: the
   * merchant's accent colour arrived as a black button and the logo as plain text, and
   * "Update payment method" pointed at the deployment root.
   *
   * Both came from the same root cause — the shell reads the brand from `vars` and
   * `blocksFor` reads the button's destination from `vars.portalUrl`, and this path
   * supplied neither properly. It sends to real customers, so it needs automatic mail's
   * treatment exactly: brand vars from the business, and a pre-authenticated exchange link.
   */
  {
    const brand = await fixture("Brandy Co", { brandColor: "#7C3AED" });
    const res = await sendAdhocEmail(brand.orgId, brand.bizId, {
      type: "payment_method_request",
      customerId: brand.cusPid,
    });
    ok("branded: the send reports ok", res.ok, res.error);
    const row = await rowFor(brand.orgId, res.email_id);
    const html = row?.bodyHtml ?? "";
    ok("the merchant's accent colour reaches the message", html.includes("#7C3AED"));
    // The fallback is not a neutral default — it IS the reported symptom, so its absence
    // is the assertion that would have caught this.
    ok("…and the unbranded #111111 fallback is gone", !html.includes("#111111"), html.slice(0, 0));
    ok(
      "the button is a pre-authenticated portal link",
      /href="https:\/\/portal\.test\/portal\/s\/[A-Za-z0-9._-]+"/.test(html),
      html.match(/href="[^"]*portal[^"]*"/)?.[0],
    );
    // The bare deployment root is what it used to point at: no /portal, no session.
    ok(
      "…never the bare deployment root",
      !/href="https:\/\/portal\.test"/.test(html),
      html.match(/href="[^"]*"/)?.[0],
    );
  }

  // ── 6b. Send invoice: "Pay now" only on an open auto-collect-OFF invoice ──────
  {
    const off = await fixture("Offline Co");
    const sendInvoice = async () => {
      const res = await sendAdhocEmail(off.orgId, off.bizId, {
        type: "invoice_sent",
        invoiceId: off.invPid,
      });
      return (await rowFor(off.orgId, res.email_id))?.bodyHtml ?? "";
    };
    const setCustomerAc = (ac: "on" | "off") =>
      withTenant(off.orgId, (tx) =>
        tx.update(customers).set({ autoCollection: ac }).where(eq(customers.publicId, off.cusPid)),
      );
    const setInvoiceStatus = (status: "paid" | "payment_due") =>
      withTenant(off.orgId, (tx) =>
        tx.update(invoices).set({ status }).where(eq(invoices.publicId, off.invPid)),
      );

    const onHtml = await sendInvoice();
    ok("auto-collect ON: invoice_sent has no Pay now", !onHtml.includes(">Pay now</a>"));

    await setCustomerAc("off");
    const offHtml = await sendInvoice();
    ok("auto-collect OFF: invoice_sent has Pay now", offHtml.includes(">Pay now</a>"));
    ok(
      "…pointing at a pre-authenticated portal link",
      /href="https:\/\/portal\.test\/portal\/s\/[A-Za-z0-9._-]+"/.test(offHtml),
      offHtml.match(/href="[^"]*portal[^"]*"/)?.[0],
    );

    await setInvoiceStatus("paid");
    const paidHtml = await sendInvoice();
    ok("auto-collect OFF but paid: no Pay now", !paidHtml.includes(">Pay now</a>"));
    await setInvoiceStatus("payment_due");
  }

  // ── 7. A transport refusal is reported, not thrown — and recorded terminally ─
  setMailer({
    kind: "console",
    /** In-process fake: reaches no network, so it can never be circuit-broken. */
    target: null,
    async send() {
      throw new Error("relay refused: 550 no such mailbox");
    },
  });
  const refused = await sendAdhocEmail(f.orgId, f.bizId, {
    type: "payment_method_request",
    customerId: f.cusPid,
  });
  ok("a relay refusal comes back as ok:false rather than throwing", refused.ok === false);
  ok(
    "the relay’s own message is reported",
    (refused.error ?? "").includes("550 no such mailbox"),
    refused.error,
  );
  const failedRow = await rowFor(f.orgId, refused.email_id);
  ok(
    "a refused send is recorded as failed, terminal, with the error",
    failedRow?.status === "failed" &&
      failedRow?.attempts === 1 &&
      failedRow?.nextAttemptAt === null &&
      !!failedRow?.lastError,
    `${failedRow?.status}/${failedRow?.attempts}/${failedRow?.nextAttemptAt}`,
  );

  // ── Additional contacts on an operator send ─────────────────────────────────
  {
    // The refusal case above left a failing mailer installed.
    setMailer({
      kind: "console",
      target: null,
      async send(msg) {
        sent.push(msg);
        return { providerMessageId: "fake-2", status: "sent" };
      },
    });
    const g = await fixture("Contacts Co");
    // Test mode emails only team members; ceo@ too, so the recipient rule is what drops the copy.
    await asTeamMembers(g.orgId, "accounts@example.com", "ceo@example.com");
    const [cust] = await withTenant(g.orgId, (tx) =>
      tx.select({ id: customers.id }).from(customers).where(eq(customers.publicId, g.cusPid)),
    );
    await createContact({
      organizationId: g.orgId,
      businessId: g.bizId,
      customerId: cust!.id,
      email: "accounts@example.com",
      sendBillingEmail: true,
    });
    const ccOf = async (to?: string) => {
      const before = sent.length;
      await sendAdhocEmail(g.orgId, g.bizId, {
        type: "invoice_sent",
        ...recordFor("invoice_sent", g),
        ...(to !== undefined ? { to } : {}),
      });
      return sent.slice(before)[0]?.cc ?? [];
    };
    // The dashboard dialog pre-fills the customer's address, so this is the common case.
    ok(
      "operator send to the customer's own address copies billing contacts",
      JSON.stringify(await ccOf("PAYER@example.com")) === JSON.stringify(["accounts@example.com"]),
    );
    ok(
      "…and so does leaving the recipient blank",
      JSON.stringify(await ccOf()) === JSON.stringify(["accounts@example.com"]),
    );
    const before = sent.length;
    const other = await ccOf("ceo@example.com");
    ok(
      "an operator send to someone else copies nobody",
      sent.length === before + 1 && other.length === 0,
    );
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} ad-hoc email: ${pass} passed, ${fail} failed`);
  await closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
