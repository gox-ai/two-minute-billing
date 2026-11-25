/**
 * Usage beyond the credits of a unit with no money rate (0530):
 *  - `bill` with the unit's price, the meter's price, both (the meter wins), neither (refused);
 *  - the money part as a usage line of the period invoice, apart from the information line;
 *  - the correctness rule: units billed in money are never repaid by the next grant;
 *  - the overdraft floor (0, inside, at the limit) and the next grant repaying first;
 *  - a plan reset with an overshoot: carry and forgive;
 *  - a customer with no subscription: the one-off invoice, void (forgiven), write-off (blocked),
 *    no saved payment method;
 *  - a void after settlement: given credit, paid credit, an expired grant, a billed part;
 *  - a full pack refund; a paid grant voided with no refund; the per-unit basis on plan credits;
 *  - parallel events across the zero line and across the floor;
 *  - the engine choices of `credit_config`: `trial_usage`, `no_subscription_usage`,
 *    `no_subscription_overdraft`, `no_subscription_invoice_after_days`, `restore_expiry_months`
 *    (each unset value is the rule the sections above check).
 * Every step runs at a pinned business time; the balance rule and the ledger after each.
 *
 *   pnpm verify:all:fresh -- --suite credit-overage
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { runWithClockScope } from "@/platform/clock";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import {
  createManualInvoice,
  recordOfflinePayment,
  voidInvoice,
  writeOffInvoice,
} from "@/modules/invoicing/ops";
import { issueRefundableCreditNote } from "@/modules/credit-notes/service";
import { ingestUsageEvents, voidUsageEvent } from "@/modules/metering/ingest";
import { unitBalanceSteps, voidCreditGrant } from "@/modules/credits/service";
import { applyPlanCredits } from "@/modules/credits/plan-credits";
import { runExpireCreditGrants } from "@/modules/credits/expiry";
import { runSettleCreditUsage } from "@/modules/credits/usage-settlement";
import { creditUsageSoFar, runBillCreditOverage } from "@/modules/credits/overage";
import { createFlatTaxRate } from "@/modules/tax/service";
import { applyCouponToSubscription, createCoupon } from "@/modules/coupons/service";
import { measureSpend } from "@/modules/usage-controls/measure";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { updatePrice } from "@/modules/catalog/service";
import {
  auditLogs,
  businesses,
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrants,
  creditUnits,
  creditUsageEvents,
  creditUsageSettlements,
  invoiceLineItems,
  invoices,
  subscriptions,
  unbilledCharges,
} from "@db/schema";
import { checker, meterBusiness } from "./lib/meter-fixtures";

const { fails, check } = checker();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const B = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const plus = (ms: number) => new Date(B.getTime() + ms);

const { org, orgId, biz, ids, product } = await meterBusiness("Credit Overage Org");
const app = await buildApp({ logger: false });
const at = <T>(t: Date, fn: () => Promise<T>) =>
  runWithClockScope({ onlyBusinessId: biz.id, now: t }, fn);

let keyN = 0;
const call = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: object,
) =>
  app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}/${path}`,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": `co-${Date.now()}-${++keyN}` }),
    },
    ...(payload ? { payload } : {}),
  });
const must = async (status: number, ...args: Parameters<typeof call>) => {
  const r = await call(...args);
  if (r.statusCode !== status)
    throw new Error(`${args[0]} ${args[1]} answered ${r.statusCode}, not ${status}: ${r.body}`);
  return JSON.parse(r.body);
};
const rowsOf = <T>(r: unknown) => r as T[];

async function ledger(customerId: string) {
  const rows = rowsOf<{ account: string; net: string }>(
    await systemDb.execute(sql`
      select account,
        sum(case when direction = 'debit' then amount_minor else -amount_minor end)::text as net
      from ledger_entries where customer_id = ${customerId} group by account`),
  );
  return Object.fromEntries(rows.map((r) => [r.account, BigInt(r.net)])) as Record<string, bigint>;
}
/** The balance rule: the row = grants − taken; below 0 only by an unbilled overshoot. */
async function drift(): Promise<unknown[]> {
  return rowsOf(
    await systemDb.execute(sql`
      select k.customer_id, coalesce(bal.available_steps, 0)::text as balance,
        (coalesce(g.steps, 0) - coalesce(t.steps, 0) - coalesce(gr.steps, 0))::text as expected
      from (
        select customer_id, unit_id from credit_unit_balances where organization_id = ${orgId}
        union
        select customer_id, unit_id from credit_grants where organization_id = ${orgId} and not unit_rated
      ) k
      left join credit_unit_balances bal on bal.customer_id = k.customer_id and bal.unit_id = k.unit_id
      left join lateral (
        select sum(m.units) as steps from credit_grants cg
        join credit_grant_movements m on m.grant_id = cg.id
        where cg.customer_id = k.customer_id and cg.unit_id = k.unit_id and not cg.unit_rated
          and not cg.out_of_balance) g on true
      left join lateral (
        select sum(c.units) as steps from credit_usage_events c
        where c.customer_id = k.customer_id and c.unit_id = k.unit_id
          and c.status in ('taken', 'pending')) t on true
      left join lateral (
        select sum(c.units) as steps from credit_usage_events c
        where c.customer_id = k.customer_id and c.unit_id = k.unit_id
          and c.source = 'overdraft' and c.status = 'taken') od on true
      left join lateral (
        select sum(x.available_steps) as steps from credit_grant_grace x
        where x.customer_id = k.customer_id and x.unit_id = k.unit_id and x.locked_at is null) gr on true
      where coalesce(bal.available_steps, 0) + coalesce(od.steps, 0) < 0
        or coalesce(bal.available_steps, 0)
          <> coalesce(g.steps, 0) - coalesce(t.steps, 0) - coalesce(gr.steps, 0)`),
  );
}
async function unbalanced(): Promise<number> {
  return rowsOf(
    await systemDb.execute(sql`
      select transaction_id from ledger_entries where organization_id = ${orgId}
      group by transaction_id
      having sum(case when direction = 'debit' then amount_minor else -amount_minor end) <> 0`),
  ).length;
}
async function paidMatches(customerId: string): Promise<boolean> {
  const [r] = rowsOf<{ left: string }>(
    await systemDb.execute(sql`
      select coalesce(sum(m.cost_minor), 0)::text as left from credit_grants g
      join credit_grant_movements m on m.grant_id = g.id
      where g.customer_id = ${customerId} and g.category = 'paid'`),
  );
  return -((await ledger(customerId))[A.paid] ?? 0n) === BigInt(r!.left);
}
/** No usage row is both billed in money and an overshoot, and a billed part names an invoice. */
async function oneState(): Promise<number> {
  return rowsOf(
    await systemDb.execute(sql`
      select id from credit_usage_events where organization_id = ${orgId}
        and ((source = 'overdraft' and units_uncovered > 0)
          or (status = 'billed' and overage_invoice_id is null)
          or (overage_basis is not null and source = 'overdraft'))`),
  ).length;
}
const inStep = async (label: string) => {
  const d = await drift();
  check(`${label}: the balance row equals its rule`, d.length === 0, d);
  check(`${label}: every ledger transaction balances`, (await unbalanced()) === 0);
  check(`${label}: every unit of usage is in one state`, (await oneState()) === 0);
};
const customer = async (tag: string, o: { pm?: boolean; autoCollection?: "on" | "off" } = {}) => {
  const c = await createCustomer({
    ...ids,
    email: `${tag}-${Date.now()}@example.com`,
    autoCollection: o.autoCollection ?? "off",
  });
  if (o.pm) await vaultPaymentMethod({ ...ids, customer: c, token: "tok_4242" });
  return c;
};
/** The business's credit config, and the unit's policies through the credit unit API. */
const setConfig = async (
  cfg: Record<string, unknown> | null,
  unit: { overage?: string; overdraft?: number; reset?: "carry" | "forgive" } = {},
) => {
  await systemDb
    .update(businesses)
    .set({ creditConfig: cfg as never })
    .where(eq(businesses.id, biz.id));
  await must(200, "PATCH", "credit_units/credit", {
    overage_minor_per_unit: unit.overage ?? null,
    overdraft_limit: unit.overdraft ?? 0,
    negative_balance_at_reset: unit.reset ?? "carry",
  });
};

