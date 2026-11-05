/**
 * Proves the billing-clock reminder pass (`runRemindersPass`) emits the three
 * time-relative subscription warnings correctly, and — the part that is easy to
 * get wrong — that the RECURRING ones dedupe per OCCURRENCE, not per subscription:
 * a renewal reminder must fire once per term, every term, forever.
 *
 * Each scenario lives in its own business and the pass is run inside
 * `runWithClockScope({ onlyBusinessId })`, so the returned counts are exactly the
 * scenario's (a system-wide scan would also pick up whatever else is in the dev DB).
 *
 * Cases 6–10 cover per-business lead days (0376) on time-travelled businesses, through the
 * real settings route: two lead days per kind, no back-fill after a change, events from
 * before 0376 not re-sent, and the input limits.
 *
 *   pnpm verify:email-reminders
 */
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { buildApp } from "@/index";
import { startTimeTravel } from "@/modules/time-travel/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { runRemindersPass } from "@/modules/subscriptions/reminders";
import { estimateRenewal } from "@/modules/subscriptions/estimate";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { runWithClockScope } from "@/platform/clock";
import { businesses, events, subscriptions, paymentMethods, timeTravels } from "@db/schema";
import {
  ACH_AUTHORIZATION_TEXT_VERSION,
  achAuthorizationEvidence,
  insertAchAuthorization,
} from "@/modules/payment-methods/ach-authorization";

let achAuthorizationId: string | null = null;

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label);
  }
}

const DAY = 24 * 3600_000;
const T = new Date("2026-09-01T10:00:00.000Z");

const org = await createOrganization({ name: "Reminders" });
const orgId = org.organization.id;

/** A business + customer + price + one subscription, isolated from the others. */
async function setupSub(name: string, opts: { trialDays?: number } = {}) {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `${name}@a.com`,
    firstName: "Pat",
    lastName: "Payer",
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
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
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: T,
    items: [{ price, quantity: 1 }],
    autoCollection: "off",
    ...opts,
  });
  return { bizId: biz.id, sub: created.subscription };
}

/** Force the subscription's clock-relevant columns; the pass reads only these. */
async function patch(subId: string, set: Partial<typeof subscriptions.$inferInsert>) {
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set(set).where(eq(subscriptions.id, subId)),
  );
}

/** Run the pass as if it were `now`, scoped to one business. */
function tick(bizId: string, now: Date) {
  return runWithClockScope({ onlyBusinessId: bizId }, () => runRemindersPass(now));
}

/** Every emitted event of `type` for this subscription, oldest first. */
async function emitted(type: string, publicId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ id: events.id, data: events.data })
      .from(events)
      .where(
        and(
          eq(events.type, type),
          eq(events.resourceType, "subscription"),
          eq(events.resourceId, publicId),
        ),
      )
      .orderBy(events.createdAt),
  );
}
const occurrence = (row: { data: unknown }, key: string) =>
  (row.data as Record<string, unknown>)[key];

// ---- Case 1: renewal fires once per TERM, every term ----------------------
{
  const { bizId, sub } = await setupSub("renewal");
  const term1End = new Date(T.getTime() + 30 * DAY);
  await patch(sub.id, { status: "active", currentPeriodStart: T, currentPeriodEnd: term1End });

  const far = await tick(bizId, new Date(term1End.getTime() - 10 * DAY));
  ok("renewal: silent outside the window (10d out, window 5d)", far.renewal === 0);

  const inside = await tick(bizId, new Date(term1End.getTime() - 2 * DAY));
  ok("renewal: fires inside the window", inside.renewal === 1);
  ok("renewal: counted in the pass total", inside.reminded === 1);

  const again = await tick(bizId, new Date(term1End.getTime() - 1 * DAY));
  ok("renewal: does NOT re-fire later in the SAME term", again.renewal === 0);
  ok(
    "renewal: exactly one event for term 1",
    (await emitted("subscription_renewal_reminder", sub.publicId)).length === 1,
  );

  // Roll into term 2, as a renewal would.
  const term2End = new Date(term1End.getTime() + 30 * DAY);
  await patch(sub.id, { currentPeriodStart: term1End, currentPeriodEnd: term2End });

  const nextTerm = await tick(bizId, new Date(term2End.getTime() - 2 * DAY));
  ok("renewal: DOES fire again for term 2", nextTerm.renewal === 1);
  const rows = await emitted("subscription_renewal_reminder", sub.publicId);
  ok("renewal: two events, one per term", rows.length === 2);
  ok(
    "renewal: the pass writes the renewal amount for the email",
    typeof (rows[0]!.data as Record<string, unknown>).expected_amount_minor === "number",
  );
  ok(
    "renewal: the two events carry different occurrence dates",
    occurrence(rows[0]!, "renewal_at") === term1End.toISOString() &&
      occurrence(rows[1]!, "renewal_at") === term2End.toISOString(),
  );

  const term2Again = await tick(bizId, new Date(term2End.getTime() - 1 * DAY));
  ok("renewal: term 2 does not double-fire either", term2Again.renewal === 0);
}

