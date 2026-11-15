/**
 * Cost-only usage and margin (scope=all of the usage margin report):
 *  C1 a flat-plan customer whose meter has no usage price: cost from the event's own cost, your
 *     cost and the list goes to the daily fold; the report shows plan revenue − that cost, by
 *     customer, plan, meter and model; an event with no cost and no price counts as without cost;
 *  C2 a billed usage line is counted once (no double count with the fold), and scope=billed
 *     returns what the report returned before (a frozen copy of the old query, same data);
 *  C3 a late event restates its day; a voided invoice moves its usage to cost only;
 *  C4 two currencies are not summed; two plans → two rows; no live subscription → the no-plan row;
 *  C5 a second organization's usage never shows.
 *
 *   pnpm verify:cost-margin
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { foldUsageCostDays } from "@/modules/metering/cost-fold";
import { restateTrailingDays } from "@/modules/metrics/daily/maintenance";
import { meters, subscriptionItems, subscriptions, usageCostDaily } from "@db/schema";
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
const tag = randomBytes(3).toString("hex");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Fixture days: three and two UTC days before today (the business zone is UTC).
const now = new Date();
const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const D1 = new Date(midnight - 3 * DAY);
const D2 = new Date(midnight - 2 * DAY);
const d1 = D1.toISOString().slice(0, 10);
const d2 = D2.toISOString().slice(0, 10);
const at = (day: Date, h: number) => new Date(day.getTime() + h * HOUR);

const A = await meterBusiness("Cost Margin Org");
const { org, orgId, biz, ids, product: usageProduct } = A;
const app = await buildApp({ logger: false });
let n = 0;
async function call(method: "GET" | "POST", url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: { authorization: `Bearer ${org.secret}`, "idempotency-key": `cm-${tag}-${n++}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}

// ── Prices, meter, list and cost rows ──────────────────────────────────────────────
const PROVIDER = "tc";
const runId = "00000000-0000-7000-8000-000000000003";
let rowN = 0;
async function listRow(model: string, cents: string) {
  await systemDb.execute(sql`
    insert into model_price_models (provider, model) values (${PROVIDER}, ${model}) on conflict do nothing`);
  await systemDb.execute(sql`
    insert into model_prices (public_id, provider, model, token_type, currency, unit_amount_decimal,
      quantity_divisor, effective_from, source, sync_run_id)
    values (${`mpr_c${tag}${++rowN}`}, ${PROVIDER}, ${model}, 'input', 'USD', ${cents}::numeric,
      1000000, '-infinity', 'test-feed', ${runId}::uuid)`);
}
async function costRow(model: string, cents: string) {
  await systemDb.execute(sql`
    insert into model_cost_overrides (organization_id, public_id, provider, model, token_type,
      currency, unit_amount_decimal, quantity_divisor, effective_from)
    values (${orgId}, ${`mco_c${tag}${++rowN}`}, ${PROVIDER}, ${model}, 'input', 'USD',
      ${cents}::numeric, 1000000, ${new Date(D1.getTime() - 2 * DAY).toISOString()}::timestamptz)`);
}
const mE = `me-${tag}`; // event cost only
const mC = `mc-${tag}`; // your cost
const mL = `ml-${tag}`; // list
const mN = `mn-${tag}`; // no cost, no price
await listRow(mL, "300");
await costRow(mC, "200");

const chat = await createTestMeter(ids, { groupBy: ["model", "token_type"] });
await systemDb
  .update(meters)
  .set({ name: `Chat ${tag}`, priceList: { provider: PROVIDER, token_type_key: "token_type" } })
  .where(eq(meters.id, chat.id));
const flat = await createProduct({ ...ids, name: `Flat ${tag}`, kind: "plan" });
const flatUsd = await createPrice({
  ...ids,
  productId: flat.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 3900,
  interval: "month",
});
const flatInr = await createPrice({
  ...ids,
  productId: flat.id,
  type: "recurring",
  model: "flat",
  currency: "INR",
  amountMinor: 99900,
  interval: "month",
});
const listed = await createPrice({
  ...ids,
  productId: usageProduct.id,
  id: `cm-listed-${tag}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: chat.key,
  amountSource: "model_price_list",
  unitAmountDecimal: "100",
  quantityDivisor: "1000000",
  markupPercent: "20",
});

async function subscribe(
  price: Awaited<ReturnType<typeof createPrice>>,
  customerId: string,
  extra: Record<string, unknown> = {},
) {
  const sub = await createSubscription({
    ...ids,
    customerId,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    ...extra,
  });
  // Live on the fixture days.
  await systemDb
    .update(subscriptions)
    .set({ startedAt: new Date(D1.getTime() - DAY) })
    .where(eq(subscriptions.id, sub.subscription.id));
  return sub.subscription;
}
/** Invoice the subscription's first period: the plan fee. */
const billFirst = (sub: Awaited<ReturnType<typeof subscribe>>) =>
  billSubscriptionPeriod({
    ...ids,
    subscription: sub,
    periodStart: sub.currentPeriodStart!,
    periodEnd: sub.currentPeriodEnd!,
  });
