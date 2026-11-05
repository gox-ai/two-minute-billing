import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  billsFromList,
  rateMeterCombination,
  resolveMeterRate,
  TIME_UNIT_MS,
  type MeterRateSpec,
  type MeterRatedTier,
  type PriceSnapshot,
} from "@/modules/catalog/pricing";
import { currencyExponent } from "@/platform/currency";
import {
  FIXED12_SCALE,
  divHalfUp,
  fixed12FromInt,
  fixed12FromNumeric,
  formatFixed12,
  mulDivHalfUp,
  tryParseFixed12,
} from "@/platform/fixed";
import type { UsageWindow } from "@/modules/subscriptions/usage-window";
import { recurringLevel, timeWeightedLevel, type Level, type LevelEvent } from "./levels";
import { readMeterUsage, takeUsageCutoff, type MeterUsageRow, type UsageCutoff } from "./read";
import { lineCost, priceListResolver, sellingRule } from "./price-list-rating";
import {
  countsTowardMeter,
  groupValuesOf,
  isRollable,
  rowsOf,
  uuidFloor,
  valueOf,
  type MeterShape,
} from "./usage-sql";

/**
 * Rating a meter price over a window: one line per value combination (and rate segment), plus
 * late lines for usage of earlier windows that arrived after their invoice. Exact: quantities
 * are Fixed12, money is rounded half-up once per line.
 */

/** Events received in the last 5 minutes may still be folding; a cutoff excludes them. */
export const FOLD_GRACE_MS = 5 * 60_000;

/** The billing pointer of one customer and meter (`customer_meter_billing`). */
export interface MeterPointer {
  usageThrough: Date | null;
  cutoffGeneration: bigint | null;
  /** Real clock, like event ids. */
  cutoffAt: Date | null;
}

/** A cutoff: rollups at generation ≤ `generation` and events received before `at` − 5 min. */
export interface MeterCutoff extends UsageCutoff {
  generation: bigint;
  /** Real clock (`clock_timestamp()`), compared with uuid_v7 event ids. */
  at: Date;
  /** The pointer before this cutoff: where late usage is measured from. */
  previous: MeterPointer;
  /** False for a preview: nothing was written and nothing may be. */
  taken: boolean;
}

/**
 * Take a cutoff for one customer and meter in its own short transaction (commit it before
 * rating): read generation F, move it to F + 1, stamp the real clock. Rollups folded from now
 * on carry F + 1 and bill later. Creates the row when missing.
 */
export async function takeMeterCutoff(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    meterId: string;
    subscriptionId: string;
  },
): Promise<MeterCutoff> {
  // The row must exist for the generation to move; the pointer is read before the move.
  await tx.execute(sql`
    insert into customer_meter_billing
      (customer_id, meter_id, organization_id, business_id, subscription_id)
    values (${input.customerId}, ${input.meterId}, ${input.organizationId}, ${input.businessId},
            ${input.subscriptionId})
    on conflict (customer_id, meter_id) do nothing`);
  const [row] = rowsOf<{
    usage_through: string | null;
    cutoff_generation: string | null;
    cutoff_at: string | null;
  }>(
    await tx.execute(sql`
      select usage_through, cutoff_generation, cutoff_at from customer_meter_billing
      where customer_id = ${input.customerId} and meter_id = ${input.meterId} for update`),
  );
  // Locks the row, moves F → F + 1, reads the watermark after the lock.
  const cut = await takeUsageCutoff(tx, input);
  return { ...cut, previous: pointerOf(row!), taken: true };
}

async function foldWatermark(tx: Tx, businessId: string): Promise<Date> {
  const [s] = rowsOf<{ watermark: string | null }>(
    await tx.execute(
      sql`select watermark from usage_rollup_state where business_id = ${businessId}`,
    ),
  );
  return s?.watermark ? new Date(s.watermark) : new Date(0);
}

/** A preview's cutoff: the current generation, unchanged, and the real clock now. */
export async function peekMeterCutoff(
  tx: Tx,
  input: { businessId: string; customerId: string; meterId: string },
): Promise<MeterCutoff> {
  const [row] = rowsOf<{
    g: string | null;
    at: string;
    usage_through: string | null;
    cutoff_generation: string | null;
    cutoff_at: string | null;
  }>(
    await tx.execute(sql`
      select c.generation as g, clock_timestamp() as at, c.usage_through, c.cutoff_generation,
        c.cutoff_at
      from (select 1) one left join customer_meter_billing c
        on c.customer_id = ${input.customerId} and c.meter_id = ${input.meterId}`),
  );
  return {
    generation: BigInt(row?.g ?? 0),
    at: new Date(row!.at),
    watermark: await foldWatermark(tx, input.businessId),
    previous: pointerOf(row ?? { usage_through: null, cutoff_generation: null, cutoff_at: null }),
    taken: false,
  };
}

function pointerOf(r: {
  usage_through: string | null;
  cutoff_generation: string | null;
  cutoff_at: string | null;
}): MeterPointer {
  return {
    usageThrough: r.usage_through ? new Date(r.usage_through) : null,
    cutoffGeneration: r.cutoff_generation != null ? BigInt(r.cutoff_generation) : null,
    cutoffAt: r.cutoff_at ? new Date(r.cutoff_at) : null,
  };
}

/** One value combination's usage over a window. Fixed12 throughout. */
export interface MeterCombo {
  /** In the meter's `group_by` order; a missing property is ''. */
  group: string[];
  quantity: bigint;
  /** Σ event amount / cost in major units, events in the price's currency (or none) only. */
  amountSum: bigint;
  costSum: bigint;
  /** Quantity of events with no cost, or a cost in another currency (sum and count meters). */
  uncostedQuantity?: bigint;
  level: Level | null;
  /** Recurring `unique`: the keys active at the window end. */
  activeKeys?: string[];
}

/** A rate for one combination over a sub-window: the model price list splits through it. */
export interface RateSegment {
  start: Date;
  end: Date;
  rate: MeterRateSpec;
  /** The segment's own divisor (a list row's); default the price's. */
  quantityDivisor?: bigint;
  /** Fixed12 percent over `rate`, applied once with the line. */
  markupPercent?: bigint | null;
  /** What the segment priced from: the line's `rating.segments[]` entry. */
  cite?: SegmentCite;
}

/** One `rating.segments[]` entry: the selling rate and the rows it came from. */
export interface SegmentCite {
  from: string;
  to: string;
  /** Selling rate, minor units per `quantity_divisor` units. */
  unit_amount_decimal: string;
  quantity_divisor: string;
  markup_percent: string | null;
  markup_base: "list" | "cost" | null;
  /** The markup base's rate; null for a fixed or default rate. */
  base_unit_amount_decimal: string | null;
  rate_from: "subscription_override" | "price_rate" | "price";
  price_source: "model_price_list" | "your_cost" | "fixed_rate" | "default_rate" | "reported_cost";
  model_price_id: string | null;
  model_cost_override_id: string | null;
  source: string | null;
  source_version: string | null;
  source_effective_from: string | null;
}

