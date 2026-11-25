/**
 * Buyer session credentials, held in an HttpOnly cookie rather than the URL (W1).
 *
 * ── WHAT THIS REPLACES AND WHY ───────────────────────────────────────────────────
 * The portal and hosted checkout used to carry their session token as a URL PATH
 * SEGMENT — `/portal/<token>`, `/checkout/<token>`. That is CWE-598, the finding
 * that lets a 24-hour email-verification token reach Google Analytics through the
 * page URL. Ours was worse in one respect: the value in
 * the URL was not a verification token that grants one action, it was the session
 * itself, valid for 72 hours.
 *
 * A URL is not a private place. It leaves through at least four doors:
 *   1. the `Referer` header on every cross-origin subresource — and the storefront
 *      injects a payment-gateway SDK from a third-party host on exactly these pages,
 *      so the token was being handed to Razorpay and Stripe on every card entry;
 *   2. browser history, and whatever syncs it between a buyer's devices;
 *   3. the access log of every proxy, CDN and load balancer in front of the app;
 *   4. the buyer forwarding "the billing page" to a colleague, which hands over their
 *      whole session rather than a link to it.
 *
 * The exchange closes all four at once. The emailed link points at
 * `/portal/s/<token>`, whose only job is to move the token from the URL into a cookie
 * and redirect to a clean path. Every page the buyer actually spends time on — where
 * the gateway scripts load, where the address bar is read, where the URL gets copied —
 * has no credential in it.
 *
 * ── THE TOKEN NEVER REACHES THE BROWSER'S JAVASCRIPT EITHER ──────────────────────
 * The cookie is `HttpOnly`, and the server actions on these surfaces read it here
 * rather than accepting it as an argument or a hidden form field. So the credential
 * exists in exactly two places: this cookie, and the server. It is not in the URL, not
 * in the DOM, and not reachable from script — which means an injection on these pages
 * cannot steal the session even if one lands.
 *
 * ── PORTAL: THE LINK IS NOW A ONE-TIME TICKET (0193) ─────────────────────────────
 * The first version of this stopped short: the value in the link was still the session
 * itself, reusable for 72 hours. It is not any more. A portal link carries a `pstk_…`
 * ENTRY credential that is good for one hour and is spent by `POST /portal/v1/session`,
 * which mints the `psst_…` session this cookie actually holds.
 *
 * Single-use was rejected the first time for a real reason — mail clients and security
 * scanners PREFETCH links, so a one-time link is routinely burned before the human
 * clicks. That objection is about EMAILED links. Portal sessions are opened through the
 * API: an integration mints one and redirects a user it has already authenticated,
 * which is never prefetched. The hazard does not apply to the path we use.
 *
 * ⚠ It DOES apply to any emailed link, which is why there is no longer a self-serve one:
 * `/portal/request` and `POST /portal/v1/request_link` were deleted on 2026-08-30 rather
 * than left reachable. The answer for the emailed case is a one-time PASSWORD the
 * customer types, not a link, precisely because typing cannot be prefetched. The argument
 * in full is in `src/modules/customer-portal/README.md` § "Self-serve access".
 *
 * ── CHECKOUT: STILL A REUSABLE LINK ──────────────────────────────────────────────
 * Stated plainly rather than left to be discovered, because an unstated residual is how
 * SR-2026-015 Finding 4 happened. The checkout link is still the session, still good for
 * `CHECKOUT_SESSION_TTL_HOURS` (24h by default). Making it one-time is a product
 * decision (a buyer returning to an abandoned checkout is ordinary and worth money),
 * not just a schema change — see `enterCheckout` in `lib/checkout-entry.ts`.
 */
import { cookies } from "next/headers";

/** Portal and checkout hold SEPARATE cookies on separate paths. */
export const PORTAL_COOKIE = "tmb_portal";
export const CHECKOUT_COOKIE = "tmb_checkout";

export type StorefrontSurface = "portal" | "checkout";

const SURFACES = {
  portal: { cookie: PORTAL_COOKIE, path: "/portal" },
  checkout: { cookie: CHECKOUT_COOKIE, path: "/checkout" },
} as const;

/**
 * An upper bound on how long either surface's cookie sits in the jar — not a claim that
 * it matches both session TTLs exactly, because the SERVER is the authority on expiry:
 * it refuses an expired token whatever the browser still holds, and the page renders
 * its "this link has expired" card off that refusal. This value only stops a dead
 * cookie loitering in the jar for months after it stopped meaning anything.
 *
 * Set to the LONGER of the two real session lifetimes so it never clips a still-valid
 * one: the portal's `PORTAL_SESSION_TTL_MS` is a fixed 72h. Checkout's is shorter and
 * configurable (`CHECKOUT_SESSION_TTL_HOURS`, default 24h — see `platform/config.ts`),
 * so its cookie will typically outlive its session by tens of hours. That is the
 * harmless loitering described above, not a widened window: the server still refuses
 * the checkout token once ITS OWN, shorter TTL passes.
 */
const SESSION_TTL_SECONDS = 72 * 3600;

