"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LANDING_PATH, REDIRECT_PARAM, safeRedirectTo } from "@/lib/redirect-to";
import { z } from "zod";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";
import { revalidatePath } from "next/cache";
import { requirePermission, requireUser } from "@/lib/session";
import { LIMITS } from "@/lib/limits";
import { forwardedFor } from "@/lib/forwarded-for";
import { isStepUpRequired } from "@/lib/step-up";
import {
  INVITE_COOKIE,
  MFA_CODES_COOKIE,
  MFA_RESET_COOKIE,
  RESET_COOKIE,
  SESSION_COOKIE,
  expire,
  mfaCodesCookieOptions,
  mfaResetCookieOptions,
  sessionCookieOptions,
} from "@/lib/auth-cookies";
import {
  clearMfaChallenge,
  isMfaChallenge,
  mfaStepUrl,
  parkMfaChallenge,
  readMfaChallenge,
  storeTrustedBrowser,
  trustedBrowserHeader,
} from "@/lib/mfa-challenge";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

// Parse the session token out of the API's Set-Cookie and store it on the portal.
function tokenFromSetCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const m = /tmb_session=([^;]+)/.exec(setCookie);
  return m?.[1] ?? null;
}

async function authPost(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (res.ok)
    return { ok: true, token: tokenFromSetCookie(res.headers.get("set-cookie")) ?? undefined };
  let error = "The request failed.";
  try {
    error = ((await res.json()) as { error?: { message?: string } }).error?.message ?? error;
  } catch {
    /* ignore */
  }
  return { ok: false, error };
}

/**
 * Store the operator session on the DASHBOARD's origin.
 *
 * The API sets its own `tmb_session` cookie too, but on the API's origin — which the
 * browser does not send back here. So this is a second writer of the same cookie name,
 * and its attributes must match the API's (`setSessionCookie` in api/auth-routes.ts) or
 * the two disagree about the same credential.
 *
 * `secure` was missing here when W4 added it on the API side: the API's cookie got the
 * flag and the one the browser actually holds did not, so the protection was real on the
 * copy nobody used. Reads the same `ALLOW_INSECURE_COOKIES` variable, so one `.env` line
 * still configures both halves.
 */
async function storeToken(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions());
}

/**
 * ── SCHEMAS ────────────────────────────────────────────────────────────────────
 * Bounds come from `lib/limits.ts`, the mirror of the API's table that
 * `verify:form-validation` §A holds to it. The server re-validates all of this — these
 * exist so a person is told WHICH field is wrong, here, rather than after a round trip.
 */
/**
 * The authenticator setup in progress: the secret to scan, carried from the action to the page
 * in a short HttpOnly cookie. Fifteen minutes, matching the API's hold on the pending secret.
 * Recovery codes are NOT here — they are minted only once the code is confirmed.
 */
const MFA_SETUP_COOKIE = "tmb_mfa_setup";
const MFA_SETUP_COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", path: "/account" } as const;

const mfaCodeSchema = z.object({
  code: z.string().trim().min(1, "Enter the code").max(20, "That code is too long"),
});
const recoveryCodeSchema = z.object({
  code: z.string().trim().min(1, "Enter a recovery code").max(40, "The code is too long"),
});
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email address")
    .max(LIMITS.email),
  password: z.string().min(1, "Password is required").max(LIMITS.password),
});

const forgotSchema = z.object({
  /**
   * The Turnstile token, forwarded verbatim (audit M3.2). Optional because the widget renders
   * only when a site key is configured, and validating its SHAPE here would be theatre — only
   * Cloudflare can say whether it is real.
   */
  turnstile_token: z.string().max(2048).optional(),
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email address")
    .max(LIMITS.email),
});

/** Shared by the reset and invite forms — both set a new password twice. */
const newPasswordSchema = z
  .object({
    password: z
      .string()
      .min(LIMITS.passwordMin, `Use at least ${LIMITS.passwordMin} characters`)
      .max(LIMITS.password, `Use ${LIMITS.password} characters or fewer`),
    confirm_password: z.string().min(1, "Confirm your password"),
  })
  // Reported against `confirm_password`, not the form: the mismatch is only actionable on
  // the field the person can retype without losing the one they meant.
  .refine((v) => v.password === v.confirm_password, {
    message: "Those passwords do not match",
    path: ["confirm_password"],
  });

