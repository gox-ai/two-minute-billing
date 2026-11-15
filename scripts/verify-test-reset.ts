/**
 * Reset a test business (POST /v1/businesses/{biz}/test_data/reset).
 *  a a used test business resets to what a new test twin is: same ids, row counts per
 *    business table equal a new twin's, settings equal live's, numbering restarts, a TM Test
 *    Gateway, and the staff test limits stay
 *  b the live business is untouched: every business table's row count and the row itself
 *  c rows a reset keeps (audit log) stay; the reset is audited
 *  d access: a live key is 403, a read key is refused, a live business and a standalone test
 *    business are refused, and a member and the test key still reach the business
 *
 *   pnpm verify:test-reset
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createApiKey, createBusiness, twinSettings } from "@/modules/tenancy/service";
import { RESET_KEEP } from "@/modules/tenancy/reset-test-business";
import { signup, inviteUser, acceptInvite } from "@/modules/auth/service";
import { createCustomer } from "@/modules/customers/service";
import { vaultPaymentMethod } from "@/modules/payment-methods/service";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCoupon } from "@/modules/coupons/service";
import { createSubscription } from "@/modules/subscriptions/service";
import { startTimeTravel, travelForward } from "@/modules/time-travel/service";
import { createEndpoint } from "@/modules/webhooks/endpoints";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import { auditLogs, authTokens, businesses, gatewayAccounts, timeTravels } from "@db/schema";

pinMfaMandateOff();
const js = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
const checks: Array<[string, boolean, string]> = [];
const ok = (n: string, c: boolean, detail: unknown = "") =>
  checks.push([n, c, typeof detail === "string" ? detail : js(detail)]);

// ── fixture ────────────────────────────────────────────────────────────────────
const PW = "Correct-Horse-Battery-9";
const uniq = randomBytes(4).toString("hex");
const em = (r: string) => `test-reset-${r}-${uniq}@example.com`;
const owner = await signup({
  email: em("owner"),
  password: PW,
  organizationName: `Test Reset ${uniq}`,
});
const orgId = owner.user.organizationId;
const live = await createBusiness({
  organizationId: orgId,
  name: "Studio",
  defaultCurrency: "USD",
  timezone: "Asia/Kolkata",
});
const [test] = await withTenant(orgId, (tx) =>
  tx.select().from(businesses).where(eq(businesses.liveBusinessId, live.id)),
);
if (!test) throw new Error("fixture: no test twin");
const S = { organizationId: orgId, businessId: test.id };

// Use the test business: catalog, coupon, webhook endpoint, customers, billing, Time Travel.
const plan = await createProduct({ ...S, name: "Pro", id: "pro", kind: "plan" });
const price = await createPrice({
  ...S,
  productId: plan.id,
  type: "recurring",
  model: "flat",
  currency: "USD",
  amountMinor: 2900,
  interval: "month",
});
await createCoupon({ ...S, code: "WELCOME", kind: "percentage", percentOffBps: 1000 });
await createEndpoint({
  organizationId: orgId,
  businessId: test.id,
  livemode: "test",
  url: "https://example.com/tmb-hooks",
});
const G = new Date("2026-01-01T00:00:00Z");
await startTimeTravel({ orgId, bizId: test.id, genesisTime: G });
for (const n of [1, 2]) {
  const c = await createCustomer({
    ...S,
    email: em(`buyer${n}`),
    autoCollection: "on",
    address: { country: "US" },
  });
  await vaultPaymentMethod({ ...S, customer: c, token: "tok_4242" });
  await createSubscription({
    ...S,
    customerId: c.id,
    now: G,
    items: [{ price, quantity: 1 }],
  });
}
await travelForward({ orgId, bizId: test.id, toTime: new Date(G.getTime() + 40 * 86_400_000) });
// Settings and numbering that differ from a new twin; a staff limit that must stay.
await systemDb
  .update(businesses)
  .set({
    defaultDueDays: 45,
    invoicePrefix: "TST-",
    invoiceNextNumber: 42n,
    teamAlertsConfig: { enabled: true },
    testCustomerLimit: 7,
  })
  .where(eq(businesses.id, test.id));

// A new pair: its twin is the reference for "what a new test twin is".
const fresh = await createBusiness({
  organizationId: orgId,
  name: "Fresh",
  defaultCurrency: "USD",
});
const [freshTwin] = await withTenant(orgId, (tx) =>
  tx.select().from(businesses).where(eq(businesses.liveBusinessId, fresh.id)),
);

/** Rows per business-scoped table (partitions folded into their parent). */
const tableCounts = async (bizId: string) => {
  const tables = (await systemDb.execute(sql`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'business_id' and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
    order by 1`)) as unknown as Array<{ name: string }>;
  const out: Record<string, number> = {};
  for (const { name } of tables) {
    const [r] = (await systemDb.execute(
      sql`select count(*)::int as n from ${sql.identifier(name)} where business_id = ${bizId}::uuid`,
    )) as unknown as Array<{ n: number }>;
    out[name] = r!.n;
  }
  return out;
};
/** The counts a reset must not change for live, or must clear for test: KEEP tables aside. */
const data = (c: Record<string, number>) =>
  js(Object.entries(c).filter(([t]) => !RESET_KEEP.has(t)));
