/**
 * Meter prices and rate cards (Tier 3 G2), end to end:
 *  - API: create a meter price with a rate card, read it back, refuse bad decimals, a match off
 *    group_by, usage fields on a meter price, meter fields on a plain price; PATCH replaces the card;
 *  - billing: "$3 per 1M input tokens" to the cent; most specific rate, then oldest, then the
 *    default; tiers and volume round once per line; package per 1M; event_amount and event_cost
 *    + 20%; a currency mismatch is not billed; the snapshot freezes the card;
 *  - one live subscription per customer bills a meter (409), and the row passes on cancel;
 *  - exact period edges: a period ending at hh:10 bills an event at hh:07 and the next bills hh:10;
 *  - every line carries quantity_decimal; an old row with nulls reads from the integers;
 *  - a period split into two segments at one rate bills the same as the whole period: free
 *    quantity once, tiers and volume on the period total, packages counted once.
 *
 *   pnpm verify:rate-cards
 */
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { createPrice, updatePrice } from "@/modules/catalog/service";
import { cancelSubscription, createSubscription } from "@/modules/subscriptions/service";
import { addSubscriptionItem } from "@/modules/subscriptions/items";
import { currentUsage } from "@/modules/subscriptions/current-usage";
import { createInvoiceFromLines } from "@/modules/invoicing/service";
import { MeterBillingConflictError } from "@/modules/subscriptions/meter-billing";
import { resolveMeterRate, type PriceSnapshot } from "@/modules/catalog/pricing";
import { FOLD_GRACE_MS, peekMeterCutoff, rateMeterItem } from "@/modules/metering/meter-rating";
import { withTenant } from "@/platform/db";
import { customerMeterBilling, invoiceLineItems, subscriptionItems } from "@db/schema";
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
const { org, orgId, biz, ids, product } = await meterBusiness("Rate Cards Org");

const HOUR = 3_600_000;
// A period that ends at hh:10, well in the past (the usage close wait is ~6 minutes).
const E = new Date(Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR + 10 * 60_000);
const S = new Date(E.getTime() - 24 * HOUR);
const mid = new Date(E.getTime() - 6 * HOUR);

const ai = await createTestMeter(ids, { groupBy: ["model", "token_type"] });

type PriceArgs = Partial<Parameters<typeof createPrice>[0]>;
let priceN = 0;
const meterPrice = (meterKey: string, p: PriceArgs) =>
  createPrice({
    ...ids,
    productId: product.id,
    id: `mp-${++priceN}-${Date.now()}`,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: meterKey,
    ...p,
  });

/** Subscribe a new customer, bill [S, E) after `events`, return the period invoice's lines. */
async function billOnce(
  price: Awaited<ReturnType<typeof meterPrice>>,
  eventName: string,
  events: Array<{
    props: Record<string, string | number>;
    at?: Date;
    amount?: string;
    cost?: string;
    currency?: string;
  }>,
  tag = "c",
) {
  const customer = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, S, E);
  for (const e of events)
    await sendEvent(ids, {
      customerId: customer.id,
      eventName,
      at: e.at ?? mid,
      properties: e.props,
      amount: e.amount,
      cost: e.cost,
      currency: e.currency,
    });
  await tick(biz.id);
  const [latest] = await invoicesOf(orgId, sub.subscription.id);
  return { customer, sub, inv: latest?.inv, lines: usageLines(latest?.lines ?? []) };
}
const amountOf = (lines: Array<{ description: string; amountMinor: bigint }>, needle: string) =>
  Number(lines.find((l) => l.description.includes(needle))?.amountMinor ?? -1);

