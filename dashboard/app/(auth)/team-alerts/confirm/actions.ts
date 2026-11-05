"use server";

import { cookies } from "next/headers";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";
import { forwardedFor } from "@/lib/forwarded-for";
import {
  TEAM_ALERT_CONFIRM_COOKIE,
  TEAM_ALERT_DONE_COOKIE,
  expire,
  teamAlertCookieOptions,
} from "@/lib/auth-cookies";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/** Spend the emailed token (0495). The answer names no business and no address. */
export async function confirmTeamAlertsAction(
  _prev: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const jar = await cookies();
  const token = jar.get(TEAM_ALERT_CONFIRM_COOKIE)?.value;
  if (!token) return actionError("This link is not valid or is expired.");
  const res = await fetch(`${BASE}/auth/team_alerts/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await forwardedFor()) },
    body: JSON.stringify({ token }),
    cache: "no-store",
  });
  jar.set(TEAM_ALERT_CONFIRM_COOKIE, "", expire(teamAlertCookieOptions()));
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    return actionError(json.error?.message ?? "This link is not valid or is expired.");
  }
  jar.set(TEAM_ALERT_DONE_COOKIE, "1", teamAlertCookieOptions());
  return actionOk("Email address confirmed.");
}
