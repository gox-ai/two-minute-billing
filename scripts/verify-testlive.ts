/**
 * Test/live partition verification (TL-*). The rules that keep a sandbox and a real
 * billing account from touching each other lived only in comments and one app-level
 * check each; this suite is the gate.
 *
 * What it pins:
 *  - API-key partition: a test key only reaches test businesses, a live key only live
 *    ones, and a mismatch is 404 (never 403 — key mode must not leak the other
 *    partition's ids); 'all' reaches both,
 *  - a test/live key can only CREATE businesses of its own mode, and only a
 *    full-access key can mint another one,
 *  - `livemode` is immutable after creation (not patchable over the API),
 *  - a live business cannot hold a TM Test Gateway account; a test business gets one
 *    automatically, and every account's livemode is DERIVED from its business,
 *  - the legacy env-provider fallback (test credentials only) is refused for a live
 *    business — otherwise a real charge silently goes to a sandbox,
 *  - a disabled gateway account refuses to charge, and (0222) a mode-mismatched row
 *    can no longer be created or driven into existence at all — the DB itself refuses
 *    the write, so the "even if a path forgot the rule" case this used to exercise via
 *    a corrupted row is now structurally unreachable rather than merely caught late,
 *  - test-only facilities (sample data, Time Travel) refuse on a live business,
 *  - webhook endpoints are partitioned: an endpoint's `livemode` is derived from its
 *    business (structurally, via a composite FK), fixed at creation, and the outbox
 *    fan-out never crosses it — so a live consumer cannot receive a sandbox business's
 *    Time-Travel-manufactured events (0152),
 *  - gateway accounts get the same structural backstop (0222): the DB itself — not
 *    just app code — refuses a row whose `livemode` disagrees with its business's,
 *  - `livemode='all'` — the single mode-crossing credential — is confined to
 *    `kind='dashboard'` and can no longer be minted over the API (0153),
 *  - every live business has a test mode (0342): createBusiness makes the pair, an older
 *    live business gets its twin on first `test_mode` call (idempotent, a copy of its
 *    settings, independent afterwards), and the DB refuses a twin of a test business, a
 *    second twin, or a live row naming a parent,
 *  - test mode emails only team members, and `test_data` deletion is test-only.
 *
 *   pnpm verify:testlive
 */
