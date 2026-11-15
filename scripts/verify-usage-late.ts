/**
 * Late usage and when usage closes (Tier 3 G1 §3.6), end to end:
 *  - usage of a billed window that arrives after its cutoff bills on the next invoice as
 *    "Usage from <period>", dated to the old period, inside the window and in its edge;
 *  - a max meter bills the difference; events received inside the fold grace bill next time;
 *  - tiered and volume prices re-rate the whole period: late = rate(period) − billed, and a
 *    negative difference bills nothing (a correction is a credit note);
 *  - a meter subscription renews ~6 min after period end, fold or no fold; with a business
 *    grace its invoice holds as a pending draft until period end + 6 min + the grace
 *    (`verify:usage-grace` covers the hold); a subscription with no meter does not wait;
 *  - a planned invoice that never commits loses nothing;
 *  - a recurring level carries from its snapshot after the events behind it are gone.
 *
 *   pnpm verify:usage-late
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { createPrice } from "@/modules/catalog/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { addSubscriptionItem, removeSubscriptionItem } from "@/modules/subscriptions/items";
import { planSubscriptionPeriodInvoice } from "@/modules/invoicing/service";
import { runAutoClosePending } from "@/modules/invoicing/pending";
import { runWithClockScope } from "@/platform/clock";
import { formatUsagePeriod } from "@/modules/metering/meter-rating";
import { customerMeterBilling, subscriptions, usageMeterLevels } from "@db/schema";
import {
  checker,
  createTestMeter,
  invoicesOf,
  meterBusiness,
  newCustomer,
  sendEvent,
  setTerm,
  tick,
  usageLines,
} from "./lib/meter-fixtures";

const { fails, check } = checker();
const { orgId, biz, ids, product } = await meterBusiness("Usage Late Org");
const HOUR = 3_600_000;
const E = new Date(Math.floor((Date.now() - 4 * HOUR) / 60_000) * 60_000);
const S = new Date(E.getTime() - 24 * HOUR);
const E2 = new Date(E.getTime() + HOUR);
const mid = new Date(E.getTime() - 6 * HOUR);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pointerOf = async (customerId: string, meterId: string) =>
  (
    await systemDb
      .select()
      .from(customerMeterBilling)
      .where(
        and(
          eq(customerMeterBilling.customerId, customerId),
          eq(customerMeterBilling.meterId, meterId),
        ),
      )
  )[0];

async function meterSub(
  meterAgg: string,
  recurring = false,
  unit = "1",
  priceArgs: Partial<Parameters<typeof createPrice>[0]> = {},
) {
  const meter = await createTestMeter(ids, { aggregation: meterAgg, recurring });
  const price = await createPrice({
    ...ids,
    productId: product.id,
    id: `late-${meter.key}`,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "month",
    meter: meter.key,
    unitAmountDecimal: unit,
    ...priceArgs,
  });
  const customer = await newCustomer(ids, meter.key);
  const sub = await createSubscription({
    ...ids,
    customerId: customer.id,
    now: new Date(),
    items: [{ price, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, S, E);
  const send = (at: Date, tokens: number, receivedMs?: number) =>
    sendEvent(ids, {
      customerId: customer.id,
      eventName: meter.eventName,
      at,
      properties: { tokens },
      receivedMs,
    });
  return { meter, price, customer, sub, send };
}

// ── 1. Late usage, inside the window and in its edge ────────────────────────────
console.log("1. late usage");
const a = await meterSub("sum");
await a.send(mid, 10);
await tick(biz.id);
const p1 = await pointerOf(a.customer.id, a.meter.id);
check(
  "the invoice moves usage_through to the exact window end",
  p1?.usageThrough?.getTime() === E.getTime(),
  p1,
);
// Received after that cutoff: dated in the billed window, one inside and one in the edge bucket.
const lateReceived = p1!.cutoffAt!.getTime() - 5 * 60_000 + 500;
await a.send(mid, 5, lateReceived);
await a.send(new Date(E.getTime() - 60_000), 7, lateReceived);
await sleep(1500);
await setTerm(a.sub.subscription.id, E, E2);
await tick(biz.id);
const [aNext, aFirst] = await invoicesOf(orgId, a.sub.subscription.id);
const late = usageLines(aNext?.lines ?? []).find((l) => l.description.startsWith("Usage from "));
check(
  "the first invoice billed 10",
  Number(usageLines(aFirst?.lines ?? [])[0]?.amountMinor) === 10,
  aFirst?.lines,
);
check(
  `the next invoice bills 12 as "Usage from ${formatUsagePeriod({ start: S, end: E })}" dated to the old period`,
  Number(late?.amountMinor) === 12 &&
    late?.description.includes(formatUsagePeriod({ start: S, end: E })) === true &&
    late?.periodStart?.getTime() === S.getTime() &&
    late?.periodEnd?.getTime() === E.getTime() &&
    (late?.rating as { late_for?: unknown })?.late_for != null,
  aNext?.lines,
);
check(
  "the late line states its quantity 12 at the rate 1",
  Number(late?.quantityDecimal) === 12 && Number(late?.unitAmountDecimal) === 1,
  { quantity: late?.quantityDecimal, unit: late?.unitAmountDecimal },
);
// Nothing new: the next invoice bills no late line again.
await setTerm(a.sub.subscription.id, E2, new Date(E2.getTime() + HOUR));
await tick(biz.id);
const [aThird] = await invoicesOf(orgId, a.sub.subscription.id);
check(
  "late usage bills once (the next window shows one zero line, no late line)",
  usageLines(aThird?.lines ?? []).length === 1 &&
    Number(usageLines(aThird?.lines ?? [])[0]?.amountMinor) === 0 &&
    !usageLines(aThird?.lines ?? []).some((l) => l.description.startsWith("Usage from ")),
  aThird?.lines,
);

// ── 1b. Late usage re-rates at the price its window had ────────────────────────
const g = await meterSub("sum", false, "10");
await g.send(mid, 2);
await tick(biz.id);
// The item's price changes (a plan change freezes a new snapshot): 10 → 99 per unit.
await systemDb.execute(sql`
  update subscription_items
  set price_snapshot = jsonb_set(price_snapshot, '{unitAmountDecimal}', '"99"')
  where subscription_id = ${g.sub.subscription.id}`);
const gp = await pointerOf(g.customer.id, g.meter.id);
await g.send(mid, 1, gp!.cutoffAt!.getTime() - 5 * 60_000 + 500);
await sleep(1500);
await setTerm(g.sub.subscription.id, E, E2);
await tick(biz.id);
const [gNext] = await invoicesOf(orgId, g.sub.subscription.id);
check(
  "late usage of the old period bills at the old rate (10, not 99)",
  Number(
    usageLines(gNext?.lines ?? []).find((l) => l.description.startsWith("Usage from "))
      ?.amountMinor,
  ) === 10,
  gNext?.lines,
);

// ── 1c. A meter item removed mid-period bills its usage once ───────────────────
const rm = await meterSub("sum", false, "1");
const planPrice = await createPrice({
  ...ids,
  productId: product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  interval: "month",
  amountMinor: 100,
});
const rmPlan = await addSubscriptionItem({
  ...ids,
  subscriptionId: rm.sub.subscription.id,
  price: planPrice,
  quantity: 1,
  invoiceImmediately: false,
  now: new Date(),
});
const P = new Date(Date.now() + HOUR);
await setTerm(rm.sub.subscription.id, S, P);
await rm.send(mid, 10);
await removeSubscriptionItem({
  ...ids,
  subscriptionId: rm.sub.subscription.id,
  itemPublicId: rm.sub.items[0]!.publicId,
  now: new Date(),
});
void rmPlan;
await tick(biz.id, new Date(P.getTime() + 10 * 60_000));
await setTerm(rm.sub.subscription.id, P, new Date(P.getTime() + HOUR));
await tick(biz.id, new Date(P.getTime() + 2 * HOUR));
const rmAll = await invoicesOf(orgId, rm.sub.subscription.id);
const rmUsage = rmAll.flatMap((x) => usageLines(x.lines)).filter((l) => l.priceId === rm.price.id);
check(
  "usage before the removal is billed exactly once (10)",
  rmUsage.reduce((a, l) => a + Number(l.amountMinor), 0) === 10 &&
    rmUsage.some((l) => (l.rating as { meter?: string } | null)?.meter === rm.meter.id),
  rmAll.map((x) => x.lines.map((l) => [l.description, l.amountMinor])),
);

// ── 2. A max meter bills the difference ────────────────────────────────────────
const b = await meterSub("max");
await b.send(mid, 5);
await tick(biz.id);
const bp = await pointerOf(b.customer.id, b.meter.id);
await b.send(mid, 8, bp!.cutoffAt!.getTime() - 5 * 60_000 + 500);
await sleep(1500);
await setTerm(b.sub.subscription.id, E, E2);
await tick(biz.id);
const [bNext] = await invoicesOf(orgId, b.sub.subscription.id);
const bLate = usageLines(bNext?.lines ?? []).find((l) => l.description.startsWith("Usage from "));
check(
  "max: billed 5, a late 8 bills the difference 3 (quantity 3 at the rate 1)",
  Number(bLate?.amountMinor) === 3 &&
    Number(bLate?.quantityDecimal) === 3 &&
    Number(bLate?.unitAmountDecimal) === 1,
  bNext?.lines,
);

// ── 2b. Tiered and volume: the whole period re-rates ───────────────────────────
/** 90 units billed in [S, E), 30 more arrive late: the first and next invoices' usage lines. */
async function lateOnTiers(model: "tiered" | "volume", tiers: Array<[string | null, string]>) {
  const t = await meterSub("sum", false, "1", {
    model,
    unitAmountDecimal: undefined,
    meterTiers: tiers.map(([up_to, unit_amount_decimal]) => ({ up_to, unit_amount_decimal })),
  });
  await t.send(mid, 90);
  await tick(biz.id);
  const tp = await pointerOf(t.customer.id, t.meter.id);
  await t.send(mid, 30, tp!.cutoffAt!.getTime() - 5 * 60_000 + 500);
  await sleep(1500);
  await setTerm(t.sub.subscription.id, E, E2);
  await tick(biz.id);
  const [next, first] = await invoicesOf(orgId, t.sub.subscription.id);
  const notes = (await systemDb.execute(
    sql`select count(*)::int n from credit_notes where customer_id = ${t.customer.id}`,
  )) as unknown as Array<{ n: number }>;
  return {
    billed: Number(usageLines(first?.lines ?? [])[0]?.amountMinor),
    late: usageLines(next?.lines ?? []).find((l) => l.description.startsWith("Usage from ")),
    next: usageLines(next?.lines ?? []),
    notes: notes[0]?.n ?? -1,
  };
}
const gr = await lateOnTiers("tiered", [
  ["100", "10"],
  [null, "5"],
]);
check(
  "graduated (100 at 10, then 5): 90 billed 900, 30 late → 200 = rate(120) 1100 − 900, not 300",
  gr.billed === 900 &&
    Number(gr.late?.amountMinor) === 200 &&
    Number(gr.late?.quantityDecimal) === 30,
  { billed: gr.billed, late: gr.late?.amountMinor, qty: gr.late?.quantityDecimal },
);
const vn = await lateOnTiers("volume", [
  ["100", "10"],
  [null, "6"],
]);
check(
  "volume (to 100 at 10, above at 6): rate(120) 720 − 900 = −180 bills no late line and no credit note",
  vn.billed === 900 &&
    vn.late === undefined &&
    vn.notes === 0 &&
    vn.next.every((l) => Number(l.amountMinor) === 0),
  { billed: vn.billed, next: vn.next.map((l) => [l.description, l.amountMinor]), notes: vn.notes },
);
const vp = await lateOnTiers("volume", [
  ["100", "10"],
  [null, "9"],
]);
check(
  "volume (to 100 at 10, above at 9): 90 billed 900, 30 late → 180 = rate(120) 1080 − 900",
  vp.billed === 900 &&
    Number(vp.late?.amountMinor) === 180 &&
    Number(vp.late?.quantityDecimal) === 30,
  { billed: vp.billed, late: vp.late?.amountMinor, qty: vp.late?.quantityDecimal },
);