let evN = 0;
type Sent = { status: string; key: string | null; error?: { code: string } };
const send = async (t: Date, c: { publicId: string }, n: number, key?: string): Promise<Sent> => {
  const [r] = await at(t, () =>
    ingestUsageEvents({
      ...ids,
      events: [
        {
          key: key ?? `co-ev-${Date.now()}-${++evN}`,
          customer: c.publicId,
          event_name: "render",
          properties: { n: String(n) },
        },
      ],
    }),
  );
  return r as Sent;
};
const rowsOfKey = (key: string) =>
  systemDb
    .select()
    .from(creditUsageEvents)
    .where(and(eq(creditUsageEvents.businessId, biz.id), eq(creditUsageEvents.eventKey, key)))
    .orderBy(creditUsageEvents.part);
const give = async (c: { publicId: string }, amount: number, t: Date, expires?: Date) =>
  at(t, () =>
    must(201, "POST", `customers/${c.publicId}/credit_grants`, {
      unit: "credit",
      amount,
      ...(expires ? { expires_at: expires.toISOString() } : {}),
    }),
  ) as Promise<{ id: string }>;
const givePaid = async (c: { publicId: string }, amount: number, priceMinor: number, t: Date) =>
  at(t, () =>
    must(201, "POST", `customers/${c.publicId}/credit_grants`, {
      category: "paid",
      unit: "credit",
      amount,
      price_minor: priceMinor,
      tax_treatment: "taxed_at_purchase",
      mark_paid: { method: "bank_transfer" },
    }),
  ) as Promise<{ id: string }>;
const settle = (t: Date) => at(t, () => runSettleCreditUsage(t));
/** The balance API's outcome for the unit: must agree with what the gate did (#445). */
const outcome = async (c: { publicId: string }, t: Date) =>
  (
    (await at(t, () => must(200, "GET", `customers/${c.publicId}/access`))) as {
      available_units: Array<{ unit: string; on_exhausted?: Record<string, unknown> }>;
    }
  ).available_units.find((u) => u.unit === "credit")?.on_exhausted;

// ── Setup: a unit with no rate (whole credits), a meter that costs 1 credit per unit ──
await must(201, "POST", "credit_units", {
  id: "credit",
  name: "credit",
  plural_name: "credits",
  currency: "USD",
  minor_per_unit: null,
  decimals: 0,
});
const [unit] = await systemDb
  .select()
  .from(creditUnits)
  .where(and(eq(creditUnits.businessId, biz.id), eq(creditUnits.key, "credit")));
const unitId = unit!.id;
const row = (customerId: string) =>
  withTenant(orgId, (tx) => unitBalanceSteps(tx, { customerId, unitId }));
await must(201, "POST", "meters", {
  id: "render",
  name: "Renders",
  event_name: "render",
  aggregation: "sum",
  value_property: "n",
});
await must(200, "PUT", "meters/render/credit_cost", { unit: "credit", credits_per_unit: "1" });
const planPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `co-plan-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 3900,
  interval: "month",
});
// The meter's own usage price: 0.25 per render. It bills only what credits do not pay.
const meterPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `co-render-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: "render",
  unitAmountDecimal: "25",
});
const S = plus(-DAY);
const E = plus(29 * DAY);
async function subscribe(c: { id: string }, withMeterPrice: boolean) {
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [
      { price: planPrice, quantity: 1 },
      ...(withMeterPrice ? [{ price: meterPrice, quantity: 1 }] : []),
    ],
  });
  await systemDb
    .update(subscriptions)
    .set({ startedAt: S, currentPeriodStart: S, currentPeriodEnd: E })
    .where(eq(subscriptions.id, sub.subscription.id));
  return (
    await systemDb.select().from(subscriptions).where(eq(subscriptions.id, sub.subscription.id))
  )[0]!;
}
const billPeriod = (sub: typeof subscriptions.$inferSelect) =>
  at(E, () =>
    billSubscriptionPeriod({
      ...ids,
      subscription: sub,
      periodStart: E,
      periodEnd: new Date(E.getTime() + 30 * DAY),
      usagePeriod: { start: S, end: E },
    }),
  );
const linesOf = (invoiceId: string) =>
  systemDb.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));

// ── 1. bill with the unit's price, the meter's price, both, neither ─────────────────
console.log("1. bill: the unit's price, the meter's price, both, neither");
await setConfig(null, { overage: "10" });
const unitBuyer = await customer("unit-price");
const unitSub = await subscribe(unitBuyer, false);
await give(unitBuyer, 10, plus(-HOUR));
const u1 = await send(plus(MIN), unitBuyer, 15);
const u1r = await rowsOfKey(u1.key!);
check(
  "unit price: 15 renders with 10 credits are accepted; 10 covered, 5 billed at 0.10",
  u1.status === "created" &&
    u1r[0]!.units === 10n &&
    u1r[0]!.unitsUncovered === 5n &&
    u1r[0]!.overageBasis === "unit" &&
    u1r[0]!.overageRateE12 === 10_000_000_000_000n &&
    (await row(unitBuyer.id)) === 0n,
  u1r,
);
await inStep("after the unit-price event");

const meterBuyer = await customer("meter-price");
const meterSub = await subscribe(meterBuyer, true);
await give(meterBuyer, 4, plus(-HOUR));
const m1 = await send(plus(2 * MIN), meterBuyer, 10);
const m1r = await rowsOfKey(m1.key!);
check(
  "both prices: the meter's own price wins (basis meter, its price fixed on the row)",
  m1.status === "created" &&
    m1r[0]!.overageBasis === "meter" &&
    m1r[0]!.overagePriceId === meterPrice.id &&
    m1r[0]!.units === 4n &&
    m1r[0]!.unitsUncovered === 6n,
  m1r,
);
await setConfig(null);
const meterOnly = await customer("meter-only");
const meterOnlySub = await subscribe(meterOnly, true);
const m2 = await send(plus(3 * MIN), meterOnly, 3);
check(
  "meter price only, no credits at all: all 3 are billed by the meter price",
  m2.status === "created" && (await rowsOfKey(m2.key!))[0]!.unitsUncovered === 3n,
  await rowsOfKey(m2.key!),
);
const neither = await customer("neither");
await subscribe(neither, false);
await give(neither, 2, plus(-HOUR));
const n1 = await send(plus(4 * MIN), neither, 5);
check(
  "neither price: bill acts as block, the event is refused (402) and nothing is taken",
  n1.error?.code === "insufficient_credit" && (await row(neither.id)) === 2n,
  n1,
);
const oNeither = await outcome(neither, plus(4 * MIN));
check(
  "balance API: no money price states refuse for the unit (billed none, floor 0)",
  oNeither?.policy === "bill" && oNeither.billed === "none" && oNeither.overdraft_units === 0,
  oNeither,
);
const oMeter = await outcome(meterBuyer, plus(4 * MIN));
check(
  "balance API: the meter's own price states bill for the unit (billed all)",
  oMeter?.billed === "all",
  oMeter,
);
await setConfig(null, { overage: "10" });
const oUnit = await outcome(neither, plus(4 * MIN));
check(
  "balance API: the unit's overage price states bill for every meter (billed all)",
  oUnit?.policy === "bill" && oUnit.billed === "all" && oUnit.source === "business_blocking_off",
  oUnit,
);
await setConfig(null);
await inStep("after the price cases");

// ── 2. The money part on the period invoice; the correctness rule ───────────────────
console.log("2. the period invoice and the correctness rule");
await setConfig(null, { overage: "10" });
const inv1 = await billPeriod(unitSub);
const lines1 = await linesOf(inv1.invoice.id);
const money1 = lines1.find((l) => l.kind === "usage" && l.amountMinor === 50n);
const info1 = lines1.find((l) => l.kind === "credit_usage");
check(
  "the unit price's 5 credits are one usage line of 0.50, apart from the zero information line",
  !!money1 && /more than the credit balance/.test(money1.description) && info1?.amountMinor === 0n,
  lines1.map((l) => [l.kind, l.amountMinor, l.description]),
);
check(
  "the information line states the covered quantity only (10 of 15)",
  /10/.test(info1?.description ?? "") && !/15/.test(info1?.description ?? ""),
  info1?.description,
);
const [charged] = await systemDb
  .select()
  .from(unbilledCharges)
  .where(eq(unbilledCharges.subscriptionId, unitSub.id));
