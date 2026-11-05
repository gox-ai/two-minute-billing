import { cache } from "react";
import { CheckCircle2, Clock } from "lucide-react";
import { checkoutSession } from "@/lib/checkout-api";
import { readStorefrontToken } from "@/lib/storefront-session";
import { CheckoutFlow } from "./checkout-flow";
import { getCountries } from "@/lib/api/geo";
import { NoticeCard } from "../../chrome";

export const dynamic = "force-dynamic";

/**
 * `generateMetadata` and the render are two passes over the same request. React's
 * `cache` makes the second lookup free — without it a tenant favicon would cost an
 * extra checkout round trip on every load.
 */
const loadSession = cache((token: string) => checkoutSession(token));

/** The browser tab is part of the brand, and the only part a page cannot set itself. */
export async function generateMetadata() {
  const token = await readStorefrontToken("checkout");
  const res = token ? await loadSession(token) : null;
  const biz = res?.ok ? res.data?.business : null;
  return {
    title: biz ? `Checkout · ${biz.name}` : "Checkout",
    ...(biz?.favicon_url ? { icons: { icon: biz.favicon_url } } : {}),
  };
}

/**
 * Shown when the checkout session cookie is missing or the token behind it no longer
 * resolves. One component so the two paths cannot drift into differently-worded cards.
 */
function ExpiredCard() {
  return (
    <NoticeCard icon={<Clock />} title="This checkout link is not valid or is expired">
      Checkout links are valid for a limited time. Ask for a new link.
    </NoticeCard>
  );
}

/**
 * Public hosted-checkout page (#10d). Everything here is authed by the price-scoped
 * checkout token, which since W1 lives in an HttpOnly cookie set by
 * `/checkout/s/<token>` rather than in this page's URL — the org API key is never used
 * (see lib/checkout-api.ts). Lives in the (storefront) route group so it is NEVER
 * wrapped in the operator dashboard chrome.
 *
 * The token is read here and never passed to `CheckoutFlow`. That matters most on this
 * surface: the card step injects a gateway SDK from a third-party host, so with the
 * token in the URL it travelled to that host as a `Referer` on the very request that
 * loads the payment form.
 */
export default async function CheckoutPage() {
  const token = await readStorefrontToken("checkout");
  // No cookie at all — opened directly, or the session expired. Same card as an
  // invalid token below: from the buyer's side these are one situation.
  if (!token) return <ExpiredCard />;

  const res = await loadSession(token);
  const countries = await getCountries();

  // Invalid / expired / revoked / non-open token → friendly card (same component
  // the portal's expired link uses; these had drifted into three hand-rolled
  // centred divs that no longer matched each other).
  if (!res.ok || !res.data) return <ExpiredCard />;

  // Already completed → nothing left to do.
  if (res.data.status === "completed") {
    return (
      <NoticeCard icon={<CheckCircle2 />} tone="success" title="This checkout is already complete">
        {res.data.mode === "change" && res.data.change?.reactivation
          ? "Your subscription is already reactivated. Thank you!"
          : res.data.mode === "change"
            ? "Your plan is already changed. Thank you!"
            : "We created your subscription. Thank you!"}
      </NoticeCard>
    );
  }

  return <CheckoutFlow view={res.data} countries={countries} />;
}