// ── 3. Received inside the fold grace: next invoice ────────────────────────────
const c = await meterSub("sum");
await c.send(mid, 4);
const graceReceived = Date.now() - 5 * 60_000 + 20_000;
await c.send(mid, 6, graceReceived);
await tick(biz.id);
const [cFirst] = await invoicesOf(orgId, c.sub.subscription.id);
check(
  "an event received in the last 5 minutes is not on this invoice",
  Number(usageLines(cFirst?.lines ?? [])[0]?.amountMinor) === 4,
  cFirst?.lines,
);
await sleep(Math.max(0, graceReceived + 5 * 60_000 + 2_000 - Date.now()));
await setTerm(c.sub.subscription.id, E, E2);
await tick(biz.id);
const [cNext] = await invoicesOf(orgId, c.sub.subscription.id);
check(
  "it bills on the next invoice as late usage, never dropped",
  Number(
    usageLines(cNext?.lines ?? []).find((l) => l.description.startsWith("Usage from "))
      ?.amountMinor,
  ) === 6,
  cNext?.lines,
);

// ── 4. A planned invoice that never commits loses nothing ──────────────────────
const d = await meterSub("sum");
await d.send(mid, 9);
const [dRow] = await systemDb
  .select()
  .from(subscriptions)
  .where(eq(subscriptions.id, d.sub.subscription.id));
