/**
 * The usage grace window that holds only the invoice (`usage_close_delay_minutes`, 0523):
 *  - grace 180: a metered term renews at period end + 6 min; its invoice is a held `pending`
 *    draft (`hold_until` = end + 186 min, `usage_closes_at` in the API) that finalizes at the
 *    close with the usage received in the grace as period usage, then the collect pump charges
 *    it; `invoice_generated` only at the close;
 *  - plan credits on time: the new cycle and a reset window are granted at the renewal; the
 *    closing grant pays the closed period's usage at the close, then expires; with
 *    `grant_when: invoice_paid` the new cycle waits for the close and the payment;
 *  - a flat-fee-only subscription finalizes at once; the cap per plan interval; the API bound;
 *  - grace 0 and `create_pending_invoices` behave as before;
 *  - a plan change in the grace and a renewal that finds a held invoice close it first; the
 *    balance rates both windows; a test-clock advance past `hold_until` closes it;
 *  - cancel at term end cancels on time and its closing usage invoice waits; an immediate
 *    cancel does not hold; a held close with nothing to bill is a zero invoice;
 *  - while held: no send, no amount in the renewal email, no payment-due reminder; after the
 *    close a late event goes on the next invoice and a declined charge starts dunning.
 *
 *   pnpm verify:usage-grace
 */
import { and, eq, like, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { cancelSubscriptionWithOptions, createSubscription } from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { applyDunningFinalAction } from "@/modules/subscriptions/dunning";
import { applyDueScheduledChanges } from "@/modules/subscriptions/scheduled-changes";
import { pauseSubscriptionWithOptions } from "@/modules/subscriptions/service";
import { loadEffectiveDunningConfig } from "@/modules/dunning-policies/effective";
import { collectRenewalInvoice } from "@/modules/subscriptions/renewal";
import { runAutoClosePending } from "@/modules/invoicing/pending";
import { ratedUnbilledUsage } from "@/modules/credits/usage";
import { grantPlanCycle } from "@/modules/credits/plan-credits";
import { ensureUsageMonth } from "@/modules/metering/partitions";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import { runRemindersPass } from "@/modules/subscriptions/reminders";
import { runDunningPass } from "@/modules/subscriptions/dunning";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import {
  businesses,
  creditGrants,
  customerMeterBilling,
  customers,
  emailMessages,
  events,
  invoices,
  payments,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import {
  checker,
  createTestMeter,
  invoicesOf,
  meterBusiness,
  newCustomer,
  sendEvent,
  setTerm,
  tick,
  usageLines,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const HOUR = 3_600_000;
const MIN = 60_000;
const E = new Date(Math.floor((Date.now() - 5 * HOUR) / MIN) * MIN);
const S = new Date(E.getTime() - 24 * HOUR);
const mid = new Date(E.getTime() - 6 * HOUR);
const at = (min: number) => new Date(E.getTime() + min * MIN);

const { buildApp } = await import("@/index");
const app = await buildApp({ logger: false });
type Biz = Awaited<ReturnType<typeof meterBusiness>>;
let keyN = 0;
const patchBiz = (b: Biz, payload: object) =>
  app.inject({
    method: "PATCH",
    url: `/v1/businesses/${b.biz.publicId}`,
    headers: {
      authorization: `Bearer ${b.org.secret}`,
      "idempotency-key": `usage-grace-${Date.now()}-${++keyN}`,
    },
    payload,
  });
const getInvoice = async (b: Biz, publicId: string) =>
  JSON.parse(
    (
      await app.inject({
        method: "GET",
        url: `/v1/businesses/${b.biz.publicId}/invoices/${publicId}`,
        headers: { authorization: `Bearer ${b.org.secret}` },
      })
    ).body,
  );
// Scoped like the real tick, not pinned like a test clock (a pin collects inline).
const closeScan = (b: Biz, now: Date) =>
  runWithClockScope({ onlyBusinessId: b.biz.id }, () => runAutoClosePending(now));
/** What the collect pump does for one invoice: lease, collect, clear. */
async function pumpCollect(orgId: string, invoiceId: string): Promise<boolean> {
  const leased = (await systemDb.execute(sql`
    update invoices set collect_due_at = now() + interval '10 minutes'
    where id = ${invoiceId} and collect_due_at <= now() returning id`)) as unknown as unknown[];
  if (leased.length === 0) return false;
  await collectRenewalInvoice(orgId, invoiceId);
  await systemDb.execute(
    sql`update invoices set collect_due_at = null, collect_trace_id = null where id = ${invoiceId}`,
  );
  return true;
}
const eventsFor = async (publicId: string, type: string) =>
  (
    await systemDb
      .select({ id: events.id, createdAt: events.createdAt })
      .from(events)
      .where(and(eq(events.type, type), sql`${events.data}::text like ${`%"${publicId}"%`}`))
  ).length;
const paymentsOf = async (invoiceId: string) =>
  systemDb.select().from(payments).where(eq(payments.invoiceId, invoiceId));
const invoiceRow = async (id: string) =>
  (await systemDb.select().from(invoices).where(eq(invoices.id, id)))[0]!;
const grantsOf = async (itemId: string) =>
  systemDb
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.subscriptionItemId, itemId), eq(creditGrants.source, "plan_cycle")));

