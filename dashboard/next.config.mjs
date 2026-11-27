import { fileURLToPath } from "node:url";
import { loadRootEnv } from "./root-env.mjs";

// First, before any setting below is read: the allowlisted keys from the root `.env`.
loadRootEnv();

/**
 * ── SECURITY HEADERS (W2) ────────────────────────────────────────────────────────
 * The API half lives in `src/platform/security-headers.ts`; read that file first — it
 * carries the reasoning the two share. Both halves are gated by `pnpm verify:security`
 * (§C for the API, §C2 for this file, which imports it and calls `headers()`).
 *
 * WHY THIS SURFACE MATTERS MORE THAN THE API'S. The buyer-facing storefront
 * (`app/(storefront)` — hosted checkout and the billing portal) and the operator
 * dashboard (`app/(dashboard)`) are ONE Next application on ONE origin. The operator's
 * `tmb_session` cookie is therefore in scope on every hosted page a stranger can open
 * by following a link. Framing protection and a script policy are worth more here than
 * the same two controls are worth when the surfaces are split across separate services.
 *
 * The obvious alternative — serve the storefront from its own origin — is the better
 * long-term answer and is not this change. Until then these headers are the boundary.
 */

import { STOREFRONT_PATHS, buildCsp, cspHeaderNameFor } from "./lib/csp-policy.mjs";

const csp = buildCsp({ storefront: false });
const storefrontCsp = buildCsp({ storefront: true });

/**
 * `Referrer-Policy` is load-bearing here, not boilerplate.
 *
 * The buyer's session credential currently lives in the URL path (`/portal/s/<token>`
 * before the exchange in W1 hands it to a cookie). With no policy set, the browser
 * sends the FULL URL — token included — as the `Referer` on every cross-origin
 * subresource request, and the storefront injects a gateway SDK from a third-party host
 * on exactly those pages. That is SEC-006's finding with the analytics tag swapped for
 * a payment script.
 *
 * `strict-origin-when-cross-origin` sends only the origin off-site, so the path never
 * leaves. W1 removes the token from the URL entirely; this header is what protects the
 * one request that still carries it, and every future URL nobody remembers to audit.
 */
/**
 * ENFORCING BY DEFAULT — the observation period is over. `CSP_REPORT_ONLY=TRUE` is the
 * escape hatch, not the default, because a policy nobody can accidentally leave in
 * report-only is the whole point of finishing the migration.
 *
 * ── WHAT THE OBSERVATION PERIOD ACTUALLY FOUND ──────────────────────────────────
 * A `script-src`/`connect-src` allowlist is a claim about every host a third-party SDK
 * touches at runtime, and neither Stripe's nor Razorpay's full set appears anywhere in
 * our source. So both were driven for real (Chrome over CDP, the checkout page's own
 * response header, report-only, `securitypolicyviolation` collected in-page):
 *
 *   - Stripe: card step reached, Elements mounted — seven frames including
 *     `controller-with-preconnect`, `elements-inner-easel` and `hcaptcha-invisible`.
 *     ZERO violations. Its nested `b.stripecdn.com` / `newassets.hcaptcha.com` frames
 *     are created INSIDE `js.stripe.com` documents, so Stripe's own policy governs them,
 *     not ours — which is why they need no entry here.
 *   - Razorpay: `checkout.js` loaded and its modal opened (`api.razorpay.com/v1/checkout/public`).
 *     THREE `script-src-elem` violations for
 *     `cdn.razorpay.com/static/cx/razorpay-risk-detection/bundle.js` — a host that appears
 *     in none of our code, injected into OUR document by the SDK. Enforcing before this run
 *     would have silently stripped Razorpay's fraud signals on every checkout. It is now in
 *     GATEWAY_SCRIPT_HOSTS, and a re-run came back clean.
 *
 * That single finding is the argument for having done this by measurement: it was not
 * guessable from our source, and report-only is the only mode in which it surfaces harmlessly.
 *
 * ── THE CAVEAT THAT SURVIVES ────────────────────────────────────────────────────
 * Violations were collected from the `securitypolicyviolation` DOM event, NOT from
 * `/api/csp-report`. On `http://localhost` with Chrome 148 the browser fires the event and
 * logs to the console but delivers NO report POST at all — verified with a guaranteed
 * violation and an 80s wait, while the sink itself answers correctly to a hand-rolled post.
 * So the reporting pipeline is unproven end-to-end and must be re-checked over HTTPS in
 * staging. The allowlist below does not rest on it.
 *
 * Coverage is honest, not total: the flows driven were card entry on both gateways from the
 * hosted checkout. A path nobody drove can still violate — which is why `report-uri` /
 * `report-to` stay in the policy after enforcement.
 */
const cspHeaderName = cspHeaderNameFor();

const securityHeaders = [
  { key: cspHeaderName, value: csp },
  // The destination `report-to csp-endpoint` names (audit M6). Without this header the
  // directive resolves to nothing and modern browsers report SILENTLY — which looks exactly
  // like "no violations", the most misleading possible outcome for a policy whose whole
  // purpose right now is discovering what it blocks.
  {
    key: "Reporting-Endpoints",
    value: 'csp-endpoint="/api/csp-report"',
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // `payment` is deliberately NOT denied — a gateway SDK may use the Payment Request
  // API on the storefront. The API's own policy does deny it, because nothing it
  // renders has any use for one.
  { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/**
 * HSTS is emitted only when the deployment actually serves HTTPS, mirroring
 * `secureTransport()` on the API side — a service asserting a transport guarantee it is
 * not keeping is worse than one saying nothing. Same variable name, same meaning, so
 * one `.env` line configures both halves consistently.
 *
 * No `preload`: that submits the apex domain to a browser-shipped list which is slow
 * and awkward to leave, and it belongs to whoever owns the domain.
 */
if (process.env.ALLOW_INSECURE_COOKIES !== "TRUE") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  });
}

