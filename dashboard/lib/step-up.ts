import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { forwardedFor } from "@/lib/forwarded-for";

/**
 * Step-up for 2FA and passkey management (2026-11-04). A plain module, not `'use server'`:
 * every export of one of those becomes a network-invokable endpoint, and this only reads.
 */
const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

export const STEP_UP_REQUIRED = "step_up_required";

/** True when the API refused because the session needs a fresh step-up. */
export function isStepUpRequired(json: Record<string, unknown>): boolean {
  return (json as { error?: { type?: string } }).error?.type === STEP_UP_REQUIRED;
}

/** What `/auth/step_up` will accept from this person, and how long a step-up lasts. */
export async function getStepUpStatus(): Promise<{
  method: "totp" | "password";
  windowMinutes: number;
} | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${BASE}/auth/step_up`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(await forwardedFor()) },
    cache: "no-store",
  }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    method: j.method === "totp" ? "totp" : "password",
    windowMinutes: Number(j.window_minutes ?? 15),
  };
}
