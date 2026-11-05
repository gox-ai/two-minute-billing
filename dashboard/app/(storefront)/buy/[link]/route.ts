import { redirect } from "next/navigation";
import { openPaymentLink } from "@/lib/checkout-api";
import { exchangeTokenForCookie } from "@/lib/storefront-session";

/**
 * A public payment link (`/buy/plink_…`). Each visit mints the visitor their own checkout
 * session, then lands them on `/checkout` through the same cookie exchange a one-buyer
 * link uses — so the token never sits in the address bar.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ link: string }> }) {
  const { link } = await params;
  const res = await openPaymentLink(link);
  if (!res.ok) redirect(`/buy/unavailable${res.status === 429 ? "?busy=1" : ""}`);
  await exchangeTokenForCookie("checkout", res.token);
}
