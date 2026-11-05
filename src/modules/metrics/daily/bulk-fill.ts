import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { withTenant } from "@/platform/db";
import { prices, products, subscriptionItems, subscriptions } from "@db/schema";
import { computeMetricPeriod } from "./compute";
import { writeMetricDay } from "./write";
import { coarsePeriodEnds } from "./cron";
import { businessCalendar, type BusinessCalendar } from "@/platform/business-calendar";
import { MEASURES, type Grain } from "./measures";
import { zonedDayString } from "@/platform/timezones";
import { businessTimezone } from "@/platform/business-tz";

/**
 * Fill many days of `metric_daily` without paying for the same read 400 times.
 *
 * ── WHY THIS IS NOT A SECOND IMPLEMENTATION ───────────────────────────────────────────
 * Every figure here still comes from `computeMetricPeriod`. Nothing about a measure is
 * restated, re-derived or re-rated: the ONLY thing this module changes is how often the
 * database is asked a question whose answer cannot change between two days of one run.
 *
 * A backfill reads a book that is standing still. `computeMetricPeriod` reads it fresh for
 * every day — the subscriptions, their items, the active discounts, the plan of each row —
 * because it is written for the nightly close, where it computes exactly one day and the
 * book is live. Over 400 days that is 400 identical scans of a 74,000-row book, three times
 * a day for the three snapshot groupings, plus one chunked item read per day for the
 * cancelled re-rating.
 *
 * So the transaction handle is wrapped in a read-through cache keyed on the SQL text and its
 * bind parameters. A repeat of a query already answered in this run returns the first
 * answer. The compute path above it is byte-for-byte the code the cron runs, which is what
 * makes the rows byte-for-byte the rows the cron writes.
 *
 * ── WHAT MAKES IT SAFE, AND WHAT ONLY MAKES IT SMALL ──────────────────────────────────
 * The BIND PARAMETERS ARE IN THE KEY. That is the correctness guarantee, and it is the only
 * one: two days ask the same window query with different instants bound, so they are
 * different keys and neither can be served the other's answer. Keying on the SQL text alone
 * moves 184 rows in the gate's fixture.
 *
 * Refusing to STORE a read whose parameters carry an instant is a memory guard, not a
 * correctness one — such a read would simply never be hit again, and the cache would fill
 * with 400 days of window answers nobody asks for twice. Proven by mutation: dropping it
 * alone changes no row.
 *
 * Writes are never cached, and only SELECTs are considered at all.
 *
 * What is left to cache is the standing reads: the book, its items, the active discounts,
 * the plan resolution. They are the whole 400× redundancy.
 *
 * ⚠️ This is therefore a BACKFILL tool and nothing else. It assumes the book does not change
 * while it runs. A change landing mid-run is picked up by the next nightly close, and the
 * fill is idempotent, so re-running the window restates it.
 */

/**
 * The memory ceiling, in rows — because rows are what this holds, and a row's size is
 * MEASURED rather than guessed: 1,442 B for a subscription, 2,133 B for an item joined to
 * its price, 258 B for the four-column plan read. So 600,000 rows is a ceiling of roughly
 * 0.6–1.0 GB depending on what fills it.
 *
 * The box this runs on has no swap, so "it grew a bit" is an OOM kill of whatever Postgres
 * or the billing worker happens to be holding. Past the budget nothing further is cached
 * and the run pays the read again — slower, never larger. Lower it with `--cache-rows` on a
 * box with less headroom.
 */
export const DEFAULT_MAX_CACHED_ROWS = 600_000;
/** Distinct queries kept. The standing reads are a handful; the cap catches a surprise. */
const MAX_CACHED_QUERIES = 64;

/** What the cache did, for the backfill's own reporting — never for a decision it makes. */
export interface CacheStats {
  hits: number;
  misses: number;
  /** Date-windowed reads, which are never cached and never served from one. */
  skipped: number;
  /** Rows held across every cached read. The memory ceiling, in one number. */
  rows: number;
  /** Milliseconds spent inside Postgres, so a run can say where its time went. */
  sqlMs: number;
}

