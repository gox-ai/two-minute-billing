/**
 * Which channels one kind reaches for one recipient. Pure; the order is the README's:
 * business exception → organization default → business filter → role permission →
 * amount limit → test business → quiet hours.
 */
import {
  defaultPreferences,
  kindDef,
  type KindPreference,
  type MemberRole,
  type NotificationKind,
  type Timing,
} from "./catalogue";

export type BusinessFilter = { mode: "all" } | { mode: "selected"; business_ids: string[] };
export type QuietHours = { enabled: boolean; from: number; to: number; disputes_through: boolean };

export type ResolveReason =
  | "not_set_up"
  | "business_filter"
  | "permission"
  | "below_limit"
  | "off"
  | "test"
  | "quiet_hours";

export interface Resolution {
  timing: Timing;
  /** "held": quiet hours; send at `heldUntil`. */
  push: boolean | "held";
  email: boolean;
  heldUntil?: Date;
  reason?: ResolveReason;
}

export interface ResolveInput {
  /** The member's organization default (`business_id` NULL). None = not set up. */
  defaultRow: { kinds: Record<string, KindPreference> } | null | undefined;
  /** This business's exceptions. */
  businessRow?: { kinds: Record<string, KindPreference> } | null;
  filter?: BusinessFilter | null;
  businessId: string | null;
  kind: NotificationKind;
  permissions: ReadonlySet<string>;
  /** Fills a kind the default row lacks (a kind added after the member saved). */
  role?: MemberRole;
  amountMinor?: number | bigint | null;
  currency?: string | null;
  test?: boolean;
  quiet?: QuietHours | null;
  now: Date;
  /** The member's timezone, for quiet hours. */
  timezone?: string | null;
  /** Dispute kinds pass quiet hours when `disputes_through` is on. */
  isDispute?: boolean;
}

const OFF = (reason: ResolveReason): Resolution => ({
  timing: "off",
  push: false,
  email: false,
  reason,
});

/** Under the currency's limit. A currency with no limit gets every amount. */
export function belowLimit(
  above: Record<string, number> | undefined,
  amountMinor: number | bigint | null | undefined,
  currency: string | null | undefined,
): boolean {
  if (!above || amountMinor == null || !currency) return false;
  const limit = above[currency.toUpperCase()];
  return limit != null && BigInt(amountMinor) < BigInt(limit);
}

export function passesFilter(filter: BusinessFilter | null | undefined, businessId: string | null) {
  if (!filter || filter.mode === "all" || !businessId) return true;
  return filter.business_ids.includes(businessId);
}

export function resolvePreference(input: ResolveInput): Resolution {
  if (!input.defaultRow) return OFF("not_set_up");
  const def = kindDef(input.kind);
  const pref =
    input.businessRow?.kinds[input.kind] ??
    input.defaultRow.kinds[input.kind] ??
    (input.role ? defaultPreferences(input.role)[input.kind] : undefined);
  if (!pref) return OFF("off");
  if (!passesFilter(input.filter, input.businessId)) return OFF("business_filter");
  if (!input.permissions.has(def.permission)) return OFF("permission");
  if (def.amount && belowLimit(pref.above, input.amountMinor, input.currency))
    return OFF("below_limit");
  if (pref.timing === "off") return OFF("off");
  // A test business: a bell row only.
  if (input.test) return { timing: "instant", push: false, email: false, reason: "test" };
  if (pref.timing === "summary") return { timing: "summary", push: false, email: false };

  const out: Resolution = { timing: "instant", push: pref.push, email: pref.email };
  const q = input.quiet;
  if (
    out.push === true &&
    q?.enabled &&
    !(input.isDispute && q.disputes_through) &&
    inQuietHours(input.now, input.timezone ?? "UTC", q.from, q.to)
  ) {
    out.push = "held";
    out.heldUntil = quietEnd(input.now, input.timezone ?? "UTC", q.to);
    out.reason = "quiet_hours";
  }
  return out;
}

/** A destination: on for the kind, in its businesses, at or above its limit, live only. */
export function resolveDestination(input: {
  dest: {
    status: string;
    businessFilter: BusinessFilter;
    kinds: Record<string, { on: boolean; above?: Record<string, number> }>;
  };
  kind: NotificationKind;
  amountMinor?: number | bigint | null;
  currency?: string | null;
  businessId: string | null;
  test?: boolean;
}): { send: boolean; reason?: "inactive" | "test" | "business_filter" | "off" | "below_limit" } {
  const { dest, kind } = input;
  if (dest.status !== "active") return { send: false, reason: "inactive" };
  if (input.test) return { send: false, reason: "test" };
  if (!passesFilter(dest.businessFilter, input.businessId))
    return { send: false, reason: "business_filter" };
  const pref = dest.kinds[kind];
  if (!pref?.on) return { send: false, reason: "off" };
  if (kindDef(kind).amount && belowLimit(pref.above, input.amountMinor, input.currency))
    return { send: false, reason: "below_limit" };
  return { send: true };
}

/**
 * The kinds one recipient gets for one event. A derived kind the recipient gets replaces the
 * kinds it supersedes; when they do not get it, the parent still applies.
 */
export function pickKindsForRecipient(
  kinds: readonly NotificationKind[],
  enabled: ReadonlySet<NotificationKind>,
): NotificationKind[] {
  const on = kinds.filter((k) => enabled.has(k));
  const replaced = new Set(on.flatMap((k) => kindDef(k).supersedes ?? []));
  return on.filter((k) => !replaced.has(k));
}

// ── Time zones (Intl only, DST-safe) ──

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** A valid IANA zone name. */
export function isTimeZone(tz: string): boolean {
  try {
    partsFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const x of partsFormatter(tz).formatToParts(at))
    if (x.type !== "literal") p[x.type] = Number(x.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute! };
}

function offsetMs(t: number, tz: string): number {
  const p = localParts(new Date(t), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000;
}

/** The instant a local wall-clock time happens. In a DST gap, the first instant after it. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  tz: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour);
  let t = wall - offsetMs(wall, tz);
  const second = wall - offsetMs(t, tz);
  if (second !== t) t = Math.max(t, second);
  return new Date(t);
}

/** `from`–`to` in whole local hours; a window with from > to crosses midnight. */
export function inQuietHours(now: Date, tz: string, from: number, to: number): boolean {
  if (from === to) return false;
  const h = localParts(now, tz).hour;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/** The next local `to`:00 after `now`. */
export function quietEnd(now: Date, tz: string, to: number): Date {
  const p = localParts(now, tz);
  for (let add = 0; add < 3; add++) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + add));
    const t = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), to, tz);
    if (t > now) return t;
  }
  return new Date(now.getTime() + 24 * 3600_000);
}
