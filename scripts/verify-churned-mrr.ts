/**
 * What a CHURNED subscription was worth, in the buckets it was live in.
 *
 * `subscriptions.mrr` is 0 once a row is cancelled, so the historical series needs a
 * different number: the rate it carried while it was earning. That number used to be
 * reconstructed on read by re-rating the surviving items against the still-active
 * discounts — and the items survive a cancellation while THE DISCOUNTS DO NOT. So a
 * subscription comped to nothing was valued in every past bucket at its plan's LIST PRICE,
 * and the further back you looked the worse it got, while today's figure stayed right.
 *
 * The rate is stored now (`last_earning_mrr`, 0271), written while the subscription is
 * still earning. This suite is the gate on that:
 *
 *   A. a cancelled subscription that carried a 100% discount contributes ZERO to history,
 *      at several past instants, through BOTH readers (the daily snapshot and the
 *      analytics reconstruction) — with its discount row REMOVED after the cancellation,
 *      which is the state a real churned book is in and the exact condition the old
 *      re-rate got wrong;
 *   B. one that genuinely paid still carries its real rate into history;
 *   C. cancelling a subscription TODAY does not move a past day's figure;
 *   D. currencies stay apart — a EUR churn never lands in the USD total;
 *   E. pause does not erase it: a subscription paused and then cancelled still reports the
 *      rate it carried before the pause, not the 0 the pause left in `mrr`.
 *
 *   pnpm verify:churned-mrr
 */
import { eq } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  createSubscription,
  cancelSubscription,
  pauseSubscription,
} from "@/modules/subscriptions/service";
import { applyManualDiscount, removeDiscount } from "@/modules/coupons/service";
import { computeBusinessAnalytics } from "@/modules/metrics/analytics";
import { computeSnapshot, utcDayString, endOfDay } from "@/modules/metrics/snapshots";
import { subscriptions } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const DAY = 86_400_000;
const wall = Date.now();
const ago = (days: number) => new Date(wall - days * DAY);
/** Everything starts here; everything that churns churns at T1; the pause outlives it. */
const T0 = ago(300);
const T1 = ago(120);
const T2 = ago(60);
/** Three instants strictly inside every subscription's live window. */
const PAST = [ago(250), ago(200), ago(150)];

const org = await createOrganization({ name: "Churned MRR Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Churned MRR Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plans" });

const price = (amountMinor: number, currency = "USD") =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency,
    amountMinor,
    interval: "month",
  });

