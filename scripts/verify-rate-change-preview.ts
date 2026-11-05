/**
 * Price-change preview (design G5 § 3.8, § 8): it re-rates each customer's last finalized
 * period to the minor unit, `old` equals what was invoiced even after the catalog rate changed,
 * a cheaper draft gives a negative diff, it writes nothing, and a period billed partly on
 * interim invoices is re-rated whole.
 *
 *   pnpm verify:all:fresh -- --suite rate-change-preview
 */
import { sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { previewRateChange } from "@/modules/usage-controls/rate-change-preview";
import {
  putPlanUsageThreshold,
  raiseInterimInvoice,
} from "@/modules/usage-controls/threshold-invoicing";
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
const { org, orgId, biz, ids, product } = await meterBusiness("Rate Preview Org");
const HOUR = 3_600_000;
const E = new Date(Math.floor((Date.now() - 3 * HOUR) / HOUR) * HOUR + 10 * 60_000);
const S = new Date(E.getTime() - 24 * HOUR);
const mid = new Date(E.getTime() - 6 * HOUR);

const meter = await createTestMeter(ids, { groupBy: ["model", "token_type"] });
const price = await createPrice({
  ...ids,
  productId: product.id,
  id: `rcp-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: meter.key,
  unitAmountDecimal: "300",
  quantityDivisor: "1000000",
  rates: [
    { match: { token_type: "input" }, unitAmountDecimal: "300" },
    { match: { token_type: "output" }, unitAmountDecimal: "1500" },
  ],
});

async function billed(tag: string, events: Array<Record<string, string | number>>) {
  const customer = await newCustomer(ids, tag);
  const sub = await createSubscription({
    ...ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, S, E);
  for (const props of events)
    await sendEvent(ids, {
      customerId: customer.id,
      eventName: meter.eventName,
      at: mid,
      properties: props,
    });
  await tick(biz.id);
  const [latest] = await invoicesOf(orgId, sub.subscription.id);
  const invoiced = usageLines(latest?.lines ?? []).reduce((a, l) => a + Number(l.amountMinor), 0);
  return { customer, invoiced, status: latest?.inv.status };
}

// $3 / 1M input, $15 / 1M output: 1,234,567 input → 370, 456,789 output → 685.
const c1 = await billed("rcp-1", [
  { model: "m-large", token_type: "input", tokens: 1_234_567 },
  { model: "m-large", token_type: "output", tokens: 456_789 },
]);
const c2 = await billed("rcp-2", [{ model: "m-small", token_type: "input", tokens: 2_000_000 }]);
check(
  "the periods were invoiced (1055 and 600)",
  c1.invoiced === 1055 && c2.invoiced === 600,
  [c1, c2].map((c) => [c.invoiced, c.status]),
);

const app = await buildApp({ logger: false });
let n = 0;
async function call(method: "POST" | "PATCH", url: string, payload: unknown) {
  const res = await app.inject({
    method,
    url: `/v1/businesses/${biz.publicId}${url}`,
    headers: {
      authorization: `Bearer ${org.secret}`,
      "idempotency-key": `rcp-${Date.now()}-${n++}`,
    },
    payload: payload as object,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

// The catalog rate changes after the periods were invoiced: live items keep their snapshot.
const patched = await call("PATCH", `/prices/${price.publicId}`, {
  rates: [
    { match: { token_type: "input" }, unit_amount_decimal: "999" },
    { match: { token_type: "output" }, unit_amount_decimal: "1500" },
  ],
});
check("the catalog rate changed (200)", patched.status === 200, patched);

// ── 1. Re-rated to the minor unit ──────────────────────────────────────────────
console.log("1. re-rate");
const draft = {
  rates: [
    { match: { token_type: "input" }, unit_amount_decimal: "600" },
    { match: { token_type: "output" }, unit_amount_decimal: "1500" },
  ],
};
const p = await call("POST", `/prices/${price.publicId}/rate_change_preview`, draft);
const row = (cus: string) => p.body.data?.find((r: { customer: string }) => r.customer === cus);
const r1 = row(c1.customer.publicId);
const r2 = row(c2.customer.publicId);
check("the preview answers 200", p.status === 200, p.body);
check(
  "old equals the invoiced amount (the item's own rate, not the new catalog rate)",
  r1?.old_minor === 1055 && r2?.old_minor === 600,
  [r1, r2],
);
check(
  "new rates to the cent: 1,234,567 × 600 / 1M = 741 (+685), 2,000,000 → 1200",
  r1?.new_minor === 1426 && r2?.new_minor === 1200,
  [r1, r2],
);
check(
  "totals and diff",
  p.body.totals?.old_minor === 1655 &&
    p.body.totals?.new_minor === 2626 &&
    p.body.totals?.diff_minor === 971,
  p.body.totals,
);
check(
  "largest increase first",
  p.body.data?.[0]?.customer === c2.customer.publicId,
  p.body.data?.map((r: { customer: string }) => r.customer),
);

const cheaper = await call("POST", `/prices/${price.publicId}/rate_change_preview`, {
  rates: [
    { match: { token_type: "input" }, unit_amount_decimal: "150" },
    { match: { token_type: "output" }, unit_amount_decimal: "1500" },
  ],
});
const cr1 = cheaper.body.data?.find(
  (r: { customer: string }) => r.customer === c1.customer.publicId,
);
check(
  "a cheaper draft gives a negative diff to the minor unit (185 − 370 = −185)",
  cr1?.diff_minor === -185 && cr1?.diff_bps === -1754,
  cr1,
);

const badDraft = await call("POST", `/prices/${price.publicId}/rate_change_preview`, {
  rates: [{ match: { region: "eu" }, unit_amount_decimal: "1" }],
});
check(
  "a rate card the price could not take is refused (400)",
  badDraft.status === 400,
  badDraft.body,
);

// ── 2. Writes nothing ──────────────────────────────────────────────────────────
console.log("2. writes nothing");
const TABLES = [
  "invoices",
  "invoice_line_items",
  "events",
  "usage_events",
  "subscriptions",
  "subscription_items",
  "customer_meter_billing",
  "prices",
  "price_rates",
  "ledger_entries",
];
async function counts() {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const r = (await systemDb.execute(
      sql`select count(*)::int as n from ${sql.identifier(t)} where organization_id = ${orgId}`,
    )) as unknown as Array<{ n: number }>;
    out[t] = r[0]!.n;
  }
  return out;
}
const before = await counts();
const direct = await previewRateChange({
  organizationId: orgId,
  businessId: biz.id,
  pricePublicId: price.publicId,
  draft: { unitAmountDecimal: "450" },
});
const after = await counts();
check("the preview ran", direct.rows.length === 2, direct.rows.length);
check("no row changed in any billing table", JSON.stringify(before) === JSON.stringify(after), {
  before,
  after,
});

// ── 3. A period billed partly on interim invoices is re-rated whole ──────────────
console.log("3. interim invoices");
{
  const ai = await createProduct({ ...ids, name: "AI tiered" });
  const tm = await createTestMeter(ids);
  const tiered = await createPrice({
    ...ids,
    productId: ai.id,
    id: `rcp-tiered-${Date.now()}`,
    type: "recurring",
    model: "tiered",
    currency: "USD",
    interval: "month",
    meter: tm.key,
    meterTiers: [
      { up_to: "10", unit_amount_decimal: "100" },
      { up_to: null, unit_amount_decimal: "50" },
    ],
  } as Parameters<typeof createPrice>[0]);
  await putPlanUsageThreshold({
    ...ids,
    productPublicId: ai.publicId,
    currency: "USD",
    amountMinor: 500n,
  });
  const customer = await newCustomer(ids, "rcp-interim");
  const { subscription: sub } = await createSubscription({
    ...ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price: tiered, quantity: 1 }],
  });
  await setTerm(sub.id, S, E);
  const usage = (t: Date, tokens: number) =>
    sendEvent(ids, {
      customerId: customer.id,
      eventName: tm.eventName,
      at: t,
      properties: { tokens },
    });
  // 8 tokens (800) billed early, 8 more at period end: 10 × 100 + 6 × 50 = 1,300 in all.
  await usage(new Date(S.getTime() + 2 * HOUR), 8);
  const r = await raiseInterimInvoice({ ...ids, subscriptionId: sub.id, now: mid });
  await usage(new Date(mid.getTime() + HOUR), 8);
  await tick(biz.id);
  const invs = await invoicesOf(orgId, sub.id);
  const billedAll = invs.reduce(
    (a, x) => a + usageLines(x.lines).reduce((b, l) => b + Number(l.amountMinor), 0),
    0,
  );
  check(
    "one interim invoice, and 1,300 invoiced over the period",
    r.outcome === "raised" && billedAll === 1300,
    {
      outcome: r.outcome,
      billedAll,
    },
  );
  const pv = await previewRateChange({
    organizationId: orgId,
    businessId: biz.id,
    pricePublicId: tiered.publicId,
    draft: {
      tiers: [
        { up_to: "10", unit_amount_decimal: "80" },
        { up_to: null, unit_amount_decimal: "40" },
      ],
    },
  });
  const row = pv.rows.find((x) => x.customer === customer.publicId);
  check(
    "each row names the customer (here its email: it has no name)",
    row?.customerName === customer.email,
    row?.customerName,
  );
  check(
    "the preview re-rates all 16 tokens: old 1,300, new 10 × 80 + 6 × 40 = 1,040",
    row?.oldMinor === 1300n && row?.newMinor === 1040n,
    { old: row?.oldMinor, new: row?.newMinor },
  );
}

await app.close();
console.log("");
console.log(
  fails.length === 0
    ? "✅ RATE CHANGE PREVIEW: PASS"
    : `❌ RATE CHANGE PREVIEW: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
