/**
 * Credit holds (design G3 §3.7, §9): parallel holds never overspend; the in-flight share;
 * capture above the hold into the overdraft limit and the `overdraft` flag past it; capture and
 * event commit together; a lapsed hold stops counting before the pass; a replayed
 * Idempotency-Key; final holds; the default and maximum TTL; scope; hold events reach the
 * outbox only when an endpoint lists them (C5).
 *
 *   pnpm verify:all:fresh -- --suite credit-holds
 */
import { eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createEndpoint, updateEndpoint } from "@/modules/webhooks/endpoints";
import { clearSubscribedEventTypes } from "@/modules/webhooks/subscribed-types";
import { createPromotionalGrant } from "@/modules/credits/service";
import {
  captureCreditHold,
  createCreditHold,
  CreditRefusedError,
  expireCreditHolds,
  HoldFinalError,
  releaseCreditHold,
} from "@/modules/credits/holds";
import { liveBalance } from "@/modules/credits/balance";
import { businesses, creditHolds, customers, usageEvents } from "@db/schema";
import {
  checker,
  createTestMeter,
  meterBusiness,
  newCustomer,
  setTerm,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const { org, orgId, biz, ids, product } = await meterBusiness("Credit Holds Org");
const meter = await createTestMeter(ids);
// 1 minor unit per token.
const price = await createPrice({
  ...ids,
  productId: product.id,
  id: `holds-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: meter.key,
  unitAmountDecimal: "1",
});
const H = 3_600_000;

async function setConfig(cfg: Record<string, unknown>) {
  await systemDb.update(businesses).set({ creditConfig: cfg }).where(eq(businesses.id, biz.id));
}
await setConfig({ blocking_enabled: true, on_exhausted_default: "block" });

/** A subscribed customer with `credit` minor units of promotional credit. */
async function funded(tag: string, credit: number) {
  const c = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, new Date(Date.now() - H), new Date(Date.now() + 20 * 24 * H));
  if (credit > 0)
    await createPromotionalGrant({
      ...ids,
      customerPublicId: c.publicId,
      currency: "USD",
      amount: BigInt(credit),
      effectiveAt: new Date(Date.now() - 60_000),
    });
  return c;
}
const event = (
  c: { publicId: string },
  tokens: number,
  key = `ev-${Date.now()}-${Math.random()}`,
) => ({
  key,
  customer: c.publicId,
  event_name: meter.eventName,
  properties: { tokens: String(tokens) },
});
const heldSum = async (customerId: string) => {
  const [r] = (await systemDb.execute(
    sql`select coalesce(sum(amount_minor), 0)::text as s, count(*)::int as n from credit_holds
        where customer_id = ${customerId} and status = 'held'`,
  )) as unknown as Array<{ s: string; n: number }>;
  return { sum: Number(r!.s), n: r!.n };
};

// ── 1. 50 parallel holds never overspend ─────────────────────────────────────────
console.log("1. parallel holds");
await setConfig({
  blocking_enabled: true,
  on_exhausted_default: "block",
  in_flight_share_bps: 10_000,
});
const par = await funded("par", 1000);
const results = await Promise.allSettled(
  Array.from({ length: 50 }, () =>
    createCreditHold({ ...ids, customerId: par.id, amountMinor: 30n, meterKey: meter.key }),
  ),
);
const ok = results.filter((r) => r.status === "fulfilled").length;
const refused = results.filter(
  (r) => r.status === "rejected" && r.reason instanceof CreditRefusedError,
).length;
const held = await heldSum(par.id);
check("50 parallel holds of 30 against 1,000: at most 1,000 held", held.sum <= 1000, held);
check("exactly 33 holds are accepted, 17 refused with 402 codes", ok === 33 && refused === 17, {
  ok,
  refused,
});

// ── 2. in_flight_limit at 50% ────────────────────────────────────────────────────
console.log("2. in-flight share");
await setConfig({ blocking_enabled: true, on_exhausted_default: "block" });
const inf = await funded("inf", 1000);
const a = await createCreditHold({
  ...ids,
  customerId: inf.id,
  amountMinor: 300n,
  meterKey: meter.key,
});
const b = await createCreditHold({
  ...ids,
  customerId: inf.id,
  amountMinor: 250n,
  meterKey: meter.key,
}).catch((e) => e);
check("hold 300 of 1,000 is accepted", a.hold.status === "held");
check(
  "hold 250 more (550 > 500) is refused in_flight_limit",
  b instanceof CreditRefusedError && b.code === "in_flight_limit",
  String(b),
);

// ── 3. capture: above the hold, overdraft limit, overdraft flag ──────────────────
console.log("3. capture");
await setConfig({
  blocking_enabled: true,
  on_exhausted_default: "block",
  overdraft_limit_minor: { USD: 200 },
});
const cap = await captureCreditHold({
  ...ids,
  holdPublicId: a.hold.publicId,
  usageEvent: event(inf, 420),
});
const ctxOf = async (custId: string) => {
  const [r] = await systemDb
    .select({ cfg: businesses.creditConfig, st: customers.creditSettings })
    .from(customers)
    .innerJoin(businesses, eq(businesses.id, customers.businessId))
    .where(eq(customers.id, custId));
  return r!;
};
const bal = async (custId: string) => {
  const c = await ctxOf(custId);
  return withTenant(orgId, (tx) =>
    liveBalance(tx, {
      customerId: custId,
      currency: "USD",
      now: new Date(),
      businessConfig: c.cfg,
      customerSettings: c.st,
      rateUsage: true,
    }),
  );
};
const b1 = await bal(inf.id);
check(
  "capture of an event worth 420 on a 300 hold is accepted",
  cap.hold.status === "captured" && cap.hold.capturedMinor === 420n,
  cap.hold,
);
check(
  "balance 580, available 780 (overdraft limit 200)",
  b1.balanceMinor === 580n && b1.availableMinor === 780n,
  {
    balance: b1.balanceMinor,
    available: b1.availableMinor,
  },
);
check("within the limit the hold is not flagged overdraft", cap.hold.overdraft === false);
const c2 = await createCreditHold({
  ...ids,
  customerId: inf.id,
  amountMinor: 100n,
  meterKey: meter.key,
});
const cap2 = await captureCreditHold({
  ...ids,
  holdPublicId: c2.hold.publicId,
  usageEvent: event(inf, 900),
});
check(
  "a capture past the overdraft limit is accepted and flagged overdraft",
  cap2.hold.status === "captured" && cap2.hold.overdraft === true,
  cap2.hold,
);
const after = await createCreditHold({
  ...ids,
  customerId: inf.id,
  amountMinor: 1n,
  meterKey: meter.key,
}).catch((e) => e);
check(
  "past the overdraft limit a blocking hold is refused",
  after instanceof CreditRefusedError,
  String(after),
);

// ── 4. capture and event commit together ─────────────────────────────────────────
console.log("4. atomic capture");
const atom = await funded("atom", 1000);
const h4 = await createCreditHold({
  ...ids,
  customerId: atom.id,
  amountMinor: 50n,
  meterKey: meter.key,
});
const badKey = `ev-atomic-${Date.now()}`;
const bad = await captureCreditHold({
  ...ids,
  holdPublicId: h4.hold.publicId,
  usageEvent: { ...event(atom, 10, badKey), properties: { tokens: "1.0000000000001" } },
}).catch((e) => e);
const [stillHeld] = await systemDb.select().from(creditHolds).where(eq(creditHolds.id, h4.hold.id));
const [stored] = await systemDb
  .select({ id: usageEvents.id })
  .from(usageEvents)
  .where(eq(usageEvents.key, badKey));
check(
  "a refused event leaves the hold held and stores no event",
  bad instanceof Error && stillHeld?.status === "held" && !stored,
  { bad: String(bad), status: stillHeld?.status, stored },
);
// A failure after the ingest rolls back the event too: capture against another customer's hold.
const other = await funded("other", 1000);
const ho = await createCreditHold({
  ...ids,
  customerId: other.id,
  amountMinor: 50n,
  meterKey: meter.key,
});
const wrongKey = `ev-wrong-${Date.now()}`;
await captureCreditHold({
  ...ids,
  holdPublicId: ho.hold.publicId,
  usageEvent: event(atom, 10, wrongKey),
}).catch(() => null);
const [wrongStored] = await systemDb
  .select({ id: usageEvents.id })
  .from(usageEvents)
  .where(eq(usageEvents.key, wrongKey));
check("an event for another customer is refused and not stored", !wrongStored);

// ── 5. a lapsed hold stops counting before the pass; the pass expires it ─────────
console.log("5. expiry");
const lap = await funded("lap", 1000);
const h5 = await createCreditHold({
  ...ids,
  customerId: lap.id,
  amountMinor: 400n,
  meterKey: meter.key,
  expiresInSeconds: 1,
});
check("an open hold counts", (await bal(lap.id)).openHoldsMinor === 400n);
await new Promise((r) => setTimeout(r, 1_200));
check(
  "a lapsed hold stops counting before the pass runs",
  (await bal(lap.id)).openHoldsMinor === 0n,
);
await expireCreditHolds(new Date());
const [h5row] = await systemDb.select().from(creditHolds).where(eq(creditHolds.id, h5.hold.id));
check("the pass marks it expired", h5row?.status === "expired");
const second = await releaseCreditHold({ ...ids, holdPublicId: h5.hold.publicId }).catch((e) => e);
check(
  "release of a final hold → HoldFinalError with its status",
  second instanceof HoldFinalError && second.status === "expired",
);
const again = await captureCreditHold({
  ...ids,
  holdPublicId: cap.hold.publicId,
  usageEvent: event(inf, 1),
}).catch((e) => e);
check(
  "a second capture of a captured hold is refused",
  again instanceof HoldFinalError && again.status === "captured",
);

// ── 6. API: idempotent replay, default TTL, 24 h maximum, scope ─────────────────
console.log("6. API");
const app = await buildApp({ logger: false });
const api = await funded("api", 1000);
const post = (payload: object, key: string) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/customers/${api.publicId}/credit_holds`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": key },
    payload,
  });
const key = `hold-${Date.now()}`;
const r1 = await post({ amount_minor: 10, meter: meter.key, scope: { model: "gpt-x" } }, key);
const r2 = await post({ amount_minor: 10, meter: meter.key, scope: { model: "gpt-x" } }, key);
const j1 = JSON.parse(r1.body);
check("POST creates a hold (201)", r1.statusCode === 201, r1.body);
check(
  "a replayed Idempotency-Key returns the same hold",
  JSON.parse(r2.body).id === j1.id && (await heldSum(api.id)).n === 1,
);
const ttl = (Date.parse(j1.expires_at) - Date.parse(j1.created_at)) / 1000;
check("default TTL is 60 s", Math.abs(ttl - 60) < 2, ttl);
check("scope is stored and returned", j1.scope?.model === "gpt-x");
const r3 = await post({ amount_minor: 10, expires_in: 86_401 }, `${key}-long`);
check("expires_in above 86,400 → 400", r3.statusCode === 400, r3.body);
const r4 = await post({ amount_minor: 10, expires_in: 86_400 }, `${key}-max`);
check("expires_in of 86,400 is accepted", r4.statusCode === 201, r4.body);
const r5 = await app.inject({
  method: "POST",
  url: `/v1/businesses/${biz.publicId}/credit_holds/${j1.id}/capture`,
  headers: {
    authorization: `Bearer ${org.secret}`,
    "idempotency-key": `${key}-cap`,
    "content-type": "application/json",
  },
  payload: JSON.stringify({ usage_event: event(api, 7) }),
});
check(
  "capture over the API (exact JSON numbers)",
  r5.statusCode === 200 && JSON.parse(r5.body).captured_minor === 7,
  r5.body,
);
await app.close();

// ── 7. C5: hold events reach the outbox only when an endpoint lists them ─────────
console.log("7. hold events");
const evCount = async () => {
  const [r] = (await systemDb.execute(sql`select count(*)::int as n from events
    where organization_id = ${orgId} and type = 'credit_hold_created'`)) as unknown as Array<{
    n: number;
  }>;
  return r!.n;
};
await setConfig({ blocking_enabled: false });
const c5 = await funded("c5", 0);
const base = await evCount();
for (let i = 0; i < 100; i++)
  await createCreditHold({ ...ids, customerId: c5.id, amountMinor: 1n, meterKey: meter.key });
check(
  "no endpoint lists credit_hold_created → 0 events for 100 holds",
  (await evCount()) === base,
  { base, now: await evCount() },
);
const all = await createEndpoint({
  organizationId: orgId,
  url: "https://example.com/all",
  businessId: biz.id,
  livemode: "test",
});
await createCreditHold({ ...ids, customerId: c5.id, amountMinor: 1n, meterKey: meter.key });
check("an 'all events' endpoint still gets none", (await evCount()) === base);
await updateEndpoint(orgId, all.endpoint.publicId, { eventTypes: ["credit_hold_created"] });
await createCreditHold({ ...ids, customerId: c5.id, amountMinor: 1n, meterKey: meter.key });
await createCreditHold({ ...ids, customerId: c5.id, amountMinor: 1n, meterKey: meter.key });
check(
  "an endpoint that lists it gets each one (cache dropped on endpoint write)",
  (await evCount()) === base + 2,
  { base, now: await evCount() },
);
const [delivered] = (await systemDb.execute(sql`select count(*)::int as n from webhook_deliveries d
  join events e on e.id = d.event_id where e.organization_id = ${orgId} and e.type = 'credit_hold_created'`)) as unknown as Array<{
  n: number;
}>;
check("each listed hold event is queued for delivery", delivered!.n === 2, delivered);
clearSubscribedEventTypes(null);

await closeDb();
if (fails.length) {
  console.log(`\n❌ CREDIT-HOLDS: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ CREDIT-HOLDS: PASS");
process.exit(0);
