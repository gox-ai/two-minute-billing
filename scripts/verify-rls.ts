/**
 * Proves RLS isolation: two orgs cannot see or touch each other's rows, even
 * with UNFILTERED queries — Postgres enforces it.
 *
 *   pnpm verify:rls
 */
import { createOrganization, createBusiness, listBusinesses } from "@/modules/tenancy/service";
import { systemDb, withTenant, closeDb } from "@/platform/db";
import { businesses } from "@db/schema";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function count(res: unknown): number {
  const row = (res as Array<{ n: number }>)[0];
  return row ? Number(row.n) : -1;
}

const a = await createOrganization({ name: "Org A" });
const b = await createOrganization({ name: "Org B" });
await createBusiness({ organizationId: a.organization.id, name: "A-biz", defaultCurrency: "USD" });
await createBusiness({ organizationId: b.organization.id, name: "B-biz", defaultCurrency: "INR" });

const aList = await listBusinesses(a.organization.id);
const bList = await listBusinesses(b.organization.id);
console.log(
  "Org A sees:",
  aList.map((x) => x.name),
);
console.log(
  "Org B sees:",
  bList.map((x) => x.name),
);

// Raw UNFILTERED count — RLS must restrict it inside a tenant context.
const aRaw = await withTenant(a.organization.id, (tx) =>
  tx.execute(sql`select count(*)::int as n from businesses`),
);
const adminRaw = await systemDb.execute(sql`select count(*)::int as n from businesses`);
console.log(`Unfiltered count as Org A (RLS):     ${count(aRaw)}`);
console.log(`Unfiltered count as admin (bypass):  ${count(adminRaw)}`);

// Negative test: inserting another org's row must fail the WITH CHECK policy.
let crossInsertBlocked = false;
try {
  await withTenant(a.organization.id, (tx) =>
    tx.insert(businesses).values({
      organizationId: b.organization.id, // mismatch with app.org_id
      publicId: "biz_should_fail",
      name: "cross-tenant",
      defaultCurrency: "USD", // so only the tenant policy can refuse it
    }),
  );
} catch {
  crossInsertBlocked = true;
}
console.log("Cross-tenant insert blocked:", crossInsertBlocked);

// Catalog-driven, so a new table is checked the day it is added.
type CatalogRow = {
  table: string;
  rls: boolean;
  has_org: boolean;
  app_privileged: boolean;
  policies: number;
};
const catalog = (await systemDb.execute(sql`
  select c.relname as table, c.relrowsecurity as rls,
         exists (select 1 from pg_attribute a where a.attrelid = c.oid
                   and a.attname = 'organization_id' and not a.attisdropped) as has_org,
         (has_table_privilege('tmbilling_app', c.oid, 'SELECT')
           or has_table_privilege('tmbilling_app', c.oid, 'INSERT')
           or has_table_privilege('tmbilling_app', c.oid, 'UPDATE')
           or has_table_privilege('tmbilling_app', c.oid, 'DELETE')) as app_privileged,
         (select count(*)::int from pg_policies p
           where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    and not c.relispartition
`)) as unknown as CatalogRow[];

// Partitions are reached through their parent, whose policy applies. A privilege on a child
// would read around it.
const openPartitions = (
  (await systemDb.execute(sql`
    select c.relname as table from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relispartition
      and (has_table_privilege('tmbilling_app', c.oid, 'SELECT')
        or has_table_privilege('tmbilling_app', c.oid, 'INSERT')
        or has_table_privilege('tmbilling_app', c.oid, 'UPDATE')
        or has_table_privilege('tmbilling_app', c.oid, 'DELETE'))
  `)) as unknown as Array<{ table: string }>
).map((r) => r.table);
console.log(
  "App role holds no privilege on a partition:",
  openPartitions.length === 0 ? "YES" : `OPEN: ${openPartitions.join(", ")}`,
);

// 1. Every table carrying an organization_id is filtered by Postgres.
const orgGaps = catalog
  .filter((r) => r.has_org && (!r.rls || r.policies === 0))
  .map((r) => r.table);
console.log(
  `RLS + policy on all ${catalog.filter((r) => r.has_org).length} tables with organization_id:`,
  orgGaps.length === 0 ? "YES" : `MISSING: ${orgGaps.join(", ")}`,
);

// 2. The app role reaches no unfiltered table but global reference data.
const GLOBAL_REFERENCE = new Set(["countries", "model_price_models", "model_prices"]);
const openToApp = catalog
  .filter((r) => r.app_privileged && !r.rls && !GLOBAL_REFERENCE.has(r.table))
  .map((r) => r.table);
console.log(
  "App role holds no privilege on a table without RLS:",
  openToApp.length === 0 ? "YES" : `OPEN: ${openToApp.join(", ")}`,
);

