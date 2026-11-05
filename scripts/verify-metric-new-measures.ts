/**
 * verify:metric-new-measures — ARR, net new MRR, gross MRR churn rate, trial conversion rate,
 * subscriber churn rate, reactivated customers and MRR at risk, each against a hand-worked
 * figure on a fixture of its own, and each through the public resolver in both currency modes:
 * money converted into the business currency, counts across currencies.
 *
 * The book is forced row by row and the MRR ledger written outright, so every expected figure
 * below is arithmetic on the table in this file. Window: June 2026, business on UTC.
 */
import { and, eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay, type MetricDailyRow } from "@/modules/metrics/daily/write";
import { measureById } from "@/modules/metrics/daily/measures";
import {
  businessesByPublicIds,
  resolveAnalytics,
  resolveScope,
} from "@/modules/metrics/daily/public-query";
import { clearOnDemandWindows } from "@/modules/metrics/daily/windows";
import { businesses, invoices, metricDaily, mrrMovements, subscriptions } from "@db/schema";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(
    cond ? "✓" : "✗",
    label,
    cond ? "" : JSON.stringify(detail ?? "", (_, v) => (typeof v === "bigint" ? `${v}n` : v)),
  );
}

const at = (iso: string) => new Date(iso.length === 10 ? `${iso}T09:00:00.000Z` : iso);
/** Past the real clock, so the dev billing worker never renews a fixture row. */
const PARKED = new Date("2028-01-01T00:00:00.000Z");
const NOW = new Date("2026-07-15T12:00:00.000Z");
/** `1 USD = 0.5 EUR`, so a EUR amount doubles into USD. */
const EUR_RATE = 0.5;

const org = await createOrganization({ name: "New Measures Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "New Measures Biz",
  defaultCurrency: "USD",
  timezone: "UTC",
  livemode: "test",
});
const bizId = biz.id;
await systemDb
  .update(businesses)
  .set({ exchangeRates: { EUR: EUR_RATE } })
  .where(eq(businesses.id, bizId));

const plan = await createProduct({ organizationId: orgId, businessId: bizId, name: "Plan" });
const price = {
  USD: await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 1000,
    interval: "month",
  }),
  EUR: await createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId: plan.id,
    type: "recurring",
    model: "flat",
    currency: "EUR",
    amountMinor: 1000,
    interval: "month",
  }),
};

let seq = 0;
const customer = () =>
  createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `new-measures-${++seq}-${Date.now()}@example.test`,
  });

interface SubSpec {
  currency: "USD" | "EUR";
  status: string;
  started: string;
  created?: string;
  canceled?: string;
  trialStart?: string;
  trialEnd?: string | null;
  activated?: string;
  mrr?: number;
  customerId?: string;
}
async function sub(s: SubSpec): Promise<{ id: string; customerId: string }> {
  const customerId = s.customerId ?? (await customer()).id;
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId,
    now: at(s.created ?? s.started),
    startDate: at(s.started),
    items: [{ price: price[s.currency], quantity: 1 }],
  });
  await systemDb
    .update(subscriptions)
    .set({
      status: s.status,
      currency: s.currency,
      mrr: BigInt(s.mrr ?? 0),
      createdAt: at(s.created ?? s.started),
      startDate: at(s.started),
      startedAt: at(s.started),
      canceledAt: s.canceled ? at(s.canceled) : null,
      currentPeriodEnd: PARKED,
      trialStart: s.trialStart ? at(s.trialStart) : null,
      trialEnd: s.trialStart ? (s.trialEnd ? at(s.trialEnd) : null) : PARKED,
      activatedAt: s.activated ? at(s.activated) : null,
    })
    .where(eq(subscriptions.id, subscription.id));
  return { id: subscription.id, customerId };
}

