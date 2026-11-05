import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businessTimezone } from "@/platform/business-tz";
import { currencyExponent } from "@/platform/currency";
import { FIXED12_SCALE, divHalfUp, fixed12FromNumeric, formatFixed12 } from "@/platform/fixed";
import { loadRateTimeline, type RateTimeline } from "@/platform/fx/history";
import { loadModelPriceBook, type ModelPriceBook } from "@/modules/model-prices/resolve";
import { meters } from "@db/schema";
import { listKeyOf } from "./price-list-rating";
import { readMeterUsage, type MeterUsageRow } from "./read";

/**
 * A customer's usage by day (design G1b § 3.8): the reader's 15-minute buckets (rollups
 * inside the range, raw events at its edges and in the open bucket), folded to days in the
 * business time zone. A bucket never crosses a local midnight: every zone offset is a
 * multiple of 15 minutes. Cost per row is the event cost plus the quantity with no cost at
 * your cost (else the list) for the bucket, rounded half-up once per row.
 */

export const MAX_HISTORY_DAYS = 92;

export interface UsageDay {
  date: string;
  meter: string;
  group: Record<string, string>;
  /** Fixed12 units. */
  quantity: bigint;
  cost?: {
    minor: bigint | null;
    basis: "event" | "price_list" | "mixed" | "partial" | "none" | "no_rate";
  };
}

export interface UsageHistory {
  timeZone: string;
  from: Date;
  to: Date;
  currency: string | null;
  days: UsageDay[];
}

/** Meters whose quantity folds from buckets: not recurring, not time-weighted, not unique. */
const foldable = (m: { recurring: boolean; aggregation: string }) =>
  !m.recurring && m.aggregation !== "weighted_sum" && m.aggregation !== "unique";

export async function customerUsageHistory(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  from: Date;
  to: Date;
  meterKey?: string;
  /** Group keys to keep; default every key of each meter. */
  groupBy?: string[];
  /** Set to measure cost in this currency. */
  costCurrency?: string;
}): Promise<UsageHistory | null> {
  return withTenant(input.organizationId, async (tx) => {
    const timeZone = await businessTimezone(tx, input.businessId);
    const list = await tx
      .select()
      .from(meters)
      .where(
        and(
          eq(meters.businessId, input.businessId),
          input.meterKey ? eq(meters.key, input.meterKey) : sql`${meters.status} = 'active'`,
        ),
      )
      .orderBy(meters.key);
    if (input.meterKey && list.length === 0) return null;
    const dayOf = dayFormatter(timeZone);
    const days: UsageDay[] = [];
    let fx: RateTimeline | null = null;
    for (const m of list.filter(foldable)) {
      const usage = await readMeterUsage(tx, {
        customerId: input.customerId,
        meterId: m.id,
        window: { start: input.from, end: input.to },
        granularity: "bucket",
      });
      const rows = usage.segments.flatMap((s) => s.rows);
      if (rows.length === 0) continue;
      const groupBy = m.groupBy ?? [];
      const keep = input.groupBy ? groupBy.filter((k) => input.groupBy!.includes(k)) : groupBy;
      const cur = input.costCurrency ?? null;
      let book: ModelPriceBook | null = null;
      if (cur && m.priceList) {
        const modelKey = m.priceList.model_key ?? "model";
        const i = groupBy.indexOf(modelKey);
        const models = [...new Set(rows.map((r) => r.groupValues[i] ?? "").filter(Boolean))];
        book = await loadModelPriceBook(tx, input.organizationId, models, {
          start: input.from,
          end: input.to,
        });
      }
      const folded = new Map<
        string,
        {
          day: UsageDay;
          rows: MeterUsageRow[];
          total: bigint;
          priced: boolean;
          events: boolean;
          unpriced: boolean;
          noRate: boolean;
        }
      >();
      for (const r of rows) {
        const date = dayOf(r.bucketStart!);
        const full: Record<string, string> = {};
        groupBy.forEach((k, i) => (full[k] = r.groupValues[i] ?? ""));
        const group: Record<string, string> = {};
        for (const k of keep) group[k] = full[k]!;
        const k = JSON.stringify([date, keep.map((x) => group[x])]);
        let e = folded.get(k);
        if (!e)
          folded.set(
            k,
            (e = {
              day: { date, meter: m.key, group, quantity: 0n },
              rows: [],
              total: 0n,
              priced: false,
              events: false,
              unpriced: false,
              noRate: false,
            }),
          );
        e.rows.push(r);
        if (!cur) continue;
        const scale = 10n ** BigInt(currencyExponent(cur));
        if (r.quantity > r.uncostedQuantity || r.costSum !== 0n) e.events = true;
        if (r.costSum !== 0n) {
          const rc = r.currency ?? m.costCurrency ?? cur;
          if (rc === cur) e.total += r.costSum * scale;
          else {
            fx ??= await loadRateTimeline(tx, input.businessId);
            const to = fx.rateAt(cur, r.bucketStart!);
            const fr = fx.rateAt(rc, r.bucketStart!);
            if (!to || !fr) e.noRate = true;
            else
              e.total += divHalfUp(
                r.costSum * scale * fixed12FromNumeric(to),
                fixed12FromNumeric(fr),
              );
          }
        }
        if (r.uncostedQuantity > 0n) {
          const key = listKeyOf(m, full, cur);
          const hit = key && book ? book.modelCost(key, r.bucketStart!) : null;
          if (hit?.kind) {
            e.total += divHalfUp(
              r.uncostedQuantity * hit.unitAmount,
              hit.quantityDivisor * FIXED12_SCALE,
            );
            e.priced = true;
          } else e.unpriced = true;
        }
      }
      for (const e of folded.values()) {
        e.day.quantity = foldQuantity(m.aggregation, e.rows);
        if (cur) {
          const minor = divHalfUp(e.total, FIXED12_SCALE);
          e.day.cost = e.noRate
            ? { minor: null, basis: "no_rate" }
            : e.unpriced
              ? e.priced || e.events
                ? { minor, basis: "partial" }
                : { minor: null, basis: "none" }
              : {
                  minor,
                  basis: e.priced && e.events ? "mixed" : e.priced ? "price_list" : "event",
                };
        }
        days.push(e.day);
      }
    }
    days.sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? -1
          : 1
        : a.meter !== b.meter
          ? a.meter < b.meter
            ? -1
            : 1
          : JSON.stringify(a.group) < JSON.stringify(b.group)
            ? -1
            : 1,
    );
    return { timeZone, from: input.from, to: input.to, currency: input.costCurrency ?? null, days };
  });
}

