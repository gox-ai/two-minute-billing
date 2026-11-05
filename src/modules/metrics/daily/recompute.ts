import { and, eq, inArray, min } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { businesses, metricDaily } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { zonedDayString } from "@/platform/timezones";
import { bulkFillCoarseGrains, bulkFillMetricDays } from "./bulk-fill";
import { invalidateSeriesCache } from "./series-cache";
import { businessCalendar } from "@/platform/business-calendar";
import type { Grain } from "./measures";

const log = createLogger("metrics.daily.recompute");

/** Days the table already holds for this business, at the `day` grain. */
async function storedSpan(businessId: string): Promise<string | null> {
  const [row] = await systemDb
    .select({ first: min(metricDaily.periodEnd) })
    .from(metricDaily)
    .where(and(eq(metricDaily.businessId, businessId), eq(metricDaily.grain, "day")));
  return row?.first ?? null;
}

/**
 * Restate every stored day of `metric_daily` for one business, on its CURRENT timezone.
 *
 * Called when that timezone changes. A row's `period_end` is a local calendar date and its
 * window is that date's local midnights, so the stored rows answer a question the business
 * has stopped asking — the only fix is to compute them again.
 *
 * Runs through `bulkFillMetricDays`, which is the same `computeMetricPeriod` the nightly
 * close runs, over a transaction that answers a standing read once per slice. A business
 * with nothing stored does nothing.
 */
export async function recomputeMetricDailyForBusiness(
  businessId: string,
): Promise<{ days: number; rows: number }> {
  const [b] = await systemDb
    .select({
      id: businesses.id,
      organizationId: businesses.organizationId,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!b) throw new Error(`recomputeMetricDailyForBusiness: no such business ${businessId}`);

  const first = await storedSpan(businessId);
  if (!first) {
    log.info("nothing stored for this business — nothing to recompute", {
      event: "metric_daily_recompute_empty",
      businessId,
    });
    return { days: 0, rows: 0 };
  }

  // Inclusive of today: the day in progress is stored too, and it was cut on the old
  // boundary like every other.
  const today = zonedDayString(new Date(), b.timezone);
  const days: string[] = [];
  const cursor = new Date(`${first}T00:00:00.000Z`);
  const last = new Date(`${today}T00:00:00.000Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const r = await bulkFillMetricDays({
    organizationId: b.organizationId,
    businessId: b.id,
    grain: "day",
    days,
    write: true,
    timezone: b.timezone,
    // A day cut on a new boundary can lose a whole group; replace, do not merge.
    replaceComputed: true,
  });
  return { days: r.days, rows: r.rows };
}

/** The grains a calendar change re-cuts: weeks for `week_start`, quarters and years for the fiscal year. */
export type CalendarGrain = Extract<Grain, "week" | "quarter" | "year">;

/**
 * Re-cut the stored coarse rows of one business on its CURRENT calendar.
 *
 * A week/quarter/year row is keyed at its period end, so a new week start or fiscal year
 * leaves every old row at a key that is no longer a period end. They are deleted, then the
 * periods covering the stored day span are computed again. Only the named grains move.
 */
export async function recomputeCoarseGrainsForBusiness(
  businessId: string,
  grains: readonly CalendarGrain[],
): Promise<{ periods: number; rows: number }> {
  const [b] = await systemDb
    .select({
      id: businesses.id,
      organizationId: businesses.organizationId,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!b) throw new Error(`recomputeCoarseGrainsForBusiness: no such business ${businessId}`);
  if (grains.length === 0) return { periods: 0, rows: 0 };

  const first = await storedSpan(businessId);
  await withTenant(b.organizationId, (tx) =>
    tx
      .delete(metricDaily)
      .where(and(eq(metricDaily.businessId, b.id), inArray(metricDaily.grain, [...grains]))),
  );
  invalidateSeriesCache(b.id);
  if (!first) return { periods: 0, rows: 0 };

  const today = zonedDayString(new Date(), b.timezone);
  const days: string[] = [];
  for (
    const d = new Date(`${first}T00:00:00.000Z`);
    d.getTime() <= Date.parse(`${today}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(d.toISOString().slice(0, 10));
  }
  const calendar = await withTenant(b.organizationId, (tx) => businessCalendar(tx, b.id));
  const r = await bulkFillCoarseGrains({
    organizationId: b.organizationId,
    businessId: b.id,
    days,
    write: true,
    grains,
    timezone: b.timezone,
    calendar,
  });
  return { periods: r.periods, rows: r.rows };
}

/**
 * Restate one business from `since` (a business-local date) to today, in place: the day rows,
 * then every coarse period covering those days. Nothing is deleted first, so the grains stay
 * readable throughout — `writeMetricDay` replaces each period's rows as it writes them. For a
 * change of WHAT is counted (a customer excluded from reporting), not of where periods fall.
 */
export async function restateMetricsFrom(
  businessId: string,
  since: string,
): Promise<{ days: number; periods: number }> {
  const [b] = await systemDb
    .select({
      id: businesses.id,
      organizationId: businesses.organizationId,
      timezone: businesses.timezone,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!b) throw new Error(`restateMetricsFrom: no such business ${businessId}`);
  const first = await storedSpan(businessId);
  if (!first) return { days: 0, periods: 0 };
  const start = since > first ? since : first;
  const today = zonedDayString(new Date(), b.timezone);
  const days: string[] = [];
  for (
    const d = new Date(`${start}T00:00:00.000Z`);
    d.getTime() <= Date.parse(`${today}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    days.push(d.toISOString().slice(0, 10));
  }
  if (days.length === 0) return { days: 0, periods: 0 };
  const dayFill = await bulkFillMetricDays({
    organizationId: b.organizationId,
    businessId: b.id,
    grain: "day",
    days,
    write: true,
    timezone: b.timezone,
    replaceComputed: true,
  });
  const calendar = await withTenant(b.organizationId, (tx) => businessCalendar(tx, b.id));
  const coarse = await bulkFillCoarseGrains({
    organizationId: b.organizationId,
    businessId: b.id,
    days,
    write: true,
    timezone: b.timezone,
    calendar,
    replaceComputed: true,
  });
  invalidateSeriesCache(b.id);
  return { days: dayFill.days, periods: coarse.periods };
}
