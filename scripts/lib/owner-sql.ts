/**
 * A connection as the table owner, for test fixtures that run DDL or replay a migration.
 * Under `verify:all:fresh --system-role` the suites log in as the app role, which owns nothing;
 * MIGRATION_DATABASE_URL is then the owner. Otherwise DATABASE_URL already is.
 */
import postgres from "postgres";
import { config } from "@/platform/config";

export function ownerSql(): postgres.Sql {
  return postgres(process.env.MIGRATION_DATABASE_URL ?? config.DATABASE_URL, {
    max: 1,
    onnotice: () => {},
  });
}