check(
  "the charge is billed on that invoice, and the event names it",
  charged?.status === "billed" && (await rowsOfKey(u1.key!))[0]!.overageChargeId === charged.id,
  charged,
);
const inv2 = await billPeriod(meterSub);
const lines2 = await linesOf(inv2.invoice.id);
check(
  "the meter price bills 6 uncovered renders at 0.25 = 1.50, with the price on the line",
  lines2.some((l) => l.kind === "usage" && l.amountMinor === 150n && l.priceId === meterPrice.id) &&
    !lines2.some((l) => l.kind === "usage" && l.amountMinor === 250n),
  lines2.map((l) => [l.kind, l.amountMinor, l.priceId]),
);
const inv3 = await billPeriod(meterOnlySub);
check(
  "a meter paid in credits is not billed from its whole quantity (no 0.75 + 0.75 double line)",
  (await linesOf(inv3.invoice.id)).filter((l) => l.kind === "usage" && l.amountMinor > 0n)
    .length === 1,
  (await linesOf(inv3.invoice.id)).map((l) => [l.kind, l.amountMinor]),
);
// The next grant: units already billed in money are never repaid from it.
await give(unitBuyer, 20, E);
await settle(plus(31 * DAY));
check(
  "a new grant of 20 is all available: the 5 billed credits are not repaid from it",
  (await row(unitBuyer.id)) === 20n,
  await row(unitBuyer.id),
);
const again = await billPeriod(unitSub).catch(() => null);
check(
  "a second period invoice bills the overage again: no (the event is charged once)",
  !again || !(await linesOf(again.invoice.id)).some((l) => l.amountMinor === 50n),
);
await inStep("after the period invoices");

// ── 3. The overdraft floor and repaying first ───────────────────────────────────────
console.log("3. the overdraft floor");
await setConfig({ blocking_enabled: true, on_exhausted_default: "block" });
const zero = await customer("floor-zero");
await subscribe(zero, false);
await give(zero, 3, plus(-HOUR));
const z1 = await send(plus(5 * MIN), zero, 4);
check(
  "floor 0 (the default): an event past the balance is refused, as before",
  z1.error?.code === "insufficient_credit" && (await row(zero.id)) === 3n,
);
await setConfig({ blocking_enabled: true, on_exhausted_default: "block" }, { overdraft: 5 });
const od = await customer("floor-five");
const odSub = await subscribe(od, false);
await give(od, 3, plus(-HOUR));
const o1 = await send(plus(6 * MIN), od, 7);
const o1r = await rowsOfKey(o1.key!);
check(
  "inside the floor: 3 covered, 4 taken below zero as an overshoot part; the row is -4",
  o1.status === "created" &&
    o1r.length === 2 &&
    o1r[0]!.units === 3n &&
    o1r[1]!.source === "overdraft" &&
    o1r[1]!.units === 4n &&
    o1r[1]!.unitsUncovered === 0n &&
    (await row(od.id)) === -4n,
  o1r,
);
const oOd = await outcome(od, plus(6 * MIN));
check(
  "balance API: block with a floor of 5 states the floor (billed none, 5 units)",
  oOd?.policy === "block" && oOd.billed === "none" && oOd.overdraft_units === 5,
  oOd,
);
const o2 = await send(plus(7 * MIN), od, 2);
check("past the floor (-6 of -5): refused whole", o2.error?.code === "insufficient_credit");
const o3 = await send(plus(8 * MIN), od, 1);
check(
  "at the floor exactly (-5): accepted",
  o3.status === "created" && (await row(od.id)) === -5n,
  await row(od.id),
);
check(
  "one more is refused at the floor",
  (await send(plus(9 * MIN), od, 1)).error?.code === "insufficient_credit",
);
// The page shows what each meter used with no credit left: an event that crosses zero keeps its
// quantity on its first part, so the overdraft part's share counts (7 − 3 = 4, then 1 more).
const usageAtFloor = await withTenant(orgId, (tx) =>
  creditUsageSoFar(tx, {
    customerId: od.id,
    subscriptionId: odSub.id,
    currency: "USD",
    subscriptionStart: odSub.startedAt ?? odSub.createdAt,
    before: plus(10 * MIN),
  }),
);
check(
  "below zero: the crossing event's share counts, so 5 used with no credit left; balance -5",
  usageAtFloor.length === 1 &&
    Number(usageAtFloor[0]!.belowZeroQuantity) === 5 &&
    usageAtFloor[0]!.overshootUnits === "5",
  usageAtFloor,
);
await inStep("at the floor");
await give(od, 10, plus(10 * MIN));
check(
  "the next grant pays the overshoot first: 10 granted, 5 owed, the row is 5",
  (await row(od.id)) === 5n,
);
await settle(plus(2 * HOUR));
const repaid = await systemDb
  .select()
  .from(creditUsageEvents)
  .where(and(eq(creditUsageEvents.customerId, od.id), eq(creditUsageEvents.source, "overdraft")));
check(
  "settlement draws the overshoot from that grant: every overshoot part is settled",
  repaid.length > 0 && repaid.every((r) => r.status === "settled") && (await row(od.id)) === 5n,
  repaid.map((r) => [r.status, r.units]),
);
await inStep("after repaying the overshoot");

