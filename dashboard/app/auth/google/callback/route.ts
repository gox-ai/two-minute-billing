import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sameState } from "@/lib/google-oauth";
import { LANDING_PATH, safeRedirectTo } from "@/lib/redirect-to";
import { forwardedFor } from "@/lib/forwarded-for";
import {
  isMfaChallenge,
  mfaStepUrl,
  parkMfaChallenge,
  trustedBrowserHeader,
  type MfaChallengeBody,
} from "@/lib/mfa-challenge";
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_REDIRECT_COOKIE,
  GOOGLE_SIGNUP_COOKIE,
  SESSION_COOKIE,
  expire,
  googleStateCookieOptions,
  sessionCookieOptions,
  signupCookieOptions,
} from "@/lib/auth-cookies";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/**
 * Step 2 of Google sign-in: Google returns the browser here with a one-time `code`.
 *
 * This route validates `state` against the cookie set in `/auth/google/start`, then hands
 * the code to the API — server-to-server — which holds the client secret, exchanges it
 * with Google, checks the id-token claims and resolves the operator. The session token
 * comes back in that response BODY and is stored as an HttpOnly cookie on this origin.
 *
 * It is never in a URL. Redirecting the browser with `?token=…` would have been the same
 * CWE-598 mistake W1 and 0193 exist to undo, on the credential that matters most.
 */
export const dynamic = "force-dynamic";

/** One message for every failure — see the API's `exchangeGoogleCode` for why. */
const GENERIC = "We could not complete the Google sign-in. Try again.";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  const jar = await cookies();
  const expected = jar.get(GOOGLE_STATE_COOKIE)?.value;
  // Single-use by intent: clear it on every outcome, so a spent state cannot be matched
  // against by a later forged callback.
  jar.set(GOOGLE_STATE_COOKIE, "", expire(googleStateCookieOptions()));

  // The operator pressed Cancel on Google's screen. Not an error worth alarming them
  // about — put them back where they started.
  if (googleError)
    redirect("/login?error=" + encodeURIComponent("The Google sign-in was cancelled"));

  // A missing code, a missing cookie and a mismatched state all land here. The mismatch
  // is the interesting one — it is what CSRF looks like — but the browser learns nothing
  // that would help someone tune an attack.
  if (!code || !state || !expected || !sameState(state, expected)) {
    redirect("/login?error=" + encodeURIComponent(GENERIC));
  }

  let json:
    | (MfaChallengeBody & {
        token?: string;
        object?: string;
        ticket?: string;
        error?: { message?: string };
      })
    | undefined;
  let okStatus = false;
  try {
    const res = await fetch(`${BASE}/auth/google/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await forwardedFor()),
        ...(await trustedBrowserHeader()),
      },
      body: JSON.stringify({ code }),
      cache: "no-store",
    });
    okStatus = res.ok;
    json = (await res.json().catch(() => undefined)) as typeof json;
  } catch {
    redirect("/login?error=" + encodeURIComponent(GENERIC));
  }

  // Google proved the first factor; a person with 2FA finishes at the code step.
  if (okStatus && isMfaChallenge(json)) {
    await parkMfaChallenge(json);
    const next = safeRedirectTo(jar.get(GOOGLE_REDIRECT_COOKIE)?.value);
    jar.set(GOOGLE_REDIRECT_COOKIE, "", expire(googleStateCookieOptions()));
    redirect(mfaStepUrl(next));
  }

  // A verified Google address with no account, on a deployment that offers sign-up: carry
  // the signed ticket to the sign-up form (0354).
  if (okStatus && json?.object === "google_signup" && typeof json.ticket === "string") {
    jar.set(GOOGLE_SIGNUP_COOKIE, json.ticket, signupCookieOptions());
    redirect("/signup");
  }

  if (!okStatus || !json?.token) {
    // The API's own message is forwarded when it has one, because the invite-only
    // refusal ("no account is linked to that Google address") is genuinely actionable —
    // it tells the operator to ask for an invite rather than to try again. It is written
    // to reveal nothing about whether the address is known to us.
    redirect("/login?error=" + encodeURIComponent(json?.error?.message ?? GENERIC));
  }

  jar.set(SESSION_COOKIE, json.token, sessionCookieOptions());

  /**
   * Land where the visitor was headed before the sign-in wall, if `/auth/google/start`
   * stashed it. Re-validated here rather than trusted: this is a cookie, and a cookie is
   * exactly as untrusted as a query parameter once anything on the origin can set one.
   * Cleared either way — it belongs to this attempt and nothing after it.
   */
  const dest = safeRedirectTo(jar.get(GOOGLE_REDIRECT_COOKIE)?.value);
  jar.set(GOOGLE_REDIRECT_COOKIE, "", expire(googleStateCookieOptions()));
  redirect(dest ?? LANDING_PATH);
}
