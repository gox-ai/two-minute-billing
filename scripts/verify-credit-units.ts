/**
 * Credit units with no money rate, their grants and the real-time balance row:
 *  - the unit API: create and update without a rate, the lock, a unit with a rate unchanged;
 *  - a given grant posts nothing to the ledger; a paid one posts at its cost basis only
 *    (pending → paid at activation, breakage at expiry);
 *  - `credit_unit_balances` = Σ what is left on the grants, after create, void, expire, a pack,
 *    a manual paid grant, plan credits per term (with rollover) and per reset window;
 *  - an idempotent replay grants once; another organization sees no row;
 *  - a unit with a rate gets no balance row and keeps its postings.
 *
 *   pnpm verify:all:fresh -- --suite credit-units
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { runWithClockScope } from "@/platform/clock";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct, updatePrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createManualInvoice, recordOfflinePayment } from "@/modules/invoicing/ops";
import { grantRemaining, unitBalanceSteps } from "@/modules/credits/service";
import { applyPlanCredits } from "@/modules/credits/plan-credits";
import { runPlanCreditResets } from "@/modules/credits/credit-clock";
import { runExpireCreditGrants } from "@/modules/credits/expiry";
import { liveBalance } from "@/modules/credits/balance";
import { AutoTopupError, putAutoTopup } from "@/modules/usage-controls/auto-topup";
import {
  businesses,
  CREDIT_LEDGER_ACCOUNTS as A,
  creditGrantMovements,
  creditGrants,
  creditUnitBalances,
  creditUnits,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import { checker, meterBusiness, newCustomer } from "./lib/meter-fixtures";

const { fails, check } = checker();
const DAY = 86_400_000;
const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);

const { org, orgId, biz, ids, product } = await meterBusiness("Credit Units Org");
const app = await buildApp({ logger: false });
const at = <T>(t: Date, fn: () => Promise<T>) =>
  runWithClockScope({ onlyBusinessId: biz.id, now: t }, fn);

let keyN = 0;
const call = (
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: object,
  o: { key?: string; secret?: string; biz?: string } = {},
) =>
  app.inject({
    method,
    url: `/v1/businesses/${o.biz ?? biz.publicId}/${path}`,
    headers: {
      authorization: `Bearer ${o.secret ?? org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": o.key ?? `cu-${Date.now()}-${++keyN}` }),
    },
    ...(payload ? { payload } : {}),
  });

/** Ledger rows of one customer: Σ (debit − credit) per account, and the row count. */
async function ledger(customerId: string) {
  const rows = (await systemDb.execute(sql`
    select account, count(*)::int as n,
      sum(case when direction = 'debit' then amount_minor else -amount_minor end)::text as net
    from ledger_entries where customer_id = ${customerId} group by account`)) as unknown as Array<{
    account: string;
    n: number;
    net: string;
  }>;
  return {
    rows: rows.reduce((s, r) => s + r.n, 0),
    net: Object.fromEntries(rows.map((r) => [r.account, BigInt(r.net)])) as Record<string, bigint>,
  };
}
/** Every ledger transaction of the organization nets to 0. */
async function unbalanced(): Promise<number> {
  const rows = (await systemDb.execute(sql`
    select transaction_id from ledger_entries where organization_id = ${orgId}
    group by transaction_id
    having sum(case when direction = 'debit' then amount_minor else -amount_minor end) <> 0`)) as unknown as unknown[];
  return rows.length;
}
/** Rows where the balance and Σ movements of the grants differ, in both directions. */
async function drift(): Promise<unknown[]> {
  return (await systemDb.execute(sql`
    select k.customer_id, k.unit_id, coalesce(bal.available_steps, 0)::text as balance,
      coalesce(g.steps, 0)::text as grants
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
    where coalesce(bal.available_steps, 0) <> coalesce(g.steps, 0)`)) as unknown as unknown[];
}
const inStep = async (label: string) => {
  const d = await drift();
  check(`${label}: the balance row equals what the grants hold`, d.length === 0, d);
  check(`${label}: every ledger transaction balances`, (await unbalanced()) === 0);
};
const customer = (tag: string) =>
  createCustomer({ ...ids, email: `${tag}-${Date.now()}@example.com`, autoCollection: "off" });

