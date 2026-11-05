import { AsyncLocalStorage } from "node:async_hooks";
import { eq, isNull, or, notInArray, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { config } from "@/platform/config";

/**
 * H4 (TL-4) — the single "business clock" seam.
 *
 * STATUS: the seam + `time_travels` table are landed, but TL-4 travel_forward /
 * start_afresh orchestration + routes are DEFERRED (user decision 2026-07-04 —
 * test-only sandbox tool, not a cutover blocker). With no travel scope ever set,
 * `businessNow` returns real time and `scanBusinessFilter` returns undefined, so
 * every clock pass behaves byte-for-byte as before. The grep-sweep is done, so a
 * future TL-4 is just: set a scope in a travel loop + a data-wipe + routes.
 *
 * Real time everywhere by default. A Time Travel step (`travel_forward`) binds a
 * per-business simulated instant for the duration of one tick step, so every
 * scheduling decision the engine would make against the real clock instead runs
 * as-of the simulated instant — deterministically.
 *
 * TWO cooperating pieces:
 *  - `businessNow(businessId)` — replaces inline `new Date()` in engine code that
 *    means "now, for this business" (period boundaries, coupon validity, etc.).
 *  - `scanBusinessFilter(col)` — every clock PASS's top-level scan ANDs this in, so
 *    a real tick EXCLUDES time-travelled businesses (travel drives them instead) and
 *    a travel step includes ONLY the traveled business. A missed scan site would
 *    let a simulated run diverge from the real clock — grep for it when adding a pass.
 */
export interface ClockScope {
  /** travel_forward: drive ONLY this business… */
  onlyBusinessId?: string;
  /** …as-of this simulated instant. */
  now?: Date;
  /** real tick: EXCLUDE these (time-travelled) businesses from every scan. */
  excludeBusinessIds?: string[];
}

const als = new AsyncLocalStorage<ClockScope>();

/** Run `fn` (a tick or travel step) bound to a clock scope. */
export function runWithClockScope<T>(scope: ClockScope, fn: () => Promise<T>): Promise<T> {
  return als.run(scope, fn);
}

export function currentClockScope(): ClockScope | undefined {
  return als.getStore();
}

/**
 * "Business now": the simulated instant when a travel_forward has pinned THIS
 * business's clock in the current async context; real wall-clock otherwise.
 */
export function businessNow(businessId: string): Date {
  const s = als.getStore();
  if (s?.onlyBusinessId === businessId && s.now) return s.now;
  return new Date();
}

/**
 * The instant to RECORD on a row written now (`created_at`, `paid_at`, …), as distinct from
 * `businessNow`, which drives scheduling decisions. Simulated when a travel step pins this
 * business, or when the current API request resolved a time-travelled business (see
 * `pinRequestClock`); wall time otherwise. Omit `businessId` where the caller does not have
 * it: a pin only ever exists for the one business the step or request is about.
 */
export function stampNow(businessId?: string): Date {
  const pin = activeClockPin();
  if (pin && (businessId === undefined || pin.businessId === businessId)) return pin.now;
  return new Date();
}

/** The simulated (business, instant) the current context records rows at, if any. */
export function activeClockPin(): { businessId: string; now: Date } | null {
  const s = als.getStore();
  if (s?.onlyBusinessId && s.now) return { businessId: s.onlyBusinessId, now: s.now };
  const r = requestClock.getStore()?.pin;
  return r ?? null;
}

/**
 * Per-request slot, opened at onRequest and filled by `resolveBusiness` when the request's
 * business is time-travelled. Same mutable-store pattern as `writeTrackingHook` in db.ts:
 * a store set later with `enterWith` does not reliably reach the handler.
 */
const requestClock = new AsyncLocalStorage<{ pin: { businessId: string; now: Date } | null }>();

export function requestClockHook(_req: unknown, _reply: unknown, done: () => void): void {
  requestClock.run({ pin: null }, done);
}

/** Rows this request writes for `businessId` are recorded as-of `now`. */
export function pinRequestClock(businessId: string, now: Date): void {
  const slot = requestClock.getStore();
  if (slot) slot.pin = { businessId, now };
}

/**
 * A Drizzle WHERE condition that scopes a clock pass's global scan by the active
 * clock scope: travel → `business_id = <traveled>`; real tick → `business_id NOT
 * IN (<time-travelled>)`; no scope (direct call) → no restriction.
 */

/**
 * Async "business now" for API-BOUNDARY call sites (no ALS clock scope exists on
 * a plain HTTP request): consults the ALS scope first (travel-driven work), then
 * the business's time travel row — so API writes against a time-travelled test
 * business (create/activate, PI expiry, coupon status) see SIMULATED time. Falls
 * back to real wall-clock (the overwhelmingly common case: one indexed lookup on
 * a test-only feature; live businesses never match).
 */
export async function businessWallClock(businessId: string): Promise<Date> {
  const s = als.getStore();
  if (s?.onlyBusinessId === businessId && s.now) return s.now;
  const { systemDb: db } = await import("@/platform/db");
  const { timeTravels } = await import("@db/schema");
  const [tm] = await db
    .select({ simulatedNow: timeTravels.simulatedNow })
    .from(timeTravels)
    .where(eq(timeTravels.businessId, businessId))
    .limit(1);
  return tm?.simulatedNow ?? new Date();
}

/**
 * One formatter per (zone, shape), reused. Building one is the expensive part (~80µs);
 * rebuilt per call, a converted daily series in Asia/Kolkata spent 1.3s on 3,400 days.
 * The key space is the set of business timezones, so it is not bounded.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function cachedFormatter(timeZone: string, withTime: boolean): Intl.DateTimeFormat {
  const key = `${withTime ? "t" : "d"}|${timeZone}`;
  let f = FORMATTERS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(withTime ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : {}),
      hour12: false,
    });
    FORMATTERS.set(key, f);
  }
  return f;
}

/**
 * Offset (ms) that `timeZone` is ahead of UTC at the given instant. Computed via
 * Intl (no dependency): read the wall-clock components in the zone, treat them as
 * if UTC, and subtract the true instant. E.g. Asia/Kolkata → +5.5h.
 */
function tzOffsetMs(date: Date, timeZone: string): number {
  const key = `${timeZone}|${Math.floor(date.getTime() / 1000)}`;
  const hit = OFFSETS.get(key);
  if (hit !== undefined) return hit;
  const offset = computeTzOffsetMs(date, timeZone);
  remember(OFFSETS, key, offset);
  return offset;
}

/**
 * Memo tables for the three conversions below, keyed on exactly what each result depends on
 * (the zone and the instant, or the zone and the date), so a hit returns the answer a fresh
 * call would. A renewal projection over a calendar-billed book asks the same handful of dates
 * for every subscription: unmemoized, `Intl` took 26 s of one day's metrics on 240k
 * subscriptions (D4.5). Each table is dropped whole past its cap.
 */
const MEMO_CAP = 200_000;
const OFFSETS = new Map<string, number>();
const DAY_STARTS = new Map<string, number>();
const MIDNIGHTS = new Map<string, number>();
function remember(table: Map<string, number>, key: string, value: number): void {
  if (table.size >= MEMO_CAP) table.clear();
  table.set(key, value);
}

function computeTzOffsetMs(date: Date, timeZone: string): number {
  const dtf = cachedFormatter(timeZone, true);
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = Number(p.value);
  // Intl can emit hour "24" at midnight; normalize to 0.
  const hour = map.hour === 24 ? 0 : map.hour!;
  const asUTC = Date.UTC(map.year!, map.month! - 1, map.day!, hour, map.minute!, map.second!);
  // Compare against the input floored to whole seconds — zone offsets are whole
  // minutes, so the input's milliseconds must not leak into the offset.
  return asUTC - (date.getTime() - date.getMilliseconds());
}

/**
 * The UTC instant of the START OF THE DAY (00:00 local) in `timeZone` that
 * contains `date`. Calendar-day-aligned businesses floor their
 * term boundaries to this. DST-safe via a two-pass offset (the offset at the
 * candidate midnight can differ from the offset at `date`).
 */
export function startOfDayInTz(date: Date, timeZone: string): Date {
  const key = `${timeZone}|${date.getTime()}`;
  const hit = DAY_STARTS.get(key);
  if (hit !== undefined) return new Date(hit);
  const start = computeStartOfDayInTz(date, timeZone);
  remember(DAY_STARTS, key, start.getTime());
  return start;
}

function computeStartOfDayInTz(date: Date, timeZone: string): Date {
  const dtf = cachedFormatter(timeZone, false);
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = Number(p.value);
  const localMidnightAsUTC = Date.UTC(map.year!, map.month! - 1, map.day!, 0, 0, 0);
  // First pass: subtract the offset at `date`; refine with the offset at the
  // resulting candidate so a same-day DST change doesn't shift the boundary.
  let candidate = new Date(localMidnightAsUTC - tzOffsetMs(date, timeZone));
  candidate = new Date(localMidnightAsUTC - tzOffsetMs(candidate, timeZone));
  return candidate;
}

/**
 * The local calendar date (in `timeZone`) that `date` falls on, as plain numbers.
 * `month` is 0-based, matching `Date.UTC` and `getUTCMonth`.
 */
export function localDatePartsInTz(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const key = `${timeZone}|${date.getTime()}`;
  const hit = DATE_PARTS.get(key);
  if (hit) return { ...hit };
  const dtf = cachedFormatter(timeZone, false);
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== "literal") map[p.type] = Number(p.value);
  const parts = { year: map.year!, month: map.month! - 1, day: map.day! };
  if (DATE_PARTS.size >= MEMO_CAP) DATE_PARTS.clear();
  DATE_PARTS.set(key, parts);
  return { ...parts };
}
const DATE_PARTS = new Map<string, { year: number; month: number; day: number }>();

