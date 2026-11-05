/**
 * Reset windows (design G3b §3.1): when plan credits and allowances renew. Pure: every window
 * computation for credits and allowances lives here, so the clock, the invoice, the balance and
 * the access check cut the same windows.
 *
 * - `term`: the billing term. `never`: one window from the clock start, no end.
 * - `subscription` anchor: windows step from the term start; month-family steps are taken from
 *   the anchor with `addInterval`, so a 31st stays end-of-month safe. A pause shift moves every
 *   boundary on by `shiftMs` (not the anchor: a clamped month end stays a clamped month end).
 *   The last window of a term is cut at the term end.
 * - `calendar` anchor: on the hour, midnight, Monday 00:00, the 1st of the month, of Jan/Apr/
 *   Jul/Oct, of Jan/Jul, and 1 Jan, in the business time zone. Not cut at the term end.
 * - A pause under `shift` (`pauseShiftOf`) extends the window open at the pause (`pauseShift`);
 *   `foldPauseShifts` replays a pause history when no window was stored.
 *   Subscription anchor: later windows step from the anchor moved by `shiftMs`. Calendar anchor:
 *   the next window runs from the moved end to the next boundary, then the calendar resumes.
 *   Credits and allowances share these rules, so a linked pair renews at the same instant.
 */
import { addInterval } from "@/modules/subscriptions/interval";
import { divHalfUp } from "./units";

export const RESET_EVERY = [
  "hour",
  "day",
  "week",
  "month",
  "quarter",
  "half_year",
  "year",
  "term",
  "never",
] as const;
export type ResetEvery = (typeof RESET_EVERY)[number];
export const RESET_ANCHORS = ["subscription", "calendar"] as const;
export type ResetAnchor = (typeof RESET_ANCHORS)[number];

export interface Reset {
  every: ResetEvery;
  /** Every N units. Default 1; none for `term` and `never`. */
  count?: number;
  /** Default `subscription`. */
  anchor?: ResetAnchor;
}

export interface ResetWindow {
  start: Date;
  /** Null for `never`. */
  end: Date | null;
}

export interface WindowContext {
  termStart: Date;
  termEnd: Date;
  /** IANA zone for the calendar anchor. */
  timeZone: string;
  /** `never`: the instant the item's clock started. */
  clockStart: Date;
  /** Σ paused time the subscription anchor moved on by (ms). */
  shiftMs?: number;
  /** The window open at the last shifted pause, with its moved end (both anchors). */
  pauseShift?: { start: Date; end: Date } | null;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_COUNT = 1000;

/** The canonical reset, or null when absent. Throws a message on a bad shape. */
export function normalizeReset(raw: unknown): Reset | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ResetShapeError("must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!["every", "count", "anchor"].includes(k)) throw new ResetShapeError(`unknown key ${k}`);
  if (typeof r.every !== "string" || !(RESET_EVERY as readonly string[]).includes(r.every))
    throw new ResetShapeError(`every must be one of ${RESET_EVERY.join(", ")}`);
  const every = r.every as ResetEvery;
  if (every === "term" || every === "never") {
    if (r.count != null) throw new ResetShapeError(`count is not allowed with every: ${every}`);
    if (r.anchor != null) throw new ResetShapeError(`anchor is not allowed with every: ${every}`);
    return { every };
  }
  let count = 1;
  if (r.count != null) {
    if (
      typeof r.count !== "number" ||
      !Number.isInteger(r.count) ||
      r.count < 1 ||
      r.count > MAX_COUNT
    )
      throw new ResetShapeError(`count must be a whole number from 1 to ${MAX_COUNT}`);
    count = r.count;
  }
  let anchor: ResetAnchor = "subscription";
  if (r.anchor != null) {
    if (typeof r.anchor !== "string" || !(RESET_ANCHORS as readonly string[]).includes(r.anchor))
      throw new ResetShapeError("anchor must be subscription or calendar");
    anchor = r.anchor as ResetAnchor;
  }
  return { every, count, anchor };
}

export class ResetShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetShapeError";
  }
}

/** An allowance that renews with the subscription's plan credits (resolved at read time). */
export interface CreditsLink {
  same_as_credits: true;
}
export const isCreditsLink = (r: unknown): r is CreditsLink =>
  !!r && typeof r === "object" && (r as Record<string, unknown>).same_as_credits === true;

/** An allowance's reset: a reset, the credits link, or null when absent. Throws on a bad shape. */
export function normalizeAllowanceReset(raw: unknown): Reset | CreditsLink | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "same_as_credits" in raw) {
    const r = raw as Record<string, unknown>;
    if (r.same_as_credits !== true || Object.keys(r).length !== 1)
      throw new ResetShapeError("same_as_credits must be true and stand alone");
    return { same_as_credits: true };
  }
  return normalizeReset(raw);
}

