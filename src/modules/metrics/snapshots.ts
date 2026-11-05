import { reportableCustomer } from "./reportable";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { mrrMovements, subscriptions, subscriptionItems, prices, customers } from "@db/schema";
import { zonedDayEndExclusive } from "@/platform/timezones";
import { notDeleted } from "@/modules/subscriptions/deleted-sql";
import {
  committedAt,
  earningAt,
  isActiveAt,
  liveAt,
  MRR_STATUSES,
  nonRenewingAt,
  startOf,
  type Lapse,
  type StockRow,
} from "./stocks";
import { resolveBusinessPlanProductIds, resolvePlanProductIds } from "./plan-of";
import {
  billingIntervalOf,
  loadFirstPaidAt,
  loadPlanAtStart,
  signupCohortOf,
} from "./dimension-values";
import { regionOf } from "./regions";
import { loadActiveDiscounts, reportingMrrBySubscription } from "./mrr";
import { inScope, subscriptionInScope, type BookScope } from "./book-scope";

/**
 * The book at the end of a day — MRR, CMRR and the subscription counts, per currency and by
 * plan, country and attribute. `metric_daily` stores these (daily/compute.ts); nothing here
 * writes.
 *
 * The predicates come from `stocks.ts`, which the live reconstruction also uses: one
 * definition, two readers, so a stored day and a rebuilt one cannot disagree.
 *
 * Per currency, never converted — FX is a reporting choice made at read time.
 */

/** A day's book, one entry per currency the business holds. */
export interface SnapshotRow {
  currency: string;
  mrrMinor: bigint;
  cmrrMinor: bigint;
  activeSubscriptions: number;
  payingSubscriptions: number;
  /** Paying and set to renew — not in its final term before a booked stop. */
  renewingSubscriptions: number;
}

/**
 * The last instant of a calendar day — the same edge the chart buckets are read at.
 *
 * `zone` is the BUSINESS's IANA zone, and the day it names is that business's own calendar
 * day: an operator in Asia/Kolkata means the day that closed at 00:00 IST, not the one that
 * closed at 00:00 UTC five and a half hours later. Omitted or null means UTC, which is the
 * column's own default and what every day written before this was cut on.
 *
 * Derived from the next day's local start rather than by adding 24 hours, because a day on
 * which the clocks move is 23 or 25 hours long.
 */
export function endOfDay(day: string, zone?: string | null): Date {
  return new Date(zonedDayEndExclusive(day, zone).getTime() - 1);
}

/** `YYYY-MM-DD` for a UTC instant. */
export function utcDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The columns every stock reader needs. Exported so the analytics-store writer selects the
 * SAME set: it builds per-subscription rows that must sum back to `computeSnapshot`, and
 * two hand-written column lists is how those two stop agreeing.
 */
export const stockFields = {
  id: subscriptions.id,
  status: subscriptions.status,
  currency: subscriptions.currency,
  mrr: subscriptions.mrr,
  // 0271: the rate a cancelled row last carried while earning — what the history reads.
  lastEarningMrr: subscriptions.lastEarningMrr,
  createdAt: subscriptions.createdAt,
  startDate: subscriptions.startDate,
  startedAt: subscriptions.startedAt,
  canceledAt: subscriptions.canceledAt,
  cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
  cancelScheduledAt: subscriptions.cancelScheduledAt,
  cancelBookedAt: subscriptions.cancelBookedAt,
  currentPeriodStart: subscriptions.currentPeriodStart,
  currentPeriodEnd: subscriptions.currentPeriodEnd,
  trialEnd: subscriptions.trialEnd,
  trialStart: subscriptions.trialStart,
  activatedAt: subscriptions.activatedAt,
  billingPeriod: subscriptions.billingPeriod,
  billingPeriodUnit: subscriptions.billingPeriodUnit,
  remainingBillingCycles: subscriptions.remainingBillingCycles,
};

/** Every column any reader of the book needs within one period's compute. */
const bookReadFields = {
  ...stockFields,
  customerId: subscriptions.customerId,
  billingAnchorDay: subscriptions.billingAnchorDay,
  country: customers.country,
};

// `async`, not a bare builder: a drizzle builder runs its query again on every `await`.
const readWholeBook = async (tx: Tx, businessId: string, scope?: BookScope | null) =>
  await tx
    .select(bookReadFields)
    .from(subscriptions)
    .leftJoin(customers, eq(customers.id, subscriptions.customerId))
    .where(
      and(
        and(eq(subscriptions.businessId, businessId), reportableCustomer(subscriptions.customerId)),
        notDeleted(),
        inScope(sql`${subscriptions.customerId}`, scope),
      ),
    );

export type BookReadRow = Awaited<ReturnType<typeof readWholeBook>>[number];

/** The book, read once per cache. The snapshot readers share these rows as they are. */
export function cachedBook(
  tx: Tx,
  businessId: string,
  cache: SnapshotMrrCache,
): Promise<BookReadRow[]> {
  return (cache.book ??= readWholeBook(tx, businessId, cache.scope));
}

/**
 * The cached book as ONE reader selects it: exactly the keys of `fields`, values shared. The
 * keys matter, not just the values: a missing `activatedAt` or `lapses` reads differently from
 * a present one, and each reader was written against its own column list.
 */
