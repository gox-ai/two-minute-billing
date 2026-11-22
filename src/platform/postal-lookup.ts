/**
 * Postal code → state + places, read from `postal_codes` (GeoNames, CC BY 4.0, loaded by
 * `pnpm postal:seed`). Reference data: no tenant, so it reads through `systemDb` like
 * `geo.ts`. An empty table, or an unknown code, answers `null` and the forms skip the autofill.
 */
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { subdivisionName } from "@/platform/geo";

export interface PostalPlace {
  /** Our subdivision code (`TN`, `CA`), or null when GeoNames' region matched none of ours. */
  stateCode: string | null;
  stateName: string | null;
  /** Distinct place names for the code, in order. */
  cities: string[];
}

/** How many places one code returns; a code names a handful, so this is a safety cap. */
const MAX_CITIES = 50;

/** Stored form of a code: upper case, no spaces or hyphens (`sw1a 1aa` → `SW1A1AA`). */
export function postalKey(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Countries whose GeoNames file holds only the leading part of a code (GB outward code, CA
 * forward sortation area, NL digits, IE routing key). Source: GeoNames postal readme and the
 * file itself: GB 2–4 chars, CA 3, NL 4, IE 3.
 */
const PARTIAL: Record<string, (key: string) => string> = {
  GB: (k) => k.slice(0, -3),
  CA: (k) => k.slice(0, 3),
  NL: (k) => k.slice(0, 4),
  IE: (k) => k.slice(0, 3),
};

/** Keys to try, most specific first. */
export function lookupKeys(country: string, raw: string): string[] {
  const key = postalKey(raw);
  if (!key) return [];
  const partial = PARTIAL[country]?.(key);
  return partial && partial !== key && partial.length >= 2 ? [key, partial] : [key];
}

export async function lookupPostal(
  countryCode: string,
  rawPostal: string,
): Promise<PostalPlace | null> {
  const country = countryCode.trim().toUpperCase();
  for (const key of lookupKeys(country, rawPostal)) {
    const rows = await systemDb.execute<{
      place_name: string;
      admin1_name: string | null;
      state_code: string | null;
    }>(sql`
      SELECT place_name, admin1_name, state_code FROM postal_codes
      WHERE country = ${country} AND postal_code = ${key}
      ORDER BY place_name LIMIT ${MAX_CITIES}
    `);
    if (rows.length === 0) continue;
    // Rare: a code that spans two regions. Take the most common one.
    const votes = new Map<string, number>();
    for (const r of rows)
      if (r.state_code) votes.set(r.state_code, (votes.get(r.state_code) ?? 0) + 1);
    const stateCode = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      stateCode,
      stateName:
        (stateCode ? subdivisionName(country, stateCode) : null) ??
        rows.find((r) => r.admin1_name)?.admin1_name ??
        null,
      cities: [...new Set(rows.map((r) => r.place_name))],
    };
  }
  return null;
}
