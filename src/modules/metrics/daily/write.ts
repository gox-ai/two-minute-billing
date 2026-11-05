import { sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { metricDaily } from "@db/schema";
import { invalidateSeriesCache } from "./series-cache";

/** One row of `metric_daily` — see the schema for what each field means. */
export interface MetricDailyRow {
  measure: string;
  /** '' means no slice — the total. */
  dim: string;
  /** '' when `dim` is '' — see the validation below. */
  dimValue: string;
  /** ISO 3, upper case, or 'XXX' when the measure is not currency-scoped. */
  currency: string;
  /**
   * Money in MINOR units, counts as counts. Never a float.
   *
   * NULL means "not applicable" (a cohort cell with no base, LTV with no churn yet) —
   * never zero. 0n means "computed, and the answer is zero". The two are kept apart on
   * write exactly as the schema keeps them apart on disk.
   */
  value: bigint | null;
  /** The other half of a ratio/average — never store a pre-divided quotient. */
  denominator?: bigint | null;
}

/** One id is one bind parameter; Postgres caps a statement at 65,534 of them. */
const CHUNK_SIZE = 500;

/**
 * Write one business-period's rows onto `metric_daily`, replacing each (measure, dim) it
 * carries: keys the compute no longer produces are deleted, the rest upserted.
 *
 * A row is written even when `value` is `0n` or `null`: a missing
 * row means "not computed", `null` means "computed, not applicable", and `0n` means
 * "computed, and it's zero" — three states a reader needs to tell apart, which dropping any
 * of them on write would collapse.
 */
export async function writeMetricDay(input: {
  organizationId: string;
  businessId: string;
  /** 'day' | 'week' | 'month' | 'quarter' | 'year' — a distinct count is not additive, so
   *  those measures are stored at each grain they are served at. */
  grain: string;
  /**
   * The period's end — the BUSINESS's local calendar date, not the UTC one.
   *
   * Its window is `[local midnight of the period's first date, local midnight of the day
   * after this one)`. A business with no timezone reports on the UTC day, which is what
   * every row written before this meant.
   */
  periodEnd: string;
  rows: readonly MetricDailyRow[];
  /**
   * Measures this write owns outright for the period: every stored row of theirs is deleted
   * before the insert, in the same transaction. Absent = replace only the pairs written.
   */
  replaceMeasures?: readonly string[];
}): Promise<{ written: number }> {
  for (const r of input.rows) {
    if (r.dim === "" && r.dimValue !== "") {
      throw new Error(
        `writeMetricDay: dim '' (no slice) must carry dimValue '', got '${r.dimValue}' for measure '${r.measure}'`,
      );
    }
    if (r.currency.length !== 3) {
      throw new Error(
        `writeMetricDay: currency must be ISO 3, got '${r.currency}' for measure '${r.measure}'`,
      );
    }
  }

  invalidateSeriesCache(input.businessId);
  const keys = input.rows.map((r) => ({
    m: r.measure,
    d: r.dim,
    v: r.dimValue,
    c: r.currency.toUpperCase(),
  }));
  return withTenant(input.organizationId, async (tx) => {
    // A restatement replaces whole measures: a group the compute no longer returns at all
    // (the only payer in a currency, now excluded) must go too. Same transaction as the
    // insert, so a reader sees the old rows or the new ones, never neither.
    if (input.replaceMeasures?.length) {
      await tx.execute(sql`
        delete from metric_daily
        where business_id = ${input.businessId}
          and grain = ${input.grain}
          and period_end = ${input.periodEnd}
          and measure = any(${`{${input.replaceMeasures.join(",")}}`}::text[])`);
    }
    // A rewrite replaces each (measure, dim) it carries: a slice value or currency the new
    // compute no longer produces is deleted, or it would outlive the day it emptied on and
    // the slices would sum past the total. Pairs the caller did not write are left alone.
    if (keys.length > 0) {
      const set = sql`jsonb_to_recordset(${JSON.stringify(keys)}::jsonb) as k(m text, d text, v text, c text)`;
      await tx.execute(sql`
        delete from metric_daily t
        where t.business_id = ${input.businessId}
          and t.grain = ${input.grain}
          and t.period_end = ${input.periodEnd}
          and exists (select 1 from ${set} where k.m = t.measure and k.d = t.dim)
          and not exists (
            select 1 from ${set}
            where k.m = t.measure and k.d = t.dim and k.v = t.dim_value and k.c = t.currency
          )`);
    }
    for (let i = 0; i < input.rows.length; i += CHUNK_SIZE) {
      const chunk = input.rows.slice(i, i + CHUNK_SIZE);
      if (chunk.length === 0) continue;
      await tx
        .insert(metricDaily)
        .values(
          chunk.map((r) => ({
            organizationId: input.organizationId,
            businessId: input.businessId,
            grain: input.grain,
            periodEnd: input.periodEnd,
            measure: r.measure,
            dim: r.dim,
            dimValue: r.dimValue,
            currency: r.currency.toUpperCase(),
            value: r.value,
            denominator: r.denominator ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [
            metricDaily.businessId,
            metricDaily.grain,
            metricDaily.periodEnd,
            metricDaily.measure,
            metricDaily.dim,
            metricDaily.dimValue,
            metricDaily.currency,
          ],
          set: {
            value: sql`excluded.value`,
            denominator: sql`excluded.denominator`,
            computedAt: sql`now()`,
          },
        });
    }
    return { written: input.rows.length };
  });
}
