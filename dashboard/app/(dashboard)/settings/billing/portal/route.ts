import { notFound, redirect } from "next/navigation";
import { getMe } from "@/lib/api";
import { accountBillingEnabled, billingPortal } from "@/lib/account-billing";
import { requirePermission } from "@/lib/session";

/**
 * Open our customer portal. A GET the browser navigates to once: the portal link is single-use,
 * and a server action's client-side redirect fetched it twice and spent it.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!accountBillingEnabled()) notFound();
  await requirePermission("settings:manage", "admin");
  const back = new URL("/settings/billing", req.url).toString();
  let url: string;
  try {
    url = (await billingPortal((await getMe()).id, back)).url;
  } catch {
    redirect("/settings/billing?portal_error=1");
  }
  redirect(url);
}
