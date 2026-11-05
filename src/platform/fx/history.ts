import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { businesses, exchangeRateHistory } from "@db/schema";

/**
 * The rate a business held for a currency AT AN INSTANT, and the recorder that makes that
 * question answerable.
 *
 * `businesses.exchange_rates` holds one value per currency and is overwritten in place, so
 * a converted figure moves for two reasons a reader cannot tell apart: the book changed,
 * or the rate did. `exchange_rate_history` records each observed change; this module is
 * the only thing that writes it and the only thing that reads it back.
 *
 * Lives in `platform/` rather than in a module because both sides need it and they sit on
 * opposite sides of the graph: `modules/tenancy` writes the rates, `modules/metrics` reads
 * them back, and neither may import the other.
 *
 * A rate is a STRING throughout. `Number("94.953741")` is 94.95374099999999, and a rate
 * that loses its last digit on the way through a reader is a rate that restates history.
 */

/** `rate` units of the quoted currency per 1 unit of `base`; null = no usable rate. */
export interface RateObservation {
  currency: string;
  base: string;
  rate: string | null;
  effectiveFrom: Date;
}

/**
 * Compare two rates as DECIMALS, not as text: "0.9", "0.90" and the "0.9000000000" a
 * numeric column reads back are one observation, and storing three of them would turn a
 * settings save into a rate change.
 */
function sameRate(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return a === b;
  const norm = (s: string) => {
    const t = s.trim();
    if (!/^[+-]?\d*\.?\d+$/.test(t)) return t;
    const neg = t.startsWith("-");
    const body = t.replace(/^[+-]/, "");
    const [i, f = ""] = body.split(".");
    const int = i!.replace(/^0+(?=\d)/, "");
    const frac = f.replace(/0+$/, "");
    const n = frac ? `${int}.${frac}` : int;
    return (neg && n !== "0" ? "-" : "") + n;
  };
  return norm(a) === norm(b);
}

/** The usable rate a jsonb `exchange_rates` value carries, or null. Never 1 for absence. */
function usableRate(raw: unknown): string | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return typeof raw === "string" ? raw.trim() : String(raw);
}

/**
 * Append an observation for every currency whose rate (or its base) has moved since the
 * last one — call it with the caller's transaction, right after `businesses.exchange_rates`
 * is written, so the observation commits with the change it describes.
 *
 * Reads the business row itself rather than taking the caller's patch: a caller that
 * passed a partial map would silently record the currencies it happened to mention.
 *
 * A currency that HAD a rate and no longer does records a NULL observation — "no usable
 * rate from here on" is a fact a reader needs, and leaving the last good rate standing
 * forever would convert at a rate the business no longer holds.
 *
 * Returns the number of rows appended; 0 when nothing moved.
 */
export async function recordExchangeRateObservations(
  tx: Tx,
  input: { organizationId: string; businessId: string; observedAt?: Date },
): Promise<number> {
  const [biz] = await tx
    .select({
      defaultCurrency: businesses.defaultCurrency,
      exchangeRates: businesses.exchangeRates,
    })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  const base = biz?.defaultCurrency?.toUpperCase();
  // Nothing to quote against: rates without a base are not observations of anything.
  if (!base) return 0;

  const now = input.observedAt ?? new Date();
  const rates = (biz?.exchangeRates ?? {}) as Record<string, unknown>;
  const wanted = new Map<string, string | null>();
  for (const [ccy, raw] of Object.entries(rates)) {
    const c = ccy.toUpperCase();
    if (c === base) continue; // a currency against itself is 1 by definition, not a rate
    wanted.set(c, usableRate(raw));
  }

  const prior = await latestObservations(tx, input.businessId);
  const rows: Array<typeof exchangeRateHistory.$inferInsert> = [];
  for (const [currency, rate] of wanted) {
    const last = prior.get(currency);
    if (last && last.base === base && sameRate(last.rate, rate)) continue;
    rows.push({
      organizationId: input.organizationId,
      businessId: input.businessId,
      currency,
      baseCurrency: base,
      rate,
      effectiveFrom: now,
    });
  }
  // A currency that dropped out of the map: record the absence once, then leave it alone.
  for (const [currency, last] of prior) {
    if (wanted.has(currency)) continue;
    if (last.rate == null && last.base === base) continue;
    rows.push({
      organizationId: input.organizationId,
      businessId: input.businessId,
      currency,
      baseCurrency: base,
      rate: null,
      effectiveFrom: now,
    });
  }
  if (rows.length === 0) return 0;
  // Idempotent under a retry: the same observation at the same instant is one row.
  await tx.insert(exchangeRateHistory).values(rows).onConflictDoNothing();
  return rows.length;
}

