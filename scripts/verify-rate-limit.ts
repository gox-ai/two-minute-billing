/**
 * API rate limiting (#6) — the last pure-code go-live blocker from the M1–M14 audit.
 *
 * Driven over REAL HTTP through the built app, because the limit lives in the auth
 * preHandler and the thing being asserted is a response: a status code, a body shape
 * and four headers. A unit test on `consumeRateLimit` alone would pass with the gate
 * unwired, which is the failure mode that matters.
 *
 * Covered:
 *  - § A the ceiling actually refuses, at the right request, with 429 + Retry-After
 *  - § B the allowance is advertised on SUCCESSFUL responses too, and drains
 *  - § C per-KEY counters: one key exhausting its budget does not refuse another key
 *        of the same organization (this is what keeps a runaway script from locking an
 *        operator out of the dashboard)
 *  - § D the per-ORG override beats the deployment default, in both directions
 *  - § E limit 0 blocks the organization outright, without writing counter rows
 *  - § F an unauthenticated request is refused as 401, never 429 — the limiter must not
 *        become an oracle for "is this key real"
 *  - § G the sweep drops spent windows and keeps live ones
 *  - § I each scope counts over the window its policy is stated in, retention covers
 *        the longest of them, and the routes actually declare it
 *  - § H credential scopes fail CLOSED when a counter cannot be written; other scopes
 *        fail OPEN, and every credential scope actually sets the flag
 *  - § J an operator session is metered per USER on its own limit: a teammate keeps their
 *        own allowance, and an org API limit of 0 does not stop the dashboard
 *  - § K each costly route (invite, webhook send, ad hoc email, collect, coupon) refuses
 *        past its own limit on every axis it declares
 *
 *   pnpm verify:rate-limit
 */
