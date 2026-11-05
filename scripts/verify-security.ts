/**
 * Security response headers, cookie attributes and the unauthenticated rate limits
 * (W2, W3, W4).
 *
 * Driven over REAL HTTP through the built app, for the same reason
 * `verify-rate-limit.ts` is: every subject here is a RESPONSE — a header, a
 * `Set-Cookie` attribute, a status code. A unit test on the header list would pass
 * with the hook unregistered, which is exactly the failure this exists to catch.
 *
 * Covered:
 *  - § A the baseline header set is on a 200
 *  - § B …and on a 404, and on an error — the `always` trap SEC-003 §5 describes,
 *        where a "fixed" header is missing on precisely the responses nobody checks
 *  - § C the Content-Security-Policy is route-appropriate: locked down by default,
 *        widened only for the two routes that genuinely render HTML
 *  - § D the invoice document's inline script is admitted BY HASH, and the hash
 *        matches the script actually served
 *  - § E the dashboard session cookie carries HttpOnly, SameSite and Secure, and the
 *        clear uses the same attributes as the set
 *  - § F login is rate limited per IP and per EMAIL independently — the second is the
 *        axis a botnet cannot evade and the per-account lockout cannot cover
 *  - § G repeated failures lock the account, and the lock reads as an ordinary
 *        credential failure rather than confirming the address exists
 *  - § U a PRODUCTION boot refuses the dev-shaped defaults of the three settings that
 *        default to their least-secure value, and still accepts an explicit statement
 *
 *   pnpm verify:security
 */
import { eq, sql } from "drizzle-orm";
import { buildApp } from "@/index";
import { systemDb, closeDb } from "@/platform/db";
import { users, authTokens } from "@db/schema";
import {
  signup,
  inviteUser,
  acceptInvite,
  startMfaEnrollment,
  confirmMfaEnrollment,
} from "@/modules/auth/service";
import { createApiKey, createBusiness } from "@/modules/tenancy/service";
import { totp } from "@/modules/auth/totp";
import { INVOICE_PRINT_SCRIPT, INVOICE_PRINT_SCRIPT_SHA256 } from "@/modules/invoicing/ops";
import { config, secureTransport } from "@/platform/config";
import { ALLOWED_ORIGINS, resolveAllowedOrigins } from "@/platform/cors";
import { verifyTurnstile, turnstileRefuses } from "@/platform/turnstile";
import { AUTH_WINDOW_MS, windowStartFor } from "@/platform/rate-limit";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { pinMfaMandateOff } from "./lib/mfa-policy";

// Not a test of the MFA mandate — see scripts/lib/mfa-policy.ts. Must precede any fixture.
pinMfaMandateOff();

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

const uniq = randomBytes(4).toString("hex");

/**
 * Drop the counters this suite works with, at BOTH ends.
 *
 * § F deliberately exhausts a rate limit, and the per-source bucket is keyed on
 * an address every suite in the repo shares (`127.0.0.1` in-process). Left behind, that
 * spent bucket refuses the next suite's perfectly ordinary login for the rest of the
 * minute — which is how `verify-auth-http` started failing its "wrong password → 401"
 * check with a 429 while nothing about auth had changed.
 *
 * Running it BEFORE as well as after is the point. Cleaning up only at the end leaves
 * the suite dependent on whoever ran before it, which is a suite that passes by
 * accident of ordering rather than because the behaviour holds.
 *
 * Scoped to the namespaces this file exercises, so it cannot disturb the API-key
 * counters `verify-rate-limit` owns.
 */
const clearAuthCounters = () =>
  systemDb.execute(sql`
    delete from public_rate_limit_counters
    where bucket like 'login:%' or bucket like 'signup:%'
       or bucket like 'change_password:%'
  `);

await clearAuthCounters();

/** Headers every response must carry, whatever its status. */
const BASELINE = [
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "cross-origin-opener-policy",
  "content-security-policy",
];

// ── § A · the baseline set on a 200 ──────────────────────────────────────────────
{
  const res = await app.inject({ method: "GET", url: "/health" });
  ok("§A /health answers 200", res.statusCode === 200);
  for (const h of BASELINE) ok(`§A 200 carries ${h}`, typeof res.headers[h] === "string");
  ok("§A frame protection denies outright", res.headers["x-frame-options"] === "DENY");
  ok(
    "§A referrer policy does not leak the path",
    res.headers["referrer-policy"] === "strict-origin-when-cross-origin",
  );
  // HSTS tracks the transport, and must track the SAME fact the cookie's Secure flag
  // does — a service that sends HSTS while issuing insecure cookies is asserting a
  // guarantee it is not keeping.
  ok(
    "§A HSTS is present iff the deployment serves HTTPS",
    Boolean(res.headers["strict-transport-security"]) === secureTransport(),
  );
}

// ── § B · the same set on responses nobody checks ────────────────────────────────
{
  const notFound = await app.inject({ method: "GET", url: `/no-such-route-${uniq}` });
  ok("§B unknown route answers 404", notFound.statusCode === 404);
  for (const h of BASELINE) ok(`§B 404 carries ${h}`, typeof notFound.headers[h] === "string");

  // A 401 comes from a preHandler that short-circuits before the route handler ever
  // runs — a different path through the lifecycle, and the one a header hook attached
  // in the wrong place misses.
  const unauth = await app.inject({ method: "GET", url: "/v1/businesses" });
  ok("§B unauthenticated request answers 401", unauth.statusCode === 401);
  for (const h of BASELINE) ok(`§B 401 carries ${h}`, typeof unauth.headers[h] === "string");
}

// ── § C · the policy fits the route ──────────────────────────────────────────────
{
  const api = await app.inject({ method: "GET", url: "/health" });
  const apiCsp = String(api.headers["content-security-policy"]);
  // A JSON API should be able to load nothing at all.
  ok("§C the default policy is default-src 'none'", apiCsp.includes("default-src 'none'"));
  ok("§C the default policy forbids framing", apiCsp.includes("frame-ancestors 'none'"));
  // The directive most policies forget, and the one that stops an injected form
  // posting a victim's data somewhere else.
  ok("§C the default policy sets form-action 'none'", apiCsp.includes("form-action 'none'"));
  ok("§C the default policy allows no script at all", !apiCsp.includes("script-src"));

  const docs = await app.inject({ method: "GET", url: "/docs" });
  const docsCsp = String(docs.headers["content-security-policy"]);
  ok("§C /docs renders", docs.statusCode === 200);
  // The one host in the service that serves us code. If it is in the page it must be
  // in the policy — and if it leaves the page, the policy should follow.
  ok("§C /docs names its CDN explicitly", docsCsp.includes("https://cdn.jsdelivr.net"));
  ok(
    "§C /docs policy matches the script the page actually loads",
    String(docs.body).includes("https://cdn.jsdelivr.net"),
  );
}

