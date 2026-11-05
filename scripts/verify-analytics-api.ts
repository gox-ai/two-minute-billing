/**
 * The public analytics API's contract gate.
 *
 * The numbers are the writer's job (`verify:metric-daily` is the oracle for those). This
 * suite proves the half a third party depends on and cannot read the source to learn:
 *
 *   1. discovery lists EVERY registry measure, with every contract field on it;
 *   2. a known measure answers in the right shape, with its unit, kind and currency stated;
 *   3. an illegal dimension is a 422 carrying a SENTENCE, never a bare code;
 *   4. an illegal grain is a 422 too;
 *   5. `split_limit` bounds the rows and the explicit `other` bucket makes the split add
 *      back up to the headline;
 *   6. `coverage` appears when periods are missing and is ABSENT when they are not;
 *   7. the batch endpoint answers several measures in one call and refuses one bad one
 *      without failing the others;
 *   8. `shape=totals` sends the same totals with the periods left out, and an unknown shape
 *      is refused by name.
 *
 * `metric_daily` rows are inserted directly: this is a test of the read contract, and
 * seeding a book would make the expected figures depend on the writer under test elsewhere.
 *
 *   pnpm verify:analytics-api
 */
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { MEASURES } from "@/modules/metrics/daily/measures";
import { todayIn } from "@/modules/metrics/daily/public-query";
import { businesses, metricDaily } from "@db/schema";
import { eq } from "drizzle-orm";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean) => checks.push([name, pass]);

const TZ = "Asia/Kolkata";
const DAYS = 30;
const PLANS = 25;
/** The plan slice sums to this, so a truncated split must still total it. */
const MRR_TOTAL = 325_000;
const MRR_NEW_PER_DAY = 500;

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00.000Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

// ── seed ──────────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Analytics API Org" });
const orgId = org.organization.id;
const apiKey = org.secret;

const bizA = await createBusiness({
  organizationId: orgId,
  name: "Analytics API Biz",
  defaultCurrency: "INR",
  livemode: "test",
  timezone: TZ,
});
const bizB = await createBusiness({
  organizationId: orgId,
  name: "Analytics API Biz Two",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: TZ,
});

const today = todayIn(TZ);
const firstDay = addDays(today, -(DAYS - 1));
const computedAt = new Date();

const rows: Array<typeof metricDaily.$inferInsert> = [];
for (let i = 0; i < DAYS; i++) {
  const periodEnd = addDays(firstDay, i);
  const base = { organizationId: orgId, grain: "day", periodEnd, computedAt };
  rows.push({
    ...base,
    businessId: bizA.id,
    measure: "mrr",
    dim: "",
    dimValue: "",
    currency: "INR",
    value: BigInt(MRR_TOTAL),
  });
  rows.push({
    ...base,
    businessId: bizA.id,
    measure: "mrr_new",
    dim: "",
    dimValue: "",
    currency: "INR",
    value: BigInt(MRR_NEW_PER_DAY),
  });
  for (let p = 0; p < PLANS; p++) {
    rows.push({
      ...base,
      businessId: bizA.id,
      measure: "mrr",
      dim: "plan",
      dimValue: `plan_${String(p).padStart(2, "0")}`,
      currency: "INR",
      value: BigInt(1000 * (p + 1)),
    });
  }
  // A second business in a second currency — the org-wide answer must refuse to add them up.
  rows.push({
    ...base,
    businessId: bizB.id,
    measure: "mrr",
    dim: "",
    dimValue: "",
    currency: "USD",
    value: 7000n,
  });
}
await withTenant(orgId, async (tx) => {
  for (let i = 0; i < rows.length; i += 200) {
    await tx.insert(metricDaily).values(rows.slice(i, i + 200));
  }
});

