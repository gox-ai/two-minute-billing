import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sameState } from "@/lib/google-oauth";
import { connectHubSpot } from "@/lib/api/hubspot";
import { HUBSPOT_STATE_COOKIE, expire, hubspotStateCookieOptions } from "@/lib/auth-cookies";

/**
 * Step 2: HubSpot returns the browser here with a one-time `code`. `state` is checked against
 * the cookie from `/start`, then the code goes to the API server-to-server — the API holds
 * the client secret and does the exchange.
 */
export const dynamic = "force-dynamic";

const GENERIC = "We could not connect HubSpot. Try again.";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = await cookies();
  const stored = jar.get(HUBSPOT_STATE_COOKIE)?.value ?? "";
  // Single-use: cleared on every outcome.
  jar.set(HUBSPOT_STATE_COOKIE, "", expire(hubspotStateCookieOptions()));

  const dot = stored.indexOf(".");
  const expected = dot > 0 ? stored.slice(0, dot) : "";
  const biz = dot > 0 ? stored.slice(dot + 1) : "";
  if (!biz) redirect("/");
  const back = `/businesses/${encodeURIComponent(biz)}/integrations/hubspot`;

  // The merchant backed out of HubSpot's screen.
  if (url.searchParams.get("error"))
    redirect(`${back}?error=${encodeURIComponent("You cancelled the HubSpot installation")}`);
  if (!code || !state || !expected || !sameState(state, expected)) {
    redirect(`${back}?error=${encodeURIComponent(GENERIC)}`);
  }

  const res = await connectHubSpot(biz, code).catch(() => null);
  if (!res?.ok) redirect(`${back}?error=${encodeURIComponent(res?.error ?? GENERIC)}`);
  redirect(`${back}?connected=1`);
}