/** The most recent observation per currency for a business. */
async function latestObservations(
  tx: Tx,
  businessId: string,
): Promise<Map<string, { base: string; rate: string | null }>> {
  const rows = await tx
    .select({
      currency: exchangeRateHistory.currency,
      base: exchangeRateHistory.baseCurrency,
      rate: exchangeRateHistory.rate,
    })
    .from(exchangeRateHistory)
    .where(eq(exchangeRateHistory.businessId, businessId))
    .orderBy(asc(exchangeRateHistory.effectiveFrom), asc(exchangeRateHistory.createdAt));
  const out = new Map<string, { base: string; rate: string | null }>();
  // Ascending, so the last write per currency wins.
  for (const r of rows)
    out.set(r.currency.toUpperCase(), { base: r.base.toUpperCase(), rate: r.rate });
  return out;
}

/**
 * A business's rate timeline, ready to be asked "what was the rate at this instant".
 *
 * ⚠️ THE FALLBACK IS THE SAFETY PROPERTY. With no observation before the instant asked
 * about, the answer is the CURRENT rate — which is what every converted figure already
 * uses. So a book whose history is empty, or holds only the seeded snapshot of today's
 * rates, converts exactly as it does now: nothing is restated, and FX becomes a real
 * figure only as real history accrues.
 */
export interface RateTimeline {
  base: string;
  /** `rate` at `at`, as a string, or null when no usable rate applies. */
  rateAt(currency: string, at: Date): string | null;
  /** True when at least one currency has more than one observation — FX can move. */
  hasHistory: boolean;
}

export function buildRateTimeline(input: {
  base: string;
  /** The CURRENT `businesses.exchange_rates` map — the fallback, and only that. */
  currentRates: Record<string, unknown> | null;
  observations: RateObservation[];
}): RateTimeline {
  const base = input.base.toUpperCase();
  const byCurrency = new Map<string, RateObservation[]>();
  for (const o of input.observations) {
    const c = o.currency.toUpperCase();
    // An observation quoted against a DIFFERENT base answers a different question and is
    // dropped rather than re-based: re-basing it would invent a rate nobody observed.
    if (o.base.toUpperCase() !== base) continue;
    const arr = byCurrency.get(c) ?? [];
    arr.push(o);
    byCurrency.set(c, arr);
  }
  for (const arr of byCurrency.values()) arr.sort((a, b) => +a.effectiveFrom - +b.effectiveFrom);

  const current = new Map<string, string | null>();
  for (const [ccy, raw] of Object.entries(input.currentRates ?? {})) {
    current.set(ccy.toUpperCase(), usableRate(raw));
  }

  return {
    base,
    hasHistory: [...byCurrency.values()].some((a) => a.length > 1),
    rateAt(currency: string, at: Date): string | null {
      const c = currency.toUpperCase();
      if (c === base) return "1"; // parity with itself is a fact, not a rate
      const arr = byCurrency.get(c);
      if (arr && arr.length > 0) {
        // Binary search: a backfilled currency holds one observation per publishing day, and
        // the waterfall asks once per ledger row.
        const t = +at;
        let lo = 0;
        let hi = arr.length - 1;
        let found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (+arr[mid]!.effectiveFrom <= t) {
            found = mid;
            lo = mid + 1;
          } else hi = mid - 1;
        }
        if (found >= 0) return arr[found]!.rate;
      }
      // Before the first observation — or no observation at all. Today's rate, which is
      // what this figure was already being converted at.
      return current.get(c) ?? null;
    },
  };
}

