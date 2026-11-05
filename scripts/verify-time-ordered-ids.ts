/**
 * D4.10: new rows get time-ordered ids, so inserts land at the right edge of each index.
 *  - no `public` primary key still defaults to gen_random_uuid() (a new table must use uuid_v7()),
 *  - SQL uuid_v7() is RFC 9562 v7 (version, variant, ms timestamp) and rises with time,
 *  - rows created through the engine get a v7 id and a public id that sorts by creation time
 *    under the database's own collation.
 *
 *   pnpm verify:time-ordered-ids
 */
import { sql } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";

const checks: Array<[string, boolean]> = [];
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const msOf = (u: string) => parseInt(u.replace(/-/g, "").slice(0, 12), 16);

const defaults = (await systemDb.execute(sql`
  select count(*) filter (where column_default = 'gen_random_uuid()')::int random,
         count(*) filter (where column_default = 'uuid_v7()')::int v7
  from information_schema.columns where table_schema = 'public' and column_name = 'id'`)) as unknown as Array<{
  random: number;
  v7: number;
}>;
console.log(
  `public id defaults: ${defaults[0]!.v7} uuid_v7(), ${defaults[0]!.random} gen_random_uuid()`,
);
checks.push(["no public primary key defaults to gen_random_uuid()", defaults[0]!.random === 0]);
checks.push(["primary keys default to uuid_v7()", defaults[0]!.v7 >= 100]);

const rows = (await systemDb.execute(sql`
  select g, uuid_v7()::text u, (extract(epoch from now()) * 1000)::bigint now_ms
  from generate_series(1, 200) g order by g`)) as unknown as Array<{
  g: number;
  u: string;
  now_ms: string;
}>;
const nowMs = Number(rows[0]!.now_ms);
checks.push(["uuid_v7() is version 7, variant 10", rows.every((r) => V7.test(r.u))]);
checks.push([
  "uuid_v7() carries the current ms",
  rows.every((r) => Math.abs(msOf(r.u) - nowMs) < 5_000),
]);
checks.push([
  "uuid_v7() never goes back in time",
  rows.every((r, i) => i === 0 || msOf(r.u) >= msOf(rows[i - 1]!.u)),
]);
checks.push(["uuid_v7() values are distinct", new Set(rows.map((r) => r.u)).size === rows.length]);

const org = await createOrganization({ name: "TimeOrderedIds" });
const orgId = org.organization.id;
const biz = await createBusiness({ organizationId: orgId, name: "Biz", defaultCurrency: "USD" });
const made: Array<{ id: string; publicId: string }> = [];
for (let i = 0; i < 5; i++) {
  made.push(
    await createCustomer({ organizationId: orgId, businessId: biz.id, email: `t${i}@example.com` }),
  );
  await new Promise((r) => setTimeout(r, 3));
}
checks.push([
  "an engine-created row gets a v7 id",
  V7.test(biz.id) && made.every((c) => V7.test(c.id)),
]);
checks.push([
  "public id keeps its shape",
  made.every((c) => /^cus_[0-9a-z]{9}[0-9A-Za-z]{15}$/.test(c.publicId)),
]);
const byPublicId = (await systemDb.execute(sql`
  select id::text from customers where business_id = ${biz.id} order by public_id`)) as unknown as Array<{
  id: string;
}>;
const byId = (await systemDb.execute(sql`
  select id::text from customers where business_id = ${biz.id} order by id`)) as unknown as Array<{
  id: string;
}>;
const created = made.map((c) => c.id).join(",");
console.log(
  `order by public_id ${byPublicId.map((r) => r.id).join(",") === created ? "matches" : "DIFFERS FROM"} creation order`,
);
checks.push([
  "ORDER BY public_id is creation order (database collation)",
  byPublicId.map((r) => r.id).join(",") === created,
]);
checks.push(["ORDER BY id is creation order", byId.map((r) => r.id).join(",") === created]);

let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ TIME-ORDERED IDS: PASS" : "❌ TIME-ORDERED IDS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