import { and, eq, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { buildApp } from "@/index";
import { systemDb, closeDb, withTenant } from "@/platform/db";
import { authTokens, businesses, organizations, rateLimitCounters } from "@db/schema";
import { createOrganization, createApiKey, createBusiness } from "@/modules/tenancy/service";
import { signup, inviteUser, acceptInvite } from "@/modules/auth/service";
import { createEndpoint } from "@/modules/webhooks/endpoints";
import { createProduct, createPrice } from "@/modules/catalog/service";
import { createCheckoutSession } from "@/modules/checkout/service";
import { pinMfaMandateOff } from "./lib/mfa-policy";
import {
  sweepRateLimitCounters,
  windowStartFor,
  consumePublicRateLimit,
  RETENTION_MS,
  AUTH_WINDOW_MS,
  SIGNUP_WINDOW_MS,
} from "@/platform/rate-limit";
import { readFileSync } from "node:fs";
import { config } from "@/platform/config";

pinMfaMandateOff();
const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

/** A cheap authenticated GET — the route is irrelevant, the preHandler is the subject. */
const call = (secret: string) =>
  app.inject({
    method: "GET",
    url: "/v1/businesses",
    headers: { authorization: `Bearer ${secret}` },
  });

async function orgWithLimit(name: string, limit: number | null) {
  const org = await createOrganization({ name });
  const orgId = org.organization.id;
  if (limit !== null) {
    await withTenant(orgId, (tx) =>
      tx
        .update(organizations)
        .set({ rateLimitPerMinute: limit })
        .where(eq(organizations.id, orgId)),
    );
  }
  const { secret } = await createApiKey(orgId, "test");
  return { orgId, secret };
}

const countersFor = async (orgId: string) =>
  systemDb.execute(sql`
    select count(*)::int as n from rate_limit_counters c
    join api_keys k on k.id = c.api_key_id
    where k.organization_id = ${orgId}
  `) as unknown as Promise<Array<{ n: number }>>;

// ── § A · the ceiling refuses ────────────────────────────────────────────────────
// Limit 3: requests 1-3 pass, the 4th is refused. Asserting the exact request that
// flips is the difference between "a limit exists" and "the limit is the number".
{
  const { secret } = await orgWithLimit("RL Ceiling", 3);
  const codes: number[] = [];
  for (let i = 0; i < 4; i++) codes.push((await call(secret)).statusCode);
  ok(
    "§A the first 3 requests are allowed",
    codes.slice(0, 3).every((c) => c === 200),
  );
  ok("§A the 4th is refused with 429", codes[3] === 429);

  const refused = await call(secret);
  const body = JSON.parse(refused.body) as { error?: { type?: string; message?: string } };
  ok("§A refusal carries type rate_limit_error", body.error?.type === "rate_limit_error");
  ok(
    "§A …and names the limit in the message",
    (body.error?.message ?? "").includes("3 requests per minute"),
  );
  // Without Retry-After a client can only guess, and guessing means retrying instantly.
  const retryAfter = Number(refused.headers["retry-after"]);
  ok("§A Retry-After is present and sane (1..60)", retryAfter >= 1 && retryAfter <= 60);
  ok("§A remaining is 0 on a refusal", refused.headers["x-ratelimit-remaining"] === "0");
}

// ── § B · the allowance is visible BEFORE it runs out ───────────────────────────
// Headers on 200s are the whole point of advertising a limit: a client can only back
// off in advance if it can watch the budget drain.
{
  const { secret } = await orgWithLimit("RL Headers", 5);
  const first = await call(secret);
  const second = await call(secret);
  ok("§B limit header states the org ceiling", first.headers["x-ratelimit-limit"] === "5");
  ok(
    "§B remaining drains 4 → 3",
    first.headers["x-ratelimit-remaining"] === "4" &&
      second.headers["x-ratelimit-remaining"] === "3",
  );
  const reset = Number(first.headers["x-ratelimit-reset"]);
  const expected = Math.floor((windowStartFor(new Date()).getTime() + 60_000) / 1000);
  // Equal, or one window on if the two calls straddled a minute boundary.
  ok("§B reset is the end of the current window", reset === expected || reset === expected + 60);
  ok(
    "§B a successful response is not given Retry-After",
    first.headers["retry-after"] === undefined,
  );
}

// ── § C · counters are per KEY, limits are per ORG ──────────────────────────────
// The property that keeps this from being an own-goal: an integration burning its
// budget must not take the operator's dashboard credential down with it.
{
  const { orgId, secret } = await orgWithLimit("RL PerKey", 2);
  const { secret: other } = await createApiKey(orgId, "test");
  ok(
    "§C key A: 2 allowed then refused",
    (await call(secret)).statusCode === 200 &&
      (await call(secret)).statusCode === 200 &&
      (await call(secret)).statusCode === 429,
  );
  // Same organization, same ceiling, its own budget.
  const otherFirst = await call(other);
  ok("§C key B of the SAME org is unaffected", otherFirst.statusCode === 200);
  ok("§C …and gets its own full allowance", otherFirst.headers["x-ratelimit-remaining"] === "1");
}

// ── § D · the per-org override beats the deployment default ────────────────────
{
  // An org with NO override rides the deployment default, which is generous — so a
  // handful of calls must not be refused, and the header must state that number.
  const { secret: dflt } = await orgWithLimit("RL Default", null);
  const r = await call(dflt);
  ok(
    "§D no override → the deployment default is in force",
    r.statusCode === 200 && r.headers["x-ratelimit-limit"] === String(config.RATE_LIMIT_PER_MINUTE),
  );

  // And an override ABOVE the default is honoured too, not just clamped downward.
  const { secret: high } = await orgWithLimit("RL High", config.RATE_LIMIT_PER_MINUTE + 100);
  const rh = await call(high);
  ok(
    "§D an override above the default is honoured",
    rh.headers["x-ratelimit-limit"] === String(config.RATE_LIMIT_PER_MINUTE + 100),
  );
}

// ── § E · limit 0 stops an organization's API traffic ──────────────────────────
// The softer alternative to revoking every key. It must refuse the FIRST request, and
// must not write a counter row per refusal for a blocked org.
{
  const { orgId, secret } = await orgWithLimit("RL Zero", 0);
  const first = await call(secret);
  ok("§E limit 0 refuses the very first request", first.statusCode === 429);
  ok("§E …reporting a limit of 0", first.headers["x-ratelimit-limit"] === "0");
  await call(secret);
  const rows = await countersFor(orgId);
  ok("§E …and writes no counter rows", (rows[0]?.n ?? 0) === 0);
}

// ── § F · the limiter is not an authentication oracle ──────────────────────────
// A bad credential must 401 whatever the traffic looks like. Answering 429 there would
// tell an attacker their key is real, and would let unauthenticated traffic fill a
// counter that belongs to someone.
{
  const bad = await app.inject({
    method: "GET",
    url: "/v1/businesses",
    headers: { authorization: "Bearer sk_test_not_a_real_key" },
  });
  ok("§F an invalid key is 401, not 429", bad.statusCode === 401);
  ok("§F …and carries no rate-limit headers", bad.headers["x-ratelimit-limit"] === undefined);
  const none = await app.inject({ method: "GET", url: "/v1/businesses" });
  ok("§F a missing key is 401", none.statusCode === 401);
}

// ── § G · the sweep drops spent windows and keeps live ones ────────────────────
{
  const { orgId, secret } = await orgWithLimit("RL Sweep", 5);
  await call(secret); // one row in the CURRENT window
  // Derived from RETENTION_MS, not a hardcoded 10 minutes. It WAS ten minutes, which was
  // comfortably outside a two-minute retention — and then per-scope windows pushed retention
  // to two hours (2 × the longest window) and this row stopped being stale at all, so §G
  // quietly asserted nothing until it failed. A test that keeps its own copy of a policy
  // stops testing the policy the moment the policy moves.
  const stale = new Date(windowStartFor(new Date()).getTime() - RETENTION_MS - 60_000);
  // A row from ten windows ago, as an unswept table would accumulate.
  const [key] = (await systemDb.execute(sql`
    select id from api_keys where organization_id = ${orgId} limit 1
  `)) as unknown as Array<{ id: string }>;
  await systemDb
    .insert(rateLimitCounters)
    .values({ apiKeyId: key!.id, windowStart: stale, count: 4 });

  const before = await countersFor(orgId);
  const swept = await sweepRateLimitCounters(new Date());
  const after = await countersFor(orgId);
  const staleGone =
    (
      await systemDb
        .select()
        .from(rateLimitCounters)
        .where(
          and(eq(rateLimitCounters.apiKeyId, key!.id), eq(rateLimitCounters.windowStart, stale)),
        )
    ).length === 0;

  console.log(`§G rows ${before[0]?.n} → ${after[0]?.n}, sweep deleted ${swept.deleted}`);
  ok("§G the spent window is deleted", staleGone && swept.deleted >= 1);
  // Retention is two windows precisely so a sweep cannot delete the window requests
  // are landing in right now.
  ok("§G the CURRENT window survives", (after[0]?.n ?? 0) === 1);
}

// ── § H · credential scopes fail CLOSED, everything else fails OPEN ──────────────
{
  // FAULT INJECTION, no database games. An Invalid Date makes `windowStartFor` produce an
  // Invalid Date too, and `start.toISOString()` then throws a RangeError from inside the
  // counting loop's try — the same catch a dead database reaches, without needing to break
  // one. That keeps this check hermetic on a shared dev DB, where renaming the counters
  // table to force a failure would leave it renamed if the process were killed mid-run.
  const broken = new Date(NaN);
  const keys = [{ kind: "ip" as const, value: "198.51.100.9", limit: 5 }];

  const openRule = await consumePublicRateLimit({ scope: "h_open", keys, now: broken });
  ok("§H a non-credential scope with an unwritable counter is ALLOWED", openRule.allowed);

  const closedRule = await consumePublicRateLimit({
    scope: "h_closed",
    keys,
    failClosed: true,
    now: broken,
  });
  ok("§H a credential scope with an unwritable counter is REFUSED", !closedRule.allowed);

  // The flag has to reach the limiter, not just be accepted at the call site. `helpers.ts`
  // narrowed the rule to `{ scope, keys }` for a long time, and a rule built as a variable
  // rather than a literal would have type-checked while quietly losing the field.
  const CREDENTIAL_SCOPES = [
    "signup",
    "login",
    "change_password",
    "forgot_password",
    "reset_password",
    "accept_invite",
    "google_exchange",
    "portal_exchange",
  ];
  const routeSrc = [
    "src/api/auth-routes.ts",
    "src/api/google-oauth.ts",
    "src/api/customer-portal-routes.ts",
  ]
    .map((f) => readFileSync(new URL("../" + f, import.meta.url).pathname, "utf8"))
    .join("\n");
  const missing = CREDENTIAL_SCOPES.filter((sc) => {
    // Delimit on a scope literal WITH its quote, so only a real rule ends the window.
    // Bare `scope: ` also matches prose — the comment above each flag begins "Credential
    // scope: refuse rather than…", which cut every window short and reported all nine
    // scopes missing while all nine were present.
    //
    // Quote style is deliberately not part of the pattern. `oxfmt` owns formatting here
    // and rewrote these routes to double quotes, at which point every one of these
    // literals stopped matching and the suite again reported all nine scopes missing
    // while all nine were present — the same false alarm, reintroduced by a reformat
    // rather than by a code change. Matching on punctuation is what made it recur.
    const opening = new RegExp(`scope:\\s*["']${sc}["']\\s*,`).exec(routeSrc);
    if (!opening) return true;
    const i = opening.index;
    const nextRule = /scope:\s*["']/g;
    nextRule.lastIndex = i + opening[0].length;
    const following = nextRule.exec(routeSrc);
    const next = following ? following.index : -1;
    return !routeSrc.slice(i, next === -1 ? undefined : next).includes("failClosed: true");
  });
  if (missing.length)
    console.log(`   ↳ credential scopes missing failClosed: ${missing.join(", ")}`);
  ok("§H every credential scope sets failClosed", missing.length === 0);
}

// ── § I · each scope counts over the window its policy is stated in ──────────────
{
  // The counts were never the defect — the UNIT was. 30/IP and 5/email applied to a
  // one-minute window permitted 450 and 75 per fifteen minutes, which is the interval the
  // standard states them in (§3.3, §7.1). Signup is stated in hours instead (§3.1), and
  // shared the per-minute auth limit until now: 1,800 per hour against a policy of 10.
  const now = new Date();

  const auth = await consumePublicRateLimit({
    scope: "i_auth",
    windowMs: AUTH_WINDOW_MS,
    now,
    keys: [{ kind: "ip", value: "198.51.100.21", limit: 5 }],
  });
  ok(
    "§I a credential scope resets on a 15-minute boundary",
    auth.resetAt.getTime() - windowStartFor(now, AUTH_WINDOW_MS).getTime() === AUTH_WINDOW_MS,
  );

  const signup = await consumePublicRateLimit({
    scope: "i_signup",
    windowMs: SIGNUP_WINDOW_MS,
    now,
    keys: [{ kind: "ip", value: "198.51.100.22", limit: 5 }],
  });
  ok(
    "§I the signup scope resets on a 60-minute boundary",
    signup.resetAt.getTime() - windowStartFor(now, SIGNUP_WINDOW_MS).getTime() === SIGNUP_WINDOW_MS,
  );

  // Two scopes with different window lengths must not share a bucket row even on the same
  // address — the window_start differs, which is what keeps them apart with no window id
  // stored anywhere.
  ok(
    "§I windows of different lengths truncate to different starts",
    windowStartFor(now, AUTH_WINDOW_MS).getTime() !==
      windowStartFor(now, SIGNUP_WINDOW_MS).getTime() ||
      now.getTime() % SIGNUP_WINDOW_MS < AUTH_WINDOW_MS,
  );

  // Retention must clear the LONGEST window, or the sweep deletes a live counter and hands
  // the caller a fresh allowance. This is the check that would have caught it.
  ok("§I retention covers the longest window", RETENTION_MS >= 2 * SIGNUP_WINDOW_MS);

  // And the routes must actually declare it. A window that only exists in this file's
  // imagination is the same defect in a new place.
  const CREDENTIAL = [
    "login",
    "change_password",
    "forgot_password",
    "reset_password",
    "accept_invite",
    "google_exchange",
    "portal_exchange",
  ];
  const routeSrc = [
    "src/api/auth-routes.ts",
    "src/api/google-oauth.ts",
    "src/api/customer-portal-routes.ts",
  ]
    .map((f) => readFileSync(new URL("../" + f, import.meta.url).pathname, "utf8"))
    .join("\n");
  // Quote-agnostic for the same reason §H above is: `oxfmt` owns formatting and rewrote
  // these routes to double quotes, at which point every window here came back empty and
  // §I reported all seven credential scopes off the 15-minute window while all seven
  // were on it. Same false alarm, same cause, second call site.
  const ruleFor = (sc: string) => {
    const opening = new RegExp(`scope:\\s*["']${sc}["']\\s*,`).exec(routeSrc);
    if (!opening) return "";
    const nextRule = /scope:\s*["']/g;
    nextRule.lastIndex = opening.index + opening[0].length;
    const following = nextRule.exec(routeSrc);
    return routeSrc.slice(opening.index, following ? following.index : undefined);
  };
  const wrongWindow = CREDENTIAL.filter((sc) => !ruleFor(sc).includes("windowMs: AUTH_WINDOW_MS"));
  if (wrongWindow.length)
    console.log(`   ↳ not on the 15-minute window: ${wrongWindow.join(", ")}`);
  ok("§I every credential scope declares AUTH_WINDOW_MS", wrongWindow.length === 0);
  ok(
    "§I signup declares SIGNUP_WINDOW_MS",
    ruleFor("signup").includes("windowMs: SIGNUP_WINDOW_MS"),
  );
  ok(
    "§I signup counts on its own per-IP limit",
    ruleFor("signup").includes("limit: config.RATE_LIMIT_SIGNUP_PER_IP"),
  );

  // The numbers adopted from the standard as written. RATE_LIMIT_AUTH_PER_IP is
  // deliberately NOT asserted at 10 — see the deviation recorded on it in config.ts.
  ok("§I per-email matches the standard (5)", config.RATE_LIMIT_AUTH_PER_EMAIL === 5);
  ok(
    "§I signups per IP per hour matches the standard (10)",
    config.RATE_LIMIT_SIGNUP_PER_IP === 10,
  );
}

/** Wait out the last 10s of a window, so a sequence of calls cannot straddle a reset. */
async function clearOfBoundary(windowMs = 60_000) {
  const into = Date.now() % windowMs;
  if (into > windowMs - 10_000) await new Promise((r) => setTimeout(r, windowMs - into + 50));
}

const PW = "Correct-Horse-Battery-9";
const uniq = randomBytes(4).toString("hex");
async function memberSession(orgId: string, email: string, role: string) {
  const invited = await inviteUser({ organizationId: orgId, email, role });
  const tok = `invt_${randomBytes(32).toString("base64url")}`;
  await systemDb.insert(authTokens).values({
    userId: invited.userId,
    tokenHash: createHash("sha256").update(tok).digest("hex"),
    purpose: "invite",
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await acceptInvite(tok, PW)).token;
}
const asSession = (token: string, method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: { cookie: `tmb_session=${token}`, "idempotency-key": randomBytes(8).toString("hex") },
    ...(payload ? { payload } : {}),
  });
const asKey = (secret: string, url: string, payload: object = {}) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${secret}`,
      "idempotency-key": randomBytes(8).toString("hex"),
    },
    payload,
  });
const errorOf = (r: { body: string }) =>
  (JSON.parse(r.body) as { error?: { type?: string; message?: string } }).error ?? {};
/** Override config knobs for one block; restored after, so later blocks see the defaults. */
async function withKnobs(knobs: Partial<typeof config>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(knobs).map((k) => [k, (config as any)[k]]));
  Object.assign(config, knobs);
  try {
    await fn();
  } finally {
    Object.assign(config, saved);
  }
}

// ── § J · an operator session is metered per USER, on its own limit ─────────────
// The dashboard signs in with a session, not a key. It counts per person against
// RATE_LIMIT_SESSION_PER_MINUTE — not the org's API limit, which here is 0 (API stopped).
await withKnobs({ RATE_LIMIT_SESSION_PER_MINUTE: 3 }, async () => {
  const o = await signup({
    email: `rlj-${uniq}@example.com`,
    password: PW,
    organizationName: `RL Session ${uniq}`,
  });
  const orgId = o.user.organizationId;
  await withTenant(orgId, (tx) =>
    tx.update(organizations).set({ rateLimitPerMinute: 0 }).where(eq(organizations.id, orgId)),
  );
  const teammate = await memberSession(orgId, `rlj-b-${uniq}@example.com`, "admin");
  const { secret } = await createApiKey(orgId, "test");

  await clearOfBoundary();
  const codes: number[] = [];
  let last = await asSession(o.token, "GET", "/v1/businesses");
  codes.push(last.statusCode);
  ok(
    "§J a session response advertises the session limit",
    last.headers["x-ratelimit-limit"] === "3",
  );
  for (let i = 0; i < 3; i++) {
    last = await asSession(o.token, "GET", "/v1/businesses");
    codes.push(last.statusCode);
  }
  ok(
    `§J session: 3 allowed then the 4th refused, although the org API limit is 0 (got ${codes.join(",")})`,
    codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429,
  );
  ok("§J …as a rate_limit_error", errorOf(last).type === "rate_limit_error");
  ok(
    "§J …naming this user, not an API key",
    (errorOf(last).message ?? "").includes("3 requests per minute for this user"),
  );
  ok("§J …with Retry-After", Number(last.headers["retry-after"]) >= 1);

  const other = await asSession(teammate, "GET", "/v1/businesses");
  ok(
    `§J a teammate's session keeps its own allowance (got ${other.statusCode})`,
    other.statusCode === 200,
  );
  ok("§J …a full one", other.headers["x-ratelimit-remaining"] === "2");
  const key = await call(secret);
  ok(
    `§J an API key of the same org still follows the org limit of 0 (got ${key.statusCode})`,
    key.statusCode === 429,
  );
});

