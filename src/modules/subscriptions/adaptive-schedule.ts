/**
 * Adaptive retry timing — smart mode's answer to WHEN, beside `decline-policy.ts`'s answer
 * to WHETHER. Opt-in per business (`dunning_config.adaptive_timing`).
 *
 * Pure and dependency-free like `dunning-schedule.ts`, which imports it: local times come
 * from `Intl`, not `platform/clock` (that module loads the app config).
 *
 * Deterministic rules, not learned ones. Each class of decline gets the timing that fits
 * what the refusal says about the money:
 *
 *   transient  processing_error, gateway_error, charge_failed, retry_too_soon
 *              → hours, not days: the fault is at a gateway or network and usually clears.
 *   funds      insufficient_funds
 *              → the next likely payday (1st, 15th, last day of the month), local morning,
 *                or every N days when the business sets `funds_gap_days`.
 *   generic    card_declined, do_not_honor
 *              → a few days apart, local morning; parks after the last (RETRY_THEN_PARK).
 *
 * Every other code keeps the merchant's schedule. Every attempt stays inside
 * `ADAPTIVE_WINDOW_DAYS` of the due date, and the business's dunning period still applies
 * on top (`scheduleTail`). "Local" is the card issuer's country when it is known
 * (`retryZoneFor`, zones from the seeded `countries.timezones`), else the business's.
 */

export type RetryClass = "transient" | "funds" | "generic";

const CLASS_OF: Readonly<Record<string, RetryClass>> = {
  processing_error: "transient",
  gateway_error: "transient",
  charge_failed: "transient",
  // The 24h floor in `RETRY_NOT_BEFORE_MS` still pushes the first attempt past the window.
  retry_too_soon: "transient",
  insufficient_funds: "funds",
  card_declined: "generic",
  do_not_honor: "generic",
};

/** The class a normalized decline code retries under, or null for the merchant's schedule. */
export function retryClassOf(code: string | null | undefined): RetryClass | null {
  return CLASS_OF[(code ?? "").trim().toLowerCase()] ?? null;
}

/** Hours after each failure, by retry number. Three retries. */
export const TRANSIENT_GAPS_HOURS = [4, 24, 72] as const;
/** Days after each failure, by retry number. Three retries, matching RETRY_THEN_PARK_ATTEMPTS. */
export const GENERIC_GAPS_DAYS = [2, 3, 4] as const;
export const FUNDS_MAX_RETRIES = 4;
/** A payday retry is never sooner than this after the failure. */
export const FUNDS_MIN_GAP_HOURS = 24;
/** Local hour a day-based retry lands on. */
export const ADAPTIVE_LOCAL_HOUR = 10;
/** No adaptive attempt lands later than this many days after the due date. */
export const ADAPTIVE_WINDOW_DAYS = 30;

/**
 * The three cadences (`dunning_config.adaptive_cadence`, 2.59). Unset = the constants above.
 * `fundsGapDays` null = the payday rule; a number = that many days after each failure.
 */
export interface AdaptiveCadence {
  transientHours: readonly number[];
  genericDays: readonly number[];
  fundsGapDays: number | null;
  fundsMaxRetries: number;
}

export const DEFAULT_ADAPTIVE_CADENCE: AdaptiveCadence = {
  transientHours: TRANSIENT_GAPS_HOURS,
  genericDays: GENERIC_GAPS_DAYS,
  fundsGapDays: null,
  fundsMaxRetries: FUNDS_MAX_RETRIES,
};

/** Bounds the API and the resolver share. */
export const CADENCE_LIMITS = {
  maxSteps: 5,
  transientHours: { min: 1, max: 168 },
  genericDays: { min: 1, max: 14 },
  fundsGapDays: { min: 1, max: 14 },
  fundsMaxRetries: { min: 1, max: 6 },
} as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The next attempt for a retry-class decline, or null when this class has no retry left
 * (its ceiling is reached or the next slot falls outside the window).
 *
 * `retryNumber` is 1 for the first retry after the original charge — the same slot
 * `nextRetryAt` indexes the merchant's offsets with.
 */
