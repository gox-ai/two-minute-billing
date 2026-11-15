/**
 * Credit settings for usage past the credits, and the credit reports (steps 6 and 7, read and
 * store only; the gate does not read the settings yet):
 *  - a unit's overage price, overdraft limit and negative balance at a plan reset: stored,
 *    returned, refused on a unit with a rate; a unit with no row reads the defaults;
 *  - the overdraft limit in three layers: customer → plan → unit → 0;
 *  - void reasons on a grant;
 *  - the full refund of a partly used credit pack, and its refusal while other credit is left;
 *  - the deferred revenue roll-forward reconciles to the ledger, month by month;
 *  - one grant's activity, runway in units, refused demand;
 *  - another organization sees none of it.
 *
 *   pnpm verify:all:fresh -- --suite credit-settings-reports
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { runWithClockScope } from "@/platform/clock";
import { createBusiness, createOrganization } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { createManualInvoice, recordOfflinePayment } from "@/modules/invoicing/ops";
import { ingestUsageEvents } from "@/modules/metering/ingest";
import { runSettleCreditUsage } from "@/modules/credits/usage-settlement";
import { resolveOverdraftLimit } from "@/modules/credits/overdraft";
import {
  auditLogs,
  creditGrantVoidReasons,
  creditOverdraftLimits,
  creditUnitPolicies,
  creditUnits,
  invoiceLineItems,
} from "@db/schema";
import { checker, meterBusiness } from "./lib/meter-fixtures";

const { fails, check } = checker();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const B = new Date(Math.floor(Date.now() / HOUR) * HOUR);
const plus = (ms: number) => new Date(B.getTime() + ms);

const { org, orgId, biz, ids, product } = await meterBusiness("Credit Settings Reports Org");
const app = await buildApp({ logger: false });
const at = <T>(t: Date, fn: () => Promise<T>) =>
  runWithClockScope({ onlyBusinessId: biz.id, now: t }, fn);

let keyN = 0;
const call = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  payload?: object,
  o: { secret?: string; biz?: string } = {},
) =>
  app.inject({
    method,
    url: `/v1/businesses/${o.biz ?? biz.publicId}/${path}`,
    headers: {
      authorization: `Bearer ${o.secret ?? org.secret}`,
      ...(method === "GET" ? {} : { "idempotency-key": `csr-${Date.now()}-${++keyN}` }),
    },
    ...(payload ? { payload } : {}),
  });
const body = <T = Record<string, unknown>>(r: { body: string }) => JSON.parse(r.body) as T;
const customer = (tag: string) =>
  createCustomer({ ...ids, email: `${tag}-${Date.now()}@example.com`, autoCollection: "off" });
let evN = 0;
const send = (t: Date, c: { publicId: string }, eventName: string) =>
  at(t, () =>
    ingestUsageEvents({
      ...ids,
      events: [
        { key: `csr-ev-${Date.now()}-${++evN}`, customer: c.publicId, event_name: eventName },
      ],
    }),
  );
async function ledgerNet(customerId: string, account: string): Promise<bigint> {
  const [r] = (await systemDb.execute(sql`
    select coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::text as net
    from ledger_entries where customer_id = ${customerId} and account = ${account}`)) as unknown as Array<{
    net: string;
  }>;
  return BigInt(r!.net);
}

// ── 1. Unit policies ─────────────────────────────────────────────────────────
console.log("1. unit policies");
const made = await call("POST", "credit_units", {
  id: "credit",
  name: "credit",
  plural_name: "credits",
  currency: "USD",
  minor_per_unit: null,
  decimals: 1,
  overage_minor_per_unit: "4.5",
  overdraft_limit: 20,
  negative_balance_at_reset: "forgive",
});
const u1 = body(made);
check(
  "a unit with no rate takes an overage price, an overdraft limit and forgive",
  made.statusCode === 201 &&
    u1.overage_minor_per_unit === "4.5" &&
    u1.overdraft_limit === 20 &&
    u1.overdraft_limit_decimal === "2" &&
    u1.negative_balance_at_reset === "forgive",
  u1,
);
const plain = body(
  await call("POST", "credit_units", {
    id: "plain",
    name: "plain",
    currency: "USD",
    minor_per_unit: null,
  }),
);
check(
  "unset = today: no overage price, overdraft 0, carry, and no policy row",
  plain.overage_minor_per_unit === null &&
    plain.overdraft_limit === 0 &&
    plain.negative_balance_at_reset === "carry" &&
    (
      await systemDb
        .select()
        .from(creditUnitPolicies)
        .innerJoin(creditUnits, eq(creditUnits.id, creditUnitPolicies.unitId))
        .where(and(eq(creditUnits.businessId, biz.id), eq(creditUnits.key, "plain")))
    ).length === 0,
  plain,
);
const ratedOverage = await call("POST", "credit_units", {
  id: "token",
  name: "token",
  currency: "USD",
  minor_per_unit: "60",
  overage_minor_per_unit: "1",
});
check(
  "a unit with a rate refuses an overage price (400) and is not created",
  ratedOverage.statusCode === 400 && (await call("GET", "credit_units/token")).statusCode === 404,
  ratedOverage.body,
);
await call("POST", "credit_units", {
  id: "token",
  name: "token",
  currency: "USD",
  minor_per_unit: "60",
});
const ratedDraft = await call("PATCH", "credit_units/token", { overdraft_limit: 5 });
check(
  "a unit with a rate refuses an overdraft limit in units (400)",
  ratedDraft.statusCode === 400,
);
const toRated = await call("PATCH", "credit_units/credit", { minor_per_unit: "60" });
check(
  "a unit with an overage price cannot take a rate (400)",
  toRated.statusCode === 400 &&
    body(await call("GET", "credit_units/credit")).minor_per_unit === null,
  toRated.body,
);
const patched = body(
  await call("PATCH", "credit_units/credit", {
    overage_minor_per_unit: null,
    negative_balance_at_reset: "carry",
  }),
);
const listed = body<{ data: Array<Record<string, unknown>> }>(await call("GET", "credit_units"));
check(
  "PATCH clears the overage price and keeps the overdraft limit; the list shows the fields",
  patched.overage_minor_per_unit === null &&
    patched.overdraft_limit === 20 &&
    patched.negative_balance_at_reset === "carry" &&
    listed.data.find((u) => u.id === "credit")?.overdraft_limit === 20,
  patched,
);
await call("PATCH", "credit_units/credit", { overage_minor_per_unit: "4.5" });
const [unitRow] = await systemDb
  .select()
  .from(creditUnits)
  .where(and(eq(creditUnits.businessId, biz.id), eq(creditUnits.key, "credit")));
const unitId = unitRow!.id;

// ── 2. Overdraft limit in three layers ───────────────────────────────────────
console.log("2. overdraft limit in three layers");
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
const addon = await createProduct({ ...ids, name: "Packs", kind: "charge" });
const notPlan = await call("PUT", `credit_units/credit/overdraft_limits/plans/${addon.publicId}`, {
  overdraft_limit: 5,
});
check("a product that is not a plan is refused (400)", notPlan.statusCode === 400, notPlan.body);
const planSet = await call(
  "PUT",
  `credit_units/credit/overdraft_limits/plans/${product.publicId}`,
  { overdraft_limit: 50 },
);
check(
  "a plan's limit is set",
  planSet.statusCode === 200 &&
    body(planSet).level === "plan" &&
    body(planSet).overdraft_limit === 50,
  planSet.body,
);
const subscriber = await customer("subscriber");
await createSubscription({
  ...ids,
  customerId: subscriber.id,
  now: new Date(),
  items: [{ price: planPrice, quantity: 1 }],
});
const loner = await customer("loner");
const resolve = (customerId: string) =>
  withTenant(orgId, (tx) => resolveOverdraftLimit(tx, { customerId, unitId }));
const r1 = await resolve(subscriber.id);
const r2 = await resolve(loner.id);
check(
  "a subscriber of the plan gets the plan's limit; a customer with no plan the unit's",
  r1.steps === 50n && r1.source === "plan" && r2.steps === 20n && r2.source === "unit",
  { r1, r2 },
);
const cusSet = await call(
  "PUT",
  `customers/${subscriber.publicId}/credit_overdraft_limits/credit`,
  {
    overdraft_limit: 0,
  },
);
check(
  "the customer's own limit wins, 0 included",
  cusSet.statusCode === 200 &&
    body(cusSet).source === "customer" &&
    body(cusSet).overdraft_limit === 0 &&
    body(cusSet).customer_override === 0,
  cusSet.body,
);
const cusList = body<{ data: Array<Record<string, unknown>> }>(
  await call("GET", `customers/${loner.publicId}/credit_overdraft_limits`),
);
check(
  "the customer list names each unit with no rate and its source",
  cusList.data.some(
    (v) => v.unit === "credit" && v.source === "unit" && v.overdraft_limit === 20,
  ) &&
    cusList.data.some((v) => v.unit === "plain" && v.source === "default") &&
    !cusList.data.some((v) => v.unit === "token"),
  cusList.data,
);
const overrides = body<{ data: Array<Record<string, unknown>> }>(
  await call("GET", "credit_units/credit/overdraft_limits"),
);
check(
  "the unit lists its plan and customer overrides",
  overrides.data.length === 2 &&
    overrides.data.some((o) => o.level === "plan" && o.product === product.publicId) &&
    overrides.data.some((o) => o.level === "customer" && o.customer === subscriber.publicId),
  overrides.data,
);
await call("DELETE", `customers/${subscriber.publicId}/credit_overdraft_limits/credit`);
await call("DELETE", `credit_units/credit/overdraft_limits/plans/${product.publicId}`);
await call("PATCH", "credit_units/credit", { overdraft_limit: 0 });
const r3 = await resolve(subscriber.id);
check(
  "with every layer removed the limit is 0 (default) and no row is left",
  r3.steps === 0n &&
    r3.source === "default" &&
    (
      await systemDb
        .select()
        .from(creditOverdraftLimits)
        .where(eq(creditOverdraftLimits.unitId, unitId))
    ).length === 0,
  r3,
);

// ── 3. Void reasons ──────────────────────────────────────────────────────────
console.log("3. void reasons");
const give = async (c: { publicId: string }, amount: number, effectiveAt?: Date) =>
  body<{ id: string }>(
    await call("POST", `customers/${c.publicId}/credit_grants`, {
      unit: "credit",
      amount,
      ...(effectiveAt ? { effective_at: effectiveAt.toISOString() } : {}),
    }),
  );
const g1 = await give(loner, 30);
const noNote = await call("POST", `customers/${loner.publicId}/credit_grants/${g1.id}/void`, {
  reason: "other",
});
const noReason = await call("POST", `customers/${loner.publicId}/credit_grants/${g1.id}/void`, {
  note: "Typo",
});
const badReason = await call("POST", `customers/${loner.publicId}/credit_grants/${g1.id}/void`, {
  reason: "because",
});
check(
  "other needs a note, a note needs a reason, an unknown reason is refused (400 each)",
  noNote.statusCode === 400 && noReason.statusCode === 400 && badReason.statusCode === 400,
);
const voided = await call("POST", `customers/${loner.publicId}/credit_grants/${g1.id}/void`, {
  reason: "goodwill_reversal",
  note: "Given twice by mistake.",
});
const vr = body<{ status: string; void_reason: { reason: string; note: string } | null }>(voided);
const fetched = body<{ void_reason: { reason: string } | null }>(
  await call("GET", `customers/${loner.publicId}/credit_grants/${g1.id}`),
);
check(
  "the void stores the reason and the grant returns it",
  voided.statusCode === 200 &&
    vr.status === "voided" &&
    vr.void_reason?.reason === "goodwill_reversal" &&
    vr.void_reason.note === "Given twice by mistake." &&
    fetched.void_reason?.reason === "goodwill_reversal",
  vr,
);
const g2 = await give(loner, 10);
const bare = await call("POST", `customers/${loner.publicId}/credit_grants/${g2.id}/void`);
check(
  "a void with no body still works and records no reason",
  bare.statusCode === 200 && body(bare).void_reason === null,
  bare.body,
);
const appendOnly = await withTenant(orgId, (tx) =>
  tx.update(creditGrantVoidReasons).set({ note: "changed" }),
).catch((e) => e);
check("a void reason cannot be changed by the app role", appendOnly instanceof Error);

// ── 4. A partly used pack, refunded in full ──────────────────────────────────
console.log("4. full refund of a partly used pack");
for (const m of [
  { id: "illustration", name: "Illustrations", event_name: "illustration", aggregation: "count" },
]) {
  const r = await call("POST", "meters", m);
  if (r.statusCode !== 201) throw new Error(`meter failed: ${r.body}`);
}
await call("PUT", "meters/illustration/credit_cost", { unit: "credit", credits_per_unit: "1" });
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
const buyer = await customer("buyer");
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
for (let i = 0; i < 5; i++) await send(plus(10 * MIN), buyer, "illustration");
await at(plus(HOUR + MIN), () => runSettleCreditUsage(plus(HOUR + MIN)));
const [packLine] = await systemDb
  .select()
  .from(invoiceLineItems)
  .where(eq(invoiceLineItems.invoiceId, sale.invoice.id));
const grantsOf = body<{ data: Array<{ id: string; source: string }> }>(
  await call("GET", `customers/${buyer.publicId}/credit_grants`),
);
const packGrant = grantsOf.data.find((g) => g.source === "purchase")!;
const note = (packRefund?: "full" | "unused") =>
  at(plus(2 * HOUR), () =>
    call("POST", "credit_notes", {
      invoice: sale.invoice.publicId,
      kind: "refundable",
      ...(packRefund ? { pack_refund: packRefund } : {}),
      items: [
        { description: "Trial Pack", amount_minor: 900, invoice_line_item: packLine!.publicId },
      ],
    }),
  );
const invRead = body<{
  lines: Array<{ id: string; creditable_minor?: number; pack_full_creditable_minor?: number }>;
}>(await call("GET", `invoices/${sale.invoice.publicId}`));
const packRead = invRead.lines.find((l) => l.id === packLine!.publicId);
check(
  "the invoice line shows both maximums: 600 unused, 900 with a full refund",
  packRead?.creditable_minor === 600 && packRead.pack_full_creditable_minor === 900,
  packRead,
);
const capped = await note();
check(
  "by default a note credits only the unused part (900 refused)",
  capped.statusCode === 400,
  capped.body,
);
// Other credit left in the unit: the used credits are drawn again from it first (0530).
const extra = await give(buyer, 10);
const full = await note("full");
const fullNote = body<{ id: string; pack_refund: string; total_minor: number }>(full);
check(
  "with other credit left, the full refund credits the whole line",
  full.statusCode === 201 && fullNote.pack_refund === "full" && fullNote.total_minor === 900,
  full.body,
);
const extraAct = body<Record<string, unknown>>(
  await call("GET", `customers/${buyer.publicId}/credit_grants/${extra.id}/activity`),
);
const writtenOff = await systemDb
  .select({ after: auditLogs.after })
  .from(auditLogs)
  .where(and(eq(auditLogs.action, "credit.zero_out"), eq(auditLogs.resourceId, fullNote.id)));
check(
  "the other grant's 1.0 is drawn again for the used 5.0; the other 4.0 is written off",
  extraAct.used_units === 10 &&
    extraAct.remaining_units === 0 &&
    writtenOff.some((r) => {
      const a = r.after as { reason?: string; units?: string };
      return a.reason === "full_refund" && a.units === "4";
    }),
  { extraAct, writtenOff },
);
const activity = body<Record<string, unknown>>(
  await call("GET", `customers/${buyer.publicId}/credit_grants/${packGrant.id}/activity`),
);
check(
  "the grant's activity: 15.0 bought, 5.0 used for 300, 10.0 voided for 600, nothing left; " +
    "credited by credit notes is the whole 900 (the re-draw does not change it)",
  activity.purchased_units === 150 &&
    activity.credited_minor === 900 &&
    activity.used_units === 50 &&
    activity.revenue_recognised_minor === 300 &&
    activity.voided_units === 100 &&
    activity.refunded_minor === 600 &&
    activity.remaining_units === 0 &&
    activity.remaining_cost_minor === 0 &&
    Array.isArray(activity.data) &&
    (
      activity.data as Array<{ kind: string; settlement: string | null; meter: string | null }>
    ).some((m) => m.kind === "draw" && m.settlement && m.meter === "illustration"),
  activity,
);
// A credit note books its reversal on credit_adjustments, the contra-revenue account.
const netRevenue =
  (await ledgerNet(buyer.id, "revenue")) + (await ledgerNet(buyer.id, "credit_adjustments"));
check(
  "revenue net of credit adjustments is 0 and deferred revenue is 0: the used part was reversed",
  netRevenue === 0n && (await ledgerNet(buyer.id, "credit_grants_paid")) === 0n,
  { netRevenue: String(netRevenue), paid: String(await ledgerNet(buyer.id, "credit_grants_paid")) },
);

// A pack whose credits are all taken by usage that is not settled yet, refunded in full: the
// note settles that usage first, so nothing is voided; with no other grant the used part is
// written off, and the ledger nets out.
console.log("4b. full refund of a pack used up before settlement");
const buyer2 = await customer("buyer2");
const sale2 = await at(B, () =>
  createManualInvoice({
    ...ids,
    customerId: buyer2.id,
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
  recordOfflinePayment({ ...ids, invoicePublicId: sale2.invoice.publicId, method: "wire" }),
);
for (let i = 0; i < 15; i++) await send(plus(10 * MIN), buyer2, "illustration");
const [packLine2] = await systemDb
  .select()
  .from(invoiceLineItems)
  .where(eq(invoiceLineItems.invoiceId, sale2.invoice.id));
const grant2 = body<{ data: Array<{ id: string; source: string }> }>(
  await call("GET", `customers/${buyer2.publicId}/credit_grants`),
).data.find((g) => g.source === "purchase")!;
const full2 = await at(plus(20 * MIN), () =>
  call("POST", "credit_notes", {
    invoice: sale2.invoice.publicId,
    kind: "refundable",
    pack_refund: "full",
    items: [
      { description: "Trial Pack", amount_minor: 900, invoice_line_item: packLine2!.publicId },
    ],
  }),
);
check(
  "a full refund of a pack used up before settlement is accepted",
  full2.statusCode === 201,
  full2.body,
);
await at(plus(HOUR + 2 * MIN), () => runSettleCreditUsage(plus(HOUR + 2 * MIN)));
const act2 = body<Record<string, unknown>>(
  await call("GET", `customers/${buyer2.publicId}/credit_grants/${grant2.id}/activity`),
);
const net2 =
  (await ledgerNet(buyer2.id, "revenue")) + (await ledgerNet(buyer2.id, "credit_adjustments"));
const paid2 = await ledgerNet(buyer2.id, "credit_grants_paid");
check(
  "after settlement the used-up pack has nothing left, and revenue and deferred revenue net to 0",
  act2.used_units === 150 &&
    act2.remaining_units === 0 &&
    act2.credited_minor === 900 &&
    net2 === 0n &&
    paid2 === 0n,
  { act2, net2: String(net2), paid2: String(paid2) },
);

// ── 5. Deferred revenue roll-forward ─────────────────────────────────────────
console.log("5. deferred revenue roll-forward");
const ym = (d: Date) => d.toISOString().slice(0, 7);
const toMonth = ym(new Date(Date.now() + 2 * DAY));
const fromMonth = ym(new Date(B.getTime() - 40 * DAY));
type Roll = {
  data: Array<Record<string, number | string>>;
  ledger_closing: Array<{ currency: string; credit_grants_paid_minor: number }>;
};
const roll = body<Roll>(
  await call("GET", `reports/credit_deferred_revenue?from=${fromMonth}&to=${toMonth}`),
);
const rows = roll.data.filter((r) => r.unit === "credit");
const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k]), 0);
const identity = roll.data.every(
  (r) =>
    Number(r.opening_minor) +
      Number(r.sold_minor) -
      Number(r.recognised_minor) -
      Number(r.breakage_minor) -
      Number(r.refunds_minor) +
      Number(r.other_minor) ===
    Number(r.closing_minor),
);
const chained = roll.data.every((r, i, a) => {
  const prev = a[i - 1];
  return (
    !prev ||
    prev.unit !== r.unit ||
    prev.currency !== r.currency ||
    prev.closing_minor === r.opening_minor
  );
});
check("every row: opening + sold − recognised − breakage − refunds + other = closing", identity);
check("a month's closing is the next month's opening", chained);
check(
  // Two packs of 900: one 1/3 used then refunded unused (300 + 600), one used up (900).
  "credit: sold 1800, recognised 1200, refunds 600, closing 0; credit notes 1800 (two full refunds)",
  sum("credited_minor") === 1800 &&
    sum("sold_minor") === 1800 &&
    sum("recognised_minor") === 1200 &&
    sum("refunds_minor") === 600 &&
    rows.at(-1)?.closing_minor === 0,
  rows,
);
const lastClosing = new Map<string, number>();
for (const r of roll.data)
  if (r.month === toMonth)
    lastClosing.set(
      String(r.currency),
      (lastClosing.get(String(r.currency)) ?? 0) + Number(r.closing_minor),
    );
check(
  "the closing balances of each currency equal the credit_grants_paid ledger account",
  roll.ledger_closing.every(
    (l) => (lastClosing.get(l.currency) ?? 0) === l.credit_grants_paid_minor,
  ),
  { ledger: roll.ledger_closing, closing: [...lastClosing] },
);
const badRange = await call("GET", "reports/credit_deferred_revenue?from=2020-01&to=2026-01");
check("a range over 36 months is refused (400)", badRange.statusCode === 400);

// ── 6. Runway in units, refused demand ───────────────────────────────────────
console.log("6. runway in units, refused demand");
const runner = await customer("runner");
await give(runner, 100, new Date(Date.now() - 3 * DAY));
for (let i = 0; i < 3; i++)
  await send(new Date(Date.now() - 2 * DAY + i * MIN), runner, "illustration");
const runway = body<Record<string, unknown>>(
  await call("GET", `customers/${runner.publicId}/credit_runway?unit=credit`),
);
check(
  "runway in units reads the balance the gate offers",
  runway.object === "credit_runway" && runway.unit === "credit" && runway.balance_units === 70,
  runway,
);
const ratedRunway = await call("GET", `customers/${runner.publicId}/credit_runway?unit=token`);
const noUnit = await call("GET", `customers/${runner.publicId}/credit_runway?unit=nope`);
check(
  "a unit with a rate is 400, an unknown unit 404",
  ratedRunway.statusCode === 400 && noUnit.statusCode === 404,
);
const broke = await customer("broke");
await send(new Date(), broke, "illustration");
await send(new Date(), broke, "illustration");
const from = new Date(Date.now() - DAY).toISOString();
const to = new Date(Date.now() + HOUR).toISOString();
const q = (g: string) =>
  `reports/credit_refused_demand?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&group_by=${g}`;
const byMeter = body<{ data: Array<Record<string, unknown>> }>(await call("GET", q("meter")));
const byCustomer = body<{ data: Array<Record<string, unknown>> }>(await call("GET", q("customer")));
const byDay = body<{ data: Array<Record<string, unknown>> }>(await call("GET", q("day")));
check(
  "refused demand counts the refused events and their credits, by meter, customer and day",
  byMeter.data.some(
    (r) =>
      r.meter === "illustration" && Number(r.refused_events) >= 2 && Number(r.refused_units) >= 20,
  ) &&
    byCustomer.data.some(
      (r) => r.customer === broke.publicId && r.refused_events === 2 && r.refused_units === 20,
    ) &&
    byDay.data.length >= 1 &&
    typeof byDay.data[0]!.day === "string",
  { byMeter: byMeter.data, byCustomer: byCustomer.data },
);

// ── 7. Another organization ──────────────────────────────────────────────────
console.log("7. another organization");
const other = await createOrganization({ name: "Credit Settings Reports Other Org" });
const otherBiz = await createBusiness({
  organizationId: other.organization.id,
  name: "Other",
  defaultCurrency: "USD",
  livemode: "test",
});
const asOther = { secret: other.secret, biz: otherBiz.publicId };
check(
  "the unit, its overrides and the grant activity are not in another organization",
  (await call("GET", "credit_units/credit/overdraft_limits", undefined, asOther)).statusCode ===
    404 &&
    (
      await call(
        "GET",
        `customers/${buyer.publicId}/credit_grants/${packGrant.id}/activity`,
        undefined,
        asOther,
      )
    ).statusCode === 404,
);
const otherRoll = body<Roll>(
  await call(
    "GET",
    `reports/credit_deferred_revenue?from=${fromMonth}&to=${toMonth}`,
    undefined,
    asOther,
  ),
);
check(
  "the other organization's roll-forward is empty",
  otherRoll.data.length === 0,
  otherRoll.data,
);
const crossRead = await withTenant(other.organization.id, (tx) =>
  tx.select().from(creditOverdraftLimits),
);
check("RLS: the other organization reads no overdraft rows", crossRead.length === 0);

await app.close();
await closeDb();
if (fails.length) {
  console.log(`\n❌ CREDIT-SETTINGS-REPORTS: FAIL (${fails.length})`);
  for (const f of fails) console.log(`   - ${f}`);
  process.exit(1);
}
console.log("\n✅ CREDIT-SETTINGS-REPORTS: PASS");
process.exit(0);
