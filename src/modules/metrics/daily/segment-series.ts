/**
 * A measure answered for a customer SEGMENT, computed from the movement ledger at read time.
 *
 * `metric_daily` holds only the dimensions it was written with; a segment is an arbitrary
 * filter over customers, so its figures cannot be looked up. The ledger carries `customer_id`
 * on every row, so the ledger-derived measures fold for any population in SQL. The rest refuse
 * by name rather than answer from the whole book.
 *
 * ⚠️ MEMBERSHIP IS TODAY'S. A segment is evaluated against customers as they stand now and
 * applied to all of history, so a chart reads "how did the customers who are in this segment
 * today get here". A customer who has since left the segment is absent from its past; a
 * segment defined as "active" therefore never shows churn.
 *
 * The figures agree with the unsegmented store when the segment is everyone
 * (`verify:segment-analytics` checks it): the flows sum the same ledger rows, the stock is the
 * running sum the ledger reconciles to, and the head counts call the same `windowCounts`.
 */
import { reportableCustomer } from "../reportable";
import { and, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businessTimezone } from "@/platform/business-tz";
import { zonedDayEndExclusive, zonedDayStart } from "@/platform/timezones";
import { mrrMovements } from "@db/schema";
import { customerPopulationSql } from "@/modules/customers/service";
import type { CustomerSegmentFilter } from "@db/schema";
import type { CustomFieldDefinitionRow } from "@/modules/custom-fields/service";
import { segmentWindowCounts } from "./customer-measures";
import type { Grain, MeasureDef } from "./measures";
import type { MetricSeriesResult, SeriesCell, SeriesPeriod } from "./query";

/** Flow measures: one ledger reason each; losses are stated as positive amounts. */
const FLOWS: Record<string, { reason: string; loss: boolean }> = {
  mrr_new: { reason: "new", loss: false },
  mrr_expansion: { reason: "expansion", loss: false },
  mrr_reactivation: { reason: "reactivation", loss: false },
  mrr_contraction: { reason: "contraction", loss: true },
  mrr_churn: { reason: "churn", loss: true },
  mrr_paused: { reason: "pause", loss: true },
};
const HEAD_COUNTS = new Set([
  "customers_new",
  "customers_churned",
  "customers_moved",
  "customer_churn_rate",
]);

/** What a segment can be asked for. Everything else is refused with this list. */
export const SEGMENT_MEASURES: readonly string[] = ["mrr", ...Object.keys(FLOWS), ...HEAD_COUNTS];

export interface SegmentPopulation {
  businessId: string;
  filters: CustomerSegmentFilter[];
  customFieldDefs: CustomFieldDefinitionRow[];
}

export async function readSegmentSeries(input: {
  organizationId: string;
  population: SegmentPopulation;
  measure: MeasureDef;
  grain: Grain;
  periods: readonly SeriesPeriod[];
}): Promise<MetricSeriesResult> {
  const { organizationId, population, measure: m, grain, periods } = input;
  const businessId = population.businessId;

  const cells = await withTenant(organizationId, async (tx) => {
    const zone = await businessTimezone(tx, businessId);
    const members = await customerPopulationSql(tx, businessId, {
      filters: population.filters,
      customFieldDefs: population.customFieldDefs,
    });
    const inSegment = sql`${mrrMovements.customerId} in (${members})`;
    const lastEnd = zonedDayEndExclusive(periods[periods.length - 1]!.end, zone);
    // The business's local calendar day, which is what every stored day row is cut on.
    const localDay = sql<string>`((${mrrMovements.occurredAt} at time zone ${zone})::date)::text`;

    if (HEAD_COUNTS.has(m.id)) {
      const rows = await segmentWindowCounts(
        tx,
        businessId,
        periods.map((p) => ({
          t: p.end,
          from: zonedDayStart(p.start, zone),
          toExclusive: zonedDayEndExclusive(p.end, zone),
        })),
        members,
      );
      return rows
        .filter((r) => r.measure === m.id)
        .map((r) => ({
          t: r.t,
          currency: r.currency,
          value: r.value,
          denominator: r.denominator ?? null,
        }));
    }

    const flow = FLOWS[m.id];
    // Per (currency, local day): a stock needs every day since the start of the book, a flow
    // only the window's.
    const byDay = await tx
      .select({
        currency: mrrMovements.currency,
        day: localDay,
        delta: sql<string>`sum(${mrrMovements.deltaMinor})`,
      })
      .from(mrrMovements)
      .where(
        and(
          and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
          inSegment,
          lt(mrrMovements.occurredAt, lastEnd),
          flow ? eq(mrrMovements.reason, flow.reason) : undefined,
          flow ? gte(mrrMovements.occurredAt, zonedDayStart(periods[0]!.start, zone)) : undefined,
        ),
      )
      // By position: the zone is a bind parameter, so the select's and the group's copies of
      // `localDay` are different expressions to Postgres.
      .groupBy(sql`1, 2`)
      .orderBy(sql`2`);

    const currencies = [...new Set(byDay.map((r) => r.currency.toUpperCase()))].sort();
    const out: SeriesCell[] = [];
    if (flow) {
      for (const p of periods) {
        for (const ccy of currencies) {
          let v = 0n;
          for (const r of byDay) {
            if (r.currency.toUpperCase() === ccy && r.day >= p.start && r.day <= p.end)
              v += BigInt(r.delta);
          }
          out.push({ t: p.end, currency: ccy, value: flow.loss ? -v : v, denominator: null });
        }
      }
      return out;
    }
    // The stock: the running sum at each period's close, for every currency held by then.
    for (const p of periods) {
      for (const ccy of currencies) {
        let v = 0n;
        let held = false;
        for (const r of byDay) {
          if (r.currency.toUpperCase() !== ccy || r.day > p.end) continue;
          v += BigInt(r.delta);
          held = true;
        }
        if (held) out.push({ t: p.end, currency: ccy, value: v, denominator: null });
      }
    }
    return out;
  });

  // Computed now, from the ledger — nothing is missing and nothing is stale.
  return { measure: m, grain, cells, computedAt: new Date(), missing: [] };
}

/** Why a segment cannot answer, in one sentence, or null when it can. */
export function segmentRefusal(
  m: MeasureDef,
  split: string | undefined,
  businesses: number,
): string | null {
  if (businesses !== 1) {
    return "A segment belongs to one business, so name the business to answer for (`business=biz_…`).";
  }
  if (split)
    return "A segment cannot be split yet. Ask for the segment, or for the split, not both.";
  if (!SEGMENT_MEASURES.includes(m.id)) {
    return `${m.name} cannot be answered for a segment yet. Segments answer: ${SEGMENT_MEASURES.join(", ")}.`;
  }
  return null;
}
