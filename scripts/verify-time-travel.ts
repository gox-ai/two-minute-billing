/**
 * TL-4 Time Travel — capstone lifecycle suite. One time-travelled TEST business
 * driven through a full lifecycle by travel_forward, with HAND-COMPUTED ledger
 * constants at each stop + the re-travel determinism (no-op) check.
 *
 *   subA (good card, plan+trial+activation-addon):
 *     trial → activation (charge_on_event='activation' fires EXACTLY once) → renewal
 *   subB (retriable-decline card, plan+trial):
 *     trial → first paid bill fails → dunning retries across simulated days → exhausted
 *   determinism: re-travel to the same instant produces ZERO new invoices/events/ledger
 *   teardown: stop wipes the simulated data + clears the machine
 *
 *   pnpm verify:time-travel
 */
import { and, eq, sql } from "drizzle-orm";
import { withTenant, closeDb, type Tx } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice, setItemApplicablePlans } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import {
  startTimeTravel,
  travelForward,
  stopTimeTravel,
  getTimeTravel,
} from "@/modules/time-travel/service";
import {
  invoices,
  subscriptions,
  subscriptionChargeLog,
  events,
  ledgerEntries,
  customers,
  products,
  prices,
} from "@db/schema";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const org = await createOrganization({ name: "TimeTravel Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "TM biz",
  defaultCurrency: "USD",
  livemode: "test",
});

const DAY = 86_400_000;
const G = new Date("2027-01-01T00:00:00.000Z"); // genesis

// ── catalog ──────────────────────────────────────────────────────────────────
const planA = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Plan A",
  id: "tm-plan-a",
  kind: "plan",
});
const priceA = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: planA.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 10000,
  interval: "month",
  trialPeriod: 14,
  trialPeriodUnit: "day",
});
const setupAddon = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Setup Fee",
  id: "tm-setup",
  kind: "addon",
});
await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: setupAddon.id,
  type: "one_time",
  model: "flat",
  currency: "USD",
  amountMinor: 5000,
});
// Attach the setup fee as an ACTIVATION charge on Plan A.
await setItemApplicablePlans({
  organizationId: orgId,
  businessId: biz.id,
  itemPublicId: "tm-setup",
  planPublicIds: ["tm-plan-a"],
  applicability: { "tm-plan-a": "optional" },
  config: { "tm-plan-a": { chargeOnEvent: "activation", chargeOnce: true } },
});

const planB = await createProduct({
  organizationId: orgId,
  businessId: biz.id,
  name: "Plan B",
  id: "tm-plan-b",
  kind: "plan",
});
const priceB = await createPrice({
  organizationId: orgId,
  businessId: biz.id,
  productId: planB.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 8000,
  interval: "month",
  trialPeriod: 14,
  trialPeriodUnit: "day",
});

// ── customers ────────────────────────────────────────────────────────────────
const custA = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "tm-a@a.com",
  autoCollection: "on",
  address: { country: "US" },
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer: custA,
  token: "tok_4242",
}); // good
const custB = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "tm-b@a.com",
  autoCollection: "on",
  address: { country: "US" },
});
await vaultPaymentMethod({
  organizationId: orgId,
  businessId: biz.id,
  customer: custB,
  token: "4000000000009995",
}); // retriable decline

// ── start Time Travel at genesis, create both trials as-of genesis ────────
await startTimeTravel({ orgId, bizId: biz.id, genesisTime: G });
const { subscription: subA } = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: custA.id,
  now: G,
  trialDays: 14,
  items: [{ price: priceA, quantity: 1 }],
});
const { subscription: subB } = await createSubscription({
  organizationId: orgId,
  businessId: biz.id,
  customerId: custB.id,
  now: G,
  trialDays: 14,
  items: [{ price: priceB, quantity: 1 }],
});
ok(
  "setup: both subs start in_trial (no invoice)",
  subA.status === "in_trial" && subB.status === "in_trial",
);

// helpers
const subInvoices = (subId: string) =>
  withTenant(orgId, (tx: Tx) =>
    tx.select().from(invoices).where(eq(invoices.subscriptionId, subId)),
  );
const freshSub = async (id: string) =>
  (
    await withTenant(orgId, (tx: Tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1),
    )
  )[0]!;
const activationRows = (subId: string) =>
  withTenant(orgId, (tx: Tx) =>
    tx
      .select()
      .from(subscriptionChargeLog)
      .where(
        and(
          eq(subscriptionChargeLog.subscriptionId, subId),
          eq(subscriptionChargeLog.chargeEvent, "activation"),
        ),
      ),
  );
async function ledgerNetsZero(): Promise<boolean> {
  return withTenant(orgId, async (tx: Tx) => {
    const res = await tx.execute(
      sql`select coalesce(sum(case when direction='debit' then amount_minor else -amount_minor end),0)::bigint as bal from ledger_entries where business_id = ${biz.id} group by currency`,
    );
    return (res as unknown as Array<{ bal: string | number }>).every((r) => BigInt(r.bal) === 0n);
  });
}
const paidTotal = (invs: Array<typeof invoices.$inferSelect>) =>
  invs.filter((i) => i.status === "paid").reduce((s, i) => s + Number(i.totalMinor), 0);