/**
 * `Secure` reads the same variable the API's `secureTransport()` does, so one `.env`
 * line configures both halves and the two cannot disagree about the transport.
 *
 * `SameSite=Lax` rather than `Strict`: the buyer arrives here by following a link from
 * an email client, and `Strict` withholds the cookie on that first cross-site
 * navigation — the buyer would land on the portal logged out, click again, and be let
 * in, which reads as a broken link. `Lax` sends it on a top-level GET (this) and
 * withholds it on a cross-site POST (CSRF), which is the distinction we actually want.
 *
 * `Path` scopes each surface to its own tree, so a checkout page never receives the
 * portal's credential and neither reaches the operator dashboard's routes.
 */
function cookieAttrs(surface: StorefrontSurface) {
  return {
    httpOnly: true,
    secure: process.env.ALLOW_INSECURE_COOKIES !== "TRUE",
    sameSite: "lax" as const,
    path: SURFACES[surface].path,
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * Store the buyer's SESSION token in the cookie. Called by the entry route handlers
 * after they have obtained one.
 *
 * For the portal (0193) the caller first spends a single-use entry credential at
 * `POST /portal/v1/session` and passes the session token it minted — so what lands in
 * this cookie was never in a URL. For checkout the URL token is still the session
 * itself (`lib/checkout-entry.ts`).
 */
export async function setStorefrontToken(surface: StorefrontSurface, token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SURFACES[surface].cookie, token, cookieAttrs(surface));
}

/**
 * The buyer's token for this surface, or null when there is no session cookie.
 *
 * Every data fetch and every server action on the storefront goes through this. A null
 * here is an ordinary state, not an error — it is what a buyer sees when the cookie has
 * expired or they opened the path directly — and the callers render the "ask for a new
 * link" card rather than throwing.
 */
export async function readStorefrontToken(surface: StorefrontSurface): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SURFACES[surface].cookie)?.value ?? null;
}

/**
 * ── ONE COOKIE PER SESSION, TOO ─────────────────────────────────────────────────
 * `tmb_checkout` / `tmb_portal` hold the LAST link opened, so two tabs in one browser share
 * it: the older tab's actions used to act on the newer tab's session (a buyer was charged
 * twice this way on checkout). The entry routes therefore bind each token to its own
 * session (`<cookie>_<session>`), the page names that session in `?s=`, and every call reads
 * the binding first. The API refuses a token for another session (`X-Checkout-Session`,
 * `X-Portal-Session`), so a tab without a binding fails closed instead of acting elsewhere.
 */
const SESSION_ID: Record<StorefrontSurface, RegExp> = {
  checkout: /^cosess_[A-Za-z0-9]{1,64}$/,
  portal: /^psess_[A-Za-z0-9]{1,64}$/,
};
const boundCookie = (surface: StorefrontSurface, session: string) =>
  `${SURFACES[surface].cookie}_${session}`;

/** The token for one session: its own binding, else the latest link opened. */
export async function readSessionToken(
  surface: StorefrontSurface,
  session: string | null | undefined,
): Promise<string | null> {
  const jar = await cookies();
  const bound =
    session && SESSION_ID[surface].test(session)
      ? jar.get(boundCookie(surface, session))?.value
      : null;
  return bound || (jar.get(SURFACES[surface].cookie)?.value ?? null);
}

/** Keep `token` for `session`. The caller has checked with the API that it opens that session. */
export async function bindSessionToken(
  surface: StorefrontSurface,
  session: string,
  token: string,
): Promise<void> {
  if (!SESSION_ID[surface].test(session)) return;
  const jar = await cookies();
  if (jar.get(boundCookie(surface, session))?.value === token) return;
  jar.set(boundCookie(surface, session), token, cookieAttrs(surface));
}

/** Drop one session's binding (sign-out). */
export async function clearSessionToken(surface: StorefrontSurface, session: string) {
  if (!SESSION_ID[surface].test(session)) return;
  const jar = await cookies();
  jar.set(boundCookie(surface, session), "", { ...cookieAttrs(surface), maxAge: 0 });
}

export const readCheckoutToken = (session: string | null | undefined) =>
  readSessionToken("checkout", session);
export const bindCheckoutToken = (session: string, token: string) =>
  bindSessionToken("checkout", session, token);

/** Drop the cookie — used when the server has told us the session is no longer valid. */
export async function clearStorefrontToken(surface: StorefrontSurface): Promise<void> {
  const jar = await cookies();
  jar.set(SURFACES[surface].cookie, "", { ...cookieAttrs(surface), maxAge: 0 });
}

/**
 * Which business the buyer last reached the portal for — NOT a credential, just a public
 * business id, so the "can't get in" card can show that business's own message once the
 * session is gone. Outlives the session on purpose.
 */
const PORTAL_BUSINESS_COOKIE = "tmb_portal_biz";
const PORTAL_BUSINESS_TTL_SECONDS = 400 * 24 * 3600;

export async function rememberPortalBusiness(businessId: string): Promise<void> {
  const jar = await cookies();
  jar.set(PORTAL_BUSINESS_COOKIE, businessId, {
    ...cookieAttrs("portal"),
    maxAge: PORTAL_BUSINESS_TTL_SECONDS,
  });
}

export async function readPortalBusiness(): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(PORTAL_BUSINESS_COOKIE)?.value ?? "";
  return /^biz_[A-Za-z0-9]+$/.test(v) ? v : null;
}
