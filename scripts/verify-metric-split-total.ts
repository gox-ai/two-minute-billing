/**
 * THE HEADLINE DOES NOT MOVE WHEN YOU ASK FOR A SPLIT, AND THE ROWS SAY WHAT THEY MISS.
 *
 * The published total is the stored `dim = ''` figure. A split adds rows; it must not
 * change the number those rows are a breakdown of. The read once built the series out of
 * the dimension rows themselves, so any stored dimension (`plan`, `country`, `horizon`, …)
 * published a total that agreed with neither the unsplit answer nor its own rows — a stock
 * lost every unattributed row and, at a small `split_limit`, the residual `other` bucket
 * went NEGATIVE and drew shares over 100%.
 *
 * The seed makes the defect unmissable: the dimension rows deliberately cover only PART of
 * the population, exactly as a real book does when a subscription has no plan or a customer
 * has no country on file.
 *
 * A split falls short of its headline for two unrelated reasons and they must not be conflated:
 * rows dropped by `split_limit` (`kind: truncated`) and population the dimension never
 * attributed (`kind: unattributed`). The seed makes both happen at once. It also seeds the two
 * cases where no residual is derivable at all — a rate and a distinct count — and the stock
 * whose slices end on different days, where the row totals genuinely do not add up and the
 * split must SAY so rather than bend a residual to hide it.
 *
 *   pnpm verify:metric-split-total
 */
import { buildApp } from "@/index";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { todayIn } from "@/modules/metrics/daily/public-query";
import { businesses, metricDaily } from "@db/schema";
import { eq } from "drizzle-orm";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, pass: boolean) => checks.push([name, pass]);

const TZ = "Asia/Kolkata";
const DAYS = 30;

/** A stock. The plan rows cover 60% of it — the rest has no plan attribution. */
const MRR_TOTAL = 100_000;
const MRR_BY_PLAN = [35_000, 15_000, 7_000, 3_000];
/** A flow. The country rows cover four sevenths of it. */
const CHURN_PER_DAY = 700;
const CHURN_BY_COUNTRY = [250, 90, 60];
/**
 * A COUNT whose states PARTITION the population. `invoices.dunning_status` is one column, so
 * an invoice stands in exactly one state and the writer stores the unsliced figure as their
 * sum. That makes it the sharpest case of all: the states must add up to the headline, and
 * the read once collapsed five state rows to whichever sorted last.
 */
const DUNNING_BY_STATE: Array<[string, number]> = [
  ["succeeded", 322],
  ["exhausted", 142],
  ["in_progress", 26],
  ["stopped", 11],
  ["parked", 3],
];
const DUNNING_TOTAL = DUNNING_BY_STATE.reduce((a, [, v]) => a + v, 0);

/**
 * A stock whose slices DO NOT END TOGETHER. `plan_gone` holds its last figure halfway through
 * the window; the book keeps ten subscriptions throughout. Each row is right and their totals
 * sum to 14 against a headline of 10 — the split must declare itself non-exhaustive rather
 * than invent a residual of −4.
 */
const ACTIVE_TOTAL = 10;
const ACTIVE_LIVE = 6;
const ACTIVE_GONE = 4;
const GONE_AFTER = 15;

/** A flow whose slices OVERSHOOT the stored total, so the residual is NEGATIVE and stays so. */
const ATTEMPTS_TOTAL = 100;
const ATTEMPTS_BY_STATUS: Array<[string, number]> = [
  ["succeeded", 70],
  ["failed", 50],
];
const ATTEMPTS_RESIDUAL_PER_DAY =
  ATTEMPTS_TOTAL - ATTEMPTS_BY_STATUS.reduce((a, [, v]) => a + v, 0);

/**
 * A rate and a distinct count: neither has a remainder to publish.
 *
 * Both are seeded in TWO currencies on purpose. A quotient of the whole book is not the sum of
 * its per-currency quotients, and a distinct count is not the sum of its slices either — so if
 * anything ever DID compute a remainder here, it would be loudly non-zero and these checks
 * would catch it. Seeded in one currency the refusal is untestable, because the shortfall a
 * broken build would publish happens to be nothing.
 */
