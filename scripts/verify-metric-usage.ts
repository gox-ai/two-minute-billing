/**
 * Oracle gate for the usage measures (`usage-measures.ts`) and the meter split of
 * `revenue_billed`. Hand-worked, June 2026 (30 days; the window before it is 2 May–31 May):
 *   rollups  June: A tokens 10 events, A images 3, A seats (max) 2, B tokens 5 → 20 events, 2 customers
 *            May:  A tokens 4 events (outside June)
 *   invoices May 15: A usage 3000 (tokens)            → A had 3000 before June
 *            June 10: A usage 4500 (tokens), cost 1500  → retained 4500 of 3000 = 15000 bps
 *            June 12: B usage 2000 (images), no cost    → B is new, not in retention
 *            June 20: B commitment true-up 800 (a voided one of 500 is out) → shortfall 800
 *   quantity June: tokens (sum) 1000 + 500, images (count) 3 events; a `max` meter has none
 *   stopped  as of 15 Sep: A (last 6 Jun) and B (7 Jun) stopped; C sent usage on 10 Sep → 2
 *   top consumers (12 months to 15 Sep): A 3000 + 4500, units tokens 1400, images 3;
 *            B 2000, tokens 500; C no revenue, tokens 50 → ranked A, B, C
 *   pacing   15 Sep 12:00, terms 1 Sep–1 Oct, commitment 30000 → due 30000 × 14.5 ÷ 30 = 14500;
 *            A counted 13000 → 8965 bps, on pace; B counted 5000 → 3448 bps, under pace
 *            terms 16 Aug–16 Sep, commitment 10000 → due 10000 × 30.5 ÷ 31 = 9839; usage at
 *            100/unit not invoiced: C 300 units → 30490 bps over; D 4000 invoiced + 50 units →
 *            9147 bps on; E volume price, 3000 invoiced → 3049 bps, pace at term end
 *
 *   pnpm verify:metric-usage
 */
import { sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { assertRegistryImplemented, computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { MEASURES, measureById, ratioValue } from "@/modules/metrics/daily/measures";
import { ensureUsageMonth } from "@/modules/metering/partitions";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import { createPrice, createProduct } from "@/modules/catalog/service";
import { snapshotPrice } from "@/modules/catalog/pricing";
import { recordUsage } from "@/modules/metering/service";
import { invoiceLineItems, invoices, meters, subscriptionItems, subscriptions } from "@db/schema";

const checks: Array<[string, boolean, string?]> = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const stamp = Date.now();
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date("2026-09-15T12:00:00.000Z");

const org = await createOrganization({ name: "Usage Measure Oracle Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Usage Measure Oracle Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;
const mk = (k: string) =>
  createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `usage-${k}-${stamp}@example.test`,
  });
const [a, b, c] = [await mk("a"), await mk("b"), await mk("c")];

const [tokens, images, seats] = await withTenant(orgId, (tx) =>
  tx
    .insert(meters)
    .values([
      {
        organizationId: orgId,
        businessId: bizId,
        key: `tokens-${stamp}`,
        name: "Tokens",
        eventName: "tokens",
        aggregation: "sum",
        valueProperty: "n",
      },
      {
        organizationId: orgId,
        businessId: bizId,
        key: `images-${stamp}`,
        name: "Images",
        eventName: "images",
        aggregation: "count",
      },
      {
        organizationId: orgId,
        businessId: bizId,
        key: `seats-${stamp}`,
        name: "Seats",
        eventName: "seats",
        aggregation: "max",
        valueProperty: "n",
      },
    ])
    .returning({ id: meters.id }),
);

// Rollups are partitioned by month; a fresh database has none for the fixture's months.
await ensureUsageMonth(at("2026-05-01"));
await ensureUsageMonth(at("2026-06-01"));
await ensureUsageMonth(at("2026-09-01"));

async function rollup(
  customerId: string,
  meterId: string,
  day: string,
  events: number,
  value: number,
) {
  await withTenant(orgId, (tx) =>
    tx.execute(sql`insert into usage_rollups
      (organization_id, business_id, customer_id, meter_id, bucket_start, generation, event_count, value_sum)
      values (${orgId}, ${bizId}, ${customerId}, ${meterId}, ${`${day}T00:00:00Z`}::timestamptz, 0, ${events}, ${value})`),
  );
}
await rollup(a.id, tokens!.id, "2026-06-05", 10, 1000);
await rollup(a.id, images!.id, "2026-06-06", 3, 3);
await rollup(b.id, tokens!.id, "2026-06-07", 5, 500);
await rollup(a.id, tokens!.id, "2026-05-20", 4, 400);
await rollup(a.id, seats!.id, "2026-06-06", 2, 7);
await rollup(c.id, tokens!.id, "2026-09-10", 50, 50);

let seq = 0;
async function usageInvoice(
  customerId: string,
  day: string,
  amount: number,
  meterId: string,
  cost: number | null,
) {
  await withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId,
        publicId: `inv_usage_oracle_${++seq}_${stamp}`,
        status: "paid",
        currency: "USD",
        subtotalMinor: BigInt(amount),
        totalMinor: BigInt(amount),
        createdAt: at(day),
      })
      .returning({ id: invoices.id });
    await tx.insert(invoiceLineItems).values({
      organizationId: orgId,
      businessId: bizId,
      invoiceId: inv!.id,
      publicId: `il_usage_oracle_${seq}_${stamp}`,
      description: "usage",
      quantity: 1,
      unitAmountMinor: BigInt(amount),
      amountMinor: BigInt(amount),
      kind: "usage",
      rating: { meter: meterId },
      costMinor: cost == null ? null : BigInt(cost),
      costBasis: cost == null ? null : "event",
      createdAt: at(day),
    });
  });
}
await usageInvoice(a.id, "2026-05-15", 3000, tokens!.id, null);
await usageInvoice(a.id, "2026-06-10", 4500, tokens!.id, 1500);
await usageInvoice(b.id, "2026-06-12", 2000, images!.id, null);