const tok = (model: string, tokens: number) => ({ model, token_type: "input", tokens });
const send = (customerId: string, when: Date, props: object, cost?: string, currency?: string) =>
  sendEvent(ids, {
    customerId,
    eventName: chat.eventName,
    at: when,
    properties: props as Record<string, string | number>,
    ...(cost ? { cost } : {}),
    ...(currency ? { currency } : {}),
  });

// C1: flat plan, no usage price on the meter.
const a1 = await newCustomer(ids, "cm-a1");
await billFirst(await subscribe(flatUsd, a1.id, { autoCollection: "off" }));
await send(a1.id, at(D1, 10), tok(mE, 1000), "0.50");
await send(a1.id, at(D1, 11), tok(mE, 1000), "0.25");
await send(a1.id, at(D2, 10), tok(mC, 500_000)); // 500k × 200 ¢ / 1M = 100
await send(a1.id, at(D2, 11), tok(mL, 1_000_000)); // 1M × 300 ¢ / 1M = 300
await send(a1.id, at(D2, 12), tok(mN, 1000)); // no cost, no price
const A1_COST = 50 + 25 + 100 + 300;

// C2: billed usage on the same meter.
const b1 = await newCustomer(ids, "cm-b1");
const subB = await subscribe(listed, b1.id, { autoCollection: "off" });
await setTerm(subB.id, at(D1, 8), at(D2, 20));
// The usage price was on the subscription before the fixture days.
await systemDb
  .update(subscriptionItems)
  .set({ createdAt: new Date(D1.getTime() - DAY) })
  .where(eq(subscriptionItems.subscriptionId, subB.id));
await send(b1.id, at(D1, 10), tok(mL, 100_000), "0.40");
await send(b1.id, at(D2, 10), tok(mL, 100_000), "0.60");
const B1_COST = 100;
/** After the void: D1 only. D2 ends after the billing pointer (D2 20:00), so its live subscription will bill it. */
const B1_D1_COST = 40;

// C4: an INR flat-plan customer, and a customer with no subscription.
const e1 = await newCustomer(ids, "cm-e1");
await billFirst(await subscribe(flatInr, e1.id, { autoCollection: "off" }));
await send(e1.id, at(D1, 10), tok(mE, 1000), "10", "INR");
const n1 = await newCustomer(ids, "cm-n1");
await send(n1.id, at(D2, 10), tok(mE, 1000), "0.30");

await tick(biz.id);
// The nightly restatement folds the trailing days, these among them.
await restateTrailingDays(new Date(), { businessIds: [biz.id] });

const range = `from=${new Date(D1.getTime() - DAY).toISOString()}&to=${new Date(midnight + 2 * DAY).toISOString()}`;
type Row = Record<string, unknown> & {
  currency: string;
  revenue_minor: number;
  cost_minor: number;
  lines: number;
  lines_without_cost: number;
  total_revenue_minor?: number;
  cost_only_minor?: number;
  cost_only_rows?: number;
  cost_only_rows_without_cost?: number;
  total_cost_minor?: number;
  total_margin_minor?: number;
  total_margin_percent?: string | null;
  plan_fee_minor?: number;
  subscribers?: number;
};
const report = async (q: string) =>
  (await call("GET", `/reports/usage_margin?${range}&${q}`)).body as {
    scope: string;
    data: Row[];
    totals: Row[];
  };