const ARPS_INR = { value: 90_000, denominator: 9 };
const ARPS_USD = { value: 100, denominator: 2 };
/** `1 INR = 0.0125 USD`, so the USD half converts at ÷0.0125. */
const USD_RATE = 0.0125;
const CHURN_RATE_INR = { value: 3, denominator: 100 };
const CHURN_RATE_USD = { value: 1, denominator: 25 };

/**
 * A CONVERTED SPLIT IS A SPLIT OF THE CONVERTED MONEY. Three currencies, one of them with no
 * rate: the headline converts USD into INR, excludes EUR and names it. The rows must do
 * exactly the same — a slice held in dollars is revenue attributed to a plan, and dropping it
 * into the residual states that nobody knows whose plan it was.
 */
const NEW_MRR_INR = 1_000;
const NEW_MRR_INR_BY_PLAN = 600;
const NEW_MRR_USD = 10;
const NEW_MRR_USD_BY_PLAN = 8;
/** No rate on file: excluded from the headline, so excluded from the rows too. */
const NEW_MRR_EUR = 5;
const NEW_MRR_EUR_BY_PLAN = 5;
const toBase = (usd: number) => Math.round(usd / USD_RATE);
const NEW_MRR_CONVERTED = NEW_MRR_INR + toBase(NEW_MRR_USD);
const NEW_MRR_RESIDUAL = NEW_MRR_CONVERTED - NEW_MRR_INR_BY_PLAN - toBase(NEW_MRR_USD_BY_PLAN);

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00.000Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

const org = await createOrganization({ name: "Split Total Org" });
const orgId = org.organization.id;
const apiKey = org.secret;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Split Total Biz",
  defaultCurrency: "INR",
  livemode: "test",
  timezone: TZ,
});

// A rate on file is what lets the two-currency money ratio be answered at all; without one
// the read refuses rather than summing rupees into dollars.
await withTenant(orgId, (tx) =>
  tx
    .update(businesses)
    .set({ exchangeRates: { USD: USD_RATE } })
    .where(eq(businesses.id, biz.id)),
);

const today = todayIn(TZ);
const firstDay = addDays(today, -(DAYS - 1));
const computedAt = new Date();