// ── STOP 1: travel just past trial end (G+16d) → activation ────────────────────
await travelForward({ orgId, bizId: biz.id, toTime: new Date(G.getTime() + 16 * DAY) });
{
  const a = await freshSub(subA.id);
  const invA = await subInvoices(subA.id);
  const actA = await activationRows(subA.id);
  ok("S1: subA activated (in_trial → active)", a.status === "active");
  ok(
    "S1: subA first paid period billed 10000 (paid)",
    invA.some((i) => Number(i.totalMinor) === 10000 && i.status === "paid"),
  );
  ok(
    "S1: subA activation charge 5000 fired (paid)",
    invA.some((i) => Number(i.totalMinor) === 5000 && i.status === "paid"),
  );
  ok("S1: subA activation fired EXACTLY once (charge log)", actA.length === 1);
  ok("S1: subA cash so far = 15000", paidTotal(invA) === 15000);

  const b = await freshSub(subB.id);
  const invB = await subInvoices(subB.id);
  ok(
    "S1: subB activated but first bill failed → payment_due",
    b.status === "active" && invB.some((i) => i.status === "payment_due"),
  );
  ok(
    "S1: subB dunning in_progress",
    invB.some((i) => i.dunningStatus === "in_progress"),
  );
  ok("S1: ledger nets zero", await ledgerNetsZero());
}

// ── STOP 2: travel past subA's first renewal + subB's dunning exhaustion ────────
// subA first paid period is [G+14, G+44]; renewal at G+44. subB dunning retries
// (default [1,3,5,7] days from ~G+15) exhaust well before G+50.
await travelForward({ orgId, bizId: biz.id, toTime: new Date(G.getTime() + 50 * DAY) });
{
  const invA = await subInvoices(subA.id);
  const actA = await activationRows(subA.id);
  ok("S2: subA renewed once more → cash 25000", paidTotal(invA) === 25000);
  ok("S2: subA activation did NOT re-fire (still 1)", actA.length === 1);

  const b = await freshSub(subB.id);
  const invB = await subInvoices(subB.id);
  ok(
    "S2: subB dunning exhausted → invoice not_paid",
    invB.some((i) => i.status === "not_paid"),
  );
  ok("S2: subB cancelled by dunning final action", b.status === "cancelled");
  ok("S2: ledger nets zero", await ledgerNetsZero());
}

// ── STOP 3: determinism — re-travel to the SAME instant → zero new rows ─────────
const snap = async () =>
  withTenant(orgId, async (tx: Tx) => {
    const inv = (
      await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(invoices)
        .where(eq(invoices.businessId, biz.id))
    )[0]!.c;
    const ev = (
      await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(events)
        .where(eq(events.businessId, biz.id))
    )[0]!.c;
    const led = (
      await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.businessId, biz.id))
    )[0]!.c;
    return { inv, ev, led };
  });
const before = await snap();
await travelForward({ orgId, bizId: biz.id, toTime: new Date(G.getTime() + 50 * DAY) }); // same instant → re-drive one tick
const after = await snap();
ok("S3: re-travel adds no invoices", after.inv === before.inv);
ok("S3: re-travel adds no events", after.ev === before.ev);
ok("S3: re-travel adds no ledger rows", after.led === before.led);

// ── STOP 4 (finale review): usage + a coupon consumed mid-journey under travel ──
{
  const { recordUsage } = await import("@/modules/metering/service");
  const { createCoupon, applyCouponToSubscription } = await import("@/modules/coupons/service");
  const T = new Date(G.getTime() + 50 * DAY); // current simulated instant
  const planC = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Plan C",
    id: "tm-plan-c",
    kind: "plan",
  });
  const priceC = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: planC.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 10000,
    interval: "month",
  });
  const meterC = await createProduct({
    organizationId: orgId,
    businessId: biz.id,
    name: "Meter C",
    id: "tm-meter-c",
    kind: "addon",
  });
  const priceM = await createPrice({
    organizationId: orgId,
    businessId: biz.id,
    productId: meterC.id,
    type: "recurring",
    model: "usage",
    currency: "USD",
    amountMinor: 5,
    interval: "month",
    usageAggregation: "sum",
  });
  const custC = await createCustomer({
    organizationId: orgId,
    businessId: biz.id,
    email: "tm-c@a.com",
    autoCollection: "on",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: biz.id,
    customer: custC,
    token: "tok_4242",
  });
  const { subscription: subC, items: itemsC } = await createSubscription({
    organizationId: orgId,
    businessId: biz.id,
    customerId: custC.id,
    now: T,
    startDate: T,
    items: [
      { price: priceC, quantity: 1 },
      { price: priceM, quantity: 1 },
    ],
  });
  await createCoupon({
    organizationId: orgId,
    businessId: biz.id,
    code: "TM20",
    kind: "percentage",
    percentOffBps: 2000,
    durationType: "once",
  });
  await applyCouponToSubscription({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionId: subC.id,
    code: "TM20",
    now: T,
  });
  const meterItem = itemsC.find((i) => i.priceId === priceM.id)!;
  // Usage lands INSIDE the first simulated period.
  await recordUsage({
    organizationId: orgId,
    businessId: biz.id,
    subscriptionItemId: meterItem.id,
    quantity: 10,
    timestamp: new Date(T.getTime() + 2 * DAY),
  });
  // Travel past the first bill (heal) and the first renewal.
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(T.getTime() + 32 * DAY) });
  const invC = (await subInvoices(subC.id)).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  // Invoice 1: recurring 10000 − 20% (once coupon) = 8000. Invoice 2 (renewal):
  // recurring 10000 + usage 10×5 = 10050, coupon exhausted → NO discount.
  ok(
    "S4: first simulated invoice 8000 (once coupon consumed under travel)",
    invC.length >= 2 && Number(invC[0]!.totalMinor) === 8000,
  );
  ok(
    "S4: renewal bills usage in arrears, coupon expired mid-journey (10050)",
    Number(invC[1]!.totalMinor) === 10050,
  );
  ok("S4: ledger nets zero", await ledgerNetsZero());
}

