/**
 * Usage paid in credits of a unit with no money rate (0526):
 *  - the credit cost of a meter (API, the three layers, what is refused);
 *  - the worked example: a pack-only buyer spends, revenue at cost, the pack lapses into
 *    breakage, no invoice;
 *  - the gate at ingest: block at zero with the refused event stored, a replay, a batch, and
 *    many parallel events against a small balance;
 *  - a subscriber: given credit before paid, a plan and a subscription cost, `bill`, `block`,
 *    the information line on the period invoice;
 *  - late events: inside the grace window, after it, older than 35 days, `backfill`;
 *  - settlement: once, and again as a no-op; a void before and after it;
 *  - the balance row and the ledger after each step; another organization sees nothing.
 * Every step runs at a pinned business time (the time-travel clock).
 *
 *   pnpm verify:all:fresh -- --suite credits-own-unit
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { runWithClockScope } from "@/platform/clock";
import { runBillingClockTickOnce } from "@/platform/jobs";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct, updatePrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { assembleInvoiceDocument } from "@/modules/invoicing/document";
import { createManualInvoice, recordOfflinePayment } from "@/modules/invoicing/ops";
import {
  ensureUsageMonthsFor,
  ingestUsageEvents,
  ingestUsageEventsTx,
  voidUsageEvent,
} from "@/modules/metering/ingest";
import { unitBalanceSteps } from "@/modules/credits/service";
import { applyPlanCredits } from "@/modules/credits/plan-credits";
import { runExpireCreditGrants } from "@/modules/credits/expiry";
import { liveBalance } from "@/modules/credits/balance";
import { runSettleCreditUsage } from "@/modules/credits/usage-settlement";
import {
  businesses,
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrantGrace,
  creditGrantMovements,
  creditGrants,
  creditUnits,
  creditUsageEvents,
  creditUsageSettlements,
  invoiceLineItems,
  invoices,
  meterCreditCosts,
  subscriptions,
} from "@db/schema";
import { checker, meterBusiness, newCustomer } from "./lib/meter-fixtures";

const { fails, check } = checker();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
// Every instant below is this hour plus an offset.
const B = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const plus = (ms: number) => new Date(B.getTime() + ms);

const { org, orgId, biz, ids, product } = await meterBusiness("Credits Own Unit Org");
const app = await buildApp({ logger: false });
const at = <T>(t: Date, fn: () => Promise<T>) =>
  runWithClockScope({ onlyBusinessId: biz.id, now: t }, fn);

let keyN = 0;
const call = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: object,
  o: { key?: string; secret?: string; biz?: string } = {},
) =>
  app.inject({
    method,
    url: `/v1/businesses/${o.biz ?? biz.publicId}/${path}`,
    headers: {
      authorization: `Bearer ${o.secret ?? org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": o.key ?? `cou-${Date.now()}-${++keyN}` }),
    },
    ...(payload ? { payload } : {}),
  });

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
/** Revenue posted by settlements for one customer. */
async function usageRevenue(customerId: string): Promise<bigint> {
  const [r] = rowsOf<{ net: string }>(
    await systemDb.execute(sql`
      select coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::text as net
      from ledger_entries
      where customer_id = ${customerId} and account = 'revenue' and source_type = 'credit_usage'`),
  );
  return BigInt(r!.net);
}
async function unbalanced(): Promise<number> {
  return rowsOf(
    await systemDb.execute(sql`
      select transaction_id from ledger_entries where organization_id = ${orgId}
      group by transaction_id
      having sum(case when direction = 'debit' then amount_minor else -amount_minor end) <> 0`),
  ).length;
}
/**
 * Rows where the balance is not: Σ movements of the grants − units taken and not settled −
 * what open grace rows hold. Or where it is below 0.
 */
async function drift(): Promise<unknown[]> {
  return rowsOf(
    await systemDb.execute(sql`
      select bal.customer_id, bal.available_steps::text as balance,
        (coalesce(g.steps, 0) - coalesce(t.steps, 0) - coalesce(gr.steps, 0))::text as expected
      from credit_unit_balances bal
      left join lateral (
        select sum(m.units) as steps from credit_grants cg
        join credit_grant_movements m on m.grant_id = cg.id
        where cg.customer_id = bal.customer_id and cg.unit_id = bal.unit_id and not cg.unit_rated
          and not cg.out_of_balance
      ) g on true
      left join lateral (
        select sum(c.units) as steps from credit_usage_events c
        where c.customer_id = bal.customer_id and c.unit_id = bal.unit_id
          and c.status in ('taken', 'pending')
      ) t on true
      left join lateral (
        select sum(x.available_steps) as steps from credit_grant_grace x
        where x.customer_id = bal.customer_id and x.unit_id = bal.unit_id and x.locked_at is null
      ) gr on true
      where bal.organization_id = ${orgId}
        -- Below 0 only by an overshoot that no one billed (0530).
        and (bal.available_steps + (select coalesce(sum(o.units), 0) from credit_usage_events o
              where o.customer_id = bal.customer_id and o.unit_id = bal.unit_id
                and o.source = 'overdraft' and o.status = 'taken') < 0
          or bal.available_steps <> coalesce(g.steps, 0) - coalesce(t.steps, 0) - coalesce(gr.steps, 0))`),
  );
}
/** Ledger credit_grants_paid = Σ cost left on the customer's paid grants. */
async function paidMatches(customerId: string): Promise<boolean> {
  const [r] = rowsOf<{ left: string }>(
    await systemDb.execute(sql`
      select coalesce(sum(m.cost_minor), 0)::text as left from credit_grants g
      join credit_grant_movements m on m.grant_id = g.id
      where g.customer_id = ${customerId} and g.category = 'paid'`),
  );
  return -((await ledger(customerId))[A.paid] ?? 0n) === BigInt(r!.left);
}
const inStep = async (label: string) => {
  const d = await drift();
  check(
    `${label}: the balance row is right (below 0 only by an unbilled overshoot)`,
    d.length === 0,
    d,
  );
  check(`${label}: every ledger transaction balances`, (await unbalanced()) === 0);
};
const customer = (tag: string) =>
  createCustomer({ ...ids, email: `${tag}-${Date.now()}@example.com`, autoCollection: "off" });