/** An invoice with one recurring line; `adjustment` marks a commitment true-up. */
async function feeInvoice(
  customerId: string,
  day: string,
  amount: number,
  opts: { status?: string; adjustment?: string; subscriptionId?: string; periodStart?: string },
) {
  await withTenant(orgId, async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId,
        publicId: `inv_usage_oracle_${++seq}_${stamp}`,
        status: opts.status ?? "paid",
        currency: "USD",
        subtotalMinor: BigInt(amount),
        totalMinor: BigInt(amount),
        subscriptionId: opts.subscriptionId ?? null,
        createdAt: at(day),
      })
      .returning({ id: invoices.id });
    await tx.insert(invoiceLineItems).values({
      organizationId: orgId,
      businessId: bizId,
      invoiceId: inv!.id,
      publicId: `il_usage_oracle_${seq}_${stamp}`,
      description: "fee",
      quantity: 1,
      unitAmountMinor: BigInt(amount),
      amountMinor: BigInt(amount),
      kind: "recurring",
      adjustment: opts.adjustment ?? null,
      periodStart: opts.periodStart ? at(opts.periodStart) : null,
      createdAt: at(day),
    });
  });
}
await feeInvoice(b.id, "2026-06-20", 800, { adjustment: "commitment" });
await feeInvoice(b.id, "2026-06-21", 500, { adjustment: "commitment", status: "voided" });

const committed = async (customerId: string, counted: number) => {
  const [sub] = await withTenant(orgId, (tx) =>
    tx
      .insert(subscriptions)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId,
        publicId: `sub_usage_oracle_${++seq}_${stamp}`,
        status: "active",
        currency: "USD",
        billingPeriod: 1,
        billingPeriodUnit: "month",
        currentPeriodStart: at("2026-09-01"),
        currentPeriodEnd: at("2026-10-01"),
        commitmentAmountMinor: 30000n,
      })
      .returning({ id: subscriptions.id, publicId: subscriptions.publicId }),
  );
  await feeInvoice(customerId, "2026-09-02", counted, {
    subscriptionId: sub!.id,
    periodStart: "2026-09-01",
  });
  return sub!.publicId;
};
const subA = await committed(a.id, 13000);
const subB = await committed(b.id, 5000);

// Usage billed in arrears: rated so far and not invoiced, it counts toward the pace (D11).
// Term 16 Aug – 16 Sep, so at 15 Sep 12:00 the $100 commitment is due 10000 × 30.5 ÷ 31 = 9839.
const usageProduct = await createProduct({
  organizationId: orgId,
  businessId: bizId,
  name: "API calls",
  kind: "addon",
});
const usagePrice = (over: Partial<Parameters<typeof createPrice>[0]> = {}) =>
  createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: usageProduct.id,
    type: "recurring",
    model: "usage",
    usageAggregation: "sum",
    currency: "USD",
    amountMinor: 100,
    interval: "month",
    ...over,
  });
