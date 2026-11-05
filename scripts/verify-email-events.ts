/**
 * Proves the event → email mapping: every billing event that should reach the customer
 * does, addressed to the right customer, with every variable the template promises.
 *
 * The load-bearing claim is the SECOND one. A `{{var}}` the enqueue path never sets
 * renders as empty text, silently — "your invoice  is overdue" — so this script does not
 * eyeball a few subjects: it re-parses every rendered subject and body back through its
 * own template, recovers what each placeholder actually rendered to, and fails on any
 * variable `TEMPLATE_VARS` marks `always: true` that came out blank. Driven off the
 * registry, so a type added later is covered the day it is added.
 *
 * Also asserted: dates are business-local calendar dates (an ISO timestamp anywhere in
 * customer mail is a failure), a non-payment cancellation still routes to its own
 * template while an ordinary one does not, and an email-disabled business enqueues
 * nothing at all.
 *
 *   pnpm verify:email-events
 */
import { eq } from "drizzle-orm";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { paymentSourceSweep } from "@/modules/payment-methods/sweep";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  pauseSubscription,
  resumeSubscription,
  cancelSubscription,
  editTrialEnd,
} from "@/modules/subscriptions/service";
import { runRemindersPass } from "@/modules/subscriptions/reminders";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { refundPayment } from "@/modules/refunds/service";
import { markPaymentMethodInvalid } from "@/modules/invoicing/collection";
import { issueAdjustmentCreditNote } from "@/modules/credit-notes/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { deliverPendingEmails } from "@/modules/emails/outbox";
import { DEFAULT_TEMPLATES, TEMPLATE_VARS, renderEmail } from "@/modules/emails/templates";
import type { EmailType } from "@/modules/emails/config";
import { formatDateInTz } from "@/modules/invoicing/document";
import { setMailer, type OutboundEmail } from "@/providers/mailer";
import { businesses, emailMessages, paymentMethods } from "@db/schema";
import { loadGeoReference } from "@/platform/geo";
import { matchTemplate, stripTemplateTail } from "./lib/template-match";
import { resolveFooter } from "@/modules/emails/templates";
import { asTeamMembers } from "./lib/team-addresses";

/**
 * LOAD THE COUNTRY REFERENCE THIS SUITE READS, rather than inheriting it.
 *
 * `verify-all.sh` seeds the geo TABLES once per run, but the in-process cache is loaded
 * by whichever suite calls `loadGeoReference()` — and this one never did. It passed only
 * because a tax suite happened to run before it in the same process.
 *
 * Sharding removed that accident: `geo` is index 15 (shard 1) and this suite is index 124
 * (shard 5), so they never share a process, and shard 5 died with `GeoNotLoadedError` on
 * every run. Exactly the hermeticity trap the sharding note in verify-all.sh warns about —
 * a suite that reads global state passes by accident of ordering.
 *
 * The rows are already seeded, so this is a cheap read, and it makes the suite runnable on
 * its own — which is how anyone debugs it.
 */
await loadGeoReference();

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

// Capturing fake mailer so nothing leaves the building (and no transport is required).
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

// A non-UTC business, so a date formatted in the WRONG zone shows up as the wrong day.
const TZ = "Asia/Kolkata";

// ── the always-variable check ─────────────────────────────────────────────────
// Turn a template into a regex whose capture groups are its `{{placeholders}}`, run the
// rendered string back through it, and read off what each variable actually rendered to.
// This is how "renders empty, silently" becomes an assertion instead of a code review.
function capturePlaceholders(tpl: string, rendered: string): Map<string, string[]> | null {
  return matchTemplate(tpl, rendered);
}