let evN = 0;
type Sent = { status: string; key: string | null; error?: { code: string; message: string } };
/** Ingest one event at business time `t`. */
const send = async (
  t: Date,
  c: { publicId: string },
  eventName: string,
  o: { timestamp?: Date; n?: string; backfill?: boolean; key?: string } = {},
): Promise<Sent> => {
  const [r] = await at(t, () =>
    ingestUsageEvents({
      ...ids,
      events: [
        {
          key: o.key ?? `ev-${Date.now()}-${++evN}`,
          customer: c.publicId,
          event_name: eventName,
          ...(o.timestamp ? { timestamp: o.timestamp.toISOString() } : {}),
          ...(o.n ? { properties: { n: o.n } } : {}),
          ...(o.backfill ? { backfill: true } : {}),
        },
      ],
    }),
  );
  return r as Sent;
};
const creditRows = (key: string) =>
  systemDb
    .select()
    .from(creditUsageEvents)
    .where(and(eq(creditUsageEvents.businessId, biz.id), eq(creditUsageEvents.eventKey, key)))
    .orderBy(creditUsageEvents.part);
const settlementsOf = (customerId: string) =>
  systemDb
    .select()
    .from(creditUsageSettlements)
    .where(eq(creditUsageSettlements.customerId, customerId))
    .orderBy(creditUsageSettlements.seq);
const settle = (t: Date) => at(t, () => runSettleCreditUsage(t));
const expire = (t: Date) => at(t, () => runExpireCreditGrants(t));
const grantOf = async (publicId: string) =>
  (await systemDb.select().from(creditGrants).where(eq(creditGrants.publicId, publicId)))[0]!;
const give = async (
  c: { publicId: string },
  amount: number,
  o: { effective_at?: Date; expires_at?: Date; on_exhausted?: string } = {},
) => {
  const r = await call("POST", `customers/${c.publicId}/credit_grants`, {
    unit: "credit",
    amount,
    ...(o.effective_at ? { effective_at: o.effective_at.toISOString() } : {}),
    ...(o.expires_at ? { expires_at: o.expires_at.toISOString() } : {}),
    ...(o.on_exhausted ? { on_exhausted: o.on_exhausted } : {}),
  });
  if (r.statusCode !== 201) throw new Error(`grant failed: ${r.body}`);
  return JSON.parse(r.body) as { id: string };
};

// ── 1. The credit cost of a meter ────────────────────────────────────────────────
console.log("1. the credit cost of a meter");
for (const u of [
  {
    id: "credit",
    name: "credit",
    plural_name: "credits",
    currency: "USD",
    minor_per_unit: null,
    decimals: 1,
  },
  { id: "token", name: "token", currency: "USD", minor_per_unit: "60" },
]) {
  const made = await call("POST", "credit_units", u);
  if (made.statusCode !== 201) throw new Error(`unit failed: ${made.body}`);
}
const [unit] = await systemDb
  .select()
  .from(creditUnits)
  .where(and(eq(creditUnits.businessId, biz.id), eq(creditUnits.key, "credit")));
const unitId = unit!.id;
const row = (customerId: string) =>
  withTenant(orgId, (tx) => unitBalanceSteps(tx, { customerId, unitId }));

for (const m of [
  { id: "illustration", name: "Illustrations", event_name: "illustration", aggregation: "count" },
  { id: "edit", name: "Edits", event_name: "edit", aggregation: "count" },
  { id: "render", name: "Renders", event_name: "render", aggregation: "sum", value_property: "n" },
  { id: "plain", name: "Plain", event_name: "plain", aggregation: "count" },
  { id: "peak", name: "Peak", event_name: "peak", aggregation: "max", value_property: "n" },
]) {
  const r = await call("POST", "meters", m);
  if (r.statusCode !== 201) throw new Error(`meter failed: ${r.body}`);
}
const put1 = await call("PUT", "meters/illustration/credit_cost", {
  unit: "credit",
  credits_per_unit: "1",
});
check(
  "PUT sets the cost of a meter",
  put1.statusCode === 200 &&
    JSON.parse(put1.body).unit === "credit" &&
    JSON.parse(put1.body).credits_per_unit === "1" &&
    JSON.parse(put1.body).overrides.length === 0,
  put1.body,
);
const put2 = await call("PUT", "meters/edit/credit_cost", {
  unit: "credit",
  credits_per_unit: 0.5,
});
check(
  "a number is read as its decimal text: 0.5",
  put2.statusCode === 200 && JSON.parse(put2.body).credits_per_unit === "0.5",
  put2.body,
);
await call("PUT", "meters/render/credit_cost", { unit: "credit", credits_per_unit: "1" });
const got = await call("GET", "meters/edit/credit_cost");
const meterGet = await call("GET", "meters/edit");
check(
  "GET returns it, and the meter carries credit_cost",
  got.statusCode === 200 &&
    JSON.parse(got.body).credits_per_unit === "0.5" &&
    JSON.parse(meterGet.body).credit_cost?.unit === "credit",
  { got: got.body, meter: meterGet.body },
);
const plainGet = await call("GET", "meters/plain");
check(
  "a meter with no cost reads credit_cost: null, and GET …/credit_cost is 404",
  JSON.parse(plainGet.body).credit_cost === null &&
    (await call("GET", "meters/plain/credit_cost")).statusCode === 404,
  plainGet.body,
);
const ratedUnit = await call("PUT", "meters/plain/credit_cost", {
  unit: "token",
  credits_per_unit: "1",
});
check("a unit with a money rate is refused (400)", ratedUnit.statusCode === 400, ratedUnit.body);
const badAgg = await call("PUT", "meters/peak/credit_cost", {
  unit: "credit",
  credits_per_unit: "1",
});
check("a meter that keeps a maximum is refused (400)", badAgg.statusCode === 400, badAgg.body);
const zero = await call("PUT", "meters/plain/credit_cost", {
  unit: "credit",
  credits_per_unit: "0",
});
check("a cost of 0 is refused (400)", zero.statusCode === 400, zero.body);
const both = await call("PUT", "meters/plain/credit_cost", {
  unit: "credit",
  credits_per_unit: "1",
  overrides: [{ product: product.publicId, subscription: "sub_x", credits_per_unit: "1" }],
});
check("an override names a plan or a subscription, not both (400)", both.statusCode === 400);
const noKey = await app.inject({
  method: "PUT",
  url: `/v1/businesses/${biz.publicId}/meters/plain/credit_cost`,
  headers: { authorization: `Bearer ${org.secret}` },
  payload: { unit: "credit", credits_per_unit: "1" },
});
check("the write needs an Idempotency-Key (400)", noKey.statusCode === 400, noKey.body);
// A meter price on no subscription may join a credit cost; it then bills only what credits
// do not pay (0530). A price that bills from event amounts may not.
const moneyPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `plain-usage-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: "plain",
  unitAmountDecimal: "1",
});
const priced = await call("PUT", "meters/plain/credit_cost", {
  unit: "credit",
  credits_per_unit: "1",
});
const unpriced = await call("DELETE", "meters/plain/credit_cost");
check(
  "a meter whose price is on no subscription takes a credit cost, and gives it back",
  priced.statusCode === 200 && unpriced.statusCode < 300,
  `${priced.statusCode} ${priced.body} ${unpriced.statusCode}`,
);
const priceOnCredit = await createPrice({
  ...ids,
  productId: product.id,
  id: `illustration-usage-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: "illustration",
  amountSource: "event_amount",
}).catch((e) => e);
check(
  "a meter with a credit cost takes no price that bills event amounts",
  priceOnCredit instanceof Error && /credit cost/.test(priceOnCredit.message),
  String(priceOnCredit),
);
void moneyPrice;