/** An ISO-8601 instant as postgres-js binds one. A date in a parameter means "this day". */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const mentionsAnInstant = (params: readonly unknown[]): boolean =>
  params.some(
    (p) =>
      p instanceof Date ||
      (typeof p === "string" && ISO_INSTANT.test(p)) ||
      (typeof p === "number" && p > 1_000_000_000_000),
  );

const isReadOnly = (text: string): boolean => {
  const s = text.trimStart().slice(0, 12).toLowerCase();
  return s.startsWith("select") || s.startsWith("with ");
};

/**
 * Wrap a transaction so identical reads within one run are answered once.
 *
 * The interception point is `session.prepareQuery`, which every drizzle builder funnels
 * through — so a cached read is the same mapped row objects the uncached one returns, and
 * no call site needs to know the cache exists.
 *
 * The cached arrays are handed back by reference. The compute path treats its reads as
 * immutable (it buckets and sums out of them, never writes into them); a caller that
 * mutated a result row would see it on the next day, and that is the one thing this
 * wrapper asks of the code above it.
 */
export function cachingTx(
  tx: Tx,
  businessId: string,
  stats: CacheStats,
  maxCachedRows: number = DEFAULT_MAX_CACHED_ROWS,
): Tx {
  const cache = new Map<string, unknown>();
  const superset: Superset = {};
  /** Rows held by THIS cache. Reset with it, once per slice. */
  let held = 0;
  const real = (tx as unknown as { session: Record<string, unknown> }).session;

  const wrapPrepared = (pq: object, key: string | null, text: string): object =>
    new Proxy(pq, {
      get(target, prop) {
        const v = Reflect.get(target, prop) as unknown;
        // Everything but `execute` is returned unbound, so `this` stays the proxy and a
        // method reaching for a sibling still reaches the wrapped one.
        if (prop !== "execute" || typeof v !== "function") return v;
        const exec = (v as (...a: unknown[]) => Promise<unknown>).bind(target);
        return async (...args: unknown[]): Promise<unknown> => {
          // A placeholder-valued execution is a different query each time — never cached.
          if (key == null || args.some((a) => a != null)) {
            stats.skipped += 1;
            if (process.env.BULK_FILL_DEBUG === "all") console.log("SKIP", text.slice(0, 130));
            const t0 = performance.now();
            const r = await exec(...args);
            stats.sqlMs += performance.now() - t0;
            return r;
          }
          if (cache.has(key)) {
            stats.hits += 1;
            return cache.get(key);
          }
          stats.misses += 1;
          if (process.env.BULK_FILL_DEBUG) console.log("MISS", text.slice(0, 130));
          const t1 = performance.now();
          const out = await exec(...args);
          stats.sqlMs += performance.now() - t1;
          const n = Array.isArray(out) ? out.length : 0;
          if (held + n <= maxCachedRows && cache.size < MAX_CACHED_QUERIES) {
            cache.set(key, out);
            held += n;
            stats.rows += n;
          }
          return out;
        };
      },
    });

  /**
   * Stand in for one of the two id-list reads: load the superset once, then answer every
   * later call by cutting it with the asked-for ids. The object returned mimics the one
   * shape drizzle uses on a prepared query — `execute()`.
   */
  const idListReader = (shape: "plan" | "rerate", params: readonly unknown[]): object => ({
    // drizzle threads an auth token through the prepared query before executing it.
    setToken(): object {
      return this;
    },
    execute: async (): Promise<unknown[]> => {
      let byId = superset[shape];
      if (!byId) {
        stats.misses += 1;
        // On the REAL handle: the superset is one of the two shapes and would otherwise
        // be intercepted by this very reader.
        byId =
          shape === "plan"
            ? await loadPlanSuperset(tx, businessId)
            : await loadRerateSuperset(tx, businessId);
        superset[shape] = byId;
        for (const v of byId.values()) {
          held += v.length;
          stats.rows += v.length;
        }
      } else {
        stats.hits += 1;
      }
      const out: unknown[] = [];
      for (const p of params) {
        const rows = typeof p === "string" ? byId.get(p) : undefined;
        if (rows) out.push(...rows);
      }
      return out;
    },
  });

  const session = new Proxy(real, {
    get(target, prop) {
      const v = Reflect.get(target, prop) as unknown;
      if (prop !== "prepareQuery" || typeof v !== "function") return v;
      const prepare = (v as (...a: unknown[]) => object).bind(target);
      return (query: { sql: string; params: unknown[] }, ...rest: unknown[]): object => {
        const shape = idListShape(query.sql);
        if (shape) return idListReader(shape, query.params ?? []);
        const pq = prepare(query, ...rest);
        const cacheable =
          isReadOnly(query.sql) && !mentionsAnInstant(query.params ?? []) ? query.sql : null;
        const key = cacheable == null ? null : `${query.sql}\u0000${JSON.stringify(query.params)}`;
        return wrapPrepared(pq, key, query.sql);
      };
    },
  });

  return new Proxy(tx as unknown as object, {
    get(target, prop) {
      if (prop === "session") return session;
      /**
       * Unbound on purpose. A drizzle builder is constructed with `this.session`, so the
       * method must run with the PROXY as `this` — bound to the real handle it would
       * capture the real session and the cache would never be consulted.
       */
      return Reflect.get(target, prop) as unknown;
    },
  }) as unknown as Tx;
}

