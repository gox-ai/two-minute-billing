/**
 * The gate for usage paid in credits, exact at the instant (0526):
 *  - a grant pays only while its window contains the instant: one that starts later, one that
 *    just ended, a late event in the grace window, 40 parallel events at the expiry;
 *  - parallel grants and the balance row; the limit on free grants in units;
 *  - a credit note on a pack line: untouched, partly used and settled, used and not settled;
 *  - a hold in money captured with an event of a meter with a credit cost, both capture
 *    shapes (holds in units: `verify:credit-holds-units`);
 *  - settlement while events arrive; webhook deliveries of the two events;
 *  - reset windows and the term renewal through the credit clock;
 *  - a pack bought, used, settled and expired by the time-travel API.
 * Every step runs at a pinned business time.
 *
 *   pnpm verify:all:fresh -- --suite credits-gate
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { runWithClockScope } from "@/platform/clock";
import { runBillingClockTickOnce } from "@/platform/jobs";
import { createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createManualInvoice, recordOfflinePayment } from "@/modules/invoicing/ops";
import { issueRefundableCreditNote } from "@/modules/credit-notes/service";
import { ingestUsageEvents, voidUsageEvent } from "@/modules/metering/ingest";
import { unitBalanceSteps } from "@/modules/credits/service";
import { runExpireCreditGrants } from "@/modules/credits/expiry";
import { liveBalance } from "@/modules/credits/balance";
import { runSettleCreditUsage } from "@/modules/credits/usage-settlement";
import { createEndpoint } from "@/modules/webhooks/endpoints";
import {
  auditLogs,
  businesses,
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrantGrace,
  creditGrants,
  creditUnits,
  creditUsageEvents,
  creditUsageSettlements,
  invoiceLineItems,
  subscriptions,
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

const { org, orgId, biz, ids, product } = await meterBusiness("Credits Gate Org");
const app = await buildApp({ logger: false });
const at = <T>(t: Date, fn: () => Promise<T>) =>
  runWithClockScope({ onlyBusinessId: biz.id, now: t }, fn);

let keyN = 0;
const call = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: object,
  o: { biz?: string; raw?: boolean } = {},
) =>
  app.inject({
    method,
    url: o.raw ? path : `/v1/businesses/${o.biz ?? biz.publicId}/${path}`,
    headers: {
      authorization: `Bearer ${org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": `cg-${Date.now()}-${++keyN}` }),
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
async function unbalanced(): Promise<number> {
  return rowsOf(
    await systemDb.execute(sql`
      select transaction_id from ledger_entries where organization_id = ${orgId}
      group by transaction_id
      having sum(case when direction = 'debit' then amount_minor else -amount_minor end) <> 0`),
  ).length;
}
/**
 * The rule of the invariant `credit_unit_balance_matches_grants`, for this organization: the
 * row = Σ movements of the grants in it − units taken and not settled − what open grace rows
 * hold, and never below 0; `held_steps` = Σ open holds in the unit. Both directions: a row
 * that disagrees, and grants with no row.
 */