// ── § C2 · the DASHBOARD policy, which is the one that guards a card form ────────
//
// § C above covers the API. The dashboard had no gate at all, even though its policy is the
// one standing between an injected script and a buyer's card details — and `next.config.mjs`
// pointed at a `pnpm verify:headers` that was never written. This is that check.
//
// It imports the real config and calls `headers()` rather than scanning the source, so it
// asserts what a browser would actually receive.
{
  // Imported through a variable so TS does not demand types for a plain-ESM config file.
  const configPath = "../dashboard/next.config.mjs";
  const mod = (await import(configPath)) as {
    default: {
      headers: () => Promise<{ source?: string; headers: { key: string; value: string }[] }[]>;
    };
  };
  const groups = await mod.default.headers();
  const emitted = groups.flatMap((g) => g.headers);
  const csp = emitted.find((h) => h.key.toLowerCase().startsWith("content-security-policy"));
  ok("§C2 the dashboard emits a Content-Security-Policy", csp !== undefined);

  // The finding this exists to prevent: shipping report-only forever. The observation period
  // ended when card entry on both gateways came back clean; `CSP_REPORT_ONLY=TRUE` is now an
  // opt-out, so a default-configured deployment must ENFORCE.
  ok(
    "§C2 the dashboard policy ENFORCES by default (not report-only)",
    process.env.CSP_REPORT_ONLY === "TRUE"
      ? csp?.key === "Content-Security-Policy-Report-Only"
      : csp?.key === "Content-Security-Policy",
  );

  const value = String(csp?.value ?? "");
  const directive = (policy: string, name: string) =>
    (new RegExp(`${name} ([^;]*)`).exec(policy)?.[1] ?? "").trim().split(/\s+/);
  // Gateway hosts go only on the routes that load a gateway SDK (see STOREFRONT_PATHS).
  const storefront = groups.filter((g) =>
    /^\/(checkout|portal|buy|pricing)\//.test((g as { source?: string }).source ?? ""),
  );
  const storefrontCsp = storefront.map(
    (g) => g.headers.find((h) => h.key === csp?.key)?.value ?? "",
  );
  const everyStorefront = (name: string, host: string) =>
    storefrontCsp.length > 0 && storefrontCsp.every((v) => directive(v, name).includes(host));
  // Measured, not read off a doc page: Razorpay's checkout.js injects its risk-detection
  // bundle from cdn.razorpay.com into OUR document. It fired three script-src-elem violations
  // in report-only, and dropping it would silently strip Razorpay's fraud signals at checkout.
  ok(
    "§C2 storefront script-src names cdn.razorpay.com (Razorpay injects it at runtime)",
    everyStorefront("script-src", "https://cdn.razorpay.com"),
  );
  ok(
    "§C2 storefront script-src names checkout.razorpay.com",
    everyStorefront("script-src", "https://checkout.razorpay.com"),
  );
  ok(
    "§C2 storefront script-src names js.stripe.com",
    everyStorefront("script-src", "https://js.stripe.com"),
  );
  // Braintree 3D Secure loads Cardinal's Songbird from the host the gateway names. Without it
  // the 3DS check never runs (blocked in the sandbox, 2026-10-28). Named hosts, no wildcard:
  // sandbox and live script, the API host each one calls, and its two logging hosts.
  for (const [name, host] of [
    ["script-src", "https://cas.static.client.cardinaltrusted.com"],
    ["script-src", "https://static.client.cardinaltrusted.com"],
    ["connect-src", "https://cas.client.cardinaltrusted.com"],
    ["connect-src", "https://client.cardinaltrusted.com"],
    ["connect-src", "https://writer.cardinalcommerce.com"],
    ["connect-src", "https://kg668dbov0.execute-api.us-east-1.amazonaws.com"],
    ["frame-src", "https://client.cardinaltrusted.com"],
  ] as const)
    ok(`§C2 storefront ${name} names ${host} (Braintree 3D Secure)`, everyStorefront(name, host));
  // The operator dashboard loads no gateway SDK, so it names no gateway host.
  ok(
    "§C2 the operator dashboard CSP names no gateway host",
    !/stripe|razorpay|braintree|paypal|cardinal|adyen|checkout\.com|squar|cybersource|cashfree|payu/.test(
      value,
    ),
  );
  // The directives that carry this policy's actual value — see the note in next.config.mjs
  // about script-src being weak while 'unsafe-inline' is a Next requirement.
  ok("§C2 the dashboard policy sets form-action 'self'", value.includes("form-action 'self'"));
  ok("§C2 the dashboard policy sets object-src 'none'", value.includes("object-src 'none'"));
  ok("§C2 the dashboard policy sets base-uri 'self'", value.includes("base-uri 'self'"));
  ok("§C2 the dashboard policy forbids framing", value.includes("frame-ancestors 'none'"));
  // connect-src is the directive an exfiltration attempt trips, so a wildcard here would
  // quietly undo the rest. The only exception is a reviewed subdomain wildcard on a vendor's
  // own domain, each with its reason:
  //  - https://*.checkout.com: every Checkout.com account calls its own API host
  //    (`{prefix}.api.checkout.com`), so one static policy cannot name them; Checkout.com's
  //    docs require the wildcard. It reaches Checkout.com's servers only.
  //  - https://*.google-analytics.com, https://*.analytics.google.com: GA4 (sign-up pages)
  //    sends to regional collection hosts; Google's CSP guide for GA4 lists both wildcards.
  //    They reach Google's analytics servers only.
  const REVIEWED_CONNECT_WILDCARDS = new Set([
    "https://*.checkout.com",
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
  ]);
  const connectSrc = directive(value, "connect-src");
  ok(
    "§C2 connect-src is an allow-list: no wildcard beyond the reviewed vendor subdomains",
    [value, ...storefrontCsp].every((v) => {
      const list = directive(v, "connect-src");
      return (
        list.length > 1 &&
        !list.includes("https:") &&
        list.filter((t) => t.includes("*")).every((t) => REVIEWED_CONNECT_WILDCARDS.has(t))
      );
    }),
  );
  ok(
    "§C2 every reviewed connect-src wildcard is a https:// subdomain of a named domain",
    [...REVIEWED_CONNECT_WILDCARDS].every((t) =>
      /^https:\/\/\*\.([a-z0-9-]+\.)+[a-z]{2,}$/.test(t),
    ),
  );

  // Live 3DS frames and posts to the card issuer's own ACS host, so storefront routes (and only
  // they) allow any https host in frame-src and form-action. connect-src must stay an
  // allow-list there, or a storefront script could send card data to an unlisted host.
  ok(
    "§C2 every storefront route (checkout, portal, buy, pricing) has its own CSP",
    storefront.length === 4 && storefrontCsp.every((v) => v.length > 0),
  );
  ok(
    "§C2 the storefront CSP allows https: in frame-src and form-action (issuer 3DS pages)",
    storefrontCsp.every(
      (v) =>
        directive(v, "frame-src").includes("https:") &&
        directive(v, "form-action").includes("https:"),
    ),
  );
  ok(
    "§C2 the operator dashboard CSP does not allow https: in frame-src or form-action",
    !directive(value, "frame-src").includes("https:") &&
      !directive(value, "form-action").includes("https:"),
  );
  ok(
    "§C2 the storefront connect-src is the dashboard's plus named gateway hosts",
    storefrontCsp.every((v) => {
      const list = directive(v, "connect-src");
      return connectSrc.every((t) => list.includes(t));
    }),
  );
  ok(
    "§C2 the storefront CSP keeps frame-ancestors 'none', object-src 'none' and base-uri 'self'",
    storefrontCsp.every(
      (v) =>
        v.includes("frame-ancestors 'none'") &&
        v.includes("object-src 'none'") &&
        v.includes("base-uri 'self'"),
    ),
  );

  // Reporting survives enforcement: the allow-list is only as complete as the flows someone
  // drove, and a path nobody exercised can still violate in production.
  ok(
    "§C2 the policy still names a report destination after enforcing",
    value.includes("report-uri") || value.includes("report-to"),
  );
  ok(
    "§C2 the report-to group is defined by a Reporting-Endpoints header",
    !value.includes("report-to") ||
      emitted.some((h) => h.key === "Reporting-Endpoints" && h.value.includes("csp-endpoint")),
  );

  // Header budget. Production nginx buffers upstream headers in `proxy_buffer_size 16k`; past
  // it nginx answers 502 (2026-10-28, at its 4 KB default). Hold every route class to half.
  // FRAMEWORK_ALLOWANCE covers what Next and a session add on top of this config.
  const HEADER_BUDGET = 8 * 1024;
  const FRAMEWORK_ALLOWANCE = 2 * 1024;
  const sourceRe = (src: string) => new RegExp(`^${src.replace(/\/:path\*$/, "(?:/.*)?")}$`);
  for (const path of ["/login", "/businesses/x/customers", "/checkout", "/portal", "/pricing/x"]) {
    const final = new Map<string, { key: string; value: string }>();
    for (const g of groups)
      if (sourceRe(g.source ?? "").test(path))
        for (const h of g.headers) final.set(h.key.toLowerCase(), h);
    const bytes = [...final.values()].reduce((n, h) => n + h.key.length + h.value.length + 4, 0);
    ok(
      `§C2 ${path}: config headers ${bytes} B + ${FRAMEWORK_ALLOWANCE} B allowance ≤ ${HEADER_BUDGET} B`,
      bytes + FRAMEWORK_ALLOWANCE <= HEADER_BUDGET,
    );
  }
}

