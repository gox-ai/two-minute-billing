/**
 * Late usage after a cancellation (`billing_rules_config.late_usage_invoices`), end to end:
 *  - off (unset): late usage of a cancelled subscription is never billed;
 *  - on: one invoice once the oldest late event was received 24 hours ago, purpose
 *    `late_usage`, at the old period's price (tiers re-rate the whole period), at most one a
 *    day per customer; a re-run adds nothing;
 *  - collection: one attempt by the collect pump, no retry, no dunning, no final action;
 *  - the per-currency minimum holds the usage back without moving the pointer;
 *  - a live subscription that takes the meter bills it instead; usage after the end and
 *    events older than 35 days are not billed;
 *  - the PATCH contract, and a time-travelled business (the 24-hour rule is met under its pin);
 *  - `wait_hours` and `min_interval_hours` (unset = 24 and 24): a shorter wait and a shorter
 *    interval, two invoices on one day, the bounds.
 *
 *   pnpm verify:late-usage-invoice
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createPrice } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { collectRenewalInvoice } from "@/modules/subscriptions/renewal";
import { runLateUsageInvoices } from "@/modules/subscriptions/late-usage-invoices";
import { formatUsagePeriod } from "@/modules/metering/meter-rating";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import { runBillingClockTickOnce } from "@/platform/jobs";
import {
  customerMeterBilling,
  customers,
  invoiceLineItems,
  invoices,
  payments,
  subscriptions,
} from "@db/schema";
import {
  checker,
  createTestMeter,
  invoicesOf,
  meterBusiness,
  sendEvent,
  setTerm,
  tick,
  usageLines,
  uuidAt,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const HOUR = 3_600_000;
const E = new Date(Math.floor((Date.now() - 4 * HOUR) / 60_000) * 60_000);
const S = new Date(E.getTime() - 24 * HOUR);
const E2 = new Date(E.getTime() + HOUR);
const mid = new Date(E.getTime() - 6 * HOUR);
const PERIOD = formatUsagePeriod({ start: S, end: E });
const ago = (h: number) => Date.now() - h * HOUR;

const { buildApp } = await import("@/index");
const app = await buildApp({ logger: false });
type Biz = Awaited<ReturnType<typeof meterBusiness>>;
let keyN = 0;
const patch = (b: Biz, late: unknown) =>
  app.inject({
    method: "PATCH",
    url: `/v1/businesses/${b.biz.publicId}`,
    headers: {
      authorization: `Bearer ${b.org.secret}`,
      "idempotency-key": `late-usage-${Date.now()}-${++keyN}`,
    },
    payload: { billing_rules_config: { late_usage_invoices: late } },
  });
const stored = async (b: Biz) =>
  JSON.parse(
    (
      await app.inject({
        method: "GET",
        url: `/v1/businesses/${b.biz.publicId}`,
        headers: { authorization: `Bearer ${b.org.secret}` },
      })
    ).body,
  ).billing_rules_config?.late_usage_invoices as {
    enabled: boolean;
    minimum: object;
    wait_hours: number;
    min_interval_hours: number;
  };

/** The late-usage pass for this business only; `now` pins its clock as a travel step does. */
const pass = (b: Biz, now?: Date) =>
  runWithClockScope({ onlyBusinessId: b.biz.id, ...(now ? { now } : {}) }, () =>
    runLateUsageInvoices(now ?? new Date()),
  );

async function lateInvoices(b: Biz, customerId: string) {
  const invs = await systemDb
    .select()
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), eq(invoices.purpose, "late_usage")))
    .orderBy(invoices.createdAt);
  const out = [];
  for (const inv of invs)
    out.push({
      inv,
      lines: await systemDb
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, inv.id)),
    });
  void b;
  return out;
}

const pointerOf = async (customerId: string, meterId: string) =>
  (
    await systemDb
      .select()
      .from(customerMeterBilling)
      .where(
        and(
          eq(customerMeterBilling.customerId, customerId),
          eq(customerMeterBilling.meterId, meterId),
        ),
      )
  )[0]!;

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

/**
 * A metered subscription billed `units` in [S, E) and cancelled at term end by the clock. Its
 * final invoice is then dated as cut two days ago, so events received since are late.
 */