// ── STOP 5 (finale review): travel touches ONLY this business ───────────────────
{
  const { webhookEndpoints, webhookDeliveries, events: eventsTable } = await import("@db/schema");
  const { systemDb: db } = await import("@/platform/db");
  const bizX = await createBusiness({
    organizationId: orgId,
    name: "TM bystander",
    defaultCurrency: "USD",
    livemode: "test",
  });
  // A pending webhook delivery for bizX scheduled IN THE FUTURE (real time): a
  // travel to simulated-2027 must NOT deliver it early (its endpoint is
  // unreachable — a pickup would bump attempts).
  // Derived from this run's fresh org id, NOT hardcoded: `webhook_endpoints_public_id_uq`
  // is globally unique, so a fixed literal let this suite run only once per database —
  // any partial failure then blocked every re-run until a full db:reset.
  const runTag = orgId.replace(/-/g, "").slice(0, 16);
  const [ep] = await db
    .insert(webhookEndpoints)
    .values({
      organizationId: orgId,
      businessId: bizX.id,
      publicId: `we_tm_${runTag}`,
      url: "http://127.0.0.1:1/never",
      signingSecret: "whsec_test_bystander",
      enabled: true,
    } as never)
    .returning();
  const [ev] = await db
    .insert(eventsTable)
    .values({
      organizationId: orgId,
      businessId: bizX.id,
      publicId: `evt_tm_${runTag}`,
      type: "invoice_paid",
      data: {},
      source: "system",
      resourceType: "invoice",
      resourceId: null,
    } as never)
    .returning();
  const [del] = await db
    .insert(webhookDeliveries)
    .values({
      organizationId: orgId,
      eventId: ev!.id,
      businessId: bizX.id,
      endpointId: ep!.id,
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() + 3_600_000),
    } as never)
    .returning();
  await travelForward({ orgId, bizId: biz.id, toTime: new Date(G.getTime() + 83 * DAY) });
  const [delAfter] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, del!.id));
  ok(
    "S5: bystander business delivery untouched by travel (pending, 0 attempts)",
    delAfter!.status === "pending" && delAfter!.attempts === 0,
  );
}

// ── STOP 6 (finale review): concurrent travels serialize (leased claim) ─────────
{
  const target = new Date(G.getTime() + 90 * DAY);
  const results = await Promise.allSettled([
    travelForward({ orgId, bizId: biz.id, toTime: target }),
    travelForward({ orgId, bizId: biz.id, toTime: target }),
  ]);
  const wins = results.filter((r) => r.status === "fulfilled").length;
  ok("S6: at least one travel succeeds, none interleave silently", wins >= 1);
  // Whatever raced, determinism holds: an immediate re-travel is a no-op.
  const b6 = await snap();
  await travelForward({ orgId, bizId: biz.id, toTime: target });
  const a6 = await snap();
  ok(
    "S6: post-race re-travel adds no rows (no interleaved double-billing)",
    a6.inv === b6.inv && a6.led === b6.led,
  );
}