// ── § D · the invoice script is admitted by hash, not by 'unsafe-inline' ─────────
{
  // Derived from the constant the renderer serves, so this asserts the two agree
  // rather than asserting a pasted literal agrees with itself.
  const expected = `sha256-${createHash("sha256").update(INVOICE_PRINT_SCRIPT, "utf8").digest("base64")}`;
  ok("§D the exported hash matches the exported script", INVOICE_PRINT_SCRIPT_SHA256 === expected);
  // The whole point of hashing: an inline handler could not be covered this way.
  ok(
    "§D the print script binds its handler rather than using onclick",
    INVOICE_PRINT_SCRIPT.includes("addEventListener"),
  );
  ok(
    "§D the print script is not admitted by 'unsafe-inline'",
    !INVOICE_PRINT_SCRIPT.includes("unsafe"),
  );
}

// ── § E · the session cookie ─────────────────────────────────────────────────────
{
  const email = `sec-${uniq}@example.com`;
  const password = "Correct-Horse-Battery-9";

  // Self-serve signup is closed (audit H2/M9), so the account is created through the SERVICE
  // — which is how the importer, the seed and every other fixture do it — and the cookie
  // comes from `login`. The subject of this section is the cookie's attributes, and `login`
  // and `signup` set it through the same `setSessionCookie`, so nothing is lost.
  await signup({ email, password, organizationName: `Sec ${uniq}` });
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  ok("§E login succeeds", res.statusCode === 200);

  // The route itself must stay shut, and refuse identically whatever it is sent — that
  // sameness is what closes M9's registration oracle.
  const closed = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email, password, organization_name: "Should Not Exist" },
  });
  const closedUnknown = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: {
      email: `never-${uniq}@example.com`,
      password,
      organization_name: "Should Not Exist",
    },
  });
  ok("§E self-serve signup is refused", closed.statusCode === 403);
  ok(
    "§E …identically for a known and an unknown address (no registration oracle)",
    closed.statusCode === closedUnknown.statusCode && closed.body === closedUnknown.body,
  );
  const setCookie = String(res.headers["set-cookie"] ?? "");
  ok("§E cookie is HttpOnly", /HttpOnly/i.test(setCookie));
  ok("§E cookie is SameSite=Lax", /SameSite=Lax/i.test(setCookie));
  ok("§E cookie Secure tracks the transport", /;\s*Secure/i.test(setCookie) === secureTransport());
  // No token in the BODY. The session is the cookie; echoing it into JSON would put it
  // back within reach of page script, undoing what HttpOnly is for.
  ok(
    "§E the session token is not echoed in the response body",
    !String(res.body).includes("sess_"),
  );

  const token = /tmb_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
  const out = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { cookie: `tmb_session=${token}` },
  });
  const clear = String(out.headers["set-cookie"] ?? "");
  // A clear that scopes differently from the set does not clear anything — the browser
  // keeps the original cookie and the "logout" is cosmetic.
  ok(
    "§E logout clears with the same attributes it set",
    /HttpOnly/i.test(clear) && /SameSite=Lax/i.test(clear),
  );
  ok("§E logout expires the cookie", /Max-Age=0/i.test(clear));
}