async function drift(): Promise<unknown[]> {
  return rowsOf(
    await systemDb.execute(sql`
      select k.customer_id, coalesce(bal.available_steps, 0)::text as balance,
        (coalesce(g.steps, 0) - coalesce(t.steps, 0) - coalesce(gr.steps, 0))::text as expected
      from (
        select customer_id, unit_id from credit_unit_balances where organization_id = ${orgId}
        union
        select customer_id, unit_id from credit_grants
        where organization_id = ${orgId} and not unit_rated
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
        select sum(h.remaining_units) as steps from credit_holds h
        where h.customer_id = k.customer_id and h.unit_id = k.unit_id and h.status = 'held'
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
  check(`${label}: the balance row equals its rule and is not below 0`, d.length === 0, d);
  check(`${label}: every ledger transaction balances`, (await unbalanced()) === 0);
};
const customer = (tag: string) =>
  createCustomer({ ...ids, email: `${tag}-${Date.now()}@example.com`, autoCollection: "off" });

let evN = 0;
type Sent = { status: string; key: string | null; error?: { code: string; message: string } };
const send = async (
  t: Date,
  c: { publicId: string },
  eventName: string,
  o: { timestamp?: Date; key?: string } = {},
): Promise<Sent> => {
  const [r] = await at(t, () =>
    ingestUsageEvents({
      ...ids,
      events: [
        {
          key: o.key ?? `cg-ev-${Date.now()}-${++evN}`,
          customer: c.publicId,
          event_name: eventName,
          ...(o.timestamp ? { timestamp: o.timestamp.toISOString() } : {}),
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
const settle = (t: Date) => at(t, () => runSettleCreditUsage(t));
const expire = (t: Date) => at(t, () => runExpireCreditGrants(t));
const grantOf = async (publicId: string) =>
  (await systemDb.select().from(creditGrants).where(eq(creditGrants.publicId, publicId)))[0]!;
const give = async (
  c: { publicId: string },
  amount: number,
  o: { effective_at?: Date; expires_at?: Date } = {},
) =>
  (await must(201, "POST", `customers/${c.publicId}/credit_grants`, {
    unit: "credit",
    amount,
    ...(o.effective_at ? { effective_at: o.effective_at.toISOString() } : {}),
    ...(o.expires_at ? { expires_at: o.expires_at.toISOString() } : {}),
  })) as { id: string };
const graceOf = async (grantPublicId: string) =>
  (
    await systemDb
      .select()
      .from(creditGrantGrace)
      .where(eq(creditGrantGrace.grantId, (await grantOf(grantPublicId)).id))
  )[0];
/** `availableUnits` of the live balance for the unit, in steps. Null = the unit is not listed. */
const offered = (customerId: string, t: Date) =>
  at(t, () =>
    withTenant(orgId, async (tx) => {
      const bal = await liveBalance(tx, {
        customerId,
        currency: "USD",
        now: t,
        businessConfig: null,
        customerSettings: null,
      });
      return bal.availableUnits.find((u) => u.unit === "credit")?.units ?? null;
    }),
  );

// ── Setup: one unit with no rate (1 decimal), one meter that costs 1 credit ───────
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
const row = (customerId: string) =>
  withTenant(orgId, (tx) => unitBalanceSteps(tx, { customerId, unitId }));
await must(201, "POST", "meters", {
  id: "illustration",
  name: "Illustrations",
  event_name: "illustration",
  aggregation: "count",
});
await must(200, "PUT", "meters/illustration/credit_cost", {
  unit: "credit",
  credits_per_unit: "1",
});

// ── 1. A grant that starts later ─────────────────────────────────────────────────
console.log("1. a grant that starts in the future");
{
  const c = await customer("future");
  const g = await give(c, 50, { effective_at: plus(2 * HOUR) });
  check(
    "the grant is written, marked out of the balance, and the row is 0",
    (await grantOf(g.id)).outOfBalance && (await row(c.id)) === 0n,
    await grantOf(g.id),
  );
  check(
    "the live balance offers 0 before the start",
    ((await offered(c.id, plus(HOUR))) ?? 0n) === 0n,
  );
  const early = await send(plus(HOUR), c, "illustration");
  check(
    "an event one hour before the start is refused: the grant does not pay",
    early.error?.code === "insufficient_credit" && (await row(c.id)) === 0n,
    early,
  );
  await inStep("before the start");
  check(
    "the live balance offers 5.0 after the start, before any event or pass",
    (await offered(c.id, plus(2 * HOUR + MIN))) === 50n && (await row(c.id)) === 0n,
    await offered(c.id, plus(2 * HOUR + MIN)),
  );
  const later = await send(plus(2 * HOUR + MIN), c, "illustration");
  check(
    "an event after the start is paid, with no pass in between",
    later.status === "created" && (await row(c.id)) === 40n && !(await grantOf(g.id)).outOfBalance,
    { later, row: await row(c.id) },
  );
  await inStep("after the start");
  // A grant that is voided before its start never reaches the row.
  const v = await give(c, 70, { effective_at: plus(9 * DAY) });
  await must(200, "POST", `customers/${c.publicId}/credit_grants/${v.id}/void`);
  check("a void before the start leaves the row as it is", (await row(c.id)) === 40n);
  await inStep("after a void before the start");
}

// ── 2. A grant that just ended ───────────────────────────────────────────────────
console.log("2. a grant that expired one second ago");
{
  const END = plus(3 * HOUR);
  const c = await customer("ended");
  const g = await give(c, 50, { effective_at: plus(-DAY), expires_at: END });
  const inLife = await send(plus(2 * HOUR), c, "illustration");
  check("an event inside the grant's life is paid", inLife.status === "created");
  check(
    "one second after the expiry the live balance offers 0, though no pass ran",
    ((await offered(c.id, plus(3 * HOUR + SEC))) ?? 0n) === 0n && (await row(c.id)) === 40n,
    { offered: await offered(c.id, plus(3 * HOUR + SEC)), row: await row(c.id) },
  );
  const fresh = await send(plus(3 * HOUR + SEC), c, "illustration");
  const grace = await graceOf(g.id);
  check(
    "a fresh event one second after the expiry is refused, though no expiry pass ran",
    fresh.error?.code === "insufficient_credit" &&
      (await creditRows(fresh.key!))[0]!.status === "refused" &&
      (await row(c.id)) === 0n,
    { fresh, row: await row(c.id) },
  );
  check(
    "the gate closed the grant as the pass does: 4.0 wait in its grace row, usage is settled",
    grace?.availableSteps === 40n &&
      grace.validUntil.getTime() === END.getTime() &&
      (await creditRows(inLife.key!))[0]!.status === "settled",
    grace,
  );
  await inStep("after the expiry");
  const late = await send(plus(3 * HOUR + 2 * SEC), c, "illustration", {
    timestamp: plus(2 * HOUR + 30 * MIN),
  });
  const lateRows = await creditRows(late.key!);
  check(
    "a late event dated inside the grant's life, inside the grace window, is paid by that grant",
    late.status === "created" &&
      lateRows.length === 1 &&
      lateRows[0]!.status === "pending" &&
      lateRows[0]!.source === "grace" &&
      lateRows[0]!.units === 10n &&
      (await graceOf(g.id))?.availableSteps === 30n,
    lateRows,
  );
  await inStep("after a late event");
  const passed = await expire(plus(3 * HOUR + 3 * SEC));
  check(
    "the expiry pass then finds nothing to do for this grant",
    passed.expired === 0 && (await grantOf(g.id)).status === "active",
    passed,
  );

  // With another grant, the customer pays from it.
  const d = await customer("two-grants");
  const short = await give(d, 10, { effective_at: plus(-DAY), expires_at: END });
  await give(d, 50, { effective_at: plus(-DAY) });
  const paid = await send(plus(3 * HOUR + SEC), d, "illustration");
  check(
    "with a second grant, the event is paid by it and the ended grant is not spent",
    paid.status === "created" &&
      (await row(d.id)) === 40n &&
      (await graceOf(short.id))?.availableSteps === 10n,
    { paid, row: await row(d.id) },
  );
  await inStep("after the second grant paid");
}

// ── 3. 40 parallel events at the instant a grant expires ─────────────────────────
console.log("3. concurrency: 40 parallel events at the expiry");
{
  const END = plus(4 * HOUR);
  const c = await customer("race");
  const ending = await give(c, 50, { effective_at: plus(-DAY), expires_at: END });
  await give(c, 30, { effective_at: plus(-DAY) });
  const results = await Promise.all(Array.from({ length: 40 }, () => send(END, c, "illustration")));
  const created = results.filter((r) => r.status === "created").length;
  const refused = results.filter((r) => r.error?.code === "insufficient_credit").length;
  check(
    "3 events are paid by the live grant (3.0); 37 are refused; none by the ended grant",
    created === 3 && refused === 37 && (await row(c.id)) === 0n,
    { created, refused, row: await row(c.id), other: results.filter((r) => !r.key).length },
  );
  check(
    "the ended grant keeps its 5.0 for late events",
    (await graceOf(ending.id))?.availableSteps === 50n,
    await graceOf(ending.id),
  );
  await inStep("after 40 parallel events");
}

// ── 4. Parallel grants ───────────────────────────────────────────────────────────
console.log("4. concurrency: 20 parallel grants");
{
  const c = await customer("grants");
  const made = await Promise.all(
    Array.from({ length: 20 }, () =>
      call("POST", `customers/${c.publicId}/credit_grants`, { unit: "credit", amount: 7 }),
    ),
  );
  check(
    "20 grants of 0.7 written at the same time leave 14.0 on the row",
    made.every((r) => r.statusCode === 201) && (await row(c.id)) === 140n,
    { statuses: made.map((r) => r.statusCode), row: await row(c.id) },
  );
  await inStep("after parallel grants");
}

// ── 5. The limit on free grants, in units ────────────────────────────────────────
console.log("5. the limit on free grants in a unit with no rate");
{
  const c = await customer("limits");
  const largeGrants = () =>
    withTenant(orgId, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.businessId, biz.id), eq(auditLogs.action, "credit.large_grant"))),
    );
  const before = (await largeGrants()).length;
  const free = await call("POST", `customers/${c.publicId}/credit_grants`, {
    unit: "credit",
    amount: 5_000_000,
  });
  check("unset: a grant of any size is accepted, with no audit row", free.statusCode === 201);
  const set = await call(
    "PATCH",
    `/v1/businesses/${biz.publicId}`,
    {
      credit_config: { unit_grant_limits: { credit: { max_units: 1000, alert_above_units: 500 } } },
    },
    { raw: true },
  );
  const [saved] = await systemDb
    .select({ cfg: businesses.creditConfig })
    .from(businesses)
    .where(eq(businesses.id, biz.id));
  check(
    "PATCH stores credit_config.unit_grant_limits",
    set.statusCode === 200 && saved?.cfg?.unit_grant_limits?.credit?.max_units === 1000,
    set.body,
  );
  const over = await call("POST", `customers/${c.publicId}/credit_grants`, {
    unit: "credit",
    amount: 1001,
  });
  check(
    "a grant above the maximum is refused (400) with the maximum in units",
    over.statusCode === 400 && /The maximum for one grant is 100 credits\./.test(over.body),
    over.body,
  );
  const atMax = await call("POST", `customers/${c.publicId}/credit_grants`, {
    unit: "credit",
    amount: 1000,
  });
  const audit = await largeGrants();
  const lastAudit = audit[audit.length - 1]?.after as
    | { unit?: string; amount_units?: number; alert_above_units?: number }
    | undefined;
  check(
    "a grant at the maximum is accepted and, above the alert amount, written to the audit log",
    atMax.statusCode === 201 &&
      audit.length === before + 1 &&
      lastAudit?.unit === "credit" &&
      lastAudit.amount_units === 1000 &&
      lastAudit.alert_above_units === 500,
    { status: atMax.statusCode, lastAudit },
  );
  const small = await call("POST", `customers/${c.publicId}/credit_grants`, {
    unit: "credit",
    amount: 500,
  });
  check(
    "a grant at the alert amount is accepted with no audit row",
    small.statusCode === 201 && (await largeGrants()).length === before + 1,
  );
  const bad = await call(
    "PATCH",
    `/v1/businesses/${biz.publicId}`,
    {
      credit_config: { unit_grant_limits: { credit: { max_units: -1 } } },
    },
    { raw: true },
  );
  check("a negative limit is refused (400)", bad.statusCode === 400, bad.body);
  await systemDb.update(businesses).set({ creditConfig: null }).where(eq(businesses.id, biz.id));
  await inStep("after the limits");
}

// ── 6. A credit note on a pack line ──────────────────────────────────────────────
console.log("6. a credit note on a pack line");
const packProduct = await createProduct({ ...ids, name: "Credit packs", kind: "charge" });
const packPrice = await createPrice({
  ...ids,
  productId: packProduct.id,
  id: `gate-pack-${Date.now()}`,
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
/** Sell one pack (15.0 credits for 9.00) and pay it, at `t`. */
async function buyPack(c: { id: string }, t: Date) {
  const sale = await at(t, () =>
    createManualInvoice({
      ...ids,
      customerId: c.id,
      currency: "USD",
      collect: false,
      lines: [
        {
          description: "Credit pack",
          priceId: packPrice.id,
          quantity: 1,
          amountMinor: 900n,
          kind: "one_time",
        },
      ],
    }),
  );
  await at(t, () =>
    recordOfflinePayment({ ...ids, invoicePublicId: sale.invoice.publicId, method: "wire" }),
  );
  const [line] = await systemDb
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, sale.invoice.id));
  const [grant] = await systemDb
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.invoiceId, sale.invoice.id));
  if (!line || !grant) throw new Error("the pack sale wrote no line or no grant");
  return { invoice: sale.invoice, line, grant };
}
const creditPack = (t: Date, p: Awaited<ReturnType<typeof buyPack>>, amountMinor: number) =>
  at(t, () =>
    issueRefundableCreditNote({
      ...ids,
      invoicePublicId: p.invoice.publicId,
      items: [
        { description: "Pack refund", amountMinor, invoiceLineItemPublicId: p.line.publicId },
      ],
    }),
  ).then(
    () => null as string | null,
    (e: Error) => e.message,
  );
const grantLeft = async (grantId: string) => {
  const [r] = rowsOf<{ units: string; cost: string }>(
    await systemDb.execute(sql`
      select coalesce(sum(units), 0)::text as units, coalesce(sum(cost_minor), 0)::text as cost
      from credit_grant_movements where grant_id = ${grantId}`),
  );
  return { units: BigInt(r!.units), cost: BigInt(r!.cost) };
};
const statusOf = async (grantId: string) =>
  (await systemDb.select().from(creditGrants).where(eq(creditGrants.id, grantId)))[0]!.status;
const T6 = plus(5 * HOUR);
{
  // (a) An untouched pack.
  const c = await customer("cn-untouched");
  const p = await buyPack(c, T6);
  const refused = await creditPack(plus(5 * HOUR + MIN), p, 900);
  check(
    "(a) untouched: a credit note for the whole pack voids 15.0 credits and all deferred revenue",
    refused === null &&
      (await row(c.id)) === 0n &&
      (await grantLeft(p.grant.id)).units === 0n &&
      (await grantLeft(p.grant.id)).cost === 0n &&
      (await statusOf(p.grant.id)) === "voided" &&
      ((await ledger(c.id))[A.paid] ?? 0n) === 0n,
    { refused, left: await grantLeft(p.grant.id), ledger: await ledger(c.id) },
  );
  check("(a) deferred revenue equals the cost left on paid credit", await paidMatches(c.id));
  await inStep("(a) after the credit note");
}
{
  // (b) Partly used, the usage settled: 6.0 of 15.0 used = 3.60 of 9.00 earned.
  const c = await customer("cn-settled");
  const p = await buyPack(c, T6);
  for (let i = 0; i < 6; i++) await send(plus(5 * HOUR + 2 * MIN), c, "illustration");
  await settle(plus(6 * HOUR + MIN));
  const whole = await creditPack(plus(6 * HOUR + 2 * MIN), p, 900);
  check(
    "(b) settled usage: a credit note for the whole pack is refused; 5.40 is creditable",
    whole !== null && /only .*5\.40/.test(whole) && (await row(c.id)) === 90n,
    whole,
  );
  const rest = await creditPack(plus(6 * HOUR + 3 * MIN), p, 540);
  check(
    "(b) a credit note for the unused 5.40 voids the 9.0 credits that are left",
    rest === null &&
      (await row(c.id)) === 0n &&
      (await grantLeft(p.grant.id)).units === 0n &&
      (await grantLeft(p.grant.id)).cost === 0n &&
      (await statusOf(p.grant.id)) === "voided" &&
      ((await ledger(c.id))[A.paid] ?? 0n) === 0n,
    { rest, left: await grantLeft(p.grant.id), ledger: await ledger(c.id) },
  );
  check("(b) deferred revenue equals the cost left on paid credit", await paidMatches(c.id));
  await inStep("(b) after the credit note");
}
{
  // (c) Partly used, the usage not settled yet: the note reads the pack as settled.
  const c = await customer("cn-taken");
  const p = await buyPack(c, T6);
  for (let i = 0; i < 6; i++) await send(plus(5 * HOUR + 2 * MIN), c, "illustration");
  const whole = await creditPack(plus(5 * HOUR + 3 * MIN), p, 900);
  check(
    "(c) usage not settled: a credit note for the whole pack is refused; 5.40 is creditable",
    whole !== null && /only .*5\.40/.test(whole) && (await row(c.id)) === 90n,
    whole,
  );
  const half = await creditPack(plus(5 * HOUR + 4 * MIN), p, 270);
  const mid = await grantLeft(p.grant.id);
  const settledNow = await systemDb
    .select()
    .from(creditUsageSettlements)
    .where(eq(creditUsageSettlements.customerId, c.id));
  check(
    "(c) a credit note for 2.70 settles the usage first (3.60 earned) and voids 4.5 credits",
    half === null &&
      settledNow.length === 1 &&
      settledNow[0]!.unitsDrawn === 60n &&
      settledNow[0]!.revenueMinor === 360n &&
      mid.units === 45n &&
      mid.cost === 270n &&
      (await row(c.id)) === 45n &&
      (await statusOf(p.grant.id)) === "active",
    { half, mid, row: await row(c.id), settledNow },
  );
  check("(c) deferred revenue equals the cost left on paid credit", await paidMatches(c.id));
  await inStep("(c) after a part credit note");
  const again = await send(plus(5 * HOUR + 5 * MIN), c, "illustration");
  check(
    "(c) what is left of the pack still pays usage",
    again.status === "created" && (await row(c.id)) === 35n,
  );
  const tooMuch = await creditPack(plus(5 * HOUR + 6 * MIN), p, 270);
  check(
    "(c) a second note for 2.70 is refused: usage took 1.0 more, 2.10 is creditable",
    tooMuch !== null && /only .*2\.10/.test(tooMuch),
    tooMuch,
  );
  await inStep("(c) after a refused credit note");
}

// ── 7. A hold in money and an event of a meter with a credit cost ────────────────
console.log("7. a hold in money on a meter with a credit cost");
{
  const T = plus(7 * HOUR);
  const c = await createCustomer({
    ...ids,
    email: `hold-${Date.now()}@example.com`,
    autoCollection: "off",
    currency: "USD",
  });
  await give(c, 20, { effective_at: plus(-DAY) });
  const hold = (payload: object) =>
    at(T, () => call("POST", `customers/${c.publicId}/credit_holds`, payload));
  const capture = (id: string, payload: object) =>
    at(T, () => call("POST", `credit_holds/${id}/capture`, payload));
  const ev = (key: string) => ({ key, customer: c.publicId, event_name: "illustration" });

  // Shape 1: the capture ingests the event. The gate decides it as any other event.
  const h1 = await hold({ amount_minor: 10 });
  if (h1.statusCode !== 201) throw new Error(`hold failed: ${h1.body}`);
  const k1 = `cap-a-${Date.now()}`;
  const c1 = await capture(JSON.parse(h1.body).id, { usage_event: ev(k1) });
  const r1 = (await creditRows(k1))[0];
  check(
    "a capture that sends the event: captured, the event takes 1.0 through the gate",
    c1.statusCode === 200 &&
      JSON.parse(c1.body).status === "captured" &&
      r1?.status === "taken" &&
      !r1.coveredByHold &&
      r1.units === 10n &&
      r1.unitsUncovered === 0n &&
      (await row(c.id)) === 10n,
    { status: c1.statusCode, body: c1.body, r1 },
  );
  await inStep("after a capture with an event");

  // Shape 2: the event arrived first, through the gate; the capture names it.
  const k2 = `cap-b-${Date.now()}`;
  const first = await send(T, c, "illustration", { key: k2 });
  const h2 = await hold({ amount_minor: 10 });
  if (h2.statusCode !== 201) throw new Error(`hold failed: ${h2.body}`);
  const c2 = await capture(JSON.parse(h2.body).id, { usage_event_id: k2 });
  const r2 = await creditRows(k2);
  check(
    "a capture that names a stored event: captured, the event's credits are taken once",
    first.status === "created" &&
      c2.statusCode === 200 &&
      JSON.parse(c2.body).status === "captured" &&
      r2.length === 1 &&
      r2[0]!.status === "taken" &&
      r2[0]!.units === 10n &&
      (await row(c.id)) === 0n,
    { status: c2.statusCode, body: c2.body, r2 },
  );
  await inStep("after a capture by key");

  // At zero: a hold in money covers nothing. The capture is refused and stores no event.
  const h3 = await hold({ amount_minor: 10 });
  if (h3.statusCode !== 201) throw new Error(`hold failed: ${h3.body}`);
  const k3 = `cap-c-${Date.now()}`;
  const c3 = await capture(JSON.parse(h3.body).id, { usage_event: ev(k3) });
  check(
    "at zero, a capture with a hold in money is refused (402): no event, no credits not covered",
    c3.statusCode === 402 &&
      JSON.parse(c3.body).error?.code === "insufficient_credit" &&
      (await creditRows(k3)).length === 0 &&
      (await row(c.id)) === 0n,
    { status: c3.statusCode, body: c3.body },
  );
  const bare = await send(T, c, "illustration");
  check("at zero, an event with no hold is refused", bare.error?.code === "insufficient_credit");
  // A capture that names a refused event leaves it refused.
  const c4 = await capture(JSON.parse(h3.body).id, { usage_event_id: bare.key! });
  check(
    "a hold in money that names a refused event does not bill it: the event stays refused",
    c4.statusCode === 200 && (await creditRows(bare.key!))[0]!.status === "refused",
    { status: c4.statusCode, body: c4.body },
  );
  const [gap] = rowsOf<{ n: number }>(
    await systemDb.execute(sql`
      select count(*)::int as n from credit_usage_events
      where customer_id = ${c.id} and units_uncovered > 0`),
  );
  check("no event of this customer has credits that nothing paid", gap!.n === 0, gap);
  await inStep("after captures at zero");
}

// ── 8. Settlement while events arrive ────────────────────────────────────────────
console.log("8. settlement against concurrent ingest");
{
  const c = await customer("settle-race");
  await give(c, 1000, { effective_at: plus(-DAY) });
  const early = plus(8 * HOUR + 50 * MIN);
  const passAt = plus(9 * HOUR + MIN);
  const seeded: Sent[] = [];
  for (let i = 0; i < 5; i++) seeded.push(await send(early, c, "illustration"));
  const outcome = await Promise.allSettled([
    ...Array.from({ length: 20 }, () => send(early, c, "illustration")),
    settle(passAt),
    ...Array.from({ length: 20 }, () => send(passAt, c, "illustration")),
    settle(passAt),
    at(passAt, () => voidUsageEvent({ ...ids, key: seeded[0]!.key! })),
  ]);
  // The void may meet a settled event (409); nothing else may fail, and nothing may deadlock.
  const failed = outcome
    .map((o, i) => ({ o, i }))
    .filter(({ o, i }) => o.status === "rejected" && i !== outcome.length - 1)
    .map(({ o }) => String((o as PromiseRejectedResult).reason));
  check("no call failed and none deadlocked", failed.length === 0, failed);
  const mine = await systemDb
    .select()
    .from(creditUsageEvents)
    .where(eq(creditUsageEvents.customerId, c.id));
  const by = (s: string) => mine.filter((r) => r.status === s);
  const drawn = await systemDb
    .select()
    .from(creditUsageSettlements)
    .where(eq(creditUsageSettlements.customerId, c.id));
  const sum = (xs: Array<{ units: bigint }>) => xs.reduce((a, r) => a + r.units, 0n);
  const voided = by("skipped").length;
  check(
    "45 events, each counted once: settled, still taken, or the one that was voided",
    mine.length === 45 &&
      by("settled").length + by("taken").length + voided === 45 &&
      voided <= 1 &&
      by("refused").length === 0,
    { settled: by("settled").length, taken: by("taken").length, voided },
  );
  check(
    "the settlements drew exactly the settled events' credits",
    drawn.reduce((a, s) => a + s.unitsDrawn, 0n) === sum(by("settled")),
    { drawn: drawn.map((s) => s.unitsDrawn), settled: sum(by("settled")) },
  );
  check(
    "the row = 100.0 − what is settled − what is taken",
    (await row(c.id)) === 1000n - sum(by("settled")) - sum(by("taken")),
    await row(c.id),
  );
  await inStep("after settlement against ingest");
  await settle(plus(10 * HOUR + MIN));
  const after = await systemDb
    .select()
    .from(creditUsageEvents)
    .where(and(eq(creditUsageEvents.customerId, c.id), eq(creditUsageEvents.status, "taken")));
  check("the next pass settles the rest", after.length === 0, after.length);
  await inStep("after the next pass");
}

// ── 9. Webhook deliveries ────────────────────────────────────────────────────────
console.log("9. webhook deliveries of the two events");
{
  const ep = await createEndpoint({
    organizationId: orgId,
    url: "https://hooks.example.com/credits-gate",
    eventTypes: ["credit_usage_refused", "credit_usage_settled"],
  });
  const c = await customer("hooks");
  await give(c, 10, { effective_at: plus(-DAY) });
  const ok = await send(plus(11 * HOUR + 10 * MIN), c, "illustration");
  const no = await send(plus(11 * HOUR + 11 * MIN), c, "illustration");
  await settle(plus(12 * HOUR + MIN));
  const sent = rowsOf<{ type: string; status: string; data: Record<string, unknown> }>(
    await systemDb.execute(sql`
      select e.type, d.status, e.data from webhook_deliveries d
      join events e on e.id = d.event_id
      join webhook_endpoints w on w.id = d.endpoint_id
      where w.public_id = ${ep.endpoint.publicId}`),
  );
  const refusedHook = sent.find((s) => s.type === "credit_usage_refused");
  const settledHook = sent.find((s) => s.type === "credit_usage_settled");
  check(
    "credit_usage_refused has a delivery row for the endpoint, with the key and the policy",
    ok.status === "created" &&
      JSON.stringify(refusedHook?.data ?? {}).includes(no.key!) &&
      JSON.stringify(refusedHook?.data ?? {}).includes('"policy":"block"'),
    sent.map((s) => [s.type, s.status]),
  );
  check(
    "credit_usage_settled has a delivery row for the endpoint",
    !!settledHook && JSON.stringify(settledHook.data).includes('"credits_drawn":"1"'),
    settledHook?.data,
  );
  check(
    "no other event type reached the endpoint",
    sent.every((s) => s.type === "credit_usage_refused" || s.type === "credit_usage_settled"),
    sent.map((s) => s.type),
  );
}

// ── 10. Reset windows and the term renewal, through the credit clock ─────────────
console.log("10. reset windows and the term renewal");
const T0 = plus(13 * HOUR);
let pn = 0;
const planPrice = (gc: Record<string, unknown>) =>
  createPrice({
    ...ids,
    productId: product.id,
    id: `gate-plan-${++pn}-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 3900,
    interval: "month",
    grantsCredit: gc,
  });
async function subscribe(tag: string, gc: Record<string, unknown>) {
  const c = await newCustomer(ids, tag);
  const price = await planPrice(gc);
  const res = await at(T0, () =>
    createSubscription({ ...ids, customerId: c.id, now: T0, items: [{ price, quantity: 1 }] }),
  );
  const [subRow] = await systemDb
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, res.subscription.id));
  await at(T0, () =>
    billSubscriptionPeriod({
      ...ids,
      subscription: subRow!,
      periodStart: subRow!.currentPeriodStart!,
      periodEnd: subRow!.currentPeriodEnd!,
    }),
  );
  return { c, sub: subRow! };
}
const liveGrants = (customerId: string) =>
  systemDb
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.customerId, customerId), eq(creditGrants.unitId, unitId)))
    .orderBy(creditGrants.effectiveAt, creditGrants.id);
{
  // A daily window of 10.0 credits on a monthly plan.
  const { c } = await subscribe("windows", {
    kind: "per_cycle",
    unit: "credit",
    amount: 100,
    reset: { every: "day" },
  });
  const day1 = await send(new Date(T0.getTime() + 2 * HOUR), c, "illustration");
  const g1 = await liveGrants(c.id);
  check(
    "window 1 grants 10.0 and an event in it is paid",
    day1.status === "created" &&
      g1.length === 1 &&
      g1[0]!.expiresAt?.getTime() === T0.getTime() + DAY &&
      (await row(c.id)) === 90n,
    { day1, grants: g1.map((g) => [g.sourceRef, g.expiresAt]) },
  );
  // One minute into window 2, with no pass: the gate closes window 1 and the clock grants 2.
  const t2 = new Date(T0.getTime() + DAY + MIN);
  const day2 = await send(t2, c, "illustration");
  const g2 = await liveGrants(c.id);
  const [closed] = g2;
  const closedGrace = (
    await systemDb.select().from(creditGrantGrace).where(eq(creditGrantGrace.grantId, closed!.id))
  )[0];
  check(
    "across the boundary with no pass: window 2 is granted and pays; window 1 does not",
    day2.status === "created" &&
      g2.length === 2 &&
      g2[1]!.effectiveAt.getTime() === T0.getTime() + DAY &&
      (await row(c.id)) === 90n &&
      closedGrace?.availableSteps === 90n,
    { day2, row: await row(c.id), grants: g2.map((g) => [g.sourceRef, g.status]), closedGrace },
  );
  await inStep("after the window boundary");
  const late = await send(new Date(t2.getTime() + MIN), c, "illustration", {
    timestamp: new Date(T0.getTime() + 20 * HOUR),
  });
  const lateRow = (await creditRows(late.key!))[0];
  check(
    "a late event dated in window 1 is paid by window 1's grant, not by window 2",
    late.status === "created" &&
      lateRow?.source === "grace" &&
      lateRow.graceGrantId === closed!.id &&
      (await row(c.id)) === 90n,
    lateRow,
  );
  await inStep("after a late event in window 1");
  // Past the grace window, the pass draws the late event and books the rest out.
  const t3 = new Date(T0.getTime() + DAY + 13 * HOUR);
  await settle(t3);
  const [closedAfter] = await systemDb
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.id, closed!.id));
  check(
    "after the grace window the pass draws the late event and expires window 1",
    closedAfter?.status === "expired" &&
      (await grantLeft(closed!.id)).units === 0n &&
      (await creditRows(late.key!))[0]!.status === "settled",
    closedAfter?.status,
  );
  await inStep("after window 1 is locked");
}
{
  // Term credits: 20.0 for the month. The grant pays until its renewal runs, not only until
  // the term end; a subscription that does not renew at the boundary stops at the term end.
  const term = { kind: "per_cycle", unit: "credit", amount: 200 };
  const { c, sub } = await subscribe("term", term);
  const stopping = await subscribe("term-cancel", term);
  const stuck = await subscribe("term-stuck", term);
  const E = sub.currentPeriodEnd!;
  const after = (ms: number) => new Date(E.getTime() + ms);
  const drawnFrom = async (grantId: string) => {
    const [r] = rowsOf<{ units: string }>(
      await systemDb.execute(sql`
        select coalesce(-sum(units), 0)::text as units from credit_grant_movements
        where grant_id = ${grantId} and kind = 'draw'`),
    );
    return BigInt(r!.units);
  };
  const used = await send(new Date(T0.getTime() + DAY), c, "illustration");
  const [old] = await liveGrants(c.id);
  check(
    "the term grant of 20.0 ends at the term end and pays an event in the term",
    used.status === "created" &&
      old?.expiresAt?.getTime() === E.getTime() &&
      (await row(c.id)) === 190n,
    { used, expires: old?.expiresAt },
  );

  // One minute after the term end, before any renewal tick.
  check(
    "the live balance still offers the term grant's 19.0 after the term end",
    (await offered(c.id, after(MIN))) === 190n,
    await offered(c.id, after(MIN)),
  );
  const gap = await send(after(MIN), c, "illustration");
  const [waiting] = await liveGrants(c.id);
  check(
    "an event one minute after the term end, before the renewal, is paid by the ended term's grant",
    gap.status === "created" &&
      (await creditRows(gap.key!))[0]!.status === "taken" &&
      !waiting!.outOfBalance &&
      waiting!.status === "active" &&
      (await row(c.id)) === 180n,
    { gap, row: await row(c.id), out: waiting!.outOfBalance },
  );
  await inStep("between the term end and the renewal");

  // Cancel at the period end: the subscription does not renew, so the exact rule applies.
  await systemDb
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, stopping.sub.id));
  const stopped = await send(after(MIN), stopping.c, "illustration");
  const [ended] = await liveGrants(stopping.c.id);
  check(
    "with cancel at period end, the same event is refused: the grant stops at the term end",
    stopped.error?.code === "insufficient_credit" &&
      ended!.outOfBalance &&
      (await row(stopping.c.id)) === 0n,
    { stopped, row: await row(stopping.c.id), out: ended!.outOfBalance },
  );
  await give(stopping.c, 30, { effective_at: plus(-DAY) });
  const byOther = await send(after(MIN + SEC), stopping.c, "illustration");
  check(
    "with another grant, that customer's event is paid by it",
    byOther.status === "created" && (await row(stopping.c.id)) === 20n,
    byOther,
  );
  await inStep("after cancel at period end");

  // A renewal that has not run one hour after the term end: the grant stops paying.
  const inLimit = await send(after(59 * MIN), stuck.c, "illustration");
  const tooLate = await send(after(60 * MIN + SEC), stuck.c, "illustration");
  const [stale] = await liveGrants(stuck.c.id);
  check(
    "a renewal that is more than one hour late: the grant pays at 59 minutes and stops after 60",
    inLimit.status === "created" &&
      tooLate.error?.code === "insufficient_credit" &&
      stale!.outOfBalance &&
      (await row(stuck.c.id)) === 0n,
    { inLimit, tooLate, out: stale!.outOfBalance },
  );
  check(
    "the usage accepted before the limit was drawn from that grant when it left the row",
    (await drawnFrom(stale!.id)) === 10n &&
      (await creditRows(inLimit.key!))[0]!.status === "settled",
    await drawnFrom(stale!.id),
  );
  await inStep("after a renewal past the limit");

  // The renewal, as the billing clock runs it.
  const renewAt = after(2 * MIN);
  await at(renewAt, () => runBillingClockTickOnce(() => {}, renewAt));
  const [subNow] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
  const now = await liveGrants(c.id);
  const oldGrace = (
    await systemDb.select().from(creditGrantGrace).where(eq(creditGrantGrace.grantId, old!.id))
  )[0];
  check(
    "the billing clock renewed the term",
    subNow!.currentPeriodStart!.getTime() === E.getTime(),
    subNow!.currentPeriodStart,
  );
  check(
    "the renewal draws both events from the old grant (2.0), closes it into grace, grants the new term",
    now.length === 2 &&
      (await drawnFrom(old!.id)) === 20n &&
      (await creditRows(gap.key!))[0]!.status === "settled" &&
      oldGrace?.availableSteps === 180n &&
      oldGrace.validUntil.getTime() === E.getTime() &&
      now[1]!.effectiveAt.getTime() === E.getTime() &&
      (await row(c.id)) === 200n,
    { row: await row(c.id), oldGrace, drawn: await drawnFrom(old!.id) },
  );
  await inStep("after the renewal");
  const next = await send(after(3 * MIN), c, "illustration");
  const late = await send(after(4 * MIN), c, "illustration", { timestamp: after(-HOUR) });
  const lateRow = (await creditRows(late.key!))[0];
  check(
    "after the renewal the new term's grant pays; a late event is paid by the old grant's grace",
    next.status === "created" &&
      late.status === "created" &&
      lateRow?.graceGrantId === old!.id &&
      (await row(c.id)) === 190n,
    { next, late, lateRow },
  );
  await settle(after(2 * HOUR));
  check(
    "settlement draws the new term's event from the new grant, and nothing more from the old one",
    (await drawnFrom(now[1]!.id)) === 10n && (await drawnFrom(old!.id)) === 20n,
    { new: await drawnFrom(now[1]!.id), old: await drawnFrom(old!.id) },
  );
  await inStep("after usage on both sides of the renewal");
}

