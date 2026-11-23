/**
 * verify:oss-upgrade — a public install of each earlier release upgrades to the staged one.
 *
 *   pnpm verify:oss-upgrade -- --new <staged public tree> <release tree>...
 *
 * `release:oss` runs it before its push prompt, with the first and the latest public tags.
 * For each earlier tree: install its schema with ITS installer, upgrade with the staged
 * installer, then require the API's schema check to pass and the schema to match a fresh
 * install of the staged tree. Also: a second run changes nothing, and a database older than
 * the floor is refused (so the refusal cannot pass vacuously). Throwaway databases, dropped.
 */
import "dotenv/config";
import { existsSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const at = args.indexOf("--new");
const newRoot = at >= 0 ? resolve(args[at + 1] ?? "") : "";
const fromRoots = args.filter((_, i) => i !== at && i !== at + 1).map((a) => resolve(a));
const source = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!newRoot || !source) {
  console.error("usage: verify:oss-upgrade -- --new <dir> <earlier dir>... (needs DATABASE_URL)");
  process.exit(2);
}

const base = new URL(source).pathname.slice(1).slice(0, 36);
const url = (db: string) => {
  const u = new URL(source);
  u.pathname = `/${db}`;
  return u.toString();
};

interface Installer {
  installSchema(
    url: string,
    root: string,
  ): Promise<{ baselineApplied: { tag: string } | null; migrationsApplied: number }>;
}
interface Checker {
  checkSchema(
    url: string,
    root: string,
  ): Promise<{ current: boolean; applied: number; expected: number }>;
}
/** Each tree runs its OWN installer, as that release's image would; deps come from here. */
async function load(tree: string): Promise<Installer> {
  if (!existsSync(join(tree, "node_modules")))
    symlinkSync(join(root, "node_modules"), join(tree, "node_modules"));
  return import(join(tree, "src/platform/selfhost/schema.ts"));
}

/** Column order is left out: a dropped and re-added column moves, and queries name columns. */
const FINGERPRINT = `
select 'col '||table_schema||'.'||table_name||'.'||column_name||' '||data_type||' '||udt_name||' '||is_nullable||' '||coalesce(column_default,'') from information_schema.columns where table_schema not in ('pg_catalog','information_schema','drizzle')
union all select 'idx '||schemaname||' '||indexdef from pg_indexes where schemaname not in ('pg_catalog','drizzle')
union all select 'con '||c.conrelid::regclass::text||' '||c.conname||' '||pg_get_constraintdef(c.oid) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname not in ('pg_catalog','information_schema','drizzle')
union all select 'pol '||schemaname||'.'||tablename||' '||policyname||' '||cmd||' '||coalesce(qual,'')||' '||coalesce(with_check,'')||' '||array_to_string(roles,',') from pg_policies
union all select 'rls '||relname||' '||relrowsecurity||' '||relforcerowsecurity from pg_class where relkind='r' and relnamespace='public'::regnamespace
union all select 'trg '||pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
union all select 'fn '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') '||md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')
union all select 'view '||schemaname||'.'||viewname||' '||md5(definition) from pg_views where schemaname not in ('pg_catalog','information_schema')
union all select 'enum '||t.typname||' '||string_agg(e.enumlabel,',' order by e.enumsortorder) from pg_enum e join pg_type t on t.oid=e.enumtypid group by t.typname
union all select 'grant '||table_schema||'.'||table_name||' '||grantee||' '||privilege_type from information_schema.role_table_grants where table_schema not in ('pg_catalog','information_schema','drizzle')`;

async function fingerprint(db: string): Promise<Set<string>> {
  const sql = postgres(url(db), { max: 1, onnotice: () => {} });
  try {
    return new Set(
      (await sql.unsafe<{ f: string }[]>(`select f from (${FINGERPRINT}) x(f)`)).map((r) => r.f),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

let fail = 0;
function ok(label: string, cond: boolean, detail?: string) {
  if (!cond) fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail ? `\n    ${detail}` : "");
}

const admin = postgres(url("postgres"), { max: 1, onnotice: () => {} });
const dbs: string[] = [];
async function fresh(name: string): Promise<string> {
  const db = `${base}_upg${name}_${process.pid}`;
  dbs.push(db);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${db}"`);
  await admin.unsafe(`CREATE DATABASE "${db}"`);
  return db;
}

try {
  const next: Installer & Checker = {
    ...(await load(newRoot)),
    ...(await import(join(newRoot, "src/platform/selfhost/schema-check.ts"))),
  };
  const freshDb = await fresh("fresh");
  await next.installSchema(url(freshDb), newRoot);
  const again = await next.installSchema(url(freshDb), newRoot);
  ok("a second run changes nothing", again.migrationsApplied === 0 && !again.baselineApplied);
  const want = await fingerprint(freshDb);

  for (const [i, from] of fromRoots.entries()) {
    const label = from.split("/").pop()!;
    const db = await fresh(String(i));
    await (await load(from)).installSchema(url(db), from);
    const r = await next.installSchema(url(db), newRoot);
    const c = await next.checkSchema(url(db), newRoot);
    ok(
      `${label}: upgraded (${r.migrationsApplied} migrations), schema current`,
      c.current,
      JSON.stringify(c),
    );
    const got = await fingerprint(db);
    const diff = [
      ...[...want].filter((f) => !got.has(f)).map((f) => `missing  ${f}`),
      ...[...got].filter((f) => !want.has(f)).map((f) => `extra    ${f}`),
    ];
    ok(
      `${label}: schema matches a fresh install (${want.size} facts)`,
      diff.length === 0,
      diff.slice(0, 15).join("\n    "),
    );
  }

  // A database recorded just under the floor must be refused, not half-migrated.
  const floor = (await import(join(newRoot, "src/platform/selfhost/schema.ts"))).readJournalFloor?.(
    newRoot,
  );
  ok("the staged journal carries its floor", !!floor);
  if (floor) {
    const old = postgres(url(freshDb), { max: 1, onnotice: () => {} });
    await old`update drizzle.__drizzle_migrations set created_at = ${floor.when - 1}`;
    await old.end({ timeout: 5 });
    const refused = await next.installSchema(url(freshDb), newRoot).then(
      () => "",
      (e: Error) => e.message,
    );
    ok(
      "a database older than the floor is refused",
      /older than/.test(refused),
      refused || "it was not refused",
    );
  }
} finally {
  for (const db of dbs) await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
}
console.log(fail ? `\n${fail} check(s) failed` : "\nall upgrade checks passed");
process.exit(fail ? 1 : 0);
