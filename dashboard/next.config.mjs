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

/**
 * Hosts the storefront genuinely loads code from, enumerated rather than waved through
 * with a wildcard: payment-gateway SDKs injected at runtime by the loaders in
 * `lib/gateway-sdk.ts`, `lib/razorpay-checkout.ts` and `lib/stripe-elements.ts`. Every
 * `GATEWAY_*` list below reaches the storefront routes only (STOREFRONT_PATHS).
 *
 * Adding a gateway means adding its host here, and that is the point: the list is the
 * standing answer to "whose code runs on our origin", and it should be short enough to
 * read in one glance.
 *
 * `cdn.razorpay.com` is NOT one we load ourselves: Razorpay's `checkout.js` injects its
 * risk-detection bundle from there into OUR document as soon as the modal opens. Measured
 * over CDP against the real header — report-only logged three `script-src-elem` violations
 * for `cdn.razorpay.com/static/cx/razorpay-risk-detection/bundle.js`, so enforcing without
 * it would silently strip Razorpay's fraud signals. This is exactly why the list is closed
 * by measurement and not by reading the gateways' docs.
 */
const GATEWAY_SCRIPT_HOSTS = [
  "https://checkout.razorpay.com",
  "https://cdn.razorpay.com",
  "https://js.stripe.com",
  // Braintree Drop-in (pinned + SRI) and the hosted-fields scripts it loads.
  "https://js.braintreegateway.com",
  // Drop-in's PayPal button (PayPal JS SDK), PayPal's fraud script and Cardinal's 3D Secure
  // script (Songbird), sandbox and live. From Braintree's CSP list (client v2 best practices,
  // read 2026-10-28) and the scripts; not measured over CDP.
  "https://www.paypal.com",
  "https://www.paypalobjects.com",
  "https://c.paypal.com",
  "https://songbird.cardinalcommerce.com",
  "https://songbirdstag.cardinalcommerce.com",
  // Cardinal's current Songbird for Drop-in 1.48 (braintree-web 3.123): the gateway names its
  // URL per account. Sandbox measured 2026-10-28 (CSP blocked it); live per Braintree's notice
  // in https://github.com/braintree/braintree-web-drop-in/issues/977 (read 2026-10-28).
  "https://cas.static.client.cardinaltrusted.com",
  "https://static.client.cardinaltrusted.com",
  // Cashfree's v3 SDK (`lib/cashfree-checkout.ts`). Not yet measured over CDP.
  "https://sdk.cashfree.com",
  // Adyen Web Drop-in (pinned + SRI; one bundle for every environment). Not yet measured over CDP.
  "https://checkoutshopper-live.cdn.adyen.com",
  // Checkout.com Flow. Its docs require *.checkout.com for script, connect and frame;
  // the subdomains are not measured over CDP yet.
  "https://*.checkout.com",
  // Authorize.net AcceptUI (`lib/authorizenet-accept.ts`), sandbox and live. Not yet measured over CDP.
  "https://jstest.authorize.net",
  "https://js.authorize.net",
  // Square Web Payments SDK (`square-payments-dialog.tsx`), sandbox and live. The vendor hosts
  // below are the ones square.js and the scripts it loads name (read 2026-10-25), not measured over CDP.
  "https://sandbox.web.squarecdn.com",
  "https://web.squarecdn.com",
  // Google Pay (`pay.js`), Cash App Pay Kit, Plaid Link (ACH) and Afterpay, loaded by square.js.
  "https://pay.google.com",
  "https://kit.cash.app",
  "https://sandbox.kit.cash.app",
  "https://cdn.plaid.com",
  "https://js.squarecdn.com",
  "https://js-sandbox.squarecdn.com",
  "https://js.afterpay.com",
  "https://js.sandbox.afterpay.com",
  // CyberSource Microform: the capture context names the script; card data posts to
  // `<flex host>/flex/v2/tokens`; the number and security code are its iframes.
  "https://testflex.cybersource.com",
  "https://flex.cybersource.com",
];

/** Stylesheets a gateway SDK injects: Braintree Drop-in's own CSS. */
const GATEWAY_STYLE_HOSTS = [
  "https://assets.braintreegateway.com",
  "https://checkoutshopper-live.cdn.adyen.com",
  // Square's documented style hosts.
  "https://sandbox.web.squarecdn.com",
  "https://web.squarecdn.com",
];

/**
 * Cloudflare Turnstile (audit M3.2). One host, and it needs all three directives: a script to
 * load the widget, a frame because the challenge renders in an iframe, and connect because the
 * widget reports back.
 *
 * Listed unconditionally rather than only when a site key is configured. A CSP that changes
 * shape with an environment variable is a policy nobody can review — and naming a host that is
 * never contacted costs nothing, while forgetting one costs a challenge that silently fails to
 * render.
 */
