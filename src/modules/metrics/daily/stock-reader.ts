import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { metricDaily } from "@db/schema";
import { MEASURES, measureById } from "./measures";

/**
 * Stocks read out of `metric_daily`, with the contract that keeps a partial cache safe:
 * **answer, or say you cannot.** Never guess, never return zero for a day you have no row for.
 *
 * This is the bridge from the report resolvers to the semantic layer. It deliberately has the
 * same shape as the `stored()` half of `loadStockReaders` — a function from an instant to a
 * number or null — so a caller keeps its existing reconstruction as the fallback arm and the
 * golden payloads stay byte-identical while the source underneath changes.
 *
 * ⚠️ Today's row does not exist until `metric_daily_current` has run, so the headline instant
 * (`ctx.now`) falls back by design until that job is live. That is the whole reason the
 * 5-minutely job exists: without it every "value now" read rebuilds the book.
 */

/**
 * The measures this reader can answer, spelled as the MEASURE REGISTRY spells them —
 * which is what the writer stored. The report vocabulary differs for the two counts, and
 * the resolver maps at its own boundary; reading under the resolver's spelling would find
 * nothing and fall back forever while looking like it worked.
 */
export type StockMeasure =
  | "mrr"
  | "cmrr"
  | "active_subscriptions"
  | "paying_subscriptions"
  | "renewing_subscriptions";

/** Asked of the registry, not hard-coded: a stock measure added there is readable here. */
const STOCK_MEASURE_IDS = MEASURES.filter((m) => m.kind === "stock").map((m) => m.id);

/** Counts are never converted — only excluded when their currency is out of scope. */
const isCount = (measure: StockMeasure) => measureById(measure)?.unit === "count";

export interface StockReader {
  /**
   * The value at an instant, converted and summed across currencies by `convert`, or NULL
   * when `metric_daily` has no row for that day — the caller must then reconstruct.
   */
  at(instant: Date, measure: StockMeasure): number | null;
  /** Per-currency rows for a dimension at an instant, or null when the day is not covered. */
  rowsAt(
    instant: Date,
    measure: StockMeasure,
    dim: string,
  ): Array<{ group_id: string; value: number }> | null;
  /** How many of the instants asked for were answered from storage — proof, not belief. */
  readonly path: { fromStore: number; missing: number };
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export async function loadStockReaderFromMetrics(input: {
  organizationId: string;
  businessId: string;
  /** Inclusive day range to preload, so the whole chart is one query. */
  from: string;
  to: string;
  /**
   * The caller's currency rule, reused verbatim. Returns null for a currency out of scope,
   * which is how a scoped view excludes rather than mis-sums — the same contract
   * `loadStockReaders` applies, so the two paths cannot disagree about scoping.
   */
  /** `at` is the instant read, so money converts at the rate held then. */
  convert: (minor: number, currency: string, at?: Date) => number | null;
  dims?: readonly string[];
}): Promise<StockReader> {
  const dims = ["", ...(input.dims ?? [])];
  const rows = await withTenant(input.organizationId, (tx) =>
    tx
      .select({
        periodEnd: metricDaily.periodEnd,
        measure: metricDaily.measure,
        dim: metricDaily.dim,
        dimValue: metricDaily.dimValue,
        currency: metricDaily.currency,
        value: metricDaily.value,
      })
      .from(metricDaily)
      .where(
        and(
          eq(metricDaily.businessId, input.businessId),
          eq(metricDaily.grain, "day"),
          inArray(metricDaily.dim, dims),
          inArray(metricDaily.measure, STOCK_MEASURE_IDS),
          gte(metricDaily.periodEnd, input.from),
          lte(metricDaily.periodEnd, input.to),
        ),
      )
      .orderBy(asc(metricDaily.periodEnd)),
  );

  // Keyed on day first: "is this day covered at all" has to be answerable before any value
  // is summed, or a partially-written day would read as a smaller number rather than a gap.
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byDay.get(r.periodEnd) ?? [];
    arr.push(r);
    byDay.set(r.periodEnd, arr);
  }

  const path = { fromStore: 0, missing: 0 };

  return {
    path,
    at(instant, measure) {
      const day = byDay.get(dayOf(instant));
      if (!day) {
        path.missing += 1;
        return null;
      }
      let total = 0;
      let seen = false;
      for (const r of day) {
        if (r.measure !== measure || r.dim !== "") continue;
        seen = true;
        // A count is not money and is never converted — only excluded when its currency is
        // out of scope, which `convert` reports by answering null for a zero amount.
        const raw = Number(r.value ?? 0n);
        if (isCount(measure)) {
          if (input.convert(0, r.currency) == null) continue;
          total += raw;
        } else {
          const v = input.convert(raw, r.currency, instant);
          if (v == null) continue;
          total += v;
        }
      }
      // The day exists but this measure is absent from it: a partially-written day, which is
      // a gap rather than a zero. Say so.
      if (!seen) {
        path.missing += 1;
        return null;
      }
      path.fromStore += 1;
      return total;
    },
    rowsAt(instant, measure, dim) {
      const day = byDay.get(dayOf(instant));
      if (!day) return null;
      const byGroup = new Map<string, number>();
      let seen = false;
      for (const r of day) {
        if (r.measure !== measure || r.dim !== dim) continue;
        seen = true;
        const raw = Number(r.value ?? 0n);
        const v = isCount(measure)
          ? input.convert(0, r.currency) == null
            ? null
            : raw
          : input.convert(raw, r.currency, instant);
        if (v == null) continue;
        byGroup.set(r.dimValue, (byGroup.get(r.dimValue) ?? 0) + v);
      }
      if (!seen) return null;
      return [...byGroup.entries()].map(([group_id, value]) => ({ group_id, value }));
    },
  };
}
