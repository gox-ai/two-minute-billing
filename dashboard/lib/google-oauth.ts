import { timingSafeEqual } from "node:crypto";
import { forwardedFor } from "@/lib/forwarded-for";

// Cookie names and attributes live in one place — see lib/auth-cookies.ts.
export {
  GOOGLE_STATE_COOKIE,
  GOOGLE_REDIRECT_COOKIE,
  googleStateCookieOptions as stateCookieOptions,
  expire,
} from "@/lib/auth-cookies";

/**
 * The dashboard's half of Google sign-in (0194). The engine's half — the code exchange
 * and the id-token claim checks — is `src/api/google-oauth.ts`, and its header explains
 * why the work splits where it does.
 *
 * Short version: `state` belongs to whoever started the flow, so it lives on THIS origin;
 * the client SECRET belongs to the API and never comes near this process; and the session
 * token travels once, in a server-to-server response body, never in a URL.
 */

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/**
 * The two PUBLIC values needed to build the consent URL (the client SECRET never comes
 * near this process).
 *
 * Read from this process's env first, so the sign-in page renders the Google button
 * without a round trip to the API. Both values must match the API's `GOOGLE_CLIENT_ID`
 * and `GOOGLE_REDIRECT_URI` exactly — the API exchanges the code with its own copies.
 * When they are unset, ask the API (`GET /auth/google`).
 *
 * Null on any failure, which hides the button: a button that cannot work is worse than
 * none.
 */
export async function googleConfig(): Promise<{ clientId: string; redirectUri: string } | null> {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const redirectUri = process.env.NEXT_PUBLIC_GOOGLE_REDIRECT_URI;
  if (clientId && redirectUri) return { clientId, redirectUri };
  try {
    const res = await fetch(`${BASE}/auth/google`, {
      headers: await forwardedFor(),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      enabled?: boolean;
      client_id?: string;
      redirect_uri?: string;
    };
    return j.enabled && j.client_id && j.redirect_uri
      ? { clientId: j.client_id, redirectUri: j.redirect_uri }
      : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison of two ASCII strings that may differ in length.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is checked first — that
 * check is not itself constant-time, but a length difference is not the secret here: the
 * state is a fixed-width random value, so any candidate of the wrong length is already
 * wrong for a reason an attacker can see without timing anything.
 */
export function sameState(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