// ── § K · each costly route refuses past its own limit ──────────────────────────
// Limits set low in-process; every route reads `config` per request.
const refusedK = (r: { statusCode: number; body: string }) =>
  r.statusCode === 429 && errorOf(r).type === "rate_limit_error";

// Invites: per person, then per organization.
await withKnobs({ RATE_LIMIT_INVITES_PER_USER: 2, RATE_LIMIT_INVITES_PER_ORG: 3 }, async () => {
  const o = await signup({
    email: `rlk-${uniq}@example.com`,
    password: PW,
    organizationName: `RL Invite ${uniq}`,
  });
  const admin2 = await memberSession(o.user.organizationId, `rlk-adm-${uniq}@example.com`, "admin");
  const invite = (tok: string, n: number) =>
    asSession(tok, "POST", "/auth/invite", {
      email: `rlk-${n}-${uniq}@example.com`,
      role: "developer",
    });
  const a = [await invite(o.token, 1), await invite(o.token, 2), await invite(o.token, 3)];
  ok(
    `§K invite: 2 per user allowed (got ${a[0]!.statusCode},${a[1]!.statusCode})`,
    !refusedK(a[0]!) && !refusedK(a[1]!) && a[0]!.statusCode < 400,
  );
  ok(`§K invite: the user's 3rd is refused (got ${a[2]!.statusCode})`, refusedK(a[2]!));
  const b = await invite(admin2, 4);
  ok(`§K invite: past the org limit another user is refused (got ${b.statusCode})`, refusedK(b));
});

