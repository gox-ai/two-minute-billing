/**
 * The level math for recurring and time-weighted usage. Pure: callers load the events.
 *
 * L(t) is the level after every event at or before t. Events arrive ordered by
 * (timestamp, created_at, id); events that share a timestamp apply together, so a swap
 * at one instant (remove A, add B) never shows as two seats.
 */

export interface LevelEvent {
  /** Epoch ms. */
  at: number;
  quantity: bigint;
  uniqueKey: string | null;
  operation: "add" | "remove";
}

export interface Level {
  /** The level at the window start, from all earlier events. */
  carriedIn: bigint;
  /** The level at the window end. */
  closing: bigint;
  /** The highest level inside the window. */
  peak: bigint;
}

export interface LevelResult extends Level {
  /** The billed quantity. Never below 0. */
  quantity: bigint;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const nonNegative = (v: bigint) => (v > 0n ? v : 0n);

/** Apply add/remove ops to a key set. A repeated add, or a remove of an absent key, does nothing. */
export function applyUniqueOps(keys: Set<string>, events: readonly LevelEvent[]): Set<string> {
  for (const e of events) {
    if (e.uniqueKey == null) continue;
    if (e.operation === "remove") keys.delete(e.uniqueKey);
    else keys.add(e.uniqueKey);
  }
  return keys;
}

/**
 * Walk the window's events, in order, from the carried-in level. `step` returns the level
 * after one event. The peak is read once per timestamp, and the carried-in level counts
 * only if it held for some time inside the window (no event at the window start).
 */
function walk(
  carriedIn: bigint,
  events: readonly LevelEvent[],
  startMs: number,
  step: (level: bigint, e: LevelEvent) => bigint,
  onSegment?: (level: bigint, fromMs: number, toMs: number) => void,
): Level {
  let level = carriedIn;
  let peak: bigint | null = events.length === 0 || events[0]!.at > startMs ? carriedIn : null;
  let since = startMs;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.at > since) onSegment?.(level, since, e.at);
    since = Math.max(since, e.at);
    level = step(level, e);
    const next = events[i + 1];
    if (!next || next.at !== e.at) peak = peak == null ? level : max(peak, level);
  }
  return { carriedIn, closing: level, peak: peak ?? level };
}

/**
 * A recurring level over `[start, end)`. `sum`: events are deltas, bills the peak. `last`:
 * events are absolute levels, bills the closing level. `max`: absolute levels, bills the
 * peak. `unique`: add/remove of keys, bills the peak count of active keys.
 */
export function recurringLevel(input: {
  aggregation: "sum" | "last" | "max" | "unique";
  /** The level from events before the window (for `unique`, use `activeKeys`). */
  carriedIn: bigint;
  /** `unique` only: the keys active at the window start. */
  activeKeys?: Set<string>;
  /** The window's events, ordered. */
  events: readonly LevelEvent[];
  startMs: number;
}): LevelResult {
  const { aggregation, events, startMs } = input;
  if (aggregation === "unique") {
    const keys = new Set(input.activeKeys ?? []);
    const lvl = walk(BigInt(keys.size), events, startMs, (_l, e) => {
      applyUniqueOps(keys, [e]);
      return BigInt(keys.size);
    });
    return { ...lvl, quantity: nonNegative(lvl.peak) };
  }
  const lvl = walk(input.carriedIn, events, startMs, (l, e) =>
    aggregation === "sum" ? l + e.quantity : e.quantity,
  );
  return { ...lvl, quantity: nonNegative(aggregation === "last" ? lvl.closing : lvl.peak) };
}

/**
 * Time-weighted usage: ∫ max(0, L(t)) dt over `[start, end)` in unit-ms, divided by the
 * unit and rounded half-up once. Events are deltas; `carriedIn` is 0 when not recurring.
 */
export function timeWeightedLevel(input: {
  carriedIn: bigint;
  events: readonly LevelEvent[];
  startMs: number;
  endMs: number;
  unitMs: number;
}): LevelResult {
  let integral = 0n;
  const add = (level: bigint, fromMs: number, toMs: number) => {
    if (toMs > fromMs) integral += nonNegative(level) * BigInt(toMs - fromMs);
  };
  const lvl = walk(input.carriedIn, input.events, input.startMs, (l, e) => l + e.quantity, add);
  const lastAt = input.events.length
    ? Math.max(input.startMs, input.events.at(-1)!.at)
    : input.startMs;
  add(lvl.closing, lastAt, input.endMs);
  const unit = BigInt(input.unitMs);
  return { ...lvl, quantity: (integral + unit / 2n) / unit };
}
