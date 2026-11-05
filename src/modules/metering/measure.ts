import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { usageRecords } from "@db/schema";
import { TIME_UNIT_MS, type PriceSnapshot, type UsageAggregation } from "@/modules/catalog/pricing";
import type { UsageWindow } from "@/modules/subscriptions/usage-window";
import {
  applyUniqueOps,
  recurringLevel,
  timeWeightedLevel,
  type Level,
  type LevelEvent,
} from "./levels";

/**
 * Where a metered quantity is measured from. `item` = a subscription item's usage records.
 * `meter` = a customer's events on a billable metric (not built yet).
 */
export type MeterSource =
  | { kind: "item"; itemId: string }
  | { kind: "meter"; meterId: string; customerId: string };

export interface Measured {
  quantity: bigint;
  /** The level, for a recurring or time-weighted metric. */
  level: Level | null;
}

/** Quantity for any aggregation over `[start, end)`, recurring and weighted_sum included. */
export async function aggregateMeteredQuantity(
  tx: Tx,
  input: { itemId: string; snapshot: PriceSnapshot; window: UsageWindow },
): Promise<bigint> {
  return (
    await measureMetered(tx, {
      source: { kind: "item", itemId: input.itemId },
      snapshot: input.snapshot,
      window: input.window,
    })
  ).quantity;
}

/** `aggregateMeteredQuantity` with the level it was measured from. */
export async function measureMetered(
  tx: Tx,
  input: { source: MeterSource; snapshot: PriceSnapshot; window: UsageWindow },
): Promise<Measured> {
  if (input.source.kind !== "item")
    throw new Error("Measuring usage from a meter is not built yet.");
  const itemId = input.source.itemId;
  const { start, end } = input.window;
  const agg = (input.snapshot.usageAggregation ?? "sum") as UsageAggregation;
  const recurring = input.snapshot.usageRecurring === true;
  if (end.getTime() <= start.getTime())
    return { quantity: 0n, level: recurring || agg === "weighted_sum" ? zeroLevel : null };

  if (agg === "weighted_sum") {
    const level = timeWeightedLevel({
      carriedIn: recurring ? await sumBefore(tx, itemId, start) : 0n,
      events: await eventsIn(tx, itemId, input.window),
      startMs: start.getTime(),
      endMs: end.getTime(),
      unitMs: TIME_UNIT_MS[input.snapshot.usageTimeUnit ?? "hour"],
    });
    return { quantity: level.quantity, level: levelOf(level) };
  }
  if (!recurring)
    return { quantity: await windowAggregate(tx, itemId, input.window, agg), level: null };

  if (agg === "unique") {
    const keys = applyUniqueOps(new Set(), await eventsBefore(tx, itemId, start));
    const level = recurringLevel({
      aggregation: "unique",
      carriedIn: BigInt(keys.size),
      activeKeys: keys,
      events: await eventsIn(tx, itemId, input.window),
      startMs: start.getTime(),
    });
    return { quantity: level.quantity, level: levelOf(level) };
  }
  if (agg !== "sum" && agg !== "last" && agg !== "max")
    throw new Error(`The ${agg} aggregation cannot carry a level.`);
  const level = recurringLevel({
    aggregation: agg,
    carriedIn:
      agg === "sum" ? await sumBefore(tx, itemId, start) : await lastBefore(tx, itemId, start),
    events: await eventsIn(tx, itemId, input.window),
    startMs: start.getTime(),
  });
  return { quantity: level.quantity, level: levelOf(level) };
}

const zeroLevel: Level = { carriedIn: 0n, closing: 0n, peak: 0n };
const levelOf = (l: Level): Level => ({ carriedIn: l.carriedIn, closing: l.closing, peak: l.peak });

const eventOrder = [asc(usageRecords.timestamp), asc(usageRecords.createdAt), asc(usageRecords.id)];
const eventCols = {
  at: usageRecords.timestamp,
  quantity: usageRecords.quantity,
  uniqueKey: usageRecords.uniqueKey,
  operation: usageRecords.operation,
};
const toEvents = (
  rows: Array<{ at: Date; quantity: bigint; uniqueKey: string | null; operation: string }>,
): LevelEvent[] =>
  rows.map((r) => ({
    at: r.at.getTime(),
    quantity: r.quantity,
    uniqueKey: r.uniqueKey,
    operation: r.operation === "remove" ? "remove" : "add",
  }));

async function eventsIn(tx: Tx, itemId: string, w: UsageWindow): Promise<LevelEvent[]> {
  return toEvents(
    await tx
      .select(eventCols)
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.subscriptionItemId, itemId),
          gte(usageRecords.timestamp, w.start),
          lt(usageRecords.timestamp, w.end),
        ),
      )
      .orderBy(...eventOrder),
  );
}

async function eventsBefore(tx: Tx, itemId: string, start: Date): Promise<LevelEvent[]> {
  return toEvents(
    await tx
      .select(eventCols)
      .from(usageRecords)
      .where(and(eq(usageRecords.subscriptionItemId, itemId), lt(usageRecords.timestamp, start)))
      .orderBy(...eventOrder),
  );
}

async function sumBefore(tx: Tx, itemId: string, start: Date): Promise<bigint> {
  const [row] = await tx
    .select({ v: sql<string>`coalesce(sum(${usageRecords.quantity}), 0)` })
    .from(usageRecords)
    .where(and(eq(usageRecords.subscriptionItemId, itemId), lt(usageRecords.timestamp, start)));
  return BigInt(row?.v ?? 0);
}

async function lastBefore(tx: Tx, itemId: string, start: Date): Promise<bigint> {
  const [row] = await tx
    .select({ v: usageRecords.quantity })
    .from(usageRecords)
    .where(and(eq(usageRecords.subscriptionItemId, itemId), lt(usageRecords.timestamp, start)))
    .orderBy(desc(usageRecords.timestamp), desc(usageRecords.createdAt), desc(usageRecords.id))
    .limit(1);
  return row?.v ?? 0n;
}

/**
 * One aggregate over the records in `[start, end)`. `unique` counts distinct keys with an
 * add in the window; `avg` rounds to a whole unit; `last` breaks timestamp ties by insert order.
 */
export async function windowAggregate(
  tx: Tx,
  itemId: string,
  w: UsageWindow,
  mode: UsageAggregation,
): Promise<bigint> {
  const q = usageRecords.quantity;
  const expr =
    mode === "max"
      ? sql<string>`coalesce(max(${q}), 0)`
      : mode === "min"
        ? sql<string>`coalesce(min(${q}), 0)`
        : mode === "count"
          ? sql<string>`count(*)`
          : mode === "avg"
            ? sql<string>`coalesce(round(avg(${q})), 0)`
            : mode === "unique"
              ? sql<string>`count(distinct ${usageRecords.uniqueKey})`
              : mode === "last"
                ? sql<string>`coalesce((array_agg(${q} order by ${usageRecords.timestamp} desc, ${usageRecords.createdAt} desc, ${usageRecords.id} desc))[1], 0)`
                : sql<string>`coalesce(sum(${q}), 0)`;
  const [row] = await tx
    .select({ value: expr })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.subscriptionItemId, itemId),
        eq(usageRecords.operation, "add"),
        gte(usageRecords.timestamp, w.start),
        lt(usageRecords.timestamp, w.end),
      ),
    );
  return BigInt(row?.value ?? 0);
}
