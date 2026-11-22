import { redirect } from "next/navigation";
import { openPaymentLink } from "@/lib/checkout-api";
import { exchangeTokenForCookie } from "@/lib/storefront-session";
import { recordCheckoutEntry } from "@/lib/storefront-visit";

/**
 * A public payment link (`/buy/plink_…`). Each visit mints the visitor their own checkout
 * session, then lands them on `/checkout` through the same cookie exchange a one-buyer
 * link uses — so the token never sits in the address bar.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ link: string }> }) {
  const { link } = await params;
  const res = await openPaymentLink(link);
  if (!res.ok) {
    const q = new URLSearchParams();
    if (res.status === 429) q.set("busy", "1");
    // A known link that is refused names its business, so the page can show its contact.
    else if (res.business) q.set("biz", res.business);
    const qs = q.toString();
    redirect(`/buy/unavailable${qs ? `?${qs}` : ""}`);
  }
  recordCheckoutEntry(req, res.token);
  await exchangeTokenForCookie("checkout", res.token);
}