/** A key per schedule: equal keys renew at the same instants. Absent = `term`. */
export function resetKey(r: Reset | null | undefined): string {
  if (!r || r.every === "term") return "term";
  if (r.every === "never") return "never";
  return `${r.every}:${r.count ?? 1}:${r.anchor ?? "subscription"}`;
}

/** Absent or `term`: once per billing term, as before resets existed. */
export const isTermReset = (r: Reset | null | undefined): boolean => !r || r.every === "term";

type Step = { ms: number } | { months: number };
function stepOf(every: ResetEvery): Step {
  switch (every) {
    case "hour":
      return { ms: HOUR };
    case "day":
      return { ms: DAY };
    case "week":
      return { ms: 7 * DAY };
    case "month":
      return { months: 1 };
    case "quarter":
      return { months: 3 };
    case "half_year":
      return { months: 6 };
    case "year":
      return { months: 12 };
    default:
      throw new Error(`no step for ${every}`);
  }
}

/** Nominal length in days (a month = 30), for the "not longer than the term" rule. */
function nominalDays(every: ResetEvery, count: number): number {
  const s = stepOf(every);
  return "ms" in s ? (s.ms / DAY) * count : s.months * 30 * count;
}
function termNominalDays(interval: string, count: number): number {
  switch (interval) {
    case "day":
      return count;
    case "week":
      return 7 * count;
    case "month":
      return 30 * count;
    case "year":
      return 360 * count;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/**
 * Why a reset may not be saved, as the tail of an STE message; null when it may. Credits do
 * not renew by the hour, and no window may be longer than the price's term.
 */
export function resetRefusal(
  reset: Reset | null,
  input: {
    target: "credits" | "allowance";
    interval?: string | null;
    intervalCount?: number | null;
  },
): string | null {
  if (!reset || reset.every === "term" || reset.every === "never") return null;
  if (input.target === "credits" && reset.every === "hour")
    return "Credits cannot renew every hour. Use a day or a longer interval.";
  if (input.interval) {
    const win = nominalDays(reset.every, reset.count ?? 1);
    const term = termNominalDays(input.interval, input.intervalCount ?? 1);
    if (win > term)
      return 'The renewal interval is longer than the billing term. To renew once each term, select "Each billing term" (API value "term").';
  }
  return null;
}

// ── Time zone arithmetic (self-contained, DST-safe) ────────────────────────────

const FMT = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = FMT.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FMT.set(timeZone, f);
  }
  return f;
}

interface LocalParts {
  year: number;
  month: number; // 0-based
  day: number;
  hour: number;
  minute: number;
  second: number;
}
function localParts(at: Date, timeZone: string): LocalParts {
  const m: Record<string, number> = {};
  for (const p of fmt(timeZone).formatToParts(at))
    if (p.type !== "literal") m[p.type] = Number(p.value);
  return {
    year: m.year!,
    month: m.month! - 1,
    day: m.day!,
    hour: m.hour! % 24,
    minute: m.minute!,
    second: m.second!,
  };
}
/** Local wall time minus UTC, in ms, at `at`. */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}
/** The UTC instant of a local wall time (two-pass offset, so a DST day lands right). */
function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month, day, hour);
  let t = wall - zoneOffsetMs(new Date(wall), timeZone);
  t = wall - zoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}
const mod = (a: number, n: number) => ((a % n) + n) % n;
const epochDay = (p: { year: number; month: number; day: number }) =>
  Math.floor(Date.UTC(p.year, p.month, p.day) / DAY);
const dayToUtcMidnight = (d: number, tz: string) => {
  const u = new Date(d * DAY);
  return localToUtc(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), 0, tz);
};

function calendarWindow(every: ResetEvery, count: number, at: Date, tz: string): ResetWindow {
  const p = localParts(at, tz);
  switch (every) {
    case "hour": {
      // Floor to the local hour, then to a multiple of `count` hours of the local day.
      const floored = at.getTime() - mod(at.getTime() + zoneOffsetMs(at, tz), HOUR);
      const start = floored - mod(p.hour, count) * HOUR;
      return { start: new Date(start), end: new Date(start + count * HOUR) };
    }
    case "day": {
      const d = epochDay(p);
      const s = d - mod(d, count);
      return { start: dayToUtcMidnight(s, tz), end: dayToUtcMidnight(s + count, tz) };
    }
    case "week": {
      // 1970-01-05 (epoch day 4) is a Monday.
      const w = Math.floor((epochDay(p) - 4) / 7);
      const s = w - mod(w, count);
      return {
        start: dayToUtcMidnight(4 + s * 7, tz),
        end: dayToUtcMidnight(4 + (s + count) * 7, tz),
      };
    }
    default: {
      const n = (stepOf(every) as { months: number }).months * count;
      const m = p.year * 12 + p.month;
      const s = m - mod(m, n);
      const at1 = (i: number) => localToUtc(Math.floor(i / 12), mod(i, 12), 1, 0, tz);
      return { start: at1(s), end: at1(s + n) };
    }
  }
}