// ---- Case 1b: a yearly plan gets a longer renewal notice ------------------
{
  const { bizId, sub } = await setupSub("renewal-yearly");
  const end = new Date(T.getTime() + 365 * DAY);
  await patch(sub.id, {
    status: "active",
    currentPeriodStart: T,
    currentPeriodEnd: end,
    billingPeriod: 1,
    billingPeriodUnit: "year",
  });
  const far = await tick(bizId, new Date(end.getTime() - 40 * DAY));
  ok("yearly renewal: silent 40 days out", far.renewal === 0);
  const inside = await tick(bizId, new Date(end.getTime() - 20 * DAY));
  ok(
    "yearly renewal: fires 20 days out (30-day window), where monthly would not",
    inside.renewal === 1,
  );
  const again = await tick(bizId, new Date(end.getTime() - 3 * DAY));
  ok("yearly renewal: once per term, not again at 3 days", again.renewal === 0);
}

// ---- Case 2: scheduled cancellation (specific_date) -----------------------
{
  const { bizId, sub } = await setupSub("cancel-scheduled");
  // Term end is inside the renewal window too — a non_renewing subscription must
  // be warned about the CANCELLATION, never about a renewal that will not happen.
  await patch(sub.id, {
    status: "active",
    currentPeriodStart: T,
    currentPeriodEnd: new Date(T.getTime() + 4 * DAY),
    cancelScheduledAt: new Date(T.getTime() + 20 * DAY),
  });

  const far = await tick(bizId, T);
  ok("cancellation: silent when the cancel date is outside the window", far.cancellation === 0);
  ok("cancellation: no renewal reminder for a non_renewing subscription", far.renewal === 0);

  const cancelAt = new Date(T.getTime() + 3 * DAY);
  await patch(sub.id, { cancelScheduledAt: cancelAt });

  const inside = await tick(bizId, T);
  ok("cancellation: fires for a scheduled cancellation in the window", inside.cancellation === 1);
  const rows = await emitted("subscription_cancellation_reminder", sub.publicId);
  ok(
    "cancellation: event carries the cancel date as its occurrence",
    rows.length === 1 && occurrence(rows[0]!, "cancel_at") === cancelAt.toISOString(),
  );

  const again = await tick(bizId, new Date(T.getTime() + 1 * DAY));
  ok("cancellation: does NOT re-fire for the same scheduled date", again.cancellation === 0);

  // Reschedule → a different occurrence → warn again.
  const moved = new Date(T.getTime() + 5 * DAY);
  await patch(sub.id, { cancelScheduledAt: moved });
  const rescheduled = await tick(bizId, T);
  ok(
    "cancellation: fires again when the cancellation is rescheduled",
    rescheduled.cancellation === 1,
  );
}

// ---- Case 3: no cancellation reminder without a scheduled cancellation ----
{
  const { bizId, sub } = await setupSub("plain-active");
  const termEnd = new Date(T.getTime() + 3 * DAY);
  await patch(sub.id, { status: "active", currentPeriodStart: T, currentPeriodEnd: termEnd });

  const r = await tick(bizId, T);
  ok("unscheduled: renewal reminder fires", r.renewal === 1);
  ok("unscheduled: NO cancellation reminder", r.cancellation === 0);
  ok(
    "unscheduled: no cancellation event exists",
    (await emitted("subscription_cancellation_reminder", sub.publicId)).length === 0,
  );

  // Flip on the end-of-term cancel: the same term end is now a cancellation.
  await patch(sub.id, { cancelAtPeriodEnd: true });
  const c = await tick(bizId, T);
  ok("cancel_at_period_end: cancellation reminder fires on the term end", c.cancellation === 1);
  ok("cancel_at_period_end: renewal reminder no longer fires", c.renewal === 0);
  const rows = await emitted("subscription_cancellation_reminder", sub.publicId);
  ok(
    "cancel_at_period_end: occurrence is current_period_end",
    rows.length === 1 && occurrence(rows[0]!, "cancel_at") === termEnd.toISOString(),
  );
}