/** `buildRateTimeline` for a caller that holds only ids. */
export async function loadRateTimeline(
  tx: Tx,
  businessId: string,
  opts?: { base?: string; currentRates?: Record<string, unknown> | null },
): Promise<RateTimeline> {
  let base = opts?.base;
  let currentRates = opts?.currentRates;
  if (base == null || currentRates === undefined) {
    const [biz] = await tx
      .select({
        defaultCurrency: businesses.defaultCurrency,
        exchangeRates: businesses.exchangeRates,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    base ??= (biz?.defaultCurrency ?? "USD").toUpperCase();
    currentRates ??= (biz?.exchangeRates ?? null) as Record<string, unknown> | null;
  }
  const observations = await tx
    .select({
      currency: exchangeRateHistory.currency,
      base: exchangeRateHistory.baseCurrency,
      rate: exchangeRateHistory.rate,
      effectiveFrom: exchangeRateHistory.effectiveFrom,
    })
    .from(exchangeRateHistory)
    .where(and(eq(exchangeRateHistory.businessId, businessId)))
    .orderBy(asc(exchangeRateHistory.effectiveFrom));
  return buildRateTimeline({ base: base!, currentRates: currentRates ?? null, observations });
}

/** One published day of rates: `currency → units per 1 EUR`. */
export interface EurRatesDay {
  day: string;
  perEur: Map<string, number>;
}

/**
 * Backfill `exchange_rate_history` with the rates this business WOULD have observed, for the
 * days before its first real observation — so converting a past figure uses the rate held
 * then instead of falling back to today's.
 *
 * Only currencies whose rate is `auto` (sourced from the same feed); a hand-entered rate has
 * no history to invent. Each day is the cross-rate the refresh itself computes
 * (`quote per EUR / base per EUR`, 10 places) and is effective at 16:30 UTC, when the
 * refresh runs; an unchanged rate appends nothing. Nothing on or after a currency's first
 * existing observation is touched, so a rerun appends nothing.
 */
export async function backfillExchangeRateHistory(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    /** Published days, any order; the caller fetches them (`fetchEcbHistory`). */
    days: readonly EurRatesDay[];
  },
): Promise<{ currency: string; appended: number; from: string | null; to: string | null }[]> {
  const [biz] = await tx
    .select({
      defaultCurrency: businesses.defaultCurrency,
      exchangeRates: businesses.exchangeRates,
      exchangeRateSources: businesses.exchangeRateSources,
    })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  const base = biz?.defaultCurrency?.toUpperCase();
  if (!base) return [];
  const sources = (biz?.exchangeRateSources ?? {}) as Record<string, { source?: string }>;
  const auto = Object.keys((biz?.exchangeRates ?? {}) as Record<string, unknown>)
    .map((c) => c.toUpperCase())
    .filter((c) => c !== base && sources[c]?.source === "auto");

  const existing = await tx
    .select({
      currency: exchangeRateHistory.currency,
      first: sql<Date>`min(${exchangeRateHistory.effectiveFrom})`,
    })
    .from(exchangeRateHistory)
    .where(eq(exchangeRateHistory.businessId, input.businessId))
    .groupBy(exchangeRateHistory.currency);
  const firstSeen = new Map(existing.map((r) => [r.currency.toUpperCase(), new Date(r.first)]));

  const days = [...input.days].sort((a, b) => (a.day < b.day ? -1 : 1));
  const out: { currency: string; appended: number; from: string | null; to: string | null }[] = [];
  for (const currency of auto) {
    const stop = firstSeen.get(currency);
    const rows: Array<typeof exchangeRateHistory.$inferInsert> = [];
    let last: string | null = null;
    for (const d of days) {
      const effectiveFrom = new Date(`${d.day}T16:30:00Z`);
      if (stop && effectiveFrom >= stop) break;
      const quote = currency === "EUR" ? 1 : d.perEur.get(currency);
      const against = base === "EUR" ? 1 : d.perEur.get(base);
      if (quote == null || against == null || !(quote > 0) || !(against > 0)) continue;
      const rate = (quote / against).toFixed(10);
      if (last != null && sameRate(last, rate)) continue;
      last = rate;
      rows.push({
        organizationId: input.organizationId,
        businessId: input.businessId,
        currency,
        baseCurrency: base,
        rate,
        effectiveFrom,
      });
    }
    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(exchangeRateHistory)
        .values(rows.slice(i, i + 500))
        .onConflictDoNothing();
    }
    out.push({
      currency,
      appended: rows.length,
      from: rows[0]?.effectiveFrom?.toISOString() ?? null,
      to: rows[rows.length - 1]?.effectiveFrom?.toISOString() ?? null,
    });
  }
  return out;
}
