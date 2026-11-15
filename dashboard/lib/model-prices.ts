// Pure, client-safe helpers for the model price list and AI usage screens.
import { formatMinorRate, isPropertyName } from "./meters";

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

/** The units of a list price (`MODEL_PRICE_UNITS` in the engine), as a person reads them. */
export const PRICE_UNITS = [
  { value: "token", label: "Tokens", one: "token", many: "tokens" },
  { value: "request", label: "Requests", one: "request", many: "requests" },
  { value: "image", label: "Images", one: "image", many: "images" },
  { value: "audio_second", label: "Audio", one: "second of audio", many: "seconds of audio" },
  { value: "video_second", label: "Video", one: "second of video", many: "seconds of video" },
  { value: "character", label: "Characters", one: "character", many: "characters" },
  { value: "page", label: "Pages", one: "page", many: "pages" },
  { value: "pixel", label: "Pixels", one: "pixel", many: "pixels" },
] as const;

/** "audio_second" → "Audio"; no unit is tokens. An unknown unit keeps its words. */
export const priceUnitLabel = (u: string | null | undefined): string =>
  PRICE_UNITS.find((x) => x.value === (u || "token"))?.label ?? tokenTypeLabel(u);

/** A unit that a quality tier can price (not tokens or requests). */
export const isMediaUnit = (u: string | null | undefined) =>
  !!u && u !== "token" && u !== "request";

/** A unit whose price can change with the resolution. Audio, characters and pages have none. */
export const takesResolution = (u: string | null | undefined) =>
  u === "image" || u === "video_second" || u === "pixel";

/** Offer Resolution for `unit`? A stored resolution on another media unit still shows. */
export const showsResolution = (u: string | null | undefined, stored: boolean) =>
  isMediaUnit(u) && (takesResolution(u) || stored);

const countLabel = (d: number) =>
  d >= 1e9 && d % 1e9 === 0
    ? `${d / 1e9}B`
    : d >= 1e6 && d % 1e6 === 0
      ? `${d / 1e6}M`
      : d >= 1e3 && d % 1e3 === 0
        ? `${d / 1e3}K`
        : d.toLocaleString("en-US");

/** "per 1M tokens", "per 1K requests", "per hour of audio", "per image". */
export function perUnitLabel(unit: string, divisor: number | string | null | undefined): string {
  const d = Number(divisor ?? 1);
  const u = PRICE_UNITS.find((x) => x.value === unit) ?? PRICE_UNITS[0];
  if (u.value === "audio_second" || u.value === "video_second") {
    const what = u.value === "audio_second" ? "audio" : "video";
    if (d === 3600) return `per hour of ${what}`;
    if (d === 60) return `per minute of ${what}`;
  }
  return d === 1 ? `per ${u.one}` : `per ${countLabel(d)} ${u.many}`;
}

/**
 * A list price in two parts, so a narrow cell can put "per …" on its own line:
 * `{ amount: "$3.00", per: "per 1M tokens" }`. Null when there is no rate.
 */
export function listPriceParts(
  minor: string | null | undefined,
  currency: string,
  divisor: number | string | null | undefined,
  unit?: string | null,
): { amount: string; per: string } | null {
  if (minor == null || minor === "") return null;
  return {
    amount: formatMinorRate(minor, currency),
    per: unit ? perUnitLabel(unit, divisor) : perLabel(divisor),
  };
}

/**
 * "$3.00 per 1M tokens" from a minor-unit rate, its divisor and its unit. No unit (a rate-card
 * rate) keeps "per 1M".
 */
export function formatListPrice(
  minor: string | null | undefined,
  currency: string,
  divisor: number | string | null | undefined,
  unit?: string | null,
): string {
  const p = listPriceParts(minor, currency, divisor, unit);
  return p ? `${p.amount} ${p.per}` : "—";
}

/** "Output · hd · 1024x1024": the type and its tier. */
export function priceTypeLabel(r: {
  token_type: string;
  quality?: string | null;
  resolution?: string | null;
}): string {
  return [tokenTypeLabel(r.token_type), r.quality, r.resolution].filter(Boolean).join(" · ");
}

/** The divisors a cost row takes (design § 5.3: Per 1M | 1K | 1 unit). */
export const COST_DIVISORS = [
  { value: "1000000", label: "Per 1M" },
  { value: "1000", label: "Per 1K" },
  { value: "1", label: "Per 1 unit" },
] as const;

/** The amounts a cost can be per, by unit: the first is the default. */
export const COST_DIVISORS_BY_UNIT: Record<string, string[]> = {
  token: ["1000000", "1000", "1"],
  request: ["1000", "1"],
  image: ["1", "1000"],
  audio_second: ["3600", "60", "1"],
  video_second: ["1", "60", "3600"],
  character: ["1000000", "1000"],
  page: ["1000", "1"],
  pixel: ["1000000000", "1000000"],
};

/** The amount a new cost of `unit` is per, until the operator selects another. */
export const defaultCostDivisor = (unit: string | null | undefined): string =>
  (COST_DIVISORS_BY_UNIT[unit ?? "token"] ?? COST_DIVISORS_BY_UNIT.token!)[0]!;

/** A value or a tier of a cost row: lower-case letters, digits, "_", "." and "-". */
export const TIER_RE = /^[a-z0-9_.x-]{0,40}$/;