// ---- Case 4: trial_ending regression (unchanged behaviour) ----------------
{
  const { bizId, sub } = await setupSub("trial", { trialDays: 14 });
  const trialEnd = sub.trialEnd!;
  ok("trial: subscription is in_trial with a trial end", sub.status === "in_trial" && !!trialEnd);

  const far = await tick(bizId, new Date(trialEnd.getTime() - 10 * DAY));
  ok("trial: silent outside the 3-day window", far.trialEnding === 0);

  const inside = await tick(bizId, new Date(trialEnd.getTime() - 1 * DAY));
  ok("trial: fires inside the window", inside.trialEnding === 1);
  ok("trial: no renewal reminder for an in_trial subscription", inside.renewal === 0);

  const again = await tick(bizId, new Date(trialEnd.getTime() - 12 * 3600_000));
  ok("trial: still deduped per subscription (fires once, ever)", again.trialEnding === 0);
  ok(
    "trial: exactly one trial_ending event",
    (await emitted("subscription_trial_ending", sub.publicId)).length === 1,
  );
}

// ---- Case 5: the pre-debit notice states the amount that will be DEBITED ----
//
// NPCI/RBI require the payer be told the amount before every mandate debit, so this
// figure is a legal artifact rather than a courtesy — and it was wrong. It quoted
// `subscriptions.mrr`, a MONTHLY-NORMALIZED metric: a ₹1,20,000/year mandate was
// notified for ₹10,000 (measured 2026-08-18). Silently correct for the monthly plans
// anyone would spot-check, out by 12× for a yearly one, and short by the whole tax
// amount on a GST renewal.
//
// The yearly case is the guard. A monthly-only test cannot fail, which is exactly why
// this went unnoticed — MRR and the monthly charge are the same number.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "predebit",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "pd@a.com",
    firstName: "Pat",
    lastName: "Payer",
  });
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Annual",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: 12_000_000,
    interval: "year",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "4242424242424242",
  });
  // A mandate rail is the entire scope of the obligation (0179). A plain card-on-file
  // carries none, and notifying those would train customers to ignore the mail that
  // legally matters — case 5b below is that control.
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ mandateRail: "upi", mandateReference: "UMN-VERIFY-1" })
      .where(eq(paymentMethods.id, pm.id)),
  );
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: T,
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const termEnd = new Date(T.getTime() + 365 * DAY);
  await patch(created.subscription.id, {
    status: "active",
    currentPeriodStart: T,
    currentPeriodEnd: termEnd,
  });

  const far = await tick(biz.id, new Date(termEnd.getTime() - 10 * DAY));
  ok("pre-debit: silent outside the window", far.preDebit === 0);

  const inside = await tick(biz.id, new Date(termEnd.getTime() - 1 * DAY));
  ok("pre-debit: fires inside the window on a mandate rail", inside.preDebit === 1);

  const rows = await emitted("subscription_pre_debit_notification", created.subscription.publicId);
  const d = (rows[0]?.data ?? {}) as Record<string, unknown>;
  const est = await estimateRenewal({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: created.subscription.id,
  });
  ok(
    "pre-debit: quotes the FULL yearly debit, not the monthly-normalized MRR",
    d.expected_amount_minor === 12_000_000,
  );
  ok(
    "pre-debit: agrees with the renewal's own calculator, tax and all",
    d.expected_amount_minor === (est?.amount_due_minor ?? est?.total_minor),
  );
  // The other two facts the rule names.
  ok("pre-debit: carries the mandate reference", d.mandate_reference === "UMN-VERIFY-1");
  ok(
    "pre-debit: carries the debit date",
    typeof d.debit_at === "string" && (d.debit_at as string).length > 0,
  );

  const again = await tick(biz.id, new Date(termEnd.getTime() - 12 * 3600_000));
  ok("pre-debit: deduped per occurrence — one notice per term", again.preDebit === 0);
}