// ── § F · login is limited on both axes ──────────────────────────────────────────
{
  // The two axes are separated by BEHAVIOUR, not by faking distinct clients with
  // `X-Forwarded-For` — that would assert one thing on a developer's machine and another
  // in CI. Behaviour is the property that actually matters.
  //
  // The forged header now gets its own check at the end of this block (audit H3): under
  // the default `TRUST_PROXY_HOPS=0` it must not move the bucket at all, which is a
  // deterministic claim rather than a deployment-dependent one.
  /**
   * ⚠ THE WHOLE BLOCK MUST LAND IN ONE WINDOW, and the window is FIXED, not sliding.
   *
   * `windowStartFor` floors to absolute multiples of `AUTH_WINDOW_MS`, so windows begin at
   * :00/:15/:30/:45 — not when the first request arrives. Every assertion below needs a counter
   * to accumulate across ~15s of requests, so a boundary crossing mid-block splits them over two
   * rows and NEITHER partition reaches the limit: no 429, and two checks fail for a reason that
   * has nothing to do with the limiter.
   *
   * Measured 2026-09-02: a run spanning 17:29:55 → 17:30:08 failed exactly that way and passed
   * on a re-run at 17:33. ~15s of work against a 900s window is a ~1.7% chance of a spurious red
   * per run — rare enough to be written off as flaky CI, and expensive because the two checks it
   * fails ("one source spraying many addresses is eventually refused", "a forged X-Forwarded-For
   * does NOT buy a fresh rate-limit bucket") read as a SECURITY regression rather than a clock
   * artefact. Someone would go looking for a limiter bug that was never there.
   *
   * So: if this window has less left than the block needs, wait for the next one. Bounded by
   * SAFETY_MS and skipped entirely the other ~95% of runs. Deliberately NOT
   * `clearPublicRateLimits` — the problem is the crossing, not leftover state, and this suite
   * owns its own counters on purpose (see `scripts/lib/rate-limit-reset.ts`).
   *
   * The helpers are IMPORTED, not re-derived. A local copy of the floor arithmetic would keep
   * passing after someone changed the real window length, which is the failure this guards.
   */
  const SAFETY_MS = 45_000;
  const msLeftInWindow = () =>
    windowStartFor(new Date(), AUTH_WINDOW_MS).getTime() + AUTH_WINDOW_MS - Date.now();
  if (msLeftInWindow() < SAFETY_MS) {
    // +250ms so we land clear of the boundary rather than exactly on it.
    const wait = msLeftInWindow() + 250;
    console.log(`  §F waiting ${(wait / 1000).toFixed(1)}s for a fresh rate-limit window`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  // Asserted, not merely arranged: if the wait above ever stops working, this names the reason
  // instead of leaving the two checks below to fail as a phantom limiter bug.
  ok("§F the block has a full rate-limit window ahead of it", msLeftInWindow() >= SAFETY_MS);

  const email = `stuff-${uniq}@example.com`;
  const statuses: number[] = [];
  for (let i = 0; i < config.RATE_LIMIT_AUTH_PER_EMAIL + 2; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong-password" },
    });
    statuses.push(r.statusCode);
  }
  ok("§F repeated attempts on one address are eventually refused", statuses.includes(429));
  ok("§F the first attempt is not refused", statuses[0] !== 429);

  // THE ISOLATION PROOF, and the reason this section is not just "a 429 appeared":
  // a DIFFERENT address from the same client, immediately after. If that is refused
  // too, the limiter is only counting the source and the per-email axis does not
  // exist. That axis is the whole point — it is what a botnet cannot evade, and what
  // the lockout in § G cannot cover, because a credential-stuffing run leaves exactly
  // one failure on each account and never trips a per-account counter.
  //
  // It fits inside the per-source budget by construction; the check below is what
  // keeps that true if someone retunes the limits.
  ok(
    "§F the per-source budget leaves room for the isolation proof",
    config.RATE_LIMIT_AUTH_PER_EMAIL + 3 <= config.RATE_LIMIT_AUTH_PER_IP,
  );
  const other = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: `other-${uniq}@example.com`, password: "wrong-password" },
  });
  ok(
    "§F a DIFFERENT address is still served — the refusal was email-scoped",
    other.statusCode !== 429,
  );

  // Now exhaust the source axis, with a fresh address every time so only that axis can
  // be what refuses.
  const ipStatuses: number[] = [];
  for (let i = 0; i < config.RATE_LIMIT_AUTH_PER_IP + 2; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `spray-${uniq}-${i}@example.com`, password: "wrong-password" },
    });
    ipStatuses.push(r.statusCode);
  }
  ok("§F one source spraying many addresses is eventually refused", ipStatuses.includes(429));

  // AUDIT H3 REGRESSION. The source budget is spent as of the line above, so one more
  // request from this client must be refused. Send it with a forged `X-Forwarded-For`:
  // if the header were believed, that value would BECOME `req.ip`, the request would
  // land in a fresh bucket and be served — which is exactly the bypass the finding
  // described, and rotating one header per request made every credential route
  // unlimited. Ignored, it keeps hitting the exhausted bucket and is still refused.
  //
  // `trustProxy` was a boolean until 2026-08-27; `true` believes the WHOLE chain and
  // resolves `req.ip` to its LEFTMOST entry, i.e. the client's own claim. Caddy and
  // nginx APPEND rather than replace, so the "only with a rewriting proxy" caveat the
  // old comment carried was never actually satisfiable. A hop count can say it.
  //
  // Guarded on the hop count because the harness has no real proxy in front of it: with
  // hops >= 1 there is no true peer for the header to sit in front of, so a forged value
  // legitimately wins and the assertion would be testing the harness, not the code.
  if (config.TRUST_PROXY_HOPS === 0) {
    const forged = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: `forged-${uniq}@example.com`, password: "wrong-password" },
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    ok(
      "§F a forged X-Forwarded-For does NOT buy a fresh rate-limit bucket",
      forged.statusCode === 429,
    );
  } else {
    ok(
      `§F forged-header check skipped — TRUST_PROXY_HOPS is ${config.TRUST_PROXY_HOPS}, not 0`,
      true,
    );
  }

  // The refusal must say nothing about whether the address is one we know.
  const refused = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: `spray-${uniq}-x@example.com`, password: "wrong-password" },
  });
  ok("§F the 429 body names no address and no account", !String(refused.body).includes(uniq));
}

// ── § G · per-account lockout ────────────────────────────────────────────────────
{
  const email = `lock-${uniq}@example.com`;
  const password = "Correct-Horse-Battery-9";
  await signup({ email, password, organizationName: `Lock ${uniq}` });

  // Drive failures through the SERVICE, not HTTP: the rate limiter would refuse these
  // long before the lockout threshold, and the two controls are being asserted
  // separately on purpose — that they are separate is the finding.
  const { login } = await import("@/modules/auth/service");
  for (let i = 0; i < config.LOGIN_LOCKOUT_THRESHOLD; i++) {
    await login(email, "wrong-password").catch(() => {});
  }
  const [locked] = await systemDb.select().from(users).where(eq(users.email, email)).limit(1);
  ok(
    "§G the account is locked after the threshold",
    Boolean(locked?.lockedUntil && locked.lockedUntil > new Date()),
  );
  // Self-expiring, so an attacker cannot use the lockout itself to keep a known
  // address out indefinitely.
  ok(
    "§G the lock expires on its own",
    Boolean(
      locked?.lockedUntil &&
      locked.lockedUntil.getTime() - Date.now() <= config.LOGIN_LOCKOUT_MINUTES * 60_000 + 5_000,
    ),
  );

  // The CORRECT password is refused while locked — and refused with the same message a
  // wrong one gets, so the lock does not confirm the address exists.
  const err = await login(email, password)
    .then(() => null)
    .catch((e: Error) => e.message);
  ok("§G a locked account refuses the correct password", err !== null);
  ok(
    "§G the refusal is indistinguishable from a wrong password",
    err === "Invalid email or password",
  );
}