/**
 * The UTC instant of local midnight on a CALENDAR DATE you name — the counterpart of
 * `startOfDayInTz`, which needs an instant already inside the day it floors. Used to
 * build calendar billing anchors ("the 15th") in a business's own zone instead of at
 * 00:00 UTC, which in Asia/Kolkata is 05:30 on the 15th and in New York is 20:00 on the
 * 14th.
 *
 * Aims at local NOON on that date first, then floors. Noon leaves twelve hours of slack
 * in both directions, so the whole-hour error a DST-straddling offset lookup can
 * introduce cannot push the guess into a neighbouring local day — which a midnight
 * guess would suffer at extreme offsets (UTC+14, UTC−11).
 */
export function midnightOnDateInTz(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const key = `${timeZone}|${year}|${month}|${day}`;
  const hit = MIDNIGHTS.get(key);
  if (hit !== undefined) return new Date(hit);
  const noonAsUTC = Date.UTC(year, month, day, 12);
  const noonish = new Date(noonAsUTC - tzOffsetMs(new Date(noonAsUTC), timeZone));
  const midnight = startOfDayInTz(noonish, timeZone);
  remember(MIDNIGHTS, key, midnight.getTime());
  return midnight;
}

/** The UTC instant of the NEXT local midnight in `timeZone` after `date`. */
export function startOfNextDayInTz(date: Date, timeZone: string): Date {
  const sod = startOfDayInTz(date, timeZone);
  // +26h safely lands inside the next calendar day regardless of DST, then floor.
  return startOfDayInTz(new Date(sod.getTime() + 26 * 60 * 60 * 1000), timeZone);
}