// ---- Case 5c: an ACH debit under our authorization (Reg E 1005.10(d)) ---------
// Amounts vary per invoice, so the payer is told amount and date at least 10 days ahead.
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "predebit-ach",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "pd-ach@example.com",
    firstName: "Pat",
    lastName: "Payer",
  });
  const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Team" });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 4900,
    interval: "month",
  });
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "4242424242424242",
  });
  // An Authorize.net eCheck, as the setup flow would have saved it, with its authorization.
  await withTenant(orgId, async (tx) => {
    await tx
      .update(paymentMethods)
      .set({ type: "us_bank_account", providerKey: "authorizenet", last4: "7891" })
      .where(eq(paymentMethods.id, pm.id));
    return insertAchAuthorization(tx, {
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      paymentMethodId: pm.id,
      paymentMethodPublicId: pm.publicId,
      gatewayKey: "authorizenet",
      methodType: "us_bank_account",
      evidence: achAuthorizationEvidence(
        { textVersion: ACH_AUTHORIZATION_TEXT_VERSION, ipAddress: null, userAgent: null },
        { businessName: "predebit-ach", payerName: "Pat Payer", payerEmail: "pd-ach@example.com" },
      ),
    });
  }).then((pma) => (achAuthorizationId = pma));
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: T,
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const termEnd = new Date(T.getTime() + 30 * DAY);
  await patch(created.subscription.id, {
    status: "active",
    currentPeriodStart: T,
    currentPeriodEnd: termEnd,
  });
  const far = await tick(biz.id, new Date(termEnd.getTime() - 13 * DAY));
  ok("ACH pre-debit: silent 13 days out", far.preDebit === 0);
  const due = await tick(biz.id, new Date(termEnd.getTime() - 11 * DAY));
  ok("ACH pre-debit: sent 11 days out (10 days is the minimum)", due.preDebit === 1);
  const rows = await emitted("subscription_pre_debit_notification", created.subscription.publicId);
  const d = (rows[0]?.data ?? {}) as Record<string, unknown>;
  ok(
    "ACH pre-debit: names the rail and the payer's authorization, with the amount",
    d.mandate_rail === "ach" &&
      d.mandate_reference === achAuthorizationId &&
      d.expected_amount_minor === 4900,
  );
  const again = await tick(biz.id, new Date(termEnd.getTime() - 2 * DAY));
  ok("ACH pre-debit: one notice per debit", again.preDebit === 0);
}

// ---- Case 5b: no mandate, no obligation ------------------------------------
{
  const biz = await createBusiness({
    organizationId: orgId,
    name: "predebit-none",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "pd2@a.com",
    firstName: "Pat",
    lastName: "Payer",
  });
  const product = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Annual",
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "INR",
    amountMinor: 12_000_000,
    interval: "year",
  });
  // Vaulted, but NO mandate_rail — an ordinary card on file.
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer,
    token: "4242424242424242",
  });
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    now: T,
    items: [{ price, quantity: 1 }],
    defaultPaymentMethodId: pm.id,
  });
  const termEnd = new Date(T.getTime() + 365 * DAY);
  await patch(created.subscription.id, {
    status: "active",
    currentPeriodStart: T,
    currentPeriodEnd: termEnd,
  });
  const inside = await tick(biz.id, new Date(termEnd.getTime() - 1 * DAY));
  ok("pre-debit: a card-on-file with no mandate gets no notice", inside.preDebit === 0);
}

