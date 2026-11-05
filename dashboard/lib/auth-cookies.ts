/**
 * Every cookie the dashboard's auth surface sets, and the attributes they share.
 *
 * ── WHY ONE FILE ────────────────────────────────────────────────────────────────
 * The `secure` expression was written out by hand in four places before this existed:
 * the session store, the Google callback, the OAuth state cookie and the reset-link
 * exchange. Four copies of one deployment fact is how the API ended up sending HSTS
 * while the cookie the browser actually held had no `Secure` at all — the W4 defect,
 * repeated. One definition, so they cannot drift.
 *
 * ── WHY `Secure` READS AN OPT-OUT ───────────────────────────────────────────────
 * `ALLOW_INSECURE_COOKIES` is the same variable the API's `secureTransport()` reads, so
 * one `.env` line configures both halves. It is an opt-OUT because deriving it from
 * `NODE_ENV` fails OPEN when the variable goes missing on a real host — SR-2026-008
 * Finding 2, where an entire policy hung on one string comparison.
 */

const secure = () => process.env.ALLOW_INSECURE_COOKIES !== "TRUE";

/** The operator session. Mirrors the API's `setSessionCookie` attribute for attribute. */
export const SESSION_COOKIE = "tmb_session";

/** Where `/reset-password/s/<token>` parks the reset credential. */
export const RESET_COOKIE = "tmb_reset";

/** Where `/invite/s/<token>` parks the invite credential. */
export const INVITE_COOKIE = "tmb_invite";

/** Where `/two-factor-reset/s/<token>` parks a 2FA-reset cancel token. It can only STOP a reset. */
export const MFA_RESET_COOKIE = "tmb_mfa_reset";
/** Self-serve sign-up (0354): the emailed confirmation token, and a pending Google identity. */
export const SIGNUP_CONFIRM_COOKIE = "tmb_signup_confirm";
/** A staff-sent sign-up link while sign-up is locked (0405), parked by `/signup/invite/s/<token>`. */
export const SIGNUP_INVITE_COOKIE = "tmb_signup_invite";
export const GOOGLE_SIGNUP_COOKIE = "tmb_google_signup";

/** CSRF `state` for the Google flow, set by `/auth/google/start`. */
export const GOOGLE_STATE_COOKIE = "tmb_oauth_state";

/**
 * Anti-replay `nonce` for the One Tap flow, set by `GET /auth/google/one-tap`.
 *
 * The code flow's `state` and this are different jobs and deliberately different cookies.
 * `state` proves the CALLBACK belongs to a flow this origin started; the nonce proves the
 * TOKEN does — it is sealed into the id_token by Google, and the API refuses a token whose
 * nonce is not the one held here. A Google id_token stays valid for about an hour and, on
 * this path, page script gets to see it, so "this token has been used already" has to be
 * answerable. The POST handler clears the cookie, which is what makes it single-use.
 *
 * HttpOnly even though the nonce is public by construction (it travels to Google through
 * the browser): page script has the value already: what it must not be able to do is
 * REWRITE the copy we compare against.
 */
export const GOOGLE_NONCE_COOKIE = "tmb_onetap_nonce";

/**
 * Where the visitor was headed, held across the Google round trip.
 *
 * A cookie and not a `state` payload: `state` is compared for equality as the CSRF
 * check, and widening it into a structure to smuggle a path through would put an
 * attacker-influenced value inside the one field whose whole job is being opaque and
 * matched exactly.
 *
 * Same scope and lifetime as the state it travels with, so it cannot outlive the
 * attempt or be read anywhere else. HttpOnly: page script has no use for it, and the
 * callback validates it through `safeRedirectTo` regardless — a cookie is as
 * untrusted as a query parameter once anything can set it.
 */
export const GOOGLE_REDIRECT_COOKIE = "tmb_oauth_redirect";

