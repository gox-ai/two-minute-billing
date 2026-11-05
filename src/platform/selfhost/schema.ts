/**
 * Install or upgrade the schema the way a public (self-hosted) database gets it:
 * graphile_worker's schema, then `db/baseline.sql` once, then the migrations newer than
 * the baseline's cut. No config import: `init.ts`, `verify:baseline-grants` and the
 * baseline builder call it with an explicit owner URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { Logger, runMigrations } from "graphile-worker";
import postgres from "postgres";

/** The header line the baseline builder writes: `-- baseline-cut: <tag> <when>`. */
export const BASELINE_CUT_PREFIX = "baseline-cut: ";

export interface BaselineCut {
  tag: string;
  /** The cut entry's journal `when`; the migrator applies entries newer than this. */
  when: number;
}

export function parseBaselineCut(text: string): BaselineCut | null {
  const m = new RegExp(`^-- ${BASELINE_CUT_PREFIX}(\\S+) (\\d+)$`, "m").exec(text);
  return m ? { tag: m[1]!, when: Number(m[2]) } : null;
}

/**
 * The baseline runs through the driver, which knows no psql meta-commands. A `\` line would
 * fail mid-file; refuse it up front with the line number instead.
 */
export function assertPlainSql(text: string): void {
  const at = text.split("\n").findIndex((l) => l.startsWith("\\"));
  if (at >= 0) throw new Error(`db/baseline.sql line ${at + 1} is a psql meta-command`);
}

interface JournalEntry {
  tag: string;
  when: number;
}

export function readJournal(root: string): JournalEntry[] | null {
  const path = join(root, "db/migrations/meta/_journal.json");
  if (!existsSync(path)) return null;
  return (JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] }).entries;
}

/** The newest migration this code expects: the later of the baseline cut and the journal. */
export function expectedSchemaWhen(root: string): number {
  const baseline = join(root, "db/baseline.sql");
  const cut = existsSync(baseline) ? parseBaselineCut(readFileSync(baseline, "utf8")) : null;
  const journal = readJournal(root) ?? [];
  return Math.max(cut?.when ?? 0, ...journal.map((e) => e.when));
}

/** The newest migration recorded in the database, or 0 when there is no record. */
export async function appliedSchemaWhen(sql: postgres.Sql): Promise<number> {
  const [t] = await sql<
    { t: string | null }[]
  >`select to_regclass('drizzle.__drizzle_migrations')::text as t`;
  if (!t?.t) return 0;
  const [r] = await sql<
    { w: string | null }[]
  >`select max(created_at)::text as w from drizzle.__drizzle_migrations`;
  return Number(r?.w ?? 0);
}

export interface InstallResult {
  baselineApplied: BaselineCut | null;
  migrationsApplied: number;
}

/**
 * Idempotent. Run it under `withInitLock`: two installs at once would both see an empty
 * database and both apply the baseline.
 */
export async function installSchema(ownerUrl: string, root: string): Promise<InstallResult> {
  // A trigger in the baseline calls graphile_worker.add_job(), so this comes first.
  await runMigrations({ connectionString: ownerUrl, logger: quietGraphileLogger() });

  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  let baselineApplied: BaselineCut | null = null;
  let migrationsApplied = 0;
  try {
    const [hasSchema] = await sql<
      { t: string | null }[]
    >`select to_regclass('public.organizations')::text as t`;
    const before = await countRecorded(sql);
    if (!hasSchema?.t) {
      baselineApplied = await applyBaseline(ownerUrl, root);
    } else if (before === 0 && readJournal(root)?.length) {
      throw new Error(
        "The schema exists but drizzle.__drizzle_migrations is empty, so the migrations " +
          "newer than it cannot be chosen. Record the baseline it was built from first.",
      );
    }
    if (readJournal(root)) {
      await migrate(drizzle(sql), { migrationsFolder: join(root, "db/migrations") });
    }
    migrationsApplied = (await countRecorded(sql)) - before - (baselineApplied ? 1 : 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
  return { baselineApplied, migrationsApplied };
}

async function countRecorded(sql: postgres.Sql): Promise<number> {
  const [t] = await sql<
    { t: string | null }[]
  >`select to_regclass('drizzle.__drizzle_migrations')::text as t`;
  if (!t?.t) return 0;
  const [r] = await sql<
    { n: number }[]
  >`select count(*)::int as n from drizzle.__drizzle_migrations`;
  return r?.n ?? 0;
}

/**
 * The baseline and its record in one transaction, on a connection of its own: the dump
 * empties `search_path` for the session.
 */
async function applyBaseline(ownerUrl: string, root: string): Promise<BaselineCut> {
  const text = readFileSync(join(root, "db/baseline.sql"), "utf8");
  const cut = parseBaselineCut(text);
  if (!cut) throw new Error(`db/baseline.sql has no "-- ${BASELINE_CUT_PREFIX}" line`);
  assertPlainSql(text);
  const conn = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await conn.begin(async (tx) => {
      await tx.unsafe(text);
      // The table drizzle's migrator creates, so it finds the record and starts after it.
      await tx.unsafe(`
        CREATE SCHEMA IF NOT EXISTS "drizzle";
        CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
          id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
        )`);
      await tx.unsafe(
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [`baseline:${cut.tag}`, cut.when],
      );
    });
  } finally {
    await conn.end({ timeout: 5 });
  }
  return cut;
}

/** graphile-worker logs every migration at info; one line from the caller is enough. */
function quietGraphileLogger() {
  return new Logger(() => (level, message) => {
    if (level === "error" || level === "warning") console.error(`[graphile-worker] ${message}`);
  });
}