async function cancelledSub(
  b: Biz,
  tag: string,
  opts: {
    units: number;
    price?: Partial<Parameters<typeof createPrice>[0]>;
    token?: string;
    autoOff?: boolean;
  },
) {
  const meter = await createTestMeter(b.ids, {});
  const price = await createPrice({
    ...b.ids,
    productId: b.product.id,
    id: `lui-${meter.key}`,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: meter.key,
    unitAmountDecimal: "10",
    ...opts.price,
  });
  const customer = await createCustomer({ ...b.ids, email: `${tag}-${Date.now()}@example.com` });
  await vaultPaymentMethod({ ...b.ids, customer, token: opts.token ?? "tok_4242" });
  if (opts.autoOff)
    await systemDb
      .update(customers)
      .set({ autoCollection: "off" })
      .where(eq(customers.id, customer.id));
  const sub = await createSubscription({
    ...b.ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, S, E);
  const send = (at: Date, tokens: number, receivedMs: number) =>
    sendEvent(b.ids, {
      customerId: customer.id,
      eventName: meter.eventName,
      at,
      properties: { tokens },
      receivedMs,
    });
  if (opts.units > 0) await send(mid, opts.units, ago(72));
  await systemDb
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, sub.subscription.id));
  await tick(b.biz.id);
  await systemDb
    .update(customerMeterBilling)
    .set({ cutoffAt: new Date(ago(48)) })
    .where(
      and(
        eq(customerMeterBilling.customerId, customer.id),
        eq(customerMeterBilling.meterId, meter.id),
      ),
    );
  const [row] = await systemDb
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, sub.subscription.id));
  return { meter, price, customer, sub: row!, send };
}

// ── 1. Off (unset): today's behaviour ─────────────────────────────────────────
console.log("1. setting off");
const off = await meterBusiness("Late Usage Off Org");
const o = await cancelledSub(off, "off", { units: 5 });
check("the clock cancels the subscription at term end", o.sub.status === "cancelled", o.sub.status);
await o.send(mid, 3, ago(30));
const oBefore = await pointerOf(o.customer.id, o.meter.id);
await pass(off);
await pass(off, new Date(Date.now() + 40 * 24 * HOUR));
const oAfter = await pointerOf(o.customer.id, o.meter.id);
check(
  "off: late usage of a cancelled subscription raises no invoice, however long",
  (await lateInvoices(off, o.customer.id)).length === 0 &&
    oAfter.cutoffAt?.getTime() === oBefore.cutoffAt?.getTime(),
  { before: oBefore.cutoffAt, after: oAfter.cutoffAt },
);

// ── 2. PATCH contract ─────────────────────────────────────────────────────────
console.log("2. settings");
const on = await meterBusiness("Late Usage On Org");
check(
  "an unset business reads disabled with no minimum, a 24-hour wait and one invoice a day",
  JSON.stringify(await stored(on)) ===
    JSON.stringify({ enabled: false, minimum: {}, wait_hours: 24, min_interval_hours: 24 }),
  await stored(on),
);
const r1 = await patch(on, { enabled: true });
check(
  "late_usage_invoices.enabled round-trips",
  r1.statusCode === 200 && (await stored(on)).enabled === true,
  [r1.statusCode, r1.body.slice(0, 200)],
);
const r2 = await patch(on, { minimum: { USD: 250 } });
const r3 = await patch(on, { enabled: false });
const kept = await stored(on);
check(
  "a PATCH with only enabled keeps the stored minimum",
  r2.statusCode === 200 &&
    r3.statusCode === 200 &&
    kept.enabled === false &&
    JSON.stringify(kept.minimum) === JSON.stringify({ USD: 250 }),
  kept,
);
const badCur = await patch(on, { minimum: { usd: 5 } });
const negative = await patch(on, { minimum: { USD: -1 } });
check(
  "a lower-case currency or a negative minimum → 400",
  badCur.statusCode === 400 && negative.statusCode === 400,
  [badCur.statusCode, negative.statusCode],
);
await patch(on, { enabled: true, minimum: {} });