// ── § I · cross-origin policy (W7) ───────────────────────────────────────────────
//
// THE POLICY, WRITTEN DOWN: this API grants cross-origin access to EXACTLY the three
// origins the deployment already names for itself — DASHBOARD_BASE_URL,
// PORTAL_BASE_URL and WEBHOOK_BASE_URL — and to nobody else, with credentials
// advertised to nobody at all. `src/platform/cors.ts` is the implementation and carries
// the reasoning; this section is the part that fails loudly when somebody relaxes it.
//
// It was "no CORS whatsoever" until 2026-08-29, and true only BY ABSENCE — nobody had
// added a CORS plugin — which is an undocumented property one `origin: true` away from
// gone, and exactly how SR-2026-008's three CORS findings came about (a substring
// allowlist, an environment bypass, and an absent-Origin allowance, which its authors
// note an auditor reads as ONE systemic weakness rather than three defects). The
// allowlist replaces that absence with a stated, finite grant. All three of those
// findings are asserted against below as shapes the rule must keep refusing.
{
  // ── the matching RULE, against production-shaped values ──────────────────────
  //
  // Asserted on `resolveAllowedOrigins` directly rather than over HTTP, because these
  // are properties of the rule and must hold on every deployment — including this one,
  // where the three variables point at localhost or are unset entirely.
  const prod = resolveAllowedOrigins({
    DASHBOARD_BASE_URL: "https://app.example.com",
    PORTAL_BASE_URL: "https://portal.example.com/",
    WEBHOOK_BASE_URL: "https://api.example.com",
  });
  ok("§I the allowlist is exactly three origins", prod.size === 3);
  ok(
    "§I a configured trailing slash normalises to a bare origin",
    prod.has("https://portal.example.com"),
  );
  for (const rejected of [
    // Finding 1, prefix position: a registrable domain that merely ENDS with an
    // allowlisted string. A substring or `endsWith` check passes this.
    "https://app.example.com.evil.example",
    // The suffix-position variant: the allowed name in a PATH, which is not part of an
    // origin at all.
    "https://evil.example/app.example.com",
    // A sibling subdomain nobody put on the list.
    "https://staging.example.com",
    // Same host, wrong scheme — a downgrade an attacker on the network can force.
    "http://app.example.com",
    // Same host, wrong port.
    "https://app.example.com:8443",
    // Finding 3: browsers send this from a sandboxed frame or a file:// document, and
    // it must never be read as "no origin, therefore trusted".
    "null",
    "",
  ]) {
    ok(`§I the allowlist refuses ${JSON.stringify(rejected)}`, !prod.has(rejected));
  }
  // Finding 2's shape: a variable that goes missing must REMOVE a grant, never open
  // one. An empty configuration is an empty allowlist — the behaviour this API had
  // before the file existed.
  ok("§I unset configuration grants no origin at all", resolveAllowedOrigins({}).size === 0);

  // ── the same rule, as this running app actually answers ────────────────────────
  const origins = [
    "https://evil.example",
    "https://tmbilling.test.evil.example",
    "https://evil.example/tmbilling.test",
    "null",
  ];
  for (const origin of origins) {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin } });
    ok(
      `§I no Access-Control-Allow-Origin for ${origin}`,
      res.headers["access-control-allow-origin"] === undefined,
    );
    // A response that varies by Origin must say so, or a shared cache in front of us
    // hands one caller's grant to the next caller.
    ok(`§I Vary: Origin for ${origin}`, String(res.headers["vary"] ?? "").includes("Origin"));
  }
  // Credentials must never be advertised, to anyone, with or without an origin echo.
  // This is the header that turns a granted origin from an annoyance into account
  // access — and it is asserted for an ALLOWED origin too, further down.
  const cred = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "https://evil.example" },
  });
  ok(
    "§I no Access-Control-Allow-Credentials, ever",
    cred.headers["access-control-allow-credentials"] === undefined,
  );

  // The preflight is the half that is easy to forget: a service can refuse the simple
  // request and still hand a permissive answer to OPTIONS.
  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/v1/businesses",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization",
    },
  });
  ok(
    "§I preflight grants no origin",
    preflight.headers["access-control-allow-origin"] === undefined,
  );
  ok(
    "§I preflight grants no methods",
    preflight.headers["access-control-allow-methods"] === undefined,
  );

  // ── and the grant itself, wherever this deployment configures one ──────────────
  //
  // Skipped rather than faked when none of the three variables is set: inventing an
  // origin here would test a policy this process is not running. `.env.example` sets
  // PORTAL_BASE_URL, so the local suite does exercise it.
  const allowed = [...ALLOWED_ORIGINS][0];
  if (allowed === undefined) {
    console.log("  SKIP §I granted-origin checks — no *_BASE_URL configured in this env");
  } else {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: allowed } });
    ok(
      `§I ${allowed} is granted, echoed EXACTLY`,
      res.headers["access-control-allow-origin"] === allowed,
    );
    ok(
      "§I a granted origin still gets no credentials",
      res.headers["access-control-allow-credentials"] === undefined,
    );
    ok(
      "§I a granted origin may read the rate-limit budget",
      String(res.headers["access-control-expose-headers"] ?? "").includes("x-ratelimit-remaining"),
    );
    // The preflight succeeds on a path that registers no OPTIONS route — the whole
    // reason the policy is answered before routing.
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/v1/businesses",
      headers: {
        origin: allowed,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,idempotency-key",
      },
    });
    ok("§I preflight from a granted origin is 204", pre.statusCode === 204);
    ok(
      "§I preflight grants POST",
      String(pre.headers["access-control-allow-methods"] ?? "").includes("POST"),
    );
    ok(
      "§I preflight grants idempotency-key",
      String(pre.headers["access-control-allow-headers"] ?? "").includes("idempotency-key"),
    );
    // A wildcard is never an acceptable answer, on any route, to anybody.
    ok("§I never a wildcard origin", pre.headers["access-control-allow-origin"] === allowed);
  }
}

await clearAuthCounters();
// ── § R · the role matrix is enforced by the ENGINE, not only by the dashboard (H1) ──
//
// Five roles and a permission matrix have existed in modules/auth/service from the start, and
// across ~291 routes exactly one consulted them. The role was enforced in the dashboard as page
// redirects and nav filtering — which a direct API call simply walks around.
{
  const rEmail = (r: string) => `rbac-${r}-${uniq}@example.com`;
  const PW = "Correct-Horse-Battery-9";

  const ownerSignup = await signup({
    email: rEmail("owner"),
    password: PW,
    organizationName: `RBAC ${uniq}`,
  });
  const orgId = ownerSignup.user.organizationId;
  const biz = await createBusiness({
    organizationId: orgId,
    name: `RBAC Biz ${uniq}`,
    defaultCurrency: "USD",
  });

  /**
   * Invite at `role`, accept, return the session token — MEMOISED, because a second invite for
   * the same address throws "User is already a member of this organization".
   */
  const tokenByRole = new Map<string, string>();
  const sessionAs = async (role: "developer" | "ops" | "manager"): Promise<string> => {
    const cached = tokenByRole.get(role);
    if (cached) return cached;
    const invited = await inviteUser({ organizationId: orgId, email: rEmail(role), role });
    const tok = `invt_${randomBytes(32).toString("base64url")}`;
    await systemDb.insert(authTokens).values({
      userId: invited.userId,
      tokenHash: createHash("sha256").update(tok).digest("hex"),
      purpose: "invite",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const token = (await acceptInvite(tok, PW)).token;
    tokenByRole.set(role, token);
    return token;
  };

  const post = (url: string, cookie: string, payload: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        cookie: `tmb_session=${cookie}`,
        "idempotency-key": randomBytes(8).toString("hex"),
      },
      payload: payload as object,
    });

  // ADMIN tier. Gateway accounts hold live payment credentials and the dashboard gates them at
  // admin, so developer, ops AND manager must all be refused. Testing only `developer` would
  // pass even if the check were `role !== 'developer'`.
  //
  // No step-up here any more (M3.3 rolled back 2026-09-02 — see § S). The error TYPE is still
  // asserted below, and that assertion is now MORE important rather than less: it is what stops
  // this section passing vacuously if a refusal ever starts coming from something other than the
  // role — which is exactly what would happen if a re-authentication gate came back.
  const gwUrl = `/v1/businesses/${biz.publicId}/gateway_accounts`;
  const gwBody = { gateway: "tmtest", name: "RBAC probe" };
  for (const role of ["developer", "ops", "manager"] as const) {
    const cookie = await sessionAs(role);
    const res = await post(gwUrl, cookie, gwBody);
    ok(`§R a ${role} session is refused an admin operation (403)`, res.statusCode === 403);
    ok(
      `§R …for the ROLE, not for step-up`,
      JSON.parse(res.body).error?.type === "permission_error",
    );
  }
  ok(
    "§R an owner session is NOT refused",
    (await post(gwUrl, ownerSignup.token, gwBody)).statusCode !== 403,
  );

  // THE OTHER DIRECTION, and the one that ships bugs. Every permission was set to the LOWEST
  // level the dashboard uses for that area — `customers/[cus]` alone mixes admin, manager and
  // ops — because a route stricter than the screen offering it is a control that always fails.
  const cusUrl = `/v1/businesses/${biz.publicId}/customers`;
  const opsWrite = await post(cusUrl, await sessionAs("ops"), {
    email: `rbac-c1-${uniq}@example.com`,
  });
  ok("§R an ops session is NOT locked out of an ops-level write", opsWrite.statusCode !== 403);

  const devWrite = await post(cusUrl, await sessionAs("developer"), {
    email: `rbac-c2-${uniq}@example.com`,
  });
  ok("§R a developer session cannot create a customer", devWrite.statusCode === 403);

  // BOTH key kinds, because they are not interchangeable and the distinction bit me: a session
  // and the dashboard's own key both report `apiKeyKind: 'dashboard'`, so a guard written as
  // `kind === 'api'` refuses the dashboard key while letting integrations through. What
  // actually separates them is whether an operator is attached.
  const withKey = (secret: string) =>
    app.inject({
      method: "POST",
      url: gwUrl,
      headers: {
        authorization: `Bearer ${secret}`,
        "idempotency-key": randomBytes(8).toString("hex"),
      },
      payload: gwBody,
    });
  ok(
    "§R the dashboard's own key still reaches the route",
    (await withKey(ownerSignup.dashboardKeySecret)).statusCode !== 403,
  );
  const integration = await createApiKey(orgId, "test");
  ok(
    "§R an integration key still reaches the route",
    (await withKey(integration.secret)).statusCode !== 403,
  );
}

