/**
 * Proves the customer-email outbox: a paid subscription invoice enqueues a
 * rendered `payment_receipt` (+ `invoice_issued`) row when the business has email
 * enabled; deliverPendingEmails sends them via the mailer adapter and marks them
 * sent; an email-disabled business, or an opted-out customer, enqueues nothing.
 *
 *   pnpm verify:emails
 */
import { and, eq } from "drizzle-orm";
import { withTraceContext, newTraceId } from "@/platform/trace";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { deliverPendingEmails } from "@/modules/emails/outbox";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import {
  businesses,
  customers,
  emailMessages,
  invoices,
  emailSuppressions,
  events,
  payments,
  subscriptions,
} from "@db/schema";
import { createContact } from "@/modules/customers/contacts";
import { upsertTemplate } from "@/modules/emails/template-service";
import { startTimeTravel } from "@/modules/time-travel/service";
import { runWithClockScope } from "@/platform/clock";
import { asTeamMembers } from "./lib/team-addresses";

let pass = 0;
let fail = 0;
/** `detail` is printed only on failure — a red line with no observed value is hard to act on. */
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail === undefined ? "" : `— got: ${String(detail)}`);
  }
}

/**
 * Deliver ONE business's queue. Unscoped, a pass takes the oldest due rows first, so any
 * backlog in the database (another business, an earlier run) is sent instead of this case's.
 */
const deliverFor = (bizId: string) =>
  runWithClockScope({ onlyBusinessId: bizId }, () => deliverPendingEmails(new Date()));

// Capturing fake mailer so we can assert what would be sent without a transport.
const captured: OutboundEmail[] = [];
setMailer({
  kind: "console",
  /** In-process fake: reaches no network, so it can never be circuit-broken. */
  target: null,
  async send(msg) {
    captured.push(msg);
    return { providerMessageId: `fake_${captured.length}`, status: "sent" };
  },
});

async function setupBiz(
  emailEnabled: boolean,
  extraConfig: Record<string, unknown> = {},
  /** The instrument to vault — a magic PAN drives which billing mail the period produces. */
  token = "tok_4242",
  amountMinor = 5000,
  /** Runs once the customer exists, before anything is billed. */
  beforeBill?: (ctx: { orgId: string; bizId: string; customerId: string }) => Promise<void>,
  autoCollection: "on" | "off" = "on",
) {
  const org = await createOrganization({ name: "Emails" });
  const orgId = org.organization.id;
  await asTeamMembers(orgId, "payer@a.com"); // test mode emails only team members
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Acme Reports",
    defaultCurrency: "USD",
    livemode: "test",
  });
  if (emailEnabled) {
    await withTenant(orgId, (tx) =>
      tx
        .update(businesses)
        .set({ emailConfig: { enabled: true, ...extraConfig } })
        .where(eq(businesses.id, biz.id)),
    );
  }
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "payer@a.com",
    firstName: "Pat",
    lastName: "Payer",
  });
  await beforeBill?.({ orgId, bizId: biz.id, customerId: customer.id });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token,
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
  });
  const sub = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
    autoCollection,
  });
  await billSubscriptionPeriod({
    organizationId: orgId,
    businessId: biz.id,
    subscription: sub.subscription,
    // Non-null by construction: this fixture creates a subscription with NO trial, so it
    // starts `active` with a term. A trialling subscription has none (2026-08-25).
    periodStart: sub.subscription.currentPeriodStart!,
    periodEnd: sub.subscription.currentPeriodEnd!,
  });
  return { orgId, bizId: biz.id };
}

const rowsFor = (orgId: string, bizId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.businessId, bizId)),
  );