const row = async (id: string) =>
  (await systemDb.select().from(businesses).where(eq(businesses.id, id)))[0]!;

const before = await tableCounts(test.id);
ok(
  "fixture: the test business has customers, invoices, payments, ledger rows and Time Travel",
  before.customers! > 0 &&
    before.invoices! > 0 &&
    before.payments! > 0 &&
    before.ledger_entries! > 0 &&
    before.time_travels! > 0,
  {
    customers: before.customers,
    invoices: before.invoices,
    payments: before.payments,
    ledger: before.ledger_entries,
  },
);
const liveBefore = { counts: await tableCounts(live.id), row: await row(live.id) };

// HTTP
const app = await buildApp({ logger: false });
const { secret: testKey } = await createApiKey(orgId, "test");
const { secret: liveKey } = await createApiKey(orgId, "live");
const { secret: readKey } = await createApiKey(orgId, "test", "api", "read");
type Auth = { cookie?: string; bearer?: string };
const headers = (a: Auth) =>
  a.cookie ? { cookie: `tmb_session=${a.cookie}` } : { authorization: `Bearer ${a.bearer}` };
const reset = (pid: string, a: Auth) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${pid}/test_data/reset`,
    headers: { ...headers(a), "idempotency-key": randomUUID() },
  });
const ALL = { bearer: owner.dashboardKeySecret };

// ── d: refusals, before the reset ──────────────────────────────────────────────
{
  // A live key never sees a test business (404, the partition); on live it is the test-tools 403.
  const r = await reset(test.publicId, { bearer: liveKey });
  const rLive = await reset(live.publicId, { bearer: liveKey });
  ok(
    "d: a live key is refused (404 on test, 403 on live)",
    r.statusCode === 404 && rLive.statusCode === 403,
    {
      test: r.statusCode,
      live: rLive.statusCode,
    },
  );
  const rr = await reset(test.publicId, { bearer: readKey });
  ok("d: a read key is 403", rr.statusCode === 403, rr.statusCode);
  const rl = await reset(live.publicId, ALL);
  ok("d: a live business is refused", rl.statusCode === 400, rl.body);
  // A legacy test business with no live twin.
  const [standalone] = await systemDb
    .insert(businesses)
    .values({
      organizationId: orgId,
      publicId: publicId("biz"),
      name: "Standalone",
      defaultCurrency: "USD",
      livemode: "test",
    })
    .returning();
  const rs = await reset(standalone!.publicId, ALL);
  ok("d: a standalone test business is refused", rs.statusCode === 400, rs.body);
  ok("d: the refusals changed nothing", data(await tableCounts(test.id)) === data(before));
}

// ── a: the reset ───────────────────────────────────────────────────────────────
const res = await reset(test.publicId, { bearer: testKey });
ok("a: reset with a test key is 200", res.statusCode === 200, res.body);
const body = res.json() as { object: string; business: string; deleted: number };
ok(
  "a: the response names the business and the rows deleted",
  body.object === "test_data_reset" && body.business === test.publicId && body.deleted > 0,
  body,
);
const after = await tableCounts(test.id);
const want = await tableCounts(freshTwin!.id);
const differ = Object.keys(after).filter((t) => !RESET_KEEP.has(t) && after[t] !== want[t]);
ok("a: every business table has the rows a new twin has", differ.length === 0, {
  differ: differ.map((t) => `${t}: ${after[t]} vs ${want[t]}`),
});
const r = await row(test.id);
ok("a: the id and public id stay", r.id === test.id && r.publicId === test.publicId);
const settingsLive = twinSettings(liveBefore.row);
const settingsNow = twinSettings(r);
const settingDiff = Object.keys(settingsLive).filter(
  (k) =>
    js(settingsLive[k as keyof typeof settingsLive]) !==
    js(settingsNow[k as keyof typeof settingsNow]),
);
ok("a: the settings equal the live business's", settingDiff.length === 0, settingDiff);
ok(
  "a: numbering and team alerts are a new twin's",
  r.invoiceNextNumber === freshTwin!.invoiceNextNumber &&
    r.creditNoteNextNumber === freshTwin!.creditNoteNextNumber &&
    r.receiptNextNumber === freshTwin!.receiptNextNumber &&
    js(r.teamAlertsConfig) === js(freshTwin!.teamAlertsConfig),
  { inv: r.invoiceNextNumber, alerts: r.teamAlertsConfig },
);
ok("a: the staff test limit stays", r.testCustomerLimit === 7, r.testCustomerLimit);
const gws = await systemDb
  .select()
  .from(gatewayAccounts)
  .where(eq(gatewayAccounts.businessId, test.id));
ok(
  "a: one TM Test Gateway, active",
  gws.length === 1 && gws[0]!.gatewayKey === "tmtest" && gws[0]!.status === "active",
  gws.map((g) => g.gatewayKey),
);
const tt = await systemDb.select().from(timeTravels).where(eq(timeTravels.businessId, test.id));
ok("a: Time Travel is off", tt.length === 0, tt.length);

// ── b: live is untouched ───────────────────────────────────────────────────────
ok(
  "b: every live business table has the same row count",
  data(await tableCounts(live.id)) === data(liveBefore.counts),
);
ok("b: the live business row is unchanged", js(await row(live.id)) === js(liveBefore.row));

// ── c: kept rows and the audit entry ───────────────────────────────────────────
ok(
  "c: audit rows stay",
  after.audit_logs! >= before.audit_logs!,
  `${before.audit_logs} → ${after.audit_logs}`,
);
const audited = await systemDb
  .select()
  .from(auditLogs)
  .where(and(eq(auditLogs.businessId, test.id), eq(auditLogs.action, "business.test_reset")));
ok("c: the reset is in the audit log", audited.length === 1, audited.length);

// ── d: access after the reset ──────────────────────────────────────────────────
{
  const invited = await inviteUser({ organizationId: orgId, email: em("member"), role: "admin" });
  const tok = `invt_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: invited.userId,
    tokenHash: createHash("sha256").update(tok).digest("hex"),
    purpose: "invite",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const member = (await acceptInvite(tok, PW)).token;
  for (const [who, a] of [
    ["the owner", { cookie: owner.token }],
    ["a member", { cookie: member }],
    ["the test key", { bearer: testKey }],
  ] as const) {
    const g = await app.inject({
      method: "GET",
      url: `/v1/businesses/${test.publicId}/customers`,
      headers: headers(a),
    });
    ok(`d: ${who} still reaches the business`, g.statusCode === 200, g.statusCode);
  }
  const again = await reset(test.publicId, { cookie: owner.token });
  ok("d: a reset business can be reset again", again.statusCode === 200, again.body);
}

await app.close();
let failed = 0;
for (const [label, passed, detail] of checks) {
  console.log(
    `${passed ? "  ✓" : "  ✗ FAIL"} ${label}${passed || !detail ? "" : `  — ${detail.slice(0, 600)}`}`,
  );
  if (!passed) failed++;
}
console.log(
  `\n${failed === 0 ? "✅ TEST-RESET: PASS" : `❌ TEST-RESET: FAIL (${failed}/${checks.length})`}`,
);
await closeDb();
process.exit(failed ? 1 : 0);