// ── The book ────────────────────────────────────────────────────────────────────────────
// Non-trial subscriptions.
const S1 = await sub({ currency: "USD", status: "active", started: "2026-01-10", mrr: 12000 });
const S2 = await sub({
  currency: "USD",
  status: "cancelled",
  started: "2026-02-01",
  canceled: "2026-06-20",
});
const S3 = await sub({ currency: "USD", status: "active", started: "2026-06-05", mrr: 4000 });
const S4 = await sub({
  currency: "USD",
  status: "cancelled",
  started: "2026-06-06",
  canceled: "2026-06-25",
});
const S5 = await sub({
  currency: "USD",
  status: "cancelled",
  started: "2026-01-01",
  canceled: "2026-05-01",
});
// Paused: never a subscriber at any instant, and its pause is a loss net new MRR must carry.
const S8 = await sub({ currency: "USD", status: "paused", started: "2026-01-01" });
const S6 = await sub({ currency: "EUR", status: "active", started: "2026-03-01", mrr: 4000 });
const S7 = await sub({
  currency: "EUR",
  status: "cancelled",
  started: "2026-03-01",
  canceled: "2026-06-15",
});

// Trials. T1 converts on time; T2 is cancelled inside its trial (which would have run into July); T3 runs out; T4 lapsed in
// May and converts late in June; T5 ends in July; T6 is the EUR conversion; T7 is open-ended
// and converts early; T8 converts later on the day the run happens, which has not happened yet.
const T1 = await sub({
  currency: "USD",
  status: "active",
  started: "2026-05-20",
  trialStart: "2026-05-20",
  trialEnd: "2026-06-03",
  activated: "2026-06-03",
});
await sub({
  currency: "USD",
  status: "cancelled",
  started: "2026-06-02",
  trialStart: "2026-06-02",
  trialEnd: "2026-07-02",
  canceled: "2026-06-05",
});
await sub({
  currency: "USD",
  status: "cancelled",
  started: "2026-06-01",
  trialStart: "2026-06-01",
  trialEnd: "2026-06-15",
  canceled: "2026-06-15",
});
const T4 = await sub({
  currency: "USD",
  status: "active",
  started: "2026-04-20",
  trialStart: "2026-04-20",
  trialEnd: "2026-05-04",
  activated: "2026-06-10",
});
const T5 = await sub({
  currency: "USD",
  status: "active",
  started: "2026-06-20",
  trialStart: "2026-06-20",
  trialEnd: "2026-07-04",
  activated: "2026-07-04",
});
const T6 = await sub({
  currency: "EUR",
  status: "active",
  started: "2026-05-28",
  trialStart: "2026-05-28",
  trialEnd: "2026-06-11",
  activated: "2026-06-11",
});
const T7 = await sub({
  currency: "USD",
  status: "active",
  started: "2026-06-02",
  trialStart: "2026-06-02",
  trialEnd: null,
  activated: "2026-06-12",
});
await sub({
  currency: "USD",
  status: "active",
  started: "2026-07-01",
  trialStart: "2026-07-01",
  trialEnd: null,
  activated: "2026-07-15T20:00:00.000Z",
});

// Accounts for reactivation. R1 churned in March and returns on a new subscription; R2 only
// paused and resumed; R4 churned in May, returned and churned again in June; R3 is EUR;
// N is a brand-new account.
const RA = await sub({
  currency: "USD",
  status: "cancelled",
  started: "2026-01-05",
  canceled: "2026-03-05",
});
const RB = await sub({
  currency: "USD",
  status: "active",
  started: "2026-06-08",
  customerId: RA.customerId,
});
const P = await sub({ currency: "USD", status: "active", started: "2026-01-01", mrr: 1000 });
// A reactivation resets the row's start, so Q's term begins at its return.
const Q = await sub({
  currency: "USD",
  status: "cancelled",
  created: "2026-01-01",
  started: "2026-06-03",
  canceled: "2026-06-20",
});
const N = await sub({ currency: "USD", status: "active", started: "2026-06-15" });
const R3 = await sub({
  currency: "EUR",
  status: "active",
  created: "2026-02-01",
  started: "2026-06-14",
});

