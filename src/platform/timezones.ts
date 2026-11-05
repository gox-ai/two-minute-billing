import { midnightOnDateInTz } from "@/platform/clock";

/**
 * Timezone names: modern IANA only, in the database and on screen.
 *
 * `businesses.timezone` anchors every date in the product — day-aligned term boundaries
 * (`modules/subscriptions/billing-mode.ts`), the business-day bucketing of list filters,
 * and every date the dashboard renders or collects. It stores the zone **name**, never an
 * offset: an offset carries no daylight-saving rule, so a Europe/Berlin business stored as
 * `+01:00` would bill an hour off for half the year.
 *
 * WHY A RENAME MAP. `Intl.supportedValuesOf('timeZone')` reports the runtime's CANONICAL
 * ids, and ICU still canonicalizes ten zones to their pre-rename spelling. Measured on
 * Node 22 / Chrome 148 (both 417-zone ICU): `Asia/Calcutta` is listed and `Asia/Kolkata`
 * is NOT. tzdb, Postgres and our own data use the modern names, so without this map a
 * business saved as `Asia/Kolkata` matched nothing in the dashboard's own picker and
 * rendered as "not a known time zone". Both spellings stay acceptable to `Intl` and to
 * Postgres, so this only decides which one we PERSIST and DISPLAY — and that is the modern
 * one, always.
 *
 * `LEGACY_TO_MODERN` is mirrored in `dashboard/lib/tz.ts` (the two packages cannot import
 * each other); `pnpm verify:dashboard-tz` fails if the copies drift, and also asserts that
 * every zone the runtime lists normalizes to a name not in this map's keys — so an ICU
 * update that introduces a new legacy canonical is caught rather than silently stored.
 */

/**
 * Legacy IANA name → modern name.
 *
 * The first ten are what ICU actually lists as canonical (so they appear in any picker
 * built from `supportedValuesOf`); the rest are aliases ICU accepts but does not list,
 * included so an API caller submitting one still gets a modern name stored.
 */
export const LEGACY_TO_MODERN: Readonly<Record<string, string>> = {
  // --- listed as canonical by ICU (Node 22 / Chrome 148) ---
  "Africa/Asmera": "Africa/Asmara",
  "America/Godthab": "America/Nuuk",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
  // --- accepted aliases, not listed ---
  "Asia/Ashkhabad": "Asia/Ashgabat",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Macao": "Asia/Macau",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Africa/Timbuktu": "Africa/Bamako",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Rosario": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Fort_Wayne": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Atka": "America/Adak",
  "America/Porto_Acre": "America/Rio_Branco",
  "Europe/Uzhgorod": "Europe/Kyiv",
  "Europe/Zaporozhye": "Europe/Kyiv",
  "Pacific/Yap": "Pacific/Chuuk",
  "Pacific/Samoa": "Pacific/Pago_Pago",
  "Pacific/Johnston": "Pacific/Honolulu",
  "Pacific/Enderbury": "Pacific/Kanton",
};

/** The modern spelling of `tz`, or `tz` unchanged when it already is one. */
export function toModernZone(tz: string): string {
  return LEGACY_TO_MODERN[tz] ?? tz;
}

/** True when `Intl` accepts this zone id. */
export function isKnownZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export class InvalidTimezoneError extends Error {
  constructor(tz: string, why: string) {
    super(
      `Invalid timezone '${tz}': ${why}. Expected a modern IANA zone name such as 'Asia/Kolkata' or 'UTC'.`,
    );
    this.name = "InvalidTimezoneError";
  }
}

/**
 * Validate a timezone and return the name to STORE — always the modern spelling.
 *
 * Rejects two things `Intl` itself accepts, both of which would be actively wrong to store:
 *  - a fixed OFFSET (`+05:30`, `GMT-4`) — no daylight-saving rule, so half the year bills
 *    at the wrong boundary;
 *  - a bare ABBREVIATION (`IST`) — India, Ireland and Israel all claim it.
 * Both were verified to pass a plain `Intl` round trip before this check existed.
 */
export function normalizeTimezone(tz: string): string {
  const value = tz.trim();
  if (!value) throw new InvalidTimezoneError(tz, "empty");
  if (/^(?:GMT|UTC)?[+-]\d{1,2}(?::?\d{2})?$/i.test(value)) {
    throw new InvalidTimezoneError(tz, "a fixed UTC offset has no daylight-saving rule");
  }
  // Every real IANA zone is `Region/City` (sometimes `Region/Sub/City`); `UTC` is the one
  // legitimate bare name. Anything else bare is an abbreviation.
  if (value !== "UTC" && !value.includes("/"))
    throw new InvalidTimezoneError(tz, "ambiguous abbreviation");
  if (!isKnownZone(value)) throw new InvalidTimezoneError(tz, "not a zone this runtime knows");

  const modern = toModernZone(value);
  // A rename map entry whose target this runtime rejects would be worse than the legacy
  // name — keep the one that actually resolves.
  return isKnownZone(modern) ? modern : value;
}

