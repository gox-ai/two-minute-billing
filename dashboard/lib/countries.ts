/**
 * Client-side helpers over the country reference data.
 *
 * WHAT CHANGED. This file used to BE the reference data: an ISO 3166-1 code string,
 * subdivision lists for four countries, postal regexes for fifteen, and a
 * hand-maintained set of ~60 countries with no postal code. The engine held a
 * second, differently-scoped copy in `src/platform/subdivisions.ts`, and
 * `verify:tax-subdivisions` existed only to notice when the two drifted.
 *
 * Migration 0177 moved all of it into the database, served by `GET /v1/countries`.
 * What is left here is pure FUNCTIONS over a `Country` record — no tables — so the
 * picker cannot offer a value the API rejects.
 *
 * Everything here is safe in a client component: no `lib/api` import, no secrets.
 */
import type { Country, Subdivision } from "@/lib/api/geo";

export type { Country, Subdivision };

export interface CountryOption {
  value: string;
  label: string;
}

export const toOptions = (countries: Country[]): CountryOption[] =>
  countries.map((c) => ({ value: c.code, label: c.name }));

export const subdivisionOptions = (subs: Subdivision[]): CountryOption[] =>
  subs.map((s) => ({ value: s.code, label: s.name }));

/**
 * The flag emoji for a currency — DERIVED, never hardcoded. Nearly every ISO-4217
 * code is its country's ISO-3166 alpha-2 plus one letter (USD→US, INR→IN, CHF→CH),
 * so the first two letters give the flag once we check they name a real region.
 * `null` for supranational and fund codes that have no flag (XAF, XOF, XDR…) so
 * callers render the bare code instead of two stray letter boxes.
 *
 * There was a literal 🇮🇳 on the subscription header chip: a USD subscription flew
 * the Indian flag.
 *
 * The region check is `Intl.DisplayNames` rather than a bundled country list — it is
 * the one thing here that must work without having fetched anything, and keeping a
 * table just for it would reintroduce exactly the duplication this file shed.
 */
let displayNames: Intl.DisplayNames | null | undefined;
function knownRegion(code: string): boolean {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      displayNames = null;
    }
  }
  if (!displayNames) return /^[A-Z]{2}$/.test(code);
  try {
    // `of()` echoes the input back for a code it does not recognise.
    return displayNames.of(code) !== code;
  } catch {
    return false;
  }
}

const flagOf = (region: string): string =>
  String.fromCodePoint(...[...region].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

export function currencyFlag(currency: string | null | undefined): string | null {
  const code = currency?.trim().toUpperCase();
  if (!code || code.length !== 3) return null;
  // EU is not ISO-3166-1 (it is a 3166-1 *exceptional reservation*) but it does have
  // a flag emoji, and the euro has no single country to point at.
  const region = code === "EUR" ? "EU" : code.slice(0, 2);
  if (region !== "EU" && !knownRegion(region)) return null;
  return flagOf(region);
}

/**
 * Flag emoji for an ISO-3166-1 alpha-2 region — the card's ISSUING country, not its
 * currency. Null for anything that is not a region this runtime knows, so a caller
 * renders the bare code rather than two stray letter boxes.
 */
export function regionFlag(country: string | null | undefined): string | null {
  const code = country?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code) || !knownRegion(code)) return null;
  return flagOf(code);
}

/**
 * "India" for `IN`. Falls back to the code itself rather than null: a gateway sent us
 * that value and blanking it would hide a fact we hold. Callers needing to know whether
 * it resolved should compare against the input.
 */
export function regionName(country: string | null | undefined): string {
  const code = country?.trim().toUpperCase() ?? "";
  if (!code) return "";
  if (!knownRegion(code)) return code;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// ── Subdivisions ─────────────────────────────────────────────────────────────

/**
 * Fold a supplied code to its canonical form. `aliases` comes from the API
 * (`GET /v1/countries/:code/subdivisions`) rather than being duplicated here —
 * some sources use non-ISO codes for four Indian states, and an imported customer
 * holding `OD` must still light up the `OR` option instead of rendering blank.
 */
export function normalizeStateCode(
  code: string | null | undefined,
  aliases: Record<string, string> = {},
): string {
  const raw = (code ?? "").trim().toUpperCase();
  if (!raw) return "";
  return aliases[raw] ?? raw;
}

export function subdivisionName(
  subs: Subdivision[],
  code: string | null | undefined,
  aliases: Record<string, string> = {},
): string {
  const canonical = normalizeStateCode(code, aliases);
  if (!canonical) return "";
  return subs.find((s) => s.code === canonical)?.name ?? canonical;
}

/**
 * Countries the TAX engine can configure a region for. A PRODUCT decision, not
 * reference data — India and the US are regime-aware (GST place of supply, US sales
 * tax) while everywhere else gets a country-wide flat rate — so it stays a constant
 * rather than moving to the countries table. Mirrors `TAX_COUNTRIES` in
 * `src/platform/geo.ts`; `verify:tax-subdivisions` fails if the two disagree.
 */
export const TAX_COUNTRIES: CountryOption[] = [
  { value: "IN", label: "India" },
  { value: "US", label: "United States" },
];

// ── Postal codes ─────────────────────────────────────────────────────────────

const reCache = new Map<string, RegExp>();

/**
 * Anchored matcher. The stored patterns are inconsistent — most are `^…$`, GB's is a
 * bare alternation — so an unanchored one would match any string merely CONTAINING a
 * valid postcode. The non-capturing group is what makes an alternation anchor as a
 * whole rather than only its first branch.
 *
 * Mirrors `postalMatcher` in `src/platform/geo.ts`; the API re-validates, so a
 * mismatch here is a worse message, not a bad row.
 */
function matcher(country: Country): RegExp | null {
  if (!country.postal_regex) return null;
  const hit = reCache.get(country.code);
  if (hit) return hit;
  try {
    const body = country.postal_regex.replace(/^\^/, "").replace(/\$$/, "");
    const re = new RegExp(`^(?:${body})$`);
    reCache.set(country.code, re);
    return re;
  } catch {
    // A pattern this browser's engine cannot compile must not break the form.
    return null;
  }
}

export function isValidPostal(country: Country | null, value: string): boolean {
  const raw = value.trim();
  if (!raw) return true;
  if (!country) return true;
  if (!country.has_postal_code) return false;
  const re = matcher(country);
  if (!re) return true;
  let canonical = raw.toUpperCase();
  for (const ch of country.postal_redundant ?? "") canonical = canonical.split(ch).join("");
  return re.test(canonical);
}

export const postalHint = (country: Country | null): string | null => country?.postal_hint ?? null;
export const postalLabel = (country: Country | null): string =>
  country?.postal_label ?? "Postal code";
export const regionLabel = (country: Country | null): string =>
  country?.region_label ?? "State / Province";
export const usesPostalCode = (country: Country | null): boolean =>
  country?.has_postal_code ?? true;
