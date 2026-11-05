/**
 * Plan credit and allowance resets (design G3b §5, §6), on a yearly plan unless noted:
 *  1. every month: signup grants the first month only; two boundaries grant (one with usage,
 *     one quiet); a re-run grants nothing twice; rollover 50 %, cap 8, kept 1 window;
 *  2. every day, usage on two days, one invoice: each day's grant pays only that day's usage,
 *     the line total is unchanged; the live balance, the access check and the invoice agree;
 *  3. calendar + week in a +05:30 business: windows start Monday 00:00 local; the partial
 *     first window: full, prorated, next full window (business setting and price override);
 *  4. never: one grant, no rollover, it survives a renewal;
 *  5. term (absent): unchanged on yearly and monthly prices;
 *  6. plan changes: upgrade full / prorated / next window, downgrade next window / full;
 *  7. cancel at period end: grant a started window / stop at the request; nothing after the end;
 *  8. pause: skip / keep granting / shift; a calendar month shifts only the next window start
 *     (a 10-day pause, one longer than the rest of the window, one past the next 1st);
 *  8c. a pause at the term-start instant still shifts; a resume that starts a new term resets;
 *  9. allowances: a daily reset counts today's usage and returns resets_at; an upgrade starts a
 *     new window / keeps the used count / prorates the limit; refusals (hourly credits,
 *     a window longer than the term, a reset on a switch feature);
 * 10. `same_as_credits`: the allowance follows the subscription's own credits price (a later
 *     reset change included; archived prices ignored; no reset = the term); refusals: no
 *     active credits price, prices on different schedules, a price change that splits them;
 * 11. allowances under a pause shift: a linked allowance renews with its credits (calendar and
 *     subscription anchor) and counts that window; an own calendar reset moves under `shift`
 *     and not under `skip`; the old `calendar_shifts` key and the legacy shape (shift_ms only)
 *     still give the open window; month-end anchors (30th, 31st) renew once per window.
 * 12. per-call overrides: `plan_credits.on_pause` on a pause (immediate and deferred) and
 *     `on_cancel_at_period_end` on an end-of-term or dated cancel beat the business rule;
 *     omitted = the rule; a later cancel does not inherit an earlier one's choice; the API
 *     stores both and refuses the cancel override with `immediately`.
 *
 *   pnpm verify:all:fresh -- --only plan-credit-resets
 */
import { and, eq, sql } from "drizzle-orm";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { buildApp } from "@/index";
import { runWithClockScope } from "@/platform/clock";
import {
  CatalogError,
  createPrice,
  createProduct,
  setPriceActive,
} from "@/modules/catalog/service";
import {
  cancelSubscription,
  cancelSubscriptionWithOptions,
  createSubscription,
  pauseSubscription,
  pauseSubscriptionWithOptions,
  removeScheduledCancellation,
  resumeSubscription,
} from "@/modules/subscriptions/service";
import { changeSubscription } from "@/modules/subscriptions/proration";
import { billSubscriptionPeriod } from "@/modules/invoicing/service";
import { createCreditUnit, grantRemaining } from "@/modules/credits/service";
import { E12 } from "@/modules/credits/units";
import { runPlanCreditResets } from "@/modules/credits/credit-clock";
import { liveBalance } from "@/modules/credits/balance";
import { checkAccess } from "@/modules/credits/access";
import {
  createFeature,
  checkEntitlement,
  setPlanEntitlement,
} from "@/modules/entitlements/service";
import { ensureUsageMonth } from "@/modules/metering/partitions";
import { addInterval } from "@/modules/subscriptions/interval";
import { runBillingClockTick } from "@/modules/subscriptions/renewal";
import {
  businesses,
  creditGrantMovements,
  creditGrants,
  scheduledChanges,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import {
  checker,
  createTestMeter,
  meterBusiness,
  newCustomer,
  sendEvent,
} from "./lib/meter-fixtures";

/** Proration rounds half-up to a whole step. */
const halfUp = (n: bigint, d: bigint) => (2n * n + d) / (2n * d);

const { fails, check } = checker();
const DAY = 86_400_000;
const T0 = new Date(Math.floor(Date.now() / 60_000) * 60_000);
const plus = (ms: number) => new Date(T0.getTime() + ms);
const month = (n: number) => addInterval(T0, "month", n);
for (let i = -1; i < 10; i++) await ensureUsageMonth(addInterval(T0, "month", i));

const { org, orgId, biz, ids, product } = await meterBusiness("Plan Credit Resets Org");
await createCreditUnit({
  ...ids,
  key: "credit",
  unit: { name: "credit", pluralName: "credits", currency: "USD", minorPerUnitE12: 100n * E12 },
});
const meter = await createTestMeter(ids);
const at = <T>(bizId: string, t: Date, fn: () => Promise<T>) =>
  runWithClockScope({ onlyBusinessId: bizId, now: t }, fn);
const resets = (t: Date, bizId = biz.id) => at(bizId, t, () => runPlanCreditResets(t));
const setRules = (bizId: string, cfg: Record<string, unknown> | null) =>
  systemDb.update(businesses).set({ billingRulesConfig: cfg }).where(eq(businesses.id, bizId));
let pn = 0;
const planPrice = (
  gc: Record<string, unknown> | null,
  o: { interval?: "month" | "year"; amount?: number; productId?: string; b?: typeof ids } = {},
) =>
  createPrice({
    ...(o.b ?? ids),
    productId: o.productId ?? product.id,
    id: `pcr-${++pn}-${Date.now()}`,
    type: "recurring",
    model: "flat",
    currency: "USD",
    amountMinor: o.amount ?? 12000,
    interval: o.interval ?? "year",
    ...(gc ? { grantsCredit: gc } : {}),
  });
const usagePrice = await createPrice({
  ...ids,
  productId: product.id,
  id: `pcr-usage-${Date.now()}`,
  type: "recurring",
  model: "usage",
  currency: "USD",
  interval: "year",
  meter: meter.key,
  unitAmountDecimal: "100",
});
const credits = (amount: number, reset: Record<string, unknown> | null, extra = {}) => ({
  kind: "per_cycle",
  unit: "credit",
  amount,
  ...(reset ? { reset } : {}),
  ...extra,
});
async function subscribe(
  tag: string,
  prices: Array<Awaited<ReturnType<typeof planPrice>>>,
  o: { t?: Date; b?: typeof ids; bizId?: string } = {},
) {
  const c = await newCustomer(o.b ?? ids, tag);
  const t = o.t ?? T0;
  const res = await at(o.bizId ?? biz.id, t, () =>
    createSubscription({
      ...(o.b ?? ids),
      customerId: c.id,
      now: t,
      items: prices.map((price) => ({ price, quantity: 1 })),
    }),
  );
  // The signup invoice, as the API raises it (createSubscription itself bills nothing).
  const [row] = await systemDb
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, res.subscription.id));
  await at(o.bizId ?? biz.id, t, () =>
    billSubscriptionPeriod({
      ...(o.b ?? ids),
      subscription: row!,
      periodStart: row!.currentPeriodStart!,
      periodEnd: row!.currentPeriodEnd!,
    }),
  );
  const items = await systemDb
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, res.subscription.id));
  const planItem = items.find((i) => i.priceId === prices[0]!.id)!;
  return { c, sub: res.subscription, items, planItem };
}
const grantsOf = (itemId: string) =>
  systemDb
    .select()
    .from(creditGrants)
    .where(eq(creditGrants.subscriptionItemId, itemId))
    .orderBy(creditGrants.effectiveAt, creditGrants.createdAt);
const windowGrants = async (itemId: string) =>
  (await grantsOf(itemId)).filter((g) => g.sourceRef?.includes(":w:"));
const rolledGrants = async (itemId: string) =>
  (await grantsOf(itemId)).filter((g) => g.sourceRef?.includes(":wroll:"));
const unitsLeft = async (id: string) =>
  (await withTenant(orgId, (tx) => grantRemaining(tx, [id]))).get(id)!.units;
const usage = (customerId: string, when: Date, tokens: number) =>
  sendEvent(ids, {
    customerId,
    eventName: meter.eventName,
    at: when,
    properties: { tokens },
    receivedMs: Math.min(Date.now(), when.getTime()) - 10 * 60_000,
  });
const cursorOf = async (itemId: string) =>
  (
    await systemDb
      .select({ c: subscriptionItems.nextCreditResetAt })
      .from(subscriptionItems)
      .where(eq(subscriptionItems.id, itemId))
  )[0]?.c ?? null;
const t = (d: Date | null | undefined) => d?.getTime() ?? null;