export async function bookAs<F extends Partial<Record<keyof BookReadRow, unknown>>>(
  tx: Tx,
  businessId: string,
  fields: F,
  cache: SnapshotMrrCache,
): Promise<Array<{ [K in keyof F & keyof BookReadRow]: BookReadRow[K] }>> {
  const keys = Object.keys(fields) as Array<keyof F & keyof BookReadRow>;
  return (await cachedBook(tx, businessId, cache)).map((r) => {
    const o = {} as { [K in keyof F & keyof BookReadRow]: BookReadRow[K] };
    for (const k of keys) o[k] = r[k];
    return o;
  });
}

/**
 * The cached book itself, typed as one reader's columns: no copy. The rows carry every other
 * column too, and `lapses` once a snapshot reader has attached them, so only a reader that
 * reads its columns by name — never an optional `StockRow` field it did not select, never the
 * keys — may take it. Shared: never mutate a row or the array.
 */
export async function bookShared<F extends Partial<Record<keyof BookReadRow, unknown>>>(
  tx: Tx,
  businessId: string,
  _fields: F,
  cache: SnapshotMrrCache,
): Promise<Array<Pick<BookReadRow, keyof F & keyof BookReadRow>>> {
  return cachedBook(tx, businessId, cache);
}

/** `load()` once per cache under `key`; uncached when there is no cache. */
export function sharedRead<T>(
  cache: SnapshotMrrCache | undefined,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  if (!cache) return load();
  cache.shared ??= new Map();
  let p = cache.shared.get(key) as Promise<T> | undefined;
  if (!p) cache.shared.set(key, (p = load()));
  return p;
}

/** Row shape the re-rating reads: the stock predicates' fields plus the cached column. */
export type MrrRow = StockRow & {
  mrr: bigint | null;
  lastEarningMrr?: bigint | null;
  activatedAt?: Date | null;
};

/**
 * One day's re-rated MRR, shared by the three compute functions of that day.
 *
 * The totals, the plan slice and the country slice group the SAME book three ways, so they
 * must rate it identically or the slices stop summing to the total. The first of them to
 * run fills this; the other two read it. Created by `writeSnapshot` and by the semantic
 * layer's period compute; omitted, each function rates the day itself.
 */
export interface SnapshotMrrCache {
  mrr?: DayMrr;
  lapses?: Map<string, Lapse[]>;
  /**
   * The rest serve one `computeMetricPeriod` call: reads that do not depend on the day, or
   * keyed by the instant they answer. Without them a period read the whole book 11 times.
   */
  book?: Promise<BookReadRow[]>;
  ledger?: Promise<LedgerIndex>;
  discounts?: Promise<Awaited<ReturnType<typeof loadActiveDiscounts>>>;
  shared?: Map<string, Promise<unknown>>;
  /** The slice of the book this cache reads (`book-scope.ts`); absent is the whole book. */
  scope?: BookScope | null;
}

/**
 * One day's MRR per subscription, in two readings.
 *
 * `earned` is what it earned at the day's end: its LEDGER balance then (Σ `mrr_movements`
 * delta up to that instant), so a rate that changed later is not projected backwards and the
 * stock always equals the movements that built it. A subscription with no ledger rows at all
 * falls back to `rated` × `earningAt`, so a book the ledger does not cover yet is no worse.
 *
 * `rated` is its CURRENT rate — only CMRR reads it, and only for a committed subscription
 * the ledger has not booked by then (`booked`), where the ledger has nothing to say.
 */
export interface DayMrr {
  earned: Map<string, bigint>;
  rated: Map<string, bigint>;
  booked: LedgerBooked;
}
export const snapshotMrrCache = (): SnapshotMrrCache => ({});

/**
 * MRR per subscription for one stored day: the cached `subscriptions.mrr` column, except
 * for CANCELLED rows, which carry `last_earning_mrr` (0271) — the rate they held while they
 * were earning — through `reportingMrrBySubscription`, the same rule `analytics.ts` reads.
 *
 * Without this a stored day sums the column verbatim, and that column is deliberately 0
 * once a row is cancelled: every past day lost the rate a subscription was actually being
 * billed the moment it churned, so last year's MRR fell when something churned today.
 *
 * The ITEM READ below is the fallback path only, for cancelled rows with nothing stored —
 * ones that churned before 0271 and have not been backfilled. It re-rates from the
 * surviving items, which is gross for a comped subscription because the discounts do not
 * survive the cancellation; that is the defect 0271 closes, kept here so an un-backfilled
 * book is no worse than it was. A fully backfilled business does this read not at all.
 *
 * Bounded to the cancelled rows LIVE at `at` — the only ones this day can count. CMRR
 * excludes cancelled outright (`committedAt`) and the active count reduces to `liveAt` for
 * them, so nothing outside that set reaches a figure; a cancelled row with no items read
 * falls back to its column, which is the 0 it already contributed.
 *
 * Caveat kept, not fixed: a rate is one number per subscription, so one whose plan changed
 * before it churned is measured at its final rate. We keep no composition history to do
 * better.
 */
