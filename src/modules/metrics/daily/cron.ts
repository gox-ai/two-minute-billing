/**
 * The cron bodies for `metric_daily` (0267): yesterday's close and today's running value.
 *
 * Per business: one business's failure is logged and skipped, not allowed to cost the
 * estate its day (or its current value).
 */
import { eq } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { businesses, subscriptions } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { computeMetricPeriod } from "./compute";
import { writeMetricDay } from "./write";
import type { Grain } from "./measures";
import { zonedDayString } from "@/platform/timezones";
import { calendarOf, periodEndOf, type BusinessCalendar } from "@/platform/business-calendar";

const log = createLogger("metrics.daily.cron");

/** A business this pass writes: its tenant, and the zone its calendar days are cut on. */
export interface CronBusiness {
  id: string;
  organizationId: string;
  /** null means UTC — the column's default, and what such a business has always used. */
  timezone: string | null;
  /** Where its weeks, quarters and years are cut (0293). */
  calendar: BusinessCalendar;
}

/** Only businesses that HAVE a subscription — a business with none writes nothing anyway. */
export async function businessesWithSubscriptions(): Promise<CronBusiness[]> {
  const rows = await systemDb
    .selectDistinct({
      id: businesses.id,
      organizationId: businesses.organizationId,
      timezone: businesses.timezone,
      weekStart: businesses.weekStart,
      fiscalYearStartMonth: businesses.fiscalYearStartMonth,
    })
    .from(businesses)
    .innerJoin(subscriptions, eq(subscriptions.businessId, businesses.id));
  return rows.map(({ weekStart, fiscalYearStartMonth, ...b }) => ({
    ...b,
    calendar: calendarOf({ weekStart, fiscalYearStartMonth }),
  }));
}

/**
 * THE DAY IS PER BUSINESS, not per pass.
 *
 * `now` is one instant; the calendar date it falls on is not. At 20:00 UTC it is already
 * tomorrow in Asia/Kolkata and still today in America/Chicago, so a single global day
 * string writes one of them under the wrong key — and either side of the date line, always
 * the wrong one. Each business is asked which day it is for IT.
 */
export const dayFor = (b: CronBusiness, at: Date): string => zonedDayString(at, b.timezone);

async function writeMetricDayForAll(
  dayOf: (b: CronBusiness) => string,
  event: string,
): Promise<{ businesses: number; failed: number }> {
  const rows = await businessesWithSubscriptions();
  let failed = 0;
  for (const b of rows) {
    const day = dayOf(b);
    try {
      const metricRows = await withTenant(b.organizationId, (tx) =>
        computeMetricPeriod(tx, b.id, "day", day, new Date(), { timezone: b.timezone }),
      );
      await writeMetricDay({
        organizationId: b.organizationId,
        businessId: b.id,
        grain: "day",
        periodEnd: day,
        rows: metricRows,
      });
    } catch (e) {
      failed++;
      log.error("metric_daily write failed for one business", {
        event: `${event}_failed`,
        businessId: b.id,
        day,
        error_message: (e as Error).message,
      });
    }
  }
  const fields = { event, businesses: rows.length - failed, failed };
  // Today's pass runs every 5 minutes; a clean one is `debug`. The nightly pass and any
  // failure stay `info`.
  if (failed > 0 || event !== "metric_daily_today_written")
    log.info("metric_daily written", fields);
  else log.debug("metric_daily written", fields);
  return { businesses: rows.length - failed, failed };
}

/**
 * The END of the period of each coarser grain that contains `day`, on the business's own
 * calendar (week start, fiscal year). The end may be in the FUTURE while the period is still
 * running — that is the point: the row sits at the key a reader will ask for, and every night
 * restates it until it closes.
 */
export function coarsePeriodEnds(day: string, calendar: BusinessCalendar): Array<[Grain, string]> {
  return (["week", "month", "quarter", "year"] as const).map((g) => [
    g,
    periodEndOf(g, day, calendar),
  ]);
}

/**
 * THE PER-GRAIN WRITE — the path a distinct count cannot do without.
 *
 * Everything additive is stored once, daily, and folded up at read. A head count cannot be:
 * an account present in January and in February is one account over the two months, so the
 * week, month, quarter and year have to be COMPUTED, each over its own window, and stored
 * under their own `grain`. `onlyNonAdditive` limits the pass to exactly those measures.
 *
 * Run nightly rather than on the five-minute pass: four extra windows per business is real
 * work, and the coarse periods are for charts, not for a live tile. A period still running
 * is restated every night under the key it will close on.
 */
async function writeCoarseGrains(day: string, b: CronBusiness): Promise<void> {
  for (const [grain, periodEnd] of coarsePeriodEnds(day, b.calendar)) {
    const rows = await withTenant(b.organizationId, (tx) =>
      computeMetricPeriod(tx, b.id, grain, periodEnd, new Date(), {
        onlyNonAdditive: true,
        timezone: b.timezone,
      }),
    );
    if (rows.length === 0) continue;
    await writeMetricDay({
      organizationId: b.organizationId,
      businessId: b.id,
      grain,
      periodEnd,
      rows,
    });
  }
}

/**
 * YESTERDAY's close — the nightly job's addition to the snapshot write.
 *
 * "Yesterday" is the day before TODAY IN THIS BUSINESS'S ZONE, not `now - 24h` read in UTC.
 * Subtracting a fixed 86,400,000 ms would also name the wrong day on the two days a year
 * the local day is 23 or 25 hours long.
 */
export async function writeMetricDayForYesterday(now: Date) {
  const yesterdayFor = (b: CronBusiness): string => {
    const today = dayFor(b, now);
    const d = new Date(`${today}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const result = await writeMetricDayForAll(yesterdayFor, "metric_daily_yesterday_written");
  let coarseFailed = 0;
  for (const b of await businessesWithSubscriptions()) {
    const day = yesterdayFor(b);
    try {
      await writeCoarseGrains(day, b);
    } catch (e) {
      coarseFailed++;
      log.error("metric_daily coarse grains failed for one business", {
        event: "metric_daily_coarse_failed",
        businessId: b.id,
        day,
        error_message: (e as Error).message,
      });
    }
  }
  log.info("metric_daily coarse grains written", {
    event: "metric_daily_coarse_written",
    failed: coarseFailed,
  });
  return result;
}

/** TODAY, recomputed — still moving, so every 5-minute pass restates it. */
export async function writeMetricDayForToday(now: Date) {
  return writeMetricDayForAll((b) => dayFor(b, now), "metric_daily_today_written");
}