// ── The ledger, stated outright ─────────────────────────────────────────────────────────
// The unscoped client: the tenant role may not delete ledger rows, by design.
await systemDb.delete(mrrMovements).where(eq(mrrMovements.businessId, bizId));
const move = (
  s: { id: string; customerId: string },
  on: string,
  reason: string,
  currency: string,
  delta: number,
) => ({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: s.id,
  customerId: s.customerId,
  reason,
  planProductId: plan.id,
  currency,
  previousMrrMinor: BigInt(delta < 0 ? -delta : 0),
  newMrrMinor: BigInt(delta > 0 ? delta : 0),
  deltaMinor: BigInt(delta),
  occurredAt: at(on),
});
await withTenant(orgId, (tx) =>
  tx
    .insert(mrrMovements)
    .values([
      move(S1, "2026-01-10", "new", "USD", 10000),
      move(S1, "2026-06-12", "expansion", "USD", 2000),
      move(S2, "2026-02-01", "new", "USD", 3000),
      move(S2, "2026-06-20", "churn", "USD", -3000),
      move(S3, "2026-06-05", "new", "USD", 4000),
      move(S4, "2026-06-06", "new", "USD", 1500),
      move(S4, "2026-06-25", "churn", "USD", -1500),
      move(S5, "2026-01-01", "new", "USD", 2000),
      move(S5, "2026-05-01", "churn", "USD", -2000),
      move(S8, "2026-01-01", "new", "USD", 1000),
      move(S8, "2026-06-10", "pause", "USD", -1000),
      move(T1, "2026-06-03", "new", "USD", 1000),
      move(T4, "2026-05-04", "new", "USD", 1000),
      move(T5, "2026-07-04", "new", "USD", 1000),
      move(T7, "2026-06-12", "new", "USD", 1000),
      move(RA, "2026-01-05", "new", "USD", 2000),
      move(RA, "2026-03-05", "churn", "USD", -2000),
      move(RB, "2026-06-08", "new", "USD", 2500),
      move(P, "2026-01-01", "new", "USD", 1000),
      move(P, "2026-04-01", "pause", "USD", -1000),
      move(P, "2026-06-09", "resume", "USD", 1000),
      move(Q, "2026-01-01", "new", "USD", 1000),
      move(Q, "2026-05-10", "churn", "USD", -1000),
      move(Q, "2026-06-03", "reactivation", "USD", 1000),
      move(Q, "2026-06-20", "churn", "USD", -1000),
      move(N, "2026-06-15", "new", "USD", 500),
      move(S6, "2026-03-01", "new", "EUR", 5000),
      move(S6, "2026-06-18", "contraction", "EUR", -1000),
      move(S7, "2026-03-01", "new", "EUR", 2000),
      move(S7, "2026-06-15", "churn", "EUR", -2000),
      move(T6, "2026-06-11", "new", "EUR", 1000),
      move(R3, "2026-02-01", "new", "EUR", 3000),
      move(R3, "2026-04-01", "churn", "EUR", -3000),
      move(R3, "2026-06-14", "reactivation", "EUR", 3000),
    ]),
);

// ── Invoices under collection ───────────────────────────────────────────────────────────
let inv = 0;
async function invoice(
  s: { id: string; customerId: string },
  currency: string,
  status: string,
  dunningStatus: string,
) {
  await withTenant(orgId, (tx) =>
    tx.insert(invoices).values({
      organizationId: orgId,
      businessId: bizId,
      customerId: s.customerId,
      subscriptionId: s.id,
      publicId: `inv_newm_${++inv}_${Date.now()}`,
      status,
      currency,
      subtotalMinor: 1000n,
      totalMinor: 1000n,
      dunningStatus,
      createdAt: at("2026-07-01"),
    }),
  );
}
await invoice(S1, "USD", "payment_due", "in_progress");
await invoice(S1, "USD", "not_paid", "in_progress"); // same subscription: counted once
await invoice(S3, "USD", "posted", "parked");
await invoice(S6, "EUR", "payment_due", "in_progress");
await invoice(S2, "USD", "paid", "succeeded"); // paid: not at risk
await invoice(S4, "USD", "payment_due", "exhausted"); // retries spent: not being chased
await invoice(P, "USD", "payment_due", "exhausted"); // …on a subscription still earning