const TURNSTILE_HOST = "https://challenges.cloudflare.com";

/**
 * Google Identity Services, for One Tap on `/login`. One host, FOUR directives: `gsi/client`
 * is a script we inject, it talks back to `accounts.google.com/gsi/`, it pulls a STYLESHEET
 * from `accounts.google.com/gsi/style`, and where FedCM is unavailable the card renders in an
 * iframe from that origin. Under FedCM the card is browser UI and outside the policy entirely —
 * which is why the frame entry must stay: it is the fallback that CSP still sees.
 *
 * `style-src` is the one that was NOT guessable, and it is the Razorpay lesson repeating: the
 * stylesheet appears nowhere in GIS's documented host list. Driving /login over CDP logged
 * `style-src-elem https://accounts.google.com/gsi/style` blocked, with the card unstyled —
 * so this list, like the gateways', is closed by measurement.
 */
const GSI_HOST = "https://accounts.google.com";
// Google Analytics, loaded on the sign-up pages only (components/signup-analytics.tsx).
const GA_SCRIPT_HOST = "https://www.googletagmanager.com";
const GA_CONNECT_HOSTS = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  GA_SCRIPT_HOST,
];

/**
 * Gateway endpoints the SDKs call. `m.stripe.network` is Stripe's fraud-signal
 * collector and `lumberjack.razorpay.com` is Razorpay's telemetry — both are load-
 * bearing for the SDK even though neither appears in our source, which is precisely
 * why this policy ships report-only until the reports say otherwise.
 */
const GATEWAY_CONNECT_HOSTS = [
  "https://api.razorpay.com",
  "https://lumberjack.razorpay.com",
  "https://api.stripe.com",
  "https://m.stripe.network",
  // Braintree: client API, GraphQL and analytics, read from a sandbox client token. The
  // production analytics host is not measured yet.
  "https://api.sandbox.braintreegateway.com",
  "https://api.braintreegateway.com",
  "https://payments.sandbox.braintree-api.com",
  "https://payments.braintree-api.com",
  "https://origin-analytics-sand.sandbox.braintree-api.com",
  // PayPal's APIs and Cardinal's 3D Secure API (Songbird), sandbox and live. Named hosts, not
  // the vendors' wildcards: connect-src stays an allow-list. Not measured over CDP yet.
  "https://www.paypal.com",
  "https://www.sandbox.paypal.com",
  "https://c.paypal.com",
  "https://centinelapi.cardinalcommerce.com",
  "https://centinelapistag.cardinalcommerce.com",
  // Songbird v2.1.0's API and device-data hosts, named in its bundles (read 2026-10-28).
  // Braintree's notice (issue #977 above) asks for *.cardinaltrusted.com; we name the hosts.
  "https://cas.client.cardinaltrusted.com",
  "https://client.cardinaltrusted.com",
  "https://geostag.cardinalcommerce.com",
  "https://0geostag.cardinalcommerce.com",
  "https://1geostag.cardinalcommerce.com",
  "https://geo.cardinalcommerce.com",
  "https://0geo.cardinalcommerce.com",
  "https://1geo.cardinalcommerce.com",
  // Songbird's logging endpoints. Its production bundle names both, with a /prod path; the
  // sandbox bundle uses the same hosts with /stag (read 2026-10-28). Exact hosts, no wildcard.
  "https://writer.cardinalcommerce.com",
  "https://kg668dbov0.execute-api.us-east-1.amazonaws.com",
  "https://sandbox.cashfree.com",
  "https://api.cashfree.com",
  // Adyen Drop-in: session calls and analytics, per environment (test, live EU, live India).
  "https://checkoutshopper-test.adyen.com",
  "https://checkoutshopper-live.adyen.com",
  "https://checkoutshopper-live-in.adyen.com",
  "https://checkoutanalytics-test.adyen.com",
  "https://checkoutanalytics-live.adyen.com",
  "https://checkoutanalytics-live-in.adyen.com",
  // Checkout.com Flow: payment sessions, risk and 3DS device data.
  "https://*.checkout.com",
  // Square: tokenization (pci-connect, documented), the hosts square.js and Cash App Pay Kit
  // call, and Afterpay's API. Read from the scripts, not measured over CDP.
  "https://pci-connect.squareupsandbox.com",
  "https://pci-connect.squareup.com",
  "https://connect.squareupsandbox.com",
  "https://connect.squareup.com",
  "https://api.squareupsandbox.com",
  "https://api.squareup.com",
  "https://sandbox.web.squarecdn.com",
  "https://web.squarecdn.com",
  "https://pay.google.com",
  // Google Pay's pay.js probes it before it shows the button (measured 2026-10-25).
  "https://google.com",
  "https://api.cash.app",
  "https://sandbox.api.cash.app",
  "https://api-plus.us.afterpay.com",
  "https://api-plus.us-sandbox.afterpay.com",
  // CyberSource Microform: the capture context names the script; card data posts to
  // `<flex host>/flex/v2/tokens`; the number and security code are its iframes.
  "https://testflex.cybersource.com",
  "https://flex.cybersource.com",
];

