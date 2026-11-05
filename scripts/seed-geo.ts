/**
 * Load `db/seed-data/geo.json` into the country reference tables.
 *
 *   pnpm geo:seed
 *
 * Idempotent: every row is an upsert keyed on the natural key, so re-running after
 * `pnpm geo:generate` picks up corrections without a truncate. Rows that have been
 * REMOVED from the dataset are deleted, so a subdivision a country abolishes stops
 * being accepted — the whole point of a closed set.
 *
 * Reference data, not tenant data: these tables are deliberately excluded from
 * `pnpm db:reset`, so a verify run does not leave the engine unable to validate an
 * address. Run this once after `pnpm db:migrate`.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import {
  countries,
  countrySubdivisions,
  countrySubdivisionAliases,
  referenceDataSources,
} from "@db/schema";

interface GeoData {
  attribution?: { version?: string };
  countries: Array<{
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
    subdivisionStrict: boolean;
    timezones?: string[];
  }>;
  subdivisions: Array<{ country: string; code: string; name: string; type: string | null }>;
  aliases: Array<{ country: string; from: string; to: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const data: GeoData = JSON.parse(readFileSync(resolve(here, "../db/seed-data/geo.json"), "utf8"));

// Postgres caps a statement at 65535 bind parameters; these inserts are wide, so
// chunk well under it rather than discovering the limit on a dataset that grows.
const CHUNK = 500;
function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
}

for (const batch of chunks(data.countries)) {
  await systemDb
    .insert(countries)
    .values(
      batch.map((c) => ({
        code: c.code,
        name: c.name,
        dialCode: c.dialCode,
        phonePattern: c.phonePattern,
        phoneLengths: c.phoneLengths,
        regionLabel: c.regionLabel,
        postalLabel: c.postalLabel,
        hasPostalCode: c.hasPostalCode,
        postalRegex: c.postalRegex,
        postalRedundant: c.postalRedundant,
        postalHint: c.postalHint,
        subdivisionStrict: c.subdivisionStrict,
        timezones: c.timezones?.length ? c.timezones : null,
      })),
    )
    .onConflictDoUpdate({
      target: countries.code,
      set: {
        name: sql`excluded.name`,
        dialCode: sql`excluded.dial_code`,
        phonePattern: sql`excluded.phone_pattern`,
        phoneLengths: sql`excluded.phone_lengths`,
        regionLabel: sql`excluded.region_label`,
        postalLabel: sql`excluded.postal_label`,
        hasPostalCode: sql`excluded.has_postal_code`,
        postalRegex: sql`excluded.postal_regex`,
        postalRedundant: sql`excluded.postal_redundant`,
        postalHint: sql`excluded.postal_hint`,
        subdivisionStrict: sql`excluded.subdivision_strict`,
        timezones: sql`excluded.timezones`,
      },
    });
}

for (const batch of chunks(data.subdivisions)) {
  await systemDb
    .insert(countrySubdivisions)
    .values(
      batch.map((s) => ({ countryCode: s.country, code: s.code, name: s.name, type: s.type })),
    )
    .onConflictDoUpdate({
      target: [countrySubdivisions.countryCode, countrySubdivisions.code],
      set: { name: sql`excluded.name`, type: sql`excluded.type` },
    });
}

for (const batch of chunks(data.aliases)) {
  await systemDb
    .insert(countrySubdivisionAliases)
    .values(batch.map((a) => ({ countryCode: a.country, alias: a.from, code: a.to })))
    .onConflictDoUpdate({
      target: [countrySubdivisionAliases.countryCode, countrySubdivisionAliases.alias],
      set: { code: sql`excluded.code` },
    });
}

// Drop anything no longer in the dataset. Without this a code stays valid forever
// after the country stops using it, which is exactly the drift the closed set exists
// to prevent. Aliases and subdivisions cascade from countries, so order matters only
// for readability.
/**
 * A bare `${array}` interpolates as a ROW constructor, which blows the 1664-column
 * limit at this size (54011). Build an explicit text[] instead — one bind parameter
 * per element, still an order of magnitude under the 65535 parameter cap.
 */
const textArray = (values: string[]) =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

const liveCountries = data.countries.map((c) => c.code);
const liveSubs = data.subdivisions.map((s) => `${s.country}:${s.code}`);
const liveAliases = data.aliases.map((a) => `${a.country}:${a.from}`);

const delSubs = await systemDb.execute(sql`
  DELETE FROM country_subdivisions
  WHERE country_code || ':' || code <> ALL (${textArray(liveSubs)})
`);
const delAliases = await systemDb.execute(sql`
  DELETE FROM country_subdivision_aliases
  WHERE country_code || ':' || alias <> ALL (${textArray(liveAliases)})
`);
const delCountries = await systemDb.execute(sql`
  DELETE FROM countries WHERE code <> ALL (${textArray(liveCountries)})
`);

console.log(`countries      ${data.countries.length} upserted, ${delCountries.count ?? 0} removed`);
console.log(`subdivisions   ${data.subdivisions.length} upserted, ${delSubs.count ?? 0} removed`);
console.log(`aliases        ${data.aliases.length} upserted, ${delAliases.count ?? 0} removed`);

// What is now seeded, for the `geo_reference_outdated` ops alert.
const seededVersion = data.attribution?.version ?? null;
await systemDb
  .insert(referenceDataSources)
  .values({ source: "dr5hn", seededVersion, seededAt: new Date() })
  .onConflictDoUpdate({
    target: referenceDataSources.source,
    set: { seededVersion, seededAt: new Date() },
  });
console.log(`seeded version ${seededVersion ?? "(none in geo.json)"}`);
// The API and worker load this set into memory ONCE at boot (the validators are
// synchronous — see src/platform/geo.ts), so a running process keeps serving the
// rows it started with until it is restarted.
console.log("\n⚠  restart the API and worker to pick these up (loaded once at boot)");

await closeDb();
process.exit(0);
