/**
 * Operator notifications (0533): the pipeline end to end on a throwaway database. Sink → queue →
 * fan-out → bell rows and deliveries → drain, with the push, chat and email transports replaced.
 *
 *   pnpm verify:notifications
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  businesses,
  disputes,
  events,
  invoiceLineItems,
  invoices,
  memberships,
  notificationDeliveries,
  notificationDestinations,
  notificationQueue,
  notifications,
  pushSubscriptions,
  roles,
  transactions,
  users,
} from "@db/schema";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { encryptSecret } from "@/platform/secrets";
import { emitEvent } from "@/modules/events/emit";
import type { EventType } from "@/modules/events/registry";
import type { EventSource } from "@/platform/event-context";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { addPromotionalCredits } from "@/modules/customers/balances";
import "@/modules/notifications/sink";
import { NOTIFICATION_KINDS, type NotificationKind } from "@/modules/notifications/catalogue";
import {
  savePreferences,
  savePushSubscription,
  saveSettings,
  type NotificationMember,
} from "@/modules/notifications/service";
import { fanOutPending } from "@/modules/notifications/fanout";
import { closeDueGroups } from "@/modules/notifications/groups";
import { deliverPendingNotifications } from "@/modules/notifications/deliver";
import { setNotificationTransports, type MailBody } from "@/modules/notifications/channels";
import { runNotificationClocks } from "@/modules/notifications/clocks";
import { ensureDigest, runDigestSender, type DigestParts } from "@/modules/notifications/digest";
import { sendTestPush } from "@/modules/notifications/test-send";
import { rowsOf } from "@/modules/metering/usage-sql";

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

// ── transports ──
const pushed: Array<{ endpoint: string; body: { title: string; body: string; tag?: string } }> = [];
const chats: Array<{ url: string; body: unknown }> = [];
const mails: MailBody[] = [];
let chatStatus = 200;
setNotificationTransports({
  async push(target, payload) {
    if (target.endpoint.includes("/gone/"))
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    pushed.push({ endpoint: target.endpoint, body: JSON.parse(payload) });
    return { statusCode: 201 };
  },
  async chat(url, body) {
    chats.push({ url, body });
    return { status: chatStatus, text: chatStatus >= 300 ? "server error" : "" };
  },
  async email(mail) {
    mails.push(mail);
  },
});

const RUN = randomUUID().slice(0, 8);
const ALL_INSTANT = Object.fromEntries(
  NOTIFICATION_KINDS.map((k) => [k, { timing: "instant", push: true, email: true }]),
);

async function mkOrg(name: string, extraLive = false) {
  const org = await createOrganization({ name: `${name} ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: `${name} Live`,
    defaultCurrency: "USD",
    livemode: "live",
  });
  const biz2 = extraLive
    ? await createBusiness({
        organizationId: orgId,
        name: `${name} Second`,
        defaultCurrency: "USD",
        livemode: "live",
      })
    : null;
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `buyer-${RUN}-${name.replace(/\W/g, "")}@example.com`,
    firstName: "Asha",
    lastName: "Rao",
  });
  return { orgId, biz, biz2, customer };
}

let seq = 0;
async function mkMember(
  orgId: string,
  role: string,
  customPermissions?: string[],
): Promise<NotificationMember & { email: string }> {
  const email = `member-${RUN}-${++seq}@example.com`;
  const [u] = await systemDb
    .insert(users)
    .values({ publicId: publicId("usr"), email, name: `Member ${seq}` })
    .returning();
  let customRole: NotificationMember["customRole"] = null;
  if (customPermissions) {
    const [r] = await systemDb
      .insert(roles)
      .values({
        organizationId: orgId,
        publicId: publicId("role"),
        name: `Viewer ${seq}`,
        nameKey: `viewer ${seq}`,
        permissions: customPermissions,
      })
      .returning();
    customRole = { id: r!.id, version: r!.version, permissions: r!.permissions };
  }
  await systemDb
    .insert(memberships)
    .values({ organizationId: orgId, userId: u!.id, role, customRoleId: customRole?.id ?? null });
  return { userId: u!.id, role, customRole, email };
}

async function addDevice(userId: string, path = "ok") {
  return savePushSubscription(userId, {
    endpoint: `https://push.example.com/${path}/${RUN}-${++seq}`,
    keys: { p256dh: "BPub", auth: "Auth" },
  });
}

async function txn(
  orgId: string,
  businessId: string,
  amountMinor: number,
  extra: Partial<typeof transactions.$inferInsert> = {},
) {
  const [t] = await systemDb
    .insert(transactions)
    .values({
      organizationId: orgId,
      businessId,
      publicId: publicId("txn"),
      type: "payment",
      status: "failed",
      amountMinor: BigInt(amountMinor),
      currency: "USD",
      occurredAt: new Date(),
      ...extra,
    })
    .returning();
  return t!;
}

async function emit(
  orgId: string,
  businessId: string,
  type: string,
  resource: { type: string; id: string },
  opts: { source?: EventSource; data?: Record<string, unknown> } = {},
) {
  return withTenant(orgId, (tx) =>
    emitEvent(tx, {
      organizationId: orgId,
      businessId,
      type: type as EventType,
      data: opts.data ?? { [resource.type]: { id: resource.id } },
      resource,
      ...(opts.source ? { source: opts.source } : {}),
    }),
  );
}

const fanout = () => fanOutPending(new Date(Date.now() + 1000));
const bell = (orgId: string, userId: string) =>
  withTenant(orgId, (tx) =>
    tx.select().from(notifications).where(eq(notifications.userId, userId)),
  );
const deliveriesOf = (orgId: string, where: ReturnType<typeof eq>) =>
  withTenant(orgId, (tx) => tx.select().from(notificationDeliveries).where(where));

// ── 1. Every event-sourced kind fans out for a member who set it Instant ──
const A = await mkOrg("Kinds");
const owner = await mkMember(A.orgId, "owner");
await savePreferences(A.orgId, owner, { default: ALL_INSTANT });
const ownerDevice = await addDevice(owner.userId);
{
  const cus = { type: "customer", id: A.customer.publicId };
  const plain: Array<[NotificationKind, string]> = [
    ["payment_failed", "payment_failed"],
    ["payment_received", "payment_succeeded"],
    ["refund_failed", "refund_failed"],
    ["payment_needs_attention", "transaction_needs_attention"],
    ["late_payment_failure", "transaction_late_failure"],
    ["dispute_opened", "dispute_created"],
    ["dispute_closed", "dispute_won"],
    ["retries_exhausted", "invoice_dunning_exhausted"],
    ["subscription_created", "subscription_created"],
    ["subscription_cancelled", "subscription_canceled"],
    ["cancellation_scheduled", "subscription_cancel_scheduled"],
    ["subscription_reactivated", "subscription_reactivated"],
    ["trial_ending", "subscription_trial_ending"],
    ["spend_limit_reached", "spend_limit_reached"],
    ["usage_alert", "usage_alert_triggered"],
    ["auto_topup_failed", "credit_auto_topup_failed"],
  ];
  for (const [, type] of plain) await emit(A.orgId, A.biz.id, type, cus);
  // Derived: a fraud decline and a change in the customer portal.
  const fraud = await txn(A.orgId, A.biz.id, 5_000, {
    errorCode: "fraudulent",
    customerId: A.customer.id,
  });
  await emit(A.orgId, A.biz.id, "payment_failed", { type: "payment", id: fraud.publicId });
  await emit(A.orgId, A.biz.id, "subscription_canceled", cus, { source: "portal" });
  const r = await fanout();
  ok("the fan-out settles every queued event", r.failed === 0 && r.retried === 0, r);

  const rows = await bell(A.orgId, owner.userId);
  const count = (k: string) => rows.filter((n) => n.kind === k).length;
  for (const [kind] of plain) {
    const expected = kind === "payment_failed" || kind === "subscription_cancelled" ? 1 : 1;
    ok(
      `${kind}: one bell row`,
      count(kind) === expected,
      rows.map((n) => n.kind),
    );
  }
  ok(
    "a fraud decline gives possible_fraud, not also payment_failed",
    count("possible_fraud") === 1 && count("payment_failed") === 1,
  );
  ok(
    "a portal cancellation gives customer_portal_change, not also subscription_cancelled",
    count("customer_portal_change") === 1 && count("subscription_cancelled") === 1,
  );
  const ds = await deliveriesOf(A.orgId, eq(notificationDeliveries.userId, owner.userId));
  const kindsWithPush = new Set(ds.filter((d) => d.channel === "push").map((d) => d.kind));
  const kindsWithEmail = new Set(ds.filter((d) => d.channel === "email").map((d) => d.kind));
  ok(
    "each Instant kind has a push and an email delivery",
    rows.every((n) => kindsWithPush.has(n.kind) && kindsWithEmail.has(n.kind)),
    { rows: rows.length, push: kindsWithPush.size, email: kindsWithEmail.size },
  );
  const failed = rows.find((n) => n.kind === "possible_fraud");
  ok(
    "the bell row reads its facts",
    /\$50/.test(failed?.title ?? "") && /Asha Rao/.test(failed?.body ?? ""),
    failed,
  );
}

// ── auto top-up: failed, then hard_declined, for one run → one queue row ──
{
  const run = `atr_${RUN}`;
  const data = {
    credit_auto_topup: {
      id: `atu_${RUN}`,
      run,
      customer: A.customer.publicId,
      amount_minor: 2_500,
      currency: "USD",
    },
  };
  await withTenant(A.orgId, async (tx) => {
    for (const type of ["credit_auto_topup_failed", "credit_auto_topup_hard_declined"])
      await emitEvent(tx, {
        organizationId: A.orgId,
        businessId: A.biz.id,
        type: type as EventType,
        data,
        resource: { type: "credit_auto_topup", id: `atu_${RUN}` },
      });
  });
  const q = await systemDb
    .select()
    .from(notificationQueue)
    .where(eq(notificationQueue.dedupeKey, `auto_topup:${run}`));
  ok("one automatic top-up run makes one queue row", q.length === 1, q.length);
  await fanout();
}

// ── large free credit grant: a direct notification from credits ──
{
  await systemDb
    .update(businesses)
    .set({ creditConfig: { grant_limits: { USD: { alert_above_minor: 5_000 } } } })
    .where(eq(businesses.id, A.biz.id));
  await addPromotionalCredits({
    organizationId: A.orgId,
    businessId: A.biz.id,
    customer: A.customer,
    amountMinor: 7_000,
    currency: "USD",
  });
  await fanout();
  const rows = (await bell(A.orgId, owner.userId)).filter((n) => n.kind === "large_credit_grant");
  ok(
    "a grant above the alert limit notifies the owner",
    rows.length === 1 && /\$70/.test(rows[0]!.title),
    rows.map((r) => r.title),
  );
}

// ── rollback: the emitting transaction fails → nothing queued ──
{
  let eventId: string | null = null;
  try {
    await withTenant(A.orgId, async (tx) => {
      const ev = await emitEvent(tx, {
        organizationId: A.orgId,
        businessId: A.biz.id,
        type: "payment_failed",
        data: {},
        resource: { type: "customer", id: A.customer.publicId },
      });
      eventId = ev.id;
      throw new Error("roll back");
    });
  } catch {
    /* expected */
  }
  const q = eventId
    ? await systemDb.select().from(notificationQueue).where(eq(notificationQueue.eventId, eventId))
    : [];
  ok("a rolled-back event queues nothing", eventId !== null && q.length === 0, q.length);
}