export async function loadReratedMrr(
  tx: Tx,
  businessId: string,
  rows: MrrRow[],
  at: Date,
  cache?: SnapshotMrrCache,
): Promise<Map<string, bigint>> {
  // Only the cancelled rows with NO stored rate need the fallback re-rate; everything else
  // answers from a column.
  // A trial cancelled without ever activating earned nothing: it keeps no rate, and re-rating
  // its items would price its unpaid trial at list.
  const rerateIds = rows
    .filter(
      (s) =>
        s.status === "cancelled" &&
        liveAt(s, at) &&
        s.lastEarningMrr == null &&
        !(s.trialStart != null && s.activatedAt == null),
    )
    .map((s) => s.id);

  // Chunked at 500: one id is one bind parameter and Postgres caps a statement at 65,534.
  const items: {
    item: typeof subscriptionItems.$inferSelect;
    price: typeof prices.$inferSelect;
  }[] = [];
  for (let i = 0; i < rerateIds.length; i += 500) {
    const chunk = await tx
      .select({ item: subscriptionItems, price: prices })
      .from(subscriptionItems)
      .innerJoin(prices, eq(subscriptionItems.priceId, prices.id))
      .where(inArray(subscriptionItems.subscriptionId, rerateIds.slice(i, i + 500)));
    for (const r of chunk) items.push(r);
  }

  return reportingMrrBySubscription({
    subs: rows,
    items: items.map((r) => ({
      subscriptionId: r.item.subscriptionId,
      price: r.price,
      quantity: r.item.quantity,
      snapshot: r.item.priceSnapshot,
    })),
    discounts:
      rerateIds.length === 0
        ? new Map()
        : await (cache
            ? (cache.discounts ??= loadActiveDiscounts(tx, businessId))
            : loadActiveDiscounts(tx, businessId)),
    cadence: new Map(
      rows.map((s) => [
        s.id,
        { interval: s.billingPeriodUnit ?? "month", intervalCount: s.billingPeriod ?? 1 },
      ]),
    ),
  });
}

/**
 * Each subscription's ledger balance at `at`, for every subscription with ANY ledger row —
 * a zero balance is kept, because "in the ledger, earning nothing then" must not fall back.
 */
export async function loadLedgerMrrAt(
  tx: Tx,
  businessId: string,
  at: Date,
  cache?: SnapshotMrrCache,
): Promise<LedgerBalances> {
  return (await loadLedgerAt(tx, businessId, at, cache)).balances;
}

export type LedgerBalances = Pick<ReadonlyMap<string, bigint>, "get" | "has">;
export type LedgerBooked = Pick<ReadonlySet<string>, "has">;
export interface LedgerAt {
  balances: LedgerBalances;
  booked: LedgerBooked;
}

/** `loadLedgerMrrAt`, plus which subscriptions had a movement by `at` — see `committedMrrOf`. */
export async function loadLedgerAt(
  tx: Tx,
  businessId: string,
  at: Date,
  cache?: SnapshotMrrCache,
): Promise<LedgerAt> {
  if (!cache) return readLedgerAt(tx, businessId, at);
  // A period asks about many instants: read the ledger once and answer each from memory.
  return ledgerViewAt(await (cache.ledger ??= readLedgerIndex(tx, businessId, cache.scope)), at);
}

/**
 * The whole ledger, grouped by subscription and ordered by time, with a running balance.
 * Times are epoch MICROseconds, as Postgres compares them: a Date would round a movement at
 * `…59.999500` onto the `…59.999` day end and count it a day early.
 */
interface LedgerIndex {
  slot: Map<string, number>;
  /** Rows of slot k are `[bounds[k], bounds[k + 1])`. */
  bounds: Int32Array;
  us: Float64Array;
  balance: BigInt64Array;
}

async function readLedgerIndex(
  tx: Tx,
  businessId: string,
  scope?: BookScope | null,
): Promise<LedgerIndex> {
  const rows = (await tx.execute(sql`
    select subscription_id::text as id,
           (extract(epoch from occurred_at) * 1000000)::float8 as us,
           delta_minor::text as d
    from ${mrrMovements}
    where business_id = ${businessId} and subscription_id is not null
      and ${subscriptionInScope(sql`subscription_id`, businessId, scope)}
    order by subscription_id, occurred_at
  `)) as unknown as Array<{ id: string; us: number; d: string }>;
  const slot = new Map<string, number>();
  const starts: number[] = [];
  const us = new Float64Array(rows.length);
  const balance = new BigInt64Array(rows.length);
  let run = 0n;
  rows.forEach((r, i) => {
    if (!slot.has(r.id)) {
      slot.set(r.id, starts.length);
      starts.push(i);
      run = 0n;
    }
    run += BigInt(r.d);
    if (BigInt.asIntN(64, run) !== run) throw new Error(`ledger balance overflows int64: ${r.id}`);
    us[i] = r.us;
    balance[i] = run;
  });
  starts.push(rows.length);
  return { slot, bounds: Int32Array.from(starts), us, balance };
}

