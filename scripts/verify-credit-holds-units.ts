/**
 * The access check, holds and the automatic top-up in a credit unit with no money rate (0527):
 *  - the access check answers in units, from the figure the gate offers, for a buyer with no
 *    subscription and for a subscriber; a meter with no credit cost answers as before;
 *  - a hold reserves units: no event and no other hold can spend them;
 *  - capture with fewer, equal and more units than held; release; expiry at the instant and by
 *    the pass; capture by key, also of an event the gate refused;
 *  - `capture_over_hold: cap_at_hold`: the event takes no more than the hold, the rest is a
 *    `forgiven` part with an audit row, also for an event the gate refused;
 *  - a hold in money does not cover an event of a meter that is paid in credits;
 *  - the open-holds share in units; parallel holds; holds against ingest and settlement;
 *  - a hold pins its grants: a grant that expires under an open hold;
 *  - leases: capture in steps, extend, release the rest, parallel steps;
 *  - the automatic top-up: the threshold, the charge, the grant on payment, a decline, the
 *    monthly cap, parallel creation, an event while a run is open;
 *  - hold expiry by the time-travel API; isolation between organizations;
 *  - an event refused for credit counts as cost and not as usage.
 * Every step runs at a pinned business time.
 *
 *   pnpm verify:all:fresh -- --suite credit-holds-units
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { runWithClockScope } from "@/platform/clock";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { startTimeTravel } from "@/modules/time-travel/service";
import { createPortalSession } from "@/modules/customer-portal/service";
import { createManualInvoice, recordOfflinePayment } from "@/modules/invoicing/ops";
import { ingestUsageEvents } from "@/modules/metering/ingest";
import { readMeterUsage } from "@/modules/metering/read";
import { foldUsageCostDays } from "@/modules/metering/cost-fold";
import { expireCreditHolds } from "@/modules/credits/holds";
import { liveBalance } from "@/modules/credits/balance";
import { runSettleCreditUsage } from "@/modules/credits/usage-settlement";
import { createRunFor, runCreditAutoTopups } from "@/modules/usage-controls/auto-topup";
import {
  auditLogs,
  businesses,
  creditAutoTopupRuns,
  creditAutoTopups,
  creditGrantGrace,
  creditGrants,
  creditHolds,
  creditUnitBalances,
  creditUnits,
  creditUsageEvents,
  creditUsageSettlements,
  events,
  invoices,
  paymentMethods,
  timeTravels,
  usageCostDaily,
} from "@db/schema";
import { checker, meterBusiness, newCustomer } from "./lib/meter-fixtures";

const { fails, check } = checker();
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Every instant below is this hour plus an offset.
const B = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const plus = (ms: number) => new Date(B.getTime() + ms);

const { org, orgId, biz, ids, product } = await meterBusiness("Credit Holds Units Org");
const app = await buildApp({ logger: false });
const at = <T>(t: Date, fn: () => Promise<T>, bizId = biz.id) =>
  runWithClockScope({ onlyBusinessId: bizId, now: t }, fn);

let keyN = 0;
const call = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: object,
  o: { biz?: string; secret?: string; key?: string } = {},
) =>
  app.inject({
    method,
    url: `/v1/businesses/${o.biz ?? biz.publicId}/${path}`,
    headers: {
      authorization: `Bearer ${o.secret ?? org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": o.key ?? `chu-${Date.now()}-${++keyN}` }),
    },
    ...(payload ? { payload } : {}),
  });
/** A setup call: throws when the status is not the expected one. */
const must = async (status: number, ...args: Parameters<typeof call>) => {
  const r = await call(...args);
  if (r.statusCode !== status)
    throw new Error(`${args[0]} ${args[1]} answered ${r.statusCode}, not ${status}: ${r.body}`);
  return JSON.parse(r.body);
};
type Res = { status: number; body: Record<string, any> };
const res = async (p: ReturnType<typeof call>): Promise<Res> => {
  const r = await p;
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : {} };
};

const rowsOf = <T>(r: unknown) => r as T[];
async function unbalanced(organizationId = orgId): Promise<number> {
  return rowsOf(
    await systemDb.execute(sql`
      select transaction_id from ledger_entries where organization_id = ${organizationId}
      group by transaction_id
      having sum(case when direction = 'debit' then amount_minor else -amount_minor end) <> 0`),
  ).length;
}
/**
 * The rule of the invariant `credit_unit_balance_matches_grants`: the row = Σ movements of the
 * grants in it − units taken and not settled − open grace rows, never below 0, and
 * `held_steps` = Σ open holds in the unit.
 */
async function drift(organizationId = orgId): Promise<unknown[]> {
  return rowsOf(
    await systemDb.execute(sql`
      select k.customer_id, coalesce(bal.available_steps, 0)::text as balance,
        (coalesce(g.steps, 0) - coalesce(t.steps, 0) - coalesce(gr.steps, 0))::text as expected,
        coalesce(bal.held_steps, 0)::text as held, coalesce(h.steps, 0)::text as open_holds
      from (
        select customer_id, unit_id from credit_unit_balances where organization_id = ${organizationId}
        union
        select customer_id, unit_id from credit_grants
        where organization_id = ${organizationId} and not unit_rated
        union
        select customer_id, unit_id from credit_holds
        where organization_id = ${organizationId} and unit_id is not null and status = 'held'
      ) k
      left join credit_unit_balances bal
        on bal.customer_id = k.customer_id and bal.unit_id = k.unit_id
      left join lateral (
        select sum(m.units) as steps from credit_grants cg
        join credit_grant_movements m on m.grant_id = cg.id
        where cg.customer_id = k.customer_id and cg.unit_id = k.unit_id and not cg.unit_rated
          and not cg.out_of_balance
      ) g on true
      left join lateral (
        select sum(c.units) as steps from credit_usage_events c
        where c.customer_id = k.customer_id and c.unit_id = k.unit_id
          and c.status in ('taken', 'pending')
      ) t on true
      left join lateral (
        select sum(x.available_steps) as steps from credit_grant_grace x
        where x.customer_id = k.customer_id and x.unit_id = k.unit_id and x.locked_at is null
      ) gr on true
      left join lateral (
        select sum(ch.remaining_units) as steps from credit_holds ch
        where ch.customer_id = k.customer_id and ch.unit_id = k.unit_id and ch.status = 'held'
      ) h on true
      left join lateral (
        select sum(p.held_steps) as steps from credit_grant_grace p
        where p.customer_id = k.customer_id and p.unit_id = k.unit_id and p.locked_at is null
      ) pin on true
      where coalesce(bal.available_steps, 0) + (select coalesce(sum(o.units), 0)
          from credit_usage_events o where o.customer_id = k.customer_id and o.unit_id = k.unit_id
            and o.source = 'overdraft' and o.status = 'taken') < 0
        or coalesce(bal.available_steps, 0)
          <> coalesce(g.steps, 0) - coalesce(t.steps, 0) - coalesce(gr.steps, 0)
        or coalesce(bal.held_steps, 0) <> coalesce(h.steps, 0)
        or coalesce(bal.pinned_steps, 0) <> coalesce(pin.steps, 0)`),
  );
}
const inStep = async (label: string, organizationId = orgId) => {
  const d = await drift(organizationId);
  check(`${label}: the balance row equals its rule, with the open holds`, d.length === 0, d);
  check(`${label}: every ledger transaction balances`, (await unbalanced(organizationId)) === 0);
};

const customer = (tag: string) =>
  createCustomer({ ...ids, email: `${tag}-${Date.now()}@example.com`, autoCollection: "off" });
let evN = 0;
type Sent = { status: string; key: string | null; error?: { code: string; message: string } };
const send = async (
  t: Date,
  c: { publicId: string },
  eventName: string,
  o: { key?: string; bizIds?: typeof ids; bizId?: string } = {},
): Promise<Sent> => {
  const [r] = await at(
    t,
    () =>
      ingestUsageEvents({
        ...(o.bizIds ?? ids),
        events: [
          {
            key: o.key ?? `chu-ev-${Date.now()}-${++evN}`,
            customer: c.publicId,
            event_name: eventName,
          },
        ],
      }),
    o.bizId,
  );
  return r as Sent;
};
const creditRows = (key: string) =>
  systemDb
    .select()
    .from(creditUsageEvents)
    .where(eq(creditUsageEvents.eventKey, key))
    .orderBy(creditUsageEvents.part);
const give = async (
  c: { publicId: string },
  amount: number,
  o: { effective_at?: Date; expires_at?: Date } = {},
) =>
  (await must(201, "POST", `customers/${c.publicId}/credit_grants`, {
    unit: "credit",
    amount,
    effective_at: (o.effective_at ?? plus(-DAY)).toISOString(),
    ...(o.expires_at ? { expires_at: o.expires_at.toISOString() } : {}),
  })) as { id: string };
const setConfig = (cfg: Record<string, unknown> | null, bizId = biz.id) =>
  systemDb.update(businesses).set({ creditConfig: cfg }).where(eq(businesses.id, bizId));

// ── Setup: a unit with no rate (1 decimal) and three meters ──────────────────────
await must(201, "POST", "credit_units", {
  id: "credit",
  name: "credit",
  plural_name: "credits",
  currency: "USD",
  minor_per_unit: null,
  decimals: 1,
});
const [unit] = await systemDb
  .select()
  .from(creditUnits)
  .where(and(eq(creditUnits.businessId, biz.id), eq(creditUnits.key, "credit")));
const unitId = unit!.id;
for (const [id, cost] of [
  ["illustration", "1"],
  ["render", "3"],
] as const) {
  await must(201, "POST", "meters", { id, name: id, event_name: id, aggregation: "count" });
  await must(200, "PUT", `meters/${id}/credit_cost`, { unit: "credit", credits_per_unit: cost });
}
// A meter with no credit cost: everything about it is as before.
await must(201, "POST", "meters", {
  id: "plain",
  name: "plain",
  event_name: "plain",
  aggregation: "count",
});
/** `available_steps` and `held_steps` of the customer's row. */
const row = async (customerId: string) => {
  const [r] = await systemDb
    .select()
    .from(creditUnitBalances)
    .where(
      and(eq(creditUnitBalances.customerId, customerId), eq(creditUnitBalances.unitId, unitId)),
    );
  return {
    available: r?.availableSteps ?? 0n,
    held: r?.heldSteps ?? 0n,
    pinned: r?.pinnedSteps ?? 0n,
  };
};
const holdRow = async (publicId: string) =>
  (await systemDb.select().from(creditHolds).where(eq(creditHolds.publicId, publicId)))[0]!;
const hold = (t: Date, c: { publicId: string }, payload: object, key?: string) =>
  at(t, () =>
    res(call("POST", `customers/${c.publicId}/credit_holds`, payload, key ? { key } : {})),
  );
const capture = (t: Date, id: string, payload: object, key?: string) =>
  at(t, () => res(call("POST", `credit_holds/${id}/capture`, payload, key ? { key } : {})));
const release = (t: Date, id: string) =>
  at(t, () => res(call("POST", `credit_holds/${id}/release`, {})));
const access = (t: Date, c: { publicId: string }, qs: string) =>
  at(t, () => res(call("GET", `customers/${c.publicId}/access?${qs}`)));
const ev = (c: { publicId: string }, name: string, key = `chu-cap-${Date.now()}-${++evN}`) => ({
  key,
  customer: c.publicId,
  event_name: name,
});
// The share is tested in § 6; elsewhere a hold may use the whole balance.
const OPEN = { in_flight_share_bps: 10_000, in_flight_applies: "other_holds_open" };
await setConfig(OPEN);