const find = (r: { data: Row[] }, key: string, k: string, cur = "USD") =>
  r.data.find((x) => x[key] === k && x.currency === cur);

// ── C1 ─────────────────────────────────────────────────────────────────────────────
console.log("C1. cost-only usage on a flat plan");
const foldRows = await withTenant(orgId, (tx) =>
  tx.select().from(usageCostDaily).where(eq(usageCostDaily.customerId, a1.id)),
);
check(
  "the fold holds one row per day and group, with the line's cost bases",
  foldRows.length === 4 &&
    foldRows.some((r) => r.model === mE && r.costMinor === 75n && r.costBasis === "event") &&
    foldRows.some((r) => r.model === mC && r.costMinor === 100n && r.costBasis === "price_list") &&
    foldRows.some((r) => r.model === mL && r.costMinor === 300n && r.costBasis === "price_list") &&
    foldRows.some((r) => r.model === mN && r.costMinor === null && r.costBasis === "none"),
  foldRows.map((r) => [r.day, r.model, r.costMinor, r.costBasis]),
);
const byCus = await report(`group_by=customer&scope=all&customer=${a1.publicId}`);
const ca = byCus.data[0];
check(
  "by customer: revenue 3900 (the plan fee), cost-only = Σ cost, margin and percent",
  byCus.scope === "all" &&
    ca?.total_revenue_minor === 3900 &&
    ca?.cost_only_minor === A1_COST &&
    ca?.total_cost_minor === A1_COST &&
    ca?.total_margin_minor === 3900 - A1_COST &&
    ca?.total_margin_percent === "87.82" &&
    ca?.revenue_minor === 0 &&
    ca?.lines === 0,
  ca,
);
check(
  "an event with no cost and no price: counted as without cost, in neither side",
  ca?.cost_only_rows === 4 && ca?.cost_only_rows_without_cost === 1,
  ca,
);
const byPlan = await report("group_by=plan&scope=all&currency=USD");
const pFlat = find(byPlan, "plan", flat.publicId);
check(
  "by plan: the flat plan row has the fee, the cost and one subscriber",
  pFlat?.plan_fee_minor === 3900 &&
    pFlat?.total_revenue_minor === 3900 &&
    pFlat?.cost_only_minor === A1_COST &&
    pFlat?.subscribers === 1 &&
    pFlat?.plan_name === flat.name,
  pFlat,
);
const byMeter = await report("group_by=meter&scope=all&currency=USD");
const mRow = find(byMeter, "meter", chat.key);
check(
  "by meter: cost-only usage of every customer with revenue 0, beside the billed line",
  mRow?.cost_only_minor === A1_COST + 30 && mRow?.cost_minor === B1_COST,
  mRow,
);
check(
  "by meter: the row carries meter_name equal to the meter's name, in both scopes",
  mRow?.meter_name === `Chat ${tag}` &&
    find(await report("group_by=meter&currency=USD"), "meter", chat.key)?.meter_name ===
      `Chat ${tag}`,
  mRow,
);
const byModel = await report("group_by=model&scope=all&currency=USD");
const rE = find(byModel, "model", mE);
const rL = find(byModel, "model", mL);
check(
  "by model: a model only cost-only usage has revenue 0 and no lines (not billed)",
  rE?.revenue_minor === 0 &&
    rE?.lines === 0 &&
    rE?.total_revenue_minor === 0 &&
    rE?.cost_only_minor === 75 + 30,
  rE,
);
check(
  "by model: a model both billed and cost only keeps the two apart",
  rL?.cost_minor === B1_COST && rL?.cost_only_minor === 300 && (rL?.lines ?? 0) > 0,
  rL,
);

// ── C2 ─────────────────────────────────────────────────────────────────────────────
console.log("C2. a billed line is counted once; scope=billed is unchanged");
const [bInv] = await invoicesOf(orgId, subB.id);
const bLines = usageLines(bInv?.lines ?? []);
check(
  "the billed line carries the events' cost",
  bLines.length === 1 &&
    bLines[0]?.costMinor === BigInt(B1_COST) &&
    bLines[0]?.costBasis === "event",
  bLines.map((l) => [l.costMinor, l.costBasis]),
);
const bAll = (await report(`group_by=customer&scope=all&customer=${b1.publicId}`)).data[0];
check(
  "by customer: billed cost once, nothing cost only (the fold rows are covered)",
  bAll?.cost_minor === B1_COST && bAll?.cost_only_minor === 0 && bAll?.total_cost_minor === B1_COST,
  bAll,
);