// ── 4. A plan reset with an unbilled overshoot: carry and forgive ───────────────────
console.log("4. a plan reset: carry and forgive");
const resetPlan = await createPrice({
  ...ids,
  productId: product.id,
  id: `co-reset-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  interval: "month",
});
await updatePrice({
  ...ids,
  pricePublicId: resetPlan.publicId,
  grantsCredit: { kind: "per_cycle", unit: "credit", amount: 10 },
});
async function planCustomer(tag: string) {
  const c = await customer(tag);
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price: resetPlan, quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({ startedAt: S, currentPeriodStart: S, currentPeriodEnd: E })
    .where(eq(subscriptions.id, sub.subscription.id));
  const cycle = (start: Date, end: Date) =>
    at(start, () =>
      withTenant(orgId, (tx) =>
        applyPlanCredits(tx, {
          ...ids,
          subscription: { id: sub.subscription.id, customerId: c.id, currency: "USD" },
          periodStart: start,
          periodEnd: end,
        }),
      ),
    );
  await cycle(S, E);
  return { c, cycle };
}
const carry = await planCustomer("carry");
await send(plus(11 * MIN), carry.c, 13);
check("carry: 10 plan credits, 13 used, the row is -3", (await row(carry.c.id)) === -3n);
await carry.cycle(E, new Date(E.getTime() + 30 * DAY));
check(
  "carry (the default): the next term's 10 pay the 3 first, the row is 7",
  (await row(carry.c.id)) === 7n,
  await row(carry.c.id),
);
await setConfig(
  { blocking_enabled: true, on_exhausted_default: "block" },
  { overdraft: 5, reset: "forgive" },
);
const forgive = await planCustomer("forgive");
await send(plus(12 * MIN), forgive.c, 14);
await forgive.cycle(E, new Date(E.getTime() + 30 * DAY));
const forgiven = await systemDb
  .select()
  .from(creditUsageEvents)
  .where(
    and(eq(creditUsageEvents.customerId, forgive.c.id), eq(creditUsageEvents.source, "overdraft")),
  );
const zeroAudit = await systemDb
  .select()
  .from(auditLogs)
  .where(and(eq(auditLogs.businessId, biz.id), eq(auditLogs.action, "credit.zero_out")));
check(
  "forgive: the 4 owed are written off at the reset (reason plan_reset), the row is the full 10",
  (await row(forgive.c.id)) === 10n &&
    forgiven.every((r) => r.status === "forgiven" && r.zeroReason === "plan_reset") &&
    zeroAudit.some((a) => (a.after as { reason?: string })?.reason === "plan_reset"),
  { row: await row(forgive.c.id), forgiven },
);
await inStep("after the resets");

// ── 5. A customer with no subscription: the one-off invoice ─────────────────────────
console.log("5. a customer with no subscription");
await setConfig(
  { blocking_enabled: true, on_exhausted_default: "block" },
  { overdraft: 5, overage: "10" },
);
const noPm = await customer("pack-no-pm");
await give(noPm, 2, plus(-HOUR));
check(
  "no saved payment method: the floor is 0, an event past the balance is refused",
  (await send(plus(13 * MIN), noPm, 3)).error?.code === "insufficient_credit",
);
const packOnly = await customer("pack-only", { pm: true });
await give(packOnly, 2, plus(-HOUR));
const p1 = await send(plus(14 * MIN), packOnly, 5);
check(
  "with a saved method and the unit's price: 2 covered, 3 overdrawn",
  p1.status === "created" && (await row(packOnly.id)) === -3n,
  await row(packOnly.id),
);
const early = await at(plus(15 * MIN), () => runBillCreditOverage(plus(15 * MIN)));
check("no invoice before the window ends", early.invoiced === 0, early);
const T5 = plus(31 * DAY);
const run5 = await at(T5, () => runBillCreditOverage(T5));
const [oneOff] = await systemDb
  .select()
  .from(invoices)
  .where(
    and(eq(invoices.customerId, packOnly.id), sql`${invoices.originToken} like 'credit-overage:%'`),
  );
check(
  "a window later: a one-off invoice of 0.30, the parts billed, the row back to 0",
  run5.invoiced >= 1 &&
    oneOff?.totalMinor === 30n &&
    (await row(packOnly.id)) === 0n &&
    (await rowsOfKey(p1.key!)).some(
      (r) => r.status === "billed" && r.overageInvoiceId === oneOff.id,
    ),
  { run5, oneOff, rows: await rowsOfKey(p1.key!) },
);
check(
  "the next pass bills nothing again",
  (await at(T5, () => runBillCreditOverage(T5))).invoiced === 0,
);
check(
  "while that invoice is open the floor is 0",
  (await send(plus(31 * DAY + MIN), packOnly, 1)).error?.code === "insufficient_credit",
);
await voidInvoice(orgId, biz.id, oneOff!.publicId);
check(
  "a void forgives the debt: the parts are forgiven with reason invoice_voided",
  (await rowsOfKey(p1.key!))
    .filter((r) => r.source === "overdraft")
    .every((r) => r.status === "forgiven" && r.zeroReason === "invoice_voided"),
  await rowsOfKey(p1.key!),
);
check(
  "after the void the floor is back",
  (await send(plus(31 * DAY + 2 * MIN), packOnly, 1)).status === "created",
);
const bad = await customer("pack-bad", { pm: true });
await give(bad, 1, plus(-HOUR));
await send(plus(16 * MIN), bad, 3);
await at(T5, () => runBillCreditOverage(T5));
const [badInv] = await systemDb
  .select()
  .from(invoices)
  .where(
    and(eq(invoices.customerId, bad.id), sql`${invoices.originToken} like 'credit-overage:%'`),
  );
if (badInv && badInv.status !== "paid") await writeOffInvoice(orgId, biz.id, badInv.publicId);
check(
  "uncollectible (written off): the debt stays billed and the block stays (floor 0)",
  !!badInv &&
    (
      await systemDb
        .select()
        .from(creditUsageEvents)
        .where(eq(creditUsageEvents.customerId, bad.id))
    ).some((r) => r.status === "billed") &&
    (await send(plus(31 * DAY + 3 * MIN), bad, 1)).error?.code === "insufficient_credit",
  badInv,
);
await inStep("after the one-off invoices");

// ── 6. A void after settlement ──────────────────────────────────────────────────────
console.log("6. a void after settlement");
await setConfig(null);
const v = await customer("void-given");
await give(v, 10, plus(-HOUR));
const vEv = await send(plus(17 * MIN), v, 4);
await settle(plus(3 * HOUR));
const vVoid = await at(plus(3 * HOUR + MIN), () => voidUsageEvent({ ...ids, key: vEv.key! }));
const corr = await systemDb
  .select()
  .from(creditUsageSettlements)
  .where(
    and(eq(creditUsageSettlements.customerId, v.id), eq(creditUsageSettlements.kind, "correction")),
  );
check(
  "given credit: a correcting settlement gives the 4 back to the grant",
  !!vVoid.voided_at && corr.length === 1 && corr[0]!.unitsDrawn === 4n && (await row(v.id)) === 10n,
  { corr, row: await row(v.id) },
);
await at(plus(3 * HOUR + 2 * MIN), () => voidUsageEvent({ ...ids, key: vEv.key! }));
check(
  "a second void writes nothing (idempotent)",
  (
    await systemDb
      .select()
      .from(creditUsageSettlements)
      .where(
        and(
          eq(creditUsageSettlements.customerId, v.id),
          eq(creditUsageSettlements.kind, "correction"),
        ),
      )
  ).length === 1,
);
const vp = await customer("void-paid");
await givePaid(vp, 10, 500, plus(-HOUR));
const vpEv = await send(plus(18 * MIN), vp, 4);
await settle(plus(3 * HOUR));
const revBefore = (await ledger(vp.id)).revenue ?? 0n;
await at(plus(3 * HOUR + MIN), () => voidUsageEvent({ ...ids, key: vpEv.key! }));
check(
  "paid credit: the revenue of the 4 (200) is reversed and the grant holds its cost again",
  revBefore - ((await ledger(vp.id)).revenue ?? 0n) === -200n &&
    (await paidMatches(vp.id)) &&
    (await row(vp.id)) === 10n,
  { before: revBefore, after: (await ledger(vp.id)).revenue },
);
const ve = await customer("void-expired");
const veGrant = await give(ve, 10, plus(-HOUR), plus(4 * HOUR));
const veEv = await send(plus(19 * MIN), ve, 4);
await settle(plus(3 * HOUR));
await at(plus(30 * HOUR), () => runExpireCreditGrants(plus(30 * HOUR)));
await at(plus(30 * HOUR), () => runSettleCreditUsage(plus(30 * HOUR)));
await at(plus(31 * HOUR), () => voidUsageEvent({ ...ids, key: veEv.key! }));
const [restore] = await systemDb
  .select()
  .from(creditGrants)
  .where(and(eq(creditGrants.customerId, ve.id), eq(creditGrants.source, "restore")));
check(
  "an expired grant: a restore grant of 4 with a rolling 12-month expiry pays them back",
  restore?.amount === 4n &&
    !!restore.expiresAt &&
    restore.expiresAt.getTime() > plus(31 * HOUR + 360 * DAY).getTime() &&
    (await row(ve.id)) === 4n,
  { restore, veGrant },
);
const billedVoid = await at(plus(31 * DAY + 5 * MIN), () =>
  voidUsageEvent({ ...ids, key: u1.key! }).then(
    () => null,
    (e: Error) => e,
  ),
);
check(
  "an event whose overage part an invoice bills: refused, as a billed event on a money meter",
  billedVoid?.name === "UsageEventBilledError",
  String(billedVoid),
);
await inStep("after the voids");

// ── 7. A full pack refund; a paid grant voided with no refund ───────────────────────
console.log("7. a full pack refund; a paid grant voided with no refund");
const packProduct = await createProduct({ ...ids, name: "Credit packs", kind: "charge" });
const packPrice = await createPrice({
  ...ids,
  productId: packProduct.id,
  id: `co-pack-${Date.now()}`,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 1000,
  grantsCredit: { kind: "pack", unit: "credit", amount: 10, tax_treatment: "taxed_at_purchase" },
});
const fr = await customer("full-refund");
await give(fr, 5, plus(-HOUR));
const sale = await at(plus(20 * MIN), () =>
  createManualInvoice({
    ...ids,
    customerId: fr.id,
    currency: "USD",
    collect: false,
    lines: [
      {
        description: "Pack",
        priceId: packPrice.id,
        quantity: 1,
        amountMinor: 1000n,
        kind: "one_time",
      },
    ],
  }),
);
await at(plus(20 * MIN), () =>
  recordOfflinePayment({ ...ids, invoicePublicId: sale.invoice.publicId, method: "wire" }),
);
await send(plus(21 * MIN), fr, 13);
await settle(plus(3 * HOUR));
// Given 5 first, then 8 of the pack. 5 more given credit can pay part of it again.
await give(fr, 5, plus(3 * HOUR));
const [packLine] = await systemDb
  .select()
  .from(invoiceLineItems)
  .where(eq(invoiceLineItems.invoiceId, sale.invoice.id));
const refusedUnused = await at(plus(3 * HOUR + MIN), () =>
  issueRefundableCreditNote({
    ...ids,
    invoicePublicId: sale.invoice.publicId,
    items: [
      { description: "Refund", amountMinor: 1000, invoiceLineItemPublicId: packLine!.publicId },
    ],
  }).then(
    () => null,
    (e: Error) => e.message,
  ),
);
check("by default only the unused part is refundable: 10.00 is refused", refusedUnused !== null);
await at(plus(3 * HOUR + MIN), () =>
  issueRefundableCreditNote({
    ...ids,
    invoicePublicId: sale.invoice.publicId,
    packRefund: "full",
    items: [
      { description: "Refund", amountMinor: 1000, invoiceLineItemPublicId: packLine!.publicId },
    ],
  }),
);
const redraw = await systemDb
  .select()
  .from(creditUsageSettlements)
  .where(
    and(eq(creditUsageSettlements.customerId, fr.id), eq(creditUsageSettlements.kind, "redraw")),
  );
check(
  "full: of the 8 used pack credits, 5 are drawn again from the other grant and 3 are " +
    "written off (full_refund); the pack's revenue is reversed by the note",
  redraw.length === 1 &&
    redraw[0]!.unitsDue === 8n &&
    redraw[0]!.unitsDrawn === 5n &&
    (await row(fr.id)) === 0n &&
    (await paidMatches(fr.id)) &&
    (await systemDb.select().from(auditLogs).where(eq(auditLogs.resourceType, "credit_note"))).some(
      (a) => (a.after as { reason?: string })?.reason === "full_refund",
    ),
  { redraw, row: await row(fr.id) },
);
const nr = await customer("no-refund");
const nrGrant = await givePaid(nr, 10, 500, plus(-HOUR));
await send(plus(22 * MIN), nr, 4);
await settle(plus(3 * HOUR));
const refusedVoid = await voidCreditGrant({
  ...ids,
  customerPublicId: nr.publicId,
  grantPublicId: nrGrant.id,
}).then(
  () => null,
  (e: Error) => e.name,
);
await at(plus(3 * HOUR + MIN), () =>
  voidCreditGrant({
    ...ids,
    customerPublicId: nr.publicId,
    grantPublicId: nrGrant.id,
    withoutRefund: { reason: "Goodwill gesture ended" },
  }),
);
check(
  "a paid grant: refused with no option; with withoutRefund its cost left (300) goes to breakage",
  refusedVoid === "CreditConflictError" &&
    -((await ledger(nr.id))[A.breakage] ?? 0n) === 300n &&
    (await paidMatches(nr.id)) &&
    (await row(nr.id)) === 0n,
  await ledger(nr.id),
);
const nrAct = await must(
  200,
  "GET",
  `customers/${nr.publicId}/credit_grants/${nrGrant.id}/activity`,
);
check(
  "the grant's activity reads that void as breakage (300), not as a refund",
  nrAct.breakage_minor === 300 && nrAct.refunded_minor === 0 && nrAct.voided_units === 6,
  nrAct,
);
// The same void through the API: `without_refund` needs a reason, and is for paid credit only.
const nrApi = await customer("no-refund-api");
const nrApiGrant = await givePaid(nrApi, 10, 500, plus(-HOUR));
const voidPath = (c: { publicId: string }, g: { id: string }) =>
  `customers/${c.publicId}/credit_grants/${g.id}/void`;
const noReason = await call("POST", voidPath(nrApi, nrApiGrant), { without_refund: true });
const plainVoid = await call("POST", voidPath(nrApi, nrApiGrant), { reason: "billing_error" });
const promoGrant = await give(nrApi, 2, plus(-HOUR));
const promoNoRefund = await call("POST", voidPath(nrApi, promoGrant), {
  without_refund: true,
  reason: "billing_error",
});
const apiVoided = await at(plus(3 * HOUR + 2 * MIN), () =>
  must(200, "POST", voidPath(nrApi, nrApiGrant), {
    without_refund: true,
    reason: "other",
    note: "Sold by mistake, customer keeps the invoice",
  }),
);
check(
  "POST …/void without_refund: 400 with no reason, 409 without it on paid credit, 400 on promotional credit; then the cost left (500) goes to breakage",
  noReason.statusCode === 400 &&
    plainVoid.statusCode === 409 &&
    promoNoRefund.statusCode === 400 &&
    apiVoided.status === "voided" &&
    apiVoided.void_reason?.reason === "other" &&
    -((await ledger(nrApi.id))[A.breakage] ?? 0n) === 500n &&
    (await paidMatches(nrApi.id)),
  {
    noReason: noReason.body,
    plainVoid: plainVoid.body,
    promoNoRefund: promoNoRefund.body,
    apiVoided,
  },
);
await inStep("after the refunds");

// ── 8. The per-unit basis on plan credits ───────────────────────────────────────────
console.log("8. the per-unit basis on plan credits");
const basisPlan = await createPrice({
  ...ids,
  productId: product.id,
  id: `co-basis-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 3900,
  interval: "month",
});
await updatePrice({
  ...ids,
  pricePublicId: basisPlan.publicId,
  grantsCredit: { kind: "per_cycle", unit: "credit", amount: 10, unit_cost_basis: "0.50" },
});
const bc = await customer("basis");
const bsub = await createSubscription({
  ...ids,
  customerId: bc.id,
  now: new Date(),
  items: [{ price: basisPlan, quantity: 1 }],
});
const planGrant = () =>
  systemDb
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.customerId, bc.id), eq(creditGrants.source, "plan_cycle")))
    .orderBy(sql`${creditGrants.createdAt} desc`)
    .limit(1)
    .then((r) => r[0]);
