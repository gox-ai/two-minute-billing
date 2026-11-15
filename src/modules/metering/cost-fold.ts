import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { formatFixed12 } from "@/platform/fixed";
import { loadRateTimeline, type RateTimeline } from "@/platform/fx/history";
import { nextDay, zonedDayEndExclusive, zonedDayStart, zonedDayString } from "@/platform/timezones";
import { loadModelPriceBook } from "@/modules/model-prices/resolve";
import { businesses, customers, meters, usageCostDaily } from "@db/schema";
import type { MeterRow } from "./meter-rating";
import { toMeterShape } from "./meters";
import { listKeyOf, meterHasCost, UsageCost } from "./price-list-rating";
import { readMeterUsage, type MeterUsageRow } from "./read";
import { countsTowardMeter, isRollable, rowsOf, uuidFloor } from "./usage-sql";

/**
 * The daily cost fold (`usage_cost_daily`): every customer's usage cost per business-local day,
 * meter and group values, by `UsageCost` (the rule `lineCost` puts on an invoice line) over the
 * reader's 15-minute buckets, each priced where it starts and converted at the day's end. It
 * covers ALL usage, billed or not; the margin report decides what an invoice line already holds.
 * A day is replaced whole, so a late event or a voided event restates it. Summed and counted
 * meters only, as on a line.
 */

/** A live subscription of the customer: the plan its usage counts under, and its currency. */
interface LiveSub {
  id: string;
  customerId: string;
  currency: string;
  start: Date;
  canceledAt: Date | null;
  meterIds: string[];
}

/**
 * The subscription a customer's usage of `meterId` on [start, end) counts under: of those live
 * that day (started before it ended, not cancelled before it began), the one with a price on
 * the meter, then the earliest start, then the lowest id. Null = none.
 */
export function subscriptionForDay(
  subs: readonly LiveSub[],
  meterId: string,
  start: Date,
  end: Date,
): LiveSub | null {
  let best: LiveSub | null = null;
  const rank = (s: LiveSub) => [s.meterIds.includes(meterId) ? 0 : 1, s.start.getTime()] as const;
  for (const s of subs) {
    if (s.start >= end || (s.canceledAt != null && s.canceledAt <= start)) continue;
    if (!best) {
      best = s;
      continue;
    }
    const [a1, a2] = rank(s);
    const [b1, b2] = rank(best);
    if (a1 < b1 || (a1 === b1 && (a2 < b2 || (a2 === b2 && s.id < best.id)))) best = s;
  }
  return best;
}

/** Contiguous runs of the given local dates. */
function runsOf(days: readonly string[]): string[][] {
  const sorted = [...new Set(days)].sort();
  const out: string[][] = [];
  for (const d of sorted) {
    const last = out.at(-1);
    if (last && nextDay(last.at(-1)!) === d) last.push(d);
    else out.push([d]);
  }
  return out;
}

const meterRowOf = (m: typeof meters.$inferSelect): MeterRow => ({
  ...toMeterShape(m),
  key: m.key,
  timeUnit: m.timeUnit,
  organizationId: m.organizationId,
  priceList: (m.priceList as MeterRow["priceList"]) ?? null,
  costCurrency: m.costCurrency,
});

/** Customers with usage of the meter on [start, end): rollups, and raw events not yet folded. */
async function customersWithUsage(
  tx: Tx,
  m: MeterRow,
  start: Date,
  end: Date,
  watermark: Date | null,
): Promise<string[]> {
  const raw =
    isRollable(m) && m.backfilledAt && watermark
      ? sql`and e.id >= ${uuidFloor(watermark.getTime())}::uuid`
      : sql``;
  const rows = rowsOf<{ c: string }>(
    await tx.execute(sql`
      select r.customer_id::text as c from usage_rollups r
      where r.business_id = ${m.businessId} and r.meter_id = ${m.id}
        and r.bucket_start >= ${start.toISOString()}::timestamptz
        and r.bucket_start < ${end.toISOString()}::timestamptz
      union
      select e.customer_id::text from usage_events e
      where e.business_id = ${m.businessId} and e.customer_id is not null and e.voided_at is null
        and e."timestamp" >= ${start.toISOString()}::timestamptz
        and e."timestamp" < ${end.toISOString()}::timestamptz
        and ${countsTowardMeter("e", m)} ${raw}
      union
      -- Refused for credit: never in a rollup, and still cost.
      select e.customer_id::text from usage_events e
      where e.business_id = ${m.businessId} and e.customer_id is not null and e.voided_at is null
        and e.refused_at is not null
        and e."timestamp" >= ${start.toISOString()}::timestamptz
        and e."timestamp" < ${end.toISOString()}::timestamptz
        and ${countsTowardMeter("e", m)}`),
  );
  return rows.map((r) => r.c);
}

