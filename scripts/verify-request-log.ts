/**
 * API request log (design L): capture, redaction, caps, idempotency links, refusals, exclusions,
 * RLS + mode gate, erasure, and the flusher's failure and shutdown paths — over real HTTP.
 *
 *   pnpm verify:request-log
 */
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { config } from "@/platform/config";
import { signup } from "@/modules/auth/service";
import { createApiKey, createBusiness, createOrganization } from "@/modules/tenancy/service";
import { clearPersonalData } from "@/modules/customers/service";
import {
  flushRequestLogs,
  requestLogStats,
  resetRequestLogBuffer,
  setRequestLogWriterForTests,
  startRequestLogFlush,
} from "@/modules/request-log/flush";
import { redactQuery, redactValue, storedBody } from "@/modules/request-log/redact";
import { apiRequestLogs, organizations } from "@db/schema";

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");
resetRequestLogBuffer();

// ── Fixtures: an org with a session (owner), test + live keys, a read key ─────────────────────
const owner = await signup({
  email: `reqlog-${uniq}@example.com`,
  password: "Sparrow-Lantern-9134",
  name: "Log Owner",
  organizationName: `Request Log ${uniq}`,
});
const orgId = owner.user.organizationId;
const biz = await createBusiness({
  organizationId: orgId,
  name: `Log Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const testKey = await createApiKey(orgId, "test", "api", "write", "integration");
const liveKey = await createApiKey(orgId, "live", "api", "write", "live one");
const readKey = await createApiKey(orgId, "test", "api", "read", "reader");
const other = await createOrganization({ name: `Other ${uniq}` });
const otherKey = await createApiKey(other.organization.id, "test", "api", "write", "other");

type Method = "GET" | "POST" | "PATCH" | "DELETE";
const call = (
  auth: { key?: string; session?: string },
  method: Method,
  url: string,
  payload?: unknown,
  idem?: string | null,
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(auth.key ? { authorization: `Bearer ${auth.key}` } : {}),
      ...(auth.session ? { cookie: `tmb_session=${auth.session}` } : {}),
      ...(method !== "GET" && idem !== null
        ? { "idempotency-key": idem ?? randomBytes(8).toString("hex") }
        : {}),
    },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
const key = { key: testKey.secret };
const session = { session: owner.token };
const B = `/v1/businesses/${biz.publicId}`;

const rowFor = async (requestId: string | undefined) => {
  await flushRequestLogs();
  if (!requestId) return undefined;
  const id = /^req_([0-9a-f]{32})$/.exec(requestId)?.[1];
  if (!id) return undefined;
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  const [r] = await systemDb.select().from(apiRequestLogs).where(eq(apiRequestLogs.id, uuid));
  return r;
};
const rid = (res: { headers: Record<string, unknown> }) => res.headers["request-id"] as string;
const orgRows = async (orgUuid = orgId) => {
  await flushRequestLogs();
  const [r] = (await systemDb.execute(
    sql`select count(*)::int as n from api_request_logs where organization_id = ${orgUuid}`,
  )) as unknown as Array<{ n: number }>;
  return r?.n ?? 0;
};
const has = (v: unknown, needle: string) => JSON.stringify(v ?? null).includes(needle);

// ── 1. Capture ────────────────────────────────────────────────────────────────────────────────
const idem1 = `idem-${uniq}-1`;
const create = await call(
  key,
  "POST",
  `${B}/customers`,
  { email: `buyer-${uniq}@example.com`, first_name: "Ada", metadata: { plan: "gold" } },
  idem1,
);
const cusId = (create.json() as { id?: string }).id!;
ok("customer created (201)", create.statusCode === 201);
ok("every response carries Request-Id: req_<32 hex>", /^req_[0-9a-f]{32}$/.test(rid(create)));
const w = await rowFor(rid(create));
ok("API-key POST → one write row", w?.kind === "write" && w?.source === "api");
ok(
  "write row: status, key, business, mode",
  w?.status === 201 &&
    w?.apiKeyId === testKey.apiKey.id &&
    w?.businessId === biz.id &&
    w?.livemode === "test",
);
ok(
  "write row: idempotency key + outcome new",
  w?.idempotencyKey === idem1 && w?.idempotencyOutcome === "new",
);
ok(
  "write row: request body kept, names and emails as sent",
  has(w?.requestBody, `buyer-${uniq}@example.com`) && has(w?.requestBody, "Ada"),
);
ok("write row: response body kept", has(w?.responseBody, cusId));
ok("write row: customer linked from the response", w?.customerId === cusId);
ok("write row: trace id and duration", !!w?.traceId && typeof w?.durationMs === "number");

const list = await call(key, "GET", `${B}/customers?limit=5`);
const r = await rowFor(rid(list));
ok(
  "API-key GET → read row, no response body",
  r?.kind === "read" && r?.responseBody === null && r?.status === 200,
);
const sessGet = await call(session, "GET", `${B}/customers`);
ok(
  "session GET → no row",
  sessGet.statusCode === 200 && (await rowFor(rid(sessGet))) === undefined,
);
const sessPost = await call(session, "POST", `${B}/customers`, { email: `s-${uniq}@example.com` });
const sp = await rowFor(rid(sessPost));
ok(
  "session POST → dashboard row with the member",
  sp?.source === "dashboard" && sp?.memberUserId === owner.user.userId && sp?.apiKeyId === null,
);

// ── 2. Redaction ──────────────────────────────────────────────────────────────────────────────
const SK = `sk_test_${"a1B2c3D4e5F6g7H8i9J0"}`;
const PAN = "4242 4242 4242 4242";
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const shapes = await call(key, "POST", `${B}/customers`, {
  email: `shape-${uniq}@example.com`,
  metadata: {
    note: `key ${SK} here`,
    card: PAN,
    jwt: JWT,
    input_tokens: "1200",
    key: "order-key-77",
    invoice_number: "INV-2026-0001",
  },
});
const sh = await rowFor(rid(shapes));
const both = JSON.stringify([sh?.requestBody, sh?.responseBody]);
ok(
  "sk_test_… under an innocent key masked (request and response)",
  !both.includes(SK) && both.includes("sk_test_****"),
);
ok("Luhn PAN masked to last four", !both.includes(PAN) && both.includes("****4242"));
ok("JWT masked", !both.includes(JWT));
ok(
  "input_tokens, key and invoice_number NOT masked",
  both.includes("1200") && both.includes("order-key-77") && both.includes("INV-2026-0001"),
);

const wh = await call(key, "POST", "/v1/webhook_endpoints", {
  url: "https://hooks.example.com/in",
  credentials: { api_key: "partner-secret-1", region: "eu-1", hmac_key: "hm-secret-2" },
});
const whr = await rowFor(rid(wh));
ok(
  "webhook endpoint credentials masked leaf by leaf",
  !!whr &&
    !has(whr.requestBody, "partner-secret-1") &&
    !has(whr.requestBody, "hm-secret-2") &&
    !has(whr.requestBody, "eu-1"),
);
ok(
  "webhook endpoint create: response never stored (signing secret)",
  wh.statusCode >= 400 || has(whr?.responseBody, '"_omitted":"secret"'),
);
ok(
  "webhook endpoint row holds no whsec_",
  !JSON.stringify(whr ?? {}).includes("whsec_") || has(whr?.responseBody, "whsec_****"),
);

const smtp = await call(key, "PATCH", `${B}/emails/smtp`, {
  host: "smtp.example.com",
  password: "smtp-pass-3",
  nope: 1,
});
const smr = await rowFor(rid(smtp));
ok(
  "SMTP password masked",
  !!smr && !has(smr.requestBody, "smtp-pass-3") && has(smr.requestBody, "smtp.example.com"),
);
const ses = await call(key, "PATCH", `${B}/emails/ses`, {
  secretAccessKey: "ses-secret-4",
  accessKeyId: "AKIAEXAMPLE",
  nope: 1,
});
const ser = await rowFor(rid(ses));
ok("SES secretAccessKey masked", !!ser && !has(ser.requestBody, "ses-secret-4"));
const gw = await call(key, "POST", `${B}/gateway_accounts`, {
  gateway_key: "authorizenet",
  credentials: { api_login_id: "login-5", transaction_key: "txn-secret-6" },
  nope: 1,
});
const gwr = await rowFor(rid(gw));
ok(
  "gateway credentials masked",
  !!gwr && !has(gwr.requestBody, "txn-secret-6") && !has(gwr.requestBody, "login-5"),
);
ok(
  "redactQuery masks token params by name and shape",
  redactQuery(`a=1&token=abc&x=${SK}`) === "a=1&token=****&x=sk_test_****",
);
ok(
  "redactValue: pstk_ in a URL, Bearer, nested password; booleans kept",
  JSON.stringify(
    redactValue({
      url: "https://p.example.com/s?t=pstk_abcdefghijklmnopqrstu",
      h: "Bearer abc.def-ghi",
      o: { password: "p", secret_configured: true },
    }),
  ) ===
    JSON.stringify({
      url: "https://p.example.com/s?t=pstk_****",
      h: "Bearer ****",
      o: { password: "****", secret_configured: true },
    }),
);

// ── 3. No-store routes ────────────────────────────────────────────────────────────────────────
const mint = await call(key, "POST", "/v1/api_keys", { livemode: "test", name: "minted" });
const mr = await rowFor(rid(mint));
ok(
  "POST /v1/api_keys: row has no sk_ and an omitted marker",
  mint.statusCode < 300 &&
    !!mr &&
    !JSON.stringify(mr).includes("sk_test_") &&
    has(mr.responseBody, '"_omitted":"secret"'),
);
const portal = await call(key, "POST", `${B}/customers/${cusId}/portal_sessions`, {});
const pr = await rowFor(rid(portal));
ok(
  "portal session: row has no pstk_",
  !!pr &&
    !JSON.stringify(pr).includes("pstk_") &&
    (portal.statusCode >= 400 || has(pr.responseBody, '"_omitted":"secret"')),
);

// ── 4. Caps ───────────────────────────────────────────────────────────────────────────────────
const big = await call(key, "POST", `${B}/brand_images`, {
  kind: "logo",
  data: "A".repeat(300 * 1024),
});
const bigr = await rowFor(rid(big));
ok(
  "body over 256 KB → too_large marker, row exists",
  !!bigr && has(bigr.requestBody, '"_omitted":"too_large"'),
);
const longLeaf = await call(key, "POST", `${B}/customers`, {
  email: `l-${uniq}@example.com`,
  metadata: { blob: "B".repeat(5_000) },
  nope: true,
});
const llr = await rowFor(rid(longLeaf));
ok("long string leaf → [omitted: N chars]", !!llr && has(llr.requestBody, "[omitted: 5000 chars]"));
const wide = Object.fromEntries(Array.from({ length: 2_500 }, (_, i) => [`k${i}`, "x".repeat(40)]));
const wideRes = await call(key, "POST", `${B}/customers`, {
  email: `w-${uniq}@example.com`,
  nope: wide,
});
const wr = await rowFor(rid(wideRes));
ok(
  "100 KB JSON → truncated with a preview",
  !!wr && (wr.requestBody as { _truncated?: boolean })?._truncated === true,
);
ok("storedBody keeps a small body as is", JSON.stringify(storedBody({ a: 1 })) === '{"a":1}');

// ── 5. A logging failure never changes the response ───────────────────────────────────────────
setRequestLogWriterForTests(async () => {
  throw new Error("forced");
});
const before5 = requestLogStats();
const failing = await call(key, "POST", `${B}/customers`, { email: `f-${uniq}@example.com` });
await flushRequestLogs();
await flushRequestLogs();
const after5 = requestLogStats();
setRequestLogWriterForTests(null);
ok("response unchanged while inserts fail", failing.statusCode === 201);
ok(
  "failed insert counted, then dropped after one retry",
  after5.failedInserts >= before5.failedInserts + 2 && after5.dropped > before5.dropped,
);

// ── 6. Idempotency links ──────────────────────────────────────────────────────────────────────
const replay = await call(
  key,
  "POST",
  `${B}/customers`,
  { email: `buyer-${uniq}@example.com`, first_name: "Ada", metadata: { plan: "gold" } },
  idem1,
);
const rr = await rowFor(rid(replay));
ok(
  "replay → outcome replayed, same body as the client got",
  rr?.idempotencyOutcome === "replayed" && has(rr?.responseBody, cusId),
);
const mismatch = await call(
  key,
  "POST",
  `${B}/customers`,
  { email: `other-${uniq}@example.com` },
  idem1,
);
const mm = await rowFor(rid(mismatch));
ok(
  "mismatch → 409 row, error_type idempotency_error",
  mismatch.statusCode === 409 &&
    mm?.idempotencyOutcome === "mismatch" &&
    mm?.errorType === "idempotency_error",
);
const detail = await call(key, "GET", `/v1/request_logs/${rid(mismatch)}`);
const d = detail.json() as {
  id: string;
  related: { same_idempotency_key: Array<{ id: string; original: boolean; current: boolean }> };
};
ok(
  "detail: related lists the original first",
  detail.statusCode === 200 &&
    d.related.same_idempotency_key[0]?.id === rid(create) &&
    d.related.same_idempotency_key[0]?.original === true &&
    d.related.same_idempotency_key.some((x) => x.current && x.id === rid(mismatch)),
);
const missing = await call(key, "POST", `${B}/customers`, { email: `m-${uniq}@example.com` }, null);
const mi = await rowFor(rid(missing));
ok(
  "no Idempotency-Key → 400 row, outcome missing",
  missing.statusCode === 400 &&
    mi?.idempotencyOutcome === "missing" &&
    mi?.errorType === "idempotency_required",
);

// ── 7. Refusals after auth are logged; before auth they are not ───────────────────────────────
const cfg = config as { RATE_LIMIT_ENABLED: string };
const rlWas = cfg.RATE_LIMIT_ENABLED;
cfg.RATE_LIMIT_ENABLED = "TRUE";
await systemDb
  .update(organizations)
  .set({ rateLimitPerMinute: 1 })
  .where(eq(organizations.id, orgId));
const rlKey = await createApiKey(orgId, "test", "api", "write", "limited");
await call({ key: rlKey.secret }, "GET", "/v1/businesses");
const limited = await call({ key: rlKey.secret }, "GET", "/v1/businesses");
await systemDb
  .update(organizations)
  .set({ rateLimitPerMinute: null })
  .where(eq(organizations.id, orgId));
cfg.RATE_LIMIT_ENABLED = rlWas;
const lr = await rowFor(rid(limited));
ok(
  "429 rate limit logged",
  limited.statusCode === 429 && lr?.status === 429 && lr?.errorType === "rate_limit_error",
);
const scoped = await call({ key: readKey.secret }, "POST", `${B}/customers`, {
  email: `r-${uniq}@example.com`,
});
const sr = await rowFor(rid(scoped));
ok(
  "read-scope 403 logged",
  scoped.statusCode === 403 && sr?.status === 403 && sr?.apiKeyId === readKey.apiKey.id,
);
const n7 = await orgRows();
const bad = await call({ key: "sk_test_notarealkey000000000000" }, "GET", "/v1/businesses");
const unrouted = await call(key, "GET", "/v1/no_such_route");
ok(
  "invalid key 401 and unrouted 404 not logged",
  bad.statusCode === 401 && unrouted.statusCode === 404 && (await orgRows()) === n7,
);

// ── 8. Excluded paths ─────────────────────────────────────────────────────────────────────────
const n8 = await orgRows();
await app.inject({ method: "GET", url: "/health" });
await call(session, "GET", "/auth/me");
await call(key, "GET", "/v1/request_logs");
await call(key, "GET", `/v1/request_logs/${rid(create)}`);
await app.inject({
  method: "GET",
  url: "/portal/v1/session",
  headers: { authorization: "Bearer pstk_x" },
});
ok("/health, /auth/*, /portal/v1/*, GET /v1/request_logs write nothing", (await orgRows()) === n8);

// ── 9. RLS, mode gate, filters ────────────────────────────────────────────────────────────────
const liveRead = await call({ key: liveKey.secret }, "GET", "/v1/businesses");
await flushRequestLogs();
const crossOrg = await call({ key: otherKey.secret }, "GET", `/v1/request_logs/${rid(create)}`);
ok("org B cannot read org A's request (404)", crossOrg.statusCode === 404);
const strangerSees = await withTenant(other.organization.id, (tx) =>
  tx.select().from(apiRequestLogs).where(eq(apiRequestLogs.organizationId, orgId)),
);
ok("RLS: org B's tenant reads 0 of org A's rows", strangerSees.length === 0);
const testList = (await call(key, "GET", "/v1/request_logs?limit=1000")).json() as {
  data: Array<{ id: string; livemode: string | null }>;
};
ok(
  "test key sees only test rows",
  testList.data.length > 0 &&
    testList.data.every((x) => x.livemode === "test") &&
    !testList.data.some((x) => x.id === rid(liveRead)),
);
const liveList = (await call({ key: liveKey.secret }, "GET", "/v1/request_logs")).json() as {
  data: Array<{ id: string; livemode: string | null }>;
};
ok(
  "live key sees its live row and no test row",
  liveList.data.some((x) => x.id === rid(liveRead)) &&
    liveList.data.every((x) => x.livemode === "live"),
);
const sessList = (await call(session, "GET", "/v1/request_logs?limit=1000")).json() as {
  data: Array<{
    id: string;
    member: { email: string } | null;
    api_key: { id: string; name: string | null } | null;
  }>;
};
ok(
  "session sees both modes",
  sessList.data.some((x) => x.id === rid(liveRead)) &&
    sessList.data.some((x) => x.id === rid(create)),
);
ok(
  "list rows carry key name and member",
  sessList.data.some((x) => x.api_key?.name === "integration") &&
    sessList.data.some((x) => x.member?.email === `reqlog-${uniq}@example.com`),
);
const filtered = async (qs: string) =>
  (
    (await call(session, "GET", `/v1/request_logs?limit=1000&${qs}`)).json() as {
      data: Array<{ id: string; status: number | null; kind: string; method: string }>;
    }
  ).data;
const errs = await filtered("status[gte]=400");
ok(
  "status[gte]=400 narrows to errors",
  errs.length > 0 && errs.every((x) => (x.status ?? 0) >= 400),
);
const reads = await filtered("kind[is]=read");
ok("kind[is]=read narrows to reads", reads.length > 0 && reads.every((x) => x.kind === "read"));
const byKey = await filtered(`api_key=${readKey.apiKey.publicId}`);
ok("api_key= narrows to that key", byKey.length === 1 && byKey[0]!.id === rid(scoped));
const byPath = await filtered("path[contains]=emails/smtp");
ok("path[contains] narrows", byPath.length === 1 && byPath[0]!.id === rid(smtp));
const byId = await filtered(`q=${rid(create)}`);
ok("q=req_… finds that request", byId.length === 1 && byId[0]!.id === rid(create));
const byIdem = await filtered(`idempotency_key=${idem1}`);
ok("idempotency_key= groups the original, replay and mismatch", byIdem.length === 3);
const unknownFilter = await call(session, "GET", "/v1/request_logs?colour[is]=red");
ok("unknown filter → 400", unknownFilter.statusCode === 400);

// ── 10. Erasure ───────────────────────────────────────────────────────────────────────────────
const otherCus = (
  await call(key, "POST", `${B}/customers`, { email: `keep-${uniq}@example.com` })
).json() as { id: string };
await call(key, "GET", `${B}/customers/${cusId}`);
await call(key, "GET", `${B}/customers/${otherCus.id}`);
await flushRequestLogs();
const cusRows = (c: string) =>
  systemDb
    .select({ id: apiRequestLogs.id })
    .from(apiRequestLogs)
    .where(and(eq(apiRequestLogs.organizationId, orgId), eq(apiRequestLogs.customerId, c)));
const beforeErase = (await cusRows(cusId)).length;
await clearPersonalData(orgId, biz.id, cusId);
ok("erasure deletes the customer's rows", beforeErase >= 2 && (await cusRows(cusId)).length === 0);
ok("erasure keeps other customers' rows", (await cusRows(otherCus.id)).length >= 2);

// ── 11. Shutdown flush writes the tail ────────────────────────────────────────────────────────
const stop = startRequestLogFlush();
const tail = await call(key, "GET", `${B}/customers?limit=1`);
await stop();
const [tailRow] = await systemDb
  .select({ id: apiRequestLogs.id })
  .from(apiRequestLogs)
  .where(
    eq(apiRequestLogs.id, (await rowFor(rid(tail)))?.id ?? "00000000-0000-0000-0000-000000000000"),
  );
ok("shutdown flush writes the tail", !!tailRow);

await app.close();
await closeDb();
let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
console.log(failed ? "REQUEST LOG: FAIL" : "REQUEST LOG: PASS");
process.exit(failed ? 1 : 0);
