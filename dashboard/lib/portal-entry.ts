import { redirect } from "next/navigation";
import { withPortalSession } from "@/lib/portal-path";
import { portalMe, type PortalAuth } from "@/lib/portal-api";
import { bindSessionToken, readSessionToken, setStorefrontToken } from "@/lib/storefront-session";

export { withPortalSession } from "@/lib/portal-path";

/**
 * Keep a portal session token and bind it to its session, so a second account opened in
 * this browser cannot take over this tab (see `lib/storefront-session.ts`). `session` is
 * read from the API when the caller does not have it. Returns the session, or null.
 */
export async function keepPortalSession(
  token: string,
  session?: string | null,
): Promise<string | null> {
  await setStorefrontToken("portal", token);
  const id = session ?? (await portalMe(token).catch(() => null))?.data?.session ?? null;
  if (id) await bindSessionToken("portal", id, token);
  return id;
}

/** Keep the token, then open `to` on its own session. */
export async function enterPortal(
  token: string,
  to: string,
  session?: string | null,
): Promise<never> {
  redirect(withPortalSession(to, await keepPortalSession(token, session)));
}

/** The token for the page's own session, sent with its id so the API checks it. */
export async function portalAuthFor(
  session: string,
): Promise<Extract<PortalAuth, { session: string }> | null> {
  const token = await readSessionToken("portal", session);
  return token ? { token, session } : null;
}