// ── 2–5. Role, amount limit, exception over default, business filter ──
const B = await mkOrg("Rules", true);
{
  const viewer = await mkMember(B.orgId, "custom", ["customers:view"]);
  const limited = await mkMember(B.orgId, "admin");
  const excepted = await mkMember(B.orgId, "admin");
  const filtered = await mkMember(B.orgId, "admin");
  await savePreferences(B.orgId, viewer, { default: ALL_INSTANT });
  await savePreferences(B.orgId, limited, {
    default: {
      ...ALL_INSTANT,
      payment_failed: { timing: "instant", push: true, email: false, above: { USD: 10_000 } },
    },
  });
  await savePreferences(B.orgId, excepted, {
    default: { ...ALL_INSTANT, payment_failed: { timing: "off", push: true, email: false } },
    exceptions: [
      {
        business: B.biz2!.publicId,
        kinds: { payment_failed: { timing: "instant", push: true, email: false } },
      },
    ],
  });
  await savePreferences(B.orgId, filtered, {
    default: ALL_INSTANT,
    business_filter: { mode: "selected", business_ids: [B.biz.publicId] },
  });
  const small = await txn(B.orgId, B.biz.id, 5_000);
  await emit(B.orgId, B.biz.id, "payment_failed", { type: "payment", id: small.publicId });
  await fanout();
  const big = await txn(B.orgId, B.biz2!.id, 20_000);
  await emit(B.orgId, B.biz2!.id, "payment_failed", { type: "payment", id: big.publicId });
  await fanout();
  const pf = async (m: { userId: string }) =>
    (await bell(B.orgId, m.userId)).filter((n) => n.kind === "payment_failed");
  ok("a role without payments:view gets no payment notification", (await pf(viewer)).length === 0);
  const lim = await pf(limited);
  ok(
    "below the amount limit: nothing; above it: a bell row",
    lim.length === 1 && lim[0]!.businessId === B.biz2!.id,
    lim.map((n) => n.amountMinor),
  );
  const ex = await pf(excepted);
  ok(
    "a business exception beats the default",
    ex.length === 1 && ex[0]!.businessId === B.biz2!.id,
    ex.map((n) => n.businessId),
  );
  const fl = await pf(filtered);
  ok(
    "the business filter keeps only the selected business",
    fl.length === 1 && fl[0]!.businessId === B.biz.id,
    fl.map((n) => n.businessId),
  );
  ok(
    "a member following several businesses sees the business name",
    /Rules Second/.test(ex[0]?.body ?? ""),
    ex[0]?.body,
  );
  ok("…a member following one does not", !/Rules Live/.test(fl[0]?.body ?? ""), fl[0]?.body);
}