// ── 1. The unit API ──────────────────────────────────────────────────────────────
console.log("1. a unit with no rate, through the API");
const made = await call("POST", "credit_units", {
  id: "credit",
  name: "credit",
  plural_name: "credits",
  currency: "USD",
  minor_per_unit: null,
  decimals: 1,
});
const unitBody = JSON.parse(made.body);
const noField = await call("POST", "credit_units", {
  id: "forgot",
  name: "forgot",
  currency: "USD",
});
check(
  "POST without minor_per_unit is refused (400), and the message says what to send",
  noField.statusCode === 400 &&
    /Send minor_per_unit: a rate, or null/.test(JSON.parse(noField.body).error?.message ?? ""),
  noField.body,
);
check(
  "POST with minor_per_unit: null creates a unit with no rate",
  made.statusCode === 201 && unitBody.rated === false && unitBody.minor_per_unit === null,
  made.body,
);
const [unit] = await systemDb
  .select()
  .from(creditUnits)
  .where(and(eq(creditUnits.businessId, biz.id), eq(creditUnits.key, "credit")));
check("the stored rate is NULL", unit?.minorPerUnitE12 === null, unit?.minorPerUnitE12);
const unitId = unit!.id;

const viaNull = await call("POST", "credit_units", {
  id: "point",
  name: "point",
  currency: "USD",
  minor_per_unit: null,
});
check(
  "minor_per_unit: null also means no rate",
  viaNull.statusCode === 201 && JSON.parse(viaNull.body).rated === false,
  viaNull.body,
);
const addRate = await call("PATCH", "credit_units/point", { minor_per_unit: "25" });
check(
  "before the first grant, PATCH gives the unit a rate",
  addRate.statusCode === 200 &&
    JSON.parse(addRate.body).rated === true &&
    JSON.parse(addRate.body).minor_per_unit === "25",
  addRate.body,
);
const dropRate = await call("PATCH", "credit_units/point", { minor_per_unit: null });
check(
  "and PATCH with null removes it again",
  dropRate.statusCode === 200 && JSON.parse(dropRate.body).rated === false,
  dropRate.body,
);
const zeroRate = await call("POST", "credit_units", {
  id: "zero",
  name: "zero",
  currency: "USD",
  minor_per_unit: "0",
});
check("a rate of 0 is still refused (400)", zeroRate.statusCode === 400, zeroRate.body);

const rated = await call("POST", "credit_units", {
  id: "token",
  name: "token",
  currency: "USD",
  minor_per_unit: "60",
  decimals: 1,
});
check(
  "a unit with a rate reads as before, plus rated: true",
  rated.statusCode === 201 &&
    JSON.parse(rated.body).minor_per_unit === "60" &&
    JSON.parse(rated.body).rated === true,
  rated.body,
);

// ── 2. A given grant: no ledger posting, the balance row ─────────────────────────
console.log("2. a given grant");
const c1 = await customer("given");
const l0 = await ledger(c1.id);
const giveKey = `give-${Date.now()}`;
const give = (key: string, amount = 150) =>
  call("POST", `customers/${c1.publicId}/credit_grants`, { unit: "credit", amount }, { key });
const g1 = await give(giveKey);
const g1b = JSON.parse(g1.body);
check(
  "a given grant in the unit is created with no money value",
  g1.statusCode === 201 &&
    g1b.face_minor === 0 &&
    g1b.cost_basis_minor === 0 &&
    g1b.amount_decimal === "15" &&
    g1b.remaining.units === 150,
  g1.body,
);
const l1 = await ledger(c1.id);
check("it posts nothing to the ledger", l1.rows === l0.rows, { before: l0, after: l1 });
const row = (customerId: string, unit = unitId) =>
  withTenant(orgId, (tx) => unitBalanceSteps(tx, { customerId, unitId: unit }));