// ---- Case 1: email enabled → billing emails enqueued + delivered ----
{
  const a = await setupBiz(true);
  const rows = await rowsFor(a.orgId, a.bizId);
  const receipt = rows.find((r) => r.type === "payment_receipt");
  ok("enabled: payment_receipt enqueued (pending)", !!receipt && receipt.status === "pending");
  ok(
    "enabled: invoice_issued enqueued",
    rows.some((r) => r.type === "invoice_issued"),
  );
  ok(
    "receipt subject rendered",
    !!receipt && receipt.subject.includes("Payment received") && receipt.subject.includes("$50.00"),
  );
  ok("receipt addressed to customer", !!receipt && receipt.toAddress === "payer@a.com");
  ok("receipt body personalized", !!receipt && receipt.bodyText.includes("Pat Payer"));

  const before = captured.length;
  const res = await deliverFor(a.bizId);
  ok("deliverPendingEmails sent ≥1", res.sent >= 1 && res.failed === 0);
  const after = await rowsFor(a.orgId, a.bizId);
  ok(
    "all rows marked sent",
    after.length > 0 && after.every((r) => r.status === "sent" && r.sentAt !== null),
  );
  ok(
    "mailer received the send",
    captured.length > before && captured.some((m) => m.to === "payer@a.com"),
  );

  // ── The invoice PDF rides along with the billing mail ───────────────────────
  // Asserted on what reached the TRANSPORT, not on the row: the row records what was
  // rendered, and an attachment built at delivery would not appear in it. This is the whole
  // point of `email_messages.invoice_id` — a message that knows which document it is about.
  const delivered = captured.slice(before);
  const invoiceMail = delivered.find(
    (m) => m.subject.includes("$50.00") || m.subject.toLowerCase().includes("invoice"),
  );
  ok(
    "an invoice email carries an attachment",
    (invoiceMail?.attachments?.length ?? 0) === 1,
    invoiceMail?.attachments?.length,
  );
  const pdf = invoiceMail?.attachments?.[0];
  ok("…named for the invoice", !!pdf && /^invoice-.+\.pdf$/.test(pdf.filename), pdf?.filename);
  ok("…typed as a PDF", pdf?.contentType === "application/pdf");
  // Real bytes from pdfkit, not a placeholder: the magic number is the cheapest proof that
  // an actual document was rendered rather than an empty buffer attached.
  ok(
    "…and is a real PDF document",
    !!pdf && pdf.content.subarray(0, 5).toString() === "%PDF-",
    pdf?.content?.subarray(0, 8).toString(),
  );

  // A lifecycle email has no document behind it and must not grow one.
  const noDoc = delivered.find(
    (m) => !m.subject.includes("$50.00") && !m.subject.toLowerCase().includes("invoice"),
  );
  if (noDoc)
    ok("an email about no document has no attachment", !noDoc.attachments?.length, noDoc.subject);
}

// ---- Case 2: email disabled (opt-in default) → nothing enqueued ----
{
  const b = await setupBiz(false);
  const rows = await rowsFor(b.orgId, b.bizId);
  ok("disabled: no emails enqueued", rows.length === 0);
}

// ---- Case 3: subject prefix + copies, through the REAL enqueue→deliver path ----
// The prefix is applied at ENQUEUE so `email_messages.subject` is exactly what went out —
// the log is what support reads, and a resend re-delivers this same row. Asserting on the
// stored row (not on a hand-built OutboundEmail) is what proves that wiring.
{
  const before = captured.length;
  const c = await setupBiz(true, {
    subjectPrefix: "[Acme]",
    cc: ["accounts@acme.test"],
    bcc: ["archive@acme.test"],
  });
  const rows = await rowsFor(c.orgId, c.bizId);
  const receipt = rows.find((r) => r.type === "payment_receipt");
  ok(
    "prefix is applied at enqueue, so the stored subject is what was sent",
    !!receipt && receipt.subject.startsWith("[Acme] "),
    receipt?.subject,
  );
  ok(
    "the prefix does not displace the rendered subject",
    !!receipt && receipt.subject.includes("Payment received"),
    receipt?.subject,
  );

  await deliverFor(c.bizId);
  const sentMsgs = captured.slice(before);
  ok(
    "copies reach the transport through the outbox",
    sentMsgs.length > 0 &&
      sentMsgs.every(
        (m) => m.cc?.[0] === "accounts@acme.test" && m.bcc?.[0] === "archive@acme.test",
      ),
    JSON.stringify({ cc: sentMsgs[0]?.cc, bcc: sentMsgs[0]?.bcc }),
  );
  // Guards the double-prefix bug: delivery must NOT re-apply what enqueue already did.
  ok(
    "delivery does not stack the prefix a second time",
    sentMsgs.every((m) => (m.subject.match(/\[Acme\]/g) ?? []).length === 1),
    sentMsgs[0]?.subject,
  );

  // A resend re-delivers the SAME row, so its subject must be stable across attempts.
  const reRow = (await rowsFor(c.orgId, c.bizId)).find((r) => r.type === "payment_receipt");
  ok(
    "the stored subject is unchanged by delivery",
    reRow?.subject === receipt?.subject,
    reRow?.subject,
  );
}

