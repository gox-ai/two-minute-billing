import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { REDIRECT_PARAM, safeRedirectTo } from "@/lib/redirect-to";
import {
  GOOGLE_STATE_COOKIE,
  GOOGLE_REDIRECT_COOKIE,
  googleConfig,
  stateCookieOptions,
  expire,
} from "@/lib/google-oauth";

/**
 * Step 1 of Google sign-in: mint the CSRF `state`, park it in an HttpOnly cookie on this
 * origin, and hand the browser to Google's consent screen.
 *
 * `state` lives here rather than on the API because it belongs to whoever STARTED the
 * flow, and that is this origin — the browser will come back to `/auth/google/callback`
 * on this host, and only a cookie set here will be sent with it.
 *
 * Without it the flow is CSRF-able in a way that is easy to miss: an attacker completes
 * a Google sign-in as themselves, captures the resulting callback URL, and gets a
 * victim to visit it — logging the victim into the ATTACKER's account, where everything
 * the victim then does is visible to them.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const cfg = await googleConfig();
  // Unconfigured deployments have no button to press, but the route can still be
  // reached by hand. Send them back rather than to a Google error page.
  if (!cfg) redirect("/login?error=" + encodeURIComponent("Google sign-in is not configured"));

  const state = randomBytes(32).toString("base64url");
  const jar = await cookies();
  jar.set(GOOGLE_STATE_COOKIE, state, stateCookieOptions());

  // Where the visitor was going, if the login page passed it on. Validated on the way
  // IN as well as on the way out: a rejected value simply means they land home.
  const dest = safeRedirectTo(new URL(req.url).searchParams.get(REDIRECT_PARAM));
  if (dest) jar.set(GOOGLE_REDIRECT_COOKIE, dest, stateCookieOptions());
  else jar.set(GOOGLE_REDIRECT_COOKIE, "", expire(stateCookieOptions()));

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  // `openid email profile` and nothing more. We need to know WHO this is; asking for
  // mail or drive access would be a consent screen that alarms operators and a token
  // worth stealing.
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  // No offline access, so Google issues no refresh token. Holding a long-lived
  // credential to someone's Google account would serve no purpose this feature has.
  url.searchParams.set("access_type", "online");
  // Re-show the chooser rather than silently reusing whichever account the browser is
  // signed into — what an operator switching between work and personal expects.
  url.searchParams.set("prompt", "select_account");
  redirect(url.toString());
}