// ── Materialise: every day of June and July to the run, and June as a month ─────────────
const days: string[] = [];
for (
  let d = new Date("2026-06-01T00:00:00Z");
  d <= new Date("2026-07-15T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1)
) {
  days.push(d.toISOString().slice(0, 10));
}
const byDay = new Map<string, MetricDailyRow[]>();
for (const day of days) {
  const rows = await withTenant(orgId, (tx) =>
    computeMetricPeriod(tx, bizId, "day", day, NOW, { timezone: "UTC" }),
  );
  byDay.set(day, rows);
  await writeMetricDay({
    organizationId: orgId,
    businessId: bizId,
    grain: "day",
    periodEnd: day,
    rows,
  });
}
const june = await withTenant(orgId, (tx) =>
  computeMetricPeriod(tx, bizId, "month", "2026-06-30", NOW, { timezone: "UTC" }),
);
await writeMetricDay({
  organizationId: orgId,
  businessId: bizId,
  grain: "month",
  periodEnd: "2026-06-30",
  rows: june.filter((r) => measureById(r.measure)?.aggregate === "none"),
});

const row = (rows: readonly MetricDailyRow[], measure: string, currency: string) =>
  rows.find((r) => r.measure === measure && r.dim === "" && r.currency === currency);
const halves = (rows: readonly MetricDailyRow[], measure: string, currency: string) => {
  const r = row(rows, measure, currency);
  return r ? `${r.value}/${r.denominator ?? "-"}` : "missing";
};

const [b] = await businessesByPublicIds(orgId, [biz.publicId]);
const scope = await resolveScope(orgId, b!, "all");
const ask = (q: Record<string, unknown>) => resolveAnalytics(scope, q as never, NOW);
const JUNE = { start: "2026-06-01", end: "2026-06-30", grain: "month" };

// ── 1. ARR ──────────────────────────────────────────────────────────────────────────────
{
  const d30 = byDay.get("2026-06-30")!;
  const mrrRows = d30.filter((r) => r.measure === "mrr");
  const arrRows = d30.filter((r) => r.measure === "arr");
  const twin = mrrRows.every((m) =>
    arrRows.some(
      (a) =>
        a.dim === m.dim &&
        a.dimValue === m.dimValue &&
        a.currency === m.currency &&
        a.value === (m.value ?? 0n) * 12n,
    ),
  );
  ok(
    "arr: every mrr row, every slice, has an arr twin at twelve times the value",
    twin && arrRows.length === mrrRows.length && mrrRows.length > 2,
    { mrr: mrrRows.length, arr: arrRows.length },
  );
  ok(
    "arr: registry declares exactly mrr's dimensions",
    JSON.stringify(measureById("arr")!.dimensions) ===
      JSON.stringify(measureById("mrr")!.dimensions),
  );
  ok(
    "arr: USD at 30 June is 12 × 23,000",
    row(d30, "arr", "USD")?.value === 276000n,
    row(d30, "arr", "USD"),
  );
  ok(
    "arr: EUR at 30 June is 12 × 8,000",
    row(d30, "arr", "EUR")?.value === 96000n,
    row(d30, "arr", "EUR"),
  );
  const conv = await ask({ measure: "arr", ...JUNE });
  const mrrConv = await ask({ measure: "mrr", ...JUNE });
  ok(
    "arr: converted into USD like mrr — 276,000 + 96,000 ÷ 0.5",
    conv.currency_basis === "converted" && conv.currency === "USD" && conv.total === 468000,
    { basis: conv.currency_basis, total: conv.total },
  );
  ok(
    "arr: …and equals twelve times the converted mrr",
    mrrConv.total != null && conv.total === mrrConv.total * 12,
    { arr: conv.total, mrr: mrrConv.total },
  );
  const eur = await ask({ measure: "arr", ...JUNE, currency: "EUR" });
  ok(
    "arr: asked in EUR alone, nothing converted",
    eur.currency_basis === "per_currency" && eur.total === 96000,
    eur.total,
  );
}

// ── 2. Net new MRR ──────────────────────────────────────────────────────────────────────
{
  ok(
    "net_new_mrr: USD June is every signed move — 8,000",
    row(june, "net_new_mrr", "USD")?.value === 8000n,
    row(june, "net_new_mrr", "USD"),
  );
  ok(
    "net_new_mrr: EUR June — 1,000",
    row(june, "net_new_mrr", "EUR")?.value === 1000n,
    row(june, "net_new_mrr", "EUR"),
  );
  const conv = await ask({ measure: "net_new_mrr", ...JUNE });
  ok(
    "net_new_mrr: folded from days and converted — 8,000 + 1,000 ÷ 0.5",
    conv.currency_basis === "converted" && conv.total === 10000,
    { basis: conv.currency_basis, total: conv.total },
  );
  ok(
    "net_new_mrr: USD agrees with the growth rate's numerator",
    row(june, "net_mrr_growth_rate", "USD")?.value === 8000n,
    row(june, "net_mrr_growth_rate", "USD"),
  );
}

// ── 3. Gross MRR churn rate ─────────────────────────────────────────────────────────────
{
  const g = measureById("gross_mrr_churn_rate")!;
  ok(
    "gross_mrr_churn_rate: USD June halves are churn + contraction over the opening — 5,500/15,000",
    halves(june, "gross_mrr_churn_rate", "USD") === "5500/15000",
    halves(june, "gross_mrr_churn_rate", "USD"),
  );
  ok(
    "gross_mrr_churn_rate: EUR June — 3,000/7,000",
    halves(june, "gross_mrr_churn_rate", "EUR") === "3000/7000",
    halves(june, "gross_mrr_churn_rate", "EUR"),
  );
  ok(
    "gross_mrr_churn_rate: its base is the growth rate's opening",
    row(june, "gross_mrr_churn_rate", "USD")?.denominator ===
      row(june, "net_mrr_growth_rate", "USD")?.denominator,
  );
  const usd = await ask({ measure: "gross_mrr_churn_rate", ...JUNE, currency: "USD" });
  ok(
    "gross_mrr_churn_rate: June folded from day rows on the first day's opening — 3,667 bps",
    usd.total === 3667,
    usd.total,
  );
  const conv = await ask({ measure: "gross_mrr_churn_rate", ...JUNE });
  ok(
    "gross_mrr_churn_rate: converted, both halves — (5,500 + 6,000) / (15,000 + 14,000) = 3,966 bps",
    conv.currency_basis === "converted" && conv.total === 3966,
    { basis: conv.currency_basis, total: conv.total },
  );
  ok(
    "gross_mrr_churn_rate: declares money halves",
    g.ratio?.denominatorUnit === "money" && g.ratio.denominator === "opening",
  );
}

// ── 4. Trial conversion rate ────────────────────────────────────────────────────────────
{
  ok(
    "trial_conversion_rate: USD June — 3 converted over 4 ended",
    halves(june, "trial_conversion_rate", "USD") === "3/4",
    halves(june, "trial_conversion_rate", "USD"),
  );
  ok(
    "trial_conversion_rate: EUR June — 1/1",
    halves(june, "trial_conversion_rate", "EUR") === "1/1",
    halves(june, "trial_conversion_rate", "EUR"),
  );
  const usd = await ask({ measure: "trial_conversion_rate", ...JUNE, currency: "USD" });
  ok("trial_conversion_rate: USD June folds to 7,500 bps", usd.total === 7500, usd.total);
  const all = await ask({ measure: "trial_conversion_rate", ...JUNE });
  ok(
    "trial_conversion_rate: counts combine across currencies unconverted — 4/5 = 8,000 bps",
    all.currency_basis === "across_currencies" && all.total === 8000,
    { basis: all.currency_basis, total: all.total },
  );
  const late = await ask({
    measure: "trial_conversion_rate",
    start: "2026-06-09",
    end: "2026-06-12",
    grain: "day",
    currency: "USD",
  });
  ok(
    "trial_conversion_rate: a late conversion can lift a window past 100% — 2/1 = 20,000 bps",
    late.total === 20000,
    late.total,
  );
  ok(
    "trial_conversion_rate: a conversion later on the run's own day has not happened yet",
    halves(byDay.get("2026-07-15")!, "trial_conversion_rate", "USD") === "0/0",
    halves(byDay.get("2026-07-15")!, "trial_conversion_rate", "USD"),
  );
  ok(
    "trial_conversion_rate: a day on which no trial ended has no rate — null, not 0%",
    (
      await ask({
        measure: "trial_conversion_rate",
        start: "2026-06-01",
        end: "2026-06-01",
        grain: "day",
        currency: "USD",
      })
    ).total === null,
  );
}

// ── 5. Subscriber churn rate ────────────────────────────────────────────────────────────
{
  ok(
    "subscriber_churn_rate: USD June — 3 stopped of 4 opening + 7 joined",
    halves(june, "subscriber_churn_rate", "USD") === "3/11",
    halves(june, "subscriber_churn_rate", "USD"),
  );
  ok(
    "subscriber_churn_rate: EUR June — 1 of 2 + 2",
    halves(june, "subscriber_churn_rate", "EUR") === "1/4",
    halves(june, "subscriber_churn_rate", "EUR"),
  );
  const month = await ask({ measure: "subscriber_churn_rate", ...JUNE });
  ok(
    "subscriber_churn_rate: June across currencies, unconverted — 4/15 = 2,667 bps",
    month.currency_basis === "across_currencies" && month.total === 2667,
    { basis: month.currency_basis, total: month.total },
  );
  const d = measureById("subscriber_churn_rate")!;
  ok(
    "subscriber_churn_rate: not foldable, and declares count halves",
    d.aggregate === "none" && d.halves === "count",
  );
  clearOnDemandWindows();
  const w = await ask({
    measure: "subscriber_churn_rate",
    start: "2026-06-01",
    end: "2026-06-20",
    grain: "day",
  });
  ok(
    "subscriber_churn_rate: a custom window is computed for itself — 3/15 = 2,000 bps",
    w.total_basis === "window" && w.total === 2000,
    { basis: w.total_basis, total: w.total },
  );
}

// ── 6. Reactivated customers ────────────────────────────────────────────────────────────
{
  ok(
    "customers_reactivated: USD June — R1 and R4, not the paused R2",
    row(june, "customers_reactivated", "USD")?.value === 2n,
    row(june, "customers_reactivated", "USD"),
  );
  ok(
    "customers_reactivated: EUR June — R3",
    row(june, "customers_reactivated", "EUR")?.value === 1n,
    row(june, "customers_reactivated", "EUR"),
  );
  const month = await ask({ measure: "customers_reactivated", ...JUNE });
  ok(
    "customers_reactivated: June across currencies — 3",
    month.currency_basis === "across_currencies" && month.total === 3,
    { basis: month.currency_basis, total: month.total },
  );
  clearOnDemandWindows();
  const w = await ask({
    measure: "customers_reactivated",
    start: "2026-06-01",
    end: "2026-06-10",
    grain: "day",
  });
  ok(
    "customers_reactivated: served for a custom window, not summed from days — 2",
    w.total_basis === "window" && w.total === 2,
    { basis: w.total_basis, total: w.total },
  );
  const stored = await withTenant(orgId, (tx) =>
    tx
      .select({ grain: metricDaily.grain })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, bizId),
          eq(metricDaily.measure, "customers_reactivated"),
          eq(metricDaily.periodEnd, "2026-06-30"),
        ),
      ),
  );
  ok(
    "customers_reactivated: stored under both the day and the month grain",
    new Set(stored.map((s) => s.grain)).size === 2,
    stored,
  );
}

// ── 7. MRR at risk ──────────────────────────────────────────────────────────────────────
{
  const today = byDay.get("2026-07-15")!;
  ok(
    "mrr_at_risk: USD — S1 once (two unpaid invoices) plus S3 parked = 16,000",
    row(today, "mrr_at_risk", "USD")?.value === 16000n,
    row(today, "mrr_at_risk", "USD"),
  );
  ok(
    "mrr_at_risk: EUR — S6 = 4,000",
    row(today, "mrr_at_risk", "EUR")?.value === 4000n,
    row(today, "mrr_at_risk", "EUR"),
  );
  ok(
    "mrr_at_risk: a past period has no row — no history",
    !byDay.get("2026-06-30")!.some((r) => r.measure === "mrr_at_risk"),
  );
  const conv = await ask({
    measure: "mrr_at_risk",
    start: "2026-07-15",
    end: "2026-07-15",
    grain: "day",
  });
  ok(
    "mrr_at_risk: converted — 16,000 + 4,000 ÷ 0.5 = 24,000",
    conv.currency_basis === "converted" && conv.total === 24000,
    { basis: conv.currency_basis, total: conv.total },
  );
}

console.log(
  `\n${fail === 0 ? "✅" : "❌"} METRIC NEW MEASURES: ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