// ── 1. every month on a yearly plan ──────────────────────────────────────────────
console.log("1. every month, yearly plan");
const monthly = await planPrice(
  credits(
    25,
    { every: "month" },
    {
      rollover: { mode: "carry", percent: 50, cap: 8, expire_after_cycles: 1 },
    },
  ),
);
const s1 = await subscribe("monthly", [monthly, usagePrice]);
{
  const w = await windowGrants(s1.planItem.id);
  const all = await grantsOf(s1.planItem.id);
  check(
    "signup grants the first month only: 25 credits, expiring a month later (not 25 for the year)",
    all.length === 1 &&
      w.length === 1 &&
      w[0]!.amount === 25n &&
      t(w[0]!.effectiveAt) === t(T0) &&
      t(w[0]!.expiresAt) === t(month(1)),
    all.map((g) => [g.amount, g.effectiveAt, g.expiresAt, g.sourceRef]),
  );
  check("the cursor waits for the next window", t(await cursorOf(s1.planItem.id)) === t(month(1)));
}
await usage(s1.c.id, plus(3 * DAY), 10);
await resets(new Date(month(1).getTime() + 60_000));
{
  const w = await windowGrants(s1.planItem.id);
  const r = await rolledGrants(s1.planItem.id);
  check(
    "boundary 1 (10 used of 25): month 2 is granted; 50 % of the 15 left rolls (7)",
    w.length === 2 &&
      t(w[1]!.effectiveAt) === t(month(1)) &&
      w[1]!.amount === 25n &&
      r.length === 1 &&
      r[0]!.amount === 7n &&
      t(r[0]!.expiresAt) === t(month(2)),
    { w: w.map((g) => [g.amount, g.effectiveAt]), r: r.map((g) => [g.amount, g.expiresAt]) },
  );
  check(
    "the closing grant keeps what its usage will draw (25 − 7 = 18)",
    (await unitsLeft(w[0]!.id)) === 18n,
  );
}
await resets(new Date(month(2).getTime() + 60_000));
{
  const w = await windowGrants(s1.planItem.id);
  const r = await rolledGrants(s1.planItem.id);
  check(
    "boundary 2 (a quiet month): month 3 is granted; 50 % of 25 is capped at 8",
    w.length === 3 && r.length === 2 && r[1]!.amount === 8n && t(r[1]!.expiresAt) === t(month(3)),
    r.map((g) => [g.amount, g.expiresAt]),
  );
}
const before1 = (await grantsOf(s1.planItem.id)).length;
await resets(new Date(month(2).getTime() + 120_000));
await at(biz.id, new Date(month(2).getTime() + 120_000), () =>
  withTenant(orgId, async (tx) => {
    const { ensureCreditWindows } = await import("@/modules/credits/credit-clock");
    return ensureCreditWindows(tx, {
      customerId: s1.c.id,
      now: new Date(month(2).getTime() + 120_000),
    });
  }),
);
check(
  "a re-run (job and reader) grants nothing twice",
  (await grantsOf(s1.planItem.id)).length === before1,
);
{
  const bal = await withTenant(orgId, (tx) =>
    liveBalance(tx, {
      customerId: s1.c.id,
      currency: "USD",
      now: new Date(month(2).getTime() + DAY),
      businessConfig: null,
      customerSettings: null,
    }),
  );
  const units = bal.availableUnits.find((u) => u.unit === "credit")?.units;
  check("live in month 3: 25 + 8 rolled (the month-1 rollover lapsed)", units === 33n, units);
}

// ── 2. every day, one invoice, exact windows ─────────────────────────────────────
console.log("2. every day, slices");
const daily = await planPrice(credits(25, { every: "day" }));
const s2 = await subscribe("daily", [daily, usagePrice]);
await usage(s2.c.id, plus(2 * 3_600_000), 30);
await usage(s2.c.id, plus(DAY + 2 * 3_600_000), 10);
const mid2 = plus(DAY + 12 * 3_600_000);
const bal2 = await at(biz.id, mid2, () =>
  withTenant(orgId, (tx) =>
    liveBalance(tx, {
      customerId: s2.c.id,
      currency: "USD",
      now: mid2,
      businessConfig: null,
      customerSettings: null,
    }),
  ),
);
const acc2 = await at(biz.id, mid2, () =>
  checkAccess({ ...ids, customerId: s2.c.id, meterKey: meter.key }),
);
check(
  "day 2, live balance: today's grant pays today's 10 only (15 left); day 1's 5 is uncovered",
  bal2.unbilledUsageMinor === 1000n &&
    bal2.balanceMinor === 1500n &&
    bal2.uncoveredUsageMinor === 500n,
  {
    covered: bal2.unbilledUsageMinor,
    balance: bal2.balanceMinor,
    uncovered: bal2.uncoveredUsageMinor,
  },
);
check(
  "the access check reads the same balance (renews at the day's end)",
  acc2.balance.unbilled_usage_minor === 1000 &&
    acc2.available_minor === 1000 &&
    acc2.renews_at === plus(2 * DAY).toISOString(),
  { b: acc2.balance, available: acc2.available_minor, renews: acc2.renews_at },
);
{
  const [subRow] = await systemDb
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, s2.sub.id));
  const res = await at(biz.id, mid2, () =>
    billSubscriptionPeriod({
      ...ids,
      subscription: subRow!,
      periodStart: mid2,
      periodEnd: plus(366 * DAY),
      usagePeriod: { start: T0, end: mid2 },
      skipFixed: true,
    }),
  );
  const inv = res.invoice;
  const lines = await systemDb.execute(sql`
    select amount_minor::text as amount from invoice_line_items
    where invoice_id = ${inv.id} and kind = 'usage'`);
  const draws = await systemDb
    .select({ grantId: creditGrantMovements.grantId, face: creditGrantMovements.faceMinor })
    .from(creditGrantMovements)
    .where(and(eq(creditGrantMovements.invoiceId, inv.id), eq(creditGrantMovements.kind, "draw")));
  const w = await windowGrants(s2.planItem.id);
  const drawOf = (g: { id: string } | undefined) =>
    -(draws.find((d) => d.grantId === g?.id)?.face ?? 0n);
  check(
    "one invoice line of 40 credits; day 1's grant pays 25 (its 30), day 2's pays 10",
    (lines as unknown as Array<{ amount: string }>).map((l) => l.amount).join() === "4000" &&
      drawOf(w[0]) === 2500n &&
      drawOf(w[1]) === 1000n,
    { lines, draws: draws.map((d) => String(d.face)) },
  );
  check(
    "the invoice agrees with the balance and the check: today's draw 10, 5 left to pay",
    drawOf(w[1]) === bal2.unbilledUsageMinor &&
      4000n - drawOf(w[0]) - drawOf(w[1]) === bal2.uncoveredUsageMinor,
    { invoice: inv.publicId },
  );
}

// ── 3. calendar + week in a +05:30 business; the partial first window ───────────
console.log("3. calendar week, Asia/Kolkata");
const kb = await meterBusiness("Plan Credit Resets IST Org");
await systemDb
  .update(businesses)
  .set({ timezone: "Asia/Kolkata" })
  .where(eq(businesses.id, kb.biz.id));
await createCreditUnit({
  ...kb.ids,
  key: "credit",
  unit: { name: "credit", pluralName: "credits", currency: "USD", minorPerUnitE12: 100n * E12 },
});
const kSub = (tag: string, gc: Record<string, unknown>) =>
  planPrice(gc, { b: kb.ids, productId: kb.product.id }).then((p) =>
    subscribe(tag, [p], { b: kb.ids, bizId: kb.biz.id }),
  );
const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000);
const k1 = await kSub("ist-full", credits(25, { every: "week", anchor: "calendar" }));
{
  const [g] = await windowGrants(k1.planItem.id);
  const local = g ? ist(g.effectiveAt) : null;
  check(
    "the window starts Monday 00:00 local (18:30 UTC Sunday) and runs a week",
    !!g &&
      local!.getUTCDay() === 1 &&
      local!.getUTCHours() === 0 &&
      local!.getUTCMinutes() === 0 &&
      g.expiresAt!.getTime() - g.effectiveAt.getTime() === 7 * DAY,
    g && [g.effectiveAt, g.expiresAt],
  );
  check(
    "first_window full (default): the partial first window is granted in full",
    g?.amount === 25n,
    g?.amount,
  );
}
await setRules(kb.biz.id, { plan_credits: { first_window: "prorated" } });
const k2 = await kSub("ist-prorated", credits(25, { every: "week", anchor: "calendar" }));
{
  const [g] = await windowGrants(k2.planItem.id);
  const want = halfUp(25n * BigInt(g!.expiresAt!.getTime() - T0.getTime()), BigInt(7 * DAY));
  check(
    "first_window prorated (business setting): the rest of the week, rounded half-up",
    g?.amount === want,
    { got: g?.amount, want },
  );
}
const k3 = await kSub(
  "ist-wait",
  credits(25, { every: "week", anchor: "calendar" }, { first_window: "next_full_window" }),
);
{
  const none = await windowGrants(k3.planItem.id);
  const next = await cursorOf(k3.planItem.id);
  await resets(new Date(next!.getTime() + 60_000), kb.biz.id);
  const w = await windowGrants(k3.planItem.id);
  check(
    "first_window next_full_window (price override beats the business): nothing, then a full week",
    none.length === 0 &&
      w.length === 1 &&
      w[0]!.amount === 25n &&
      ist(w[0]!.effectiveAt).getUTCDay() === 1,
    { none: none.length, w: w.map((g) => [g.amount, g.effectiveAt]) },
  );
}
await setRules(kb.biz.id, null);

// ── 4. never ──────────────────────────────────────────────────────────────────────
console.log("4. never");
const never = await planPrice(credits(25, { every: "never" }), { interval: "month", amount: 1000 });
const s4 = await subscribe("never", [never]);
{
  const renewAt = new Date(month(1).getTime() + 3_600_000);
  await at(biz.id, renewAt, () => runBillingClockTick(renewAt));
  await resets(renewAt);
  const all = await grantsOf(s4.planItem.id);
  check(
    "one grant, no expiry, no rollover; a renewal grants nothing more",
    all.length === 1 && all[0]!.expiresAt === null && all[0]!.status === "active",
    all.map((g) => [g.sourceRef, g.expiresAt, g.status]),
  );
  try {
    await planPrice(credits(25, { every: "never" }, { rollover: { mode: "carry", percent: 50 } }), {
      interval: "month",
    });
    check("never with rollover is refused", false);
  } catch (e) {
    check("never with rollover is refused", e instanceof CatalogError);
  }
}

// ── 5. term (absent): unchanged ──────────────────────────────────────────────────
console.log("5. term, regression");
{
  const yearly = await subscribe("term-year", [await planPrice(credits(25, null))]);
  await resets(new Date(month(1).getTime() + 60_000));
  const g = await grantsOf(yearly.planItem.id);
  check(
    "yearly, no reset: one grant of 25 for the whole term, the clock adds nothing",
    g.length === 1 &&
      g[0]!.sourceRef!.includes(":cycle:") &&
      t(g[0]!.expiresAt) === t(addInterval(T0, "year", 1)),
    g.map((x) => [x.sourceRef, x.expiresAt]),
  );
  const m = await subscribe("term-month", [
    await planPrice(credits(25, { every: "term" }), { interval: "month", amount: 1000 }),
  ]);
  const renewAt = new Date(month(1).getTime() + 3_600_000);
  await at(biz.id, renewAt, () => runBillingClockTick(renewAt));
  const gm = await grantsOf(m.planItem.id);
  check(
    "monthly, every term: the renewal grants cycle 2 (2 cycle grants), cursor unused",
    gm.filter((x) => x.sourceRef?.includes(":cycle:")).length === 2 &&
      (await cursorOf(m.planItem.id)) === null,
    gm.map((x) => x.sourceRef),
  );
}