/** Plugs a price list into the one rating path. Default: the snapshot's rate card. */
export type ResolveRate = (
  combo: { group: Record<string, string> },
  window: UsageWindow,
) => RateSegment[] | Promise<RateSegment[]>;

/** Cost of a usage line in its currency: `minor` null when it is unknown (see `basis`). */
export interface LineCost {
  minor: bigint | null;
  basis: "event" | "price_list" | "mixed" | "partial" | "none" | "no_rate";
}

/** One rated line: a combination and rate segment of a window, or late usage of an old one. */
export interface MeterLineRating {
  late: boolean;
  /** The line's own span: a rate segment of `period`, or all of it. */
  window: UsageWindow;
  /** The window rated as one: late usage is matched against what each period billed. */
  period: UsageWindow;
  group: string[];
  rateMatch: Record<string, string> | "default";
  rate: MeterRateSpec;
  quantity: bigint;
  billableQuantity: bigint;
  /** Fixed12 minor units per unit. */
  unitAmount: bigint;
  amountMinor: bigint;
  amountSum: bigint;
  costSum: bigint;
  tiers?: MeterRatedTier[];
  level: Level | null;
  /** A late line: the pricing of its window (from the earlier line), for its rating. */
  pricing?: MeterPricingRecord;
  /** The segment this line rated with, when the resolver cited one. */
  segment?: RateSegment;
  /** A late line that re-rated over several segments: each of them. */
  segments?: RateSegment[];
  /** Set on lines of this window (not late lines). Null = cost not measured. */
  cost?: LineCost | null;
  /**
   * `event_cost_or_list`: the events' own cost (+ markup), or the events without one, billed
   * from the list. Absent on other prices and on late lines (both parts in one).
   */
  part?: "reported_cost" | "list";
}

/** A recurring level to record at a cutoff (`usage_meter_levels`). */
export interface LevelSnapshot {
  customerId: string;
  meterId: string;
  group: string[];
  at: Date;
  level: bigint;
  activeKeys: string[] | null;
}

export interface MeterItemRating {
  meter: MeterRow;
  lines: MeterLineRating[];
  /** The pricing this rating used, recorded on the window's first line. */
  pricing: MeterPricingRecord;
  /** Written by the invoice transaction: `usage_through`, `cutoff_generation`, `cutoff_at`. */
  pointer: { customerId: string; meterId: string; usageThrough: Date; cutoff: MeterCutoff };
  levels: LevelSnapshot[];
}

export type MeterRow = MeterShape & {
  key: string;
  timeUnit: string | null;
  organizationId: string;
  /** 0457: the model price list key of each combination. */
  priceList: {
    provider?: string;
    provider_key?: string;
    model_key?: string;
    token_type?: string;
    token_type_key?: string;
  } | null;
  costCurrency: string | null;
};

/**
 * Rate one meter item over `window`. Lines with a zero quantity are left out. `cutoff` from
 * `takeMeterCutoff` (or `peekMeterCutoff` for a preview). `usageThrough` defaults to the
 * window end; a threshold invoice passes a cutoff inside the period and keeps it.
 */
export async function rateMeterItem(
  tx: Tx,
  input: {
    item: { id: string; freeQuantity: number | null; priceSnapshot: PriceSnapshot };
    subscription: { customerId: string; currency: string };
    window: UsageWindow;
    cutoff: MeterCutoff;
    resolveRate?: ResolveRate;
    /** Default `window.end`. Pass the previous value to rate without moving the pointer. */
    usageThrough?: Date;
    /** Only events whose property `key` equals `value` (a property spend limit). */
    where?: { key: string; value: string };
    /** Amounts only: no line cost and no late lines (usage-controls spend measure). */
    measureOnly?: boolean;
  },
): Promise<MeterItemRating> {
  const snap = input.item.priceSnapshot;
  if (!snap.meter) throw new Error(`Price ${snap.publicId} does not bill from a meter.`);
  const meter = await loadMeter(tx, snap.meter.id);
  const customerId = input.subscription.customerId;
  const currency = snap.currency || input.subscription.currency;
  const resolveRate = input.resolveRate ?? defaultResolver(tx, meter, snap, currency);
  const ctx: RateCtx = {
    tx,
    meter,
    snap,
    customerId,
    currency,
    freeQuantity: Math.max(0, input.item.freeQuantity ?? snap.freeQuantity ?? 0),
    resolveRate,
    ...(input.resolveRate ? { customResolver: input.resolveRate } : {}),
    ...(input.where ? { where: input.where } : {}),
  };
  // Usage already billed through the pointer (a removal's settlement) is not billed again.
  const through = input.cutoff.previous.usageThrough;
  const window =
    through && through.getTime() > input.window.start.getTime()
      ? {
          start: new Date(Math.min(through.getTime(), input.window.end.getTime())),
          end: input.window.end,
        }
      : input.window;

  const current = await readCombos(ctx, window, input.cutoff);
  const lines = await rateCombos(ctx, window, current.combos, false, input.cutoff);
  // No usage still records the window and its pricing, so late usage of it can bill.
  if (lines.length === 0 && window.end.getTime() > window.start.getTime())
    lines.push({
      late: false,
      window,
      period: window,
      group: [],
      rateMatch: "default",
      rate: resolveMeterRate(snap, {}),
      quantity: 0n,
      billableQuantity: 0n,
      unitAmount: 0n,
      amountMinor: 0n,
      amountSum: 0n,
      costSum: 0n,
      level: null,
    });
  if (!input.measureOnly)
    for (const line of lines)
      line.cost =
        line.quantity > 0n
          ? await lineCost({
              tx,
              meter,
              customerId,
              currency,
              cutoff: input.cutoff,
              line,
              ...(line.part ? { part: line.part } : {}),
            })
          : null;
  const late =
    meter.recurring || input.measureOnly ? [] : await lateLines(ctx, window, input.cutoff);
  const levels: LevelSnapshot[] = meter.recurring
    ? current.combos.map((c) => ({
        customerId,
        meterId: meter.id,
        group: c.group,
        at: window.end,
        level: c.level?.closing ?? 0n,
        activeKeys: c.activeKeys ?? null,
      }))
    : [];
  return {
    meter,
    lines: [...lines, ...late],
    pricing: pricingRecord(snap, ctx.freeQuantity),
    pointer: {
      customerId,
      meterId: meter.id,
      usageThrough: input.usageThrough ?? window.end,
      cutoff: input.cutoff,
    },
    levels,
  };
}

