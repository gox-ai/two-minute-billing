"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { LIMITS } from "@/lib/limits";
import {
  SESSION_COOKIE,
  TRUSTED_BROWSER_COOKIE,
  expire,
  trustedBrowserCookieOptions,
} from "@/lib/auth-cookies";
import { forwardedFor } from "@/lib/forwarded-for";
import { actionError, actionOk, parseForm, type ActionResult } from "@/lib/action-result";

/** The person's own profile, theme and sessions. Every action acts on the caller only. */
const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

async function asMe(
  method: "PATCH" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; json: Record<string, unknown>; error?: string }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(await forwardedFor()),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: res.ok,
    json,
    error: (json as { error?: { message?: string } }).error?.message,
  };
}

const profileSchema = z.object({
  name: z.string().trim().max(LIMITS.name, `Name must be ${LIMITS.name} characters or fewer`),
});

export async function updateProfileAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requireUser();
  const parsed = parseForm(profileSchema, formData);
  if (parsed.error) return parsed.error;
  const r = await asMe("PATCH", "/auth/me", { name: parsed.data.name || null });
  if (!r.ok)
    return actionError(r.error ?? "We could not save your profile.", {
      errors: { name: r.error ?? "" },
    });
  return actionOk("Profile saved");
}

export async function removeAvatarAction(): Promise<ActionResult> {
  await requireUser();
  const r = await asMe("DELETE", "/auth/me/avatar");
  if (!r.ok) return actionError(r.error ?? "We could not remove your photo.");
  return actionOk("Photo removed");
}

const themeSchema = z.enum(["light", "dark", "system"]);

/** Saves the theme on the account so it follows the person to another browser. */
export async function setThemeAction(theme: string): Promise<ActionResult> {
  await requireUser();
  const t = themeSchema.safeParse(theme);
  if (!t.success) return actionError("Unknown theme");
  const r = await asMe("PATCH", "/auth/me", { theme: t.data });
  if (!r.ok) return actionError(r.error ?? "We could not save your theme.");
  return actionOk();
}

export async function revokeSessionAction(id: string): Promise<ActionResult> {
  await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return actionError("We could not find the session.");
  const r = await asMe("DELETE", `/auth/sessions/${id}`);
  if (!r.ok) return actionError(r.error ?? "We could not sign out the browser.");
  return actionOk("Signed out");
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  await requireUser();
  const r = await asMe("POST", "/auth/sessions/revoke_others", {});
  if (!r.ok) return actionError(r.error ?? "We could not sign out your other browsers.");
  const n = Number(r.json.signed_out_sessions ?? 0);
  return actionOk(n === 1 ? "Signed out of 1 browser" : `Signed out of ${n} browsers`);
}

async function dropTrustedCookie() {
  (await cookies()).set(TRUSTED_BROWSER_COOKIE, "", expire(trustedBrowserCookieOptions()));
}

/** Forget one trusted browser. `current` = it is this one, so its cookie goes too. */
export async function forgetTrustedBrowserAction(
  id: string,
  current: boolean,
): Promise<ActionResult> {
  await requireUser();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return actionError("We could not find the browser.");
  const r = await asMe("DELETE", `/auth/trusted_browsers/${id}`);
  if (!r.ok) return actionError(r.error ?? "We could not forget the browser.");
  if (current) await dropTrustedCookie();
  return actionOk("We forgot the browser. It will ask for a code at the next sign-in.");
}

export async function forgetAllTrustedBrowsersAction(): Promise<ActionResult> {
  await requireUser();
  const r = await asMe("POST", "/auth/trusted_browsers/forget_all", {});
  if (!r.ok) return actionError(r.error ?? "We could not forget your trusted browsers.");
  await dropTrustedCookie();
  return actionOk("All browsers will ask for a code at the next sign-in.");
}