// ── 6. A test business: bell only, marked test ──
{
  const testBiz = await createBusiness({
    organizationId: B.orgId,
    name: "Rules Test",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const m = await mkMember(B.orgId, "owner");
  await savePreferences(B.orgId, m, { default: ALL_INSTANT });
  await addDevice(m.userId);
  const t = await txn(B.orgId, testBiz.id, 9_000);
  await emit(B.orgId, testBiz.id, "payment_failed", { type: "payment", id: t.publicId });
  await fanout();
  const rows = (await bell(B.orgId, m.userId)).filter((n) => n.businessId === testBiz.id);
  const ds = await deliverieswhere(B.orgId, m.userId, testBiz.id);
  ok(
    "a test business makes a bell row with test = true",
    rows.length === 1 && rows[0]!.test === true,
    rows,
  );
  ok("…and no delivery", ds.length === 0, ds.length);
}
async function deliverieswhere(orgId: string, userId: string, businessId: string) {
  return withTenant(orgId, (tx) =>
    tx
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.userId, userId),
          eq(notificationDeliveries.businessId, businessId),
        ),
      ),
  );
}

// ── 7. Grouping: 12 failures in a burst → 1 send, then one list of the 11 more per channel ──
const G = await mkOrg("Burst");
{
  const m = await mkMember(G.orgId, "owner");
  await savePreferences(G.orgId, m, {
    default: { ...ALL_INSTANT, payment_failed: { timing: "instant", push: true, email: true } },
  });
  await addDevice(m.userId);
  for (let i = 0; i < 12; i++) {
    const t = await txn(G.orgId, G.biz.id, 1_000 + i);
    await emit(G.orgId, G.biz.id, "payment_failed", { type: "payment", id: t.publicId });
  }
  await fanout();
  const rows = (await bell(G.orgId, m.userId)).filter((n) => n.kind === "payment_failed");
  ok(
    "12 failures make one bell row counting 12",
    rows.length === 1 && rows[0]!.groupCount === 12,
    rows.map((r) => r.groupCount),
  );
  ok("…titled for the group", rows[0]?.title === "12 payments failed", rows[0]?.title);
  let ds = await deliveriesOf(G.orgId, eq(notificationDeliveries.userId, m.userId));
  ok(
    "…and one push and one email",
    ds.length === 2,
    ds.map((d) => d.channel),
  );
  const closed = await closeDueGroups(new Date(Date.now() + 6 * 60_000));
  ds = await deliveriesOf(G.orgId, eq(notificationDeliveries.userId, m.userId));
  const more = ds.filter((d) => (d.payload as { more?: boolean }).more);
  const push = more.find((d) => d.channel === "push");
  const mail = more.find((d) => d.channel === "email")?.payload as
    | { mail?: { subject: string; text: string } }
    | undefined;
  ok(
    "closing the window adds one list per channel",
    closed.closed >= 1 && more.length === 2,
    more.map((d) => d.channel),
  );
  // Amounts 10.00 … 10.11: the 11 after the first add to 110.66.
  ok(
    "…the list counts and totals only the 11 more",
    mail?.mail?.subject === "11 more payments failed · $110.66",
    mail?.mail?.subject,
  );
  ok(
    "…lists five rows, then the rest, with no count, total or first rows",
    (mail?.mail?.text.match(/^- /gm) ?? []).length === 5 &&
      /\$10\.01/.test(mail?.mail?.text ?? "") &&
      /^and 6 more$/m.test(mail?.mail?.text ?? "") &&
      !/^(Count|Total|First):/m.test(mail?.mail?.text ?? ""),
    mail?.mail?.text,
  );
  ok(
    "…the push shows two rows and keeps the first one's tag",
    (push?.payload as { push?: { title: string; body: string } })?.push?.title ===
      "11 more payments failed · $110.66" &&
      /\nand 9 more$/.test((push?.payload as { push?: { body: string } })?.push?.body ?? "") &&
      (push?.payload as { push?: { tag: string } })?.push?.tag ===
        (
          ds.find((d) => d.channel === "push" && !(d.payload as { more?: boolean }).more)
            ?.payload as { push?: { tag: string } }
        )?.push?.tag,
    push?.payload,
  );
}

