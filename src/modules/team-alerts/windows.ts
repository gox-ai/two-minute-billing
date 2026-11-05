/** The time windows every team alert is cut from. Pure. */
import { zonedDayStart, zonedDayString } from "@/platform/timezones";
import { DIGEST_LOCAL_HOUR } from "./config";

const HOUR_MS = 3_600_000;

/** The top of the hour a run is for. Every window is derived from it. */
export function alertHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Due dates one to two hours back: the hour of slack lets the due pass collect an
 * auto-charged invoice before we call it overdue.
 */
export function overdueWindow(hour: Date): { start: Date; end: Date } {
  return { start: new Date(hour.getTime() - 2 * HOUR_MS), end: new Date(hour.getTime() - HOUR_MS) };
}

/**
 * Deliveries whose last attempt started one to two hours back. `last_attempt_at` is the
 * pass start and `failed` commits up to ~90 s later, so a window ending at `hour` could
 * read a delivery before its status lands and never see it again.
 */
export function webhookWindow(hour: Date): { start: Date; end: Date } {
  return { start: new Date(hour.getTime() - 2 * HOUR_MS), end: new Date(hour.getTime() - HOUR_MS) };
}

function localHour(at: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" })
    .formatToParts(at)
    .find((p) => p.type === "hour")?.value;
  return Number(h ?? 0);
}

/**
 * The local day a digest sent at `hour` covers — the day before — or null when `hour` is not
 * the digest hour in `tz`. Each local day has exactly one top-of-hour UTC instant whose local
 * hour is the digest hour, half-hour zones included.
 */
export function digestDay(
  hour: Date,
  tz: string,
): { day: string; start: Date; end: Date; today: string } | null {
  if (localHour(hour, tz) !== DIGEST_LOCAL_HOUR) return null;
  const today = zonedDayString(hour, tz);
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  return { day, start: zonedDayStart(day, tz), end: zonedDayStart(today, tz), today };
}