export function scanBusinessFilter(businessIdColumn: AnyPgColumn): SQL | undefined {
  const s = als.getStore();
  if (!s) return undefined;
  if (s.onlyBusinessId) return eq(businessIdColumn, s.onlyBusinessId);
  if (s.excludeBusinessIds && s.excludeBusinessIds.length > 0)
    return notInArray(businessIdColumn, s.excludeBusinessIds);
  return undefined;
}

/**
 * scanBusinessFilter for a NULLABLE business column (e.g. events.business_id —
 * org-level events have none). NULL semantics matter: `col NOT IN (…)` evaluates
 * NULL for null rows and would silently EXCLUDE every org-level row from the real
 * tick whenever any time travel is active. Travel scope (`only`) deliberately
 * excludes null-business rows — org-level work stays on the real clock.
 */
export function scanBusinessFilterNullable(businessIdColumn: AnyPgColumn): SQL | undefined {
  const s = als.getStore();
  if (!s) return undefined;
  if (s.onlyBusinessId) return eq(businessIdColumn, s.onlyBusinessId);
  if (s.excludeBusinessIds && s.excludeBusinessIds.length > 0) {
    return or(isNull(businessIdColumn), notInArray(businessIdColumn, s.excludeBusinessIds));
  }
  return undefined;
}

