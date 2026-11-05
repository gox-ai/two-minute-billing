/**
 * Billing from the model price list (Tier 3 PR 1b, design G1b T4, T5, T10, T11):
 *  - T4 a list change mid-period splits the line: $3.00 then $2.50 per 1M input, +20 % →
 *    444 ¢ and 137 ¢; each line cites the list row it priced from;
 *  - T5 your cost vs the selling price: markup on list bills $3.60, on cost $2.40; the line
 *    cost is your cost, never the list, while a cost row is live; a list move bills $3.00;
 *  - T10 a customer's own selling price wins over the price's, and a catalog edit moves no
 *    live item; a match off group_by and an override on a non-list price → 400;
 *  - T11 a non-USD price with no row in its currency bills the default rate; with a cost row
 *    in that currency and a cost base it bills from that row. No FX on a list price;
 *  - T12 late usage of a period whose lines split bills only the late units, with their cost;
 *  - T13 usage with no list row, dated before a cost row starts, bills at the default rate,
 *    and the invoice equals current usage at the period end;
 *  - T14 free quantity applies once to a period the list splits, as to an unsplit period;
 *  - T15 `event_cost_or_list` (G1c): events with a cost bill it + markup on a "reported cost"
 *    line, the others bill from the list; a fixed rate wins over both; free units come off
 *    the list part only; each line carries its own part's cost; list drift compares the
 *    reported cost with the list price of the same tokens, for the organization or one business.
 *
 *   pnpm verify:model-price-billing
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { createPrice, updatePrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { currentUsage } from "@/modules/subscriptions/current-usage";
import { listDrift } from "@/modules/metering/list-drift";
import { foldBusiness } from "@/modules/metering/fold";
import { ensureRollupState } from "@/modules/metering/meters";
import { customerMeterBilling, meters, subscriptionItems } from "@db/schema";
import {
  checker,
  createTestMeter,
  invoicesOf,
  meterBusiness,
  newCustomer,
  sendEvent,
  setTerm,
  tick,
  usageLines,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const { org, orgId, biz, ids, product } = await meterBusiness("Model Price Billing Org");

const HOUR = 3_600_000;
const E = new Date(Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR + 10 * 60_000);
const S = new Date(E.getTime() - 24 * HOUR);
// A price change inside a 15-minute bucket: the bucket that holds it splits on raw events.
const T = new Date(S.getTime() + 12 * HOUR + 7 * 60_000 + 13_000);
const before = new Date(T.getTime() - HOUR);
const after = new Date(T.getTime() + HOUR);
const PROVIDER = "tp";
const tag = randomBytes(3).toString("hex");

const ai = await createTestMeter(ids, { groupBy: ["model", "token_type"] });
await systemDb
  .update(meters)
  .set({ priceList: { provider: PROVIDER, token_type_key: "token_type" } })
  .where(eq(meters.id, ai.id));

const run = "00000000-0000-7000-8000-000000000001";
let rowN = 0;
/** A dated list row (cents per divisor). `from` null = since before we tracked it. */
async function listRow(model: string, tokenType: string, cents: string, from: Date | null) {
  await systemDb.execute(sql`
    insert into model_price_models (provider, model) values (${PROVIDER}, ${model})
    on conflict do nothing`);
  const pid = `mpr_t${tag}${++rowN}`;
  await systemDb.execute(sql`
    insert into model_prices (public_id, provider, model, token_type, currency,
      unit_amount_decimal, quantity_divisor, effective_from, source, source_version,
      source_effective_from, sync_run_id)
    values (${pid}, ${PROVIDER}, ${model}, ${tokenType}, 'USD', ${cents}::numeric, 1000000,
      ${from ? sql`${from.toISOString()}::timestamptz` : sql`'-infinity'::timestamptz`},
      'test-feed', 'v1', ${from ? from.toISOString().slice(0, 10) : null}::date, ${run}::uuid)`);
  return pid;
}
async function costRow(
  model: string,
  tokenType: string,
  currency: string,
  cents: string,
  from = new Date(S.getTime() - 24 * HOUR),
) {
  const pid = `mco_t${tag}${++rowN}`;
  await systemDb.execute(sql`
    insert into model_cost_overrides (organization_id, public_id, provider, model, token_type,
      currency, unit_amount_decimal, quantity_divisor, effective_from)
    values (${orgId}, ${pid}, ${PROVIDER}, ${model}, ${tokenType}, ${currency},
      ${cents}::numeric, 1000000, ${from.toISOString()}::timestamptz)`);
  return pid;
}