type FoldRow = typeof usageCostDaily.$inferInsert;

/** One customer's fold rows for one meter over the run. */
async function foldCustomer(ctx: {
  tx: Tx;
  meter: MeterRow;
  customerId: string;
  days: readonly string[];
  zone: string | null;
  subs: readonly LiveSub[];
  fallbackCurrency: string;
  fx: () => Promise<RateTimeline>;
}): Promise<FoldRow[]> {
  const { tx, meter, days, zone } = ctx;
  const start = zonedDayStart(days[0]!, zone);
  const end = zonedDayEndExclusive(days.at(-1)!, zone);
  const usage = await readMeterUsage(tx, {
    customerId: ctx.customerId,
    meterId: meter.id,
    window: { start, end },
    granularity: "bucket",
  });
  // Events refused for credit are no usage, and their cost is still cost: read apart, costed
  // with the rest, left out of the quantity.
  const refused = new Set(
    (
      await readMeterUsage(tx, {
        customerId: ctx.customerId,
        meterId: meter.id,
        window: { start, end },
        granularity: "bucket",
        refusedOnly: true,
      })
    ).segments.flatMap((s) => s.rows),
  );
  const rows = [...usage.segments.flatMap((s) => s.rows), ...refused];
  if (rows.length === 0) return [];
  const modelKey = meter.priceList?.model_key ?? "model";
  const mi = meter.groupBy.indexOf(modelKey);
  const book = meter.priceList
    ? await loadModelPriceBook(
        tx,
        meter.organizationId,
        rows.map((r) => r.groupValues[mi] ?? "").filter(Boolean),
        { start, end },
      )
    : null;
  // day → group → bucket → rows
  const byDay = new Map<string, Map<string, Map<number, MeterUsageRow[]>>>();
  for (const r of rows) {
    const day = zonedDayString(r.bucketStart!, zone);
    const groups = byDay.get(day) ?? new Map<string, Map<number, MeterUsageRow[]>>();
    const gk = JSON.stringify(r.groupValues);
    const buckets = groups.get(gk) ?? new Map<number, MeterUsageRow[]>();
    const t = r.bucketStart!.getTime();
    buckets.set(t, [...(buckets.get(t) ?? []), r]);
    groups.set(gk, buckets);
    byDay.set(day, groups);
  }
  const out: FoldRow[] = [];
  for (const [day, groups] of byDay) {
    if (!days.includes(day)) continue;
    const startsAt = zonedDayStart(day, zone);
    const endsAt = zonedDayEndExclusive(day, zone);
    const sub = subscriptionForDay(ctx.subs, meter.id, startsAt, endsAt);
    const currency = sub?.currency ?? ctx.fallbackCurrency;
    for (const [gk, buckets] of groups) {
      const groupValues = JSON.parse(gk) as string[];
      const group: Record<string, string> = {};
      meter.groupBy.forEach((k, i) => (group[k] = groupValues[i] ?? ""));
      const cost = new UsageCost({
        meter,
        currency,
        key: listKeyOf(meter, group, currency),
        book,
        fxAt: endsAt,
        fx: ctx.fx,
      });
      let quantity = 0n;
      for (const [t, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
        await cost.add(list, new Date(t));
        quantity += list.reduce((a, r) => a + (refused.has(r) ? 0n : r.quantity), 0n);
      }
      const c = cost.result();
      out.push({
        organizationId: meter.organizationId,
        businessId: meter.businessId,
        day,
        startsAt,
        endsAt,
        customerId: ctx.customerId,
        meterId: meter.id,
        groupValues,
        model: mi >= 0 ? (groupValues[mi] ?? "") : "",
        subscriptionId: sub?.id ?? null,
        currency,
        quantity: formatFixed12(quantity),
        costMinor: c.minor,
        costBasis: c.basis,
      });
    }
  }
  return out;
}

/**
 * Restate the fold for these business-local days: each day's rows are replaced by what the
 * usage holds now. Returns the rows written.
 */
export async function foldUsageCostDays(input: {
  organizationId: string;
  businessId: string;
  days: readonly string[];
  /** The business's zone; null = UTC. */
  timezone: string | null;
}): Promise<{ rows: number }> {
  const { organizationId, businessId, timezone: zone } = input;
  let written = 0;
  for (const days of runsOf(input.days)) {
    const start = zonedDayStart(days[0]!, zone);
    const end = zonedDayEndExclusive(days.at(-1)!, zone);
    const setup = await withTenant(organizationId, async (tx) => {
      const [b] = await tx
        .select({ currency: businesses.defaultCurrency })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      const list = (await tx.select().from(meters).where(eq(meters.businessId, businessId)))
        .map(meterRowOf)
        .filter(meterHasCost);
      const [state] = rowsOf<{ watermark: Date }>(
        await tx.execute(
          sql`select watermark from usage_rollup_state where business_id = ${businessId}`,
        ),
      );
      const watermark = state ? new Date(state.watermark) : null;
      const candidates = new Map<string, string[]>();
      for (const m of list)
        candidates.set(m.id, await customersWithUsage(tx, m, start, end, watermark));
      const ids = [...new Set([...candidates.values()].flat())];
      const subs = ids.length
        ? rowsOf<{
            id: string;
            customer_id: string;
            currency: string;
            start: string;
            canceled_at: string | null;
            meter_ids: string[] | null;
          }>(
            await tx.execute(sql`
              select s.id::text, s.customer_id::text, upper(s.currency) as currency,
                coalesce(s.started_at, s.start_date, s.created_at) as start, s.canceled_at,
                array(select distinct p.meter_id::text from subscription_items si
                      join prices p on p.id = si.price_id
                      where si.subscription_id = s.id and p.meter_id is not null) as meter_ids
              from subscriptions s
              where s.business_id = ${businessId} and s.deleted_at is null
                and s.customer_id = any(${`{${ids.join(",")}}`}::uuid[])
                and coalesce(s.started_at, s.start_date, s.created_at) < ${end.toISOString()}::timestamptz
                and (s.canceled_at is null or s.canceled_at > ${start.toISOString()}::timestamptz)`),
          )
        : [];
      const prefs = ids.length
        ? await tx
            .select({ id: customers.id, currency: customers.currency })
            .from(customers)
            .where(and(eq(customers.businessId, businessId), inArray(customers.id, ids)))
        : [];
      return {
        list,
        candidates,
        fallback: b?.currency?.toUpperCase() ?? "USD",
        prefs: new Map(prefs.map((p) => [p.id, p.currency?.toUpperCase() ?? null])),
        subs: subs.map((s): LiveSub => ({
          id: s.id,
          customerId: s.customer_id,
          currency: s.currency,
          start: new Date(s.start),
          canceledAt: s.canceled_at ? new Date(s.canceled_at) : null,
          meterIds: s.meter_ids ?? [],
        })),
      };
    });

    let fx: Promise<RateTimeline> | null = null;
    const loadFx = () =>
      (fx ??= withTenant(organizationId, (tx) => loadRateTimeline(tx, businessId)));
    // Meters with no cost rule, and customers with no usage left, lose their rows.
    await withTenant(organizationId, (tx) =>
      tx.execute(sql`
        delete from usage_cost_daily d
        where d.business_id = ${businessId} and d.day >= ${days[0]!}::date
          and d.day <= ${days.at(-1)!}::date
          and not exists (
            select 1 from jsonb_each(${JSON.stringify(Object.fromEntries(setup.candidates))}::jsonb) k
            where k.key = d.meter_id::text and k.value ? d.customer_id::text)`),
    );
    for (const meter of setup.list) {
      for (const customerId of setup.candidates.get(meter.id) ?? []) {
        written += await withTenant(organizationId, async (tx) => {
          const rows = await foldCustomer({
            tx,
            meter,
            customerId,
            days,
            zone,
            subs: setup.subs.filter((s) => s.customerId === customerId),
            fallbackCurrency: setup.prefs.get(customerId) ?? setup.fallback,
            fx: loadFx,
          });
          await tx
            .delete(usageCostDaily)
            .where(
              and(
                eq(usageCostDaily.businessId, businessId),
                eq(usageCostDaily.meterId, meter.id),
                eq(usageCostDaily.customerId, customerId),
                sql`${usageCostDaily.day} >= ${days[0]!}::date and ${usageCostDaily.day} <= ${days.at(-1)!}::date`,
              ),
            );
          for (let i = 0; i < rows.length; i += 1000)
            await tx.insert(usageCostDaily).values(rows.slice(i, i + 1000));
          return rows.length;
        });
      }
    }
  }
  return { rows: written };
}
