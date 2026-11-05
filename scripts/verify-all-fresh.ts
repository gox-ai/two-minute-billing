/**
 * Run `verify:all` against a THROWAWAY database instead of your dev one.
 *
 * `verify-all.sh` starts with `db:migrate` + **`db:reset`**, which truncates every app
 * table — so running it locally destroys whatever you were looking at, and rotates the
 * dashboard credentials in `.claude/current.md` as a side effect. That footgun is
 * documented in `CLAUDE.md` and has cost real time; this removes it.
 *
 *   pnpm verify:all:fresh                 # create, migrate, verify, drop
 *   pnpm verify:all:fresh -- --keep       # leave the database behind to inspect
 *   pnpm verify:all:fresh -- --shard 1/5  # flags are forwarded to verify-all.sh; a shard
 *                                         # skips gateway-conformance by itself
 *   pnpm verify:all:fresh -- --only gateway-conformance  # the sixth job: that suite alone
 *   pnpm verify:all:fresh -- --system-role   # suites log in as the production app role
 *   pnpm verify:all:fresh -- --suite hubspot-sync  # one suite, same preamble, same throwaway
 *
 * The throwaway URL is passed to the child through its ENVIRONMENT, never through argv
 * or a temp file, so the password does not reach the process list or the disk.
 */
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import postgres from "postgres";

const KEEP_FLAG = "--keep";
const argv = process.argv.slice(2);
const keep = argv.includes(KEEP_FLAG);
const SYSTEM_ROLE_FLAG = "--system-role";
const systemRole = argv.includes(SYSTEM_ROLE_FLAG);
const suiteAt = argv.indexOf("--suite");
const suite = suiteAt >= 0 ? argv[suiteAt + 1] : undefined;
const forwarded = argv.filter(
  (a, i) =>
    a !== KEEP_FLAG &&
    a !== SYSTEM_ROLE_FLAG &&
    (suiteAt < 0 || (i !== suiteAt && i !== suiteAt + 1)),
);
if (suiteAt >= 0 && !suite) {
  console.error("--suite needs a name, e.g. --suite hubspot-sync");
  process.exit(2);
}

// --list touches no database, so it needs neither DATABASE_URL nor a throwaway.
if (argv.includes("--list")) {
  const r = spawnSync("bash", ["scripts/verify-all.sh", ...forwarded], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const source = process.env.DATABASE_URL;
if (!source) {
  console.error("DATABASE_URL is not set — nothing to derive a throwaway database from.");
  process.exit(2);
}

/**
 * `<source db>_verify_<pid>`, so two runs cannot collide and a leftover from a crashed
 * run is identifiable. Postgres identifiers cap at 63 bytes; the slice keeps room.
 */
const url = new URL(source);
const sourceDb = url.pathname.replace(/^\//, "");
const throwaway = `${sourceDb.slice(0, 40)}_verify_${process.pid}`;

/**
 * Admin connection for CREATE/DROP DATABASE, which cannot run against the database
 * being created and cannot run inside a transaction.
 *
 * `postgres` is the conventional maintenance database; falling back to the source one is
 * for clusters where it is absent (some managed providers). Either works — the point is
 * only that it is not `throwaway`.
 */
function adminUrl(db: string): string {
  const u = new URL(source!);
  u.pathname = `/${db}`;
  return u.toString();
}

function childUrl(): string {
  const u = new URL(source!);
  u.pathname = `/${throwaway}`;
  return u.toString();
}

async function withAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const db of ["postgres", sourceDb]) {
    const sql = postgres(adminUrl(db), { max: 1, onnotice: () => {} });
    try {
      return await fn(sql);
    } catch (e) {
      lastError = e;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  }
  throw lastError;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  console.log(`▶ creating throwaway database ${throwaway}`);
  await withAdmin(async (sql) => {
    // `sql.unsafe` because an identifier cannot be a bound parameter. The name is
    // derived from the configured DATABASE_URL and this process's pid, not from input.
    await sql.unsafe(`DROP DATABASE IF EXISTS "${throwaway}"`);
    await sql.unsafe(`CREATE DATABASE "${throwaway}"`);
  });

  // Every step of verify-all.sh reads DATABASE_URL — migrate, reset, geo:seed and each
  // suite — so overriding it here is enough to redirect the whole run. `dotenv` does not
  // overwrite an already-set variable, which is what makes this stick in the children.
  // --system-role: setup runs as the owner (MIGRATION_DATABASE_URL), the suites as the
  // production login from scripts/sql/system-role.sql. The role is cluster-wide; its local
  // password is not a secret.
  let env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: childUrl() };
  if (systemRole) {
    await withAdmin((sql) =>
      sql.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tmbilling_system') THEN
          CREATE ROLE tmbilling_system LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS
            PASSWORD 'tmbilling_system';
        END IF;
      END $$`),
    );
    const app = new URL(childUrl());
    app.username = "tmbilling_system";
    app.password = "tmbilling_system";
    env = { ...env, DATABASE_URL: app.toString(), MIGRATION_DATABASE_URL: childUrl() };
  }
  const owner = { ...env, DATABASE_URL: env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL };
  let code: number;
  if (suite) {
    // verify-all.sh's preamble, then the one suite.
    console.log(`▶ verify:${suite} against ${throwaway} (your dev database is untouched)`);
    code = await run("pnpm", ["db:migrate"], owner);
    if (code === 0) code = await run("pnpm", ["backoffice:migrate"], owner);
    if (code === 0) code = await run("pnpm", ["db:reset"], owner);
    if (code === 0 && systemRole)
      code = await run(
        "pnpm",
        ["tsx", "scripts/lib/apply-sql.ts", "scripts/sql/system-role.sql"],
        owner,
      );
    if (code === 0) code = await run("pnpm", ["geo:seed"], env);
    if (code === 0) code = await run("pnpm", [`verify:${suite}`], env);
  } else {
    console.log(`▶ verify:all against ${throwaway} (your dev database is untouched)`);
    code = await run("bash", ["scripts/verify-all.sh", ...forwarded], env);
  }

  if (keep) {
    console.log(`\n▶ keeping ${throwaway} (--keep). Drop it with:`);
    console.log(
      `  pnpm tsx -e "import postgres from 'postgres'; const s=postgres(process.env.DATABASE_URL!.replace(/\\/[^/]*$/,'/postgres')); await s.unsafe('DROP DATABASE IF EXISTS \\"${throwaway}\\"'); await s.end()"`,
    );
  } else {
    console.log(`\n▶ dropping ${throwaway}`);
    // Terminate stragglers first: a suite that leaked a connection would otherwise make
    // DROP DATABASE fail, leaving a database behind on every run.
    await withAdmin(async (sql) => {
      await sql.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${throwaway}' AND pid <> pg_backend_pid()`,
      );
      await sql.unsafe(`DROP DATABASE IF EXISTS "${throwaway}"`);
    }).catch((e) => {
      // Not fatal: the suite result is what matters, and a stray database is visible and
      // droppable. Swallowing the verify exit code to report a cleanup problem would be
      // the wrong trade.
      console.error(`⚠ could not drop ${throwaway}: ${(e as Error).message}`);
    });
  }

  process.exit(code);
}

void main();