// ── 7b. A burst of two: the second goes out as a normal notification ──
const G2 = await mkOrg("Pair");
{
  const m = await mkMember(G2.orgId, "owner");
  await savePreferences(G2.orgId, m, { default: ALL_INSTANT });
  await addDevice(m.userId);
  for (const amt of [2_000, 3_500]) {
    const t = await txn(G2.orgId, G2.biz.id, amt);
    await emit(G2.orgId, G2.biz.id, "payment_failed", { type: "payment", id: t.publicId });
  }
  await fanout();
  const rows = (await bell(G2.orgId, m.userId)).filter((n) => n.kind === "payment_failed");
  ok("two failures: the bell row counts 2", rows[0]?.title === "2 payments failed", rows[0]?.title);
  await closeDueGroups(new Date(Date.now() + 6 * 60_000));
  const ds = await deliveriesOf(G2.orgId, eq(notificationDeliveries.userId, m.userId));
  const more = ds.filter((d) => (d.payload as { more?: boolean }).more);
  const first = ds.find((d) => d.channel === "push" && !(d.payload as { more?: boolean }).more);
  const push = more.find((d) => d.channel === "push")?.payload as
    | { push?: { title: string; tag: string } }
    | undefined;
  const mail = more.find((d) => d.channel === "email")?.payload as
    | { mail?: { subject: string; text: string } }
    | undefined;
  ok(
    "…closing sends the second as a normal notification, not '1 more'",
    more.length === 2 &&
      push?.push?.title === "Payment failed: $35" &&
      mail?.mail?.subject === "Payment failed: $35" &&
      /^Amount: \$35\.00$/m.test(mail?.mail?.text ?? ""),
    [push?.push?.title, mail?.mail?.subject],
  );
  ok(
    "…with its own push tag, so the first stays on the device",
    !!push?.push?.tag &&
      push.push.tag !== (first?.payload as { push?: { tag: string } })?.push?.tag,
    push?.push?.tag,
  );
}

