/**
 * The reminder settings of 2.24–2.26 and the email link target of 2.28:
 *
 *  - payment due (`reminder_config.payment_due`): before the due date of an invoice that is
 *    not collected automatically, once per lead day;
 *  - scheduled pause / resume (`pause`, `resume`);
 *  - card expiry lead days (`card_expiring`), with `payment_source_expiring` still once;
 *  - each path: not before the lead day, not twice, Off sends nothing, the per-type email
 *    switch stops the email but not the event;
 *  - `email_config.linkTarget`: the button goes to the merchant URL, no portal session.
 *
 * Each case has its own business, and every pass runs in `runWithClockScope`, so the counts
 * are the case's own.
 *
 *   pnpm verify:settings-reminders
 */
import "@/modules/emails/outbox"; // registers the email sink
import { and, eq } from "drizzle-orm";
import { withTenant, closeDb, systemDb } from "@/platform/db";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { scheduleChange } from "@/modules/subscriptions/scheduled-changes";
import { runRemindersPass } from "@/modules/subscriptions/reminders";
import { paymentSourceSweep } from "@/modules/payment-methods/sweep";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { runWithClockScope } from "@/platform/clock";
import { publicId } from "@/platform/ids";
import {
  businesses,
  emailMessages,
  events,
  invoiceLineItems,
  invoices,
  paymentMethods,
  subscriptions,
} from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log("✓", label);
  } else {
    fail++;
    console.log("✗", label, detail === undefined ? "" : JSON.stringify(detail));
  }
}

const DAY = 24 * 3600_000;
const T = new Date("2027-03-01T10:00:00.000Z");
const plus = (days: number) => new Date(T.getTime() + days * DAY);
const MERCHANT_URL = "https://billing.example.com/account?from=email";

const org = await createOrganization({ name: "Reminder settings" });
const orgId = org.organization.id;

/** A business with the given stored reminder_config and email_config. */
async function setupBiz(
  name: string,
  reminderConfig: Record<string, unknown> | null,
  emailConfig: Record<string, unknown> = { enabled: true },
) {
  const biz = await createBusiness({
    organizationId: orgId,
    name,
    defaultCurrency: "USD",
    livemode: "test",
  });
  await systemDb
    .update(businesses)
    .set({ reminderConfig, emailConfig })
    .where(eq(businesses.id, biz.id));
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
  return { biz, customer, price };
}

type Setup = Awaited<ReturnType<typeof setupBiz>>;

async function subscribe(s: Setup, opts: { autoCollection?: "on" | "off"; pm?: string } = {}) {
  const created = await createSubscription({
    organizationId: orgId,
    businessId: s.biz.id,
    customerId: s.customer.id,
    now: T,
    items: [{ price: s.price, quantity: 1 }],
    autoCollection: opts.autoCollection ?? "off",
    ...(opts.pm ? { defaultPaymentMethodId: opts.pm } : {}),
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(subscriptions)
      .set({ status: "active", currentPeriodStart: T, currentPeriodEnd: plus(90) })
      .where(eq(subscriptions.id, created.subscription.id)),
  );
  return created.subscription;
}

/** An open invoice of the subscription, with money due on `due` (one line, consistent). */
async function openInvoice(sub: { id: string; customerId: string; businessId: string }, due: Date) {
  return withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        publicId: publicId("inv"),
        organizationId: orgId,
        businessId: sub.businessId,
        customerId: sub.customerId,
        subscriptionId: sub.id,
        status: "posted",
        currency: "USD",
        subtotalMinor: 5000n,
        totalMinor: 5000n,
        amountDueMinor: 5000n,
        dueDate: due,
      })
      .returning();
    await tx.insert(invoiceLineItems).values({
      publicId: publicId("il"),
      organizationId: orgId,
      businessId: sub.businessId,
      invoiceId: inv!.id,
      description: "Pro",
      kind: "recurring",
      quantity: 1,
      unitAmountMinor: 5000n,
      amountMinor: 5000n,
    });
    return inv!;
  });
}

const remind = (bizId: string, now: Date) =>
  runWithClockScope({ onlyBusinessId: bizId }, () => runRemindersPass(now));
const sweep = (bizId: string, now: Date) =>
  runWithClockScope({ onlyBusinessId: bizId }, () => paymentSourceSweep(now));

async function eventsOf(type: string, resourceId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ data: events.data })
      .from(events)
      .where(and(eq(events.type, type), eq(events.resourceId, resourceId)))
      .orderBy(events.createdAt),
  );
}
const leads = (rows: Array<{ data: unknown }>) =>
  JSON.stringify(rows.map((r) => (r.data as Record<string, unknown>).lead_days));

