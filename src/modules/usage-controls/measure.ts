/**
 * One measure for every usage control (design G5 §3.1): spend (rated usage, pre-tax, before
 * credits), quantity per meter, live balance and burn, for a customer and an instant. Reads
 * are exact at any instant: rollups inside the window plus the raw tail (metering/read.ts),
 * so a check never waits for the fold. Read-only.
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  localDatePartsInTz,
  midnightOnDateInTz,
  startOfDayInTz,
  startOfNextDayInTz,
  stampNow,
} from "@/platform/clock";
import { businesses, customers, type UsageControlInterval } from "@db/schema";
import { FOLD_GRACE_MS, peekMeterCutoff, rateMeterItem } from "@/modules/metering/meter-rating";
import type { MeterCutoff } from "@/modules/metering/meter-rating";
import { rateMeteredItem } from "@/modules/metering/rating";
import { readMeterUsage } from "@/modules/metering/read";
import { liveMeteredItems, type MeteredItem } from "@/modules/credits/usage";
import { liveAt, liveBalance } from "@/modules/credits/balance";
import { faceMinorFor } from "@/modules/credits/units";

export type { UsageControlInterval };

const DAY_MS = 86_400_000;

export interface Window {
  start: Date;
  end: Date;
}

const TZ_TTL_MS = 60_000;
const tzCache = new Map<string, { tz: string; at: number }>();

/** The business's time zone (IANA), UTC when unset. Cached for a minute per process. */
export async function businessTimeZone(tx: Tx, businessId: string): Promise<string> {
  const hit = tzCache.get(businessId);
  if (hit && Date.now() - hit.at < TZ_TTL_MS) return hit.tz;
  const [b] = await tx
    .select({ tz: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const tz = b?.tz || "UTC";
  tzCache.set(businessId, { tz, at: Date.now() });
  return tz;
}

/**
 * The calendar interval holding `now` in the business zone: day, ISO week (Monday) or
 * month. `period` is per subscription (see `periodWindow`).
 */
export function calendarWindow(
  interval: Exclude<UsageControlInterval, "period">,
  now: Date,
  tz: string,
): Window {
  if (interval === "day")
    return { start: startOfDayInTz(now, tz), end: startOfNextDayInTz(now, tz) };
  const p = localDatePartsInTz(now, tz);
  if (interval === "month")
    return {
      start: midnightOnDateInTz(p.year, p.month, 1, tz),
      end: midnightOnDateInTz(p.year, p.month + 1, 1, tz),
    };
  const dow = new Date(Date.UTC(p.year, p.month, p.day)).getUTCDay();
  const back = (dow + 6) % 7;
  return {
    start: midnightOnDateInTz(p.year, p.month, p.day - back, tz),
    end: midnightOnDateInTz(p.year, p.month, p.day - back + 7, tz),
  };
}

/** A subscription's current term, or null before its first term. */
export function periodWindow(sub: {
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}): Window | null {
  if (!sub.currentPeriodStart || !sub.currentPeriodEnd) return null;
  return { start: new Date(sub.currentPeriodStart), end: new Date(sub.currentPeriodEnd) };
}

export interface SpendQuery {
  businessId: string;
  customerId: string;
  currency: string;
  interval: UsageControlInterval;
  /** Business clock; default `stampNow(businessId)`. */
  now?: Date;
  /** Default: the business zone. */
  tz?: string;
  /** null = all meters. */
  meterIds?: string[] | null;
  /** Only this subscription's items. */
  subscriptionId?: string | null;
  /** Only events whose property `key` equals `value`. Meter prices only. */
  where?: { key: string; value: string } | null;
}

export interface ItemSpend {
  subscriptionId: string;
  subscriptionItemId: string;
  meterId: string | null;
  window: Window;
  amountMinor: bigint;
}

export interface SpendMeasure {
  amountMinor: bigint;
  /** The interval: calendar, or the earliest term for `period`. */
  window: Window;
  /** When the interval resets (window end). */
  resetsAt: Date;
  items: ItemSpend[];
}

/**
 * Rates within one evaluation, keyed by item, window and filter. Share one across limits so
 * the term-to-now rating is done once.
 */
export type RateCache = Map<string, Promise<bigint>>;
export const newRateCache = (): RateCache => new Map();

async function cutoffFor(
  tx: Tx,
  cache: Map<string, Promise<MeterCutoff>>,
  input: { businessId: string; customerId: string; meterId: string },
): Promise<MeterCutoff> {
  let c = cache.get(input.meterId);
  if (!c) {
    c = peekMeterCutoff(tx, input).then((p) => ({
      ...p,
      // Every event received so far; the billing pointer does not narrow a measure.
      at: new Date(Date.now() + FOLD_GRACE_MS + 1_000),
      previous: { ...p.previous, usageThrough: null },
    }));
    cache.set(input.meterId, c);
  }
  return c;
}

/** Rated amount of one item over `window`, pre-tax, before credits. */
async function rateItem(
  tx: Tx,
  ctx: {
    businessId: string;
    customerId: string;
    cache: RateCache;
    cutoffs: Map<string, Promise<MeterCutoff>>;
    where: { key: string; value: string } | null;
  },
  r: MeteredItem,
  window: Window,
): Promise<bigint> {
  if (window.end.getTime() <= window.start.getTime()) return 0n;
  const key = JSON.stringify([
    r.item.id,
    window.start.getTime(),
    window.end.getTime(),
    ctx.where?.key ?? null,
    ctx.where?.value ?? null,
  ]);
  const hit = ctx.cache.get(key);
  if (hit) return hit;
  const run = (async () => {
    if (r.snap.meter) {
      const cutoff = await cutoffFor(tx, ctx.cutoffs, {
        businessId: ctx.businessId,
        customerId: ctx.customerId,
        meterId: r.snap.meter.id,
      });
      const rated = await rateMeterItem(tx, {
        item: { ...r.item, priceSnapshot: r.snap },
        subscription: { customerId: ctx.customerId, currency: r.sub.currency },
        window,
        cutoff,
        usageThrough: window.end,
        measureOnly: true,
        ...(ctx.where ? { where: ctx.where } : {}),
      });
      return rated.lines.filter((l) => !l.late).reduce((a, l) => a + l.amountMinor, 0n);
    }
    // Usage records carry no properties: a property measure leaves them out.
    if (ctx.where) return 0n;
    const rated = await rateMeteredItem(tx, {
      item: { ...r.item, priceSnapshot: r.snap },
      window,
    });
    return rated.amountMinor;
  })();
  ctx.cache.set(key, run);
  return run;
}

/**
 * Spend in `[from, to)` for one item, consistent with its invoice: inside the current term
 * it is rated(term start → to) − rated(term start → from), so tiers, packages and free units
 * land where the invoice puts them. A part before the term is rated on its own.
 */
async function itemSpendBetween(
  tx: Tx,
  ctx: Parameters<typeof rateItem>[1],
  r: MeteredItem,
  from: Date,
  to: Date,
): Promise<bigint> {
  if (to.getTime() <= from.getTime()) return 0n;
  const term = r.sub.currentPeriodStart ? new Date(r.sub.currentPeriodStart) : null;
  if (!term || term.getTime() >= to.getTime())
    return rateItem(tx, ctx, r, { start: from, end: to });
  let before = 0n;
  let inner = 0n;
  if (from.getTime() < term.getTime()) {
    before = await rateItem(tx, ctx, r, { start: from, end: term });
    inner = await rateItem(tx, ctx, r, { start: term, end: to });
  } else {
    const all = await rateItem(tx, ctx, r, { start: term, end: to });
    const head = await rateItem(tx, ctx, r, { start: term, end: from });
    inner = all - head;
  }
  const total = before + inner;
  return total > 0n ? total : 0n;
}

/**
 * Spend over an interval for a customer (design §3.1): Σ over the customer's live metered
 * items in `currency`, narrowed by meters, subscription and property. `period` uses each
 * subscription's own term. `items` may be passed when already loaded.
 */
export async function measureSpend(
  tx: Tx,
  q: SpendQuery,
  opts: { cache?: RateCache; items?: MeteredItem[] } = {},
): Promise<SpendMeasure> {
  const now = q.now ?? stampNow(q.businessId);
  const tz = q.tz ?? (await businessTimeZone(tx, q.businessId));
  const cur = q.currency.toUpperCase();
  const all =
    opts.items ?? (await liveMeteredItems(tx, { customerId: q.customerId, currency: cur }));
  const items = all.filter(
    (r) =>
      r.sub.currency.toUpperCase() === cur &&
      (!q.subscriptionId || r.sub.id === q.subscriptionId) &&
      (!q.meterIds || (r.snap.meter != null && q.meterIds.includes(r.snap.meter.id))) &&
      (!q.where || r.snap.meter != null),
  );
  const ctx = {
    businessId: q.businessId,
    customerId: q.customerId,
    cache: opts.cache ?? newRateCache(),
    cutoffs: new Map<string, Promise<MeterCutoff>>(),
    where: q.where ?? null,
  };
  const cal = q.interval === "period" ? null : calendarWindow(q.interval, now, tz);
  const out: ItemSpend[] = [];
  let window: Window | null = cal;
  for (const r of items) {
    const w = cal ?? periodWindow(r.sub);
    if (!w) continue;
    if (!window || w.end.getTime() < window.end.getTime()) window = w;
    const to = new Date(Math.min(now.getTime(), w.end.getTime()));
    const amountMinor = await itemSpendBetween(tx, ctx, r, w.start, to);
    out.push({
      subscriptionId: r.sub.id,
      subscriptionItemId: r.item.id,
      meterId: r.snap.meter?.id ?? null,
      window: w,
      amountMinor,
    });
  }
  const win = window ?? cal ?? { start: now, end: now };
  return {
    amountMinor: out.reduce((a, i) => a + i.amountMinor, 0n),
    window: win,
    resetsAt: win.end,
    items: out,
  };
}

/** Spend in an explicit `[from, to)` (burn, previews). */
export async function measureSpendBetween(
  tx: Tx,
  q: {
    businessId: string;
    customerId: string;
    currency: string;
    from: Date;
    to: Date;
    meterIds?: string[] | null;
  },
  opts: { cache?: RateCache; items?: MeteredItem[] } = {},
): Promise<bigint> {
  const cur = q.currency.toUpperCase();
  const all =
    opts.items ?? (await liveMeteredItems(tx, { customerId: q.customerId, currency: cur }));
  const ctx = {
    businessId: q.businessId,
    customerId: q.customerId,
    cache: opts.cache ?? newRateCache(),
    cutoffs: new Map<string, Promise<MeterCutoff>>(),
    where: null,
  };
  let total = 0n;
  for (const r of all) {
    if (r.sub.currency.toUpperCase() !== cur) continue;
    if (q.meterIds && (!r.snap.meter || !q.meterIds.includes(r.snap.meter.id))) continue;
    total += await itemSpendBetween(tx, ctx, r, q.from, q.to);
  }
  return total;
}

/**
 * A meter's quantity in `[from, to)`, Fixed12. Level meters (recurring, weighted_sum)
 * read 0 here, as the entitlement count does.
 */
export async function measureQuantity(
  tx: Tx,
  q: { customerId: string; meterId: string; from: Date; to: Date },
): Promise<bigint> {
  if (q.to.getTime() <= q.from.getTime()) return 0n;
  try {
    const u = await readMeterUsage(tx, {
      customerId: q.customerId,
      meterId: q.meterId,
      window: { start: q.from, end: q.to },
    });
    return u.segments.flatMap((s) => s.rows).reduce((a, r) => a + r.quantity, 0n);
  } catch (e) {
    if ((e as Error).name === "LevelMeterReadError") return 0n;
    throw e;
  }
}

export interface BalanceMeasure {
  /** Minor units for money (unit null), else the unit's steps. */
  value: bigint;
  /** Money balance in minor units (all grants, face). */
  moneyMinor: bigint;
  /** Σ original amounts of live grants, in the same unit as `value`. */
  grantedTotal: bigint;
}

/** Live balance (PR 2's `liveBalance`) for money or one credit unit. */
export async function measureBalance(
  tx: Tx,
  q: { customerId: string; currency: string; unitId: string | null; now: Date },
): Promise<BalanceMeasure> {
  const [c] = await tx
    .select({ settings: customers.creditSettings, cfg: businesses.creditConfig })
    .from(customers)
    .innerJoin(businesses, eq(businesses.id, customers.businessId))
    .where(eq(customers.id, q.customerId))
    .limit(1);
  const bal = await liveBalance(tx, {
    customerId: q.customerId,
    currency: q.currency,
    now: q.now,
    businessConfig: c?.cfg ?? null,
    customerSettings: c?.settings ?? null,
  });
  const live = bal.grants.filter((g) => liveAt(g, q.now));
  if (!q.unitId) {
    const granted = live.reduce(
      (a, g) => a + (g.unit ? faceMinorFor(g.amount, g.unit) : g.amount),
      0n,
    );
    return { value: bal.balanceMinor, moneyMinor: bal.balanceMinor, grantedTotal: granted };
  }
  const mine = live.filter((g) => g.unitId === q.unitId);
  const key = mine[0]?.unitKey ?? null;
  const units = key ? (bal.availableUnits.find((u) => u.unit === key)?.units ?? 0n) : 0n;
  return {
    value: units,
    moneyMinor: bal.balanceMinor,
    grantedTotal: mine.reduce((a, g) => a + g.amount, 0n),
  };
}

export interface BurnMeasure {
  /** Spend in the last 7 days. */
  spend7dMinor: bigint;
  /** spend7d ÷ 7, rounded down; null when there is not enough usage. */
  burnMinorPerDay: bigint | null;
  /** True when the customer has at least 24 h of usage. */
  enoughUsage: boolean;
}

/** Burn (design §3.5): spend in the last 7 days ÷ 7. Null under 24 h of usage or at 0. */
export async function measureBurn(
  tx: Tx,
  q: { businessId: string; customerId: string; currency: string; now: Date },
  opts: { cache?: RateCache; items?: MeteredItem[] } = {},
): Promise<BurnMeasure> {
  const from = new Date(q.now.getTime() - 7 * DAY_MS);
  const rows = (await tx.execute(sql`
    select least(
      (select min("timestamp") from usage_events where business_id = ${q.businessId}
        and customer_id = ${q.customerId} and voided_at is null
        and "timestamp" >= ${from.toISOString()}::timestamptz),
      (select min(r."timestamp") from usage_records r
        join subscriptions s on s.id = r.subscription_id
        where s.customer_id = ${q.customerId} and r."timestamp" >= ${from.toISOString()}::timestamptz)
    ) as first`)) as unknown as Array<{ first: string | Date | null }>;
  const first = rows[0]?.first ? new Date(rows[0].first) : null;
  const enoughUsage = !!first && q.now.getTime() - first.getTime() >= DAY_MS;
  const spend7dMinor = await measureSpendBetween(tx, { ...q, from, to: q.now }, opts);
  const burn = spend7dMinor / 7n;
  return {
    spend7dMinor,
    burnMinorPerDay: enoughUsage && spend7dMinor > 0n ? burn : null,
    enoughUsage,
  };
}

export interface Runway {
  /** null = "Not enough usage to estimate". */
  runwayDays: number | null;
  runsOutAt: Date | null;
  balanceMinor: bigint;
  burnMinorPerDay: bigint | null;
  /** Money the auto top-up can still add this month (counted in the runway). */
  autoTopupMinor: bigint;
}

/**
 * Runway (§3.5): floor(balance ÷ burn) days, with burn = spend7d ÷ 7 kept exact as
 * floor(balance × 7 ÷ spend7d). `extraMinor` adds what an auto top-up can still buy.
 */
export function runwayFrom(input: {
  balanceMinor: bigint;
  spend7dMinor: bigint;
  enoughUsage: boolean;
  now: Date;
  extraMinor?: bigint;
}): { runwayDays: number | null; runsOutAt: Date | null } {
  if (!input.enoughUsage || input.spend7dMinor <= 0n) return { runwayDays: null, runsOutAt: null };
  const bal = input.balanceMinor + (input.extraMinor ?? 0n);
  const days = bal <= 0n ? 0n : (bal * 7n) / input.spend7dMinor;
  const n = Number(days);
  return { runwayDays: n, runsOutAt: new Date(input.now.getTime() + n * DAY_MS) };
}

/** What an active auto top-up can still add this calendar month (cap − open and paid runs). */
export async function autoTopupHeadroom(
  tx: Tx,
  q: {
    businessId: string;
    customerId: string;
    currency: string;
    unitId: string | null;
    now: Date;
    tz: string;
  },
): Promise<bigint> {
  const month = calendarWindow("month", q.now, q.tz);
  const rows = (await tx.execute(sql`
    select a.monthly_cap_minor::text as cap,
      coalesce((select sum(r.amount_minor) from credit_auto_topup_runs r
        where r.config_id = a.id and r.status in ('notice_sent','charging','pending','succeeded')
          and r.created_at >= ${month.start.toISOString()}::timestamptz
          and r.created_at < ${month.end.toISOString()}::timestamptz), 0)::text as used
    from credit_auto_topups a
    where a.business_id = ${q.businessId} and a.customer_id = ${q.customerId}
      and a.currency = ${q.currency.toUpperCase()} and a.status = 'active'
      and ${q.unitId ? sql`a.unit_id = ${q.unitId}` : sql`a.unit_id is null`}
    limit 1`)) as unknown as Array<{ cap: string; used: string }>;
  const r = rows[0];
  if (!r) return 0n;
  const left = BigInt(r.cap) - BigInt(r.used);
  return left > 0n ? left : 0n;
}

/** Runway for a customer in a currency (money balance). */
export async function measureRunway(
  tx: Tx,
  q: {
    businessId: string;
    customerId: string;
    currency: string;
    unitId?: string | null;
    now?: Date;
  },
): Promise<Runway & { enoughUsage: boolean; spend7dMinor: bigint }> {
  const now = q.now ?? stampNow(q.businessId);
  const tz = await businessTimeZone(tx, q.businessId);
  const bal = await measureBalance(tx, {
    customerId: q.customerId,
    currency: q.currency,
    unitId: null,
    now,
  });
  const burn = await measureBurn(tx, { ...q, now });
  const extra = await autoTopupHeadroom(tx, {
    businessId: q.businessId,
    customerId: q.customerId,
    currency: q.currency,
    unitId: q.unitId ?? null,
    now,
    tz,
  });
  const r = runwayFrom({
    balanceMinor: bal.moneyMinor,
    spend7dMinor: burn.spend7dMinor,
    enoughUsage: burn.enoughUsage,
    now,
    extraMinor: extra,
  });
  return {
    ...r,
    balanceMinor: bal.moneyMinor,
    burnMinorPerDay: burn.burnMinorPerDay,
    autoTopupMinor: extra,
    enoughUsage: burn.enoughUsage,
    spend7dMinor: burn.spend7dMinor,
  };
}

/** Customers of a business with an active subscription in `currency` (for scans). */
export async function customerCurrencies(tx: Tx, customerId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select distinct upper(currency) as c from subscriptions
    where customer_id = ${customerId} and status in ('active', 'in_trial') and deleted_at is null`)) as unknown as Array<{
    c: string;
  }>;
  return rows.map((r) => r.c);
}