// ── YEARLY BOUNDARY (cutover rehearsal item #4) ─────────────────────────────────
// Everything above is MONTHLY. A yearly term has its own arithmetic and its own ways
// to be wrong: `addInterval(start,'year',1)` must land a calendar year out (not 12
// separate month hops, and not 365 fixed days), the renewal must fire ONCE at the
// boundary rather than every month, and proration must divide by the YEAR — a monthly
// denominator on a ₹/yr plan overstates a mid-term upgrade by roughly 12×.
// Own business + own machine, so the hand-computed monthly timeline above is untouched.
// The span is chosen to cross 29-Feb-2028: [2027-06-15, 2028-06-15) is a 366-day year,
// and the term after it is 365 — the amount must not move with the day count.
{
  const { changeSubscription } = await import("@/modules/subscriptions/proration");
  const { estimateChange } = await import("@/modules/subscriptions/estimate");
  const { subscriptionItems } = await import("@db/schema");

  const bizY = await createBusiness({
    organizationId: orgId,
    name: "TM yearly",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const GY = new Date("2027-06-15T00:00:00.000Z");
  const prodY = await createProduct({
    organizationId: orgId,
    businessId: bizY.id,
    name: "Plan Y",
    id: "tm-plan-y",
    kind: "plan",
  });
  // per_unit so a quantity change is a real money change; 1200.00/unit/YEAR.
  const priceY = await createPrice({
    organizationId: orgId,
    businessId: bizY.id,
    productId: prodY.id,
    type: "recurring",
    model: "per_unit",
    currency: "USD",
    amountMinor: 120000,
    interval: "year",
  });
  const custY = await createCustomer({
    organizationId: orgId,
    businessId: bizY.id,
    email: "tm-y@a.com",
    autoCollection: "on",
  });
  await vaultPaymentMethod({
    organizationId: orgId,
    businessId: bizY.id,
    customer: custY,
    token: "tok_4242",
  });
  await startTimeTravel({ orgId, bizId: bizY.id, genesisTime: GY });

  const { subscription: subY } = await createSubscription({
    organizationId: orgId,
    businessId: bizY.id,
    customerId: custY.id,
    now: GY,
    items: [{ price: priceY, quantity: 1 }],
  });
  const invY = () =>
    withTenant(orgId, (tx: Tx) =>
      tx.select().from(invoices).where(eq(invoices.subscriptionId, subY.id)),
    );
  const rowY = () =>
    withTenant(orgId, (tx: Tx) =>
      tx.select().from(subscriptions).where(eq(subscriptions.id, subY.id)).limit(1),
    ).then((r) => r[0]!);

  {
    const r = await rowY();
    const i = await invY();
    const YEAR_LATER = Date.parse("2028-06-15T00:00:00.000Z");
    console.log(
      `  yearly: at creation status=${r.status} invoices=[${i.map((x) => Number(x.totalMinor)).join(",")}] term=${r.currentPeriodStart!.toISOString()}..${r.currentPeriodEnd!.toISOString()}`,
    );
    ok("Y0: yearly sub is active on creation", r.status === "active");
    // No invoice yet, and that is correct: `createSubscription` does not bill in advance —
    // the CREATE ROUTE does, after coupons are applied (see subscription-routes.ts). This
    // journey drives the module directly, so the first money event here is the upgrade.
    ok("Y0: module-level create raises no invoice (the route bills in advance)", i.length === 0);
    ok(
      "Y1: term end is a calendar year out (2028-06-15), not a month",
      r.currentPeriodEnd!.getTime() === YEAR_LATER,
    );
  }

  // Mid-term upgrade, priced against the YEAR. Expected value is computed with the
  // engine's own integer arithmetic from the row's real dates, so it is a hand-computed
  // constant rather than a re-implementation: prorate(amount) = amount * remaining/total.
  // Travel is forward-only, so this stop (Dec 2027) must precede the boundary checks.
  let expectedNetOut = 0n;
  {
    const H = new Date("2027-12-15T00:00:00.000Z"); // ~half way through the 366-day term
    await travelForward({ orgId, bizId: bizY.id, toTime: H });
    const r = await rowY();
    const total = BigInt(r.currentPeriodEnd!.getTime() - r.currentPeriodStart!.getTime());
    const remaining = BigInt(r.currentPeriodEnd!.getTime() - H.getTime());
    const expectedNet = (240000n * remaining) / total - (120000n * remaining) / total;
    const item = (
      await withTenant(orgId, (tx: Tx) =>
        tx.select().from(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subY.id)),
      )
    )[0]!;

    const est = await estimateChange({
      organizationId: orgId,
      businessId: bizY.id,
      subscriptionId: subY.id,
      now: H,
      changes: [{ itemId: item.publicId, newQuantity: 2 }],
    });
    // A MONTH denominator would put this near the full 120000; a year puts it near half.
    ok(
      "Y3: yearly proration divides by the YEAR (estimate == hand-computed)",
      BigInt(est.total_minor) === expectedNet,
    );
    ok(
      "Y3: and that is roughly half a year, not a month slice",
      est.total_minor > 50000 && est.total_minor < 70000,
    );

    const before = (await invY()).length;
    await changeSubscription({
      organizationId: orgId,
      businessId: bizY.id,
      subscriptionId: subY.id,
      now: H,
      changes: [{ itemId: item.publicId, newQuantity: 2 }],
      invoiceImmediately: true,
    });
    const after = await invY();
    const prorationInv = after.find((i) => !after.slice(0, before).some((b) => b.id === i.id));
    ok(
      "Y4: the booked upgrade matches the preview to the minor unit",
      !!prorationInv && BigInt(prorationInv.totalMinor) === expectedNet,
    );
    expectedNetOut = expectedNet;
  }

  // Just BEFORE the boundary: a monthly cadence would have re-billed ~5 more times by
  // now. Only the original year + the upgrade proration may exist.
  await travelForward({ orgId, bizId: bizY.id, toTime: new Date("2028-06-14T00:00:00.000Z") });
  {
    const i = await invY();
    console.log(
      `  yearly: day before renewal invoices=[${i.map((x) => Number(x.totalMinor)).join(",")}]`,
    );
    ok(
      "Y2: no renewal raised before the boundary (only the upgrade proration exists)",
      i.length === 1 && BigInt(i[0]!.totalMinor) === expectedNetOut,
    );
    ok(
      "Y2: and nothing has billed a full year yet",
      !i.some((x) => Number(x.totalMinor) === 240000),
    );
  }

  // Past the boundary: exactly one renewal, at the full new-composition year price.
  await travelForward({ orgId, bizId: bizY.id, toTime: new Date("2028-06-16T00:00:00.000Z") });
  {
    const r = await rowY();
    const i = await invY();
    const renewal = i.filter((x) => Number(x.totalMinor) === 240000);
    ok(
      "Y5: renewal bills the full year for BOTH units exactly once (240000)",
      renewal.length === 1,
    );
    ok(
      "Y5: new term is the next calendar year (2029-06-15)",
      r.currentPeriodEnd!.getTime() === Date.parse("2029-06-15T00:00:00.000Z"),
    );
    // The 2027→2028 term spans 29-Feb (366 days), the 2028→2029 one does not (365).
    // A yearly price is flat, so the day count must not change the amount.
    ok(
      "Y6: the leap-spanning year and the plain year bill the SAME amount",
      renewal.length === 1 && Number(renewal[0]!.totalMinor) === 240000,
    );
  }

  // Determinism at a yearly boundary too.
  {
    const b = (await invY()).length;
    await travelForward({ orgId, bizId: bizY.id, toTime: new Date("2028-06-16T00:00:00.000Z") });
    ok("Y7: re-travel past the yearly boundary adds no invoice", (await invY()).length === b);
  }
  await stopTimeTravel({ orgId, bizId: bizY.id });
}

// ── ROUTE-LAYER SIMULATED TIME (the seam finished 2026-08-31) ───────────────────
// `businessWallClock` was wired into exactly TWO subscription routes (create and
// reactivate); every other mutating route still read a literal `new Date()`. So a
// time-travelled business's own API writes were priced at REAL wall-clock while its
// subscriptions lived at the simulated instant — a change on a 2025 term was prorated
// as of today, which is months past the term end.
//
// Driven over real HTTP (the defect was in the ROUTE layer — the modules already take
// `now` as a parameter and were always right), against a business pinned to a FIXED
// PAST instant, with hand-computed constants:
//   simulated now == the term start, so an upgrade owes the FULL delta for the term
//   and every proration line's period must START at the simulated instant.
// Un-fixed code cannot produce those numbers: real `now` sits past `current_period_end`,
// so the remaining fraction is not 1 (and the line period is today, not 2025-03-10).
{
  const { buildApp } = await import("@/index");
  const { Tmbilling } = await import("../sdk/index");
  const { invoiceLineItems, subscriptionItems } = await import("@db/schema");

  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: `http://127.0.0.1:${port}` });

  // Its OWN throwaway business (never an existing/imported one) — same rule the rest
  // of this suite follows.
  const bizR = await createBusiness({
    organizationId: orgId,
    name: "TM routes",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const GR = new Date("2025-03-10T00:00:00.000Z"); // a fixed instant in the PAST
  await startTimeTravel({ orgId, bizId: bizR.id, genesisTime: GR });

  // per_unit, so a QUANTITY change is a real money change with an exact delta.
  const prodR = await tmb.products.create(bizR.publicId, { name: "Routes Plan", kind: "plan" });
  const priceR = await tmb.prices.create(bizR.publicId, {
    product: prodR.id,
    model: "per_unit",
    type: "recurring",
    currency: "USD",
    amount_minor: 20000,
    interval: "month",
  });
  const addonR = await tmb.products.create(bizR.publicId, { name: "Routes Addon", kind: "addon" });
  const priceAddonR = await tmb.prices.create(bizR.publicId, {
    product: addonR.id,
    model: "per_unit",
    type: "recurring",
    currency: "USD",
    amount_minor: 6000,
    interval: "month",
  });

  // auto_collection off: this stop is about the CLOCK, not about collection.
  const custR = await tmb.customers.create(bizR.publicId, {
    email: "tm-routes@a.com",
    auto_collection: "off",
  });
  const subR = await tmb.subscriptions.create(bizR.publicId, custR.id, {
    items: [{ price: priceR.id, quantity: 1 }],
  });

  const subRowR = async () =>
    (
      await withTenant(orgId, (tx: Tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.publicId, subR.id)).limit(1),
      )
    )[0]!;
  const invRowsR = async () =>
    withTenant(orgId, (tx: Tx) =>
      tx.select().from(invoices).where(eq(invoices.businessId, bizR.id)),
    );
  const linesOfR = (invoiceId: string) =>
    withTenant(orgId, (tx: Tx) =>
      tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId)),
    );
  const itemIdOfR = async (pricePublicId: string) => {
    const s = await subRowR();
    const rows = await withTenant(orgId, (tx: Tx) =>
      tx
        .select({ item: subscriptionItems.publicId, price: prices.publicId })
        .from(subscriptionItems)
        .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
        .where(eq(subscriptionItems.subscriptionId, s.id)),
    );
    return rows.find((r) => r.price === pricePublicId)!.item;
  };

  // Precondition, not the point: create/reactivate already consulted the wall clock, so
  // the term must already be anchored at the simulated instant. If this fails, nothing
  // below means anything.
  const r0 = await subRowR();
  ok(
    "R0: create anchors the term at the SIMULATED instant",
    r0.currentPeriodStart!.getTime() === GR.getTime(),
  );
  const termEndR = r0.currentPeriodEnd!.getTime();

  // ── the estimate route (previously `now: new Date()`) ────────────────────────
  // At the term start the whole term remains, so an upgrade 1→2 owes the full monthly
  // delta: 40000 − 20000 = 20000. Real `now` is past `termEnd`, so nothing but the
  // simulated clock can produce it.
  let estTotal: number | string = "threw";
  try {
    const est = await tmb.subscriptions.estimate(bizR.publicId, subR.id, {
      changes: [{ item: await itemIdOfR(priceR.id), quantity: 2 }],
    });
    estTotal = est.total_minor;
  } catch (e) {
    estTotal = `threw: ${String(e)}`;
  }
  ok(
    "R1: /estimate prices the upgrade at the SIMULATED instant (full-term delta 20000)",
    estTotal === 20000,
  );

  // ── the change route (previously `now: new Date()`) ──────────────────────────
  const invBefore = new Set((await invRowsR()).map((i) => i.id));
  let changeFailed: string | null = null;
  try {
    await tmb.subscriptions.change(bizR.publicId, subR.id, {
      changes: [{ item: await itemIdOfR(priceR.id), quantity: 2 }],
      invoice_immediately: true,
    });
  } catch (e) {
    changeFailed = String(e);
  }
  const changeInv = (await invRowsR()).find((i) => !invBefore.has(i.id));
  ok(
    "R2: /change books the upgrade at the SIMULATED instant (proration invoice 20000)",
    changeFailed === null && !!changeInv && Number(changeInv.totalMinor) === 20000,
  );
  {
    const ls = changeInv ? await linesOfR(changeInv.id) : [];
    const pro = ls.filter((l) => l.kind === "proration" && l.periodStart);
    // The line's own period is the direct evidence: it must START at the simulated
    // instant. Un-fixed, it started TODAY — a period outside the term it prorates.
    ok(
      "R3: every proration line starts at the SIMULATED instant, not today",
      pro.length > 0 &&
        pro.every(
          (l) => l.periodStart!.getTime() === GR.getTime() && l.periodEnd!.getTime() === termEndR,
        ),
    );
  }

  // ── the add-item route (previously `now: new Date()`) ────────────────────────
  const invBefore2 = new Set((await invRowsR()).map((i) => i.id));
  let addFailed: string | null = null;
  try {
    await tmb.subscriptions.addItem(bizR.publicId, subR.id, {
      price: priceAddonR.id,
      quantity: 1,
      invoice_immediately: true,
    });
  } catch (e) {
    addFailed = String(e);
  }
  const addInv = (await invRowsR()).find((i) => !invBefore2.has(i.id));
  ok(
    "R4: POST /items prices the add-on at the SIMULATED instant (full-term 6000)",
    addFailed === null && !!addInv && Number(addInv.totalMinor) === 6000,
  );

  // The safety property: nothing about a business WITHOUT time travel may move.
  // `businessWallClock` falls through to `new Date()`, so a plain test business must
  // still price a same-instant upgrade at the full delta against a term anchored NOW.
  {
    const bizN = await createBusiness({
      organizationId: orgId,
      name: "TM none",
      defaultCurrency: "USD",
      livemode: "test",
    });
    const prodN = await tmb.products.create(bizN.publicId, { name: "No-TM Plan", kind: "plan" });
    const priceN = await tmb.prices.create(bizN.publicId, {
      product: prodN.id,
      model: "per_unit",
      type: "recurring",
      currency: "USD",
      amount_minor: 20000,
      interval: "month",
    });
    const custN = await tmb.customers.create(bizN.publicId, {
      email: "tm-none@a.com",
      auto_collection: "off",
    });
    const subN = await tmb.subscriptions.create(bizN.publicId, custN.id, {
      items: [{ price: priceN.id, quantity: 1 }],
    });
    const sN = (
      await withTenant(orgId, (tx: Tx) =>
        tx.select().from(subscriptions).where(eq(subscriptions.publicId, subN.id)).limit(1),
      )
    )[0]!;
    const itemN = (
      await withTenant(orgId, (tx: Tx) =>
        tx
          .select({ item: subscriptionItems.publicId, price: prices.publicId })
          .from(subscriptionItems)
          .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
          .where(eq(subscriptionItems.subscriptionId, sN.id)),
      )
    )[0]!.item;
    const estN = await tmb.subscriptions.estimate(bizN.publicId, subN.id, {
      changes: [{ item: itemN, quantity: 2 }],
    });
    // Real time: the term was anchored microseconds ago, so ~the whole term remains.
    ok(
      "R5: a business with NO time travel is unchanged (real clock, ~full-term delta)",
      estN.total_minor > 19900 && estN.total_minor <= 20000,
    );
  }

  // wipe:false — this suite's throwaway businesses are torn down by the run that owns
  // them; a wipe here would take the ledger down over the admin connection for no gain.
  await stopTimeTravel({ orgId, bizId: bizR.id, wipe: false });
  await app.close();
}