// ── drive the real server, in process ─────────────────────────────────────────────────────
const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${apiKey}` };
const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: auth, payload: payload as object });
const j = (r: { body: string }) => JSON.parse(r.body);

const win = `start=${firstDay}&end=${today}`;

// ── 1 · discovery ─────────────────────────────────────────────────────────────────────────
const disc = await get("/v1/analytics/measures");
const discovered = j(disc).data as Array<Record<string, unknown>>;
ok("discovery answers 200", disc.statusCode === 200);
ok(
  `discovery lists every registry measure (${MEASURES.length})`,
  discovered.length === MEASURES.length &&
    MEASURES.every((m) => discovered.some((d) => d.id === m.id)),
);
const CONTRACT_FIELDS = [
  "id",
  "name",
  "description",
  "kind",
  "unit",
  "aggregate",
  "dimensions",
  "grains",
  "currency",
  "supports_compare",
];
ok(
  "every discovered measure carries every contract field",
  discovered.every((d) => CONTRACT_FIELDS.every((f) => d[f] !== undefined)),
);

// ── 2 · a known measure, in the right shape and units ─────────────────────────────────────
const mrr = await get(`/v1/analytics?measure=mrr&grain=day&${win}&business=${bizA.publicId}`);
const m = j(mrr);
ok("a known measure answers 200", mrr.statusCode === 200);
ok("unit is stated as money", m.unit === "money");
ok("kind is stated as stock", m.kind === "stock");
ok("currency is stated as INR", m.currency === "INR");
ok("a stock's total is the value at the end, not a sum", m.total_basis === "value_at_end");
ok(`the stock's value is the stored minor-unit figure`, m.total === MRR_TOTAL);
ok(`the series covers every asked period (${DAYS})`, m.series.length === DAYS);
ok(
  "freshness travels with the data",
  typeof m.as_of === "string" && typeof m.computed_at === "string",
);
ok(
  "the window's timezone is the BUSINESS's, and says so",
  m.range.timezone === TZ && m.range.timezone_source === "business",
);

const flow = await get(`/v1/analytics?measure=mrr_new&grain=day&${win}&business=${bizA.publicId}`);
const f = j(flow);
ok("a flow is stated as a flow", f.kind === "flow");
ok(
  "a flow's total is the sum over the window",
  f.total_basis === "sum_over_window" && f.total === MRR_NEW_PER_DAY * DAYS,
);

// Money held in two currencies is never silently added up.
const orgWide = await get(`/v1/analytics?measure=mrr&grain=day&${win}`);
ok(
  "org-wide money across two currencies is refused, by name",
  orgWide.statusCode === 422 && /never summed across them/.test(j(orgWide).error.message),
);

// ── 3 · an illegal dimension explains itself ──────────────────────────────────────────────
const badDim = await get(
  `/v1/analytics?measure=cmrr&grain=day&${win}&split=plan&business=${bizA.publicId}`,
);
const badDimMsg = String(j(badDim).error?.message ?? "");
ok("an illegal dimension is 422", badDim.statusCode === 422);
ok(
  "…and the 422 carries a sentence naming what IS allowed",
  /cannot be split by plan/.test(badDimMsg) &&
    /currency/.test(badDimMsg) &&
    badDimMsg.endsWith("."),
);

// ── 4 · an illegal grain explains itself ──────────────────────────────────────────────────
const badGrain = await get(
  `/v1/analytics?measure=mrr&grain=fortnight&${win}&business=${bizA.publicId}`,
);
ok(
  "an illegal grain is 422 with a sentence",
  badGrain.statusCode === 422 && /no grain called "fortnight"/.test(j(badGrain).error.message),
);

// ── 5 · a split is bounded, and still adds up ─────────────────────────────────────────────
const LIMIT = 5;
const split = await get(
  `/v1/analytics?measure=mrr&grain=day&${win}&split=plan&split_limit=${LIMIT}&business=${bizA.publicId}`,
);
const s = j(split);
ok("a split answers 200", split.statusCode === 200);
ok(`split_limit bounds the rows to ${LIMIT} + other`, s.split.series.length === LIMIT + 1);
ok("the split says it was truncated", s.split.truncated === true);
const otherRow = s.split.series[LIMIT];
ok("the tail is an explicit `other` bucket", otherRow?.key === "other");
const splitSum = s.split.series.reduce((a: number, r: { total: number }) => a + r.total, 0);
ok("the split totals add back up to the headline", splitSum === s.total);
ok("the order is deterministic: biggest first", s.split.series[0].total >= s.split.series[1].total);

const wideSplit = await get(
  `/v1/analytics?measure=mrr&grain=day&${win}&split=plan&split_limit=${PLANS}&business=${bizA.publicId}`,
);
const w = j(wideSplit);
ok(
  "a split that fits is not truncated and has no `other`",
  w.split.truncated === false && w.split.series.length === PLANS,
);