const changePasswordSchema = z
  .object({
    // OPTIONAL: a Google-only account has no current password, and the form does not render
    // the field for one. A password holder always sends it — the field is `required` where it
    // IS rendered — and the engine returns "Current password is incorrect" if it is wrong or
    // blank, which `Field` shows against the box.
    current_password: z.string().max(LIMITS.password).optional(),
    new_password: z
      .string()
      .min(LIMITS.passwordMin, `Use at least ${LIMITS.passwordMin} characters`)
      .max(LIMITS.password, `Use ${LIMITS.password} characters or fewer`),
  })
  .refine((v) => !v.current_password || v.current_password !== v.new_password, {
    message: "Enter a password that you did not use here before",
    path: ["new_password"],
  });

const inviteSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email address")
    .max(LIMITS.email),
  name: z.string().trim().max(LIMITS.name).optional(),
  // A fixed role, or a custom role's `role_…` id. The engine refuses one the inviter cannot give.
  role: z.union(
    [z.enum(["manager", "ops", "developer", "admin"]), z.string().regex(/^role_[A-Za-z0-9]+$/)],
    { message: "Select a role" },
  ),
});

/**
 * Sign in.
 *
 * The credential failure stays a FORM-level message, deliberately. "Invalid email or
 * password" is worded not to say which, and attaching it to one field would say it — the
 * enumeration property the engine's constant-time compare exists to protect. Only the
 * shape errors (missing, malformed, over-length) are per-field.
 *
 * Returning `ActionResult` also gets the message out of the URL. The old
 * `redirect('/login?error=…')` put failure text in the address bar, browser history and
 * every proxy log in between — harmless in itself, and needless.
 */
export async function loginAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseForm(loginSchema, formData);
  if (parsed.error) return parsed.error;

  // The API answers one of three ways: a session (done), a CHALLENGE (the password was right
  // and a second factor is outstanding), or a refusal.
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await forwardedFor()),
      ...(await trustedBrowserHeader()),
    },
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    object?: string;
    challenge?: string;
    error?: { message?: string };
  };

  if (res.ok && isMfaChallenge(json)) {
    // Into an HttpOnly cookie, never a hidden field: the code step then posts ONLY the code,
    // so the password is not re-sent and does not reach browser history. The destination is
    // carried across, or finishing 2FA would forget where the visitor was going.
    await parkMfaChallenge(json);
    redirect(mfaStepUrl(safeRedirectTo(String(formData.get(REDIRECT_PARAM) ?? ""))));
  }

  if (!res.ok) return actionError(json.error?.message ?? "Sign-in failed.");
  const token = tokenFromSetCookie(res.headers.get("set-cookie"));
  if (!token) return actionError("Sign-in failed.");
  await storeToken(token);
  redirect(safeRedirectTo(String(formData.get(REDIRECT_PARAM) ?? "")) ?? LANDING_PATH);
}

/**
 * The second step: a code (or a recovery code), and the challenge from the cookie.
 *
 * The challenge is cleared on every outcome that ENDS the attempt — success, or a challenge the
 * API no longer recognises, which lands on the page's "timed out" view. A wrong code keeps it:
 * the API does not spend a challenge on a wrong code either.
 */