// ── 2. The worked example: a pack-only buyer ─────────────────────────────────────
console.log("2. the worked example: a pack-only buyer");
const packProduct = await createProduct({ ...ids, name: "Credit packs", kind: "charge" });
const packPrice = await createPrice({
  ...ids,
  productId: packProduct.id,
  id: `trial-pack-${Date.now()}`,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 900,
  grantsCredit: {
    kind: "pack",
    unit: "credit",
    amount: 150,
    tax_treatment: "taxed_at_purchase",
    expires_after: { days: 30 },
  },
});
const buyer = await customer("pack-only");
const sale = await at(B, () =>
  createManualInvoice({
    ...ids,
    customerId: buyer.id,
    currency: "USD",
    collect: false,
    lines: [
      {
        description: "Trial Pack",
        priceId: packPrice.id,
        quantity: 1,
        amountMinor: 900n,
        kind: "one_time",
      },
    ],
  }),
);
await at(B, () =>
  recordOfflinePayment({ ...ids, invoicePublicId: sale.invoice.publicId, method: "wire" }),
);
check("the pack gives 15.0 credits", (await row(buyer.id)) === 150n, await row(buyer.id));

const used: Sent[] = [];
for (let i = 0; i < 4; i++) used.push(await send(plus(10 * MIN), buyer, "illustration"));
for (let i = 0; i < 2; i++) used.push(await send(plus(10 * MIN), buyer, "edit"));
check(
  "4 illustrations and 2 edits are accepted with no subscription",
  used.every((r) => r.status === "created"),
  used,
);
check(
  "the balance moved with each event: 10.0 left",
  (await row(buyer.id)) === 100n,
  await row(buyer.id),
);
const firstRows = await creditRows(used[0]!.key!);
check(
  "an event's credits are taken and wait for settlement",
  firstRows.length === 1 &&
    firstRows[0]!.status === "taken" &&
    firstRows[0]!.units === 10n &&
    firstRows[0]!.unitsDue === 10n &&
    firstRows[0]!.costSource === "meter",
  firstRows,
);
const live = await at(plus(11 * MIN), () =>
  withTenant(orgId, (tx) =>
    liveBalance(tx, {
      customerId: buyer.id,
      currency: "USD",
      now: plus(11 * MIN),
      businessConfig: null,
      customerSettings: null,
    }),
  ),
);
check(
  "the balance that the API and the portal show is 10.0 too, before settlement",
  live.availableUnits.find((u) => u.unit === "credit")?.units === 100n,
  live.availableUnits,
);
check(
  "nothing is drawn or posted before settlement",
  (await settlementsOf(buyer.id)).length === 0 && (await usageRevenue(buyer.id)) === 0n,
);
await inStep("after ingest");

const again = await send(plus(11 * MIN), buyer, "illustration", { key: used[0]!.key! });
check(
  "a replayed event key is a duplicate and takes nothing",
  again.status === "duplicate" && (await row(buyer.id)) === 100n,
  again,
);

// Received at :10; the pass settles what arrived before the top of the hour.
const early = await settle(plus(30 * MIN));
check("the pass waits for the top of the hour", early.settled === 0, early);
const pass1 = await settle(plus(HOUR + MIN));
const s1 = await settlementsOf(buyer.id);
check(
  "the hourly pass writes one settlement for each meter",
  pass1.settled === 2 && s1.length === 2 && s1.every((s) => s.kind === "usage"),
  { pass1, n: s1.length },
);
const illus = s1.find((s) => s.unitsDrawn === 40n);
const edits = s1.find((s) => s.unitsDrawn === 10n);
check(
  "illustrations: 4 for 4.0 credits, revenue 240; edits: 2 for 1.0 credit, revenue 60",
  illus?.events === 4 &&
    Number(illus.quantity) === 4 &&
    illus.revenueMinor === 240n &&
    edits?.events === 2 &&
    edits.revenueMinor === 60n,
  s1,
);
const lb = await ledger(buyer.id);
check(
  "ledger: Dr credit_grants_paid 300 / Cr revenue 300 (900 × 5 ÷ 15)",
  (await usageRevenue(buyer.id)) === 300n && -(lb[A.paid] ?? 0n) === 600n,
  lb,
);
check("no discount account is used", lb[A.discount] === undefined, lb);
check("the balance did not move at settlement", (await row(buyer.id)) === 100n);
check("credit_grants_paid = the cost left on the grants", await paidMatches(buyer.id));
const draws = await systemDb
  .select()
  .from(creditGrantMovements)
  .where(and(eq(creditGrantMovements.customerId, buyer.id), eq(creditGrantMovements.kind, "draw")));
