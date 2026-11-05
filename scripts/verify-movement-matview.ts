/**
 * The movement waterfall's pre-grouped ledger (0273) answers exactly what the ledger does.
 *
 *   A. TENANCY, mutation-tested. The matview has no RLS; the definer-rights view carries the
 *      predicate. With no tenant set the view returns nothing, another org sees none of this
 *      business, and the app role holds NO privilege on the matview itself. The mutation
 *      grants that privilege in a rolled-back transaction and shows the matview then reads
 *      across tenants — the shape `security_invoker` would force.
 *   B. EXACT. Both movement summaries, converted and per-currency, equal the ledger rebuild
 *      to the minor unit, over a book with rate moves, plan changes, a trial conversion,
 *      repeated identical deltas and a quiet month.
 *   C. THE TAIL. Rows written after the refresh — one backdated into a closed month, one in
 *      this month — are counted, and the answer still equals the rebuild.
 *   D. RESTATEMENTS NET. A correction at the same instant as the row it corrects is summed
 *      with it before any column adds magnitudes — folded, and when written after the refresh
 *      against an original the fold already holds.
 *
 *   pnpm verify:movement-matview
 */
import { sql } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { businesses, exchangeRateHistory, mrrMovements } from "@db/schema";
import { eq } from "drizzle-orm";
import { resolveReport } from "@/modules/metrics/reports/resolve";
import {
  movementFold,
  movementPath,
  refreshMovementSummary,
  resetMovementPath,
} from "@/modules/metrics/reports/movement-matview";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "Movement Fold Org" });
const orgId = org.organization.id;
const other = await createOrganization({ name: "Movement Fold Other Org" });
const otherOrgId = other.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Movement Fold",
  defaultCurrency: "USD",
  livemode: "test",
});

// ── A book ───────────────────────────────────────────────────────────────────
const planA = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan A" });
const planB = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plan B" });

async function subscriptionIn(currency: string, trialDays?: number) {
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `fold${Math.random()}@a.com`,
    currency,
  });
  const price = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: planA.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor: 10_000,
    interval: "month",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const s = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
    trialDays,
  });
  return { subscriptionId: s.subscription.id, customerId: c.id, currency };
}

const usd = await subscriptionIn("USD");
const inr = await subscriptionIn("INR");
const eur = await subscriptionIn("EUR");
const trial = await subscriptionIn("USD", 14);

const now = new Date();
const monthsAgo = (k: number, day = 10) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, day, 12));
const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);

// Rates move, so the FX column is non-zero and conversion is instant-dependent.
await systemDb
  .update(businesses)
  .set({ exchangeRates: { INR: "83.17", EUR: "0.9131" } })
  .where(eq(businesses.id, biz.id));
await systemDb.insert(exchangeRateHistory).values([
  {
    organizationId: orgId,
    businessId: biz.id,
    currency: "INR",
    baseCurrency: "USD",
    rate: "79.43",
    effectiveFrom: monthsAgo(16),
  },
  {
    organizationId: orgId,
    businessId: biz.id,
    currency: "INR",
    baseCurrency: "USD",
    rate: "83.17",
    effectiveFrom: monthsAgo(4),
  },
  {
    organizationId: orgId,
    businessId: biz.id,
    currency: "EUR",
    baseCurrency: "USD",
    rate: "0.9407",
    effectiveFrom: monthsAgo(16),
  },
  {
    organizationId: orgId,
    businessId: biz.id,
    currency: "EUR",
    baseCurrency: "USD",
    rate: "0.9131",
    effectiveFrom: monthsAgo(7),
  },
]);

type Seed = {
  s: typeof usd;
  reason: string;
  delta: number;
  at: Date;
  plan?: string | null;
  prev?: string | null;
  createdAt?: Date;
};
const movement = (m: Seed) => ({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: m.s.subscriptionId,
  customerId: m.s.customerId,
  reason: m.reason,
  planProductId: m.plan === undefined ? planA.id : m.plan,
  previousPlanProductId: m.prev ?? null,
  currency: m.s.currency,
  previousMrrMinor: 0n,
  newMrrMinor: BigInt(Math.max(m.delta, 0)),
  deltaMinor: BigInt(m.delta),
  occurredAt: m.at,
  createdAt: m.createdAt ?? twoDaysAgo,
});

