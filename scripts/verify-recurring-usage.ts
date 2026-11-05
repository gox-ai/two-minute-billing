/**
 * Recurring and time-weighted usage. What regresses without each check:
 *  - seats (unique add/remove) bill the peak and carry into periods with no events; a
 *    swapped seat counts once;
 *  - a recurring sum takes negative deltas and bills its peak; `last` carries the gauge;
 *    `max` counts the carried-in level;
 *  - weighted_sum bills unit-hours exactly, rounding half-up once;
 *  - trial events carry into the first period; a price swap keeps the level; a new item
 *    starts at 0; a window across two periods bills once;
 *  - the usage API: remove, negative quantity rules, replay compares the operation, and
 *    DELETE of a recurring record before the open window → 409.
 *
 *   pnpm verify:recurring-usage
 */
import { and, eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { withTenant, closeDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addSubscriptionItem } from "@/modules/subscriptions/items";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { recordUsage } from "@/modules/metering/service";
import type { LineRating } from "@/modules/metering/rating";
import { invoiceLineItems, type prices } from "@db/schema";

const checks: [string, boolean, string?][] = [];
const ok = (n: string, c: boolean, detail?: string) => checks.push([n, c, detail]);
const RUN = Math.random().toString(36).slice(2, 8);
const H = 3_600_000;
const L = 720 * H; // one synthetic 30-day period

async function main() {
  const org = await createOrganization({ name: `Recurring Usage Org ${RUN}` });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Recurring Usage Biz",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const ctx = { organizationId: orgId, businessId: biz.id };
  const customer = await createCustomer({ ...ctx, email: `recurring-usage-${RUN}@example.com` });
  await vaultPaymentMethod({ ...ctx, customer, token: "tok_4242" });
  const planProd = await createProduct({ ...ctx, name: "Box", kind: "plan" });
  const plan = await createPrice({
    ...ctx,
    productId: planProd.id,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: 5000,
    interval: "month",
  });
  const meterProd = await createProduct({ ...ctx, name: "Meter", kind: "addon" });
  type Agg = "sum" | "last" | "max" | "unique" | "weighted_sum";
  const usagePrice = (agg: Agg, recurring = true, amountMinor = 100) =>
    createPrice({
      ...ctx,
      productId: meterProd.id,
      type: "recurring",
      model: "usage",
      currency: "USD",
      interval: "month",
      amountMinor,
      usageAggregation: agg,
      usageRecurring: recurring,
    });

  /** A subscription with one metered item; `bill(k)` rates synthetic period k. */
  const setup = async (price: typeof prices.$inferSelect, trialDays?: number) => {
    const { subscription: sub, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      ...(trialDays ? { trialDays } : {}),
      items: [
        { price: plan, quantity: 1 },
        { price, quantity: 1 },
      ],
    });
    const item = items.find((i) => i.priceId === price.id)!;
    const t0 = (sub.currentPeriodStart ?? sub.trialStart ?? new Date()).getTime() + 60_000;
    const at = (k: number, hours = 0) => new Date(t0 + k * L + hours * H);
    const use = (k: number, hours: number, quantity: number, op?: "add" | "remove", key?: string) =>
      recordUsage({
        ...ctx,
        subscriptionItemId: item.id,
        quantity,
        operation: op,
        uniqueKey: key,
        timestamp: at(k, hours),
      });
    const bill = async (k: number, span = 1) => {
      const { invoice } = await billSubscriptionPeriod({
        ...ctx,
        subscription: sub,
        periodStart: at(k + span),
        periodEnd: at(k + span + 1),
        usagePeriod: { start: at(k), end: at(k + span) },
      });
      const lines = await withTenant(orgId, (tx) =>
        tx
          .select()
          .from(invoiceLineItems)
          .where(
            and(eq(invoiceLineItems.invoiceId, invoice.id), eq(invoiceLineItems.kind, "usage")),
          ),
      );
      const rated = lines.filter((l) => l.rating != null);
      const line = rated[0];
      return {
        line,
        rated,
        rating: (line?.rating ?? null) as LineRating | null,
        qty: line?.quantity ?? 0,
      };
    };
    return { sub, item, use, bill, at };
  };

  // ── Seats: unique add/remove, three periods ───────────────────────────────
  {
    const s = await setup(await usagePrice("unique", true, 1000));
    await s.use(0, 1, 1, "add", "a");
    await s.use(0, 2, 1, "add", "b");
    await s.use(0, 3, 1, "add", "c");
    await s.use(0, 4, 1, "remove", "a");
    await s.use(0, 5, 1, "add", "d"); // a swapped seat: remove a, then add d
    await s.use(0, 6, 1, "add", "d"); // repeated add: nothing
    const p1 = await s.bill(0);
    ok("seats P1: peak 3 (the swapped seat counts once)", p1.qty === 3, String(p1.qty));
    ok("…3 × 1,000", p1.line?.amountMinor === 3000n);
    const p2 = await s.bill(1);
    ok("seats P2: no events, the 3 seats carry", p2.qty === 3, String(p2.qty));
    ok(
      "…rating shows the level",
      p2.rating?.recurring === true &&
        p2.rating.level?.carried_in === 3 &&
        p2.rating.level.closing === 3,
      JSON.stringify(p2.rating?.level),
    );
    await s.use(2, 100, 1, "remove", "b");
    const p3 = await s.bill(2);
    ok("seats P3: a mid-period removal still bills the peak", p3.qty === 3, String(p3.qty));
    ok("…and closes at 2", p3.rating?.level?.closing === 2);
    const p4 = await s.bill(3);
    ok("seats P4: 2", p4.qty === 2, String(p4.qty));
  }

  // ── Recurring sum with negative deltas ─────────────────────────────────────
  {
    const s = await setup(await usagePrice("sum"));
    await s.use(0, 1, 10);
    await s.use(0, 2, -15);
    await s.use(0, 3, 8);
    const p1 = await s.bill(0);
    ok("recurring sum P1: peak 10", p1.qty === 10, String(p1.qty));
    ok("…closes at 3, not 8", p1.rating?.level?.closing === 3, JSON.stringify(p1.rating?.level));
    const p2 = await s.bill(1);
    ok("recurring sum P2: carries 3", p2.qty === 3, String(p2.qty));
  }

  // ── last gauge and max with carry-in ──────────────────────────────────────
  {
    const s = await setup(await usagePrice("last"));
    await s.use(0, 1, 7);
    await s.bill(0);
    const p2 = await s.bill(1);
    ok("last: the gauge carries (7)", p2.qty === 7, String(p2.qty));
  }
  {
    const s = await setup(await usagePrice("max"));
    await s.use(0, 1, 5);
    await s.use(0, 2, 2);
    const p1 = await s.bill(0);
    ok("max P1: 5", p1.qty === 5, String(p1.qty));
    await s.use(1, 1, 1);
    const p2 = await s.bill(1);
    ok("max P2: the carried-in 2 beats an event of 1", p2.qty === 2, String(p2.qty));
  }

  // ── weighted_sum: the 30-day example ───────────────────────────────────────
  {
    const s = await setup(await usagePrice("weighted_sum", true, 1));
    await s.use(0, 0, 100);
    const p1 = await s.bill(0);
    ok("weighted P1: 100 GB × 720 h = 72,000", p1.qty === 72_000, String(p1.qty));
    await s.use(1, 240, 50);
    await s.use(1, 600, -30);
    const p2 = await s.bill(1);
    ok(
      "weighted P2: 24,000 + 54,000 + 14,400 = 92,400 GB-hours",
      p2.qty === 92_400,
      String(p2.qty),
    );
    ok("…at 1 minor per GB-hour = 92,400", p2.line?.amountMinor === 92_400n);
    ok("…closes at 120", p2.rating?.level?.closing === 120 && p2.rating.time_unit === "hour");
  }
  {
    const s = await setup(await usagePrice("weighted_sum", false, 1));
    await s.use(0, 719.5, 1); // 1 unit for the last half hour
    const p1 = await s.bill(0);
    ok("weighted: half an hour rounds half-up to 1 unit-hour", p1.qty === 1, String(p1.qty));
  }

  // ── Trial events carry into period 1 ──────────────────────────────────────
  {
    const s = await setup(await usagePrice("unique", true, 1000), 7);
    await s.use(-1, 700, 1, "add", "trial-seat"); // before the first billed window
    const p1 = await s.bill(0);
    ok("a seat added in the trial bills in period 1", p1.qty === 1, String(p1.qty));
  }

  // ── Price swap keeps the level; a new item starts at 0 ────────────────────
  {
    const seat = await usagePrice("unique", true, 1000);
    const seat2 = await usagePrice("unique", true, 2000);
    const s = await setup(seat);
    await s.use(0, 1, 1, "add", "x");
    await s.use(0, 2, 1, "add", "y");
    await s.bill(0);
    await changeSubscription({
      ...ctx,
      subscriptionId: s.sub.id,
      now: new Date(),
      changes: [{ itemId: s.item.publicId, newPriceId: seat2.publicId }],
      invoiceImmediately: true,
    });
    const p2 = await s.bill(1);
    ok(
      "a price swap keeps the level: 2 seats at the new rate",
      p2.line?.amountMinor === 4000n,
      String(p2.line?.amountMinor),
    );
    const fresh = await usagePrice("sum");
    const { item: added } = await addSubscriptionItem({
      ...ctx,
      subscriptionId: s.sub.id,
      price: fresh,
      quantity: 1,
      now: new Date(),
      invoiceImmediately: true,
    });
    const p3 = await s.bill(2);
    ok(
      "a new item starts at 0 (no line for it)",
      added != null && !p3.rated.some((l) => l.priceId === fresh.id) && p3.rated.length === 1,
      p3.rated.map((l) => `${l.priceId} ${l.quantity}`).join("; "),
    );
  }

  // ── One window across two periods bills once ──────────────────────────────
  {
    const s = await setup(await usagePrice("sum"));
    await s.use(0, 1, 4);
    await s.use(1, 1, 3);
    const merged = await s.bill(0, 2);
    ok("a window over two periods bills the peak once (7)", merged.qty === 7, String(merged.qty));
  }

  // ── Usage API ───────────────────────────────────────────────────────────────
  const app = await buildApp({ logger: false });
  let n = 0;
  const call = async (method: "POST" | "DELETE", url: string, payload?: unknown, key?: string) => {
    const res = await app.inject({
      method,
      url: `/v1/businesses/${biz.publicId}${url}`,
      headers: {
        authorization: `Bearer ${org.secret}`,
        "idempotency-key": key ?? `ru-${RUN}-${n++}`,
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  {
    const seatPrice = await usagePrice("unique", true, 1000);
    const sumPrice = await usagePrice("sum", false);
    const { subscription: sub, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: new Date(),
      items: [
        { price: plan, quantity: 1 },
        { price: seatPrice, quantity: 1 },
        { price: sumPrice, quantity: 1 },
      ],
    });
    const seatItem = items.find((i) => i.priceId === seatPrice.id)!;
    const sumItem = items.find((i) => i.priceId === sumPrice.id)!;
    const post = (body: object, key?: string) =>
      call("POST", `/subscriptions/${sub.publicId}/usage`, body, key);
    const added = await post({ item: seatItem.publicId, quantity: 1, unique_key: "u1" });
    ok("API: add a seat → 201", added.status === 201 && added.body.operation === undefined);
    const removed = await post({
      item: seatItem.publicId,
      quantity: 1,
      unique_key: "u1",
      operation: "remove",
    });
    ok(
      "API: remove a seat → 201 with operation",
      removed.status === 201 && removed.body.operation === "remove",
    );
    const noKey = await post({ item: seatItem.publicId, quantity: 1, operation: "remove" });
    ok("API: remove without unique_key → 400", noKey.status === 400);
    const wrong = await post({ item: sumItem.publicId, quantity: 1, operation: "remove" });
    ok("API: remove on a sum price → 400", wrong.status === 400);
    const neg = await post({ item: sumItem.publicId, quantity: -2 });
    ok(
      "API: negative quantity on a non-recurring sum → 400",
      neg.status === 400,
      JSON.stringify(neg.body),
    );
    await post({
      item: seatItem.publicId,
      quantity: 1,
      unique_key: "u2",
      idempotency_key: `k-${RUN}`,
    });
    const replay = await post(
      {
        item: seatItem.publicId,
        quantity: 1,
        unique_key: "u2",
        operation: "remove",
        idempotency_key: `k-${RUN}`,
      },
      `other-${RUN}`,
    );
    ok("API: a replay with another operation → 409", replay.status === 409, String(replay.status));
  }

  // ── DELETE before the open window on a recurring price → 409 ───────────────
  {
    const gauge = await usagePrice("last");
    const past = new Date(Date.now() - 5 * 86_400_000);
    const { subscription: sub, items } = await createSubscription({
      ...ctx,
      customerId: customer.id,
      now: past,
      items: [
        { price: plan, quantity: 1 },
        { price: gauge, quantity: 1 },
      ],
    });
    const gaugeItem = items.find((i) => i.priceId === gauge.id)!;
    const rec = await recordUsage({
      ...ctx,
      subscriptionItemId: gaugeItem.id,
      quantity: 0, // a zero level: no usage line will lock it
      timestamp: new Date(past.getTime() + 60_000),
    });
    await changeSubscription({
      ...ctx,
      subscriptionId: sub.id,
      now: new Date(),
      changes: [],
      resetTerm: true,
      invoiceImmediately: true,
    });
    const del = await call("DELETE", `/usages/${rec.publicId}`);
    ok(
      "DELETE a recurring record before the open window → 409",
      del.status === 409,
      JSON.stringify(del.body),
    );
  }
  await app.close();
}

try {
  await main();
} catch (e) {
  console.error(`threw: ${e instanceof Error ? e.stack : String(e)}`);
  checks.push(["suite completed", false]);
}

console.log("");
let pass = true;
for (const [n, c, detail] of checks) {
  console.log(`${c ? "✅" : "❌"} ${n}${!c && detail ? `  (${detail})` : ""}`);
  if (!c) pass = false;
}
console.log(pass ? "\n✅ RECURRING-USAGE: PASS" : "\n❌ RECURRING-USAGE: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
