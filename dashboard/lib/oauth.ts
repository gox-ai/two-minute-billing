import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { forwardedFor } from "@/lib/forwarded-for";
import { signInUrl } from "@/lib/sign-in-url";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

export interface OAuthRequestView {
  id: string;
  client_name: string | null;
  client_id: string;
  redirect_host: string;
  scope: string;
  expires_at: string;
  businesses: Array<{ id: string; name: string; livemode: "test" | "live" }>;
}

export interface ConnectedApp {
  id: string;
  client_name: string | null;
  client_id: string;
  business: string;
  business_name: string;
  created_at: string;
  last_used_at: string | null;
}

async function authHeaders() {
  const token = (await cookies()).get("tmb_session")?.value;
  if (!token) redirect(await signInUrl());
  return { cookie: `tmb_session=${token}`, ...(await forwardedFor()) };
}

/** A pending connection request, or null when it expired or was already answered. */
export async function getOAuthRequest(id: string): Promise<OAuthRequestView | null> {
  const res = await fetch(`${BASE}/auth/oauth/requests/${encodeURIComponent(id)}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`tmbilling API /auth/oauth/requests → ${res.status}`);
  return (await res.json()) as OAuthRequestView;
}

export async function listConnectedApps(): Promise<ConnectedApp[]> {
  const res = await fetch(`${BASE}/auth/oauth/grants`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`tmbilling API /auth/oauth/grants → ${res.status}`);
  return ((await res.json()) as { data?: ConnectedApp[] }).data ?? [];
}

/** POST/DELETE to an /auth/oauth route; returns the body, or the API's own error message. */
export async function oauthWrite(
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; message: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(await authHeaders()),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, body: json };
  const message = (json.error as { message?: string } | undefined)?.message;
  return { ok: false, message: message ?? "We could not complete the request. Try again." };
}