// ── 7c. Clock: two overdue invoices in one run → one message listing both, nothing later ──
const O = await mkOrg("Overdue");
{
  const m = await mkMember(O.orgId, "owner");
  await savePreferences(O.orgId, m, { default: ALL_INSTANT });
  await addDevice(m.userId);
  const [space] = await systemDb
    .insert(notificationDestinations)
    .values({
      publicId: publicId("ndst"),
      organizationId: O.orgId,
      type: "chat",
      name: "Collections space",
      urlEnc: encryptSecret(`https://chat.googleapis.com/v1/spaces/${RUN}o/messages?key=k&token=t`),
      urlHint: "oken=t",
      status: "active",
      kinds: { invoice_overdue: { on: true } },
    })
    .returning();
  const now = new Date();
  const numbers: string[] = [];
  for (const [i, amt] of [700n, 118_800n].entries()) {
    const number = `OD-${RUN}-${i + 1}`;
    numbers.push(number);
    await withTenant(O.orgId, async (tx) => {
      const [inv] = await tx
        .insert(invoices)
        .values({
          publicId: publicId("inv"),
          organizationId: O.orgId,
          businessId: O.biz.id,
          customerId: O.customer.id,
          number,
          status: "payment_due",
          currency: "USD",
          subtotalMinor: amt,
          totalMinor: amt,
          amountDueMinor: amt,
          dueDate: new Date(now.getTime() - 3 * 3_600_000),
        })
        .returning();
      await tx.insert(invoiceLineItems).values({
        publicId: publicId("il"),
        organizationId: O.orgId,
        businessId: O.biz.id,
        invoiceId: inv!.id,
        description: "Fixture line",
        kind: "recurring",
        quantity: 1,
        unitAmountMinor: amt,
        amountMinor: amt,
      });
    });
  }
  const r1 = await runNotificationClocks(now, { onlyBusinessId: O.biz.id });
  const pending = await systemDb
    .select()
    .from(notificationQueue)
    .where(
      and(eq(notificationQueue.businessId, O.biz.id), eq(notificationQueue.status, "pending")),
    );
  ok(
    "one run's two overdue invoices make one queue row",
    r1.enqueued === 2 &&
      pending.length === 1 &&
      (pending[0]!.payload as { items?: unknown[] }).items?.length === 2,
    [r1, pending.length],
  );
  await fanout();
  const mine = await deliveriesOf(O.orgId, eq(notificationDeliveries.userId, m.userId));
  const chat = await deliveriesOf(O.orgId, eq(notificationDeliveries.destinationId, space!.id));
  const title = "2 invoices overdue · $1,195";
  const lists = (d: { payload: unknown }) => {
    const p = d.payload as {
      push?: { title: string; body: string };
      mail?: { subject: string; text: string };
      chat?: unknown;
    };
    const text = p.push
      ? `${p.push.title}\n${p.push.body}`
      : p.mail
        ? `${p.mail.subject}\n${p.mail.text}`
        : JSON.stringify(p.chat);
    return text.includes(title) && numbers.every((n) => text.includes(n));
  };
  ok(
    "…one push and one email for the member, each listing both",
    mine.length === 2 &&
      mine.some((d) => d.channel === "push") &&
      mine.some((d) => d.channel === "email") &&
      mine.every(lists),
    mine.map((d) => [d.channel, (d.payload as { push?: { title: string } }).push?.title]),
  );
  ok("…one Google Chat message listing both", chat.length === 1 && chat.every(lists), chat.length);
  const rows = (await bell(O.orgId, m.userId)).filter((n) => n.kind === "invoice_overdue");
  ok(
    "…one bell row for the run",
    rows.length === 1 && rows[0]!.title === title && rows[0]!.groupCount === 2,
    rows.map((n) => n.title),
  );
  await closeDueGroups(new Date(Date.now() + 6 * 60_000));
  const r2 = await runNotificationClocks(new Date(now.getTime() + 60_000), {
    onlyBusinessId: O.biz.id,
  });
  await fanout();
  const after = await deliveriesOf(O.orgId, eq(notificationDeliveries.businessId, O.biz.id));
  ok(
    "…and no later message, even when the clock runs again",
    after.length === 3 && r2.enqueued === 0,
    [after.length, r2],
  );
}

