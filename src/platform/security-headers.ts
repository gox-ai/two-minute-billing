/**
 * Response security headers (W2) — the API half. The dashboard/storefront half is
 * `dashboard/next.config.mjs`; the two are verified together by `verify:headers`.
 *
 * ── WHY THE API NEEDS THEM AT ALL ────────────────────────────────────────────────
 * "It's a JSON API, headers are a browser concern" is the reasoning that left Two
 * Minute Reports with the middleware applied to one of five services (SR-2026-008
 * Finding 6). It is also wrong here specifically: this service returns `text/html` on
 * two routes — the print-friendly invoice (`api/invoice-routes.ts`) and the API
 * reference at `/docs`. It is a rendering origin, not only a JSON one, and the invoice
 * document interpolates merchant and customer data.
 *
 * ── WHY ONE HOOK RATHER THAN A PLUGIN ────────────────────────────────────────────
 * The set is small, the policy varies per route, and a dependency whose defaults we
 * would override on every line buys nothing. Same reasoning as `platform/rate-limit.ts`
 * being a hand-written counter rather than a limiter package.
 *
 * ── WHY `onSend` ─────────────────────────────────────────────────────────────────
 * It is the last hook before the reply is written, so it covers 4xx, 5xx, the
 * not-found envelope and redirects alike. SEC-003 §5 documents this as the single most
 * common reason a "fixed" header is still missing in production: nginx's `add_header`
 * omits the header on error responses unless marked `always`, and every framework has
 * its own version of that trap. Ours is choosing a hook that only runs on the happy
 * path. `verify:headers` asserts a 200, a 404 and a redirect for exactly this reason.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { secureTransport } from "@/platform/config";
import { INVOICE_PRINT_SCRIPT_SHA256 } from "@/modules/invoicing/ops";
import { AUTO_SUBMIT_SCRIPT_SHA256, TMTEST_FORM_POST_PATH } from "@/providers/tmtest/form-post";

/**
 * Applied to every response regardless of content type.
 *
 * `X-Frame-Options` AND `frame-ancestors` (the latter arrives in the CSP below):
 * the header is obsolete and the directive supersedes it, but the header is still what
 * older browsers honour, and shipping both costs nothing. SEC-003's remediation does
 * the same.
 */
const BASE_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  // Nothing this service renders asks for a device. `payment=()` is safe HERE and
  // deliberately absent from the storefront's policy, where a gateway SDK may use the
  // Payment Request API.
  ["permissions-policy", "geolocation=(), microphone=(), camera=(), payment=()"],
  // Belongs to the API's own origin, which hosts no cross-origin popups.
  ["cross-origin-opener-policy", "same-origin"],
];

/**
 * One year, subdomains included. NOT `preload` — that submits the apex domain to a
 * browser-shipped list that is slow and awkward to leave, and it is a decision for
 * whoever owns the domain, not for this file. Add it deliberately or not at all.
 */
const HSTS = "max-age=31536000; includeSubDomains";

/**
 * The default policy: a JSON API that renders nothing and should be able to load
 * nothing. `default-src 'none'` denies every fetch directive at once, so a response
 * that somehow reached a browser as markup can neither run script nor call home.
 *
 * `form-action 'none'` matters more than it looks — it is what stops an injected form
 * from posting a victim's data somewhere else, and it is the directive most policies
 * forget.
 */
const CSP_API = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * The print-friendly invoice. A self-contained document: an inline stylesheet, one
 * merchant logo, and one inline script that opens the print dialog.
 *
 * The script is admitted **by hash**, not by `'unsafe-inline'`. Its text is a module
 * constant in `invoicing/ops.ts`, so the hash is computed from the same string that is
 * actually served and cannot drift from it — edit the script and the hash follows in
 * the same commit or the page stops working, which is the correct failure. That is why
 * the print bar's button uses `addEventListener` inside that script rather than an
 * `onclick` attribute: an inline handler cannot be hashed without also enabling
 * `'unsafe-hashes'`, which re-opens most of what the policy is for.
 *
 * `img-src` admits `https:` and `data:` because the logo is a merchant-supplied URL on
 * a domain we do not know at build time. `style-src 'unsafe-inline'` is the one real
 * concession: the stylesheet is generated inline for a document that must survive
 * being saved to disk and printed. It carries no user input — every interpolated value
 * in that renderer goes through `esc()` — and CSS alone cannot execute script.
 */