export async function mfaLoginAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const dest = safeRedirectTo(String(formData.get(REDIRECT_PARAM) ?? ""));
  const { challenge } = await readMfaChallenge();
  if (!challenge) redirect(mfaStepUrl(dest));

  const recovery = formData.get("method") === "recovery";
  const parsed = parseForm(recovery ? recoveryCodeSchema : mfaCodeSchema, formData);
  if (parsed.error) return parsed.error;

  const res = await fetch(`${BASE}/auth/login/mfa`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify({
      challenge,
      code: parsed.data.code,
      trust_browser: !recovery && formData.get("trust_browser") === "on",
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    recovery_codes_left?: number;
    trusted_browser?: { token?: string; expires_at?: string };
    error?: { message?: string };
  };
  if (!res.ok) {
    if (/expired/i.test(json.error?.message ?? "")) {
      await clearMfaChallenge();
      redirect(mfaStepUrl(dest));
    }
    if (res.status === 429)
      return actionError("Too many attempts. Wait one minute. Then try again.");
    const msg = recovery
      ? "The code is not correct. Possibly, someone used it before."
      : "The code is not correct. Enter the code that your app shows now.";
    return actionError(msg, { errors: { code: msg } });
  }
  const token = tokenFromSetCookie(res.headers.get("set-cookie"));
  if (!token) return actionError("Sign-in failed.");
  await clearMfaChallenge();
  await storeToken(token);
  await storeTrustedBrowser(json.trusted_browser);
  // A recovery code got them in: say how many are left before they carry on.
  if (typeof json.recovery_codes_left === "number") {
    const q = new URLSearchParams({ recovery_used: String(json.recovery_codes_left) });
    if (dest) q.set("next", dest);
    redirect(`/account?${q.toString()}`);
  }
  redirect(dest ?? LANDING_PATH);
}

export async function inviteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const parsed = parseForm(inviteSchema, formData);
  if (parsed.error) return parsed.error;

  const res = await fetch(`${BASE}/auth/invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `tmb_session=${token}`,
      ...(await forwardedFor()),
    },
    // No password: the invitee chooses their own via the emailed link (0197).
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = "We could not send the invite.";
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* */
    }
    // "already a member of this organization" is about the address they typed, so it
    // belongs on that field rather than in a toast that leaves them hunting for it.
    return actionError(msg, /already a member/i.test(msg) ? { errors: { email: msg } } : undefined);
  }
  // No redirect: ActionForm toasts this and refreshes the server components, so the new
  // member appears in the list without navigating away from the form.
  return actionOk("Invite sent");
}

export async function changePasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const parsed = parseForm(changePasswordSchema, formData);
  if (parsed.error) return parsed.error;

  const res = await fetch(`${BASE}/auth/change_password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `tmb_session=${token}`,
      ...(await forwardedFor()),
    },
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = "We could not change the password.";
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* */
    }
    // The one thing the server rejects that the schema cannot check is the current
    // password being wrong — and that IS field-specific, unlike a login failure.
    return actionError(
      msg,
      /current password/i.test(msg) ? { errors: { current_password: msg } } : undefined,
    );
  }
  return actionOk("Password changed");
}

// ── Multi-organization (0194) ────────────────────────────────────────────────

/**
 * Move the session into another organization the operator belongs to.
 *
 * The API validates membership and ROTATES the token, so the new value has to be stored
 * here — keeping the old cookie would leave the browser holding a credential the server
 * has already deleted, and every subsequent page would bounce to the login screen.
 */
export async function switchOrganizationAction(formData: FormData) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}/auth/switch_organization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `tmb_session=${token}`,
      ...(await forwardedFor()),
    },
    body: JSON.stringify({ organization: String(formData.get("organization") ?? "") }),
    cache: "no-store",
  });
  if (!res.ok) redirect("/?error=" + encodeURIComponent("We could not switch organization."));
  const json = (await res.json()) as { token?: string };
  if (json.token) await storeToken(json.token);
  // Home, not back. The whole page is scoped to the organization that just changed, and
  // returning to a detail screen would mean a record id belonging to the previous tenant.
  redirect("/");
}

/** Accept or decline a pending invite (0498). The API checks it belongs to this session's user. */
async function answerInvite(verb: "accept" | "decline", organization: string): Promise<boolean> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}/auth/invitations/${encodeURIComponent(organization)}/${verb}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `tmb_session=${token}`,
      ...(await forwardedFor()),
    },
    body: "{}",
    cache: "no-store",
  });
  return res.ok;
}