// ── 8. Push 410 deletes the device ──
const P = await mkOrg("Gone");
{
  const m = await mkMember(P.orgId, "owner");
  await savePreferences(P.orgId, m, { default: ALL_INSTANT });
  const dev = await addDevice(m.userId, "gone");
  const t = await txn(P.orgId, P.biz.id, 3_000);
  await emit(P.orgId, P.biz.id, "payment_failed", { type: "payment", id: t.publicId });
  await fanout();
  await deliverPendingNotifications(new Date(Date.now() + 1000));
  const left = await systemDb
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.publicId, dev.id));
  const ds = (await deliveriesOf(P.orgId, eq(notificationDeliveries.userId, m.userId))).filter(
    (d) => d.channel === "push",
  );
  ok("a 410 from the push service deletes the device", left.length === 0, left.length);
  ok(
    "…and settles the push as skipped",
    ds.length === 1 && ds[0]!.status === "skipped" && ds[0]!.lastError === "subscription_gone",
    ds.map((d) => [d.status, d.lastError]),
  );
  const ok2 = await sendTestPush({
    organizationId: A.orgId,
    userId: owner.userId,
    subscriptionPublicId: ownerDevice.id,
  });
  ok("a test push reaches a working device", ok2.ok === true, ok2);
}

// ── 9. Google Chat: five failures in a row → not working, owners told once; pending email gets nothing ──
const C = await mkOrg("Chat");
{
  const own = await mkMember(C.orgId, "owner");
  const on = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, { on: true }]));
  const url = `https://chat.googleapis.com/v1/spaces/${RUN}/messages?key=k&token=t`;
  const [chat] = await systemDb
    .insert(notificationDestinations)
    .values({
      publicId: publicId("ndst"),
      organizationId: C.orgId,
      type: "chat",
      name: "Ops space",
      urlEnc: encryptSecret(url),
      urlHint: "oken=t",
      status: "active",
      kinds: on,
    })
    .returning();
  const [pending] = await systemDb
    .insert(notificationDestinations)
    .values({
      publicId: publicId("ndst"),
      organizationId: C.orgId,
      type: "email",
      name: "Finance",
      email: `finance-${RUN}@example.com`,
      status: "pending",
      kinds: on,
    })
    .returning();
  const cus = { type: "customer", id: C.customer.publicId };
  for (const type of [
    "payment_failed",
    "refund_failed",
    "transaction_needs_attention",
    "transaction_late_failure",
    "dispute_created",
  ])
    await emit(C.orgId, C.biz.id, type, cus);
  await fanout();
  const chatDs = await deliveriesOf(C.orgId, eq(notificationDeliveries.destinationId, chat!.id));
  const pendDs = await deliveriesOf(C.orgId, eq(notificationDeliveries.destinationId, pending!.id));
  ok("an active space gets one delivery per event", chatDs.length === 5, chatDs.length);
  ok(
    "an outside address waiting for confirmation gets nothing",
    pendDs.length === 0,
    pendDs.length,
  );
  chatStatus = 500;
  mails.length = 0;
  await deliverPendingNotifications(new Date(Date.now() + 1000));
  chatStatus = 200;
  const [after] = await systemDb
    .select()
    .from(notificationDestinations)
    .where(eq(notificationDestinations.id, chat!.id));
  ok(
    "five failures in a row mark the space not working",
    after?.status === "not_working" && after.failureStreak === 5,
    [after?.status, after?.failureStreak],
  );
  const notices = mails.filter((m) =>
    /We could not send to the Google Chat space Ops space/.test(m.subject),
  );
  ok(
    "…and email the owners and admins once",
    notices.length === 1 && notices[0]!.to === own.email,
    notices.map((m) => m.to),
  );
}

