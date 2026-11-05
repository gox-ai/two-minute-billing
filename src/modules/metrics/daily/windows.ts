/**
 * Non-additive measures over windows that are not calendar periods.
 *
 * A distinct count or a cohort rate over "the last 30 days" is not the sum of those days, and
 * no stored month holds it. The rolling presets are therefore computed as windows of their
 * own — every 30 minutes, into `metric_windows` — and read like any stored row, so Business Home never
 * waits on one. Any other window (a custom range) is computed on demand for one business and
 * held for one refresh interval.
 */
import { and, eq, inArray, lt } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { metricWindows } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { snapshotMrrCache, type SnapshotMrrCache } from "../snapshots";
import { computeMetricPeriod } from "./compute";
import { businessesWithSubscriptions, dayFor } from "./cron";
import { CURRENT_REFRESH_SECONDS } from "./freshness";

const log = createLogger("metrics.daily.windows");

/** The rolling presets kept precomputed — the ones Business Home and Reports offer. */
export const ROLLING_WINDOWS = ["7d", "30d", "90d", "6m", "12m"] as const;

export interface WindowRow {
  businessId: string;
  measure: string;
  dim: string;
  dimValue: string;
  currency: string;
  value: bigint | null;
  denominator: bigint | null;
  computedAt: Date;
}

async function computeWindow(
  organizationId: string,
  businessId: string,
  start: string,
  end: string,
  now: Date,
  zone: string | null,
  cache?: SnapshotMrrCache,
) {
  return withTenant(organizationId, (tx) =>
    computeMetricPeriod(tx, businessId, "day", end, now, {
      timezone: zone,
      periodStart: start,
      onlyNonAdditive: true,
      cache,
    }),
  );
}

/**
 * Recompute every rolling window ending today, per business, and drop windows that ended
 * more than three days ago — a rolling window is only ever read at today's end.
 */
export async function refreshRollingWindows(
  now: Date = new Date(),
  /** Tests scope the pass; the cron runs it for every business. */
  opts: { businessIds?: readonly string[] } = {},
) {
  // Imported here, not at the top: public-query reads this module.
  const { resolveWindow } = await import("./public-query");
  const all = await businessesWithSubscriptions();
  const list = opts.businessIds ? all.filter((b) => opts.businessIds!.includes(b.id)) : all;
  let failed = 0;
  const runStart = Date.now();
  let slowest: { businessId: string; ms: number } | null = null;
  for (const b of list) {
    const t0 = Date.now();
    try {
      const zone = b.timezone ?? "UTC";
      // One per window END: the presets all end today, so they read the book once between them.
      const caches = new Map<string, SnapshotMrrCache>();
      for (const name of ROLLING_WINDOWS) {
        const w = resolveWindow({ range: name, timezone: zone, timezoneSource: "business" });
        const cache = caches.get(w.end) ?? snapshotMrrCache();
        caches.set(w.end, cache);
        const rows = await computeWindow(
          b.organizationId,
          b.id,
          w.start,
          w.end,
          now,
          b.timezone,
          cache,
        );
        await withTenant(b.organizationId, async (tx) => {
          await tx
            .delete(metricWindows)
            .where(
              and(
                eq(metricWindows.businessId, b.id),
                eq(metricWindows.periodStart, w.start),
                eq(metricWindows.periodEnd, w.end),
              ),
            );
          if (rows.length === 0) return;
          await tx.insert(metricWindows).values(
            rows.map((r) => ({
              organizationId: b.organizationId,
              businessId: b.id,
              windowName: name,
              periodStart: w.start,
              periodEnd: w.end,
              measure: r.measure,
              dim: r.dim,
              dimValue: r.dimValue,
              currency: r.currency,
              value: r.value,
              denominator: r.denominator ?? null,
            })),
          );
        });
      }
      const today = dayFor(b, now);
      const cutoff = new Date(`${today}T00:00:00.000Z`);
      cutoff.setUTCDate(cutoff.getUTCDate() - 3);
      await withTenant(b.organizationId, (tx) =>
        tx
          .delete(metricWindows)
          .where(
            and(
              eq(metricWindows.businessId, b.id),
              lt(metricWindows.periodEnd, cutoff.toISOString().slice(0, 10)),
            ),
          ),
      );
      const ms = Date.now() - t0;
      if (!slowest || ms > slowest.ms) slowest = { businessId: b.id, ms };
      // Per business at debug: a run touches every business with subscriptions, which on a
      // database with many businesses is one info line each, every half hour.
      log.debug("rolling metric windows refreshed", {
        event: "metric_windows_refreshed",
        businessId: b.id,
        windows: ROLLING_WINDOWS.length,
        ms,
      });
    } catch (e) {
      failed++;
      log.error("rolling metric windows failed for one business", {
        event: "metric_windows_refresh_failed",
        businessId: b.id,
        error_message: (e as Error).message,
      });
    }
  }
  log.info("rolling metric windows refresh finished", {
    event: "metric_windows_refresh_run",
    businesses: list.length,
    failed,
    ms: Date.now() - runStart,
    slowest_business: slowest?.businessId ?? null,
    slowest_ms: slowest?.ms ?? null,
  });
  return { failed };
}