// ── 3. On: the 24-hour rule, one invoice, at the old price ─────────────────────
console.log("3. setting on");
const a = await cancelledSub(on, "on", { units: 5 });
const aLate = await a.send(mid, 3, ago(1));
await pass(on);
check(
  "on: no invoice while the oldest late event was received less than 24 hours ago",
  (await lateInvoices(on, a.customer.id)).length === 0,
);
// A day later: the same event, received 25 hours ago.
await systemDb.execute(
  sql`update usage_events set id = ${uuidAt(ago(25))}::uuid where id = ${aLate}::uuid`,
);
await pass(on);
const [aInv, ...aMore] = await lateInvoices(on, a.customer.id);
const aLine = usageLines(aInv?.lines ?? [])[0];
check(
  `on: one invoice once it is 24 hours old, purpose late_usage, "Usage from ${PERIOD}" 3 × 10 = 30`,
  aMore.length === 0 &&
    aInv?.inv.purpose === "late_usage" &&
    aInv.inv.subscriptionId === a.sub.id &&
    usageLines(aInv.lines).length === 1 &&
    aLine?.description.startsWith(`Usage from ${PERIOD}`) === true &&
    Number(aLine.amountMinor) === 30 &&
    aLine.periodStart?.getTime() === S.getTime() &&
    aLine.periodEnd?.getTime() === E.getTime(),
  aInv && { inv: aInv.inv.purpose, lines: aInv.lines.map((l) => [l.description, l.amountMinor]) },
);
check(
  "the invoice is due on issue, takes no coupon and waits for the collect pump",
  aInv?.inv.status === "payment_due" &&
    aInv.inv.netTermDays == null &&
    !aInv.lines.some((l) => l.kind === "discount") &&
    aInv.inv.collectDueAt != null &&
    aInv.inv.attemptCount === 0,
  aInv && {
    status: aInv.inv.status,
    terms: aInv.inv.netTermDays,
    due: aInv.inv.collectDueAt,
  },
);
await pass(on);
check("a second pass adds nothing", (await lateInvoices(on, a.customer.id)).length === 1);

// Collection: the pump charges it once.
await pumpCollect(on.orgId, aInv!.inv.id);
const [aPaid] = await systemDb.select().from(invoices).where(eq(invoices.id, aInv!.inv.id));
const aPays = await systemDb.select().from(payments).where(eq(payments.invoiceId, aInv!.inv.id));
check(
  "card on file, auto-collection on: the collect pump charges it once and it is paid",
  aPaid?.status === "paid" && aPays.length === 1,
  { status: aPaid?.status, payments: aPays.length },
);

// A second late event the same day waits for the next day (the clock is pinned, as a travel
// pins it, so only the one-a-day rule can hold it).
await a.send(mid, 2, Date.now());
await pass(on, new Date(Date.now() + HOUR));
check(
  "a second late event within 24 hours of the last late-usage invoice raises none",
  (await lateInvoices(on, a.customer.id)).length === 1,
);
await pass(on, new Date(Date.now() + 25 * HOUR));
const aAll = await lateInvoices(on, a.customer.id);
check(
  "a day later it bills: 2 × 10 = 20 on a second invoice",
  aAll.length === 2 && Number(usageLines(aAll[1]!.lines)[0]?.amountMinor) === 20,
  aAll.map((x) => x.lines.map((l) => [l.description, l.amountMinor])),
);

// Tiers re-rate the whole period at its stored pricing.
const t = await cancelledSub(on, "tiers", {
  units: 90,
  price: {
    model: "tiered",
    unitAmountDecimal: undefined,
    meterTiers: [
      { up_to: "100", unit_amount_decimal: "10" },
      { up_to: null, unit_amount_decimal: "5" },
    ],
  },
});
await t.send(mid, 30, ago(25));
await pass(on);
const [tInv] = await lateInvoices(on, t.customer.id);
check(
  "graduated (100 at 10, then 5): 90 billed, 30 late → 200 = rate(120) − 900",
  Number(usageLines(tInv?.lines ?? [])[0]?.amountMinor) === 200,
  tInv?.lines.map((l) => [l.description, l.amountMinor]),
);

// ── 4. Collection: a declined card, auto-collection off ───────────────────────
console.log("4. collection");
const d = await cancelledSub(on, "decline", { units: 0, token: "4000000000009995" });
await d.send(mid, 4, ago(25));
await pass(on);
const [dInv] = await lateInvoices(on, d.customer.id);
await pumpCollect(on.orgId, dInv!.inv.id);
const [dAfter] = await systemDb.select().from(invoices).where(eq(invoices.id, dInv!.inv.id));
const dEvents = (await systemDb.execute(sql`
  select type from events where business_id = ${on.biz.id}
    and data::text like ${`%${dInv!.inv.publicId}%`}`)) as unknown as Array<{ type: string }>;
