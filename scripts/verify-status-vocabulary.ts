/**
 * One outcome vocabulary (0321): `transactions.status` and `invoices.dunning_status` store
 * and return `succeeded` / `failed` / `late_failed`, and every input still accepts the old
 * spellings (`success` / `failure` / `late_failure`) as deprecated aliases.
 *
 *   §1 new values are stored and returned
 *   §2 old values on list filters match the same rows as the new ones (service + HTTP)
 *   §3 reconcile accepts the old verdict words
 *   §4 a saved view and pre-aggregates written before 0321 are rewritten by it, and the
 *      migration is safe to re-run
 *   §5 the compatibility triggers map an old spelling a previous build writes
 *
 *   pnpm verify:status-vocabulary
 */
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import {
  listTransactionsPage,
  recordTransaction,
  setTransactionStatus,
} from "@/modules/transactions/service";
import { listInvoicesPage } from "@/modules/invoicing/service";
import { createListView } from "@/modules/list-views/service";
import { invoices, listViews, metricDaily, transactions } from "@db/schema";
import { ownerSql } from "./lib/owner-sql";

const checks: Array<[string, boolean, string?]> = [];
const ok = (name: string, pass: boolean, detail?: string) => {
  checks.push([name, pass, detail]);
  console.log(`${pass ? "✅" : "❌"} ${name}${!pass && detail ? ` — ${detail}` : ""}`);
};
const OLD = new Set(["success", "failure", "late_failure"]);
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ── seed ──────────────────────────────────────────────────────────────────────────────────
const org = await createOrganization({ name: "Status Vocabulary Org" });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: "Status Vocabulary Biz",
  defaultCurrency: "USD",
  livemode: "test",
});
const customer = await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: "status-vocab@example.com",
});

const txn = (status: "succeeded" | "failed" | "timeout" | "in_progress") =>
  recordTransaction({
    organizationId: orgId,
    businessId: biz.id,
    customerId: customer.id,
    type: "payment",
    status,
    amountMinor: 1_000n,
    currency: "USD",
    gatewayKey: "tmtest",
  });
const ok1 = await txn("succeeded");
const ok2 = await txn("succeeded");
const bad1 = await txn("failed");
const late = await txn("succeeded");
await withTenant(orgId, (tx) => setTransactionStatus(tx, orgId, late.id, "late_failed"));
const pending = await txn("timeout");
const pending2 = await txn("timeout");

let n = 0;
const invoice = (dunningStatus: string | null) =>
  withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(invoices)
      .values({
        organizationId: orgId,
        businessId: biz.id,
        customerId: customer.id,
        publicId: `inv_vocab_${++n}_${Date.now()}`,
        status: dunningStatus === "succeeded" ? "paid" : "payment_due",
        currency: "USD",
        subtotalMinor: 1_000n,
        totalMinor: 1_000n,
        dunningStatus,
      })
      .returning();
    return row!;
  });
const recovered = await invoice("succeeded");
await invoice("in_progress");
await invoice(null);

// ── §1 stored and returned ────────────────────────────────────────────────────────────────
console.log("\n§1 new values are stored and returned");
const stored = await withTenant(orgId, (tx) =>
  tx
    .select({ id: transactions.id, status: transactions.status })
    .from(transactions)
    .where(eq(transactions.businessId, biz.id)),
);
const byId = new Map(stored.map((r) => [r.id, r.status]));
ok("stored: a settled attempt reads succeeded", byId.get(ok1.id) === "succeeded");
ok("stored: a refusal reads failed", byId.get(bad1.id) === "failed");
ok("stored: a reversal reads late_failed", byId.get(late.id) === "late_failed");
ok(
  "stored: no row in the business holds an old spelling",
  stored.every((r) => !OLD.has(r.status)),
);