async function sub(amountMinor: number, currency = "USD", at: Date = T0) {
  const p = await price(amountMinor, currency);
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `ch${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  return (
    await createSubscription({
      organizationId: orgId,
      businessId: biz.id,
      customerId: c.id,
      now: at,
      items: [{ price: p, quantity: 1 }],
    })
  ).subscription;
}

/** Comp it to nothing, the way a free account is actually carried. */
const comp = (subscriptionId: string, now: Date) =>
  applyManualDiscount({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId,
    kind: "percentage",
    percentOffBps: 10000,
    durationType: "forever",
    now,
  });

const cancel = (subscriptionId: string, now: Date) =>
  cancelSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId,
    atPeriodEnd: false,
    now,
  });

const stored = async (id: string) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select({ mrr: subscriptions.mrr, last: subscriptions.lastEarningMrr })
        .from(subscriptions)
        .where(eq(subscriptions.id, id)),
    )
  )[0]!;

/** One past day's stored-snapshot MRR, per currency. */
const snapshotMrr = async (at: Date, currency: string) => {
  const rows = await withTenant(orgId, (tx) => computeSnapshot(tx, biz.id, utcDayString(at)));
  return Number(rows.find((r) => r.currency === currency)?.mrrMinor ?? 0n);
};

/** The same day through the analytics reconstruction, which is the other reader. */
const analyticsMrr = async (at: Date, currency: string) =>
  (
    await computeBusinessAnalytics(orgId, biz.id, {
      range: "daily",
      currency,
      now: endOfDay(utcDayString(at)),
    })
  ).kpis.mrr.value;

// ── The book ─────────────────────────────────────────────────────────────────
// A genuine payer that churned: $50/mo, live T0 → T1.
const payer = await sub(5000);
await cancel(payer.id, T1);

// A COMPED account that churned: $50/mo list, discounted to nothing, live T0 → T1 — and
// its discount removed afterwards, which is the state the real book is in. Nothing on the
// row then says it was free except the figure recorded while it still was.
const comped = await sub(5000);
await comp(comped.id, T0);
await cancel(comped.id, T1);
await removeDiscount(orgId, comped.id);

// Paused at T1, cancelled at T2. Both zero `mrr`; neither may erase the rate it earned.
const pausedThenGone = await sub(8000);
await pauseSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: pausedThenGone.id,
  now: T1,
});
await cancel(pausedThenGone.id, T2);

// Still live, and still comped-live — the second is what check C cancels TODAY.
await sub(7000); // still live and paying — the 7000 that today's figure must be
const compedLive = await sub(9000);
await comp(compedLive.id, T0);

// A EUR churn, for the currency wall.
const euro = await sub(3000, "EUR");
await cancel(euro.id, T1);

// USD, at any instant strictly between T0 and T1:
//   payer 5000 + comped 0 + paused-then-gone 8000 + live 7000 + comped-live 0 = 20000.
const EXPECTED_USD = 20000;

// ── E. What the column holds ─────────────────────────────────────────────────
{
  const p = await stored(payer.id);
  const c = await stored(comped.id);
  const q = await stored(pausedThenGone.id);
  ok("column: a churned payer records the rate it was earning", p.last === 5000n && p.mrr === 0n);
  ok("column: a churned COMPED account records 0, not its list price", c.last === 0n);
  ok(
    "column: pause then cancel keeps the pre-pause rate — neither zeroing write erased it",
    q.last === 8000n && q.mrr === 0n,
  );
}

// ── A + B + D. History, at three past instants, through both readers ─────────
for (const at of PAST) {
  const label = utcDayString(at);
  const snap = await snapshotMrr(at, "USD");
  const analytics = await analyticsMrr(at, "USD");
  ok(
    `history ${label}: stored day = ${EXPECTED_USD} — the comped churn counts for NOTHING, ` +
      `not its $50 list price`,
    snap === EXPECTED_USD,
  );
  ok(
    `history ${label}: the analytics reconstruction agrees with the stored day`,
    analytics === EXPECTED_USD,
  );
  ok(
    `history ${label}: EUR stays its own figure (3000), never folded into USD`,
    (await snapshotMrr(at, "EUR")) === 3000,
  );
}

// ── C. A cancellation today does not restate yesterday ───────────────────────
{
  const before = await Promise.all(PAST.map((at) => snapshotMrr(at, "USD")));
  await cancel(compedLive.id, new Date());
  // Its discount goes with it, exactly as check A's did — the condition under which a
  // re-rate from items silently returns list price.
  await removeDiscount(orgId, compedLive.id);
  const after = await Promise.all(PAST.map((at) => snapshotMrr(at, "USD")));
  ok(
    "today's cancellation leaves every past day exactly as it was",
    before.every((v, i) => v === after[i]) && after.every((v) => v === EXPECTED_USD),
  );
  const z = await stored(compedLive.id);
  ok("today's cancellation records the 0 it was actually earning", z.last === 0n);
  ok(
    "and today's own figure is the live book alone (7000)",
    (await analyticsMrr(new Date(), "USD")) === 7000,
  );
}

// ── A rate recorded before 0271 is not lost at cancellation ────────────────────────────
// A subscription earning since before the column existed holds NULL there until something
// recomputes it. Cancelling it must record the rate it carried, or history re-rates its items
// at list price — which is exactly how two churned accounts read wrong on the production book.
{
  const legacy = await sub(4_200);
  await systemDb
    .update(subscriptions)
    .set({ lastEarningMrr: null })
    .where(eq(subscriptions.id, legacy.id));
  await cancel(legacy.id, new Date(T0.getTime() + 20 * 86_400_000));
  const after = await stored(legacy.id);
  ok(
    "legacy: cancelling a row with no recorded rate keeps the rate it carried",
    after.mrr === 0n && after.last === 4_200n,
  );
}

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