// ── 1. The access check in units ─────────────────────────────────────────────────
console.log("1. the access check in units");
{
  const T = plus(HOUR);
  const buyer = await customer("access-pack");
  await give(buyer, 50);
  const a = await access(T, buyer, "meter=illustration");
  check(
    "a buyer with no subscription: allowed, 5 credits, 4 left after one illustration",
    a.status === 200 &&
      a.body.allowed === true &&
      a.body.code === "ok" &&
      a.body.credits?.unit === "credit" &&
      a.body.credits.available === "5" &&
      a.body.credits.estimate === "1" &&
      a.body.credits.remaining === "4" &&
      a.body.credits.held === "0" &&
      a.body.credits.credits_per_unit === "1" &&
      a.body.credits.cost_source === "meter",
    a.body,
  );
  check(
    "a buyer with no subscription is always block",
    a.body.on_exhausted?.policy === "block" && a.body.on_exhausted.source === "no_subscription",
    a.body.on_exhausted,
  );
  const exact = await access(T, buyer, "meter=illustration&estimate_quantity=5");
  const over = await access(T, buyer, "meter=illustration&estimate_quantity=6");
  const inUnits = await access(T, buyer, "meter=illustration&estimate_units=5.1");
  check(
    "an estimate of the whole balance is allowed with 0 left; one more is insufficient_credit",
    exact.body.allowed === true &&
      exact.body.credits.remaining === "0" &&
      over.body.allowed === false &&
      over.body.code === "insufficient_credit" &&
      over.body.credits.estimate === "6" &&
      inUnits.body.code === "insufficient_credit" &&
      inUnits.body.credits.estimate === "5.1",
    { exact: exact.body.credits, over: over.body, inUnits: inUnits.body.credits },
  );
  const three = await access(T, buyer, "meter=render");
  check(
    "the default estimate is one event of the meter: a render costs 3",
    three.body.credits?.estimate === "3" && three.body.credits.remaining === "2",
    three.body.credits,
  );
  const money = await access(T, buyer, "meter=illustration&estimate=100");
  const both = await access(T, buyer, "meter=illustration&estimate_quantity=1&estimate_units=1");
  const fine = await access(T, buyer, "meter=illustration&estimate_units=0.25");
  check(
    "a money estimate, two estimates, and more decimals than the unit has are refused (400)",
    money.status === 400 && both.status === 400 && fine.status === 400,
    [money.status, both.status, fine.status],
  );
  const plain = await access(T, buyer, "meter=plain");
  const plainUnits = await access(T, buyer, "meter=plain&estimate_quantity=1");
  check(
    "a meter with no credit cost answers as before: no_subscription, no credits block",
    plain.body.code === "no_subscription" &&
      plain.body.credits === null &&
      plainUnits.status === 400,
    { plain: plain.body.code, credits: plain.body.credits, plainUnits: plainUnits.status },
  );
  const empty = await customer("access-empty");
  const none = await access(T, empty, "meter=illustration");
  check(
    "a customer with no credit: insufficient_credit, 0 available",
    none.body.code === "insufficient_credit" && none.body.credits.available === "0",
    none.body,
  );

  // A subscriber, blocking off (`bill`): short usage is still refused; the plan's cost applies.
  const member = await newCustomer(ids, "access-sub");
  const plan = await createPrice({
    ...ids,
    productId: product.id,
    id: `chu-plan-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    interval: "month",
    amountMinor: 1000,
  });
  await createSubscription({
    ...ids,
    customerId: member.id,
    now: new Date(),
    items: [{ price: plan, quantity: 1 }],
  });
  await give(member, 20);
  const m1 = await access(T, member, "meter=illustration&estimate_quantity=3");
  check(
    "a subscriber under bill: the policy is reported, and usage beyond the balance is refused",
    m1.body.on_exhausted?.policy === "bill" &&
      m1.body.on_exhausted.source === "business_blocking_off" &&
      m1.body.code === "insufficient_credit" &&
      m1.body.credits.available === "2",
    m1.body,
  );
  await must(200, "PUT", "meters/illustration/credit_cost", {
    unit: "credit",
    credits_per_unit: "1",
    overrides: [{ product: product.publicId, credits_per_unit: "0.5" }],
  });
  const m2 = await access(T, member, "meter=illustration&estimate_quantity=3");
  const h = await hold(T, member, { meter: "illustration", quantity: 3 });
  check(
    "the plan's cost applies to the access check and to a hold by quantity: 3 × 0.5 = 1.5",
    m2.body.allowed === true &&
      m2.body.credits.credits_per_unit === "0.5" &&
      m2.body.credits.cost_source === "plan" &&
      m2.body.credits.estimate === "1.5" &&
      h.status === 201 &&
      h.body.units === "1.5" &&
      (await row(member.id)).held === 15n,
    { access: m2.body.credits, hold: h.body },
  );
  const stillPack = await access(T, buyer, "meter=illustration");
  check(
    "the buyer with no subscription keeps the meter's own cost",
    stillPack.body.credits.credits_per_unit === "1",
  );
  await must(200, "PUT", "meters/illustration/credit_cost", {
    unit: "credit",
    credits_per_unit: "1",
  });
  await inStep("after the access checks");
}

// ── 2. A hold reserves units ─────────────────────────────────────────────────────
console.log("2. a hold reserves units");
{
  const T = plus(2 * HOUR);
  const c = await customer("reserve");
  await give(c, 50);
  const key = `chu-idem-${Date.now()}`;
  const h = await hold(T, c, { meter: "illustration", units: "3" }, key);
  check(
    "a hold of 3 credits: 201, in units, no money amount",
    h.status === 201 &&
      h.body.unit === "credit" &&
      h.body.units === "3" &&
      h.body.amount_minor === 0 &&
      h.body.status === "held" &&
      h.body.meter === "illustration",
    h,
  );
  const r0 = await row(c.id);
  check("the row keeps 5.0 and holds 3.0", r0.available === 50n && r0.held === 30n, r0);
  const again = await hold(T, c, { meter: "illustration", units: "3" }, key);
  check(
    "a replay of the Idempotency-Key answers with the same hold and reserves nothing more",
    again.body.id === h.body.id && (await row(c.id)).held === 30n,
    again,
  );
  const a = await access(T, c, "meter=illustration&estimate_units=2");
  const a2 = await access(T, c, "meter=illustration&estimate_units=2.1");
  check(
    "the access check sees the held units: 2 available, 3 held",
    a.body.allowed === true &&
      a.body.credits.available === "2" &&
      a.body.credits.held === "3" &&
      a2.body.code === "in_flight_limit",
    { a: a.body.credits, a2: a2.body.code },
  );
  const bal = await at(T, () =>
    withTenant(orgId, (tx) =>
      liveBalance(tx, {
        customerId: c.id,
        currency: "USD",
        now: T,
        businessConfig: null,
        customerSettings: null,
      }),
    ),
  );
  check(
    "the live balance offers 2.0",
    bal.availableUnits.find((u) => u.unit === "credit")?.units === 20n,
    bal.availableUnits,
  );
  const e1 = await send(T, c, "illustration");
  const e2 = await send(T, c, "illustration");
  const e3 = await send(T, c, "illustration");
  check(
    "events spend the 2 free credits; the third is refused: the held units are not spent",
    e1.status === "created" &&
      e2.status === "created" &&
      e3.error?.code === "insufficient_credit" &&
      (await row(c.id)).available === 30n &&
      (await row(c.id)).held === 30n,
    { e3, row: await row(c.id) },
  );
  const second = await hold(T, c, { meter: "illustration", units: "0.1" });
  check(
    "another hold cannot take the held units: 402 with the figures in units",
    second.status === 402 &&
      second.body.error?.code === "in_flight_limit" &&
      second.body.error.balance_units === "3" &&
      second.body.error.open_holds_units === "3",
    second,
  );
  const bad = [
    await hold(T, c, { meter: "illustration", amount_minor: 100 }),
    await hold(T, c, { meter: "illustration", quantity: 1, units: 1 }),
    await hold(T, c, { meter: "illustration" }),
    await hold(T, c, { meter: "illustration", units: "0.25" }),
    await hold(T, c, { meter: "illustration", units: "0" }),
    await hold(T, c, { meter: "plain", units: "1" }),
    await hold(T, c, { units: "1" }),
  ];
  check(
    "a money amount on a meter paid in credits, both or neither of quantity and units, too many decimals, 0, and units on a money meter are refused (400)",
    bad.every((b) => b.status === 400),
    bad.map((b) => b.status),
  );
  const rel = await release(T, h.body.id);
  const relAgain = await release(T, h.body.id);
  check(
    "release gives the units back; a second release is 409",
    rel.status === 200 &&
      rel.body.status === "released" &&
      (await row(c.id)).held === 0n &&
      (await row(c.id)).available === 30n &&
      relAgain.status === 409,
    { rel, relAgain: relAgain.status },
  );
  const e4 = await send(T, c, "illustration");
  check("after the release an event spends the credits", e4.status === "created", e4);
  await inStep("after a hold and its release");
}

// ── 3. Capture: fewer, equal and more units than held ────────────────────────────
console.log("3. capture with an event");
{
  const T = plus(3 * HOUR);
  const c = await customer("capture");
  await give(c, 50);
  // Fewer: 3 held, the event costs 1.
  const h1 = await hold(T, c, { meter: "illustration", units: 3 });
  const e1 = ev(c, "illustration");
  const capKey = `chu-capkey-${Date.now()}`;
  const c1 = await capture(T, h1.body.id, { usage_event: e1 }, capKey);
  const r1 = (await creditRows(e1.key))[0];
  check(
    "fewer: the event takes 1, the other 2 held credits return to the balance",
    c1.status === 200 &&
      c1.body.status === "captured" &&
      c1.body.captured_units === "1" &&
      c1.body.overdraft === false &&
      r1?.status === "taken" &&
      r1.units === 10n &&
      r1.unitsUncovered === 0n &&
      r1.coveredByHold &&
      (await row(c.id)).available === 40n &&
      (await row(c.id)).held === 0n,
    { c1, r1, row: await row(c.id) },
  );
  const replay = await capture(T, h1.body.id, { usage_event: e1 }, capKey);
  const second = await capture(T, h1.body.id, { usage_event: ev(c, "illustration") });
  check(
    "a replayed capture answers the same and takes nothing more; a new capture is 409",
    replay.status === 200 &&
      replay.body.captured_units === "1" &&
      second.status === 409 &&
      (await row(c.id)).available === 40n,
    { replay: replay.status, second: second.status, row: await row(c.id) },
  );
  // Equal: a hold by quantity, the event of that quantity.
  const h2 = await hold(T, c, { meter: "render", quantity: 1 });
  const e2 = ev(c, "render");
  const c2 = await capture(T, h2.body.id, { usage_event: e2 });
  check(
    "equal: a hold for one render (3 credits) is captured by one render",
    h2.body.units === "3" &&
      c2.body.captured_units === "3" &&
      c2.body.overdraft === false &&
      (await creditRows(e2.key))[0]!.unitsUncovered === 0n &&
      (await row(c.id)).available === 10n &&
      (await row(c.id)).held === 0n,
    { h2: h2.body, c2: c2.body, row: await row(c.id) },
  );
  // More: 1 credit left and held; the event costs 3.
  const h3 = await hold(T, c, { meter: "illustration", units: 1 });
  const e3 = ev(c, "render");
  const c3 = await capture(T, h3.body.id, { usage_event: e3 });
  const [r3, r3over] = await creditRows(e3.key);
  check(
    "more: the event takes what the balance has (1); with no money price the other 2 go below " +
      "zero (an overshoot the next grant pays first), and the hold is marked overdraft",
    c3.status === 200 &&
      c3.body.captured_units === "1" &&
      c3.body.overdraft === true &&
      r3?.units === 10n &&
      r3.unitsUncovered === 0n &&
      r3over?.source === "overdraft" &&
      r3over.units === 20n &&
      (await row(c.id)).available === -20n &&
      (await row(c.id)).held === 0n,
    { c3, r3, r3over, row: await row(c.id) },
  );
  // More, with free balance: the event may take free credits beyond the hold.
  const d = await customer("capture-more");
  await give(d, 50);
  const h4 = await hold(T, d, { meter: "illustration", units: 1 });
  const e4 = ev(d, "render");
  const c4 = await capture(T, h4.body.id, { usage_event: e4 });
  check(
    "more, with free credits: the event takes its whole cost (3) and nothing is uncovered",
    c4.body.captured_units === "3" &&
      c4.body.overdraft === false &&
      (await creditRows(e4.key))[0]!.unitsUncovered === 0n &&
      (await row(d.id)).available === 20n,
    { c4: c4.body, row: await row(d.id) },
  );
  // A hold in money does not cover an event of a meter paid in credits.
  const z = await customer("money-hold");
  const mh = await hold(T, z, { amount_minor: 10 });
  const ez = ev(z, "illustration");
  const cz = await capture(T, mh.body.id, { usage_event: ez });
  check(
    "a hold in money at a balance of 0: the capture is refused (402), the hold stays open, no event is stored",
    mh.status === 201 &&
      mh.body.unit === null &&
      mh.body.units === null &&
      cz.status === 402 &&
      cz.body.error?.code === "insufficient_credit" &&
      (await holdRow(mh.body.id)).status === "held" &&
      (await creditRows(ez.key)).length === 0,
    { mh: mh.body, cz },
  );
  const wrong = await capture(T, (await hold(T, d, { meter: "illustration", units: 1 })).body.id, {
    usage_event: ev(c, "illustration"),
  });
  check("an event of another customer is refused (400)", wrong.status === 400, wrong);
  await inStep("after the captures");
}

// ── 3b. capture_over_hold: cap_at_hold ───────────────────────────────────────────
console.log("3b. a capture capped at the hold");
{
  const T = plus(3 * HOUR + 30 * MIN);
  await setConfig({ ...OPEN, capture_over_hold: "cap_at_hold" });
  const pastHold = (rows: Array<typeof creditUsageEvents.$inferSelect>) =>
    rows.filter((r) => r.status === "forgiven" && r.zeroReason === "hold_cap");
  // Free credit beyond the hold: under `debt` the event took its whole cost (§ 3); here 1.
  const c = await customer("cap-free");
  await give(c, 50);
  const h1 = await hold(T, c, { meter: "illustration", units: 1 });
  const e1 = ev(c, "render");
  const c1 = await capture(T, h1.body.id, { usage_event: e1 });
  const r1 = await creditRows(e1.key);
  const audit = await systemDb
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.businessId, biz.id),
        eq(auditLogs.action, "credit.zero_out"),
        eq(auditLogs.resourceId, h1.body.id),
      ),
    );
  check(
    "cap, with free credits: the event takes the 1 held, the other 2 are a forgiven part",
    c1.status === 200 &&
      c1.body.captured_units === "1" &&
      c1.body.overdraft === false &&
      r1[0]?.units === 10n &&
      pastHold(r1).length === 1 &&
      pastHold(r1)[0]!.units === 20n &&
      (await row(c.id)).available === 40n &&
      (await row(c.id)).held === 0n &&
      audit.some((a) => (a.after as { reason?: string })?.reason === "hold_cap"),
    { c1, r1, row: await row(c.id), audit },
  );
  // No credit beyond the hold: under `debt` the other 2 went below zero (§ 3); here nothing.
  const d = await customer("cap-empty");
  await give(d, 10);
  const h2 = await hold(T, d, { meter: "illustration", units: 1 });
  const e2 = ev(d, "render");
  const c2 = await capture(T, h2.body.id, { usage_event: e2 });
  const r2 = await creditRows(e2.key);
  check(
    "cap, at the end of the balance: no overshoot, the balance stops at 0",
    c2.body.captured_units === "1" &&
      c2.body.overdraft === false &&
      !r2.some((r) => r.source === "overdraft" && r.status === "taken") &&
      pastHold(r2)[0]?.units === 20n &&
      (await row(d.id)).available === 0n,
    { c2, r2, row: await row(d.id) },
  );
  // Less than the hold is not changed by the cap.
  const h3 = await hold(T, c, { meter: "render", units: 3 });
  const e3 = ev(c, "illustration");
  const c3 = await capture(T, h3.body.id, { usage_event: e3 });
  check(
    "cap, less than the hold: the event takes its cost, nothing is forgiven",
    c3.body.captured_units === "1" &&
      pastHold(await creditRows(e3.key)).length === 0 &&
      (await row(c.id)).available === 30n,
    { c3, row: await row(c.id) },
  );
  // By key: the gate refused the event while the hold kept the balance.
  const k = await customer("cap-key");
  await give(k, 10);
  const h4 = await hold(T, k, { meter: "illustration", units: 1 });
  const refused = await send(T, k, "render");
  const c4 = await capture(T, h4.body.id, { usage_event_id: refused.key });
  const r4 = await creditRows(refused.key!);
  check(
    "cap, by key: the refused event is paid with the 1 held, the other 2 are forgiven",
    refused.error?.code === "insufficient_credit" &&
      c4.status === 200 &&
      c4.body.captured_units === "1" &&
      r4[0]?.status === "taken" &&
      r4[0].units === 10n &&
      pastHold(r4)[0]?.units === 20n &&
      (await row(k.id)).available === 0n,
    { c4, r4, row: await row(k.id) },
  );
  await setConfig(OPEN);
  await inStep("after the capped captures");
}

// ── 4. Capture by key ────────────────────────────────────────────────────────────
console.log("4. capture by the key of a stored event");
{
  const T = plus(4 * HOUR);
  const c = await customer("by-key");
  await give(c, 30);
  // The event took its credits at ingest, beside the hold.
  const h1 = await hold(T, c, { meter: "illustration", units: 1 });
  const first = await send(T, c, "illustration");
  const c1 = await capture(T, h1.body.id, { usage_event_id: first.key });
  const r1 = await creditRows(first.key!);
  check(
    "an event that paid at ingest: the hold's units return, the credits are taken once",
    first.status === "created" &&
      c1.status === 200 &&
      c1.body.captured_units === "1" &&
      r1.length === 1 &&
      r1[0]!.units === 10n &&
      (await row(c.id)).available === 20n &&
      (await row(c.id)).held === 0n,
    { c1, row: await row(c.id) },
  );
  // The hold has everything that is left, so the gate refuses the event; the capture pays it.
  const h2 = await hold(T, c, { meter: "illustration", units: 2 });
  const refused = await send(T, c, "illustration");
  const before = (await creditRows(refused.key!))[0];
  const c2 = await capture(T, h2.body.id, { usage_event_id: refused.key });
  const after = (await creditRows(refused.key!))[0];
  check(
    "an event the gate refused while the hold was open is paid by the capture",
    refused.error?.code === "insufficient_credit" &&
      before?.status === "refused" &&
      c2.status === 200 &&
      c2.body.captured_units === "1" &&
      c2.body.overdraft === false &&
      after?.status === "taken" &&
      after.units === 10n &&
      after.unitsUncovered === 0n &&
      after.coveredByHold &&
      after.reason === null &&
      (await row(c.id)).available === 10n &&
      (await row(c.id)).held === 0n,
    { refused, c2, after, row: await row(c.id) },
  );
  const repeat = await send(T, c, "illustration", { key: refused.key! });
  check(
    "a repeat of that event key is now a duplicate, not a refusal",
    repeat.status === "duplicate",
    repeat,
  );
  const settled = await at(plus(5 * HOUR + MIN), () => runSettleCreditUsage(plus(5 * HOUR + MIN)));
  check(
    "settlement draws the event the capture paid",
    settled.failed === 0 && (await creditRows(refused.key!))[0]!.status === "settled",
    settled,
  );
  const missing = await capture(
    T,
    (await hold(T, c, { meter: "illustration", units: 1 })).body.id,
    { usage_event_id: "no-such-key" },
  );
  check("an unknown event key is 404", missing.status === 404, missing);
  await inStep("after captures by key");
}

// ── 5. Expiry ────────────────────────────────────────────────────────────────────
console.log("5. expiry");
{
  const T = plus(6 * HOUR);
  // The holds that the steps above left open are past their time.
  await at(T, () => expireCreditHolds(T));
  const c = await customer("expiry");
  await give(c, 30);
  const h = await hold(T, c, { meter: "illustration", units: 3, expires_in: 60 });
  const during = await send(plus(6 * HOUR + 30 * SEC), c, "illustration");
  check(
    "before its expiry the hold keeps every credit: an event is refused",
    h.status === 201 && during.error?.code === "insufficient_credit",
    during,
  );
  const after = plus(6 * HOUR + 61 * SEC);
  const a = await access(after, c, "meter=illustration&estimate_units=3");
  check(
    "one second after the expiry the access check offers the units again, though no pass ran",
    a.body.allowed === true &&
      a.body.credits.available === "3" &&
      a.body.credits.held === "0" &&
      (await row(c.id)).held === 30n,
    { credits: a.body.credits, row: await row(c.id) },
  );
  const late = await capture(after, h.body.id, { usage_event: ev(c, "illustration") });
  check("a capture after the expiry is 409", late.status === 409, late);
  const spend = await send(after, c, "illustration");
  check(
    "an event after the expiry is paid: the gate ends the hold and gives its units back",
    spend.status === "created" &&
      (await holdRow(h.body.id)).status === "expired" &&
      (await row(c.id)).held === 0n &&
      (await row(c.id)).available === 20n,
    { spend, row: await row(c.id) },
  );
  // The pass ends a hold that no event met.
  const h2 = await hold(after, c, { meter: "illustration", units: 2, expires_in: 60 });
  const early = await at(plus(6 * HOUR + 90 * SEC), () =>
    expireCreditHolds(plus(6 * HOUR + 90 * SEC)),
  );
  const passAt = plus(6 * HOUR + 3 * MIN);
  const done = await at(passAt, () => expireCreditHolds(passAt));
  const again = await at(passAt, () => expireCreditHolds(passAt));
  check(
    "the pass leaves a hold that is not due, ends it when due, and a second run finds nothing",
    early.expired === 0 &&
      done.expired === 1 &&
      again.expired === 0 &&
      (await holdRow(h2.body.id)).status === "expired" &&
      (await row(c.id)).held === 0n,
    { early, done, again },
  );
  await inStep("after the expiries");
}

// ── 6. The share of the balance that holds can use ───────────────────────────────
console.log("6. the open-holds share in units");
{
  const T = plus(7 * HOUR);
  await setConfig({});
  const c = await customer("share");
  await give(c, 100);
  const a = await hold(T, c, { meter: "illustration", units: 3 });
  const b = await hold(T, c, { meter: "illustration", units: "2.5" });
  const ok = await hold(T, c, { meter: "illustration", units: 2 });
  check(
    "at 50%: 3 of 10 is held, 2.5 more is refused in_flight_limit with the figures in units, 2 more is held",
    a.status === 201 &&
      b.status === 402 &&
      b.body.error?.code === "in_flight_limit" &&
      b.body.error.balance_units === "10" &&
      b.body.error.open_holds_units === "3" &&
      ok.status === 201 &&
      (await row(c.id)).held === 50n,
    { a: a.status, b, ok: ok.status },
  );
  const chk = await access(T, c, "meter=illustration&estimate_units=0.1");
  check(
    "the access check answers in_flight_limit for an estimate past the share",
    chk.body.code === "in_flight_limit" && chk.body.allowed === false,
    chk.body,
  );
  await setConfig({ in_flight_applies: "other_holds_open" });
  const d = await customer("share-single");
  await give(d, 100);
  const lone = await hold(T, d, { meter: "illustration", units: 9 });
  const next = await hold(T, d, { meter: "illustration", units: 1 });
  check(
    "other_holds_open: a hold with no other open may pass the share; the next one may not",
    lone.status === 201 && next.status === 402 && next.body.error?.code === "in_flight_limit",
    { lone: lone.status, next },
  );
  // Blocking off for a subscriber: the share does not apply, the balance still does.
  await setConfig(OPEN);
  await inStep("after the share");
}

// ── 7. Parallel holds, and holds against ingest and settlement ────────────────────
console.log("7. concurrency");
{
  const T = plus(8 * HOUR);
  const c = await customer("parallel");
  await give(c, 100);
  const results = await Promise.all(
    Array.from({ length: 40 }, () => hold(T, c, { meter: "illustration", units: "0.3" })),
  );
  const made = results.filter((r) => r.status === 201).length;
  const short = results.filter(
    (r) =>
      r.status === 402 && ["in_flight_limit", "insufficient_credit"].includes(r.body.error?.code),
  ).length;
  check(
    "40 parallel holds of 0.3 against 10: exactly 33 are held, 7 refused, 9.9 reserved",
    made === 33 && short === 7 && (await row(c.id)).held === 99n,
    { made, short, row: await row(c.id) },
  );
  await inStep("after parallel holds");

  const d = await customer("mixed");
  await give(d, 200);
  const early = plus(8 * HOUR + 50 * MIN);
  const passAt = plus(9 * HOUR + MIN);
  const seeded = await Promise.all(
    Array.from({ length: 6 }, () =>
      hold(early, d, { meter: "illustration", units: "0.5", expires_in: 3600 }),
    ),
  );
  const outcome = await Promise.allSettled([
    ...Array.from({ length: 15 }, () => send(early, d, "illustration")),
    ...Array.from({ length: 15 }, () => hold(passAt, d, { meter: "illustration", units: "0.5" })),
    at(passAt, () => runSettleCreditUsage(passAt)),
    ...seeded
      .slice(0, 3)
      .map((h) => capture(passAt, h.body.id, { usage_event: ev(d, "illustration") })),
    ...seeded.slice(3).map((h) => release(passAt, h.body.id)),
    ...Array.from({ length: 15 }, () => send(passAt, d, "illustration")),
    at(passAt, () => runSettleCreditUsage(passAt)),
  ]);
  const thrown = outcome.filter((o) => o.status === "rejected");
  const errors = outcome.filter(
    (o) =>
      o.status === "fulfilled" &&
      typeof (o.value as Res).status === "number" &&
      (o.value as Res).status >= 500,
  );
  check(
    "holds, captures, releases, events and settlement together: none fails, none deadlocks",
    thrown.length === 0 && errors.length === 0,
    { thrown: thrown.map((t) => String((t as PromiseRejectedResult).reason)), errors },
  );
  const final = await row(d.id);
  // A capture that costs more than its hold never fails: with no money price its rest is an
  // overshoot (0530), a debt below the open holds. Credits, not that debt, are counted here.
  const [spent] = rowsOf<{ units: string; debt: string }>(
    await systemDb.execute(sql`
      select coalesce(sum(units) filter (where source <> 'overdraft'), 0)::text as units,
        coalesce(sum(units) filter (where source = 'overdraft'), 0)::text as debt
      from credit_usage_events
      where customer_id = ${d.id} and status in ('taken', 'pending', 'settled')`),
  );
  check(
    "nothing is spent twice: credits taken plus credits held are at most the 20 granted",
    BigInt(spent!.units) + final.held <= 200n &&
      final.available + BigInt(spent!.debt) >= final.held,
    { spent: spent!.units, debt: spent!.debt, final },
  );
  await inStep("after holds against ingest and settlement");
}

// ── 8. A hold pins its grants ────────────────────────────────────────────────────
console.log("8. a grant that ends while a hold is open");
{
  const END = plus(11 * HOUR);
  const c = await customer("grant-ends");
  const g = await give(c, 50, { expires_at: END });
  const [grant] = await systemDb.select().from(creditGrants).where(eq(creditGrants.publicId, g.id));
  const graceRow = async (grantId = grant!.id) =>
    (
      await systemDb.select().from(creditGrantGrace).where(eq(creditGrantGrace.grantId, grantId))
    )[0];
  const T = plus(10 * HOUR + 50 * MIN);
  const h = await hold(T, c, { meter: "illustration", units: 3, expires_in: 3600 });
  const afterEnd = plus(11 * HOUR + SEC);
  const bare = await send(afterEnd, c, "illustration");
  const r = await row(c.id);
  const gr = await graceRow();
  check(
    "after the grant's expiry the 3 held credits stay with the grant for the hold; nothing is spendable",
    h.status === 201 &&
      bare.error?.code === "insufficient_credit" &&
      r.available === 0n &&
      r.held === 30n &&
      r.pinned === 30n &&
      gr?.availableSteps === 50n &&
      gr.heldSteps === 30n &&
      (await holdRow(h.body.id)).status === "held",
    { bare, r, gr },
  );
  const a = await access(afterEnd, c, "meter=illustration");
  check(
    "the access check: 0 available, 3 held",
    a.body.credits.available === "0" &&
      a.body.credits.held === "3" &&
      a.body.code === "insufficient_credit",
    a.body.credits,
  );
  await inStep("with a hold over an ended grant");
  // A late event may use what the grant has beyond the held units, never the held units.
  const lateKeys: string[] = [];
  for (let i = 0; i < 3; i++) {
    const key = `chu-late-${Date.now()}-${i}`;
    lateKeys.push(key);
    await at(afterEnd, () =>
      ingestUsageEvents({
        ...ids,
        events: [
          {
            key,
            customer: c.publicId,
            event_name: "illustration",
            timestamp: plus(10 * HOUR + 55 * MIN).toISOString(),
          },
        ],
      }),
    );
  }
  const lateStatus = await Promise.all(lateKeys.map(async (k) => (await creditRows(k))[0]?.status));
  check(
    "late events take the 2 credits that are not held and the third is refused: the held units are kept",
    lateStatus.filter((x) => x === "pending").length === 2 &&
      lateStatus.filter((x) => x === "refused").length === 1 &&
      (await graceRow())?.availableSteps === 30n &&
      (await graceRow())?.heldSteps === 30n,
    { lateStatus, grace: await graceRow() },
  );
  const e = ev(c, "illustration");
  const cap = await capture(afterEnd, h.body.id, { usage_event: e, final: false });
  const er = (await creditRows(e.key))[0];
  check(
    "a capture after the expiry is paid from the expired grant, as a late event is: 1 taken, 2 still held",
    cap.status === 200 &&
      cap.body.status === "held" &&
      cap.body.captured_units === "1" &&
      cap.body.remaining_units === "2" &&
      cap.body.overdraft === false &&
      er?.units === 10n &&
      er.unitsUncovered === 0n &&
      er.source === "grace" &&
      er.graceGrantId === grant!.id &&
      er.status === "pending" &&
      (await row(c.id)).held === 20n &&
      (await row(c.id)).pinned === 20n &&
      (await graceRow())?.availableSteps === 20n,
    { cap, er, row: await row(c.id), grace: await graceRow() },
  );
  await inStep("after a capture from an ended grant");
  const rel = await release(afterEnd, h.body.id);
  const after = await row(c.id);
  const again = await send(afterEnd, c, "illustration");
  check(
    "a release after the expiry does not make the expired units spendable",
    rel.status === 200 &&
      after.available === 0n &&
      after.held === 0n &&
      after.pinned === 0n &&
      (await graceRow())?.availableSteps === 20n &&
      (await graceRow())?.heldSteps === 0n &&
      again.error?.code === "insufficient_credit",
    { rel: rel.status, after, grace: await graceRow(), again },
  );
  await inStep("after a release over an ended grant");
  const lockAt = new Date(END.getTime() + 12 * HOUR + MIN);
  const locked = await at(lockAt, () => runSettleCreditUsage(lockAt));
  const late = await systemDb
    .select()
    .from(creditUsageSettlements)
    .where(eq(creditUsageSettlements.graceGrantId, grant!.id));
  const [closed] = await systemDb.select().from(creditGrants).where(eq(creditGrants.id, grant!.id));
  check(
    "when the grant's window closes, the capture is drawn from that grant and the rest expires",
    locked.failed === 0 &&
      late.reduce((x, y) => x + y.unitsDrawn, 0n) === 30n &&
      (await creditRows(e.key))[0]!.status === "settled" &&
      closed?.status === "expired" &&
      (await row(c.id)).available === 0n,
    { locked, late: late.map((l) => l.unitsDrawn), status: closed?.status },
  );
  await inStep("after the grant's window closed");

  // With no window for late events the grant still keeps the held units until the hold closes.
  await setConfig({ ...OPEN, late_event_grace_hours: 0 });
  const d = await customer("grant-ends-no-window");
  const END2 = plus(11 * HOUR + 30 * MIN);
  const g2 = await give(d, 50, { expires_at: END2 });
  const [grant2] = await systemDb
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.publicId, g2.id));
  const h2 = await hold(plus(11 * HOUR + 20 * MIN), d, {
    meter: "render",
    quantity: 1,
    expires_in: 3600,
  });
  const afterEnd2 = new Date(END2.getTime() + SEC);
  const e2 = ev(d, "render");
  const cap2 = await capture(afterEnd2, h2.body.id, { usage_event: e2 });
  const bare2 = await send(afterEnd2, d, "illustration");
  check(
    "no late-event window: the capture after the expiry still takes its 3 held credits from that grant; the other 2 are not spendable",
    cap2.status === 200 &&
      cap2.body.status === "captured" &&
      cap2.body.captured_units === "3" &&
      cap2.body.overdraft === false &&
      (await creditRows(e2.key))[0]!.graceGrantId === grant2!.id &&
      bare2.error?.code === "insufficient_credit" &&
      (await row(d.id)).pinned === 0n,
    { cap2, bare2, row: await row(d.id), grace: await graceRow(grant2!.id) },
  );
  await inStep("after a capture with no late-event window");
  const lockAt2 = plus(12 * HOUR + 21 * MIN);
  await at(lockAt2, () => runSettleCreditUsage(lockAt2));
  const [closed2] = await systemDb
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.id, grant2!.id));
  check(
    "after the hold's time the grant is booked out: the capture drawn, the rest expired",
    closed2?.status === "expired" && (await creditRows(e2.key))[0]!.status === "settled",
    closed2?.status,
  );
  await setConfig(OPEN);
  await inStep("after the no-window grant closed");
}

// ── 8b. Leases: a hold used in steps ─────────────────────────────────────────────
console.log("8b. leases");
{
  const T = plus(14 * HOUR);
  const c = await customer("lease");
  await give(c, 100);
  const h = await hold(T, c, { meter: "illustration", units: 5, expires_in: 60 });
  const k1 = `chu-lease-1-${Date.now()}`;
  const step1 = { usage_event: ev(c, "illustration"), final: false };
  const s1 = await capture(T, h.body.id, step1, k1);
  check(
    "step 1 takes 1 credit and the hold stays open with 4",
    s1.status === 200 &&
      s1.body.status === "held" &&
      s1.body.units === "5" &&
      s1.body.remaining_units === "4" &&
      s1.body.captured_units === "1" &&
      (await row(c.id)).available === 90n &&
      (await row(c.id)).held === 40n,
    { s1, row: await row(c.id) },
  );
  const again = await capture(T, h.body.id, step1, k1);
  check(
    "a replay of the step's Idempotency-Key answers the same and takes nothing more",
    again.body.remaining_units === "4" && (await row(c.id)).available === 90n,
    again.body,
  );
  const s2 = await capture(T, h.body.id, { usage_event: ev(c, "render"), final: false });
  const acc = await access(T, c, "meter=illustration");
  check(
    "step 2 takes 3: 1 is left, and the access check counts the lease by what it still reserves",
    s2.body.remaining_units === "1" &&
      s2.body.captured_units === "4" &&
      acc.body.credits.held === "1" &&
      acc.body.credits.available === "5" &&
      acc.body.credits.unsettled === "4",
    { s2: s2.body, credits: acc.body.credits },
  );
  const balance = await at(T, () => res(call("GET", `customers/${c.publicId}/access`)));
  const entry = (balance.body.available_units as Array<Record<string, unknown>>).find(
    (u) => u.unit === "credit",
  );
  check(
    "the balance lists held_units and unsettled_units next to the available figure",
    entry?.units === 50 && entry.held_units === 10 && entry.unsettled_units === 40,
    entry,
  );
  const ext = (expires_in: number, id = h.body.id) =>
    at(T, () => res(call("POST", `credit_holds/${id}/extend`, { expires_in })));
  const longer = await ext(600);
  const shorter = await ext(30);
  const moneyHold = await hold(T, c, { amount_minor: 10 });
  const moneyExt = await ext(600, moneyHold.body.id);
  const moneyStep = await capture(T, moneyHold.body.id, {
    usage_event: ev(c, "plain"),
    final: false,
  });
  check(
    "extend moves the expiry later, never earlier; a hold in money takes no extend and no step",
    longer.status === 200 &&
      longer.body.expires_at === new Date(T.getTime() + 600 * SEC).toISOString() &&
      longer.body.remaining_units === "1" &&
      shorter.status === 400 &&
      moneyExt.status === 400 &&
      moneyStep.status === 400,
    { longer, shorter: shorter.status, moneyExt: moneyExt.status, moneyStep: moneyStep.status },
  );
  const later = new Date(T.getTime() + 120 * SEC);
  const s3 = await capture(later, h.body.id, { usage_event: ev(c, "illustration"), final: false });
  const s4 = await capture(later, h.body.id, { usage_event: ev(c, "illustration"), final: false });
  check(
    "past the first expiry the extended lease still works; the step that uses the last credit closes it",
    s3.status === 200 &&
      s3.body.status === "captured" &&
      s3.body.remaining_units === "0" &&
      s3.body.captured_units === "5" &&
      s4.status === 409 &&
      (await row(c.id)).held === 0n &&
      (await row(c.id)).available === 50n,
    { s3, s4: s4.status, row: await row(c.id) },
  );
  // Release the rest.
  const h2 = await hold(later, c, { meter: "illustration", units: 5, expires_in: 600 });
  await capture(later, h2.body.id, { usage_event: ev(c, "illustration"), final: false });
  const rel = await release(later, h2.body.id);
  check(
    "release closes a lease and gives back what is left",
    rel.status === 200 &&
      rel.body.status === "released" &&
      rel.body.remaining_units === "0" &&
      rel.body.captured_units === "1" &&
      (await row(c.id)).held === 0n &&
      (await row(c.id)).available === 40n,
    { rel, row: await row(c.id) },
  );
  // Expiry gives back what a lease still reserves.
  const h3 = await hold(later, c, { meter: "illustration", units: 3, expires_in: 60 });
  await capture(later, h3.body.id, { usage_event: ev(c, "illustration"), final: false });
  const passAt = new Date(later.getTime() + 5 * MIN);
  await at(passAt, () => expireCreditHolds(passAt));
  check(
    "expiry of a lease gives back its 2 remaining credits",
    (await holdRow(h3.body.id)).status === "expired" &&
      (await row(c.id)).held === 0n &&
      (await row(c.id)).available === 30n,
    await row(c.id),
  );
  // Parallel steps on one lease never take more than it holds.
  const p = await customer("lease-parallel");
  await give(p, 20);
  const lease = await hold(passAt, p, { meter: "illustration", units: 2, expires_in: 600 });
  const steps = await Promise.all(
    Array.from({ length: 10 }, () =>
      capture(passAt, lease.body.id, { usage_event: ev(p, "illustration"), final: false }),
    ),
  );
  const done = await holdRow(lease.body.id);
  check(
    "10 parallel steps on a lease of 2: exactly 2 are captured, 8 find the hold closed, 2 credits taken",
    steps.filter((x) => x.status === 200).length === 2 &&
      steps.filter((x) => x.status === 409).length === 8 &&
      done.status === "captured" &&
      done.capturedUnits === 20n &&
      (await row(p.id)).available === 0n &&
      (await row(p.id)).held === 0n,
    { statuses: steps.map((x) => x.status), done, row: await row(p.id) },
  );
  await inStep("after the leases");
}

// ── 9. The automatic top-up for a unit with no rate ──────────────────────────────
console.log("9. the automatic top-up");
{
  const T0 = new Date(Math.floor(Date.now() / MIN) * MIN);
  const tb = await createBusiness({
    organizationId: orgId,
    name: "Top-up in units",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const tIds = { organizationId: orgId, businessId: tb.id };
  await startTimeTravel({ orgId, bizId: tb.id, genesisTime: T0 });
  const atT = async <T>(t: Date, fn: () => Promise<T>): Promise<T> => {
    await systemDb
      .update(timeTravels)
      .set({ simulatedNow: t })
      .where(eq(timeTravels.businessId, tb.id));
    return runWithClockScope({ onlyBusinessId: tb.id, now: t }, fn);
  };
  const o = { biz: tb.publicId };
  const pass = (t: Date) => atT(t, () => runCreditAutoTopups(t));
  for (const [id, rate] of [
    ["credit", null],
    ["token", "0.01"],
  ] as const)
    await must(
      201,
      "POST",
      "credit_units",
      { id, name: id, plural_name: `${id}s`, currency: "USD", minor_per_unit: rate, decimals: 1 },
      o,
    );
  await must(
    201,
    "POST",
    "meters",
    { id: "illustration", name: "Illustrations", event_name: "illustration", aggregation: "count" },
    o,
  );
  await must(
    200,
    "PUT",
    "meters/illustration/credit_cost",
    { unit: "credit", credits_per_unit: "1" },
    o,
  );
  const packProduct = await createProduct({ ...tIds, name: "Credit packs", kind: "charge" });
  const pack = await createPrice({
    ...tIds,
    productId: packProduct.id,
    id: `chu-pack-${Date.now()}`,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 900,
    grantsCredit: { kind: "pack", unit: "credit", amount: 150, tax_treatment: "taxed_at_purchase" },
  });
  const tokenPack = await createPrice({
    ...tIds,
    productId: packProduct.id,
    id: `chu-token-pack-${Date.now()}`,
    type: "one_time",
    model: "flat",
    currency: "USD",
    amountMinor: 500,
    grantsCredit: { kind: "pack", unit: "token", amount: 500, tax_treatment: "taxed_at_purchase" },
  });
  const [tUnit] = await systemDb
    .select()
    .from(creditUnits)
    .where(and(eq(creditUnits.businessId, tb.id), eq(creditUnits.key, "credit")));
  const tRow = async (customerId: string) => {
    const [r] = await systemDb
      .select()
      .from(creditUnitBalances)
      .where(
        and(
          eq(creditUnitBalances.customerId, customerId),
          eq(creditUnitBalances.unitId, tUnit!.id),
        ),
      );
    return r?.availableSteps ?? 0n;
  };
  let cn = 0;
  const buyer = async (card: string) => {
    const c = await createCustomer({ ...tIds, email: `chu-atu-${++cn}-${Date.now()}@example.com` });
    await vaultPaymentMethod({ ...tIds, customer: c, token: card });
    return c;
  };
  const giveT = (c: { publicId: string }, amount: number, t: Date) =>
    atT(t, () =>
      must(201, "POST", `customers/${c.publicId}/credit_grants`, { unit: "credit", amount }, o),
    );
  const sendT = async (t: Date, c: { publicId: string }) => {
    const [r] = await atT(t, () =>
      ingestUsageEvents({
        ...tIds,
        events: [
          {
            key: `chu-atu-ev-${Date.now()}-${++evN}`,
            customer: c.publicId,
            event_name: "illustration",
          },
        ],
      }),
    );
    return r as Sent;
  };
  const body = (over: Record<string, unknown> = {}) => ({
    unit: "credit",
    trigger: "threshold",
    threshold_units: "5",
    method: "fixed",
    pack_price: pack.publicId,
    monthly_cap_minor: 100_000,
    max_runs_per_day: 10,
    ...over,
  });
  const put = (c: { publicId: string }, b: object, t = T0) =>
    atT(t, () => res(call("PUT", `customers/${c.publicId}/auto_topup`, b, o)));
  const cfgOf = async (publicId: string) =>
    (
      await systemDb.select().from(creditAutoTopups).where(eq(creditAutoTopups.publicId, publicId))
    )[0]!;
  const runsOf = (configId: string) =>
    systemDb
      .select()
      .from(creditAutoTopupRuns)
      .where(eq(creditAutoTopupRuns.configId, configId))
      .orderBy(creditAutoTopupRuns.createdAt, creditAutoTopupRuns.id);
  const grantsOf = (invoiceId: string) =>
    systemDb.select().from(creditGrants).where(eq(creditGrants.invoiceId, invoiceId));
  const eventsOf = (type: string, resourceId: string) =>
    systemDb
      .select()
      .from(events)
      .where(and(eq(events.type, type as never), eq(events.resourceId, resourceId)));

  // The config.
  const c = await buyer("4242424242424242");
  const saved = await put(c, body());
  check(
    "a top-up for a unit with no rate is saved: a threshold in credits and the pack",
    saved.status === 200 &&
      saved.body.unit === "credit" &&
      saved.body.threshold_units === "5" &&
      saved.body.threshold_minor === null &&
      saved.body.pack_price === pack.publicId &&
      saved.body.pack_quantity === 1 &&
      saved.body.target_units === null &&
      saved.body.amount_minor === 900 &&
      saved.body.status === "active",
    saved,
  );
  const refusals = [
    await put(c, body({ pack_price: undefined })),
    await put(c, body({ amount_minor: 900 })),
    await put(c, body({ threshold_units: undefined, threshold_minor: 100 })),
    await put(c, body({ method: "target", target_minor: 5000 })),
    await put(c, body({ pack_price: tokenPack.publicId })),
    await put(c, body({ threshold_units: "0.25" })),
    await put(c, body({ monthly_cap_minor: 899 })),
    await put(c, body({ unit: "token" })),
    await put(c, { ...body(), unit: undefined }),
  ];
  check(
    "refused (400): no pack, a money amount, a money threshold, the target method, a pack of another unit, too many decimals, a cap below the pack, a unit with a rate, no unit",
    refusals.every((r) => r.status === 400),
    refusals.map((r) => `${r.status} ${r.body.error?.message ?? ""}`),
  );
  const noPrice = await put(c, body({ pack_price: "price_none" }));
  check("an unknown pack price is 404", noPrice.status === 404, noPrice);
  const cfg = await cfgOf(saved.body.id);

  // Above the threshold: nothing. At it: one run, charged, and the credits on payment.
  await giveT(c, 60, T0);
  await pass(T0);
  check("above the threshold no run is made", (await runsOf(cfg.id)).length === 0);
  const spend = await sendT(T0, c);
  check(
    "an event takes the balance to the threshold (5.0)",
    spend.status === "created" && (await tRow(c.id)) === 50n,
  );
  const created = await atT(T0, () =>
    Promise.all(Array.from({ length: 20 }, () => createRunFor(cfg, T0))),
  );
  const open = await runsOf(cfg.id);
  const pending = open[0] ? await grantsOf(open[0].invoiceId!) : [];
  check(
    "at the threshold, 20 parallel creations make one run for one pack; its grant is pending",
    created.filter((r) => r === "created").length === 1 &&
      open.length === 1 &&
      open[0]!.amountMinor === 900n &&
      open[0]!.status === "created" &&
      pending.length === 1 &&
      pending[0]!.status === "pending" &&
      pending[0]!.amount === 150n &&
      (await tRow(c.id)) === 50n,
    { created, open, pending },
  );
  await pass(T0);
  await pass(T0);
  const done = await runsOf(cfg.id);
  const [inv] = await systemDb.select().from(invoices).where(eq(invoices.id, done[0]!.invoiceId!));
  const active = await grantsOf(done[0]!.invoiceId!);
  check(
    "the pass charges once: run succeeded, invoice paid, the 15 credits in the balance (20.0), no second run",
    done.length === 1 &&
      done[0]!.status === "succeeded" &&
      inv?.status === "paid" &&
      inv.purpose === "credit_purchase" &&
      active[0]?.status === "active" &&
      active[0].costBasisMinor === 900n &&
      active[0].faceMinor === 0n &&
      (await tRow(c.id)) === 200n,
    { done, inv: inv?.status, grant: active[0], row: await tRow(c.id) },
  );
  check(
    "credit_auto_topup_succeeded once",
    (await eventsOf("credit_auto_topup_succeeded", cfg.publicId)).length === 1,
  );
  await inStep("after a top-up", orgId);

  // An event while a run is open: no credit on promise.
  const w = await buyer("4242424242424242");
  const wSaved = await put(w, body());
  const wCfg = await cfgOf(wSaved.body.id);
  await giveT(w, 10, T0);
  await atT(T0, () => createRunFor(wCfg, T0));
  const first = await sendT(T0, w);
  const second = await sendT(T0, w);
  check(
    "while the run is open an event the balance covers is paid and the next is refused",
    (await runsOf(wCfg.id))[0]?.status === "created" &&
      first.status === "created" &&
      second.error?.code === "insufficient_credit" &&
      (await tRow(w.id)) === 0n,
    { first, second },
  );
  await pass(T0);
  const third = await sendT(T0, w);
  check(
    "after the payment the credits are there and an event is paid",
    (await runsOf(wCfg.id))[0]?.status === "succeeded" &&
      third.status === "created" &&
      (await tRow(w.id)) === 140n,
    { third, row: await tRow(w.id) },
  );

  // Several packs to land above the threshold; the monthly cap never splits a pack.
  const m = await buyer("4242424242424242");
  const mSaved = await put(m, body({ threshold_units: "20", monthly_cap_minor: 2000 }));
  const mCfg = await cfgOf(mSaved.body.id);
  await pass(T0);
  const mRuns = await runsOf(mCfg.id);
  check(
    "from 0 with a threshold of 20: two packs (30 credits) in one run, 18.00",
    mRuns.length === 1 &&
      mRuns[0]!.status === "succeeded" &&
      mRuns[0]!.amountMinor === 1800n &&
      (await tRow(m.id)) === 300n,
    { mRuns, row: await tRow(m.id) },
  );
  for (let i = 0; i < 10; i++) await sendT(T0, m);
  check("ten events take the balance to the threshold again", (await tRow(m.id)) === 200n);
  await pass(T0);
  await pass(T0);
  check(
    "the monthly cap has 2.00 left, less than a pack: no run, credit_auto_topup_skipped once",
    (await runsOf(mCfg.id)).length === 1 &&
      (await eventsOf("credit_auto_topup_skipped", mCfg.publicId)).length === 1,
    { runs: (await runsOf(mCfg.id)).length },
  );

  // The threshold is checked in the gate's take: the mark is set once, and one run follows.
  const tRowFull = async (customerId: string) =>
    (
      await systemDb
        .select()
        .from(creditUnitBalances)
        .where(
          and(
            eq(creditUnitBalances.customerId, customerId),
            eq(creditUnitBalances.unitId, tUnit!.id),
          ),
        )
    )[0];
  const q = await buyer("4242424242424242");
  await giveT(q, 70, T0);
  const qSaved = await put(q, body());
  const qCfg = await cfgOf(qSaved.body.id);
  const copied = await tRowFull(q.id);
  const above = await sendT(T0, q);
  const stillClear = (await tRowFull(q.id))?.topupDueAt ?? null;
  const crossing = await Promise.all([sendT(T0, q), sendT(T0, q)]);
  const marked = await tRowFull(q.id);
  check(
    "the gate holds the threshold on the balance row and marks it when a take ends at or below it",
    copied?.topupThresholdSteps === 50n &&
      above.status === "created" &&
      stillClear === null &&
      crossing.every((r) => r.status === "created") &&
      marked?.availableSteps === 40n &&
      marked.topupDueAt != null,
    { copied, stillClear, marked },
  );
  const made = await atT(T0, () =>
    Promise.all(Array.from({ length: 10 }, () => createRunFor(qCfg, T0))),
  );
  check(
    "two takes that cross the threshold together lead to one run; the mark is cleared",
    made.filter((r) => r === "created").length === 1 &&
      (await runsOf(qCfg.id)).length === 1 &&
      (await tRowFull(q.id))?.topupDueAt === null,
    { made, row: await tRowFull(q.id) },
  );
  await pass(T0);
  check("that run is paid: 4.0 + 15.0", (await tRow(q.id)) === 190n, await tRow(q.id));
  const off = await atT(T0, () =>
    res(call("POST", `customers/${q.publicId}/auto_topup/disable?unit=credit`, {}, o)),
  );
  check(
    "turning the top-up off takes the threshold off the balance row",
    off.status === 200 && (await tRowFull(q.id))?.topupThresholdSteps === null,
    { off: off.status, row: await tRowFull(q.id) },
  );

  // "Recharge to N units": whole packs to reach at least N.
  const n = await buyer("4242424242424242");
  const nSaved = await put(n, body({ method: "target", target_units: "40", threshold_units: "5" }));
  const nBad = [
    await put(n, body({ method: "target", target_units: "40", pack_quantity: 2 })),
    await put(n, body({ method: "fixed", target_units: "40" })),
    await put(n, body({ method: "target", target_units: "5", threshold_units: "5" })),
    await put(n, body({ purchase_limits: { hour: {} } })),
    await put(n, body({ purchase_limits: { year: { count: 1 } } })),
  ];
  await pass(T0);
  const nRuns = await runsOf((await cfgOf(nSaved.body.id)).id);
  check(
    "recharge to 40 from 0 with packs of 15: 3 packs (45 credits), 27.00",
    nSaved.status === 200 &&
      nSaved.body.target_units === "40" &&
      nSaved.body.pack_quantity === null &&
      nRuns.length === 1 &&
      nRuns[0]!.amountMinor === 2700n &&
      nRuns[0]!.status === "succeeded" &&
      (await tRow(n.id)) === 450n,
    { nSaved: nSaved.body, nRuns, row: await tRow(n.id) },
  );
  check(
    "refused (400): a count and a target together, a target with the fixed method, a target at the threshold, an empty limit, an unknown window",
    nBad.every((r) => r.status === 400),
    nBad.map((r) => r.status),
  );

  // Purchase limits per period.
  const l = await buyer("4242424242424242");
  const lSaved = await put(
    l,
    body({ purchase_limits: { hour: { count: 1 }, week: { amount_minor: 2000 } } }),
  );
  const lCfg = await cfgOf(lSaved.body.id);
  await pass(T0);
  for (let i = 0; i < 10; i++) await sendT(T0, l);
  await pass(T0);
  await pass(T0);
  const lSkips = await eventsOf("credit_auto_topup_skipped", lCfg.publicId);
  check(
    "one purchase an hour: the second in the same hour is skipped once, with reason purchase_limit",
    lSaved.body.purchase_limits?.hour?.count === 1 &&
      (await runsOf(lCfg.id)).length === 1 &&
      lSkips.length === 1 &&
      (lSkips[0]!.data as { reason?: string; window?: string }).reason === "purchase_limit" &&
      (lSkips[0]!.data as { window?: string }).window === "hour",
    { runs: (await runsOf(lCfg.id)).length, skips: lSkips.map((e) => e.data) },
  );
  const T2 = new Date(T0.getTime() + 2 * HOUR);
  await pass(T2);
  for (let i = 0; i < 15; i++) await sendT(T2, l);
  const T5 = new Date(T0.getTime() + 5 * HOUR);
  await pass(T5);
  const lAfter = await eventsOf("credit_auto_topup_skipped", lCfg.publicId);
  check(
    "two hours later the hour is free and a second pack is bought; a third would pass 20.00 in 7 days and is skipped",
    (await runsOf(lCfg.id)).filter((r) => r.status === "succeeded").length === 2 &&
      lAfter.some((e) => (e.data as { window?: string }).window === "week"),
    { runs: await runsOf(lCfg.id), skips: lAfter.map((e) => e.data) },
  );

  // A soft decline is tried again: 3 tries in 24 hours, then the top-up is off.
  const x = await buyer("4000000000009995");
  const xSaved = await put(x, body());
  const xCfg = await cfgOf(xSaved.body.id);
  await pass(T0);
  await pass(T0);
  const [try1] = await runsOf(xCfg.id);
  const [xInv1] = await systemDb.select().from(invoices).where(eq(invoices.id, try1!.invoiceId!));
  const paysOf = async (invoiceId: string) =>
    rowsOf<{ status: string }>(
      await systemDb.execute(sql`select status from payments where invoice_id = ${invoiceId}`),
    );
  check(
    "a soft decline: the run waits for its next try in 4 hours, the top-up stays on, the invoice stays open",
    try1!.status === "created" &&
      try1!.attempts === 1 &&
      try1!.declineCode === "insufficient_funds" &&
      try1!.chargeAfter?.getTime() === T0.getTime() + 4 * HOUR &&
      xInv1?.status !== "voided" &&
      (await cfgOf(xSaved.body.id)).status === "active" &&
      (await paysOf(try1!.invoiceId!)).length === 1 &&
      (await eventsOf("credit_auto_topup_retry_scheduled", xCfg.publicId)).length === 1 &&
      (await eventsOf("credit_auto_topup_failed", xCfg.publicId)).length === 0,
    { run: try1, inv: xInv1?.status },
  );
  const between = await sendT(new Date(T0.getTime() + HOUR), x);
  check(
    "an event between two tries is refused: no credit before a payment",
    between.error?.code === "insufficient_credit",
    between,
  );
  // Try 2, with a pack bought by hand at the same time.
  const T4 = new Date(T0.getTime() + 4 * HOUR + MIN);
  const manual = async () => {
    const sale = await atT(T4, () =>
      createManualInvoice({
        ...tIds,
        customerId: x.id,
        currency: "USD",
        collect: false,
        lines: [
          {
            description: "Pack",
            priceId: pack.id,
            quantity: 1,
            amountMinor: 900n,
            kind: "one_time",
          },
        ],
      }),
    );
    await atT(T4, () =>
      recordOfflinePayment({ ...tIds, invoicePublicId: sale.invoice.publicId, method: "wire" }),
    );
  };
  const together = await Promise.allSettled([pass(T4), manual()]);
  const [try2] = await runsOf(xCfg.id);
  check(
    "try 2 and a pack bought by hand at the same time: neither fails, the bought pack's 15 credits arrive, the run waits for try 3",
    together.every((r) => r.status === "fulfilled") &&
      (await tRow(x.id)) === 150n &&
      try2!.status === "created" &&
      try2!.attempts === 2 &&
      try2!.chargeAfter?.getTime() === T4.getTime() + 12 * HOUR &&
      (await runsOf(xCfg.id)).length === 1,
    { together, run: try2, row: await tRow(x.id) },
  );
  await inStep("between two tries", orgId);
  const T17 = new Date(T4.getTime() + 12 * HOUR + MIN);
  await pass(T17);
  await pass(T17);
  const [try3] = await runsOf(xCfg.id);
  const [xInv] = await systemDb.select().from(invoices).where(eq(invoices.id, try3!.invoiceId!));
  const xAfter = await cfgOf(xSaved.body.id);
  check(
    "the third failed try turns the top-up off: run failed, invoice voided, 3 payments, credit_auto_topup_retries_exhausted and credit_auto_topup_failed once each",
    try3!.status === "failed" &&
      try3!.attempts === 3 &&
      xInv?.status === "voided" &&
      (await paysOf(try3!.invoiceId!)).filter((p) => p.status === "failed").length === 3 &&
      xAfter.status === "disabled" &&
      xAfter.disabledReason === "retries_exhausted" &&
      (await tRowFull(x.id))?.topupThresholdSteps === null &&
      (await eventsOf("credit_auto_topup_retry_scheduled", xCfg.publicId)).length === 2 &&
      (await eventsOf("credit_auto_topup_retries_exhausted", xCfg.publicId)).length === 1 &&
      (await eventsOf("credit_auto_topup_hard_declined", xCfg.publicId)).length === 0 &&
      (await eventsOf("credit_auto_topup_failed", xCfg.publicId)).length === 1,
    { run: try3, inv: xInv?.status, cfg: xAfter },
  );
  const on = await atT(T17, () =>
    res(call("POST", `customers/${x.publicId}/auto_topup/enable?unit=credit`, {}, o)),
  );
  check(
    "an operator can turn it on again: the threshold is back on the balance row",
    on.status === 200 &&
      on.body.status === "active" &&
      (await tRowFull(x.id))?.topupThresholdSteps === 50n,
    on,
  );
  await atT(T17, () =>
    res(call("POST", `customers/${x.publicId}/auto_topup/disable?unit=credit`, {}, o)),
  );

  // A hard decline turns it off at once.
  const y = await buyer("4000000000000069");
  const ySaved = await put(y, body());
  const yCfg = await cfgOf(ySaved.body.id);
  await pass(T17);
  const [yRun] = await runsOf(yCfg.id);
  const [yInv] = await systemDb.select().from(invoices).where(eq(invoices.id, yRun!.invoiceId!));
  const yAfter = await cfgOf(ySaved.body.id);
  check(
    "a hard decline: no second try, the top-up is off, credit_auto_topup_hard_declined and credit_auto_topup_failed once each",
    yRun!.status === "failed" &&
      yRun!.attempts === 1 &&
      yInv?.status === "voided" &&
      (await grantsOf(yRun!.invoiceId!)).every((g) => g.status !== "active") &&
      yAfter.status === "disabled" &&
      yAfter.disabledReason === "payment_declined" &&
      (await eventsOf("credit_auto_topup_hard_declined", yCfg.publicId)).length === 1 &&
      (await eventsOf("credit_auto_topup_retry_scheduled", yCfg.publicId)).length === 0 &&
      (await eventsOf("credit_auto_topup_failed", yCfg.publicId)).length === 1,
    { run: yRun, inv: yInv?.status, cfg: yAfter },
  );

  // A soft decline whose next try succeeds.
  const z = await buyer("4000000000002008");
  const zSaved = await put(z, body(), T17);
  const zCfg = await cfgOf(zSaved.body.id);
  await pass(T17);
  const [z1] = await runsOf(zCfg.id);
  const T22 = new Date(T17.getTime() + 4 * HOUR + MIN);
  await pass(T22);
  const [z2] = await runsOf(zCfg.id);
  check(
    "a try that fails and a second try that is paid: one run, the credits arrive after the payment only",
    z1!.status === "created" &&
      z1!.attempts === 1 &&
      z2!.status === "succeeded" &&
      (await tRow(z.id)) === 150n &&
      (await cfgOf(zSaved.body.id)).status === "active" &&
      (await eventsOf("credit_auto_topup_succeeded", zCfg.publicId)).length === 1,
    { z1, z2, row: await tRow(z.id) },
  );

  // The buyer's switch in the portal, when the business allows it.
  {
    const link = await createPortalSession({ ...tIds, customerId: q.id });
    const sess = await app.inject({
      method: "POST",
      url: "/portal/v1/session",
      headers: { authorization: `Bearer ${link.accessToken}` },
    });
    const auth = { authorization: `Bearer ${JSON.parse(sess.body).token}` };
    const read = async () =>
      JSON.parse(
        (
          await atT(T17, () =>
            app.inject({ method: "GET", url: "/portal/v1/credits", headers: auth }),
          )
        ).body,
      ) as {
        auto_topups: Array<Record<string, unknown>>;
        balances: Array<{ units: Array<Record<string, unknown>> }>;
      };
    let pk = 0;
    const flip = (enabled: boolean) =>
      atT(T17, () =>
        app.inject({
          method: "POST",
          url: "/portal/v1/credits/auto_topup",
          headers: { ...auth, "idempotency-key": `chu-portal-${Date.now()}-${++pk}` },
          payload: { unit: "credit", enabled },
        }),
      );
    const closed = await read();
    const refusedFlip = await flip(true);
    check(
      "the portal shows no automatic top-up and refuses the switch until the business allows it (403)",
      closed.auto_topups.length === 0 && refusedFlip.statusCode === 403,
      { listed: closed.auto_topups, status: refusedFlip.statusCode },
    );
    await systemDb
      .update(businesses)
      .set({ creditConfig: { portal_auto_topup: true } })
      .where(eq(businesses.id, tb.id));
    const open = await read();
    const unitRow = open.balances.flatMap((b) => b.units).find((u) => u.unit === "credit");
    check(
      "with the setting on, the portal shows the pack, the threshold and that it is off; the balance has held and unsettled amounts",
      open.auto_topups.length === 1 &&
        open.auto_topups[0]!.status === "disabled" &&
        open.auto_topups[0]!.threshold_amount === 50 &&
        open.auto_topups[0]!.pack_credits_amount === 150 &&
        open.auto_topups[0]!.pack_amount_minor === 900 &&
        open.auto_topups[0]!.pack_name === "Credit packs" &&
        open.auto_topups[0]!.pack_quantity === 1 &&
        open.auto_topups[0]!.has_payment_method === true &&
        unitRow?.held_amount === 0 &&
        typeof unitRow.unsettled_amount === "number",
      { topups: open.auto_topups, unitRow },
    );
    // No method that we can charge: the read says so, and the buyer's refusal is in our words.
    const qPms = await systemDb
      .select({ id: paymentMethods.id, status: paymentMethods.status })
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, q.id));
    await systemDb
      .update(paymentMethods)
      .set({ status: "invalid" })
      .where(eq(paymentMethods.customerId, q.id));
    const noPm = await read();
    const refusedNoPm = await flip(true);
    // An invalid primary with a live backup: a run falls through to the backup, so it counts.
    const [firstPm] = await systemDb
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, q.id))
      .limit(1);
    const [backup] = await systemDb
      .insert(paymentMethods)
      .values({
        ...firstPm!,
        id: undefined as never,
        publicId: `pm_backup_${Date.now()}`,
        providerPaymentMethodId: `pm_test_backup_${Date.now()}`,
        role: "backup",
        status: "valid",
      })
      .returning({ id: paymentMethods.id });
    const withBackup = await read();
    await systemDb.delete(paymentMethods).where(eq(paymentMethods.id, backup!.id));
    check(
      "an invalid primary with a live backup counts as a payment method that we can charge",
      withBackup.auto_topups[0]?.has_payment_method === true,
      withBackup.auto_topups,
    );
    for (const pm of qPms)
      await systemDb
        .update(paymentMethods)
        .set({ status: pm.status })
        .where(eq(paymentMethods.id, pm.id));
    check(
      "with no payment method that we can charge, the portal read says so and enabling is refused in the buyer's words (400)",
      qPms.length > 0 &&
        noPm.auto_topups[0]?.has_payment_method === false &&
        refusedNoPm.statusCode === 400 &&
        JSON.parse(refusedNoPm.body).error?.message ===
          "We could not enable automatic top-up. You have no payment method that we can charge. Add a payment method, then try again." &&
        (await cfgOf(qSaved.body.id)).status === "disabled",
      { listed: noPm.auto_topups, status: refusedNoPm.statusCode, body: refusedNoPm.body },
    );
    const onAgain = await flip(true);
    const afterOn = await cfgOf(qSaved.body.id);
    const offAgain = await flip(false);
    const afterOff = await cfgOf(qSaved.body.id);
    const noUnit = await atT(T17, () =>
      app.inject({
        method: "POST",
        url: "/portal/v1/credits/auto_topup",
        headers: { ...auth, "idempotency-key": `chu-portal-${Date.now()}-${++pk}` },
        payload: { unit: "token", enabled: true },
      }),
    );
    check(
      "the buyer enables it (the threshold returns to the gate) and disables it; a unit with no top-up is 404",
      onAgain.statusCode === 200 &&
        JSON.parse(onAgain.body).status === "active" &&
        afterOn.status === "active" &&
        offAgain.statusCode === 200 &&
        afterOff.status === "disabled" &&
        afterOff.disabledReason === "customer" &&
        (await tRowFull(q.id))?.topupThresholdSteps === null &&
        noUnit.statusCode === 404,
      { on: onAgain.statusCode, off: offAgain.statusCode, noUnit: noUnit.statusCode, afterOff },
    );
    await systemDb.update(businesses).set({ creditConfig: null }).where(eq(businesses.id, tb.id));
  }

  // A schedule buys one purchase on its day.
  const s = await buyer("4242424242424242");
  const day = T0.getUTCDate();
  const sSaved = await put(
    s,
    body({
      trigger: "schedule",
      threshold_units: undefined,
      schedule: { every: "month", day },
      pack_quantity: 2,
    }),
  );
  await pass(T0);
  const sRuns = await runsOf((await cfgOf(sSaved.body.id)).id);
  check(
    "a schedule with pack_quantity 2 buys two packs in one purchase on its day",
    sSaved.status === 200 &&
      sSaved.body.amount_minor === 1800 &&
      sRuns.length === 1 &&
      sRuns[0]!.status === "succeeded" &&
      (await tRow(s.id)) === 300n,
    { sSaved: sSaved.body, sRuns },
  );
  const patch = await res(call("PATCH", "credit_units/credit", { minor_per_unit: "0.01" }, o));
  check("the unit cannot take a rate while it is in use (409)", patch.status === 409, patch);
  await inStep("after the top-ups", orgId);
}

// ── 10. Hold expiry by the time-travel API ───────────────────────────────────────
console.log("10. time travel");
{
  const bizT = await createBusiness({
    organizationId: orgId,
    name: "Travel",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const tb = { biz: bizT.publicId };
  const G = new Date("2025-03-10T00:00:00.000Z");
  const iso = (ms: number) => new Date(G.getTime() + ms).toISOString();
  await must(201, "POST", "time_travel/start", { genesis_time: G.toISOString() }, tb);
  await setConfig(OPEN, bizT.id);
  await must(
    201,
    "POST",
    "credit_units",
    {
      id: "credit",
      name: "credit",
      plural_name: "credits",
      currency: "USD",
      minor_per_unit: null,
      decimals: 0,
    },
    tb,
  );
  await must(
    201,
    "POST",
    "meters",
    { id: "illustration", name: "Illustrations", event_name: "illustration", aggregation: "count" },
    tb,
  );
  await must(
    200,
    "PUT",
    "meters/illustration/credit_cost",
    { unit: "credit", credits_per_unit: "1" },
    tb,
  );
  const cus = (await must(
    201,
    "POST",
    "customers",
    { email: `travel-${Date.now()}@example.com`, auto_collection: "off" },
    tb,
  )) as { id: string };
  await must(201, "POST", `customers/${cus.id}/credit_grants`, { unit: "credit", amount: 10 }, tb);
  const h = await must(
    201,
    "POST",
    `customers/${cus.id}/credit_holds`,
    { meter: "illustration", units: 10, expires_in: 3600 },
    tb,
  );
  const accessT = async () =>
    (await must(200, "GET", `customers/${cus.id}/access?meter=illustration`, undefined, tb)) as {
      code: string;
      credits: { available: string; held: string };
    };
  const before = await accessT();
  check(
    "the hold is made at the simulated time and keeps all 10 credits",
    h.expires_at === iso(HOUR) &&
      before.code === "insufficient_credit" &&
      before.credits.held === "10",
    { expires: h.expires_at, before },
  );
  await must(200, "POST", "time_travel/advance", { to_time: iso(30 * MIN) }, tb);
  check("travel to 30 minutes: the hold is still open", (await holdRow(h.id)).status === "held");
  await must(200, "POST", "time_travel/advance", { to_time: iso(2 * HOUR) }, tb);
  const after = await accessT();
  check(
    "travel past the expiry: the pass ends the hold and the 10 credits are available",
    (await holdRow(h.id)).status === "expired" &&
      after.code === "ok" &&
      after.credits.available === "10" &&
      after.credits.held === "0",
    { status: (await holdRow(h.id)).status, after },
  );
  await inStep("after the time travel");
}

// ── 11. Isolation between organizations ──────────────────────────────────────────
console.log("11. isolation");
{
  const T = plus(12 * HOUR);
  const c = await customer("rls");
  await give(c, 50);
  const h = await hold(T, c, { meter: "illustration", units: 1 });
  const other = await createOrganization({ name: "Credit Holds Units Other Org" });
  const otherBiz = await createBusiness({
    organizationId: other.organization.id,
    name: "Other",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const mine = await withTenant(orgId, (tx) => tx.select().from(creditHolds));
  const theirs = await withTenant(other.organization.id, (tx) => tx.select().from(creditHolds));
  const theirRows = await withTenant(other.organization.id, (tx) =>
    tx.select().from(creditUnitBalances),
  );
  check(
    "RLS: the other organization reads no hold and no balance row",
    mine.length > 0 && theirs.length === 0 && theirRows.length === 0,
    { mine: mine.length, theirs: theirs.length, rows: theirRows.length },
  );
  const cross = { secret: other.secret, biz: otherBiz.publicId };
  const read = await res(call("GET", `credit_holds/${h.body.id}`, undefined, cross));
  const rel = await res(call("POST", `credit_holds/${h.body.id}/release`, {}, cross));
  const cap = await res(
    call("POST", `credit_holds/${h.body.id}/capture`, { usage_event_id: "x" }, cross),
  );
  const moved = await withTenant(other.organization.id, (tx) =>
    tx
      .update(creditUnitBalances)
      .set({ heldSteps: 0n })
      .where(eq(creditUnitBalances.customerId, c.id))
      .returning(),
  );
  check(
    "the other organization cannot read, release or capture the hold, or move the row",
    read.status === 404 &&
      rel.status === 404 &&
      cap.status === 404 &&
      moved.length === 0 &&
      (await holdRow(h.body.id)).status === "held" &&
      (await row(c.id)).held === 10n,
    { read: read.status, rel: rel.status, cap: cap.status },
  );
  await inStep("at the end");
}

// ── 12. A refused event is cost, not usage ───────────────────────────────────────
console.log("12. a refused event counts as cost, not as usage");
{
  const T = plus(13 * HOUR);
  const c = await customer("cost-not-usage");
  await give(c, 30);
  const [meter] = rowsOf<{ id: string }>(
    await systemDb.execute(
      sql`select id from meters where business_id = ${biz.id} and key = 'illustration'`,
    ),
  );
  const window = { start: plus(12 * HOUR), end: plus(15 * HOUR) };
  const sendCost = async (key: string) => {
    const [r] = await at(T, () =>
      ingestUsageEvents({
        ...ids,
        events: [
          { key, customer: c.publicId, event_name: "illustration", cost: "0.25", currency: "USD" },
        ],
      }),
    );
    return r as Sent;
  };
  const total = async () => {
    const u = await withTenant(orgId, (tx) =>
      readMeterUsage(tx, { customerId: c.id, meterId: meter!.id, window }),
    );
    return u.segments.flatMap((x) => x.rows).reduce((a, r) => a + r.quantity, 0n) / 10n ** 12n;
  };
  const apiTotal = async () => {
    const h = await must(
      200,
      "GET",
      `customers/${c.publicId}/usage?meter=illustration&from=${window.start.toISOString()}&to=${window.end.toISOString()}`,
    );
    return (h.data as Array<{ quantity: string }>).reduce((a, d) => a + Number(d.quantity), 0);
  };
  const days = [...new Set([window.start, window.end].map((d) => d.toISOString().slice(0, 10)))];
  const costFold = async () => {
    await foldUsageCostDays({ ...ids, days, timezone: null });
    const rows = await systemDb
      .select()
      .from(usageCostDaily)
      .where(and(eq(usageCostDaily.customerId, c.id), eq(usageCostDaily.meterId, meter!.id)));
    return {
      cost: rows.reduce((a, r) => a + (r.costMinor ?? 0n), 0n),
      quantity: rows.reduce((a, r) => a + Number(r.quantity), 0),
    };
  };
  const stamp = Date.now();
  const ok = await sendCost(`chu-cost-ok-${stamp}`);
  // A hold-covered event: accepted, so it counts in both.
  const h = await hold(T, c, { meter: "illustration", units: 2 });
  const held = {
    ...ev(c, "illustration", `chu-cost-held-${stamp}`),
    cost: "0.25",
    currency: "USD",
  };
  const cap = await capture(T, h.body.id, { usage_event: held });
  const one = await sendCost(`chu-cost-last-${stamp}`);
  const no = await sendCost(`chu-cost-refused-${stamp}`);
  check(
    "three events are accepted (one by a capture) and the fourth is refused",
    ok.status === "created" &&
      cap.status === 200 &&
      one.status === "created" &&
      no.error?.code === "insufficient_credit",
    { ok, cap: cap.status, one, no },
  );
  const first = { usage: await total(), api: await apiTotal(), fold: await costFold() };
  check(
    "usage counts the 3 accepted events and not the refused one: the meter total and the usage API",
    first.usage === 3n && first.api === 3,
    first,
  );
  check(
    "the daily cost fold keeps the refused event's cost (4 × 0.25) with the quantity of the 3 that count",
    first.fold.cost === 100n && first.fold.quantity === 3,
    first.fold,
  );
  const listed = await must(200, "GET", `usage_events?customer=${c.publicId}&limit=100`);
  const shown = (listed.data as Array<{ key: string; refused_at: string | null }>).find(
    (e) => e.key === no.key,
  );
  const accepted = (listed.data as Array<{ key: string; refused_at: string | null }>).find(
    (e) => e.key === ok.key,
  );
  check(
    "the events API lists the refused event with refused_at; an accepted event has none",
    !!shown?.refused_at && accepted?.refused_at === null,
    { shown, accepted },
  );
  const replay = await sendCost(no.key!);
  const second = { usage: await total(), api: await apiTotal(), fold: await costFold() };
  check(
    "a replay of the refused key is refused again and changes neither usage nor cost",
    replay.error?.code === "insufficient_credit" &&
      second.usage === 3n &&
      second.api === 3 &&
      second.fold.cost === 100n &&
      second.fold.quantity === 3,
    { replay, second },
  );
  // The fold passes the refused event; then a capture pays it and it enters the usage totals.
  await systemDb.execute(sql`
    update usage_rollup_state set watermark = clock_timestamp() where business_id = ${biz.id}`);
  await give(c, 10);
  const h2 = await hold(T, c, { meter: "illustration", units: 1 });
  const paid = await capture(T, h2.body.id, { usage_event_id: no.key });
  const third = { usage: await total(), api: await apiTotal(), fold: await costFold() };
  const [flag] = rowsOf<{ refused_at: string | null }>(
    await systemDb.execute(
      sql`select refused_at from usage_events where business_id = ${biz.id} and key = ${no.key}`,
    ),
  );
  check(
    "a capture that pays the refused event: it counts as usage from then, and its cost is counted once",
    paid.status === 200 &&
      flag?.refused_at === null &&
      third.usage === 4n &&
      third.api === 4 &&
      third.fold.cost === 100n &&
      third.fold.quantity === 4,
    { paid: paid.status, flag, third },
  );
  const plainEvent = await send(T, c, "plain");
  check(
    "a meter with no credit cost never refuses: its event has no refused_at",
    plainEvent.status === "created" &&
      rowsOf<{ refused_at: string | null }>(
        await systemDb.execute(
          sql`select refused_at from usage_events where business_id = ${biz.id} and key = ${plainEvent.key}`,
        ),
      )[0]?.refused_at === null,
    plainEvent,
  );
  await inStep("after refused events");
}

await app.close();
await closeDb();
if (fails.length) {
  console.log(`\n❌ CREDIT-HOLDS-UNITS: FAIL (${fails.length})`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\n✅ CREDIT-HOLDS-UNITS: PASS");
process.exit(0);