if ((await planGrant())?.category !== "paid") {
  // The subscription's first term was granted with no invoice: grant a term with one.
  const { invoice: termInvoice } = await createManualInvoice({
    ...ids,
    customerId: bc.id,
    currency: "USD",
    collect: false,
    lines: [{ description: "Plan term", amountMinor: 3900n, kind: "recurring" }],
  });
  const S8 = plus(2 * DAY);
  await at(S8, () =>
    withTenant(orgId, (tx) =>
      applyPlanCredits(tx, {
        ...ids,
        subscription: { id: bsub.subscription.id, customerId: bc.id, currency: "USD" },
        periodStart: S8,
        periodEnd: plus(5 * DAY),
        invoiceId: termInvoice.id,
      }),
    ),
  );
}
const basisGrant = await planGrant();
const deferred = -((await ledger(bc.id))[A.paid] ?? 0n);
check(
  "the term's 10 credits are paid credit with a cost of 5.00, deferred from revenue",
  basisGrant?.category === "paid" && basisGrant.costBasisMinor === 500n && deferred === 500n,
  { basisGrant, deferred },
);
const useAt = new Date(Math.max(basisGrant!.effectiveAt.getTime(), B.getTime()) + HOUR);
await send(useAt, bc, 4);
await settle(new Date(useAt.getTime() + 2 * HOUR));
const recognised = rowsOf<{ r: string }>(
  await systemDb.execute(sql`
    select coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::text as r
    from ledger_entries where customer_id = ${bc.id} and source_type = 'credit_usage' and account = 'revenue'`),
)[0]!.r;
check("4 used: 2.00 recognised on use", recognised === "200", recognised);
// A term plan grant is closed by its renewal: the next term's cycle expires it.
const end8 = basisGrant!.expiresAt!;
await at(end8, () =>
  withTenant(orgId, (tx) =>
    applyPlanCredits(tx, {
      ...ids,
      subscription: { id: bsub.subscription.id, customerId: bc.id, currency: "USD" },
      periodStart: end8,
      periodEnd: new Date(end8.getTime() + 30 * DAY),
    }),
  ),
);
// Its late-event window (12 hours) closes, then the rest is booked out.
const late8 = new Date(end8.getTime() + 13 * HOUR);
await at(late8, () => runSettleCreditUsage(late8));
check(
  "at expiry the 3.00 left is breakage, and deferred revenue is back to its rule",
  -((await ledger(bc.id))[A.breakage] ?? 0n) === 300n && (await paidMatches(bc.id)),
  await ledger(bc.id),
);
await inStep("after the per-unit basis");

// ── 9. Parallel events across the zero line and across the floor ────────────────────
console.log("9. parallel events");
await setConfig(null, { overage: "10" });
const par = await customer("parallel-zero");
await subscribe(par, false);
await give(par, 20, plus(-HOUR));
await Promise.all(Array.from({ length: 30 }, () => send(plus(23 * MIN), par, 1)));
const parRows = await systemDb
  .select()
  .from(creditUsageEvents)
  .where(eq(creditUsageEvents.customerId, par.id));
const covered = parRows.reduce((s, r) => s + (r.source === "overdraft" ? 0n : r.units), 0n);
const billed = parRows.reduce((s, r) => s + r.unitsUncovered, 0n);
check(
  "30 parallel events with 20 credits: exactly 20 covered and 10 billed, never both",
  covered === 20n && billed === 10n && (await row(par.id)) === 0n,
  { covered, billed },
);
await setConfig({ blocking_enabled: true, on_exhausted_default: "block" }, { overdraft: 5 });
const parF = await customer("parallel-floor");
await subscribe(parF, false);
await give(parF, 10, plus(-HOUR));
const res = await Promise.all(Array.from({ length: 30 }, () => send(plus(24 * MIN), parF, 1)));
check(
  "30 parallel events with 10 credits and a floor of 5: 15 accepted, the row never below -5",
  res.filter((r) => r.status === "created").length === 15 && (await row(parF.id)) === -5n,
  { ok: res.filter((r) => r.status === "created").length, row: await row(parF.id) },
);
await inStep("after the parallel events");