// ── § K · a read-only API key cannot write (H1.3) ────────────────────────────────
//
// Role checks do not constrain a key at all: a key is not a person, carries no role, and
// satisfies every `requirePerm` trivially. Scope is the axis that does. Until it existed every
// key an organization minted had full privilege, which is why "leaked integration key" and
// "full account takeover" were the same event.
{
  const kOrg = await signup({
    email: `scope-${uniq}@example.com`,
    password: "Correct-Horse-Battery-9",
    organizationName: `Scope ${uniq}`,
  });
  // livemode 'test' to match the test-mode keys below: a test key reaching a live business is
  // answered 404 by the sandbox partition, which would look like a scope failure and is not.
  const kBiz = await createBusiness({
    organizationId: kOrg.user.organizationId,
    name: `Scope Biz ${uniq}`,
    defaultCurrency: "USD",
    livemode: "test",
  });
  const readKey = await createApiKey(kOrg.user.organizationId, "test", "api", "read");
  const writeKey = await createApiKey(kOrg.user.organizationId, "test", "api", "write");

  const call = (secret: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(method === "POST" ? { "idempotency-key": randomBytes(8).toString("hex") } : {}),
      },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const cusUrl = `/v1/businesses/${kBiz.publicId}/customers`;

  ok("§K a read key can READ", (await call(readKey.secret, "GET", cusUrl)).statusCode === 200);

  const blocked = await call(readKey.secret, "POST", cusUrl, { email: `k1-${uniq}@example.com` });
  ok("§K a read key cannot WRITE (403)", blocked.statusCode === 403);
  ok("§K …and is told why", String(blocked.body).includes("read-only"));

  ok(
    "§K a write key still writes",
    (await call(writeKey.secret, "POST", cusUrl, { email: `k2-${uniq}@example.com` })).statusCode <
      300,
  );

  // Enforcement is by METHOD, so it holds for routes nobody remembered to annotate — which is
  // the point, but it would also refuse the POSTs that only COMPUTE. A read key that cannot
  // answer "what would this cost" is missing most of what read access is for, so those are
  // allow-listed by route PATTERN (never by raw URL, or a path containing the word "estimate"
  // could smuggle itself in).
  const est = await call(
    readKey.secret,
    "POST",
    `/v1/businesses/${kBiz.publicId}/customers/cus_nonexistent/subscription_estimate`,
    { items: [] },
  );
  ok("§K a read key still reaches a non-mutating estimate (not 403)", est.statusCode !== 403);

  // Defaults matter more than the feature: every key minted before this column existed, and
  // every caller that does not ask, must keep the reach it had.
  const defaulted = await createApiKey(kOrg.user.organizationId, "test");
  ok("§K a key minted without a scope defaults to 'write'", defaulted.apiKey.scope === "write");
}

// ── § S · REMOVED 2026-09-02 ─────────────────────────────────────────────────────
//
// This section asserted that a stolen session could not mint an API key or a gateway
// credential without re-authenticating (audit M3.3). `requireStepUp` was removed from every
// route on our user's instruction, so the property no longer holds and a suite asserting it
// would fail rather than protect anything. Deleted instead of skipped: a commented-out
// section is one someone re-enables without re-reading why it went.
//
// To restore the control, re-wire `requireStepUp` (git history: this commit) onto
// `src/api/gateway-routes.ts` (4 routes) and the `POST /v1/api_keys` mint, then restore this
// section from the same commit. Rationale and scope: docs/PROGRESS.md.
//
// 2026-11-04: step-up is back on 2FA and passkey management ONLY (audit P2-PASSKEY). Those
// assertions live in verify:auth-identity § M. API keys and gateways stay ungated.

