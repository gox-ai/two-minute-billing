import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { businessTimezone } from "@/platform/business-tz";
import { businessCalendar, type WeekStart } from "@/platform/business-calendar";

/**
 * Calendar-relative reporting ranges — the vocabulary the payments dashboards
 * use (Current Day / Yesterday / This Week / Previous Week / This Month /
 * Last Month).
 *
 * This lives ALONGSIDE `analytics.ts`'s rolling ranges (`daily|3m|6m|12m`), it
 * does not replace them: "the last 60 days" and "this month" are different
 * questions and one cannot be relabelled as the other.
 *
 * ## Why the resolution happens in Postgres
 * Every boundary is a *wall-clock* boundary in the BUSINESS timezone — "this
 * week" in UTC is the wrong week for half the world, and a business in
 * Asia/Kolkata closes its day 5h30m before UTC does. Doing the arithmetic in JS
 * would mean re-implementing DST; Postgres already has it:
 *
 *   date_trunc('week', now() AT TIME ZONE tz)   -- local wall clock, week start 00:00
 *   … AT TIME ZONE tz                            -- back to the real instant
 *
 * The week starts on the business's `week_start` (0293); see `weekTruncShift`.
 *
 * `+ interval '1 month'` / `'7 days'` applied to the *local* timestamp keeps the
 * same wall clock across a DST transition, which is what a business means by
 * "the previous week"; converting to an instant afterwards makes that period 23
 * or 25 hours long where the clocks actually moved. That is correct.
 *
 * ## Previous period
 * Every tile on these dashboards shows a delta, so a range is useless without
 * its comparable. Each range's previous period is the immediately preceding
 * period of the SAME calendar unit, so `previous.end === current.start` always
 * holds (the two windows tile, no gap and no overlap) and February is compared
 * against January rather than against "28 days ago".
 */

export type CalendarRange =
  | "current_day"
  | "yesterday"
  | "this_week"
  | "previous_week"
  | "this_month"
  | "last_month";

export const CALENDAR_RANGES: CalendarRange[] = [
  "current_day",
  "yesterday",
  "this_week",
  "previous_week",
  "this_month",
  "last_month",
];

export const isCalendarRange = (v: unknown): v is CalendarRange =>
  typeof v === "string" && (CALENDAR_RANGES as string[]).includes(v);

/** Chart bucket granularity — a day is read hour-by-hour, longer spans day-by-day. */
export type BucketGranularity = "hour" | "day";

/** Half-open window: `start <= t < end`. */
export interface Period {
  start: Date;
  end: Date;
}

export interface ResolvedRange {
  range: CalendarRange;
  /** IANA zone the boundaries were resolved in (the business's, `UTC` by default). */
  timezone: string;
  label: string;
  prev_label: string;
  granularity: BucketGranularity;
  current: Period;
  previous: Period;
}

interface RangeShape {
  /** `date_trunc` unit that defines the period. */
  unit: "day" | "week" | "month";
  /** One period's length, as a Postgres interval applied to a LOCAL timestamp. */
  step: string;
  /** How many periods back from the truncated `now` the current window sits. */
  offset: number;
  label: string;
  prevLabel: string;
  granularity: BucketGranularity;
}

/**
 * `date_trunc('week', …)` always lands on Monday, so a Sunday week is truncated one day
 * later and shifted back: `date_trunc('week', t + 1 day) - 1 day`.
 */
export const weekTruncShift = (weekStart: WeekStart): string =>
  weekStart === "sunday" ? "1 day" : "0 days";

const SHAPES: Record<CalendarRange, RangeShape> = {
  current_day: {
    unit: "day",
    step: "1 day",
    offset: 0,
    label: "Current Day",
    prevLabel: "Yesterday",
    granularity: "hour",
  },
  yesterday: {
    unit: "day",
    step: "1 day",
    offset: -1,
    label: "Yesterday",
    prevLabel: "Previous Day",
    granularity: "hour",
  },
  this_week: {
    unit: "week",
    step: "7 days",
    offset: 0,
    label: "This Week",
    prevLabel: "Previous Week",
    granularity: "day",
  },
  previous_week: {
    unit: "week",
    step: "7 days",
    offset: -1,
    label: "Previous Week",
    prevLabel: "Week Before",
    granularity: "day",
  },
  this_month: {
    unit: "month",
    step: "1 month",
    offset: 0,
    label: "This Month",
    prevLabel: "Last Month",
    granularity: "day",
  },
  last_month: {
    unit: "month",
    step: "1 month",
    offset: -1,
    label: "Last Month",
    prevLabel: "Month Before",
    granularity: "day",
  },
};

