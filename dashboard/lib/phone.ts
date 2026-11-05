/**
 * Phone entry rules for `PhoneField`: compose what was typed into E.164, and check it against
 * the country's rules from `/v1/countries`.
 *
 * No app imports, so the root unit tests can load it (`test/unit/compose-phone.test.ts`).
 */

/** The phone half of a `/v1/countries` row — structurally a subset of `Country`. */
export interface PhoneCountry {
  code: string;
  dial_code: string | null;
  phone_pattern?: string | null;
  phone_lengths?: number[] | null;
}

/** Loose fallback for a country the engine sent no phone rules for. */
export function isPlausiblePhone(national: string): boolean {
  const digits = national.replace(/[^\d]/g, "");
  if (!digits) return true;
  return digits.length >= 4 && digits.length <= 15;
}

const phoneReCache = new Map<string, RegExp | null>();

/**
 * Does this national number fit the country's rules? Mirrors `fitsCountry` in
 * `src/platform/geo.ts`, reading the same rules from `/v1/countries`.
 */
function fitsCountry(country: PhoneCountry, national: string): boolean {
  if (country.phone_lengths?.length && !country.phone_lengths.includes(national.length))
    return false;
  if (!country.phone_pattern) return national.length >= 4;
  let re = phoneReCache.get(country.code);
  if (re === undefined) {
    try {
      re = new RegExp(`^(?:${country.phone_pattern})$`);
    } catch {
      re = null; // a pattern this browser cannot compile must not break the form
    }
    phoneReCache.set(country.code, re);
  }
  return re ? re.test(national) : national.length >= 4;
}

/** Fits any country on this dial code (+1 is shared). Null when no rules are known. */
function fitsDial(dial: string, national: string, countries: PhoneCountry[]): boolean | null {
  const sharers = countries.filter((c) => c.dial_code === dial);
  if (!sharers.some((c) => c.phone_pattern || c.phone_lengths?.length)) return null;
  return sharers.some((c) => fitsCountry(c, national));
}

/**
 * The dial code after the address country changes to one dialling `countryDial`.
 *
 * Follows the country while no number is typed. Once one is, a dial code already set stays
 * (changing country must not re-file the number) — but an EMPTY one is still filled, or a
 * number typed before the country posts as "" and is silently dropped.
 */
export function dialForCountry(current: string, numberTyped: boolean, countryDial: string): string {
  return numberTyped && current ? current : countryDial;
}

/**
 * The E.164 value for a dial code plus what the person typed, or "" when nothing was typed.
 *
 * People write their own number the domestic way, so the typed part is read leniently: a
 * leading `+` or `00` means they typed the whole international number; otherwise a repeated
 * dial code and a trunk 0 (`07700 900123` under +44) are dropped — but only when the number
 * is valid without them, so a number whose 0 is significant (Italy) is kept as typed.
 */
export function composePhone(dial: string, typed: string, countries: PhoneCountry[]): string {
  const raw = typed.trim();
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (!dial) return "";
  const candidates = [digits, digits.replace(/^0/, "")];
  if (digits.startsWith(dial)) {
    const rest = digits.slice(dial.length);
    candidates.push(rest, rest.replace(/^0/, ""));
  }
  const fit = candidates.find((n) => n && fitsDial(dial, n, countries));
  return `+${dial}${fit ?? digits}`;
}

/**
 * Is the composed number valid for its dial code? Falls back to the loose check when the
 * engine sent no rules, and accepts an empty value (the field is optional).
 */
export function isValidComposedPhone(e164: string, countries: PhoneCountry[]): boolean {
  if (!e164) return true;
  const { dial, national } = splitPhone(e164, countries);
  if (!dial) return isPlausiblePhone(national);
  return fitsDial(dial, national, countries) ?? isPlausiblePhone(national);
}

/** Split a stored E.164 value into dial code + national part for the two inputs. */
export function splitPhone(
  value: string | null | undefined,
  countries: PhoneCountry[],
): { dial: string; national: string } {
  const raw = (value ?? "").trim();
  if (!raw.startsWith("+")) return { dial: "", national: raw };
  const digits = raw.slice(1).replace(/[^\d]/g, "");
  // Longest first, so a longer dial code is not shadowed by a shorter prefix of it.
  const dials = [...new Set(countries.map((c) => c.dial_code).filter(Boolean) as string[])].sort(
    (a, b) => b.length - a.length,
  );
  const hit = dials.find((d) => digits.startsWith(d));
  return hit ? { dial: hit, national: digits.slice(hit.length) } : { dial: "", national: digits };
}