// ── 10. Before the invoice: the estimate, current usage and spend; tax and coupons ──
console.log("10. the estimate, current usage and spend; tax and coupons on the money line");
await setConfig(null, { overage: "10" });
await createFlatTaxRate({ ...ids, name: "VAT", country: "GB", rateBps: 2000 });
type Sub = typeof subscriptions.$inferSelect;
type Price = Parameters<typeof createSubscription>[0]["items"][number]["price"];
const GB = { line1: "1 High Street", city: "London", postalCode: "EC1A 1BB", country: "GB" };
const buyer = (tag: string, address?: typeof GB) =>
  createCustomer({
    ...ids,
    email: `${tag}-${Date.now()}@example.com`,
    autoCollection: "off",
    ...(address ? { address } : {}),
  });
async function subscribeTo(c: { id: string }, items: Price[]): Promise<Sub> {
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: items.map((price) => ({ price, quantity: 1 })),
  });
  await systemDb
    .update(subscriptions)
    .set({ startedAt: S, currentPeriodStart: S, currentPeriodEnd: E })
    .where(eq(subscriptions.id, sub.subscription.id));
  return (
    await systemDb.select().from(subscriptions).where(eq(subscriptions.id, sub.subscription.id))
  )[0]!;
}
/** Everything a read must leave alone, as one row of counts and a digest of the usage rows. */
const footprint = async () =>
  JSON.stringify(
    rowsOf(
      await systemDb.execute(sql`select
        (select count(*) from unbilled_charges where organization_id = ${orgId})::text as charges,
        (select count(*) from invoices where organization_id = ${orgId})::text as invoices,
        (select count(*) from invoice_line_items where organization_id = ${orgId})::text as lines,
        (select count(*) from ledger_entries where organization_id = ${orgId})::text as ledger,
        (select count(*) from credit_grants where organization_id = ${orgId})::text as grants,
        (select count(*) from credit_grant_movements where organization_id = ${orgId})::text as movements,
        (select count(*) from credit_usage_settlements where organization_id = ${orgId})::text as settlements,
        (select md5(coalesce(string_agg(id::text || status || units::text || coalesce(overage_charge_id::text, '-')
            || coalesce(settlement_id::text, '-'), ',' order by id), ''))
          from credit_usage_events where organization_id = ${orgId}) as usage,
        (select md5(coalesce(string_agg(id::text || available_steps::text, ',' order by id), ''))
          from credit_unit_balances where organization_id = ${orgId}) as balances`),
    )[0],
  );
type Est = {
  lines: Array<{ description: string; amount_minor: number }>;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
};
const estimateAt = async (t: Date, sub: Sub, q = "?include_usage_so_far=true") =>
  (await at(t, () => must(200, "GET", `subscriptions/${sub.publicId}/renewal_estimate${q}`)))
    .estimate as Est | null;
const usageAt = (t: Date, sub: Sub) =>
  at(t, () => must(200, "GET", `subscriptions/${sub.publicId}/current_usage`));
const moneyLine = (ls: Awaited<ReturnType<typeof linesOf>>) =>
  ls.find((l) => l.kind === "usage" && /more than the credit balance/.test(l.description));
const taxOn = async (lineId: string) =>
  rowsOf<{ n: string; tax: string }>(
    await systemDb.execute(sql`
      select count(*)::text as n, coalesce(sum(amount_minor), 0)::text as tax
      from applied_taxes where invoice_line_item_id = ${lineId}`),
  )[0]!;
/** The estimate at the boundary, then the invoice at the same instant: they must agree. */
async function previewThenBill(label: string, sub: Sub) {
  const before = await footprint();
  const plain = await estimateAt(E, sub, "");
  const est = await estimateAt(E, sub);
  check(`${label}: the estimates write nothing`, (await footprint()) === before);
  check(
    `${label}: the default estimate has no usage line`,
    !plain?.lines.some((l) => /more than the credit balance/.test(l.description)),
    plain?.lines,
  );
  const { invoice } = await billPeriod(sub);
  const got = (await must(200, "GET", `invoices/${invoice.publicId}`)) as Est;
  const lines = await linesOf(invoice.id);
  const sum = (kind: string) =>
    Number(lines.filter((l) => l.kind === kind).reduce((a, l) => a + l.amountMinor, 0n));
  // The invoice stores its coupon and exclusive tax as rows of their own kind.
  const inv = { ...got, discount_minor: -sum("discount") };
  const billed = lines
    .filter((l) => !["credit_usage", "discount", "tax"].includes(l.kind))
    .map((l) => [l.description, Number(l.amountMinor)]);
  const same =
    !!est &&
    JSON.stringify(est.lines.map((l) => [l.description, l.amount_minor])) ===
      JSON.stringify(billed) &&
    est.subtotal_minor === inv.subtotal_minor &&
    est.discount_minor === inv.discount_minor &&
    est.tax_minor === inv.tax_minor &&
    est.total_minor === inv.total_minor;
  check(`${label}: the estimate equals the invoice (lines, discount, tax, total)`, same, {
    est,
    billed,
    inv: [inv.subtotal_minor, inv.discount_minor, inv.tax_minor, inv.total_minor],
  });
  check(
    `${label}: the invoice adds up`,
    // Inclusive tax is inside the line amounts and has no row.
    inv.total_minor === inv.subtotal_minor - inv.discount_minor + sum("tax") &&
      inv.total_minor === Number(lines.reduce((a, l) => a + l.amountMinor, 0n)),
    [inv.subtotal_minor, inv.discount_minor, sum("tax"), inv.total_minor],
  );
  const info = lines.find((l) => l.kind === "credit_usage");
  if (info)
    check(
      `${label}: the information line has no amount, discount or tax`,
      info.amountMinor === 0n && info.discountMinor === 0n && (await taxOn(info.id)).n === "0",
      [info.amountMinor, info.discountMinor, await taxOn(info.id)],
    );
  return { est: est!, inv, lines, invoice };
}

// Exclusive tax, the unit's price: a taxable charge, as a one-time charge is.
const taxUnit = await buyer("tax-unit", GB);
const taxUnitSub = await subscribeTo(taxUnit, [planPrice]);
await give(taxUnit, 10, plus(-HOUR));
await send(plus(30 * MIN), taxUnit, 15);
const cu = await usageAt(plus(HOUR), taxUnitSub);
check(
  "current usage: 10 paid with credits, 5 billed at 0.50, no overshoot; totals carry the tax",
  cu.credit_usage?.length === 1 &&
    Number(cu.credit_usage[0].paid_quantity) === 10 &&
    cu.credit_usage[0].paid_units === "10" &&
    cu.credit_usage[0].billed.length === 1 &&
    Number(cu.credit_usage[0].billed[0].quantity) === 5 &&
    cu.credit_usage[0].billed_amount_minor === 50 &&
    cu.credit_usage[0].overshoot_units === "0" &&
    cu.subtotal_minor === 50 &&
    cu.tax_minor === 10 &&
    cu.total_minor === 60,
  cu,
);
const spendOf = (c: { id: string }, sub: Sub, t: Date) =>
  withTenant(orgId, (tx) =>
    measureSpend(tx, {
      businessId: biz.id,
      customerId: c.id,
      currency: "USD",
      interval: "period",
      now: t,
      subscriptionId: sub.id,
    }),
  );
check(
  "spend in the term counts the 0.50 that money bills, and nothing before the event",
  (await spendOf(taxUnit, taxUnitSub, plus(HOUR))).amountMinor === 50n &&
    (await spendOf(taxUnit, taxUnitSub, plus(10 * MIN))).amountMinor === 0n,
  (await spendOf(taxUnit, taxUnitSub, plus(HOUR))).amountMinor,
);
const tu = await previewThenBill("exclusive tax, unit price", taxUnitSub);
const tuLine = moneyLine(tu.lines)!;
check(
  "exclusive tax, unit price: 0.50 is taxed at 20% (0.10); invoice tax = 20% of 39.50",
  tuLine.amountMinor === 50n && (await taxOn(tuLine.id)).tax === "10" && tu.inv.tax_minor === 790,
  [tuLine.amountMinor, await taxOn(tuLine.id), tu.inv.tax_minor],
);
check(
  "after the invoice: spend still counts the billed 0.50; current usage bills nothing more",
  (await spendOf(taxUnit, taxUnitSub, plus(2 * HOUR))).amountMinor === 50n &&
    ((await usageAt(plus(2 * HOUR), taxUnitSub)).credit_usage?.[0]?.billed_amount_minor ?? 0) === 0,
);

// Exclusive tax, the meter's price: taxed as that price.
const taxMeter = await buyer("tax-meter", GB);
const taxMeterSub = await subscribeTo(taxMeter, [planPrice, meterPrice]);
await give(taxMeter, 4, plus(-HOUR));
await send(plus(31 * MIN), taxMeter, 10);
const tm = await previewThenBill("exclusive tax, meter price", taxMeterSub);
const tmLine = moneyLine(tm.lines)!;
check(
  "exclusive tax, meter price: 1.50 is taxed at 20% (0.30) with the price on the line",
  tmLine.amountMinor === 150n &&
    tmLine.priceId === meterPrice.id &&
    (await taxOn(tmLine.id)).tax === "30" &&
    tm.inv.tax_minor === 810,
  [tmLine.amountMinor, await taxOn(tmLine.id), tm.inv.tax_minor],
);

