// Pure presentation helpers — no server-only imports, so client components can
// use them without pulling node:crypto (lib/api) into the browser bundle.

import { currencyExponent, toMajor } from "./money";

/**
 * Dates are rendered in the **business** timezone, not UTC — matching what the
 * engine actually does: a term boundary is the start of the
 * day in `businesses.timezone` and proration is whole-day (`db/schema/tenancy.ts`).
 * Rendering the same instant in UTC made every renewal date look a day off (a
 * midnight-IST boundary displayed as `18:30` the previous day).
 *
 * `tz` is an IANA zone from `Business.timezone`, and UTC is the fallback (also the
 * column default). Every business-scoped surface passes it: **client** components
 * read it from context via `useBusinessTz()` (set once in the `/businesses/[biz]`
 * layout — see `components/business-tz.tsx`), and **server** components resolve the
 * business row and pass it explicitly, since they cannot read context.
 *
 * It stays optional because a few surfaces genuinely have no single business —
 * `/audit` and `/developer` (org-level API keys and webhook endpoints) span every
 * business in the org. Since 0216 those pass the
 * ORGANIZATION's zone (`organizations.timezone`, set on /settings): client components
 * read `useDisplayTz()` (business → organization → UTC) and server components call
 * `orgTz()` from `lib/org-tz-server.ts`. UTC remains the fallback for an org that has
 * never set one, so `fmtDate(x)` with no `tz` still means UTC — and on those screens
 * that is now a bug, not a default.
 *
 * Date ENTRY is the mirror of this file and lives in `lib/tz.ts` +
 * `components/form/datetime-field.tsx`: the operator types a business-timezone wall
 * clock and the form posts UTC. Never convert a typed date by hand.
 *
 * CLOSED 2026-08-22: the two CUSTOMER-facing surfaces outside the dashboard tree —
 * `/portal/[token]` (invoice dates) and `/checkout/[token]` (the renewal date in the
 * order preview) — used to render in UTC, because neither API exposed the business
 * `timezone` and neither route sits under a `BusinessTzProvider`. Both payloads now
 * carry `business.timezone` and both routes thread it explicitly. There is deliberately
 * still no provider out here: a buyer surface renders a handful of dates, and an
 * explicit `tz` argument is harder to forget than a context that silently defaults.
 * A NEW date on either route must pass it — `fmtDate(x)` alone means UTC.
 */
const DEFAULT_TZ = "UTC";

/**
 * Standalone cadence label for a price interval — "USD Monthly", "Daily".
 *
 * There is a lowercase sibling (`INTERVAL_LABEL` in components/subscriptions/line-items.tsx,
 * "billed monthly") for cadences that sit inside a sentence. Two casings is deliberate;
 * SEVEN copies of the map was not. This one exists because a site improvised
 * `cap(interval) + 'ly'`, which renders a daily price as **"Dayly"** — the same
 * defect that was fixed on the price create page and left standing here.
 */
export const INTERVAL_LABEL: Record<string, string> = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
};

/** Title-case cadence for `interval`, falling back to the raw value for an unknown one. */
export function intervalLabel(interval?: string | null): string {
  return interval ? (INTERVAL_LABEL[interval] ?? interval) : "";
}

