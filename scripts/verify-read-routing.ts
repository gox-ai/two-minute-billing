/**
 * Report routes run read-only (`onReplica`, platform/db.ts): a write inside one fails loudly,
 * reads keep RLS, and the same code outside the wrapper still writes. With DATABASE_REPLICA_URL
 * unset this runs on the primary, which is the case every suite and dev server sees.
 *
 *   pnpm verify:read-routing
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { closeDb, onReplica, withTenant, withTenantRead } from "@/platform/db";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}
// drizzle wraps the driver error ("Failed query: …"); Postgres's reason is on `cause`.
const errorText = (e: unknown) =>
  `${(e as Error).message} ${((e as Error).cause as Error | undefined)?.message ?? ""}`;
const callRoute = (fn: () => Promise<unknown>) =>
  onReplica(fn)({} as FastifyRequest, {} as FastifyReply);

const a = await createOrganization({ name: "Read routing A" });
const orgB = await createOrganization({ name: "Read routing B" });
const bizA = await createBusiness({
  organizationId: a.organization.id,
  name: "A-biz",
  defaultCurrency: "USD",
});
await createBusiness({
  organizationId: orgB.organization.id,
  name: "B-biz",
  defaultCurrency: "USD",
});
const orgA = a.organization.id;
const touch = (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) =>
  tx.execute(sql`update businesses set name = name where id = ${bizA.id}`);

// 1. A write inside a report route is refused.
let writeError = "";
try {
  await callRoute(() => withTenant(orgA, touch));
} catch (e) {
  writeError = errorText(e);
}
check("write inside onReplica fails", /read-only transaction/.test(writeError), writeError);

// 2. Reads inside it still see only their own organization (B's rows stay hidden).
const seen = (await callRoute(() =>
  withTenant(orgA, (tx) =>
    tx.execute(sql`select count(*) filter (where organization_id <> ${orgA})::int as stranger,
                          count(*)::int as own from businesses`),
  ),
)) as Array<{ stranger: number; own: number }>;
check(
  "RLS still applies on the read path",
  Number(seen[0]?.stranger) === 0 && Number(seen[0]?.own) >= 1,
  `own ${seen[0]?.own}, other org ${seen[0]?.stranger}`,
);

// 3. Transaction options pass through (repeatable read report snapshots).
const level = (await callRoute(() =>
  withTenant(orgA, (tx) => tx.execute(sql`show transaction_isolation`), {
    isolationLevel: "repeatable read",
  }),
)) as Array<{ transaction_isolation: string }>;
check(
  "isolation level is kept",
  level[0]?.transaction_isolation === "repeatable read",
  level[0]?.transaction_isolation,
);

// 4. Outside the wrapper (jobs, write routes) the same call writes as before.
let outsideOk = true;
try {
  await withTenant(orgA, touch);
} catch {
  outsideOk = false;
}
check("write outside onReplica still works", outsideOk);

// 5. withTenantRead on its own is read-only too.
let directError = "";
try {
  await withTenantRead(orgA, touch);
} catch (e) {
  directError = errorText(e);
}
check("withTenantRead is read-only", /read-only transaction/.test(directError), directError);

// 6. The report routes are wrapped (a new report route must be added here and wrapped).
for (const [file, n] of [
  ["src/api/metrics-routes.ts", 10],
  ["src/api/analytics-routes.ts", 2],
] as const) {
  const found = readFileSync(join(ROOT, file), "utf8").split("onReplica(async").length - 1;
  check(`${file} wraps ${n} report handlers`, found === n, `found ${found}`);
}

console.log(failed === 0 ? "\n✅ READ ROUTING: PASS" : `\n❌ READ ROUTING: FAIL (${failed})`);
await closeDb();
process.exit(failed === 0 ? 0 : 1);
