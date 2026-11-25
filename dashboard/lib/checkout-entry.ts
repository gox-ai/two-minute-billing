import { redirect } from "next/navigation";
import { checkoutSession } from "@/lib/checkout-api";
import { bindCheckoutToken, setStorefrontToken } from "@/lib/storefront-session";

/**
 * Put a checkout token in the cookie and open the page on its own session.
 *
 * The token is also bound to its session (`tmb_checkout_<cosess>`) and the page opens on
 * `?s=<session>`, so a second checkout link opened in this browser cannot take over this
 * tab: once one did, an older tab paid on the newer tab's session and a buyer paid twice.
 * A token that does not resolve goes to `/checkout` as before and gets the expired card.
 * Resolving it here tells a guesser nothing new: `GET /checkout/v1/session` answers the
 * same question for the same token.
 *
 * Unlike the portal's one-time entry ticket, the checkout link is still the session and
 * stays reusable for its TTL: a buyer coming back to an abandoned checkout is ordinary.
 */
export async function enterCheckout(token: string): Promise<never> {
  await setStorefrontToken("checkout", token);
  const view = await checkoutSession(token).catch(() => null);
  const session = view?.ok ? view.data?.id : null;
  if (!session) redirect("/checkout");
  await bindCheckoutToken(session, token);
  redirect(`/checkout?s=${encodeURIComponent(session)}`);
}