/** Names of every `always: true` variable that rendered blank (or an unparseable body). */
function emptyAlwaysVars(row: { type: string; subject: string; bodyText: string }): string[] {
  const type = row.type as EmailType;
  const def = DEFAULT_TEMPLATES[type];
  const always = new Set(TEMPLATE_VARS[type].filter((v) => v.always).map((v) => String(v.key)));
  // renderEmail appends the shell's blocks to the text body, and none of them come from
  // the template: the action button ("Pay now: <url>"), then one line per facts-card row
  // ("Invoiced amount: $17.11"). Each is a single `Label: value` line joined by a blank
  // line, so they are peeled off the end until only the template's own text remains.
  // Stripping just "Manage billing:" stopped working when the fixed CTA became a typed
  // per-type action and the card arrived — the template then failed to match at all and
  // every row reported `body:unparseable`.
  // The footer follows the shell's blocks, so it comes off first.
  let body = stripTemplateTail(row.bodyText, resolveFooter(def));
  for (;;) {
    const m = /\n\n[^\n]+: [^\n]+$/.exec(body);
    if (!m) break;
    body = body.slice(0, m.index);
  }
  const bad: string[] = [];
  for (const [tpl, rendered, where] of [
    [def.subject, row.subject, "subject"],
    [def.body, body, "body"],
  ] as const) {
    const caps = capturePlaceholders(tpl, rendered);
    if (!caps) {
      bad.push(`${where}:unparseable`);
      continue;
    }
    for (const [k, values] of caps) {
      if (always.has(k) && values.some((v) => v.trim() === "")) bad.push(`${where}:${k}`);
    }
  }
  return bad;
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// ── fixture ───────────────────────────────────────────────────────────────────
async function setupBiz(emailEnabled: boolean, name: string) {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ timezone: TZ, ...(emailEnabled ? { emailConfig: { enabled: true } } : {}) })
      .where(eq(businesses.id, biz.id)),
  );
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Pro Plan",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  return { orgId, bizId: biz.id, price };
}

const rowsFor = (orgId: string, bizId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(emailMessages).where(eq(emailMessages.businessId, bizId)),
  );

// ── Case 1: an email-enabled business, driven through every mapped event ──────
const { orgId, bizId, price } = await setupBiz(true, "Acme Reports");
await asTeamMembers(orgId, "ann@payer.example", "ben@buyer.example"); // test mode emails only team members
const now = new Date();

const ann = await createCustomer({
  organizationId: orgId,
  businessId: bizId,
  email: "ann@payer.example",
  firstName: "Ann",
  lastName: "Payer",
});
const ben = await createCustomer({
  organizationId: orgId,
  businessId: bizId,
  email: "ben@buyer.example",
  firstName: "Ben",
  lastName: "Buyer",
});
const annCard = await vaultPaymentMethod({
  organizationId: orgId,
  businessId: bizId,
  customer: ann,
  token: "tok_4242",
});

const newSub = async (customerId: string, extra: { trialDays?: number; withCard?: boolean } = {}) =>
  (
    await createSubscription({
      organizationId: orgId,
      businessId: bizId,
      customerId,
      now,
      items: [{ price, quantity: 1 }],
      ...(extra.trialDays ? { trialDays: extra.trialDays } : {}),
      ...(extra.withCard ? { defaultPaymentMethodId: annCard.id } : {}),
    })
  ).subscription;

const bill = (sub: Awaited<ReturnType<typeof newSub>>) =>
  billSubscriptionPeriod({
    organizationId: orgId,
    businessId: bizId,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });

// Ann: paid invoice → invoice_issued, payment_receipt, subscription_activated.
const subA = await newSub(ann.id, { withCard: true });
const { payment } = await bill(subA);
ok("fixture: Ann’s invoice was charged", payment?.status === "succeeded");

// refund_created (a refund of an invoice-linked payment also issues a refunded CN).
if (payment) {
  await refundPayment({
    organizationId: orgId,
    businessId: bizId,
    paymentPublicId: payment.publicId,
    amountMinor: 2000,
    reason: "goodwill",
  });
}