// ── 1. API ──────────────────────────────────────────────────────────────────────
console.log("1. API");
const app = await buildApp({ logger: false });
let n = 0;
async function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: {
      authorization: `Bearer ${org.secret}`,
      "idempotency-key": `rc-${Date.now()}-${n++}`,
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
await call("POST", "/products", { id: "rc-plan", name: "RC plan", kind: "plan" });
const priceBody = {
  product: "rc-plan",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: ai.key,
  unit_amount_decimal: "300",
  quantity_divisor: "1000000",
  rates: [{ match: { token_type: "output" }, unit_amount_decimal: "1500" }],
};
const made = await call("POST", "/prices", { ...priceBody, id: "rc-tokens" });
check(
  "create a meter price → 201 with meter, decimal rate, divisor and rate card",
  made.status === 201 &&
    made.body.meter === ai.key &&
    made.body.unit_amount_decimal === "300" &&
    made.body.quantity_divisor === "1000000" &&
    made.body.amount_source === "rate" &&
    made.body.usage_aggregation === "sum" &&
    made.body.rates?.[0]?.unit_amount_decimal === "1500",
  made.body,
);
const bad = async (name: string, body: Record<string, unknown>, field: string) => {
  const r = await call("POST", "/prices", { ...priceBody, ...body });
  check(`${name} → 400`, r.status === 400 && JSON.stringify(r.body).includes(field), r.body);
};
await bad(
  "a rate with 13 decimals",
  { unit_amount_decimal: "0.1234567890123" },
  "unit_amount_decimal",
);
await bad("a rate with an exponent", { unit_amount_decimal: "3e2" }, "unit_amount_decimal");
await bad(
  "a rate matching a property off group_by",
  { rates: [{ match: { region: "eu" }, unit_amount_decimal: "1" }] },
  "region",
);
await bad(
  "two rates with the same match",
  {
    rates: [
      { match: { model: "a" }, unit_amount_decimal: "1" },
      { match: { model: "a" }, unit_amount_decimal: "2" },
    ],
  },
  "same match",
);
await bad("usage_aggregation on a meter price", { usage_aggregation: "max" }, "usage_aggregation");
await bad("a flat model on a meter", { model: "flat" }, "model");
const plain = await call("POST", "/prices", {
  product: "rc-plan",
  model: "per_unit",
  currency: "USD",
  interval: "month",
  amount_minor: 100,
  unit_amount_decimal: "1",
});
check("unit_amount_decimal on a price with no meter → 400", plain.status === 400, plain.body);
const patched = await call("PATCH", "/prices/rc-tokens", {
  rates: [{ match: { model: "big" }, unit_amount_decimal: "9000" }],
});
check(
  "PATCH rates replaces the rate card",
  patched.status === 200 &&
    patched.body.rates.length === 1 &&
    patched.body.rates[0].match.model === "big",
  patched.body,
);
const lockedMeter = await call("PATCH", "/prices/rc-tokens", { quantity_divisor: "1000" });
check("PATCH quantity_divisor → 400", lockedMeter.status === 400);

// ── 2. The proof: $3 per 1M input, $15 per 1M output ─────────────────────────────
console.log("2. rating");
const tokens = await meterPrice(ai.key, {
  unitAmountDecimal: "300",
  quantityDivisor: "1000000",
  rates: [
    { match: { token_type: "input" }, unitAmountDecimal: "300" },
    { match: { token_type: "output" }, unitAmountDecimal: "1500" },
  ],
});
const proof = await billOnce(tokens, ai.eventName, [
  { props: { model: "m-large", token_type: "input", tokens: 1_000_000 } },
  { props: { model: "m-large", token_type: "input", tokens: 234_567 } },
  { props: { model: "m-large", token_type: "output", tokens: 456_789 } },
]);
check(
  "1,234,567 input → 370 and 456,789 output → 685: two lines, 1055",
  proof.lines.length === 2 &&
    amountOf(proof.lines, "input") === 370 &&
    amountOf(proof.lines, "output") === 685 &&
    Number(proof.inv?.subtotalMinor) === 1055,
  proof.lines.map((l) => [l.description, l.amountMinor]),
);
const inputLine = proof.lines.find((l) => l.description.includes("input"));
check(
  "the line reads 'price · group values', quantity_decimal 1234567, unit 0.0003",
  !!inputLine?.description.endsWith(" · m-large · input") &&
    Number(inputLine?.quantityDecimal) === 1234567 &&
    Number(inputLine?.unitAmountDecimal) === 0.0003 &&
    inputLine?.quantity === 1 &&
    Number(inputLine?.unitAmountMinor) === 370,
  inputLine,
);
const rating = inputLine?.rating as Record<string, unknown> | undefined;
check(
  "rating names the meter, group, matched rate, divisor and exact window",
  rating?.meter === ai.id &&
    JSON.stringify(rating?.group) === JSON.stringify(["m-large", "input"]) &&
    JSON.stringify(rating?.rate_match) === JSON.stringify({ token_type: "input" }) &&
    rating?.quantity_divisor === "1000000" &&
    (rating?.window as { end: string })?.end === E.toISOString(),
  rating,
);

// ── 3. Precedence ───────────────────────────────────────────────────────────────
const card = await meterPrice(ai.key, {
  unitAmountDecimal: "7",
  quantityDivisor: "1000000",
  rates: [
    { match: { model: "m1" }, unitAmountDecimal: "100" },
    { match: { token_type: "output" }, unitAmountDecimal: "500" },
    { match: { model: "m1", token_type: "output" }, unitAmountDecimal: "900" },
  ],
});
const M = 1_000_000;
const prec = await billOnce(card, ai.eventName, [
  { props: { model: "m1", token_type: "output", tokens: M } },
  { props: { model: "m1", token_type: "input", tokens: M } },
  { props: { model: "m2", token_type: "output", tokens: M } },
  { props: { model: "unknown-model", token_type: "input", tokens: M } },
]);
check(
  "most specific wins (900); one property (100, 500); an unknown model bills at the default (7)",
  amountOf(prec.lines, "m1 · output") === 900 &&
    amountOf(prec.lines, "m1 · input") === 100 &&
    amountOf(prec.lines, "m2 · output") === 500 &&
    amountOf(prec.lines, "unknown-model · input") === 7,
  prec.lines.map((l) => [l.description, l.amountMinor]),
);
const tie = await meterPrice(ai.key, {
  unitAmountDecimal: "7",
  quantityDivisor: "1000000",
  rates: [
    { match: { model: "m3" }, unitAmountDecimal: "11" },
    { match: { token_type: "input" }, unitAmountDecimal: "22" },
  ],
});
const tied = await billOnce(tie, ai.eventName, [
  { props: { model: "m3", token_type: "input", tokens: M } },
]);
check("on a tie the oldest rate wins (11)", amountOf(tied.lines, "m3") === 11, tied.lines);

// ── 4. Tiers, volume, package ──────────────────────────────────────────────────
const plainMeter = await createTestMeter(ids, {});
const tiered = await meterPrice(plainMeter.key, {
  model: "tiered",
  meterTiers: [
    { up_to: "1", unit_amount_decimal: "0.4" },
    { up_to: "2", unit_amount_decimal: "0.4" },
    { up_to: null, unit_amount_decimal: "0.4" },
  ],
});
const tieredBill = await billOnce(tiered, plainMeter.eventName, [{ props: { tokens: 3 } }]);
check(
  "tiered 3 × 0.4 rounds once per line → 1 (per-tier rounding would give 0)",
  Number(usageLines(tieredBill.lines)[0]?.amountMinor) === 1,
  tieredBill.lines,
);
const volume = await meterPrice(plainMeter.key, {
  model: "volume",
  quantityDivisor: "1000000",
  meterTiers: [
    { up_to: "1000000", unit_amount_decimal: "300" },
    { up_to: null, unit_amount_decimal: "250.5", flat_amount_minor: 5 },
  ],
});
const volumeBill = await billOnce(volume, plainMeter.eventName, [{ props: { tokens: 2_500_001 } }]);
// 2,500,001 × 250.5 ÷ 10^6 = 626.2502505 → 626, + 5.
check(
  "volume with a decimal rate → 631",
  Number(volumeBill.lines[0]?.amountMinor) === 631,
  volumeBill.lines,
);
const pkg = await meterPrice(plainMeter.key, {
  model: "package",
  packageSize: 1_000_000,
  unitAmountDecimal: "250",
});
const pkgBill = await billOnce(pkg, plainMeter.eventName, [{ props: { tokens: 1_000_001 } }]);
check(
  "package per 1M: 1,000,001 units → 2 packages → 500",
  Number(pkgBill.lines[0]?.amountMinor) === 500,
  pkgBill.lines,
);

// ── 4b. A split period bills like the whole period ─────────────────────────────
console.log("4b. a period split into segments");
const splitMeter = await createTestMeter(ids, {});
const T = new Date(S.getTime() + 12 * HOUR);
/** Rate [S, E) once whole and once split at T (same rate both sides); events 6 before, 8 after. */
async function splitVsWhole(p: PriceArgs, tag: string) {
  const price = await meterPrice(splitMeter.key, p);
  const customer = await newCustomer(ids, tag);
  for (const [at, tokens] of [
    [new Date(T.getTime() - HOUR), 6],
    [new Date(T.getTime() + HOUR), 8],
  ] as const)
    await sendEvent(ids, {
      customerId: customer.id,
      eventName: splitMeter.eventName,
      at,
      properties: { tokens },
    });
  // The item's frozen snapshot carries the meter; nothing bills it here.
  const sub = await createSubscription({
    ...ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  const [item] = await systemDb
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, sub.subscription.id));
  const snap = item!.priceSnapshot as PriceSnapshot;
  return withTenant(orgId, async (tx) => {
    const peek = await peekMeterCutoff(tx, {
      businessId: biz.id,
      customerId: customer.id,
      meterId: splitMeter.id,
    });
    const cutoff = { ...peek, at: new Date(Date.now() + FOLD_GRACE_MS + 1_000) };
    const rate = (split: boolean) =>
      rateMeterItem(tx, {
        item: { id: "split", freeQuantity: null, priceSnapshot: snap },
        subscription: { customerId: customer.id, currency: "USD" },
        window: { start: S, end: E },
        cutoff,
        ...(split
          ? {
              resolveRate: (combo: { group: Record<string, string> }) => [
                { start: S, end: T, rate: resolveMeterRate(snap, combo.group) },
                { start: T, end: E, rate: resolveMeterRate(snap, combo.group) },
              ],
            }
          : {}),
      });
    const sum = (r: Awaited<ReturnType<typeof rate>>) =>
      r.lines.reduce((a, l) => a + Number(l.amountMinor), 0);
    const split = await rate(true);
    return { whole: sum(await rate(false)), split: sum(split), lines: split.lines.length };
  });
}
const freeSplit = await splitVsWhole({ unitAmountDecimal: "10", freeQuantity: 5 }, "split-free");
check(
  "free quantity applies once per period: (14 − 5) × 10 = 90, split as whole",
  freeSplit.whole === 90 && freeSplit.split === 90 && freeSplit.lines === 2,
  freeSplit,
);
const tieredSplit = await splitVsWhole(
  {
    model: "tiered",
    meterTiers: [
      { up_to: "10", unit_amount_decimal: "100" },
      { up_to: null, unit_amount_decimal: "50" },
    ],
  },
  "split-tiered",
);
check(
  "tiered split mid-tier: 10 × 100 + 4 × 50 = 1200, split as whole",
  tieredSplit.whole === 1200 && tieredSplit.split === 1200,
  tieredSplit,
);
const volumeSplit = await splitVsWhole(
  {
    model: "volume",
    meterTiers: [
      { up_to: "10", unit_amount_decimal: "100" },
      { up_to: null, unit_amount_decimal: "50", flat_amount_minor: 7 },
    ],
  },
  "split-volume",
);
check(
  "volume on the period total: 14 × 50 + 7 = 707, split as whole",
  volumeSplit.whole === 707 && volumeSplit.split === 707,
  volumeSplit,
);
const packageSplit = await splitVsWhole(
  { model: "package", packageSize: 5, unitAmountDecimal: "100" },
  "split-package",
);
check(
  "package on the period total: 3 packages of 5 = 300, split as whole",
  packageSplit.whole === 300 && packageSplit.split === 300,
  packageSplit,
);

// ── 5. Dynamic pricing ─────────────────────────────────────────────────────────
const passthrough = await meterPrice(plainMeter.key, { amountSource: "event_amount" });
const amt = await billOnce(passthrough, plainMeter.eventName, [
  { props: { tokens: 1 }, amount: "0.015" },
  { props: { tokens: 1 }, amount: "0.02", currency: "USD" },
  { props: { tokens: 1 }, amount: "5", currency: "EUR" },
]);
check(
  "event_amount: 0.035 USD → 4 minor; the EUR event is not billed",
  amt.lines.length === 1 && Number(amt.lines[0]?.amountMinor) === 4,
  amt.lines,
);
const costPlus = await meterPrice(plainMeter.key, {
  amountSource: "event_cost",
  markupPercent: "20",
});
const cost = await billOnce(costPlus, plainMeter.eventName, [
  { props: { tokens: 1 }, cost: "0.01" },
  { props: { tokens: 1 }, cost: "0.0125" },
]);
check(
  "event_cost + 20%: 0.0225 × 1.2 = 2.7 minor → 3",
  Number(cost.lines[0]?.amountMinor) === 3,
  cost.lines,
);
check(
  "rating keeps the summed cost for margin",
  (cost.lines[0]?.rating as { cost_sum?: string })?.cost_sum === "0.0225",
  cost.lines[0]?.rating,
);
// A rate price still records the events' amount and cost on the invoice line (margin reads it).
const ratePlain = await meterPrice(plainMeter.key, { unitAmountDecimal: "1" });
const rated = await billOnce(ratePlain, plainMeter.eventName, [
  { props: { tokens: 2 }, cost: "0.01", amount: "0.03" },
  { props: { tokens: 3 }, cost: "0.0125" },
]);
const ratedRating = rated.lines[0]?.rating as { cost_sum?: string; amount_sum?: string };
check(
  "rate price: the line stores the events' real cost_sum and amount_sum",
  Number(rated.lines[0]?.amountMinor) === 5 &&
    ratedRating?.cost_sum === "0.0225" &&
    ratedRating?.amount_sum === "0.03",
  rated.lines,
);
const zeroQty = await billOnce(ratePlain, plainMeter.eventName, [
  { props: { tokens: 0 }, cost: "0.5" },
]);
check(
  "rate price, quantity 0 with a cost: the line still stores cost_sum 0.5",
  zeroQty.lines.some((l) => (l.rating as { cost_sum?: string })?.cost_sum === "0.5"),
  zeroQty.lines,
);

// ── 5b. unique counts distinct values across currencies ────────────────────────
const users = await createTestMeter(ids, { aggregation: "unique", uniqueProperty: "user" });
const perUser = await meterPrice(users.key, { unitAmountDecimal: "100" });
const uniq = await billOnce(perUser, users.eventName, [
  { props: { user: "u1" }, currency: "USD" },
  { props: { user: "u1" }, currency: "EUR" },
  { props: { user: "u2" } },
]);
check(
  "unique: u1 in two currencies and u2 → 2 users → 200 (not 3)",
  Number(uniq.lines[0]?.quantityDecimal) === 2 && Number(uniq.lines[0]?.amountMinor) === 200,
  uniq.lines,
);

// ── 5c. current_usage shows a meter item's total so far ────────────────────────
const cuCustomer = await newCustomer(ids, "cu");
const cuSub = await createSubscription({
  ...ids,
  customerId: cuCustomer.id,
  now: new Date(),
  items: [{ price: tokens, quantity: 1 }],
});
await setTerm(cuSub.subscription.id, S, new Date(Date.now() + 24 * HOUR));
for (const [tt, n] of [
  ["input", 2_000_000],
  ["output", 1_000_000],
] as const)
  await sendEvent(ids, {
    customerId: cuCustomer.id,
    eventName: ai.eventName,
    at: mid,
    properties: { model: "m-large", token_type: tt, tokens: n },
    receivedMs: Date.now(),
  });
const cu = await currentUsage({ ...ids, subscriptionId: cuSub.subscription.id });
const cuItem = cu?.items.find((i) => i.pricePublicId === tokens.publicId);
check(
  "current_usage: the meter item totals every combination up to now (600 + 1500 = 2100)",
  Number(cuItem?.amountMinor) === 2100 && Number(cuItem?.quantity) === 3_000_000,
  cuItem,
);

// ── 6. The snapshot freezes the rate card ──────────────────────────────────────
const frozen = await meterPrice(plainMeter.key, { unitAmountDecimal: "10" });
const fCustomer = await newCustomer(ids, "frozen");
const fSub = await createSubscription({
  ...ids,
  customerId: fCustomer.id,
  now: new Date(),
  items: [{ price: frozen, quantity: 1 }],
});
await updatePrice({ ...ids, pricePublicId: frozen.publicId, unitAmountDecimal: "99" });
await setTerm(fSub.subscription.id, S, E);
await sendEvent(ids, {
  customerId: fCustomer.id,
  eventName: plainMeter.eventName,
  at: mid,
  properties: { tokens: 2 },
});
await tick(biz.id);
const [fInv] = await invoicesOf(orgId, fSub.subscription.id);
check(
  "a rate edit after subscribing does not reprice the live item (20, not 198)",
  Number(usageLines(fInv?.lines ?? [])[0]?.amountMinor) === 20,
  fInv?.lines,
);

// ── 7. One live subscription per customer bills a meter ─────────────────────────
console.log("3. guard");
let conflict: unknown = null;
try {
  await createSubscription({
    ...ids,
    customerId: fCustomer.id,
    now: new Date(),
    items: [{ price: frozen, quantity: 1 }],
  });
} catch (e) {
  conflict = e;
}
check(
  "a second live subscription on the same meter → 409",
  conflict instanceof MeterBillingConflictError && conflict.statusCode === 409,
  String(conflict),
);
const apiCustomer = await newCustomer(ids, "api409");
const first = await call("POST", `/customers/${apiCustomer.publicId}/subscriptions`, {
  items: [{ price: "rc-tokens" }],
});
const second = await call("POST", `/customers/${apiCustomer.publicId}/subscriptions`, {
  items: [{ price: "rc-tokens" }],
});
check(
  "the API answers 409 with the owner and the meter",
  first.status < 300 &&
    second.status === 409 &&
    String(second.body.error?.message).includes(ai.key),
  { first: first.status, second: second.body },
);
const [before] = await systemDb
  .select()
  .from(customerMeterBilling)
  .where(
    and(
      eq(customerMeterBilling.customerId, fCustomer.id),
      eq(customerMeterBilling.meterId, plainMeter.id),
    ),
  );
await cancelSubscription({
  ...ids,
  subscriptionId: fSub.subscription.id,
  atPeriodEnd: false,
  now: new Date(),
});
const next = await createSubscription({
  ...ids,
  customerId: fCustomer.id,
  now: new Date(),
  items: [{ price: frozen, quantity: 1 }],
});
const [after] = await systemDb
  .select()
  .from(customerMeterBilling)
  .where(
    and(
      eq(customerMeterBilling.customerId, fCustomer.id),
      eq(customerMeterBilling.meterId, plainMeter.id),
    ),
  );
check(
  "after a cancel the row passes to the next subscription with its pointer (windows stay contiguous)",
  after?.subscriptionId === next.subscription.id &&
    after?.usageThrough?.getTime() === E.getTime() &&
    before?.usageThrough?.getTime() === E.getTime(),
  { before, after },
);

// ── 8. Exact period edges ──────────────────────────────────────────────────────
console.log("4. edges");
const edgeMeter = await createTestMeter(ids, { aggregation: "count" });
const edgePrice = await meterPrice(edgeMeter.key, { unitAmountDecimal: "1" });
const eCustomer = await newCustomer(ids, "edge");
const eSub = await createSubscription({
  ...ids,
  customerId: eCustomer.id,
  now: new Date(),
  items: [{ price: edgePrice, quantity: 1 }],
});
await setTerm(eSub.subscription.id, S, E);
const at07 = new Date(E.getTime() - 3 * 60_000);
await sendEvent(ids, {
  customerId: eCustomer.id,
  eventName: edgeMeter.eventName,
  at: at07,
  properties: {},
});
await sendEvent(ids, {
  customerId: eCustomer.id,
  eventName: edgeMeter.eventName,
  at: E,
  properties: {},
});
await tick(biz.id);
await setTerm(eSub.subscription.id, E, new Date(E.getTime() + HOUR));
await tick(biz.id);
const [p2, p1] = await invoicesOf(orgId, eSub.subscription.id);
const q = (x: typeof p1) => usageLines(x?.lines ?? []).map((l) => Number(l.quantityDecimal));
check(
  "a period ending at hh:10 bills the hh:07 event; the hh:10:00 event bills on the next",
  JSON.stringify(q(p1)) === "[1]" &&
    JSON.stringify(q(p2)) === "[1]" &&
    usageLines(p2?.lines ?? [])[0]?.periodStart?.getTime() === E.getTime(),
  { p1: q(p1), p2: q(p2) },
);

// ── 9. Decimals on every line ──────────────────────────────────────────────────
console.log("5. decimals");
const seat = await createPrice({
  ...ids,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  interval: "month",
  amountMinor: 250,
});
const addon = await createPrice({
  ...ids,
  productId: product.id,
  type: "recurring",
  model: "per_unit",
  currency: "USD",
  interval: "month",
  amountMinor: 1000,
});
const dCustomer = await newCustomer(ids, "dec");
const dSub = await createSubscription({
  ...ids,
  customerId: dCustomer.id,
  now: new Date(),
  items: [{ price: seat, quantity: 3 }],
});
// The renewal raises the plan line (3 seats) for the next period.
await setTerm(dSub.subscription.id, S, E);
await tick(biz.id);
await addSubscriptionItem({
  ...ids,
  subscriptionId: dSub.subscription.id,
  price: addon,
  quantity: 2,
  invoiceImmediately: true,
  now: new Date(),
});
await createInvoiceFromLines({
  ...ids,
  customerId: dCustomer.id,
  currency: "USD",
  lines: [{ description: "Setup", amountMinor: 5000n, quantity: 1 }],
});
const all = await systemDb
  .select()
  .from(invoiceLineItems)
  .where(
    sql`${invoiceLineItems.invoiceId} in (select id from invoices where customer_id = ${dCustomer.id})`,
  );
const plan = all.find((l) => l.kind === "recurring" && l.quantity === 3);
const prorated = all.find((l) => l.description !== "Setup" && l.quantity === 2);
const oneOff = all.find((l) => l.description === "Setup");
check(
  "a plan line, a proration line and a one-off charge carry quantity_decimal and unit_amount_decimal",
  Number(plan?.quantityDecimal) === 3 &&
    Number(plan?.unitAmountDecimal) === 250 &&
    Number(prorated?.quantityDecimal) === 2 &&
    prorated?.unitAmountDecimal != null &&
    Number(oneOff?.quantityDecimal) === 1 &&
    Number(oneOff?.unitAmountDecimal) === 5000,
  { plan, prorated, oneOff },
);
check("a meter line carries them too", inputLine?.quantityDecimal != null);
await systemDb
  .update(invoiceLineItems)
  .set({ quantity: 5 })
  .where(eq(invoiceLineItems.id, oneOff!.id));
const [edited] = await systemDb
  .select()
  .from(invoiceLineItems)
  .where(eq(invoiceLineItems.id, oneOff!.id));
check(
  "a quantity edit keeps quantity_decimal in step",
  Number(edited?.quantityDecimal) === 5,
  edited,
);
// An old row: written before 0454, decimals null (the trigger is bypassed to make one).
await systemDb.transaction(async (t) => {
  await t.execute(
    sql`alter table invoice_line_items disable trigger invoice_line_items_fill_decimals`,
  );
  await t.execute(
    sql`update invoice_line_items set quantity_decimal = null, unit_amount_decimal = null where id = ${oneOff!.id}`,
  );
  await t.execute(
    sql`alter table invoice_line_items enable trigger invoice_line_items_fill_decimals`,
  );
});
const oneOffInvoice = await systemDb.execute(
  sql`select i.public_id from invoices i join invoice_line_items l on l.invoice_id = i.id where l.id = ${oneOff!.id}`,
);
const invPid = (oneOffInvoice as unknown as Array<{ public_id: string }>)[0]!.public_id;
const read = await call("GET", `/invoices/${invPid}`);
const readLine = (read.body.lines ?? read.body.line_items ?? []).find(
  (l: { description: string }) => l.description === "Setup",
);
check(
  "an old row with nulls reads from the integer fields",
  readLine?.quantity_decimal === "5" && readLine?.unit_amount_decimal === "5000",
  readLine,
);
await app.close();

console.log("");
console.log(
  fails.length === 0 ? "✅ RATE CARDS: PASS" : `❌ RATE CARDS: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