/** @type {import('next').NextConfig} */
/**
 * The edition (lib/edition.ts): `cloud` or `self_hosted`, default `self_hosted`. Any other value
 * refuses to build or start, as the API refuses to boot: a typo must not pick an edition.
 */
const EDITION = process.env.TMBILLING_EDITION;
if (EDITION && EDITION !== "cloud" && EDITION !== "self_hosted") {
  throw new Error(`TMBILLING_EDITION must be "cloud" or "self_hosted", not "${EDITION}"`);
}

const nextConfig = {
  /**
   * Where the build lands, overridable so a deploy can build into a staging directory and
   * swap it in with a single rename. `next build` rewrites this directory IN PLACE, while the
   * running `next start` is still serving `/_next/static/<old build id>/…` out of it — so an
   * in-place rebuild 404s chunks for anyone mid-navigation for the whole length of the build.
   * Unset, this is `.next` exactly as before; `deploy/reload.sh` is the only caller that sets it.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  /**
   * The self-hosted Docker image ships Next's standalone server (`deploy/docker/Dockerfile.dashboard`).
   * Only when its build asks for it; `next start` under pm2 is unchanged.
   */
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone", outputFileTracingRoot: fileURLToPath(new URL("..", import.meta.url)) }
    : {}),
  /**
   * Next 16 writes an AGENTS.md and a CLAUDE.md into this directory on every dev start.
   * Off, for two reasons. The obvious one is that generated files reappearing in
   * `git status` are noise. The one that matters: a `dashboard/CLAUDE.md` is picked up as
   * DIRECTORY-SCOPED instructions, so a framework-authored file would silently outrank the
   * repo's own conventions for anyone working under dashboard/.
   */
  agentRules: false,

  /**
   * Shell out to the installed `tsc` binary instead of importing the compiler in-process.
   * Required by TypeScript 7, which ships no stable JavaScript compiler API — and TS 7 is
   * the point: the dashboard's typecheck went from 21.9s to seconds on the same tree.
   */
  experimental: {
    useTypeScriptCli: true,
    // proxy.ts buffers request bodies, 10 MB by default. An assistant screenshot may be
    // 10 MB, which is ~13.4 MB as base64 JSON; a cut body would reach the API malformed.
    proxyClientMaxBodySize: "15mb",
  },

  reactStrictMode: true,
  /**
   * Apple Pay's domain-association file must be served from a path Next will not serve on
   * its own: dot-directories under `public/` are not served (measured — the request falls
   * through to the app router and 307s to /login), and an app-router folder cannot be named
   * `.well-known` either. So the well-known path is rewritten onto a normal route handler.
   *
   * Without this, Stripe fetches a redirect instead of the file, the domain stays inactive,
   * and the Apple Pay button silently never appears — the exact failure the wallet-domain
   * endpoint exists to make visible.
   */
  async rewrites() {
    return [
      {
        source: "/.well-known/apple-developer-merchantid-domain-association",
        destination: "/api/apple-pay-domain-association",
      },
    ];
  },
  async redirects() {
    return [
      /**
       * `/revenue/*` → `/reports/*`. The section was called Revenue until it grew to hold the
       * dashboards AND the report catalogue; renaming the label without the path would have
       * left the two disagreeing in the address bar.
       *
       * Permanent, and kept rather than deleted: these URLs are in bookmarks and in links
       * already shared. The explorer lives at `/reports/stats`, because these are the stats — MRR, ARR and
       * the rest — and `/reports/reports` is not a path anyone should have to read.
       */
      {
        source: "/businesses/:biz/revenue/reports/:rest*",
        destination: "/businesses/:biz/reports/stats/:rest*",
        permanent: true,
      },
      {
        source: "/businesses/:biz/revenue/:rest*",
        destination: "/businesses/:biz/reports/:rest*",
        permanent: true,
      },
      {
        source: "/businesses/:biz/revenue",
        destination: "/businesses/:biz/reports",
        permanent: true,
      },
      // The sign-up page is `/signup`; the hyphenated form is a common guess and fell through to
      // the sign-in guard.
      { source: "/sign-up", destination: "/signup", permanent: true },
      { source: "/sign-up/:rest*", destination: "/signup/:rest*", permanent: true },
      // Team alerts became notifications (0533): the old settings page opens Team notifications.
      {
        source: "/businesses/:biz/settings/team-alerts",
        destination: "/settings/notifications",
        permanent: false,
      },
    ];
  },
  async headers() {
    // A later match overrides the same header key, so storefront routes get their own CSP.
    return [
      { source: "/:path*", headers: securityHeaders },
      ...STOREFRONT_PATHS.map((source) => ({
        source,
        headers: [
          { key: cspHeaderName, value: storefrontCsp },
          // A gateway's bank step runs in a popup that reports back to its sheet on this page.
          // `same-origin` cuts that link: the money is authorized and the page never hears.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      })),
      // The service worker: revalidated on every check, or an update waits on the HTTP cache.
      // CSP needs nothing: worker-src and manifest-src fall back to `'self'`.
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, max-age=0" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};
export default nextConfig;