import { eq } from "drizzle-orm";
import { buildApp } from "@/index";
import { closeDb, systemDb, withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import {
  createApiKey,
  createBusiness,
  createOrganization,
  ensureTestTwin,
} from "@/modules/tenancy/service";
import { testModeAllows } from "@/modules/emails/test-mode";
import { createGatewayAccount, listGatewayAccounts, GatewayError } from "@/modules/gateway/service";
import { resolveChargeAdapter, type Pm } from "@/modules/invoicing/collection";
import { GatewayRouterError } from "@/modules/gateway/router";
import { emitEvent } from "@/modules/events/emit";
import {
  apiKeys,
  businesses,
  gatewayAccounts,
  memberships,
  users,
  webhookDeliveries,
  webhookEndpoints,
} from "@db/schema";

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const j = (r: { body: string }) => JSON.parse(r.body);
const H = (key: string) => ({ authorization: `Bearer ${key}` });

// ——— Fixtures ———————————————————————————————————————————————————————————————
// One org, both partitions, and a key of each mode.
const { organization, secret: allKey } = await createOrganization({ name: "TL Co" });
const orgId = organization.id;
const liveBiz = await createBusiness({
  organizationId: orgId,
  name: "TL Live",
  defaultCurrency: "USD",
});
const testBiz = await createBusiness({
  organizationId: orgId,
  name: "TL Test",
  defaultCurrency: "USD",
  livemode: "test",
});
// Bare businesses (no gateway accounts) for the env-fallback checks below.
const liveBare = await createBusiness({
  organizationId: orgId,
  name: "TL Live Bare",
  defaultCurrency: "USD",
});
const testBare = await createBusiness({
  organizationId: orgId,
  name: "TL Test Bare",
  defaultCurrency: "USD",
  livemode: "test",
});
const { secret: testKey } = await createApiKey(orgId, "test");
const { secret: liveKey } = await createApiKey(orgId, "live");

checks.push(["createBusiness defaults to live", liveBiz.livemode === "live"]);
checks.push(["createBusiness livemode:test honored", testBiz.livemode === "test"]);
checks.push(["test key prefix is sk_test_", testKey.startsWith("sk_test_")]);
checks.push(["live key prefix is sk_live_", liveKey.startsWith("sk_live_")]);

// ——— 1) Key partition: cross-mode reads are 404, not 403 ————————————————————
const testKeyLiveBiz = await app.inject({
  method: "GET",
  url: `/v1/businesses/${liveBiz.publicId}`,
  headers: H(testKey),
});
checks.push(["test key → live business 404", testKeyLiveBiz.statusCode === 404]);
checks.push([
  "the 404 does not leak that the business exists",
  !JSON.stringify(j(testKeyLiveBiz)).includes("TL Live"),
]);
const liveKeyTestBiz = await app.inject({
  method: "GET",
  url: `/v1/businesses/${testBiz.publicId}`,
  headers: H(liveKey),
});
checks.push(["live key → test business 404", liveKeyTestBiz.statusCode === 404]);

const testKeyOwn = await app.inject({
  method: "GET",
  url: `/v1/businesses/${testBiz.publicId}`,
  headers: H(testKey),
});
checks.push(["test key → test business 200", testKeyOwn.statusCode === 200]);
const liveKeyOwn = await app.inject({
  method: "GET",
  url: `/v1/businesses/${liveBiz.publicId}`,
  headers: H(liveKey),
});
checks.push(["live key → live business 200", liveKeyOwn.statusCode === 200]);
const allKeyBoth = await Promise.all([
  app.inject({ method: "GET", url: `/v1/businesses/${liveBiz.publicId}`, headers: H(allKey) }),
  app.inject({ method: "GET", url: `/v1/businesses/${testBiz.publicId}`, headers: H(allKey) }),
]);
checks.push(["all key reaches both partitions", allKeyBoth.every((r) => r.statusCode === 200)]);

// ——— 2) Lists are mode-scoped ————————————————————————————————————————————————
const ids = (r: { body: string }) => (j(r).data as Array<{ id: string }>).map((b) => b.id);
const testList = ids(
  await app.inject({ method: "GET", url: "/v1/businesses", headers: H(testKey) }),
);
checks.push([
  "test key lists only test businesses",
  testList.includes(testBiz.publicId) && !testList.includes(liveBiz.publicId),
]);
const liveList = ids(
  await app.inject({ method: "GET", url: "/v1/businesses", headers: H(liveKey) }),
);
checks.push([
  "live key lists only live businesses",
  liveList.includes(liveBiz.publicId) && !liveList.includes(testBiz.publicId),
]);

// ——— 3) A key can only create in its own partition ———————————————————————————
const testMakesLive = await app.inject({
  method: "POST",
  url: "/v1/businesses",
  headers: { ...H(testKey), "idempotency-key": crypto.randomUUID() },
  payload: { name: "X", default_currency: "USD", livemode: "live" },
});
checks.push(["test key cannot create a live business", testMakesLive.statusCode === 400]);
const liveMakesTest = await app.inject({
  method: "POST",
  url: "/v1/businesses",
  headers: { ...H(liveKey), "idempotency-key": crypto.randomUUID() },
  payload: { name: "X", default_currency: "USD", livemode: "test" },
});
checks.push(["live key cannot create a test business", liveMakesTest.statusCode === 400]);
const testMakesDefault = await app.inject({
  method: "POST",
  url: "/v1/businesses",
  headers: { ...H(testKey), "idempotency-key": crypto.randomUUID() },
  payload: { name: "TL Implied", default_currency: "USD" },
});
checks.push([
  "test key with no livemode stamps test (never live-by-default)",
  testMakesDefault.statusCode === 201 && j(testMakesDefault).livemode === "test",
]);

// NOBODY mints a full-access key over the API any more — not even a full-access key.
// `sk_all_` is the one credential that spans both partitions (auth.ts:127 skips the
// per-business mode check for it), our dashboard is the only thing that legitimately
// needs that, and 0153's api_keys_mode_kind_ck confines it to kind='dashboard'.
const testMakesAllKey = await app.inject({
  method: "POST",
  url: "/v1/api_keys",
  headers: { ...H(testKey), "idempotency-key": crypto.randomUUID() },
  payload: { livemode: "all" },
});
checks.push(["test key cannot mint an all-mode key", testMakesAllKey.statusCode === 400]);
const allMakesAllKey = await app.inject({
  method: "POST",
  url: "/v1/api_keys",
  headers: { ...H(allKey), "idempotency-key": crypto.randomUUID() },
  payload: { livemode: "all" },
});
checks.push([
  "not even an all key can mint an all-mode key (400, not 500)",
  allMakesAllKey.statusCode === 400,
]);

// ——— 4) livemode is immutable ————————————————————————————————————————————————
await app.inject({
  method: "PATCH",
  url: `/v1/businesses/${liveBiz.publicId}`,
  headers: { ...H(allKey), "idempotency-key": crypto.randomUUID() },
  payload: { livemode: "test" },
});
const afterPatch = await app.inject({
  method: "GET",
  url: `/v1/businesses/${liveBiz.publicId}`,
  headers: H(allKey),
});
checks.push(["livemode not patchable (live stays live)", j(afterPatch).livemode === "live"]);
await app.inject({
  method: "PATCH",
  url: `/v1/businesses/${testBiz.publicId}`,
  headers: { ...H(allKey), "idempotency-key": crypto.randomUUID() },
  payload: { livemode: "live" },
});
const afterPatchTest = await app.inject({
  method: "GET",
  url: `/v1/businesses/${testBiz.publicId}`,
  headers: H(allKey),
});
checks.push(["livemode not patchable (test stays test)", j(afterPatchTest).livemode === "test"]);

// ——— 5) Gateway accounts inherit the business's mode —————————————————————————
const testAccounts = await listGatewayAccounts(orgId, testBiz.id);
const autoTmtest = testAccounts.find((a) => a.gatewayKey === "tmtest");
checks.push(["test business auto-gets a TM Test Gateway", !!autoTmtest]);
checks.push(["auto tmtest account is livemode=false", autoTmtest?.livemode === false]);

let tmtestOnLiveRejected = false;
try {
  await createGatewayAccount({
    organizationId: orgId,
    businessId: liveBiz.id,
    gatewayKey: "tmtest",
    label: "Nope",
    credentials: {},
  });
} catch (e) {
  tmtestOnLiveRejected = e instanceof GatewayError;
}
checks.push(["tmtest rejected on a live business", tmtestOnLiveRejected]);

// livemode is DERIVED from the business, never taken from the caller.
const liveStripe = await createGatewayAccount({
  organizationId: orgId,
  businessId: liveBiz.id,
  gatewayKey: "stripe",
  label: "TL Stripe",
  credentials: { secret_key: "sk_test_tl_dummy" },
});
checks.push(["live business account is livemode=true", liveStripe.livemode === true]);
const testStripe = await createGatewayAccount({
  organizationId: orgId,
  businessId: testBiz.id,
  gatewayKey: "stripe",
  label: "TL Stripe Test",
  credentials: { secret_key: "sk_test_tl_dummy" },
});
checks.push(["test business account is livemode=false", testStripe.livemode === false]);

// The composite FK (business_id, livemode_mode) → businesses(id, livemode) (0222) is
// what makes the derivation structural, the same way 0152 did for webhook_endpoints:
// corrupt the row directly, the way a path that forgot the rule would.
let gatewayFkRejected = false;
try {
  await withTenant(orgId, (tx) =>
    tx.insert(gatewayAccounts).values({
      organizationId: orgId,
      businessId: liveBiz.id,
      publicId: "gwa_tl_corrupt",
      gatewayKey: "stripe",
      label: "Corrupt",
      livemode: false,
      credentialsEnc: "enc_tl",
    }),
  );
} catch {
  gatewayFkRejected = true;
}
checks.push([
  "DB refuses a gateway account whose livemode contradicts its business",
  gatewayFkRejected,
]);

// ——— 6) Charge-time guards ———————————————————————————————————————————————————
// `resolveChargeAdapter` reads exactly three fields off the payment method
// (gatewayAccountId, type, providerKey), so a minimal stand-in exercises the real
// guard without vaulting a card or writing a payment_methods row.
const pmFor = (gatewayAccountId: string | null, providerKey = "stripe") =>
  ({
    gatewayAccountId,
    type: "card",
    providerKey,
    providerCustomerId: "cus_tl",
    providerPaymentMethodId: "pm_tl",
  }) as unknown as Pm;

const routerCode = async (businessId: string, pm: Pm): Promise<string | null> => {
  try {
    await resolveChargeAdapter({ organizationId: orgId, businessId, currency: "USD", pm });
    return null;
  } catch (e) {
    return e instanceof GatewayRouterError ? e.code : `other:${(e as Error).name}`;
  }
};

// 6a) THE FIX: a live business with no gateway account must not fall back to the
// env-configured registry, which holds *_TEST_* credentials only.
checks.push([
  "live business with no gateway account refuses to charge",
  (await routerCode(liveBare.id, pmFor(null))) === "gateway_not_found",
]);
// The mirror: a test business may still take the legacy fallback. Its outcome depends
// on whether env provider keys are set, so assert only that it is NOT the live refusal.
await withTenant(orgId, (tx) =>
  tx.delete(gatewayAccounts).where(eq(gatewayAccounts.businessId, testBare.id)),
);
const testBareCode = await routerCode(testBare.id, pmFor(null));
checks.push([
  "test business fallback not blocked by the live guard",
  testBareCode !== "gateway_not_found",
]);

// 6b) A mode-mismatched account used to be reachable by corrupting a row the way a
// code path that forgot the rule would (S6's original premise) — 0222 makes that
// corruption itself impossible (also checked directly in § 5 above), so confirm THAT
// instead of chasing a state the DB will no longer let this row reach.
let liveStripeCorruptionRejected = false;
try {
  await withTenant(orgId, (tx) =>
    tx
      .update(gatewayAccounts)
      .set({ livemode: false })
      .where(eq(gatewayAccounts.id, liveStripe.id)),
  );
} catch {
  liveStripeCorruptionRejected = true;
}
checks.push([
  "DB refuses to flip a live account to livemode=false (0222)",
  liveStripeCorruptionRejected,
]);
// A disabled account must not charge either (S6) — same guard, adjacent rule, and
// unaffected by 0222 (status is not part of the livemode FK).
await withTenant(orgId, (tx) =>
  tx
    .update(gatewayAccounts)
    .set({ status: "disabled" })
    .where(eq(gatewayAccounts.id, liveStripe.id)),
);
checks.push([
  "disabled account refuses to charge",
  (await routerCode(liveBiz.id, pmFor(liveStripe.id))) === "gateway_disabled",
]);

// ——— 7) Test-only facilities refuse on live —————————————————————————————————
const sampleOnLive = await app.inject({
  method: "POST",
  url: `/v1/businesses/${liveBiz.publicId}/sample_data`,
  headers: { ...H(allKey), "idempotency-key": crypto.randomUUID() },
  payload: {},
});
checks.push(["sample_data refused on a live business", sampleOnLive.statusCode === 400]);

const tmOnLive = await app.inject({
  method: "POST",
  url: `/v1/businesses/${liveBiz.publicId}/time_travel/start`,
  headers: { ...H(allKey), "idempotency-key": crypto.randomUUID() },
  payload: { genesis_time: new Date("2026-01-01T00:00:00.000Z").toISOString() },
});
checks.push(["Time Travel refused on a live business", tmOnLive.statusCode === 400]);

// Time travel is destructive and spans a whole business → all-mode key only.
const tmWithTestKey = await app.inject({
  method: "POST",
  url: `/v1/businesses/${testBiz.publicId}/time_travel/start`,
  headers: { ...H(testKey), "idempotency-key": crypto.randomUUID() },
  payload: { genesis_time: new Date("2026-01-01T00:00:00.000Z").toISOString() },
});
checks.push(["Time Travel requires an all-mode key", tmWithTestKey.statusCode === 403]);

// ——— 8) Webhook endpoints carry a partition (0152) ——————————————————————————
const mkEndpoint = (key: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/v1/webhook_endpoints",
    headers: { ...H(key), "idempotency-key": crypto.randomUUID() },
    payload: body,
  });