let priceN = 0;
const listPrice = (p: Partial<Parameters<typeof createPrice>[0]>) =>
  createPrice({
    ...ids,
    productId: product.id,
    id: `mpl-${++priceN}-${Date.now()}`,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: ai.key,
    amountSource: "model_price_list",
    unitAmountDecimal: "100",
    quantityDivisor: "1000000",
    markupPercent: "20",
    ...p,
  });

type Ev = {
  model: string;
  tokenType: string;
  tokens: number;
  at: Date;
  receivedMs?: number;
  cost?: string;
  currency?: string;
};
async function subscribe(price: Awaited<ReturnType<typeof listPrice>>, label: string) {
  const customer = await newCustomer(ids, label);
  const sub = await createSubscription({
    ...ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, S, E);
  return { customer, sub };
}
type Sub = Awaited<ReturnType<typeof subscribe>>;
/** Send each subscription's events, then run the clock once: one tick bills every term. */
async function bill(...work: Array<[Sub, Ev[]]>) {
  for (const [s, events] of work)
    for (const e of events)
      await sendEvent(ids, {
        customerId: s.customer.id,
        eventName: ai.eventName,
        at: e.at,
        properties: { model: e.model, token_type: e.tokenType, tokens: e.tokens },
        ...(e.receivedMs ? { receivedMs: e.receivedMs } : {}),
        ...(e.cost != null ? { cost: e.cost, currency: e.currency ?? "USD" } : {}),
      });
  await tick(biz.id);
  const out = [];
  for (const [s] of work) {
    const [latest] = await invoicesOf(orgId, s.sub.subscription.id);
    out.push(usageLines(latest?.lines ?? []));
  }
  return out;
}
type Line = Awaited<ReturnType<typeof bill>>[number][number];
type Seg = {
  model_price_id: string | null;
  model_cost_override_id: string | null;
  price_source: string;
  rate_from: string;
};
const segOf = (l: Line | undefined) => (l?.rating as { segments?: Seg[] } | null)?.segments?.[0];
const amounts = (ls: Line[]) => ls.map((l) => Number(l.amountMinor)).sort((a, b) => a - b);

const app = await buildApp({ logger: false });
let n = 0;
async function call(method: "GET" | "PATCH", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${org.secret}`,
      "idempotency-key": `mpb-${Date.now()}-${n++}`,
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

// ── T4 ───────────────────────────────────────────────────────────────────────────
console.log("T4. a list change splits the line, each at its own price");
const m4 = `m4-${tag}`;
const old4 = await listRow(m4, "input", "300", null);
const new4 = await listRow(m4, "input", "250", T);
const s4 = await subscribe(await listPrice({}), "t4");
const [l4 = []] = await bill([
  s4,
  [
    { model: m4, tokenType: "input", tokens: 1_234_567, at: before },
    { model: m4, tokenType: "input", tokens: 456_789, at: after },
  ],
]);
check(
  "two lines: 444 ¢ before T and 137 ¢ after",
  JSON.stringify(amounts(l4)) === "[137,444]",
  amounts(l4),
);
const l4old = l4.find((l) => l.amountMinor === 444n);
const l4new = l4.find((l) => l.amountMinor === 137n);
check(
  "each line cites the list row it priced from",
  segOf(l4old)?.model_price_id === old4 && segOf(l4new)?.model_price_id === new4,
  [segOf(l4old), segOf(l4new)],
);
check(
  "each line carries its true unit price (360 and 300 per 1M)",
  Number(l4old?.unitAmountDecimal) === 0.00036 && Number(l4new?.unitAmountDecimal) === 0.0003,
  [l4old?.unitAmountDecimal, l4new?.unitAmountDecimal],
);
check(
  "the line windows meet at the change instant",
  l4old?.periodEnd?.getTime() === T.getTime() && l4new?.periodStart?.getTime() === T.getTime(),
);
const cited = await call("GET", `/v1/organization/model_prices/${old4}`);
if (cited.status === 404 && /route/i.test(JSON.stringify(cited.body)))
  console.log("  · GET /v1/organization/model_prices/:id not registered in this build; skipped");
else
  check(
    "GET …/model_prices/:id returns the cited row",
    cited.status === 200 && JSON.stringify(cited.body).includes(old4),
    cited,
  );

// ── T5 ───────────────────────────────────────────────────────────────────────────
console.log("T5. your cost vs the selling price");
const m5 = `m5-${tag}`;
const list5 = await listRow(m5, "input", "300", null);
const cost5 = await costRow(m5, "input", "USD", "200");
const onList = await subscribe(await listPrice({ markupBase: "list" }), "t5l");
const onCost = await subscribe(await listPrice({ markupBase: "cost" }), "t5c");
// The list moves to $2.50 at T. The cost row does not move.
const moved5 = await listRow(m5, "input", "250", T);
const ev5 = [
  { model: m5, tokenType: "input", tokens: 1_000_000, at: before },
  { model: m5, tokenType: "input", tokens: 1_000_000, at: after },
];
const [l5list = [], l5cost = []] = await bill([onList, ev5], [onCost, ev5]);
check(
  "markup on list: $3.60 before the move, $3.00 after",
  JSON.stringify(amounts(l5list)) === "[300,360]",
  amounts(l5list),
);
check(
  "markup on list cites the list rows, not your cost",
  l5list.every((l) => segOf(l)?.model_cost_override_id == null) &&
    new Set(l5list.map((l) => segOf(l)?.model_price_id)).size === 2 &&
    l5list.some((l) => segOf(l)?.model_price_id === list5) &&
    l5list.some((l) => segOf(l)?.model_price_id === moved5),
  l5list.map(segOf),
);
check(
  "line cost is your cost ($2.00 per 1M) on each side of the list move",
  l5list.every((l) => l.costMinor === 200n && l.costBasis === "price_list"),
  l5list.map((l) => [l.costMinor, l.costBasis]),
);
check(
  "markup on cost: $2.40 per 1M through the list move (one line, cost row unchanged)",
  JSON.stringify(amounts(l5cost)) === "[480]" && segOf(l5cost[0])?.model_cost_override_id === cost5,
  { amounts: amounts(l5cost), seg: segOf(l5cost[0]) },
);

// ── T10 ──────────────────────────────────────────────────────────────────────────
console.log("T10. a customer's own selling price");
const m10 = `m10-${tag}`;
await listRow(m10, "input", "300", null);
await listRow(m10, "output", "1500", null);
const p10 = await listPrice({});
const a10 = await subscribe(p10, "t10a");
const b10 = await subscribe(p10, "t10b");
const [bItem] = await systemDb
  .select()
  .from(subscriptionItems)
  .where(eq(subscriptionItems.subscriptionId, b10.sub.subscription.id));
const itemUrl = `/v1/businesses/${biz.publicId}/subscriptions/${b10.sub.subscription.publicId}/items/${bItem!.publicId}`;
const off = await call("PATCH", itemUrl, {
  rates: [{ match: { region: "eu" }, unit_amount_decimal: "1" }],
});
check("an override match off the meter's group_by → 400", off.status === 400, off.body);
const both = await call("PATCH", itemUrl, {
  rates: [{ match: { model: m10 }, unit_amount_decimal: "1", markup_percent: "5" }],
});
check("an override row with a rate and a markup → 400", both.status === 400, both.body);
const set = await call("PATCH", itemUrl, {
  markup_percent: "10",
  rates: [{ match: { model: m10, token_type: "input" }, unit_amount_decimal: "100" }],
});
check(
  "PATCH item sets the customer's selling price",
  set.status === 200 && set.body.selling_price?.markup_percent === "10",
  set.body,
);
// A catalog edit after attach moves no live item.
await updatePrice({ ...ids, pricePublicId: p10.publicId, markupPercent: "50" });
const ev10 = (at: Date) => [
  { model: m10, tokenType: "input", tokens: 1_000_000, at },
  { model: m10, tokenType: "output", tokens: 1_000_000, at },
];
const [l10a = [], l10b = []] = await bill([a10, ev10(before)], [b10, ev10(before)]);
check(
  "customer A: list + 20 % (360 input, 1800 output), not the edited 50 %",
  JSON.stringify(amounts(l10a)) === "[360,1800]",
  amounts(l10a),
);
check(
  "customer B: the fixed rate on input (100) and list + 10 % on output (1650)",
  JSON.stringify(amounts(l10b)) === "[100,1650]",
  amounts(l10b),
);
check(
  "customer B's lines say the rate came from the subscription override",
  l10b.every((l) => segOf(l)?.rate_from === "subscription_override"),
  l10b.map(segOf),
);
const rateOnly = await createPrice({
  ...ids,
  productId: product.id,
  id: `rate-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: (await createTestMeter(ids, { groupBy: ["model"] })).key,
  unitAmountDecimal: "1",
});
const c10 = await subscribe(rateOnly, "t10c");
const [cItem] = await systemDb
  .select()
  .from(subscriptionItems)
  .where(eq(subscriptionItems.subscriptionId, c10.sub.subscription.id));