function anchoredWindow(
  every: ResetEvery,
  count: number,
  at: Date,
  anchor: Date,
  shiftMs: number,
  termEnd: Date,
): ResetWindow {
  const step = stepOf(every);
  // The unshifted window that holds `at − shift`, moved on by the shift.
  const t = at.getTime() - shiftMs;
  let start: Date;
  let end: Date;
  if ("ms" in step) {
    const len = step.ms * count;
    const k = Math.max(0, Math.floor((t - anchor.getTime()) / len));
    start = new Date(anchor.getTime() + k * len);
    end = new Date(start.getTime() + len);
  } else {
    const n = step.months * count;
    const a = anchor;
    const u = new Date(t);
    const months =
      (u.getUTCFullYear() - a.getUTCFullYear()) * 12 + (u.getUTCMonth() - a.getUTCMonth());
    let k = Math.max(0, Math.floor(months / n));
    while (k > 0 && addInterval(a, "month", k * n).getTime() > t) k--;
    while (addInterval(a, "month", (k + 1) * n).getTime() <= t) k++;
    start = addInterval(a, "month", k * n);
    end = addInterval(a, "month", (k + 1) * n);
  }
  start = new Date(start.getTime() + shiftMs);
  end = new Date(end.getTime() + shiftMs);
  if (start.getTime() < termEnd.getTime() && end.getTime() > termEnd.getTime()) end = termEnd;
  return { start, end };
}

/** The window that holds `at`. */
export function windowAt(reset: Reset | null, at: Date, ctx: WindowContext): ResetWindow {
  const r = reset ?? { every: "term" as const };
  if (r.every === "term") return { start: ctx.termStart, end: ctx.termEnd };
  if (r.every === "never") return { start: ctx.clockStart, end: null };
  const count = r.count ?? 1;
  const s = ctx.pauseShift;
  const t = at.getTime();
  if (s && t >= s.start.getTime() && t < s.end.getTime()) return { ...s };
  if ((r.anchor ?? "subscription") === "calendar") {
    const w = calendarWindow(r.every, count, at, ctx.timeZone);
    // The window after a shift starts at the moved end; boundaries it covers are skipped.
    if (s && t >= s.end.getTime() && w.start.getTime() < s.end.getTime())
      return { start: s.end, end: w.end };
    return w;
  }
  return anchoredWindow(r.every, count, at, ctx.termStart, ctx.shiftMs ?? 0, ctx.termEnd);
}

/** `w` with its end moved on by `ms`. */
export function shiftedWindow(w: ResetWindow, ms: number): { start: Date; end: Date } {
  const end = w.end ?? w.start;
  return { start: w.start, end: new Date(end.getTime() + ms) };
}

/**
 * A pause under `shift` from `pausedAt`, `ms` long: the window open at the pause in `ctx` (the
 * context before the pause), with its moved end. Store it as the next `pauseShift`, and add `ms`
 * to `shiftMs`. Null for `term` and `never`, which a pause does not move.
 */
export function pauseShiftOf(
  reset: Reset | null,
  ctx: WindowContext,
  pausedAt: Date,
  ms: number,
): { start: Date; end: Date } | null {
  if (!reset || reset.every === "term" || reset.every === "never") return null;
  return shiftedWindow(windowAt(reset, pausedAt, ctx), ms);
}

/**
 * The full calendar window that holds `w` when `w` is the short window after a calendar shift
 * (it starts at the moved end, inside a calendar window); null otherwise.
 */
export function calendarWindowOfShort(
  reset: Reset | null,
  w: ResetWindow,
  ctx: WindowContext,
): ResetWindow | null {
  const s = ctx.pauseShift;
  if (!reset || !s || reset.anchor !== "calendar" || w.start.getTime() !== s.end.getTime())
    return null;
  const plain = windowAt(reset, w.start, { ...ctx, pauseShift: null });
  return plain.start.getTime() < w.start.getTime() ? plain : null;
}

/** A pause under `shift`: it began at `at` and lasted `ms`. */
export interface PauseRecord {
  at: Date;
  ms: number;
}