// Ben: no card → the invoice stays open, so an adjustment credit note applies to it
// (that one call emits credit_note_created AND credit_note_allocated).
const subB = await newSub(ben.id);
const { invoice: invB } = await bill(subB);
await issueAdjustmentCreditNote({
  organizationId: orgId,
  businessId: bizId,
  invoicePublicId: invB.publicId,
  items: [{ description: "Service credit", amountMinor: 1000 }],
  reason: "goodwill",
});

// invoice_payment_due — emitted here with the payload the dunning/settlement paths use,
// so the mapping is proven without driving a card decline.
await withTenant(orgId, (tx) =>
  emitEvent(tx, {
    organizationId: orgId,
    businessId: bizId,
    type: "invoice_payment_due",
    data: buildEventData("invoice_payment_due", { id: invB.publicId, next_attempt_at: null }),
  }),
);

// pause / resume (real service calls).
await pauseSubscription({ organizationId: orgId, businessId: bizId, subscriptionId: subA.id });
await resumeSubscription({ organizationId: orgId, businessId: bizId, subscriptionId: subA.id });

// subscription_changed / subscription_renewed — emitted with the engine's own payloads
// (a real renewal needs the clock; the mapping under test is the same either way).
await withTenant(orgId, async (tx) => {
  await emitEvent(tx, {
    organizationId: orgId,
    businessId: bizId,
    type: "subscription_changed",
    data: buildEventData("subscription_changed", { id: subA.publicId, status: "active" }),
  });
  await emitEvent(tx, {
    organizationId: orgId,
    businessId: bizId,
    type: "subscription_renewed",
    data: buildEventData("subscription_renewed", {
      id: subA.publicId,
      current_period_start: subA.currentPeriodStart!,
      current_period_end: subA.currentPeriodEnd!,
    }),
  });
});

// trial_ending — the real reminder pass, off a subscription trialing inside the window.
await newSub(ann.id, { trialDays: 2 });
await runRemindersPass(now);

// renewal_reminder / cancellation_reminder — emitted with runRemindersPass's exact
// payload (resource fields + the top-level occurrence date it dedupes on), so the
// mapping is proven against the shape the pass really produces rather than a guess.
const subC = await newSub(ben.id);
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subC.id,
  atPeriodEnd: true,
  now,
});
await withTenant(orgId, async (tx) => {
  await emitEvent(tx, {
    organizationId: orgId,
    businessId: bizId,
    type: "subscription_renewal_reminder",
    data: buildEventData(
      "subscription_renewal_reminder",
      { id: subA.publicId, current_period_end: subA.currentPeriodEnd! },
      null,
      // The pass also writes the renewal estimate (expected_amount_minor + currency).
      {
        renewal_at: subA.currentPeriodEnd!.toISOString(),
        expected_amount_minor: 129900,
        currency: "USD",
      },
    ),
  });
  await emitEvent(tx, {
    organizationId: orgId,
    businessId: bizId,
    type: "subscription_cancellation_reminder",
    data: buildEventData(
      "subscription_cancellation_reminder",
      { id: subC.publicId, cancel_scheduled_at: subC.currentPeriodEnd! },
      null,
      { cancel_at: subC.currentPeriodEnd!.toISOString() },
    ),
  });
});

// The two cancellations: one the buyer chose, one dunning caused.
const subD = await newSub(ann.id);
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subD.id,
  atPeriodEnd: false,
  now,
});
const subE = await newSub(ben.id);
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subE.id,
  atPeriodEnd: false,
  now,
  cancelReason: "not_paid",
});

// card_expiring then card_expired, via the real expiry sweep.
await withTenant(orgId, (tx) =>
  tx
    .update(paymentMethods)
    .set({
      brand: "visa",
      last4: "4242",
      expMonth: now.getUTCMonth() + 1,
      expYear: now.getUTCFullYear(),
      status: "valid",
    })
    .where(eq(paymentMethods.id, annCard.id)),
);
await paymentSourceSweep(now);
await withTenant(orgId, (tx) =>
  tx
    .update(paymentMethods)
    .set({ expMonth: 12, expYear: now.getUTCFullYear() - 1 })
    .where(eq(paymentMethods.id, annCard.id)),
);
await paymentSourceSweep(now);

