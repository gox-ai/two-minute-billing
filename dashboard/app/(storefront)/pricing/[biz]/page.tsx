import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPricingPage } from "@/lib/checkout-api";
import { BrandTheme, NoticeCard, StorefrontFooter, StorefrontHeader } from "../../chrome";

export const dynamic = "force-dynamic";

/** "Monthly", "Every 3 months", "Yearly" — or nothing for a one-time price. */
function cadence(interval: string | null, count: number): string | null {
  if (!interval) return null;
  if (count === 1) {
    return (
      ({ day: "per day", week: "per week", month: "per month", year: "per year" } as const)[
        interval as "day" | "week" | "month" | "year"
      ] ?? `per ${interval}`
    );
  }
  return `every ${count} ${interval}s`;
}

/**
 * A business's public pricing page: one card per payment link it marked for it, read from
 * the catalogue rather than typed into the page. Each button opens that link, so every
 * visitor gets their own checkout. Link to it from a website: the storefront refuses to be
 * framed (`frame-ancestors 'none'`), so it is not an iframe embed.
 */
export default async function PricingPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  const page = await getPricingPage(biz);
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
    brand_color: page.business.brand_color,
    livemode: page.business.livemode,
  };
  return (
    <BrandTheme brand={brand}>
      <div className="flex w-full flex-col gap-5">
        <StorefrontHeader brand={brand} subtitle="Select a plan or a product." />
        {page.links.length === 0 ? (
          <NoticeCard icon={<Clock />} title="Nothing is for sale yet">
            Come back later.
          </NoticeCard>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {page.links.map((l) => {
              const per = cadence(l.price.interval, l.price.interval_count);
              return (
                <div key={l.id} className="flex flex-col gap-4 rounded-xl border bg-card p-5">
                  {l.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a merchant image on our CDN
                    <img
                      src={l.image_url}
                      alt=""
                      className="aspect-4/3 w-full rounded-md border bg-muted/50 object-cover"
                    />
                  ) : null}
                  <div className="flex flex-col gap-1">
                    <h2 className="text-lg font-semibold">{l.name}</h2>
                    {l.description ? (
                      <p className="text-sm text-muted-foreground">{l.description}</p>
                    ) : null}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-semibold tabular-nums">{l.price.amount}</span>
                    <span className="text-sm text-muted-foreground">{per ?? "one time"}</span>
                  </div>
                  <Button asChild className="mt-auto">
                    <a href={`/buy/${l.id}`}>{l.mode === "create" ? "Subscribe" : "Buy"}</a>
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <StorefrontFooter business={page.business.name} />
      </div>
    </BrandTheme>
  );
}