export function adaptiveNextRetryAt(input: {
  retryClass: RetryClass;
  retryNumber: number;
  now: Date;
  dueDate?: Date | null;
  timezone?: string | null;
  /** `countries.timezones` of the card's issuing country; empty or absent = unknown. */
  issuerZones?: readonly string[] | null;
  /** The business's cadence; omitted = the defaults. */
  cadence?: AdaptiveCadence;
}): Date | null {
  const cadence = input.cadence ?? DEFAULT_ADAPTIVE_CADENCE;
  const zone = retryZoneFor({
    issuerZones: input.issuerZones,
    businessTimezone: input.timezone,
    at: input.now,
  });
  const n = input.retryNumber;
  let at: Date | null;
  switch (input.retryClass) {
    case "transient": {
      const gap = cadence.transientHours[n - 1];
      at = gap === undefined ? null : new Date(input.now.getTime() + gap * HOUR);
      break;
    }
    case "generic": {
      const gap = cadence.genericDays[n - 1];
      at =
        gap === undefined
          ? null
          : localMorning(addLocalDays(localDate(input.now, zone), gap), zone);
      break;
    }
    case "funds":
      at =
        n < 1 || n > cadence.fundsMaxRetries
          ? null
          : cadence.fundsGapDays == null
            ? nextPaydayMorning(input.now, zone)
            : localMorning(addLocalDays(localDate(input.now, zone), cadence.fundsGapDays), zone);
      break;
  }
  if (!at) return null;
  const windowEnd = (input.dueDate ?? input.now).getTime() + ADAPTIVE_WINDOW_DAYS * DAY;
  return at.getTime() > windowEnd ? null : at;
}

/**
 * The zone whose morning a retry aims for.
 *
 * The card's issuing country when it has one zone. When it has several, the business's
 * own zone if the country shares its clock (a US business charging a US card), else a
 * zone at the middle of that country's UTC offsets, so 10:00 there is within a few hours
 * of 10:00 anywhere in it. Zones unknown → the business.
 */
export function retryZoneFor(input: {
  issuerZones?: readonly string[] | null;
  businessTimezone?: string | null;
  at: Date;
}): string {
  const business = usableZone(input.businessTimezone);
  // Research stations are not where cardholders live.
  const zones = (input.issuerZones ?? []).filter(
    (z) => !z.startsWith("Antarctica/") && usableZone(z) === z,
  );
  if (zones.length === 0) return business;
  if (zones.length === 1) return zones[0]!;
  const businessOffset = offsetMs(input.at, business);
  if (zones.some((z) => offsetMs(input.at, z) === businessOffset)) return business;
  const offsets = zones.map((z) => offsetMs(input.at, z));
  const median = [...offsets].sort((a, b) => a - b)[Math.floor((offsets.length - 1) / 2)];
  // Only the offset matters for "10:00 local"; ties go to the first listed.
  return zones[offsets.indexOf(median!)]!;
}

/** The first 1st / 15th / last-of-month morning at least FUNDS_MIN_GAP_HOURS away. */
function nextPaydayMorning(now: Date, zone: string): Date {
  const earliest = now.getTime() + FUNDS_MIN_GAP_HOURS * HOUR;
  let { y, m } = localDate(now, zone);
  // Three paydays a month, so two months of candidates always contain one.
  for (let i = 0; i < 3; i++) {
    for (const d of [1, 15, daysInMonth(y, m)]) {
      const at = localMorning({ y, m, d }, zone);
      if (at.getTime() >= earliest) return at;
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return new Date(earliest);
}

// ── Local time without platform/clock ─────────────────────────────────────────

type LocalDate = { y: number; m: number; d: number };

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    FORMATTERS.set(zone, f);
  }
  return f;
}

/** A zone Intl accepts, else UTC — a bad stored value must not stop dunning. */
function usableZone(zone: string | null | undefined): string {
  if (!zone) return "UTC";
  try {
    formatter(zone);
    return zone;
  } catch {
    return "UTC";
  }
}

function parts(instant: Date, zone: string): LocalDate & { h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of formatter(zone).formatToParts(instant))
    if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

/** Milliseconds the zone is ahead of UTC at `instant`. */
function offsetMs(instant: Date, zone: string): number {
  const p = parts(instant, zone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

function localDate(instant: Date, zone: string): LocalDate {
  const { y, m, d } = parts(instant, zone);
  return { y, m, d };
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** ADAPTIVE_LOCAL_HOUR on `date` in `zone`, correct across a DST change on that day. */
function localMorning(date: LocalDate, zone: string): Date {
  const wall = Date.UTC(date.y, date.m - 1, date.d, ADAPTIVE_LOCAL_HOUR);
  const first = wall - offsetMs(new Date(wall), zone);
  const second = wall - offsetMs(new Date(first), zone);
  return new Date(second);
}