/**
 * ── THE TWO READS A KEYED CACHE CANNOT CATCH ──────────────────────────────────────────
 *
 * `loadReratedMrr` and `resolvePlanProductIds` both ask
 * `… from subscription_items … where subscription_id in (…)`, and the id list is a
 * DIFFERENT set every day — the rows that day counts. So the SQL text differs, the key
 * differs, and the cache never hits: they were 9 of the ~10 misses per day left after
 * everything standing had been cached once.
 *
 * Both are pure row filters. `in (ids)` selects exactly the subset of the business's items
 * whose subscription is in the list, and both callers fold their result per subscription —
 * so the SAME read done once for the whole business, filtered in memory by the asked-for
 * ids, returns exactly the rows Postgres would have returned. Not an approximation of them:
 * the same rows, from the same query, cut by the same predicate.
 *
 * The superset is built here with the IDENTICAL drizzle select, so the row objects are
 * mapped identically too — a hand-written SQL string would have been a second shape to keep
 * in step. Within one subscription the item order is preserved (the plan read's `order by
 * subscription_id, id` is what makes "first item" mean the oldest); across subscriptions the
 * order follows the asked-for ids, which neither caller reads.
 */
interface Superset {
  /** `subscription_items ⋈ prices ⋈ products`, four columns, for the plan resolution. */
  plan?: Map<string, unknown[]>;
  /** `subscription_items ⋈ prices`, whole rows, for the cancelled re-rating. */
  rerate?: Map<string, unknown[]>;
}

/** Which of the two id-list reads this SQL is, or null when it is neither. */
function idListShape(text: string): "plan" | "rerate" | null {
  if (!text.includes('from "subscription_items"')) return null;
  if (!text.includes('"subscription_id" in (')) return null;
  if (!text.includes('inner join "prices"')) return null;
  return text.includes('inner join "products"') ? "plan" : "rerate";
}

/** Group a superset read by the subscription each row belongs to. */
function groupBySubscription(
  rows: readonly unknown[],
  idOf: (r: unknown) => string,
): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const r of rows) {
    const id = idOf(r);
    const arr = out.get(id);
    if (arr) arr.push(r);
    else out.set(id, [r]);
  }
  return out;
}

