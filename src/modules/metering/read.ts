import { eq, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { divHalfUp, FIXED12_SCALE, fixed12FromNumeric } from "@/platform/fixed";
import { meters } from "@db/schema";
import { toMeterShape } from "./meters";
import {
  BUCKET_MS,
  bucketOf,
  ceil15,
  countsTowardMeter,
  floor15,
  groupValuesOf,
  isRollable,
  iso,
  pgTextArray,
  rowsOf,
  uuidFloor,
  valueOf,
  type MeterShape,
} from "./usage-sql";

/** The grace of the fold (see fold.ts): a cutoff counts events received before T − this. */
export const CUTOFF_GRACE_MS = 5 * 60_000;

/**
 * What an invoice reads (design §3.6): rollups at or below `generation`, and raw events
 * received before `at − 5 min` and matched before `at`. `watermark` is the fold watermark
 * read AFTER the customer-meter row was locked, so the raw tail starts where the rollups
 * that generation holds end.
 */
export interface UsageCutoff {
  generation: bigint;
  at: Date;
  watermark: Date;
}

/**
 * Only the columns the meter's aggregation needs are read; the rest stay 0 / null. sum:
 * valueSum · count: eventCount · min/max: valueMin/valueMax · avg: valueSum + eventCount ·
 * last: lastValue + lastAt. amountSum, costSum and uncostedQuantity are always read.
 */
export interface MeterUsageRow {
  groupValues: string[];
  /** null = the events named no currency (bills in the price's). */
  currency: string | null;
  /** Set when `granularity: 'bucket'`. */
  bucketStart?: Date;
  eventCount: bigint;
  /** The meter's aggregate, Fixed12 (sum, count, min, max, avg, last or unique). */
  quantity: bigint;
  valueSum: bigint;
  valueMin: bigint | null;
  valueMax: bigint | null;
  lastValue: bigint | null;
  lastAt: Date | null;
  /** Major units, Fixed12. */
  amountSum: bigint;
  costSum: bigint;
  /** Quantity of events that carried no cost. */
  uncostedQuantity: bigint;
}

export interface MeterUsageSegment {
  start: Date;
  end: Date;
  rows: MeterUsageRow[];
}

export interface MeterUsage {
  meterId: string;
  aggregation: string;
  /** One per `[start, splitAt…, end)` piece, in order. */
  segments: MeterUsageSegment[];
  /** True when whole buckets came from rollups; false = everything read raw. */
  usedRollups: boolean;
}

export class LevelMeterReadError extends Error {
  constructor() {
    super("A recurring or weighted_sum meter is read with readMeterEvents and levels.ts.");
    this.name = "LevelMeterReadError";
  }
}

async function loadMeter(tx: Tx, meterId: string): Promise<MeterShape> {
  const [m] = await tx.select().from(meters).where(eq(meters.id, meterId)).limit(1);
  if (!m) throw new Error(`meter ${meterId} not found`);
  return toMeterShape(m);
}

const rangeSql = (col: SQL, ranges: Array<[number, number]>): SQL =>
  ranges.length
    ? sql`(${sql.join(
        ranges.map(
          ([a, b]) => sql`(${col} >= ${iso(a)}::timestamptz and ${col} < ${iso(b)}::timestamptz)`,
        ),
        sql` or `,
      )})`
    : sql`false`;

const segmentSql = (col: SQL, inner: number[]): SQL =>
  inner.length
    ? sql`(case ${sql.join(
        inner.map((p, i) => sql`when ${col} < ${iso(p)}::timestamptz then ${i}`),
        sql` `,
      )} else ${inner.length} end)`
    : sql`0`;

/** Which aggregate columns a read computes. */
interface Need {
  n: boolean;
  vsum: boolean;
  vmin: boolean;
  vmax: boolean;
  last: boolean;
}

const needOf = (aggregation: string): Need => ({
  n: aggregation === "count" || aggregation === "avg",
  vsum: aggregation === "sum" || aggregation === "avg",
  vmin: aggregation === "min",
  vmax: aggregation === "max",
  last: aggregation === "last",
});

const NULL_TEXT = sql`null::text`;
const pick = (on: boolean, col: SQL): SQL => (on ? col : NULL_TEXT);

interface Part {
  seg: number;
  gv: string[];
  cur: string;
  bucket: Date | null;
  n: string | null;
  vsum: string | null;
  vmin: string | null;
  vmax: string | null;
  lastv: string | null;
  last_at: Date | null;
  last_id: string | null;
  asum: string | null;
  csum: string | null;
  uncosted: string | null;
  uniq: string | null;
}

/**
 * Rolled-up aggregates by query, per process, LRU, bounded. Exact: the key holds every input of
 * the rollup query, and `rollup_version` (0468) takes a new sequence value in the transaction of
 * every rollup write, so a fold, backfill, late match, void rebuild or meter restart moves the
 * key at once. A rolled-back write never reuses its number. Each API process caches on its own.
 */
const ROLLUP_CACHE_MAX = 10_000;
const rollupCache = new Map<string, Part[]>();

/** For tests: forget every cached rollup aggregate. */
export function clearRollupReadCache(): void {
  rollupCache.clear();
}

/**
 * A customer's usage of one meter over `[window.start, window.end)`, exact to the
 * microsecond (design §3.5): whole 15-minute buckets inside the window from rollups plus a
 * raw scan of events received since the watermark; the edge buckets, every `splitAt`
 * bucket and any window under 30 minutes read raw. The tail and the rolled part never
 * overlap, so nothing is counted twice. One result row per group values and currency.
 */
export async function readMeterUsage(
  tx: Tx,
  input: {
    customerId: string;
    meterId: string;
    window: { start: Date; end: Date };
    splitAt?: Date[];
    granularity?: "total" | "bucket";
    cutoff?: UsageCutoff;
    /** Only events whose property `key` equals `value` (a property spend limit). Reads raw. */
    where?: { key: string; value: string };
  },
): Promise<MeterUsage> {
  const m = await loadMeter(tx, input.meterId);
  if (m.recurring || m.aggregation === "weighted_sum") throw new LevelMeterReadError();
  const need = needOf(m.aggregation);
  const startMs = input.window.start.getTime();
  const endMs = input.window.end.getTime();
  const inner = [
    ...new Set(
      (input.splitAt ?? []).map((d) => d.getTime()).filter((t) => t > startMs && t < endMs),
    ),
  ].sort((a, b) => a - b);
  const points = [startMs, ...inner, endMs];
  const empty: MeterUsage = {
    meterId: m.id,
    aggregation: m.aggregation,
    segments: points.slice(0, -1).map((p, i) => ({
      start: new Date(p),
      end: new Date(points[i + 1]!),
      rows: [],
    })),
    usedRollups: false,
  };
  if (endMs <= startMs) return { ...empty, segments: [] };

  let watermarkMs: number | null = null;
  let version: string | null = null;
  if (isRollable(m) && m.backfilledAt) {
    const [s] = rowsOf<{ watermark: Date; v: string }>(
      await tx.execute(
        sql`select watermark, rollup_version::text as v from usage_rollup_state
          where business_id = ${m.businessId}`,
      ),
    );
    version = s?.v ?? null;
    if (input.cutoff) watermarkMs = input.cutoff.watermark.getTime();
    else if (s) watermarkMs = new Date(s.watermark).getTime();
  }
  const inside: Array<[number, number]> = [];
  // Rollups do not group by a limit property, so a filtered read is raw.
  if (watermarkMs !== null && !input.where && endMs - startMs >= 2 * BUCKET_MS) {
    for (let i = 0; i < points.length - 1; i++) {
      const a = ceil15(points[i]!);
      const b = floor15(points[i + 1]!);
      if (a < b) inside.push([a, b]);
    }
  }
  const raw: Array<[number, number]> = [];
  let cursor = startMs;
  for (const [a, b] of inside) {
    if (a > cursor) raw.push([cursor, a]);
    cursor = b;
  }
  if (cursor < endMs) raw.push([cursor, endMs]);

  const byBucket = input.granularity === "bucket";
  const parts: Part[] = [];

  if (inside.length) {
    const gen = input.cutoff
      ? sql`and r.generation <= ${input.cutoff.generation.toString()}::bigint`
      : sql``;
    const seg = segmentSql(sql`r.bucket_start`, inner);
    // The rolled part is the expensive one and changes only with the rollups, so it is cached
    // (see `rollupCache`). The version is read in the same statement as the rollups, so an
    // entry always holds what its version saw. Per-bucket reads are not cached.
    const keyOf = (v: string) =>
      JSON.stringify([
        m.businessId,
        input.customerId,
        m.id,
        m.aggregation,
        inner,
        inside,
        input.cutoff?.generation.toString() ?? null,
        v,
      ]);
    const cacheable = version !== null && !byBucket;
    const hit = cacheable ? rollupCache.get(keyOf(version!)) : undefined;
    if (hit) {
      const k = keyOf(version!);
      rollupCache.delete(k);
      rollupCache.set(k, hit);
      parts.push(...hit);
    } else {
      const aggSql = sql`
          select ${seg} as seg, r.group_values as gv, r.currency as cur,
            ${byBucket ? sql`r.bucket_start` : sql`null::timestamptz`} as bucket,
            ${pick(need.n, sql`sum(r.event_count)::text`)} as n,
            ${pick(need.vsum, sql`sum(r.value_sum)::text`)} as vsum,
            ${pick(need.vmin, sql`min(r.value_min)::text`)} as vmin,
            ${pick(need.vmax, sql`max(r.value_max)::text`)} as vmax,
            ${
              need.last
                ? sql`((array_agg(r.last_value order by r.last_at desc nulls last, r.last_event_id desc))[1])::text as lastv,
            max(r.last_at) as last_at,
            (array_agg(r.last_event_id order by r.last_at desc nulls last, r.last_event_id desc))[1]::text as last_id`
                : sql`null::text as lastv, null::timestamptz as last_at, null::text as last_id`
            },
            sum(r.amount_sum)::text as asum, sum(r.cost_sum)::text as csum,
            sum(r.uncosted_quantity)::text as uncosted, null::text as uniq
          from usage_rollups r
          where r.business_id = ${m.businessId} and r.customer_id = ${input.customerId}
            and r.meter_id = ${m.id} and ${rangeSql(sql`r.bucket_start`, inside)} ${gen}
          group by 1, 2, 3, 4`;
      const rows = rowsOf<Part & { ver: string | null }>(
        await tx.execute(
          cacheable
            ? sql`select v.ver, a.* from
                (select rollup_version::text as ver from usage_rollup_state
                 where business_id = ${m.businessId}) v
                left join lateral (${aggSql}) a on true`
            : sql`select null::text as ver, a.* from (${aggSql}) a`,
        ),
      );
      const rolled = rows.filter((r) => r.seg != null);
      const ver = rows[0]?.ver ?? null;
      if (cacheable && ver !== null) {
        if (rollupCache.size >= ROLLUP_CACHE_MAX)
          rollupCache.delete(rollupCache.keys().next().value!);
        rollupCache.set(keyOf(ver), rolled);
      }
      parts.push(...rolled);
    }
  }

  // Raw: the edges, plus the tail of the inside buckets (received at or after the watermark).
  const tail =
    inside.length && watermarkMs !== null
      ? sql` or (${rangeSql(sql`e."timestamp"`, inside)} and e.id >= ${uuidFloor(watermarkMs)}::uuid)`
      : sql``;
  const cut = input.cutoff
    ? sql`and e.id < ${uuidFloor(input.cutoff.at.getTime() - CUTOFF_GRACE_MS)}::uuid
          and (e.matched_at is null or e.matched_at < ${iso(input.cutoff.at)}::timestamptz)`
    : sql``;
  const val = valueOf("e", sql`${m.valueProperty ?? ""}::text`);
  const gv = groupValuesOf("e", sql`${pgTextArray(m.groupBy)}`);
  const seg = segmentSql(sql`e."timestamp"`, inner);
  parts.push(
    ...rowsOf<Part>(
      await tx.execute(sql`
        select ${seg} as seg, ${gv} as gv, coalesce(e.currency, '') as cur,
          ${byBucket ? bucketOf(sql`e."timestamp"`) : sql`null::timestamptz`} as bucket,
          ${pick(need.n, sql`count(*)::text`)} as n,
          ${pick(need.vsum, sql`sum(${val})::text`)} as vsum,
          ${pick(need.vmin, sql`min(${val})::text`)} as vmin,
          ${pick(need.vmax, sql`max(${val})::text`)} as vmax,
          ${
            need.last
              ? sql`((array_agg(${val} order by e."timestamp" desc, e.id desc))[1])::text as lastv,
          max(e."timestamp") as last_at,
          (array_agg(e.id order by e."timestamp" desc, e.id desc))[1]::text as last_id`
              : sql`null::text as lastv, null::timestamptz as last_at, null::text as last_id`
          },
          sum(e.amount)::text as asum, sum(e.cost)::text as csum,
          (sum(coalesce(${val}, 1)) filter (where e.cost is null))::text as uncosted,
          ${
            m.aggregation === "unique"
              ? sql`count(distinct e.properties ->> ${m.uniqueProperty ?? ""}::text)::text`
              : sql`null::text`
          } as uniq
        from usage_events e
        where e.business_id = ${m.businessId} and e.customer_id = ${input.customerId}
          and e.event_name = ${m.eventName}
          and e."timestamp" >= ${iso(startMs)}::timestamptz and e."timestamp" < ${iso(endMs)}::timestamptz
          and e.voided_at is null
          and (${rangeSql(sql`e."timestamp"`, raw)}${tail})
          and ${countsTowardMeter("e", m)}
          ${input.where ? sql`and e.properties ->> ${input.where.key}::text = ${input.where.value}::text` : sql``}
          ${cut}
        group by 1, 2, 3, 4`),
    ),
  );

  const merged = new Map<
    string,
    { seg: number; row: MeterUsageRow; lastId: string | null; uniq: bigint }
  >();
  for (const p of parts) {
    const k = JSON.stringify([p.seg, p.gv, p.cur, p.bucket ? new Date(p.bucket).getTime() : null]);
    const num = (s: string | null) => (s == null ? null : fixed12FromNumeric(s));
    const cur = merged.get(k);
    const lastAt = p.last_at ? new Date(p.last_at) : null;
    if (!cur) {
      merged.set(k, {
        seg: p.seg,
        lastId: p.last_id,
        uniq: BigInt(p.uniq ?? "0"),
        row: {
          groupValues: p.gv,
          currency: p.cur === "" ? null : p.cur,
          ...(byBucket && p.bucket ? { bucketStart: new Date(p.bucket) } : {}),
          eventCount: BigInt(p.n ?? "0"),
          quantity: 0n,
          valueSum: num(p.vsum) ?? 0n,
          valueMin: num(p.vmin),
          valueMax: num(p.vmax),
          lastValue: num(p.lastv),
          lastAt,
          amountSum: num(p.asum) ?? 0n,
          costSum: num(p.csum) ?? 0n,
          uncostedQuantity: num(p.uncosted) ?? 0n,
        },
      });
      continue;
    }
    const r = cur.row;
    r.eventCount += BigInt(p.n ?? "0");
    r.valueSum += num(p.vsum) ?? 0n;
    const vmin = num(p.vmin);
    const vmax = num(p.vmax);
    if (vmin !== null) r.valueMin = r.valueMin === null || vmin < r.valueMin ? vmin : r.valueMin;
    if (vmax !== null) r.valueMax = r.valueMax === null || vmax > r.valueMax ? vmax : r.valueMax;
    if (
      lastAt &&
      (!r.lastAt ||
        lastAt.getTime() > r.lastAt.getTime() ||
        (lastAt.getTime() === r.lastAt.getTime() && (p.last_id ?? "") > (cur.lastId ?? "")))
    ) {
      r.lastAt = lastAt;
      r.lastValue = num(p.lastv);
      cur.lastId = p.last_id;
    }
    r.amountSum += num(p.asum) ?? 0n;
    r.costSum += num(p.csum) ?? 0n;
    r.uncostedQuantity += num(p.uncosted) ?? 0n;
    cur.uniq += BigInt(p.uniq ?? "0");
  }

  const segments = empty.segments.map((s) => ({ ...s, rows: [] as MeterUsageRow[] }));
  for (const { seg, row, uniq } of merged.values()) {
    row.quantity = quantityOf(m.aggregation, row, uniq);
    segments[seg]!.rows.push(row);
  }
  for (const s of segments)
    s.rows.sort((a, b) =>
      JSON.stringify([a.groupValues, a.currency, a.bucketStart?.getTime()]) <
      JSON.stringify([b.groupValues, b.currency, b.bucketStart?.getTime()])
        ? -1
        : 1,
    );
  return { meterId: m.id, aggregation: m.aggregation, segments, usedRollups: inside.length > 0 };
}

function quantityOf(aggregation: string, r: MeterUsageRow, uniq: bigint): bigint {
  switch (aggregation) {
    case "count":
      return r.eventCount * FIXED12_SCALE;
    case "min":
      return r.valueMin ?? 0n;
    case "max":
      return r.valueMax ?? 0n;
    case "last":
      return r.lastValue ?? 0n;
    case "avg":
      return r.eventCount > 0n ? divHalfUp(r.valueSum, r.eventCount) : 0n;
    case "unique":
      return uniq * FIXED12_SCALE;
    default:
      return r.valueSum;
  }
}

export interface MeterEvent {
  id: string;
  at: Date;
  groupValues: string[];
  currency: string | null;
  /** Fixed12; null for count and unique meters. */
  value: bigint | null;
  /** `unique` meters: the unique property's value. */
  uniqueValue: string | null;
}

/**
 * Raw events of one meter for one customer in `[from, to)`, in apply order (timestamp, then
 * id). For recurring and weighted_sum meters, whose level math (`levels.ts`) needs order.
 */
export async function readMeterEvents(
  tx: Tx,
  input: { customerId: string; meterId: string; from?: Date; to: Date; cutoff?: UsageCutoff },
): Promise<MeterEvent[]> {
  const m = await loadMeter(tx, input.meterId);
  const val = valueOf("e", sql`${m.valueProperty ?? ""}::text`);
  const cut = input.cutoff
    ? sql`and e.id < ${uuidFloor(input.cutoff.at.getTime() - CUTOFF_GRACE_MS)}::uuid
          and (e.matched_at is null or e.matched_at < ${iso(input.cutoff.at)}::timestamptz)`
    : sql``;
  const rows = rowsOf<{
    id: string;
    ts: Date;
    gv: string[];
    cur: string | null;
    val: string | null;
    uniq: string | null;
  }>(
    await tx.execute(sql`
      select e.id, e."timestamp" as ts, ${groupValuesOf("e", sql`${pgTextArray(m.groupBy)}`)} as gv,
        e.currency as cur, (${val})::text as val,
        e.properties ->> ${m.uniqueProperty ?? ""}::text as uniq
      from usage_events e
      where e.business_id = ${m.businessId} and e.customer_id = ${input.customerId}
        and e.event_name = ${m.eventName} and e.voided_at is null
        ${input.from ? sql`and e."timestamp" >= ${iso(input.from)}::timestamptz` : sql``}
        and e."timestamp" < ${iso(input.to)}::timestamptz
        and ${countsTowardMeter("e", m)}
        ${cut}
      order by e."timestamp", e.id`),
  );
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.ts),
    groupValues: r.gv,
    currency: r.cur,
    value: r.val == null ? null : fixed12FromNumeric(r.val),
    uniqueValue: m.aggregation === "unique" ? r.uniq : null,
  }));
}

/**
 * Take a cutoff for one customer-meter (design §3.6): lock the billing row, read its
 * generation F and move it to F + 1, then read the fold watermark. Run it in its own short
 * transaction before rating. A customer-meter with no billing row cuts at generation 0.
 */
export async function takeUsageCutoff(
  tx: Tx,
  input: { businessId: string; customerId: string; meterId: string },
): Promise<UsageCutoff> {
  const [row] = rowsOf<{ generation: string }>(
    await tx.execute(sql`
      update customer_meter_billing set generation = generation + 1
      where customer_id = ${input.customerId} and meter_id = ${input.meterId}
        and business_id = ${input.businessId}
      returning generation - 1 as generation`),
  );
  const [s] = rowsOf<{ watermark: Date | null; at: Date }>(
    await tx.execute(sql`select (select watermark from usage_rollup_state where business_id = ${input.businessId}) as watermark,
      clock_timestamp() as at`),
  );
  return {
    generation: BigInt(row?.generation ?? "0"),
    at: new Date(s!.at),
    watermark: s?.watermark ? new Date(s.watermark) : new Date(0),
  };
}