interface RateCtx {
  tx: Tx;
  meter: MeterRow;
  snap: PriceSnapshot;
  customerId: string;
  currency: string;
  freeQuantity: number;
  resolveRate: ResolveRate;
  /** The caller's resolver (1b's price list), kept when a late window re-rates. */
  customResolver?: ResolveRate;
  /** A property filter (usage-controls spend measure). */
  where?: { key: string; value: string };
}

function defaultResolver(
  tx: Tx,
  meter: MeterRow,
  snap: PriceSnapshot,
  currency: string,
): ResolveRate {
  return (
    priceListResolver({ tx, meter, snap, currency }) ??
    ((combo, w) => [{ start: w.start, end: w.end, rate: resolveMeterRate(snap, combo.group) }])
  );
}

async function loadMeter(tx: Tx, meterId: string): Promise<MeterRow> {
  const [m] = rowsOf<{
    id: string;
    organization_id: string;
    business_id: string;
    key: string;
    event_name: string;
    aggregation: string;
    value_property: string | null;
    unique_property: string | null;
    recurring: boolean;
    time_unit: string | null;
    filters: Record<string, Array<string | number | boolean>>;
    group_by: string[];
    folded_from: string | null;
    backfilled_at: string | null;
    price_list: MeterRow["priceList"];
    cost_currency: string | null;
  }>(await tx.execute(sql`select * from meters where id = ${meterId}`));
  if (!m) throw new Error(`Meter ${meterId} not found.`);
  return {
    id: m.id,
    organizationId: m.organization_id,
    businessId: m.business_id,
    key: m.key,
    eventName: m.event_name,
    aggregation: m.aggregation,
    valueProperty: m.value_property,
    uniqueProperty: m.unique_property,
    recurring: m.recurring,
    timeUnit: m.time_unit,
    filters: m.filters ?? {},
    groupBy: m.group_by ?? [],
    foldedFrom: m.folded_from ? new Date(m.folded_from) : null,
    backfilledAt: m.backfilled_at ? new Date(m.backfilled_at) : null,
    priceList: m.price_list ?? null,
    costCurrency: m.cost_currency ?? null,
  };
}

async function rateCombos(
  ctx: RateCtx,
  window: UsageWindow,
  combos: MeterCombo[],
  late: boolean,
  cutoff: MeterCutoff,
): Promise<MeterLineRating[]> {
  const out: MeterLineRating[] = [];
  const planned: Array<{ combo: MeterCombo; segments: RateSegment[] }> = [];
  for (const combo of combos) {
    const group = groupRecord(ctx.meter.groupBy, combo.group);
    planned.push({ combo, segments: await ctx.resolveRate({ group }, window) });
  }
  const isWhole = (seg: RateSegment) =>
    seg.start.getTime() <= window.start.getTime() && seg.end.getTime() >= window.end.getTime();
  // Additive meters read every split once (`splitAt`) and sum the pieces of each segment.
  const additive =
    !ctx.meter.recurring && (ctx.meter.aggregation === "sum" || ctx.meter.aggregation === "count");
  let pieces: Awaited<ReturnType<typeof readMeterUsage>>["segments"] | null = null;
  const splitRead = async () => {
    if (pieces) return pieces;
    const splitAt = planned.flatMap((p) =>
      p.segments.flatMap((s) => [s.start, s.end]).filter((d) => !isNaN(d.getTime())),
    );
    pieces = (
      await readMeterUsage(ctx.tx, {
        customerId: ctx.customerId,
        meterId: ctx.meter.id,
        window,
        splitAt,
        cutoff: { generation: cutoff.generation, at: cutoff.at, watermark: cutoff.watermark },
        ...(ctx.where ? { where: ctx.where } : {}),
      })
    ).segments;
    return pieces;
  };
  const segmentCombo = async (seg: RateSegment, group: string[]) => {
    if (!additive)
      return (await readCombos(ctx, { start: seg.start, end: seg.end }, cutoff)).combos.find((x) =>
        sameGroup(x.group, group),
      );
    const rows = (await splitRead())
      .filter(
        (p) => p.start.getTime() >= seg.start.getTime() && p.end.getTime() <= seg.end.getTime(),
      )
      .flatMap((p) => p.rows.filter((r) => sameGroup(r.groupValues, group)));
    return mergeCurrencies(ctx.meter.aggregation, rows, ctx.currency)[0];
  };
  const listed = billsFromList(ctx.snap.amountSource);
  const costFirst = ctx.snap.amountSource === "event_cost_or_list";
  const byRate = listed || (ctx.snap.amountSource ?? "rate") === "rate";
  for (const { combo, segments } of planned) {
    // Real cost first: a fixed selling rate wins, so such a combination bills as the list does.
    const split = costFirst && !segments.every((s) => s.cite?.price_source === "fixed_rate");
    // Billed from the list: every unit, or (split) only the units of events without a cost.
    const listQuantity = (c: MeterCombo) => (split ? (c.uncostedQuantity ?? 0n) : c.quantity);
    if (split) {
      const reported = reportedCostLine(ctx, window, combo, late);
      if (reported) out.push(reported);
    }
    // A segment narrower than the window measures its own part (a mid-window price change).
    const parts: Array<{ seg: RateSegment; whole: boolean; c: MeterCombo }> = [];
    for (const seg of [...segments].sort((a, b) => a.start.getTime() - b.start.getTime())) {
      const whole = isWhole(seg);
      const c = whole ? combo : await segmentCombo(seg, combo.group);
      if (!c) continue;
      if (
        split ? listQuantity(c) === 0n : c.quantity === 0n && c.amountSum === 0n && c.costSum === 0n
      )
        continue;
      parts.push({ seg, whole, c });
    }
    // Free units, tiers, volume and packages belong to the period: the free units come off
    // the earliest segments, and each segment rates its place in the period's running total.
    let freeLeft = fixed12FromInt(ctx.freeQuantity);
    const billable = parts.map(({ c }) => {
      const q = listQuantity(c) > 0n ? listQuantity(c) : 0n;
      const f = q < freeLeft ? q : freeLeft;
      freeLeft -= f;
      return q - f;
    });
    const total = billable.reduce((a, q) => a + q, 0n);
    let before = 0n;
    for (const [i, { seg, whole, c }] of parts.entries()) {
      const rated = rateMeterCombination({
        model: ctx.snap.model,
        // A list segment is a rate (plus its markup) over the list row's own divisor.
        amountSource: listed ? "rate" : (ctx.snap.amountSource ?? "rate"),
        quantity: byRate ? billable[i]! : c.quantity,
        freeQuantity: 0,
        rate: seg.rate,
        quantityDivisor: seg.quantityDivisor ?? BigInt(ctx.snap.quantityDivisor ?? "1"),
        packageSize: ctx.snap.packageSize,
        amountSum: c.amountSum,
        costSum: c.costSum,
        markupPercent: listed
          ? (seg.markupPercent ?? null)
          : ctx.snap.markupPercent != null
            ? fixed12FromNumeric(ctx.snap.markupPercent)
            : null,
        currencyExponent: currencyExponent(ctx.currency),
        // Only an additive meter's segments add up to the period's quantity.
        ...(additive ? { position: { before, total } } : {}),
      });
      before += billable[i]!;
      out.push({
        late,
        window: whole ? window : { start: seg.start, end: seg.end },
        period: window,
        group: combo.group,
        rateMatch: seg.rate.match,
        rate: seg.rate,
        quantity: listQuantity(c),
        billableQuantity: rated.billableQuantity,
        unitAmount: rated.unitAmount,
        amountMinor: rated.amountMinor,
        amountSum: c.amountSum,
        costSum: split ? 0n : c.costSum,
        ...(rated.tiers ? { tiers: rated.tiers } : {}),
        level: c.level,
        ...(seg.cite ? { segment: seg } : {}),
        ...(split ? { part: "list" as const } : {}),
      });
    }
  }
  return out;
}