check(
  "each draw names its settlement and no invoice",
  draws.length === 2 && draws.every((d) => d.settlementId !== null && d.invoiceId === null),
  draws.length,
);
await inStep("after settlement");

const pass2 = await settle(plus(HOUR + 2 * MIN));
check(
  "a second run settles nothing",
  pass2.settled === 0 &&
    (await settlementsOf(buyer.id)).length === 2 &&
    (await usageRevenue(buyer.id)) === 300n,
  pass2,
);
const listed = await call("GET", `customers/${buyer.publicId}/credit_usage`);
const listedBody = JSON.parse(listed.body);
check(
  "GET …/credit_usage lists the settlements",
  listed.statusCode === 200 &&
    listedBody.data.length === 2 &&
    listedBody.data.some(
      (s: { meter: string; credits_drawn: string; revenue_minor: number }) =>
        s.meter === "illustration" && s.credits_drawn === "4" && s.revenue_minor === 240,
    ),
  listed.body,
);
const txns = JSON.parse(
  (await call("GET", `customers/${buyer.publicId}/credit_transactions?kind=draw`)).body,
);
check(
  "a draw in the transaction list names its settlement",
  txns.data.length === 2 &&
    txns.data.every((t: { settlement: string | null }) => t.settlement?.startsWith("cst_")),
  txns.data,
);
const buyerInvoices = await systemDb
  .select()
  .from(invoices)
  .where(eq(invoices.customerId, buyer.id));
check("no invoice but the pack's own", buyerInvoices.length === 1, buyerInvoices.length);

// The pack lapses with 10.0 credits left. It keeps them for late events for 12 hours.
const packGrant = (
  await systemDb.select().from(creditGrants).where(eq(creditGrants.invoiceId, sale.invoice.id))
)[0]!;
const lapse = new Date(packGrant.expiresAt!.getTime() + MIN);
await expire(lapse);
const [held] = await systemDb
  .select()
  .from(creditGrantGrace)
  .where(eq(creditGrantGrace.grantId, packGrant.id));
check(
  "at expiry the credits leave the balance and wait in the grace window",
  (await row(buyer.id)) === 0n &&
    held?.availableSteps === 100n &&
    held.lockedAt === null &&
    (await grantOf(packGrant.publicId)).status === "active",
  { row: await row(buyer.id), held },
);
const spent = await send(new Date(lapse.getTime() + MIN), buyer, "illustration");
check(
  "an event on time after the expiry is refused",
  spent.error?.code === "insufficient_credit",
  spent,
);
await inStep("in the grace window");
const afterGrace = new Date(packGrant.expiresAt!.getTime() + 12 * HOUR + MIN);
const lockPass = await settle(afterGrace);
const lc = await ledger(buyer.id);
check(
  "when the window ends the pack expires into breakage: Dr credit_grants_paid 600 / Cr credit_breakage 600",
  lockPass.locked === 1 &&
    (await grantOf(packGrant.publicId)).status === "expired" &&
    -(lc[A.breakage] ?? 0n) === 600n &&
    (lc[A.paid] ?? 0n) === 0n,
  { lockPass, lc },
);
check("credit_grants_paid = the cost left on the grants", await paidMatches(buyer.id));
await inStep("after breakage");

// ── 3. Block at zero ─────────────────────────────────────────────────────────────
console.log("3. block at zero: the refused event is stored");
const small = await customer("block");
await give(small, 10, { effective_at: plus(-DAY) });
const ok1 = await call("POST", "usage_events", {
  key: "blk-1",
  customer: small.publicId,
  event_name: "illustration",
});
const ok1b = JSON.parse(ok1.body);
check(
  "POST …/usage_events: 201, and the event shows its credits",
  ok1.statusCode === 201 &&
    ok1b.event.credit?.[0]?.status === "taken" &&
    ok1b.event.credit[0].credits_taken === "1" &&
    ok1b.event.credit[0].meter === "illustration",
  ok1.body,
);
const no1 = await call("POST", "usage_events", {
  key: "blk-2",
  customer: small.publicId,
  event_name: "illustration",
});
check(
  "the next event answers 402 insufficient_credit",
  no1.statusCode === 402 && JSON.parse(no1.body).error.code === "insufficient_credit",
  no1.body,
);
const [storedRefused] = rowsOf<{ n: number }>(
  await systemDb.execute(
    sql`select count(*)::int as n from usage_events where business_id = ${biz.id} and key = 'blk-2'`,
  ),
);
const refusedRows = await creditRows("blk-2");
check(
  "it is stored, with a refused row and its reason, and takes nothing",
  storedRefused?.n === 1 &&
    refusedRows.length === 1 &&
    refusedRows[0]!.status === "refused" &&
    refusedRows[0]!.reason === "insufficient_credit" &&
    refusedRows[0]!.units === 0n &&
    refusedRows[0]!.unitsDue === 10n &&
    (await row(small.id)) === 0n,
  refusedRows,
);
const viaList = JSON.parse((await call("GET", "usage_events?key=blk-2")).body);
check(
  "the event list shows it as refused",
  viaList.data[0]?.credit?.[0]?.status === "refused" &&
    viaList.data[0].credit[0].reason === "insufficient_credit",
  viaList.data[0],
);
const refusedEvents = rowsOf<{ data: { credit_usage: { usage_event: string; reason: string } } }>(
  await systemDb.execute(sql`
    select data from events where organization_id = ${orgId} and type = 'credit_usage_refused'
      and data->'credit_usage'->>'usage_event' = 'blk-2'`),
);
check(
  "a credit_usage_refused event is written",
  refusedEvents.length === 1 &&
    refusedEvents[0]!.data.credit_usage.reason === "insufficient_credit",
  refusedEvents,
);
const no1again = await call("POST", "usage_events", {
  key: "blk-2",
  customer: small.publicId,
  event_name: "illustration",
});
check(
  "a replay of the refused key answers 402 again, with one stored event",
  no1again.statusCode === 402 && (await creditRows("blk-2")).length === 1,
  no1again.body,
);
const batch = await call("POST", "usage_events/batch", {
  events: [
    { key: "blk-3", customer: small.publicId, event_name: "edit" },
    { key: "blk-4", customer: small.publicId, event_name: "plain" },
  ],
});
const batchBody = JSON.parse(batch.body);
check(
  "a batch gives the refusal per event; a meter with no cost is not gated",
  batch.statusCode === 200 &&
    batchBody.results[0].status === "error" &&
    batchBody.results[0].error.code === "insufficient_credit" &&
    batchBody.results[1].status === "created" &&
    (await creditRows("blk-4")).length === 0,
  batch.body,
);
// Two meters count one event: it is accepted or refused whole.
for (const id of ["combo-a", "combo-b"]) {
  await call("POST", "meters", { id, name: id, event_name: "combo", aggregation: "count" });
  await call("PUT", `meters/${id}/credit_cost`, { unit: "credit", credits_per_unit: "1" });
}
const pair = await customer("pair");
await give(pair, 15, { effective_at: plus(-DAY) });
const half = await send(plus(15 * MIN), pair, "combo");
const halfRows = await creditRows(half.key!);
check(
  "an event that two meters count is refused whole when the credit pays only one",
  half.error?.code === "insufficient_credit" &&
    halfRows.length === 2 &&
    halfRows.every((r) => r.status === "refused" && r.units === 0n) &&
    (await row(pair.id)) === 15n,
  halfRows,
);
await give(pair, 5, { effective_at: plus(-DAY) });
const whole = await send(plus(16 * MIN), pair, "combo");
check(
  "and accepted whole when it pays both",
  whole.status === "created" &&
    (await creditRows(whole.key!)).every((r) => r.status === "taken" && r.units === 10n) &&
    (await row(pair.id)) === 0n,
  whole,
);
const far = new Date(Date.now() + 2 * HOUR);
await settle(far);
const smallSettled = await settlementsOf(small.id);
check(
  "settlement draws the accepted event only; the refused ones are never billed",
  smallSettled.length === 1 &&
    smallSettled[0]!.unitsDrawn === 10n &&
    (await creditRows("blk-2"))[0]!.status === "refused" &&
    (await creditRows("blk-2"))[0]!.settlementId === null,
  smallSettled,
);
await inStep("after a refusal");