/** Read-only views of the index at `at`; no per-instant copy of the book. */
function ledgerViewAt(ix: LedgerIndex, at: Date): LedgerAt {
  const atUs = at.getTime() * 1000;
  // The last row of `id` at or before `at`, or -1 when it has none by then.
  const lastAt = (k: number): number => {
    let lo = ix.bounds[k]!;
    let hi = ix.bounds[k + 1]! - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (ix.us[mid]! <= atUs) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  return {
    balances: {
      has: (id) => ix.slot.has(id),
      get: (id) => {
        const k = ix.slot.get(id);
        if (k === undefined) return undefined;
        const j = lastAt(k);
        return j < 0 ? 0n : ix.balance[j]!;
      },
    },
    booked: {
      has: (id) => {
        const k = ix.slot.get(id);
        return k !== undefined && lastAt(k) >= 0;
      },
    },
  };
}

async function readLedgerAt(tx: Tx, businessId: string, at: Date): Promise<LedgerAt> {
  const rows = await tx
    .select({
      subscriptionId: mrrMovements.subscriptionId,
      balance: sql<string>`coalesce(sum(${mrrMovements.deltaMinor}) filter (where ${mrrMovements.occurredAt} <= ${at.toISOString()}::timestamptz), 0)`,
      booked: sql<boolean>`bool_or(${mrrMovements.occurredAt} <= ${at.toISOString()}::timestamptz)`,
    })
    .from(mrrMovements)
    .where(
      and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
    )
    .groupBy(mrrMovements.subscriptionId);
  return {
    balances: new Map(rows.map((r) => [r.subscriptionId, BigInt(r.balance)])),
    booked: new Set(rows.filter((r) => r.booked).map((r) => r.subscriptionId)),
  };
}

/**
 * Each subscription's closed cancelled stretches, from the ledger: a `churn` and the
 * `reactivation` that ended it. Reversal rows (a churn booked positive, a reactivation
 * negative) are corrections, not stops or restarts, so only the signed ones pair.
 *
 * A reactivation at zero MRR books no movement, so a live row whose last churn has no
 * reactivation after it closes that stretch at `start_date`, which every reactivation
 * re-stamps to its term start.
 */
export async function loadLapses(
  tx: Tx,
  businessId: string,
  scope?: BookScope | null,
): Promise<Map<string, Lapse[]>> {
  const rows = (await tx.execute(sql`
    select r.subscription_id, c.occurred_at as from_at, r.occurred_at as to_at
    from ${mrrMovements} r
    cross join lateral (
      select max(m.occurred_at) as occurred_at from ${mrrMovements} m
      where m.subscription_id = r.subscription_id and m.reason = 'churn' and m.delta_minor < 0
        and m.occurred_at <= r.occurred_at
    ) c
    where r.business_id = ${businessId} and r.reason = 'reactivation' and r.delta_minor > 0
      and c.occurred_at is not null
      and ${subscriptionInScope(sql`r.subscription_id`, businessId, scope)}
    union all
    select s.id, c.occurred_at, s.start_date
    from ${subscriptions} s
    cross join lateral (
      select max(m.occurred_at) as occurred_at from ${mrrMovements} m
      where m.subscription_id = s.id and m.reason = 'churn' and m.delta_minor < 0
    ) c
    where s.business_id = ${businessId} and s.canceled_at is null
      and ${inScope(sql`s.customer_id`, scope)}
      and s.start_date > c.occurred_at
      and not exists (
        select 1 from ${mrrMovements} r
        where r.subscription_id = s.id and r.reason = 'reactivation' and r.delta_minor > 0
          and r.occurred_at >= c.occurred_at
      )
  `)) as unknown as Array<{ subscription_id: string; from_at: string; to_at: string }>;
  const out = new Map<string, Lapse[]>();
  for (const r of rows) {
    const list = out.get(r.subscription_id) ?? [];
    list.push({ from: new Date(r.from_at), to: new Date(r.to_at) });
    out.set(r.subscription_id, list);
  }
  return out;
}

/** Attach `loadLapses`' stretches to loaded rows, in place. */
export function attachLapses<T extends { id: string }>(
  rows: T[],
  lapses: ReadonlyMap<string, Lapse[]>,
): T[] {
  for (const r of rows) (r as T & { lapses?: Lapse[] }).lapses = lapses.get(r.id);
  return rows;
}

/** `loadLapses`, once per day across the compute functions that share a cache. */
export async function lapsesForDay(
  tx: Tx,
  businessId: string,
  cache?: SnapshotMrrCache,
): Promise<Map<string, Lapse[]>> {
  if (cache?.lapses) return cache.lapses;
  const lapses = await loadLapses(tx, businessId, cache?.scope);
  if (cache) cache.lapses = lapses;
  return lapses;
}

/** One ledger row, as the in-memory readers hold it. */
export interface LedgerRow {
  subscriptionId: string;
  occurredAt: Date;
  deltaMinor: bigint;
}

/** A business's whole ledger, oldest first — for readers that ask about many instants. */
export async function loadLedgerRows(tx: Tx, businessId: string): Promise<LedgerRow[]> {
  const rows = await tx
    .select({
      subscriptionId: mrrMovements.subscriptionId,
      occurredAt: mrrMovements.occurredAt,
      deltaMinor: mrrMovements.deltaMinor,
    })
    .from(mrrMovements)
    .where(
      and(eq(mrrMovements.businessId, businessId), reportableCustomer(mrrMovements.customerId)),
    )
    .orderBy(mrrMovements.occurredAt);
  return rows;
}

/** `loadLedgerMrrAt` over rows already in memory (sorted by `occurredAt`). */
export function ledgerBalancesAt(rows: readonly LedgerRow[], at: Date): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const r of rows) if (!out.has(r.subscriptionId)) out.set(r.subscriptionId, 0n);
  for (const r of rows) {
    if (r.occurredAt > at) break;
    out.set(r.subscriptionId, out.get(r.subscriptionId)! + r.deltaMinor);
  }
  return out;
}

