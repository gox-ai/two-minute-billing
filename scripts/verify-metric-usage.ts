/**
 * Oracle gate for the usage measures (`usage-measures.ts`) and the meter split of
 * `revenue_billed`. Hand-worked, June 2026 (30 days; the window before it is 2 May–31 May):
 *   rollups  June: A tokens 10 events, A images 3, B tokens 5 → 18 events, 2 customers
 *            May:  A tokens 4 events (outside June)
 *   invoices May 15: A usage 3000 (tokens)            → A had 3000 before June
 *            June 10: A usage 4500 (tokens), cost 1500  → retained 4500 of 3000 = 15000 bps
 *            June 12: B usage 2000 (images), no cost    → B is new, not in retention
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
import { invoiceLineItems, invoices, meters } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
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
const [a, b] = [await mk("a"), await mk("b")];

const [tokens, images] = await withTenant(orgId, (tx) =>
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
    ])
    .returning({ id: meters.id }),
);

// Rollups are partitioned by month; a fresh database has none for the fixture's months.
await ensureUsageMonth(at("2026-05-01"));
await ensureUsageMonth(at("2026-06-01"));

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

let paired = true;
try {
  assertRegistryImplemented();
} catch (e) {
  paired = false;
  console.error(e);
}
ok("registry: the usage measures are declared and implemented with their slices", paired);
ok("registry: four usage measures", MEASURES.filter((m) => m.source === "usage").length === 4);

const rows = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "month", "2026-06-30", NOW),
);
const g = (m: string, dim = "", v = "", cur = "USD") =>
  rows.find((r) => r.measure === m && r.dim === dim && r.dimValue === v && r.currency === cur);
const val = (m: string, dim = "", v = "", cur = "USD") => g(m, dim, v, cur)?.value ?? null;

ok("events: 10 + 3 + 5 in June (May's 4 are out)", val("usage_events", "", "", "XXX") === 18n);
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
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
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
