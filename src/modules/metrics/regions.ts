/**
 * Country → region, for the `region` metric dimension.
 *
 * Scheme: the UN M49 standard's regions and sub-regions, grouped into five and applied
 * strictly — no commercial exceptions, so a country's region is looked up, never argued:
 *
 *   north_america       M49 Northern America (021)
 *   latin_america       M49 Latin America and the Caribbean (419)
 *   europe              M49 Europe (150)
 *   middle_east_africa  M49 Africa (002) + Western Asia (145)
 *   asia_pacific        M49 Central, Eastern, South-eastern and Southern Asia + Oceania (009)
 *
 * Strict means Cyprus is Western Asia and Iran is Southern Asia, as M49 files them. Kosovo
 * (XK, user-assigned) and Taiwan (TW, not listed by M49) are placed with their neighbours.
 * A code in none of the lists (AQ, a typo) is `other`; no country on file is `none`.
 */

export const REGIONS = [
  "north_america",
  "latin_america",
  "europe",
  "middle_east_africa",
  "asia_pacific",
] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Record<Region | "other" | "none", string> = {
  north_america: "North America",
  latin_america: "Latin America & Caribbean",
  europe: "Europe",
  middle_east_africa: "Middle East & Africa",
  asia_pacific: "Asia Pacific",
  other: "Other",
  none: "Not set",
};

const MEMBERS: Record<Region, string> = {
  north_america: "BM CA GL PM US",
  latin_america:
    // Caribbean
    "AG AI AW BB BL BQ BS CU CW DM DO GD GP HT JM KN KY LC MF MQ MS PR SX TC TT VC VG VI " +
    // Central America
    "BZ CR GT HN MX NI PA SV " +
    // South America
    "AR BO BR BV CL CO EC FK GF GS GY PE PY SR UY VE",
  europe:
    // Eastern
    "BG BY CZ HU MD PL RO RU SK UA " +
    // Northern
    "AX DK EE FI FO GB GG IE IM IS JE LT LV NO SE SJ " +
    // Southern
    "AD AL BA ES GI GR HR IT ME MK MT PT RS SI SM VA XK " +
    // Western
    "AT BE CH DE FR LI LU MC NL",
  middle_east_africa:
    // Northern Africa
    "DZ EG EH LY MA SD TN " +
    // Sub-Saharan Africa
    "AO BF BI BJ BW CD CF CG CI CM CV DJ ER ET GA GH GM GN GQ GW IO KE KM LR LS MG ML MR MU " +
    "MW MZ NA NE NG RE RW SC SH SL SN SO SS ST SZ TD TF TG TZ UG YT ZA ZM ZW " +
    // Western Asia
    "AE AM AZ BH CY GE IL IQ JO KW LB OM PS QA SA SY TR YE",
  asia_pacific:
    // Central Asia
    "KG KZ TJ TM UZ " +
    // Eastern Asia
    "CN HK JP KP KR MN MO TW " +
    // South-eastern Asia
    "BN ID KH LA MM MY PH SG TH TL VN " +
    // Southern Asia
    "AF BD BT IN IR LK MV NP PK " +
    // Oceania
    "AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS",
};

const BY_COUNTRY: ReadonlyMap<string, Region> = new Map(
  (Object.entries(MEMBERS) as Array<[Region, string]>).flatMap(([region, codes]) =>
    codes.split(" ").map((c): [string, Region] => [c, region]),
  ),
);

/** The region key for an ISO 3166-1 alpha-2 code: `none` when absent, `other` when unmapped. */
export function regionOf(country: string | null | undefined): Region | "other" | "none" {
  if (!country) return "none";
  return BY_COUNTRY.get(country.toUpperCase()) ?? "other";
}