const notList = await call(
  "PATCH",
  `/v1/businesses/${biz.publicId}/subscriptions/${c10.sub.subscription.publicId}/items/${cItem!.publicId}`,
  { markup_percent: "10" },
);
check("an override on a price that is not on the list → 400", notList.status === 400, notList.body);

// ── T11 ──────────────────────────────────────────────────────────────────────────
console.log("T11. a currency other than the list's");
// Two models: one with no INR row at all, one with your cost in INR.
const m11 = `m11-${tag}`;
const m11c = `m11c-${tag}`;
await listRow(m11, "input", "300", null);
await listRow(m11c, "input", "300", null);
const inrDefault = await subscribe(
  await listPrice({ currency: "INR", unitAmountDecimal: "5000" }),
  "t11d",
);
await costRow(m11c, "input", "INR", "20000");
const inrCost = await subscribe(
  await listPrice({
    currency: "INR",
    unitAmountDecimal: "5000",
    markupBase: "cost",
    markupPercent: "10",
  }),
  "t11c",
);
const ev11 = (model: string) => [{ model, tokenType: "input", tokens: 1_000_000, at: before }];
const [l11d = [], l11c = []] = await bill([inrDefault, ev11(m11)], [inrCost, ev11(m11c)]);
check(
  "INR with no INR row on a list base: the default rate (5000), price_source default_rate",
  JSON.stringify(amounts(l11d)) === "[5000]" &&
    (l11d[0]?.rating as { price_source?: string } | null)?.price_source === "default_rate",
  { amounts: amounts(l11d), rating: l11d[0]?.rating },
);
check(
  "INR with an INR cost row on a cost base: 20000 + 10 % = 22000",
  JSON.stringify(amounts(l11c)) === "[22000]",
  amounts(l11c),
);