const rows: Array<typeof metricDaily.$inferInsert> = [];
for (let i = 0; i < DAYS; i++) {
  const periodEnd = addDays(firstDay, i);
  const base = {
    organizationId: orgId,
    businessId: biz.id,
    grain: "day",
    periodEnd,
    currency: "INR",
    computedAt,
  };
  rows.push({ ...base, measure: "mrr", dim: "", dimValue: "", value: BigInt(MRR_TOTAL) });
  MRR_BY_PLAN.forEach((v, p) =>
    rows.push({
      ...base,
      measure: "mrr",
      dim: "plan",
      dimValue: `plan_${p}`,
      value: BigInt(v),
    }),
  );
  rows.push({
    ...base,
    measure: "mrr_churn",
    dim: "",
    dimValue: "",
    value: BigInt(CHURN_PER_DAY),
  });
  CHURN_BY_COUNTRY.forEach((v, c) =>
    rows.push({
      ...base,
      measure: "mrr_churn",
      dim: "country",
      dimValue: ["IN", "US", "DE"][c]!,
      value: BigInt(v),
    }),
  );
  rows.push({
    ...base,
    measure: "active_subscriptions",
    dim: "",
    dimValue: "",
    value: BigInt(ACTIVE_TOTAL),
  });
  rows.push({
    ...base,
    measure: "active_subscriptions",
    dim: "plan",
    dimValue: "plan_live",
    value: BigInt(ACTIVE_LIVE),
  });
  if (i < GONE_AFTER) {
    rows.push({
      ...base,
      measure: "active_subscriptions",
      dim: "plan",
      dimValue: "plan_gone",
      value: BigInt(ACTIVE_GONE),
    });
  }
  rows.push({
    ...base,
    measure: "payment_attempts",
    dim: "",
    dimValue: "",
    value: BigInt(ATTEMPTS_TOTAL),
  });
  for (const [status, v] of ATTEMPTS_BY_STATUS) {
    rows.push({
      ...base,
      measure: "payment_attempts",
      dim: "transaction_status",
      dimValue: status,
      value: BigInt(v),
    });
  }
  for (const [ccy, total, plan] of [
    ["INR", NEW_MRR_INR, NEW_MRR_INR_BY_PLAN],
    ["USD", NEW_MRR_USD, NEW_MRR_USD_BY_PLAN],
    ["EUR", NEW_MRR_EUR, NEW_MRR_EUR_BY_PLAN],
  ] as const) {
    rows.push({
      ...base,
      currency: ccy,
      measure: "mrr_new",
      dim: "",
      dimValue: "",
      value: BigInt(total),
    });
    rows.push({
      ...base,
      currency: ccy,
      measure: "mrr_new",
      dim: "plan",
      dimValue: `plan_${ccy.toLowerCase()}`,
      value: BigInt(plan),
    });
  }
  for (const [ccy, arps, churnRate] of [
    ["INR", ARPS_INR, CHURN_RATE_INR],
    ["USD", ARPS_USD, CHURN_RATE_USD],
  ] as const) {
    rows.push({
      ...base,
      currency: ccy,
      measure: "revenue_per_paying_subscription",
      dim: "",
      dimValue: "",
      value: BigInt(arps.value),
      denominator: BigInt(arps.denominator),
    });
    rows.push({
      ...base,
      currency: ccy,
      measure: "customer_churn_rate",
      dim: "",
      dimValue: "",
      value: BigInt(churnRate.value),
      denominator: BigInt(churnRate.denominator),
    });
  }
  rows.push({
    ...base,
    measure: "dunning_invoices",
    dim: "",
    dimValue: "",
    value: BigInt(DUNNING_TOTAL),
  });
  for (const [state, v] of DUNNING_BY_STATE) {
    rows.push({
      ...base,
      measure: "dunning_invoices",
      dim: "dunning_status",
      dimValue: state,
      value: BigInt(v),
    });
  }
}
await withTenant(orgId, async (tx) => {
  for (let i = 0; i < rows.length; i += 200) {
    await tx.insert(metricDaily).values(rows.slice(i, i + 200));
  }
});