/**
 * Gateways a `form_post` buyer authorization submits to (`submitFormPost`). `form-action`
 * blocks the POST for any host not listed, so a form-post gateway adds its host here.
 */
const GATEWAY_FORM_HOSTS = [
  // Cashfree's SDK may leave for its hosted mandate page by form POST.
  "https://sandbox.cashfree.com",
  "https://api.cashfree.com",
  // Square's buyer verification and Adyen Web's 3DS2 challenge post their form from OUR
  // document (measured on the sandbox simulators, 2026-10-25). Live posts go to the card
  // issuer's own ACS host, which no list can name: see STOREFRONT_ISSUER_SOURCES.
  "https://api.squareupsandbox.com",
  "https://pal-test.adyen.com",
  // PayU hosted checkout. `_payment` answers 302 to the checkout app (measured on test:
  // apitest.payu.in); the live app host api.payu.in is from the docs.
  "https://test.payu.in",
  "https://apitest.payu.in",
  "https://secure.payu.in",
  "https://api.payu.in",
];

/** Fonts a gateway SDK loads into OUR document: square.js (measured 2026-10-25). */
const GATEWAY_FONT_HOSTS = [
  "https://square-fonts-production-f.squarecdn.com",
  "https://cash-f.squarecdn.com",
  "https://d1g145x70srn7h.cloudfront.net",
];

/** Gateways that render their payment sheet in an iframe on our page. */
const GATEWAY_FRAME_HOSTS = [
  "https://api.razorpay.com",
  "https://js.stripe.com",
  "https://hooks.stripe.com",
  // Braintree hosted card fields.
  "https://assets.braintreegateway.com",
  // Braintree: PayPal's checkout frames and Cardinal's 3D Secure frames, sandbox and live.
  // A live 3DS challenge frames the issuer's host: see STOREFRONT_ISSUER_SOURCES.
  "https://www.paypal.com",
  "https://www.sandbox.paypal.com",
  "https://c.paypal.com",
  "https://*.cardinalcommerce.com",
  // Songbird v2.1.0 frames its device-data and challenge pages from these (bundles, 2026-10-28).
  "https://cas.client.cardinaltrusted.com",
  "https://client.cardinaltrusted.com",
  // Cashfree's payment modal.
  "https://sandbox.cashfree.com",
  "https://api.cashfree.com",
  "https://sdk.cashfree.com",
  // Adyen secured card fields. A live 3DS challenge frames the issuer's own host: not listed.
  "https://checkoutshopper-test.adyen.com",
  // Adyen's 3DS2 challenge simulator (test only, measured 2026-10-25).
  "https://pal-test.adyen.com",
  "https://checkoutshopper-live.adyen.com",
  "https://checkoutshopper-live-in.adyen.com",
  // Checkout.com Flow card fields and 3DS challenge.
  "https://*.checkout.com",
  // Authorize.net's hosted card form (`acceptMain.html`, named in AcceptUI.js).
  "https://jstest.authorize.net",
  "https://js.authorize.net",
  // Square card fields; Google Pay, Plaid Link (ACH) and Afterpay checkout frames.
  "https://sandbox.web.squarecdn.com",
  "https://web.squarecdn.com",
  // Square's 3DS challenge frame on the sandbox simulator (measured 2026-10-25).
  "https://api.squareupsandbox.com",
  "https://pay.google.com",
  "https://cdn.plaid.com",
  // Cash App Pay Kit's frame (measured 2026-10-25: pay.js frames it into our document).
  "https://kit.cash.app",
  "https://sandbox.kit.cash.app",
  "https://checkout.us.afterpay.com",
  "https://checkout.us-sandbox.afterpay.com",
  // CyberSource Microform: the capture context names the script; card data posts to
  // `<flex host>/flex/v2/tokens`; the number and security code are its iframes.
  "https://testflex.cybersource.com",
  "https://flex.cybersource.com",
];

/**
 * `'unsafe-inline'` in `script-src` is a Next.js requirement, not a choice (`'unsafe-eval'`
 * only in development and on the storefront, see `buildCsp`) — the framework inlines its bootstrap and hydration payload, and a nonce
 * scheme needs middleware that rewrites every response. Stated plainly rather than
 * left for a reader to infer: this policy's value is in `connect-src`, `object-src`,
 * `base-uri`, `form-action` and `frame-ancestors`, NOT in `script-src`.
 *
 * That is still most of the value. SR-2026-008 Finding 7 makes the case: the cheapest
 * and most effective directive against an injection is the one that stops the payload
 * phoning home, because exfiltration is the step every data-theft chain needs and the
 * one an attacker cannot work around. A policy that blocks nothing else but pins
 * `connect-src` to our own API is already worth shipping.
 *
 * Tightening `script-src` properly means nonce middleware, and that is a separate
 * change with its own failure modes.
 */