// A scoped endpoint's mode is DERIVED from its business, never taken from the caller
// (the same rule gateway accounts follow).
const epTestBiz = await mkEndpoint(allKey, {
  url: "https://tl.test/scoped-test",
  business: testBiz.publicId,
});
checks.push([
  "scoped endpoint derives livemode from its business (test)",
  epTestBiz.statusCode === 201 && j(epTestBiz).livemode === "test",
]);
const epLiveBiz = await mkEndpoint(allKey, {
  url: "https://tl.test/scoped-live",
  business: liveBiz.publicId,
});
checks.push([
  "scoped endpoint derives livemode from its business (live)",
  epLiveBiz.statusCode === 201 && j(epLiveBiz).livemode === "live",
]);
const epContradiction = await mkEndpoint(allKey, {
  url: "https://tl.test/contradiction",
  business: testBiz.publicId,
  livemode: "live",
});
checks.push([
  "a livemode contradicting the business is refused",
  epContradiction.statusCode === 400,
]);

// Org-wide: resolve the mode, never invent one. A test/live key implies it; a
// full-access key implies nothing, so it has to say.
const epImplied = await mkEndpoint(testKey, { url: "https://tl.test/implied" });
checks.push([
  "test key with no livemode stamps a test endpoint (never live-by-default)",
  epImplied.statusCode === 201 && j(epImplied).livemode === "test",
]);
const epAllUnstated = await mkEndpoint(allKey, { url: "https://tl.test/unstated" });
checks.push([
  "org-wide endpoint with a full-access key must state livemode",
  epAllUnstated.statusCode === 400,
]);
const epTestKeyLive = await mkEndpoint(testKey, { url: "https://tl.test/x", livemode: "live" });
checks.push(["test key cannot create a live endpoint", epTestKeyLive.statusCode === 400]);
const epTestKeyLiveBiz = await mkEndpoint(testKey, {
  url: "https://tl.test/y",
  business: liveBiz.publicId,
});
checks.push([
  "test key cannot scope an endpoint to a live business",
  epTestKeyLiveBiz.statusCode === 400,
]);