// ── § M · a mandated second factor, and the lockout it must NOT cause (M3.1) ─────
//
// The policy is "roles in MFA_REQUIRED_ROLES must hold a second factor". The dangerous part is
// not the refusal, it is the shape of it: the obvious implementation refuses the LOGIN, which
// locks the whole team out on the deploy that enables it, because the enrolment page is behind
// the login. So the assertions below are as much about what stays REACHABLE as what is refused.
//
// The policy is toggled by mutating `config.MFA_REQUIRED_ROLES` in-process. `roleRequiresMfa`
// reads it on every call, so this exercises the real code path — and testing both states in one
// run is the only way to know the OFF case is off because the policy is empty rather than
// because the guard never runs.
{
  const mEmail = `mfareq-${uniq}@example.com`;
  const PW = "Correct-Horse-Battery-9";
  const m = await signup({ email: mEmail, password: PW, organizationName: `MfaReq ${uniq}` });

  const asOperator = (cookie: string, url = "/v1/businesses") =>
    app.inject({ method: "GET", url, headers: { cookie: `tmb_session=${cookie}` } });

  const original = [...config.MFA_REQUIRED_ROLES];
  const setPolicy = (roles: string[]) => {
    config.MFA_REQUIRED_ROLES.length = 0;
    config.MFA_REQUIRED_ROLES.push(...roles);
  };

  // ── OFF (the shipped default) ──────────────────────────────────────────────────
  setPolicy([]);
  ok(
    "§M with no policy, an un-enrolled owner reaches /v1",
    (await asOperator(m.token)).statusCode === 200,
  );

  // ── ON, and this person is in scope ────────────────────────────────────────────
  // `signup` makes an owner, so this is the real target of the policy rather than a role
  // chosen to make the test convenient.
  setPolicy(["owner", "admin"]);
  const refusedNow = await asOperator(m.token);
  ok("§M with the policy on, an un-enrolled owner is refused /v1", refusedNow.statusCode === 403);
  // A DISTINCT type. A generic 403 gives the person no way to tell "enrol and continue" from
  // "you may never do this", and gives the dashboard nothing to route on.
  // Read defensively. If the guard regresses, the body is a 200 payload with no `error` at all,
  // and `.error.type` would THROW — taking the whole suite down and hiding every assertion after
  // it, including the anti-lockout ones. A gate that crashes instead of reporting tells you
  // something broke but not what.
  const errType = (body: string): string => {
    try {
      return (JSON.parse(body) as { error?: { type?: string } }).error?.type ?? "(no error field)";
    } catch {
      return "(unparsable)";
    }
  };
  ok(
    "§M …and told to ENROL, not merely forbidden",
    errType(refusedNow.body) === "mfa_enrollment_required",
  );

  // ── the anti-lockout half, which is the point ──────────────────────────────────
  // Everything needed to COMPLY must still answer, or the policy is a permanent outage.
  ok(
    "§M …but /auth/me still answers, so the dashboard can see why",
    (
      await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: { cookie: `tmb_session=${m.token}` },
      })
    ).statusCode === 200,
  );
  const meBody = await app.inject({
    method: "GET",
    url: "/auth/me",
    headers: { cookie: `tmb_session=${m.token}` },
  });
  ok(
    "§M …and says so in the flag the dashboard routes on",
    JSON.parse(meBody.body).mfa_enrollment_required === true,
  );
  ok(
    "§M …and the enrolment route itself is still reachable",
    (
      await app.inject({
        method: "POST",
        url: "/auth/mfa/enroll",
        headers: { cookie: `tmb_session=${m.token}` },
        payload: {},
      })
    ).statusCode < 400,
  );

  // ── enrolling clears it, with no second write ──────────────────────────────────
  const enrol = await startMfaEnrollment({ userId: m.user.userId });
  await confirmMfaEnrollment({ userId: m.user.userId, code: totp(enrol.secret) });
  ok(
    "§M once enrolled, the same session reaches /v1 again",
    (await asOperator(m.token)).statusCode === 200,
  );
  ok(
    "§M …and the flag is derived, so it cleared itself",
    JSON.parse(
      (
        await app.inject({
          method: "GET",
          url: "/auth/me",
          headers: { cookie: `tmb_session=${m.token}` },
        })
      ).body,
    ).mfa_enrollment_required === false,
  );

  // ── a role OUTSIDE the policy is untouched ─────────────────────────────────────
  setPolicy(["admin"]);
  const outEmail = `mfaout-${uniq}@example.com`;
  const out = await signup({ email: outEmail, password: PW, organizationName: `MfaOut ${uniq}` });
  // signup mints an OWNER; with the policy naming only `admin`, they must be unaffected.
  ok(
    "§M a role the policy does not name is unaffected",
    (await asOperator(out.token)).statusCode === 200,
  );

  // ── an API KEY is never asked to enrol ─────────────────────────────────────────
  // A key is not a person, has no role and cannot enrol in anything. Applying a human policy to
  // it would break every integration in the organization for no security benefit.
  setPolicy(["owner", "admin"]);
  const keyOrg = await signup({
    email: `mfakey-${uniq}@example.com`,
    password: PW,
    organizationName: `MfaKey ${uniq}`,
  });
  const viaKey = await app.inject({
    method: "GET",
    url: "/v1/businesses",
    headers: { authorization: `Bearer ${keyOrg.dashboardKeySecret}` },
  });
  ok("§M an API key is never asked to enrol", viaKey.statusCode === 200);

  setPolicy(original);
}

// ── § T · the bot challenge, and which way it fails (M3.2) ───────────────────────
//
// `forgot_password` is unauthenticated, answers identically whatever it is sent, and mails an
// address the CALLER names — so a rate limit is the only thing between it and a script mailing
// every address someone owns. §3.1 step 2 and §7.1 both ask for a challenge.
//
// The verifier is injected: a suite that reaches challenges.cloudflare.com is slow, flaky and
// fails offline, the same reasoning as the injectable breach lookup in the password policy.
{
  const ok_ = async () => true;
  const no_ = async () => false;
  const boom = async () => {
    throw new Error("cloudflare unreachable");
  };

  ok(
    "§T unconfigured is SKIPPED, not refused",
    (await verifyTurnstile("anything", "203.0.113.5", { enabled: false })) === "skipped",
  );
  ok(
    "§T a good token passes",
    (await verifyTurnstile("tok", "203.0.113.5", { enabled: true, verifier: ok_ })) === "passed",
  );
  ok(
    "§T a bad token fails",
    (await verifyTurnstile("tok", "203.0.113.5", { enabled: true, verifier: no_ })) === "failed",
  );
  ok(
    "§T a MISSING token fails when the challenge is on",
    (await verifyTurnstile(undefined, "203.0.113.5", { enabled: true, verifier: ok_ })) ===
      "failed",
  );

  // THE ONE THAT MATTERS. Configured but unreachable must REFUSE — the opposite of the HIBP
  // choice, because "make the verifier unreachable" is cheaper than solving a challenge, and a
  // control that switches itself off under pressure is not a control.
  const unavailable = await verifyTurnstile("tok", "203.0.113.5", {
    enabled: true,
    verifier: boom,
  });
  ok("§T an UNREACHABLE verifier is reported as unavailable", unavailable === "unavailable");
  ok("§T …and unavailable REFUSES (fails closed)", turnstileRefuses(unavailable));
  ok(
    "§T skipped and passed both proceed",
    !turnstileRefuses("skipped") && !turnstileRefuses("passed"),
  );

  // And the route stays a uniform 200 whatever the challenge said — a challenge that changed
  // the reply would become the enumeration oracle this route is built to avoid.
  const shapes = new Set<string>();
  for (const email of [`known-${uniq}@example.com`, `unknown-${uniq}@example.com`]) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/forgot_password",
      payload: { email },
    });
    shapes.add(`${res.statusCode}:${res.body}`);
  }
  ok("§T forgot_password still answers identically for known and unknown", shapes.size === 1);
}