/**
 * Carries the MFA challenge between the password step and the code step (audit M3).
 *
 * HttpOnly, and scoped to `/login` like the reset and invite cookies: it stands for "this
 * password was correct" and is useless without the second factor, but it is still a partial
 * credential and page script has no business reading it. Short — the API expires the challenge
 * in five minutes regardless; this is belt to that braces.
 */
export const MFA_COOKIE = "tmb_mfa";

/** Who is signing in and with what first factor, for the code step's chip. Display only. */
export const MFA_WHO_COOKIE = "tmb_mfa_who";

/**
 * Freshly minted recovery codes, carried from the action to the one screen that shows them.
 * They exist in readable form nowhere else; HttpOnly, path-scoped to /account, ten minutes.
 */
export const MFA_CODES_COOKIE = "tmb_mfa_codes";

/**
 * "Don't ask again on this browser for 30 days" (0329). The raw token the API minted; only its
 * hash is stored server-side. Path `/` because every sign-in door reads it — the password form,
 * the Google callback, One Tap and invite acceptance — and Lax still reaches the Google callback,
 * which is a top-level GET navigation.
 */
export const TRUSTED_BROWSER_COOKIE = "tmb_tb";
export const mfaCodesCookieOptions = () => ({ ...base(), path: "/account", maxAge: 600 });

/**
 * `SameSite=Lax` throughout, and it is doing real work rather than being a default:
 * it withholds these cookies on a cross-site POST, which is CSRF protection for every
 * state-changing route on this origin without a token scheme. `Strict` is wrong for all
 * three — each is read after a top-level navigation the browser began somewhere else
 * (an emailed link, Google's consent screen), and `Strict` withholds the cookie on
 * exactly that first request.
 */
const base = () => ({ httpOnly: true, secure: secure(), sameSite: "lax" as const });

/** Seven days, matching the API's session TTL. */
export const sessionCookieOptions = () => ({ ...base(), path: "/", maxAge: 7 * 24 * 3600 });

/**
 * Ten minutes, and path-scoped to the one page that reads it. Long enough to choose a
 * password; this only has to survive the walk from the inbox to the form. The TOKEN's
 * own life is the real bound, and the server is its authority.
 */
export const resetCookieOptions = () => ({ ...base(), path: "/reset-password", maxAge: 600 });

/** Scoped to the cancel page; an hour, since the owner may read the email and click later. */
export const mfaResetCookieOptions = () => ({ ...base(), path: "/two-factor-reset", maxAge: 3600 });

/** Team alert address confirmation (0495): the parked token, and "confirmed" for the page. */
export const TEAM_ALERT_CONFIRM_COOKIE = "tmb_team_alert_confirm";
export const TEAM_ALERT_DONE_COOKIE = "tmb_team_alert_done";
export const teamAlertCookieOptions = () => ({ ...base(), path: "/team-alerts", maxAge: 900 });

/** Same shape as the reset cookie, scoped to the invite page. */
export const inviteCookieOptions = () => ({ ...base(), path: "/invite", maxAge: 600 });
/** Scoped to the sign-up pages; fifteen minutes, the life of the API's Google ticket. */
export const signupCookieOptions = () => ({ ...base(), path: "/signup", maxAge: 900 });
export const mfaCookieOptions = () => ({ ...base(), path: "/login", maxAge: 300 });
export const trustedBrowserCookieOptions = (maxAge = 30 * 24 * 3600) => ({
  ...base(),
  path: "/",
  maxAge,
});

/** Ten minutes, path-scoped to the flow so it rides on nothing else. */
export const googleStateCookieOptions = () => ({ ...base(), path: "/auth/google", maxAge: 600 });

/** Clearing must repeat the SET's scope, or the browser keeps the original cookie. */
export const expire = <T extends { path: string }>(opts: T) => ({ ...opts, maxAge: 0 });

/** HubSpot install: `<state>.<business>`, path-scoped to the flow like the Google one. */
export const HUBSPOT_STATE_COOKIE = "tmb_hubspot_state";
export const hubspotStateCookieOptions = () => ({
  ...base(),
  path: "/integrations/hubspot",
  maxAge: 600,
});