async function loadPlanSuperset(tx: Tx, businessId: string): Promise<Map<string, unknown[]>> {
  const rows = await tx
    .select({
      subscriptionId: subscriptionItems.subscriptionId,
      productId: prices.productId,
      kind: products.kind,
      itemId: subscriptionItems.id,
    })
    .from(subscriptionItems)
    .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
    .innerJoin(products, eq(products.id, prices.productId))
    .where(eq(subscriptionItems.businessId, businessId))
    .orderBy(subscriptionItems.subscriptionId, subscriptionItems.id);
  return groupBySubscription(rows, (r) => (r as { subscriptionId: string }).subscriptionId);
}

async function loadRerateSuperset(tx: Tx, businessId: string): Promise<Map<string, unknown[]>> {
  /**
   * Bounded to CANCELLED rows with no stored last-earning rate, the only population
   * `loadReratedMrr` ever asks about — every other row answers from a column and never
   * reaches this read. Without the second bound a 96%-cancelled book loaded nearly all of its
   * items here.
   */
  const rows = await tx
    .select({ item: subscriptionItems, price: prices })
    .from(subscriptionItems)
    .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionItems.subscriptionId))
    .where(
      and(
        eq(subscriptionItems.businessId, businessId),
        eq(subscriptions.status, "cancelled"),
        isNull(subscriptions.lastEarningMrr),
      ),
    );
  return groupBySubscription(
    rows,
    (r) => (r as { item: { subscriptionId: string } }).item.subscriptionId,
  );
}

export interface BulkFillResult {
  days: number;
  rows: number;
  cache: CacheStats;
}

/**
 * Fill `days` (a list of `YYYY-MM-DD`, any order) for one business.
 *
 * One transaction per SLICE of days, not one for the whole window: a transaction held open
 * for an hour pins Postgres's oldest snapshot and stops autovacuum reclaiming anything on a
 * box that is also serving live traffic. The cache is rebuilt per slice, which costs one
 * book read per slice and keeps the process's working set flat.
 *
 * Each day is written before the next is computed, so at most one day's rows are ever held.
 * The write upserts on the full key, so an interrupted run is resumed by re-running it.
 */
export async function bulkFillMetricDays(input: {
  organizationId: string;
  businessId: string;
  grain: Grain;
  days: readonly string[];
  write: boolean;
  now?: Date;
  /** Days per transaction. Bounds both the open-transaction age and the cache's lifetime. */
  sliceDays?: number;
  /** Passed straight through: a coarser grain closes with just the non-additive measures. */
  onlyNonAdditive?: boolean;
  /** Passed straight through: restate only these measures (`computeMetricPeriod`). */
  measures?: ReadonlySet<string>;
  /** The cache's row ceiling — see `DEFAULT_MAX_CACHED_ROWS`. */
  maxCachedRows?: number;
  /**
   * The business's IANA zone, which decides where every day in `days` is cut. Resolved
   * here, ONCE for the run, when the caller does not pass it — a zone cannot change under
   * a fill, and asking per day would be 400 lookups for one answer.
   */
  timezone?: string | null;
  onDay?: (day: string, rows: number) => void;
  /**
   * Restate: each period's write replaces every measure this compute owns
   * (`computedMeasures`), so a group that emptied is removed rather than left stale.
   */
  replaceComputed?: boolean;
}): Promise<BulkFillResult> {
  const slice = Math.max(1, input.sliceDays ?? 60);
  const zone =
    input.timezone !== undefined
      ? input.timezone
      : await withTenant(input.organizationId, (tx) => businessTimezone(tx, input.businessId));
  const stats: CacheStats = { hits: 0, misses: 0, skipped: 0, rows: 0, sqlMs: 0 };
  let rows = 0;
  const now = input.now ?? new Date();

  for (let i = 0; i < input.days.length; i += slice) {
    const chunk = input.days.slice(i, i + slice);
    await withTenant(input.organizationId, async (tx) => {
      const cached = cachingTx(tx, input.businessId, stats, input.maxCachedRows);
      for (const day of chunk) {
        const out = await computeMetricPeriod(cached, input.businessId, input.grain, day, now, {
          onlyNonAdditive: input.onlyNonAdditive ?? false,
          timezone: zone,
          ...(input.measures ? { measures: input.measures } : {}),
        });
        /**
         * Written here, one day at a time, so at most ONE day's rows are ever held — the
         * same bound the sequential backfill keeps. `writeMetricDay` opens its own tenant
         * transaction on a second pooled connection; the transaction this runs inside only
         * ever reads, so the two cannot contend for a lock.
         */
        if (input.write) {
          await writeMetricDay({
            organizationId: input.organizationId,
            businessId: input.businessId,
            grain: input.grain,
            periodEnd: day,
            rows: out,
            ...(input.replaceComputed
              ? {
                  replaceMeasures: computedMeasures({
                    grain: input.grain,
                    periodEnd: day,
                    today: zonedDayString(now, zone),
                    onlyNonAdditive: input.onlyNonAdditive ?? false,
                    ...(input.measures ? { measures: input.measures } : {}),
                  }),
                }
              : {}),
          });
        }
        rows += out.length;
        input.onDay?.(day, out.length);
      }
    });
  }

  return { days: input.days.length, rows, cache: stats };
}