// ── § U · the production boot floor ──────────────────────────────────────────────
//
// TRUST_PROXY_HOPS, PASSWORD_BREACH_CHECK and ALLOW_INSECURE_COOKIES each default to
// their LEAST-SECURE value for a good local reason, so a real host inherits an
// undefended configuration by saying nothing. `config.ts` refuses to boot in that state;
// this proves the refusal, because a boot guard nobody exercises is a comment.
//
// Driven as CHILD PROCESSES, and it has to be: this suite has already imported
// `config.ts`, whose module-level `safeParse` ran once at NODE_ENV=test and cached its
// result. Nothing in-process can re-run it, and asserting on the source text instead
// would pass with the guard deleted from the parse — the same trap §A avoids by using
// real responses rather than the header list.
{
  const execFileAsync = promisify(execFile);

  // Enough to satisfy the base schema. Zod runs `superRefine` only when the object
  // itself parses, so an incomplete env would report DATABASE_URL and never reach the
  // guard — a false PASS shaped exactly like a real one. Learned the hard way.
  const BASE = {
    DOTENV_CONFIG_PATH: "/dev/null", // else the repo's own .env answers for us
    DATABASE_URL: "postgres://verify/none",
    API_KEY_SECRET: "s".repeat(40),
    GATEWAY_CREDENTIALS_KEY: "k".repeat(40),
  };

  /** Boot `config.ts` alone in a child. Returns its stderr, or '' when it booted. */
  const boot = async (env: Record<string, string>): Promise<string> => {
    try {
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", "-e", "import('@/platform/config.ts')"],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, ...BASE, ...env } as NodeJS.ProcessEnv,
        },
      );
      return "";
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
  };

  const bare = await boot({ NODE_ENV: "production" });
  ok(
    "§U production refuses a boot that never states TRUST_PROXY_HOPS",
    bare.includes("TRUST_PROXY_HOPS"),
  );
  ok(
    "§U production refuses a boot without PASSWORD_BREACH_CHECK",
    bare.includes("PASSWORD_BREACH_CHECK"),
  );
  // Logging is on the floor because a host that never turns it on ships NOTHING and says
  // nothing — and the alert evaluator reaches a human through the sink, so monitoring
  // that cannot notify anyone looks exactly like a system with nothing to report.
  ok("§U production refuses a boot with cloud logging off", bare.includes("CLOUD_LOGGING"));

  // THE ONE THAT MATTERS. `0` must be accepted when STATED and refused when merely
  // defaulted — the whole point is telling an operator's answer from the schema's guess.
  // Without this the guard could be "require a non-zero value", which would be wrong for
  // any host whose socket really does face the internet.
  // `PROD_OK` is every floored setting satisfied — so a boot that still fails is failing
  // for the one thing the assertion is about, not for a neighbour.
  const PROD_OK = {
    NODE_ENV: "production",
    TRUST_PROXY_HOPS: "1",
    PASSWORD_BREACH_CHECK: "TRUE",
    CLOUD_LOGGING: "TRUE",
    GOOGLE_CLOUD_PROJECT_ID: "verify-project",
  };

  const statedZero = await boot({ ...PROD_OK, TRUST_PROXY_HOPS: "0" });
  ok("§U …but an explicitly stated TRUST_PROXY_HOPS=0 boots", statedZero === "");

  const insecure = await boot({ ...PROD_OK, ALLOW_INSECURE_COOKIES: "TRUE" });
  ok(
    "§U production refuses ALLOW_INSECURE_COOKIES=TRUE",
    insecure.includes("ALLOW_INSECURE_COOKIES"),
  );

  const good = await boot(PROD_OK);
  ok("§U a correctly stated production env boots", good === "");

  // The floor is about CONFIGURATION, not runtime: switching logging on without saying
  // WHERE is the other half of the same mistake, and the existing project-id guard has
  // to keep catching it now that production forces the switch on.
  const noProject = await boot({ ...PROD_OK, GOOGLE_CLOUD_PROJECT_ID: "" });
  ok(
    "§U …but logging on with no project id is still refused",
    noProject.includes("GOOGLE_CLOUD_PROJECT_ID"),
  );

  // The floor is scoped to production: it must not turn every developer's checkout into a
  // configuration exercise, which is how a guard gets deleted rather than satisfied.
  const dev = await boot({ NODE_ENV: "development" });
  ok("§U development is unaffected by the floor", dev === "");
}

// ── § P · the dashboard hands the engine the CALLER'S address, not its own ───────
//
// The dashboard is a BFF: the browser reaches Next, and Next opens a SECOND connection to
// the engine over loopback. `TRUST_PROXY_HOPS` cannot rescue that hop — a hop count chooses
// how much of `X-Forwarded-For` to believe, and on this connection there was no header at
// all — so every dashboard-originated audit row recorded `127.0.0.1`, in production, with
// nothing in the UI to suggest the value was a placeholder. An audit trail whose IP column
// is a constant is worse than one with no IP column: it reads as evidence.
//
// A SOURCE SCAN, deliberately, and it is the one thing a source scan is right for here. The
// alternative — drive a real request through Next — needs the dashboard running with a proxy
// in front, which no suite has; and the failure this guards is not a wrong value but an
// OMISSION at a new call site, which is exactly what reading every call site catches. The
// value itself is asserted by `clientIp`'s unit tests and by the engine's own hop handling.
//
// The rule: every `fetch` at the engine carries `forwardedFor()`, directly or through
// `authHeaders()` (which folds it in for all of `lib/api.ts`). Adding a call site without it
// silently reintroduces the loopback address for that route only.
{
  const ROOT = join(process.cwd(), "dashboard");
  const SKIP = new Set(["node_modules", ".next", "public", ".turbo"]);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (SKIP.has(e.name)) return [];
      const full = join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });

  // The engine's base URL has exactly two spellings in the dashboard: the module-local
  // `BASE` const, and `API_URL` re-exported from `lib/api.ts`.
  const CALL = /fetch\(\s*`\$\{(?:BASE|API_URL)\}/;
  /** A comment-only line — prose must not count toward the window below. */
  const isComment = (l: string) => /^\s*(\/\/|\/?\*)/.test(l);

  const missing: string[] = [];
  for (const file of walk(ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!CALL.test(line)) return;
      // A `fetch` init object is a handful of lines of actual CODE. Counted in code lines
      // rather than characters on purpose: several call sites carry a twenty-line note about
      // idempotency keys between `fetch(` and the header that matters, and a character
      // window reported two false misses for exactly that reason.
      const window = lines
        .slice(i, i + 40)
        .filter((l) => !isComment(l))
        .slice(0, 15)
        .join("\n");
      if (window.includes("forwardedFor()") || window.includes("authHeaders(")) return;
      missing.push(`${relative(ROOT, file)}:${i + 1}`);
    });
  }
  ok(
    `§P every dashboard→engine fetch forwards the caller's chain${missing.length ? ` — missing at ${missing.join(", ")}` : ""}`,
    missing.length === 0,
  );

  // …and forwards it UNTOUCHED. nginx appends the real peer, so the last entry is the one
  // nginx wrote and the engine's single trusted hop reads exactly that. Append our own
  // address here and the last entry becomes `127.0.0.1` again — the original bug, restored
  // by a change that looks like it is doing more of the right thing.
  const helper = readFileSync(join(ROOT, "lib/forwarded-for.ts"), "utf8");
  ok(
    "§P …verbatim: the helper emits the received chain as-is, never a built one",
    helper.includes('get("x-forwarded-for")') &&
      helper.includes('{ "x-forwarded-for": chain }') &&
      !helper.includes("${chain}"),
  );
}

await app.close();
let pass = true;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) pass = false;
}
console.log("");
console.log(pass ? "✅ SECURITY: PASS" : "❌ SECURITY: FAIL");
await closeDb();
process.exit(pass ? 0 : 1);