/** The usage margin query before scope existed, frozen: what existing callers got. */
async function legacy(groupBy: "customer" | "model" | "meter") {
  const key =
    groupBy === "customer"
      ? sql`c.public_id`
      : groupBy === "meter"
        ? sql`m.key`
        : sql`coalesce(li.rating -> 'group' ->> (array_position(
              array(select jsonb_array_elements_text(li.rating -> 'group_by')),
              coalesce(m.price_list ->> 'model_key', 'model')) - 1), '')`;
  const from = new Date(D1.getTime() - DAY).toISOString();
  const to = new Date(midnight + 2 * DAY).toISOString();
  return (await withTenant(orgId, (tx) =>
    tx.execute(sql`
      with l as (
        select ${key} as k, i.currency::text as currency,
          li.amount_minor - coalesce(li.discount_minor, 0)
            - coalesce((
                select sum(ci.amount_minor) from credit_note_items ci
                join credit_notes cn on cn.id = ci.credit_note_id
                where ci.invoice_line_item_id = li.id and cn.status <> 'voided'
                  and coalesce(ci.kind, '') <> 'tax'), 0)
            - case when p.tax_behavior = 'inclusive' then coalesce((
                select sum(t.amount_minor) from applied_taxes t
                where t.invoice_line_item_id = li.id), 0) else 0 end as revenue,
          li.cost_minor,
          (li.cost_minor is not null and li.cost_basis in ('event', 'price_list', 'mixed')) as costed
        from invoice_line_items li
        join invoices i on i.id = li.invoice_id
        join customers c on c.id = i.customer_id
        join meters m on m.id = (li.rating ->> 'meter')::uuid
        left join prices p on p.id = li.price_id
        where li.business_id = ${biz.id} and i.business_id = ${biz.id}
          and not c.exclude_from_reporting
          and li.kind = 'usage' and li.rating ? 'meter'
          and i.status not in ('pending', 'voided')
          and coalesce(i.finalized_at, i.created_at) >= ${from}::timestamptz
          and coalesce(i.finalized_at, i.created_at) < ${to}::timestamptz
      )
      select k, currency,
        coalesce(sum(revenue) filter (where costed), 0)::int as revenue,
        coalesce(sum(cost_minor) filter (where costed), 0)::int as cost,
        count(*)::int as lines,
        (count(*) filter (where not costed))::int as without_cost,
        grouping(k)::int as total
      from l
      group by grouping sets ((k, currency), (currency))
      order by total, currency, k`),
  )) as unknown as Array<{
    k: string | null;
    currency: string;
    revenue: number;
    cost: number;
    lines: number;
    without_cost: number;
    total: number;
  }>;
}
const same = (
  x: Row | undefined,
  l: { revenue: number; cost: number; lines: number; without_cost: number },
) =>
  x?.revenue_minor === l.revenue &&
  x?.cost_minor === l.cost &&
  x?.margin_minor === l.revenue - l.cost &&
  x?.lines === l.lines &&
  x?.lines_without_cost === l.without_cost;
for (const g of ["customer", "model", "meter"] as const) {
  const old = await legacy(g);
  const billed = await report(`group_by=${g}`);
  const all = await report(`group_by=${g}&scope=all`);
  const oldRows = old.filter((r) => r.total === 0);
  const oldTotals = old.filter((r) => r.total === 1);
  check(
    `scope=billed (default) by ${g} = the old query, row for row`,
    billed.scope === "billed" &&
      oldRows.length > 0 &&
      billed.data.length === oldRows.length &&
      oldRows.every((o) => same(find(billed, g, o.k ?? "", o.currency), o)) &&
      oldTotals.every((o) =>
        same(
          billed.totals.find((t) => t.currency === o.currency),
          o,
        ),
      ) &&
      billed.data.every((x) => x.cost_only_minor === undefined),
    { old, billed: billed.data },
  );
  check(
    `scope=all by ${g}: the billed fields equal the old query; extra rows bill nothing`,
    oldRows.every((o) => same(find(all, g, o.k ?? "", o.currency), o)) &&
      all.data
        .filter((x) => !oldRows.some((o) => (o.k ?? "") === x[g] && o.currency === x.currency))
        .every((x) => x.lines === 0 && x.revenue_minor === 0 && x.cost_minor === 0),
    all.data,
  );
}