await planSubscriptionPeriodInvoice({
  ...ids,
  subscription: dRow!,
  periodStart: E,
  periodEnd: E2,
  usagePeriod: { start: S, end: E },
});
const dp = await pointerOf(d.customer.id, d.meter.id);
check(
  "a plan takes a cutoff but leaves the pointer",
  dp?.usageThrough == null && dp?.generation === 1n,
  dp,
);
await tick(biz.id);
const [dInv] = await invoicesOf(orgId, d.sub.subscription.id);
check(
  "the real renewal bills all of it",
  Number(usageLines(dInv?.lines ?? [])[0]?.amountMinor) === 9,
  dInv?.lines,
);

// ── 5. Recurring level from its snapshot ───────────────────────────────────────
const r = await meterSub("sum", true, "100");
await r.send(mid, 3);
await tick(biz.id);
const [snap] = await systemDb
  .select()
  .from(usageMeterLevels)
  .where(
    and(eq(usageMeterLevels.customerId, r.customer.id), eq(usageMeterLevels.meterId, r.meter.id)),
  );
check(
  "the cutoff records the level at the window end",
  Number(snap?.level) === 3 && snap?.at.getTime() === E.getTime(),
  snap,
);
// The partition behind the snapshot is dropped: its events are gone.
await systemDb.execute(
  sql`delete from usage_events where customer_id = ${r.customer.id} and "timestamp" < ${E.toISOString()}::timestamptz`,
);
await r.send(new Date(E.getTime() + 10 * 60_000), 2);
await setTerm(r.sub.subscription.id, E, E2);
await tick(biz.id);
const [rNext] = await invoicesOf(orgId, r.sub.subscription.id);
check(
  "seats carry 3 from the snapshot + 2 → 5 × 100 = 500",
  Number(usageLines(rNext?.lines ?? [])[0]?.amountMinor) === 500 &&
    !usageLines(rNext?.lines ?? []).some((l) => l.description.startsWith("Usage from ")),
  rNext?.lines,
);