// ── T12 ──────────────────────────────────────────────────────────────────────────
console.log("T12. late usage of a split period bills only what is late");
const E2 = new Date(E.getTime() + HOUR);
const m12 = `m12-${tag}`; // the list moves at T: its lines split
const m12b = `m12b-${tag}`; // no change: one line for the whole period
await listRow(m12, "input", "300", null);
await listRow(m12, "input", "250", T);
await listRow(m12b, "input", "100", null);
await costRow(m12b, "input", "USD", "50");
const s12 = await subscribe(await listPrice({ markupPercent: "0" }), "t12");
const [l12 = []] = await bill([
  s12,
  [
    { model: m12, tokenType: "input", tokens: 1_000_000, at: before },
    { model: m12, tokenType: "input", tokens: 1_000_000, at: after },
    { model: m12b, tokenType: "input", tokens: 1_000_000, at: before },
  ],
]);
check(
  "the first invoice splits m12 (300 + 250) and bills m12b whole (100)",
  JSON.stringify(amounts(l12)) === "[100,250,300]",
  amounts(l12),
);
// Received just after that cutoff's edge: late usage of the billed period, one per combination.
const [p12] = await systemDb
  .select()
  .from(customerMeterBilling)
  .where(eq(customerMeterBilling.customerId, s12.customer.id));