/** Accept, then open the organization: the reason the person accepted. */
export async function acceptInvitationAction(formData: FormData) {
  await requireUser();
  const organization = String(formData.get("organization") ?? "");
  if (!(await answerInvite("accept", organization))) {
    redirect("/invitations?error=" + encodeURIComponent("We could not accept the invite."));
  }
  await switchOrganizationAction(formData);
}

export async function declineInvitationAction(formData: FormData) {
  await requireUser();
  const organization = String(formData.get("organization") ?? "");
  if (!(await answerInvite("decline", organization))) {
    redirect("/invitations?error=" + encodeURIComponent("We could not decline the invite."));
  }
  revalidatePath("/invitations");
  redirect("/invitations");
}

// ── Password reset (0194) ────────────────────────────────────────────────────

/**
 * Ask for a reset link. Always lands on the same confirmation, whatever happened.
 *
 * The API answers a uniform 200 precisely so this cannot become the account-enumeration
 * oracle SR-2026-010 describes — branching here on the response would give away at the
 * last step exactly what the API was careful not to say.
 */
export async function forgotPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = parseForm(forgotSchema, formData);
  // A FORMAT error is safe to surface and is decidable without asking the server: "that
  // is not an email address" says nothing about whether we hold one. The uniform answer
  // the API gives is about KNOWN vs UNKNOWN addresses, and that property is untouched —
  // every well-formed address below takes the identical path and the identical reply.
  if (parsed.error) return parsed.error;

  await fetch(`${BASE}/auth/forgot_password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify(parsed.data),
    cache: "no-store",
  }).catch(() => {});
  redirect("/forgot-password?sent=1");
}

/**
 * Set the new password using the token held in the reset cookie.
 *
 * Read from an HttpOnly cookie rather than a hidden form field: `/reset-password/s/<token>`
 * parks it there and redirects to a clean URL, so the credential is in neither the address
 * bar nor the DOM — the pattern 0193 established for the buyer portal.
 */
export async function resetPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(RESET_COOKIE)?.value;
  if (!token) redirect("/forgot-password?expired=1");

  // The mismatch check lives in the schema now, so it arrives on `confirm_password`
  // instead of bouncing the whole page with a message in the URL.
  const parsed = parseForm(newPasswordSchema, formData);
  if (parsed.error) return parsed.error;

  const res = await fetch(`${BASE}/auth/reset_password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify({ token, new_password: parsed.data.password }),
    cache: "no-store",
  });
  // Spent either way — a failed attempt must not leave a live credential in the jar.
  jar.delete(RESET_COOKIE);
  if (!res.ok) {
    let msg = "This reset link is not valid or is expired.";
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* */
    }
    // The token is gone, so there is nothing to retry on this page — send them back to
    // ask for a new link rather than leaving a dead form.
    redirect("/forgot-password?error=" + encodeURIComponent(msg));
  }
  // The reset revoked every session for the account, including any this browser held.
  jar.delete(SESSION_COOKIE);
  redirect("/login?reset=1");
}

/**
 * Stop a support 2FA reset. The token comes from the HttpOnly cookie `/two-factor-reset/s/<token>`
 * parked; the outcome is its own page, because the cookie is spent either way.
 */