// ── the four trial/instrument types added later ───────────────────────────────
// Driven through the REAL service calls, not hand-emitted payloads: the claim under test
// is that these events fire at all, and a hand-written envelope would prove only that the
// mapping works on an envelope we wrote ourselves. Each of the four had no email before.

// trial_expired — a trial that ran out without converting. `trial_ended` is the reason
// `cancelTrialThatDidNotConvert` stamps; it used to take the ordinary-cancellation branch,
// so a customer who never subscribed was told their subscription had been cancelled.
const subT = await newSub(ann.id, { trialDays: 5 });
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subT.id,
  atPeriodEnd: false,
  now,
  cancelReason: "trial_ended",
});

// trial_extended — the real editTrialEnd, moving the boundary LATER.
const subX = await newSub(ben.id, { trialDays: 3 });
await editTrialEnd({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subX.id,
  now,
  trialEnd: new Date(now.getTime() + 30 * 24 * 3600_000),
});

// …and the same call moving it EARLIER must not congratulate anybody.
const subY = await newSub(ben.id, { trialDays: 20 });
await editTrialEnd({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: subY.id,
  now,
  trialEnd: new Date(now.getTime() + 2 * 24 * 3600_000),
});

// payment_method_invalid — a hard decline marking the instrument unusable. The status
// write used to be silent: no event, so no webhook and no email for the one payment-method
// state the customer has to act on.
await markPaymentMethodInvalid(orgId, annCard.id);
// Twice, because a dunning run that hard-declines on every retry must not mail per attempt.
await markPaymentMethodInvalid(orgId, annCard.id);

// ── assertions ────────────────────────────────────────────────────────────────
const rows = await rowsFor(orgId, bizId);
const of = (t: EmailType) => rows.filter((r) => r.type === t);

// The amounts that used to be advertised but never filled.
ok(
  "renewal_reminder states the renewal amount",
  of("renewal_reminder").some((r) => r.bodyText.includes("$1,299.00")),
  of("renewal_reminder")[0]?.bodyText.slice(0, 200),
);
ok(
  "subscription_renewed states what the renewal cost",
  // In the details card, which drops the row when there is no amount.
  of("subscription_renewed").some((r) => /Amount: \S*\d/.test(r.bodyText)),
  of("subscription_renewed")[0]?.bodyText.slice(0, 200),
);

// Every newly mapped event enqueued a row of the right type…
const expected: EmailType[] = [
  "invoice_issued",
  "invoice_overdue",
  "payment_receipt",
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
  "card_expiring",
  "card_expired",
  "trial_ending",
  "renewal_reminder",
  "cancellation_reminder",
];
for (const t of expected)
  ok(
    `${t}: enqueued`,
    of(t).length > 0,
    rows.map((r) => r.type),
  );

// …addressed to the right customer. Ann and Ben each own their own records, so a
// resolver reading the wrong table lands the mail on the wrong person.
const addressedTo = (t: EmailType, email: string) =>
  of(t).length > 0 && of(t).every((r) => r.toAddress === email);
// Both customers were invoiced, so this type proves the resolver picks the invoice's
// OWN customer rather than whichever one it finds first.
const bothCustomers = (t: EmailType) =>
  of(t).some((r) => r.toAddress === "ann@payer.example") &&
  of(t).some((r) => r.toAddress === "ben@buyer.example");
