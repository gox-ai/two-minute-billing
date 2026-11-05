import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getHubSpot } from "@/lib/api/hubspot";
import { getBusiness } from "@/lib/api/business-settings";
import { HUBSPOT_STATE_COOKIE, hubspotStateCookieOptions } from "@/lib/auth-cookies";
import { requirePermission } from "@/lib/session";

/**
 * Step 1 of a HubSpot install: mint `state`, remember which business started it, and send
 * the browser to HubSpot's install screen. The registered redirect URL is fixed, so the
 * business rides in the state cookie rather than the URL.
 */
export const dynamic = "force-dynamic";

const settingsPath = (biz: string) => `/businesses/${encodeURIComponent(biz)}/integrations/hubspot`;

export async function GET(req: Request) {
  await requirePermission("integrations:view", "admin");
  const biz = new URL(req.url).searchParams.get("biz") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(biz)) redirect("/");

  if ((await getBusiness(biz).catch(() => undefined))?.livemode === "test") {
    redirect(
      `${settingsPath(biz)}?error=${encodeURIComponent("HubSpot is not available in test mode")}`,
    );
  }

  const status = await getHubSpot(biz).catch(() => null);
  if (!status?.authorize_url) {
    redirect(
      `${settingsPath(biz)}?error=${encodeURIComponent("HubSpot is not configured on this deployment")}`,
    );
  }

  const state = randomBytes(32).toString("base64url");
  (await cookies()).set(HUBSPOT_STATE_COOKIE, `${state}.${biz}`, hubspotStateCookieOptions());

  const url = new URL(status.authorize_url);
  url.searchParams.set("state", state);
  redirect(url.toString());
}
