"use server";

import { redirect } from "next/navigation";
import { portalExchange } from "@/lib/portal-api";
import { rememberPortalBusiness, setStorefrontToken } from "@/lib/storefront-session";

/**
 * The button on the click-to-continue page (Phase 4b). A POST, so a scanner that only loads
 * pages never spends the link. Same landing as the direct exchange: a dead link goes to
 * `/portal`, which shows the expired card.
 */
export async function continuePortalLinkAction(token: string): Promise<void> {
  const session = await portalExchange(token);
  if (session.business) await rememberPortalBusiness(session.business);
  if (session.ok) await setStorefrontToken("portal", session.token);
  redirect(
    session.ok && session.forwardUrl?.startsWith("/portal") ? session.forwardUrl : "/portal",
  );
}
