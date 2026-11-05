"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { forwardedFor } from "@/lib/forwarded-for";
import { LANDING_PATH, safeRedirectTo } from "@/lib/redirect-to";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { STEP_UP_REQUIRED, isStepUpRequired } from "@/lib/step-up";
import {
  MFA_CODES_COOKIE,
  SESSION_COOKIE,
  mfaCodesCookieOptions,
  sessionCookieOptions,
} from "@/lib/auth-cookies";
import {
  clearMfaChallenge,
  mfaStepUrl,
  readMfaChallenge,
  storeTrustedBrowser,
} from "@/lib/mfa-challenge";

/**
 * Passkeys (0330). The browser runs each ceremony with `@simplewebauthn/browser`; these actions
 * only carry the options out and the response back. The API verifies everything.
 *
 * The sign-in actions are public by necessity — they ARE the sign-in path, like `loginAction`.
 * The account actions act on the caller's own passkeys, re-checked server-side.
 */

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/** Options handed to the browser, plus the handle the response must come back with. */
export type PasskeyOptionsResult =
  | { ok: true; handle: string; options: Record<string, unknown> }
  | { ok: false; message: string; reason?: string };

/** A finished sign-in: the browser navigates to `to` (a full load, so the new cookie is read). */
export type PasskeySignInResult =
  | { ok: true; to: string }
  | { ok: false; message: string; reason?: string; to?: string };

interface ApiReply {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
  setCookie: string | null;
}

/** Private: exporting it would make it an endpoint. */
async function call(
  path: string,
  init: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown; session?: boolean } = {},
): Promise<ApiReply> {
  const token = init.session ? (await cookies()).get(SESSION_COOKIE)?.value : undefined;
  // `requireUser()` has already sent a signed-out visitor to /login; this is the race after it.
  if (init.session && !token) {
    return {
      ok: false,
      status: 401,
      json: { error: { message: "Not signed in" } },
      setCookie: null,
    };
  }
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "POST",
    headers: {
      // A bodiless write still sends `{}` — Fastify refuses an empty JSON body.
      "Content-Type": "application/json",
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...(await forwardedFor()),
    },
    body: JSON.stringify(init.body ?? {}),
    cache: "no-store",
  });
  return {
    ok: res.ok,
    status: res.status,
    json: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    setCookie: res.headers.get("set-cookie"),
  };
}

const errorOf = (r: ApiReply) =>
  (r.json as { error?: { message?: string; reason?: string; type?: string } }).error ?? {};

function options(r: ApiReply, fallback: string): PasskeyOptionsResult {
  if (r.status === 429)
    return { ok: false, message: "Too many attempts. Wait one minute. Then try again." };
  if (!r.ok && isStepUpRequired(r.json)) {
    return { ok: false, message: errorOf(r).message ?? fallback, reason: STEP_UP_REQUIRED };
  }
  if (!r.ok || typeof r.json.handle !== "string" || !r.json.options) {
    return { ok: false, message: errorOf(r).message ?? fallback };
  }
  return { ok: true, handle: r.json.handle, options: r.json.options as Record<string, unknown> };
}

async function storeSession(setCookie: string | null): Promise<boolean> {
  const token = setCookie ? /tmb_session=([^;]+)/.exec(setCookie)?.[1] : undefined;
  if (!token) return false;
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
  return true;
}

// ── sign-in ─────────────────────────────────────────────────────────────────

/** "Sign in with a passkey": options for whatever passkey the browser holds for us. */
export async function passkeySignInOptionsAction(): Promise<PasskeyOptionsResult> {
  return options(await call("/auth/passkey/options"), "We could not start the passkey sign-in.");
}

export async function passkeySignInAction(
  handle: string,
  response: unknown,
  redirectTo?: string | null,
): Promise<PasskeySignInResult> {
  const r = await call("/auth/passkey/verify", { body: { handle, response } });
  if (!r.ok) {
    const e = errorOf(r);
    if (r.status === 429)
      return { ok: false, message: "Too many attempts. Wait one minute. Then try again." };
    return {
      ok: false,
      reason: e.reason,
      message:
        e.reason === "not_found"
          ? "This passkey is not linked to an account now."
          : (e.message ?? "The passkey did not operate. Try again, or sign in with your password."),
    };
  }
  if (!(await storeSession(r.setCookie)))
    return { ok: false, message: "The sign-in did not complete. Try again." };
  return { ok: true, to: safeRedirectTo(redirectTo ?? "") ?? LANDING_PATH };
}

/** Options for the sign-in second step, bound to the challenge in this browser's cookie. */
export async function mfaPasskeyOptionsAction(): Promise<PasskeyOptionsResult> {
  const { challenge } = await readMfaChallenge();
  if (!challenge) return { ok: false, message: "This sign-in timed out.", reason: "expired" };
  return options(
    await call("/auth/login/mfa/passkey-options", { body: { challenge } }),
    "We could not start your passkey.",
  );
}