// A tax-inclusive meter price: the tax is inside the 1.50.
const inclPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `co-render-incl-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: "render",
  unitAmountDecimal: "25",
  taxBehavior: "inclusive",
});
const taxIncl = await buyer("tax-incl", GB);
const taxInclSub = await subscribeTo(taxIncl, [planPrice, inclPrice]);
await give(taxIncl, 4, plus(-HOUR));
await send(plus(32 * MIN), taxIncl, 10);
const ti = await previewThenBill("inclusive meter price", taxInclSub);
const tiLine = moneyLine(ti.lines)!;
check(
  "inclusive meter price: the line stays 1.50 and holds 0.25 of tax; the plan adds 7.80 on top",
  tiLine.amountMinor === 150n &&
    (await taxOn(tiLine.id)).tax === "25" &&
    ti.inv.total_minor === 3900 + 780 + 150,
  [tiLine.amountMinor, await taxOn(tiLine.id), ti.inv],
);

// A percentage coupon: the money line is discounted as a usage line of a money meter is.
await must(201, "POST", "meters", {
  id: "plain",
  name: "Plain renders",
  event_name: "plain",
  aggregation: "sum",
  value_property: "n",
});
const plainPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `co-plain-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: "plain",
  unitAmountDecimal: "25",
});
await createCoupon({
  ...ids,
  code: "CO20",
  kind: "percentage",
  percentOffBps: 2000,
  durationType: "forever",
});
const withCoupon = async (sub: Sub, code: string) =>
  applyCouponToSubscription({ ...ids, subscriptionId: sub.id, code, now: new Date() });
const pct = await buyer("coupon-pct");
const pctSub = await subscribeTo(pct, [planPrice, meterPrice]);
await withCoupon(pctSub, "CO20");
await give(pct, 4, plus(-HOUR));
await send(plus(33 * MIN), pct, 10);
const pc = await previewThenBill("percentage coupon", pctSub);
const twin = await buyer("coupon-twin");
const twinSub = await subscribeTo(twin, [planPrice, plainPrice]);
await withCoupon(twinSub, "CO20");
const [twinEvent] = await at(plus(33 * MIN), () =>
  ingestUsageEvents({
    ...ids,
    events: [
      {
        key: `co-plain-${Date.now()}`,
        customer: twin.publicId,
        event_name: "plain",
        properties: { n: "6" },
      },
    ],
  }),
);
if ((twinEvent as Sent).status !== "created")
  throw new Error(`the plain event was not accepted: ${JSON.stringify(twinEvent)}`);
const tw = await billPeriod(twinSub);
const twLine = (await linesOf(tw.invoice.id)).find((l) => l.priceId === plainPrice.id);
const pcLine = moneyLine(pc.lines)!;
check(
  "percentage coupon: 1.50 of overage is discounted 0.30, as 1.50 of a money meter is",
  pcLine.amountMinor === 150n &&
    pcLine.discountMinor === 30n &&
    twLine?.amountMinor === 150n &&
    twLine.discountMinor === pcLine.discountMinor &&
    pc.inv.discount_minor === 810 &&
    pc.inv.total_minor === 3240,
  {
    over: [pcLine.amountMinor, pcLine.discountMinor],
    twin: [twLine?.amountMinor, twLine?.discountMinor],
    inv: [pc.inv.discount_minor, pc.inv.total_minor],
  },
);

// A fixed coupon larger than the plan fee: the rest comes off the money line.
await createCoupon({
  ...ids,
  code: "CO40",
  kind: "fixed_amount",
  amountOffMinor: 4000,
  currency: "USD",
  durationType: "forever",
});
const fix = await buyer("coupon-fixed");
const fixSub = await subscribeTo(fix, [planPrice, meterPrice]);
await withCoupon(fixSub, "CO40");
await give(fix, 4, plus(-HOUR));
await send(plus(34 * MIN), fix, 10);
const fx = await previewThenBill("fixed coupon", fixSub);
const fxLines = fx.lines.filter((l) => l.kind === "recurring" || l.kind === "usage");
check(
  "fixed coupon of 40.00 on 39.00 + 1.50: the lines carry 40.00 of discount and 0.50 is due",
  fxLines.reduce((a, l) => a + l.discountMinor, 0n) === 4000n &&
    moneyLine(fx.lines)!.discountMinor > 0n &&
    moneyLine(fx.lines)!.discountMinor <= 150n &&
    fx.inv.total_minor === 50,
  {
    lines: fxLines.map((l) => [l.kind, l.amountMinor, l.discountMinor]),
    total: fx.inv.total_minor,
  },
);
await inStep("after tax and coupons");