const onDemand = new Map<string, { at: number; rows: Promise<WindowRow[]> }>();
const ON_DEMAND_TTL_MS = CURRENT_REFRESH_SECONDS * 1000;
const ON_DEMAND_MAX = 500;

/**
 * The non-additive rows for one window. Stored rows first; a single business with none for
 * this window (a custom range, or the minutes after midnight before the next refresh) is
 * computed on demand and held for one refresh interval. Several businesses never compute on
 * demand — that is seconds each — and a business without stored rows is simply absent.
 */
export async function windowRows(input: {
  organizationId: string;
  businessIds: readonly string[];
  start: string;
  end: string;
  timezone: string | null;
  now: Date;
  /**
   * The rolling preset, when the window is one. Several businesses then read each one's own
   * latest stored window of that name: it was cut in that business's zone, so its dates need
   * not equal the organization's, and matching on dates would drop it without a word.
   */
  windowName?: string;
}): Promise<WindowRow[]> {
  if (
    input.businessIds.length > 1 &&
    input.windowName &&
    (ROLLING_WINDOWS as readonly string[]).includes(input.windowName)
  ) {
    const named = await withTenant(input.organizationId, (tx) =>
      tx
        .select()
        .from(metricWindows)
        .where(
          and(
            inArray(metricWindows.businessId, [...input.businessIds]),
            eq(metricWindows.windowName, input.windowName!),
          ),
        ),
    );
    const latest = new Map<string, string>();
    for (const r of named) {
      if ((latest.get(r.businessId) ?? "") < r.periodEnd) latest.set(r.businessId, r.periodEnd);
    }
    return named
      .filter((r) => latest.get(r.businessId) === r.periodEnd)
      .map((r) => ({
        businessId: r.businessId,
        measure: r.measure,
        dim: r.dim,
        dimValue: r.dimValue,
        currency: r.currency,
        value: r.value,
        denominator: r.denominator,
        computedAt: r.computedAt,
      }));
  }
  const stored = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(metricWindows)
      .where(
        and(
          inArray(metricWindows.businessId, [...input.businessIds]),
          eq(metricWindows.periodStart, input.start),
          eq(metricWindows.periodEnd, input.end),
        ),
      ),
  );
  const rows: WindowRow[] = stored.map((r) => ({
    businessId: r.businessId,
    measure: r.measure,
    dim: r.dim,
    dimValue: r.dimValue,
    currency: r.currency,
    value: r.value,
    denominator: r.denominator,
    computedAt: r.computedAt,
  }));
  if (rows.length > 0 || input.businessIds.length !== 1) return rows;

  const businessId = input.businessIds[0]!;
  const key = `${businessId}|${input.start}|${input.end}`;
  const hit = onDemand.get(key);
  if (hit && Date.now() - hit.at < ON_DEMAND_TTL_MS) return hit.rows;
  const computed = computeWindow(
    input.organizationId,
    businessId,
    input.start,
    input.end,
    input.now,
    input.timezone,
  ).then((list) => {
    const at = new Date();
    return list.map((r) => ({
      businessId,
      measure: r.measure,
      dim: r.dim,
      dimValue: r.dimValue,
      currency: r.currency,
      value: r.value,
      denominator: r.denominator ?? null,
      computedAt: at,
    }));
  });
  computed.catch(() => onDemand.delete(key));
  if (onDemand.size >= ON_DEMAND_MAX) onDemand.clear();
  onDemand.set(key, { at: Date.now(), rows: computed });
  return computed;
}

/** Forget on-demand windows — for tests that write and re-read within one process. */
export function clearOnDemandWindows(): void {
  onDemand.clear();
}