// The composite FK (business_id, livemode) → businesses(id, livemode) is what makes
// the derivation structural: corrupt the row the way a path that forgot the rule would.
let endpointFkRejected = false;
try {
  await withTenant(orgId, (tx) =>
    tx.insert(webhookEndpoints).values({
      organizationId: orgId,
      businessId: liveBiz.id,
      publicId: "whe_tl_corrupt",
      url: "https://tl.test/corrupt",
      signingSecret: "whsec_tl",
      enabled: "true",
      livemode: "test",
    }),
  );
} catch {
  endpointFkRejected = true;
}
checks.push(["DB refuses an endpoint whose livemode contradicts its business", endpointFkRejected]);

// ——— 9) THE FIX: outbox fan-out never crosses the partition ——————————————————
const orgWideTest = j(
  await mkEndpoint(allKey, { url: "https://tl.test/org-test", livemode: "test" }),
).id as string;
const orgWideLive = j(
  await mkEndpoint(allKey, { url: "https://tl.test/org-live", livemode: "live" }),
).id as string;

const emitOn = (businessId: string | null) =>
  withTenant(orgId, (tx) =>
    emitEvent(tx, {
      organizationId: orgId,
      businessId: businessId ?? undefined,
      type: "customer_created",
      data: { id: "cus_tl_probe" },
    }),
  );