// Webhook resend / test send: per endpoint, then per organization. A refused call still
// counts on every axis, so the org stands at 3 after the first endpoint's three.
await withKnobs(
  { RATE_LIMIT_WEBHOOK_SENDS_PER_ENDPOINT: 2, RATE_LIMIT_WEBHOOK_SENDS_PER_ORG: 4 },
  async () => {
    const { orgId, secret } = await orgWithLimit("RL Webhook", null);
    const mk = async () =>
      (
        await createEndpoint({
          organizationId: orgId,
          livemode: "test",
          url: "https://example.com/hooks/rate-limit",
          eventTypes: ["customer_updated"],
        })
      ).endpoint.publicId;
    const e1 = await mk();
    const e2 = await mk();
    const send = (id: string) => asKey(secret, `/v1/webhook_endpoints/${id}/redeliver_failed`);
    await clearOfBoundary();
    const a = [await send(e1), await send(e1), await send(e1)];
    ok(
      `§K webhook: 2 per endpoint allowed (got ${a[0]!.statusCode},${a[1]!.statusCode})`,
      a[0]!.statusCode === 200 && a[1]!.statusCode === 200,
    );
    ok(`§K webhook: the endpoint's 3rd is refused (got ${a[2]!.statusCode})`, refusedK(a[2]!));
    const b = [await send(e2), await send(e2)];
    ok(
      `§K webhook: another endpoint runs into the org limit (got ${b.map((r) => r.statusCode)})`,
      b[0]!.statusCode === 200 && refusedK(b[1]!),
    );
    const missing = await send("whe_doesnotexist");
    ok(
      `§K webhook: an unknown endpoint is 404, not counted (got ${missing.statusCode})`,
      missing.statusCode === 404,
    );
  },
);