/** One day's quantity from its bucket rows, by the meter's aggregation. */
function foldQuantity(aggregation: string, rows: MeterUsageRow[]): bigint {
  switch (aggregation) {
    case "max":
      return (
        rows.reduce<bigint | null>(
          (a, r) => (r.valueMax != null && (a == null || r.valueMax > a) ? r.valueMax : a),
          null,
        ) ?? 0n
      );
    case "min":
      return (
        rows.reduce<bigint | null>(
          (a, r) => (r.valueMin != null && (a == null || r.valueMin < a) ? r.valueMin : a),
          null,
        ) ?? 0n
      );
    case "last":
      return (
        [...rows].sort((a, b) => (a.lastAt?.getTime() ?? 0) - (b.lastAt?.getTime() ?? 0)).at(-1)
          ?.lastValue ?? 0n
      );
    case "avg": {
      const n = rows.reduce((a, r) => a + r.eventCount, 0n);
      return n > 0n
        ? divHalfUp(
            rows.reduce((a, r) => a + r.valueSum, 0n),
            n,
          )
        : 0n;
    }
    default:
      return rows.reduce((a, r) => a + r.quantity, 0n);
  }
}

/** "YYYY-MM-DD" of an instant in `timeZone`. */
function dayFormatter(timeZone: string): (d: Date) => string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const cache = new Map<number, string>();
  return (d) => {
    const t = d.getTime();
    let s = cache.get(t);
    if (s === undefined) cache.set(t, (s = f.format(d)));
    return s;
  };
}

export function serializeUsageHistory(h: UsageHistory, opts: { cost: boolean }) {
  return {
    object: "usage_history" as const,
    time_zone: h.timeZone,
    from: h.from.toISOString(),
    to: h.to.toISOString(),
    interval: "day" as const,
    ...(opts.cost ? { currency: h.currency } : {}),
    data: h.days.map((d) => ({
      date: d.date,
      meter: d.meter,
      group: d.group,
      quantity: formatFixed12(d.quantity),
      ...(opts.cost && d.cost
        ? {
            cost_minor: d.cost.minor != null ? Number(d.cost.minor) : null,
            cost_basis: d.cost.basis,
          }
        : {}),
    })),
  };
}