// ---- Case 4: ONE authenticate-mail per debit, though TWO sites emit the event ----
/**
 * `collectClaimedInvoice` emits `payment_authentication_required` when it books an
 * off-session `requires_action` pending; `applyActionRequired` emits it again a second
 * later when the gateway states the same thing. Both render byte-identically — the
 * template has no `authenticate_by` var — so the buyer was mailed twice (measured
 * 2026-09-10 on a ₹4,602 debit). It reached every debit on 2026-09-09,
 * when the amount gate came off the pending booking: below ₹15,000 the old failure
 * booking made the transaction terminal, which made the webhook handler return `ignored`.
 *
 * The event still fires twice on purpose — only the SECOND MAIL is suppressed.
 */
{
  const d = await setupBiz(true, {}, "tok_4000000000003155");
  const notices = async () =>
    (await rowsFor(d.orgId, d.bizId)).filter((r) => r.type === "payment_authentication_required");

  const first = await notices();
  ok("the charge-time notice is enqueued", first.length === 1, first.length);

  const [pay] = await withTenant(d.orgId, (tx) =>
    tx.select().from(payments).where(eq(payments.businessId, d.bizId)).limit(1),
  );
  ok(
    "…against a debit booked PENDING, not failed",
    pay?.status === "pending" && !!pay?.providerChargeId,
    pay?.status,
  );

  // The gateway now states the same requirement, carrying the deadline only it can know.
  const outcome = await handleProviderEvent("tmtest", {
    providerEventId: `pe_afa_${Date.now()}`,
    type: "intent.requires_action",
    providerChargeId: pay!.providerChargeId!,
    actionType: "pre_debit_notification",
    actionDeadline: new Date(Date.now() + 26 * 3600 * 1000),
    occurredAt: new Date(),
    raw: {},
  });
  ok("the gateway's own statement is processed", outcome === "processed", outcome);

  type Envelope = { suppress_email?: boolean; payment?: Record<string, unknown> };
  const evs = await withTenant(d.orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(
        and(eq(events.businessId, d.bizId), eq(events.type, "payment_authentication_required")),
      ),
  );
  ok("both sites still emit — a subscriber hears the deadline", evs.length === 2, evs.length);
  const stated = evs.find((e) => (e.data as Envelope)?.payment?.action_type);
  ok(
    "…and the gateway's event carries `authenticate_by`",
    typeof (stated?.data as Envelope)?.payment?.authenticate_by === "string",
  );
  ok(
    "…stamped suppress_email, so the sink skips it",
    (stated?.data as Envelope)?.suppress_email === true,
  );

  ok("the buyer is told ONCE, not twice", (await notices()).length === 1);
}

