/**
 * The read and refresh sides of `mrr_movement_summary_mv` (0273, netted by 0275).
 *
 * The matview holds the ledger grouped by (month, currency, column, signed delta) with a
 * count, for rows written before its `cutoff`. The waterfall reads those cells for COMPLETE
 * months and the raw ledger for everything else — see `resolve.ts`, which owns the fold.
 *
 * ⚠️ Reads go through the definer-rights view `mrr_movement_summary`, never the matview:
 * the view carries the tenant predicate. `REFRESH` runs on the base handle (the owner) and
 * is estate-wide — a matview has no partial refresh.
 */
import { sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { createLogger } from "@/platform/logger";
import { hasExcludedCustomer } from "../reportable";

const log = createLogger("metrics.movement-matview");

/** `count` ledger rows that share every field here. Never converted. */
export interface MovementCell {
  /** First instant of the month, UTC. */
  month: Date;
  currency: string;
  columnKey: string;
  deltaMinor: number;
  count: number;
}

/** Off makes every waterfall rebuild from the ledger — the gate's reference answer. */
export const movementFold = { enabled: true };

/** Which path the waterfall took, for the gate. */
export const movementPath = { fromMatview: 0, rebuilt: 0 };
export function resetMovementPath(): void {
  movementPath.fromMatview = 0;
  movementPath.rebuilt = 0;
}

/**
 * The cells for months BEFORE `before`, and the cutoff they were cut at — or null when there
 * are none (never refreshed, or a book whose history is all newer than the cutoff). Null means
 * "read the whole ledger", which is always correct, only slower.
 */
export async function loadMovementCells(
  organizationId: string,
  businessId: string,
  before: Date,
): Promise<{ cells: MovementCell[]; cutoff: Date } | null> {
  if (!movementFold.enabled) return null;
  // The fold is estate-wide and cannot leave a customer out: a book with one excluded from
  // reporting (0482) reads the filtered ledger instead.
  const [ex] = (await withTenant(organizationId, (tx) =>
    tx.execute(sql`select ${hasExcludedCustomer(businessId)} as excluded`),
  )) as unknown as Array<{ excluded: boolean }>;
  if (ex?.excluded) return null;
  let raw: Array<Record<string, unknown>>;
  try {
    raw = (await withTenant(organizationId, (tx) =>
      tx.execute(sql`
        select period_month::text as period_month, currency, column_key,
               delta_minor, movements, cutoff
          from mrr_movement_summary
         where business_id = ${businessId}::uuid
           and period_month < ${before.toISOString().slice(0, 10)}::date
      `),
    )) as unknown as Array<Record<string, unknown>>;
  } catch (e) {
    // Created WITH NO DATA and never refreshed: the ledger answers until the first refresh.
    if (/has not been populated/i.test((e as Error).message)) return null;
    throw e;
  }
  if (raw.length === 0) return null;
  const cutoff = new Date(raw[0]!.cutoff as string);

  // A restatement written since the refresh has to net against an original the fold already
  // holds, which it cannot. Rebuild until the next refresh folds both (0275).
  const [late] = (await withTenant(organizationId, (tx) =>
    tx.execute(sql`
      select exists (
        select 1 from mrr_movements n
         where n.business_id = ${businessId}::uuid
           and n.created_at >= ${cutoff.toISOString()}::timestamptz
           and n.occurred_at < ${before.toISOString()}::timestamptz
           and exists (
             select 1 from mrr_movements o
              where o.subscription_id = n.subscription_id
                and o.occurred_at = n.occurred_at
                and o.reason = n.reason
                and o.created_at < ${cutoff.toISOString()}::timestamptz)
      ) as stale
    `),
  )) as unknown as Array<{ stale: boolean }>;
  if (late?.stale) return null;
  return {
    cutoff,
    cells: raw.map((r) => ({
      month: new Date(`${String(r.period_month)}T00:00:00Z`),
      currency: String(r.currency),
      columnKey: String(r.column_key),
      deltaMinor: Number(r.delta_minor),
      count: Number(r.movements),
    })),
  };
}

/**
 * Re-cut the matview at `now() - 1 hour`.
 *
 * CONCURRENTLY: the plain form takes an ACCESS EXCLUSIVE lock and every waterfall on the
 * estate would block behind it. ~170 ms on the production book. Not callable inside a
 * transaction — Postgres rejects it there.
 */
export async function refreshMovementSummary(): Promise<{ ms: number }> {
  const started = Date.now();
  try {
    await systemDb.execute(sql`refresh materialized view concurrently mrr_movement_summary_mv`);
  } catch (e) {
    // A never-populated matview cannot be refreshed concurrently; the first one is plain.
    if (!/has not been populated/i.test((e as Error).message)) throw e;
    await systemDb.execute(sql`refresh materialized view mrr_movement_summary_mv`);
  }
  const ms = Date.now() - started;
  log.info("mrr_movement_summary refreshed", { event: "movement_summary_refreshed", ms });
  return { ms };
}