// ── 8 · shape=totals: the same answer without its periods ─────────────────────────────────
const totalsSplit = j(
  await get(
    `/v1/analytics?measure=mrr&grain=day&${win}&split=plan&split_limit=${LIMIT}&shape=totals&business=${bizA.publicId}`,
  ),
);
ok(
  "totals: a split is a ranked list — no row carries points",
  totalsSplit.split.series.every((r: { points: unknown[] }) => r.points.length === 0) &&
    totalsSplit.series.length === 0,
);
ok(
  "totals: every row total and the headline equal the series answer's",
  totalsSplit.total === s.total &&
    JSON.stringify(
      totalsSplit.split.series.map((r: { key: string; total: number }) => [r.key, r.total]),
    ) ===
      JSON.stringify(s.split.series.map((r: { key: string; total: number }) => [r.key, r.total])),
);
ok("totals: the shape is echoed", totalsSplit.shape === "totals" && s.shape === "series");
const figure = j(
  await get(`/v1/analytics?measure=mrr&grain=day&${win}&shape=totals&business=${bizA.publicId}`),
);
ok(
  "totals without a split is a single figure",
  figure.series.length === 0 && figure.total === s.total,
);
const badShape = await get(
  `/v1/analytics?measure=mrr&${win}&shape=matrix&business=${bizA.publicId}`,
);
ok(
  "an unknown shape is a 422 naming the shapes",
  badShape.statusCode === 422 && /Shapes are series, totals/.test(j(badShape).error.message),
);
const bt = j(
  await post("/v1/analytics/query", {
    business: bizA.publicId,
    grain: "day",
    start: firstDay,
    end: today,
    queries: [{ key: "ranked", measure: "mrr", split: "plan", shape: "totals" }],
  }),
);
ok(
  "the batch carries shape per question",
  bt.data[0].shape === "totals" && bt.data[0].split.series[0].points.length === 0,
);

// ── 6 · coverage ──────────────────────────────────────────────────────────────────────────
ok("coverage is ABSENT when every period is known", m.coverage === undefined);
const gappy = await get(
  `/v1/analytics?measure=mrr&grain=day&start=${addDays(firstDay, -10)}&end=${today}&business=${bizA.publicId}`,
);
const g = j(gappy);
ok(
  "coverage appears when periods are missing",
  g.coverage != null && g.coverage.missing_periods.length === 10,
);
ok(
  "…and it says where the history becomes complete, in words",
  g.coverage?.complete_from === firstDay && /not zero/.test(String(g.coverage?.note)),
);

// ── 7 · the batch endpoint ────────────────────────────────────────────────────────────────
const batch = await post("/v1/analytics/query", {
  business: bizA.publicId,
  grain: "day",
  start: firstDay,
  end: today,
  queries: [
    { key: "stock", measure: "mrr" },
    { key: "nonsense", measure: "not_a_measure" },
    { key: "flow", measure: "mrr_new" },
    { key: "sliced", measure: "mrr", split: "plan", split_limit: 3 },
  ],
});
const b = j(batch);
ok("the batch answers 200", batch.statusCode === 200);
ok("the batch answers every question in one call", b.data.length === 4);
ok(
  "a good measure answers inside the batch",
  b.data[0].object === "analytics_result" && b.data[0].total === MRR_TOTAL,
);
ok(
  "one bad measure fails alone, as a 422 with its sentence",
  b.data[1].object === "analytics_error" &&
    b.data[1].status === 422 &&
    /no measure called "not_a_measure"/.test(b.data[1].error.message),
);
ok(
  "…and the questions after it still answer",
  b.data[2].total === MRR_NEW_PER_DAY * DAYS && b.data[3].split.series.length === 4,
);
ok(
  "every batch slot keeps its key",
  b.data.map((d: { key: string }) => d.key).join(",") === "stock,nonsense,flow,sliced",
);