export async function cancelMfaResetAction(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(MFA_RESET_COOKIE)?.value;
  if (!token) redirect("/two-factor-reset?result=gone");
  const res = await fetch(`${BASE}/auth/mfa/reset/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  // A throttled attempt keeps the cookie, so waiting a minute and clicking again works.
  if (res.status !== 429) jar.set(MFA_RESET_COOKIE, "", expire(mfaResetCookieOptions()));
  const result = res.ok
    ? "cancelled"
    : res.status === 409
      ? "completed"
      : res.status === 429
        ? "throttled"
        : "gone";
  redirect(`/two-factor-reset?result=${result}`);
}

/**
 * Accept an invite: set the password the invitee chose and sign them in.
 *
 * The token is read from the HttpOnly cookie `/invite/s/<token>` parked, so it is in
 * neither the address bar nor the DOM — the pattern 0193 established for the portal.
 */
export async function acceptInviteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(INVITE_COOKIE)?.value;
  if (!token)
    redirect("/login?error=" + encodeURIComponent("This invite link is not valid or is expired."));

  const parsed = parseForm(newPasswordSchema, formData);
  if (parsed.error) return parsed.error;

  const res = await fetch(`${BASE}/auth/accept_invite`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(await forwardedFor()),
      ...(await trustedBrowserHeader()),
    },
    body: JSON.stringify({ token, password: parsed.data.password }),
    cache: "no-store",
  });
  // Spent either way — a failed attempt must not leave a live credential in the jar.
  jar.delete(INVITE_COOKIE);
  if (!res.ok) {
    let msg = "This invite link is not valid or is expired.";
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* */
    }
    // Same as the reset path: the token is spent, so there is nothing to retry here.
    redirect("/login?error=" + encodeURIComponent(msg));
  }
  const json = (await res.json()) as { token?: string; object?: string; challenge?: string };
  // An existing account with 2FA: the password is set, the code is still owed.
  if (isMfaChallenge(json)) {
    await parkMfaChallenge(json);
    redirect(mfaStepUrl(null));
  }
  if (json.token) await storeToken(json.token);
  redirect(LANDING_PATH);
}

export async function logoutAction() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    await fetch(`${BASE}/auth/logout`, {
      method: "POST",
      headers: { cookie: `tmb_session=${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    }).catch(() => {});
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

// ── second factor, for the signed-in person (audit M3) ────────────────────────

/** Call the API as the signed-in operator. Private: exporting it would make it an action. */
async function mfaFetch(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown>; error?: string }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(await forwardedFor()),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const error = (json as { error?: { message?: string } }).error?.message;
  return { ok: res.ok, status: res.status, json, error };
}

/** The refusal the step-up dialog answers. Carries the API's message. */
function stepUpRefusal(r: { error?: string }): ActionResult {
  return actionError(r.error ?? "Confirm your identity. Then try again.", {
    code: "step_up_required",
  });
}

/**
 * Begin authenticator setup (or "Change app"): mint the secret and show the setup panel. Returns
 * only when the session must step up first; every other outcome redirects.
 */
export async function enrollMfaAction(): Promise<ActionResult> {
  await requireUser();
  const r = await mfaFetch("/auth/mfa/enroll", {});
  if (!r.ok && isStepUpRequired(r.json)) return stepUpRefusal(r);
  if (!r.ok)
    redirect("/account?error=" + encodeURIComponent(r.error ?? "We could not start setup."));
  await stashSetup(r.json);
  redirect("/account#two-factor");
}

/** Confirm your identity: a code if 2FA is on, the password if not. Opens the step-up window. */
export async function stepUpAction(input: {
  code?: string;
  password?: string;
}): Promise<ActionResult> {
  await requireUser();
  const code = input.code?.trim().slice(0, 20) || undefined;
  const password = input.password?.slice(0, LIMITS.password) || undefined;
  if (!code && !password) {
    const msg = "Enter a value.";
    return actionError(msg, { errors: { [input.code === undefined ? "password" : "code"]: msg } });
  }
  const r = await mfaFetch("/auth/step_up", { code, password });
  if (r.status === 429) return actionError("Too many attempts. Wait one minute. Then try again.");
  if (!r.ok) {
    const msg = r.error ?? "We could not confirm your identity. Try again.";
    return actionError(msg, { errors: { [code ? "code" : "password"]: msg } });
  }
  return actionOk("Identity confirmed.");
}

/**
 * "Sign in again": the step-up for an account that has no password and no authenticator app.
 * A new sign-in counts as a step-up, so the person lands back on the account page ready.
 */
export async function signInAgainAction(): Promise<void> {
  await requireUser();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    await fetch(`${BASE}/auth/logout`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    }).catch(() => {});
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect(`/login?${REDIRECT_PARAM}=${encodeURIComponent("/account")}`);
}

async function stashSetup(json: Record<string, unknown>) {
  (await cookies()).set(
    MFA_SETUP_COOKIE,
    JSON.stringify({
      secret: json.secret,
      otpauthUri: json.otpauth_uri,
      replacing: json.replacing === true,
    }),
    { ...MFA_SETUP_COOKIE_OPTIONS, maxAge: 900 },
  );
}

