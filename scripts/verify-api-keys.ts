/**
 * API-key hygiene and the security audit trail, over real HTTP.
 *
 *  - § A last used: written from the auth path, at most once per key per window (B12)
 *  - § B audit rows for key create/revoke, webhook endpoint create/update/delete/rotate and
 *        a CSV export — and never a secret in the row (B13)
 *  - § C expiry: an expired key is refused exactly like a revoked one; expiry at create
 *  - § D rotation with an overlap: same name/mode/scope, old key expires on schedule,
 *        dashboard keys do not rotate, a retry mints nothing
 *
 *   pnpm verify:api-keys
 */
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import {
  createOrganization,
  createApiKey,
  createBusiness,
  markApiKeyUsed,
  writeApiKeyLastUsed,
} from "@/modules/tenancy/service";
import { RAW_DATASETS } from "@/modules/metrics/export/datasets";
import { apiKeys, auditLogs } from "@db/schema";

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");

const org = await createOrganization({ name: `Keys ${uniq}` });
const orgId = org.organization.id;
const biz = await createBusiness({
  organizationId: orgId,
  name: `Keys Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const admin = await createApiKey(orgId, "test", "api", "write", "admin");

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (secret: string, method: Method, url: string, payload?: unknown, idem?: string) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(method !== "GET" ? { "idempotency-key": idem ?? randomBytes(8).toString("hex") } : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const keyRow = async (publicId: string) =>
  (await systemDb.select().from(apiKeys).where(eq(apiKeys.publicId, publicId)).limit(1))[0]!;

/** The fire-and-forget write lands after the response; poll for it. */
async function waitFor(pred: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

const auditRows = (action: string, resourceId: string) =>
  systemDb
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, orgId),
        eq(auditLogs.action, action),
        eq(auditLogs.resourceId, resourceId),
      ),
    );

// ── § A · last used (B12) ─────────────────────────────────────────────────────────
{
  ok("§A a new key has never been used", (await keyRow(admin.apiKey.publicId)).lastUsedAt === null);
  const res = await call(admin.secret, "GET", "/v1/api_keys");
  ok("§A an authenticated request answers 200", res.statusCode === 200);
  ok(
    "§A …and records last_used_at",
    await waitFor(async () => (await keyRow(admin.apiKey.publicId)).lastUsedAt !== null),
  );

  // Inside the window a second request writes nothing, so a busy key costs one UPDATE per window.
  const old = new Date(Date.now() - 10 * 60_000);
  await systemDb
    .update(apiKeys)
    .set({ lastUsedAt: old })
    .where(eq(apiKeys.publicId, admin.apiKey.publicId));
  await call(admin.secret, "GET", "/v1/api_keys");
  await new Promise((r) => setTimeout(r, 300));
  ok(
    "§A a second request inside the window writes nothing (in-process throttle)",
    (await keyRow(admin.apiKey.publicId)).lastUsedAt?.getTime() === old.getTime(),
  );

  // The conditional UPDATE bounds writes across processes, where the in-process throttle cannot.
  ok(
    "§A the write moves a timestamp older than the window",
    await writeApiKeyLastUsed(admin.apiKey.id),
  );
  ok("§A …and refuses one inside it", !(await writeApiKeyLastUsed(admin.apiKey.id)));

  // A failed write must never reach the request: an id the UPDATE cannot even parse.
  let threw = false;
  try {
    markApiKeyUsed("not-a-uuid");
  } catch {
    threw = true;
  }
  await new Promise((r) => setTimeout(r, 300));
  ok("§A a failed last-used write throws nothing (and leaves no unhandled rejection)", !threw);
}

// ── § B · audit rows (B13) ────────────────────────────────────────────────────────
{
  const created = await call(admin.secret, "POST", "/v1/api_keys", { name: "ci", scope: "read" });
  ok("§B create answers 201", created.statusCode === 201);
  const body = created.json() as { id: string; secret: string; prefix: string };
  const [createRow] = await auditRows("api_key.create", body.id);
  ok("§B api_key.create is audited", !!createRow);
  ok("§B …attributed to the calling key", createRow?.actor === admin.apiKey.publicId);
  ok("§B …and carries the prefix", JSON.stringify(createRow?.after ?? null).includes(body.prefix));
  const hashed = (await keyRow(body.id)).hashedKey;
  ok(
    "§B …and never the secret or its hash",
    !JSON.stringify(createRow ?? {}).includes(body.secret) &&
      !JSON.stringify(createRow ?? {}).includes(hashed),
  );

  await call(admin.secret, "POST", `/v1/api_keys/${body.id}/revoke`, {});
  await call(admin.secret, "POST", `/v1/api_keys/${body.id}/revoke`, {});
  ok(
    "§B api_key.revoke is audited once, not per idempotent retry",
    (await auditRows("api_key.revoke", body.id)).length === 1,
  );

  // A literal public IP: the SSRF guard passes it without a DNS lookup.
  const ep = await call(admin.secret, "POST", "/v1/webhook_endpoints", {
    url: "https://93.184.216.34/hook",
  });
  ok("§B webhook endpoint create answers 2xx", ep.statusCode < 300);
  const epBody = ep.json() as { id: string; signing_secret?: string; secret?: string };
  const epSecret = epBody.signing_secret ?? epBody.secret ?? "";
  const [epCreate] = await auditRows("webhook_endpoint.create", epBody.id);
  ok("§B webhook_endpoint.create is audited", !!epCreate);
  ok(
    "§B …without the signing secret",
    epSecret !== "" && !JSON.stringify(epCreate ?? {}).includes(epSecret),
  );

  await call(admin.secret, "PATCH", `/v1/webhook_endpoints/${epBody.id}`, {
    description: "orders",
  });
  const [epUpdate] = await auditRows("webhook_endpoint.update", epBody.id);
  ok(
    "§B webhook_endpoint.update is audited with the changed field",
    JSON.stringify(epUpdate?.after ?? {}).includes("orders"),
  );

  const rot = await call(
    admin.secret,
    "POST",
    `/v1/webhook_endpoints/${epBody.id}/rotate_secret`,
    {},
  );
  const rotSecret = (rot.json() as { signing_secret?: string }).signing_secret ?? "";
  const [epRotate] = await auditRows("webhook_endpoint.rotate_secret", epBody.id);
  ok("§B webhook_endpoint.rotate_secret is audited", !!epRotate);
  ok(
    "§B …without the old or the new secret",
    rotSecret !== "" &&
      !JSON.stringify(epRotate ?? {}).includes(rotSecret) &&
      !JSON.stringify(epRotate ?? {}).includes(epSecret),
  );

  await call(admin.secret, "DELETE", `/v1/webhook_endpoints/${epBody.id}`);
  ok(
    "§B webhook_endpoint.delete is audited",
    (await auditRows("webhook_endpoint.delete", epBody.id)).length === 1,
  );

  const dataset = RAW_DATASETS[0]!.key;
  const csv = await call(
    admin.secret,
    "GET",
    `/v1/businesses/${biz.publicId}/raw_export/${dataset}?format=csv`,
  );
  ok("§B a CSV export answers 200", csv.statusCode === 200);
  ok("§B …and is audited as data.export", (await auditRows("data.export", dataset)).length === 1);
}

// ── § C · expiry ───────────────────────────────────────────────────────────────────
{
  const revoked = await createApiKey(orgId, "test");
  await call(admin.secret, "POST", `/v1/api_keys/${revoked.apiKey.publicId}/revoke`, {});
  const expired = await createApiKey(orgId, "test");
  ok(
    "§C a key works before it expires",
    (await call(expired.secret, "GET", "/v1/api_keys")).statusCode === 200,
  );
  await systemDb
    .update(apiKeys)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(apiKeys.id, expired.apiKey.id));
  const r1 = await call(revoked.secret, "GET", "/v1/api_keys");
  const r2 = await call(expired.secret, "GET", "/v1/api_keys");
  ok("§C an expired key is refused 401", r2.statusCode === 401);
  ok(
    "§C …with the same status and body as a revoked key",
    r1.statusCode === r2.statusCode && r1.body === r2.body,
  );

  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const withExpiry = await call(admin.secret, "POST", "/v1/api_keys", { expires_at: future });
  ok("§C create accepts an expiry", withExpiry.statusCode === 201);
  const wb = withExpiry.json() as { id: string; secret: string; expires_at: string | null };
  ok(
    "§C …and returns it",
    !!wb.expires_at && new Date(wb.expires_at).getTime() === new Date(future).getTime(),
  );
  ok(
    "§C …and the key works until then",
    (await call(wb.secret, "GET", "/v1/api_keys")).statusCode === 200,
  );
  const [wbAudit] = await auditRows("api_key.create", wb.id);
  ok(
    "§C …and the audit row records the expiry",
    JSON.stringify(wbAudit?.after ?? null).includes("expires_at"),
  );
  const past = new Date(Date.now() - 60_000).toISOString();
  ok(
    "§C create refuses an expiry in the past",
    (await call(admin.secret, "POST", "/v1/api_keys", { expires_at: past })).statusCode === 400,
  );
  ok(
    "§C create refuses an expiry that is not a date-time",
    (await call(admin.secret, "POST", "/v1/api_keys", { expires_at: "next week" })).statusCode ===
      400,
  );
  const noExpiry = (await (await call(admin.secret, "POST", "/v1/api_keys", {})).json()) as {
    expires_at: string | null;
  };
  ok("§C a key created without an expiry never expires", noExpiry.expires_at === null);
}

// ── § D · rotation with an overlap ─────────────────────────────────────────────────
{
  const old = await createApiKey(orgId, "test", "api", "read", "billing-sync");
  const idem = randomBytes(8).toString("hex");
  const before = Date.now();
  const res = await call(
    admin.secret,
    "POST",
    `/v1/api_keys/${old.apiKey.publicId}/rotate`,
    { overlap_seconds: 3600 },
    idem,
  );
  ok("§D rotate answers 201", res.statusCode === 201);
  const body = res.json() as {
    id: string;
    secret: string;
    name: string;
    scope: string;
    livemode: string;
    expires_at: string | null;
    previous_key: { id: string; expires_at: string };
  };
  ok("§D the new key is a different key", body.id !== old.apiKey.publicId && !!body.secret);
  ok(
    "§D …with the same name, scope and mode",
    body.name === "billing-sync" && body.scope === "read" && body.livemode === "test",
  );
  ok("§D …and no expiry of its own", body.expires_at === null);
  const oldExp = new Date(body.previous_key.expires_at).getTime();
  ok(
    "§D the old key expires after the overlap (1 hour)",
    oldExp >= before + 3600_000 - 5_000 && oldExp <= Date.now() + 3600_000 + 5_000,
  );
  ok(
    "§D both keys work during the overlap",
    (await call(body.secret, "GET", "/v1/api_keys")).statusCode === 200 &&
      (await call(old.secret, "GET", "/v1/api_keys")).statusCode === 200,
  );

  const [rotRow] = await auditRows("api_key.rotate", old.apiKey.publicId);
  const [newRow] = await auditRows("api_key.create", body.id);
  ok("§D api_key.rotate is audited on the old key", !!rotRow);
  ok("§D …and api_key.create on the new one", !!newRow);
  ok("§D …as one action (same trace)", !!rotRow?.traceId && rotRow.traceId === newRow?.traceId);
  ok("§D …without the new secret", !JSON.stringify([rotRow, newRow]).includes(body.secret));

  // A retry must not mint a second key, and the secret is not replayed.
  const retry = await call(
    admin.secret,
    "POST",
    `/v1/api_keys/${old.apiKey.publicId}/rotate`,
    { overlap_seconds: 3600 },
    idem,
  );
  const named = await systemDb
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, orgId), eq(apiKeys.name, "billing-sync")));
  ok("§D a retry with the same Idempotency-Key mints nothing", named.length === 2);
  ok("§D …and does not replay the secret", !retry.body.includes(body.secret));

  const noIdem = await app.inject({
    method: "POST",
    url: `/v1/api_keys/${body.id}/rotate`,
    headers: { authorization: `Bearer ${admin.secret}` },
    payload: {},
  });
  ok("§D rotate requires an Idempotency-Key", noIdem.statusCode === 400);

  // Overlap 0 stops the old key now; the default is 24 hours; the range is 0 to 7 days.
  const k0 = await createApiKey(orgId, "test");
  const r0 = await call(admin.secret, "POST", `/v1/api_keys/${k0.apiKey.publicId}/rotate`, {
    overlap_seconds: 0,
  });
  ok("§D overlap 0 rotates", r0.statusCode === 201);
  ok(
    "§D …and the old key is refused at once",
    (await call(k0.secret, "GET", "/v1/api_keys")).statusCode === 401,
  );
  const kd = await createApiKey(orgId, "test");
  const rd = (
    await call(admin.secret, "POST", `/v1/api_keys/${kd.apiKey.publicId}/rotate`, {})
  ).json() as { previous_key: { expires_at: string } };
  const dExp = new Date(rd.previous_key.expires_at).getTime() - Date.now();
  ok("§D the default overlap is 24 hours", Math.abs(dExp - 86_400_000) < 60_000);
  const kr = await createApiKey(orgId, "test");
  ok(
    "§D an overlap over 7 days is refused",
    (
      await call(admin.secret, "POST", `/v1/api_keys/${kr.apiKey.publicId}/rotate`, {
        overlap_seconds: 7 * 86_400 + 1,
      })
    ).statusCode === 400,
  );
  ok(
    "§D a negative overlap is refused",
    (
      await call(admin.secret, "POST", `/v1/api_keys/${kr.apiKey.publicId}/rotate`, {
        overlap_seconds: -1,
      })
    ).statusCode === 400,
  );

  // Rotation never lengthens a key's life.
  const soon = await createApiKey(
    orgId,
    "test",
    "api",
    "write",
    null,
    new Date(Date.now() + 600_000),
  );
  const rs = (
    await call(admin.secret, "POST", `/v1/api_keys/${soon.apiKey.publicId}/rotate`, {
      overlap_seconds: 7 * 86_400,
    })
  ).json() as { previous_key: { expires_at: string } };
  ok(
    "§D rotating keeps an earlier existing expiry",
    new Date(rs.previous_key.expires_at).getTime() <= Date.now() + 600_000,
  );

  // A revoked key cannot come back through rotation.
  const kv = await createApiKey(orgId, "test");
  await call(admin.secret, "POST", `/v1/api_keys/${kv.apiKey.publicId}/revoke`, {});
  ok(
    "§D a revoked key does not rotate (400)",
    (await call(admin.secret, "POST", `/v1/api_keys/${kv.apiKey.publicId}/rotate`, {}))
      .statusCode === 400,
  );

  // The dashboard credential is not an integration key: hidden, unrevokable, unrotatable.
  ok(
    "§D the dashboard credential does not rotate (404, like revoke)",
    (await call(admin.secret, "POST", `/v1/api_keys/${org.apiKey.publicId}/rotate`, {}))
      .statusCode === 404,
  );

  // Another organization's key is invisible.
  const other = await createOrganization({ name: `Other ${uniq}` });
  const foreign = await createApiKey(other.organization.id, "test");
  ok(
    "§D another organization's key answers 404",
    (await call(admin.secret, "POST", `/v1/api_keys/${foreign.apiKey.publicId}/rotate`, {}))
      .statusCode === 404,
  );
}

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ API-KEYS: PASS" : "❌ API-KEYS: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