/**
 * `ctx` (with no shift) after `pauses` in order, each applied as a resume applies it: the shift
 * grows and `pauseShift` is the window open at the last pause, with its moved end.
 */
export function foldPauseShifts(
  reset: Reset | null,
  ctx: WindowContext,
  pauses: readonly PauseRecord[],
): WindowContext {
  let c: WindowContext = { ...ctx, shiftMs: 0, pauseShift: null };
  for (const p of pauses) {
    const open = pauseShiftOf(reset, c, p.at, p.ms);
    c = { ...c, shiftMs: (c.shiftMs ?? 0) + p.ms, pauseShift: open ?? c.pauseShift };
  }
  return c;
}

/** Windows whose start is in [from, to), in order (at most `limit`). */
export function windowsStartingIn(
  reset: Reset | null,
  from: Date,
  to: Date,
  ctx: WindowContext,
  limit = 1000,
): ResetWindow[] {
  const out: ResetWindow[] = [];
  let w = windowAt(reset, from, ctx);
  if (w.start.getTime() < from.getTime()) {
    if (!w.end) return out;
    w = windowAt(reset, w.end, ctx);
  }
  while (w.start.getTime() < to.getTime() && out.length < limit) {
    out.push(w);
    if (!w.end || w.end.getTime() <= w.start.getTime()) break;
    if (
      w.end.getTime() >= ctx.termEnd.getTime() &&
      (reset?.anchor ?? "subscription") !== "calendar"
    )
      break;
    w = windowAt(reset, w.end, ctx);
  }
  return out;
}

/** The end of the `n`th window counted from `w` (1 = `w` itself). Null for `never`. */
export function endAfterWindows(
  reset: Reset | null,
  w: ResetWindow,
  n: number,
  ctx: WindowContext,
): Date | null {
  let cur = w;
  for (let i = 1; i < n; i++) {
    if (!cur.end) return null;
    // Past this term the next one has the same length: extend the context by a term.
    const next =
      cur.end.getTime() >= ctx.termEnd.getTime() && (reset?.anchor ?? "subscription") !== "calendar"
        ? windowAt(reset, cur.end, {
            ...ctx,
            termStart: ctx.termEnd,
            termEnd: new Date(
              ctx.termEnd.getTime() + (ctx.termEnd.getTime() - ctx.termStart.getTime()),
            ),
            shiftMs: 0,
          })
        : windowAt(reset, cur.end, ctx);
    cur = next;
  }
  return cur.end;
}

/**
 * `amount` for the part of `w` from `from` on, rounded half-up to a whole step (the unit's
 * decimals); the full amount when `from` is at or before the start.
 */
export function prorateForRest(amount: bigint, w: ResetWindow, from: Date): bigint {
  if (!w.end || from.getTime() <= w.start.getTime()) return amount;
  const len = BigInt(w.end.getTime() - w.start.getTime());
  const rest = BigInt(Math.max(0, w.end.getTime() - from.getTime()));
  return len > 0n ? divHalfUp(amount * rest, len) : amount;
}

/**
 * Split `total` over `weights` in proportion, each piece rounded down and the last piece taking
 * the remainder, so Σ = total. All-zero weights give everything to the last piece.
 */
export function splitByWeights(total: bigint, weights: readonly bigint[]): bigint[] {
  if (!weights.length) return [];
  const sum = weights.reduce((a, w) => a + (w > 0n ? w : 0n), 0n);
  const out = weights.map(() => 0n);
  if (sum === 0n) {
    out[out.length - 1] = total;
    return out;
  }
  let given = 0n;
  for (let i = 0; i < weights.length - 1; i++) {
    const w = weights[i]! > 0n ? weights[i]! : 0n;
    out[i] = (total * w) / sum;
    given += out[i]!;
  }
  out[out.length - 1] = total - given;
  return out;
}

/** The ISO instant a window renews at, or null for `never`. */
export const renewsAt = (w: ResetWindow): string | null => (w.end ? w.end.toISOString() : null);

// ── Grant refs: one grant per item, price and window start (unique source_ref) ──

export const windowRef = (itemId: string, priceId: string, start: Date) =>
  `${itemId}:w:${priceId}:${start.toISOString()}`;
export const windowRollRef = (itemId: string, priceId: string, start: Date) =>
  `${itemId}:wroll:${priceId}:${start.toISOString()}`;

/** A reset-window plan grant (or its rollover): pays only usage inside its own window. */
export const isExactWindowGrant = (source: string, sourceRef: string | null | undefined) =>
  source === "plan_cycle" && !!sourceRef && /:w(roll)?:/.test(sourceRef);