/** Which endpoints the outbox actually fanned this event out to. */
const fannedTo = async (eventId: string): Promise<Set<string>> =>
  withTenant(orgId, async (tx) => {
    const rows = await tx
      .select({ pid: webhookEndpoints.publicId })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(eq(webhookDeliveries.eventId, eventId));
    return new Set(rows.map((r) => r.pid));
  });

const testFan = await fannedTo((await emitOn(testBiz.id)).id);
checks.push(["a test business event reaches a test org-wide endpoint", testFan.has(orgWideTest)]);
checks.push([
  "THE FIX: a test business event never reaches a LIVE org-wide endpoint",
  !testFan.has(orgWideLive),
]);
checks.push([
  "a test business event reaches its own scoped endpoint",
  testFan.has(j(epTestBiz).id),
]);
checks.push([
  "a test business event does not reach a live business's endpoint",
  !testFan.has(j(epLiveBiz).id),
]);

const liveFan = await fannedTo((await emitOn(liveBiz.id)).id);
checks.push(["a live business event reaches a live org-wide endpoint", liveFan.has(orgWideLive)]);
checks.push([
  "a live business event never reaches a TEST org-wide endpoint",
  !liveFan.has(orgWideTest),
]);

// Org-level events have no partition (nothing simulated is org-level), so they stay
// visible to every enabled endpoint — the rule the mode filter had to remain coherent with.
const orgFan = await fannedTo((await emitOn(null)).id);
checks.push([
  "an org-level event still reaches endpoints in BOTH partitions",
  orgFan.has(orgWideTest) && orgFan.has(orgWideLive),
]);