// ── 6. plan changes ──────────────────────────────────────────────────────────────
console.log("6. plan changes");
const small = await planPrice(credits(10, { every: "month" }), { amount: 1200 });
const big = await planPrice(credits(25, { every: "month" }), { amount: 3600 });
const change = async (
  s: Awaited<ReturnType<typeof subscribe>>,
  to: { publicId: string },
  when: Date,
) =>
  at(biz.id, when, () =>
    changeSubscription({
      ...ids,
      subscriptionId: s.sub.id,
      now: when,
      changes: [{ itemId: s.planItem.publicId, newPriceId: to.publicId }],
      invoiceImmediately: false,
    }),
  );
const mid = plus(10 * DAY);
const W1 = month(1);
for (const rule of ["full", "prorated", "next_window"] as const) {
  await setRules(biz.id, { plan_credits: { on_upgrade: rule } });
  const s = await subscribe(`up-${rule}`, [small]);
  await change(s, big, mid);
  const g = await grantsOf(s.planItem.id);
  const old = g.find((x) => x.sourceRef?.includes(`:w:${small.id}:`));
  const nw = g.find((x) => x.sourceRef?.includes(`:w:${big.id}:`));
  if (rule === "next_window") {
    await resets(new Date(W1.getTime() + 60_000));
    const after = (await grantsOf(s.planItem.id)).find((x) =>
      x.sourceRef?.includes(`:w:${big.id}:`),
    );
    check(
      "upgrade, next_window: the old grant runs to its window end; the new plan from the next window",
      t(old?.expiresAt) === t(W1) && !nw && after?.amount === 25n && t(after.effectiveAt) === t(W1),
      { old: old?.expiresAt, after: after && [after.amount, after.effectiveAt] },
    );
  } else {
    const want =
      rule === "full"
        ? 25n
        : halfUp(25n * BigInt(W1.getTime() - mid.getTime()), BigInt(W1.getTime() - T0.getTime()));
    check(
      `upgrade, ${rule}: the old grant ends at the change; the new one at once (${rule})`,
      t(old?.expiresAt) === t(mid) &&
        nw?.amount === want &&
        t(nw.effectiveAt) === t(mid) &&
        t(nw.expiresAt) === t(W1) &&
        t(await cursorOf(s.planItem.id)) === t(W1),
      { old: old?.expiresAt, nw: nw && [nw.amount, nw.effectiveAt, nw.expiresAt], want },
    );
  }
}
for (const rule of ["next_window", "full"] as const) {
  await setRules(biz.id, { plan_credits: { on_downgrade: rule } });
  const s = await subscribe(`down-${rule}`, [big]);
  await change(s, small, mid);
  const g = await grantsOf(s.planItem.id);
  const old = g.find((x) => x.sourceRef?.includes(`:w:${big.id}:`));
  const nw = g.find((x) => x.sourceRef?.includes(`:w:${small.id}:`));
  check(
    `downgrade, ${rule}: ${rule === "full" ? "the new plan's 10 at once" : "the old 25 runs to the window end"}`,
    rule === "full"
      ? t(old?.expiresAt) === t(mid) && nw?.amount === 10n
      : t(old?.expiresAt) === t(W1) && !nw,
    { old: old?.expiresAt, nw: nw?.amount },
  );
}
await setRules(biz.id, null);

// ── 7. cancel at period end ──────────────────────────────────────────────────────
console.log("7. cancel at period end");
const weekly = await planPrice(credits(25, { every: "week" }), { interval: "month", amount: 1000 });
for (const rule of ["grant_started_window", "stop_at_request"] as const) {
  await setRules(biz.id, { plan_credits: { on_cancel_at_period_end: rule } });
  const s = await subscribe(`cancel-${rule}`, [weekly]);
  await systemDb
    .update(subscriptions)
    .set({ cancelAtPeriodEnd: true })
    .where(eq(subscriptions.id, s.sub.id));
  await resets(plus(7 * DAY + 60_000));
  const n = (await windowGrants(s.planItem.id)).length;
  check(
    `${rule}: ${rule === "stop_at_request" ? "no window after the request" : "the next window still starts before the end"}`,
    n === (rule === "stop_at_request" ? 1 : 2),
    n,
  );
}
await setRules(biz.id, null);
{
  const s = await subscribe("cancel-date", [weekly]);
  await systemDb
    .update(subscriptions)
    .set({ cancelScheduledAt: plus(10 * DAY) })
    .where(eq(subscriptions.id, s.sub.id));
  await resets(plus(14 * DAY + 60_000));
  const n1 = (await windowGrants(s.planItem.id)).length;
  await systemDb
    .update(subscriptions)
    .set({ status: "cancelled" })
    .where(eq(subscriptions.id, s.sub.id));
  await resets(plus(21 * DAY + 60_000));
  check(
    "a dated cancel: weeks 1–2 (before the date) only; nothing after the end",
    n1 === 2 && (await windowGrants(s.planItem.id)).length === 2,
    n1,
  );
}

// ── 8. pause ─────────────────────────────────────────────────────────────────────
console.log("8. pause");
for (const rule of ["skip", "keep_granting", "shift"] as const) {
  await setRules(biz.id, { plan_credits: { on_pause: rule } });
  const s = await subscribe(`pause-${rule}`, [weekly]);
  const pauseAt = plus(3 * DAY);
  const resumeAt = plus(rule === "shift" ? 5 * DAY : 9 * DAY);
  await at(biz.id, pauseAt, () =>
    pauseSubscription({ ...ids, subscriptionId: s.sub.id, now: pauseAt }),
  );
  if (rule !== "shift") await resets(plus(7 * DAY + 60_000));
  await at(biz.id, resumeAt, () =>
    resumeSubscription({ ...ids, subscriptionId: s.sub.id, now: resumeAt }),
  );
  await resets(new Date(resumeAt.getTime() + 60_000));
  const w = await windowGrants(s.planItem.id);
  if (rule === "skip") {
    await resets(plus(14 * DAY + 60_000));
    const w2 = await windowGrants(s.planItem.id);
    check(
      "skip: the week that started while paused is not granted; the next week is",
      w.length === 1 && w2.length === 2 && t(w2[1]!.effectiveAt) === t(plus(14 * DAY)),
      { before: w.length, after: w2.map((g) => g.effectiveAt) },
    );
  } else if (rule === "keep_granting") {
    check("keep_granting: week 2 is granted while paused", w.length === 2, w.length);
  } else {
    await resets(plus(9 * DAY + 60_000));
    const w2 = await windowGrants(s.planItem.id);
    check(
      "shift: week 1 runs on by the 2 paused days; week 2 starts 2 days later",
      t(w[0]!.expiresAt) === t(plus(9 * DAY)) &&
        w2.length === 2 &&
        t(w2[1]!.effectiveAt) === t(plus(9 * DAY)),
      { w1: w[0]?.expiresAt, w2: w2.map((g) => g.effectiveAt) },
    );
  }
}
await setRules(biz.id, null);

// ── 8b. pause shift on a calendar month (UTC business) ───────────────────────────
console.log("8b. pause shift, calendar month");
const cb = await meterBusiness("Plan Credit Resets Calendar Org");
await systemDb
  .update(businesses)
  .set({ timezone: "UTC", billingRulesConfig: { plan_credits: { on_pause: "shift" } } })
  .where(eq(businesses.id, cb.biz.id));