check("the balance row holds the 15.0 credits", (await row(c1.id)) === 150n, await row(c1.id));
const [g1row] = await systemDb.select().from(creditGrants).where(eq(creditGrants.publicId, g1b.id));
check(
  "the grant row is marked as a unit with no rate, face 0",
  g1row?.unitRated === false && g1row.faceMinor === 0n,
  g1row,
);

const replay = await give(giveKey);
const grantCount = async (customerId: string) =>
  (await systemDb.select().from(creditGrants).where(eq(creditGrants.customerId, customerId)))
    .length;
check(
  "a replayed Idempotency-Key returns the same grant and moves the balance once",
  replay.statusCode === 201 &&
    JSON.parse(replay.body).id === g1b.id &&
    (await grantCount(c1.id)) === 1 &&
    (await row(c1.id)) === 150n,
  { body: replay.body, row: await row(c1.id) },
);
const locked = await call("PATCH", "credit_units/credit", { minor_per_unit: "60" });
check("after the first grant the unit cannot take a rate (409)", locked.statusCode === 409);
const rename = await call("PATCH", "credit_units/credit", { plural_name: "credits" });
check("its name can still change", rename.statusCode === 200, rename.body);

// The money limit on a free grant is on its money value; this credit has none.
await systemDb
  .update(businesses)
  .set({ creditConfig: { grant_limits: { USD: { max_minor: 1 } } } })
  .where(eq(businesses.id, biz.id));
const overLimit = await give(`${giveKey}-2`, 50);
check(
  "the money limit on free grants does not refuse it",
  overLimit.statusCode === 201 && (await row(c1.id)) === 200n,
  overLimit.body,
);
await systemDb.update(businesses).set({ creditConfig: null }).where(eq(businesses.id, biz.id));
await inStep("after create");