// ——— 10) An endpoint's partition is fixed at creation ————————————————————————
const patchEp = (id: string, body: Record<string, unknown>, key = allKey) =>
  app.inject({
    method: "PATCH",
    url: `/v1/webhook_endpoints/${id}`,
    headers: { ...H(key), "idempotency-key": crypto.randomUUID() },
    payload: body,
  });

const epModePatched = await patchEp(orgWideTest, { livemode: "live" });
const epAfterModePatch = await app.inject({
  method: "GET",
  url: `/v1/webhook_endpoints/${orgWideTest}`,
  headers: H(allKey),
});
checks.push([
  "endpoint livemode is not patchable (refused as an unknown parameter; test stays test)",
  epModePatched.statusCode === 400 &&
    /livemode/.test(epModePatched.body) &&
    j(epAfterModePatch).livemode === "test",
]);
const epCrossRescope = await patchEp(orgWideTest, { business: liveBiz.publicId });
checks.push(["cross-partition re-scope refused", epCrossRescope.statusCode === 400]);
const epSameRescope = await patchEp(orgWideTest, { business: testBiz.publicId });
checks.push([
  "same-partition re-scope allowed",
  epSameRescope.statusCode === 200 && j(epSameRescope).livemode === "test",
]);
// A test credential must not be able to redirect a live endpoint's URL, rotate its
// secret or fire a test POST at the customer's production consumer. 404, not 403 — the
// same non-leaking answer the business partition gives.
const epTestKeyEditsLive = await patchEp(orgWideLive, { url: "https://tl.test/hijack" }, testKey);
checks.push([
  "test key cannot edit a live endpoint (404, not 403)",
  epTestKeyEditsLive.statusCode === 404,
]);
const epTestKeyRotatesLive = await app.inject({
  method: "POST",
  url: `/v1/webhook_endpoints/${orgWideLive}/rotate_secret`,
  headers: { ...H(testKey), "idempotency-key": crypto.randomUUID() },
  payload: {},
});
checks.push([
  "test key cannot rotate a live endpoint's secret",
  epTestKeyRotatesLive.statusCode === 404,
]);
const epTestKeyTestSendsLive = await app.inject({
  method: "POST",
  url: `/v1/webhook_endpoints/${orgWideLive}/test`,
  headers: { ...H(testKey), "idempotency-key": crypto.randomUUID() },
  payload: { type: "customer_created" },
});
checks.push([
  "test key cannot test-send to a live endpoint",
  epTestKeyTestSendsLive.statusCode === 404,
]);