// Plan credits that wait for the payment, with overage on the same invoice.
const grantWhen = async (when: "invoice_paid" | "invoice_issued") => {
  const r = await app.inject({
    method: "PATCH",
    url: `/v1/businesses/${biz.publicId}`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `co-gw-${++keyN}` },
    payload: { billing_rules_config: { plan_credits: { grant_when: when } } },
  });
  if (r.statusCode !== 200) throw new Error(`PATCH grant_when answered ${r.statusCode}: ${r.body}`);
};
const creditPlan = await createPrice({
  ...ids,
  productId: product.id,
  id: `co-credit-plan-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 3900,
  interval: "month",
});
await updatePrice({
  ...ids,
  pricePublicId: creditPlan.publicId,
  grantsCredit: { kind: "per_cycle", unit: "credit", amount: 10 },
});
const wp = await buyer("when-paid");
const wpSub = await subscribeTo(wp, [creditPlan]);
const wpCycle = (start: Date, end: Date, invoiceId?: string) =>
  at(start, () =>
    withTenant(orgId, (tx) =>
      applyPlanCredits(tx, {
        ...ids,
        subscription: { id: wpSub.id, customerId: wp.id, currency: "USD" },
        periodStart: start,
        periodEnd: end,
        ...(invoiceId ? { invoiceId } : {}),
      }),
    ),
  );
await wpCycle(S, E);
const wpEvent = await send(plus(35 * MIN), wp, 15);
check(
  "when paid: the term's 10 credits pay their part and 5 are billed at the unit's price",
  wpEvent.status === "created" &&
    (await rowsOfKey(wpEvent.key!))[0]!.unitsUncovered === 5n &&
    (await row(wp.id)) === 0n,
  await rowsOfKey(wpEvent.key!),
);
await grantWhen("invoice_paid");
const wb = await previewThenBill("when paid", wpSub);
// The renewal grants the new cycle against the invoice it raised.
await wpCycle(E, new Date(E.getTime() + 30 * DAY), wb.invoice.id);
const cycles = () =>
  systemDb
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.customerId, wp.id), eq(creditGrants.source, "plan_cycle")))
    .orderBy(creditGrants.effectiveAt);
const wg0 = await cycles();
check(
  "when paid: the invoice bills the 0.50; the new cycle waits for its payment and offers nothing",
  moneyLine(wb.lines)?.amountMinor === 50n &&
    wg0.length === 2 &&
    wg0[1]!.status === "pending" &&
    wg0[1]!.invoiceId === wb.invoice.id &&
    (await row(wp.id)) === 0n,
  { grants: wg0.map((g) => [g.status, g.amount, g.invoiceId]), row: await row(wp.id) },
);
await at(E, () =>
  recordOfflinePayment({ ...ids, invoicePublicId: wb.invoice.publicId, method: "wire" }),
);
await settle(new Date(E.getTime() + 13 * HOUR));
const wpRows = await rowsOfKey(wpEvent.key!);
check(
  "when paid: the payment starts the 10 credits; the 5 billed in money are not repaid from them",
  (await cycles())[1]!.status === "active" &&
    (await row(wp.id)) === 10n &&
    wpRows[0]!.unitsUncovered === 5n &&
    wpRows[0]!.overageChargeId != null,
  { grants: (await cycles()).map((g) => [g.status, g.amount]), row: await row(wp.id), wpRows },
);
check(
  "when paid: the next estimate has no line for usage that is billed",
  !(await estimateAt(new Date(E.getTime() + 14 * HOUR), wpSub))?.lines.some((l) =>
    /more than the credit balance/.test(l.description),
  ),
);
await grantWhen("invoice_issued");
await inStep("after the grant that waits for the payment");

// ── 11. The engine choices of credit_config ─────────────────────────────────────────
console.log("11. trial_usage, no_subscription_*, restore_expiry_months");
{
  const T = plus(45 * DAY);
  const t = (ms: number) => new Date(T.getTime() + ms);
  const trialOf = async (tag: string, credits: number) => {
    const c = await customer(tag);
    const sub = await subscribe(c, false);
    await systemDb
      .update(subscriptions)
      .set({ status: "in_trial", trialStart: S, trialEnd: t(10 * DAY) })
      .where(eq(subscriptions.id, sub.id));
    await give(c, credits, t(-HOUR));
    return {
      c,
      sub: { ...sub, status: "in_trial" as const, trialStart: S, trialEnd: t(10 * DAY) },
    };
  };
  const blockCfg = { blocking_enabled: true, on_exhausted_default: "block" };
  const priced = { overdraft: 5, overage: "10" };

  // trial_usage
  await setConfig(blockCfg, priced);
  const tr0 = await trialOf("trial-unset", 2);
  check(
    "trial_usage unset: a trial past its credits is refused, with an overdraft and a price",
    (await send(t(MIN), tr0.c, 5)).error?.code === "insufficient_credit" &&
      (await row(tr0.c.id)) === 2n,
  );
  await setConfig({ ...blockCfg, trial_usage: "overdraft_only" }, priced);
  const tr1 = await trialOf("trial-overdraft", 2);
  const tr1e = await send(t(2 * MIN), tr1.c, 5);
  const tr1r = await rowsOfKey(tr1e.key!);
  check(
    "trial_usage overdraft_only: 2 covered, 3 below zero, nothing billed in money",
    tr1e.status === "created" &&
      (await row(tr1.c.id)) === -3n &&
      tr1r.every((r) => r.unitsUncovered === 0n && r.overageBasis === null),
    tr1r,
  );
  await setConfig({ ...blockCfg, trial_usage: "overdraft_only" }, { overdraft: 5 });
  const tr2 = await trialOf("trial-overdraft-unpriced", 2);
  check(
    "trial_usage overdraft_only, no overage price: refused (nothing could invoice the rest)",
    (await send(t(3 * MIN), tr2.c, 5)).error?.code === "insufficient_credit",
  );
  await setConfig(
    { blocking_enabled: true, on_exhausted_default: "bill", trial_usage: "as_paid" },
    priced,
  );
  const tr3 = await trialOf("trial-as-paid", 2);
  const tr3e = await send(t(4 * MIN), tr3.c, 5);
  const tr3r = await rowsOfKey(tr3e.key!);
  check(
    "trial_usage as_paid under bill: 2 covered, 3 billed at the unit's price",
    tr3e.status === "created" &&
      tr3r[0]!.units === 2n &&
      tr3r[0]!.unitsUncovered === 3n &&
      tr3r[0]!.overageBasis === "unit",
    tr3r,
  );
  const conversion = await at(t(HOUR), () =>
    billSubscriptionPeriod({
      ...ids,
      subscription: tr3.sub,
      periodStart: t(HOUR),
      periodEnd: t(31 * DAY),
      usagePeriod: { start: t(-DAY), end: t(HOUR) },
    }),
  );
  const convLines = conversion?.invoice ? await linesOf(conversion.invoice.id) : [];
  check(
    "trial_usage as_paid: the first invoice after the trial bills the 3 (0.30), one time",
    (await rowsOfKey(tr3e.key!))[0]!.overageChargeId != null &&
      convLines.some(
        (l) => /more than the credit balance/.test(l.description) && l.amountMinor === 30n,
      ),
    { conversion: conversion?.invoice?.publicId, convLines },
  );
  const tr4 = await trialOf("trial-as-paid-ends", 2);
  const tr4e = await send(t(5 * MIN), tr4.c, 5);
  await systemDb
    .update(subscriptions)
    .set({ status: "cancelled", canceledAt: t(6 * MIN) })
    .where(eq(subscriptions.id, tr4.sub.id));
  await at(t(7 * MIN), () => runBillCreditOverage(t(7 * MIN)));
  const [tr4inv] = await systemDb
    .select()
    .from(invoices)
    .where(
      and(eq(invoices.customerId, tr4.c.id), sql`${invoices.originToken} like 'credit-overage:%'`),
    );
  check(
    "trial_usage as_paid, the trial ends with no paid subscription: a one-off invoice bills the 3",
    tr4inv?.totalMinor === 30n && (await rowsOfKey(tr4e.key!))[0]!.overageInvoiceId === tr4inv.id,
    { tr4inv, rows: await rowsOfKey(tr4e.key!) },
  );

  // no_subscription_overdraft
  await setConfig({ ...blockCfg, no_subscription_overdraft: "always" }, priced);
  const ns1 = await customer("nosub-always");
  await give(ns1, 2, t(-HOUR));
  check(
    "no_subscription_overdraft always: no saved payment method, still 3 below zero",
    (await send(t(8 * MIN), ns1, 5)).status === "created" && (await row(ns1.id)) === -3n,
    await row(ns1.id),
  );
  await setConfig({ ...blockCfg, no_subscription_overdraft: "never" }, priced);
  const ns2 = await customer("nosub-never", { pm: true });
  await give(ns2, 2, t(-HOUR));
  check(
    "no_subscription_overdraft never: with a saved payment method, refused at zero",
    (await send(t(9 * MIN), ns2, 5)).error?.code === "insufficient_credit",
  );

  // no_subscription_usage and no_subscription_invoice_after_days
  await setConfig(
    {
      blocking_enabled: true,
      on_exhausted_default: "bill",
      no_subscription_usage: "as_subscriber",
      no_subscription_invoice_after_days: 2,
    },
    { overage: "10" },
  );
  const ns3 = await customer("nosub-as-subscriber");
  await give(ns3, 2, t(-HOUR));
  const ns3e = await send(t(10 * MIN), ns3, 5);
  const ns3r = await rowsOfKey(ns3e.key!);
  check(
    "no_subscription_usage as_subscriber under bill: 2 covered, 3 billed at the unit's price",
    ns3e.status === "created" && ns3r[0]!.unitsUncovered === 3n && ns3r[0]!.overageBasis === "unit",
    ns3r,
  );
  const ns3inv = async () =>
    systemDb
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.customerId, ns3.id), sql`${invoices.originToken} like 'credit-overage:%'`),
      );
  await at(t(DAY), () => runBillCreditOverage(t(DAY)));
  check(
    "no_subscription_invoice_after_days 2: no invoice after 1 day",
    (await ns3inv()).length === 0,
  );
  await at(t(2 * DAY + HOUR), () => runBillCreditOverage(t(2 * DAY + HOUR)));
  check(
    "no_subscription_invoice_after_days 2: after 2 days a one-off invoice bills the 3 (0.30)",
    (await ns3inv())[0]?.totalMinor === 30n,
    await ns3inv(),
  );

  // restore_expiry_months
  const restored = async (tag: string, months: number | "never") => {
    await setConfig({ restore_expiry_months: months });
    const c = await customer(tag);
    await give(c, 10, t(3 * DAY - HOUR), t(3 * DAY + 4 * HOUR));
    const e = await send(t(3 * DAY + MIN), c, 4);
    await settle(t(3 * DAY + 3 * HOUR));
    await at(t(3 * DAY + 30 * HOUR), () => runExpireCreditGrants(t(3 * DAY + 30 * HOUR)));
    await at(t(3 * DAY + 30 * HOUR), () => runSettleCreditUsage(t(3 * DAY + 30 * HOUR)));
    await at(t(3 * DAY + 31 * HOUR), () => voidUsageEvent({ ...ids, key: e.key! }));
    const [g] = await systemDb
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.customerId, c.id), eq(creditGrants.source, "restore")));
    return g;
  };
  const never = await restored("restore-never", "never");
  check(
    "restore_expiry_months never: the restore grant has no expiry",
    never?.amount === 4n && never.expiresAt === null,
    never,
  );
  const three = await restored("restore-three", 3);
  const days = three?.expiresAt
    ? (three.expiresAt.getTime() - t(3 * DAY + 31 * HOUR).getTime()) / DAY
    : -1;
  check(
    "restore_expiry_months 3: the restore grant expires 3 months after the void",
    three?.amount === 4n && days >= 89 && days <= 92,
    { three, days },
  );
  await setConfig(null);
  await inStep("after the engine choices");
}

await app.close();
await closeDb();
if (fails.length) {
  console.error(`\n❌ CREDIT-OVERAGE: ${fails.length} failed`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("\n✅ CREDIT-OVERAGE: PASS");
process.exit(0);