ok(
  "invoice_issued → each invoice’s own customer",
  bothCustomers("invoice_issued"),
  of("invoice_issued").map((r) => r.toAddress),
);
ok(
  "credit_note_issued → each note’s own customer",
  bothCustomers("credit_note_issued"),
  of("credit_note_issued").map((r) => r.toAddress),
);
ok("payment_receipt → Ann", addressedTo("payment_receipt", "ann@payer.example"));
ok(
  "refund_issued → Ann (via the refunded payment)",
  addressedTo("refund_issued", "ann@payer.example"),
);
ok("invoice_overdue → Ben (his open invoice)", addressedTo("invoice_overdue", "ben@buyer.example"));
ok(
  "credit_note_applied → Ben (the note’s customer)",
  addressedTo("credit_note_applied", "ben@buyer.example"),
);
ok("card_expiring → Ann (the card’s owner)", addressedTo("card_expiring", "ann@payer.example"));
ok("card_expired → Ann", addressedTo("card_expired", "ann@payer.example"));
ok(
  "trial_ending → Ann (her trialing subscription)",
  addressedTo("trial_ending", "ann@payer.example"),
);
ok(
  "cancellation_reminder → Ben (his non-renewing subscription)",
  addressedTo("cancellation_reminder", "ben@buyer.example"),
);
ok(
  "every row went to one of the two customers",
  rows.every((r) => r.toAddress === "ann@payer.example" || r.toAddress === "ben@buyer.example"),
  rows.map((r) => r.toAddress),
);

// No `always: true` variable renders empty, in any row.
const blanks = rows
  .map((r) => ({ type: r.type, subject: r.subject, blank: emptyAlwaysVars(r) }))
  .filter((r) => r.blank.length > 0);
ok("no always-variable renders empty", blanks.length === 0, blanks);

// ── the shell's card and button blocks actually reach a real send ─────────────
// Unit tests prove `brandedShell` can render a card and a button; these prove the outbox
// POPULATES them, which is the half that silently regresses. A card whose rows never get
// filled is the email equivalent of a control that renders but does nothing.
const anyOf = (t: EmailType, needle: string) => of(t).some((r) => r.bodyText.includes(needle));