const CSP_INVOICE_HTML = [
  "default-src 'none'",
  `script-src '${INVOICE_PRINT_SCRIPT_SHA256}'`,
  "style-src 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/**
 * `/docs` — the Scalar API reference, which is a third-party bundle from a CDN that
 * injects its own styles and fetches `/openapi.json`.
 *
 * Named explicitly rather than waved through: this is the only place in the service
 * that loads code from a host we do not control, and writing that host into a policy
 * is the difference between an accepted dependency and an unnoticed one.
 */
const CSP_DOCS = [
  "default-src 'none'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' https: data:",
  "font-src 'self' https://cdn.jsdelivr.net data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

/**
 * The TM Test Gateway's `form_post` page: one hashed script that submits one form back to
 * the storefront, so `form-action` is the one directive opened. Test businesses only.
 */
const CSP_TMTEST_FORM_POST = [
  "default-src 'none'",
  `script-src '${AUTO_SUBMIT_SCRIPT_SHA256}'`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action http: https:",
].join("; ");

/**
 * Route PATTERNS, never raw paths — `/v1/businesses/:biz/invoices/:inv/html` matches
 * every invoice, and matching on the raw path would mean matching on ids.
 */
const CSP_BY_ROUTE = new Map<string, string>([
  ["/docs", CSP_DOCS],
  ["/v1/businesses/:biz/invoices/:inv/html", CSP_INVOICE_HTML],
  [TMTEST_FORM_POST_PATH, CSP_TMTEST_FORM_POST],
]);

/** The policy for one request. Unknown route → the locked-down default. */
function cspFor(req: FastifyRequest, reply: FastifyReply): string {
  const route = req.routeOptions?.url;
  const csp = route && CSP_BY_ROUTE.get(route);
  // The test gateway's loose policy is for its auto-submit HTML page only; its JSON errors keep the strict one.
  if (
    route === TMTEST_FORM_POST_PATH &&
    !String(reply.getHeader("content-type") ?? "").startsWith("text/html")
  )
    return CSP_API;
  return csp || CSP_API;
}

/**
 * Attach the header set to every response on this instance.
 *
 * Headers are SET, not appended: a route that wrote its own copy of one of these is
 * overwritten here rather than producing two conflicting values, which is the other
 * half of the trap SEC-003 §5 describes (nginx's `add_header` appends, so a fixed
 * header and a stale upstream one both ship and the browser picks one).
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", (req: FastifyRequest, reply: FastifyReply, payload, done) => {
    for (const [name, value] of BASE_HEADERS) {
      // A route may ask for the STRICTER policy (the portal link peek); never loosen it.
      if (name === "referrer-policy" && reply.getHeader(name) === "no-referrer") continue;
      reply.header(name, value);
    }
    reply.header("content-security-policy", cspFor(req, reply));
    // Responses carry secrets (API keys, signing secrets, session tokens) and billing data:
    // no shared or browser cache keeps them unless a route chose its own policy.
    if (!reply.hasHeader("cache-control")) {
      reply.header("cache-control", "private, no-store");
      reply.header("pragma", "no-cache");
    }
    // Only where it means something. Advertising HSTS from a plain-HTTP deployment is
    // ignored by browsers, but it would also be this service asserting a guarantee it
    // is not keeping — and the cookie flag reads the same function, so the two
    // statements about the transport can never contradict each other.
    if (secureTransport()) reply.header("strict-transport-security", HSTS);
    done(null, payload);
  });
}