await createCreditUnit({
  ...cb.ids,
  key: "credit",
  unit: { name: "credit", pluralName: "credits", currency: "USD", minorPerUnitE12: 100n * E12 },
});
const calMonth = await planPrice(credits(25, { every: "month", anchor: "calendar" }), {
  b: cb.ids,
  productId: cb.product.id,
});
const first = (n: number) => new Date(Date.UTC(T0.getUTCFullYear(), T0.getUTCMonth() + n, 1));
const [M1, M2, M3, M4, M5] = [1, 2, 3, 4, 5].map(first) as [Date, Date, Date, Date, Date];
const dayAfter = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const calResets = (tm: Date) => at(cb.biz.id, tm, () => runPlanCreditResets(tm));
for (const [tag, pauseDay, days] of [
  ["10 days mid-window", 5, 10],
  ["longer than the rest of the window", 20, 15],
  ["past the next calendar boundary", 20, 45],
] as const) {
  const s = await subscribe(`cal-shift-${days}`, [calMonth], {
    b: cb.ids,
    bizId: cb.biz.id,
    t: dayAfter(M1, 1),
  });
  const p = dayAfter(M1, pauseDay);
  const r = dayAfter(p, days);
  await at(cb.biz.id, p, () => pauseSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: p }));
  if (r.getTime() > M2.getTime()) await calResets(new Date(M2.getTime() + 60_000));
  const whilePaused = (await windowGrants(s.planItem.id)).length;
  await at(cb.biz.id, r, () => resumeSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: r }));
  const moved = dayAfter(M2, days);
  // The window after the shift ends at the first calendar boundary after the moved end.
  const nextEnd = moved.getTime() < M3.getTime() ? M3 : M4;
  await calResets(new Date(M2.getTime() + 60_000));
  const atM2 = (await windowGrants(s.planItem.id)).length;
  await calResets(new Date(moved.getTime() + 60_000));
  await calResets(new Date(nextEnd.getTime() + 60_000));
  const w = await windowGrants(s.planItem.id);
  const after = nextEnd === M3 ? M4 : M5;
  check(
    `calendar shift, ${tag}: the open grant ends ${days} days late, the next window runs to the ` +
      "next 1st (granted in full), then calendar months",
    whilePaused === 1 &&
      atM2 === 1 &&
      w.length === 3 &&
      t(w[0]!.expiresAt) === t(moved) &&
      t(w[1]!.effectiveAt) === t(moved) &&
      t(w[1]!.expiresAt) === t(nextEnd) &&
      w[1]!.amount === 25n &&
      t(w[2]!.effectiveAt) === t(nextEnd) &&
      t(w[2]!.expiresAt) === t(after),
    {
      whilePaused,
      atM2,
      want: { moved, nextEnd, after },
      w: w.map((g) => [g.effectiveAt, g.expiresAt, String(g.amount)]),
    },
  );
}
// The short window after a shift follows `first_window` (here the per-price override): 100
// credits, paused from the 10th to the 20th, so the short window is [M2 + 10 days, M3).
for (const rule of ["full", "prorated", "next_full_window"] as const) {
  const price = await planPrice(
    credits(100, { every: "month", anchor: "calendar" }, { first_window: rule }),
    { b: cb.ids, productId: cb.product.id },
  );
  const s = await subscribe(`cal-short-${rule}`, [price], { b: cb.ids, bizId: cb.biz.id, t: M1 });
  const p = dayAfter(M1, 9);
  const r = dayAfter(M1, 19);
  await at(cb.biz.id, p, () => pauseSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: p }));
  await at(cb.biz.id, r, () => resumeSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: r }));
  const moved = dayAfter(M2, 10);
  await calResets(new Date(moved.getTime() + 60_000));
  await calResets(new Date(M3.getTime() + 60_000));
  const w = await windowGrants(s.planItem.id);
  const short = w.find((g) => t(g.effectiveAt) === t(moved));
  const next = w.find((g) => t(g.effectiveAt) === t(M3));
  // Prorated: the short window's share of its calendar month, rounded half-up to a whole credit.
  const want =
    rule === "full"
      ? 100n
      : rule === "prorated"
        ? halfUp(100n * BigInt(M3.getTime() - moved.getTime()), BigInt(M3.getTime() - M2.getTime()))
        : null;
  check(
    `calendar shift, short window, first_window ${rule}: ${want == null ? "nothing" : String(want)} ` +
      "for the short window, 100 on the next 1st",
    t(w[0]!.expiresAt) === t(moved) &&
      (want == null ? !short : short?.amount === want && t(short.expiresAt) === t(M3)) &&
      next?.amount === 100n,
    { want, w: w.map((g) => [g.effectiveAt, g.expiresAt, String(g.amount)]) },
  );
}

// ── 8c. a pause at the term-start instant, and a resume that starts a new term ───────
console.log("8c. pause at the term start");
{
  // Paused at the very instant the term starts: the resume is in the same term, so it shifts.
  const t0 = dayAfter(M1, 3);
  const s = await subscribe("cal-pause-at-start", [calMonth], {
    b: cb.ids,
    bizId: cb.biz.id,
    t: t0,
  });
  const r = dayAfter(t0, 10);
  await at(cb.biz.id, t0, () =>
    pauseSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: t0 }),
  );
  await at(cb.biz.id, r, () => resumeSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: r }));
  const moved = dayAfter(M2, 10);
  const w = await windowGrants(s.planItem.id);
  const cur = await cursorOf(s.planItem.id);
  check(
    "a pause at the term-start instant, resumed 10 days later under shift: the open grant and " +
      "the cursor move by 10 days",
    w.length === 1 && t(w[0]!.expiresAt) === t(moved) && t(cur) === t(moved),
    { w: w.map((g) => [g.effectiveAt, g.expiresAt]), cur, want: moved },
  );
}
{
  // A resume after the term ended starts a new term: the shift and the stored windows reset.
  await setRules(biz.id, { plan_credits: { on_pause: "shift" } });
  const s = await subscribe("pause-new-term", [weekly]);
  const p = plus(3 * DAY);
  const r = new Date(month(1).getTime() + 5 * DAY);
  await at(biz.id, p, () => pauseSubscription({ ...ids, subscriptionId: s.sub.id, now: p }));
  await at(biz.id, r, () => resumeSubscription({ ...ids, subscriptionId: s.sub.id, now: r }));
  const [row] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, s.sub.id));
  const rs = row?.resetState;
  check(
    "a resume that starts a new term resets the shift (shift_ms 0, no stored windows)",
    !!row?.currentPeriodStart &&
      row.currentPeriodStart.getTime() > p.getTime() &&
      rs?.shift_ms === 0 &&
      Object.keys(rs?.pause_windows ?? {}).length === 0 &&
      Object.keys(rs?.allowance_shifts ?? {}).length === 0,
    { start: row?.currentPeriodStart, rs },
  );
  await setRules(biz.id, null);
}

{
  // A day-anchored business floors a new term's start to midnight. Paused exactly at the term
  // end (midnight) and resumed later that day, out of term: the new term starts at the pause
  // instant, and the resume must still reset the shift.
  const db = await meterBusiness("Plan Credit Resets Day Anchor Org");
  await systemDb
    .update(businesses)
    .set({
      timezone: "UTC",
      anchorGranularity: "day",
      prorationGranularity: "whole_day",
      billingRulesConfig: { plan_credits: { on_pause: "shift" } },
    })
    .where(eq(businesses.id, db.biz.id));
  await createCreditUnit({
    ...db.ids,
    key: "credit",
    unit: { name: "credit", pluralName: "credits", currency: "USD", minorPerUnitE12: 100n * E12 },
  });
  const price = await planPrice(credits(25, { every: "week" }), {
    b: db.ids,
    productId: db.product.id,
    interval: "month",
    amount: 1000,
  });
  const s = await subscribe("pause-midnight", [price], { b: db.ids, bizId: db.biz.id });
  const [before] = await systemDb
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, s.sub.id));
  const p = before!.currentPeriodEnd!;
  const r = new Date(p.getTime() + 5 * 3_600_000);
  await at(db.biz.id, p, () => pauseSubscription({ ...db.ids, subscriptionId: s.sub.id, now: p }));
  await at(db.biz.id, r, () => resumeSubscription({ ...db.ids, subscriptionId: s.sub.id, now: r }));
  const [row] = await systemDb.select().from(subscriptions).where(eq(subscriptions.id, s.sub.id));
  const rs = row?.resetState;
  check(
    "day anchor: a pause at the term end (midnight), resumed out of term the same day: the new " +
      "term starts at the pause instant and the shift resets",
    t(row?.currentPeriodStart) === t(p) &&
      rs?.shift_ms === 0 &&
      Object.keys(rs?.pause_windows ?? {}).length === 0,
    { pausedAt: p, start: row?.currentPeriodStart, rs },
  );
}