/**
 * `ledgerBalancesAt` and `ledgerBookedAt` for many instants, from one pass over the rows while
 * the instants rise — a chart asks them in order. The same `Date` comparisons, so the same
 * answers; an earlier instant starts the pass again. Rescanning every row per instant was
 * instants × rows: 21 s of Business Home on a 240k-subscription book (D4.5).
 *
 * ⚠ `balancesAt` returns the pass's own map, valid only until the next call: read it, do not
 * keep it. `bookedAt` keeps nothing — booked by `at` is "first movement at or before `at`".
 */
export function ledgerSweep(rows: readonly LedgerRow[]): {
  balancesAt: (at: Date) => ReadonlyMap<string, bigint>;
  bookedAt: (at: Date) => LedgerBooked;
  /** Whether the subscription has any ledger row at all. */
  has: (id: string) => boolean;
  /** Changes whenever `balancesAt` moved a balance: equal versions, equal balances. */
  version: () => number;
} {
  const zeroed = new Map<string, bigint>();
  const firstAt = new Map<string, Date>();
  for (const r of rows) {
    if (!zeroed.has(r.subscriptionId)) {
      zeroed.set(r.subscriptionId, 0n);
      firstAt.set(r.subscriptionId, r.occurredAt);
    }
  }
  let next = 0;
  let last = -Infinity;
  let version = 0;
  let balances = new Map(zeroed);
  return {
    balancesAt: (at) => {
      if (at.getTime() < last && next > 0) {
        next = 0;
        version++;
        balances = new Map(zeroed);
      }
      last = at.getTime();
      const from = next;
      for (; next < rows.length; next++) {
        const r = rows[next]!;
        if (r.occurredAt > at) break;
        balances.set(r.subscriptionId, balances.get(r.subscriptionId)! + r.deltaMinor);
      }
      if (next > from) version++;
      return balances;
    },
    has: (id) => zeroed.has(id),
    version: () => version,
    bookedAt: (at) => ({
      has: (id: string) => {
        const first = firstAt.get(id);
        return first !== undefined && !(first > at);
      },
    }),
  };
}

/** Subscriptions with a ledger movement at or before `at`, over rows sorted by `occurredAt`. */
export function ledgerBookedAt(rows: readonly LedgerRow[], at: Date): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.occurredAt > at) break;
    out.add(r.subscriptionId);
  }
  return out;
}

/**
 * A COMMITTED subscription's CMRR at `at` — the one rule every CMRR reader shares.
 *
 * Once the ledger has booked the subscription, its balance then is the answer, zero
 * included: a trial (the engine books it and reverses it at trial start), a lapse or a churn
 * earned nothing, and today's rate must not be read back into those days — a plan change
 * after conversion would rewrite every one of them. Only a subscription that has NOT STARTED
 * by `at` and is not booked yet (a future start) is committed at its `rated` rate.
 *
 * `started` is what keeps an unbooked past out of that fallback: a subscription whose first
 * ledger row came later — an imported trial that was cancelled, then reactivated — earned
 * nothing before it, and today's rate must not fill that gap.
 */
export function committedMrrOf(
  id: string,
  earned: Pick<ReadonlyMap<string, bigint>, "get">,
  booked: LedgerBooked,
  rated: bigint,
  started: boolean,
): bigint {
  const e = earned.get(id) ?? 0n;
  return e !== 0n || booked.has(id) || started ? e : rated;
}

/**
 * What each subscription EARNED at `at` — the one definition every stock reader shares.
 *
 * Its ledger balance then, when it has any ledger row; otherwise `rated` while `earningAt`
 * holds. Zeros are omitted, so `get(id) ?? 0n` is the answer for any id.
 */
export function earnedAt(
  subs: readonly (StockRow & { id: string })[],
  ledger: LedgerBalances,
  rated: Map<string, bigint>,
  at: Date,
): Map<string, bigint> {
  const earned = new Map<string, bigint>();
  for (const s of subs) {
    const fromLedger = ledger.get(s.id);
    const value =
      fromLedger !== undefined ? fromLedger : earningAt(s, at) ? (rated.get(s.id) ?? 0n) : 0n;
    if (value !== 0n) earned.set(s.id, value);
  }
  return earned;
}

/** Fill the shared cache on first use, or rate the day standalone when there is none. */
async function mrrForDay(
  tx: Tx,
  businessId: string,
  rows: MrrRow[],
  at: Date,
  cache?: SnapshotMrrCache,
): Promise<DayMrr> {
  if (cache?.mrr) return cache.mrr;
  const rated = await loadReratedMrr(tx, businessId, rows, at, cache);
  const ledger = await loadLedgerAt(tx, businessId, at, cache);
  const earned = earnedAt(rows, ledger.balances, rated, at);
  const book = { earned, rated, booked: ledger.booked };
  if (cache) cache.mrr = book;
  return book;
}

/**
 * Compute (but do not store) the book at the end of `day`, per currency.
 *
 * MRR is each subscription's LEDGER balance at the day's end (`DayMrr`), so a later rate
 * change stays in the day it happened; `loadReratedMrr` covers rows the ledger does not. The
 * customer's country below is still read as it stands today.
 */
