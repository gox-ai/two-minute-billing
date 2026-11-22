import { cache } from "react";
import { Clock, Tag } from "lucide-react";
import { getPricingPage } from "@/lib/checkout-api";
import { fmtDate } from "@/lib/format-date";
import { BrandTheme, NoticeCard, StorefrontFooter, StorefrontHeader } from "../../chrome";
import { groupPricing, offerSentence } from "./plans";
import { OneTimeGrid, PlanGrid } from "./pricing-grid";

export const dynamic = "force-dynamic";

/** One fetch for the tab title and the page. */
const loadPage = cache((biz: string) => getPricingPage(biz));

export async function generateMetadata({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  const page = await loadPage(biz);
  const b = page?.business;
  return {
    title: b ? `Pricing · ${b.name}` : "Pricing",
    ...(b?.favicon_url ? { icons: { icon: b.favicon_url } } : {}),
  };
}

/**
 * A business's public pricing page: the payment links it marked for it, read from the
 * catalogue rather than typed into the page. A product sold monthly and yearly is one card
 * with a switch; one-time products sit under their own heading. Each button opens that link,
 * so every visitor gets their own checkout. Link to it from a website: the storefront refuses
 * to be framed (`frame-ancestors 'none'`), so it is not an iframe embed.
 */
export default async function PricingPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  const page = await loadPage(biz);
  if (!page) {
    return (
      <NoticeCard icon={<Clock />} title="This pricing page is not available">
        Ask the business for a new link.
      </NoticeCard>
    );
  }
  const brand = {
    name: page.business.name,
    logo_url: page.business.logo_url,
    icon_url: page.business.icon_url ?? null,
    brand_color: page.business.brand_color,
    button_text_color: page.business.button_text_color ?? null,
    livemode: page.business.livemode,
  };
  const { plans, oneTime, cadences } = groupPricing(page.links);
  const empty = plans.length === 0 && oneTime.length === 0;
  // An offer is shown only with its code: without one the buyer has no way to claim it.
  const offers = empty ? [] : (page.offers ?? []).filter((o) => o.code);
  return (
    <BrandTheme brand={brand}>
      <div className="flex w-full flex-col gap-5">
        <StorefrontHeader
          brand={brand}
          subtitle={
            empty
              ? undefined
              : plans.length && oneTime.length
                ? "Select a plan or a product."
                : plans.length
                  ? "Select a plan."
                  : "Select a product."
          }
        />
        {empty ? (
          <NoticeCard icon={<Clock />} title="Nothing is for sale yet">
            Come back later.
          </NoticeCard>
        ) : (
          <>
            {offers.map((o) => (
              <div
                key={o.code}
                className="flex items-start gap-3 rounded-xl border bg-card px-5 py-4 text-sm"
              >
                <Tag className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="font-semibold">{o.name}</div>
                  <p className="text-muted-foreground">
                    {offerSentence(o.percent_off, o.periods, o.intervals)} Enter the code{" "}
                    <span className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
                      {o.code}
                    </span>{" "}
                    at checkout. The offer ends on{" "}
                    <span className="whitespace-nowrap">
                      {fmtDate(`${o.ends_on}T12:00:00Z`, "UTC")}
                    </span>
                    .
                  </p>
                </div>
              </div>
            ))}
            {plans.length ? <PlanGrid plans={plans} cadences={cadences} /> : null}
            {oneTime.length ? <OneTimeGrid items={oneTime} /> : null}
          </>
        )}
        <StorefrontFooter
          business={page.business.name}
          supportEmail={page.business.support_email}
          website={page.business.website}
          secure={!empty}
        />
      </div>
    </BrandTheme>
  );
}