/**
 * How many rows ONE business may take from an egress pass, given how many businesses
 * actually have due work this pass.
 *
 * ── THE DEFECT THIS FIXES (2026-09-11) ──────────────────────────────────────────────
 * Both outboxes ranked rows per business and filtered `rn <= TICK_FAIR_SHARE_PER_BUSINESS`,
 * a FIXED 50. The comment above each said the cap "bounds one tenant's share without
 * slowing a tenant that is alone", and `config.ts` calls it "a SHARE, not a rate limit — a
 * business alone in the queue is not slowed by it". None of that was true: 50 applied
 * whether one business had due work or fifty did, so a single tenant draining a backlog was
 * held to 50 rows a minute — 3,000/hour — no matter how empty the queue was around it.
 *
 * That ceiling is invisible until volume arrives, and then it is the binding constraint on
 * the whole egress path: a business renewing 1,000 subscriptions in a minute produces 1,000
 * emails and could drain 50, so the backlog grew by 950 every tick while every gauge showed
 * a pass completing well inside its budget. Adding concurrency to the drain loop would not
 * have helped, because the pass never SAW row 51.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────
 * Divide the scan evenly, and never go below the old floor:
 *
 *     share = max(TICK_FAIR_SHARE_PER_BUSINESS, ceil(TICK_SCAN_LIMIT / businesses))
 *
 * One business with due work takes the whole scan. Ten take a tenth each. Fifty are each
 * held to the 50-row floor, which is exactly the old behaviour and the case the cap was
 * written for — the measured incident had one business holding 3,095 of 7,654 due rows.
 * So fairness is unchanged where it was ever doing work, and the ceiling disappears where
 * it was only ever an accident.
 *
 * `businesses` counts DISTINCT businesses with rows due right now, not all businesses: a
 * tenant with nothing queued must not shrink anyone else's share.
 */
export function fairShareFor(businessesWithDueWork: number): number {
  const floor = config.TICK_FAIR_SHARE_PER_BUSINESS;
  // OFF by default — see `TICK_FAIR_SHARE_DYNAMIC`. The fixed cap is a bug, but switching it
  // silently would make passes report `capped` where they never did, which is an alerting
  // signal. Callers still skip the count query entirely when this is off.
  if (config.TICK_FAIR_SHARE_DYNAMIC !== "TRUE") return floor;
  // Guard the divide: a pass that found no rows never reaches this, but a caller that
  // passes 0 must not produce Infinity and silently disable the cap altogether.
  if (businessesWithDueWork <= 1) return Math.max(floor, config.TICK_SCAN_LIMIT);
  return Math.max(floor, Math.ceil(config.TICK_SCAN_LIMIT / businessesWithDueWork));
}