// ── 11. Time travel through the API ──────────────────────────────────────────────
console.log("11. time travel through the API");
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
    {
      id: "illustration",
      name: "Illustrations",
      event_name: "illustration",
      aggregation: "count",
    },
    tb,
  );
  await must(
    200,
    "PUT",
    "meters/illustration/credit_cost",
    {
      unit: "credit",
      credits_per_unit: "1",
    },
    tb,
  );
  const cus = (await must(
    201,
    "POST",
    "customers",
    {
      email: `travel-${Date.now()}@example.com`,
      auto_collection: "off",
    },
    tb,
  )) as { id: string };
  // The pack: 10 credits for 5.00, paid, expiring 36 hours after the start.
  const pack = (await must(
    201,
    "POST",
    `customers/${cus.id}/credit_grants`,
    {
      category: "paid",
      unit: "credit",
      amount: 10,
      price_minor: 500,
      tax_treatment: "taxed_at_purchase",
      mark_paid: { method: "bank_transfer" },
      expires_at: iso(36 * HOUR),
    },
    tb,
  )) as { id: string; effective_at: string };
  const [cusRow] = rowsOf<{ id: string }>(
    await systemDb.execute(sql`select id from customers where public_id = ${cus.id}`),
  );
  const [unitT] = await systemDb
    .select()
    .from(creditUnits)
    .where(and(eq(creditUnits.businessId, bizT.id), eq(creditUnits.key, "credit")));
  const rowT = () =>
    withTenant(orgId, (tx) => unitBalanceSteps(tx, { customerId: cusRow!.id, unitId: unitT!.id }));
  const sendEvent = (key: string, timestamp?: string) =>
    call(
      "POST",
      "usage_events",
      {
        key,
        customer: cus.id,
        event_name: "illustration",
        ...(timestamp ? { timestamp } : {}),
      },
      tb,
    );
  const stamp = Date.now();
  const u1 = await sendEvent(`tt-1-${stamp}`);
  const u2 = await sendEvent(`tt-2-${stamp}`);
  const u3 = await sendEvent(`tt-3-${stamp}`);
  check(
    "the pack starts at the simulated time and 3 events spend 3 of its 10 credits",
    pack.effective_at === G.toISOString() &&
      [u1, u2, u3].every((r) => r.statusCode === 201) &&
      (await rowT()) === 7n,
    { effective: pack.effective_at, statuses: [u1, u2, u3].map((r) => r.statusCode) },
  );
  const settlementsT = () =>
    systemDb
      .select()
      .from(creditUsageSettlements)
      .where(eq(creditUsageSettlements.customerId, cusRow!.id));
  await must(200, "POST", "time_travel/advance", { to_time: iso(2 * HOUR) }, tb);
  const s1 = await settlementsT();
  check(
    "travel past the top of the hour settles the usage: 3 credits drawn, revenue 1.50",
    s1.length === 1 && s1[0]!.unitsDrawn === 3n && s1[0]!.revenueMinor === 150n,
    s1,
  );
  // One hour past the expiry: the clock closed the pack into its grace window.
  await must(200, "POST", "time_travel/advance", { to_time: iso(37 * HOUR) }, tb);
  const [packRow] = await systemDb
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.publicId, pack.id));
  const graceT = async () =>
    (
      await systemDb
        .select()
        .from(creditGrantGrace)
        .where(eq(creditGrantGrace.grantId, packRow!.id))
    )[0];
  check(
    "travel past the expiry: the pack is closed, 7 credits wait in its grace row, the row is 0",
    (await graceT())?.availableSteps === 7n &&
      (await graceT())?.lockedAt === null &&
      (await rowT()) === 0n,
    { grace: await graceT(), row: await rowT() },
  );
  const fresh = await sendEvent(`tt-fresh-${stamp}`);
  check(
    "a fresh event after the expiry is refused (402)",
    fresh.statusCode === 402 && /insufficient_credit/.test(fresh.body),
    fresh.body,
  );
  const late = await sendEvent(`tt-late-${stamp}`, iso(35 * HOUR));
  check(
    "a late event dated inside the pack's life is accepted and paid by the pack",
    late.statusCode === 201 && (await graceT())?.availableSteps === 6n,
    late.body,
  );
  // Past the grace window (expiry + 12 h): the late event is drawn, the rest is breakage.
  await must(200, "POST", "time_travel/advance", { to_time: iso(50 * HOUR) }, tb);
  const [packEnd] = await systemDb
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.id, packRow!.id));
  const s2 = await settlementsT();
  const led = await ledger(cusRow!.id);
  check(
    "travel past the grace window: the late event is drawn (0.50), 6 credits lapse (3.00), the pack is expired",
    packEnd?.status === "expired" &&
      (await graceT())?.lockedAt !== null &&
      s2.length === 2 &&
      s2.some((s) => s.kind === "late" && s.unitsDrawn === 1n && s.revenueMinor === 50n) &&
      -(led[A.breakage] ?? 0n) === 300n &&
      (led[A.paid] ?? 0n) === 0n &&
      (await rowT()) === 0n,
    { status: packEnd?.status, s2, led },
  );
  await inStep("after the time travel");
}

await app.close();
await closeDb();
if (fails.length) {
  console.error(`\n❌ CREDITS-GATE: ${fails.length} failed`);
  for (const f of fails) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("\n✅ CREDITS-GATE: PASS");
process.exit(0);