export async function computeSnapshot(
  tx: Tx,
  businessId: string,
  day: string,
  cache?: SnapshotMrrCache,
  /** The business's IANA zone — `day` is its local calendar day. Omitted means UTC. */
  zone?: string | null,
): Promise<SnapshotRow[]> {
  const at = endOfDay(day, zone);
  const rows = cache
    ? await cachedBook(tx, businessId, cache)
    : await tx
        .select(stockFields)
        .from(subscriptions)
        .where(
          and(
            and(
              eq(subscriptions.businessId, businessId),
              reportableCustomer(subscriptions.customerId),
            ),
            notDeleted(),
          ),
        );
  attachLapses(rows, await lapsesForDay(tx, businessId, cache));
  const book = await mrrForDay(tx, businessId, rows as unknown as MrrRow[], at, cache);

  const byCurrency = new Map<string, SnapshotRow>();
  const bucket = (ccy: string): SnapshotRow => {
    const key = ccy.toUpperCase();
    let row = byCurrency.get(key);
    if (!row) {
      row = {
        currency: key,
        mrrMinor: 0n,
        cmrrMinor: 0n,
        activeSubscriptions: 0,
        payingSubscriptions: 0,
        renewingSubscriptions: 0,
      };
      byCurrency.set(key, row);
    }
    return row;
  };

  for (const r of rows) {
    const s = r as unknown as StockRow;
    const earned = book.earned.get(r.id) ?? 0n;
    const b = bucket(r.currency);
    b.mrrMinor += earned;
    if (committedAt(s, at))
      b.cmrrMinor += committedMrrOf(
        r.id,
        book.earned,
        book.booked,
        book.rated.get(r.id) ?? 0n,
        startOf(s) <= at,
      );
    // Earning per the ledger is active then, whatever the row's (possibly reset) start says.
    if (earned > 0n || (MRR_STATUSES.has(r.status) && isActiveAt(s, at))) {
      b.activeSubscriptions += 1;
      if (earned > 0n) {
        b.payingSubscriptions += 1;
        if (!nonRenewingAt(s, at)) b.renewingSubscriptions += 1;
      }
    }
  }
  // A currency with nothing in it on that day is dropped rather than stored as zeros: the
  // row would claim the business held that currency on a day it did not.
  return [...byCurrency.values()].filter(
    (r) => r.mrrMinor !== 0n || r.cmrrMinor !== 0n || r.activeSubscriptions > 0,
  );
}

/** A day's book, split by plan (Phase 2 continued) — the dimension `mrr_snapshot_plans` stores. */
export interface SnapshotPlanRow {
  currency: string;
  /** NULL = "no plan" (charges-only subscriptions), not "all plans" — never dropped. */
  planProductId: string | null;
  mrrMinor: bigint;
  activeSubscriptions: number;
  payingSubscriptions: number;
  /** Paying and set to renew — not in its final term before a booked stop. */
  renewingSubscriptions: number;
}

// A key that treats `null` as its own bucket rather than colliding with an empty string.
const planKey = (currency: string, planProductId: string | null): string =>
  `${currency} ${planProductId ?? " "}`;

/**
 * Compute (but do not store) the book at the end of `day`, split by plan.
 *
 * Same query, same predicates as `computeSnapshot` — `MRR_STATUSES`/`liveAt`/`isActiveAt`
 * from `stocks.ts` — so a per-plan total can never disagree with the business total: every
 * subscription that contributes to one contributes identically to the other, just grouped
 * differently. The plan itself comes from `resolvePlanProductId` (`plan-of.ts`), the one
 * shared rule — never re-derived here.
 *
 * No CMRR here (see the schema comment on `mrr_snapshot_plans`) — only what "MRR by plan
 * over time" needs. Plan resolution is skipped for a subscription that contributes to
 * neither MRR nor the active count on this day, since a business's whole history is
 * scanned and most rows on most days are irrelevant to it.
 */
