/**
 * Country, subdivision, postal and phone reference — the authority for every
 * address the engine accepts.
 *
 * WHY THIS EXISTS. `state_code` is not decoration: place of supply is decided by
 * comparing it against the seller's own state and against state-scoped rate
 * components. A code that does not match resolves to NO place of supply, the
 * component never applies, and the tax silently becomes 0 — a wrong number on a
 * legal document, not an error. So the set of acceptable values has to be closed,
 * and it has to be closed HERE rather than only in a dropdown: a strict picker in
 * front of a free-text API is a lie the API will eventually be told.
 *
 * This replaces the hand-maintained IN/US lists that used to live in this file and
 * a parallel copy in `dashboard/lib/countries.ts`. The data now lives in the
 * `countries` / `country_subdivisions` / `country_subdivision_aliases` tables
 * (migration 0177), covering all 249 ISO 3166-1 regions, and the dashboard reads it
 * over `GET /v1/countries` instead of shipping its own copy.
 *
 * ── LOADING ─────────────────────────────────────────────────────────────────────
 * The accessors are SYNCHRONOUS because their callers are: `normalizeStateCode` is
 * used deep inside tax resolution, and making it async would ripple through the
 * whole pricing path. So the (small, static) reference set is loaded ONCE into
 * memory — `loadGeoReference()` at process start, or `primeGeoReference()` from the
 * committed JSON for unit tests and offline scripts.
 *
 * Using an accessor before either has run THROWS. That is deliberate: the natural
 * alternative — treating an empty cache as "no list, accept anything" — would turn
 * a boot-order mistake into silently unvalidated addresses and zero tax, which is
 * the exact failure this module exists to prevent.
 */
import { systemDb } from "@/platform/db";
import {
  countries as countriesTable,
  countrySubdivisions,
  countrySubdivisionAliases,
} from "@db/schema";

export interface GeoCountry {
  code: string;
  name: string;
  dialCode: string | null;
  phonePattern: string | null;
  phoneLengths: number[] | null;
  regionLabel: string;
  postalLabel: string;
  hasPostalCode: boolean;
  postalRegex: string | null;
  postalRedundant: string | null;
  postalHint: string | null;
  /** When true a non-empty subdivision outside the list is rejected. */
  subdivisionStrict: boolean;
}

export interface GeoSubdivision {
  code: string;
  name: string;
  type: string | null;
}

interface Cache {
  countries: Map<string, GeoCountry>;
  subdivisions: Map<string, GeoSubdivision[]>;
  aliases: Map<string, Map<string, string>>;
  /**
   * Longest-first dial codes for splitting an E.164 number. A dial code maps to
   * MANY countries, not one: `1` is the whole NANP (US, CA, and ~20 Caribbean
   * states), `7` is Russia and Kazakhstan, `44` covers the Crown dependencies.
   * Picking one arbitrarily would validate a real US number against Anguilla's
   * pattern and reject it.
   */
  dialCodes: Array<{ dial: string; countries: string[] }>;
}

let cache: Cache | null = null;

export class GeoNotLoadedError extends Error {
  constructor() {
    super(
      "Country reference data not loaded — call loadGeoReference() at startup or primeGeoReference() in tests",
    );
    this.name = "GeoNotLoadedError";
  }
}

export class SubdivisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubdivisionError";
  }
}

export class AddressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressValidationError";
  }
}

function get(): Cache {
  if (!cache) throw new GeoNotLoadedError();
  return cache;
}

export const isGeoLoaded = (): boolean => cache !== null;