/** Leave setup. The pending secret is held server-side for 15 minutes and simply lapses. */
export async function cancelMfaSetupAction(): Promise<void> {
  await requireUser();
  (await cookies()).set(MFA_SETUP_COOKIE, "", { ...MFA_SETUP_COOKIE_OPTIONS, maxAge: 0 });
  redirect("/account#two-factor");
}

/**
 * Finish setup by proving the authenticator holds the secret. A first setup returns the
 * recovery codes, which go to the reveal panel; a "Change app" returns none.
 */
export async function confirmMfaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireUser();
  const parsed = parseForm(mfaCodeSchema, formData);
  if (parsed.error) return parsed.error;
  const r = await mfaFetch("/auth/mfa/confirm", { code: parsed.data.code });
  const jar = await cookies();
  if (!r.ok) {
    // The setup lapsed: start a new one rather than strand the person on a dead QR code.
    if (/expired/i.test(r.error ?? "")) {
      const again = await mfaFetch("/auth/mfa/enroll", {});
      if (again.ok) {
        await stashSetup(again.json);
        redirect("/account?setup_expired=1#two-factor");
      }
    }
    const msg =
      r.error ?? "The code is not correct. Make sure that your phone sets its time automatically.";
    return actionError(msg, { errors: { code: msg } });
  }
  jar.set(MFA_SETUP_COOKIE, "", { ...MFA_SETUP_COOKIE_OPTIONS, maxAge: 0 });
  const codes = r.json.recovery_codes;
  if (Array.isArray(codes) && codes.length > 0) {
    jar.set(MFA_CODES_COOKIE, JSON.stringify(codes), mfaCodesCookieOptions());
    redirect("/account?enabled=1#two-factor");
  }
  redirect("/account?changed=1#two-factor");
}

/** Replace the recovery codes; the new set goes to the reveal panel. */
export async function regenerateRecoveryCodesAction(): Promise<ActionResult> {
  await requireUser();
  const r = await mfaFetch("/auth/mfa/recovery_codes", {});
  if (!r.ok && isStepUpRequired(r.json)) return stepUpRefusal(r);
  if (!r.ok) return actionError(r.error ?? "We could not make new codes.");
  (await cookies()).set(
    MFA_CODES_COOKIE,
    JSON.stringify(r.json.recovery_codes ?? []),
    mfaCodesCookieOptions(),
  );
  revalidatePath("/account");
  return actionOk();
}

/** "I saved them": record it and drop the only readable copy. */
export async function acknowledgeRecoveryCodesAction(): Promise<ActionResult> {
  await requireUser();
  const r = await mfaFetch("/auth/mfa/recovery_codes/acknowledge", {});
  if (!r.ok) return actionError(r.error ?? "We could not record that you saved the codes.");
  (await cookies()).set(MFA_CODES_COOKIE, "", expire(mfaCodesCookieOptions()));
  revalidatePath("/account");
  return actionOk("Recovery codes saved");
}

/**
 * Turn 2FA off. The API needs a recent step-up and signs out every other browser, which is what
 * makes a stolen session's attempt visible to the owner.
 */
export async function disableMfaAction(): Promise<ActionResult> {
  await requireUser();
  const r = await mfaFetch("/auth/mfa/disable", {});
  if (!r.ok && isStepUpRequired(r.json)) return stepUpRefusal(r);
  if (!r.ok) return actionError(r.error ?? "We could not disable two-factor authentication.");
  const jar = await cookies();
  jar.set(MFA_SETUP_COOKIE, "", { ...MFA_SETUP_COOKIE_OPTIONS, maxAge: 0 });
  jar.set(MFA_CODES_COOKIE, "", expire(mfaCodesCookieOptions()));
  revalidatePath("/account");
  const n = Number(r.json.signed_out_sessions ?? 0);
  return actionOk(
    n > 0
      ? `Two-factor authentication is off. We signed out your other browsers.`
      : "Two-factor authentication is off",
  );
}