// ── TRAVEL OVER THE REST ROUTES: A RENEWAL, ASSERTED (T0–T6) ────────────────────
// Everything above calls `travelForward` in-process. This drives the same journey
// through the PUBLIC time-travel API — `POST …/time_travel/start`, `…/advance`,
// `GET …/time_travel` — because that is the surface an operator (or any harness)
// actually has, and it is a different amount of code: an all-mode key gate, a zod
// body, `resolveBusiness`, and a serializer that has to report `simulated_now` back
// honestly. None of that is exercised by an in-process call.
//
// The property under test is the one a real-clock run cannot reach at all: a monthly
// subscription's SECOND invoice, for the term that begins where the first one ended,
// inside one process. Waiting for it is a month; travelling to it is 32 ticks.
//
// The destination is resolved RELATIVELY — read `current_period_end` off the
// subscription and add a day — never stated as a literal. A test that hardcodes
// "2025-04-10" passes even when the engine computes the term wrong, because the same
// wrong date is written down in both places. The hand-computed constants then check
// that resolution rather than replacing it.
//
//   genesis            2025-03-10   (pinned in the PAST, so nothing here drifts)
//   plan               flat, USD, 12300 minor / month, no trial, auto_collection off
//   first term         [2025-03-10, 2025-04-10)   — 31 days
//   travel to          2025-04-11   = current_period_end + 1 day  → 32 daily ticks
//   renewal invoice    12300, line period [2025-04-10, 2025-05-10)
//   second term        [2025-04-10, 2025-05-10)
{
  const { buildApp } = await import("@/index");
  const { Tmbilling } = await import("../sdk/index");
  const { invoiceLineItems } = await import("@db/schema");

  const app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const tmb = new Tmbilling({ apiKey: org.secret, baseUrl: base });

  // Its OWN throwaway business — never an existing or imported one. Time travel
  // pins a business out of real billing entirely, so starting one on a business this
  // run did not create would silently stop billing it.
  const bizT = await createBusiness({
    organizationId: orgId,
    name: "TM travel routes",
    defaultCurrency: "USD",
    livemode: "test",
  });

  // Raw fetch rather than the SDK: the SDK has no time-travel surface, and the point
  // here is the ROUTE — status codes included (T5 asserts on a 400).
  let idemN = 0;
  const api = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${org.secret}`,
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", "Idempotency-Key": `tm-travel-${++idemN}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };

  try {
    const GT = new Date("2025-03-10T00:00:00.000Z");
    const TERM_END = new Date("2025-04-10T00:00:00.000Z").getTime(); // GT + 1 month
    const NEXT_TERM_END = new Date("2025-05-10T00:00:00.000Z").getTime();

    // Start BEFORE the subscription exists, so the term is anchored at the simulated
    // instant (R0 above pins that behaviour) and every constant below is fixed rather
    // than relative to whenever this suite happens to run.
    const started = await api("POST", `/v1/businesses/${bizT.publicId}/time_travel/start`, {
      genesis_time: GT.toISOString(),
    });

    const prodT = await tmb.products.create(bizT.publicId, { name: "Travel Plan", kind: "plan" });
    const priceT = await tmb.prices.create(bizT.publicId, {
      product: prodT.id,
      model: "flat",
      type: "recurring",
      currency: "USD",
      amount_minor: 12300,
      interval: "month",
    });
    // auto_collection off: this stop is about the CLOCK. An uncollected renewal
    // invoice is still a renewal invoice, and no gateway is involved.
    const custT = await tmb.customers.create(bizT.publicId, {
      email: "tm-travel@a.com",
      auto_collection: "off",
    });
    const subT = await tmb.subscriptions.create(bizT.publicId, custT.id, {
      items: [{ price: priceT.id, quantity: 1 }],
    });

    const subRowT = async () =>
      (
        await withTenant(orgId, (tx: Tx) =>
          tx.select().from(subscriptions).where(eq(subscriptions.publicId, subT.id)).limit(1),
        )
      )[0]!;
    const invRowsT = async () =>
      withTenant(orgId, (tx: Tx) =>
        tx.select().from(invoices).where(eq(invoices.businessId, bizT.id)),
      );

    const s0 = await subRowT();
    const inv0 = await invRowsT();
    ok(
      "T0: signup at the simulated genesis bills 12300 once, term [2025-03-10, 2025-04-10)",
      started.status === 201 &&
        s0.status === "active" &&
        s0.currentPeriodStart!.getTime() === GT.getTime() &&
        s0.currentPeriodEnd!.getTime() === TERM_END &&
        inv0.length === 1 &&
        Number(inv0[0]!.totalMinor) === 12300,
    );

    // ── resolve the destination RELATIVELY, off the subscription's own state ──────
    // 'afterTermEnd' = one day past the renewal boundary. Landing ON the boundary
    // does renew (the passes threshold on `<= now`), but then the assertion is about
    // the instant a renewal is due rather than a term that has demonstrably rolled.
    const readSub = await api("GET", `/v1/businesses/${bizT.publicId}/subscriptions/${subT.id}`);
    const resolvedTermEnd = new Date(readSub.body.current_period_end).getTime();
    const destination = new Date(resolvedTermEnd + DAY);
    ok(
      "T1: the API reports the term end the destination resolves from (2025-04-10)",
      readSub.status === 200 && resolvedTermEnd === TERM_END,
    );

    const travelled = await api("POST", `/v1/businesses/${bizT.publicId}/time_travel/advance`, {
      to_time: destination.toISOString(),
    });
    const status1 = await api("GET", `/v1/businesses/${bizT.publicId}/time_travel`);
    ok(
      "T2: travel lands on 2025-04-11 in 32 daily ticks and the route says so",
      travelled.status === 200 &&
        travelled.body.steps === 32 &&
        new Date(travelled.body.to).getTime() === TERM_END + DAY &&
        status1.body.status === "in_progress" &&
        new Date(status1.body.simulated_now).getTime() === TERM_END + DAY,
    );

    const inv1 = await invRowsT();
    const renewal = inv1.find((i) => i.id !== inv0[0]!.id);
    ok(
      "T3: the RENEWAL invoice exists at exactly 12300 — 2 invoices, not 1 and not 32",
      inv1.length === 2 && !!renewal && Number(renewal.totalMinor) === 12300,
    );

    const s1 = await subRowT();
    const renewalLines = renewal
      ? await withTenant(orgId, (tx: Tx) =>
          tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, renewal.id)),
        )
      : [];
    const charge = renewalLines.filter((l) => l.kind !== "discount" && l.kind !== "tax");
    ok(
      "T4: the term rolled to [2025-04-10, 2025-05-10) and the renewal line bills exactly it",
      s1.currentPeriodStart!.getTime() === TERM_END &&
        s1.currentPeriodEnd!.getTime() === NEXT_TERM_END &&
        charge.length === 1 &&
        Number(charge[0]!.amountMinor) === 12300 &&
        charge[0]!.periodStart!.getTime() === TERM_END &&
        charge[0]!.periodEnd!.getTime() === NEXT_TERM_END,
    );

    // A second travel continues from where the first stopped and raises nothing new:
    // three days into a term already billed in advance owes no money.
    const again = await api("POST", `/v1/businesses/${bizT.publicId}/time_travel/advance`, {
      to_time: new Date(TERM_END + DAY + 3 * DAY).toISOString(),
    });
    const status2 = await api("GET", `/v1/businesses/${bizT.publicId}/time_travel`);
    const inv2 = await invRowsT();
    ok(
      "T5: a second travel continues from 2025-04-11 (+3d, 3 ticks) and bills nothing new",
      again.status === 200 &&
        again.body.steps === 3 &&
        new Date(status2.body.simulated_now).getTime() === TERM_END + 4 * DAY &&
        new Date(status2.body.genesis_time).getTime() === GT.getTime() &&
        inv2.length === 2,
    );

    // Forward-only, and LOUD about it. A backwards travel that quietly no-op'd would
    // leave a caller believing it had rewound; a 400 is the only honest answer, and
    // the clock must not have moved.
    //
    // This case used to have to run LAST, because of an engine bug it found:
    // `travelForward` took its 15-minute serialization lease BEFORE validating
    // direction or step size, and only the success path cleared it — so a refused
    // travel wedged the business for fifteen minutes and T5 failed with "A travel is
    // already in progress". Fixed the same day (validate before leasing, plus a
    // try/finally release); T7 below is the regression test and is the reason the
    // ordering no longer matters.
    const backwards = await api("POST", `/v1/businesses/${bizT.publicId}/time_travel/advance`, {
      to_time: new Date(TERM_END - 5 * DAY).toISOString(),
    });
    const status3 = await api("GET", `/v1/businesses/${bizT.publicId}/time_travel`);
    ok(
      "T6: travelling BACKWARD is refused (400) and moves nothing",
      backwards.status === 400 &&
        /moves only forward/.test(JSON.stringify(backwards.body)) &&
        new Date(status3.body.simulated_now).getTime() === TERM_END + 4 * DAY,
    );

    // T7 — the REFUSAL MUST NOT COST THE LEASE. This is the whole point of the fix:
    // the ordinary sequence is a caller sending one bad request and then a good one.
    // Un-fixed, this travel is refused "A travel is already in progress for this
    // business" and stays refused for 15 minutes, which is how the bug presented.
    // It runs IMMEDIATELY after the refusal deliberately — a sleep would hide it.
    const afterRefusal = await api("POST", `/v1/businesses/${bizT.publicId}/time_travel/advance`, {
      to_time: new Date(TERM_END + 5 * DAY).toISOString(),
    });
    const status4 = await api("GET", `/v1/businesses/${bizT.publicId}/time_travel`);
    ok(
      "T7: a refused travel does NOT strand the lease — the next one still runs",
      afterRefusal.status === 200 &&
        afterRefusal.body.steps === 1 &&
        new Date(status4.body.simulated_now).getTime() === TERM_END + 5 * DAY,
    );

    // T8 — an EMPTY test business created through the API (no catalog, no subscriptions):
    // every schema-valid advance is a 200, never a 500.
    const emptyBiz = await api("POST", "/v1/businesses", {
      name: "TM travel empty",
      default_currency: "USD",
      livemode: "test",
    });
    const EB = `/v1/businesses/${emptyBiz.body.id}`;
    const E0 = new Date("2025-06-01T00:00:00.000Z").getTime();
    const eStart = await api("POST", `${EB}/time_travel/start`, {
      genesis_time: new Date(E0).toISOString(),
    });
    const eSame = await api("POST", `${EB}/time_travel/advance`, {
      to_time: new Date(E0).toISOString(),
    });
    const eDays = await api("POST", `${EB}/time_travel/advance`, {
      to_time: new Date(E0 + 2 * DAY).toISOString(),
    });
    const eWeeks = await api("POST", `${EB}/time_travel/advance`, {
      to_time: new Date(E0 + 40 * DAY).toISOString(),
      step_days: 7,
    });
    await api("POST", `${EB}/time_travel/stop`, { wipe: false });
    ok(
      "T8: advance on an empty API-created test business → 200 (same instant, days, step_days)",
      emptyBiz.status === 201 &&
        eStart.status === 201 &&
        eSame.status === 200 &&
        eSame.body.steps === 1 &&
        eDays.status === 200 &&
        eDays.body.steps === 2 &&
        eWeeks.status === 200 &&
        eWeeks.body.steps === 6,
    );
  } finally {
    // ROBUST TEARDOWN. Any await above can throw, and a business left `in_progress`
    // is a business permanently excluded from real billing ticks — there are already
    // 31 of those from suites that died before reaching their teardown. wipe:false for
    // the same reason the R block gives; this run owns the business either way.
    await stopTimeTravel({ orgId, bizId: bizT.id, wipe: false }).catch(() => {});
    await app.close();
  }
}

// ── teardown: stop wipes simulated data + clears the machine ────────────────────
const r = await stopTimeTravel({ orgId, bizId: biz.id });
{
  const tm = await getTimeTravel(orgId, biz.id);
  const remainingCustomers = await withTenant(orgId, (tx: Tx) =>
    tx.select().from(customers).where(eq(customers.businessId, biz.id)),
  );
  const remainingProducts = await withTenant(orgId, (tx: Tx) =>
    tx.select().from(products).where(eq(products.businessId, biz.id)),
  );
  ok("teardown: stop wiped customers", remainingCustomers.length === 0 && r.wiped > 0);
  ok("teardown: catalog KEPT (products survive the wipe)", remainingProducts.length >= 2);
  ok(
    "teardown: machine cleared (simulated_now null, not_enabled)",
    tm?.simulatedNow == null && tm?.status === "not_enabled",
  );
}

let failed = 0;
for (const [label, passed] of checks) {
  console.log(`${passed ? "  ✓" : "  ✗ FAIL"} ${label}`);
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ TIME TRAVEL: PASS" : `❌ TIME TRAVEL: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