/**
 * `event_cost_or_list`: the events that carried a cost bill that cost plus the combination's
 * markup (its rate row or customer override, else the price's), over the whole window. Null
 * when none of them did.
 */
function reportedCostLine(
  ctx: RateCtx,
  window: UsageWindow,
  combo: MeterCombo,
  late: boolean,
): MeterLineRating | null {
  const quantity = combo.quantity - (combo.uncostedQuantity ?? 0n);
  if (quantity <= 0n && combo.costSum === 0n) return null;
  const rule = sellingRule(ctx.snap, groupRecord(ctx.meter.groupBy, combo.group));
  const markup = fixed12FromNumeric(rule.markup ?? "0");
  const rated = rateMeterCombination({
    model: ctx.snap.model,
    amountSource: "event_cost",
    quantity,
    freeQuantity: 0,
    rate: { unitAmountDecimal: null, tiers: null },
    quantityDivisor: 1n,
    costSum: combo.costSum,
    markupPercent: markup,
    currencyExponent: currencyExponent(ctx.currency),
  });
  const rate: MeterRateSpec = { unitAmountDecimal: null, tiers: null, match: rule.match };
  return {
    late,
    window,
    period: window,
    group: combo.group,
    rateMatch: rule.match,
    rate,
    quantity,
    billableQuantity: rated.billableQuantity,
    unitAmount: rated.unitAmount,
    amountMinor: rated.amountMinor,
    amountSum: 0n,
    costSum: combo.costSum,
    level: null,
    part: "reported_cost",
    segment: {
      start: window.start,
      end: window.end,
      rate,
      markupPercent: markup,
      cite: {
        from: window.start.toISOString(),
        to: window.end.toISOString(),
        unit_amount_decimal: formatFixed12(rated.unitAmount),
        quantity_divisor: "1",
        markup_percent: formatFixed12(markup),
        markup_base: null,
        base_unit_amount_decimal: null,
        rate_from: rule.from,
        price_source: "reported_cost",
        model_price_id: null,
        model_cost_override_id: null,
        source: null,
        source_version: null,
        source_effective_from: null,
      },
    },
  };
}

const groupKey = (g: readonly string[]) => JSON.stringify(g);
const sameGroup = (a: readonly string[], b: readonly string[]) => groupKey(a) === groupKey(b);

export function groupRecord(
  groupBy: readonly string[],
  values: readonly string[],
): Record<string, string> {
  const r: Record<string, string> = {};
  groupBy.forEach((k, i) => (r[k] = values[i] ?? ""));
  return r;
}

