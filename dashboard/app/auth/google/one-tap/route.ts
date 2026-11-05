import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { forwardedFor } from "@/lib/forwarded-for";
import {
  isMfaChallenge,
  parkMfaChallenge,
  trustedBrowserHeader,
  type MfaChallengeBody,
} from "@/lib/mfa-challenge";
import {
  GOOGLE_NONCE_COOKIE,
  GOOGLE_SIGNUP_COOKIE,
  SESSION_COOKIE,
  expire,
  googleStateCookieOptions,
  sessionCookieOptions,
  signupCookieOptions,
} from "@/lib/auth-cookies";

/**
 * Google One Tap — the dashboard's half. Two methods on one route, because they are two
 * halves of one exchange and splitting them across files hid that in the code flow.
 *
 *   GET  → mint the anti-replay `nonce`, park it in an HttpOnly cookie, hand the public
 *          copy to the caller so `components/auth/google-one-tap.tsx` can seed GIS with it.
 *   POST → take the id_token GIS handed page script, send it to the API with the nonce
 *          THIS origin remembers, and store the returned session as a cookie here.
 *
 * Why the nonce is minted by a route handler and not by the login page: a server
 * component cannot set a cookie. Next only permits that in a server action or a route
 * handler, so the alternative is a nonce the browser chooses — which is not a nonce, it
 * is a value an attacker replaying a captured token would simply supply again.
 *
 * As on the code path, the session token is never in a URL. It travels in the API's
 * response body to this process and becomes an HttpOnly cookie on this origin.
 */
export const dynamic = "force-dynamic";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/** One message for every failure — see the API's `verifyGoogleOneTapToken` for why. */
const GENERIC = "We could not complete the Google sign-in. Try again.";

export async function GET() {
  const nonce = randomBytes(32).toString("base64url");
  // Same scope and lifetime as the code flow's `state`: ten minutes, path-scoped to
  // `/auth/google`, so it rides on nothing else and cannot outlive the attempt.
  (await cookies()).set(GOOGLE_NONCE_COOKIE, nonce, googleStateCookieOptions());
  return Response.json({ nonce }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const jar = await cookies();
  const nonce = jar.get(GOOGLE_NONCE_COOKIE)?.value;
  // Single-use by intent, cleared on every outcome — this is what stops a token captured
  // from page script being posted a second time while it is still within its hour.
  jar.set(GOOGLE_NONCE_COOKIE, "", expire(googleStateCookieOptions()));

  const credential = ((await req.json().catch(() => null)) as { credential?: unknown } | null)
    ?.credential;
  if (typeof credential !== "string" || !credential || !nonce) {
    return Response.json({ error: GENERIC }, { status: 400 });
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
    const res = await fetch(`${BASE}/auth/google/one-tap`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(await forwardedFor()),
        ...(await trustedBrowserHeader()),
      },
      body: JSON.stringify({ credential, nonce }),
      cache: "no-store",
    });
    okStatus = res.ok;
    json = (await res.json().catch(() => undefined)) as typeof json;
  } catch {
    return Response.json({ error: GENERIC }, { status: 502 });
  }

  // A person with 2FA: park the challenge; the component sends the browser to the code step.
  if (okStatus && isMfaChallenge(json)) {
    await parkMfaChallenge(json);
    return Response.json({ ok: true, mfa: true });
  }

  // No account yet, and sign-up is offered: carry the ticket to the sign-up form (0354).
  if (okStatus && json?.object === "google_signup" && typeof json.ticket === "string") {
    jar.set(GOOGLE_SIGNUP_COOKIE, json.ticket, signupCookieOptions());
    return Response.json({ ok: true, signup: true });
  }

  if (!okStatus || !json?.token) {
    // The API's message is forwarded when it has one, for the same reason the callback
    // route forwards it: the invite-only refusal tells the operator to ask for an invite
    // rather than to try again, and is written to reveal nothing about whether we know
    // the address.
    return Response.json({ error: json?.error?.message ?? GENERIC }, { status: 401 });
  }

  jar.set(SESSION_COOKIE, json.token, sessionCookieOptions());
  return Response.json({ ok: true });
}
