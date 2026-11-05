import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { REDIRECT_PARAM } from "@/lib/redirect-to";

/**
 * Third layer of dashboard authorization, beneath two that do the real work (audit H4).
 *
 * Named `proxy.ts`, not `middleware.ts`: Next 16.3 deprecates the middleware convention and
 * says so on every dev boot. Both audit documents prescribe `middleware.ts` — they were
 * written against an older Next. The behaviour is verified by curl either way (anonymous GET
 * redirects, anonymous POST 401s, /login still 200s), because a security control that
 * silently stops running is the worst outcome of a rename.
 *
 * The guards that matter are `requirePermission()` inside every server action and page —
 * this cannot replace them, because it knows only whether a cookie is PRESENT, not who it
 * belongs to or what they may do. What it adds is a floor: anything anyone forgets to
 * guard next still refuses an anonymous caller. 23 actions and 8 pages had no check at all
 * and nothing noticed for as long as they existed, and the dashboard is reachable from the
 * public internet, so a floor is worth having.
 *
 * PUBLIC BY EXCEPTION. A default-deny list is the only kind that survives new routes being
 * added — an allow-by-default matcher silently admits whatever ships next.
 */
const PUBLIC = [
  // The operator auth pages, and the /s/<token> exchange routes that live under them.
  // These are the `(auth)` route group; requiring a session to reach sign-in is circular.
  "/login",
  "/forgot-password",
  "/reset-password",
  "/invite",
  // Self-serve sandbox sign-up and its /signup/confirm/s/<token> exchange (0352).
  "/signup",
  // Cancelling a support 2FA reset, from its email. The owner may be locked out by design.
  "/two-factor-reset",
  // Confirming a team alert address (0495): the reader is often not a member at all.
  "/team-alerts",
  // Google sign-in start + callback. Outside every route group, and the callback is
  // reached by a redirect FROM Google carrying no cookie of ours by definition.
  "/auth/google",
  // The storefront. Excluded because it authenticates on its OWN cookies — tmb_portal and
  // tmb_checkout, set by its own /s/<token> exchanges — which this middleware must not
  // second-guess. Its pages already gate on readStorefrontToken.
  "/portal",
  "/checkout",
  // Public payment links and pricing pages (E2). Visitors carry no cookie at all: /buy mints
  // their checkout session and hands it to /checkout through the same cookie exchange.
  "/buy",
  "/pricing",
  // A gateway POSTs the buyer back here (cross-site, so no cookie at all); the handler
  // only answers a 303 to a same-origin path.
  "/gateway-return",
  // The subdivision list the storefront's address form fetches from the browser. It is the
  // one route those public pages call client-side, and it is reference data — ISO 3166-2
  // rows, identical for every caller, with no tenant scope to leak. A buyer has tmb_checkout,
  // never tmb_session, so it landed on the default-deny branch as a 307 to /login; `fetch`
  // followed it, got the login page's HTML with a 200, and the JSON parse threw. The dropdown
  // showed "Couldn't load the state list" on the one screen where the state is required.
  "/api/geo",
  // The CSP violation sink (audit M6). The BROWSER posts these, with no session and no CSRF
  // token — often as a fire-and-forget beacon — so requiring one means receiving nothing. This
  // proxy answered 401 and the reports vanished, which is indistinguishable from "no
  // violations": the most misleading possible outcome for a policy whose entire current purpose
  // is discovering what it blocks. The handler is written for anonymous callers — it stores
  // nothing, trusts nothing, truncates what it logs and always answers 204.
  "/api/csp-report",
  // Apple Pay's domain-association file, and the route the well-known path rewrites onto.
  // STRIPE AND APPLE FETCH IT, anonymously and by definition — it is the proof that this
  // domain is ours, so requiring a session means it can never be verified. It answers a
  // fixed, public, non-secret blob issued by Stripe (their `pspId` and signature, nothing
  // of ours) and reads no request state at all.
  //
  // This is the third place the same file was silently blocked: `public/.well-known/…` is
  // not served by Next at all, and both it and the route handler landed here as a 307 to
  // /login. A redirect is what Stripe fetches instead of the file, and the domain then
  // stays inactive with no button and no explanation.
  "/.well-known/apple-developer-merchantid-domain-association",
  "/api/apple-pay-domain-association",
];

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Prefix match with an explicit boundary: `startsWith(p + '/')` rather than
  // `startsWith(p)`, or `/logins-are-fun` would inherit `/login`'s exemption.
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }
  if (req.cookies.get(SESSION_COOKIE)?.value) {
    // Pass the pathname down to the server components (audit M3.1). `requireUser()` needs it
    // to send a mandated role to the enrolment screen WITHOUT redirecting `/account` to
    // itself, and a server component cannot otherwise see the path it is rendering for.
    //
    // `set` overwrites, so a client sending its own `x-tmb-path` cannot spoof it. Even if it
    // could, it would gain nothing: this header only steers a redirect, and the refusal itself
    // is the API's — every `/v1/*` call stays 403 until the factor is confirmed.
    const headers = new Headers(req.headers);
    headers.set("x-tmb-path", pathname);
    return NextResponse.next({ request: { headers } });
  }

  // A server action POST gets 401, not a redirect. There is no browser navigation to
  // redirect, and answering an action with the login page's HTML produces a confusing
  // failure in the client rather than a legible one.
  if (req.method === "POST") {
    return new NextResponse("Not signed in", { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  // Drop the query rather than carrying it to /login: it can hold ids and filters from the
  // tenant the visitor was NOT authenticated for.
  //
  // The PATH is carried, as `redirectTo`, so signing in lands where the visitor was going
  // instead of dumping them on the home page. It is a different kind of value from the
  // query: they just requested it, so echoing it back discloses nothing they did not have,
  // and `requirePermission()` still gates the destination when they arrive. Read only
  // through `safeRedirectTo` — the parameter is an open redirect otherwise.
  url.search = "";
  url.searchParams.set(REDIRECT_PARAM, pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Static assets and the favicon never carry a session and never need one. Everything
  // else — pages, server actions, route handlers — passes through.
  //
  // ⚠ The extension arm is load-bearing, not tidiness. `_next/static` covers files the
  // BUNDLER emits; it does not cover `public/`, which Next serves from the ROOT
  // (`public/brands/visa.svg` → `/brands/visa.svg`). Those were matching the default-deny
  // branch, so every <img> on an unauthenticated page — the Google mark on /login, the card
  // network marks on the storefront, which authenticates on its own tmb_portal cookie and
  // never has tmb_session — answered `307 → /login` and rendered as a broken image. The
  // buyer-facing surface was the worse half: it is public by design and its images were not.
  //
  // Listing extensions rather than a bare `\.` keeps the default-deny posture for routes:
  // no page, action or route handler in this app ends in one of these, so nothing that
  // needs a session can accidentally fall through by acquiring a dot in its path.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|txt|xml|webmanifest)$).*)",
  ],
};