// ── 9. allowances ────────────────────────────────────────────────────────────────
console.log("9. allowances");
const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${org.secret}` };
const feat = await createFeature({
  ...ids,
  key: `styles-${Date.now()}`,
  name: "Styles",
  type: "meter",
  meterId: meter.id,
});
const sw = await createFeature({ ...ids, key: `sso-${Date.now()}`, name: "SSO", type: "switch" });
const aProd = await createProduct({ ...ids, name: "Hobby" });
const bProd = await createProduct({ ...ids, name: "Pro" });
const aPrice = await planPrice(null, { productId: aProd.id, amount: 1200 });
const bPrice = await planPrice(null, { productId: bProd.id, amount: 3600 });
{
  const res = await app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/products/${aProd.publicId}/entitlements`,
    headers: { ...auth, "idempotency-key": `ent-a-${Date.now()}` },
    payload: { feature: feat.key, value: "3", reset: { every: "day" } },
  });
  check(
    "API: a meter allowance takes a daily reset (stored, returned)",
    res.statusCode === 201 && res.json().reset?.every === "day",
    res.body,
  );
  const bad = await app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/products/${aProd.publicId}/entitlements`,
    headers: { ...auth, "idempotency-key": `ent-sw-${Date.now()}` },
    payload: { feature: sw.key, value: "true", reset: { every: "day" } },
  });
  check("API: a switch feature takes no reset (400)", bad.statusCode === 400, bad.body);
  const hourly = await app.inject({
    method: "POST",
    url: `/v1/businesses/${biz.publicId}/products/${aProd.publicId}/entitlements`,
    headers: { ...auth, "idempotency-key": `ent-h-${Date.now()}` },
    payload: { feature: feat.key, value: "3", reset: { every: "hour" } },
  });
  check("API: an allowance may reset every hour", hourly.statusCode === 201, hourly.body);
  await setPlanEntitlement({
    ...ids,
    productId: aProd.id,
    featureId: feat.id,
    value: "3",
    reset: { every: "day" },
  });
}
{
  const s = await subscribe("allow-day", [aPrice, usagePrice]);
  await usage(s.c.id, plus(2 * 3_600_000), 1);
  await usage(s.c.id, plus(3 * 3_600_000), 1);
  await usage(s.c.id, plus(DAY + 3_600_000), 1);
  const now = plus(DAY + 5 * 3_600_000);
  const ch = await at(biz.id, now, () => checkEntitlement(orgId, s.sub.id, feat.key));
  const acc = await at(biz.id, now, () =>
    checkAccess({ ...ids, customerId: s.c.id, meterKey: meter.key }),
  );
  check(
    "a daily allowance counts today's usage only (1 of 3) and returns resets_at",
    ch.entitled &&
      Number(ch.used) === 1 &&
      ch.resets_at === plus(2 * DAY).toISOString() &&
      Number(acc.entitlement?.used) === 1 &&
      acc.entitlement?.resets_at === plus(2 * DAY).toISOString(),
    { ch, ent: acc.entitlement },
  );
}
await setPlanEntitlement({
  ...ids,
  productId: aProd.id,
  featureId: feat.id,
  value: "1",
  reset: { every: "month" },
});
await setPlanEntitlement({
  ...ids,
  productId: bProd.id,
  featureId: feat.id,
  value: "3",
  reset: { every: "month" },
});
for (const rule of ["new_window", "keep_used", "prorated"] as const) {
  await setRules(biz.id, { allowances: { on_upgrade: rule } });
  const s = await subscribe(`allow-up-${rule}`, [aPrice, usagePrice]);
  await usage(s.c.id, plus(3_600_000), 1);
  const when = plus(15 * DAY);
  await change(s, bPrice, when);
  const ch = await at(biz.id, plus(15 * DAY + 3_600_000), () =>
    checkEntitlement(orgId, s.sub.id, feat.key),
  );
  const len = month(1).getTime() - T0.getTime();
  const prorated = String(Math.floor((1 * 15 * DAY + 3 * (len - 15 * DAY)) / len));
  const ok =
    rule === "new_window"
      ? Number(ch.used) === 0 && ch.value === "3"
      : rule === "keep_used"
        ? Number(ch.used) === 1 && ch.value === "3"
        : Number(ch.used) === 1 && ch.value === prorated;
  check(
    `allowance upgrade, ${rule}: ${rule === "new_window" ? "a new window (0 of 3 used)" : rule === "keep_used" ? "1 of 3 used" : `limit prorated to ${prorated}`}`,
    ok,
    ch,
  );
}
// ── 9b. one change's own rules (`POST …/change`) ─────────────────────────────────
console.log("9b. per-change plan_credits / allowances");
{
  type Sub = Awaited<ReturnType<typeof subscribe>>;
  // `at` books the change at `when`: the clock scope does not reach the request.
  const changeVia = (s: Sub, to: { publicId: string }, when: Date, body: object) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/subscriptions/${s.sub.publicId}/change`,
      headers: { ...auth, "idempotency-key": crypto.randomUUID() },
      payload: {
        changes: [{ item: s.planItem.publicId, price: to.publicId }],
        invoice_immediately: false,
        timing: "now",
        at: when.toISOString(),
        ...body,
      },
    });
  const grantPair = async (s: Sub, from: { id: string }, to: { id: string }) => {
    const g = await grantsOf(s.planItem.id);
    return {
      old: g.find((x) => x.sourceRef?.includes(`:w:${from.id}:`)),
      nw: g.find((x) => x.sourceRef?.includes(`:w:${to.id}:`)),
    };
  };
  const proratedWant = halfUp(
    25n * BigInt(W1.getTime() - mid.getTime()),
    BigInt(W1.getTime() - T0.getTime()),
  );

  await setRules(biz.id, { plan_credits: { on_upgrade: "full" } });
  const estimateFor = async (s: Sub, to: { publicId: string }) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/subscriptions/${s.sub.publicId}/estimate`,
      headers: auth,
      payload: { changes: [{ item: s.planItem.publicId, price: to.publicId }] },
    });
  const est = await estimateFor(await subscribe("ov-est", [small]), big);
  check(
    "estimate: change_policy.plan_credits is the upgrade rule when a plan grants credits",
    est.statusCode === 200 && est.json().change_policy?.plan_credits === "full",
    est.body.slice(0, 300),
  );

  const a = await subscribe("ov-up-next", [small]);
  const ar = await changeVia(a, big, mid, { plan_credits: "next_window" });
  const ag = await grantPair(a, small, big);
  check(
    "override: rule on_upgrade full + plan_credits next_window → old grant to window end, none new",
    ar.statusCode === 200 && t(ag.old?.expiresAt) === t(W1) && !ag.nw,
    { status: ar.statusCode, body: ar.body.slice(0, 200), old: ag.old?.expiresAt },
  );

  await setRules(biz.id, { plan_credits: { on_upgrade: "next_window" } });
  const b = await subscribe("ov-up-pro", [small]);
  const br = await changeVia(b, big, mid, { plan_credits: "prorated" });
  const bg = await grantPair(b, small, big);
  check(
    "override: rule on_upgrade next_window + plan_credits prorated → the prorated grant at once",
    br.statusCode === 200 && bg.nw?.amount === proratedWant && t(bg.old?.expiresAt) === t(mid),
    { status: br.statusCode, nw: bg.nw?.amount, want: proratedWant },
  );
  const c = await subscribe("ov-up-omit", [small]);
  const cr = await changeVia(c, big, mid, {});
  const cg = await grantPair(c, small, big);
  check(
    "omitted on the route: the rule (next_window) applies",
    cr.statusCode === 200 && t(cg.old?.expiresAt) === t(W1) && !cg.nw,
    { status: cr.statusCode, old: cg.old?.expiresAt, nw: cg.nw?.amount },
  );

  await setRules(biz.id, { plan_credits: { on_downgrade: "next_window" } });
  const d = await subscribe("ov-down-full", [big]);
  const dr = await changeVia(d, small, mid, { plan_credits: "full" });
  const dg = await grantPair(d, big, small);
  check(
    "override: rule on_downgrade next_window + plan_credits full → the new plan's 10 at once",
    dr.statusCode === 200 && t(dg.old?.expiresAt) === t(mid) && dg.nw?.amount === 10n,
    { status: dr.statusCode, old: dg.old?.expiresAt, nw: dg.nw?.amount },
  );
  const e = await subscribe("ov-down-pro", [big]);
  const er = await changeVia(e, small, mid, { plan_credits: "prorated" });
  check(
    "a downgrade with plan_credits prorated → 400, nothing changed",
    er.statusCode === 400 && !(await grantPair(e, big, small)).nw,
    er.body.slice(0, 200),
  );

  await setRules(biz.id, { allowances: { on_upgrade: "new_window" } });
  const f = await subscribe("ov-allow-keep", [aPrice, usagePrice]);
  await usage(f.c.id, plus(3_600_000), 1);
  const fr = await changeVia(f, bPrice, plus(15 * DAY), { allowances: "keep_used" });
  const fch = await at(biz.id, plus(15 * DAY + 3_600_000), () =>
    checkEntitlement(orgId, f.sub.id, feat.key),
  );
  check(
    "override: rule new_window + allowances keep_used → 1 of 3 used",
    fr.statusCode === 200 && Number(fch.used) === 1 && fch.value === "3",
    { status: fr.statusCode, body: fr.body.slice(0, 200), fch },
  );
  await setRules(biz.id, { allowances: { on_upgrade: "keep_used" } });
  const g = await subscribe("ov-allow-new", [aPrice, usagePrice]);
  await usage(g.c.id, plus(3_600_000), 1);
  const gr = await changeVia(g, bPrice, plus(15 * DAY), { allowances: "new_window" });
  const gch = await at(biz.id, plus(15 * DAY + 3_600_000), () =>
    checkEntitlement(orgId, g.sub.id, feat.key),
  );
  check(
    "override: rule keep_used + allowances new_window → 0 of 3 used",
    gr.statusCode === 200 && Number(gch.used) === 0 && gch.value === "3",
    { status: gr.statusCode, gch },
  );
  const h = await subscribe("ov-allow-omit", [aPrice, usagePrice]);
  await usage(h.c.id, plus(3_600_000), 1);
  const hr = await changeVia(h, bPrice, plus(15 * DAY), {});
  const hch = await at(biz.id, plus(15 * DAY + 3_600_000), () =>
    checkEntitlement(orgId, h.sub.id, feat.key),
  );
  check(
    "omitted on the route: the allowance rule (keep_used) applies",
    hr.statusCode === 200 && Number(hch.used) === 1,
    { status: hr.statusCode, hch },
  );
  const ae = await estimateFor(await subscribe("ov-allow-est", [aPrice, usagePrice]), bPrice);
  check(
    "estimate: allowances is the rule when the upgrade raises an allowance; plan_credits null",
    ae.statusCode === 200 &&
      ae.json().change_policy?.allowances === "keep_used" &&
      ae.json().change_policy?.plan_credits === null,
    ae.body.slice(0, 300),
  );
  const i = await subscribe("ov-allow-down", [bPrice, usagePrice]);
  const ir = await changeVia(i, aPrice, plus(15 * DAY), { allowances: "keep_used" });
  check("a downgrade with allowances → 400", ir.statusCode === 400, ir.body.slice(0, 200));
}

await setRules(biz.id, null);
for (const [label, gc, interval] of [
  ["hourly credits are refused", credits(25, { every: "hour" }), "month"],
  [
    "a yearly reset on a monthly price is refused (use term)",
    credits(25, { every: "year" }),
    "month",
  ],
] as const) {
  try {
    await planPrice(gc, { interval });
    check(label, false);
  } catch (e) {
    check(
      label,
      e instanceof CatalogError && /renew|term/.test((e as Error).message),
      (e as Error).message,
    );
  }
}

// ── 10. an allowance that follows the credits (`same_as_credits`) ────────────────
console.log("10. an allowance that follows the credits");
{
  const meter2 = await createTestMeter(ids);
  const usage2 = await createPrice({
    ...ids,
    productId: product.id,
    id: `pcr-usage2-${Date.now()}`,
    type: "recurring",
    model: "usage",
    currency: "USD",
    interval: "year",
    meter: meter2.key,
    unitAmountDecimal: "100",
  });
  const gen = await createFeature({
    ...ids,
    key: `gens-${Date.now()}`,
    name: "Generations",
    type: "meter",
    meterId: meter2.id,
  });
  const link = { same_as_credits: true };
  let ik = 0;
  const call = (method: "POST" | "PATCH", url: string, payload: Record<string, unknown>) =>
    app.inject({
      method,
      url,
      headers: { ...auth, "idempotency-key": `link-${++ik}-${Date.now()}` },
      payload,
    });
  const linkEnt = (p: { publicId: string }) =>
    call("POST", `/v1/businesses/${biz.publicId}/products/${p.publicId}/entitlements`, {
      feature: gen.key,
      value: "5",
      reset: link,
    });
  const patchPrice = (p: { publicId: string }, body: Record<string, unknown>) =>
    call("PATCH", `/v1/businesses/${biz.publicId}/prices/${p.publicId}`, body);
  const msg = (r: { json: () => { error?: { message?: string } } }) =>
    r.json().error?.message ?? "";

  // (a) no active price that grants credits per period.
  const starter = await createProduct({ ...ids, name: "Starter" });
  await planPrice(null, { productId: starter.id, amount: 600 });
  const legacyOnly = await createProduct({ ...ids, name: "Legacy" });
  const gone = await planPrice(credits(10, { every: "month" }), { productId: legacyOnly.id });
  await setPriceActive(orgId, biz.id, gone.publicId, false);
  const ra = await linkEnt(starter);
  const ra2 = await linkEnt(legacyOnly);
  check(
    "(a) the link is refused on a plan with no active price that grants credits per period " +
      "(an archived one does not count)",
    ra.statusCode === 400 && ra2.statusCode === 400 && /grants credits/.test(msg(ra)),
    [ra.body, ra2.body],
  );
  // (b) active prices on different schedules.
  const mixed = await createProduct({ ...ids, name: "Mixed" });
  await planPrice(credits(10, { every: "month" }), { productId: mixed.id });
  await planPrice(credits(10, { every: "week" }), { productId: mixed.id, amount: 13000 });
  const rb = await linkEnt(mixed);
  check(
    "(b) the link is refused when the plan's active prices renew on different schedules",
    rb.statusCode === 400 &&
      /different schedules\. Select a schedule for the allowance\./.test(msg(rb)),
    rb.body,
  );

  // The link: monthly credits, plus an archived daily price that must not count.
  const creator = await createProduct({ ...ids, name: "Creator" });
  const cp = await planPrice(credits(25, { every: "month" }), {
    productId: creator.id,
    amount: 9000,
  });
  const daily = await planPrice(credits(5, { every: "day" }), {
    productId: creator.id,
    amount: 9100,
  });
  await setPriceActive(orgId, biz.id, daily.publicId, false);
  const ok = await linkEnt(creator);
  check(
    "the link is saved and returned as a link (the archived daily price is ignored)",
    ok.statusCode === 201 && ok.json().reset?.same_as_credits === true,
    ok.body,
  );
  const sL = await subscribe("link-month", [cp, usage2]);
  const nowL = plus(3 * DAY);
  const c1 = await at(biz.id, nowL, () => checkEntitlement(orgId, sL.sub.id, gen.key));
  const a1 = await at(biz.id, nowL, () =>
    checkAccess({ ...ids, customerId: sL.c.id, meterKey: meter2.key }),
  );
  check(
    "a subscription on the monthly credits price: the check and the access check reset at the " +
      "credits' month end",
    c1.resets_at === month(1).toISOString() && a1.entitlement?.resets_at === month(1).toISOString(),
    { check: c1.resets_at, access: a1.entitlement, want: month(1) },
  );
  const upd = await patchPrice(cp, { grants_credit: credits(25, { every: "week" }) });
  const c2 = await at(biz.id, nowL, () => checkEntitlement(orgId, sL.sub.id, gen.key));
  check(
    "the link follows a later change of the credits' reset (now weekly)",
    upd.statusCode === 200 && c2.resets_at === plus(7 * DAY).toISOString(),
    { upd: upd.statusCode === 200 ? "ok" : upd.body, got: c2.resets_at, want: plus(7 * DAY) },
  );

  // (c) a price change that splits the linked plan's schedules.
  let created: string | null = null;
  try {
    await planPrice(credits(25, { every: "month" }), { productId: creator.id, amount: 9200 });
  } catch (e) {
    created = e instanceof CatalogError ? (e as Error).message : String(e);
  }
  const same = await planPrice(credits(25, { every: "week" }), {
    productId: creator.id,
    amount: 9300,
  });
  const toMonth = await patchPrice(same, { grants_credit: credits(25, { every: "month" }) });
  const unarchive = await patchPrice(daily, { active: true });
  check(
    "(c) a price create, update or unarchive that splits the schedules is refused, naming the " +
      "allowance; a price on the same schedule is accepted",
    !!created &&
      /Generations/.test(created) &&
      toMonth.statusCode === 400 &&
      /Generations/.test(msg(toMonth)) &&
      unarchive.statusCode === 400 &&
      /Generations/.test(msg(unarchive)),
    { created, toMonth: toMonth.body, unarchive: unarchive.body },
  );

  // A subscription override may link too.
  const so = await call(
    "POST",
    `/v1/businesses/${biz.publicId}/subscriptions/${sL.sub.publicId}/entitlements`,
    { feature: gen.key, value: "9", reset: link },
  );
  const c3 = await at(biz.id, nowL, () => checkEntitlement(orgId, sL.sub.id, gen.key));
  check(
    "a subscription override takes the link and resolves it the same way",
    so.statusCode === 201 &&
      so.json().reset?.same_as_credits === true &&
      c3.value === "9" &&
      c3.resets_at === plus(7 * DAY).toISOString(),
    { so: so.body, c3 },
  );

  // No reset on the subscription's own price: the term.
  const basic = await createProduct({ ...ids, name: "Basic" });
  const tp = await planPrice(credits(10, null), { productId: basic.id, amount: 5000 });
  const okT = await linkEnt(basic);
  const sT = await subscribe("link-term", [tp, usage2]);
  const cT = await at(biz.id, nowL, () => checkEntitlement(orgId, sT.sub.id, gen.key));
  check(
    "a subscription on a price with no reset resolves to the term (resets at the term end)",
    okT.statusCode === 201 && cT.resets_at === addInterval(T0, "year", 1).toISOString(),
    { okT: okT.statusCode === 201 ? "ok" : okT.body, got: cT.resets_at },
  );
}

// ── 11. allowances under a pause shift ───────────────────────────────────────────
console.log("11. allowances under a pause shift");
{
  // One meter, usage price and meter feature per case, so `meterFeature` finds one feature.
  const allowanceKit = async (b: typeof ids, productId: string, tag: string) => {
    const m = await createTestMeter(b);
    const up = await createPrice({
      ...b,
      productId,
      id: `pcr-usage-${tag}-${Date.now()}`,
      type: "recurring",
      model: "usage",
      currency: "USD",
      interval: "year",
      meter: m.key,
      unitAmountDecimal: "100",
    });
    const f = await createFeature({
      ...b,
      key: `${tag}-${Date.now()}`,
      name: `Allowance ${tag}`,
      type: "meter",
      meterId: m.id,
    });
    return { m, up, f };
  };
  const sendUse = (
    b: typeof ids,
    m: { eventName: string },
    customerId: string,
    when: Date,
    n: number,
  ) =>
    sendEvent(b, {
      customerId,
      eventName: m.eventName,
      at: when,
      properties: { tokens: n },
      receivedMs: Math.min(Date.now(), when.getTime()) - 10 * 60_000,
    });
  const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
  const stateOf = async (id: string) =>
    ((
      await systemDb
        .select({ rs: subscriptions.resetState })
        .from(subscriptions)
        .where(eq(subscriptions.id, id))
    )[0]?.rs ?? {}) as Record<string, unknown>;
  const setState = (id: string, rs: Record<string, unknown>) =>
    systemDb
      .update(subscriptions)
      .set({ resetState: rs as typeof subscriptions.$inferInsert.resetState })
      .where(eq(subscriptions.id, id));
  // The shape a resume wrote before open windows were stored: the paused total only.
  const toLegacy = async (id: string) => {
    const rs = await stateOf(id);
    await setState(id, {
      paused_at: null,
      shift_ms: rs.shift_ms,
      ...(rs.allowance_changes ? { allowance_changes: rs.allowance_changes } : {}),
    });
  };

  // (a) A linked allowance on calendar-month credits, a 10-day pause mid-month under `shift`:
  // the open window runs to M2 + 10 days, the short window to M3. Usage 1, 2, 4, 8 tells the
  // windows apart.
  {
    const plan = await createProduct({ ...cb.ids, name: "Calendar Link" });
    const cp = await planPrice(credits(25, { every: "month", anchor: "calendar" }), {
      b: cb.ids,
      productId: plan.id,
    });
    const k = await allowanceKit(cb.ids, cb.product.id, "cal-link");
    await setPlanEntitlement({
      ...cb.ids,
      productId: plan.id,
      featureId: k.f.id,
      value: "100",
      reset: { same_as_credits: true },
    });
    const s = await subscribe("link-cal-shift", [cp, k.up], {
      b: cb.ids,
      bizId: cb.biz.id,
      t: dayAfter(M1, 1),
    });
    const p = dayAfter(M1, 14);
    const r = dayAfter(M1, 24);
    const moved = dayAfter(M2, 10);
    await sendUse(cb.ids, k.m, s.c.id, dayAfter(M1, 3), 1);
    await at(cb.biz.id, p, () =>
      pauseSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: p }),
    );
    await at(cb.biz.id, r, () =>
      resumeSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: r }),
    );
    const written = await stateOf(s.sub.id);
    const pw = written.pause_windows as Record<string, unknown> | undefined;
    check(
      "the resume writes the moved window under reset_state.pause_windows, and not the old key",
      !!pw?.[s.planItem.id] && written.calendar_shifts === undefined,
      written,
    );
    // The key written before the rename: still honoured for data already deployed.
    const { pause_windows: _pw, ...rest } = written;
    await setState(s.sub.id, { ...rest, calendar_shifts: pw ?? written.calendar_shifts });
    await sendUse(cb.ids, k.m, s.c.id, dayAfter(M2, 5), 2);
    const step = async (now: Date) => {
      await calResets(now);
      const ch = await at(cb.biz.id, now, () => checkEntitlement(cb.orgId, s.sub.id, k.f.key));
      const acc = await at(cb.biz.id, now, () =>
        checkAccess({ ...cb.ids, customerId: s.c.id, meterKey: k.m.key }),
      );
      return { ch, acc, cursor: await cursorOf(s.planItem.id) };
    };
    const a1 = await step(dayAfter(M2, 6));
    check(
      "linked + calendar shift (seeded under the old key), before the moved end: the credits and " +
        "the allowance renew at M2 + 10 days; the check counts the open window (1 + 2)",
      a1.ch.resets_at === iso(moved) &&
        iso(a1.cursor) === iso(moved) &&
        a1.acc.entitlement?.resets_at === iso(moved) &&
        Number(a1.ch.used) === 3 &&
        Number(a1.acc.entitlement?.used) === 3,
      { ch: a1.ch, ent: a1.acc.entitlement, cursor: a1.cursor, want: moved },
    );
    // Usage is sent as time passes: a window counts what has arrived for it.
    await sendUse(cb.ids, k.m, s.c.id, dayAfter(M2, 12), 4);
    const a2 = await step(dayAfter(M2, 13));
    const w = await windowGrants(s.planItem.id);
    check(
      "linked + calendar shift, the short window: both renew at M3; the check counts the " +
        "short window only (4)",
      a2.ch.resets_at === iso(M3) &&
        iso(a2.cursor) === iso(M3) &&
        a2.acc.entitlement?.resets_at === iso(M3) &&
        t(w[1]?.effectiveAt) === t(moved) &&
        t(w[1]?.expiresAt) === t(M3) &&
        Number(a2.ch.used) === 4,
      { ch: a2.ch, cursor: a2.cursor, w: w.map((g) => [g.effectiveAt, g.expiresAt]) },
    );
    await sendUse(cb.ids, k.m, s.c.id, dayAfter(M3, 2), 8);
    const a3 = await step(dayAfter(M3, 3));
    check(
      "linked + calendar shift, after the short window: both renew at M4; the check counts 8",
      a3.ch.resets_at === iso(M4) && iso(a3.cursor) === iso(M4) && Number(a3.ch.used) === 8,
      { ch: a3.ch, cursor: a3.cursor },
    );
  }

  // (b) A linked allowance on subscription-anchored monthly credits, a 5-day pause under `shift`.
  {
    await setRules(biz.id, { plan_credits: { on_pause: "shift" } });
    const plan = await createProduct({ ...ids, name: "Anchor Link" });
    const cp = await planPrice(credits(25, { every: "month" }), { productId: plan.id });
    const k = await allowanceKit(ids, product.id, "sub-link");
    await setPlanEntitlement({
      ...ids,
      productId: plan.id,
      featureId: k.f.id,
      value: "100",
      reset: { same_as_credits: true },
    });
    const s = await subscribe("link-sub-shift", [cp, k.up]);
    const p = plus(3 * DAY);
    const r = plus(8 * DAY);
    const moved = new Date(month(1).getTime() + 5 * DAY);
    await sendUse(ids, k.m, s.c.id, plus(DAY), 1);
    await at(biz.id, p, () => pauseSubscription({ ...ids, subscriptionId: s.sub.id, now: p }));
    await at(biz.id, r, () => resumeSubscription({ ...ids, subscriptionId: s.sub.id, now: r }));
    await sendUse(ids, k.m, s.c.id, plus(10 * DAY), 2);
    await sendUse(ids, k.m, s.c.id, new Date(month(1).getTime() + 2 * DAY), 4);
    const b1 = new Date(month(1).getTime() + 3 * DAY);
    await resets(b1);
    const ch1 = await at(biz.id, b1, () => checkEntitlement(orgId, s.sub.id, k.f.key));
    await sendUse(ids, k.m, s.c.id, new Date(month(1).getTime() + 6 * DAY), 8);
    const cur1 = await cursorOf(s.planItem.id);
    const w1 = await windowGrants(s.planItem.id);
    check(
      "linked + subscription anchor shift: the credits and the allowance renew 5 days late; the " +
        "check counts the whole open window, before and after the pause (1 + 2 + 4)",
      ch1.resets_at === iso(moved) &&
        iso(cur1) === iso(moved) &&
        t(w1[0]?.expiresAt) === t(moved) &&
        Number(ch1.used) === 7,
      { ch1, cur1, w: w1.map((g) => [g.effectiveAt, g.expiresAt]), want: moved },
    );
    await toLegacy(s.sub.id);
    const ch1L = await at(biz.id, b1, () => checkEntitlement(orgId, s.sub.id, k.f.key));
    check(
      "linked, legacy shape (shift_ms only): the open window is derived from the pause record " +
        "(the same resets_at and 1 + 2 + 4)",
      ch1L.resets_at === iso(moved) && Number(ch1L.used) === 7,
      ch1L,
    );
    const b2 = new Date(month(1).getTime() + 7 * DAY);
    await resets(b2);
    const ch2 = await at(biz.id, b2, () => checkEntitlement(orgId, s.sub.id, k.f.key));
    const cur2 = await cursorOf(s.planItem.id);
    const w2 = await windowGrants(s.planItem.id);
    check(
      "linked + subscription anchor shift, the next window: it starts at the moved end; " +
        "resets_at is the credits' next window start; the check counts 8",
      t(w2[1]?.effectiveAt) === t(moved) &&
        ch2.resets_at === iso(new Date(month(2).getTime() + 5 * DAY)) &&
        ch2.resets_at === iso(cur2) &&
        ch2.resets_at === iso(w2[1]?.expiresAt) &&
        Number(ch2.used) === 8,
      { ch2, cur2, w: w2.map((g) => [g.effectiveAt, g.expiresAt]) },
    );
    await setRules(biz.id, null);
  }

  // (c) An allowance with its own calendar-month reset (no credits) follows `on_pause`: `shift`
  // moves it as the credits move; `skip` leaves its windows as they are.
  for (const rule of ["shift", "skip"] as const) {
    await setRules(cb.biz.id, { plan_credits: { on_pause: rule } });
    const plan = await createProduct({ ...cb.ids, name: `Own Calendar ${rule}` });
    const fp = await planPrice(null, { b: cb.ids, productId: plan.id });
    const k = await allowanceKit(cb.ids, cb.product.id, `own-cal-${rule}`);
    await setPlanEntitlement({
      ...cb.ids,
      productId: plan.id,
      featureId: k.f.id,
      value: "100",
      reset: { every: "month", anchor: "calendar" },
    });
    const s = await subscribe(`own-cal-${rule}`, [fp, k.up], {
      b: cb.ids,
      bizId: cb.biz.id,
      t: dayAfter(M1, 1),
    });
    const p = dayAfter(M1, 14);
    const r = dayAfter(M1, 24);
    await sendUse(cb.ids, k.m, s.c.id, dayAfter(M1, 3), 1);
    await at(cb.biz.id, p, () =>
      pauseSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: p }),
    );
    await at(cb.biz.id, r, () =>
      resumeSubscription({ ...cb.ids, subscriptionId: s.sub.id, now: r }),
    );
    await sendUse(cb.ids, k.m, s.c.id, dayAfter(M2, 5), 2);
    const c1 = await at(cb.biz.id, dayAfter(M2, 6), () =>
      checkEntitlement(cb.orgId, s.sub.id, k.f.key),
    );
    await sendUse(cb.ids, k.m, s.c.id, dayAfter(M2, 12), 4);
    const c2 = await at(cb.biz.id, dayAfter(M2, 13), () =>
      checkEntitlement(cb.orgId, s.sub.id, k.f.key),
    );
    const ok =
      rule === "shift"
        ? c1.resets_at === iso(dayAfter(M2, 10)) &&
          Number(c1.used) === 3 &&
          c2.resets_at === iso(M3) &&
          Number(c2.used) === 4
        : c1.resets_at === iso(M3) &&
          Number(c1.used) === 2 &&
          c2.resets_at === iso(M3) &&
          Number(c2.used) === 6;
    check(
      rule === "shift"
        ? "own calendar reset, shift: the open window runs to M2 + 10 days (1 + 2), the short " +
            "window to M3 (4)"
        : "own calendar reset, skip: the windows do not move (M2 to M3: 2, then 2 + 4)",
      ok,
      { c1, c2 },
    );
  }
  await setRules(cb.biz.id, { plan_credits: { on_pause: "shift" } });

  // (d) A legacy pause (shift_ms only) on an allowance with its own subscription-anchored reset.
  {
    await setRules(biz.id, { plan_credits: { on_pause: "shift" } });
    const plan = await createProduct({ ...ids, name: "Own Anchor Legacy" });
    const fp = await planPrice(null, { productId: plan.id });
    const k = await allowanceKit(ids, product.id, "own-sub-legacy");
    await setPlanEntitlement({
      ...ids,
      productId: plan.id,
      featureId: k.f.id,
      value: "100",
      reset: { every: "month" },
    });
    const s = await subscribe("own-sub-legacy", [fp, k.up]);
    const p = plus(3 * DAY);
    const r = plus(8 * DAY);
    const moved = new Date(month(1).getTime() + 5 * DAY);
    await sendUse(ids, k.m, s.c.id, plus(DAY), 1);
    await at(biz.id, p, () => pauseSubscription({ ...ids, subscriptionId: s.sub.id, now: p }));
    await at(biz.id, r, () => resumeSubscription({ ...ids, subscriptionId: s.sub.id, now: r }));
    await sendUse(ids, k.m, s.c.id, plus(10 * DAY), 2);
    const now = plus(12 * DAY);
    const stored = await at(biz.id, now, () => checkEntitlement(orgId, s.sub.id, k.f.key));
    await toLegacy(s.sub.id);
    const legacy = await at(biz.id, now, () => checkEntitlement(orgId, s.sub.id, k.f.key));
    check(
      "own subscription-anchored reset, legacy shape (shift_ms only): the window open at the " +
        "pause is derived from the pause record, as if stored (1 + 2, renews 5 days late)",
      [stored, legacy].every((c) => c.resets_at === iso(moved) && Number(c.used) === 3),
      { stored, legacy, want: moved },
    );
    await setRules(biz.id, null);
  }

  // (e) Month-end anchors: a 5-day pause from the 5th day; every later boundary moves by the
  // paused time, so the next window starts where the open one ends (one grant per window).
  {
    await setRules(biz.id, { plan_credits: { on_pause: "shift" } });
    const daysIn = (f: Date) =>
      new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0)).getUTCDate();
    const anchorOn = (day: number) => {
      for (let i = 1; i <= 7; i++)
        if (daysIn(first(i)) === day)
          return new Date(Date.UTC(first(i).getUTCFullYear(), first(i).getUTCMonth(), day));
      throw new Error(`no month with ${day} days ahead`);
    };
    for (const day of [30, 31]) {
      const t0 = anchorOn(day);
      const plan = await createProduct({ ...ids, name: `Month End ${day}` });
      const cp = await planPrice(credits(25, { every: "month" }), { productId: plan.id });
      const k = await allowanceKit(ids, product.id, `month-end-${day}`);
      await setPlanEntitlement({
        ...ids,
        productId: plan.id,
        featureId: k.f.id,
        value: "100",
        reset: { same_as_credits: true },
      });
      const s = await subscribe(`month-end-${day}`, [cp, k.up], { t: t0 });
      const p = new Date(t0.getTime() + 5 * DAY);
      const r = new Date(t0.getTime() + 10 * DAY);
      await at(biz.id, p, () => pauseSubscription({ ...ids, subscriptionId: s.sub.id, now: p }));
      await at(biz.id, r, () => resumeSubscription({ ...ids, subscriptionId: s.sub.id, now: r }));
      const end1 = new Date(addInterval(t0, "month", 1).getTime() + 5 * DAY);
      const end2 = new Date(addInterval(t0, "month", 2).getTime() + 5 * DAY);
      const now = new Date(end1.getTime() + 60_000);
      await resets(now);
      const w = await windowGrants(s.planItem.id);
      const cur = await cursorOf(s.planItem.id);
      const ch = await at(biz.id, now, () => checkEntitlement(orgId, s.sub.id, k.f.key));
      check(
        `anchor on the ${day === 31 ? "31st" : "30th"}: the open window ends 5 days late; the next grant starts there ` +
          "and ends 5 days after the next boundary; the cursor and resets_at agree",
        w.length === 2 &&
          t(w[0]!.expiresAt) === t(end1) &&
          t(w[1]!.effectiveAt) === t(end1) &&
          t(w[1]!.expiresAt) === t(end2) &&
          iso(cur) === iso(end2) &&
          ch.resets_at === iso(end2),
        {
          t0,
          want: { end1, end2 },
          w: w.map((g) => [g.effectiveAt, g.expiresAt]),
          cur,
          resets: ch.resets_at,
        },
      );
    }
    await setRules(biz.id, null);
  }
}
// ── 12. per-call overrides ───────────────────────────────────────────────────────
console.log("12. per-call overrides");
const stateOf = async (id: string) =>
  (
    await systemDb
      .select({ rs: subscriptions.resetState, booked: subscriptions.cancelBookedAt })
      .from(subscriptions)
      .where(eq(subscriptions.id, id))
  )[0]!;
{
  // (a) business `skip`; the pause call says `keep_granting`, or nothing.
  await setRules(biz.id, { plan_credits: { on_pause: "skip" } });
  for (const perCall of ["keep_granting", undefined] as const) {
    const s = await subscribe(`ovr-pause-${perCall ?? "omit"}`, [weekly]);
    const pauseAt = plus(3 * DAY);
    await at(biz.id, pauseAt, () =>
      pauseSubscriptionWithOptions({
        ...ids,
        subscriptionId: s.sub.id,
        now: pauseAt,
        pauseOption: "immediately",
        ...(perCall ? { planCreditsOnPause: perCall } : {}),
      }),
    );
    await resets(plus(7 * DAY + 60_000));
    const n = (await windowGrants(s.planItem.id)).length;
    check(
      `pause, business skip + ${perCall ?? "omitted"}: ${perCall ? "week 2 granted while paused" : "week 2 skipped"}`,
      n === (perCall ? 2 : 1),
      n,
    );
    if (perCall) {
      const resumeAt = plus(9 * DAY);
      await at(biz.id, resumeAt, () =>
        resumeSubscription({ ...ids, subscriptionId: s.sub.id, now: resumeAt }),
      );
      const rs = (await stateOf(s.sub.id)).rs;
      check("the resume drops the pause's own rule", rs?.pause_rule == null, rs);
    }
  }
  // (b) a deferred pause carries the choice to its scheduled row.
  {
    const s = await subscribe("ovr-pause-deferred", [weekly]);
    const out = await at(biz.id, T0, () =>
      pauseSubscriptionWithOptions({
        ...ids,
        subscriptionId: s.sub.id,
        now: T0,
        pauseOption: "specific_date",
        pauseDate: plus(3 * DAY),
        planCreditsOnPause: "shift",
      }),
    );
    const [row] = await systemDb
      .select({ payload: scheduledChanges.payload })
      .from(scheduledChanges)
      .where(eq(scheduledChanges.publicId, out.scheduledChange!));
    check(
      "a deferred pause stores plan_credits.on_pause for the date it starts",
      (row?.payload as { pause?: { planCreditsOnPause?: string } })?.pause?.planCreditsOnPause ===
        "shift",
      row?.payload,
    );
  }
  await setRules(biz.id, null);

  // (c) end-of-term cancel: each business rule against the other value, and omitted.
  const cancelEnd = (subId: string, perCall?: "grant_started_window" | "stop_at_request") =>
    at(biz.id, T0, () =>
      cancelSubscriptionWithOptions({
        ...ids,
        subscriptionId: subId,
        now: T0,
        cancelOption: "end_of_term",
        ...(perCall ? { planCreditsOnCancelAtPeriodEnd: perCall } : {}),
      }),
    );
  for (const [rule, perCall, want] of [
    ["grant_started_window", "stop_at_request", 1],
    ["stop_at_request", "grant_started_window", 2],
    ["stop_at_request", undefined, 1],
  ] as const) {
    await setRules(biz.id, { plan_credits: { on_cancel_at_period_end: rule } });
    const s = await subscribe(`ovr-cancel-${rule}-${perCall ?? "omit"}`, [weekly]);
    await cancelEnd(s.sub.id, perCall);
    await resets(plus(7 * DAY + 60_000));
    const n = (await windowGrants(s.planItem.id)).length;
    check(
      `cancel at end, business ${rule} + ${perCall ?? "omitted"}: ${want} window(s)`,
      n === want,
      n,
    );
  }
  // (d) the choice belongs to its cancel: removed, then cancelled again without it.
  await setRules(biz.id, { plan_credits: { on_cancel_at_period_end: "grant_started_window" } });
  {
    const s = await subscribe("ovr-cancel-again", [weekly]);
    await cancelEnd(s.sub.id, "stop_at_request");
    await removeScheduledCancellation({ ...ids, subscriptionId: s.sub.id });
    const again = new Date(T0.getTime() + 60_000);
    await at(biz.id, again, () =>
      cancelSubscription({ ...ids, subscriptionId: s.sub.id, atPeriodEnd: true, now: again }),
    );
    await resets(plus(7 * DAY + 60_000));
    const n = (await windowGrants(s.planItem.id)).length;
    check("a later cancel follows the business rule, not the earlier call's choice", n === 2, n);
  }
  // (e) a dated cancel takes the override too.
  {
    const s = await subscribe("ovr-cancel-date", [weekly]);
    await at(biz.id, T0, () =>
      cancelSubscriptionWithOptions({
        ...ids,
        subscriptionId: s.sub.id,
        now: T0,
        cancelOption: "specific_date",
        cancelAt: plus(10 * DAY),
        planCreditsOnCancelAtPeriodEnd: "stop_at_request",
      }),
    );
    await resets(plus(14 * DAY + 60_000));
    const n = (await windowGrants(s.planItem.id)).length;
    check("a dated cancel + stop_at_request: no window after the request", n === 1, n);
  }
  await setRules(biz.id, null);

  // (f) the API threads both fields and refuses the cancel one with `immediately`.
  const post = (path: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/v1/businesses/${biz.publicId}/subscriptions/${path}`,
      headers: { ...auth, "idempotency-key": `ovr-${path}-${Date.now()}-${Math.random()}` },
      payload,
    });
  {
    const s = await subscribe("ovr-api-pause", [weekly]);
    const res = await post(`${s.sub.publicId}/pause`, {
      pause_option: "immediately",
      plan_credits: { on_pause: "keep_granting" },
    });
    const rs = (await stateOf(s.sub.id)).rs;
    check(
      "API pause: plan_credits.on_pause is stored with the pause",
      res.statusCode === 200 && rs?.pause_rule === "keep_granting",
      `${res.statusCode} ${JSON.stringify(rs)}`,
    );
  }
  {
    const s = await subscribe("ovr-api-cancel", [weekly]);
    const now = await post(`${s.sub.publicId}/cancel`, {
      cancel_option: "immediately",
      plan_credits: { on_cancel_at_period_end: "stop_at_request" },
    });
    const est = await post(`${s.sub.publicId}/cancel_estimate`, {
      cancel_option: "immediately",
      plan_credits: { on_cancel_at_period_end: "stop_at_request" },
    });
    check(
      "API: plan_credits.on_cancel_at_period_end with immediately is refused (cancel + estimate)",
      now.statusCode === 400 && est.statusCode === 400,
      `${now.statusCode} ${est.statusCode} ${now.body}`,
    );
    const end = await post(`${s.sub.publicId}/cancel`, {
      cancel_option: "end_of_term",
      plan_credits: { on_cancel_at_period_end: "stop_at_request" },
    });
    const st = await stateOf(s.sub.id);
    check(
      "API end-of-term cancel: the choice is stored against its booking",
      end.statusCode === 200 &&
        st.rs?.cancel_rule?.value === "stop_at_request" &&
        t(new Date(st.rs.cancel_rule.booked_at)) === t(st.booked),
      `${end.statusCode} ${JSON.stringify(st)}`,
    );
  }
}

await app.close();

if (fails.length) {
  console.log(`\n❌ PLAN-CREDIT-RESETS: ${fails.length} failed`);
  for (const f of fails) console.log(`  - ${f}`);
  await closeDb();
  process.exit(1);
}
console.log("\n✅ PLAN-CREDIT-RESETS: PASS");
await closeDb();