// The endpoint LIST is mode-scoped too — a test key cannot even enumerate the live side.
const epList = (r: { body: string }) => (j(r).data as Array<{ id: string }>).map((e) => e.id);
const testEpList = epList(
  await app.inject({ method: "GET", url: "/v1/webhook_endpoints", headers: H(testKey) }),
);
checks.push([
  "test key lists only test endpoints",
  testEpList.includes(orgWideTest) && !testEpList.includes(orgWideLive),
]);
const allEpList = epList(
  await app.inject({ method: "GET", url: "/v1/webhook_endpoints", headers: H(allKey) }),
);
checks.push([
  "a full-access key lists endpoints in both partitions",
  allEpList.includes(orgWideTest) && allEpList.includes(orgWideLive),
]);

// ——— 11) The mode-crossing credential is confined to the dashboard kind (0153) —
let allApiKeyRejected = false;
try {
  await createApiKey(orgId, "all"); // kind defaults to 'api'
} catch {
  allApiKeyRejected = true;
}
checks.push(["DB refuses kind=api with livemode=all", allApiKeyRejected]);

const orgKeys = await withTenant(orgId, (tx) =>
  tx
    .select({ kind: apiKeys.kind, livemode: apiKeys.livemode })
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, orgId)),
);
checks.push([
  "the org dashboard credential is still all-mode",
  orgKeys.some((k) => k.kind === "dashboard" && k.livemode === "all"),
]);
checks.push([
  "no api-kind key crosses the partition",
  orgKeys.every((k) => k.kind !== "api" || k.livemode !== "all"),
]);

// ——— Test mode of a business (0342) ————————————————————————————————————————————
const liveRow = j(
  await app.inject({
    method: "GET",
    url: `/v1/businesses/${liveBiz.publicId}`,
    headers: H(allKey),
  }),
);
const twinPid: string | null = liveRow.test_business_id;
checks.push(["createBusiness makes a test twin", typeof twinPid === "string"]);
checks.push(["a live business reports no live_business_id", liveRow.live_business_id === null]);
const twinRow = twinPid
  ? j(await app.inject({ method: "GET", url: `/v1/businesses/${twinPid}`, headers: H(allKey) }))
  : {};
checks.push([
  "the twin is test and names its live business",
  twinRow.livemode === "test" && twinRow.live_business_id === liveBiz.publicId,
]);
checks.push([
  "createBusiness livemode:test returns the twin of a new live business",
  !!j(
    await app.inject({
      method: "GET",
      url: `/v1/businesses/${testBiz.publicId}`,
      headers: H(allKey),
    }),
  ).live_business_id,
]);

// A live business from before 0342: no twin until test mode is first opened.
const [older] = await withTenant(orgId, (tx) =>
  tx
    .insert(businesses)
    .values({
      organizationId: orgId,
      publicId: publicId("biz"),
      name: "TL Older",
      livemode: "live",
      defaultCurrency: "INR",
      timezone: "Asia/Kolkata",
      invoicePrefix: "TLO-",
      invoiceNextNumber: 42n,
    })
    .returning(),
);
const openTest = (pid: string, key = allKey) =>
  app.inject({
    method: "POST",
    url: `/v1/businesses/${pid}/test_mode`,
    headers: { ...H(key), "idempotency-key": crypto.randomUUID() },
  });