// ── 10. Quiet hours: held, then one push for everything held ──
const Q = await mkOrg("Quiet");
{
  const m = await mkMember(Q.orgId, "owner");
  const instantPush = { timing: "instant", push: true, email: false };
  await savePreferences(Q.orgId, m, {
    default: { ...ALL_INSTANT, payment_failed: instantPush, refund_failed: instantPush },
  });
  const h = new Date().getUTCHours();
  await saveSettings(Q.orgId, m.userId, {
    timezone: "UTC",
    quiet: { enabled: true, from: h, to: (h + 2) % 24, disputes_through: false },
  });
  const dev = await addDevice(m.userId);
  const cus = { type: "customer", id: Q.customer.publicId };
  await emit(Q.orgId, Q.biz.id, "payment_failed", cus);
  await emit(Q.orgId, Q.biz.id, "refund_failed", cus);
  await fanout();
  const held = (await deliveriesOf(Q.orgId, eq(notificationDeliveries.userId, m.userId))).filter(
    (d) => d.channel === "push",
  );
  ok(
    "in quiet hours a push is held",
    held.length === 2 && held.every((d) => d.status === "held"),
    held.map((d) => d.status),
  );
  pushed.length = 0;
  await deliverPendingNotifications(new Date(Date.now() + 3 * 3_600_000));
  const sub = await systemDb
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.publicId, dev.id));
  const mine = pushed.filter((p) => p.endpoint === sub[0]?.endpoint);
  ok(
    "after quiet hours the held pushes go out as one",
    mine.length === 1 &&
      mine[0]!.body.title === "While quiet hours were on" &&
      /1 payment failed/.test(mine[0]!.body.body) &&
      /1 refund failed/.test(mine[0]!.body.body),
    mine.map((p) => p.body),
  );
}

// ── 11. Clock: an evidence reminder enqueues once across runs ──
{
  const now = new Date();
  const [d] = await systemDb
    .insert(disputes)
    .values({
      publicId: publicId("dsp"),
      organizationId: A.orgId,
      businessId: A.biz.id,
      customerId: A.customer.id,
      providerKey: "tmtest",
      providerDisputeId: `dp_${RUN}`,
      amountMinor: 12_000n,
      currency: "USD",
      evidenceDueBy: new Date(now.getTime() + 50 * 3_600_000),
    })
    .returning();
  const keys = () =>
    systemDb
      .select()
      .from(notificationQueue)
      .where(like(notificationQueue.dedupeKey, `clock:dispute_evidence_due:${d!.id}:%`));
  const r1 = await runNotificationClocks(now, { onlyBusinessId: A.biz.id });
  const r2 = await runNotificationClocks(new Date(now.getTime() + 3_600_000), {
    onlyBusinessId: A.biz.id,
  });
  ok(
    "the 72-hour reminder enqueues once across two runs",
    (await keys()).length === 1 && r1.enqueued >= 1 && r2.enqueued === 0,
    [r1, r2],
  );
  await fanout();
  const rows = (await bell(A.orgId, owner.userId)).filter((n) => n.kind === "dispute_evidence_due");
  ok(
    "the reminder reaches the member",
    rows.length === 1 && /^Evidence due in 3 days$/.test(rows[0]!.title),
    rows.map((r) => r.title),
  );
  await runNotificationClocks(new Date(now.getTime() + 30 * 3_600_000), {
    onlyBusinessId: A.biz.id,
  });
  ok("…and the 24-hour reminder once more", (await keys()).length === 2);
}