/**
 * The grains a backfill has to COMPUTE rather than fold.
 *
 * `day` is absent on purpose: it is the grain everything additive is stored at, and the
 * coarse pass exists only for the measures that declare `aggregate: "none"`.
 */
export const COARSE_GRAINS: readonly Grain[] = ["week", "month", "quarter", "year"];

/**
 * THE DISTINCT COARSE PERIODS A WINDOW OF DAYS FALLS INSIDE — each named ONCE.
 *
 * 400 days sit inside roughly 57 weeks, 13 months, 5 quarters and 2 years. Walking the days
 * and closing each one's containing month writes that month about 30 times, for the same 30
 * identical rows: 30x the work, and the last write wins anyway. So the set is derived first
 * and each period is computed once.
 *
 * The periods are cut on the business's own `calendar` (week start, fiscal year).
 *
 * ⚠️ THE DAYS MUST ALREADY BE THE BUSINESS'S OWN CALENDAR DATES. `coarsePeriodEnds` is
 * shared with the nightly close rather than re-derived here, and it does plain calendar
 * arithmetic on a `YYYY-MM-DD` — it cannot know which calendar cut that date. Hand it a UTC
 * day for a book that closes at Asia/Kolkata midnight and the month boundary lands on the
 * wrong date, which is the defect the local-day cut removed.
 *
 * Returned NEWEST FIRST: an interrupted run has then filled the periods a screen is most
 * likely to ask for, and the remainder is picked up by re-running.
 *
 * A period at either edge of the window reaches OUTSIDE it — the oldest month begins before
 * the first backfilled day, and the newest may not have closed yet. Both are computed over
 * their own full window, which is the only figure that month has; the running one is
 * restated by every nightly close until it closes.
 */
export function coarsePeriodSet(
  days: readonly string[],
  calendar: BusinessCalendar,
  grains: readonly Grain[] = COARSE_GRAINS,
): Map<Grain, string[]> {
  const wanted = new Set(grains);
  const out = new Map<Grain, Set<string>>();
  for (const g of grains) out.set(g, new Set());
  for (const day of days) {
    for (const [grain, periodEnd] of coarsePeriodEnds(day, calendar)) {
      if (wanted.has(grain)) out.get(grain)!.add(periodEnd);
    }
  }
  return new Map(
    [...out].map(([g, set]) => [g, [...set].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))]),
  );
}

export interface CoarseFillResult {
  /** One entry per grain, in the order they were filled. */
  grains: Array<{ grain: Grain; periods: number; rows: number }>;
  periods: number;
  rows: number;
  cache: CacheStats;
}