const perUnit = await usagePrice();
const volume = await usagePrice({
  model: "volume",
  amountMinor: undefined,
  tiers: [
    { upToMinor: 100, unitAmountMinor: 100 },
    { upToMinor: null, unitAmountMinor: 50 },
  ],
});
const arrears = async (
  tag: string,
  invoiced: number,
  price: Awaited<ReturnType<typeof usagePrice>>,
  units: number,
) => {
  const cus = await mk(tag);
  const [sub] = await withTenant(orgId, (tx) =>
    tx
      .insert(subscriptions)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId: cus.id,
        publicId: `sub_usage_oracle_${++seq}_${stamp}`,
        status: "active",
        currency: "USD",
        billingPeriod: 1,
        billingPeriodUnit: "month",
        currentPeriodStart: at("2026-08-16"),
        currentPeriodEnd: at("2026-09-16"),
        commitmentAmountMinor: 10000n,
      })
      .returning({ id: subscriptions.id, publicId: subscriptions.publicId }),
  );
  const [item] = await withTenant(orgId, (tx) =>
    tx
      .insert(subscriptionItems)
      .values({
        organizationId: orgId,
        businessId: bizId,
        subscriptionId: sub!.id,
        publicId: `si_usage_oracle_${++seq}_${stamp}`,
        priceId: price.id,
        priceSnapshot: snapshotPrice(price),
      })
      .returning({ id: subscriptionItems.id }),
  );
  await recordUsage({
    organizationId: orgId,
    businessId: bizId,
    subscriptionItemId: item!.id,
    quantity: units,
    timestamp: at("2026-09-01"),
  });
  if (invoiced > 0)
    await feeInvoice(cus.id, "2026-08-17", invoiced, {
      subscriptionId: sub!.id,
      periodStart: "2026-08-16",
    });
  return sub!.publicId;
};
// $300 of usage, none invoiced: over pace.
const subC = await arrears("arrears-only", 0, perUnit, 300);
// $40 invoiced + $50 of usage so far: on pace.
const subD = await arrears("arrears-mixed", 4000, perUnit, 50);
// A volume price settles at the closing total: invoiced fees only, pace at term end.
const subE = await arrears("arrears-volume", 3000, volume, 80);

let paired = true;
try {
  assertRegistryImplemented();
} catch (e) {
  paired = false;
  console.error(e);
}
ok("registry: the usage measures are declared and implemented with their slices", paired);
ok("registry: seven usage measures", MEASURES.filter((m) => m.source === "usage").length === 7);

const rows = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "month", "2026-06-30", NOW),
);
const g = (m: string, dim = "", v = "", cur = "USD") =>
  rows.find((r) => r.measure === m && r.dim === dim && r.dimValue === v && r.currency === cur);
const val = (m: string, dim = "", v = "", cur = "USD") => g(m, dim, v, cur)?.value ?? null;

ok("events: 10 + 3 + 2 + 5 in June (May's 4 are out)", val("usage_events", "", "", "XXX") === 20n);
ok(
  "events: tokens 15, images 3",
  val("usage_events", "meter", tokens!.id, "XXX") === 15n &&
    val("usage_events", "meter", images!.id, "XXX") === 3n,
);
ok("customers with usage: 2", val("usage_customers", "", "", "XXX") === 2n);
ok(
  "cost: the one costed line, 1500",
  val("usage_cost") === 1500n && val("usage_cost", "meter", tokens!.id) === 1500n,
);
const ret = g("usage_revenue_retention");
ok(
  "retention: A kept 4500 of 3000 → 15000 bps; B is new and not counted",
  ret?.value === 4500n &&
    ret?.denominator === 3000n &&
    ratioValue(measureById("usage_revenue_retention")!, ret.value, ret.denominator) === 15000,
);
ok(
  "revenue billed: the meter split covers usage lines — tokens 4500, images 2000",
  val("revenue_billed", "meter", tokens!.id) === 4500n &&
    val("revenue_billed", "meter", images!.id) === 2000n,
);
ok("revenue billed: usage type 6500", val("revenue_billed", "revenue_type", "usage") === 6500n);
ok(
  "usage quantity: tokens 1000 + 500 summed, images 3 counted; the max meter has no row",
  val("usage_quantity", "meter", tokens!.id, "XXX") === 1500n &&
    val("usage_quantity", "meter", images!.id, "XXX") === 3n &&
    g("usage_quantity", "meter", seats!.id, "XXX") === undefined,
);
ok("usage quantity: no total across meters", g("usage_quantity", "", "", "XXX") === undefined);
ok(
  "commitment shortfall: the billed 800; the voided 500 is out",
  val("commitment_shortfall") === 800n,
);
ok(
  "customers stopped: a past period carries no reading",
  g("usage_customers_stopped", "", "", "XXX") === undefined,
);
const today = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "day", "2026-09-15", NOW),
);
ok(
  "customers stopped: A and B sent nothing in 30 days; C sent usage on 10 Sep",
  today.find((r) => r.measure === "usage_customers_stopped")?.value === 2n,
);