// 3. Every policy checks writes too, and is keyed on the active org (directly, or through
//    `businesses` / `memberships`, which are themselves keyed on it).
const policyRows = (await systemDb.execute(sql`
  select tablename as table, policyname as name, cmd, qual, with_check
  from pg_policies where schemaname = 'public'
`)) as unknown as Array<{
  table: string;
  name: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}>;
const keyed = (e: string | null) => !!e && /app\.org_id|FROM businesses|FROM memberships/.test(e);
const weakPolicies = policyRows
  .filter((p) => p.cmd !== "ALL" || !keyed(p.qual) || !keyed(p.with_check))
  .map((p) => `${p.table}.${p.name}`);
console.log(
  `All ${policyRows.length} policies cover reads and writes, keyed on the org:`,
  weakPolicies.length === 0 ? "YES" : `WEAK: ${weakPolicies.join(", ")}`,
);

// 4. As an org that owns nothing, every table the app role can read is empty — while orgs A
//    and B above own rows in it.
const readable = catalog
  .filter((r) => r.rls && r.app_privileged)
  .map((r) => r.table)
  .sort();
const strangerRows = await withTenant(randomUUID(), async (tx) => {
  const leaks: string[] = [];
  for (const t of readable) {
    const [row] = (await tx.execute(
      sql`select count(*)::int as n from ${sql.identifier(t)}`,
    )) as unknown as Array<{ n: number }>;
    if ((row?.n ?? 0) > 0) leaks.push(`${t}=${row!.n}`);
  }
  return leaks;
});
console.log(
  `A stranger org reads 0 rows from all ${readable.length} readable tables:`,
  strangerRows.length === 0 ? "YES" : `LEAK: ${strangerRows.join(", ")}`,
);

// 5. The app role with no org set sees nothing. On a pooled connection a previous tenant
//    transaction leaves `app.org_id` as '', and the policy's uuid cast refuses the query:
//    also closed.
const unsetCount = await systemDb
  .transaction(async (tx) => {
    await tx.execute(sql`set local role tmbilling_app`);
    return count(await tx.execute(sql`select count(*)::int as n from businesses`));
  })
  .catch((e: { cause?: unknown }) =>
    /invalid input syntax for type uuid/.test(String(e?.cause ?? e)) ? 0 : -1,
  );
console.log("App role with no org set reads 0 businesses:", unsetCount === 0 ? "YES" : unsetCount);

// 6. Code that bypasses RLS is a reviewed list: every production importer of `systemDb` is in the
//    allowlist, and every entry still imports it (the list only shrinks on purpose). A file the
//    published tree withholds (the back-office) is skipped.
const allow = new Set<string>(
  JSON.parse(readFileSync(join(ROOT, "scripts/lib/system-db-allowlist.json"), "utf8")).files,
);
const importers = new Set<string>();
const walk = (dir: string) => {
  if (!existsSync(join(ROOT, dir))) return;
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!["node_modules", ".next", "scripts", "web"].includes(e.name)) walk(rel);
    } else if (
      /\.tsx?$/.test(e.name) &&
      !/\.test\.tsx?$/.test(e.name) &&
      rel !== "src/platform/db.ts"
    ) {
      if (/\bsystemDb\b/.test(readFileSync(join(ROOT, rel), "utf8"))) importers.add(rel);
    }
  }
};
walk("src");
walk("backoffice");
const unlisted = [...importers].filter((f) => !allow.has(f)).sort();
const stale = [...allow].filter((f) => existsSync(join(ROOT, f)) && !importers.has(f)).sort();
console.log(
  `systemDb importers all on the allowlist (${importers.size}):`,
  unlisted.length === 0 ? "YES" : `NOT LISTED: ${unlisted.join(", ")}`,
);
console.log(
  "No stale allowlist entries:",
  stale.length === 0 ? "YES" : `STALE (remove): ${stale.join(", ")}`,
);

// Each business is two rows: its live mode and its test twin.
const pass =
  aList.length === 2 &&
  aList.every((x) => x.name === "A-biz") &&
  bList.length === 2 &&
  bList.every((x) => x.name === "B-biz") &&
  count(aRaw) === 2 &&
  // RLS scopes org A to its own row; admin (bypasses RLS) sees strictly more.
  // Relative (not absolute) so the check is independent of prior DB state.
  count(adminRaw) >= 4 &&
  count(adminRaw) > count(aRaw) &&
  crossInsertBlocked &&
  orgGaps.length === 0 &&
  openToApp.length === 0 &&
  openPartitions.length === 0 &&
  weakPolicies.length === 0 &&
  strangerRows.length === 0 &&
  unsetCount === 0 &&
  unlisted.length === 0 &&
  stale.length === 0;

console.log("");
console.log(pass ? "✅ RLS ISOLATION: PASS" : "❌ RLS ISOLATION: FAIL");

await closeDb();
process.exit(pass ? 0 : 1);