// ---- Case 5: one OPERATION, one mail — and a later operation still mails ----
/**
 * The sink maps one event to one message, so an operation that legitimately emits the
 * same event type twice for one object mailed the customer twice: a subscription update
 * that changes term AND items AND a coupon emits three `subscription_changed` events
 * (measured — three in 157ms, three identical mails).
 *
 * The second half is the half that matters. The guard is scoped to the EXECUTION, not to
 * a stretch of wall time, because the suites drive the billing clock days forward inside
 * a couple of real seconds — any wall-clock window wide enough to catch the duplicate
 * would also swallow the dunning ladder's day-8 reminder. So a repeat in a LATER trace
 * must still go out, and that is asserted here rather than left to inference.
 */
{
  const e = await setupBiz(true);
  const [sub] = await withTenant(e.orgId, (tx) =>
    tx.select().from(subscriptions).where(eq(subscriptions.businessId, e.bizId)).limit(1),
  );
  const changes = async () =>
    (await rowsFor(e.orgId, e.bizId)).filter((r) => r.type === "subscription_changed");
  ok("no change notice yet", (await changes()).length === 0);

  const emitChange = () =>
    withTenant(e.orgId, (tx) =>
      emitEvent(tx, {
        organizationId: e.orgId,
        businessId: e.bizId,
        type: "subscription_changed",
        data: buildEventData("subscription_changed", { id: sub!.publicId }),
      }),
    );

  // One request that changes three things about one subscription.
  await withTraceContext({ traceId: newTraceId("req") }, async () => {
    await emitChange();
    await emitChange();
    await emitChange();
  });
  const once = await changes();
  ok("three events in ONE request mail the customer once", once.length === 1, once.length);

  const evs = await withTenant(e.orgId, (tx) =>
    tx
      .select()
      .from(events)
      .where(and(eq(events.businessId, e.bizId), eq(events.type, "subscription_changed"))),
  );
  ok("…while every event still reaches a subscriber", evs.length === 3, evs.length);

  // A LATER operation on the same subscription is a real second notice.
  await withTraceContext({ traceId: newTraceId("req") }, emitChange);
  ok(
    "a later request mails again — a ladder repeat is not a duplicate",
    (await changes()).length === 2,
    (await changes()).length,
  );
}

// ---- Case 6: attachments are decided per email type ----
{
  const noPdf = { pdf: false, skipZeroPdf: false, skipZeroSend: false };
  const a = await setupBiz(true, { attachments: { invoice_issued: noPdf } });
  const before = captured.length;
  await deliverFor(a.bizId);
  const byId = new Map(captured.slice(before).map((m) => [m.idempotencyKey, m]));
  const rows = await rowsFor(a.orgId, a.bizId);
  const mail = (type: string) => byId.get(rows.find((r) => r.type === type)?.publicId ?? "");
  ok(
    "per-type off: invoice_issued goes out without its PDF",
    !!mail("invoice_issued") && !mail("invoice_issued")?.attachments?.length,
  );
  ok(
    "…while payment_receipt, not turned off, still carries it",
    mail("payment_receipt")?.attachments?.length === 1,
    mail("payment_receipt")?.attachments?.length,
  );

  // A zero-value invoice with "don't send" on: no invoice_issued row at all.
  const z = await setupBiz(
    true,
    { attachments: { invoice_issued: { pdf: true, skipZeroPdf: false, skipZeroSend: true } } },
    "tok_4242",
    0,
  );
  const zRows = await rowsFor(z.orgId, z.bizId);
  ok(
    "zero-value + don't send: no invoice_issued email",
    !zRows.some((r) => r.type === "invoice_issued"),
    zRows.map((r) => r.type),
  );

  // Same zero-value invoice, sending on but PDF skipped: the email goes, bare.
  const zp = await setupBiz(
    true,
    { attachments: { invoice_issued: { pdf: true, skipZeroPdf: true, skipZeroSend: false } } },
    "tok_4242",
    0,
  );
  const zpBefore = captured.length;
  await deliverFor(zp.bizId);
  const zpRows = await rowsFor(zp.orgId, zp.bizId);
  const zpRow = zpRows.find((r) => r.type === "invoice_issued");
  const zpMail = captured.slice(zpBefore).find((m) => m.idempotencyKey === zpRow?.publicId);
  ok(
    "zero-value + skip PDF: invoice_issued still sent",
    !!zpMail,
    zpRows.map((r) => r.type),
  );
  ok("…without the PDF", !!zpMail && !zpMail.attachments?.length, zpMail?.attachments?.length);
}