const seeds: Seed[] = [
  { s: usd, reason: "new", delta: 10_000, at: monthsAgo(13) },
  { s: inr, reason: "new", delta: 415_837, at: monthsAgo(12) },
  { s: eur, reason: "new", delta: 9_131, at: monthsAgo(12) },
  { s: trial, reason: "new", delta: 4_999, at: monthsAgo(11) }, // a conversion
  // Identical deltas in one cell: the count must multiply a per-row rounding.
  ...Array.from({ length: 5 }, () => ({
    s: inr,
    reason: "expansion",
    delta: 8_317 + 41,
    at: monthsAgo(10),
  })),
  { s: usd, reason: "expansion", delta: 2_500, at: monthsAgo(9), plan: planB.id, prev: planA.id }, // upgrade
  { s: eur, reason: "contraction", delta: -1_234, at: monthsAgo(8), plan: null, prev: planA.id }, // downgrade onto no plan
  { s: inr, reason: "contraction", delta: -20_001, at: monthsAgo(8) },
  // monthsAgo(5) is QUIET — no movement at all.
  { s: eur, reason: "pause", delta: -7_897, at: monthsAgo(6) },
  { s: eur, reason: "resume", delta: 7_897, at: monthsAgo(4) },
  { s: usd, reason: "churn", delta: -12_500, at: monthsAgo(3) },
  { s: usd, reason: "reactivation", delta: 12_500, at: monthsAgo(2) },
  { s: inr, reason: "expansion", delta: 99_999, at: monthsAgo(1), plan: planB.id, prev: planA.id },
  { s: inr, reason: "new", delta: 1, at: monthsAgo(1) },
  // This month — always read raw, whatever the fold holds.
  {
    s: usd,
    reason: "expansion",
    delta: 777,
    at: new Date(Math.min(monthsAgo(0, 1).getTime(), twoDaysAgo.getTime())),
  },
];
await systemDb.insert(mrrMovements).values(seeds.map(movement));
// D: a restatement the refresh will fold — the −1,234 downgrade was really −1,000.
await systemDb.insert(mrrMovements).values(
  movement({
    s: eur,
    reason: "contraction",
    delta: 234,
    at: monthsAgo(8),
    plan: null,
    prev: planA.id,
  }),
);

const KEYS = ["mrr_movement_summary", "arr_movement_summary"];
const CURRENCIES = [undefined, "USD", "INR", "EUR"];

async function tables(fold: boolean) {
  movementFold.enabled = fold;
  const out: string[] = [];
  for (const key of KEYS)
    for (const currency of CURRENCIES) {
      const r = await resolveReport(orgId, biz.id, key, { currency });
      out.push(JSON.stringify({ key, currency, headline: r.headline, rows: r.table?.rows }));
    }
  movementFold.enabled = true;
  return out;
}

await refreshMovementSummary();

// ── A. Tenancy ───────────────────────────────────────────────────────────────
const [held] = (await systemDb.execute(
  sql`select count(*)::int as n from mrr_movement_summary_mv where business_id = ${biz.id}::uuid`,
)) as unknown as Array<{ n: number }>;
ok("the fold holds this business (precondition for every check below)", (held?.n ?? 0) > 0);
ok(
  "…in fewer rows than the ledger it groups (identical deltas share a cell)",
  (held?.n ?? 0) < seeds.length,
);

async function asApp<T>(orgSetting: string | null, q: ReturnType<typeof sql>): Promise<T[]> {
  return systemDb.transaction(async (tx) => {
    await tx.execute(sql`set local role tmbilling_app`);
    if (orgSetting) await tx.execute(sql`select set_config('app.org_id', ${orgSetting}, true)`);
    return (await tx.execute(q)) as unknown as T[];
  });
}
const viewCount = sql`select count(*)::int as n from mrr_movement_summary where business_id = ${biz.id}::uuid`;

// The mutation first: grant what `security_invoker` would need, and the matview reads across
// tenants. If this ever reads 0, the checks below prove nothing.
let leaked = -1;
let privilegedWhenGranted = false;
await systemDb
  .transaction(async (tx) => {
    await tx.execute(sql`grant select on mrr_movement_summary_mv to tmbilling_app`);
    const [p] = (await tx.execute(
      sql`select has_table_privilege('tmbilling_app', 'mrr_movement_summary_mv', 'SELECT') as p`,
    )) as unknown as Array<{ p: boolean }>;
    privilegedWhenGranted = p?.p === true;
    await tx.execute(sql`set local role tmbilling_app`);
    const [r] = (await tx.execute(
      sql`select count(*)::int as n from mrr_movement_summary_mv where business_id = ${biz.id}::uuid`,
    )) as unknown as Array<{ n: number }>;
    leaked = r?.n ?? 0;
    throw new Error("rollback");
  })
  .catch((e) => {
    if ((e as Error).message !== "rollback") throw e;
  });