async function mails(bizId: string, type: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select({ bodyHtml: emailMessages.bodyHtml, bodyText: emailMessages.bodyText })
      .from(emailMessages)
      .where(and(eq(emailMessages.businessId, bizId), eq(emailMessages.type, type))),
  );
}

// ---- 2.25 Payment due: [10, 3] ---------------------------------------------
{
  const s = await setupBiz("due", { payment_due: [10, 3] });
  const sub = await subscribe(s);
  const inv = await openInvoice(sub, plus(20));

  ok("due: nothing 11 days out", (await remind(s.biz.id, plus(8.5))).paymentDue === 0);
  ok("due: the 10-day reminder", (await remind(s.biz.id, plus(10.5))).paymentDue === 1);
  ok("due: not twice", (await remind(s.biz.id, plus(11))).paymentDue === 0);
  ok("due: the 3-day reminder", (await remind(s.biz.id, plus(17.5))).paymentDue === 1);
  ok("due: not twice at 3 days", (await remind(s.biz.id, plus(18))).paymentDue === 0);
  ok("due: nothing after the due date", (await remind(s.biz.id, plus(21))).paymentDue === 0);
  const ev = await eventsOf("invoice_payment_due_reminder", inv.publicId);
  ok("due: two events, lead_days 10 then 3", leads(ev) === "[10,3]", leads(ev));
  ok(
    "due: the event carries the due date",
    (ev[0]?.data as Record<string, unknown>)?.due_at === plus(20).toISOString(),
  );
  const m = await mails(s.biz.id, "payment_due_reminder");
  ok("due: two emails", m.length === 2, m.length);
  ok("due: the email states the amount", m[0]?.bodyText.includes("$50.00") ?? false);
  ok(
    "due: the button is a signed-in portal link (default target)",
    m[0]?.bodyHtml.includes("/portal/s/") ?? false,
  );
}

// An auto-collected invoice charges itself: no "pay before" reminder.
{
  const s = await setupBiz("due-auto", { payment_due: [3] });
  const sub = await subscribe(s);
  const inv = await openInvoice(sub, plus(20));
  await withTenant(orgId, (tx) =>
    tx.update(subscriptions).set({ autoCollection: "on" }).where(eq(subscriptions.id, sub.id)),
  );
  ok(
    "due: auto-collected invoice gets none",
    (await remind(s.biz.id, plus(17.5))).paymentDue === 0,
  );
  ok(
    "due: no event for it",
    (await eventsOf("invoice_payment_due_reminder", inv.publicId)).length === 0,
  );
}

// Off (today's default) and the per-type email switch.
{
  const off = await setupBiz("due-off", null);
  const sub = await subscribe(off);
  const inv = await openInvoice(sub, plus(4));
  ok("due: Off sends nothing", (await remind(off.biz.id, plus(1.5))).paymentDue === 0);
  ok(
    "due: Off emits no event",
    (await eventsOf("invoice_payment_due_reminder", inv.publicId)).length === 0,
  );

  const muted = await setupBiz(
    "due-muted",
    { payment_due: [3] },
    { enabled: true, types: { payment_due_reminder: false } },
  );
  const sub2 = await subscribe(muted);
  const inv2 = await openInvoice(sub2, plus(4));
  ok(
    "due: muted type still emits the event",
    (await remind(muted.biz.id, plus(1.5))).paymentDue === 1,
  );
  ok(
    "due: muted type sends no email",
    (await mails(muted.biz.id, "payment_due_reminder")).length === 0,
  );
  ok(
    "due: muted event on record",
    (await eventsOf("invoice_payment_due_reminder", inv2.publicId)).length === 1,
  );
}