/**
 * Fill every coarse period containing `days`, for one business, over the fast path.
 *
 * This is `bulkFillMetricDays` with a wider window and `onlyNonAdditive` — not a second
 * implementation of anything. The same `computeMetricPeriod` runs, over the same cached
 * transaction: a coarse window binds different instants, so its window reads are never
 * served another period's answer, while the standing reads (the book, its items, the
 * discounts, the plan resolution) are the same reads the day pass already caches.
 *
 * `slicePeriods` is deliberately smaller than the day pass's slice. One coarse period costs
 * more than one day — a year's movement window is 365 days of ledger — so the same count of
 * periods per transaction would hold a transaction open far longer, and a long-lived read
 * transaction pins Postgres's oldest snapshot on a box that is also serving live traffic.
 */
/**
 * The measures one period's compute owns: what `computeMetricPeriod` would compute for it.
 * A live-state measure (`asOf: computed_at`) is left out for a past period: it is written only
 * for the period in progress, and its stored history cannot be computed again.
 */
export function computedMeasures(input: {
  grain: Grain;
  periodEnd: string;
  today: string;
  onlyNonAdditive: boolean;
  measures?: ReadonlySet<string>;
}): string[] {
  return MEASURES.filter(
    (m) =>
      m.grains.includes(input.grain) &&
      (!input.onlyNonAdditive || m.aggregate === "none") &&
      (!input.measures || input.measures.has(m.id)) &&
      (m.asOf === "period_end" || input.periodEnd >= input.today),
  ).map((m) => m.id);
}

export async function bulkFillCoarseGrains(input: {
  organizationId: string;
  businessId: string;
  /** The business's own calendar dates, as the day fill uses them. */
  days: readonly string[];
  write: boolean;
  now?: Date;
  grains?: readonly Grain[];
  /** Coarse periods per transaction. */
  slicePeriods?: number;
  maxCachedRows?: number;
  timezone?: string | null;
  /** Looked up when absent. */
  calendar?: BusinessCalendar;
  measures?: ReadonlySet<string>;
  onPeriod?: (grain: Grain, periodEnd: string, rows: number) => void;
  /** See `bulkFillMetricDays`. */
  replaceComputed?: boolean;
}): Promise<CoarseFillResult> {
  const calendar =
    input.calendar ??
    (await withTenant(input.organizationId, (tx) => businessCalendar(tx, input.businessId)));
  const set = coarsePeriodSet(input.days, calendar, input.grains ?? COARSE_GRAINS);
  const cache: CacheStats = { hits: 0, misses: 0, skipped: 0, rows: 0, sqlMs: 0 };
  const grains: CoarseFillResult["grains"] = [];
  let rows = 0;
  let periods = 0;

  for (const [grain, ends] of set) {
    if (ends.length === 0) continue;
    const r = await bulkFillMetricDays({
      organizationId: input.organizationId,
      businessId: input.businessId,
      grain,
      days: ends,
      write: input.write,
      onlyNonAdditive: true,
      ...(input.measures ? { measures: input.measures } : {}),
      ...(input.replaceComputed ? { replaceComputed: true } : {}),
      ...(input.now ? { now: input.now } : {}),
      // `sliceDays` is "periods per transaction"; here a period is a week/month/quarter/year.
      sliceDays: input.slicePeriods ?? 12,
      ...(input.maxCachedRows != null ? { maxCachedRows: input.maxCachedRows } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      ...(input.onPeriod ? { onDay: (d, n) => input.onPeriod!(grain, d, n) } : {}),
    });
    grains.push({ grain, periods: ends.length, rows: r.rows });
    periods += ends.length;
    rows += r.rows;
    cache.hits += r.cache.hits;
    cache.misses += r.cache.misses;
    cache.skipped += r.cache.skipped;
    cache.rows += r.cache.rows;
    cache.sqlMs += r.cache.sqlMs;
  }

  return { grains, periods, rows, cache };
}