ok("mutation: with a grant on the matview, the app role reads it with NO tenant set", leaked > 0);
ok("mutation: …and the privilege check below sees that grant", privilegedWhenGranted);

const [priv] = (await systemDb.execute(
  sql`select has_table_privilege('tmbilling_app', 'mrr_movement_summary_mv', 'SELECT') as p`,
)) as unknown as Array<{ p: boolean }>;
ok("the app role holds no privilege on the matview itself", priv?.p === false);
ok(
  "no tenant set: the view returns nothing (fails closed)",
  (await asApp<{ n: number }>(null, viewCount))[0]?.n === 0,
);
ok(
  "another organization sees none of this business",
  (await asApp<{ n: number }>(otherOrgId, viewCount))[0]?.n === 0,
);
ok(
  "the owning organization sees it through the view",
  (await asApp<{ n: number }>(orgId, viewCount))[0]?.n === held?.n,
);

// ── B. Exact ─────────────────────────────────────────────────────────────────
const reference = await tables(false);
resetMovementPath();
const folded = await tables(true);
ok(
  `the fold was actually read (${movementPath.fromMatview} of ${reference.length} answers)`,
  movementPath.fromMatview === reference.length && movementPath.rebuilt === 0,
);
reference.forEach((ref, i) =>
  ok(`exact: ${JSON.parse(ref).key} · ${JSON.parse(ref).currency ?? "ALL"}`, folded[i] === ref),
);
const fx = JSON.parse(reference[0]!).rows.some((r: { values: number[] }) => r.values[11] !== 0);
ok("the converted book has a non-zero FX column (rates really moved)", fx);

// D: the folded restatement reads as its net, not as 1,234 + 234.
{
  const r = await resolveReport(orgId, biz.id, "mrr_movement_summary", { currency: "EUR" });
  const cols = r.table!.columns.map((c: { key: string }) => c.key);
  const m8 = monthsAgo(8);
  const label = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m8.getUTCMonth()]} ${m8.getUTCFullYear()}`;
  const row = r.table!.rows.find((x: { period: string }) => x.period === label);
  ok(
    "restated: a folded correction nets — the downgrade reads 1000, not 1468",
    row?.values[cols.indexOf("downgrade")] === 1000,
  );
}

// ── C. The tail ──────────────────────────────────────────────────────────────
await systemDb.insert(mrrMovements).values([
  movement({
    s: eur,
    reason: "expansion",
    delta: 3_333,
    at: monthsAgo(3),
    createdAt: new Date(),
  }),
  movement({
    s: inr,
    reason: "contraction",
    delta: -4_159,
    at: monthsAgo(0, 1),
    createdAt: new Date(),
  }),
]);
const reference2 = await tables(false);
resetMovementPath();
const folded2 = await tables(true);
ok("rows written after the refresh move the answer", reference2[0] !== reference[0]);
ok("…the fold is still what answers", movementPath.fromMatview === reference2.length);
reference2.forEach((ref, i) =>
  ok(
    `exact with a tail: ${JSON.parse(ref).key} · ${JSON.parse(ref).currency ?? "ALL"}`,
    folded2[i] === ref,
  ),
);

// D: a correction written AFTER the refresh, against an original the fold already holds. It
// cannot be netted across the split, so the waterfall rebuilds until the next refresh.
await systemDb
  .insert(mrrMovements)
  .values(
    movement({ s: usd, reason: "new", delta: -3_000, at: monthsAgo(13), createdAt: new Date() }),
  );
const reference3 = await tables(false);
resetMovementPath();
const folded3 = await tables(true);
ok(
  "restated late: the fold stands aside (rebuilt, not read)",
  movementPath.rebuilt === reference3.length && movementPath.fromMatview === 0,
);
ok(
  "restated late: …and the answer is the ledger's",
  folded3.every((f, i) => f === reference3[i]),
);
await refreshMovementSummary();

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log(
  failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length} failed`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