// ---- 2.26 Pause and resume: [7] --------------------------------------------
{
  const s = await setupBiz("pause", { pause: [7], resume: [7] });
  const sub = await subscribe(s);
  for (const [type, at] of [
    ["pause", plus(20)],
    ["resume", plus(40)],
  ] as const)
    await scheduleChange({
      organizationId: orgId,
      businessId: s.biz.id,
      subscriptionId: sub.id,
      type,
      effectiveAt: at,
    });
  const r0 = await remind(s.biz.id, plus(12));
  ok("pause: nothing 8 days out", r0.pause === 0 && r0.resume === 0);
  ok("pause: the 7-day reminder", (await remind(s.biz.id, plus(13.5))).pause === 1);
  ok("pause: not twice", (await remind(s.biz.id, plus(14))).pause === 0);
  ok("resume: the 7-day reminder", (await remind(s.biz.id, plus(33.5))).resume === 1);
  ok("resume: not twice", (await remind(s.biz.id, plus(34))).resume === 0);
  const p = await eventsOf("subscription_pause_reminder", sub.publicId);
  const r = await eventsOf("subscription_resume_reminder", sub.publicId);
  ok("pause: one event at lead 7", leads(p) === "[7]", leads(p));
  ok("resume: one event at lead 7", leads(r) === "[7]", leads(r));
  const pm = await mails(s.biz.id, "pause_reminder");
  const rm = await mails(s.biz.id, "resume_reminder");
  ok("pause: one email naming the plan", pm.length === 1 && pm[0]!.bodyText.includes("Pro"));
  ok("resume: one email", rm.length === 1);
}
{
  const s = await setupBiz("pause-off", { resume: [7] });
  const sub = await subscribe(s);
  await scheduleChange({
    organizationId: orgId,
    businessId: s.biz.id,
    subscriptionId: sub.id,
    type: "pause",
    effectiveAt: plus(20),
  });
  ok("pause: Off sends nothing", (await remind(s.biz.id, plus(13.5))).pause === 0);

  const muted = await setupBiz(
    "pause-muted",
    { pause: [7] },
    {
      enabled: true,
      types: { pause_reminder: false },
    },
  );
  const sub2 = await subscribe(muted);
  await scheduleChange({
    organizationId: orgId,
    businessId: muted.biz.id,
    subscriptionId: sub2.id,
    type: "pause",
    effectiveAt: plus(20),
  });
  ok("pause: muted type still emits", (await remind(muted.biz.id, plus(13.5))).pause === 1);
  ok(
    "pause: muted type sends no email",
    (await mails(muted.biz.id, "pause_reminder")).length === 0,
  );
}

