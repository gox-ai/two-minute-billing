/**
 * The EQUIVALENCE GATE for the fast `metric_daily` fill (`bulk-fill.ts`).
 *
 * The fast path exists to make a 400-day backfill finish in minutes. It buys that by
 * answering a standing read once per slice instead of once per day — and the one thing a
 * cache must never do is change an answer. So this gate does not check that the fast path is
 * plausible. It checks that it is the SAME:
 *
 *   1. BYTE-IDENTICAL ROWS. The per-day path fills a window, every stored row is snapshotted,
 *      the table is emptied, the fast path fills the same window, and the two sets are
 *      compared on every key column plus `value` and `denominator`. Both directions, so a
 *      row invented by one side fails as loudly as a row lost by it.
 *   2. NULL IS NOT ZERO. A period with no figure must produce NO row; a measured zero must
 *      still produce one; and `null` must stay `null`. All three appear in the fixture and
 *      all three are asserted on their own, because a set comparison that happened to be
 *      empty would pass vacuously.
 *   3. THE AGGREGATES SURVIVE. A stock is the value at the period's close and never the sum
 *      of its days; a ratio keeps both halves; a non-additive count is written per grain.
 *      Checked at two grains, since only the month grain can show a stock summed.
 *   4. CANCELLED SUBSCRIPTIONS ARE STILL RE-RATED. The fixture holds a cancelled
 *      subscription whose `subscriptions.mrr` column is 0, live across the window. Its rate
 *      must appear in the MRR of the days it was live — on BOTH paths. A fast path that
 *      summed the column would report those days lower, which is exactly the defect the
 *      re-rating exists to prevent.
 *
 *   pnpm verify:metric-daily-fast
 */
import { and, eq } from "drizzle-orm";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription, cancelSubscription } from "@/modules/subscriptions/service";
import { applyManualDiscount } from "@/modules/coupons/service";
import { computeMetricPeriod } from "@/modules/metrics/daily/compute";
import { writeMetricDay } from "@/modules/metrics/daily/write";
import { bulkFillMetricDays } from "@/modules/metrics/daily/bulk-fill";
import { measureById } from "@/modules/metrics/daily/measures";
import {
  customers,
  invoiceLineItems,
  invoices,
  metricDaily,
  mrrMovements,
  payments,
  subscriptionItems,
  subscriptions,
  transactions,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** Pinned, so the as-of-the-run measures are the same "now" on both paths. */
const NOW = new Date("2026-07-20T12:00:00.000Z");
/** Every seeded term ends here, so a live worker never renews anything mid-run. */
const PARKED = at("2028-01-01");

// ─────────────────────────────────────────────────────────────────────────────
// Seed — its own organization, never the dev database's book.
// ─────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Metric Daily Fast Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Metric Daily Fast Biz",
  defaultCurrency: "USD",
  livemode: "test",
  timezone: "UTC",
});
const bizId = biz.id;

const starter = await createProduct({ organizationId: orgId, businessId: bizId, name: "Starter" });
const pro = await createProduct({ organizationId: orgId, businessId: bizId, name: "Pro" });
const price = (productId: string, currency: string, amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: bizId,
    productId,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor,
    interval: "month",
  });
const starterUsd = await price(starter.id, "USD", 5000);
const starterEur = await price(starter.id, "EUR", 3000);
const proUsd = await price(pro.id, "USD", 12_000);

let seq = 0;
async function subscribe(opts: {
  price: typeof starterUsd;
  country: string | null;
  startedOn: string;
  /** A SECOND plan line. Which of the two the row files under is decided by item order. */
  alsoPrice?: typeof starterUsd;
}) {
  const customer = await createCustomer({
    organizationId: orgId,
    businessId: bizId,
    email: `fast-${String(++seq).padStart(2, "0")}-${Date.now()}@example.test`,
    ...(opts.country ? { address: { country: opts.country } } : {}),
  });
  await systemDb
    .update(customers)
    .set({ createdAt: at(opts.startedOn) })
    .where(eq(customers.id, customer.id));
  const { subscription } = await createSubscription({
    organizationId: orgId,
    businessId: bizId,
    customerId: customer.id,
    now: at(opts.startedOn),
    startDate: at(opts.startedOn),
    items: [
      { price: opts.price, quantity: 1 },
      ...(opts.alsoPrice ? [{ price: opts.alsoPrice, quantity: 1 }] : []),
    ],
  });
  await systemDb
    .update(subscriptions)
    .set({ currentPeriodEnd: PARKED, trialEnd: PARKED, createdAt: at(opts.startedOn) })
    .where(eq(subscriptions.id, subscription.id));
  return { customer, subscription };
}

