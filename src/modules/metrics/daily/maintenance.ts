/**
 * Keeping stored history true after the day it describes has closed.
 *
 * The nightly close writes only yesterday, but older days legitimately move: a backdated
 * cancellation, a refund of an old payment, a dunning outcome on last week's invoice. Two
 * scheduled passes cover that without a full backfill:
 *
 *  - `restateTrailingDays` recomputes the last 35 days, and the coarse periods containing
 *    them, so anything touching the past month repairs itself overnight. An OLDER day that
 *    received a backdated transaction or MRR movement since it was stored is restated too.
 *  - `scanMetricDrift` recomputes a few OLDER sampled days and records where the headline
 *    figures no longer match what is stored — history the restatement does not reach.
 *    `metric_daily_reproducible` (ops invariants) reads that record.
 */
import { and, eq, desc, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { opsInvariantResults, metricDaily } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { computeMetricPeriod } from "./compute";
import { bulkFillMetricDays, bulkFillCoarseGrains } from "./bulk-fill";
import { businessesWithSubscriptions, dayFor, type CronBusiness } from "./cron";

const log = createLogger("metrics.daily.maintenance");

export const TRAILING_DAYS = 35;
/** Well under the 1.6 GB a full backfill peaks at, on a box shared with billing. */
const MAX_CACHED_ROWS = 400_000;

const scoped = async (ids?: readonly string[]) => {
  const all = await businessesWithSubscriptions();
  return ids ? all.filter((b) => ids.includes(b.id)) : all;
};

const shift = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** How far back a late row's WRITE is looked for; older misses are the drift scan's. */
export const LATE_LOOKBACK_DAYS = 30;
/** Late days restated per business per night; the rest are found again the next night. */
export const MAX_LATE_DAYS = 60;

/**
 * Days older than the trailing window that gained a dated row after they were stored: an
 * offline refund or payment with a past date, a backdated cancel or reactivation. Only the
 * two logs that carry both an event date and a write date can show this.
 */
export async function lateDays(b: CronBusiness, now: Date): Promise<string[]> {
  const oldestTrailing = shift(dayFor(b, now), -TRAILING_DAYS);
  const since = new Date(now.getTime() - LATE_LOOKBACK_DAYS * 86_400_000).toISOString();
  const zone = b.timezone ?? "UTC";
  const rows = (await withTenant(b.organizationId, (tx) =>
    tx.execute(sql`
      with late as (
        select (occurred_at at time zone ${zone})::date as day, max(created_at) as written
        from transactions
        where business_id = ${b.id} and created_at >= ${since}::timestamptz
        group by 1
        union all
        select (occurred_at at time zone ${zone})::date, max(created_at)
        from mrr_movements
        where business_id = ${b.id} and created_at >= ${since}::timestamptz
        group by 1
      )
      select l.day::text as day
      from late l
      where l.day < ${oldestTrailing}::date
        and exists (
          select 1 from metric_daily md
          where md.business_id = ${b.id} and md.grain = 'day' and md.period_end = l.day
            and md.dim = '' and md.computed_at < l.written
        )
      group by l.day
      order by l.day desc
      limit ${MAX_LATE_DAYS}::int`),
  )) as unknown as Array<{ day: string }>;
  return rows.map((r) => r.day).sort();
}

/** Restate the late days of one business, and the coarse periods that contain them. */
async function restateLateDays(b: CronBusiness, now: Date) {
  const days = await lateDays(b, now);
  if (days.length === 0) return { days: 0, rows: 0 };
  const day = await bulkFillMetricDays({
    organizationId: b.organizationId,
    businessId: b.id,
    grain: "day",
    days,
    write: true,
    now,
    sliceDays: MAX_LATE_DAYS,
    maxCachedRows: MAX_CACHED_ROWS,
    timezone: b.timezone,
  });
  const coarse = await bulkFillCoarseGrains({
    organizationId: b.organizationId,
    businessId: b.id,
    days,
    write: true,
    now,
    maxCachedRows: MAX_CACHED_ROWS,
    timezone: b.timezone,
    calendar: b.calendar,
  });
  log.info("metric_daily late days restated", {
    event: "metric_daily_late_restated",
    businessId: b.id,
    days,
    rows: day.rows,
    coarseRows: coarse.rows,
  });
  return { days: days.length, rows: day.rows + coarse.rows };
}

/**
 * Yesterday and the 34 days before it, per business, in its own calendar — plus any older
 * day that received a backdated row since it was stored (`lateDays`).
 */
export async function restateTrailingDays(
  now: Date = new Date(),
  /** Tests scope the pass; the cron runs it for every business. */
  opts: { businessIds?: readonly string[] } = {},
) {
  let failed = 0;
  let late = 0;
  for (const b of await scoped(opts.businessIds)) {
    const today = dayFor(b, now);
    const days = Array.from({ length: TRAILING_DAYS }, (_, i) => shift(today, -(i + 1)));
    const t0 = Date.now();
    try {
      const day = await bulkFillMetricDays({
        organizationId: b.organizationId,
        businessId: b.id,
        grain: "day",
        days,
        write: true,
        now,
        sliceDays: TRAILING_DAYS,
        maxCachedRows: MAX_CACHED_ROWS,
        timezone: b.timezone,
      });
      const coarse = await bulkFillCoarseGrains({
        organizationId: b.organizationId,
        businessId: b.id,
        days,
        write: true,
        now,
        maxCachedRows: MAX_CACHED_ROWS,
        timezone: b.timezone,
        calendar: b.calendar,
      });
      log.info("metric_daily trailing days restated", {
        event: "metric_daily_restated",
        businessId: b.id,
        days: days.length,
        rows: day.rows,
        coarseRows: coarse.rows,
        ms: Date.now() - t0,
      });
    } catch (e) {
      failed++;
      log.error("metric_daily restatement failed for one business", {
        event: "metric_daily_restate_failed",
        businessId: b.id,
        error_message: (e as Error).message,
      });
    }
    try {
      late += (await restateLateDays(b, now)).days;
    } catch (e) {
      failed++;
      log.error("metric_daily late-day restatement failed for one business", {
        event: "metric_daily_late_restate_failed",
        businessId: b.id,
        error_message: (e as Error).message,
      });
    }
  }
  return { failed, late };
}

/** The figures a person reads first; drift in these is worth an alert. */
export const DRIFT_MEASURES = [
  "mrr",
  "cmrr",
  "active_subscriptions",
  "paying_subscriptions",
  "billing_gross",
  "cash_collected",
  "payments_net",
] as const;
/** Days back, all older than the trailing restatement reaches. */
export const DRIFT_SAMPLE_DAYS = [45, 90, 180, 365, 730] as const;
/** Where the scan records itself; the invariant of the same family reads it. */
export const DRIFT_SCAN_KEY = "metric_daily_drift_scan";

export interface DriftRow {
  business: string;
  day: string;
  measure: string;
  currency: string;
  stored: string | null;
  fresh: string | null;
}

/**
 * Recompute sampled older days and compare the headline figures with what is stored. A day
 * with no stored row for a measure is not drift — it was never written, which coverage
 * already reports.
 */
export async function scanMetricDrift(
  now: Date = new Date(),
  opts: { businessIds?: readonly string[]; record?: boolean } = {},
): Promise<DriftRow[]> {
  const t0 = Date.now();
  const drift: DriftRow[] = [];
  for (const b of await scoped(opts.businessIds)) {
    const today = dayFor(b, now);
    for (const back of DRIFT_SAMPLE_DAYS) {
      const day = shift(today, -back);
      const stored = await withTenant(b.organizationId, (tx) =>
        tx
          .select({
            measure: metricDaily.measure,
            currency: metricDaily.currency,
            value: metricDaily.value,
          })
          .from(metricDaily)
          .where(
            and(
              eq(metricDaily.businessId, b.id),
              eq(metricDaily.grain, "day"),
              eq(metricDaily.periodEnd, day),
              eq(metricDaily.dim, ""),
            ),
          ),
      );
      if (stored.length === 0) continue;
      const fresh = await withTenant(b.organizationId, (tx) =>
        computeMetricPeriod(tx, b.id, "day", day, now, { timezone: b.timezone }),
      );
      const freshBy = new Map(
        fresh.filter((r) => r.dim === "").map((r) => [`${r.measure}|${r.currency}`, r.value]),
      );
      for (const s of stored) {
        if (!(DRIFT_MEASURES as readonly string[]).includes(s.measure)) continue;
        const f = freshBy.get(`${s.measure}|${s.currency}`) ?? null;
        const sv = s.value == null ? null : String(s.value);
        const fv = f == null ? null : String(f);
        if (sv !== fv) {
          drift.push({
            business: b.id,
            day,
            measure: s.measure,
            currency: s.currency,
            stored: sv,
            fresh: fv,
          });
        }
      }
    }
  }
  // A scoped test run must not stand in for the estate-wide scan the invariant reads.
  if (opts.record === false || opts.businessIds) return drift;
  await systemDb.insert(opsInvariantResults).values({
    checkKey: DRIFT_SCAN_KEY,
    severity: "warn",
    violations: drift.length,
    sample: drift.slice(0, 50),
    sampleTruncated: drift.length > 50,
    durationMs: Date.now() - t0,
  });
  log.info("metric_daily drift scanned", {
    event: "metric_daily_drift_scanned",
    drifted: drift.length,
    ms: Date.now() - t0,
  });
  return drift;
}

/** The latest scan, for the invariant that surfaces it. */
export async function latestDriftScan() {
  const [row] = await systemDb
    .select()
    .from(opsInvariantResults)
    .where(eq(opsInvariantResults.checkKey, DRIFT_SCAN_KEY))
    .orderBy(desc(opsInvariantResults.ranAt))
    .limit(1);
  return row ?? null;
}
