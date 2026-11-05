/**
 * `TMBILLING_REQUIRE_SCHEMA=TRUE` (the Docker image sets it): the API and the worker refuse to
 * boot when the database is behind this code, for installs that start them without `init`.
 * Unset (pm2) = no check.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { appliedSchemaWhen, expectedSchemaWhen } from "./schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface SchemaCheck {
  current: boolean;
  applied: number;
  expected: number;
}

export async function checkSchema(databaseUrl: string, root = ROOT): Promise<SchemaCheck> {
  const expected = expectedSchemaWhen(root);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const applied = await appliedSchemaWhen(sql);
    return { current: applied >= expected, applied, expected };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Exit 1 with `schema_behind` when required and behind; a no-op otherwise. */
export async function requireCurrentSchema(
  databaseUrl: string,
  log: { error: (error: unknown, info?: unknown) => void },
): Promise<void> {
  if (process.env.TMBILLING_REQUIRE_SCHEMA !== "TRUE") return;
  const check = await checkSchema(databaseUrl);
  if (check.current) return;
  log.error(
    new Error("The database schema is older than this release. Run the init service first."),
    {
      event: "schema_behind",
      applied: check.applied,
      expected: check.expected,
    },
  );
  process.exit(1);
}
