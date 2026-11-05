// Pure, client-safe helpers for the model price list and AI usage screens.
import { formatMinorRate } from "./meters";

const TOKEN_TYPE: Record<string, string> = {
  input: "Input",
  output: "Output",
  cache_read: "Cache read",
  cache_write: "Cache write",
  cache_write_1h: "Cache write, 1 hour",
  input_audio: "Input audio",
  output_audio: "Output audio",
  cache_audio_read: "Cache read, audio",
  requests: "Requests",
};

/** "cache_read" → "Cache read". Unknown types keep their words. */
export function tokenTypeLabel(t: string | null | undefined): string {
  if (!t) return "—";
  if (TOKEN_TYPE[t]) return TOKEN_TYPE[t];
  const s = t.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The "per" part of a list price: "per 1M", "per 1K", "per unit". */
export function perLabel(divisor: number | string | null | undefined): string {
  const d = Number(divisor ?? 1);
  if (d === 1_000_000) return "per 1M";
  if (d === 1000) return "per 1K";
  if (d === 1) return "per unit";
  return `per ${d.toLocaleString("en-US")}`;
}

/** "$3.00 per 1M" from a minor-unit rate and its divisor. */
export function formatListPrice(
  minor: string | null | undefined,
  currency: string,
  divisor: number | string | null | undefined,
): string {
  if (minor == null || minor === "") return "—";
  return `${formatMinorRate(minor, currency)} ${perLabel(divisor)}`;
}

/** The divisors a cost row takes (design § 5.3: Per 1M | 1K | 1 unit). */
export const COST_DIVISORS = [
  { value: "1000000", label: "Per 1M" },
  { value: "1000", label: "Per 1K" },
  { value: "1", label: "Per 1 unit" },
] as const;

/** Where a selling rate came from (`rating.segments[].rate_from`). */
export const RATE_FROM_LABEL: Record<string, string> = {
  subscription_override: "Customer price",
  price_rate: "Rate for this model",
  price: "Price markup",
};

/**
 * Amount sources that bill from the model price list. `event_cost_or_list` bills an event's own
 * cost first; both take the same markup, markup base, rate rows and selling-price override.
 */
export const isListSource = (s: string | null | undefined): boolean =>
  s === "model_price_list" || s === "event_cost_or_list";

/** `rating.price_source` on a usage line. */
export const PRICE_SOURCE_LABEL: Record<string, string> = {
  model_price_list: "Model price list",
  reported_cost: "Reported cost",
  your_cost: "Your cost",
  fixed_rate: "Fixed rate",
  default_rate: "Default rate",
  rate: "Rate card",
};

/** Business-local YYYY-MM-DD for today, so a day range matches the business's days. */
export function localDate(tz: string | null | undefined, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** `date` minus `days` (YYYY-MM-DD arithmetic, no time zone). */
export function minusDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** "12.5" → "12.5%", null → "—". */
export function percentLabel(p: string | null | undefined): string {
  if (p == null || p === "") return "—";
  const n = Number(p);
  return Number.isFinite(n) ? `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%` : p;
}

/** A group's model value, read from the meter's model key (default "model"). */
export const modelOf = (group: Record<string, string> | null | undefined, key = "model") =>
  group?.[key] ?? null;

/** The instant a business-local date starts, as ISO (handles any zone offset, incl. +05:45). */
export function localMidnightIso(date: string, tz: string | null | undefined): string {
  const utc = new Date(`${date}T00:00:00Z`);
  if (!tz) return utc.toISOString();
  try {
    // Offset of the zone at that wall time: format the UTC instant in the zone, read it back.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(utc);
    const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(
      v("year"),
      v("month") - 1,
      v("day"),
      v("hour"),
      v("minute"),
      v("second"),
    );
    const offset = asUtc - utc.getTime();
    return new Date(utc.getTime() - offset).toISOString();
  } catch {
    return utc.toISOString();
  }
}

/** `date` plus `days` (YYYY-MM-DD arithmetic, no time zone). */
export const plusDays = (date: string, days: number) => minusDays(date, -days);