export async function computeSnapshotByPlan(
  tx: Tx,
  businessId: string,
  day: string,
  cache?: SnapshotMrrCache,
  /** The business's IANA zone — `day` is its local calendar day. Omitted means UTC. */
  zone?: string | null,
): Promise<SnapshotPlanRow[]> {
  const at = endOfDay(day, zone);
  const rows = cache
    ? await cachedBook(tx, businessId, cache)
    : await tx
        .select(stockFields)
        .from(subscriptions)
        .where(
          and(
            and(
              eq(subscriptions.businessId, businessId),
              reportableCustomer(subscriptions.customerId),
            ),
            notDeleted(),
          ),
        );
  attachLapses(rows, await lapsesForDay(tx, businessId, cache));
  const book = await mrrForDay(tx, businessId, rows as unknown as MrrRow[], at, cache);

  const byKey = new Map<string, SnapshotPlanRow>();
  const bucket = (ccy: string, planProductId: string | null): SnapshotPlanRow => {
    const currency = ccy.toUpperCase();
    const key = planKey(currency, planProductId);
    let row = byKey.get(key);
    if (!row) {
      row = {
        currency,
        planProductId,
        mrrMinor: 0n,
        activeSubscriptions: 0,
        payingSubscriptions: 0,
        renewingSubscriptions: 0,
      };
      byKey.set(key, row);
    }
    return row;
  };

  /**
   * Plans for every subscription this day counts, in ONE query.
   *
   * This resolved the plan INSIDE the loop below, so a business with 100,000 subscriptions
   * issued 100,000 sequential queries per day — 0.96 ms each measured on a warm local
   * database, i.e. ~96 s for one day and ~1.9 hours for a 71-day backfill, against ~1.2 s
   * for the totals pass over the same book. The filter runs first so the batch asks only
   * about subscriptions that will actually be counted.
   */
  const counted = rows.filter((r) => {
    const s = r as unknown as StockRow;
    // Earning per the ledger counts even where the row's dates say otherwise (a reactivation
    // resets its start), or the plan rows would stop summing to the total.
    return (
      book.earned.has(r.id) || (MRR_STATUSES.has(r.status) && (liveAt(s, at) || isActiveAt(s, at)))
    );
  });
  // Every counted row, i.e. (nearly) the whole book: one business-wide read, shared per run.
  const plans = await sharedRead(cache, "businessPlans", () =>
    resolveBusinessPlanProductIds(tx, businessId, cache?.scope),
  );

  for (const r of counted) {
    const s = r as unknown as StockRow;
    const earned = book.earned.get(r.id) ?? 0n;
    const countsForActive = earned > 0n || (MRR_STATUSES.has(r.status) && isActiveAt(s, at));
    const planProductId = plans.get(r.id) ?? null;
    const b = bucket(r.currency, planProductId);
    b.mrrMinor += earned;
    if (countsForActive) {
      b.activeSubscriptions += 1;
      if (earned > 0n) {
        b.payingSubscriptions += 1;
        if (!nonRenewingAt(s, at)) b.renewingSubscriptions += 1;
      }
    }
  }
  // A plan with nothing on this day writes no row — same rule as the totals table, and for
  // the same reason: a row of zeros would claim the plan existed on this book that day.
  return [...byKey.values()].filter((r) => r.mrrMinor !== 0n || r.activeSubscriptions > 0);
}

/**
 * A day's book, split by the customer's COUNTRY (Phase 4c) — what `mrr_snapshot_countries`
 * stores.
 */
export interface SnapshotCountryRow {
  currency: string;
  /** NULL = "Unknown" (no country on the customer), not "all countries" — never dropped. */
  country: string | null;
  mrrMinor: bigint;
  activeSubscriptions: number;
  payingSubscriptions: number;
  /** Paying and set to renew — not in its final term before a booked stop. */
  renewingSubscriptions: number;
}

// `null` gets its own key rather than colliding with a two-letter code or an empty string.
const countryKey = (currency: string, country: string | null): string =>
  `${currency} ${country ?? " "}`;

/**
 * Compute (but do not store) the book at the end of `day`, split by customer country.
 *
 * Same query and the same `stocks.ts` predicates as `computeSnapshot`, with one left join:
 * a subscription that contributes to the business total contributes identically here, just
 * bucketed differently, so the per-country rows always SUM to the total. That identity is
 * the reason the join is LEFT and the reason NULL is kept — a customer with no country on
 * file lands in the Unknown bucket rather than out of the breakdown.
 *
 * The country is read as it stands NOW. A customer that moves restates from this day
 * forward; days already written keep the country the book had when they were computed,
 * which is what a historical series means. The same limitation as the cached MRR above.
 */
export async function computeSnapshotByCountry(
  tx: Tx,
  businessId: string,
  day: string,
  cache?: SnapshotMrrCache,
  /** The business's IANA zone — `day` is its local calendar day. Omitted means UTC. */
  zone?: string | null,
): Promise<SnapshotCountryRow[]> {
  const at = endOfDay(day, zone);
  const rows = cache
    ? await cachedBook(tx, businessId, cache)
    : await tx
        .select({ ...stockFields, country: customers.country })
        .from(subscriptions)
        .leftJoin(customers, eq(customers.id, subscriptions.customerId))
        .where(
          and(
            and(
              eq(subscriptions.businessId, businessId),
              reportableCustomer(subscriptions.customerId),
            ),
            notDeleted(),
          ),
        );
  attachLapses(rows, await lapsesForDay(tx, businessId, cache));
  const book = await mrrForDay(tx, businessId, rows as unknown as MrrRow[], at, cache);

  const byKey = new Map<string, SnapshotCountryRow>();
  const bucket = (ccy: string, country: string | null): SnapshotCountryRow => {
    const currency = ccy.toUpperCase();
    const key = countryKey(currency, country);
    let row = byKey.get(key);
    if (!row) {
      row = {
        currency,
        country,
        mrrMinor: 0n,
        activeSubscriptions: 0,
        payingSubscriptions: 0,
        renewingSubscriptions: 0,
      };
      byKey.set(key, row);
    }
    return row;
  };

  for (const r of rows) {
    const s = r as unknown as StockRow;
    const earned = book.earned.get(r.id) ?? 0n;
    const country = r.country ? r.country.toUpperCase() : null;
    const b = bucket(r.currency, country);
    b.mrrMinor += earned;
    if (earned > 0n || (MRR_STATUSES.has(r.status) && isActiveAt(s, at))) {
      b.activeSubscriptions += 1;
      if (earned > 0n) {
        b.payingSubscriptions += 1;
        if (!nonRenewingAt(s, at)) b.renewingSubscriptions += 1;
      }
    }
  }
  // A country with nothing on this day writes no row — same rule as the other two tables.
  return [...byKey.values()].filter((r) => r.mrrMinor !== 0n || r.activeSubscriptions > 0);
}

