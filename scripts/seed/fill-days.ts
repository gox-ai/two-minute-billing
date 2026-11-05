/**
 * A `metric_daily` fill worker — a child of `pnpm seed`'s load. The fill is CPU-bound
 * JavaScript over a DB-bound read, so the loader runs several side by side.
 *
 * Reads one JSON job per stdin line and answers each with one stdout line, so the loader
 * can hand the next slice to whichever worker frees up first. A job is either a slice of
 * days (day grain) or one coarse grain of one business. Days are independent, and the
 * coarse pass reads the book, never `metric_daily`, so jobs run in any order.
 */
import "./quiet";
import { createInterface } from "node:readline";
import { closeDb } from "@/platform/db";
import { bulkFillCoarseGrains, bulkFillMetricDays } from "@/modules/metrics/daily/bulk-fill";
import type { Grain } from "@/modules/metrics/daily/measures";

export interface FillJob {
  organizationId: string;
  businessId: string;
  timezone: string;
  days: string[];
  now: string;
  /** Absent: fill `days` at day grain. Present: fill that coarse grain's periods over `days`. */
  coarse?: Grain;
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const job = JSON.parse(line) as FillJob;
  const base = {
    organizationId: job.organizationId,
    businessId: job.businessId,
    days: job.days,
    write: true,
    now: new Date(job.now),
    timezone: job.timezone,
  };
  // One transaction per job: its standing reads are then loaded once, not once per 60 days.
  // A job is seconds long and the seed database serves no one else.
  const r = job.coarse
    ? await bulkFillCoarseGrains({ ...base, grains: [job.coarse], slicePeriods: job.days.length })
    : await bulkFillMetricDays({ ...base, grain: "day", sliceDays: job.days.length });
  process.stdout.write(JSON.stringify({ rows: r.rows }) + "\n");
}
await closeDb();
process.exit(0);
