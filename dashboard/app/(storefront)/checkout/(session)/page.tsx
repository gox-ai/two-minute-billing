import { cache } from "react";
import { redirect } from "next/navigation";
import { CheckCircle2, Clock } from "lucide-react";
import { checkoutSession } from "@/lib/checkout-api";
import { readCheckoutToken } from "@/lib/storefront-session";
import { CheckoutFlow } from "./checkout-flow";
import { getCountries } from "@/lib/api/geo";
import { NoticeCard } from "../../chrome";
import { newLinkAvailable } from "@/lib/new-link-api";
import { NewLinkButton } from "../../new-link/new-link-button";
import { emailNewCheckoutLinkAction } from "../../new-link/actions";

export const dynamic = "force-dynamic";

/**
 * `generateMetadata` and the render are two passes over the same request. React's
 * `cache` makes the second lookup free — without it a tenant favicon would cost an
 * extra checkout round trip on every load.
 */
const loadSession = cache((token: string) => checkoutSession(token));

/** `?s=cosess_…`: the session this tab shows. The page puts it there on first load. */
type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const sessionOf = async ({ searchParams }: Search) => {
  const s = (await searchParams).s;
  return typeof s === "string" ? s : null;
};

/** The browser tab is part of the brand, and the only part a page cannot set itself. */
export async function generateMetadata(props: Search) {
  const token = await readCheckoutToken(await sessionOf(props));
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
async function ExpiredCard({ token }: { token: string | null }) {
  // The cookie holds the dead link's own token: a restart or an unfinished order can get a
  // new link by email.
  const canResend = await newLinkAvailable("checkout", token);
  return (
    <NoticeCard icon={<Clock />} title="This checkout link is not valid or is expired">
      {canResend
        ? "Checkout links are valid for a limited time. We can send a new link to your email address."
        : "Checkout links are valid for a limited time. Ask for a new link."}
      {canResend ? <NewLinkButton request={emailNewCheckoutLinkAction} /> : null}
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
export default async function CheckoutPage(props: Search) {
  // A tab keeps its own session after another checkout link opens in this browser.
  const token = await readCheckoutToken(await sessionOf(props));
  // No cookie at all — opened directly, or the session expired. Same card as an
  // invalid token below: from the buyer's side these are one situation.
  if (!token) return <ExpiredCard token={null} />;

  const res = await loadSession(token);
  const countries = await getCountries();

  // Invalid / expired / revoked / non-open token → friendly card (same component
  // the portal's expired link uses; these had drifted into three hand-rolled
  // centred divs that no longer matched each other).
  if (!res.ok || !res.data) return <ExpiredCard token={token} />;

  // Name the session in the URL before any script runs, so a reload or refresh of this tab
  // keeps it after another checkout link opens in the same browser. Other params stay.
  if ((await sessionOf(props)) !== res.data.id) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(await props.searchParams))
      if (k !== "s" && typeof v === "string") params.set(k, v);
    params.set("s", res.data.id);
    redirect(`/checkout?${params.toString()}`);
  }

  // Already completed → nothing left to do.
  if (res.data.status === "completed") {
    return (
      <NoticeCard icon={<CheckCircle2 />} tone="success" title="This checkout is already complete">
        {res.data.mode === "change" && res.data.change?.reactivation
          ? "Your subscription is already reactivated."
          : res.data.mode === "change"
            ? "Your plan is already changed."
            : "We created your subscription."}
      </NoticeCard>
    );
  }

  return <CheckoutFlow view={res.data} countries={countries} />;
}
