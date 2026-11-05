"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { forwardedFor } from "@/lib/forwarded-for";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/**
 * Turn the organization's "Require two-factor authentication" on or off (0329). The API checks
 * the admin permission and the caller's own 2FA again; this check only spares a non-admin the
 * round trip.
 */
export async function setRequireTwoFactorAction(enabled: boolean): Promise<ActionResult> {
  await requirePermission("security:manage", "admin");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}/auth/organization/security/require_two_factor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(await forwardedFor()),
    },
    body: JSON.stringify({ enabled: enabled === true }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as {
    notified?: number;
    error?: { message?: string };
  };
  if (!res.ok) return actionError(json.error?.message ?? "We could not save the setting.");
  revalidatePath("/settings");
  revalidatePath("/team");
  if (!enabled) return actionOk("Two-factor authentication is no longer required");
  const n = json.notified ?? 0;
  return actionOk(
    n === 0
      ? "Two-factor authentication is now required"
      : `Two-factor authentication is now required. We sent an email to ${n} ${n === 1 ? "member" : "members"} without it.`,
  );
}

/**
 * The organization's session policy (0482). A value equal to the installation limit is sent as
 * null, so the organization keeps following the installation. The API refuses a looser value.
 */
export async function saveSessionPolicyAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  await requirePermission("security:manage", "admin");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const limit = (k: string) => Number(fd.get(`${k}_limit`));
  const pick = (k: string): number | null => {
    const v = Number(fd.get(k));
    return Number.isInteger(v) && v > 0 && v < limit(k) ? v : null;
  };
  const roles = fd.getAll("mfa_role").map(String).filter(Boolean);
  const res = await fetch(`${BASE}/auth/organization/security/session_policy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(await forwardedFor()),
    },
    body: JSON.stringify({
      session_idle_minutes: pick("session_idle_minutes"),
      session_absolute_ttl_hours: pick("session_absolute_ttl_hours"),
      mfa_required_roles: roles.length ? roles : null,
    }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) return actionError(json.error?.message ?? "We could not save the session settings.");
  revalidatePath("/settings");
  revalidatePath("/team");
  return actionOk("Session settings saved.");
}