const lateAt = p12!.cutoffAt!.getTime() - 5 * 60_000 + 500;
await setTerm(s12.sub.subscription.id, E, E2);
await new Promise((r) => setTimeout(r, 1500));
const [n12 = []] = await bill([
  s12,
  [
    { model: m12, tokenType: "input", tokens: 1_000_000, at: after, receivedMs: lateAt },
    { model: m12b, tokenType: "input", tokens: 2_000_000, at: before, receivedMs: lateAt },
  ],
]);
const late12 = n12.filter((l) => l.description.startsWith("Usage from "));
check(
  "the next invoice bills only the late units: m12 250 and m12b 200",
  JSON.stringify(amounts(late12)) === "[200,250]",
  n12.map((l) => [l.description, l.amountMinor]),
);
check(
  "each late line carries the cost of its late units (m12 250 from the list, m12b 100)",
  late12.length === 2 &&
    late12.every(
      (l) =>
        (l.amountMinor === 250n && l.costMinor === 250n && l.costBasis === "price_list") ||
        (l.amountMinor === 200n && l.costMinor === 100n && l.costBasis === "price_list"),
    ),
  late12.map((l) => [l.amountMinor, l.costMinor, l.costBasis]),
);

// ── T13 ──────────────────────────────────────────────────────────────────────────
console.log("T13. usage before a cost row starts bills at the default rate");
const m13 = `mystery-${tag}`; // no list row; your cost starts at T, after its usage
const m13b = `nova-${tag}`; // no list row; your cost starts at T, usage on both sides
await costRow(m13, "input", "USD", "40", T);
await costRow(m13b, "input", "USD", "40", T);
const s13 = await subscribe(await listPrice({}), "t13");
for (const e of [
  { model: m13, tokens: 50_000, at: before },
  { model: m13b, tokens: 70_000, at: before },
  { model: m13b, tokens: 1_000_000, at: after },
])
  await sendEvent(ids, {
    customerId: s13.customer.id,
    eventName: ai.eventName,
    at: e.at,
    properties: { model: e.model, token_type: "input", tokens: e.tokens },
  });
const cu13 = await currentUsage({ ...ids, subscriptionId: s13.sub.subscription.id });
const [l13 = []] = await bill([s13, []]);
const total13 = l13.reduce((a, l) => a + Number(l.amountMinor), 0);
check(
  "default rate before the cost row (5 and 7), your cost + 20 % after it (48)",
  JSON.stringify(amounts(l13)) === "[5,7,48]",
  l13.map((l) => [l.description, l.amountMinor, l.periodStart, l.periodEnd]),
);
check(
  "the invoice total equals current usage at the period end (60)",
  total13 === 60 && Number(cu13?.items.reduce((a, i) => a + i.amountMinor, 0n)) === total13,
  { invoice: total13, current: cu13?.items.map((i) => String(i.amountMinor)) },
);
// Late usage dated where no line of its period was billed: the period's only line is the
// cost segment after T, and the late event is before T.
const s13b = await subscribe(await listPrice({}), "t13b");
const [l13b = []] = await bill([
  s13b,
  [{ model: m13b, tokenType: "input", tokens: 1_000_000, at: after }],
]);
const [p13b] = await systemDb
  .select()
  .from(customerMeterBilling)
  .where(eq(customerMeterBilling.customerId, s13b.customer.id));
