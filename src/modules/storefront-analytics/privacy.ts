/**
 * The request-level privacy rules. Every write path goes through `trackingRefused` first.
 */

type HeaderBag = Record<string, string | string[] | undefined> | Headers;

function header(h: HeaderBag, name: string): string | null {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const v = (h as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** Global Privacy Control or Do Not Track: record nothing for this request. */
export function trackingRefused(h: HeaderBag): boolean {
  return header(h, "sec-gpc")?.trim() === "1" || header(h, "dnt")?.trim() === "1";
}

/** The edge's country code (Cloudflare `CF-IPCountry`), or null. `XX`/`T1` are not countries. */
export function countryFrom(h: HeaderBag): string | null {
  const v = header(h, "cf-ipcountry")?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1" ? v : null;
}

const HOST = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;

/**
 * A Referer reduced to its host. Accepts a full URL or a bare host; anything else, and our
 * own host, is null. Path, query and fragment never survive this function.
 */
export function referrerHostOf(raw: string | null | undefined, selfHost?: string | null) {
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (!HOST.test(host)) return null;
  const self = selfHost
    ?.toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
  return self && host === self ? null : host;
}

/** A UTM value as we keep it: trimmed, lower case, 100 characters at most, empty = null. */
export function cleanUtm(v: string | null | undefined): string | null {
  const s = v?.trim().toLowerCase().slice(0, 100) ?? "";
  return s ? s : null;
}