/** `21-Aug-2026` / `21-Aug-2026 00:00` in `tz`. */
function fmtIn(iso: string, tz: string, withTime: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      // h23 (not hour12:false) — the latter renders midnight as `24:00` on some engines.
      ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
      timeZone: tz,
    }).formatToParts(d);
  } catch {
    // An unknown/malformed IANA zone throws rather than falling back.
    return withTime ? d.toISOString().slice(0, 16).replace("T", " ") : d.toISOString().slice(0, 10);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  const date = `${p.day}-${p.month}-${p.year}`;
  return withTime ? `${date} ${p.hour}:${p.minute}` : date;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `1 Oct 2026, 11:07` in `tz` — the list-cell format. Months are always three letters
 * (en-GB's short month is "Sept"). '—' when absent.
 */
export function fmtDateTimeShort(iso?: string | null, tz?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: tz || DEFAULT_TZ,
    }).formatToParts(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  // en-GB pads `day: "numeric"` to "01".
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute}`;
}

/** `1 Nov 2026` in `tz` — the list-cell date (no time). '—' when absent. */
export function fmtDateShort(iso?: string | null, tz?: string | null): string {
  return fmtDateTimeShort(iso, tz).replace(/,? \d{2}:\d{2}$/, "");
}

/** `21-Aug-2026` in the business timezone; '—' when absent. */
export function fmtDate(iso?: string | null, tz?: string | null): string {
  return iso ? fmtIn(iso, tz || DEFAULT_TZ, false) : "—";
}

/** `21-Aug-2026 00:00` in the business timezone; '—' when absent. */
export function fmtDateTime(iso?: string | null, tz?: string | null): string {
  return iso ? fmtIn(iso, tz || DEFAULT_TZ, true) : "—";
}

/**
 * `21-Aug-2026 00:00:12` — the same format with SECONDS, for ops.
 *
 * Minutes are the right resolution for a billing date and the wrong one for an
 * incident: the alert this was written for is "a crash between the gateway's
 * response and our commit", where two events a few seconds apart are the whole
 * story. Everywhere else keeps `fmtDateTime`.
 */
export function fmtDateTimeSec(iso?: string | null, tz?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const zone = tz || DEFAULT_TZ;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // h23, not hour12:false — the latter renders midnight as `24:00` on some engines.
      hourCycle: "h23",
      timeZone: zone,
    }).formatToParts(d);
  } catch {
    // An unknown/malformed IANA zone throws rather than falling back.
    return d.toISOString().slice(0, 19).replace("T", " ");
  }
  const p: Record<string, string> = {};
  for (const { type, value } of parts) p[type] = value;
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Pricing models whose amount scales with a purchased quantity (so a Qty field
 * makes sense). Flat is a single fixed fee; usage is metered from usage records;
 * percentage derives from another line — none of those take a manual quantity.
 */
const QUANTITY_BASED_MODELS = new Set(["per_unit", "tiered", "volume", "stairstep", "package"]);

/** True when a price's model is quantity-based (show an editable Qty; else "—", qty 1). */
export function isQuantityBased(model?: string | null): boolean {
  return model ? QUANTITY_BASED_MODELS.has(model) : false;
}

/**
 * Currency exponents + major↔minor conversion live in `lib/money.ts` — one
 * implementation, an explicit ISO-4217 table, and no dependency on the runtime's
 * CLDR data. Re-exported here because ~40 call sites already import them from
 * `@/lib/format` alongside `money()`, and money helpers belong together.
 */
export {
  currencyExponent,
  minorPerMajor,
  toMinor,
  toMajor,
  toMajorInput,
  majorStep,
} from "./money";

/** Format integer minor units + currency for display, e.g. 4900 USD → $49.00. */
export function money(minor: number | null, currency: string): string {
  if (minor == null) return "—";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(
      toMajor(minor, currency),
    );
  } catch {
    // Unknown code → Intl throws; fall back to the currency's own exponent rather
    // than a blanket 2, so ¥1000 does not render as "1000.00 JPY".
    return `${toMajor(minor, currency).toFixed(currencyExponent(currency))} ${currency}`;
  }
}

/**
 * How long a discount lasts, as one label.
 *
 * Shared because two screens state it — the catalog's coupon table and the
 * subscription's Items card — and a second copy of this mapping is how the two
 * start disagreeing about what `repeating` with no period count means.
 * `repeating` WITHOUT a count is "Limited period" rather than a guessed number:
 * the engine stores the count separately and it is genuinely optional.
 */
export function couponDurationLabel(
  durationType?: string | null,
  durationInPeriods?: number | null,
): string {
  if (durationType === "once") return "One-time";
  if (durationType === "forever") return "Forever";
  return durationInPeriods ? `${durationInPeriods} period(s)` : "Limited period";
}

/**
 * Compact money for dashboard headlines: 4957000 USD → `$49.57K`,
 * 190000000 → `$1.90M`. Amounts under 1,000 keep their full form (`$277.12`).
 */
export function moneyCompact(minor: number | null, currency: string): string {
  if (minor == null) return "—";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(toMajor(minor, currency));
  } catch {
    return money(minor, currency);
  }
}

/** Compact count for chart axes / headlines: 49600 → `49.6k`. */
export function countCompact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(n)
    .toLowerCase();
}

/** Basis points → a percent string, e.g. 206 → `2.06%`. */
export function pctFromBps(bps: number | null, digits = 2): string {
  if (bps == null) return "—";
  return `${(bps / 100).toFixed(digits)}%`;
}