// The portal lists the grants by units and marks the unit as one with no money value.
{
  const { createPortalSession } = await import("@/modules/customer-portal/service");
  const link = await createPortalSession({ ...ids, customerId: c1.id });
  const sess = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${link.accessToken}` },
  });
  const res = await app.inject({
    method: "GET",
    url: "/portal/v1/credits",
    headers: { authorization: `Bearer ${JSON.parse(sess.body).token}` },
  });
  const body = res.statusCode === 200 ? JSON.parse(res.body) : { grants: [], balances: [] };
  const listed = (
    body.grants as { unit: string; unit_rated: boolean; remaining_amount: number }[]
  ).filter((g) => g.unit === "credit");
  const unitBal = (
    body.balances as { units: { unit: string; rated: boolean; available_amount: number }[] }[]
  )
    .flatMap((b) => b.units)
    .find((u) => u.unit === "credit");
  check(
    "the portal lists the grants of a unit with no rate, by units, and marks the unit",
    listed.length === 2 &&
      listed.reduce((n, g) => n + g.remaining_amount, 0) === 200 &&
      listed.every((g) => g.unit_rated === false) &&
      unitBal?.rated === false &&
      unitBal.available_amount === 200,
    res.body,
  );
  // The history explains the balance: each movement in units, with no money amount.
  const hist = (
    body.transactions as {
      unit: string | null;
      unit_rated: boolean;
      units: number;
      face_minor: number;
      unit_plural_name: string;
      decimals: number;
    }[]
  ).filter((t) => t.unit === "credit");
  check(
    "the portal history lists the movements of a unit with no rate, in units, face 0",
    hist.length === 2 &&
      hist.every(
        (t) =>
          t.unit_rated === false &&
          t.face_minor === 0 &&
          t.unit_plural_name === "credits" &&
          t.decimals === 1,
      ) &&
      hist.reduce((n, t) => n + t.units, 0) === 200,
    body.transactions,
  );
}

const bal = await withTenant(orgId, (tx) =>
  liveBalance(tx, {
    customerId: c1.id,
    currency: "USD",
    now: new Date(),
    businessConfig: null,
    customerSettings: null,
  }),
);
check(
  "the money balance does not count it; the unit balance does",
  bal.grantsMinor === 0n &&
    bal.availableMinor === 0n &&
    bal.availableUnits.find((u) => u.unit === "credit")?.units === 200n,
  { money: bal.grantsMinor, units: bal.availableUnits },
);

// ── 3. Void and expire ───────────────────────────────────────────────────────────
console.log("3. void and expire");
const voided = await call(
  "POST",
  `customers/${c1.publicId}/credit_grants/${JSON.parse(overLimit.body).id}/void`,
);
check(
  "a void takes the grant's units off the balance, with no posting",
  voided.statusCode === 200 &&
    JSON.parse(voided.body).status === "voided" &&
    (await row(c1.id)) === 150n &&
    (await ledger(c1.id)).rows === l0.rows,
  { body: voided.body, row: await row(c1.id) },
);
await inStep("after void");

// Lapsed at T0: the expiry pass books it out.
const lapsing = await call("POST", `customers/${c1.publicId}/credit_grants`, {
  unit: "credit",
  amount: 30,
  effective_at: plus(-2 * DAY).toISOString(),
  expires_at: plus(-DAY).toISOString(),
});
check(
  "a grant counts while it is active",
  lapsing.statusCode === 201 && (await row(c1.id)) === 180n,
);
await at(T0, () => runExpireCreditGrants(T0));
const [lapsed] = await systemDb
  .select()
  .from(creditGrants)
  .where(eq(creditGrants.publicId, JSON.parse(lapsing.body).id));
check(
  "the expiry pass takes it off the balance, with no posting",
  lapsed?.status === "expired" &&
    (await row(c1.id)) === 150n &&
    (await ledger(c1.id)).rows === l0.rows,
  { status: lapsed?.status, row: await row(c1.id) },
);
await inStep("after expire");

// ── 4. Paid credit: a pack ───────────────────────────────────────────────────────
console.log("4. a pack");
const packProduct = await createProduct({ ...ids, name: "Credit packs", kind: "charge" });
// 15.0 credits for 9.00, good for 30 days.
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
const c2 = await customer("pack");
const sale = await createManualInvoice({
  ...ids,
  customerId: c2.id,
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
});
const packGrant = async () =>
  (
    await systemDb.select().from(creditGrants).where(eq(creditGrants.invoiceId, sale.invoice.id))
  )[0];
const pending = await packGrant();
const lp = await ledger(c2.id);
check(
  "the sale holds a pending grant: 15.0 credits, cost basis 900, face 0",
  pending?.status === "pending" &&
    pending.amount === 150n &&
    pending.costBasisMinor === 900n &&
    pending.faceMinor === 0n &&
    pending.unitRated === false,
  pending,
);
check(
  "the sale defers the cost: Cr credit_grants_pending 900",
  -(lp.net[A.pending] ?? 0n) === 900n,
  lp.net,
);
check("a pending grant is not in the balance", (await row(c2.id)) === 0n, await row(c2.id));
await recordOfflinePayment({ ...ids, invoicePublicId: sale.invoice.publicId, method: "wire" });
const active = await packGrant();
const la = await ledger(c2.id);
check(
  "the payment activates it: pending closes, credit_grants_paid holds 900",
  active?.status === "active" &&
    (la.net[A.pending] ?? 0n) === 0n &&
    -(la.net[A.paid] ?? 0n) === 900n,
  { status: active?.status, net: la.net },
);
check(
  "no discount, promotional or breakage account is touched",
  la.net[A.discount] === undefined &&
    la.net[A.promotional] === undefined &&
    la.net[A.breakage] === undefined,
  la.net,
);
check("the balance row holds the pack", (await row(c2.id)) === 150n, await row(c2.id));
const left = (await withTenant(orgId, (tx) => grantRemaining(tx, [active!.id]))).get(active!.id)!;
check(
  "what is left: 150 steps, face 0, cost 900 (= credit_grants_paid)",
  left.units === 150n && left.face === 0n && left.cost === 900n,
  left,
);
await inStep("after a pack");

const paidApi = await call("POST", `customers/${c2.publicId}/credit_grants`, {
  category: "paid",
  unit: "credit",
  amount: 100,
  price_minor: 500,
  tax_treatment: "taxed_at_purchase",
  mark_paid: { method: "bank_transfer" },
});
const paidBody = JSON.parse(paidApi.body);
check(
  "a paid manual grant: the price is the cost basis, active at once",
  paidApi.statusCode === 201 &&
    paidBody.status === "active" &&
    paidBody.cost_basis_minor === 500 &&
    paidBody.face_minor === 0 &&
    (await row(c2.id)) === 250n &&
    -((await ledger(c2.id)).net[A.paid] ?? 0n) === 1400n,
  { body: paidApi.body, row: await row(c2.id) },
);
await inStep("after a paid manual grant");

// The pack lapses 30 days after it was paid.
const later = new Date(active!.effectiveAt.getTime() + 31 * DAY);
await at(later, () => runExpireCreditGrants(later));
const gone = await packGrant();
const lb = await ledger(c2.id);
check(
  "the unused pack expires into breakage at its cost",
  gone?.status === "expired" &&
    -(lb.net[A.breakage] ?? 0n) === 900n &&
    -(lb.net[A.paid] ?? 0n) === 500n,
  { status: gone?.status, net: lb.net },
);
check("and leaves the balance", (await row(c2.id)) === 100n, await row(c2.id));
await inStep("after a pack expires");

// ── 5. Plan credits per term ─────────────────────────────────────────────────────
console.log("5. plan credits per term");
const P = [1, 2, 3, 4].map((m) => new Date(Date.UTC(2030, m - 1, 1)));
async function planCustomer(tag: string, gc: Record<string, unknown>) {
  const price = await createPrice({
    ...ids,
    productId: product.id,
    id: `plan-${tag}-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 3900,
    interval: "month",
  });
  const c = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  // Set after the signup, so only the periods below grant.
  await updatePrice({ ...ids, pricePublicId: price.publicId, grantsCredit: gc });
  // At the period start, as the renewal runs: a grant is in the balance row from its start.
  const renew = (i: number) =>
    at(P[i]!, () =>
      withTenant(orgId, (tx) =>
        applyPlanCredits(tx, {
          ...ids,
          subscription: { id: sub.subscription.id, customerId: c.id, currency: "USD" },
          periodStart: P[i]!,
          periodEnd: P[i + 1]!,
        }),
      ),
    );
  return { c, renew };
}
const basic = await planCustomer("basic", { kind: "per_cycle", unit: "credit", amount: 750 });
const lplan0 = await ledger(basic.c.id);
await basic.renew(0);
check(
  "the plan grants 75.0 credits: the balance row holds them",
  (await row(basic.c.id)) === 750n,
  await row(basic.c.id),
);
check(
  "given plan credit posts nothing",
  (await ledger(basic.c.id)).rows === lplan0.rows,
  await ledger(basic.c.id),
);
const again = await basic.renew(0);
check(
  "a re-run of the period grants once",
  again.granted === 0 && (await row(basic.c.id)) === 750n,
  again,
);
await basic.renew(1);
check(
  "the next term replaces the lot: still 75.0",
  (await row(basic.c.id)) === 750n,
  await row(basic.c.id),
);
await inStep("after a term renewal");