const app = await buildApp({ logger: false });
const auth = { authorization: `Bearer ${org.secret}` };
const get = async (url: string) => {
  const res = await app.inject({ method: "GET", url, headers: auth });
  return { code: res.statusCode, body: res.json() as any };
};
const txnIds = async (qs: string) => {
  const r = await get(`/v1/businesses/${biz.publicId}/transactions?limit=100&${qs}`);
  return { code: r.code, ids: (r.body.data ?? []).map((t: any) => t.id as string), body: r.body };
};

const all = await txnIds("");
ok("HTTP: the list answers", all.code === 200, JSON.stringify(all.body).slice(0, 200));
ok(
  "HTTP: every returned status is in the new vocabulary",
  (all.body.data ?? []).every((t: any) => !OLD.has(t.status)),
);
ok(
  "HTTP: late_failed is returned as such",
  (all.body.data ?? []).some((t: any) => t.id === late.publicId && t.status === "late_failed"),
);
const invAll = await get(`/v1/businesses/${biz.publicId}/invoices?limit=100`);
ok(
  "HTTP: a recovered invoice returns dunning_status succeeded",
  (invAll.body.data ?? []).some(
    (i: any) => i.id === recovered.publicId && i.dunning_status === "succeeded",
  ),
);

// ── §2 old values on filters ─────────────────────────────────────────────────────────────
console.log("\n§2 old spellings on filters match the same rows");
const svc = async (op: string, value: string) =>
  (
    await listTransactionsPage(orgId, biz.id, {
      limit: 100,
      filters: [{ field: "status", op, value }],
    })
  ).data
    .map((r) => r.txn.publicId)
    .sort();
const pairs: Array<[string, string, string]> = [
  ["is", "success", "succeeded"],
  ["is", "failure", "failed"],
  ["is", "late_failure", "late_failed"],
  ["is", "SUCCESS", "succeeded"],
  ["is_not", "success", "succeeded"],
  ["in", "success,late_failure", "succeeded,late_failed"],
  ["in", "success, failed", "succeeded,failed"],
  ["not_in", "failure,late_failure", "failed,late_failed"],
];
for (const [op, oldV, newV] of pairs) {
  const a = await svc(op, oldV);
  const b = await svc(op, newV);
  ok(`service: status[${op}]=${oldV} ≡ ${newV}`, sameSet(a, b) && a.length > 0, `${a} vs ${b}`);
}
ok(
  "service: the new spelling picks the right rows",
  sameSet(await svc("is", "succeeded"), [ok1.publicId, ok2.publicId]),
);

for (const [qsOld, qsNew] of [
  ["status[is]=success", "status[is]=succeeded"],
  ["status=failure", "status=failed"],
  ["status[in]=success,late_failure", "status[in]=succeeded,late_failed"],
  ["status[not_in]=success", "status[not_in]=succeeded"],
]) {
  const a = await txnIds(qsOld!);
  const b = await txnIds(qsNew!);
  ok(
    `HTTP: ?${qsOld} ≡ ?${qsNew}`,
    a.code === 200 && sameSet(a.ids, b.ids) && a.ids.length > 0,
    `${a.code} ${a.ids} vs ${b.ids}`,
  );
}

const invIds = async (op: string, value: string) =>
  (
    await listInvoicesPage(orgId, biz.id, {
      limit: 100,
      filters: [{ field: "dunning_status", op, value }],
    })
  ).data
    .map((r) => r.invoice.publicId)
    .sort();
ok(
  "service: dunning_status[is]=success ≡ succeeded",
  sameSet(await invIds("is", "success"), await invIds("is", "succeeded")) &&
    (await invIds("is", "succeeded")).length === 1,
);
ok(
  "service: dunning_status[in]=success,in_progress ≡ succeeded,in_progress",
  sameSet(await invIds("in", "success,in_progress"), await invIds("in", "succeeded,in_progress")) &&
    (await invIds("in", "succeeded,in_progress")).length === 2,
);
const invHttp = async (qs: string) =>
  ((await get(`/v1/businesses/${biz.publicId}/invoices?limit=100&${qs}`)).body.data ?? [])
    .map((i: any) => i.id as string)
    .sort();
