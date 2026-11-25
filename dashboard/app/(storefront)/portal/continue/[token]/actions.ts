"use server";

import { redirect } from "next/navigation";
import { portalExchange, portalResume } from "@/lib/portal-api";
import { enterPortal } from "@/lib/portal-entry";
import { readStorefrontToken, rememberPortalBusiness } from "@/lib/storefront-session";

/**
 * The button on the click-to-continue page (Phase 4b). A POST, so a scanner that only loads
 * pages never spends the link. Same landing as the direct exchange: a dead link goes to
 * `/portal`, which shows the expired card.
 */
export async function continuePortalLinkAction(token: string): Promise<void> {
  const session = await portalExchange(token);
  if (session.business) await rememberPortalBusiness(session.business);
  if (session.ok)
    await enterPortal(
      session.token,
      session.forwardUrl?.startsWith("/portal") ? session.forwardUrl : "/portal",
      session.session,
    );
  // Spent a moment ago in this browser (a double press, a second tab): reopen its page.
  // Else back to its continue page: the expired card there can offer a new link.
  const latest = await readStorefrontToken("portal");
  const again = await portalResume(token, latest);
  if (again && latest) await enterPortal(latest, again);
  redirect(`/portal/continue/${encodeURIComponent(token)}`);
}