/** Bucket width per granularity, as a Postgres interval. */
const BUCKET_STEP: Record<BucketGranularity, string> = { hour: "1 hour", day: "1 day" };

/**
 * Resolve a calendar range (and its comparable previous period) into instants,
 * in the business's timezone.
 */
export async function resolveCalendarRange(
  tx: Tx,
  businessId: string,
  range: CalendarRange,
  now: Date = new Date(),
): Promise<ResolvedRange> {
  const tz = await businessTimezone(tx, businessId);
  const shape = SHAPES[range];
  const shift =
    shape.unit === "week"
      ? weekTruncShift((await businessCalendar(tx, businessId)).weekStart)
      : "0 days";

  // `anchor` is the local wall clock at the start of the *current* period; the
  // three sibling boundaries are one `step` away from it in local time.
  const res = await tx.execute(sql`
    with anchor as (
      select date_trunc(${shape.unit}, (${now.toISOString()}::timestamptz at time zone ${tz}) + ${shift}::interval)
             - ${shift}::interval
             + (${shape.offset}::int * ${shape.step}::interval) as s
    )
    select (s at time zone ${tz})                        as current_start,
           ((s + ${shape.step}::interval) at time zone ${tz}) as current_end,
           ((s - ${shape.step}::interval) at time zone ${tz}) as previous_start,
           (s at time zone ${tz})                        as previous_end
    from anchor
  `);
  const row = (res as unknown as Array<Record<string, Date>>)[0]!;

  return {
    range,
    timezone: tz,
    label: shape.label,
    prev_label: shape.prevLabel,
    granularity: shape.granularity,
    current: { start: new Date(row.current_start!), end: new Date(row.current_end!) },
    previous: { start: new Date(row.previous_start!), end: new Date(row.previous_end!) },
  };
}

export interface RangeBucket {
  /** Local wall-clock key, `YYYY-MM-DD HH24:MI` — matches `bucketKeySql`. */
  key: string;
  /** ISO-ish local bucket start: `YYYY-MM-DD` (day) or `YYYY-MM-DDTHH:MM` (hour). */
  t: string;
  /** Short axis label, e.g. `Aug 1` / `14:00`. */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Turn a `YYYY-MM-DD HH24:MI` local key into the point's `t` + axis label. */
function describeBucket(key: string, granularity: BucketGranularity): { t: string; label: string } {
  const [date = "", time = "00:00"] = key.split(" ");
  if (granularity === "hour") return { t: `${date}T${time}`, label: time };
  const [, mm = "01", dd = "01"] = date.split("-");
  const month = MONTHS[Number(mm) - 1] ?? "";
  return { t: date, label: `${month} ${Number(dd)}` };
}

/**
 * The chart buckets covering a period, in local wall-clock terms.
 *
 * Generated by Postgres over the LOCAL timestamps so a DST day yields 23 or 25
 * hourly buckets rather than a silently duplicated or missing hour, and so the
 * keys are byte-identical to what `bucketKeySql` produces for a row.
 */
export async function resolveBuckets(
  tx: Tx,
  period: Period,
  timezone: string,
  granularity: BucketGranularity,
): Promise<RangeBucket[]> {
  const step = BUCKET_STEP[granularity];
  const res = await tx.execute(sql`
    select to_char(gs, 'YYYY-MM-DD HH24:MI') as key
    from generate_series(
      (${period.start.toISOString()}::timestamptz at time zone ${timezone}),
      ((${period.end.toISOString()}::timestamptz at time zone ${timezone}) - interval '1 microsecond'),
      ${step}::interval
    ) gs
  `);
  return (res as unknown as Array<{ key: string }>).map((r) => ({
    key: r.key,
    ...describeBucket(r.key, granularity),
  }));
}

/**
 * SQL that buckets a `timestamptz` column into the same local wall-clock key
 * `resolveBuckets` emits. Use it in a `GROUP BY` — aggregation stays in Postgres.
 */
export function bucketKeySql(column: SQL, timezone: string, granularity: BucketGranularity): SQL {
  const unit = granularity === "hour" ? "hour" : "day";
  return sql`to_char(date_trunc(${unit}, (${column} at time zone ${timezone})), 'YYYY-MM-DD HH24:MI')`;
}
