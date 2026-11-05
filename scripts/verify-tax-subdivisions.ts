/**
 * The subdivision data the engine validates against must be the data we reviewed.
 *
 * This used to compare two hand-maintained copies — `src/platform/subdivisions.ts`
 * and a duplicate in `dashboard/lib/countries.ts`. Migration 0177 removed the
 * duplication: the reference set lives in `countries` / `country_subdivisions`, is
 * generated from the dr5hn database with NO per-country overrides, and the dashboard
 * reads it over `GET /v1/countries`. So the drift worth checking changed shape, and
 * it is now between three things:
 *
 *   the reviewed dataset   db/seed-data/geo.json
 *   what the database has  countries + country_subdivisions
 *   what the engine loads  src/platform/geo.ts
 *
 * A drift is not cosmetic. `state_code` decides place of supply: a code the engine
 * rejects 400s the form, and a code it accepts but cannot name renders blank and is
 * silently cleared by the next save. Worse, a MISSING code resolves to no place of
 * supply and taxes at zero — a wrong number on a legal document, not an error.
 *
 *   pnpm verify:tax-subdivisions
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { systemDb, closeDb } from "@/platform/db";
import { countries as countriesTable, countrySubdivisions } from "@db/schema";
import {
  TAX_COUNTRIES,
  loadGeoReference,
  normalizeStateCode,
  requireStateCode,
  subdivisionsFor,
  isStrictSubdivisionCountry,
} from "@/platform/geo";

const checks: Array<[string, boolean]> = [];
const ok = (name: string, good: boolean) => checks.push([name, good]);

const dataset = JSON.parse(
  readFileSync(resolve(process.cwd(), "db/seed-data/geo.json"), "utf8"),
) as {
  countries: Array<{ code: string; subdivisionStrict: boolean }>;
  subdivisions: Array<{ country: string; code: string; name: string }>;
};

// ── The database matches the reviewed dataset ────────────────────────────────
const dbCountries = await systemDb.select({ code: countriesTable.code }).from(countriesTable);
const dbSubs = await systemDb
  .select({
    country: countrySubdivisions.countryCode,
    code: countrySubdivisions.code,
    name: countrySubdivisions.name,
  })
  .from(countrySubdivisions);

ok(`countries seeded (${dbCountries.length})`, dbCountries.length === dataset.countries.length);
ok(`subdivisions seeded (${dbSubs.length})`, dbSubs.length === dataset.subdivisions.length);

const dbKey = new Set(dbSubs.map((s) => `${s.country}:${s.code}`));
const jsonKey = new Set(dataset.subdivisions.map((s) => `${s.country}:${s.code}`));
const missingInDb = [...jsonKey].filter((k) => !dbKey.has(k));
const extraInDb = [...dbKey].filter((k) => !jsonKey.has(k));
ok(
  `no subdivision missing from the database${missingInDb.length ? ` — ${missingInDb.slice(0, 8).join(", ")}` : ""}`,
  missingInDb.length === 0,
);
ok(
  `no stale subdivision in the database${extraInDb.length ? ` — ${extraInDb.slice(0, 8).join(", ")}` : ""}`,
  extraInDb.length === 0,
);

// ── The engine loads what the database holds ─────────────────────────────────
await loadGeoReference();

for (const cc of ["IN", "US"] as const) {
  const loaded = subdivisionsFor(cc) ?? [];
  const expected = dataset.subdivisions.filter((s) => s.country === cc);
  ok(`${cc}: engine loaded ${expected.length} subdivisions`, loaded.length === expected.length);
  const names = new Map(loaded.map((s) => [s.value, s.label]));
  const nameDiffs = expected.filter((e) => names.get(e.code) !== e.name);
  ok(
    `${cc}: names agree${
      nameDiffs.length
        ? ` — ${nameDiffs
            .slice(0, 5)
            .map((d) => d.code)
            .join(", ")}`
        : ""
    }`,
    nameDiffs.length === 0,
  );
  ok(`${cc}: is a closed set`, isStrictSubdivisionCountry(cc));
}

/**
 * The freshness properties the source is chosen FOR. The previous source
 * (`iso-3166-2@1.0.0`) predated India's 2019/2020 reorganisation — no Ladakh, no
 * merged `DH`, still listing `DD`/`DN` separately — and a `state_code` matching
 * nothing resolves to no place of supply and taxes at zero. If a future source swap
 * regresses any of these, this is what catches it.
 */
const inCodes = new Set((subdivisionsFor("IN") ?? []).map((s) => s.value));
ok("IN has LA (Ladakh) — created 2019", inCodes.has("LA"));
ok("IN has DH (merged Dadra and Nagar Haveli and Daman and Diu) — merged 2020", inCodes.has("DH"));
ok("IN does not have the pre-2020 DD/DN", !inCodes.has("DD") && !inCodes.has("DN"));
ok("IN has exactly 36 subdivisions (28 states + 8 union territories)", inCodes.size === 36);
// The source uses a non-ISO spelling here; `UT` folds onto it below.
ok("IN codes Uttarakhand as UK (source canonical)", inCodes.has("UK") && !inCodes.has("UT"));

const usCodes = new Set((subdivisionsFor("US") ?? []).map((s) => s.value));
ok("US has DC", usCodes.has("DC"));
ok(
  "US has the 3 military postal regions (real billing destinations)",
  ["AA", "AE", "AP"].every((c) => usCodes.has(c)),
);
ok("US has exactly 60, straight from the source", usCodes.size === 60);

/**
 * The alias fold. Not all in the same direction — the source uses ISO for
 * Chhattisgarh / Odisha / Telangana but the non-ISO spelling for Uttarakhand, so three
 * folds run non-ISO→canonical and one runs ISO→canonical. Either scheme resolves.
 */
const CB_ALIASES: Array<[string, string, string]> = [
  ["IN", "CG", "CT"],
  ["IN", "OD", "OR"],
  ["IN", "TS", "TG"],
  // Folds the other way: the source is canonical on `UK`, so ISO's `UT` is the alias.
  ["IN", "UT", "UK"],
];
for (const [cc, from, to] of CB_ALIASES) {
  ok(`alias ${cc} ${from}→${to}`, normalizeStateCode(cc, from) === to);
  ok(`alias ${cc} ${from}→${to} survives validation`, requireStateCode(cc, from) === to);
}
// An alias must not shadow a code that already means something else.
ok(
  "no alias collides with a real Indian code",
  CB_ALIASES.every(([, from]) => !inCodes.has(from)),
);
// Every canonical code folds to itself, in either case.
let foldDiffs = 0;
for (const cc of ["IN", "US"]) {
  for (const s of subdivisionsFor(cc) ?? []) {
    if (normalizeStateCode(cc, s.value) !== s.value) foldDiffs++;
    if (normalizeStateCode(cc, s.value.toLowerCase()) !== s.value) foldDiffs++;
  }
}
ok("every canonical code folds to itself, in both cases", foldDiffs === 0);

ok(`tax countries unchanged (${TAX_COUNTRIES.join(",")})`, TAX_COUNTRIES.join(",") === "IN,US");

let pass = true;
console.log("");
for (const [n, good] of checks) {
  console.log(`  ${good ? "✓" : "✗"} ${n}`);
  if (!good) pass = false;
}
console.log(`\n${checks.length} checks`);
console.log(pass ? "✅ TAX SUBDIVISIONS: PASS" : "❌ TAX SUBDIVISIONS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