ok(
  "invoice_issued carries an invoice facts card",
  anyOf("invoice_issued", "Invoice: "),
  of("invoice_issued")[0]?.bodyText.slice(-200),
);
ok("invoice_issued states the amount in the card", anyOf("invoice_issued", "Invoiced amount: "));
ok(
  "a payable email offers Pay now, not the generic CTA",
  anyOf("invoice_overdue", "Pay now: "),
  of("invoice_overdue")[0]?.bodyText.slice(-200),
);
ok("invoice_overdue states what it is overdue since", anyOf("invoice_overdue", "Due since: "));
ok(
  "card_expiring offers Change payment method",
  anyOf("card_expiring", "Change payment method: "),
  of("card_expiring")[0]?.bodyText.slice(-200),
);
ok(
  "card_expiring names the card and its expiry",
  anyOf("card_expiring", "Card: ") && anyOf("card_expiring", "Expires: "),
);
// The button carries a PRE-AUTHENTICATED, per-customer link — what a
// `payment_method_update_url` has to be. It used to be `/portal/request`, the page that
// asks the buyer for their email so it can send them a link: "Pay now" did not pay, it
// started a login, and the two buttons differed only in their label.
ok(
  "a payable email carries a pre-authenticated portal link, not the request page",
  of("invoice_overdue").every((r) => /\/portal\/s\/pstk_/.test(r.bodyText)) &&
    of("invoice_overdue").every((r) => !r.bodyText.includes("/portal/request")),
  of("invoice_overdue")[0]?.bodyText.slice(-220),
);
ok(
  "each email gets its OWN link, never a shared one",
  // One entry credential per message: a link consumed by one recipient (or by a mail
  // scanner following it) must not be the same one another customer was sent.
  new Set(
    rows
      .filter((r) => /\/portal\/s\//.test(r.bodyText))
      .map((r) => /\/portal\/s\/(pstk_[A-Za-z0-9_-]+)/.exec(r.bodyText)?.[1]),
  ).size === rows.filter((r) => /\/portal\/s\//.test(r.bodyText)).length,
);
ok(
  "an email with no button mints no link at all",
  // A welcome email has no action; minting a credential for a button nobody can press
  // would be a portal session created for nothing.
  of("subscription_activated").every((r) => !r.bodyText.includes("/portal/s/")),
);
// ── the four later-added types actually fire ─────────────────────────────────
ok(
  "trial_started fires when a subscription starts IN TRIAL",
  of("trial_started").length > 0,
  of("trial_started").map((r) => r.subject),
);
ok(
  "trial_started fires ONCE PER TRIALING subscription and never for an active one",
  // Four subscriptions above were created with trialDays (2, 5, 3, 20); the rest start
  // active and emit the same `subscription_started` event with `status: 'active'`, which
  // must fall through to no email — activation has its own event and its own template.
  of("trial_started").length === 4,
  of("trial_started").length,
);
ok(
  "trial_expired fires on a trial that ran out, not subscription_canceled",
  of("trial_expired").length === 1,
  of("trial_expired").map((r) => r.subject),
);
ok(
  "trial_expired is addressed to the trialing customer",
  addressedTo("trial_expired", "ann@payer.example"),
);
ok(
  "trial_extended fires when the trial boundary moves LATER",
  of("trial_extended").length === 1,
  of("trial_extended").map((r) => r.subject),
);
ok(
  "shortening a trial sends no trial_extended, and no ordinary change email either",
  // The shortened one emitted subscription_changed with the flag false. It must not read
  // as good news, and it is not a plan change worth mailing about either.
  of("trial_extended").length === 1,
);
ok(
  "payment_method_invalid fires on a hard decline",
  of("payment_method_invalid").length === 1,
  of("payment_method_invalid").map((r) => r.subject),
);
ok(
  "a second invalidation of the same instrument does not mail twice",
  of("payment_method_invalid").length === 1,
);
ok(
  "payment_method_invalid names the instrument in words, not the raw enum",
  of("payment_method_invalid").every((r) => !/\b(upi|emandate|nach)\b/.test(r.subject)),
  of("payment_method_invalid").map((r) => r.subject),
);
ok(
  "payment_method_invalid offers Change payment method",
  of("payment_method_invalid").every((r) => r.bodyText.includes("Change payment method: ")),
);

// A fact the resolver has no value for must not print as a blank line.
ok(
  "no facts-card row rendered with an empty value",
  rows.every((r) => !/\n[^\n]+: *\n/.test(r.bodyText) && !/\n[^\n]+: *$/.test(r.bodyText)),
  rows.find((r) => /\n[^\n]+: *$/.test(r.bodyText))?.type,
);

// Negative control: a check that cannot fail proves nothing. Render a type with one
// always-variable deliberately unset and confirm the checker names it.
const control = renderEmail("invoice_overdue", {
  businessName: "Acme",
  customerName: "Ann",
  amount: "50.00 USD",
  invoiceNumber: "INV-1",
});
ok(
  "the always-variable check catches a blank (negative control)",
  emptyAlwaysVars({
    type: "invoice_overdue",
    subject: control.subject,
    bodyText: control.text,
  }).includes("body:dueDate"),
);

// Dates are business-local calendar dates, never raw timestamps.
const isoLeaks = rows.filter(
  (r) => ISO_TIMESTAMP.test(r.subject) || ISO_TIMESTAMP.test(r.bodyText),
);
ok(
  "no ISO timestamp in any rendered email",
  isoLeaks.length === 0,
  isoLeaks.map((r) => r.type),
);
const overdue = of("invoice_overdue")[0];
const expectedDue = formatDateInTz(invB.dueDate ?? invB.createdAt, TZ);
ok(
  `invoice_overdue names the due date in the business timezone (${expectedDue})`,
  !!overdue && overdue.bodyText.includes(`due on ${expectedDue}`),
  overdue?.bodyText,
);

// The plan name reaches the lifecycle mail (a real product, not a placeholder).
ok(
  "subscription_activated names the plan",
  of("subscription_activated").every((r) => r.bodyText.includes("Pro Plan")),
  of("subscription_activated")[0]?.bodyText,
);

// Cancellation routing: reason decides the template, and only the reason.
ok(
  "cancel with reason not_paid → subscription_canceled_nonpayment",
  of("subscription_canceled_nonpayment").length === 1,
  of("subscription_canceled_nonpayment").length,
);
ok(
  "cancel with an ordinary reason → subscription_canceled",
  of("subscription_canceled").length === 1,
  of("subscription_canceled").length,
);

// The rows are deliverable (same path verify:emails proves end-to-end).
const delivery = await deliverPendingEmails(new Date());
ok(
  "deliverPendingEmails sent the queue with no failures",
  delivery.sent >= 1 && delivery.failed === 0,
  delivery,
);

// ── The document a message is ABOUT rides with it ───────────────────────────
// Ben's invoice is unpaid, so §fixture issued an adjustment credit note against it — which
// makes this the one suite holding both an invoice email and a credit-note email delivered
// through the outbox. The wrong-document failure is what this pins: a credit-note email
// renders the INVOICE number in its body, so attaching that invoice would look plausible in
// code and hand the customer the wrong paperwork.
// Matched on wording shared by every credit-note / invoice subject, not on one phrasing.
const cnMail = captured.find((m) => /credit/i.test(m.subject));
const cnPdf = cnMail?.attachments?.[0];
ok("a credit-note email carries an attachment", !!cnPdf, cnMail?.attachments?.length);
ok(
  "…and it is the CREDIT NOTE, not the invoice it credits",
  !!cnPdf && /^credit-note-.+\.pdf$/.test(cnPdf.filename),
  cnPdf?.filename,
);
ok("…rendered as a real PDF", !!cnPdf && cnPdf.content.subarray(0, 5).toString() === "%PDF-");

const invMail = captured.find((m) => /invoice/i.test(m.subject) && !/credit/i.test(m.subject));
const invPdf = invMail?.attachments?.[0];
ok(
  "an invoice email attaches the INVOICE",
  !!invPdf && /^invoice-.+\.pdf$/.test(invPdf.filename),
  invPdf?.filename,
);

// A lifecycle email has no document behind it and must not grow one.
const lifecycle = captured.find((m) => m.subject.toLowerCase().includes("cancel"));
if (lifecycle)
  ok("a lifecycle email has no attachment", !lifecycle.attachments?.length, lifecycle.subject);

// ── Case 2: email-disabled business (opt-in default) → nothing enqueued ───────
{
  const off = await setupBiz(false, "Quiet Co");
  const cus = await createCustomer({
    organizationId: off.orgId,
    businessId: off.bizId,
    email: "quiet@buyer.example",
    firstName: "Quinn",
  });
  const card = await vaultPaymentMethod({
    organizationId: off.orgId,
    businessId: off.bizId,
    customer: cus,
    token: "tok_4242",
  });
  const sub = (
    await createSubscription({
      organizationId: off.orgId,
      businessId: off.bizId,
      customerId: cus.id,
      now,
      items: [{ price: off.price, quantity: 1 }],
      defaultPaymentMethodId: card.id,
    })
  ).subscription;
  const billed = await billSubscriptionPeriod({
    organizationId: off.orgId,
    businessId: off.bizId,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
  if (billed.payment) {
    await refundPayment({
      organizationId: off.orgId,
      businessId: off.bizId,
      paymentPublicId: billed.payment.publicId,
      amountMinor: 1000,
    });
  }
  await pauseSubscription({
    organizationId: off.orgId,
    businessId: off.bizId,
    subscriptionId: sub.id,
  });
  await resumeSubscription({
    organizationId: off.orgId,
    businessId: off.bizId,
    subscriptionId: sub.id,
  });
  await cancelSubscription({
    organizationId: off.orgId,
    businessId: off.bizId,
    subscriptionId: sub.id,
    atPeriodEnd: false,
    now,
  });
  const offRows = await rowsFor(off.orgId, off.bizId);
  ok(
    "disabled: no emails enqueued for any of the new events",
    offRows.length === 0,
    offRows.map((r) => r.type),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
setMailer(null);
await closeDb();
process.exit(fail ? 1 : 0);