const [dSub] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, d.sub.id));
check(
  "a declined card leaves it unpaid: not_paid, no next attempt, no dunning",
  dAfter?.status === "not_paid" && dAfter.nextAttemptAt == null && dAfter.dunningStatus == null,
  { status: dAfter?.status, next: dAfter?.nextAttemptAt, dunning: dAfter?.dunningStatus },
);
check(
  "no dunning event, no void or write-off, and the subscription is not touched",
  !dEvents.some((e) => /dunning|voided|written_off/.test(e.type)) &&
    !dAfter?.writtenOff &&
    dSub?.status === "cancelled",
  { events: dEvents.map((e) => e.type), sub: dSub?.status },
);
await runWithClockScope({ onlyBusinessId: on.biz.id }, () => runBillingClockTickOnce(() => {}));
const dPays = await systemDb.select().from(payments).where(eq(payments.invoiceId, dInv!.inv.id));
const [dLater] = await systemDb.select().from(invoices).where(eq(invoices.id, dInv!.inv.id));
check(
  "a later tick does not retry it",
  dPays.length === 1 && dLater?.status === "not_paid" && dLater.collectDueAt == null,
  { payments: dPays.length, status: dLater?.status },
);

const f = await cancelledSub(on, "offline", { units: 0, autoOff: true });
await f.send(mid, 4, ago(25));
await pass(on);
const [fInv] = await lateInvoices(on, f.customer.id);
check(
  "auto-collection off: issued unpaid, not in dunning, not queued for collection",
  fInv?.inv.status === "payment_due" &&
    fInv.inv.dunningStatus == null &&
    fInv.inv.nextAttemptAt == null &&
    fInv.inv.collectDueAt == null,
  fInv && {
    status: fInv.inv.status,
    dunning: fInv.inv.dunningStatus,
    next: fInv.inv.nextAttemptAt,
    due: fInv.inv.collectDueAt,
  },
);

// ── 5. A live subscription owns the meter; usage after the end; older than 35 days ──
console.log("5. ownership and limits");
const l = await cancelledSub(on, "live", { units: 5 });
const live = await createSubscription({
  ...on.ids,
  customerId: l.customer.id,
  now: new Date(),
  items: [{ price: l.price, quantity: 1 }],
});
await setTerm(live.subscription.id, E, E2);
await l.send(mid, 3, ago(25));
await pass(on);
await tick(on.biz.id);
const [lNext] = await invoicesOf(on.orgId, live.subscription.id);
check(
  "a new live subscription that bills the meter takes the late usage on its next invoice",
  (await lateInvoices(on, l.customer.id)).length === 0 &&
    Number(
      usageLines(lNext?.lines ?? []).find((x) => x.description.startsWith("Usage from "))
        ?.amountMinor,
    ) === 30,
  lNext?.lines.map((x) => [x.description, x.amountMinor]),
);

const g = await cancelledSub(on, "after", { units: 5 });
await g.send(new Date(E.getTime() + 30 * 60_000), 7, ago(25));
await pass(on);
check(
  "usage stamped after the subscription ended is not billed",
  (await lateInvoices(on, g.customer.id)).length === 0,
);

const tooOld = await app.inject({
  method: "POST",
  url: `/v1/businesses/${on.biz.publicId}/usage_events`,
  headers: { authorization: `Bearer ${on.org.secret}`, "content-type": "application/json" },
  payload: JSON.stringify({
    key: `old-${Date.now()}`,
    customer: g.customer.id,
    event_name: g.meter.eventName,
    properties: { tokens: 1 },
    timestamp: new Date(Date.now() - 36 * 24 * HOUR).toISOString(),
  }),
});
check(
  "an event older than 35 days → 422 timestamp_too_old",
  tooOld.statusCode === 422 && JSON.parse(tooOld.body).error?.code === "timestamp_too_old",
  [tooOld.statusCode, tooOld.body.slice(0, 200)],
);

// ── 6. The minimum ────────────────────────────────────────────────────────────
console.log("6. minimum");
const mb = await meterBusiness("Late Usage Minimum Org");
await patch(mb, { enabled: true, minimum: { USD: 100 } });
const m = await cancelledSub(mb, "minimum", { units: 5 });
await m.send(mid, 3, ago(25));
const mBefore = await pointerOf(m.customer.id, m.meter.id);
await pass(mb);
const mHeld = await pointerOf(m.customer.id, m.meter.id);
check(
  "below the minimum (30 < 100): no invoice and the pointer has not moved",
  (await lateInvoices(mb, m.customer.id)).length === 0 &&
    mHeld.cutoffAt?.getTime() === mBefore.cutoffAt?.getTime() &&
    mHeld.usageThrough?.getTime() === mBefore.usageThrough?.getTime() &&
    mHeld.lateCheckedAt != null,
  { before: mBefore.cutoffAt, after: mHeld.cutoffAt, checked: mHeld.lateCheckedAt },
);
// An hour later more late usage arrives and crosses it.
await systemDb
  .update(customerMeterBilling)
  .set({ lateCheckedAt: new Date(ago(2)) })
  .where(
    and(
      eq(customerMeterBilling.customerId, m.customer.id),
      eq(customerMeterBilling.meterId, m.meter.id),
    ),
  );
