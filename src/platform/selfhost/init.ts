/**
 * The self-hosted `init` step: everything a database needs before the API and worker start.
 * The Docker image runs it as a one-shot service; `pnpm db:setup` / `db:migrate` run it on a
 * public checkout. Connects as the owner (MIGRATION_DATABASE_URL, else DATABASE_URL).
 *
 * All steps run under one session advisory lock, so a second `init` waits and then finds
 * each step a no-op:
 *   1. roles — `tmbilling_app`, and the `tmbilling_system` login from APP_DB_PASSWORD
 *      (skipped when TMBILLING_APP_ROLE=external or no password is set),
 *   2. schema — graphile_worker, the baseline once, the newer migrations (`schema.ts`),
 *   3. grants for `tmbilling_system` (scripts/sql/system-role.sql),
 *   4. the geo reference data, when its version changed,
 *   5. the first organization from env (`bootstrap-org.ts`).
 * Exits non-zero on any failure, so compose never starts the API on a half-migrated database.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createLogger, flushCloudLogging } from "@/platform/logger";
import { installSchema } from "./schema";

const log = createLogger("selfhost-init");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ownerUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
const LOCK_WAIT_MS = Number(process.env.TMBILLING_INIT_LOCK_WAIT_MS ?? 600_000);

async function main(): Promise<void> {
  if (!ownerUrl)
    throw new Error("Set MIGRATION_DATABASE_URL (or DATABASE_URL) to the owner login.");
  const lock = postgres(ownerUrl, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "tmbilling-init" },
  });
  try {
    await acquireLock(lock);
    await ensureRoles(lock);
    const schema = await installSchema(ownerUrl, ROOT);
    log.info("schema ready", {
      event: "init_schema_ready",
      baseline: schema.baselineApplied?.tag ?? null,
      migrations_applied: schema.migrationsApplied,
    });
    await grantSystemRole(lock);
    await loadGeo(lock);
    const { bootstrapInputFromEnv, bootstrapOrg } = await import("./bootstrap-org");
    const outcome = await bootstrapOrg(bootstrapInputFromEnv());
    log.info("bootstrap done", { event: "init_bootstrap", outcome: outcome.kind });
  } finally {
    // Ending the session releases the advisory lock.
    await lock.end({ timeout: 5 });
  }
}

/** Wait for the lock up to LOCK_WAIT_MS, then name the holder and give up. */
async function acquireLock(sql: postgres.Sql): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let announced = false;
  for (;;) {
    const [r] = await sql<
      { ok: boolean }[]
    >`select pg_try_advisory_lock(hashtext('tmbilling.init')) as ok`;
    if (r?.ok) return;
    if (!announced) {
      log.info("another init holds the lock; waiting", { event: "init_lock_wait" });
      announced = true;
    }
    if (Date.now() > deadline) {
      const holders = await sql<{ pid: number; application_name: string }[]>`
        select a.pid, a.application_name from pg_locks l join pg_stat_activity a using (pid)
         where l.locktype = 'advisory' and l.granted and a.application_name = 'tmbilling-init'`;
      throw new Error(
        `The init lock is still held after ${LOCK_WAIT_MS} ms by ${JSON.stringify(holders)}.`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function ensureRoles(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tmbilling_app') THEN
      CREATE ROLE tmbilling_app NOLOGIN;
    END IF;
  END $$`);
  const password = process.env.APP_DB_PASSWORD;
  if (process.env.TMBILLING_APP_ROLE === "external" || !password) return;
  if (!/^[\x21-\x7e]{16,}$/.test(password)) {
    throw new Error("APP_DB_PASSWORD must be 16 or more printable characters, with no spaces.");
  }
  const literal = `'${password.replace(/'/g, "''")}'`;
  const [exists] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_roles where rolname = 'tmbilling_system'`;
  try {
    await sql.unsafe(
      `${exists?.n ? "ALTER" : "CREATE"} ROLE tmbilling_system WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD ${literal}`,
    );
  } catch (e) {
    // The driver's error carries the statement, and the statement carries the password.
    throw new Error(
      `Could not create or update the tmbilling_system login: ${(e as Error).message}`,
    );
  }
}

async function grantSystemRole(sql: postgres.Sql): Promise<void> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_roles where rolname = 'tmbilling_system'`;
  if (!r?.n) return;
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(join(ROOT, "scripts/sql/system-role.sql"), "utf8"));
    // For the API's and worker's schema check (TMBILLING_REQUIRE_SCHEMA).
    await tx.unsafe(`GRANT USAGE ON SCHEMA drizzle TO tmbilling_system;
      GRANT SELECT ON drizzle.__drizzle_migrations TO tmbilling_system`);
  });
}

/** `scripts/seed-geo.ts`, only when geo.json carries a version the database has not seeded. */
async function loadGeo(sql: postgres.Sql): Promise<void> {
  const data = JSON.parse(readFileSync(join(ROOT, "db/seed-data/geo.json"), "utf8")) as {
    attribution?: { version?: string };
  };
  const version = data.attribution?.version ?? null;
  const [seeded] = await sql<{ v: string | null }[]>`
    select seeded_version as v from reference_data_sources where source = 'dr5hn'`;
  const [countries] = await sql<{ n: number }[]>`select count(*)::int as n from countries`;
  if (version && seeded?.v === version && countries?.n) return;
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-geo.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: ownerUrl },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (run.status !== 0)
    throw new Error(`Loading the geo reference data failed (exit ${run.status}).`);
  log.info("geo reference data loaded", { event: "init_geo_loaded", version });
}

try {
  await main();
  log.info("init complete", { event: "init_complete" });
  await flushCloudLogging();
  process.exit(0);
} catch (e) {
  log.error(e, { event: "init_failed" });
  await flushCloudLogging();
  process.exit(1);
}