// Two currencies, two plans, two countries and one customer with none — the three slices
// the stock measures cut, including the null bucket each of them keeps.
const s1 = await subscribe({ price: starterUsd, country: "DE", startedOn: "2026-01-10" });
const s2 = await subscribe({ price: proUsd, country: "FR", startedOn: "2026-02-25" });
const s3 = await subscribe({ price: starterEur, country: null, startedOn: "2026-03-20" });
const s4 = await subscribe({ price: starterUsd, country: "FR", startedOn: "2026-04-02" });
/**
 * TWO plan lines. `resolvePlanProductId` files it under the FIRST — meaning the oldest
 * item, which is only "first" while the read is ordered by item id. A fast path that served
 * those items in another order would file this subscription's MRR under Pro instead of
 * Starter, and the plan slice would move with it.
 */
const s5 = await subscribe({
  price: starterUsd,
  alsoPrice: proUsd,
  country: "DE",
  startedOn: "2026-05-05",
});
const s5Items = await withTenant(orgId, (tx) =>
  tx
    .select({ id: subscriptionItems.id })
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, s5.subscription.id)),
);

/**
 * CANCELLED, and cancelled AFTER the window closes, so it is live on every sampled day.
 * `recomputeSubscriptionMrr` zeroes its column the moment it churns; the days it was live
 * must still carry the rate it was being billed, which only the re-rating can supply.
 */
await cancelSubscription({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: s2.subscription.id,
  atPeriodEnd: false,
  now: at("2026-08-15"),
});
// Live, active, and worth nothing: a MEASURED zero, which must be a row rather than a gap.
await applyManualDiscount({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: s4.subscription.id,
  kind: "percentage",
  percentOffBps: 10_000,
  durationType: "forever",
  now: at("2026-04-02"),
});

const stamp = (id: string, set: Record<string, Date>) =>
  systemDb.update(subscriptions).set(set).where(eq(subscriptions.id, id));
await stamp(s3.subscription.id, {
  trialStart: at("2026-06-05"),
  trialEnd: at("2026-06-19"),
  activatedAt: at("2026-06-19"),
});
await stamp(s1.subscription.id, { trialStart: at("2026-06-02") });

// The ledger, dated exactly — the services stamp wall clock, which is outside the window.
const flow = (
  iso: string,
  reason: string,
  sub: { subscription: { id: string }; customer: { id: string } },
  currency: string,
  previous: number,
  next: number,
  planProductId: string | null,
) => ({
  organizationId: orgId,
  businessId: bizId,
  subscriptionId: sub.subscription.id,
  customerId: sub.customer.id,
  reason,
  planProductId,
  currency,
  previousMrrMinor: BigInt(previous),
  newMrrMinor: BigInt(next),
  deltaMinor: BigInt(next - previous),
  occurredAt: new Date(iso),
});
await withTenant(orgId, (tx) =>
  tx.insert(mrrMovements).values([
    flow("2026-06-02T09:00:00.000Z", "new", s1, "USD", 0, 5000, starter.id),
    flow("2026-06-07T10:00:00.000Z", "expansion", s1, "USD", 5000, 6000, starter.id),
    flow("2026-06-11T13:30:00.000Z", "new", s2, "USD", 0, 12_000, pro.id),
    flow("2026-06-14T18:00:00.000Z", "new", s3, "EUR", 0, 3000, starter.id),
    // A NULL plan is a real bucket, not an excluded one.
    flow("2026-06-18T08:00:00.000Z", "new", s4, "USD", 0, 1100, null),
    flow("2026-06-21T10:00:00.000Z", "contraction", s2, "USD", 12_000, 9000, pro.id),
    flow("2026-06-27T10:00:00.000Z", "churn", s4, "USD", 1100, 0, starter.id),
    flow("2026-06-30T23:59:59.999Z", "new", s1, "USD", 0, 700, starter.id),
    flow("2026-07-01T00:00:00.000Z", "reactivation", s4, "USD", 0, 1100, starter.id),
    flow("2026-07-09T10:00:00.000Z", "pause", s3, "EUR", 3000, 0, starter.id),
  ]),
);

// Documents and cash, so the delegated invoice and payment families are exercised too.
let docSeq = 0;
async function invoice(i: {
  currency: string;
  status: string;
  createdAt: string;
  totalMinor: number;
  paidAt?: string | null;
  customerId: string;
}): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: bizId,
        customerId: i.customerId,
        publicId: `inv_fast_${++docSeq}_${Date.now()}`,
        status: i.status,
        currency: i.currency,
        subtotalMinor: BigInt(i.totalMinor),
        totalMinor: BigInt(i.totalMinor),
        amountDueMinor: i.paidAt ? 0n : BigInt(i.totalMinor),
        dueDate: at(i.createdAt),
        paidAt: i.paidAt ? at(i.paidAt) : null,
        createdAt: at(i.createdAt),
      })
      .returning({ id: invoices.id });
    await tx.insert(invoiceLineItems).values({
      organizationId: orgId,
      businessId: bizId,
      invoiceId: row!.id,
      publicId: `il_fast_${docSeq}_${Date.now()}`,
      description: "line",
      quantity: 1,
      unitAmountMinor: BigInt(i.totalMinor),
      amountMinor: BigInt(i.totalMinor),
      discountMinor: 0n,
      kind: "subscription",
      createdAt: at(i.createdAt),
    });
    return row!.id;
  });
}