// ===========================================================================
// Per-business lead days (0376), on time-travelled businesses
// ===========================================================================
const app = await buildApp({ logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
let idem = 0;
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "idempotency-key": `rem-${Date.now()}-${++idem}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

/** Run `fn` as business time `t`: the time-travel row and the clock scope agree. */
async function at<R>(bizId: string, t: Date, fn: () => Promise<R>): Promise<R> {
  await systemDb
    .update(timeTravels)
    .set({ simulatedNow: t })
    .where(eq(timeTravels.businessId, bizId));
  return runWithClockScope({ onlyBusinessId: bizId, now: t }, fn);
}
const tickAt = (bizId: string, t: Date) => at(bizId, t, () => runRemindersPass(t));

/** A time-travelled business (genesis T) with one monthly subscription created at T. */
async function travelSub(name: string) {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await startTimeTravel({ orgId, bizId: biz.id, genesisTime: T });
  const sub = await at(biz.id, T, async () => {
    const customer = await createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email: `${name}@example.com`,
      firstName: "Pat",
      lastName: "Payer",
    });
    const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Pro" });
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
    const created = await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: customer.id,
      now: T,
      items: [{ price, quantity: 1 }],
      autoCollection: "off",
    });
    return created.subscription;
  });
  return { bizId: biz.id, bizPid: biz.publicId, sub };
}

/** PATCH the business's reminder_config as business time `t`. */
const setLeadDays = (b: { bizId: string; bizPid: string }, t: Date, cfg: unknown) =>
  at(b.bizId, t, () => api("PATCH", `/v1/businesses/${b.bizPid}`, { reminder_config: cfg }));

const leads = (rows: Array<{ data: unknown }>) =>
  rows.map((r) => (r.data as Record<string, unknown>).lead_days);

// ---- Case 6: two renewal lead days, every term ----------------------------
{
  const b = await travelSub("two-leads");
  const end1 = new Date(T.getTime() + 30 * DAY);
  await patch(b.sub.id, { status: "active", currentPeriodStart: T, currentPeriodEnd: end1 });

  const res = await setLeadDays(b, T, { renewal: [3, 15] });
  ok("two leads: PATCH accepts [3, 15]", res.status === 200);
  ok(
    "two leads: the business returns every kind, resolved and largest first",
    JSON.stringify(res.body.reminder_config) ===
      JSON.stringify({
        trial_ending: [3],
        renewal: [15, 3],
        renewal_yearly: [30],
        cancellation: [5],
        card_expiring: "expiry_month",
        payment_due: [],
        pause: [],
        resume: [],
      }),
  );

  ok(
    "two leads: silent 20 days out",
    (await tickAt(b.bizId, new Date(end1.getTime() - 20 * DAY))).renewal === 0,
  );
  ok(
    "two leads: fires at 15 days",
    (await tickAt(b.bizId, new Date(end1.getTime() - 14 * DAY))).renewal === 1,
  );
  ok(
    "two leads: not again at 10 days",
    (await tickAt(b.bizId, new Date(end1.getTime() - 10 * DAY))).renewal === 0,
  );
  ok(
    "two leads: fires again at 3 days",
    (await tickAt(b.bizId, new Date(end1.getTime() - 2.5 * DAY))).renewal === 1,
  );
  ok(
    "two leads: not again at 1 day",
    (await tickAt(b.bizId, new Date(end1.getTime() - 1 * DAY))).renewal === 0,
  );
  const rows = await emitted("subscription_renewal_reminder", b.sub.publicId);
  ok(
    "two leads: two events for one term, lead_days 15 then 3, same renewal_at",
    JSON.stringify(leads(rows)) === "[15,3]" &&
      rows.every((r) => occurrence(r, "renewal_at") === end1.toISOString()),
  );

  const end2 = new Date(end1.getTime() + 30 * DAY);
  await patch(b.sub.id, { currentPeriodStart: end1, currentPeriodEnd: end2 });
  ok(
    "two leads: term 2 at 15 days",
    (await tickAt(b.bizId, new Date(end2.getTime() - 14 * DAY))).renewal === 1,
  );
  ok(
    "two leads: term 2 at 3 days",
    (await tickAt(b.bizId, new Date(end2.getTime() - 2 * DAY))).renewal === 1,
  );
  ok(
    "two leads: four events over two terms",
    (await emitted("subscription_renewal_reminder", b.sub.publicId)).length === 4,
  );

  const sched = await api("GET", `/v1/businesses/${b.bizPid}/emails/reminders`);
  const row = (sched.body.data as Array<Record<string, unknown>>).find(
    (r) => r.type === "renewal_reminder",
  );
  const pd = (sched.body.data as Array<Record<string, unknown>>).find(
    (r) => r.type === "pre_debit_notification",
  );
  ok(
    "two leads: the email schedule reports this business's lists",
    JSON.stringify(row?.lead_days) === "[15,3]" &&
      row?.days_before === 15 &&
      row?.configurable === true,
  );
  ok(
    "two leads: the pre-debit notice stays fixed",
    pd?.configurable === false && pd?.days_before === 2,
  );
}

// ---- Case 7: a change mid-term does not back-fill -------------------------
{
  const b = await travelSub("no-backfill");
  const end1 = new Date(T.getTime() + 30 * DAY);
  await patch(b.sub.id, { status: "active", currentPeriodStart: T, currentPeriodEnd: end1 });

  const changeAt = new Date(end1.getTime() - 10 * DAY);
  ok(
    "no back-fill: silent 10 days out on the default",
    (await tickAt(b.bizId, changeAt)).renewal === 0,
  );
  await setLeadDays(b, changeAt, { renewal: [15, 3] });
  ok(
    "no back-fill: the 15-day mark that passed before the change is not sent",
    (await tickAt(b.bizId, new Date(changeAt.getTime() + 3600_000))).renewal === 0,
  );
  ok(
    "no back-fill: nothing at the old 5-day mark either",
    (await tickAt(b.bizId, new Date(end1.getTime() - 4 * DAY))).renewal === 0,
  );
  ok(
    "no back-fill: the 3-day mark fires",
    (await tickAt(b.bizId, new Date(end1.getTime() - 2 * DAY))).renewal === 1,
  );

  const end2 = new Date(end1.getTime() + 30 * DAY);
  await patch(b.sub.id, { currentPeriodStart: end1, currentPeriodEnd: end2 });
  ok(
    "no back-fill: the next term gets its 15-day reminder",
    (await tickAt(b.bizId, new Date(end2.getTime() - 14 * DAY))).renewal === 1,
  );
  await setLeadDays(b, new Date(end2.getTime() - 13 * DAY), { renewal: [3, 15] });
  const [stored] = await systemDb
    .select({ cfg: businesses.reminderConfig })
    .from(businesses)
    .where(eq(businesses.id, b.bizId));
  ok(
    "no back-fill: saving the same list again does not move changed_at",
    (stored?.cfg as { changed_at?: { renewal?: string } } | null)?.changed_at?.renewal ===
      changeAt.toISOString(),
  );
}

// ---- Case 8: an event from before 0376 is not re-sent ---------------------
{
  const b = await travelSub("legacy");
  const end1 = new Date(T.getTime() + 30 * DAY);
  await patch(b.sub.id, { status: "active", currentPeriodStart: T, currentPeriodEnd: end1 });
  // The shape the pass wrote before lead days: an occurrence and no `lead_days`.
  await withTenant(orgId, (tx) =>
    emitEvent(tx, {
      organizationId: orgId,
      businessId: b.bizId,
      type: "subscription_renewal_reminder",
      data: buildEventData(
        "subscription_renewal_reminder",
        { id: b.sub.publicId, current_period_end: end1 },
        null,
        { renewal_at: end1.toISOString() },
      ),
    }),
  );
  ok(
    "legacy: the default 5-day reminder already sent is not sent again",
    (await tickAt(b.bizId, new Date(end1.getTime() - 4 * DAY))).renewal === 0,
  );
  await setLeadDays(b, new Date(end1.getTime() - 4 * DAY), { renewal: [5, 1] });
  ok(
    "legacy: a closer lead day added later still fires",
    (await tickAt(b.bizId, new Date(end1.getTime() - 0.5 * DAY))).renewal === 1,
  );
}

// ---- Case 9: two cancellation lead days -----------------------------------
{
  const b = await travelSub("cancel-two-leads");
  await setLeadDays(b, T, { cancellation: [10, 1] });
  const end1 = new Date(T.getTime() + 30 * DAY);
  await at(b.bizId, T, () =>
    patch(b.sub.id, {
      status: "active",
      currentPeriodStart: T,
      currentPeriodEnd: end1,
      cancelAtPeriodEnd: true,
    }),
  );
  ok(
    "cancel leads: fires at 10 days",
    (await tickAt(b.bizId, new Date(end1.getTime() - 9 * DAY))).cancellation === 1,
  );
  ok(
    "cancel leads: not again at 5 days",
    (await tickAt(b.bizId, new Date(end1.getTime() - 5 * DAY))).cancellation === 0,
  );
  ok(
    "cancel leads: fires at 1 day",
    (await tickAt(b.bizId, new Date(end1.getTime() - 0.5 * DAY))).cancellation === 1,
  );
  ok(
    "cancel leads: lead_days 10 then 1",
    JSON.stringify(leads(await emitted("subscription_cancellation_reminder", b.sub.publicId))) ===
      "[10,1]",
  );
}

// ---- Case 10: input limits ------------------------------------------------
{
  const b = await travelSub("limits");
  for (const [label, cfg] of [
    ["0 days", { renewal: [0] }],
    ["91 days", { renewal: [91] }],
    ["six values", { renewal: [1, 2, 3, 4, 5, 6] }],
    ["a repeated value", { trial_ending: [3, 3] }],
    ["an empty list", { cancellation: [] }],
  ] as const) {
    ok(`limits: ${label} is refused`, (await setLeadDays(b, T, cfg)).status === 400);
  }
  const reset = await setLeadDays(b, T, null);
  ok(
    "limits: null resets every kind to the default",
    reset.status === 200 && reset.body.reminder_config?.renewal?.join(",") === "5",
  );
}

await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail ? 1 : 0);
