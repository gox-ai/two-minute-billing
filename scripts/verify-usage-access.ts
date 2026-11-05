/**
 * The access check (design G3 §3.9, §9): each of the six codes from its own fixture, the order
 * of evaluation, the policy ladder (C2) rung by rung, an expired customer override, a used-up
 * block grant, the overdraft limit, a meter feature that counts usage, the usage-key lookup and
 * the no-op spend-limit hook.
 *
 *   pnpm verify:all:fresh -- --suite usage-access
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addUsageKey, createMeter } from "@/modules/metering/meters";
import { foldBusiness } from "@/modules/metering/fold";
import { ingestUsageEvents, voidUsageEvent } from "@/modules/metering/ingest";
import {
  checkEntitlement,
  createFeature,
  setPlanEntitlement,
} from "@/modules/entitlements/service";
import { createPromotionalGrant } from "@/modules/credits/service";
import { checkAccess } from "@/modules/credits/access";
import { createCreditHold, expireCreditHolds } from "@/modules/credits/holds";
import { runWithClockScope } from "@/platform/clock";
import {
  defaultSpendLimitEvaluator,
  setSpendLimitEvaluator,
  spendLimitEvaluator,
} from "@/modules/credits/spend-limits";
import {
  businesses,
  customers,
  features,
  meters,
  prices,
  subscriptions,
  timeTravels,
  usageRollupState,
} from "@db/schema";
import {
  checker,
  createTestMeter,
  meterBusiness,
  newCustomer,
  invoicesOf,
  sendEvent,
  setTerm,
  tick,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const { org, orgId, biz, ids, product } = await meterBusiness("Usage Access Org");
const meter = await createTestMeter(ids);
const otherMeter = await createTestMeter(ids);
const H = 3_600_000;
const meterPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `acc-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: meter.key,
  unitAmountDecimal: "1",
});
const planPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `acc-plan-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});

const setConfig = (cfg: Record<string, unknown> | null) =>
  systemDb.update(businesses).set({ creditConfig: cfg }).where(eq(businesses.id, biz.id));
const setSettings = (customerId: string, st: Record<string, unknown> | null) =>
  systemDb.update(customers).set({ creditSettings: st }).where(eq(customers.id, customerId));

async function subscribed(tag: string, opts: { plan?: boolean } = {}) {
  const c = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [
      { price: meterPrice, quantity: 1 },
      ...(opts.plan ? [{ price: planPrice, quantity: 1 }] : []),
    ],
  });
  await setTerm(sub.subscription.id, new Date(Date.now() - H), new Date(Date.now() + 20 * 24 * H));
  return c;
}
const recordTokens = (customerId: string, tokens: number) =>
  sendEvent(ids, {
    customerId,
    eventName: meter.eventName,
    at: new Date(Date.now() - 5 * 60_000),
    properties: { tokens },
  });
const grant = (
  c: { publicId: string },
  amount: number,
  onExhausted: "block" | "bill" | null = null,
) =>
  createPromotionalGrant({
    ...ids,
    customerPublicId: c.publicId,
    currency: "USD",
    amount: BigInt(amount),
    onExhausted,
    effectiveAt: new Date(Date.now() - 60_000),
  });
const access = (customerId: string, extra: { estimate?: number; meter?: string | null } = {}) =>
  checkAccess({
    ...ids,
    customerId,
    meterKey: extra.meter === undefined ? meter.key : extra.meter,
    estimateMinor: extra.estimate != null ? BigInt(extra.estimate) : null,
  });

// ── 1. The six codes ─────────────────────────────────────────────────────────────
console.log("1. codes");
await setConfig({ blocking_enabled: true, on_exhausted_default: "block" });
const okC = await subscribed("ok");
await grant(okC, 1000);
const r1 = await access(okC.id, { estimate: 10 });
check(
  "ok: funded and subscribed",
  r1.code === "ok" && r1.allowed && r1.available_minor === 1000,
  r1,
);

const lone = await newCustomer(ids, "lone");
check("no_subscription: no live subscription", (await access(lone.id)).code === "no_subscription");
check(
  "no_subscription: a subscription that does not bill this meter",
  (await access(okC.id, { meter: otherMeter.key })).code === "no_subscription",
);
check(
  "order: unsubscribed and out of credit → no_subscription first",
  (await access(lone.id, { estimate: 5 })).code === "no_subscription",
);

const feat = await createFeature({
  ...ids,
  key: `tokens_${Date.now()}`,
  name: "Tokens",
  type: "meter",
  meterId: meter.id,
});
await setPlanEntitlement({ ...ids, productId: product.id, featureId: feat.id, value: "100" });
const ent = await subscribed("ent");
await grant(ent, 10_000);
await recordTokens(ent.id, 99);
const e1 = await access(ent.id);
check(
  "a meter feature below its limit allows (99 + 1 ≤ 100)",
  e1.code === "ok" && e1.entitlement?.used === "99",
  e1.entitlement,
);
await recordTokens(ent.id, 1);
const e2 = await access(ent.id);
check(
  "not_entitled: usage this period + 1 over the limit",
  e2.code === "not_entitled" && e2.entitlement?.used === "100",
  e2,
);
const [entSub] = await systemDb
  .select({ id: subscriptions.id })
  .from(subscriptions)
  .where(eq(subscriptions.customerId, ent.id));
const ce = await checkEntitlement(orgId, entSub!.id, feat.key);
check(
  "checkEntitlement counts usage for a meter feature (used 100 of 100 → over_limit)",
  ce.entitled === false && ce.used === "100",
  ce,
);

check("the no-op spend-limit hook returns []", (await access(okC.id)).limits.length === 0);
setSpendLimitEvaluator({
  evaluate: async () => [
    {
      id: "slim_x",
      limit: "slim_x",
      scope: "customer",
      property_key: null,
      property_value: null,
      interval: "day",
      mode: "hard",
      set_by: "operator",
      source: "limit",
      amount_minor: 10,
      limit_minor: 10,
      spent_minor: 10,
      open_holds_minor: 0,
      resets_at: null,
      reached: true,
      status: "reached",
    },
  ],
});
check(
  "spend_limit_reached: a limit reports reached",
  (await access(okC.id)).code === "spend_limit_reached",
);
setSpendLimitEvaluator(null);
check(
  "the evaluator resets to the default (usage controls)",
  spendLimitEvaluator() === defaultSpendLimitEvaluator,
);

const fl = await subscribed("flight");
await grant(fl, 1000);
await createCreditHold({ ...ids, customerId: fl.id, amountMinor: 400n, meterKey: meter.key });
const f1 = await access(fl.id, { estimate: 150 });
check("in_flight_limit: open 400 + estimate 150 > 50% of 1,000", f1.code === "in_flight_limit", f1);
check("without an estimate the in-flight rule does not apply", (await access(fl.id)).code === "ok");

const broke = await subscribed("broke");
check(
  "insufficient_credit: blocking, no credit",
  (await access(broke.id)).code === "insufficient_credit",
);

// ── 2. The policy ladder (C2) ────────────────────────────────────────────────────
console.log("2. policy ladder");
const lad = await subscribed("ladder", { plan: true });
await grant(lad, 10, "block");
await recordTokens(lad.id, 10); // the block grant is used up
await setConfig({ blocking_enabled: false, on_exhausted_default: "block" });
const p0 = await access(lad.id);
check(
  "business blocking off → bill, even with a block grant",
  p0.code === "ok" && p0.on_exhausted.source === "business_blocking_off",
  p0.on_exhausted,
);
await setConfig({ blocking_enabled: true, on_exhausted_default: "bill" });
const p1 = await access(lad.id);
check(
  "a used-up block grant still blocks",
  p1.code === "insufficient_credit" && p1.on_exhausted.source === "grant",
  p1.on_exhausted,
);
await setSettings(lad.id, { on_exhausted: "bill" });
const p2 = await access(lad.id);
check(
  "customer override bill beats a block grant",
  p2.code === "ok" && p2.on_exhausted.source === "customer_override",
  p2.on_exhausted,
);
await setSettings(lad.id, {
  on_exhausted: "bill",
  override_expires_at: new Date(Date.now() - 60_000).toISOString(),
});
const p3 = await access(lad.id);
check(
  "an expired override falls through to the block grant",
  p3.code === "insufficient_credit" && p3.on_exhausted.source === "grant",
  p3.on_exhausted,
);
await setSettings(lad.id, null);
await systemDb
  .update(prices)
  .set({ grantsCredit: { kind: "per_cycle", unit: null, amount: 1, on_exhausted: "bill" } })
  .where(eq(prices.id, planPrice.id));
const p4 = await access(lad.id);
check(
  "a block grant beats a plan bill",
  p4.on_exhausted.policy === "block" && p4.on_exhausted.source === "grant",
  p4.on_exhausted,
);
const plan = await subscribed("plan", { plan: true });
await systemDb
  .update(prices)
  .set({ grantsCredit: { kind: "per_cycle", unit: null, amount: 1, on_exhausted: "block" } })
  .where(eq(prices.id, planPrice.id));
const p5 = await access(plan.id);
check(
  "the plan price beats the business default (plan block, default bill)",
  p5.code === "insufficient_credit" && p5.on_exhausted.source === "plan_price",
  p5.on_exhausted,
);
await systemDb.update(prices).set({ grantsCredit: null }).where(eq(prices.id, planPrice.id));
const p6 = await access(plan.id);
check(
  "with nothing else set, the business default answers",
  p6.code === "ok" && p6.on_exhausted.source === "business_default",
  p6.on_exhausted,
);

// ── 3. The overdraft limit ───────────────────────────────────────────────────────
console.log("3. overdraft");
// The meter feature would answer not_entitled first; unlink it for this section.
await systemDb.update(features).set({ meterId: null }).where(eq(features.id, feat.id));
await setConfig({
  blocking_enabled: true,
  on_exhausted_default: "block",
  overdraft_limit_minor: { USD: 200 },
});
const od = await subscribed("od");
await recordTokens(od.id, 150);
const o1 = await access(od.id);
check(
  "150 of usage with an overdraft limit of 200: allowed (available 50)",
  o1.code === "ok" && o1.available_minor === 50,
  o1,
);
await recordTokens(od.id, 100);
const o2 = await access(od.id);
check(
  "250 of usage: below −200, refused",
  o2.code === "insufficient_credit" && o2.available_minor === -50,
  o2,
);

// ── 4. API: the customer and the usage-key routes ────────────────────────────────
console.log("4. API");
const app = await buildApp({ logger: false });
await addUsageKey({ ...ids, customerId: okC.id, key: `acct-${okC.id}` });
const get = (url: string) =>
  app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: { authorization: `Bearer ${org.secret}` },
  });
const a1 = await get(
  `/customers/${okC.publicId}/access?meter=${meter.key}&estimate=5&scope[model]=x`,
);
check(
  "GET …/customers/:cus/access answers 200 with a code",
  a1.statusCode === 200 && JSON.parse(a1.body).code === "ok",
  a1.body,
);
const a2 = await get(`/access?customer_key=acct-${okC.id}&meter=${meter.key}`);
check(
  "GET …/access?customer_key= finds the customer",
  a2.statusCode === 200 && JSON.parse(a2.body).customer === okC.publicId,
  a2.body,
);
const a3 = await get(`/access?customer_key=nobody&meter=${meter.key}`);
check("an unknown usage key → 404", a3.statusCode === 404);

// ── 5. Time travel: the access check and holds read the simulated clock ─────────
console.log("5. time travel");
await setConfig({ blocking_enabled: true, on_exhausted_default: "block" });
const tt = await subscribed("travel");
await setSettings(tt.id, {
  on_exhausted: "bill",
  override_expires_at: new Date(Date.now() + H).toISOString(),
});
const ttFunded = await subscribed("travel-hold");
await grant(ttFunded, 1000);
const ttHold = await createCreditHold({
  ...ids,
  customerId: ttFunded.id,
  amountMinor: 400n,
  meterKey: meter.key,
  expiresInSeconds: 600,
});
const t0 = JSON.parse((await get(`/customers/${tt.publicId}/access?meter=${meter.key}`)).body);
const h0 = JSON.parse(
  (await get(`/customers/${ttFunded.publicId}/access?meter=${meter.key}`)).body,
);
check(
  "wall clock: the override is live and the hold is open",
  t0.on_exhausted?.source === "customer_override" && h0.balance?.open_holds_minor === 400,
  { t0: t0.on_exhausted, h0: h0.balance },
);
const simulated = new Date(Date.now() + 2 * H);
await systemDb.insert(timeTravels).values({
  organizationId: orgId,
  businessId: biz.id,
  status: "succeeded",
  simulatedNow: simulated,
});
const t1 = JSON.parse((await get(`/customers/${tt.publicId}/access?meter=${meter.key}`)).body);
check(
  "simulated +2 h: the override has expired, so blocking applies",
  t1.code === "insufficient_credit" &&
    t1.on_exhausted?.source !== "customer_override" &&
    t1.as_of === simulated.toISOString(),
  t1,
);
const h1 = JSON.parse(
  (await get(`/customers/${ttFunded.publicId}/access?meter=${meter.key}`)).body,
);
check(
  "simulated +2 h: the 600 s hold no longer counts",
  h1.balance?.open_holds_minor === 0 && h1.available_minor === 1000,
  h1.balance,
);
const rel = await app.inject({
  method: "POST",
  url: `/v1/businesses/${biz.publicId}/credit_holds/${ttHold.hold.publicId}/release`,
  headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `tt-rel-${Date.now()}` },
});
check(
  "simulated +2 h: releasing the lapsed hold is refused (409)",
  rel.statusCode === 409,
  rel.body,
);
const realTick = await runWithClockScope({ excludeBusinessIds: [biz.id] }, () =>
  expireCreditHolds(new Date()),
);
const travelStep = await runWithClockScope({ onlyBusinessId: biz.id, now: simulated }, () =>
  expireCreditHolds(simulated),
);
check(
  "the expiry pass: a real tick skips the travelled business; its travel step expires the hold",
  realTick.expired === 0 && travelStep.expired >= 1,
  { realTick, travelStep },
);
await systemDb.delete(timeTravels).where(eq(timeTravels.businessId, biz.id));

// ── 6. Unfolded events count: the access check and the invoice read the raw tail ─
console.log("6. unfolded events");
await setConfig({ blocking_enabled: false });
const foldMeter = await createMeter({
  ...ids,
  key: `fold-${Date.now()}`,
  definition: {
    name: "Fold tokens",
    eventName: `fold_${Date.now()}`,
    aggregation: "sum",
    valueProperty: "tokens",
  },
});
// As if the meter had been created an hour ago with no events yet.
const hourAgo = new Date(Date.now() - H);
await systemDb
  .update(usageRollupState)
  .set({ watermark: hourAgo })
  .where(eq(usageRollupState.businessId, biz.id));
await systemDb.update(meters).set({ foldedFrom: hourAgo }).where(eq(meters.id, foldMeter.id));
const foldPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `acc-fold-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: foldMeter.key,
  unitAmountDecimal: "1",
});
const fc = await newCustomer(ids, "fold");
const fsub = await createSubscription({
  ...ids,
  customerId: fc.id,
  now: new Date(),
  items: [{ price: foldPrice, quantity: 1 }],
});
await setTerm(
  fsub.subscription.id,
  new Date(Date.now() - 24 * H),
  new Date(Date.now() + 20 * 24 * H),
);
const foldEvent = (tokens: number, atMin: number, receivedMin: number) =>
  sendEvent(ids, {
    customerId: fc.id,
    eventName: foldMeter.eventName,
    at: new Date(Date.now() - atMin * 60_000),
    properties: { tokens },
    receivedMs: Date.now() - receivedMin * 60_000,
  });
await foldEvent(100, 55, 50); // folded below
const folded = await foldBusiness({
  organizationId: orgId,
  businessId: biz.id,
  graceMs: 30 * 60_000,
});
await foldEvent(40, 50, 10); // received after the watermark: not folded
const [mrow] = await systemDb.select().from(meters).where(eq(meters.id, foldMeter.id));
const [state] = await systemDb
  .select()
  .from(usageRollupState)
  .where(eq(usageRollupState.businessId, biz.id));
check(
  "fixture: the meter reads rollups, the first event is folded, the watermark is behind the second",
  !!mrow?.backfilledAt &&
    folded.folded >= 1 &&
    state!.watermark.getTime() < Date.now() - 20 * 60_000,
  { backfilled: mrow?.backfilledAt, folded, watermark: state?.watermark },
);
// Ingested now through the API path: received after the watermark, not folded.
const ingested = await ingestUsageEvents({
  ...ids,
  events: [
    {
      key: `fold-now-${Date.now()}`,
      customer: fc.publicId,
      event_name: foldMeter.eventName,
      timestamp: new Date(Date.now() - 48 * 60_000).toISOString(),
      properties: { tokens: "7" },
    },
  ],
});
const u1 = await access(fc.id, { meter: foldMeter.key });
check(
  "the access check counts folded + unfolded + just ingested usage (100 + 40 + 7)",
  ingested.every((r) => r.status === "created") &&
    u1.usage_this_period.quantity === "147" &&
    u1.cost_this_period_minor === 147,
  { ingested, usage: u1.usage_this_period, cost: u1.cost_this_period_minor },
);
// Close the period (past the usage-close delay) inside the newest event's 5-minute grace:
// the invoice bills what was received before its cutoff, folded or not.
await setTerm(
  fsub.subscription.id,
  new Date(Date.now() - 24 * H),
  new Date(Date.now() - 45 * 60_000),
);
await tick(biz.id);
const [{ lines: fLines } = { lines: [] }] = await invoicesOf(orgId, fsub.subscription.id);
const usageLine = fLines.find((l) => l.priceId === foldPrice.id);
check(
  "the invoice bills the folded and the unfolded event (140); the newest waits out its grace",
  usageLine?.amountMinor === 140n,
  fLines.map((l) => [l.description, l.amountMinor]),
);

// ── 7. The rollup read cache stays exact: a fold and a void show at once ─────────
console.log("7. rollup cache");
const gc = await newCustomer(ids, "cache");
const gsub = await createSubscription({
  ...ids,
  customerId: gc.id,
  now: new Date(),
  items: [{ price: foldPrice, quantity: 1 }],
});
await setTerm(
  gsub.subscription.id,
  new Date(Date.now() - 24 * H),
  new Date(Date.now() + 20 * 24 * H),
);
const cacheKey = `cache-${Date.now()}`;
const sentX = await ingestUsageEvents({
  ...ids,
  events: [
    {
      key: cacheKey,
      customer: gc.publicId,
      event_name: foldMeter.eventName,
      timestamp: new Date(Date.now() - 40 * 60_000).toISOString(),
      properties: { tokens: "100" },
    },
  ],
});
const qty = async () => (await access(gc.id, { meter: foldMeter.key })).usage_this_period.quantity;
const beforeFold = [await qty(), await qty()];
await foldBusiness({ organizationId: orgId, businessId: biz.id, graceMs: 0 });
const afterFold = await qty();
await voidUsageEvent({ ...ids, key: cacheKey, reason: "cache check" });
const afterVoid = await qty();
check(
  "a fold and a void change the access result at once (100 raw → 100 folded → 0 voided)",
  sentX[0]?.status === "created" &&
    beforeFold.every((q) => q === "100") &&
    afterFold === "100" &&
    afterVoid === "0",
  { sentX, beforeFold, afterFold, afterVoid },
);
await app.close();

await closeDb();
if (fails.length) {
  console.log(`\n❌ USAGE-ACCESS: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ USAGE-ACCESS: PASS");
process.exit(0);