/**
 * ── TEAM MEMBER WRITES (2026-08-30) ────────────────────────────────────────────────────
 *
 * Row-level actions rather than forms, so they return `{ ok, error }` like the catalog's
 * archive/restore and the calling client component owns the toast. The API re-checks the
 * permission and every rule; `requirePermission` here is what keeps a non-admin from
 * seeing a spinner before being told no.
 *
 * `revalidatePath('/team')` on success, not `router.refresh()` alone: the members table is
 * a server component, so the refreshed render must not come from the route cache.
 */
async function memberWrite(
  path: string,
  init: { method: "PATCH" | "DELETE" | "POST"; body?: unknown },
): Promise<{ ok: boolean; error?: string }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  /**
   * A BODILESS WRITE STILL SENDS `{}` — the same thing `apiWrite`/`apiDelete` in lib/api.ts
   * have always done, and it is not a style choice. Declaring
   * `Content-Type: application/json` with an empty body makes Fastify refuse the request
   * outright ("Body cannot be empty when content-type is set to 'application/json'"), which
   * killed both bodiless writes here: Resend invite and Remove failed with that message in
   * the toast while every server-side check passed. `app.inject` with no payload sends no
   * content-type, so the suite was exercising a request no browser makes — which is why this
   * needed a real browser to find, and why § F now injects the header the dashboard sends.
   */
  const res = await fetch(`${BASE}${path}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      cookie: `tmb_session=${token}`,
      ...(await forwardedFor()),
    },
    body: JSON.stringify(init.body ?? {}),
    cache: "no-store",
  });
  if (res.ok) {
    revalidatePath("/team");
    return { ok: true };
  }
  let error = "The request failed.";
  try {
    error = ((await res.json()) as { error?: { message?: string } }).error?.message ?? error;
  } catch {
    /* ignore */
  }
  return { ok: false, error };
}

export async function changeMemberRoleAction(id: string, role: string) {
  await requirePermission("members:manage", "admin");
  return memberWrite(`/auth/members/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { role },
  });
}

export async function removeMemberAction(id: string) {
  await requirePermission("members:manage", "admin");
  return memberWrite(`/auth/members/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function resendMemberInviteAction(id: string) {
  await requirePermission("members:manage", "admin");
  return memberWrite(`/auth/members/${encodeURIComponent(id)}/resend_invite`, { method: "POST" });
}

/**
 * Move the What's-new highwater to the number of notes that exist right now.
 *
 * Called from two places, both of which mean "this person has now seen them": dismissing the
 * dialog, and opening `/whats-new`. It SETS rather than increments, so calling it twice is the
 * same as calling it once — which matters because the page marks on every visit.
 *
 * Deliberately silent on failure. This is a badge, not money: a person whose highwater did not
 * move sees the dialog once more, and an error toast on a page they did not ask to interact
 * with would be worse than that.
 */
export async function markReleaseNotesSeenAction(count: number): Promise<void> {
  // Session-only, and first: an action is its own POST endpoint, and a redirect from a
  // guard inside the try below would come back as a result. No permission fits — none is
  // held by every role (a `developer` has no `ops`), and both callers gate on a session
  // alone: the `(dashboard)` layout and `/whats-new` both use `requireUser()`.
  await requireUser();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;
  try {
    await fetch(`${BASE}/auth/me/release_notes_seen`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: `tmb_session=${token}`,
        ...(await forwardedFor()),
      },
      body: JSON.stringify({ count }),
      cache: "no-store",
    });
  } catch {
    /* see the docblock — a stuck badge is the whole cost */
  }
}

/**
 * The product tour was started or dismissed: never offer it again. Silent on failure, like
 * the release-notes highwater above — the cost of a missed write is one more offer.
 */
export async function markProductTourSeenAction(): Promise<void> {
  await requireUser();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;
  try {
    await fetch(`${BASE}/auth/me/product_tour_seen`, {
      method: "POST",
      headers: { cookie: `tmb_session=${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
  } catch {
    /* one more offer is the whole cost */
  }
}
