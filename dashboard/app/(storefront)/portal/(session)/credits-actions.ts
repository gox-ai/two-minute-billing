"use server";

import { portalBuyCredits } from "@/lib/portal-api";
import { readStorefrontToken } from "@/lib/storefront-session";
import { actionError, actionOk, type ActionResult } from "@/lib/action-result";

/**
 * "Buy credits": mint a purchase checkout for one pack price. Returns its URL; the client
 * opens it with a full page load (a server redirect is a soft navigation, and the checkout
 * page then reads the link as not valid).
 */
export async function portalBuyCreditsAction(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const token = await readStorefrontToken("portal");
  if (!token) return actionError("Your session ended. Open the portal link again.");
  const price = String(fd.get("price") ?? "");
  const quantity = Number(fd.get("quantity") ?? "1");
  if (!price) return actionError("We could not start the purchase. Reload the page.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100)
    return actionError("We could not start the purchase. Enter a quantity from 1 to 100.");
  const res = await portalBuyCredits(token, price, quantity);
  if (!res.ok || !res.data?.url)
    return actionError(res.error ?? "We could not start the purchase. Try again.");
  return actionOk(undefined, res.data.url);
}