const top = await resolveReport(orgId, bizId, "top_usage_consumers", { now: NOW });
const row = (pub: string) => top.grid?.rows.find((r) => r.group_id === pub)?.values;
const tokensCol = top.grid?.columns.findIndex((col) => col.key === tokens!.id) ?? -1;
const imagesCol = top.grid?.columns.findIndex((col) => col.key === images!.id) ?? -1;
ok(
  "top consumers: ranked A, B, C by usage revenue, then events",
  JSON.stringify(top.rows?.map((r) => r.group_id)) ===
    JSON.stringify([a.publicId, b.publicId, c.publicId]) &&
    JSON.stringify(top.rows?.map((r) => r.value)) === JSON.stringify([7500, 2000, 0]),
);
ok(
  "top consumers: units per additive meter; the max meter has no column",
  row(a.publicId)?.[tokensCol] === 1400 &&
    row(a.publicId)?.[imagesCol] === 3 &&
    row(b.publicId)?.[tokensCol] === 500 &&
    row(c.publicId)?.[tokensCol] === 50 &&
    !top.grid?.columns.some((col) => col.key === seats!.id),
);

const pacing = await resolveReport(orgId, bizId, "commitment_pacing", { now: NOW });
const paced = (pub: string) => pacing.grid?.rows.find((r) => r.values[0] === pub)?.values;
ok(
  "pacing: due so far is 30000 × 14.5 ÷ 30 days = 14500",
  paced(subA)?.[2] === 14500 && paced(subA)?.[3] === 30000,
);
ok(
  "pacing: A counted 13000 → 8965 bps on pace; B 5000 → 3448 bps under pace",
  paced(subA)?.[1] === 13000 &&
    paced(subA)?.[4] === 8965 &&
    paced(subA)?.[5] === "On pace" &&
    paced(subB)?.[4] === 3448 &&
    paced(subB)?.[5] === "Under pace",
);
ok(
  "pacing: unbilled usage of $300 on a $100 commitment due 9839 → 30490 bps, over pace",
  paced(subC)?.[1] === 30000 &&
    paced(subC)?.[2] === 9839 &&
    paced(subC)?.[4] === 30490 &&
    paced(subC)?.[5] === "Over pace" &&
    paced(subC)?.[6] === 30000,
  JSON.stringify(paced(subC)),
);
ok(
  "pacing: mixed, 4000 invoiced + 5000 usage so far = 9000 → 9147 bps, on pace",
  paced(subD)?.[1] === 9000 &&
    paced(subD)?.[4] === 9147 &&
    paced(subD)?.[5] === "On pace" &&
    paced(subD)?.[6] === 5000,
  JSON.stringify(paced(subD)),
);
ok(
  "pacing: a volume price counts invoiced fees only (3000 → 3049 bps) and shows pace at term end",
  paced(subE)?.[1] === 3000 &&
    paced(subE)?.[4] === 3049 &&
    paced(subE)?.[5] === "Pace shown at term end" &&
    paced(subE)?.[6] === 0,
  JSON.stringify(paced(subE)),
);
ok(
  "pacing: one under, two on, one over, one at term end",
  JSON.stringify(pacing.rows?.map((r) => [r.group_id, r.value])) ===
    JSON.stringify([
      ["under", 1],
      ["on", 2],
      ["over", 1],
      ["term_end", 1],
    ]),
  JSON.stringify(pacing.rows),
);

// A day with no usage writes no meter slice; the customer count is per grain, not summed.
const day = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "day", "2026-06-05", NOW),
);
ok(
  "day grain: 5 June counts A's 10 events and 1 customer",
  day.find((r) => r.measure === "usage_events" && r.dim === "")?.value === 10n &&
    day.find((r) => r.measure === "usage_customers")?.value === 1n,
);

let failed = 0;
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}${!pass && detail ? ` — ${detail}` : ""}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-USAGE: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-USAGE: FAIL (${failed}/${checks.length} failed)`,
);
if (failed > 0)
  console.log(
    rows
      .filter((r) => r.measure.startsWith("usage") || r.measure === "revenue_billed")
      .map(
        (r) =>
          `${r.measure}|${r.dim}|${r.dimValue}|${r.currency}=${r.value}/${r.denominator ?? ""}`,
      )
      .join("\n"),
  );
await closeDb();
process.exit(failed === 0 ? 0 : 1);