await m.send(mid, 8, ago(1));
await pass(mb);
const mAll = await lateInvoices(mb, m.customer.id);
check(
  "more late usage that crosses it: one invoice for all of it (11 × 10 = 110)",
  mAll.length === 1 &&
    usageLines(mAll[0]!.lines).length === 1 &&
    Number(usageLines(mAll[0]!.lines)[0]?.amountMinor) === 110,
  mAll.map((x) => x.lines.map((l2) => [l2.description, l2.amountMinor])),
);

// ── 7. A time-travelled business ──────────────────────────────────────────────
console.log("7. time travel");
const tt = await meterBusiness("Late Usage Travel Org");
await patch(tt, { enabled: true });
const v = await cancelledSub(tt, "travel", { units: 5 });
const genesis = new Date();
await startTimeTravel({ orgId: tt.orgId, bizId: tt.biz.id, genesisTime: genesis });
await v.send(mid, 3, Date.now());
await travelForward({
  orgId: tt.orgId,
  bizId: tt.biz.id,
  toTime: new Date(genesis.getTime() + 24 * HOUR),
});
const [vInv] = await lateInvoices(tt, v.customer.id);
check(
  "time travel: an advance bills late usage received seconds ago (the 24-hour rule is met under the pin)",
  vInv?.inv.purpose === "late_usage" && Number(usageLines(vInv.lines)[0]?.amountMinor) === 30,
  vInv?.lines.map((x) => [x.description, x.amountMinor]),
);

// ── 8. wait_hours and min_interval_hours ─────────────────────────────────────
console.log("8. the wait and the interval");
const wi = await meterBusiness("Late Usage Times Org");
const badWait = await patch(wi, { wait_hours: 0 });
const badGap = await patch(wi, { min_interval_hours: 721 });
const okTimes = await patch(wi, { enabled: true, wait_hours: 2, min_interval_hours: 6 });
check(
  "wait_hours 0 and min_interval_hours 721 → 400; 2 and 6 round-trip",
  badWait.statusCode === 400 &&
    badGap.statusCode === 400 &&
    okTimes.statusCode === 200 &&
    (await stored(wi)).wait_hours === 2 &&
    (await stored(wi)).min_interval_hours === 6,
  [badWait.statusCode, badGap.statusCode, okTimes.statusCode, await stored(wi)],
);
const w = await cancelledSub(wi, "times", { units: 5 });
const wLate = await w.send(mid, 3, ago(1));
await pass(wi);
check(
  "wait_hours 2: no invoice while the oldest late event is 1 hour old",
  (await lateInvoices(wi, w.customer.id)).length === 0,
);
await systemDb.execute(
  sql`update usage_events set id = ${uuidAt(ago(3))}::uuid where id = ${wLate}::uuid`,
);
await pass(wi);
check(
  "wait_hours 2: one invoice once it is 3 hours old",
  (await lateInvoices(wi, w.customer.id)).length === 1,
);
await w.send(mid, 2, Date.now());
await pass(wi, new Date(Date.now() + 2 * HOUR));
check(
  "min_interval_hours 6: none 2 hours after the last late-usage invoice",
  (await lateInvoices(wi, w.customer.id)).length === 1,
);
await pass(wi, new Date(Date.now() + 7 * HOUR));
const wAll = await lateInvoices(wi, w.customer.id);
check(
  "min_interval_hours 6: a second invoice 7 hours later (2 × 10 = 20)",
  wAll.length === 2 && Number(usageLines(wAll[1]!.lines)[0]?.amountMinor) === 20,
  wAll.map((x) => [x.inv.originToken, x.lines.map((l) => [l.description, l.amountMinor])]),
);

await app.close();
console.log("");
console.log(
  fails.length === 0
    ? "✅ LATE USAGE INVOICE: PASS"
    : `❌ LATE USAGE INVOICE: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