// One org + test business for the business-scoped routes below.
const kOrg = await orgWithLimit("RL Routes", null);
const kBiz = await createBusiness({
  organizationId: kOrg.orgId,
  name: "RL Routes Biz",
  defaultCurrency: "USD",
  livemode: "test",
});

// Ad hoc email: per recipient, then per business. The customer does not exist, so nothing
// is sent; the counter is consumed after the body parses.
await withKnobs(
  { RATE_LIMIT_ADHOC_EMAILS_PER_RECIPIENT: 2, RATE_LIMIT_ADHOC_EMAILS_PER_BUSINESS: 3 },
  async () => {
    const send = (to: string) =>
      asKey(kOrg.secret, `/v1/businesses/${kBiz.publicId}/emails/send`, {
        type: "payment_method_request",
        customer: "cus_XXXXXXXXXXXX01",
        to,
      });
    const a = [
      await send(`rl-a-${uniq}@example.com`),
      await send(`rl-a-${uniq}@example.com`),
      await send(`RL-A-${uniq}@example.com`),
    ];
    ok(
      `§K email: 2 per recipient not refused (got ${a[0]!.statusCode},${a[1]!.statusCode})`,
      !refusedK(a[0]!) && !refusedK(a[1]!),
    );
    ok(
      `§K email: the recipient's 3rd is refused, case-insensitively (got ${a[2]!.statusCode})`,
      refusedK(a[2]!),
    );
    const b = await send(`rl-b-${uniq}@example.com`);
    ok(`§K email: a new recipient runs into the business limit (got ${b.statusCode})`, refusedK(b));
  },
);