const carry = await planCustomer("carry", {
  kind: "per_cycle",
  unit: "credit",
  amount: 750,
  rollover: { mode: "carry", percent: 50 },
});
await carry.renew(0);
const rolled = await carry.renew(1);
check(
  "a rollover carries units with no money: 75.0 new + 37.5 carried",
  rolled.rolled === 1 && (await row(carry.c.id)) === 1125n,
  { rolled, row: await row(carry.c.id) },
);
check("and posts nothing", (await ledger(carry.c.id)).net[A.promotional] === undefined);
await inStep("after a rollover");

// ── 6. Plan credits on a reset window ────────────────────────────────────────────
console.log("6. reset windows");
const dailyPrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `plan-daily-${Date.now()}`,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 12000,
  interval: "year",
  grantsCredit: {
    kind: "per_cycle",
    unit: "credit",
    amount: 250,
    reset: { every: "day" },
    rollover: { mode: "carry", percent: 100 },
  },
});
const cw = await newCustomer(ids, "daily");
const subW = await at(T0, () =>
  createSubscription({
    ...ids,
    customerId: cw.id,
    now: T0,
    items: [{ price: dailyPrice, quantity: 1 }],
  }),
);
const [subRow] = await systemDb
  .select()
  .from(subscriptions)
  .where(eq(subscriptions.id, subW.subscription.id));
