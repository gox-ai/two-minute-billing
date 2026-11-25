import { enterCheckout } from "@/lib/checkout-entry";
import { recordCheckoutEntry } from "@/lib/storefront-visit";

/**
 * Hosted-checkout entry (W1) — the portal's twin. See
 * `app/(storefront)/portal/s/[token]/route.ts` and `lib/storefront-session.ts`.
 *
 * This surface is the one where the leak mattered most: the card-entry step injects a
 * gateway SDK from a third-party host, so with the token in the path it travelled to
 * that host as a `Referer` on the very request that loads the payment form.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  recordCheckoutEntry(req, token);
  await enterCheckout(token);
}