// ---- Case 7: additional contacts get copies, by audience ----
{
  const c = await setupBiz(true, {}, "tok_4242", 5000, async ({ orgId, bizId, customerId }) => {
    const add = (
      email: string,
      f: { sendBillingEmail?: boolean; sendAccountEmail?: boolean; enabled?: boolean },
    ) => createContact({ organizationId: orgId, businessId: bizId, customerId, email, ...f });
    await add("accounts@a.com", { sendBillingEmail: true });
    await add("owner@a.com", { sendAccountEmail: true });
    await add("off@a.com", { sendBillingEmail: true, enabled: false });
    await add("PAYER@a.com", { sendBillingEmail: true }); // the customer's own address
    await add("bounced@a.com", { sendBillingEmail: true });
    // Test mode emails only team members; bounced@ too, so suppression is what drops it.
    await asTeamMembers(orgId, "accounts@a.com", "owner@a.com", "bounced@a.com");
    await withTenant(orgId, (tx) =>
      tx.insert(emailSuppressions).values({
        organizationId: orgId,
        businessId: bizId,
        address: "bounced@a.com",
        reason: "bounce",
      }),
    );
  });
  const rows = await rowsFor(c.orgId, c.bizId);
  const receipt = rows.find((r) => r.type === "payment_receipt");
  ok(
    "billing mail copies billing contacts only — not disabled, not the customer again",
    JSON.stringify(receipt?.ccAddresses) === JSON.stringify(["accounts@a.com", "bounced@a.com"]),
    JSON.stringify(receipt?.ccAddresses),
  );
  const before = captured.length;
  await deliverFor(c.bizId);
  const sent = captured.slice(before).find((m) => m.idempotencyKey === receipt?.publicId);
  ok(
    "a suppressed contact is dropped at delivery",
    JSON.stringify(sent?.cc) === JSON.stringify(["accounts@a.com"]),
    JSON.stringify(sent?.cc),
  );
  const activated = rows.find((r) => r.type === "subscription_activated");
  if (activated)
    ok(
      "account mail copies account contacts only",
      JSON.stringify(activated.ccAddresses) === JSON.stringify(["owner@a.com"]),
      JSON.stringify(activated.ccAddresses),
    );
  else
    console.log(
      "  (no subscription_activated mail in this flow — account audience covered by unit test)",
    );
}

// ---- Case 8: a failed charge names the method it tried ----
// A merchant template using {{paymentMethodType}} went out as "We couldn't charge your "
// in production, because payment_failed never filled it.
{
  const d = await setupBiz(true, {}, "tok_4000000000000002", 5000, async ({ orgId, bizId }) => {
    await upsertTemplate(orgId, bizId, "payment_failed", {
      subject: 'We couldn\'t charge your {{paymentMethodType | default: "BLANK"}}',
      heading: "Payment failed",
      body: "Hi {{customerName}}",
    });
  });
  const failed = (await rowsFor(d.orgId, d.bizId)).find((r) => r.type === "payment_failed");
  ok("a declined card produces a payment_failed email", !!failed);
  ok(
    "…whose {{paymentMethodType}} is filled from the charge that failed",
    failed?.subject === "We couldn't charge your card",
    failed?.subject,
  );
}