/** Finish the second step with a passkey. */
export async function mfaPasskeyLoginAction(
  handle: string,
  response: unknown,
  trustBrowser: boolean,
  redirectTo?: string | null,
): Promise<PasskeySignInResult> {
  const dest = safeRedirectTo(redirectTo ?? "");
  const { challenge } = await readMfaChallenge();
  if (!challenge) return { ok: false, message: "This sign-in timed out.", to: mfaStepUrl(dest) };
  const r = await call("/auth/login/mfa/passkey", {
    body: { challenge, handle, response, trust_browser: trustBrowser },
  });
  if (!r.ok) {
    const e = errorOf(r);
    if (r.status === 429)
      return { ok: false, message: "Too many attempts. Wait one minute. Then try again." };
    // The sign-in itself lapsed: the page's "timed out" view says what to do.
    if (r.status === 401 && /expired/i.test(e.message ?? "")) {
      await clearMfaChallenge();
      return { ok: false, message: "This sign-in timed out.", to: mfaStepUrl(dest) };
    }
    return {
      ok: false,
      reason: e.reason,
      message: e.message ?? "The passkey did not operate. Try again, or use a different method.",
    };
  }
  if (!(await storeSession(r.setCookie)))
    return { ok: false, message: "The sign-in did not complete. Try again." };
  await clearMfaChallenge();
  await storeTrustedBrowser(
    r.json.trusted_browser as { token?: string; expires_at?: string } | undefined,
  );
  return { ok: true, to: dest ?? LANDING_PATH };
}

// ── the signed-in person's passkeys ─────────────────────────────────────────

export async function passkeyRegistrationOptionsAction(): Promise<PasskeyOptionsResult> {
  await requireUser();
  return options(
    await call("/auth/mfa/passkeys/options", { session: true }),
    "We could not start to add a passkey.",
  );
}

export type AddPasskeyResult =
  | { ok: true; passkey: { id: string; name: string }; turnedOn: boolean }
  | { ok: false; message: string; reason?: string };

/**
 * Store the new passkey. When it is the first method the API turns 2FA on and returns recovery
 * codes once; they go to the same reveal panel the authenticator app's setup uses.
 */
export async function addPasskeyAction(
  handle: string,
  response: unknown,
): Promise<AddPasskeyResult> {
  await requireUser();
  const r = await call("/auth/mfa/passkeys", { session: true, body: { handle, response } });
  if (!r.ok) {
    const e = errorOf(r);
    return {
      ok: false,
      reason: isStepUpRequired(r.json) ? STEP_UP_REQUIRED : e.reason,
      message: e.message ?? "The browser did not make the passkey. Try again.",
    };
  }
  const codes = r.json.recovery_codes;
  const turnedOn = Array.isArray(codes) && codes.length > 0;
  if (turnedOn) {
    (await cookies()).set(MFA_CODES_COOKIE, JSON.stringify(codes), mfaCodesCookieOptions());
  }
  // No revalidatePath: re-rendering now would swap the card for the codes panel and unmount the
  // dialog before its "Name it" step. The dialog refreshes the page when it closes.
  const p = r.json.passkey as { id: string; name: string };
  return { ok: true, passkey: { id: p.id, name: p.name }, turnedOn };
}

export async function renamePasskeyAction(id: string, name: string): Promise<ActionResult> {
  await requireUser();
  const trimmed = name.trim();
  if (!trimmed)
    return actionError("Give the passkey a name.", {
      errors: { name: "Give the passkey a name." },
    });
  const r = await call(`/auth/mfa/passkeys/${encodeURIComponent(id)}`, {
    method: "PATCH",
    session: true,
    body: { name: trimmed.slice(0, 64) },
  });
  if (!r.ok) return actionError(errorOf(r).message ?? "We could not save the name. Try again.");
  revalidatePath("/account");
  return actionOk("Passkey renamed");
}

/** Shared by both removals. `confirmTurnOff` is set only when the dialog said this turns 2FA off. */
async function removeMethod(
  path: string,
  confirmTurnOff: boolean,
  done: string,
): Promise<ActionResult> {
  const r = await call(`${path}${confirmTurnOff ? "?confirm_turn_off=true" : ""}`, {
    method: "DELETE",
    session: true,
  });
  if (!r.ok)
    return actionError(errorOf(r).message ?? "The action did not complete", {
      ...(isStepUpRequired(r.json) ? { code: STEP_UP_REQUIRED } : {}),
    });
  if (r.json.confirmed === false) {
    (await cookies()).set(MFA_CODES_COOKIE, "", { ...mfaCodesCookieOptions(), maxAge: 0 });
  }
  revalidatePath("/account");
  if (r.json.confirmed === false) {
    return actionOk(
      Number(r.json.signed_out_sessions ?? 0) > 0
        ? "Two-factor authentication is off. We signed out your other browsers."
        : "Two-factor authentication is off",
    );
  }
  return actionOk(done);
}

export async function removePasskeyAction(
  id: string,
  confirmTurnOff: boolean,
): Promise<ActionResult> {
  await requireUser();
  return removeMethod(
    `/auth/mfa/passkeys/${encodeURIComponent(id)}`,
    confirmTurnOff,
    "Passkey removed",
  );
}

/** Remove the authenticator app while passkeys keep 2FA on. */
export async function removeAuthenticatorAppAction(): Promise<ActionResult> {
  await requireUser();
  return removeMethod("/auth/mfa/totp", false, "Authenticator app removed");
}