/** The dimensions `computeSnapshotByAttributes` cuts the book by, in one pass. */
export const ATTRIBUTE_DIMS = [
  "billing_interval",
  "region",
  "plan_at_start",
  "signup_cohort",
] as const;
export type AttributeDim = (typeof ATTRIBUTE_DIMS)[number];

/** One bucket of one attribute dimension. `key` is never empty: a missing value is `none`. */
export interface SnapshotAttributeRow {
  dim: AttributeDim;
  key: string;
  currency: string;
  mrrMinor: bigint;
  cmrrMinor: bigint;
  activeSubscriptions: number;
  payingSubscriptions: number;
  renewingSubscriptions: number;
}

/**
 * The book at the end of `day`, cut by each requested attribute dimension — one read of the
 * book for all of them. Same predicates and the same shared MRR as `computeSnapshot`, and
 * every subscription lands in exactly one bucket per dimension, so each dimension's rows sum
 * to the total, CMRR included.
 *
 * - `billing_interval` — the subscription's cadence (`billingIntervalOf`), as it stands now.
 * - `region` — the customer's country through `regionOf`, as it stands now.
 * - `plan_at_start` — the plan on its earliest plan-bearing ledger row, else its current plan.
 * - `signup_cohort` — the month the customer first paid, `none` if not yet paid at that day.
 */
export async function computeSnapshotByAttributes(
  tx: Tx,
  businessId: string,
  day: string,
  dims: readonly AttributeDim[],
  cache?: SnapshotMrrCache,
  zone?: string | null,
): Promise<SnapshotAttributeRow[]> {
  if (dims.length === 0) return [];
  const at = endOfDay(day, zone);
  const rows = cache
    ? await cachedBook(tx, businessId, cache)
    : await tx
        .select({
          ...stockFields,
          customerId: subscriptions.customerId,
          country: customers.country,
        })
        .from(subscriptions)
        .leftJoin(customers, eq(customers.id, subscriptions.customerId))
        .where(
          and(
            and(
              eq(subscriptions.businessId, businessId),
              reportableCustomer(subscriptions.customerId),
            ),
            notDeleted(),
          ),
        );
  attachLapses(rows, await lapsesForDay(tx, businessId, cache));
  const book = await mrrForDay(tx, businessId, rows as unknown as MrrRow[], at, cache);

  const contributes = (r: (typeof rows)[number]): boolean => {
    const s = r as unknown as StockRow;
    return (
      book.earned.has(r.id) ||
      committedAt(s, at) ||
      (MRR_STATUSES.has(r.status) && isActiveAt(s, at))
    );
  };
  const counted = rows.filter(contributes);

  const want = new Set(dims);
  const startPlans = want.has("plan_at_start")
    ? await sharedRead(cache, "planAtStart", () =>
        loadPlanAtStart(tx, businessId, { scope: cache?.scope }),
      )
    : null;
  const currentPlans = startPlans
    ? await resolvePlanProductIds(
        tx,
        counted.filter((r) => !startPlans.has(r.id)).map((r) => r.id),
      )
    : null;
  const firstPaid = want.has("signup_cohort")
    ? await sharedRead(cache, "firstPaid", () =>
        loadFirstPaidAt(tx, businessId, { scope: cache?.scope }),
      )
    : null;

  const keyOf = (dim: AttributeDim, r: (typeof rows)[number]): string => {
    switch (dim) {
      case "billing_interval":
        return billingIntervalOf(r.billingPeriod, r.billingPeriodUnit);
      case "region":
        return regionOf(r.country);
      case "plan_at_start":
        return startPlans!.get(r.id) ?? currentPlans!.get(r.id) ?? "none";
      case "signup_cohort":
        return signupCohortOf(firstPaid!.get(r.customerId), zone, at);
    }
  };

  const byKey = new Map<string, SnapshotAttributeRow>();
  for (const r of counted) {
    const s = r as unknown as StockRow;
    const earned = book.earned.get(r.id) ?? 0n;
    const cmrr = committedAt(s, at)
      ? committedMrrOf(r.id, book.earned, book.booked, book.rated.get(r.id) ?? 0n, startOf(s) <= at)
      : 0n;
    const active = earned > 0n || (MRR_STATUSES.has(r.status) && isActiveAt(s, at));
    const paying = active && earned > 0n;
    const renewing = paying && !nonRenewingAt(s, at);
    const currency = r.currency.toUpperCase();
    for (const dim of dims) {
      const key = keyOf(dim, r);
      const k = `${dim}\u0000${currency}\u0000${key}`;
      let b = byKey.get(k);
      if (!b) {
        b = {
          dim,
          key,
          currency,
          mrrMinor: 0n,
          cmrrMinor: 0n,
          activeSubscriptions: 0,
          payingSubscriptions: 0,
          renewingSubscriptions: 0,
        };
        byKey.set(k, b);
      }
      b.mrrMinor += earned;
      b.cmrrMinor += cmrr;
      if (active) b.activeSubscriptions += 1;
      if (paying) b.payingSubscriptions += 1;
      if (renewing) b.renewingSubscriptions += 1;
    }
  }
  // A bucket with nothing in it that day writes no row — the rule every other slice follows.
  return [...byKey.values()].filter(
    (r) => r.mrrMinor !== 0n || r.cmrrMinor !== 0n || r.activeSubscriptions > 0,
  );
}
