/**
 * Truncate all application tables for a clean slate (keeps the schema + migration
 * history). Used at the start of `verify:all` so a full run is hermetic instead of
 * accumulating rows across runs. graphile_worker lives in its own schema and is
 * left alone.
 *
 *   pnpm db:reset
 */
import { sql } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";

/**
 * Platform REFERENCE data, not tenant data — kept for the same reason the migration
 * history is. Truncating the country tables would leave the engine unable to validate
 * any address until someone re-ran `pnpm geo:seed`, so every `verify:all` (which calls
 * db:reset) would start by breaking address validation.
 */
const KEEP = [
  "__drizzle_migrations",
  "countries",
  "country_subdivisions",
  "country_subdivision_aliases",
  // The AI model price list: filled by its sync, append-only. Its source row is reset, so the
  // next sync fetches in full and diffs against these rows.
  "model_price_models",
  "model_prices",
];

// One bind per name rather than `<> all (${KEEP})`: an interpolated JS array reaches
// Postgres as an untyped parameter, and `all(...)` cannot infer an array type from
// context, so the server rejected it outright — `op ANY/ALL (array) requires array on
// right side` (42809), which took CI's whole verify job down at setup.
const rows = (await systemDb.execute(sql`
  select tablename from pg_tables
  where schemaname = 'public'
    and tablename not in (${sql.join(
      KEEP.map((t) => sql`${t}`),
      sql`, `,
    )})
`)) as unknown as Array<{ tablename: string }>;

const tables = rows.map((r) => `"${r.tablename}"`);
if (tables.length > 0) {
  await systemDb.execute(sql.raw(`truncate table ${tables.join(", ")} restart identity cascade`));
  console.log(`reset ${tables.length} tables`);
} else {
  console.log("no tables to reset");
}
await closeDb();
process.exit(0);