// ── 12. Summary: figures equal the facts; the member gets one summary ──
const S = await mkOrg("Summary");
{
  const m = await mkMember(S.orgId, "owner");
  await savePreferences(S.orgId, m, {
    default: ALL_INSTANT,
    daily: { enabled: true, channels: ["email"] },
  });
  const at = new Date();
  await saveSettings(S.orgId, m.userId, { timezone: "UTC", summary_hour: at.getUTCHours() });
  const yesterday = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - 1, 10),
  );
  for (const amt of [12_345, 6_000, 99_900])
    await txn(S.orgId, S.biz.id, amt, {
      status: "succeeded",
      finalisedAt: yesterday,
      occurredAt: yesterday,
    });
  await txn(S.orgId, S.biz.id, 4_000, {
    status: "failed",
    finalisedAt: yesterday,
    occurredAt: yesterday,
  });
  const start = yesterday.toISOString().slice(0, 10);
  const live = {
    id: S.biz.id,
    publicId: S.biz.publicId,
    name: S.biz.name,
    timezone: S.biz.timezone ?? "UTC",
  };
  const d = await withTenant(S.orgId, (tx) => ensureDigest(tx, S.orgId, live, "daily", start, at));
  const parts = d.parts as unknown as DigestParts;
  const [direct] = rowsOf<{ n: number; s: string }>(
    await systemDb.execute(sql`
      select count(*)::int as n, coalesce(sum(amount_minor), 0)::text as s from transactions
      where business_id = ${S.biz.id} and type = 'payment' and status = 'succeeded'
        and finalised_at >= ${`${start}T00:00:00Z`}::timestamptz
        and finalised_at < ${`${start}T00:00:00Z`}::timestamptz + interval '1 day'`),
  );
  ok(
    "collected equals the direct SQL sum",
    parts.figures.collected.count === direct!.n &&
      parts.figures.collected.totals.USD === Number(direct!.s),
    [parts.figures.collected, direct],
  );
  ok(
    "failed counts the failed payment",
    parts.figures.failed.count === 1 && parts.figures.failed.totals.USD === 4_000,
  );
  const s1 = await runDigestSender(at, { onlyBusinessId: S.biz.id });
  const s2 = await runDigestSender(at, { onlyBusinessId: S.biz.id });
  const rows = (await bell(S.orgId, m.userId)).filter((n) => n.kind === "daily_summary");
  const ds = (await deliveriesOf(S.orgId, eq(notificationDeliveries.userId, m.userId))).filter(
    (x) => x.kind === "daily_summary",
  );
  ok(
    "the member gets one summary bell row",
    rows.length === 1 && rows[0]!.url === `/notifications/summaries/${d.publicId}`,
    rows.map((r) => [r.title, r.url]),
  );
  ok(
    "…and one email, even when the sender runs twice",
    ds.length === 1 && ds[0]!.channel === "email" && s1.members === 1 && s2.members === 0,
    [ds.length, s1, s2],
  );
}

// ── 13. The worker reached every row it queued ──
{
  const stuck = await systemDb
    .select({ id: notificationQueue.id, lastError: notificationQueue.lastError })
    .from(notificationQueue)
    .where(
      and(
        inArray(notificationQueue.organizationId, [
          A.orgId,
          B.orgId,
          G.orgId,
          G2.orgId,
          O.orgId,
          P.orgId,
          C.orgId,
          Q.orgId,
        ]),
        eq(notificationQueue.status, "failed"),
      ),
    );
  ok("no queue row failed", stuck.length === 0, stuck);
  const evs = await systemDb
    .select({ id: events.id })
    .from(events)
    .where(eq(events.organizationId, A.orgId));
  ok("events were emitted", evs.length > 0);
}

setNotificationTransports(null);
console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "✅ NOTIFICATIONS: PASS" : "❌ NOTIFICATIONS: FAIL");
await closeDb();
process.exit(fail === 0 ? 0 : 1);