// ── 4. Many parallel events against a small balance ──────────────────────────────
console.log("4. concurrency: 40 parallel events, 5.0 credits");
const racer = await customer("race");
await give(racer, 50, { effective_at: plus(-DAY) });
const race = await Promise.all(
  Array.from({ length: 40 }, (_, i) =>
    send(plus(20 * MIN), racer, "illustration", { key: `race-${i}` }),
  ),
);
const accepted = race.filter((r) => r.status === "created").length;
const turnedAway = race.filter((r) => r.error?.code === "insufficient_credit").length;
const [took] = rowsOf<{ taken: string; refused: number }>(
  await systemDb.execute(sql`
    select coalesce(sum(units), 0)::text as taken,
      count(*) filter (where status = 'refused')::int as refused
    from credit_usage_events where customer_id = ${racer.id}`),
);
check(
  "exactly the 5 affordable events are accepted and 35 refused",
  accepted === 5 && turnedAway === 35 && took?.refused === 35,
  { accepted, turnedAway, took },
);
check(
  "the balance is 0, never below, and the units taken equal the grant",
  (await row(racer.id)) === 0n && took?.taken === "50",
  { row: await row(racer.id), took },
);
await inStep("after the race");

// ── 5. A subscriber: plan credits, a pack, the cost layers, the policy ───────────
console.log("5. a subscriber");
const planPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `basic-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 3900,
  interval: "month",
});
const member = await newCustomer(ids, "member");
const sub = await createSubscription({
  ...ids,
  customerId: member.id,
  now: new Date(),
  items: [{ price: planPrice, quantity: 1 }],
});
const S = plus(-DAY);
const E = plus(29 * DAY);
await systemDb
  .update(subscriptions)
  .set({ startedAt: S, currentPeriodStart: S, currentPeriodEnd: E })
  .where(eq(subscriptions.id, sub.subscription.id));
await updatePrice({
  ...ids,
  pricePublicId: planPrice.publicId,
  grantsCredit: { kind: "per_cycle", unit: "credit", amount: 750 },
});
await at(B, () =>
  withTenant(orgId, (tx) =>
    applyPlanCredits(tx, {
      ...ids,
      subscription: { id: sub.subscription.id, customerId: member.id, currency: "USD" },
      periodStart: S,
      periodEnd: E,
    }),
  ),
);
const topUp = await at(B, () =>
  call("POST", `customers/${member.publicId}/credit_grants`, {
    category: "paid",
    unit: "credit",
    amount: 100,
    price_minor: 500,
    tax_treatment: "taxed_at_purchase",
    mark_paid: { method: "bank_transfer" },
    effective_at: plus(-HOUR).toISOString(),
  }),
);
check(
  "75.0 plan credits and a 10.0 pack for 5.00",
  topUp.statusCode === 201 && (await row(member.id)) === 850n,
  { body: topUp.body, row: await row(member.id) },
);
const big = await send(plus(130 * MIN), member, "render", { n: "76" });
check(
  "76 renders are accepted: 9.0 credits left",
  big.status === "created" && (await row(member.id)) === 90n,
);
await settle(plus(3 * HOUR + MIN));
const memberDraws = await systemDb
  .select({ m: creditGrantMovements, category: creditGrants.category })
  .from(creditGrantMovements)
  .innerJoin(creditGrants, eq(creditGrants.id, creditGrantMovements.grantId))
  .where(
    and(eq(creditGrantMovements.customerId, member.id), eq(creditGrantMovements.kind, "draw")),
  );
const fromPlan = memberDraws.find((d) => d.category === "promotional");
const fromPack = memberDraws.find((d) => d.category === "paid");
check(
  "given credit pays first (75.0, no posting); the pack pays the last 1.0 at its cost (50)",
  fromPlan?.m.units === -750n &&
    fromPlan.m.ledgerTransactionId === null &&
    fromPack?.m.units === -10n &&
    fromPack.m.costMinor === -50n &&
    (await usageRevenue(member.id)) === 50n,
  memberDraws.map((d) => [d.category, d.m.units, d.m.costMinor]),
);
check("credit_grants_paid = the cost left on the grants", await paidMatches(member.id));

// The cost for the plan, then for this subscription.
await call("PUT", "meters/render/credit_cost", {
  unit: "credit",
  credits_per_unit: "1",
  overrides: [{ product: product.publicId, credits_per_unit: "0.8" }],
});
const onPlan = await send(plus(190 * MIN), member, "render", { n: "10" });
const onPlanRow = (await creditRows(onPlan.key!))[0]!;
check(
  "a plan override: 10 renders cost 8.0 credits",
  onPlanRow.unitsDue === 80n && onPlanRow.costSource === "plan" && (await row(member.id)) === 10n,
  onPlanRow,
);
const withDeal = await call("PUT", "meters/render/credit_cost", {
  unit: "credit",
  credits_per_unit: "1",
  overrides: [
    { product: product.publicId, credits_per_unit: "0.8" },
    { subscription: sub.subscription.publicId, credits_per_unit: "0.5" },
  ],
});
check(
  "the cost holds both overrides",
  JSON.parse(withDeal.body).overrides.length === 2,
  withDeal.body,
);
const onDeal = await send(plus(191 * MIN), member, "render", { n: "1" });
const onDealRow = (await creditRows(onDeal.key!))[0]!;
check(
  "a subscription override wins: 1 render costs 0.5",
  onDealRow.unitsDue === 5n &&
    onDealRow.costSource === "subscription" &&
    (await row(member.id)) === 5n,
  onDealRow,
);
const other1 = await customer("no-plan");
await give(other1, 100, { effective_at: plus(-DAY) });
const baseCost = await send(plus(191 * MIN), other1, "render", { n: "1" });
check(
  "a customer with no subscription pays the meter's own cost",
  (await creditRows(baseCost.key!))[0]!.unitsDue === 10n,
);

// Policy. Blocking is off for this business (`bill`). Usage that credits do not cover has no
// price yet, so the gate refuses it as `block` does.
const over = await send(plus(192 * MIN), member, "render", { n: "4" });
const overRow = (await creditRows(over.key!))[0]!;
check(
  "bill, with no overage price yet: the short event is refused and stored, as under block",
  over.error?.code === "insufficient_credit" &&
    overRow.status === "refused" &&
    overRow.reason === "insufficient_credit" &&
    overRow.units === 0n &&
    overRow.unitsUncovered === 0n &&
    (await row(member.id)) === 5n,
  { over, overRow },
);
const within = await send(plus(192 * MIN), member, "render", { n: "1" });
check(
  "bill: an event the balance covers is accepted (0.5), and the balance is 0",
  within.status === "created" &&
    (await creditRows(within.key!))[0]!.units === 5n &&
    (await row(member.id)) === 0n,
  within,
);
await systemDb
  .update(businesses)
  .set({ creditConfig: { blocking_enabled: true, on_exhausted_default: "block" } })
  .where(eq(businesses.id, biz.id));
const blocked = await send(plus(193 * MIN), member, "render", { n: "1" });
check(
  "block (the business default): the subscriber's event is refused and stored",
  blocked.error?.code === "insufficient_credit" &&
    (await creditRows(blocked.key!))[0]!.status === "refused",
  blocked,
);
await systemDb.update(businesses).set({ creditConfig: null }).where(eq(businesses.id, biz.id));
await inStep("after the subscriber's usage");

// An event that settles a hold is never refused.
const heldKey = `hold-${Date.now()}`;
const heldEvents = [{ key: heldKey, customer: small.publicId, event_name: "illustration" }];
const [viaHold] = await at(plus(194 * MIN), async () => {
  await ensureUsageMonthsFor(biz.id, heldEvents);
  return withTenant(orgId, (tx) =>
    ingestUsageEventsTx(tx, { ...ids, coveredUnitId: unitId, events: heldEvents }),
  );
});
const heldRow = (await creditRows(heldKey))[0]!;
check(
  "an event covered by a hold is accepted at zero: with no money price the rest goes below zero",
  viaHold?.status === "created" &&
    heldRow.status === "taken" &&
    heldRow.coveredByHold &&
    heldRow.source === "overdraft" &&
    heldRow.units === 10n &&
    heldRow.unitsUncovered === 0n,
  heldRow,
);

// The period invoice settles first and states what credits paid.
const [subRow] = await systemDb
  .select()
  .from(subscriptions)
  .where(eq(subscriptions.id, sub.subscription.id));
const before = (await settlementsOf(member.id)).length;
await at(E, () =>
  billSubscriptionPeriod({
    ...ids,
    subscription: subRow!,
    periodStart: E,
    periodEnd: new Date(E.getTime() + 30 * DAY),
  }),
);
const memberSettlements = await settlementsOf(member.id);
check(
  "the invoice settles the usage the pass had not reached",
  memberSettlements.length > before &&
    (
      await systemDb
        .select()
        .from(creditUsageEvents)
        .where(
          and(eq(creditUsageEvents.customerId, member.id), eq(creditUsageEvents.status, "taken")),
        )
    ).length === 0,
  { before, after: memberSettlements.length },
);
const [periodInvoice] = await systemDb
  .select()
  .from(invoices)
  .where(and(eq(invoices.subscriptionId, sub.subscription.id), eq(invoices.periodStart, E)));
const lines = periodInvoice
  ? await systemDb
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, periodInvoice.id))
  : [];
const info = lines.filter((l) => l.kind === "credit_usage");
check(
  "the invoice has one information line: Renders: 88. Paid with 85 credits.",
  info.length === 1 &&
    info[0]!.description === "Renders: 88. Paid with 85 credits." &&
    info[0]!.amountMinor === 0n &&
    (info[0]!.rating as { credit_usage: { credit_units: string } }).credit_usage.credit_units ===
      "85",
  info.map((l) => [l.description, l.amountMinor]),
);
check(
  "the line adds no money: the invoice is the plan fee",
  periodInvoice?.subtotalMinor === 3900n,
  periodInvoice?.subtotalMinor,
);
// The printed invoice states it as information: no row in the line table, no amount, no tax.
const printed = periodInvoice
  ? await assembleInvoiceDocument(orgId, biz.id, periodInvoice.publicId)
  : null;
check(
  "the invoice document carries the sentence outside its charge lines and totals",
  printed?.creditUsage?.[0]?.text === "Renders: 88. Paid with 85 credits." &&
    printed.chargeLines.every((l) => !l.description.startsWith("Renders:")) &&
    printed.totals.totalMinor === periodInvoice!.totalMinor,
  printed?.creditUsage,
);
await inStep("after the period invoice");

// ── 6. Late events ───────────────────────────────────────────────────────────────
console.log("6. late events");
const W0 = plus(-2 * DAY);
const W1 = plus(-DAY);
const late = await customer("late");
const march = await give(late, 100, { effective_at: W0, expires_at: W1 });
await give(late, 50, { effective_at: W1 });
check("two windows: 10.0 until W1, 5.0 from W1", (await row(late.id)) === 150n);
const inW0 = await send(new Date(W1.getTime() - 2 * HOUR), late, "illustration");
check(
  "an event in the first window is accepted",
  inW0.status === "created" && (await row(late.id)) === 140n,
);
await expire(new Date(W1.getTime() + HOUR));
const marchId = (await grantOf(march.id)).id;
const [grace] = await systemDb
  .select()
  .from(creditGrantGrace)
  .where(eq(creditGrantGrace.grantId, marchId));
check(
  "the first window closes: its usage is drawn, 9.0 wait in the grace window, 5.0 stay in the balance",
  grace?.availableSteps === 90n &&
    grace.validUntil.getTime() === W1.getTime() &&
    grace.locksAt.getTime() === W1.getTime() + 12 * HOUR &&
    (await row(late.id)) === 50n &&
    (await grantOf(march.id)).status === "active",
  { grace, row: await row(late.id) },
);
const firstDraw = await systemDb
  .select()
  .from(creditGrantMovements)
  .where(and(eq(creditGrantMovements.customerId, late.id), eq(creditGrantMovements.kind, "draw")));
check(
  "the usage of the first window was drawn from the first grant",
  firstDraw.length === 1 && firstDraw[0]!.grantId === marchId && firstDraw[0]!.units === -10n,
  firstDraw,
);
const now2 = new Date(W1.getTime() + 2 * HOUR);
const lateIn = await send(now2, late, "illustration", { timestamp: new Date(W1.getTime() - HOUR) });
const lateInRows = await creditRows(lateIn.key!);
check(
  "a late event inside the grace window draws from the grant that ended, not from the balance",
  lateIn.status === "created" &&
    lateInRows.length === 1 &&
    lateInRows[0]!.status === "pending" &&
    lateInRows[0]!.source === "grace" &&
    lateInRows[0]!.units === 10n &&
    (await row(late.id)) === 50n,
  lateInRows,
);
const onTime = await send(now2, late, "illustration");
check(
  "an event on time is paid by the balance",
  (await creditRows(onTime.key!))[0]!.source === "balance" && (await row(late.id)) === 40n,
);
// 27 hours late: older than the grace window.
const tooLate = await send(now2, late, "illustration", {
  timestamp: new Date(W0.getTime() + HOUR),
});
const tooLateRows = await creditRows(tooLate.key!);
check(
  "an event older than the grace window is paid by the balance now",
  tooLate.status === "created" &&
    tooLateRows[0]!.source === "balance" &&
    tooLateRows[0]!.status === "taken" &&
    (await row(late.id)) === 30n,
  tooLateRows,
);
const apiPending = JSON.parse((await call("GET", `usage_events?key=${lateIn.key}`)).body);
check(
  "the event reads as pending until the window ends",
  apiPending.data[0]?.credit?.[0]?.status === "pending" &&
    apiPending.data[0].credit[0].credits_from_closed_grant === "1",
  apiPending.data[0]?.credit,
);
await inStep("in a grace window");
const midPass = await settle(new Date(W1.getTime() + 4 * HOUR));
check(
  "before the window ends the pass leaves the grant open",
  midPass.locked === 0 &&
    (await grantOf(march.id)).status === "active" &&
    (await creditRows(lateIn.key!))[0]!.status === "pending",
  midPass,
);
const endPass = await settle(new Date(W1.getTime() + 12 * HOUR + MIN));
const lateSettlement = (await settlementsOf(late.id)).find((s) => s.kind === "late");
check(
  "when the window ends the draw locks: a late settlement, the grant expires with what is left",
  endPass.locked === 1 &&
    lateSettlement?.unitsDrawn === 10n &&
    lateSettlement.graceGrantId === marchId &&
    (await creditRows(lateIn.key!))[0]!.status === "settled" &&
    (await grantOf(march.id)).status === "expired" &&
    (await row(late.id)) === 30n,
  { endPass, lateSettlement },
);
const [marchLeft] = rowsOf<{ units: string }>(
  await systemDb.execute(sql`
    select coalesce(sum(units), 0)::text as units from credit_grant_movements
    where grant_id = ${marchId}`),
);
check("the first grant is closed to 0", marchLeft?.units === "0", marchLeft);
const afterLock = await send(new Date(W1.getTime() + 13 * HOUR), late, "illustration", {
  timestamp: new Date(W1.getTime() - MIN),
});
check(
  "after the lock a late event is paid by the balance",
  (await creditRows(afterLock.key!))[0]!.source === "balance" && (await row(late.id)) === 20n,
);
const ancient = await send(now2, late, "illustration", {
  timestamp: new Date(now2.getTime() - 36 * DAY),
});
check(
  "an event older than 35 days is rejected with timestamp_too_old, and nothing is stored",
  ancient.status === "error" &&
    ancient.error?.code === "timestamp_too_old" &&
    (await creditRows(ancient.key!)).length === 0 &&
    (await row(late.id)) === 20n,
  ancient,
);
const plainOld = await send(now2, late, "plain", {
  timestamp: new Date(now2.getTime() - 36 * DAY),
});
check("as for a meter with no credit cost", plainOld.error?.code === "timestamp_too_old", plainOld);
const filled = await send(now2, late, "illustration", { backfill: true });
const filledRows = await creditRows(filled.key!);
check(
  "backfill: the usage is recorded and no credits are spent",
  filled.status === "created" &&
    filledRows[0]!.status === "skipped" &&
    filledRows[0]!.reason === "backfill" &&
    filledRows[0]!.units === 0n &&
    (await row(late.id)) === 20n,
  filledRows,
);
const plainFilled = await send(now2, late, "plain", { backfill: true });
check("backfill on a meter with no credit cost changes nothing", plainFilled.status === "created");
await inStep("after late events");

// No grace window: an expiry books at once, as for a unit that pays nothing.
await systemDb
  .update(businesses)
  .set({ creditConfig: { late_event_grace_hours: 0 } })
  .where(eq(businesses.id, biz.id));
const strict = await customer("no-grace");
const strictGrant = await give(strict, 30, { effective_at: W0, expires_at: W1 });
await expire(new Date(W1.getTime() + HOUR));
check(
  "late_event_grace_hours: 0 expires a grant at once",
  (await grantOf(strictGrant.id)).status === "expired" && (await row(strict.id)) === 0n,
);
await systemDb.update(businesses).set({ creditConfig: null }).where(eq(businesses.id, biz.id));

// ── 7. A void ────────────────────────────────────────────────────────────────────
console.log("7. a void");
const voider = await customer("void");
await give(voider, 30, { effective_at: plus(-DAY) });
const v1 = await send(plus(80 * MIN), voider, "illustration");
const v2 = await send(plus(80 * MIN), voider, "illustration");
check("two events take 2.0 of 3.0", (await row(voider.id)) === 10n);
await at(plus(81 * MIN), () => voidUsageEvent({ ...ids, key: v1.key! }));
const v1Rows = await creditRows(v1.key!);
check(
  "a void before settlement gives the credits back",
  (await row(voider.id)) === 20n &&
    v1Rows[0]!.status === "skipped" &&
    v1Rows[0]!.reason === "voided",
  v1Rows,
);
await settle(plus(3 * HOUR));
const lateVoid = await at(plus(3 * HOUR), () => voidUsageEvent({ ...ids, key: v2.key! })).catch(
  (e) => e,
);
check(
  "a void after settlement gives the credits back through a correcting settlement (0530)",
  !(lateVoid instanceof Error) && (await row(voider.id)) === 30n,
  String(lateVoid),
);
await inStep("after a void");

// ── 8. The cost removed ──────────────────────────────────────────────────────────
console.log("8. the cost removed");
const del = await call("DELETE", "meters/edit/credit_cost");
check(
  "DELETE removes the cost",
  del.statusCode === 200 && JSON.parse(del.body).deleted === true,
  del.body,
);
const free = await send(plus(82 * MIN), voider, "edit");
check(
  "the meter's events then spend nothing and are not gated",
  free.status === "created" &&
    (await creditRows(free.key!)).length === 0 &&
    (await row(voider.id)) === 30n,
);
check(
  "a second DELETE is 404",
  (await call("DELETE", "meters/edit/credit_cost")).statusCode === 404,
);
const back = await call("PUT", "meters/edit/credit_cost", {
  unit: "credit",
  credits_per_unit: "0.5",
});
check("PUT sets it again", back.statusCode === 200, back.body);

// ── 9. The billing clock, as a time-travel step runs it ──────────────────────────
console.log("9. the billing clock runs the pass");
const clocked = await customer("clock");
await give(clocked, 30, { effective_at: plus(-DAY) });
await send(plus(5 * HOUR + 10 * MIN), clocked, "illustration");
const stepAt = plus(6 * HOUR + MIN);
await runWithClockScope({ onlyBusinessId: biz.id, now: stepAt }, () =>
  runBillingClockTickOnce(() => {}, stepAt),
);
const clockedSettled = await settlementsOf(clocked.id);
check(
  "a tick at the simulated time settles the usage of this business",
  clockedSettled.length === 1 &&
    clockedSettled[0]!.unitsDrawn === 10n &&
    clockedSettled[0]!.windowEnd.getTime() === plus(6 * HOUR).getTime(),
  clockedSettled,
);
await inStep("after a tick");

// ── 10. Isolation between organizations ───────────────────────────────────────────
console.log("10. isolation");
const other = await createOrganization({ name: "Credits Own Unit Other Org" });
const otherBiz = await createBusiness({
  organizationId: other.organization.id,
  name: "Other",
  defaultCurrency: "USD",
  livemode: "test",
});
for (const [name, table] of [
  ["meter_credit_costs", meterCreditCosts],
  ["credit_usage_events", creditUsageEvents],
  ["credit_usage_settlements", creditUsageSettlements],
  ["credit_grant_grace", creditGrantGrace],
] as const) {
  const mine = await withTenant(orgId, (tx) => tx.select().from(table));
  const theirs = await withTenant(other.organization.id, (tx) => tx.select().from(table));
  check(
    `RLS: the other organization reads no ${name} row`,
    mine.length > 0 && theirs.length === 0,
    {
      mine: mine.length,
      theirs: theirs.length,
    },
  );
}
const [illusMeter] = await systemDb
  .select()
  .from(meterCreditCosts)
  .where(eq(meterCreditCosts.businessId, biz.id));
const crossWrite = await withTenant(other.organization.id, (tx) =>
  tx.insert(meterCreditCosts).values({
    organizationId: orgId,
    businessId: biz.id,
    meterId: illusMeter!.meterId,
    unitId,
    creditsPerUnit: "9",
    productId: product.id,
  }),
).catch((e) => e);
check("RLS: it cannot write a cost for this organization", crossWrite instanceof Error);
const crossRead = await call("GET", "meters/illustration/credit_cost", undefined, {
  secret: other.secret,
  biz: otherBiz.publicId,
});
check("the cost is not in the other organization's business (404)", crossRead.statusCode === 404);
const appendOnly = await withTenant(orgId, (tx) =>
  tx.update(creditUsageSettlements).set({ revenueMinor: 1n }),
).catch((e) => e);
check("a settlement cannot be changed by the app role", appendOnly instanceof Error);
await inStep("at the end");

await app.close();
await closeDb();
if (fails.length) {
  console.log(`\n❌ CREDITS-OWN-UNIT: FAIL (${fails.length})`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exit(1);
}
console.log("\n✅ CREDITS-OWN-UNIT: PASS");
process.exit(0);