// Collect / retry: per invoice per hour, then per organization per minute. Counted before
// the invoice is read, so an unknown id is enough.
await withKnobs(
  { RATE_LIMIT_COLLECTS_PER_INVOICE: 2, RATE_LIMIT_COLLECTS_PER_ORG: 4 },
  async () => {
    const collect = (inv: string, verb = "collect") =>
      asKey(kOrg.secret, `/v1/businesses/${kBiz.publicId}/invoices/${inv}/${verb}`);
    await clearOfBoundary();
    const a = [
      await collect(`inv_RL01${uniq}`),
      await collect(`inv_RL01${uniq}`, "retry"),
      await collect(`inv_RL01${uniq}`),
    ];
    ok(
      `§K collect: 2 per invoice not refused (got ${a[0]!.statusCode},${a[1]!.statusCode})`,
      !refusedK(a[0]!) && !refusedK(a[1]!),
    );
    ok(
      `§K collect: the invoice's 3rd (collect and retry share it) is refused (got ${a[2]!.statusCode})`,
      refusedK(a[2]!) && (errorOf(a[2]!).message ?? "").includes("this invoice"),
    );
    // Another org naming the same invoice id has its own counter: it cannot block this one.
    const other = await orgWithLimit("RL Routes Other", null);
    const otherBiz = await createBusiness({
      organizationId: other.orgId,
      name: "RL Routes Other Biz",
      defaultCurrency: "USD",
      livemode: "test",
    });
    const x = await asKey(
      other.secret,
      `/v1/businesses/${otherBiz.publicId}/invoices/inv_RL01${uniq}/collect`,
    );
    ok(
      `§K collect: another org's calls on the same invoice id use their own counter (got ${x.statusCode})`,
      !refusedK(x),
    );
    const b = [
      await collect(`inv_RL02${uniq}`),
      await collect(`inv_RL03${uniq}`),
      await collect(`inv_RL04${uniq}`),
    ];
    ok(
      `§K collect: past the org limit any invoice is refused (got ${b.map((r) => r.statusCode)})`,
      !refusedK(b[0]!) &&
        !refusedK(b[1]!) &&
        refusedK(b[2]!) &&
        (errorOf(b[2]!).message ?? "").includes("collection requests"),
    );
  },
);

