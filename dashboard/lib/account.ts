import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth-cookies";
import { forwardedFor } from "@/lib/forwarded-for";
import { trustedBrowserHeader } from "@/lib/mfa-challenge";

/**
 * Reads for the account page: the person's sessions and whether a photo can be uploaded.
 * A plain module, not `'use server'` — exporting reads from an action file would make each
 * one a network-invokable POST (`verify:action-guards`).
 */
const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

async function get(path: string): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...(await forwardedFor()) },
    cache: "no-store",
  });
  return { ok: res.ok, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export interface AccountSession {
  id: string;
  current: boolean;
  created_at: string;
  last_active_at: string;
  ip: string | null;
  user_agent: string | null;
  auth_method: string | null;
  organization: string;
}

export interface TrustedBrowser {
  id: string;
  /** This browser holds the cookie for it. */
  current: boolean;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

/**
 * Browsers that skip the sign-in code (0329). Forwards this browser's cookie so the API can mark
 * which one is "this browser". Null when the engine could not answer.
 */
export async function getTrustedBrowsers(): Promise<TrustedBrowser[] | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const res = await fetch(`${BASE}/auth/trusted_browsers`, {
    headers: {
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(await forwardedFor()),
      ...(await trustedBrowserHeader()),
    },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { data?: unknown };
  if (!res.ok || !Array.isArray(json.data)) return null;
  return json.data as TrustedBrowser[];
}

/** Null when the engine could not answer — the card says so rather than showing an empty list. */
export async function getMySessions(): Promise<AccountSession[] | null> {
  const r = await get("/auth/sessions");
  if (!r.ok || !Array.isArray(r.json.data)) return null;
  return r.json.data as AccountSession[];
}

export interface AvatarCapability {
  uploadEnabled: boolean;
  accepts: string[];
}

/** Best-effort: an engine that cannot answer means "no picker", never a broken page. */
export async function getAvatarCapability(): Promise<AvatarCapability> {
  const r = await get("/auth/me/avatar");
  if (!r.ok) return { uploadEnabled: false, accepts: [] };
  return {
    uploadEnabled: r.json.upload_enabled === true,
    accepts: Array.isArray(r.json.accepts) ? (r.json.accepts as string[]) : [],
  };
}

/** "Chrome on macOS" from a user agent. Coarse on purpose: it names a device, not a build. */
export function describeUserAgent(ua: string | null): string {
  if (!ua) return "Unknown browser";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "ChromeOS"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown browser";
}
