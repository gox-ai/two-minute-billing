// Relative imports only: a root unit test imports this file, where `@/` points at `src/`.
import { toMajor } from "../../lib/money";

/** True when a series has nothing to draw: every bucket is a gap or a zero. */
export function isBlankSeries(values: ReadonlyArray<number | null | undefined>): boolean {
  return values.every((v) => v == null || !Number.isFinite(v) || v === 0);
}

/**
 * The smallest step a value axis may tick by. A count never ticks in halves, and a money
 * axis never ticks below one unit of its currency (that printed "0" at every tick).
 */
export function axisMinInterval(kind: "money" | "count" | "percent", currency = "USD") {
  if (kind === "count") return 1;
  if (kind === "money") return Math.max(1, Math.round(1 / toMajor(1, currency)));
  return undefined;
}

/** "Credits used" → "No credits used in this period." An acronym keeps its case. */
export function blankSeriesNote(seriesLabel: string): string {
  const lead = /^[A-Z][a-z]/.test(seriesLabel)
    ? seriesLabel.charAt(0).toLowerCase() + seriesLabel.slice(1)
    : seriesLabel;
  return `No ${lead} in this period.`;
}

/**
 * Where a waterfall's opening and closing bars stand. Zero when that leaves the movement
 * readable (the swing is a quarter of the lowest total or more); else a broken axis two swings
 * under the lowest total, so a 1% month still shows. `broken` asks for the break mark, since
 * a cut bar must never pass for a whole one.
 */
export function waterfallFloor(lo: number, hi: number): { floor: number; broken: boolean } {
  if (lo <= 0) return { floor: Math.min(0, lo), broken: false };
  const swing = hi - lo || Math.abs(hi) * 0.05 || 1;
  const floor = lo - 2 * swing;
  if (floor <= lo * 0.5) return { floor: 0, broken: false };
  return { floor, broken: true };
}

/**
 * The share of each bucket's attempts that succeeded, 0–1. A bucket with no attempts has no
 * rate, not a zero one.
 */
export function successRates(
  attempts: ReadonlyArray<number | null>,
  failures: ReadonlyArray<number | null>,
): Array<number | null> {
  return attempts.map((a, i) => (a != null && a > 0 ? (a - (failures[i] ?? 0)) / a : null));
}

/**
 * A sparkline's vertical range, data min to max. With `minSpan` the range is never narrower,
 * so on a rate a one-point dip stays a small dip and a flat run sits at the top.
 */
export function sparkRange(values: ReadonlyArray<number>, minSpan = 0): { lo: number; hi: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (minSpan > 0 && hi - lo < minSpan) return { lo: hi - minSpan, hi };
  return { lo, hi: hi > lo ? hi : lo + 1 };
}
