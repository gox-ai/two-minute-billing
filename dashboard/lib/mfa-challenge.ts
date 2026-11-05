import { cookies } from "next/headers";
import {
  MFA_COOKIE,
  MFA_WHO_COOKIE,
  TRUSTED_BROWSER_COOKIE,
  expire,
  mfaCookieOptions,
  trustedBrowserCookieOptions,
} from "@/lib/auth-cookies";
import { REDIRECT_PARAM } from "@/lib/redirect-to";

/**
 * The second step of sign-in, shared by every door: the password form, the Google callback,
 * One Tap and invite acceptance all park the API's challenge here and send the browser to
 * `/login?mfa=1`. A plain module, not `'use server'`, so none of it becomes an endpoint.
 */
export type FirstFactor = "password" | "google";

export interface MfaChallengeBody {
  object?: string;
  challenge?: string;
  email?: string;
  auth_method?: string;
  /** A support reset is pending and will turn 2FA off at this time. */
  reset_effective_at?: string | null;
  /** Who to ask when every method is lost. Null = the deployment named nobody. */
  support_email?: string | null;
  /** How long a support reset waits for the owner to cancel it. */
  reset_wait_days?: number;
  /** The person's passkeys by name (0330); when there are any, the step opens on them. */
  passkey_names?: string[];
  /** Whether an authenticator app is set up — passkey-only people have none. */
  authenticator_app?: boolean;
}

export interface MfaWho {
  email: string;
  method: FirstFactor;
  resetEffectiveAt: string | null;
  supportEmail: string | null;
  resetWaitDays: number | null;
  /** Up to three names, for "MacBook Pro or Pixel 8". */
  passkeyNames: string[];
  authenticatorApp: boolean;
}

export function isMfaChallenge(
  json: MfaChallengeBody | undefined | null,
): json is MfaChallengeBody & { challenge: string } {
  return json?.object === "mfa_challenge" && typeof json.challenge === "string";
}

/** Store the challenge (HttpOnly) and who it belongs to, for the code step. */
export async function parkMfaChallenge(json: MfaChallengeBody & { challenge: string }) {
  const jar = await cookies();
  jar.set(MFA_COOKIE, json.challenge, mfaCookieOptions());
  jar.set(
    MFA_WHO_COOKIE,
    JSON.stringify({
      email: json.email ?? "",
      method: json.auth_method === "google" ? "google" : "password",
      resetAt: json.reset_effective_at ?? null,
      support: json.support_email ?? null,
      waitDays: typeof json.reset_wait_days === "number" ? json.reset_wait_days : null,
      // Capped: a cookie has a size limit, and the step names at most a few.
      passkeys: (json.passkey_names ?? []).slice(0, 3).map((n) => String(n).slice(0, 64)),
      app: json.authenticator_app !== false,
    }),
    mfaCookieOptions(),
  );
}

export async function clearMfaChallenge() {
  const jar = await cookies();
  jar.set(MFA_COOKIE, "", expire(mfaCookieOptions()));
  jar.set(MFA_WHO_COOKIE, "", expire(mfaCookieOptions()));
}

export async function readMfaChallenge(): Promise<{
  challenge: string | null;
  who: MfaWho | null;
}> {
  const jar = await cookies();
  const challenge = jar.get(MFA_COOKIE)?.value || null;
  let who: MfaWho | null = null;
  try {
    const raw = jar.get(MFA_WHO_COOKIE)?.value;
    if (raw) {
      const v = JSON.parse(raw) as {
        email?: string;
        method?: string;
        resetAt?: string | null;
        support?: string | null;
        waitDays?: number | null;
        passkeys?: unknown;
        app?: boolean;
      };
      who = {
        email: v.email ?? "",
        method: v.method === "google" ? "google" : "password",
        resetEffectiveAt: typeof v.resetAt === "string" ? v.resetAt : null,
        supportEmail: typeof v.support === "string" ? v.support : null,
        resetWaitDays: typeof v.waitDays === "number" ? v.waitDays : null,
        passkeyNames: Array.isArray(v.passkeys) ? v.passkeys.map(String) : [],
        authenticatorApp: v.app !== false,
      };
    }
  } catch {
    who = null;
  }
  return { challenge, who };
}

/** `/login?mfa=1`, carrying the destination when there is one (already validated by the caller). */
export function mfaStepUrl(dest: string | null, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ mfa: "1", ...extra });
  if (dest) q.set(REDIRECT_PARAM, dest);
  return `/login?${q.toString()}`;
}

/**
 * The trusted-browser cookie, as the header the API reads on its sign-in doors (0329). Empty when
 * this browser holds none, so callers can spread it unconditionally.
 */
export async function trustedBrowserHeader(): Promise<Record<string, string>> {
  const v = (await cookies()).get(TRUSTED_BROWSER_COOKIE)?.value;
  return v ? { "x-tmb-trusted-browser": v } : {};
}

/** Store the token the API minted after "Don't ask again on this browser". */
export async function storeTrustedBrowser(t: { token?: string; expires_at?: string } | undefined) {
  if (!t?.token) return;
  const until = t.expires_at ? Date.parse(t.expires_at) : NaN;
  const maxAge = Number.isFinite(until)
    ? Math.max(0, Math.floor((until - Date.now()) / 1000))
    : undefined;
  (await cookies()).set(TRUSTED_BROWSER_COOKIE, t.token, trustedBrowserCookieOptions(maxAge));
}
