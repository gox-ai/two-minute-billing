import { eq } from "drizzle-orm";
import { businesses } from "@db/schema";
import type { Tx } from "@/platform/db";

/**
 * A business's reporting calendar: the day its week starts and the month its fiscal year
 * starts (0293). The single source of truth for every week, quarter and year boundary the
 * analytics engine cuts — stored coarse rows, API buckets and named windows all call these.
 *
 * All arithmetic is on `YYYY-MM-DD` calendar dates that are ALREADY the business's own local
 * dates; a timezone never enters here.
 *
 * Fiscal labels name the year a fiscal year ENDS in: with an April start, Apr 2026 – Mar 2027
 * is "FY2027" and its first quarter "Q1 FY2027". A January start keeps plain calendar labels.
 */

export const WEEK_STARTS = ["sunday", "monday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export interface BusinessCalendar {
  weekStart: WeekStart;
  /** 1–12; 1 is the calendar year. */
  fiscalYearStartMonth: number;
}

export const DEFAULT_CALENDAR: BusinessCalendar = Object.freeze({
  weekStart: "sunday",
  fiscalYearStartMonth: 1,
});

type CalendarGrain = "day" | "week" | "month" | "quarter" | "year";

/** A calendar from a `businesses` row; anything unrecognised falls back to the defaults. */
export function calendarOf(
  row: { weekStart?: string | null; fiscalYearStartMonth?: number | null } | null | undefined,
): BusinessCalendar {
  const ws = row?.weekStart;
  const fy = row?.fiscalYearStartMonth;
  return {
    weekStart: ws === "monday" || ws === "sunday" ? ws : DEFAULT_CALENDAR.weekStart,
    fiscalYearStartMonth:
      fy != null && Number.isInteger(fy) && fy >= 1 && fy <= 12
        ? fy
        : DEFAULT_CALENDAR.fiscalYearStartMonth,
  };
}

export const sameCalendar = (a: BusinessCalendar, b: BusinessCalendar): boolean =>
  a.weekStart === b.weekStart && a.fiscalYearStartMonth === b.fiscalYearStartMonth;

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
/** Last day of the month `m0` (0-based, may overflow) of year `y`. */
const monthEnd = (y: number, m0: number) => iso(new Date(Date.UTC(y, m0 + 1, 0)));

/** The last day of the week containing `day`. */
export function weekEnd(day: string, weekStart: WeekStart): string {
  const first = weekStart === "monday" ? 1 : 0;
  const into = (utc(day).getUTCDay() - first + 7) % 7;
  return addDays(day, 6 - into);
}

/** The first day of the week containing `day`. */
export function weekStartDate(day: string, weekStart: WeekStart): string {
  return addDays(weekEnd(day, weekStart), -6);
}

/** Months (0–11) into its fiscal year that `day` falls. */
function fiscalMonthIndex(day: string, fyStart: number): number {
  return (utc(day).getUTCMonth() - (fyStart - 1) + 12) % 12;
}

/** The last day of the fiscal quarter containing `day`. */
export function fiscalQuarterEnd(day: string, fyStart: number): string {
  const d = utc(day);
  const idx = fiscalMonthIndex(day, fyStart);
  return monthEnd(d.getUTCFullYear(), d.getUTCMonth() + (2 - (idx % 3)));
}

/** The last day of the fiscal year containing `day`. */
export function fiscalYearEnd(day: string, fyStart: number): string {
  const d = utc(day);
  return monthEnd(d.getUTCFullYear(), d.getUTCMonth() + (11 - fiscalMonthIndex(day, fyStart)));
}

/** The last day of the `grain` period containing `day` — the key a coarse row is stored at. */
export function periodEndOf(grain: CalendarGrain, day: string, cal: BusinessCalendar): string {
  if (grain === "day") return day;
  if (grain === "week") return weekEnd(day, cal.weekStart);
  if (grain === "quarter") return fiscalQuarterEnd(day, cal.fiscalYearStartMonth);
  if (grain === "year") return fiscalYearEnd(day, cal.fiscalYearStartMonth);
  const d = utc(day);
  return monthEnd(d.getUTCFullYear(), d.getUTCMonth());
}

/** The first day of the `grain` period containing `day`. */
export function periodStartOf(grain: CalendarGrain, day: string, cal: BusinessCalendar): string {
  if (grain === "day") return day;
  if (grain === "week") return weekStartDate(day, cal.weekStart);
  const end = utc(periodEndOf(grain, day, cal));
  const months = grain === "month" ? 1 : grain === "quarter" ? 3 : 12;
  return iso(new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (months - 1), 1)));
}

/** The fiscal year `day` falls in, named by the calendar year it ends in. */
export function fiscalYearOf(day: string, fyStart: number): number {
  return utc(fiscalYearEnd(day, fyStart)).getUTCFullYear();
}

/** "Q1 2026" on a calendar year; "Q1 FY2027" on a fiscal one. */
export function quarterLabel(day: string, fyStart: number): string {
  const q = Math.floor(fiscalMonthIndex(day, fyStart) / 3) + 1;
  const y = fiscalYearOf(day, fyStart);
  return fyStart === 1 ? `Q${q} ${y}` : `Q${q} FY${y}`;
}

/** "2026" on a calendar year; "FY2027" on a fiscal one. */
export function yearLabel(day: string, fyStart: number): string {
  const y = fiscalYearOf(day, fyStart);
  return fyStart === 1 ? `${y}` : `FY${y}`;
}

/** One primary-key lookup; not cached, so a settings change takes effect at once. */
export async function businessCalendar(tx: Tx, businessId: string): Promise<BusinessCalendar> {
  const [b] = await tx
    .select({
      weekStart: businesses.weekStart,
      fiscalYearStartMonth: businesses.fiscalYearStartMonth,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  return calendarOf(b);
}
