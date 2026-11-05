import { cache } from "react";
import { apiGet } from "@/lib/api";

/**
 * Country reference data, fetched from the engine.
 *
 * This replaces the tables that used to be hardcoded in `lib/countries.ts` — a
 * country-code string, four subdivision lists and fifteen postal regexes, all of
 * which the engine held a second, differently-scoped copy of. The picker can no
 * longer offer a value the API rejects, because both sides read the same rows.
 *
 * `cache()` dedupes within a single render pass; the engine also sends a day-long
 * `cache-control`, so this is one fetch per server process in practice.
 */

export interface Country {
  code: string;
  name: string;
  dial_code: string | null;
  /** National-number pattern; anchor as `^(?:…)$`. Absent from an older engine. */
  phone_pattern?: string | null;
  /** Allowed national-number lengths; null means any. */
  phone_lengths?: number[] | null;
  /** Local name for the region field — "State", "Province", "Prefecture". */
  region_label: string;
  /** Local name for the postal field — "ZIP code", "PIN code", "Postcode". */
  postal_label: string;
  /** False for the ~60 countries with no postal system — hide the field entirely. */
  has_postal_code: boolean;
  /** Anchor as `^(?:…)$` before testing; null means no format to check. */
  postal_regex: string | null;
  /** Characters to strip before matching (usually " -"). */
  postal_redundant: string | null;
  postal_hint: string | null;
  /** True when a value outside the subdivision list is rejected by the API. */
  subdivision_strict: boolean;
  has_subdivisions: boolean;
}

export interface Subdivision {
  code: string;
  name: string;
}

export interface SubdivisionList {
  data: Subdivision[];
  /** Non-canonical codes we accept, `{ alias: canonical }` — alternate Indian codes. */
  aliases: Record<string, string>;
}

export const getCountries = cache(async (): Promise<Country[]> => {
  const { data } = await apiGet<{ data: Country[] }>("/v1/countries");
  return data;
});

export const getCountry = cache(async (code: string): Promise<Country | null> => {
  const all = await getCountries();
  return all.find((c) => c.code === code.toUpperCase()) ?? null;
});

export const getSubdivisions = cache(async (code: string): Promise<SubdivisionList> => {
  if (!code) return { data: [], aliases: {} };
  return apiGet<SubdivisionList>(
    `/v1/countries/${encodeURIComponent(code.toUpperCase())}/subdivisions`,
  );
});