/** A tier as the engine stores and matches it: trimmed, lower-case ("HD " → "hd"). */
export const normalizeTier = (v: string | null | undefined): string =>
  (v ?? "").trim().toLowerCase();

export const TIER_MESSAGE =
  "Use at most 40 lower-case letters, digits, dots, dashes or underscores.";

/**
 * The tier fields "Set your cost" shows. A media unit takes a quality (and a resolution where
 * it has one); a row opened with a tier keeps its tier fields whatever the unit, so the new
 * cost has the same key.
 */
export function costTierFields(
  unit: string | null | undefined,
  key?: { quality?: string | null; resolution?: string | null } | null,
): { quality: boolean; resolution: boolean } {
  return {
    quality: isMediaUnit(unit) || !!key?.quality,
    resolution: showsResolution(unit, !!key?.resolution) || !!key?.resolution,
  };
}

/** The price list's search and filters that the cost list can apply too. */
export interface UnlistedCostFilters {
  q?: string;
  provider?: string;
  unit?: string;
}

/** One read of "Your costs with no list price". `nextCursor` null = no more rows. */
export interface UnlistedCostPage<Row> {
  rows: Row[];
  nextCursor: string | null;
}

/** Rows per read of "Your costs with no list price". */
export const UNLISTED_COSTS_PAGE = 50;

/** `q` and the `filter=provider:is:…` / `filter=unit:is:…` entries of the page's address. */
export function unlistedCostFilters(
  q: string | null | undefined,
  filters: readonly string[],
): UnlistedCostFilters {
  const is = (field: string) => {
    const hit = filters.find((f) => f.startsWith(`${field}:is:`));
    return hit ? hit.slice(field.length + 4) : undefined;
  };
  const out: UnlistedCostFilters = {};
  if (q?.trim()) out.q = q.trim();
  const provider = is("provider");
  if (provider) out.provider = provider;
  const unit = is("unit");
  if (unit && PRICE_UNITS.some((u) => u.value === unit)) out.unit = unit;
  return out;
}

/** A stable key for a filter set, so a list knows which filters its rows were read with. */
export const unlistedCostKey = (f: UnlistedCostFilters): string =>
  JSON.stringify([f.q ?? "", f.provider ?? "", f.unit ?? ""]);

/**
 * When a source was checked and when its prices last applied. `updated` is null when it is the
 * same instant as `checked` (or there is none), so the line shows one time.
 */
export function feedTimes(f: { checked_at?: string | null; last_success_at?: string | null }): {
  checked: string | null;
  updated: string | null;
} {
  const checked = f.checked_at ?? f.last_success_at ?? null;
  const updated =
    f.last_success_at && checked && Date.parse(f.last_success_at) !== Date.parse(checked)
      ? f.last_success_at
      : null;
  return { checked, updated };
}

/** Delete a cost before it starts; end it once it started and has not ended. */
export function costRowActions(
  c: { effective_from: string; effective_to?: string | null },
  now: number,
): { canDelete: boolean; canEnd: boolean } {
  const started = Date.parse(c.effective_from) <= now;
  return {
    canDelete: !started,
    canEnd: started && (c.effective_to == null || Date.parse(c.effective_to) > now),
  };
}

/**
 * Field messages for a meter's price list mapping, keyed by the form's field names: an empty
 * property or value, a tier the list cannot hold, a property that Group by does not have.
 * `groupBy` null = the form did not post it (a meter with usage).
 */
export function priceListFieldErrors(
  m: {
    provider_key?: string | null;
    model_key?: string | null;
    token_type_key?: string | null;
    quality?: string | null;
    quality_key?: string | null;
    resolution?: string | null;
    resolution_key?: string | null;
  },
  groupBy: readonly string[] | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, what] of [
    ["provider_key", "provider"],
    ["quality_key", "quality"],
    ["resolution_key", "resolution"],
  ] as const)
    if (m[field] === "") out[field] = `Enter the property that holds the ${what}.`;
  for (const t of ["quality", "resolution"] as const) {
    if (m[t] === "") out[t] = `Enter the ${t}.`;
    else if (m[t] != null && !TIER_RE.test(m[t])) out[t] = TIER_MESSAGE;
  }
  if (groupBy)
    for (const field of [
      "provider_key",
      "model_key",
      "token_type_key",
      "quality_key",
      "resolution_key",
    ] as const) {
      const k = field === "model_key" ? m.model_key || "model" : m[field];
      if (k && isPropertyName(k) && !groupBy.includes(k) && !out[field])
        out[field] = `Add ${k} to Group by.`;
    }
  return out;
}

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
/** A list row's `source` (who published the price) → its name on screen. */
export const LIST_FEED_NAME: Record<string, string> = {
  "genai-prices": "genai-prices",
  litellm: "LiteLLM",
};
export const listFeedName = (s: string) => LIST_FEED_NAME[s] ?? s;

/** A source's version is an ETag: drop the weak marker and quotes, keep 8 characters. */
export const shortVersion = (raw: string): string =>
  raw.replace(/^W\//, "").replaceAll('"', "").slice(0, 8);

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
  return Number.isFinite(n)
    ? `${n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
    : p;
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