// ── a rate of MONEY across currencies converts both halves before dividing ────────────────
// Summing a USD and an INR retention raw weighs a paisa as a cent: here the right answer is
// 70% on an opening of $200.00, and the raw one 50.4% on "$10,100.00".
{
  const bizC = await createBusiness({
    organizationId: orgId,
    name: "Analytics API Biz Three",
    defaultCurrency: "USD",
    livemode: "test",
    timezone: TZ,
  });
  await withTenant(orgId, (tx) =>
    tx
      .update(businesses)
      .set({ exchangeRates: { INR: 100 } })
      .where(eq(businesses.id, bizC.id)),
  );
  const monthStart = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  const at = {
    organizationId: orgId,
    businessId: bizC.id,
    grain: "month",
    periodEnd: lastMonthEnd,
    computedAt,
    dim: "",
    dimValue: "",
  };
  await withTenant(orgId, (tx) =>
    tx.insert(metricDaily).values([
      {
        ...at,
        measure: "gross_revenue_retention",
        currency: "USD",
        value: 9000n,
        denominator: 10000n,
      },
      {
        ...at,
        measure: "gross_revenue_retention",
        currency: "INR",
        value: 500000n,
        denominator: 1000000n,
      },
      // Customers, not money: the halves combine as they are, whatever the currency.
      { ...at, measure: "customer_churn_rate", currency: "USD", value: 1n, denominator: 10n },
      { ...at, measure: "customer_churn_rate", currency: "INR", value: 3n, denominator: 10n },
    ]),
  );
  const q = `business=${bizC.publicId}&grain=month&start=${lastMonthStart}&end=${lastMonthEnd}`;
  const grr = (await get(`/v1/analytics?measure=gross_revenue_retention&${q}`)).json();
  const point = grr.series?.[0];
  ok(
    "a money rate across currencies is converted, not summed raw",
    grr.currency === "USD" && grr.currency_basis === "converted",
  );
  ok(
    "…its opening is both currencies in USD ($100 + ₹10,000 at 100 = $200.00)",
    point?.denominator === 20000,
  );
  ok("…and the rate is value-weighted: 70%, not 50.4%", point?.value === 7000);
  const usd = (await get(`/v1/analytics?measure=gross_revenue_retention&${q}&currency=USD`)).json();
  ok("…one currency asked for is untouched: 90%", usd.series?.[0]?.value === 9000);
  // Money over a COUNT: the revenue converts, the subscriptions never do. Converting the
  // count by the rate turned 3 INR subscriptions into 0 and inflated the average.
  await withTenant(orgId, (tx) =>
    tx.insert(metricDaily).values([
      {
        ...at,
        grain: "day",
        measure: "revenue_per_paying_subscription",
        currency: "USD",
        value: 10000n,
        denominator: 2n,
      },
      {
        ...at,
        grain: "day",
        measure: "revenue_per_paying_subscription",
        currency: "INR",
        value: 1000000n,
        denominator: 3n,
      },
    ]),
  );
  const rpps = (
    await get(
      `/v1/analytics?measure=revenue_per_paying_subscription&business=${bizC.publicId}&grain=day&start=${lastMonthEnd}&end=${lastMonthEnd}`,
    )
  ).json();
  const rp = rpps.series?.[0];
  ok(
    "money over a count: the count is summed, not converted (5 subscriptions, $40.00 each)",
    rp?.denominator === 5 && rp?.value === 4000,
  );
  // The running month is stored at its calendar END (the writer keys it where a reader will
  // ask); a window ending today must still find it, or every current month reads null.
  const monthEnd = addDays(`${addDays(monthStart, 32).slice(0, 7)}-01`, -1);
  await withTenant(orgId, (tx) =>
    tx
      .insert(metricDaily)
      .values([
        {
          ...at,
          periodEnd: monthEnd,
          measure: "gross_revenue_retention",
          currency: "USD",
          value: 9500n,
          denominator: 10000n,
        },
      ]),
  );
  const running = (
    await get(
      `/v1/analytics?measure=gross_revenue_retention&business=${bizC.publicId}&grain=month&range=this_month&currency=USD`,
    )
  ).json();
  ok(
    "the running month is read from its month-end row, not reported missing",
    running.series?.at(-1)?.value === 9500,
  );
  const churn = (await get(`/v1/analytics?measure=customer_churn_rate&${q}`)).json();
  ok(
    "a rate of customers combines across currencies unconverted: 4 of 20",
    churn.currency_basis === "across_currencies" && churn.series?.[0]?.value === 2000,
  );
}

// Every rate without a RatioFold must say what it divides, or the currency rule cannot know.
{
  const undeclared = MEASURES.filter(
    (m) => m.unit !== "money" && m.unit !== "count" && !m.ratio && m.halves == null,
  ).map((m) => m.id);
  ok(
    `every rate without a RatioFold declares its halves${undeclared.length ? `: ${undeclared}` : ""}`,
    undeclared.length === 0,
  );
}

// ── verdict ───────────────────────────────────────────────────────────────────────────────
await app.close();

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass] of checks) console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
console.log("");
console.log(
  failed.length === 0
    ? `✅ ANALYTICS-API: PASS (${checks.length}/${checks.length})`
    : `❌ ANALYTICS-API: FAIL (${failed.length} of ${checks.length})`,
);
await closeDb();
process.exit(failed.length === 0 ? 0 : 1);
