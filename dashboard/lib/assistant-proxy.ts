import "server-only";
import { cookies } from "next/headers";
import { forwardedFor } from "@/lib/forwarded-for";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/** Forward to the assistant's member routes with the signed-in session. Null when signed out. */
export async function assistantFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const token = (await cookies()).get("tmb_session")?.value;
  if (!token) return null;
  return fetch(`${BASE}/auth/assistant${path}`, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: `tmb_session=${token}`,
      ...(await forwardedFor()),
    },
    cache: "no-store",
  });
}

export interface AssistantStatus {
  enabled: boolean;
  available: boolean;
  cap_reached: boolean;
  /** Cloud: support requests, and how many have a reply the member has not read. */
  support?: { unread: number } | null;
}

/** For the shell: show the launcher only when the assistant can answer. Never throws. */
export async function assistantStatus(): Promise<AssistantStatus | null> {
  try {
    const res = await assistantFetch("/status");
    return res?.ok ? ((await res.json()) as AssistantStatus) : null;
  } catch {
    return null;
  }
}

/** Forward a JSON call and pass the API's answer back as it is. */
export async function relayJson(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await assistantFetch(path, init);
  if (!res) {
    return Response.json({ error: { message: "Sign in again." } }, { status: 401 });
  }
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export const jsonInit = (method: string, body?: string): RequestInit => ({
  method,
  ...(body !== undefined ? { headers: { "content-type": "application/json" }, body } : {}),
});