ok(
  "HTTP: ?dunning_status[is]=success ≡ succeeded",
  sameSet(
    await invHttp("dunning_status[is]=success"),
    await invHttp("dunning_status[is]=succeeded"),
  ) && (await invHttp("dunning_status[is]=succeeded")).includes(recovered.publicId),
);

// ── §3 reconcile ─────────────────────────────────────────────────────────────────────────
console.log("\n§3 reconcile accepts the old verdict words");
const reconcile = async (id: string, outcome: string) => {
  const res = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/reconcile`,
    headers: { ...auth, "idempotency-key": `vocab-${id}-${outcome}-${Date.now()}` },
    payload: { outcome },
  });
  return { code: res.statusCode, body: res.json() as any };
};
const r1 = await reconcile(pending.publicId, "failure");
ok(
  "reconcile: outcome=failure is accepted and stores failed",
  r1.code === 200 && r1.body.status === "failed",
  `${r1.code} ${JSON.stringify(r1.body).slice(0, 200)}`,
);
const r2 = await reconcile(pending2.publicId, "bogus");
ok("reconcile: an unknown outcome is still a 400", r2.code === 400, String(r2.code));
const r3 = await reconcile(pending2.publicId, "failed");
ok("reconcile: the new word still works", r3.code === 200 && r3.body.status === "failed");

// ── §4 saved views + pre-aggregates written before 0321 ──────────────────────────────────
console.log("\n§4 a saved view and pre-aggregates from before 0321");
const OWNER = "status-vocab@example.com";
const [txnView] = await systemDb
  .insert(listViews)
  .values({
    organizationId: orgId,
    businessId: biz.id,
    publicId: `view_vocab_t_${Date.now()}`,
    entity: "transactions",
    name: "Old failures",
    owner: OWNER,
    filters: [
      { field: "status", op: "in", value: "failure, late_failure" },
      { field: "status", op: "is_present", value: "true" },
      { field: "type", op: "is", value: "payment" },
    ],
  })
  .returning();
const [invView] = await systemDb
  .insert(listViews)
  .values({
    organizationId: orgId,
    businessId: biz.id,
    publicId: `view_vocab_i_${Date.now()}`,
    entity: "invoices",
    name: "Old recovered",
    owner: OWNER,
    filters: [{ field: "dunning_status", op: "is", value: "success" }],
  })
  .returning();
// A `status` filter on another list is a different vocabulary and must be left alone.
const [otherView] = await systemDb
  .insert(listViews)
  .values({
    organizationId: orgId,
    businessId: biz.id,
    publicId: `view_vocab_o_${Date.now()}`,
    entity: "payment_intents",
    name: "Unrelated",
    owner: OWNER,
    filters: [{ field: "status", op: "is", value: "success" }],
  })
  .returning();

const beforeView = await svc("in", "failure, late_failure");

const PERIOD = "2026-06-30";
const metric = (dim: string, dimValue: string, value: bigint) => ({
  organizationId: orgId,
  businessId: biz.id,
  grain: "month",
  periodEnd: PERIOD,
  measure: dim === "dunning_status" ? "dunning_invoices" : "payment_attempts",
  dim,
  dimValue,
  currency: "USD",
  value,
});
await systemDb.insert(metricDaily).values([
  metric("transaction_status", "success", 5n),
  metric("transaction_status", "failure", 3n),
  // A collision: the new build already restated this slice — its figure wins.
  metric("transaction_status", "late_failure", 1n),
  metric("transaction_status", "late_failed", 2n),
  metric("dunning_status", "success", 7n),
]);

// Run 0321 twice: once to rewrite, once more to prove a re-run is a no-op.
const migration = readFileSync("db/migrations/0321_status_vocabulary_succeeded.sql", "utf8");
const statements = migration
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);
const owner = ownerSql();
for (let pass = 1; pass <= 2; pass++) {
  let error = "";
  try {
    for (const s of statements) await owner.unsafe(s);
  } catch (e) {
    error = (e as Error).message;
  }
  ok(`migration: pass ${pass} runs cleanly`, error === "", error);
}
await owner.end({ timeout: 5 });

const view = async (id: string) =>
  (await systemDb.select().from(listViews).where(eq(listViews.id, id)))[0]!;
const tv = await view(txnView!.id);
ok(
  "view: a transactions status set is rewritten member by member",
  tv.filters[0]?.value === "failed,late_failed",
  JSON.stringify(tv.filters),
);
ok(
  "view: is_present and other fields are untouched",
  tv.filters[1]?.value === "true" && tv.filters[2]?.value === "payment",
  JSON.stringify(tv.filters),
);
ok(
  "view: the rewritten view lists the same rows it listed before",
  sameSet(await svc(tv.filters[0]!.op, tv.filters[0]!.value), beforeView) && beforeView.length > 0,
);
const iv = await view(invView!.id);
ok(
  "view: an invoices dunning_status filter is rewritten",
  iv.filters[0]?.value === "succeeded",
  JSON.stringify(iv.filters),
);
ok(
  "view: a status filter on another list is left alone",
  (await view(otherView!.id)).filters[0]?.value === "success",
);

const created = await createListView({
  organizationId: orgId,
  businessId: biz.id,
  entity: "transactions",
  name: "Written with old words",
  owner: OWNER,
  filters: [{ field: "status", op: "in", value: "success,failure" }],
});
ok(
  "view: a view saved today with old words is stored in the new spelling",
  created.filters[0]?.value === "succeeded,failed",
  JSON.stringify(created.filters),
);

const metrics = await systemDb
  .select({ dim: metricDaily.dim, v: metricDaily.dimValue, value: metricDaily.value })
  .from(metricDaily)
  .where(and(eq(metricDaily.businessId, biz.id), eq(metricDaily.periodEnd, PERIOD)));
const m = new Map(metrics.map((r) => [`${r.dim}:${r.v}`, r.value]));
ok("metrics: success → succeeded", m.get("transaction_status:succeeded") === 5n);
ok("metrics: failure → failed", m.get("transaction_status:failed") === 3n);
ok(
  "metrics: on a collision the existing new-spelling row wins",
  m.get("transaction_status:late_failed") === 2n,
);
ok("metrics: dunning success → succeeded", m.get("dunning_status:succeeded") === 7n);
ok(
  "metrics: no old spelling survives",
  metrics.every((r) => !OLD.has(r.v)),
  JSON.stringify(metrics.map((r) => r.v)),
);

// ── §5 compatibility triggers ────────────────────────────────────────────────────────────
console.log("\n§5 an old spelling written by a previous build is mapped, not refused");
await systemDb.execute(sql`update transactions set status = 'success' where id = ${bad1.id}`);
const [flipped] = await systemDb
  .select({ status: transactions.status })
  .from(transactions)
  .where(eq(transactions.id, bad1.id));
ok(
  "trigger: a transaction written as success is stored succeeded",
  flipped?.status === "succeeded",
);
await systemDb.execute(
  sql`update invoices set dunning_status = 'success' where id = ${recovered.id}`,
);
const [inv] = await systemDb
  .select({ d: invoices.dunningStatus })
  .from(invoices)
  .where(eq(invoices.id, recovered.id));
ok("trigger: dunning_status written as success is stored succeeded", inv?.d === "succeeded");
let refused = false;
try {
  await systemDb.execute(sql`update transactions set status = 'bogus' where id = ${bad1.id}`);
} catch {
  refused = true;
}
ok("check: a status outside the vocabulary is refused", refused);

await app.close();
await closeDb();

const failed = checks.filter(([, pass]) => !pass);
console.log(
  failed.length === 0
    ? `\n✅ STATUS-VOCABULARY: PASS (${checks.length} checks)`
    : `\n❌ STATUS-VOCABULARY: FAIL (${failed.length} of ${checks.length})`,
);
process.exit(failed.length === 0 ? 0 : 1);
