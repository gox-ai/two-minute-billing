/**
 * Where an unauthenticated visitor was headed, carried through sign-in.
 *
 * ── Why this is a validator and not just a string ─────────────────────────────
 * A `?redirectTo=` the app follows after login is the textbook OPEN REDIRECT: send
 * someone `/login?redirectTo=https://evil.example/harvest`, they sign in for real,
 * and we bounce them off-site with the sign-in they just completed as the pretext.
 * So nothing reads the parameter directly — every consumer goes through
 * {@link safeRedirectTo}, which returns a same-origin PATH or nothing at all.
 *
 * The rejections are specific, because each is a way a "starts with /" check
 * alone gets fooled:
 *   · `//evil.example` is protocol-relative — a browser treats it as absolute.
 *   · `/\evil.example` and `/\/evil.example` are normalised to `//` by some
 *     browsers, so a backslash is a scheme-relative host in disguise.
 *   · `/login?x=https://…` embedding a scheme is fine as a path, but pointing back
 *     at an auth route is a redirect loop, not a destination.
 *
 * ── What is carried ───────────────────────────────────────────────────────────
 * The path AND its query, so the visitor returns to the same tab and filters (user
 * decision 2026-11-15; until then only the path was carried). It is the visitor's own
 * request echoed back to them, and `requirePermission()` still gates the destination
 * once they arrive: if they may not see it, they get the usual refusal.
 */

export const REDIRECT_PARAM = "redirectTo";

/** The default post-sign-in landing; `app/start/route.ts` picks the page. */
export const LANDING_PATH = "/start";

/** Auth routes are never a post-login destination — landing there is a loop. */
const AUTH_PATHS = ["/login", "/forgot-password", "/reset-password", "/invite", "/auth/"];

/**
 * A same-origin path safe to redirect to after sign-in, or `null`.
 *
 * @param raw the untrusted value — a query parameter or a form field.
 */
export function safeRedirectTo(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // A long value is either a mistake or an attempt; either way it is not a path
  // this app serves.
  if (raw.length > 2048) return null;

  // Control characters (including an encoded newline that survived decoding) can
  // split a header downstream. Nothing legitimate here contains one.
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;

  if (!raw.startsWith("/")) return null;
  // protocol-relative, and the backslash disguises of it
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (raw.includes("\\")) return null;
  // a scheme anywhere means this is not the path it claims to be
  if (raw.includes("://")) return null;

  const path = raw.split(/[?#]/)[0] ?? "";
  if (AUTH_PATHS.some((p) => path === p || path.startsWith(p))) return null;

  return raw;
}
