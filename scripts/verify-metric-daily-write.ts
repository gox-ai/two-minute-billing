/**
 * The write layer for `metric_daily` (0267): upsert, chunking, the null/zero/missing
 * three-way distinction, and the grain+period_end unique key.
 *
 *   pnpm verify:metric-daily-write
 */
import { and, eq } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { writeMetricDay, type MetricDailyRow } from "@/modules/metrics/daily/write";
import { metricDaily } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Metric Daily Write Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Metric Daily Write Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const bizId = biz.id;
const periodEnd = "2026-09-01";

async function readPeriod(measure: string, grain = "day") {
  return withTenant(orgId, (tx) =>
    tx
      .select()
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.grain, grain),
          eq(metricDaily.periodEnd, periodEnd),
          eq(metricDaily.measure, measure),
        ),
      ),
  );
}

// 1. Write N rows, read them back, values match — including a value === 0n row.
const rows1: MetricDailyRow[] = [
  { measure: "mrr", dim: "", dimValue: "", currency: "USD", value: 500_00n },
  { measure: "mrr", dim: "plan", dimValue: "plan_a", currency: "USD", value: 300_00n },
  { measure: "mrr", dim: "plan", dimValue: "plan_b", currency: "USD", value: 200_00n },
  { measure: "new_mrr", dim: "", dimValue: "", currency: "USD", value: 0n },
];
const w1 = await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  periodEnd,
  rows: rows1,
});
ok("write returns count = rows written", w1.written === rows1.length);

const mrrRows = await readPeriod("mrr");
ok("readback: 3 mrr rows", mrrRows.length === 3);
const total = mrrRows.find((r) => r.dim === "" && r.dimValue === "");
ok("readback: total row value matches", total?.value === 500_00n);
const planA = mrrRows.find((r) => r.dimValue === "plan_a");
ok("readback: slice row value matches", planA?.value === 300_00n);

const zeroRows = await readPeriod("new_mrr");
ok("zero-value row IS written (not dropped)", zeroRows.length === 1 && zeroRows[0]!.value === 0n);

// 3. Total and slices coexist without colliding — already implied by mrrRows.length === 3,
// asserted explicitly here.
ok(
  "total row and slice rows coexist under the same measure/period",
  mrrRows.some((r) => r.dim === "") && mrrRows.filter((r) => r.dim === "plan").length === 2,
);

// 2. Re-write the same period with different values: RESTATES, not duplicates.
const beforeComputedAt = total!.computedAt;
await new Promise((r) => setTimeout(r, 20)); // ensure now() moves
const rows2: MetricDailyRow[] = [
  { measure: "mrr", dim: "", dimValue: "", currency: "USD", value: 999_00n },
  { measure: "mrr", dim: "plan", dimValue: "plan_a", currency: "USD", value: 300_00n },
  { measure: "mrr", dim: "plan", dimValue: "plan_b", currency: "USD", value: 200_00n },
  { measure: "new_mrr", dim: "", dimValue: "", currency: "USD", value: 0n },
];
await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  periodEnd,
  rows: rows2,
});
const mrrRowsAfter = await readPeriod("mrr");
ok("restate: row count unchanged after re-write", mrrRowsAfter.length === 3);
const totalAfter = mrrRowsAfter.find((r) => r.dim === "" && r.dimValue === "");
ok("restate: value updated", totalAfter?.value === 999_00n);
ok(
  "restate: computed_at moved forward",
  !!totalAfter && totalAfter.computedAt.getTime() > beforeComputedAt!.getTime(),
);

// 4. Chunk boundary: 1,200 rows in one call (well past the 500-row chunk size).
const bulkMeasure = "bulk_test";
const bulkRows: MetricDailyRow[] = Array.from({ length: 1200 }, (_, i) => ({
  measure: bulkMeasure,
  dim: "sub",
  dimValue: `sub_${i}`,
  currency: "USD",
  value: BigInt(i),
}));
const wBulk = await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  periodEnd,
  rows: bulkRows,
});
ok("chunk boundary: write reports 1200", wBulk.written === 1200);
const bulkBack = await readPeriod(bulkMeasure);
ok("chunk boundary: readback has 1200 rows", bulkBack.length === 1200);

// 5. Defensive validation: dim === '' with a non-empty dimValue must throw.
let threw = false;
try {
  await writeMetricDay({
    organizationId: orgId,
    businessId: bizId,
    grain: "day",
    periodEnd,
    rows: [{ measure: "bad", dim: "", dimValue: "not-empty", currency: "USD", value: 1n }],
  });
} catch {
  threw = true;
}
ok("validation: dim='' with non-empty dimValue throws", threw);

// 6. A null value round-trips as null — never coerced to 0.
await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  periodEnd,
  rows: [{ measure: "ltv", dim: "", dimValue: "", currency: "USD", value: null }],
});
const ltvRows = await readPeriod("ltv");
ok("null value round-trips as null, not 0", ltvRows.length === 1 && ltvRows[0]!.value === null);

// 7. A row with a denominator round-trips both halves, and the same key at a DIFFERENT
// grain does not collide with the day row (grain is part of the unique key).
await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  periodEnd,
  rows: [
    { measure: "retention", dim: "", dimValue: "", currency: "USD", value: 42n, denominator: 100n },
  ],
});
await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "month",
  periodEnd,
  rows: [
    {
      measure: "retention",
      dim: "",
      dimValue: "",
      currency: "USD",
      value: 900n,
      denominator: 1000n,
    },
  ],
});
const retentionDay = await readPeriod("retention", "day");
const retentionMonth = await readPeriod("retention", "month");
ok(
  "denominator round-trips alongside value",
  retentionDay.length === 1 &&
    retentionDay[0]!.value === 42n &&
    retentionDay[0]!.denominator === 100n,
);
ok(
  "same measure/period at a different grain does not collide",
  retentionMonth.length === 1 &&
    retentionMonth[0]!.value === 900n &&
    retentionMonth[0]!.denominator === 1000n,
);

// 8. A rewrite replaces the (measure, dim) pairs it carries: a slice value or currency that
// emptied is deleted, and a pair the call did not write survives.
await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  periodEnd,
  rows: [
    { measure: "mrr", dim: "plan", dimValue: "plan_a", currency: "USD", value: 500_00n },
    { measure: "mrr", dim: "plan", dimValue: "plan_a", currency: "INR", value: 7_00n },
  ],
});
await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  periodEnd,
  rows: [{ measure: "mrr", dim: "plan", dimValue: "plan_a", currency: "USD", value: 500_00n }],
});
const replaced = await readPeriod("mrr");
const planKeys = replaced
  .filter((r) => r.dim === "plan")
  .map((r) => `${r.dimValue}/${r.currency}`)
  .sort()
  .join(",");
ok(
  "replace: an emptied slice value and an emptied currency are deleted",
  planKeys === "plan_a/USD",
);
ok(
  "replace: the total, written in an earlier call, survives a slice-only rewrite",
  replaced.some((r) => r.dim === "" && r.value === 999_00n),
);
ok(
  "replace: another measure on the same day is untouched",
  (await readPeriod("new_mrr")).length === 1,
);
ok(
  "replace: the same key at another grain is untouched",
  (await readPeriod("retention", "month")).length === 1,
);

for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
const failed = checks.filter(([, c]) => !c);
console.log("");
const verdict = failed.length === 0;
console.log(
  verdict
    ? `✅ METRIC-DAILY-WRITE: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-DAILY-WRITE: FAIL (${failed.length}/${checks.length} failed)`,
);
await closeDb();
process.exit(verdict ? 0 : 1);
