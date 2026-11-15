// The engine's usage grace resolver, imported as-is so the settings screen shows the cap the
// renewal applies: one implementation, no copy to drift. Pure, safe in the browser.
import {
  USAGE_CLOSE_BASE_MINUTES,
  USAGE_GRACE_MAX_MINUTES,
  effectiveGraceByInterval,
  effectiveUsageGraceMinutes,
} from "../../src/modules/subscriptions/usage-close";

export {
  USAGE_CLOSE_BASE_MINUTES,
  USAGE_GRACE_MAX_MINUTES,
  effectiveGraceByInterval,
  effectiveUsageGraceMinutes,
};

/** "45 minutes", "3 hours", "2 days 4 hours". Whole minutes in, at most two parts out. */
export function formatGrace(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  const part = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const parts = [
    days ? part(days, "day") : null,
    hours ? part(hours, "hour") : null,
    mins ? part(mins, "minute") : null,
  ].filter((p): p is string => p != null);
  return parts.length ? parts.slice(0, 2).join(" ") : "0 minutes";
}

/** One plan billing period in words: "month", "3 months", "week". */
export function intervalLabel(unit: string, count: number): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

/** The units the wait is typed in, and their size in minutes. */
export const GRACE_UNITS = [
  { value: "minutes", minutes: 1 },
  { value: "hours", minutes: 60 },
  { value: "days", minutes: 1440 },
] as const;
export type GraceUnit = (typeof GRACE_UNITS)[number]["value"];

const unitMinutes = (unit: string): number | null =>
  GRACE_UNITS.find((u) => u.value === unit)?.minutes ?? null;

/** The largest number the field takes in `unit`: 43200 minutes, 720 hours, 30 days. */
export function graceUnitMax(unit: GraceUnit): number {
  return Math.floor(USAGE_GRACE_MAX_MINUTES / (unitMinutes(unit) ?? 1));
}

/** The largest unit that shows the stored minutes as a whole number. */
export function graceUnitFor(minutes: number): GraceUnit {
  if (minutes > 0 && minutes % 1440 === 0) return "days";
  if (minutes > 0 && minutes % 60 === 0) return "hours";
  return "minutes";
}

/**
 * The stored minutes for a typed "<value> <unit>", or null when the value is not a whole
 * number from 0 to 30 days. The form and the save action both call this, so the number
 * saved is always the number the screen showed.
 */
export function graceMinutesFrom(value: unknown, unit: unknown): number | null {
  const per = typeof unit === "string" ? unitMinutes(unit) : null;
  if (per == null) return null;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+$/.test(text.trim())) return null;
  const minutes = Number(text.trim()) * per;
  return minutes <= USAGE_GRACE_MAX_MINUTES ? minutes : null;
}

/** The distinct billing periods of the recurring prices, for the cap. */
export function recurringIntervals(
  prices: Array<{ type?: string | null; interval?: string | null; interval_count?: number | null }>,
): Array<{ unit: string; count: number }> {
  const seen = new Map<string, { unit: string; count: number }>();
  for (const p of prices)
    if (p.type === "recurring" && p.interval)
      seen.set(`${p.interval}:${p.interval_count ?? 1}`, {
        unit: p.interval,
        count: p.interval_count ?? 1,
      });
  return [...seen.values()];
}

/**
 * The shortest and longest wait that applies after the cap. With no recurring prices the
 * configured value is both: nothing lowers it.
 */
export function effectiveGraceRange(
  configured: number,
  intervals: Array<{ unit: string; count: number }>,
): { low: number; high: number } {
  if (!intervals.length) return { low: configured, high: configured };
  const m = effectiveGraceByInterval(configured, intervals).map((i) => i.minutes);
  return { low: Math.min(...m), high: Math.max(...m) };
}
