import Link from "next/link";
import { Clock } from "lucide-react";
import { getPricingPage } from "@/lib/checkout-api";
import { BrandTheme, NoticeCard, StorefrontFooter, StorefrontHeader } from "../../chrome";

export const metadata = { title: "Payment link" };

/**
 * Where `/buy/<link>` lands when the link is unknown, archived, or opened too often. A known
 * link names its business (`?biz=`): the page then carries its brand, its contact and, when
 * it has a pricing page, the way to what it sells now.
 */
export default async function PaymentLinkUnavailable({
  searchParams,
}: {
  searchParams: Promise<{ busy?: string; biz?: string }>;
}) {
  const { busy, biz } = await searchParams;
  const notice = busy ? (
    <NoticeCard icon={<Clock />} title="Too many attempts">
      You opened this link too many times. Wait a few minutes, then try again.
    </NoticeCard>
  ) : (
    <NoticeCard icon={<Clock />} title="This payment link is not available">
      The business stopped this link or changed what it sells. Ask the business for a new link.
    </NoticeCard>
  );
  // The business is a nicety here: if it cannot be read, the plain notice still answers.
  const page =
    biz && /^biz_[A-Za-z0-9]+$/.test(biz) ? await getPricingPage(biz).catch(() => null) : null;
  if (!page) return notice;
  const brand = {
    name: page.business.name,
    logo_url: page.business.logo_url,
    icon_url: page.business.icon_url ?? null,
    brand_color: page.business.brand_color,
    livemode: page.business.livemode,
  };
  return (
    <BrandTheme brand={brand}>
      <div className="flex w-full flex-col gap-5">
        <StorefrontHeader brand={brand} />
        {page.links.length ? (
          <NoticeCard icon={<Clock />} title="This payment link is not available">
            {brand.name} stopped this link or changed what it sells.{" "}
            <Link href={`/pricing/${biz}`} className="text-primary hover:underline">
              See the plans and prices
            </Link>
            .
          </NoticeCard>
        ) : (
          <NoticeCard icon={<Clock />} title="This payment link is not available">
            {brand.name} stopped this link or changed what it sells. Ask {brand.name} for a new
            link.
          </NoticeCard>
        )}
        <StorefrontFooter
          business={brand.name}
          supportEmail={page.business.support_email}
          website={page.business.website}
          secure={false}
        />
      </div>
    </BrandTheme>
  );
}
