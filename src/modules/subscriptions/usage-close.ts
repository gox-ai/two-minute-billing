/**
 * The usage grace window (`businesses.usage_close_delay_minutes`, 0454 / 0523), in one place.
 * Pure: the renewal, the close scan, the API and the settings screen all read it from here.
 *
 * A metered renewal runs at the boundary + `USAGE_CLOSE_BASE_MINUTES`. With a grace, its
 * invoice is a held pending draft that finalizes at the boundary + base + effective grace.
 */
import type { Interval } from "./interval";

/** Usage closes this many minutes after a period ends, before any grace. */
export const USAGE_CLOSE_BASE_MINUTES = 6;
/** The largest grace a business can set: 30 days. */
export const USAGE_GRACE_MAX_MINUTES = 43_200;

const MINUTE_MS = 60_000;

/** Nominal minutes in one interval: a month counts 28 days, so the cap holds in February. */
export function nominalIntervalMinutes(unit: Interval | string | null, count?: number | null) {
  const c = Math.max(1, count ?? 1);
  const day = 1_440;
  switch (unit ?? "month") {
    case "day":
      return day * c;
    case "week":
      return 7 * day * c;
    case "year":
      return 365 * day * c;
    default:
      return 28 * day * c;
  }
}

/**
 * The grace that applies: the configured value, never more than half the plan interval or
 * half the term it runs into. So a held invoice always closes before the next boundary.
 */
export function effectiveUsageGraceMinutes(
  configured: number,
  interval: { unit: Interval | string | null; count?: number | null },
  termMinutes?: number,
): number {
  const set = Math.max(0, Math.floor(configured));
  if (set === 0) return 0;
  const halves = [Math.floor(nominalIntervalMinutes(interval.unit, interval.count) / 2)];
  if (termMinutes != null) halves.push(Math.floor(Math.max(0, termMinutes) / 2));
  return Math.max(0, Math.min(set, ...halves));
}

/** Minutes between two instants, floored. */
export function minutesBetween(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / MINUTE_MS);
}

/** When usage of the period ending at `boundary` closes: boundary + base + grace. */
export function usageCloseAt(boundary: Date, graceMinutes: number): Date {
  return new Date(boundary.getTime() + (USAGE_CLOSE_BASE_MINUTES + graceMinutes) * MINUTE_MS);
}

/** The effective grace per plan interval, for the API and the settings screen. */
export function effectiveGraceByInterval(
  configured: number,
  intervals: Array<{ unit: Interval | string; count: number }>,
): Array<{ unit: string; count: number; minutes: number; capped: boolean }> {
  return intervals.map((i) => {
    const minutes = effectiveUsageGraceMinutes(configured, i);
    return { unit: i.unit, count: i.count, minutes, capped: minutes < configured };
  });
}