const textArray = (xs: readonly string[]): SQL =>
  xs.length === 0
    ? sql`array[]::text[]`
    : sql`array[${sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `,
      )}]::text[]`;

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/**
 * An event is inside a cutoff taken at `at` (real clock) when it was received more than the
 * fold grace before it and matched before it. Recurring levels are snapshotted on this rule,
 * so an event is either in a snapshot or a late delta after it, never both.
 */
function inCutoff(c: { at: Date }): SQL {
  return sql`(e.id < ${uuidFloor(c.at.getTime() - FOLD_GRACE_MS)}::uuid
    and (e.matched_at is null or e.matched_at < ${ts(c.at)}))`;
}

/** The meter's events for this customer: matched, not voided, passing its filters. */
function eventScope(ctx: RateCtx): SQL {
  const m = ctx.meter;
  const where = ctx.where
    ? sql` and e.properties ->> ${ctx.where.key}::text = ${ctx.where.value}::text`
    : sql``;
  return sql`e.business_id = ${m.businessId} and e.customer_id = ${ctx.customerId}
    and e.event_name = ${m.eventName} and e.voided_at is null and ${countsTowardMeter("e", m)}${where}`;
}

/**
 * Usage per combination over `window`, exact, read from the events. `cutoff` = null reads
 * everything received so far.
 */
async function readCombos(
  ctx: RateCtx,
  window: UsageWindow,
  cutoff: MeterCutoff | null,
): Promise<{ combos: MeterCombo[] }> {
  const m = ctx.meter;
  if (window.end.getTime() <= window.start.getTime()) return { combos: [] };
  if (m.recurring || m.aggregation === "weighted_sum")
    return { combos: await readLevels(ctx, window, cutoff) };
  if (m.aggregation === "unique") return { combos: await readUnique(ctx, window, cutoff) };
  const usage = await readMeterUsage(ctx.tx, {
    customerId: ctx.customerId,
    meterId: m.id,
    window,
    ...(cutoff
      ? { cutoff: { generation: cutoff.generation, at: cutoff.at, watermark: cutoff.watermark } }
      : {}),
    ...(ctx.where ? { where: ctx.where } : {}),
  });
  return { combos: mergeCurrencies(m.aggregation, usage.segments[0]?.rows ?? [], ctx.currency) };
}

/**
 * One combo per group from the reader's rows per group and currency. Quantity counts every
 * event; amount and cost count only events in the price's currency or none (a mismatch is not
 * billed). `unique` meters do not come here (`readUnique`).
 */
function mergeCurrencies(
  aggregation: string,
  rows: MeterUsageRow[],
  currency: string,
): MeterCombo[] {
  const out = new Map<string, { combo: MeterCombo; rows: MeterUsageRow[] }>();
  for (const r of rows) {
    const k = groupKey(r.groupValues);
    let e = out.get(k);
    if (!e)
      out.set(
        k,
        (e = {
          combo: {
            group: r.groupValues,
            quantity: 0n,
            amountSum: 0n,
            costSum: 0n,
            uncostedQuantity: 0n,
            level: null,
          },
          rows: [],
        }),
      );
    e.rows.push(r);
    // A cost in another currency cannot bill, so `event_cost_or_list` bills those units from
    // the list instead of dropping them.
    e.combo.uncostedQuantity! +=
      r.currency == null || r.currency === currency ? r.uncostedQuantity : r.quantity;
    if (r.currency == null || r.currency === currency) {
      e.combo.amountSum += r.amountSum;
      e.combo.costSum += r.costSum;
    }
  }
  for (const { combo, rows: rs } of out.values()) {
    if (rs.length === 1) {
      combo.quantity = rs[0]!.quantity;
      continue;
    }
    const n = rs.reduce((a, r) => a + r.eventCount, 0n);
    const sum = rs.reduce((a, r) => a + r.valueSum, 0n);
    const pick = (
      f: (r: MeterUsageRow) => bigint | null,
      better: (a: bigint, b: bigint) => boolean,
    ) =>
      rs.reduce<bigint | null>((a, r) => {
        const v = f(r);
        return v == null ? a : a == null || better(v, a) ? v : a;
      }, null) ?? 0n;
    switch (aggregation) {
      case "min":
        combo.quantity = pick(
          (r) => r.valueMin,
          (a, b) => a < b,
        );
        break;
      case "max":
        combo.quantity = pick(
          (r) => r.valueMax,
          (a, b) => a > b,
        );
        break;
      case "last":
        combo.quantity =
          [...rs].sort((a, b) => (a.lastAt?.getTime() ?? 0) - (b.lastAt?.getTime() ?? 0)).at(-1)
            ?.lastValue ?? 0n;
        break;
      case "avg":
        combo.quantity = n > 0n ? divHalfUp(sum, n) : 0n;
        break;
      default:
        combo.quantity = rs.reduce((a, r) => a + r.quantity, 0n);
    }
  }
  return [...out.values()]
    .map((e) => e.combo)
    .sort((a, b) => (groupKey(a.group) < groupKey(b.group) ? -1 : 1));
}

/**
 * A `unique` meter counts distinct values across every currency of a group, so it is read here
 * from raw events (it is never rolled up) rather than from per-currency rows.
 */
async function readUnique(
  ctx: RateCtx,
  window: UsageWindow,
  cutoff: MeterCutoff | null,
): Promise<MeterCombo[]> {
  const m = ctx.meter;
  const rows = rowsOf<{ gv: string[]; uniq: string; asum: string; csum: string }>(
    await ctx.tx.execute(sql`
      select x.gv, count(distinct x.uq)::text uniq,
        coalesce(sum(x.amount) filter (where x.cur_ok), 0)::text asum,
        coalesce(sum(x.cost) filter (where x.cur_ok), 0)::text csum
      from (
        select ${groupValuesOf("e", textArray(m.groupBy))} gv,
          e.properties ->> ${m.uniqueProperty ?? ""}::text uq, e.amount, e.cost,
          (e.currency is null or e.currency = ${ctx.currency}) cur_ok
        from usage_events e
        where ${eventScope(ctx)}
          and e.timestamp >= ${ts(window.start)} and e.timestamp < ${ts(window.end)}
          ${cutoff ? sql`and ${inCutoff(cutoff)}` : sql``}
      ) x
      group by x.gv order by x.gv`),
  );
  return rows.map((r) => ({
    group: r.gv,
    quantity: fixed12FromInt(BigInt(r.uniq)),
    amountSum: fixed12FromNumeric(r.asum),
    costSum: fixed12FromNumeric(r.csum),
    level: null,
  }));
}

interface RawEvent {
  gv: string[];
  at: number;
  v: string | null;
  uq: string | null;
}

/**
 * Recurring and time-weighted meters, from raw events. The carried-in level is the latest
 * snapshot at or before the window start plus the events after it, so no older history is read.
 * A late delta dated before that snapshot (sum, unique) applies at the window start; a late
 * `last` / `max` reading before it is ignored.
 */
async function readLevels(
  ctx: RateCtx,
  window: UsageWindow,
  cutoff: MeterCutoff | null,
): Promise<MeterCombo[]> {
  const m = ctx.meter;
  const agg = m.aggregation;
  const startMs = window.start.getTime();
  // Latest snapshot set at or before the window start.
  const snaps = m.recurring
    ? rowsOf<{ gv: string[]; at: string; level: string; keys: string[] | null; taken: string }>(
        await ctx.tx.execute(sql`
          select group_values gv, at, level::text level, active_keys keys, created_at taken
          from usage_meter_levels
          where customer_id = ${ctx.customerId} and meter_id = ${m.id}
            and at = (select max(at) from usage_meter_levels
                      where customer_id = ${ctx.customerId} and meter_id = ${m.id}
                        and at <= ${ts(window.start)})`),
      )
    : [];
  const snapAt = snaps[0] ? new Date(snaps[0].at) : null;
  const snapTaken = snaps[0] ? new Date(snaps[0].taken) : null;
  const from = m.recurring ? snapAt : window.start;
  const deltas = agg === "sum" || agg === "unique";
  const rows = rowsOf<{
    gv: string[];
    at: string;
    v: string | null;
    uq: string | null;
    before: boolean;
  }>(
    await ctx.tx.execute(sql`
      select ${groupValuesOf("e", textArray(m.groupBy))} gv, e.timestamp at,
        (${valueOf("e", sql`${m.valueProperty ?? ""}::text`)})::text v,
        e.properties ->> ${m.uniqueProperty ?? ""}::text uq,
        (e.timestamp < ${ts(window.start)}) before
      from usage_events e
      where ${eventScope(ctx)} and e.timestamp < ${ts(window.end)}
        ${cutoff ? sql`and ${inCutoff(cutoff)}` : sql``}
        and (${from ? sql`e.timestamp >= ${ts(from)}` : sql`true`}
          ${
            snapAt && snapTaken && deltas
              ? sql`or (e.timestamp < ${ts(snapAt)} and not ${inCutoff({ at: snapTaken })})`
              : sql``
          })
      order by e.timestamp, e.id`),
  );
  const byGroup = new Map<string, { group: string[]; before: RawEvent[]; inside: RawEvent[] }>();
  const bucket = (gv: string[]) => {
    const k = groupKey(gv);
    let b = byGroup.get(k);
    if (!b) byGroup.set(k, (b = { group: gv, before: [], inside: [] }));
    return b;
  };
  for (const s of snaps) bucket(s.gv);
  for (const r of rows) {
    const e = { gv: r.gv, at: new Date(r.at).getTime(), v: r.v, uq: r.uq };
    (r.before ? bucket(r.gv).before : bucket(r.gv).inside).push(e);
  }
  const snapOf = new Map(snaps.map((s) => [groupKey(s.gv), s]));
  const out: MeterCombo[] = [];
  for (const { group, before, inside } of byGroup.values()) {
    const snap = snapOf.get(groupKey(group));
    const toLevel = (e: RawEvent): LevelEvent => ({
      at: Math.max(e.at, startMs),
      quantity: e.v != null ? fixed12FromNumeric(e.v) : 0n,
      uniqueKey: e.uq,
      operation: "add",
    });
    if (agg === "weighted_sum") {
      const lvl = timeWeightedLevel({
        carriedIn: 0n,
        events: inside.map(toLevel),
        startMs,
        endMs: window.end.getTime(),
        unitMs: TIME_UNIT_MS[(m.timeUnit as "hour" | "day") ?? "hour"],
      });
      out.push(comboOf(group, lvl.quantity, lvl));
      continue;
    }
    if (agg === "unique") {
      const keys = new Set<string>(snap?.keys ?? []);
      for (const e of before) if (e.uq != null) keys.add(e.uq);
      const lvl = recurringLevel({
        aggregation: "unique",
        carriedIn: BigInt(keys.size),
        activeKeys: keys,
        events: inside.map(toLevel),
        startMs,
      });
      const active = new Set(keys);
      for (const e of inside) if (e.uq != null) active.add(e.uq);
      out.push({
        ...comboOf(group, fixed12FromInt(lvl.quantity), {
          carriedIn: fixed12FromInt(lvl.carriedIn),
          closing: fixed12FromInt(lvl.closing),
          peak: fixed12FromInt(lvl.peak),
        }),
        activeKeys: [...active].sort(),
      });
      continue;
    }
    const base = snap ? fixed12FromNumeric(snap.level) : 0n;
    let carriedIn: bigint;
    if (agg === "sum") carriedIn = before.reduce((s, e) => s + toLevel(e).quantity, base);
    else {
      // last / max: the latest reading before the window, else the snapshot.
      const prev = before.filter((e) => !snapAt || e.at >= snapAt.getTime()).at(-1);
      carriedIn = prev ? toLevel(prev).quantity : base;
    }
    const lvl = recurringLevel({
      aggregation: agg as "sum" | "last" | "max",
      carriedIn,
      events: inside.map(toLevel),
      startMs,
    });
    out.push(comboOf(group, lvl.quantity, lvl));
  }
  return out
    .filter((c) => c.quantity !== 0n || (c.level && c.level.closing !== 0n))
    .sort((a, b) => (groupKey(a.group) < groupKey(b.group) ? -1 : 1));
}

function comboOf(group: string[], quantity: bigint, level: Level): MeterCombo {
  return {
    group,
    quantity,
    amountSum: 0n,
    costSum: 0n,
    level: { carriedIn: level.carriedIn, closing: level.closing, peak: level.peak },
  };
}

/**
 * The pricing a window was rated at, kept on its first line's `rating.pricing`, so late usage of
 * that window re-rates at the price that applied then, never the item's current one.
 */
export interface MeterPricingRecord {
  model: string;
  currency: string;
  unit_amount_decimal: string | null;
  tiers: unknown;
  rates: PriceSnapshot["rates"];
  quantity_divisor: string;
  amount_source: string;
  markup_percent: string | null;
  package_size: number | null;
  free_quantity: number;
  /** model_price_list only. */
  markup_base?: "list" | "cost" | null;
  selling_override?: PriceSnapshot["sellingOverride"];
}

export function pricingRecord(snap: PriceSnapshot, freeQuantity: number): MeterPricingRecord {
  return {
    model: snap.model,
    currency: snap.currency,
    unit_amount_decimal: snap.unitAmountDecimal ?? null,
    tiers: snap.tiers ?? null,
    rates: snap.rates ?? [],
    quantity_divisor: snap.quantityDivisor ?? "1",
    amount_source: snap.amountSource ?? "rate",
    markup_percent: snap.markupPercent ?? null,
    package_size: snap.packageSize ?? null,
    free_quantity: freeQuantity,
    ...(billsFromList(snap.amountSource)
      ? {
          markup_base: snap.markupBase ?? "list",
          ...(snap.sellingOverride ? { selling_override: snap.sellingOverride } : {}),
        }
      : {}),
  };
}

function ctxAtPricing(ctx: RateCtx, p: MeterPricingRecord | null): RateCtx {
  if (!p) return ctx;
  const snap: PriceSnapshot = {
    ...ctx.snap,
    model: p.model,
    currency: p.currency,
    unitAmountDecimal: p.unit_amount_decimal,
    tiers: p.tiers,
    rates: p.rates,
    quantityDivisor: p.quantity_divisor,
    amountSource: p.amount_source,
    markupPercent: p.markup_percent,
    packageSize: p.package_size,
    markupBase: p.markup_base ?? ctx.snap.markupBase,
    sellingOverride: p.selling_override,
  };
  return {
    ...ctx,
    snap,
    freeQuantity: p.free_quantity,
    resolveRate: ctx.customResolver ?? defaultResolver(ctx.tx, ctx.meter, snap, ctx.currency),
  };
}

/**
 * Usage of earlier windows that arrived after their invoice's cutoff. For each earlier period
 * it touches: late = rate(period, now, at that period's pricing) − what was already billed for
 * it, per combination, summed over every segment either side split into. Only a positive
 * difference bills (one line per combination, with its cost); corrections go through a
 * credit note.
 *
 * Found by RECEIVE time, so a renewal reads only what arrived since the last cutoff: raw events
 * received after the previous cutoff (an id range), rollups folded above its generation (late
 * matches of rolled-up meters land there), and for raw-read meters events matched after it.
 */
async function lateLines(
  ctx: RateCtx,
  current: UsageWindow,
  cutoff: MeterCutoff,
): Promise<MeterLineRating[]> {
  const prev = cutoff.previous;
  if (!prev.usageThrough || !prev.cutoffAt) return [];
  const through = prev.usageThrough;
  const m = ctx.meter;
  const rollable = isRollable(m);
  const touched = rollable
    ? rowsOf<{ t: string }>(
        await ctx.tx.execute(sql`
          select distinct bucket_start t from usage_rollups
          where business_id = ${m.businessId} and customer_id = ${ctx.customerId}
            and meter_id = ${m.id} and bucket_start < ${ts(through)}
            and generation > ${String(prev.cutoffGeneration ?? -1n)}::bigint`),
      )
    : [];
  const raw = rowsOf<{ t: string }>(
    await ctx.tx.execute(sql`
      select distinct e.timestamp t from usage_events e
      where ${eventScope(ctx)} and e.timestamp < ${ts(through)}
        and e.id >= ${uuidFloor(prev.cutoffAt.getTime() - FOLD_GRACE_MS)}::uuid`),
  );
  // Raw-read meters have no rollups to show a late match. Only events matched after ingest
  // have matched_at, so this is a range on usage_events_late_match_idx.
  const matched = rollable
    ? []
    : rowsOf<{ t: string }>(
        await ctx.tx.execute(sql`
          select distinct e.timestamp t from usage_events e
          where ${eventScope(ctx)} and e.timestamp < ${ts(through)}
            and e.matched_at >= ${ts(prev.cutoffAt)}`),
      );
  const instants = [...touched, ...raw, ...matched].map((r) => new Date(r.t).getTime());
  if (instants.length === 0) return [];
  const earliest = Math.min(...instants);
  // What earlier lines (and settlements not yet invoiced) billed per period and combination,
  // whatever segments they split into.
  const billed = rowsOf<{
    rating: MeterLineRatingJson;
    amount: string;
    cost: string | null;
    basis: string | null;
  }>(
    await ctx.tx.execute(sql`
      select li.rating, li.amount_minor::text amount, li.cost_minor::text cost,
        li.cost_basis basis
      from invoice_line_items li
      join invoices i on i.id = li.invoice_id
      where i.business_id = ${m.businessId} and i.customer_id = ${ctx.customerId}
        and i.status not in ('voided', 'pending')
        and li.kind = 'usage' and li.rating ->> 'meter' = ${m.id}
        and coalesce(li.rating -> 'period' ->> 'end', li.rating -> 'window' ->> 'end')::timestamptz
          > ${ts(new Date(earliest))}
      union all
      select u.rating, u.amount_minor::text, u.rating -> 'settlement_cost' ->> 'minor',
        u.rating -> 'settlement_cost' ->> 'basis'
      from unbilled_charges u join subscriptions s on s.id = u.subscription_id
      where u.business_id = ${m.businessId} and s.customer_id = ${ctx.customerId}
        and u.status = 'pending' and u.rating ->> 'meter' = ${m.id}
        and coalesce(u.rating -> 'period' ->> 'end', u.rating -> 'window' ->> 'end')::timestamptz
          > ${ts(new Date(earliest))}`),
  );
  const periods = new Map<string, { window: UsageWindow; pricing: MeterPricingRecord | null }>();
  const billedBy = new Map<string, Billed>();
  for (const b of billed) {
    // Lines written before `period` existed were never split: their window is the period.
    const p = b.rating.period ?? b.rating.window;
    const w = { start: new Date(p.start), end: new Date(p.end) };
    const pk = `${w.start.toISOString()}|${w.end.toISOString()}`;
    const k = `${pk}|${groupKey(b.rating.group ?? [])}`;
    const sum = billedBy.get(k) ?? { amount: 0n, quantity: 0n, cost: 0n, costUnknown: null };
    // A late line stores its own delta, so the sum is the quantity billed so far.
    const quantity = tryParseFixed12(String(b.rating.quantity ?? "0")) ?? 0n;
    sum.amount += BigInt(b.amount);
    sum.quantity += quantity;
    if (b.cost != null) sum.cost += BigInt(b.cost);
    else if (quantity > 0n) sum.costUnknown ??= (b.basis as LineCost["basis"] | null) ?? "none";
    billedBy.set(k, sum);
    if (w.end.getTime() > current.start.getTime()) continue;
    if (!instants.some((t) => t >= w.start.getTime() - 15 * 60_000 && t < w.end.getTime()))
      continue;
    const seen = periods.get(pk);
    periods.set(pk, { window: w, pricing: seen?.pricing ?? b.rating.pricing ?? null });
  }
  const out: MeterLineRating[] = [];
  for (const [pk, { window: w, pricing }] of [...periods.entries()].sort()) {
    const at = ctxAtPricing(ctx, pricing);
    const { combos } = await readCombos(at, w, cutoff);
    const byGroup = new Map<string, MeterLineRating[]>();
    for (const line of await rateCombos(at, w, combos, true, cutoff)) {
      const k = groupKey(line.group);
      byGroup.set(k, [...(byGroup.get(k) ?? []), line]);
    }
    for (const [gk, ls] of byGroup) {
      const already = billedBy.get(`${pk}|${gk}`);
      const total = (f: (l: MeterLineRating) => bigint) => ls.reduce((a, l) => a + f(l), 0n);
      const diff = total((l) => l.amountMinor) - (already?.amount ?? 0n);
      if (diff <= 0n) continue;
      const one = ls.length === 1 ? ls[0]! : null;
      const segs = ls.flatMap((l) => (l.segment ? [l.segment] : []));
      const line: MeterLineRating = {
        late: true,
        window: w,
        period: w,
        group: ls[0]!.group,
        rateMatch: ls[0]!.rateMatch,
        rate: ls[0]!.rate,
        quantity: total((l) => l.quantity),
        billableQuantity: total((l) => l.billableQuantity),
        unitAmount: one?.unitAmount ?? 0n,
        amountMinor: diff,
        amountSum: total((l) => l.amountSum),
        costSum: total((l) => l.costSum),
        ...(one?.tiers ? { tiers: one.tiers } : {}),
        level: one?.level ?? null,
        ...(one?.segment ? { segment: one.segment } : {}),
        ...(!one && segs.length ? { segments: segs } : {}),
        ...(pricing ? { pricing } : {}),
      };
      const cost = await lineCost({
        tx: ctx.tx,
        meter: m,
        customerId: ctx.customerId,
        currency: ctx.currency,
        cutoff,
        line,
      });
      out.push({
        ...line,
        ...lateQuantity(
          at.snap,
          one?.unitAmount ?? null,
          line.quantity,
          diff,
          already?.quantity ?? 0n,
        ),
        cost: lateCost(cost, already),
      });
    }
  }
  return out;
}

/** What a period already billed for one combination. */
interface Billed {
  amount: bigint;
  quantity: bigint;
  /** Σ cost_minor of the lines that had one. */
  cost: bigint;
  /** The basis of a billed line whose cost was unknown; then the late cost is unknown too. */
  costUnknown: LineCost["basis"] | null;
}

/** The late units' cost: the period's cost now less what its lines already carried. */
function lateCost(now: LineCost | null, already: Billed | undefined): LineCost | null {
  if (!now || now.minor == null) return now;
  if (already?.costUnknown) return { minor: null, basis: already.costUnknown };
  const minor = now.minor - (already?.cost ?? 0n);
  return { minor: minor > 0n ? minor : 0n, basis: now.basis };
}

/**
 * A late line's quantity and rate: the units added since the window was billed, at the line's
 * rate for a per-unit price, else the difference ÷ those units (tiers, packages, event amounts).
 * A difference with no added units (an event amount on a max meter) states 1 × the difference.
 */
function lateQuantity(
  snap: PriceSnapshot,
  /** The rate of a line that did not split; null across segments. */
  unitAmount: bigint | null,
  quantity: bigint,
  diff: bigint,
  billedQuantity: bigint,
): Pick<MeterLineRating, "quantity" | "billableQuantity" | "unitAmount"> {
  const added = quantity - billedQuantity;
  if (added <= 0n)
    return {
      quantity: FIXED12_SCALE,
      billableQuantity: FIXED12_SCALE,
      unitAmount: diff * FIXED12_SCALE,
    };
  const perUnit =
    unitAmount != null && snap.model === "usage" && (snap.amountSource ?? "rate") === "rate";
  return {
    quantity: added,
    billableQuantity: added,
    unitAmount: perUnit ? unitAmount : mulDivHalfUp(diff, FIXED12_SCALE * FIXED12_SCALE, added),
  };
}

/** "<price> · <group values>", or "Usage from <period>: <price> · <group values>" when late. */
export function meterLineDescription(
  label: string,
  r: Pick<MeterItemRating, "meter">,
  line: Pick<MeterLineRating, "late" | "group" | "window" | "part">,
): string {
  const values = r.meter.groupBy.length && line.group.length ? ` · ${line.group.join(" · ")}` : "";
  const part = line.part === "reported_cost" ? " · reported cost" : "";
  return line.late
    ? `Usage from ${formatUsagePeriod(line.window)}: ${label}${values}`
    : `${label}${values}${part}`;
}

/** "1–31 Oct 2026" for a half-open window, in UTC. */
export function formatUsagePeriod(w: UsageWindow): string {
  const last = new Date(w.end.getTime() - 1);
  const d = (x: Date) => x.getUTCDate();
  const mon = (x: Date) => x.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const y = (x: Date) => x.getUTCFullYear();
  if (y(w.start) === y(last) && mon(w.start) === mon(last))
    return d(w.start) === d(last)
      ? `${d(w.start)} ${mon(w.start)} ${y(w.start)}`
      : `${d(w.start)}–${d(last)} ${mon(last)} ${y(last)}`;
  if (y(w.start) === y(last))
    return `${d(w.start)} ${mon(w.start)} – ${d(last)} ${mon(last)} ${y(last)}`;
  return `${d(w.start)} ${mon(w.start)} ${y(w.start)} – ${d(last)} ${mon(last)} ${y(last)}`;
}

/**
 * The `rating` stored on a meter line. JSON-safe: decimals as strings. `withPricing` puts the
 * full pricing (rate card included) on the line; one line per window carries it.
 */
export function meterLineRatingJson(
  snap: PriceSnapshot,
  r: MeterItemRating,
  line: MeterLineRating,
  withPricing: boolean,
) {
  const iso = (w: UsageWindow) => ({ start: w.start.toISOString(), end: w.end.toISOString() });
  const p = line.pricing ?? r.pricing;
  const cites = (line.segments ?? (line.segment ? [line.segment] : [])).flatMap((s) =>
    s.cite ? [s.cite] : [],
  );
  const cite = cites[0];
  return {
    meter: r.meter.id,
    meter_key: r.meter.key,
    model: p.model,
    aggregation: snap.usageAggregation ?? r.meter.aggregation,
    recurring: r.meter.recurring,
    group_by: r.meter.groupBy,
    group: line.group,
    rate_match: line.rateMatch,
    unit_amount_decimal: cite ? cite.unit_amount_decimal : line.rate.unitAmountDecimal,
    quantity_divisor: cite ? cite.quantity_divisor : p.quantity_divisor,
    amount_source: p.amount_source,
    markup_percent: p.markup_percent,
    quantity: formatFixed12(line.quantity),
    free_quantity: p.free_quantity,
    billable_quantity: formatFixed12(line.billableQuantity),
    /** Minor units per unit (Fixed12 text): the line's `unit_amount_decimal`. */
    unit_amount: formatFixed12(line.unitAmount),
    amount_sum: formatFixed12(line.amountSum),
    cost_sum: formatFixed12(line.costSum),
    tiers: (line.tiers ?? []).map((t) => ({
      from: t.from,
      to: t.to,
      units: t.units,
      unit_amount_decimal: t.unitAmountDecimal,
      flat_amount_minor: t.flatAmountMinor,
      amount: t.amount,
    })),
    window: iso(line.window),
    period: iso(line.period),
    cutoff: {
      generation: String(r.pointer.cutoff.generation),
      at: r.pointer.cutoff.at.toISOString(),
    },
    late_for: line.late ? iso(line.window) : null,
    level: line.level
      ? {
          carried_in: formatFixed12(line.level.carriedIn),
          closing: formatFixed12(line.level.closing),
          peak: formatFixed12(line.level.peak),
        }
      : null,
    // The model price list: what each segment priced from (B1).
    ...(cite
      ? {
          price_source: cites.some((c) => c.price_source === "default_rate")
            ? "default_rate"
            : cite.price_source,
          segments: cites,
        }
      : {}),
    ...(line.part ? { part: line.part } : {}),
    ...(withPricing ? { pricing: p } : {}),
  } as {
    meter: string;
    meter_key: string;
    window: { start: string; end: string };
    /** Absent on lines written before 1b: their window is the period. */
    period?: { start: string; end: string };
    group: string[];
    pricing?: MeterPricingRecord;
    [k: string]: unknown;
  };
}
export type MeterLineRatingJson = ReturnType<typeof meterLineRatingJson>;

/**
 * Write what an invoice of meter lines commits with it: the billing pointer and the recurring
 * level snapshots. Runs in the invoice transaction, so a rollback loses nothing.
 */
export async function commitMeterRating(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    pointers: MeterItemRating["pointer"][];
    levels: LevelSnapshot[];
  },
): Promise<void> {
  for (const p of input.pointers) {
    if (!p.cutoff.taken) continue;
    await tx.execute(sql`
      update customer_meter_billing
      set usage_through = greatest(coalesce(usage_through, ${ts(p.usageThrough)}), ${ts(p.usageThrough)}),
          cutoff_generation = ${String(p.cutoff.generation)}::bigint,
          cutoff_at = ${ts(p.cutoff.at)},
          updated_at = app_now()
      where customer_id = ${p.customerId} and meter_id = ${p.meterId}`);
  }
  // created_at = the cutoff instant (real clock): `readLevels` splits snapshot from late on it.
  const takenAt = new Map(input.pointers.map((p) => [p.meterId, p.cutoff]));
  for (const l of input.levels) {
    const cutoff = takenAt.get(l.meterId);
    if (!cutoff?.taken) continue;
    await tx.execute(sql`
      insert into usage_meter_levels
        (organization_id, business_id, customer_id, meter_id, group_values, at, level, active_keys,
         created_at)
      values (${input.organizationId}, ${input.businessId}, ${l.customerId}, ${l.meterId},
              ${textArray(l.group)}, ${ts(l.at)}, ${formatFixed12(l.level)}::numeric,
              ${l.activeKeys ? textArray(l.activeKeys) : sql`null`}, ${ts(cutoff.at)})
      on conflict (customer_id, meter_id, group_values, at)
        do update set level = excluded.level, active_keys = excluded.active_keys,
                      created_at = excluded.created_at`);
  }
}

/** Fixed12 → a JS number for event payloads (display only). */
export const fixedToNumber = (v: bigint): number => Number(v) / Number(FIXED12_SCALE);