// ── Local calendar days ─────────────────────────────────────────────────────────────────

/** Is `day` a `YYYY-MM-DD` calendar date? */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A zone that means "no conversion" — a business with none reports on the UTC day. */
const isUtc = (zone: string | null | undefined): boolean => !zone || zone === "UTC";

/**
 * The UTC instant at which the calendar day `day` BEGINS in `zone`.
 *
 * `zone` null, empty or `UTC` means UTC, so a business that never chose a zone keeps the
 * plain `${day}T00:00:00.000Z` it has always had.
 *
 * NEVER offset arithmetic. `midnightOnDateInTz` asks the runtime's own tz database what the
 * offset is at the instant in question and then re-asks at the answer, because the offset
 * that applies on a day the clocks move is not the one that applied the moment before it. A
 * fixed `±5:30` happens to be right for India forever and wrong for Berlin twice a year —
 * the failure a book kept in India can never demonstrate.
 *
 * ONE implementation of this boundary, deliberately. `clock.ts` has floored day-aligned
 * billing terms to a business's local midnight since long before analytics needed the same
 * instant; a second copy here is how a term boundary and a reporting boundary drift apart.
 */
export function zonedDayStart(day: string, zone?: string | null): Date {
  if (!DAY_RE.test(day)) throw new Error(`zonedDayStart: expected YYYY-MM-DD, got '${day}'`);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  if (isUtc(zone)) return new Date(Date.UTC(y, m - 1, d));
  // A day's start in a zone never changes, and a converted series asks for thousands.
  const key = `${zone}|${day}`;
  const hit = DAY_STARTS.get(key);
  if (hit != null) return new Date(hit);
  const at = midnightOnDateInTz(y, m - 1, d, zone!).getTime();
  if (DAY_STARTS.size >= DAY_STARTS_MAX) DAY_STARTS.clear();
  DAY_STARTS.set(key, at);
  return new Date(at);
}

/** Epoch ms per `zone|day`. A decade of days across a handful of zones fits well inside. */
const DAY_STARTS = new Map<string, number>();
const DAY_STARTS_MAX = 100_000;

/** The calendar day after `day` — pure date arithmetic, no instant involved. */
export function nextDay(day: string): string {
  if (!DAY_RE.test(day)) throw new Error(`nextDay: expected YYYY-MM-DD, got '${day}'`);
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * The first instant AFTER the calendar day `day` in `zone` — the half-open upper bound.
 *
 * It is the NEXT day's start, never "start + 24h": a day on which the clocks move is 23 or
 * 25 hours long, and two consecutive days must still tile with no gap and no overlap.
 */
export function zonedDayEndExclusive(day: string, zone?: string | null): Date {
  if (isUtc(zone)) return zonedDayStart(nextDay(day), zone);
  const key = `end|${zone}|${day}`;
  const hit = DAY_STARTS.get(key);
  if (hit != null) return new Date(hit);
  const at = zonedDayStart(nextDay(day), zone).getTime();
  if (DAY_STARTS.size >= DAY_STARTS_MAX) DAY_STARTS.clear();
  DAY_STARTS.set(key, at);
  return new Date(at);
}

/**
 * Formatters, kept per zone.
 *
 * ⚠️ CONSTRUCTING ONE IS THE EXPENSIVE PART, NOT FORMATTING WITH IT. Measured here:
 * 80µs per call when the formatter is rebuilt each time against 0.68µs for the UTC path
 * that builds none — a 118× penalty that ONLY a non-UTC business pays, and production is
 * Asia/Kolkata. The metrics sync dates one row per subscription per day, so it reached
 * 163M calls on the production book: three and a half hours spent formatting dates.
 *
 * Unbounded on purpose. The key space is the set of business timezones, which is tens of
 * entries at most and fixed by the accounts that exist — an LRU here would add eviction
 * bookkeeping to guard against a growth that cannot happen.
 */
const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(zone: string): Intl.DateTimeFormat {
  let f = DAY_FORMATTERS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    DAY_FORMATTERS.set(zone, f);
  }
  return f;
}

/** The calendar date `instant` falls on in `zone`, `YYYY-MM-DD`. */
export function zonedDayString(instant: Date, zone?: string | null): string {
  if (isUtc(zone)) return instant.toISOString().slice(0, 10);
  const parts = dayFormatter(zone!).formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