function build(
  countryRows: GeoCountry[],
  subRows: Array<{ country: string; code: string; name: string; type: string | null }>,
  aliasRows: Array<{ country: string; alias: string; code: string }>,
): Cache {
  const subdivisions = new Map<string, GeoSubdivision[]>();
  for (const s of subRows) {
    const list = subdivisions.get(s.country) ?? [];
    list.push({ code: s.code, name: s.name, type: s.type });
    subdivisions.set(s.country, list);
  }
  for (const list of subdivisions.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const aliases = new Map<string, Map<string, string>>();
  for (const a of aliasRows) {
    const m = aliases.get(a.country) ?? new Map<string, string>();
    m.set(a.alias, a.code);
    aliases.set(a.country, m);
  }

  // Grouped, then longest-first so a longer code is never shadowed by a shorter one
  // that happens to be its prefix.
  const byDial = new Map<string, string[]>();
  for (const c of countryRows) {
    if (!c.dialCode) continue;
    byDial.set(c.dialCode, [...(byDial.get(c.dialCode) ?? []), c.code]);
  }
  const dialCodes = [...byDial.entries()]
    .map(([dial, list]) => ({ dial, countries: list }))
    .sort((a, b) => b.dial.length - a.dial.length);

  return {
    countries: new Map(countryRows.map((c) => [c.code, c])),
    subdivisions,
    aliases,
    dialCodes,
  };
}

/** Load from the database. Call once during process startup. */
export async function loadGeoReference(): Promise<void> {
  const [countryRows, subRows, aliasRows] = await Promise.all([
    systemDb.select().from(countriesTable),
    systemDb.select().from(countrySubdivisions),
    systemDb.select().from(countrySubdivisionAliases),
  ]);
  if (countryRows.length === 0) {
    throw new Error("countries table is empty — run `pnpm geo:seed`");
  }
  cache = build(
    countryRows as GeoCountry[],
    subRows.map((s) => ({ country: s.countryCode, code: s.code, name: s.name, type: s.type })),
    aliasRows.map((a) => ({ country: a.countryCode, alias: a.alias, code: a.code })),
  );
}

/**
 * Populate from an already-materialised dataset — `db/seed-data/geo.json` — so unit
 * tests and offline scripts validate against the same rows the database holds
 * without needing a connection.
 */
export function primeGeoReference(data: {
  countries: GeoCountry[];
  subdivisions: Array<{ country: string; code: string; name: string; type: string | null }>;
  aliases: Array<{ country: string; from: string; to: string }>;
}): void {
  cache = build(
    data.countries,
    data.subdivisions,
    data.aliases.map((a) => ({ country: a.country, alias: a.from, code: a.to })),
  );
}

/** Test-only: forget the cache so a later access fails loudly instead of using stale rows. */
export function resetGeoReference(): void {
  cache = null;
}

const cc = (v: string | null | undefined): string => (v ?? "").trim().toUpperCase();

// ── Countries ────────────────────────────────────────────────────────────────

export const allCountries = (): GeoCountry[] =>
  [...get().countries.values()].sort((a, b) => a.name.localeCompare(b.name));

export const countryFor = (code: string | null | undefined): GeoCountry | null =>
  get().countries.get(cc(code)) ?? null;

export const isValidCountry = (code: string | null | undefined): boolean =>
  get().countries.has(cc(code));

/** Upper-cased code, or a thrown 400-shaped error. Empty passes through as null. */
export function requireCountry(code: string | null | undefined): string | null {
  const v = cc(code);
  if (!v) return null;
  if (!get().countries.has(v)) {
    throw new AddressValidationError(`"${code}" is not a valid ISO 3166-1 alpha-2 country code`);
  }
  return v;
}

// ── Subdivisions ─────────────────────────────────────────────────────────────

/**
 * Countries the TAX engine can configure a region for today. Unrelated to which
 * countries have a subdivision list — that is now all of them. India and the US are
 * regime-aware (GST place of supply, US sales tax); elsewhere a region is a
 * country-wide flat rate.
 */
export const TAX_COUNTRIES = ["IN", "US"] as const;
export type TaxCountry = (typeof TAX_COUNTRIES)[number];
export const isTaxCountry = (c: string | null | undefined): c is TaxCountry =>
  !!c && (TAX_COUNTRIES as readonly string[]).includes(cc(c));

/** `{ value, label }` options for a country, or `null` when it has no subdivisions. */
export function subdivisionsFor(
  country: string | null | undefined,
): Array<{ value: string; label: string }> | null {
  const list = get().subdivisions.get(cc(country));
  return list?.length ? list.map((s) => ({ value: s.code, label: s.name })) : null;
}

/**
 * True when the list is a CLOSED set. False for countries whose ISO 3166-2 entries
 * are municipal units nobody writes in an address (GB's councils, FR's departments):
 * there the picker is a convenience and free text is still accepted.
 */
export const isStrictSubdivisionCountry = (country: string | null | undefined): boolean =>
  get().countries.get(cc(country))?.subdivisionStrict ?? false;

/**
 * The non-canonical codes accepted for a country, as `{ alias: canonical }`. The
 * dashboard needs these to RENDER: an imported customer holds `OD`, and a
 * picker that only knows `OR` would show a blank field for a correct value and clear
 * it on the next save. Served alongside the subdivisions so the fold lives in one
 * place instead of being copied into the dashboard by hand.
 */
export function aliasesFor(country: string | null | undefined): Record<string, string> {
  return Object.fromEntries(get().aliases.get(cc(country)) ?? []);
}

/** The display name for a canonical code, or null if we don't know it. */
export function subdivisionName(
  country: string | null | undefined,
  code: string | null | undefined,
): string | null {
  const canonical = normalizeStateCode(country, code);
  if (!canonical) return null;
  return (
    get()
      .subdivisions.get(cc(country))
      ?.find((s) => s.code === canonical)?.name ?? null
  );
}

/**
 * Fold a supplied code to its canonical form: upper-cased, aliases resolved.
 * Returns null for empty input. A code for a country we hold no list for is passed
 * through upper-cased — we cannot validate it, so we must not mangle it.
 */
export function normalizeStateCode(
  country: string | null | undefined,
  code: string | null | undefined,
): string | null {
  const raw = cc(code);
  if (!raw) return null;
  return get().aliases.get(cc(country))?.get(raw) ?? raw;
}

/**
 * Is this a code we recognise for the country? True for any code where we hold no
 * list, or where the list is not a closed set — absence of a closed list is not
 * evidence the code is wrong, and rejecting it would block a legitimate address.
 */
export function isValidStateCode(
  country: string | null | undefined,
  code: string | null | undefined,
): boolean {
  const c = cc(country);
  if (!isStrictSubdivisionCountry(c)) return true;
  const subs = get().subdivisions.get(c);
  if (!subs?.length) return true;
  const canonical = normalizeStateCode(country, code);
  if (!canonical) return true; // empty is "not stated", handled by required-ness elsewhere
  return subs.some((s) => s.code === canonical);
}

/**
 * Normalize + validate in one step, throwing a message that names the country and
 * shows what was expected. Callers at the API boundary use this so a bad code is a
 * 400 rather than a row that silently taxes nothing.
 */
export function requireStateCode(
  country: string | null | undefined,
  code: string | null | undefined,
): string | null {
  const canonical = normalizeStateCode(country, code);
  if (canonical === null) return null;
  if (!isValidStateCode(country, canonical)) {
    const c = cc(country);
    const known = get()
      .subdivisions.get(c)
      ?.map((s) => s.code)
      .join(", ");
    throw new SubdivisionError(
      `"${code}" is not a valid state code for ${c || "that country"}${known ? `. Use one of: ${known}` : ""}`,
    );
  }
  return canonical;
}

// ── Postal codes ─────────────────────────────────────────────────────────────

const reCache = new Map<string, RegExp>();

/**
 * Build an anchored matcher. The stored patterns are inconsistent — most are
 * `^…$`, GB's is a bare alternation — so an unanchored one would match any string
 * CONTAINING a valid postcode. Wrapping in a non-capturing group is what makes the
 * alternation anchor as a whole rather than only its first branch.
 */
function postalMatcher(country: GeoCountry): RegExp | null {
  if (!country.postalRegex) return null;
  const hit = reCache.get(country.code);
  if (hit) return hit;
  const body = country.postalRegex.replace(/^\^/, "").replace(/\$$/, "");
  const re = new RegExp(`^(?:${body})$`);
  reCache.set(country.code, re);
  return re;
}

/** Strip the characters the format treats as decoration (usually spaces and dashes). */
function canonicalPostal(country: GeoCountry, value: string): string {
  const redundant = country.postalRedundant ?? "";
  let out = value.trim().toUpperCase();
  for (const ch of redundant) out = out.split(ch).join("");
  return out;
}

/** True when acceptable for that country. Empty is always allowed here. */
export function isValidPostal(
  country: string | null | undefined,
  value: string | null | undefined,
): boolean {
  const raw = (value ?? "").trim();
  if (!raw) return true;
  const c = countryFor(country);
  if (!c) return true; // unknown country is a country error, not a postal one
  if (!c.hasPostalCode) return false;
  const re = postalMatcher(c);
  return re ? re.test(canonicalPostal(c, raw)) : true;
}

/**
 * Validate, returning the value as given (we store what the user typed — the
 * redundant-character stripping is for MATCHING only; "SW1A 1AA" should not be
 * flattened to "SW1A1AA" on an invoice).
 */
export function requirePostal(
  country: string | null | undefined,
  value: string | null | undefined,
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const c = countryFor(country);
  if (c && !c.hasPostalCode) {
    throw new AddressValidationError(`${c.name} does not use a postal code`);
  }
  if (!isValidPostal(country, raw)) {
    const hint = c?.postalHint ? `. Expected format: ${c.postalHint}` : "";
    throw new AddressValidationError(
      `"${raw}" is not a valid ${c?.postalLabel.toLowerCase() ?? "postal code"} for ${c?.code ?? "that country"}${hint}`,
    );
  }
  return raw;
}

// ── Phone numbers ────────────────────────────────────────────────────────────

const phoneCache = new Map<string, RegExp>();

function phoneMatcher(country: GeoCountry): RegExp | null {
  if (!country.phonePattern) return null;
  const hit = phoneCache.get(country.code);
  if (hit) return hit;
  const re = new RegExp(`^(?:${country.phonePattern})$`);
  phoneCache.set(country.code, re);
  return re;
}

/** Digits only, plus a leading `+` if present. */
const cleanPhone = (v: string): string => {
  const trimmed = v.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
};

/**
 * Split an E.164 number into its dial code, the countries that share it, and the
 * national part. Matched longest-first so a longer dial code is never shadowed by a
 * shorter one that is its prefix.
 *
 * `countries` is a LIST because a dial code is not unique: `+1` is the whole North
 * American Numbering Plan. Telling them apart needs area-code tables we deliberately
 * do not carry, so validation accepts a number that is valid for ANY of them.
 */
export function splitE164(
  value: string,
): { dial: string; countries: string[]; national: string } | null {
  const cleaned = cleanPhone(value);
  if (!cleaned.startsWith("+")) return null;
  const digits = cleaned.slice(1);
  for (const { dial, countries } of get().dialCodes) {
    if (digits.startsWith(dial)) return { dial, countries, national: digits.slice(dial.length) };
  }
  return null;
}

/** Does this national number fit that country's length rules and pattern? */
function fitsCountry(country: GeoCountry, national: string): boolean {
  if (country.phoneLengths?.length && !country.phoneLengths.includes(national.length)) return false;
  const re = phoneMatcher(country);
  return re ? re.test(national) : national.length >= 4;
}

/**
 * The country an E.164 number belongs to, resolved by trying every country that
 * shares its dial code and keeping the first whose rules it satisfies. Falls back to
 * the first sharer so a caller always gets a country to name in an error.
 */
export function resolveE164(value: string): { country: string; national: string } | null {
  const split = splitE164(value);
  if (!split) return null;
  for (const code of split.countries) {
    const c = countryFor(code);
    if (c && fitsCountry(c, split.national)) return { country: code, national: split.national };
  }
  return split.countries[0] ? { country: split.countries[0], national: split.national } : null;
}

/**
 * Validate a phone number. Accepts E.164 (`+919876543210`) or a national number
 * when `country` says which country to read it as. Empty is allowed — a phone is
 * optional everywhere we collect one.
 */
export function isValidPhone(value: string | null | undefined, country?: string | null): boolean {
  const raw = (value ?? "").trim();
  if (!raw) return true;
  const cleaned = cleanPhone(raw);

  // An E.164 value carries its own country — but possibly several, so it is valid if
  // it is valid for any of them. A bare national number is read against `country`.
  if (cleaned.startsWith("+")) {
    const split = splitE164(cleaned);
    if (!split) return false;
    return split.countries.some((code) => {
      const c = countryFor(code);
      return c ? fitsCountry(c, split.national) : false;
    });
  }
  const target = countryFor(country);
  return target ? fitsCountry(target, cleaned) : false;
}

/**
 * The number with its domestic trunk 0 removed, when that is what makes it valid —
 * `+4407700900123` → `+447700900123`. Null when the 0 is not the problem. Italy keeps
 * its 0 internationally, and an Italian number is valid as-is, so it never gets here.
 */
export function withoutTrunkZero(value: string, country?: string | null): string | null {
  const cleaned = cleanPhone(value);
  let candidate: string | null = null;
  if (cleaned.startsWith("+")) {
    const split = splitE164(cleaned);
    if (split?.national.startsWith("0")) candidate = `+${split.dial}${split.national.slice(1)}`;
  } else if (cleaned.startsWith("0")) {
    candidate = cleaned.slice(1);
  }
  return candidate && isValidPhone(candidate, country) ? candidate : null;
}

/**
 * Validate and return E.164. `country` supplies the dial code when the value is a
 * national number; a value that already carries `+` keeps its own.
 */
export function requirePhoneE164(
  value: string | null | undefined,
  country?: string | null,
): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  const cleaned = cleanPhone(raw);

  if (!cleaned.startsWith("+")) {
    const c = countryFor(country);
    if (!c?.dialCode) {
      throw new AddressValidationError(
        "A phone number without a country code needs a country to resolve it. Supply an E.164 number that starts with + instead",
      );
    }
    if (!isValidPhone(cleaned, c.code)) {
      throw new AddressValidationError(`"${raw}" is not a valid phone number for ${c.name}`);
    }
    return `+${c.dialCode}${cleaned}`;
  }

  if (!isValidPhone(cleaned)) {
    throw new AddressValidationError(`"${raw}" is not a valid phone number`);
  }
  return cleaned;
}