await setTerm(s13b.sub.subscription.id, E, E2);
await new Promise((r) => setTimeout(r, 1500));
const [n13b = []] = await bill([
  s13b,
  [
    {
      model: m13,
      tokenType: "input",
      tokens: 50_000,
      at: before,
      receivedMs: p13b!.cutoffAt!.getTime() - 5 * 60_000 + 500,
    },
  ],
]);
check(
  "late usage before the period's only billed segment bills on the next invoice (5)",
  JSON.stringify(amounts(l13b)) === "[48]" &&
    JSON.stringify(amounts(n13b.filter((l) => l.description.startsWith("Usage from ")))) === "[5]",
  { first: amounts(l13b), next: n13b.map((l) => [l.description, l.amountMinor]) },
);

// ── T14 ──────────────────────────────────────────────────────────────────────────
console.log("T14. free quantity once per period, not per segment");
const m14 = `m14-${tag}`; // a new list row at T with the same price: the line splits
const m14b = `m14b-${tag}`; // one row: no split
await listRow(m14, "input", "300", null);
await listRow(m14, "input", "300", T);
await listRow(m14b, "input", "300", null);
const free14 = { markupPercent: "0", freeQuantity: 500_000 };
const s14 = await subscribe(await listPrice(free14), "t14");
const s14b = await subscribe(await listPrice(free14), "t14b");
const ev14 = (model: string) => [
  { model, tokenType: "input", tokens: 1_000_000, at: before },
  { model, tokenType: "input", tokens: 1_000_000, at: after },
];
const [l14 = [], l14b = []] = await bill([s14, ev14(m14)], [s14b, ev14(m14b)]);
const sum14 = (ls: Line[]) => ls.reduce((a, l) => a + Number(l.amountMinor), 0);
check(
  "split at one rate: (2M − 0.5M free) × $3 per 1M = 450, the same as the unsplit period",
  l14.length === 2 && sum14(l14) === 450 && sum14(l14b) === 450,
  { split: amounts(l14), whole: amounts(l14b) },
);

// ── T15 ──────────────────────────────────────────────────────────────────────────
console.log("T15. real cost first: reported cost, else the list");
const m15 = `m15-${tag}`;
const list15 = await listRow(m15, "input", "300", null);
// Its own meter on the same events, set up as the API creates one (fold state, then a
// backfill), so list drift has rollups to read once the fold runs.
const ai15 = await createTestMeter(ids, {
  groupBy: ["model", "token_type"],
  eventName: ai.eventName,
});
const w15 = await systemDb.transaction((tx) => ensureRollupState(tx, orgId, biz.id));
await systemDb
  .update(meters)
  .set({
    priceList: { provider: PROVIDER, token_type_key: "token_type" },
    foldedFrom: w15,
    backfilledAt: null,
  })
  .where(eq(meters.id, ai15.id));
const cf = (p: Partial<Parameters<typeof createPrice>[0]> = {}) =>
  listPrice({ amountSource: "event_cost_or_list", meter: ai15.key, ...p });