// ---- Case 9: an invoice the customer pays themselves gets "Invoice to pay" ----
{
  const off = await setupBiz(true, {}, "tok_4242", 5000, undefined, "off");
  const offRows = await rowsFor(off.orgId, off.bizId);
  const toPay = offRows.find((r) => r.type === "invoice_to_pay");
  ok(
    "an offline invoice sends Invoice to pay, not Invoice issued",
    !!toPay && !offRows.some((r) => r.type === "invoice_issued"),
    offRows.map((r) => r.type),
  );
  ok(
    "…with the due date and a Pay now button",
    !!toPay && /due on /.test(toPay.subject) && toPay.bodyText.includes("Pay now: "),
    toPay?.subject,
  );

  const on = await setupBiz(true);
  const onRows = await rowsFor(on.orgId, on.bizId);
  const issued = onRows.find((r) => r.type === "invoice_issued");
  ok(
    "an auto-collected invoice still sends Invoice issued, with no button",
    !!issued &&
      !issued.bodyText.includes("Pay now: ") &&
      !onRows.some((r) => r.type === "invoice_to_pay"),
  );

  // A business that customised Invoice issued keeps its words for offline invoices.
  const inh = await setupBiz(
    true,
    {},
    "tok_4242",
    5000,
    async ({ orgId, bizId }) => {
      await upsertTemplate(orgId, bizId, "invoice_issued", {
        subject: "Our own invoice words",
        heading: "H",
        body: "Hi {{customerName}}",
      });
    },
    "off",
  );
  const inhRow = (await rowsFor(inh.orgId, inh.bizId)).find((r) => r.type === "invoice_to_pay");
  ok(
    "…using its customised Invoice issued until Invoice to pay has its own",
    inhRow?.subject === "Our own invoice words",
    inhRow?.subject,
  );

  // Muting Invoice issued mutes the offline one too, until it is switched on its own.
  const muted = await setupBiz(
    true,
    { types: { invoice_issued: false } },
    "tok_4242",
    5000,
    undefined,
    "off",
  );
  ok(
    "muting Invoice issued also mutes Invoice to pay",
    !(await rowsFor(muted.orgId, muted.bizId)).some(
      (r) => r.type === "invoice_to_pay" || r.type === "invoice_issued",
    ),
  );
}

// ---- Case 10: a voided invoice's queued Invoice issued is not sent ----
// Time-travelled and scoped so the live dev worker cannot deliver the row first.
{
  const v = await setupBiz(true, {}, "tok_4242", 5000, async ({ orgId, bizId }) => {
    await startTimeTravel({ orgId, bizId, genesisTime: new Date() });
  });
  const issued = (await rowsFor(v.orgId, v.bizId)).find((r) => r.type === "invoice_issued");
  await withTenant(v.orgId, (tx) =>
    tx
      .update(invoices)
      .set({ status: "voided", voidedAt: new Date() })
      .where(eq(invoices.id, issued!.invoiceId!)),
  );
  const before = captured.length;
  const res = await runWithClockScope({ onlyBusinessId: v.bizId }, () =>
    deliverPendingEmails(new Date()),
  );
  const row = (await rowsFor(v.orgId, v.bizId)).find((r) => r.id === issued?.id);
  ok(
    "a voided invoice's Invoice issued is skipped, with the reason",
    row?.status === "skipped" && /voided/.test(row.lastError ?? "") && res.stale >= 1,
    `${row?.status} / ${row?.lastError} / stale=${res.stale}`,
  );
  ok(
    "…and never reaches the mailer",
    !captured.slice(before).some((m) => m.subject === issued?.subject),
  );
}

setMailer(null);
// ---- Case 11: a customer who opted out gets no automatic mail ----
{
  const a = await setupBiz(true, {}, "tok_4242", 5000, ({ orgId, customerId }) =>
    withTenant(orgId, (tx) =>
      tx.update(customers).set({ emailNotifications: false }).where(eq(customers.id, customerId)),
    ).then(() => undefined),
  );
  const rows = await rowsFor(a.orgId, a.bizId);
  ok("opted-out customer: nothing enqueued", rows.length === 0, rows.map((r) => r.type).join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail ? 1 : 0);