const first = await openTest(older!.publicId);
const lazy = j(first);
checks.push([
  "test_mode creates the missing twin",
  first.statusCode === 200 && lazy.livemode === "test",
]);
checks.push([
  "the twin copies the live settings",
  lazy.timezone === "Asia/Kolkata" &&
    lazy.invoice_prefix === "TLO-" &&
    lazy.default_currency === "INR" &&
    lazy.name === "TL Older",
]);
checks.push(["the twin's numbering starts at 1", lazy.invoice_next_number === 1]);
const second = j(await openTest(older!.publicId));
checks.push(["test_mode is idempotent (same twin)", second.id === lazy.id]);
const raced = await Promise.all([1, 2, 3].map(() => ensureTestTwin(orgId, older!.id)));
checks.push([
  "concurrent ensureTestTwin returns one twin",
  raced.every((r) => r.publicId === lazy.id),
]);
const lazyGateways = await listGatewayAccounts(orgId, raced[0]!.id);
checks.push([
  "the twin gets exactly one TM Test Gateway",
  lazyGateways.filter((g) => g.gatewayKey === "tmtest").length === 1,
]);
checks.push(["test_mode on a test business is 400", (await openTest(lazy.id)).statusCode === 400]);
checks.push([
  "a test key cannot open test mode of a live business",
  (await openTest(older!.publicId, testKey)).statusCode === 404,
]);
await app.inject({
  method: "PATCH",
  url: `/v1/businesses/${lazy.id}`,
  headers: { ...H(allKey), "idempotency-key": crypto.randomUUID() },
  payload: { name: "TL Older (renamed in test)" },
});
const olderAfter = j(
  await app.inject({ method: "GET", url: `/v1/businesses/${older!.publicId}`, headers: H(allKey) }),
);
checks.push(["a change in test mode does not reach live", olderAfter.name === "TL Older"]);

const refused = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
};
checks.push([
  "DB refuses a second twin",
  await refused(() =>
    withTenant(orgId, (tx) =>
      tx.insert(businesses).values({
        organizationId: orgId,
        publicId: publicId("biz"),
        name: "dup twin",
        defaultCurrency: "USD",
        livemode: "test",
        liveBusinessId: older!.id,
      }),
    ),
  ),
]);
checks.push([
  "DB refuses a twin of a test business",
  await refused(() =>
    withTenant(orgId, (tx) =>
      tx.insert(businesses).values({
        organizationId: orgId,
        publicId: publicId("biz"),
        name: "twin of test",
        defaultCurrency: "USD",
        livemode: "test",
        liveBusinessId: raced[0]!.id,
      }),
    ),
  ),
]);
// A parent with no twin yet, so only the CHECK (not the unique index) can refuse it.
const [lone] = await withTenant(orgId, (tx) =>
  tx
    .insert(businesses)
    .values({
      organizationId: orgId,
      publicId: publicId("biz"),
      name: "TL Lone",
      livemode: "live",
      defaultCurrency: "USD",
    })
    .returning(),
);
checks.push([
  "DB refuses a live row that names a parent",
  await refused(() =>
    withTenant(orgId, (tx) =>
      tx.insert(businesses).values({
        organizationId: orgId,
        publicId: publicId("biz"),
        name: "live with parent",
        defaultCurrency: "USD",
        livemode: "live",
        liveBusinessId: lone!.id,
      }),
    ),
  ),
]);

// Test mode email: team members only.
const memberEmail = `tl-member-${Date.now()}@example.com`;
const [member] = await systemDb
  .insert(users)
  .values({ publicId: publicId("usr"), email: memberEmail })
  .returning();
await withTenant(orgId, (tx) =>
  tx.insert(memberships).values({ organizationId: orgId, userId: member!.id, role: "admin" }),
);
checks.push([
  "test mode refuses a non-member address",
  !(await testModeAllows(raced[0]!, "customer@example.com")),
]);
checks.push([
  "test mode allows a team member (any case)",
  await testModeAllows(raced[0]!, memberEmail.toUpperCase()),
]);
checks.push(["live mode allows any address", await testModeAllows(older!, "customer@example.com")]);

// Delete test data: test-only, all-mode key.
const delTestData = (pid: string, key = allKey) =>
  app.inject({
    method: "DELETE",
    url: `/v1/businesses/${pid}/test_data`,
    headers: { ...H(key), "idempotency-key": crypto.randomUUID() },
  });
checks.push([
  "delete test data refuses a live business",
  (await delTestData(older!.publicId)).statusCode === 400,
]);
checks.push([
  "delete test data needs an all-mode key",
  (await delTestData(lazy.id, testKey)).statusCode === 403,
]);
checks.push([
  "delete test data on a test business is 200",
  (await delTestData(lazy.id)).statusCode === 200,
]);

await app.close();
let pass = true;
for (const [n, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!ok) pass = false;
}
console.log("");
console.log(pass ? "✅ TEST/LIVE PARTITION: PASS" : "❌ TEST/LIVE PARTITION: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
