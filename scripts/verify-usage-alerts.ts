/**
 * Usage alerts and runway (design G5 §3.4–3.5, §8): one jump fires each threshold once, a
 * second crossing in the period is silent, a top-up resolves a balance alert, the period
 * roll resolves with `period_ended` and the next period re-arms, the states read comes from
 * the state rows, a plan alert covers a later subscription, email only when asked, runway.
 *
 *   pnpm verify:all:fresh -- --suite usage-alerts
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createPromotionalGrant } from "@/modules/credits/service";
import { createAlert, getAlert, alertStates } from "@/modules/usage-controls/alerts";
import { createSpendLimit } from "@/modules/usage-controls/limits";
import { evaluateCustomer, runUsageControlsCheck } from "@/modules/usage-controls/check";
import { createCreditHold } from "@/modules/credits/holds";
import { runUsageAlertsPass } from "@/modules/usage-controls/alerts-pass";
import { measureRunway } from "@/modules/usage-controls/measure";
import { emailTypeForEvent } from "@/modules/emails/outbox";
import { events, usageAlertStates, usageControlDirty } from "@db/schema";
import {
  checker,
  createTestMeter,
  meterBusiness,
  newCustomer,
  sendEvent,
  setTerm,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const { org, orgId, biz, ids, product } = await meterBusiness("Usage Alerts Org");
const meter = await createTestMeter(ids);
const H = 3_600_000;
const D = 24 * H;
const price = await createPrice({
  ...ids,
  productId: product.id,
  id: `ua-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: meter.key,
  unitAmountDecimal: "1",
});

async function subscribed(tag: string, termStart = new Date(Date.now() - H)) {
  const c = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, termStart, new Date(Date.now() + 40 * D));
  return { c, sub: sub.subscription };
}
const record = (customerId: string, tokens: number, at = new Date(Date.now() - 5 * 60_000)) =>
  sendEvent(ids, { customerId, eventName: meter.eventName, at, properties: { tokens } });
const evaluate = (customerId: string, now?: Date) =>
  runWithClockScope({ onlyBusinessId: biz.id, ...(now ? { now } : {}) }, () =>
    evaluateCustomer({ ...ids, customerId }),
  );
const alertEvents = async (alertPublicId: string, type: string) =>
  systemDb
    .select({ data: events.data, createdAt: events.createdAt })
    .from(events)
    .where(
      and(
        eq(events.businessId, biz.id),
        eq(events.type, type as never),
        sql`${events.data} -> 'usage_alert' ->> 'id' = ${alertPublicId}`,
      ),
    );
const states = (alertPublicId: string, customerId: string, now?: Date) =>
  runWithClockScope({ onlyBusinessId: biz.id, ...(now ? { now } : {}) }, () =>
    withTenant(orgId, async (tx) => {
      const a = await getAlert(tx, biz.id, alertPublicId);
      return alertStates(tx, a!, customerId);
    }),
  );
const grant = (publicId: string, amount: number) =>
  createPromotionalGrant({
    ...ids,
    customerPublicId: publicId,
    currency: "USD",
    amount: BigInt(amount),
    effectiveAt: new Date(Date.now() - 60 * D),
  });

// ── 1. One jump crosses 50 / 80 / 100 % of the limit ────────────────────────────
console.log("1. one jump, three thresholds");
const j = await subscribed("jump");
await createSpendLimit({
  ...ids,
  customerId: j.c.id,
  fields: {
    scope: "customer",
    interval: "month",
    amountMinor: 1000n,
    currency: "USD",
    mode: "soft",
    setBy: "operator",
  },
});
const spendAlert = await createAlert({
  ...ids,
  fields: {
    kind: "spend",
    scope: "customer",
    customerId: j.c.id,
    interval: "month",
    currency: "USD",
    thresholds: [
      { value: 50, unit: "percent" },
      { value: 80, unit: "percent" },
      { value: 100, unit: "percent" },
    ],
    email: true,
  },
});
await record(j.c.id, 1000);
await evaluate(j.c.id);
const fired = await alertEvents(spendAlert.publicId, "usage_alert_triggered");
const firedValues = fired
  .map((e) => (e.data as { threshold: { value: number } }).threshold.value)
  .sort((a, b) => a - b);
check(
  "1,000 of a 1,000 limit in one jump → 50, 80 and 100 % each fire once",
  JSON.stringify(firedValues) === "[50,80,100]",
  firedValues,
);
await record(j.c.id, 10);
await evaluate(j.c.id);
check(
  "a second evaluation in the period fires nothing",
  (await alertEvents(spendAlert.publicId, "usage_alert_triggered")).length === 3,
);
const s1 = await states(spendAlert.publicId, j.c.id);
check(
  "states read: three thresholds triggered, with the last value",
  s1[0]?.thresholds.every((t) => t.state === "triggered" && t.last_value === 1000) === true,
  s1,
);
// The read comes from the state rows, not the events: change a row, the read follows.
await systemDb
  .update(usageAlertStates)
  .set({ resolvedAt: new Date(), resolveReason: "recovered" })
  .where(and(eq(usageAlertStates.alertId, spendAlert.id), sql`${usageAlertStates.threshold} = 50`));
const s2 = await states(spendAlert.publicId, j.c.id);
check(
  "states read follows the state rows (50 % resolved, no event says so)",
  s2[0]?.thresholds.find((t) => t.value === 50)?.state === "resolved" &&
    s2[0]?.thresholds.find((t) => t.value === 80)?.state === "triggered",
  s2,
);
check(
  "email only when the alert asks: email:true maps to usage_alert",
  fired.every(
    (e) =>
      emailTypeForEvent({
        ...(e as object),
        type: "usage_alert_triggered",
        data: e.data,
      } as never) === "usage_alert",
  ),
);
check(
  "…and email:false maps to no mail",
  emailTypeForEvent({
    type: "usage_alert_triggered",
    data: { ...(fired[0]!.data as object), email: false },
  } as never) === null,
);

// ── 2. Period roll resolves; the next period re-arms ────────────────────────────
console.log("2. period roll");
const nextMonth = new Date(Date.now() + 32 * D);
const roll = await runWithClockScope({ onlyBusinessId: biz.id, now: nextMonth }, () =>
  runUsageAlertsPass(nextMonth),
);
const resolvedEv = await alertEvents(spendAlert.publicId, "usage_alert_resolved");
check(
  "the pass after the month ends resolves the two open thresholds with period_ended",
  roll.resolved >= 2 &&
    resolvedEv.filter((e) => (e.data as { reason: string }).reason === "period_ended").length === 2,
  { roll, n: resolvedEv.length },
);
await record(j.c.id, 600, new Date(nextMonth.getTime() - 60_000));
await evaluate(j.c.id, nextMonth);
const fired2 = await alertEvents(spendAlert.publicId, "usage_alert_triggered");
check(
  "the next period re-arms: 600 of 1,000 fires 50 % again",
  fired2.length === 4 &&
    (fired2.at(-1)?.data as { threshold: { value: number } } | undefined)?.threshold.value === 50,
  fired2.map((e) => (e.data as { threshold: { value: number } }).threshold.value),
);
const s3 = await states(spendAlert.publicId, j.c.id, nextMonth);
check(
  "states read in the new period: 50 % triggered, 80 and 100 % armed",
  s3[0]?.thresholds.map((t) => t.state).join(",") === "triggered,armed,armed",
  s3[0]?.thresholds,
);

// ── 3. A balance alert: fires, a top-up resolves it, a second fall is silent ────
console.log("3. balance");
const b = await subscribed("balance");
await grant(b.c.publicId, 1000);
const balAlert = await createAlert({
  ...ids,
  fields: {
    kind: "credit_balance",
    scope: "customer",
    customerId: b.c.id,
    currency: "USD",
    thresholds: [{ value: 200, unit: "minor" }],
  },
});
await evaluate(b.c.id);
check(
  "balance 1,000 above 200: nothing fires",
  (await alertEvents(balAlert.publicId, "usage_alert_triggered")).length === 0,
);
await record(b.c.id, 900);
await evaluate(b.c.id);
check(
  "balance falls to 100 → triggered",
  (await alertEvents(balAlert.publicId, "usage_alert_triggered")).length === 1,
);
await grant(b.c.publicId, 1000);
await evaluate(b.c.id);
const balRes = await alertEvents(balAlert.publicId, "usage_alert_resolved");
check(
  "a top-up to 1,100 resolves it (recovered)",
  balRes.length === 1 && (balRes[0]!.data as { reason: string }).reason === "recovered",
  balRes.map((e) => e.data),
);
await record(b.c.id, 1000);
await evaluate(b.c.id);
check(
  "falling below 200 again in the same month fires nothing",
  (await alertEvents(balAlert.publicId, "usage_alert_triggered")).length === 1,
);
const bs = await states(balAlert.publicId, b.c.id);
check("states read: the threshold is resolved", bs[0]?.thresholds[0]?.state === "resolved", bs);

// A hold alone moves the balance: no webhook endpoint lists hold events here.
const hb0 = await subscribed("hold-balance");
await grant(hb0.c.publicId, 1000);
const holdAlert = await createAlert({
  ...ids,
  fields: {
    kind: "credit_balance",
    scope: "customer",
    customerId: hb0.c.id,
    currency: "USD",
    thresholds: [{ value: 200, unit: "minor" }],
  },
});
const checkNow = () => runWithClockScope({ onlyBusinessId: biz.id }, () => runUsageControlsCheck());
await checkNow();
await createCreditHold({ ...ids, customerId: hb0.c.id, amountMinor: 900n });
const [holdMark] = await systemDb
  .select()
  .from(usageControlDirty)
  .where(eq(usageControlDirty.customerId, hb0.c.id));
await checkNow();
check(
  "a hold that drops the balance to 100 marks the customer and fires the alert on the next check",
  !!holdMark && (await alertEvents(holdAlert.publicId, "usage_alert_triggered")).length === 1,
  { marked: !!holdMark },
);

// ── 4. A plan alert covers a subscription created later ─────────────────────────
console.log("4. plan alert");
const planAlert = await createAlert({
  ...ids,
  fields: {
    kind: "usage_quantity",
    scope: "plan",
    productId: product.id,
    meterId: meter.id,
    interval: "month",
    thresholds: [{ value: 100, unit: "units" }],
  },
});
const late = await subscribed("late");
await record(late.c.id, 150);
await evaluate(late.c.id);
const pf = await alertEvents(planAlert.publicId, "usage_alert_triggered");
check(
  "a subscription created after the plan alert triggers it, named on the event",
  pf.length === 1 && (pf[0]!.data as { subscription: string }).subscription === late.sub.publicId,
  pf.map((e) => e.data),
);
check(
  "email:false (the default) → no mail",
  emailTypeForEvent({ type: "usage_alert_triggered", data: pf[0]!.data } as never) === null,
);
const app = await buildApp({ logger: false });
const http = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/usage_alerts/${planAlert.publicId}/states?customer=${late.c.publicId}`,
  headers: { authorization: `Bearer ${org.secret}` },
});
const hb = JSON.parse(http.body);
check(
  "GET …/usage_alerts/:alert/states?customer= answers per subscription",
  http.statusCode === 200 &&
    hb.data?.[0]?.subscription === late.sub.publicId &&
    hb.data?.[0]?.thresholds?.[0]?.state === "triggered",
  http.body,
);
const noCus = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/usage_alerts/${planAlert.publicId}/states`,
  headers: { authorization: `Bearer ${org.secret}` },
});
check("a plan alert's states without customer → 400", noCus.statusCode === 400, noCus.body);

// ── 5. Runway ───────────────────────────────────────────────────────────────────
console.log("5. runway");
const fresh = await subscribed("runway-fresh");
await grant(fresh.c.publicId, 5000);
await record(fresh.c.id, 100, new Date(Date.now() - 2 * H));
const r0 = await withTenant(orgId, (tx) =>
  measureRunway(tx, { businessId: biz.id, customerId: fresh.c.id, currency: "USD" }),
);
check("under 24 h of usage → runway null (not enough usage)", r0.runwayDays === null, r0);
const week = await subscribed("runway-week", new Date(Date.now() - 8 * D));
await grant(week.c.publicId, 7000);
for (let d = 6; d >= 0; d--) await record(week.c.id, 200, new Date(Date.now() - d * D - 2 * H));
const r1 = await withTenant(orgId, (tx) =>
  measureRunway(tx, { businessId: biz.id, customerId: week.c.id, currency: "USD" }),
);
// 1,400 spent in 7 days → burn 200/day; balance 7,000 − 1,400 = 5,600 → 28 days.
check(
  "7-day fixture: burn 200/day, balance 5,600 → runway 28 days",
  r1.runwayDays === 28 && r1.burnMinorPerDay === 200n && r1.balanceMinor === 5600n,
  r1,
);
const rh = await app.inject({
  method: "GET",
  url: `/v1/businesses/${biz.publicId}/customers/${week.c.publicId}/credit_runway?currency=USD`,
  headers: { authorization: `Bearer ${org.secret}` },
});
check(
  "GET …/customers/:cus/credit_runway → 28 days, labelled an estimate",
  rh.statusCode === 200 &&
    JSON.parse(rh.body).runway_days === 28 &&
    JSON.parse(rh.body).estimate === true,
  rh.body,
);
const runAlert = await createAlert({
  ...ids,
  fields: {
    kind: "credit_runway",
    scope: "customer",
    customerId: week.c.id,
    currency: "USD",
    thresholds: [{ value: 30, unit: "days" }],
  },
});
await evaluate(week.c.id);
check(
  "a runway alert at 30 days fires at 28",
  (await alertEvents(runAlert.publicId, "usage_alert_triggered")).length === 1,
);

await app.close();
await closeDb();
if (fails.length) {
  console.log(`\n❌ USAGE-ALERTS: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ USAGE-ALERTS: PASS");
process.exit(0);
