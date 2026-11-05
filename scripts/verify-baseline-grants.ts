/**
 * verify:baseline-grants — a database built the public way (db/baseline.sql, its cut
 * record, the newer migrations) grants `tmbilling_app` exactly what the migration chain
 * grants, and passes verify:rls.
 *
 * What it pins:
 *  - same tables, and the same privileges for tmbilling_app and PUBLIC (tables, columns,
 *    sequences, schemas, functions), chain vs baseline install,
 *  - the comparison notices one revoked grant (mutation check, so it cannot pass vacuously),
 *  - verify:rls passes against the baseline install, as a tenant request would.
 *
 *   pnpm verify:baseline-grants
 *
 * Builds two throwaway databases next to DATABASE_URL's and drops them.
 */
import "dotenv/config";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { installSchema } from "@/platform/selfhost/schema";
import { diffMatrix, privilegeMatrix } from "./lib/privilege-matrix";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
const base = new URL(source).pathname.slice(1).slice(0, 36);
const chainDb = `${base}_bgchain_${process.pid}`;
const publicDb = `${base}_bgpub_${process.pid}`;
const at = (db: string) => {
  const u = new URL(source);
  u.pathname = `/${db}`;
  return u.toString();
};

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else fail++;
  console.log(cond ? "✓" : "✗", label, !cond && detail !== undefined ? JSON.stringify(detail) : "");
}

const admin = postgres(at("postgres"), { max: 1, onnotice: () => {} });
const drop = async () => {
  for (const db of [chainDb, publicDb]) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  }
};
await drop();
await admin.unsafe(`CREATE DATABASE "${chainDb}"`);
await admin.unsafe(`CREATE DATABASE "${publicDb}"`);

try {
  execFileSync("pnpm", ["db:migrate"], {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, DATABASE_URL: at(chainDb) },
  });
  const installed = await installSchema(at(publicDb), root);
  ok("the public install applied the baseline", installed.baselineApplied !== null);
  console.log(
    `  baseline cut ${installed.baselineApplied?.tag}, ${installed.migrationsApplied} newer migration(s)`,
  );

  const chain = postgres(at(chainDb), { max: 1, onnotice: () => {} });
  const pub = postgres(at(publicDb), { max: 1, onnotice: () => {} });
  const tables = async (sql: postgres.Sql) =>
    (
      await sql<{ t: string }[]>`
        select table_name as t from information_schema.tables
         where table_schema = 'public' order by 1`
    ).map((r) => r.t);
  const tablesDiff = diffMatrix(await tables(chain), await tables(pub));
  ok("same tables as the chain", !tablesDiff.onlyA.length && !tablesDiff.onlyB.length, tablesDiff);

  const chainGrants = await privilegeMatrix(chain);
  const pubGrants = await privilegeMatrix(pub);
  const d = diffMatrix(chainGrants, pubGrants);
  ok(
    `same privileges for tmbilling_app and PUBLIC (${chainGrants.length} grants)`,
    chainGrants.length > 100 && !d.onlyA.length && !d.onlyB.length,
    { chainOnly: d.onlyA.slice(0, 10), baselineOnly: d.onlyB.slice(0, 10) },
  );

  // Mutation: one lost grant must show up as a difference.
  await pub.unsafe(`REVOKE INSERT ON TABLE public.businesses FROM tmbilling_app`);
  const mutated = diffMatrix(chainGrants, await privilegeMatrix(pub));
  ok(
    "a revoked grant is detected",
    mutated.onlyA.includes("table public.businesses tmbilling_app INSERT"),
    mutated,
  );
  await pub.unsafe(`GRANT INSERT ON TABLE public.businesses TO tmbilling_app`);

  const again = await installSchema(at(publicDb), root);
  ok(
    "a second install is a no-op",
    again.baselineApplied === null && again.migrationsApplied === 0,
    again,
  );
  await chain.end();
  await pub.end();

  const rls = spawnSync("pnpm", ["verify:rls"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: at(publicDb), MIGRATION_DATABASE_URL: at(publicDb) },
  });
  ok("verify:rls passes on the baseline install", rls.status === 0, {
    tail: `${rls.stdout}${rls.stderr}`.trim().split("\n").slice(-5),
  });
} finally {
  await drop();
  await admin.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail ? "❌ BASELINE-GRANTS: FAIL" : "✅ BASELINE-GRANTS: PASS");
process.exit(fail ? 1 : 0);