const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${apiKey}` };
const ask = async (query: string) => {
  const r = await app.inject({
    method: "GET",
    url: `/v1/analytics?business=${biz.publicId}&start=${firstDay}&end=${today}&grain=day&${query}`,
    headers: auth,
  });
  return JSON.parse(r.body) as {
    total: number | null;
    currency: string | null;
    currency_basis: string;
    missing_rates?: string[];
    series: Array<{ t: string; value: number | null }>;
    split?: {
      truncated: boolean;
      exhaustive: boolean;
      exhaustive_basis: string;
      note: string;
      series: Array<{
        key: string;
        label: string;
        kind: "dimension" | "truncated" | "unattributed";
        total: number | null;
        points: Array<{ t: string; value: number | null }>;
      }>;
    };
  };
};

/** Σ of every row at one period — the arithmetic that is always sound. */
const rowsAt = (
  split: { series: Array<{ points: Array<{ value: number | null }> }> },
  i: number,
): number => split.series.reduce((sum, r) => sum + (r.points[i]?.value ?? 0), 0);

// ── 1 · a stored dimension does not move the total ────────────────────────────────────────
const mrrPlain = await ask("measure=mrr");
ok(`mrr unsplit totals ${MRR_TOTAL} (value at end)`, mrrPlain.total === MRR_TOTAL);

for (const split of ["plan", "currency", "business"]) {
  const got = await ask(`measure=mrr&split=${split}`);
  ok(
    `mrr total is unchanged by split=${split} (${got.total} vs ${mrrPlain.total})`,
    got.total === mrrPlain.total,
  );
}

const churnPlain = await ask("measure=mrr_churn");
ok(
  `mrr_churn unsplit totals ${CHURN_PER_DAY * DAYS} (sum over window)`,
  churnPlain.total === CHURN_PER_DAY * DAYS,
);
for (const split of ["country", "plan", "currency"]) {
  const got = await ask(`measure=mrr_churn&split=${split}`);
  ok(
    `mrr_churn total is unchanged by split=${split} (${got.total} vs ${churnPlain.total})`,
    got.total === churnPlain.total,
  );
}

// ── 2 · the slices are still the slices ───────────────────────────────────────────────────
const PLAN_SUM = MRR_BY_PLAN.reduce((a, b) => a + b, 0);
const byPlan = await ask("measure=mrr&split=plan");
const byPlanDims = byPlan.split?.series.filter((r) => r.kind === "dimension") ?? [];
ok(
  `the plan split still returns its ${MRR_BY_PLAN.length} dimension rows, summing to ${PLAN_SUM}`,
  byPlanDims.length === MRR_BY_PLAN.length &&
    byPlanDims.reduce((s, r) => s + (r.total ?? 0), 0) === PLAN_SUM,
);

// ── 3 · unattributed population is named even when NOTHING was truncated ───────────────────
const planResidual = byPlan.split?.series.find((r) => r.kind === "unattributed");
ok(
  `an untruncated plan split still reports the ${MRR_TOTAL - PLAN_SUM} it does not attribute`,
  byPlan.split?.truncated === false && planResidual?.total === MRR_TOTAL - PLAN_SUM,
);
ok(
  `that row says unattributed, not "N more" (${JSON.stringify(planResidual?.label)})`,
  planResidual?.key === "unattributed" && !/more/.test(planResidual?.label ?? "more"),
);
ok(
  "an untruncated plan split with a residual is exhaustive",
  byPlan.split?.exhaustive === true && byPlan.split.exhaustive_basis === "rows_add_to_total",
);

// ── 4 · truncation and non-attribution are TWO rows, and together they close the total ─────
for (const limit of [1, 2, 3]) {
  const got = await ask(`measure=mrr&split=plan&split_limit=${limit}`);
  const rows = got.split?.series ?? [];
  const dropped = rows.find((r) => r.kind === "truncated");
  const unattributed = rows.find((r) => r.kind === "unattributed");
  const kept = rows.filter((r) => r.kind === "dimension");
  const droppedTruth = MRR_BY_PLAN.slice(limit).reduce((a, b) => a + b, 0);
  ok(
    `at split_limit=${limit} the truncated row is the ${MRR_BY_PLAN.length - limit} dropped rows (${droppedTruth}), not the whole shortfall (${dropped?.total})`,
    dropped?.total === droppedTruth &&
      dropped?.label === `Other (${MRR_BY_PLAN.length - limit} more)`,
  );
  ok(
    `at split_limit=${limit} the unattributed row stays ${MRR_TOTAL - PLAN_SUM} whatever the limit (${unattributed?.total})`,
    unattributed?.total === MRR_TOTAL - PLAN_SUM,
  );
  ok(
    `at split_limit=${limit} kept + truncated + unattributed = the headline`,
    kept.reduce((s, r) => s + (r.total ?? 0), 0) +
      (dropped?.total ?? 0) +
      (unattributed?.total ?? 0) ===
      got.total,
  );
  ok(
    `at split_limit=${limit} the split says so: exhaustive, truncated`,
    got.split?.exhaustive === true && got.split.truncated === true,
  );
}

// ── 5 · a SUM flow closes too, truncated or not ───────────────────────────────────────────
const COUNTRY_SUM = CHURN_BY_COUNTRY.reduce((a, b) => a + b, 0) * DAYS;
const CHURN_TOTAL = CHURN_PER_DAY * DAYS;
for (const q of ["", "&split_limit=1"]) {
  const got = await ask(`measure=mrr_churn&split=country${q}`);
  const rows = got.split?.series ?? [];
  const unattributed = rows.find((r) => r.kind === "unattributed");
  const truncatedRow = rows.find((r) => r.kind === "truncated");
  ok(
    `mrr_churn by country${q || " (all rows)"}: the ${CHURN_TOTAL - COUNTRY_SUM} with no country is its own row (${unattributed?.total})`,
    unattributed?.total === CHURN_TOTAL - COUNTRY_SUM,
  );
  ok(
    `mrr_churn by country${q || " (all rows)"}: every row adds back up to ${CHURN_TOTAL}`,
    got.split?.exhaustive === true &&
      rows.reduce((s, r) => s + (r.total ?? 0), 0) === got.total &&
      got.total === CHURN_TOTAL,
  );
  ok(
    `mrr_churn by country${q || " (all rows)"}: truncated says whether rows were dropped`,
    got.split?.truncated === (truncatedRow != null) && got.split?.truncated === (q !== ""),
  );
}

// ── 6 · a residual may be NEGATIVE. It is the true remainder, not a positive one ───────────
const attempts = await ask("measure=payment_attempts&split=transaction_status");
const attemptsResidual = attempts.split?.series.find((r) => r.kind === "unattributed");
ok(
  `payment_attempts: the residual is the true remainder ${ATTEMPTS_RESIDUAL_PER_DAY * DAYS}, not clamped to zero (${attemptsResidual?.total})`,
  attemptsResidual?.total === ATTEMPTS_RESIDUAL_PER_DAY * DAYS &&
    (attemptsResidual?.total ?? 0) < 0,
);
ok(
  "payment_attempts: the closed-set labels did not overwrite the residual's own label",
  attemptsResidual?.label === "Not attributed to a transaction status" &&
    attempts.split?.series.some((r) => r.kind === "dimension" && r.label === "Succeeded") === true,
);
ok(
  `payment_attempts: the rows still add back up to ${ATTEMPTS_TOTAL * DAYS}`,
  attempts.split?.exhaustive === true &&
    (attempts.split?.series.reduce((s, r) => s + (r.total ?? 0), 0) ?? null) === attempts.total,
);

// ── 7 · a stock whose slices end on different days SAYS it does not add up ─────────────────
const active = await ask("measure=active_subscriptions&split=plan");
const activeRows = active.split?.series ?? [];
ok(
  `active_subscriptions headline is the value at the end (${active.total})`,
  active.total === ACTIVE_TOTAL,
);
ok(
  `its row totals sum to ${ACTIVE_LIVE + ACTIVE_GONE + (ACTIVE_TOTAL - ACTIVE_LIVE)} ABOVE the headline, and the split says non-exhaustive instead of hiding it`,
  activeRows.reduce((s, r) => s + (r.total ?? 0), 0) > (active.total ?? 0) &&
    active.split?.exhaustive === false &&
    active.split.exhaustive_basis === "row_totals_not_coincident",
);
{
  // The per-period arithmetic is the part that IS sound, and it must be exact at every tick.
  const bad = active.series.findIndex(
    (p, i) => p.value != null && rowsAt(active.split!, i) !== p.value,
  );
  ok(`every period of that split still adds up exactly (first mismatch: ${bad})`, bad === -1);
}

// ── 8 · a rate and a distinct count invent nothing ─────────────────────────────────────────
const rate = await ask("measure=revenue_per_paying_subscription&split=currency");
ok(
  "a ratio split publishes no residual row and declares itself non-exhaustive",
  rate.split?.exhaustive === false &&
    rate.split.exhaustive_basis === "rate_not_decomposable" &&
    rate.split.series.every((r) => r.kind === "dimension") &&
    (rate.split.note?.length ?? 0) > 0,
);
const distinct = await ask("measure=customer_churn_rate&split=currency");
ok(
  "a non-additive rate split publishes no residual row and declares itself non-exhaustive",
  distinct.split?.exhaustive === false &&
    distinct.split.exhaustive_basis === "distinct_count_not_additive" &&
    distinct.split.series.every((r) => r.kind === "dimension") &&
    (distinct.split.note?.length ?? 0) > 0,
);

// ── 9 · a partitioned count: the states ARE the total ─────────────────────────────────────
const dunPlain = await ask("measure=dunning_invoices");
ok(`dunning_invoices unsplit counts ${DUNNING_TOTAL}`, dunPlain.total === DUNNING_TOTAL);
const dunSplit = await ask("measure=dunning_invoices&split=dunning_status");
ok(
  `dunning_invoices total is unchanged by split=dunning_status (${dunSplit.total} vs ${dunPlain.total})`,
  dunSplit.total === dunPlain.total,
);
ok(
  `the ${DUNNING_BY_STATE.length} collections states are disjoint and sum to the headline`,
  dunSplit.split?.series.length === DUNNING_BY_STATE.length &&
    dunSplit.split.series.every((r) => r.kind === "dimension") &&
    dunSplit.split.series.reduce((s, r) => s + (r.total ?? 0), 0) === dunSplit.total,
);
ok(
  "a dimension that DOES partition the population publishes no residual row at all",
  dunSplit.split?.exhaustive === true &&
    dunSplit.split.exhaustive_basis === "rows_add_to_total" &&
    !dunSplit.split.series.some((r) => r.kind !== "dimension"),
);

// ── 10 · a CONVERTED split converts its rows, and the residual is only what is unattributed ─
{
  const conv = await ask("measure=mrr_new&split=plan");
  ok(
    `mrr_new converts into ${conv.currency} and names EUR as unpriced (${JSON.stringify(conv.missing_rates)})`,
    conv.currency === "INR" &&
      conv.currency_basis === "converted" &&
      conv.missing_rates?.length === 1 &&
      conv.missing_rates[0] === "EUR",
  );
  ok(
    `its headline is the converted ${NEW_MRR_CONVERTED * DAYS} (${conv.total})`,
    conv.total === NEW_MRR_CONVERTED * DAYS,
  );

  const convRows = conv.split?.series ?? [];
  const usdRow = convRows.find((r) => r.key === "plan_usd");
  ok(
    `the USD plan row is CONVERTED, not dropped: ${toBase(NEW_MRR_USD_BY_PLAN) * DAYS} (${usdRow?.total})`,
    usdRow?.kind === "dimension" && usdRow.total === toBase(NEW_MRR_USD_BY_PLAN) * DAYS,
  );
  ok(
    `the INR plan row is untouched at ${NEW_MRR_INR_BY_PLAN * DAYS} (${convRows.find((r) => r.key === "plan_inr")?.total})`,
    convRows.find((r) => r.key === "plan_inr")?.total === NEW_MRR_INR_BY_PLAN * DAYS,
  );
  const eurRow = convRows.find((r) => r.key === "plan_eur");
  ok(
    `the unpriced EUR plan row is excluded, never guessed at (${eurRow?.total ?? "absent"})`,
    eurRow == null || eurRow.total == null || eurRow.total === 0,
  );

  const convResidual = convRows.find((r) => r.kind === "unattributed");
  ok(
    `the residual is the ${NEW_MRR_RESIDUAL * DAYS} genuinely unattributed, not the ${(NEW_MRR_CONVERTED - NEW_MRR_INR_BY_PLAN) * DAYS} an unconverted split would claim (${convResidual?.total})`,
    convResidual?.total === NEW_MRR_RESIDUAL * DAYS,
  );
  ok(
    "a converted split still adds back up to its headline",
    conv.split?.exhaustive === true &&
      convRows.reduce((sum, r) => sum + (r.total ?? 0), 0) === conv.total,
  );
  {
    const bad = conv.series.findIndex(
      (p, i) => p.value != null && rowsAt(conv.split!, i) !== p.value,
    );
    ok(`every period of the converted split adds up exactly (first mismatch: ${bad})`, bad === -1);
  }

  // Asking for one currency must still answer in that currency alone — conversion is what the
  // absence of `currency=` asks for, never a default.
  const perCcy = await ask("measure=mrr_new&split=plan&currency=USD");
  ok(
    `currency=USD is answered in USD at ${NEW_MRR_USD * DAYS}, unconverted (${perCcy.total})`,
    perCcy.currency === "USD" &&
      perCcy.currency_basis === "per_currency" &&
      perCcy.total === NEW_MRR_USD * DAYS &&
      perCcy.split?.series.find((r) => r.key === "plan_usd")?.total === NEW_MRR_USD_BY_PLAN * DAYS,
  );
}

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ METRIC-SPLIT-TOTAL: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-SPLIT-TOTAL: FAIL (${failed}/${checks.length} failed)`,
);
await app.close();
await closeDb();
process.exit(failed === 0 ? 0 : 1);