const s15 = await subscribe(await cf(), "t15");
const s15fixed = await subscribe(
  await cf({ rates: [{ match: { model: m15 }, unitAmountDecimal: "100" }] }),
  "t15fixed",
);
const s15free = await subscribe(await cf({ freeQuantity: 500_000 }), "t15free");
const s15eur = await subscribe(await cf(), "t15eur");
// One call reported its cost ($0.50 for 1M tokens); one did not.
const ev15 = [
  { model: m15, tokenType: "input", tokens: 1_000_000, at: before, cost: "0.50" },
  { model: m15, tokenType: "input", tokens: 1_000_000, at: after },
];
const [l15 = [], l15fixed = [], l15free = [], l15eur = []] = await bill(
  [s15, ev15],
  [s15fixed, ev15],
  [s15free, ev15],
  [s15eur, [{ ...ev15[0]!, cost: "0.40", currency: "EUR" }]],
);
const reported15 = l15.find((l) => segOf(l)?.price_source === "reported_cost");
const listed15 = l15.find((l) => segOf(l)?.price_source === "model_price_list");
check(
  "reported $0.50 + 20 % = 60 ¢ on its own line; the other 1M from the list: 360 ¢",
  JSON.stringify(amounts(l15)) === "[60,360]" &&
    reported15?.amountMinor === 60n &&
    listed15?.amountMinor === 360n,
  l15.map((l) => [l.description, l.amountMinor, segOf(l)?.price_source]),
);
check(
  'the reported line says "reported cost"; the list line cites its list row',
  reported15?.description.endsWith(" · reported cost") === true &&
    segOf(listed15)?.model_price_id === list15 &&
    (reported15?.rating as { part?: string } | null)?.part === "reported_cost" &&
    (listed15?.rating as { part?: string } | null)?.part === "list",
  [reported15?.description, segOf(listed15), reported15?.rating],
);
check(
  "each line's cost is its own part: 50 ¢ reported, 300 ¢ list",
  reported15?.costMinor === 50n &&
    reported15?.costBasis === "event" &&
    listed15?.costMinor === 300n &&
    listed15?.costBasis === "price_list",
  l15.map((l) => [l.amountMinor, l.costMinor, l.costBasis]),
);
check(
  "a fixed rate wins: all 2M at 100 per 1M = 200 ¢, one line",
  JSON.stringify(amounts(l15fixed)) === "[200]" &&
    segOf(l15fixed[0])?.price_source === "fixed_rate",
  l15fixed.map((l) => [l.amountMinor, segOf(l)?.price_source]),
);
check(
  "free units come off the list part only: 60 ¢ reported, (1M − 0.5M) × $3.60 = 180 ¢",
  JSON.stringify(amounts(l15free)) === "[60,180]",
  amounts(l15free),
);
check(
  "a cost in another currency bills from the list, never nothing: 1M × $3.60 = 360 ¢, cost 300 ¢",
  JSON.stringify(amounts(l15eur)) === "[360]" &&
    segOf(l15eur[0])?.price_source === "model_price_list" &&
    l15eur[0]?.costMinor === 300n,
  l15eur.map((l) => [l.amountMinor, segOf(l)?.price_source, l.costMinor]),
);
let fold15 = await foldBusiness({ organizationId: orgId, businessId: biz.id, graceMs: 0 });
while (!fold15.caughtUp)
  fold15 = await foldBusiness({ organizationId: orgId, businessId: biz.id, graceMs: 0 });
const drift15 = (await listDrift(orgId)).find((d) => d.model === m15);
check(
  "list drift: the calls reported 3 × 50 ¢ against 3 × 300 ¢ on the list = −83.3 %",
  drift15?.reportedCostMinor === 150n &&
    drift15?.listCostMinor === 900n &&
    drift15?.differencePercent === -83.3,
  drift15,
);
const driftApi = await call("GET", "/v1/organization/model_prices/drift");
check(
  "GET /v1/organization/model_prices/drift lists it",
  driftApi.status === 200 &&
    (driftApi.body.data as Array<{ model: string; difference_percent: number }>).some(
      (d) => d.model === m15 && d.difference_percent === -83.3,
    ),
  driftApi.body,
);

const byBiz = await call("GET", `/v1/organization/model_prices?business=${biz.publicId}`);
const driftBiz = await call("GET", `/v1/organization/model_prices/drift?business=${biz.publicId}`);
const noBiz = await call("GET", "/v1/organization/model_prices/drift?business=biz_missing");
check(
  "?business= lists the models that business used, and its drift; an unknown business is 404",
  byBiz.status === 200 &&
    (byBiz.body.data as Array<{ model: string }>).some((r) => r.model === m15) &&
    (driftBiz.body.data as Array<{ model: string }>).some((d) => d.model === m15) &&
    noBiz.status === 404,
  { byBiz: byBiz.status, drift: driftBiz.body, noBiz: noBiz.status },
);

await app.close();
console.log("");
console.log(
  fails.length === 0
    ? "✅ MODEL PRICE BILLING: PASS"
    : `❌ MODEL PRICE BILLING: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