/** A business with a meter price (10 per unit), a flat plan with term credits, a flat-only plan. */
async function graceBusiness(name: string, grace: number, extra: object = {}) {
  const b = await meterBusiness(name);
  const saved = await patchBiz(b, { usage_close_delay_minutes: grace, ...extra });
  if (saved.statusCode !== 200) throw new Error(`PATCH failed: ${saved.body}`);
  const unit = await app.inject({
    method: "POST",
    url: `/v1/businesses/${b.biz.publicId}/credit_units`,
    headers: {
      authorization: `Bearer ${b.org.secret}`,
      "idempotency-key": `usage-grace-unit-${Date.now()}-${++keyN}`,
    },
    payload: { id: "credit", name: "credit", currency: "USD", minor_per_unit: "1", decimals: 0 },
  });
  if (unit.statusCode >= 300) throw new Error(`credit unit failed: ${unit.body}`);
  const planProduct = await createProduct({ ...b.ids, name: "Plan", kind: "plan" });
  const meter = await createTestMeter(b.ids, {});
  const meterPrice = await createPrice({
    ...b.ids,
    productId: b.product.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: meter.key,
    unitAmountDecimal: "10",
  });
  const plan = await createPrice({
    ...b.ids,
    productId: planProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    interval: "month",
    amountMinor: 1000,
    grantsCredit: {
      kind: "per_cycle",
      unit: "credit",
      amount: 100,
      rollover: { mode: "none" },
      applicability: { kind: "metered" },
    },
  });
  const flatOnly = await createPrice({
    ...b.ids,
    productId: planProduct.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    interval: "month",
    amountMinor: 700,
  });
  return { ...b, meter, meterPrice, plan, flatOnly, planProduct };
}
type GB = Awaited<ReturnType<typeof graceBusiness>>;

/** A subscription on [S, E): meter + plan by default. The plan's first grant is moved there. */
async function graceSub(g: GB, tag: string, prices = [g.plan, g.meterPrice], card?: string) {
  const customer = card
    ? await createCustomer({ ...g.ids, email: `${tag}-${Date.now()}@example.com` })
    : await newCustomer(g.ids, tag);
  if (card) await vaultPaymentMethod({ ...g.ids, customer, token: card });
  const sub = await createSubscription({
    ...g.ids,
    customerId: customer.id,
    now: new Date(),
    items: prices.map((price) => ({ price, quantity: 1 })),
  });
  await setTerm(sub.subscription.id, S, E);
  const items = await systemDb
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, sub.subscription.id));
  const planItem = items.find((i) => i.priceId === g.plan.id);
  // The closing term's own cycle grant, as its renewal would have granted it.
  if (planItem)
    await withTenant(g.orgId, (tx) =>
      grantPlanCycle(tx, {
        ...g.ids,
        subscription: { id: sub.subscription.id, customerId: customer.id, currency: "USD" },
        periodStart: S,
        periodEnd: E,
      }),
    );
  const send = (stamp: Date, tokens: number, receivedMs?: number) =>
    sendEvent(g.ids, {
      customerId: customer.id,
      eventName: g.meter.eventName,
      at: stamp,
      properties: { tokens },
      receivedMs,
    });
  return { customer, sub, id: sub.subscription.id, planItem, send };
}
const heldOf = async (g: GB, subId: string) =>
  (await invoicesOf(g.orgId, subId)).find((x) => x.inv.holdUntil != null);
/** The renewal email enqueued for a customer (enqueued in the event's transaction). */
const renewedMail = async (customerId: string) =>
  (
    await systemDb
      .select({ bodyText: emailMessages.bodyText })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.customerId, customerId),
          eq(emailMessages.type, "subscription_renewed"),
        ),
      )
  )[0]?.bodyText;
const enableEmail = (b: Biz) =>
  systemDb
    .update(businesses)
    .set({ emailConfig: { enabled: true } })
    .where(eq(businesses.id, b.biz.id));

