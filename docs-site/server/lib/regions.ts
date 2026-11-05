import type { H3Event } from "h3";
import { CONSENT_COUNTRIES, EU_COUNTRIES } from "../../app/utils/regions";

export const EU = new Set(EU_COUNTRIES);
export const CONSENT_REQUIRED = new Set(CONSENT_COUNTRIES);

/**
 * The visitor's country from Cloudflare, or undefined when unknown: no header (not through
 * Cloudflare), `XX` (no country) or `T1` (Tor).
 */
export function visitorCountry(event: H3Event): string | undefined {
  const c = (getHeader(event, "cf-ipcountry") ?? "").toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== "XX" ? c : undefined;
}
