import { forwardedFor } from "@/lib/forwarded-for";
import { isCloud } from "@/lib/edition";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/**
 * What the sign-up page offers: `open` = self-serve sign-up (0354), `requests` = Cloud with
 * sign-up locked, so it takes an access request (0405), `closed` = invitation only.
 * `closed` on any failure: no dead form.
 */
export async function signupMode(): Promise<"open" | "requests" | "closed"> {
  if (!isCloud()) return "closed";
  try {
    const res = await fetch(`${BASE}/auth/signup`, {
      headers: await forwardedFor(),
      cache: "no-store",
    });
    if (!res.ok) return "closed";
    const j = (await res.json()) as { enabled?: boolean; requests?: boolean };
    return j.enabled === true ? "open" : j.requests === true ? "requests" : "closed";
  } catch {
    return "closed";
  }
}

/** Whether this deployment offers self-serve sign-up. */
export async function signupEnabled(): Promise<boolean> {
  return (await signupMode()) === "open";
}
