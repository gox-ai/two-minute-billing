import { forwardedFor } from "./forwarded-for";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";

/** "Email me a new link" (portal or checkout). The token is the expired link's own. */
type Surface = "portal" | "checkout";

/** Whether the expired link can have a new one. False on any error: the button then stays hidden. */
export async function newLinkAvailable(surface: Surface, token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const res = await fetch(`${BASE}/${surface}/v1/new_link`, {
      headers: { Authorization: `Bearer ${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    return res.ok && ((await res.json()) as { available?: boolean }).available === true;
  } catch {
    return false;
  }
}

/** Ask for the new link. `limited`: too many requests for this link. */
export async function requestNewLink(
  surface: Surface,
  token: string,
): Promise<"accepted" | "limited" | "failed"> {
  try {
    const res = await fetch(`${BASE}/${surface}/v1/new_link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...(await forwardedFor()) },
      cache: "no-store",
    });
    return res.status === 202 ? "accepted" : res.status === 429 ? "limited" : "failed";
  } catch {
    return "failed";
  }
}