// ── 1. Grace 180 ─────────────────────────────────────────────────────────────────
console.log("1. grace 180");
const g = await graceBusiness("Usage Grace Org", 180);
await enableEmail(g);
const a = await graceSub(g, "grace");
await a.send(mid, 10);
const countA = async () => (await invoicesOf(g.orgId, a.id)).length;
const before = await countA();
await tick(g.biz.id, at(5));
check("not renewed at period end + 5 min", (await countA()) === before);
await tick(g.biz.id, at(6));
const [aSub] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, a.id));
const aHeld = await heldOf(g, a.id);
check(
  "the term rolls at period end + 6 min",
  aSub?.currentPeriodStart?.getTime() === E.getTime(),
  aSub?.currentPeriodStart,
);
check(
  "a held invoice exists: pending, hold_until = period end + 186 min",
  aHeld?.inv.status === "pending" && aHeld.inv.holdUntil?.getTime() === at(186).getTime(),
  aHeld?.inv,
);
const aRenewed = (
  await systemDb
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.type, "subscription_renewed"),
        sql`${events.data}::text like ${`%"${a.sub.subscription.publicId}"%`}`,
      ),
    )
)[0]?.data as { invoice_hold_until?: string } | undefined;
check(
  "the renewal event carries invoice_hold_until",
  aRenewed?.invoice_hold_until === at(186).toISOString(),
  aRenewed,
);
const aMail = await renewedMail(a.customer.id);
check(
  "a held renewal's email states no amount",
  !!aMail && aMail.includes("Next renewal") && !aMail.includes("Amount"),
  aMail?.slice(0, 300),
);
// The draft is not final: neither an invoice email nor a payment request goes out.
const sendHeld = async (type: string) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${g.biz.publicId}/emails/send`,
    headers: {
      authorization: `Bearer ${g.org.secret}`,
      "idempotency-key": `usage-grace-send-${Date.now()}-${++keyN}`,
    },
    payload: { type, invoice: aHeld?.inv.publicId },
  });
const sentInv = await sendHeld("invoice_sent");
const sentReq = await sendHeld("payment_request");
check(
  "sending a held invoice or a payment request for it is refused (400)",
  sentInv.statusCode === 400 &&
    sentReq.statusCode === 400 &&
    JSON.parse(sentInv.body).error?.message ===
      `We could not send the invoice. Invoice '${aHeld?.inv.publicId}' is not final. Send it after it finalizes.`,
  [sentInv.statusCode, sentInv.body, sentReq.statusCode],
);
const aApi = aHeld ? await getInvoice(g, aHeld.inv.publicId) : null;
check(
  "the API shows usage_closes_at on the held invoice",
  aApi?.usage_closes_at != null && new Date(aApi.usage_closes_at).getTime() === at(186).getTime(),
  aApi?.usage_closes_at,
);
check(
  "at the renewal: invoice_pending_created, no invoice_generated, no charge",
  !!aHeld &&
    (await eventsFor(aHeld.inv.publicId, "invoice_pending_created")) === 1 &&
    (await eventsFor(aHeld.inv.publicId, "invoice_generated")) === 0 &&
    (await paymentsOf(aHeld.inv.id)).length === 0,
);
// Plan credits on time.
const aGrants = await grantsOf(a.planItem!.id);
const aNew = aGrants.find((x) => x.sourceRef === `${a.planItem!.id}:cycle:${E.toISOString()}`);
const aClosing = aGrants.find((x) => x.sourceRef === `${a.planItem!.id}:cycle:${S.toISOString()}`);
check(
  "right after the renewal the new period's grant exists, active, from the period start",
  aNew?.status === "active" && aNew.effectiveAt.getTime() === E.getTime(),
  aNew,
);
check("the closing grant is still active in the grace", aClosing?.status === "active", aGrants);
// Received in the grace, stamped inside the closed period.
await a.send(mid, 5, at(120).getTime());
// New-term usage, for the balance.
await a.send(at(30), 2, at(30).getTime());
await withTenant(g.orgId, async (tx) => {
  const lines = await ratedUnbilledUsage(tx, {
    customerId: a.customer.id,
    currency: "USD",
    asOf: new Date(),
  });
  const heldLine = lines.find((l) => l.held);
  const current = lines.find((l) => !l.held && l.meterId === g.meter.id);
  check(
    "the balance rates both windows in the grace (closed 15 units = 150, current 2 units = 20)",
    heldLine?.amountMinor === 150n && current?.amountMinor === 20n,
    lines.map((l) => [l.held ?? false, String(l.amountMinor)]),
  );
});
await closeScan(g, at(185));
check("not closed at period end + 185 min", (await invoiceRow(aHeld!.inv.id)).status === "pending");
await closeScan(g, at(186));
const aClosed = (await invoicesOf(g.orgId, a.id)).find((x) => x.inv.id === aHeld!.inv.id)!;
const aUsage = usageLines(aClosed.lines).filter((l) => l.priceId === g.meterPrice.id);
check(
  "closed at period end + 186 min with the grace event as period usage (15 units = 150, no late line)",
  aClosed.inv.status !== "pending" &&
    aUsage.length === 1 &&
    Number(aUsage[0]!.amountMinor) === 150 &&
    !aUsage[0]!.description.startsWith("Usage from ") &&
    aUsage[0]!.periodStart?.getTime() === S.getTime(),
  aClosed.lines.map((l) => [l.description, String(l.amountMinor)]),
);
check(
  "due on issue: the due date is the close instant, not the period start",
  aClosed.inv.dueDate?.getTime() === at(186).getTime() && aClosed.inv.status === "payment_due",
  [aClosed.inv.dueDate, aClosed.inv.status],
);
check(
  "invoice_generated and invoice_closed are emitted at the close",
  (await eventsFor(aHeld!.inv.publicId, "invoice_generated")) === 1 &&
    (await eventsFor(aHeld!.inv.publicId, "invoice_closed")) === 1,
);
check(
  "the closing grant paid the closed period's usage (100 of 150)",
  aClosed.inv.grantCreditsPreTaxMinor + aClosed.inv.grantCreditsPostTaxMinor === 100n,
  [aClosed.inv.grantCreditsPreTaxMinor, aClosed.inv.grantCreditsPostTaxMinor],
);
const aClosingAfter = (await grantsOf(a.planItem!.id)).find((x) => x.id === aClosing?.id);
check(
  "the closing grant is settled after the close",
  aClosingAfter?.status !== "active",
  aClosingAfter?.status,
);
check(
  "no charge in the close itself; it waits for the collect pump",
  (await paymentsOf(aHeld!.inv.id)).length === 0 && aClosed.inv.collectDueAt != null,
  aClosed.inv.collectDueAt,
);
await pumpCollect(g.orgId, aHeld!.inv.id);
check(
  "the collect pump charges it after the close",
  (await paymentsOf(aHeld!.inv.id)).length === 1 &&
    (await invoiceRow(aHeld!.inv.id)).status === "paid",
);
check(
  "no held invoice is left pending after the close",
  !(await invoicesOf(g.orgId, a.id)).some((x) => x.inv.holdUntil && x.inv.status === "pending"),
);
// Received after the close's cutoff, stamped in the closed period: the next invoice bills it
// late. Just past the cutoff, so it is settled by the next close (as in verify:usage-late).
const aPointer = (
  await systemDb
    .select({ cutoffAt: customerMeterBilling.cutoffAt })
    .from(customerMeterBilling)
    .where(
      and(
        eq(customerMeterBilling.customerId, a.customer.id),
        eq(customerMeterBilling.meterId, g.meter.id),
      ),
    )
)[0];
await a.send(mid, 7, aPointer!.cutoffAt!.getTime() - 5 * MIN + 500);
await new Promise((r) => setTimeout(r, 1500));
const E3 = at(250);
await setTerm(a.id, E, E3);
await tick(g.biz.id, new Date(E3.getTime() + 6 * MIN));
const aNextHeld = (await invoicesOf(g.orgId, a.id)).find(
  (x) => x.inv.holdUntil && x.inv.status === "pending",
);
await closeScan(g, new Date(E3.getTime() + 186 * MIN));
const aNext = aNextHeld
  ? (await invoicesOf(g.orgId, a.id)).find((x) => x.inv.id === aNextHeld.inv.id)
  : undefined;
const aLate = usageLines(aNext?.lines ?? []).find((l) => l.description.startsWith("Usage from "));
check(
  "an event received after the close goes on the next invoice as late usage (7 units = 70)",
  !!aNext &&
    aNext.inv.status !== "pending" &&
    Number(aLate?.amountMinor) === 70 &&
    aLate?.periodStart?.getTime() === S.getTime(),
  aNext?.lines.map((l) => [l.description, String(l.amountMinor)]),
);

// ── 2. Flat-fee only, same business ─────────────────────────────────────────────
console.log("2. flat only");
const f = await graceSub(g, "flat", [g.flatOnly]);
const fBefore = (await invoicesOf(g.orgId, f.id)).length;
await tick(g.biz.id, at(1));
const fAll = await invoicesOf(g.orgId, f.id);
check(
  "a flat-fee-only subscription is finalized at once with no hold_until",
  fAll.length === fBefore + 1 &&
    fAll[0]!.inv.status !== "pending" &&
    fAll[0]!.inv.holdUntil == null,
  fAll[0]?.inv,
);

// ── 3. A plan change in the grace closes the held invoice first ───────────────
console.log("3. close first");
const c = await graceSub(g, "change");
await c.send(mid, 3);
await tick(g.biz.id, at(6));
const cHeld = await heldOf(g, c.id);
const plan2 = await createPrice({
  ...g.ids,
  productId: g.planProduct.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  interval: "month",
  amountMinor: 2000,
});
const cItems = await systemDb
  .select()
  .from(subscriptionItems)
  .where(eq(subscriptionItems.subscriptionId, c.id));
const cPlanItem = cItems.find((i) => i.priceId === g.plan.id)!;
await changeSubscription({
  ...g.ids,
  subscriptionId: c.id,
  now: new Date(),
  changes: [{ itemId: cPlanItem.publicId, newPriceId: plan2.publicId }],
});
check(
  "a plan change during the grace finalizes the held invoice first",
  !!cHeld && (await invoiceRow(cHeld.inv.id)).status !== "pending",
  cHeld ? (await invoiceRow(cHeld.inv.id)).status : null,
);

// A renewal that finds a held invoice of the same subscription finalizes it first.
const r = await graceSub(g, "renew-first");
await r.send(mid, 4);
await tick(g.biz.id, at(6));
const rHeld = await heldOf(g, r.id);
const E2 = at(60);
await setTerm(r.id, E, E2);
await tick(g.biz.id, new Date(E2.getTime() + 200 * MIN));
const rAll = await invoicesOf(g.orgId, r.id);
check(
  "a renewal that finds a held invoice of the same subscription finalizes it first",
  !!rHeld &&
    (await invoiceRow(rHeld.inv.id)).status !== "pending" &&
    rAll.some((x) => x.inv.periodStart?.getTime() === E2.getTime()),
  rAll.map((x) => [x.inv.status, x.inv.periodStart]),
);

// ── 4. Cancel at term end ───────────────────────────────────────────────────────
console.log("4. cancel");
const k = await graceSub(g, "cancel-end");
await k.send(mid, 6);
await systemDb
  .update(subscriptions)
  .set({ cancelAtPeriodEnd: true })
  .where(eq(subscriptions.id, k.id));
await tick(g.biz.id, at(6));
const [kSub] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, k.id));
const kHeld = await heldOf(g, k.id);
check(
  "cancel at term end: cancelled on time, its usage invoice is held",
  kSub?.status === "cancelled" &&
    kHeld?.inv.status === "pending" &&
    kHeld.inv.holdUntil?.getTime() === at(186).getTime(),
  [kSub?.status, kHeld?.inv],
);
await k.send(mid, 4, at(100).getTime());
await closeScan(g, at(186));
const kClosed = (await invoicesOf(g.orgId, k.id)).find((x) => x.inv.id === kHeld?.inv.id);
check(
  "the closing invoice takes usage received in the grace (10 units = 100) and no fixed line",
  !!kClosed &&
    kClosed.inv.status !== "pending" &&
    usageLines(kClosed.lines).reduce((s, l) => s + Number(l.amountMinor), 0) === 100 &&
    !kClosed.lines.some((l) => l.kind === "recurring"),
  kClosed?.lines.map((l) => [l.kind, l.description, String(l.amountMinor)]),
);
// An immediate cancel bills at once: no hold.
const im = await graceSub(g, "cancel-now");
await setTerm(im.id, S, new Date(Date.now() + 10 * HOUR));
await im.send(mid, 2);
await cancelSubscriptionWithOptions({
  ...g.ids,
  subscriptionId: im.id,
  now: new Date(),
  cancelOption: "immediately",
});
check("an immediate cancel holds nothing", (await heldOf(g, im.id)) === undefined);

// ── 5. Zero invoice ─────────────────────────────────────────────────────────────
console.log("5. zero");
const z = await graceSub(g, "zero", [g.meterPrice]);
await tick(g.biz.id, at(6));
const zHeld = await heldOf(g, z.id);
await closeScan(g, at(186));
const zRow = zHeld ? await invoiceRow(zHeld.inv.id) : null;
check(
  "a held close with nothing to bill is a numbered zero invoice",
  !!zRow && zRow.status === "paid" && zRow.totalMinor === 0n && zRow.number != null,
  zRow,
);

// ── 5b. Due date, reminders, net terms; end actions and scheduled changes in the grace ──
console.log("5b. due date and locks");
const DAY = 24 * HOUR;
// Auto-collection off: the reminder schedule counts from the due date.
const off = await graceSub(g, "offline");
await systemDb
  .update(customers)
  .set({ autoCollection: "off" })
  .where(eq(customers.id, off.customer.id));
await off.send(mid, 2);
await tick(g.biz.id, at(6));
const offHeld = await heldOf(g, off.id);
await closeScan(g, at(186));
if (offHeld) await pumpCollect(g.orgId, offHeld.inv.id);
const offRow = offHeld ? await invoiceRow(offHeld.inv.id) : null;
const fromDue = offRow?.nextAttemptAt
  ? offRow.nextAttemptAt.getTime() - at(186).getTime()
  : Number.NaN;
check(
  "offline: due at the close, and the first reminder counts whole days from it",
  offRow?.dueDate?.getTime() === at(186).getTime() &&
    offRow.dunningStatus === "in_progress" &&
    fromDue > 0 &&
    fromDue % DAY === 0,
  [offRow?.dueDate, offRow?.dunningStatus, offRow?.nextAttemptAt],
);
// Net 3 days: due = close + 3 days, not yet due.
const net = await graceSub(g, "net3");
await systemDb.update(customers).set({ netTermDays: 3 }).where(eq(customers.id, net.customer.id));
await net.send(mid, 2);
await tick(g.biz.id, at(6));
const netHeld = await heldOf(g, net.id);
await closeScan(g, at(186));
const netRow = netHeld ? await invoiceRow(netHeld.inv.id) : null;
check(
  "net 3 days: the due date is the close + 3 days and the invoice is posted",
  netRow?.dueDate?.getTime() === at(186).getTime() + 3 * DAY && netRow.status === "posted",
  [netRow?.dueDate, netRow?.status],
);
// A dunning end action that cancels in the grace closes the held invoice first.
const dn = await graceSub(g, "dunning-end");
await dn.send(mid, 2);
await tick(g.biz.id, at(6));
const dnHeld = await heldOf(g, dn.id);
// The exhausted invoice: an earlier, finalized invoice of the business.
const dnFirst = fAll[0]!;
await systemDb
  .update(invoices)
  .set({ status: "not_paid", dunningStatus: "exhausted" })
  .where(eq(invoices.id, dnFirst.inv.id));
const dnCfg = await withTenant(g.orgId, (tx) =>
  loadEffectiveDunningConfig(tx, { businessId: g.biz.id, customerId: dn.customer.id }),
);
await applyDunningFinalAction({
  ...g.ids,
  invoicePublicId: dnFirst.inv.publicId,
  subscriptionId: dn.id,
  subscriptionPublicId: dn.sub.subscription.publicId,
  config: { ...dnCfg, finalAction: { invoice: "not_paid", subscription: "cancel" } },
});
const [dnSub] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, dn.id));
check(
  "a dunning end action that cancels in the grace finalizes the held invoice first",
  dnSub?.status === "cancelled" &&
    !!dnHeld &&
    (await invoiceRow(dnHeld.inv.id)).status !== "pending",
  [dnSub?.status, dnHeld ? (await invoiceRow(dnHeld.inv.id)).status : null],
);
// A scheduled change applied by the clock in the grace closes the held invoice first.
const sc = await graceSub(g, "scheduled");
await sc.send(mid, 2);
await pauseSubscriptionWithOptions({
  ...g.ids,
  subscriptionId: sc.id,
  now: new Date(S.getTime() + HOUR),
  pauseOption: "specific_date",
  pauseDate: at(60),
});
await tick(g.biz.id, at(6));
const scHeld = await heldOf(g, sc.id);
await runWithClockScope({ onlyBusinessId: g.biz.id }, () => applyDueScheduledChanges(at(61)));
const [scSub] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, sc.id));
check(
  "a scheduled pause applied in the grace finalizes the held invoice first",
  scSub?.status === "paused" &&
    scHeld?.inv.status === "pending" &&
    (await invoiceRow(scHeld.inv.id)).status !== "pending",
  [scSub?.status, scHeld?.inv.status, scHeld ? (await invoiceRow(scHeld.inv.id)).status : null],
);

// A declined charge at the close starts dunning on the now-final invoice.
const dc = await graceSub(g, "declined", undefined, "4000000000009995");
await dc.send(mid, 2);
await tick(g.biz.id, at(6));
const dcHeld = await heldOf(g, dc.id);
await closeScan(g, at(186));
if (dcHeld) await pumpCollect(g.orgId, dcHeld.inv.id);
const dcRow = dcHeld ? await invoiceRow(dcHeld.inv.id) : null;
check(
  "a declined charge after the close starts dunning on the final invoice",
  !!dcRow &&
    (await paymentsOf(dcRow.id)).length === 1 &&
    dcRow.status === "payment_due" &&
    dcRow.dunningStatus === "in_progress" &&
    dcRow.nextAttemptAt != null,
  [dcRow?.status, dcRow?.dunningStatus, dcRow?.nextAttemptAt],
);
// No payment-due reminder or overdue notice while held; the same invoice gets one once final.
await systemDb
  .update(businesses)
  .set({ reminderConfig: { payment_due: [3] } })
  .where(eq(businesses.id, g.biz.id));
const rm = await graceSub(g, "reminders");
await systemDb
  .update(customers)
  .set({ autoCollection: "off", netTermDays: 3 })
  .where(eq(customers.id, rm.customer.id));
await rm.send(mid, 2);
await tick(g.biz.id, at(6));
const rmHeld = await heldOf(g, rm.id);
const notices = async () =>
  rmHeld
    ? (await eventsFor(rmHeld.inv.publicId, "invoice_payment_due_reminder")) +
      (await eventsFor(rmHeld.inv.publicId, "invoice_payment_due"))
    : -1;
const scoped = <T>(now: Date, fn: () => Promise<T>) =>
  runWithClockScope({ onlyBusinessId: g.biz.id, now }, fn);
await scoped(at(100), () => runRemindersPass(at(100)));
await scoped(at(100), () => runDunningPass(at(100)));
check(
  "no payment-due reminder or overdue notice while the invoice is held",
  rmHeld?.inv.status === "pending" && (await notices()) === 0,
  [rmHeld?.inv.status, await notices()],
);
await closeScan(g, at(186));
await scoped(at(190), () => runRemindersPass(at(190)));
check(
  "…and the 3-day reminder once it is final (the check is armed)",
  (await eventsFor(rmHeld!.inv.publicId, "invoice_payment_due_reminder")) === 1,
  [(await invoiceRow(rmHeld!.inv.id)).status, (await invoiceRow(rmHeld!.inv.id)).dueDate],
);
await systemDb.update(businesses).set({ reminderConfig: null }).where(eq(businesses.id, g.biz.id));

// ── 6. Cap and API ──────────────────────────────────────────────────────────────
console.log("6. cap");
const cap = await graceBusiness("Usage Grace Cap Org", 43200);
const capFor = async (interval: "day" | "week" | "month" | "year", start: Date) => {
  const meter = await createTestMeter(cap.ids, {});
  const price = await createPrice({
    ...cap.ids,
    productId: cap.product.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval,
    meter: meter.key,
    unitAmountDecimal: "1",
  });
  const customer = await newCustomer(cap.ids, `cap-${interval}`);
  const sub = await createSubscription({
    ...cap.ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, start, E);
  await tick(cap.biz.id, at(6));
  const held = (await invoicesOf(cap.orgId, sub.subscription.id)).find((x) => x.inv.holdUntil);
  return held ? (held.inv.holdUntil!.getTime() - E.getTime()) / MIN - 6 : null;
};
const dayCap = await capFor("day", S);
const weekCap = await capFor("week", new Date(E.getTime() - 7 * 24 * HOUR));
const monthCap = await capFor("month", new Date(E.getTime() - 30 * 24 * HOUR));
const yearCap = await capFor("year", new Date(E.getTime() - 365 * 24 * HOUR));
check("cap: a daily plan with 43200 configured holds 720 minutes", dayCap === 720, dayCap);
check("cap: a weekly plan holds 5040 minutes", weekCap === 5040, weekCap);
check("cap: a monthly plan holds 20160 minutes", monthCap === 20160, monthCap);
check("cap: a yearly plan holds the full 43200 minutes", yearCap === 43200, yearCap);
const tooLong = await patchBiz(cap, { usage_close_delay_minutes: 43201 });
const fraction = await patchBiz(cap, { usage_close_delay_minutes: 2.5 });
check(
  "the API refuses 43201 and 2.5 with the new message",
  tooLong.statusCode === 400 &&
    fraction.statusCode === 400 &&
    JSON.parse(tooLong.body).error?.message ===
      "usage_close_delay_minutes: Enter a whole number of minutes from 0 to 43200 (30 days).",
  [tooLong.body, fraction.statusCode],
);

// ── 7. Grace 0 and pending-invoice mode ───────────────────────────────────────
console.log("7. grace 0");
const zero = await graceBusiness("Usage Grace Zero Org", 0);
await enableEmail(zero);
const o = await graceSub(zero, "zero-grace");
await o.send(mid, 10);
const oBefore = (await invoicesOf(zero.orgId, o.id)).length;
await tick(zero.biz.id, at(5));
const oEarly = (await invoicesOf(zero.orgId, o.id)).length;
await tick(zero.biz.id, at(6));
const oAll = await invoicesOf(zero.orgId, o.id);
const oInv = oAll[0]!;
check(
  "grace 0: not at +5 min; at +6 min one finalized invoice with the usage, no hold_until",
  oEarly === oBefore &&
    oAll.length === oBefore + 1 &&
    oInv.inv.status === "paid" &&
    oInv.inv.holdUntil == null &&
    usageLines(oInv.lines).some((l) => Number(l.amountMinor) === 100),
  oInv.inv,
);
// The email quotes the invoice of ITS renewal, at each renewal.
const usd = (minor: bigint | number) => `$${(Number(minor) / 100).toFixed(2)}`;
const renewedMails = async (customerId: string) =>
  (
    await systemDb
      .select({ bodyText: emailMessages.bodyText })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.customerId, customerId),
          eq(emailMessages.type, "subscription_renewed"),
        ),
      )
      .orderBy(emailMessages.createdAt)
  ).map((m) => m.bodyText);
const oMail1 = (await renewedMails(o.customer.id))[0];
check(
  "grace 0: the renewal email states this renewal's own invoice total",
  !!oMail1 && oMail1.includes(`Amount: ${usd(oInv.inv.totalMinor)}`),
  { mail: oMail1?.slice(0, 300), total: String(oInv.inv.totalMinor) },
);
check(
  "grace 0: the renewal event has no invoice_hold_until",
  (
    await systemDb
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.type, "subscription_renewed"),
          sql`${events.data}::text like ${`%"${o.sub.subscription.publicId}"%`}`,
          sql`${events.data}->>'invoice_hold_until' is not null`,
        ),
      )
  ).length === 0 && !!(await renewedMail(o.customer.id)),
);
check(
  "grace 0: the due date is the period start, as before",
  oInv.inv.dueDate?.getTime() === E.getTime(),
  oInv.inv.dueDate,
);
check(
  "grace 0: invoice_generated at the renewal, no invoice_pending_created, charged inline",
  (await eventsFor(oInv.inv.publicId, "invoice_generated")) === 1 &&
    (await eventsFor(oInv.inv.publicId, "invoice_pending_created")) === 0 &&
    (await paymentsOf(oInv.inv.id)).length === 1,
);
const oGrants = await grantsOf(o.planItem!.id);
const oClosing = oGrants.find((x) => x.sourceRef?.endsWith(`:cycle:${S.toISOString()}`));
check(
  "grace 0: the closing grant paid its usage and was settled, the new one granted, in the renewal",
  !!oClosing &&
    oClosing.status !== "active" &&
    oInv.inv.grantCreditsPreTaxMinor + oInv.inv.grantCreditsPostTaxMinor === 100n &&
    oGrants.some((x) => x.sourceRef?.endsWith(`:cycle:${E.toISOString()}`)),
  oGrants.map((x) => [x.sourceRef, x.status]),
);
// A second renewal with more usage: its email states the second invoice, not the first.
await o.send(at(30), 30);
const [oSub] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, o.id));
await tick(zero.biz.id, new Date(oSub!.currentPeriodEnd!.getTime() + 6 * MIN));
const oAll2 = await invoicesOf(zero.orgId, o.id);
const oInv2 = oAll2.find((x) => x.inv.periodStart?.getTime() === oSub!.currentPeriodEnd!.getTime());
const oMail2 = (await renewedMails(o.customer.id))[1];
check(
  "grace 0: a second renewal's email states ITS invoice total, not the first one's",
  !!oInv2 &&
    oInv2.inv.totalMinor !== oInv.inv.totalMinor &&
    !!oMail2 &&
    oMail2.includes(`Amount: ${usd(oInv2.inv.totalMinor)}`) &&
    !oMail2.includes(`Amount: ${usd(oInv.inv.totalMinor)}`),
  { mail: oMail2?.slice(0, 300), totals: oAll2.map((x) => String(x.inv.totalMinor)) },
);
// Deferred numbering: the invoice is committed unnumbered and numbered by a later pass. The
// email is built again at the commit, so it still states this renewal's total.
// A flat fee only: an invoice with a credit draw is numbered at once and would not defer.
const deferSub = await graceSub(zero, "defer-number", [zero.flatOnly]);
const { renewSubscription } = await import("@/modules/subscriptions/renewal");
await runWithClockScope({ onlyBusinessId: zero.biz.id }, () =>
  renewSubscription(zero.orgId, deferSub.id, at(6), { deferNumber: true }),
);
const deferInv = (await invoicesOf(zero.orgId, deferSub.id)).find(
  (x) => x.inv.periodStart?.getTime() === E.getTime(),
);
const deferMail = (await renewedMails(deferSub.customer.id))[0];
check(
  "deferred numbering: the renewal email states the total of the unnumbered renewal invoice",
  !!deferInv &&
    deferInv.inv.awaitingNumber === true &&
    !!deferMail &&
    deferMail.includes(`Amount: ${usd(deferInv.inv.totalMinor)}`),
  {
    mail: deferMail?.slice(0, 300),
    inv: deferInv?.inv.status,
    total: String(deferInv?.inv.totalMinor),
  },
);
const pend = await graceBusiness("Usage Grace Pending Org", 180, { create_pending_invoices: true });
await enableEmail(pend);
const p = await graceSub(pend, "pending-mode");
await tick(pend.biz.id, at(6));
const pMail = await renewedMail(p.customer.id);
check(
  "create_pending_invoices: the renewal email states no amount while its invoice is a draft",
  !!pMail && pMail.includes("Next renewal") && !pMail.includes("Amount"),
  pMail?.slice(0, 300),
);
const pDraft = (await invoicesOf(pend.orgId, p.id)).find((x) => x.inv.status === "pending");
const pWindow = (pDraft?.inv.metadata as { usage_window?: { start: string; end: string } } | null)
  ?.usage_window;
check(
  "create_pending_invoices: a pending draft with no hold_until and its own period as the window",
  !!pDraft && pDraft.inv.holdUntil == null && pWindow?.end === pDraft.inv.periodEnd?.toISOString(),
  pDraft?.inv,
);

// ── 8. Test clock: credits on time, reset windows, grant_when: invoice_paid ─────
console.log("8. test clock");
async function travelled(name: string, grantWhen?: "invoice_paid") {
  const t = await graceBusiness(name, 180);
  if (grantWhen) {
    const r = await patchBiz(t, {
      billing_rules_config: { plan_credits: { grant_when: grantWhen } },
    });
    if (r.statusCode !== 200) throw new Error(`PATCH failed: ${r.body}`);
  }
  const G = new Date("2026-01-01T00:00:00.000Z");
  await ensureUsageMonth(G);
  await ensureUsageMonth(new Date("2026-02-01T00:00:00.000Z"));
  await startTimeTravel({ orgId: t.orgId, bizId: t.biz.id, genesisTime: G });
  const reset = await createPrice({
    ...t.ids,
    productId: t.product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    interval: "month",
    amountMinor: 0,
    grantsCredit: {
      kind: "per_cycle",
      unit: "credit",
      amount: 50,
      reset: { every: "month" },
      rollover: { mode: "none" },
      applicability: { kind: "metered" },
    },
  });
  const customer = await newCustomer(t.ids, "tt");
  const sub = await runWithClockScope({ onlyBusinessId: t.biz.id, now: G }, () =>
    createSubscription({
      ...t.ids,
      customerId: customer.id,
      now: G,
      items: [
        { price: t.plan, quantity: 1 },
        { price: t.meterPrice, quantity: 1 },
        { price: reset, quantity: 1 },
      ],
    }),
  );
  const [row] = await systemDb
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, sub.subscription.id));
  const end = row!.currentPeriodEnd!;
  const items = await systemDb
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, sub.subscription.id));
  return {
    t,
    customer,
    subId: sub.subscription.id,
    end,
    planItem: items.find((i) => i.priceId === t.plan.id)!,
    resetItem: items.find((i) => i.priceId === reset.id)!,
  };
}
const tt = await travelled("Usage Grace Clock Org");
await sendEvent(tt.t.ids, {
  customerId: tt.customer.id,
  eventName: tt.t.meter.eventName,
  at: new Date(tt.end.getTime() - 10 * 24 * HOUR),
  properties: { tokens: 3 },
});
await travelForward({
  orgId: tt.t.orgId,
  bizId: tt.t.biz.id,
  toTime: new Date(tt.end.getTime() + HOUR),
  stepDays: 7,
});
const ttHeld = (await invoicesOf(tt.t.orgId, tt.subId)).find((x) => x.inv.holdUntil);
const ttPlanGrants = await grantsOf(tt.planItem.id);
const ttWindow = await systemDb
  .select()
  .from(creditGrants)
  .where(
    and(
      eq(creditGrants.subscriptionItemId, tt.resetItem.id),
      like(creditGrants.sourceRef, "%:w:%"),
      eq(creditGrants.effectiveAt, tt.end),
    ),
  );
check(
  "test clock: held at the renewal; the new term grant and the reset window are granted then",
  ttHeld?.inv.status === "pending" &&
    ttPlanGrants.some(
      (x) =>
        x.sourceRef === `${tt.planItem.id}:cycle:${tt.end.toISOString()}` && x.status === "active",
    ) &&
    ttWindow.length === 1,
  {
    held: ttHeld?.inv.status,
    plan: ttPlanGrants.map((x) => [x.sourceRef, x.status]),
    window: (
      await systemDb
        .select()
        .from(creditGrants)
        .where(eq(creditGrants.subscriptionItemId, tt.resetItem.id))
    ).map((x) => [x.sourceRef, x.status, x.effectiveAt]),
    cursor: (
      await systemDb
        .select({ c: subscriptionItems.nextCreditResetAt })
        .from(subscriptionItems)
        .where(eq(subscriptionItems.id, tt.resetItem.id))
    )[0]?.c,
  },
);
// Sent in the grace, stamped in the closed period.
await sendEvent(tt.t.ids, {
  customerId: tt.customer.id,
  eventName: tt.t.meter.eventName,
  at: new Date(tt.end.getTime() - HOUR),
  properties: { tokens: 2 },
});
await travelForward({
  orgId: tt.t.orgId,
  bizId: tt.t.biz.id,
  toTime: new Date(tt.end.getTime() + 4 * HOUR),
});
const ttClosed = ttHeld
  ? (await invoicesOf(tt.t.orgId, tt.subId)).find((x) => x.inv.id === ttHeld.inv.id)
  : undefined;
check(
  "test clock: an advance past hold_until closes the hold, with the grace event (5 units = 50)",
  !!ttClosed &&
    ttClosed.inv.status !== "pending" &&
    usageLines(ttClosed.lines)
      .filter((l) => l.priceId === tt.t.meterPrice.id)
      .reduce((s, l) => s + Number(l.amountMinor), 0) === 50,
  ttClosed?.lines.map((l) => [l.description, String(l.amountMinor)]),
);

const tp = await travelled("Usage Grace Paid Org", "invoice_paid");
await travelForward({
  orgId: tp.t.orgId,
  bizId: tp.t.biz.id,
  toTime: new Date(tp.end.getTime() + HOUR),
  stepDays: 7,
});
const tpNew = async () =>
  (await grantsOf(tp.planItem.id)).find(
    (x) => x.sourceRef === `${tp.planItem.id}:cycle:${tp.end.toISOString()}`,
  );
check(
  "grant_when invoice_paid: the new cycle is pending in the grace",
  (await tpNew())?.status === "pending",
  (await tpNew())?.status,
);
await travelForward({
  orgId: tp.t.orgId,
  bizId: tp.t.biz.id,
  toTime: new Date(tp.end.getTime() + 4 * HOUR),
});
const tpHeld = (await invoicesOf(tp.t.orgId, tp.subId)).find((x) => x.inv.holdUntil);
if (tpHeld) await pumpCollect(tp.t.orgId, tpHeld.inv.id);
check(
  "grant_when invoice_paid: active once the held invoice is closed and paid",
  !!tpHeld &&
    (await invoiceRow(tpHeld.inv.id)).status === "paid" &&
    (await tpNew())?.status === "active",
  [tpHeld ? (await invoiceRow(tpHeld.inv.id)).status : null, (await tpNew())?.status],
);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ USAGE GRACE: PASS" : `❌ USAGE GRACE: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