// ---- 2.24 Card expiry ------------------------------------------------------
/** A card that expires at the end of April 2027 (stops working 2027-05-01). */
async function cardFor(s: Setup) {
  const pm = await vaultPaymentMethod({
    organizationId: orgId,
    businessId: s.biz.id,
    customer: s.customer,
    token: "4242424242424242",
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(paymentMethods)
      .set({ expMonth: 4, expYear: 2027, status: "valid" })
      .where(eq(paymentMethods.id, pm.id)),
  );
  await subscribe(s, { autoCollection: "on", pm: pm.id });
  return pm;
}
const EXPIRES = new Date("2027-05-01T00:00:00.000Z");
const before = (days: number) => new Date(EXPIRES.getTime() - days * DAY);

{
  // 35 days: the first reminder lands in March, before the expiry month starts.
  const s = await setupBiz("card-lead", { card_expiring: [35, 7] });
  const pm = await cardFor(s);
  ok("card: nothing 40 days out", (await sweep(s.biz.id, before(40))).reminded === 0);
  ok("card: the 35-day reminder", (await sweep(s.biz.id, before(34.5))).reminded === 1);
  ok("card: not twice", (await sweep(s.biz.id, before(34))).reminded === 0);
  // Enters the expiry month: the status change still fires once, without its email.
  const month = await sweep(s.biz.id, new Date("2027-04-02T10:00:00.000Z"));
  ok("card: the expiry-month transition still happens", month.expiring === 1);
  ok("card: the 7-day reminder", (await sweep(s.biz.id, before(6.5))).reminded === 1);
  ok("card: not twice at 7 days", (await sweep(s.biz.id, before(6))).reminded === 0);
  const rem = await eventsOf("payment_source_expiry_reminder", pm.publicId);
  ok("card: two reminder events, 35 then 7", leads(rem) === "[35,7]", leads(rem));
  const exp = await eventsOf("payment_source_expiring", pm.publicId);
  ok("card: payment_source_expiring fired once", exp.length === 1, exp.length);
  ok(
    "card: that event carries suppress_email",
    (exp[0]?.data as Record<string, unknown>)?.suppress_email === true,
  );
  const m = await mails(s.biz.id, "card_expiring");
  ok("card: two card_expiring emails, one per lead day", m.length === 2, m.length);
}
{
  const s = await setupBiz("card-month", null);
  const pm = await cardFor(s);
  ok("card (default): no lead reminder", (await sweep(s.biz.id, before(40))).reminded === 0);
  const month = await sweep(s.biz.id, new Date("2027-04-02T10:00:00.000Z"));
  ok("card (default): transition in the expiry month", month.expiring === 1);
  ok("card (default): its email goes out", (await mails(s.biz.id, "card_expiring")).length === 1);
  ok(
    "card (default): no reminder events",
    (await eventsOf("payment_source_expiry_reminder", pm.publicId)).length === 0,
  );

  const muted = await setupBiz(
    "card-muted",
    { card_expiring: [7] },
    {
      enabled: true,
      types: { card_expiring: false },
    },
  );
  await cardFor(muted);
  ok("card: muted type still emits", (await sweep(muted.biz.id, before(6.5))).reminded === 1);
  ok("card: muted type sends no email", (await mails(muted.biz.id, "card_expiring")).length === 0);
}

// ---- 2.28 Link target ------------------------------------------------------
{
  const s = await setupBiz(
    "links",
    { payment_due: [3] },
    {
      enabled: true,
      linkTarget: "merchant_url",
      merchantUrl: MERCHANT_URL,
    },
  );
  const sub = await subscribe(s);
  await openInvoice(sub, plus(4));
  await remind(s.biz.id, plus(1.5));
  const [m] = await mails(s.biz.id, "payment_due_reminder");
  ok("links: the button goes to the merchant URL", !!m && m.bodyHtml.includes(MERCHANT_URL));
  ok("links: no portal session in the email", !!m && !m.bodyHtml.includes("/portal/s/"));
}

// ---- API: shapes, limits and defaults --------------------------------------
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
      "idempotency-key": `srem-${Date.now()}-${++idem}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
{
  // A key-created business keeps today's behaviour.
  const created = await api("POST", "/v1/businesses", {
    default_currency: "USD",
    name: "Key made",
    livemode: "test",
  });
  const pid = created.body.id as string;
  const rc = created.body.reminder_config ?? {};
  ok(
    "api: a key-created business keeps today's defaults",
    created.status === 201 &&
      rc.card_expiring === "expiry_month" &&
      JSON.stringify([rc.payment_due, rc.pause, rc.resume]) === "[[],[],[]]",
    rc,
  );
  for (const [label, cfg] of [
    ["4 payment-due values", { payment_due: [1, 2, 3, 4] }],
    ["an empty card list", { card_expiring: [] }],
    ["a card word other than expiry_month", { card_expiring: "soon" }],
    ["91 days before a pause", { pause: [91] }],
  ] as const)
    ok(
      `api: ${label} is refused`,
      (await api("PATCH", `/v1/businesses/${pid}`, { reminder_config: cfg })).status === 400,
    );
  const set = await api("PATCH", `/v1/businesses/${pid}`, {
    reminder_config: { payment_due: [3, 10], card_expiring: [7, 30], pause: [] },
  });
  ok(
    "api: lists are stored sorted, [] stays Off",
    set.status === 200 &&
      JSON.stringify(set.body.reminder_config?.payment_due) === "[10,3]" &&
      JSON.stringify(set.body.reminder_config?.card_expiring) === "[30,7]" &&
      JSON.stringify(set.body.reminder_config?.pause) === "[]",
    set.body.reminder_config,
  );
  const sched = await api("GET", `/v1/businesses/${pid}/emails/reminders`);
  const row = (t: string) =>
    (sched.body.data as Array<Record<string, any>>).find((r) => r.type === t);
  ok(
    "api: the reminder schedule lists the new kinds",
    row("payment_due_reminder")?.days_before === 10 &&
      row("pause_reminder")?.days_before === null &&
      row("card_expiring")?.expiry_month === false,
  );

  const bad = await api("PATCH", `/v1/businesses/${pid}`, {
    email_config: { enabled: true, linkTarget: "merchant_url" },
  });
  ok("api: merchant_url without a URL is refused", bad.status === 400);
  const ftp = await api("PATCH", `/v1/businesses/${pid}`, {
    email_config: { enabled: true, linkTarget: "merchant_url", merchantUrl: "ftp://example.com" },
  });
  ok("api: a non-http URL is refused", ftp.status === 400);
  const good = await api("PATCH", `/v1/businesses/${pid}`, {
    email_config: { enabled: true, linkTarget: "merchant_url", merchantUrl: MERCHANT_URL },
  });
  ok(
    "api: an http(s) merchant URL is kept",
    good.status === 200 && good.body.email_config?.merchantUrl === MERCHANT_URL,
  );
}

await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
await closeDb();
process.exit(fail ? 1 : 0);