// Checkout coupon: per checkout session, then per address.
await withKnobs(
  { RATE_LIMIT_COUPON_TRIES_PER_SESSION: 2, RATE_LIMIT_COUPON_TRIES_PER_IP: 3 },
  async () => {
    await withTenant(kOrg.orgId, (tx) =>
      tx.update(businesses).set({ allowCustomerCoupons: true }).where(eq(businesses.id, kBiz.id)),
    );
    const product = await createProduct({
      organizationId: kOrg.orgId,
      businessId: kBiz.id,
      name: "RL Plan",
    });
    const price = await createPrice({
      organizationId: kOrg.orgId,
      businessId: kBiz.id,
      productId: product.id,
      type: "recurring",
      model: "flat",
      currency: "USD",
      amountMinor: 5000,
      interval: "month",
    });
    const mint = async () =>
      (
        await createCheckoutSession({
          organizationId: kOrg.orgId,
          businessId: kBiz.id,
          priceId: price.publicId,
          quantity: 1,
        })
      ).token;
    const s1 = await mint();
    const s2 = await mint();
    // Fresh addresses per run, so neither 127.0.0.1 (shared by every suite) nor a rerun
    // inside the window can interfere.
    const ipA = `2001:db8::${uniq.slice(0, 4)}:a`;
    const ipB = `2001:db8::${uniq.slice(0, 4)}:b`;
    const tryCode = (token: string, ip: string) =>
      app.inject({
        method: "POST",
        url: "/checkout/v1/coupon",
        remoteAddress: ip,
        headers: { authorization: `Bearer ${token}` },
        payload: { code: "NOSUCHCODE" },
      });
    const a = [await tryCode(s1, ipA), await tryCode(s1, ipA), await tryCode(s1, ipB)];
    ok(
      `§K coupon: 2 per session not refused (got ${a[0]!.statusCode},${a[1]!.statusCode})`,
      !refusedK(a[0]!) && !refusedK(a[1]!) && a[0]!.statusCode !== 401,
    );
    ok(
      `§K coupon: the session's 3rd is refused from a new address too (got ${a[2]!.statusCode})`,
      refusedK(a[2]!),
    );
    const b = [await tryCode(s2, ipA), await tryCode(s2, ipA)];
    ok(
      `§K coupon: another session from the same address hits the address limit (got ${b.map((r) => r.statusCode)})`,
      !refusedK(b[0]!) && refusedK(b[1]!),
    );
  },
);

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ RATE LIMIT: PASS" : "❌ RATE LIMIT: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