// ── C3 ─────────────────────────────────────────────────────────────────────────────
console.log("C3. late events and voids restate");
await send(a1.id, at(D1, 15), tok(mE, 1000), "0.10");
await foldUsageCostDays({ ...ids, days: [d1, d2], timezone: null });
const late = (await report(`group_by=customer&scope=all&customer=${a1.publicId}`)).data[0];
check(
  "a late event for an earlier day: that day restates, the cost rises by 10",
  late?.cost_only_minor === A1_COST + 10 && late?.total_margin_minor === 3900 - A1_COST - 10,
  late,
);
const voided = await call("POST", `/invoices/${bInv!.inv.publicId}/void`, {});
check("void the billed customer's invoice", voided.status === 200, voided.body);
const bVoid = (await report(`group_by=customer&scope=all&customer=${b1.publicId}`)).data[0];
check(
  "after the void: no billed cost; the day before the billing pointer is cost only, the day a live subscription will bill is not",
  bVoid?.cost_minor === 0 && bVoid?.lines === 0 && bVoid?.cost_only_minor === B1_D1_COST,
  bVoid,
);

// ── C4 ─────────────────────────────────────────────────────────────────────────────
console.log("C4. currencies, plans and no plan");
const plans = await report("group_by=plan&scope=all");
const pInr = find(plans, "plan", flat.publicId, "INR");
const pUsd = find(plans, "plan", flat.publicId, "USD");
check(
  "the INR plan row is apart from the USD one: fee 99900, cost 1000",
  pInr?.plan_fee_minor === 99900 && pInr?.cost_only_minor === 1000 && pInr?.subscribers === 1,
  pInr,
);
const usdTot = plans.totals.find((t) => t.currency === "USD");
const inrTot = plans.totals.find((t) => t.currency === "INR");
check(
  "totals per currency: INR is never added to USD",
  plans.totals.length === 2 &&
    inrTot?.cost_only_minor === 1000 &&
    usdTot?.cost_only_minor === A1_COST + 10 + 30 + B1_D1_COST,
  plans.totals,
);
const pUsage = find(plans, "plan", usageProduct.publicId);
const pNone = find(plans, "plan", "");
check(
  "two plans → two rows: the usage plan holds the billed customer",
  pUsd != null && pUsage?.subscribers === 1 && pUsage?.cost_only_minor === B1_D1_COST,
  pUsage,
);
check(
  "usage with no live subscription → the no-plan row",
  pNone?.cost_only_minor === 30 && pNone?.subscribers === 0 && pNone?.plan_name === null,
  pNone,
);

// ── C5 ─────────────────────────────────────────────────────────────────────────────
console.log("C5. tenant isolation");
const B = await meterBusiness("Cost Margin Other Org");
const otherMeter = await createTestMeter(B.ids, { groupBy: ["model"] });
const stranger = await newCustomer(B.ids, "cm-other");
await sendEvent(B.ids, {
  customerId: stranger.id,
  eventName: otherMeter.eventName,
  at: at(D1, 10),
  properties: { model: mE, tokens: 1000 },
  cost: "9.99",
});
await foldUsageCostDays({ ...B.ids, days: [d1, d2], timezone: null });
const after = await report("group_by=customer&scope=all&currency=USD");
check(
  "the other organization's usage is not in this report",
  after.totals[0]?.cost_only_minor === A1_COST + 10 + 30 + B1_D1_COST &&
    !after.data.some((x) => x.customer === stranger.publicId),
  after.totals,
);
const seen = await withTenant(orgId, (tx) =>
  tx.select().from(usageCostDaily).where(eq(usageCostDaily.businessId, B.biz.id)),
);
check("RLS: this organization cannot read the other's fold rows", seen.length === 0, seen.length);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ COST MARGIN: PASS" : `❌ COST MARGIN: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