const invA = await invoice({
  currency: "USD",
  status: "paid",
  createdAt: "2026-06-12",
  totalMinor: 12_000,
  paidAt: "2026-06-15",
  customerId: s2.customer.id,
});
await invoice({
  currency: "EUR",
  status: "payment_due",
  createdAt: "2026-06-22",
  totalMinor: 3000,
  customerId: s3.customer.id,
});

await withTenant(orgId, async (tx) => {
  await tx.insert(payments).values({
    organizationId: orgId,
    businessId: bizId,
    customerId: s2.customer.id,
    invoiceId: invA,
    publicId: `pay_fast_${Date.now()}`,
    status: "succeeded",
    amountMinor: 12_000n,
    currency: "USD",
    providerKey: "manual",
    createdAt: at("2026-06-15"),
  });
  await tx.insert(transactions).values({
    organizationId: orgId,
    businessId: bizId,
    customerId: s2.customer.id,
    publicId: `txn_fast_${Date.now()}`,
    type: "payment",
    status: "succeeded",
    amountMinor: 12_000n,
    currency: "USD",
    occurredAt: at("2026-06-15"),
    createdAt: at("2026-06-15"),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The window. Days across two months plus both months themselves — only a coarser
// grain can show a stock that was summed instead of taken at the close.
// ─────────────────────────────────────────────────────────────────────────────
const DAYS: string[] = [];
for (
  let d = new Date("2026-06-01T00:00:00.000Z");
  d < at("2026-07-16");
  d.setUTCDate(d.getUTCDate() + 1)
) {
  DAYS.push(d.toISOString().slice(0, 10));
}
const MONTHS = ["2026-06-30", "2026-07-31"];

type Key = string;
const SEP = String.fromCharCode(0);
const readable = (k: Key) => k.split(SEP).join(" ");
const rowKey = (r: {
  grain: string;
  periodEnd: string;
  measure: string;
  dim: string;
  dimValue: string;
  currency: string;
}): Key => [r.grain, r.periodEnd, r.measure, r.dim, r.dimValue, r.currency].join(SEP);

const readAll = async (): Promise<Map<Key, string>> =>
  withTenant(orgId, async (tx) => {
    const rows = await tx.select().from(metricDaily).where(eq(metricDaily.businessId, bizId));
    return new Map(
      rows.map((r) => [
        rowKey(r),
        `${r.value === null ? "NULL" : r.value}|${r.denominator === null ? "NULL" : r.denominator}`,
      ]),
    );
  });

const clear = () =>
  withTenant(orgId, (tx) => tx.delete(metricDaily).where(eq(metricDaily.businessId, bizId)));

// ── The per-day path: the reference ──────────────────────────────────────────
await withTenant(orgId, async (tx) => {
  for (const day of DAYS) {
    const rows = await computeMetricPeriod(tx, bizId, "day", day, NOW);
    await writeMetricDay({
      organizationId: orgId,
      businessId: bizId,
      grain: "day",
      periodEnd: day,
      rows,
    });
  }
  for (const m of MONTHS) {
    const rows = await computeMetricPeriod(tx, bizId, "month", m, NOW, { onlyNonAdditive: true });
    await writeMetricDay({
      organizationId: orgId,
      businessId: bizId,
      grain: "month",
      periodEnd: m,
      rows,
    });
  }
});
const slow = await readAll();
await clear();
ok("the reference path wrote rows to compare", slow.size > 0);
// Without it, the item ORDER cannot matter and the plan slice proves nothing about it.
ok("the fixture holds a subscription with two plan lines", s5Items.length === 2);

// ── The fast path: the same window, the same instant ─────────────────────────
// A slice SMALLER than the window on purpose — a cache that only ever survived one slice
// would pass a single-slice run and fail here.
const fast = await bulkFillMetricDays({
  organizationId: orgId,
  businessId: bizId,
  grain: "day",
  days: DAYS,
  write: true,
  now: NOW,
  sliceDays: 7,
});
await bulkFillMetricDays({
  organizationId: orgId,
  businessId: bizId,
  grain: "month",
  days: MONTHS,
  write: true,
  now: NOW,
  sliceDays: 1,
  onlyNonAdditive: true,
});
const fastRows = await readAll();

// ── 1. Byte-identical, both directions ───────────────────────────────────────
const differing: string[] = [];
for (const [k, v] of slow) {
  const other = fastRows.get(k);
  if (other === undefined) differing.push(`missing from fast: ${readable(k)}`);
  else if (other !== v) differing.push(`${readable(k)}: slow=${v} fast=${other}`);
}
for (const k of fastRows.keys()) {
  if (!slow.has(k)) differing.push(`invented by fast: ${readable(k)}`);
}
console.log(`compared ${slow.size} rows (fast wrote ${fastRows.size}); ${differing.length} differ`);
for (const d of differing.slice(0, 20)) console.log(`  ${d}`);
ok("row counts match", slow.size === fastRows.size);
ok("every row matches on value and denominator", differing.length === 0);
ok("the fill reported the rows it wrote", fast.rows > 0);

// ── 2. Null is not zero ──────────────────────────────────────────────────────
const nullRows = [...slow].filter(([, v]) => v.startsWith("NULL"));
const zeroRows = [...slow].filter(([, v]) => v.startsWith("0|"));
ok("the fixture produced a NULL value (not applicable)", nullRows.length > 0);
ok("the fixture produced a measured zero", zeroRows.length > 0);
ok(
  "every NULL stayed NULL on the fast path",
  nullRows.every(([k, v]) => fastRows.get(k) === v),
);
ok(
  "every measured zero is still a row on the fast path",
  zeroRows.every(([k, v]) => fastRows.get(k) === v),
);
/**
 * The as-of-the-run measures answer only the period containing `now`. Every sampled day is
 * in the past, so they must be ABSENT — a fast path that filled the gap with a zero would
 * be inventing a history nothing recorded.
 */
const asOfRunAbsent = ["cards_expired", "cards_expiring", "receivables_outstanding"].every(
  (m) => ![...fastRows.keys()].some((k) => k.split(SEP)[2] === m),
);
ok("an unanswerable past period gets NO row, not a zero", asOfRunAbsent);

// ── 3. The aggregates survive ────────────────────────────────────────────────
const valueOf = (
  src: Map<Key, string>,
  grain: string,
  periodEnd: string,
  measure: string,
  currency: string,
): bigint | null | undefined => {
  const v = src.get([grain, periodEnd, measure, "", "", currency].join(SEP));
  if (v === undefined) return undefined;
  const [value] = v.split("|");
  return value === "NULL" ? null : BigInt(value!);
};
const juneDays = DAYS.filter((d) => d.startsWith("2026-06"));
const mrrSum = juneDays.reduce((n, d) => n + (valueOf(fastRows, "day", d, "mrr", "USD") ?? 0n), 0n);
const mrrClose = valueOf(fastRows, "day", "2026-06-30", "mrr", "USD");
ok(
  "a stock is the value at the close, never the sum of its days",
  mrrClose != null && mrrClose > 0n && mrrClose !== mrrSum,
);
const ratioRow = [...fastRows].find(([k]) => {
  const m = measureById(k.split(SEP)[2]!);
  return m?.aggregate === "ratio";
});
ok("a ratio stores both halves", ratioRow != null && !ratioRow[1].endsWith("|NULL"));
const nonAdditive = [...fastRows.keys()].filter(
  (k) => measureById(k.split(SEP)[2]!)?.aggregate === "none",
);
ok(
  "a non-additive count is written at the month grain too",
  nonAdditive.some((k) => k.startsWith(`month${SEP}`)),
);

// ── 4. Cancelled subscriptions are still re-rated ────────────────────────────
const [cancelled] = await withTenant(orgId, (tx) =>
  tx
    .select({ mrr: subscriptions.mrr, status: subscriptions.status })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, s2.subscription.id), eq(subscriptions.businessId, bizId))),
);
ok(
  "the fixture's cancelled row carries a zeroed column",
  cancelled?.status === "cancelled" && (cancelled.mrr ?? 0n) === 0n,
);
/**
 * It was live on every sampled day and is the only Pro line, so the Pro plan slice is its
 * rate alone. A path that summed the column would write 0 here.
 */
const proSlice = fastRows.get(["day", "2026-07-10", "mrr", "plan", pro.id, "USD"].join(SEP));
ok(
  "a cancelled subscription still carries its rate on the days it was live",
  proSlice != null && BigInt(proSlice.split("|")[0]!) > 0n,
);

for (const [name, passed] of checks) console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
const failed = checks.filter(([, c]) => !c);
console.log("");
const verdict = failed.length === 0;
console.log(
  verdict
    ? `✅ METRIC-DAILY-FAST: PASS (${checks.length}/${checks.length})`
    : `❌ METRIC-DAILY-FAST: FAIL (${failed.length}/${checks.length} failed)`,
);
await closeDb();
process.exit(verdict ? 0 : 1);