await at(T0, () =>
  billSubscriptionPeriod({
    ...ids,
    subscription: subRow!,
    periodStart: subRow!.currentPeriodStart!,
    periodEnd: subRow!.currentPeriodEnd!,
  }),
);
const [itemW] = await systemDb
  .select()
  .from(subscriptionItems)
  .where(eq(subscriptionItems.subscriptionId, subW.subscription.id));
const windowGrants = async () =>
  (
    await systemDb.select().from(creditGrants).where(eq(creditGrants.subscriptionItemId, itemW!.id))
  ).filter((g) => g.status === "active");
check(
  "the first window grants 25.0 credits",
  (await row(cw.id)) === 250n && (await windowGrants()).length === 1,
  { row: await row(cw.id), grants: (await windowGrants()).length },
);
await inStep("after the first window");
const day2 = plus(DAY + 3_600_000);
await at(day2, () => runPlanCreditResets(day2));
await at(day2, () => runExpireCreditGrants(day2));
check(
  "the next window: 25.0 new + 25.0 carried, the closed window booked out",
  (await row(cw.id)) === 500n,
  { row: await row(cw.id), grants: await windowGrants() },
);
const outs = await systemDb
  .select()
  .from(creditGrantMovements)
  .where(
    and(eq(creditGrantMovements.customerId, cw.id), eq(creditGrantMovements.kind, "rollover_out")),
  );
check(
  "the carry is a movement in units only",
  outs.length === 1 && outs[0]!.units === -250n && outs[0]!.faceMinor === 0n,
  outs,
);
check(
  "window credits post nothing",
  (await ledger(cw.id)).net[A.promotional] === undefined &&
    (await ledger(cw.id)).net.promotional_credit === undefined,
);
await inStep("after a reset window");

// ── 7. Isolation between organizations ───────────────────────────────────────────
console.log("7. isolation");
const other = await createOrganization({ name: "Credit Units Other Org" });
const otherBiz = await createBusiness({
  organizationId: other.organization.id,
  name: "Other",
  defaultCurrency: "USD",
  livemode: "test",
});
const mine = await withTenant(orgId, (tx) => tx.select().from(creditUnitBalances));
const theirs = await withTenant(other.organization.id, (tx) =>
  tx.select().from(creditUnitBalances),
);
check(
  "RLS: the other organization reads none of these balance rows",
  mine.length > 0 && theirs.length === 0,
  { mine: mine.length, theirs: theirs.length },
);
const crossWrite = await withTenant(other.organization.id, (tx) =>
  tx
    .insert(creditUnitBalances)
    .values({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c1.id,
      unitId,
      availableSteps: 1n,
    })
    .onConflictDoNothing(),
).catch((e) => e);
check("RLS: it cannot write a row for this organization", crossWrite instanceof Error);
const crossRead = await call("GET", "credit_units/credit", undefined, {
  secret: other.secret,
  biz: otherBiz.publicId,
});
check("the unit is not in the other organization's business (404)", crossRead.statusCode === 404);
const crossGrant = await call(
  "POST",
  `customers/${c1.publicId}/credit_grants`,
  { unit: "credit", amount: 10 },
  { secret: other.secret },
);
check(
  "the other organization's key cannot grant here",
  crossGrant.statusCode >= 400 && (await row(c1.id)) === 150n,
  crossGrant.statusCode,
);