/**
 * A live 3DS challenge (Adyen Web, Square) frames the card issuer's ACS page and posts its
 * form from OUR document. Every issuer runs its own ACS host, so storefront routes allow any
 * https host in these two directives. connect-src stays an allow-list there too, so script
 * still cannot send data to an unlisted host. The operator dashboard keeps the strict policy.
 */
const STOREFRONT_ISSUER_SOURCES = "https:";

/**
 * The routes that load a gateway SDK, and so the only ones that get the gateway hosts. Every
 * loader (`lib/gateway-sdk.ts`, `lib/razorpay-checkout.ts`, `lib/stripe-elements.ts`) is
 * imported from `app/(storefront)` alone: the checkout and portal pages. `/buy` and `/pricing`
 * are the rest of the buyer surface. `/x/:path*` also matches `/x`.
 *
 * Scoped because every host is bytes in a response header. With all gateways on every route
 * the headers passed nginx's default 4 KB `proxy_buffer_size` and the box answered 502
 * (2026-10-28). `verify:security` § C2 holds each route class to a header budget.
 */
const STOREFRONT_PATHS = ["/checkout/:path*", "/portal/:path*", "/buy/:path*", "/pricing/:path*"];

const hosts = (first, rest) => [...first, ...rest].join(" ");

const buildCsp = ({ storefront }) => {
  const gw = (list) => (storefront ? list : []);
  // Next needs eval only in development (fast refresh). The storefront keeps it for the gateway
  // SDKs, which are not all proven without it; the operator dashboard drops it in production.
  const evalSrc = storefront || process.env.NODE_ENV !== "production" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${evalSrc} ${hosts(gw(GATEWAY_SCRIPT_HOSTS), [TURNSTILE_HOST, GSI_HOST, GA_SCRIPT_HOST])}`,
    // Tailwind ships a stylesheet, but Next also inlines critical CSS.
    `style-src 'self' 'unsafe-inline' ${hosts(gw(GATEWAY_STYLE_HOSTS), [GSI_HOST])}`,
    // Merchant logos are arbitrary https URLs supplied per business; `data:` covers
    // inlined icons.
    "img-src 'self' https: data: blob:",
    `font-src ${hosts(["'self'", "data:"], gw(GATEWAY_FONT_HOSTS))}`,
    `connect-src 'self' ${hosts(gw(GATEWAY_CONNECT_HOSTS), [TURNSTILE_HOST, GSI_HOST, ...GA_CONNECT_HOSTS])}`,
    `frame-src 'self' ${hosts(gw(GATEWAY_FRAME_HOSTS), [TURNSTILE_HOST, GSI_HOST, ...gw([STOREFRONT_ISSUER_SOURCES])])}`,
    "object-src 'none'",
    // BOTH reporting directives (audit M6). `report-uri` is deprecated and still the only one
    // some browsers implement; `report-to` is current and needs the Reporting-Endpoints header
    // below. Naming one would silently collect nothing on half the fleet, and the whole point of
    // the report-only phase is learning the host list.
    "report-uri /api/csp-report",
    "report-to csp-endpoint",
    "base-uri 'self'",
    // Every form on both surfaces posts to a Next server action on this origin, except a
    // gateway's signed `form_post` (GATEWAY_FORM_HOSTS, storefront only). This is the directive
    // that stops an injected form from posting a buyer's card details or an operator's
    // credentials somewhere else.
    ["form-action 'self'", ...gw(GATEWAY_FORM_HOSTS), ...gw([STOREFRONT_ISSUER_SOURCES])].join(" "),
    // Nothing on either surface is meant to be embedded. This now enforces alongside the
    // `X-Frame-Options: DENY` header below; both stay, because XFO is what older browsers
    // honour and `frame-ancestors` is what current ones do.
    //
    // ⚠ This is a real product constraint, not just a header: it forbids embedding the hosted
    // checkout in a merchant's own page. If we ever ship an in-page iframe checkout,
    // `frame-ancestors` has to become per-business rather than 'none' — and that is a
    // decision, not a tweak.
    "frame-ancestors 'none'",
  ].join("; ");
};
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
const cspHeaderName =
  process.env.CSP_REPORT_ONLY === "TRUE"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

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
    ];
  },
  async headers() {
    // A later match overrides the same header key, so storefront routes get their own CSP.
    return [
      { source: "/:path*", headers: securityHeaders },
      ...STOREFRONT_PATHS.map((source) => ({
        source,
        headers: [{ key: cspHeaderName, value: storefrontCsp }],
      })),
    ];
  },
};
export default nextConfig;
