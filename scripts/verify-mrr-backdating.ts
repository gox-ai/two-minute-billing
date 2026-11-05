/**
 * A movement is dated WHEN IT HAPPENED, not when the row was written.
 *
 * `mrr_movements` claims one identity: **Σ delta over a window = the change in MRR across
 * that window**. It holds only while `occurred_at` is the effective instant. Every
 * movement but the opening one used to take the column default — wall clock — so a
 * backdated cancel, pause or discount filed its delta in the period the operator happened
 * to be sitting in, and the column has no UPDATE grant, so a wrong row can only ever be
 * compensated.
 *
 * The fixture is built entirely in the past, then read through a trailing 30-day window
 * that must contain exactly ONE move. Wall-clock dating drags all of them into it.
 *
 *   pnpm verify:mrr-backdating
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import {
  cancelSubscription,
  createSubscription,
  pauseSubscription,
} from "@/modules/subscriptions/service";
import { applyManualDiscount } from "@/modules/coupons/service";
import { mrrMovements, subscriptions } from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const DAY = 24 * 60 * 60 * 1000;
const wallClock = new Date();
const T0 = new Date(wallClock.getTime() - 90 * DAY); // every subscription starts here
const T1 = new Date(wallClock.getTime() - 45 * DAY); // every backdated operation happens here
const windowStart = new Date(wallClock.getTime() - 30 * DAY);

const org = await createOrganization({ name: "Backdating Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Backdating Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const product = await createProduct({ organizationId: orgId, businessId: biz.id, name: "Plans" });
const price = (amountMinor: number) =>
  createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: product.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor,
    interval: "month",
  });

async function newSub(amountMinor: number, startedAt: Date) {
  const p = await price(amountMinor);
  const c = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: `bd${Math.random()}@a.com`,
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: c,
    token: "tok_4242",
  });
  const created = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: c.id,
    now: startedAt,
    items: [{ price: p, quantity: 1 }],
  });
  return created.subscription;
}

const movementsFor = (subscriptionId: string) =>
  withTenant(orgId, (tx) =>
    tx
      .select({
        reason: mrrMovements.reason,
        delta: mrrMovements.deltaMinor,
        occurredAt: mrrMovements.occurredAt,
      })
      .from(mrrMovements)
      .where(eq(mrrMovements.subscriptionId, subscriptionId)),
  );

/** Within a day of the intended instant — a day-anchored business floors it. */
const dated = (at: Date | null | undefined, expected: Date) =>
  at != null && Math.abs(at.getTime() - expected.getTime()) <= 26 * 60 * 60 * 1000;
/** Far enough from the wall clock that only a real effective date can explain it. */
const notWallClock = (at: Date | null | undefined) =>
  at != null && wallClock.getTime() - at.getTime() > 20 * DAY;

// ── A. Backdated cancel ──────────────────────────────────────────────────────
const subA = await newSub(5000, T0);
await cancelSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: subA.id,
  atPeriodEnd: false,
  now: T1,
});
{
  const rows = await movementsFor(subA.id);
  const churn = rows.find((r) => r.reason === "churn");
  const opened = rows.find((r) => r.reason === "new");
  ok("cancel: the churn movement exists", churn != null);
  ok("cancel: the churn movement is dated at the cancel instant", dated(churn?.occurredAt, T1));
  ok("cancel: the churn movement is NOT dated at wall clock", notWallClock(churn?.occurredAt));
  ok("cancel: the opening move is still dated at the start date", dated(opened?.occurredAt, T0));
}

// ── B. Backdated pause ───────────────────────────────────────────────────────
const subB = await newSub(7000, T0);
await pauseSubscription({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: subB.id,
  now: T1,
});
{
  const rows = await movementsFor(subB.id);
  const paused = rows.find((r) => r.reason === "pause");
  ok("pause: the pause movement exists", paused != null);
  ok("pause: the pause movement is dated at the pause instant", dated(paused?.occurredAt, T1));
  ok("pause: the pause movement is NOT dated at wall clock", notWallClock(paused?.occurredAt));
}

// ── C. Backdated discount (the coupons module's own call site) ───────────────
const subC = await newSub(4000, T0);
await applyManualDiscount({
  organizationId: orgId,
  businessId: biz.id,
  subscriptionId: subC.id,
  kind: "percentage",
  percentOffBps: 5000,
  durationType: "forever",
  now: T1,
});
{
  const rows = await movementsFor(subC.id);
  const contraction = rows.find((r) => r.reason === "contraction");
  ok("discount: the contraction movement exists", contraction != null);
  ok(
    "discount: the contraction movement is dated at the apply instant",
    dated(contraction?.occurredAt, T1),
  );
  ok(
    "discount: the contraction movement is NOT dated at wall clock",
    notWallClock(contraction?.occurredAt),
  );
  ok("discount: the contraction is half the rate", contraction?.delta === -2000n);
}

// ── D. One sale inside the window ────────────────────────────────────────────
// Everything above happened 45 days ago, so the last 30 days contain this and nothing
// else. That is the fact the whole table exists to state.
await newSub(3000, wallClock);

// ── The identity ─────────────────────────────────────────────────────────────
const sumDeltas = async (from?: Date) =>
  (
    await withTenant(orgId, (tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}), 0)` })
        .from(mrrMovements)
        .where(
          from
            ? and(eq(mrrMovements.businessId, biz.id), gte(mrrMovements.occurredAt, from))
            : eq(mrrMovements.businessId, biz.id),
        ),
    )
  ).map((r) => BigInt(r.total))[0]!;

const bookMrr = (
  await withTenant(orgId, (tx) =>
    tx
      .select({ total: sql<string>`coalesce(sum(${subscriptions.mrr}), 0)` })
      .from(subscriptions)
      .where(eq(subscriptions.businessId, biz.id)),
  )
).map((r) => BigInt(r.total))[0]!;

// The book stood at ZERO 30 days ago, by construction: A was cancelled, B paused and C
// discounted 45 days ago, and D did not exist. The window's MRR change is therefore
// exactly D's 3000 — and the window sum must say so.
const windowSum = await sumDeltas(windowStart);
ok("book: the three backdated subscriptions plus today's sale total 5000", bookMrr === 5000n);
ok(
  "window: Σ delta over the last 30 days equals the MRR change across it (+3000)",
  windowSum === 3000n,
);
ok("all time: Σ delta equals the stored book MRR", (await sumDeltas()) === bookMrr);

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`  ${pass ? "✓" : "✗"} ${name}`);
  if (!pass) failed++;
}
console.log("");
console.log(
  failed === 0
    ? `✅ MRR-BACKDATING: PASS (${checks.length}/${checks.length})`
    : `❌ MRR-BACKDATING: FAIL (${failed}/${checks.length} failed)`,
);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