// ── 6. When usage closes ───────────────────────────────────────────────────────
console.log("2. renewal wait");
const w = await meterBusiness("Usage Close Org");
const wIds = w.ids;
const wMeter = await createTestMeter(wIds, {});
const wPrice = await createPrice({
  ...wIds,
  productId: w.product.id,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "month",
  meter: wMeter.key,
  unitAmountDecimal: "1",
});
const flat = await createPrice({
  ...wIds,
  productId: w.product.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  interval: "month",
  amountMinor: 500,
});
const PE = new Date(Math.floor((Date.now() - 6 * HOUR) / 60_000) * 60_000);
const PS = new Date(PE.getTime() - 24 * HOUR);
const at = (min: number) => new Date(PE.getTime() + min * 60_000);
// The delay is saved through the API, so the setting reaches the column renewal reads.
const { buildApp } = await import("@/index");
const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${w.org.secret}` };
let keyN = 0;
const patchBiz = (payload: object) =>
  app.inject({
    method: "PATCH",
    url: `/v1/businesses/${w.biz.publicId}`,
    headers: { ...auth, "idempotency-key": `usage-close-${Date.now()}-${++keyN}` },
    payload,
  });
const tooLong = await patchBiz({ usage_close_delay_minutes: 43201 });
const fraction = await patchBiz({ usage_close_delay_minutes: 2.5 });
check(
  "the API refuses a grace of 43201 or 2.5 minutes and says what to enter",
  tooLong.statusCode === 400 &&
    fraction.statusCode === 400 &&
    JSON.parse(tooLong.body).error?.message ===
      "usage_close_delay_minutes: Enter a whole number of minutes from 0 to 43200 (30 days).",
  [tooLong.body, fraction.statusCode],
);
/** The term rolls at +6 min; with a grace the invoice is a pending draft until +6 + grace. */
async function waitCase(delay: number) {
  const saved = await patchBiz({ usage_close_delay_minutes: delay });
  const got = await app.inject({
    method: "GET",
    url: `/v1/businesses/${w.biz.publicId}`,
    headers: auth,
  });
  check(
    `the API saves a grace of ${delay} and returns it`,
    saved.statusCode === 200 && JSON.parse(got.body).usage_close_delay_minutes === delay,
    [saved.statusCode, saved.body.slice(0, 200)],
  );
  const cus = await newCustomer(wIds, `wait${delay}`);
  const sub = await createSubscription({
    ...wIds,
    customerId: cus.id,
    now: new Date(),
    items: [{ price: wPrice, quantity: 1 }],
  });
  await setTerm(sub.subscription.id, PS, PE);
  const all = () => invoicesOf(w.orgId, sub.subscription.id);
  const start = (await all()).length;
  await tick(w.biz.id, at(5));
  const early = (await all()).length;
  await tick(w.biz.id, at(6));
  const rolled = await all();
  const close = (min: number) =>
    runWithClockScope({ onlyBusinessId: w.biz.id }, () => runAutoClosePending(at(min)));
  await close(6 + delay - 1);
  const stillHeld = (await all())[0]?.inv.status === "pending";
  await close(6 + delay);
  const final = (await all())[0]?.inv;
  return {
    waited: early === start,
    renewed: rolled.length === start + 1,
    held: rolled[0]?.inv.status === "pending" && rolled[0]?.inv.holdUntil != null,
    stillHeld,
    finalStatus: final?.status,
  };
}
const d0 = await waitCase(0);
check(
  "grace 0: not at +5 min, renewed and finalized at +6 min (no hold)",
  d0.waited && d0.renewed && !d0.held && d0.finalStatus !== "pending",
  d0,
);
const [state] = (await systemDb.execute(
  sql`select 1 from usage_rollup_state where business_id = ${w.biz.id}`,
)) as unknown as unknown[];
const d10 = await waitCase(10);
check(
  "no fold ever ran, grace 10: the term rolls at +6 min; the invoice holds until +16 min",
  !state && d10.waited && d10.renewed && d10.held && d10.stillHeld && d10.finalStatus !== "pending",
  { state, d10 },
);
const plainCus = await newCustomer(wIds, "flat");
const plainSub = await createSubscription({
  ...wIds,
  customerId: plainCus.id,
  now: new Date(),
  items: [{ price: flat, quantity: 1 }],
});
await setTerm(plainSub.subscription.id, PS, PE);
const plainBefore = (await invoicesOf(w.orgId, plainSub.subscription.id)).length;
await tick(w.biz.id, at(1));
check(
  "a subscription with no meter does not wait",
  (await invoicesOf(w.orgId, plainSub.subscription.id)).length === plainBefore + 1,
);

await app.close();
console.log("");
console.log(
  fails.length === 0 ? "✅ USAGE LATE: PASS" : `❌ USAGE LATE: FAIL (${fails.join(", ")})`,
);
await closeDb();
process.exit(fails.length === 0 ? 0 : 1);
