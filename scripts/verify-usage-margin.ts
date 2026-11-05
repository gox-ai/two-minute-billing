/**
 * Cost on usage lines, the usage margin report and the usage views (Tier 3 PR 1b, design G1b
 * M1–M6):
 *  - M1 cost to the cent (event cost + uncosted × your cost, else list; rounded once per
 *    line, never per bucket); margin = revenue after a 10 % coupon and a line credit note,
 *    BEFORE tax, − cost, per row and in total;
 *  - M2 event cost in USD on an INR line converts at the business rate; no rate → no_rate,
 *    counted in lines_without_cost and left out of both sides;
 *  - M3 group by customer, model and meter sum to one total; a voided invoice is left out;
 *  - M4 usage by day in Asia/Kolkata: 18:40 UTC is the next local day;
 *  - M5 projection at 25 % elapsed rates 4× the QUANTITY on a tiered price; at window end it
 *    equals the invoice line;
 *  - M6 the buyer never sees cost or markup; include=cost needs usage_margin:view.
 *
 *   pnpm verify:usage-margin
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { runWithClockScope } from "@/platform/clock";
import { createPrice } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { currentUsage, serializeCurrentUsage } from "@/modules/subscriptions/current-usage";
import { createCoupon, applyCouponToSubscription } from "@/modules/coupons/service";
import { createFlatTaxRate } from "@/modules/tax/service";
import { createApiKey } from "@/modules/tenancy/service";
import { businesses, creditNoteItems, meters } from "@db/schema";
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
const { org, orgId, biz, ids, product } = await meterBusiness("Usage Margin Org");
const tag = randomBytes(3).toString("hex");
const HOUR = 3_600_000;
const E = new Date(Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR + 10 * 60_000);
const S = new Date(E.getTime() - 24 * HOUR);
const at = (h: number) => new Date(S.getTime() + h * HOUR);

const app = await buildApp({ logger: false });
let n = 0;
async function call(method: "GET" | "POST", url: string, payload?: unknown, secret = org.secret) {
  const res = await app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: { authorization: `Bearer ${secret}`, "idempotency-key": `um-${Date.now()}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

const PROVIDER = "tp";
const run = "00000000-0000-7000-8000-000000000002";
let rowN = 0;
async function listRow(model: string, cents: string) {
  await systemDb.execute(sql`
    insert into model_price_models (provider, model) values (${PROVIDER}, ${model}) on conflict do nothing`);
  await systemDb.execute(sql`
    insert into model_prices (public_id, provider, model, token_type, currency, unit_amount_decimal,
      quantity_divisor, effective_from, source, sync_run_id)
    values (${`mpr_u${tag}${++rowN}`}, ${PROVIDER}, ${model}, 'input', 'USD', ${cents}::numeric,
      1000000, '-infinity', 'test-feed', ${run}::uuid)`);
}
async function costRow(model: string, cents: string) {
  await systemDb.execute(sql`
    insert into model_cost_overrides (organization_id, public_id, provider, model, token_type,
      currency, unit_amount_decimal, quantity_divisor, effective_from)
    values (${orgId}, ${`mco_u${tag}${++rowN}`}, ${PROVIDER}, ${model}, 'input', 'USD',
      ${cents}::numeric, 1000000, ${new Date(S.getTime() - 24 * HOUR).toISOString()}::timestamptz)`);
}
const mapMeter = (id: string, set: Partial<typeof meters.$inferInsert>) =>
  systemDb.update(meters).set(set).where(eq(meters.id, id));
let priceN = 0;
const price = (p: Partial<Parameters<typeof createPrice>[0]>) =>
  createPrice({
    ...ids,
    productId: product.id,
    id: `um-${++priceN}-${Date.now()}`,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    ...p,
  });
async function subscribe(p: Awaited<ReturnType<typeof price>>, customerId: string, extra = {}) {
  const sub = await createSubscription({
    ...ids,
    customerId,
    now: new Date(),
    items: [{ price: p, quantity: 1 }],
    ...extra,
  });
  await setTerm(sub.subscription.id, S, E);
  return sub.subscription;
}
const send = (
  customerId: string,
  eventName: string,
  when: Date,
  props: Record<string, string | number>,
  cost?: string,
) => sendEvent(ids, { customerId, eventName, at: when, properties: props, cost });
async function linesOf(subId: string) {
  const [latest] = await invoicesOf(orgId, subId);
  const all = latest?.lines ?? [];
  return {
    inv: latest?.inv,
    lines: usageLines(all),
    taxMinor: all.filter((l) => l.kind === "tax").reduce((a, l) => a + l.amountMinor, 0n),
  };
}

// ── Set-up for M1–M3: one tick bills every term ───────────────────────────────────
const ai = await createTestMeter(ids, { groupBy: ["model", "token_type"] });
await mapMeter(ai.id, { priceList: { provider: PROVIDER, token_type_key: "token_type" } });
const mA = `ma-${tag}`;
const mB = `mb-${tag}`;
await listRow(mA, "300");
await listRow(mB, "300");
await costRow(mA, "200"); // your cost on A only; B costs at the list
const listed = await price({
  meter: ai.key,
  amountSource: "model_price_list",
  unitAmountDecimal: "100",
  quantityDivisor: "1000000",
  markupPercent: "20",
});
await createFlatTaxRate({ ...ids, name: "GST", country: "IN", rateBps: 2000 });
const taxed = await createCustomer({
  ...ids,
  email: `m1-${Date.now()}@example.com`,
  address: { line1: "1 Road", country: "IN" },
});
await vaultPaymentMethod({ ...ids, customer: taxed, token: "tok_4242" });
const sub1 = await subscribe(listed, taxed.id);
await createCoupon({
  ...ids,
  code: `TEN${tag}`,
  kind: "percentage",
  percentOffBps: 1000,
  durationType: "forever",
});
await applyCouponToSubscription({
  ...ids,
  subscriptionId: sub1.id,
  code: `TEN${tag}`,
  now: new Date(),
});
const tok = (model: string, tokens: number) => ({ model, token_type: "input", tokens });
await send(taxed.id, ai.eventName, at(1), tok(mA, 1_000_000));
// Two costed events in different buckets: 0.4 ¢ each. Rounded per bucket they make 0.
await send(taxed.id, ai.eventName, at(2), tok(mA, 1000), "0.004");
await send(taxed.id, ai.eventName, at(4), tok(mA, 1000), "0.004");
await send(taxed.id, ai.eventName, at(5), tok(mB, 333_333));

// M2: INR lines whose event cost is in USD (and one in EUR, which has no rate).
await systemDb
  .update(businesses)
  .set({ exchangeRates: { INR: "83.5" } })
  .where(eq(businesses.id, biz.id));
const usdCost = await createTestMeter(ids, {});
await mapMeter(usdCost.id, { costCurrency: "USD" });
const eurCost = await createTestMeter(ids, {});
await mapMeter(eurCost.id, { costCurrency: "EUR" });
const inr1 = await newCustomer(ids, "m2a");
const inr2 = await newCustomer(ids, "m2b");
const sub2 = await subscribe(
  await price({ meter: usdCost.key, currency: "INR", unitAmountDecimal: "1000" }),
  inr1.id,
);
const sub2b = await subscribe(
  await price({ meter: eurCost.key, currency: "INR", unitAmountDecimal: "1000" }),
  inr2.id,
);
await send(inr1.id, usdCost.eventName, at(3), { tokens: 10 }, "1");
await send(inr2.id, eurCost.eventName, at(3), { tokens: 10 }, "1");

// M3: a second USD customer, and one whose invoice is voided.
const other = await newCustomer(ids, "m3");
const sub3 = await subscribe(listed, other.id);
await send(other.id, ai.eventName, at(6), tok(mB, 1_000_000));
const voided = await createCustomer({ ...ids, email: `m3v-${Date.now()}@example.com` });
const sub3v = await subscribe(listed, voided.id, { autoCollection: "off" });
await send(voided.id, ai.eventName, at(6), tok(mB, 5_000_000));

await tick(biz.id);

// ── M1 ───────────────────────────────────────────────────────────────────────────
console.log("M1. cost and margin to the cent");
const b1 = await linesOf(sub1.id);
const lineA = b1.lines.find((l) => (l.rating as { group?: string[] } | null)?.group?.[0] === mA);
const lineB = b1.lines.find((l) => (l.rating as { group?: string[] } | null)?.group?.[0] === mB);
check(
  "line A cost = half-up(200 + 0.4 + 0.4) = 201, basis mixed",
  lineA?.costMinor === 201n && lineA?.costBasis === "mixed",
  [lineA?.costMinor, lineA?.costBasis],
);
check(
  "line B cost = half-up(333,333 × $3.00 / 1M) = 100 at the list, basis price_list",
  lineB?.costMinor === 100n && lineB?.costBasis === "price_list",
  [lineB?.costMinor, lineB?.costBasis],
);
check("the invoice carries tax (so tax is a real trap)", b1.taxMinor > 0n, b1.taxMinor);
check(
  "the coupon reduced the usage lines",
  (lineA?.discountMinor ?? 0n) > 0n && (lineB?.discountMinor ?? 0n) > 0n,
  [lineA?.discountMinor, lineB?.discountMinor],
);
const cnBody = (kind: string) => ({
  invoice: b1.inv!.publicId,
  kind,
  items: [{ description: "Usage credit", amount_minor: 50, invoice_line_item: lineA!.publicId }],
});
let cn = await call("POST", "/credit_notes", cnBody("adjustment"));
if (cn.status !== 201) cn = await call("POST", "/credit_notes", cnBody("refundable"));
check("a partial credit note on line A", cn.status === 201, cn.body);
const credited = await systemDb
  .select({ amount: creditNoteItems.amountMinor, kind: creditNoteItems.kind })
  .from(creditNoteItems)
  .where(eq(creditNoteItems.invoiceLineItemId, lineA!.id));
const supplyCredit = credited.filter((c) => c.kind !== "tax").reduce((a, c) => a + c.amount, 0n);
check("the credit note credits line A's supply", supplyCredit > 0n, credited);
const revenue = (l: typeof lineA, credit: bigint) =>
  l!.amountMinor - (l!.discountMinor ?? 0n) - credit;
const revA = revenue(lineA, supplyCredit);
const revB = revenue(lineB, 0n);
const range = `from=${new Date(S.getTime() - 24 * HOUR).toISOString()}&to=${new Date(Date.now() + 24 * HOUR).toISOString()}`;
const byModel = await call(
  "GET",
  `/reports/usage_margin?${range}&group_by=model&currency=USD&customer=${taxed.publicId}`,
);
const rowOf = (r: typeof byModel, k: string, key: string) =>
  (r.body.data ?? []).find((x: Record<string, unknown>) => x[key] === k);
const rA = rowOf(byModel, mA, "model");
const rB = rowOf(byModel, mB, "model");
check(
  "model A: revenue = amount − coupon − credit (before tax), cost 201, margin = revenue − cost",
  rA?.revenue_minor === Number(revA) &&
    rA?.cost_minor === 201 &&
    rA?.margin_minor === Number(revA) - 201,
  { rA, revA: String(revA), supplyCredit: String(supplyCredit) },
);
check(
  "model B: revenue after the coupon, cost 100",
  rB?.revenue_minor === Number(revB) &&
    rB?.cost_minor === 100 &&
    rB?.margin_minor === Number(revB) - 100,
  { rB, revB: String(revB) },
);
const tot1 = byModel.body.totals?.[0];
check(
  "total margin = Σ revenue − Σ cost, tax excluded",
  tot1?.revenue_minor === Number(revA + revB) && tot1?.margin_minor === Number(revA + revB) - 301,
  tot1,
);

// ── M2 ───────────────────────────────────────────────────────────────────────────
console.log("M2. event cost in another currency");
const b2 = await linesOf(sub2.id);
const b2b = await linesOf(sub2b.id);
check(
  "$1.00 of event cost on an INR line = ₹83.50 at the business rate (8350), basis event",
  b2.lines[0]?.costMinor === 8350n && b2.lines[0]?.costBasis === "event",
  [b2.lines[0]?.costMinor, b2.lines[0]?.costBasis],
);
check(
  "EUR cost with no EUR rate → no_rate, cost null",
  b2b.lines[0]?.costMinor == null && b2b.lines[0]?.costBasis === "no_rate",
  [b2b.lines[0]?.costMinor, b2b.lines[0]?.costBasis],
);
const inr = await call("GET", `/reports/usage_margin?${range}&group_by=meter&currency=INR`);
const inrTot = inr.body.totals?.[0];
check(
  "INR totals: the no_rate line is counted in lines_without_cost and left out of both sides",
  inrTot?.lines === 2 &&
    inrTot?.lines_without_cost === 1 &&
    inrTot?.cost_minor === 8350 &&
    inrTot?.revenue_minor === Number(b2.lines[0]!.amountMinor - (b2.lines[0]!.discountMinor ?? 0n)),
  inr.body,
);

// ── M3 ───────────────────────────────────────────────────────────────────────────
console.log("M3. groupings agree; a voided invoice is left out");
const v = await linesOf(sub3v.id);
const voidRes = await call("POST", `/invoices/${v.inv?.publicId}/void`, {});
check("void the third customer's invoice", voidRes.status === 200, voidRes.body);
const totals: Array<{ g: string; rev: number; cost: number; total?: { revenue_minor: number } }> =
  [];
for (const g of ["customer", "model", "meter"]) {
  const r = await call("GET", `/reports/usage_margin?${range}&group_by=${g}&currency=USD`);
  const sum = (r.body.data ?? []).reduce(
    (a: { rev: number; cost: number }, x: { revenue_minor: number; cost_minor: number }) => ({
      rev: a.rev + x.revenue_minor,
      cost: a.cost + x.cost_minor,
    }),
    { rev: 0, cost: 0 },
  );
  totals.push({ g, ...sum, total: r.body.totals?.[0] });
}
check(
  "customer, model and meter rows each sum to the same total",
  totals.every(
    (t) =>
      t.rev === totals[0]!.rev && t.cost === totals[0]!.cost && t.rev === t.total?.revenue_minor,
  ),
  totals,
);
const b3 = await linesOf(sub3.id);
check(
  "the voided invoice is not in the report",
  totals[0]!.rev === Number(revA + revB + revenue(b3.lines[0], 0n)),
  { got: totals[0]!.rev, voided: String(v.lines[0]?.amountMinor) },
);

// ── M4 ───────────────────────────────────────────────────────────────────────────
console.log("M4. days in the business time zone");
await systemDb
  .update(businesses)
  .set({ timezone: "Asia/Kolkata" })
  .where(eq(businesses.id, biz.id));
const day = new Date(
  Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 3),
);
const late = new Date(day.getTime() + 18 * HOUR + 40 * 60_000); // 00:10 IST the next day
const dayCus = await newCustomer(ids, "m4");
await send(dayCus.id, ai.eventName, late, tok(mA, 42));
const nextDay = new Date(day.getTime() + 24 * HOUR).toISOString().slice(0, 10);
const hist = await call(
  "GET",
  `/customers/${dayCus.publicId}/usage?from=${day.toISOString()}&to=${new Date(day.getTime() + 48 * HOUR).toISOString()}&meter=${ai.key}&include=cost`,
);
check(
  "18:40 UTC lands on the next day in Asia/Kolkata",
  hist.status === 200 &&
    hist.body.data?.length === 1 &&
    hist.body.data[0].date === nextDay &&
    hist.body.data[0].quantity === "42" &&
    hist.body.time_zone === "Asia/Kolkata",
  hist.body,
);
const tooLong = await call(
  "GET",
  `/customers/${dayCus.publicId}/usage?from=${new Date(Date.now() - 100 * 24 * HOUR).toISOString()}&to=${new Date().toISOString()}`,
);
check("a range over 92 days → 400", tooLong.status === 400, tooLong.body);

// ── M5 ───────────────────────────────────────────────────────────────────────────
console.log("M5. projection rates a quantity");
const plain = await createTestMeter(ids, {});
const tiered = await price({
  meter: plain.key,
  model: "tiered",
  meterTiers: [
    { up_to: "1000", unit_amount_decimal: "100" },
    { up_to: null, unit_amount_decimal: "50" },
  ],
});
const c5 = await newCustomer(ids, "m5");
const sub5 = await subscribe(tiered, c5.id);
await send(c5.id, plain.eventName, at(1), { tokens: 1000 });
const view = (now: Date) =>
  runWithClockScope({ onlyBusinessId: biz.id, now }, () =>
    currentUsage({ ...ids, subscriptionId: sub5.id, includeProjection: true }),
  );
const q = await view(at(6)); // 25 % of the day
const item = q?.items[0];
check(
  "25 % elapsed, 1,000 units → 4,000 projected, rated on the tiers (100,000 + 3,000 × 50)",
  item?.projection?.quantity === 4000n && item?.projection?.amountMinor === 250_000n,
  item?.projection,
);
const atEnd = await view(E);
await tick(biz.id);
const b5 = await linesOf(sub5.id);
check(
  "at window end the projection equals the invoice line",
  atEnd?.items[0]?.projection?.amountMinor === b5.lines[0]?.amountMinor &&
    b5.lines[0]?.amountMinor === 100_000n,
  [atEnd?.items[0]?.projection, b5.lines[0]?.amountMinor],
);

// ── M6 ───────────────────────────────────────────────────────────────────────────
console.log("M6. the buyer never sees cost");
const c6 = await newCustomer(ids, "m6");
const sub6 = await subscribe(listed, c6.id);
await setTerm(sub6.id, new Date(Date.now() - 6 * HOUR), new Date(Date.now() + 18 * HOUR));
await send(c6.id, ai.eventName, new Date(Date.now() - HOUR), tok(mA, 1000));
const v6 = await currentUsage({ ...ids, subscriptionId: sub6.id, includeProjection: false });
const portal = JSON.stringify(serializeCurrentUsage(v6!, { portal: true }));
check(
  "portal current usage: per-model amounts, no cost, markup or price rows",
  portal.includes(mA) && !/cost|markup|segments|model_price/.test(portal),
  portal,
);
check(
  "with the projection flag off nothing is projected",
  v6!.projection == null &&
    v6!.items.every((i) => i.combinations?.every((c) => c.projection == null)),
);
const staff = JSON.stringify(serializeCurrentUsage(v6!, { showCost: true }));
check(
  "staff with usage_margin:view see the cost of usage so far",
  staff.includes('"cost_minor"'),
  staff,
);
const narrow = await createApiKey(orgId, "test", "api", "read", null, null, {
  usage: "read",
  invoices: "read",
});
const wide = await createApiKey(orgId, "test", "api", "read", null, null, {
  usage: "read",
  usage_margin: "read",
});
const cus6 = `/customers/${c6.publicId}/usage?from=${new Date(Date.now() - 24 * HOUR).toISOString()}&to=${new Date().toISOString()}`;
const denied = await call("GET", `${cus6}&include=cost`, undefined, narrow.secret);
const allowed = await call("GET", `${cus6}&include=cost`, undefined, wide.secret);
check("include=cost without usage_margin:view → 403", denied.status === 403, denied.body);
check(
  "include=cost with usage_margin:view → cost per day",
  allowed.status === 200 && allowed.body.data?.[0]?.cost_basis != null,
  allowed.body,
);
const invNarrow = await call("GET", `/invoices/${b1.inv!.publicId}`, undefined, narrow.secret);
const invText = JSON.stringify(invNarrow.body);
check(
  "an invoice read without usage_margin:view shows no cost and no cost row",
  invNarrow.status === 200 && !invText.includes("cost_minor") && !invText.includes("mco_"),
  invNarrow.status,
);
const marginDenied = await call("GET", `/reports/usage_margin?${range}`, undefined, narrow.secret);
check("the margin report needs usage_margin:view", marginDenied.status === 403, marginDenied.body);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ USAGE MARGIN: PASS" : `❌ USAGE MARGIN: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
