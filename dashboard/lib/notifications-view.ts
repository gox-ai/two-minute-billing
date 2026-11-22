// Pure helpers for the notification screens: the bell's day groups, the "Only above" text,
// a device label from the browser's user agent. Relative imports only: a unit test imports it.
import { fmtDate, fmtDateTime } from "./format-date";

export type Timing = "instant" | "summary" | "off";

export const TIMING_OPTIONS: Array<{ value: Timing; label: string }> = [
  { value: "instant", label: "Instant" },
  { value: "summary", label: "Daily summary" },
  { value: "off", label: "Off" },
];

export const timingLabel = (t: Timing) => TIMING_OPTIONS.find((o) => o.value === t)?.label ?? "Off";

/** Format an amount in minor units with its currency symbol: "₹10,000", "$100.00". */
export function moneyText(minor: number, currency: string): string {
  const cur = currency.toUpperCase();
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    return `${cur} ${minor}`;
  }
  const major = minor / 10 ** digits;
  const whole = Number.isInteger(major);
  try {
    return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: whole && cur === "INR" ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${cur} ${major}`;
  }
}

/**
 * The "Only above" trigger: "Any amount" with no limit, up to two limits in full
 * ("₹10,000 · $100.00"), else "3 limits". It never truncates.
 */
export function aboveText(above: Record<string, number> | undefined): string {
  const set = Object.entries(above ?? {}).filter(([, v]) => v > 0);
  if (set.length === 0) return "Any amount";
  if (set.length > 2) return `${set.length} limits`;
  return set.map(([cur, v]) => moneyText(v, cur)).join(" · ");
}

/** The calendar day of an instant in a zone, as YYYY-MM-DD. */
export function localDay(iso: string | Date, tz: string): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** "Today", "Yesterday", or the date, in the row's own business zone. */
export function dayLabel(iso: string, tz: string, now: Date = new Date()): string {
  const day = localDay(iso, tz);
  if (day === localDay(now, tz)) return "Today";
  if (day === localDay(new Date(now.getTime() - 86_400_000), tz)) return "Yesterday";
  return fmtDate(iso, tz);
}

/** "09:00" in the zone. */
export function timeOfDay(iso: string, tz: string): string {
  const s = fmtDateTime(iso, tz);
  return s.split(", ")[1] ?? s;
}

/** Consecutive rows that share a day label, newest first as the API sends them. */
export function groupByDay<T extends { created_at: string }>(
  rows: T[],
  tzOf: (row: T) => string,
  now: Date = new Date(),
): Array<{ label: string; rows: T[] }> {
  const out: Array<{ label: string; rows: T[] }> = [];
  for (const r of rows) {
    const label = dayLabel(r.created_at, tzOf(r), now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else out.push({ label, rows: [r] });
  }
  return out;
}

/** "Chrome on macOS" from a user agent; the label a device row shows. */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua) || /CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return os ? `${browser} on ${os}` : browser;
}

/** The VAPID public key (base64url) as the bytes `pushManager.subscribe` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** An hour as "08:00". */
export const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
