import { CURRENT_REFRESH_SECONDS } from "./freshness";
import type { MetricSeriesResult } from "./query";

/**
 * Closed periods of a series, reused for one refresh interval.
 *
 * The 5-minute pass rewrites only TODAY, and the caller keeps today and yesterday (which the
 * nightly close restates) out of this cache. Older days change only on a restatement — a
 * backdated change or a recompute — written by the worker, a different process, so nothing
 * here can hear it. The TTL is therefore the refresh interval: a cached figure is never
 * older than the live ones beside it.
 *
 * OFF unless `enableSeriesCache()` is called — the API server does; scripts and verify
 * suites write `metric_daily` directly and must never read a stale copy of their own rows.
 */
const TTL_MS = CURRENT_REFRESH_SECONDS * 1000;
const MAX_ENTRIES = 2000;

let enabled = false;
const entries = new Map<string, { at: number; value: Promise<MetricSeriesResult> }>();

export function enableSeriesCache(): void {
  enabled = true;
}

export function seriesCacheEnabled(): boolean {
  return enabled;
}

/** Drop everything held for a business (or all), after a write in this process. */
export function invalidateSeriesCache(businessId?: string): void {
  if (!businessId) return entries.clear();
  for (const k of entries.keys()) if (k.startsWith(`${businessId}|`)) entries.delete(k);
}

/** `key` must start with `<businessId>|` so a write can invalidate it. */
export function cachedSeries(
  key: string,
  load: () => Promise<MetricSeriesResult>,
  keep: (r: MetricSeriesResult) => boolean = () => true,
): Promise<MetricSeriesResult> {
  if (!enabled) return load();
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load();
  // A failed read must not be served for an hour.
  value.then(
    (r) => {
      if (!keep(r)) entries.delete(key);
    },
    () => entries.delete(key),
  );
  if (entries.size >= MAX_ENTRIES) entries.clear();
  entries.set(key, { at: Date.now(), value });
  return value;
}