// ── 8. A unit with a rate is untouched ───────────────────────────────────────────
console.log("8. a unit with a rate");
const c3 = await customer("rated");
const tokenGrant = await call("POST", `customers/${c3.publicId}/credit_grants`, {
  unit: "token",
  amount: 150,
});
const tb = JSON.parse(tokenGrant.body);
const lt = await ledger(c3.id);
check(
  "a given grant in it keeps its face and its promotional posting",
  tokenGrant.statusCode === 201 &&
    tb.face_minor === 900 &&
    -(lt.net[A.promotional] ?? 0n) === 900n &&
    lt.net.promotional_credit === 900n,
  { body: tokenGrant.body, net: lt.net },
);
const [tokenRow] = await systemDb
  .select()
  .from(creditGrants)
  .where(eq(creditGrants.publicId, tb.id));
const ratedRows = await systemDb
  .select()
  .from(creditUnitBalances)
  .where(eq(creditUnitBalances.customerId, c3.id));
check(
  "it is marked as rated and gets no balance row",
  tokenRow?.unitRated === true && ratedRows.length === 0,
  { rated: tokenRow?.unitRated, rows: ratedRows.length },
);
{
  const { createPortalSession } = await import("@/modules/customer-portal/service");
  const link = await createPortalSession({ ...ids, customerId: c3.id });
  const sess = await app.inject({
    method: "POST",
    url: "/portal/v1/session",
    headers: { authorization: `Bearer ${link.accessToken}` },
  });
  const res = await app.inject({
    method: "GET",
    url: "/portal/v1/credits",
    headers: { authorization: `Bearer ${JSON.parse(sess.body).token}` },
  });
  const t = res.statusCode === 200 ? JSON.parse(res.body).transactions : [];
  check(
    "its portal history line keeps its money amount, plus the unit fields",
    t.length === 1 &&
      t[0].face_minor === 900 &&
      t[0].currency === "USD" &&
      t[0].unit === "token" &&
      t[0].unit_rated === true &&
      t[0].units === 150,
    res.body,
  );
}
const voidToken = await call("POST", `customers/${c3.publicId}/credit_grants/${tb.id}/void`);
check(
  "its void reverses the promotional posting, as before",
  voidToken.statusCode === 200 && ((await ledger(c3.id)).net[A.promotional] ?? 0n) === 0n,
  voidToken.body,
);

// ── 9. Guards ────────────────────────────────────────────────────────────────────
console.log("9. guards");
const raw = (unitRated: boolean, face: number) =>
  systemDb
    .execute(
      sql`insert into credit_grants (organization_id, business_id, public_id, customer_id, currency,
        unit_id, amount, face_minor, unit_rated, category, source)
      values (${orgId}, ${biz.id}, ${`cgr_guard_${face}_${unitRated}`}, ${c1.id}, 'USD', ${unitId},
        10, ${face}, ${unitRated}, 'promotional', 'manual')`,
    )
    .then(
      () => "inserted",
      (e) => String((e as { cause?: { constraint_name?: string } }).cause?.constraint_name ?? e),
    );
check(
  "CHECK: a grant in a unit with no rate cannot carry a face value",
  /credit_grants_face_rated_ck/.test(await raw(false, 5)),
);
check(
  "CHECK: a grant in a unit with a rate cannot have face 0",
  /credit_grants_face_rated_ck/.test(await raw(true, 0)),
);
const topup = await putAutoTopup({
  ...ids,
  customerPublicId: c1.publicId,
  config: {
    unitKey: "credit",
    trigger: "threshold",
    thresholdMinor: 100n,
    method: "fixed",
    amountMinor: 900n,
    monthlyCapMinor: 5000n,
    grant: { tax_treatment: "taxed_at_purchase" },
  },
}).catch((e) => e);
check(
  "an automatic top-up for a unit with no rate is refused",
  topup instanceof AutoTopupError && /has no rate/.test(topup.message),
  String(topup),
);
await inStep("at the end");

await app.close();
await closeDb();
if (fails.length) {
  console.log(`\n❌ CREDIT-UNITS: FAIL (${fails.length})`);
  process.exit(1);
}
console.log("\n✅ CREDIT-UNITS: PASS");
process.exit(0);
