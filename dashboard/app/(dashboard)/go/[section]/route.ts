import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { listBusinesses } from "@/lib/api";
import { BUSINESS_ID, LAST_BUSINESS_COOKIE } from "@/lib/pwa";

/**
 * The app shortcuts' target: /go/<section> opens that section of the last business used on
 * this device (the `tmb_last_biz` cookie, set by <LastBusiness>). The cookie is only a hint:
 * it must name a business the session can list, else the single live business, else the
 * organization home.
 */
export const dynamic = "force-dynamic";

const SECTIONS: Record<string, string> = {
  home: "",
  customers: "/customers",
  invoices: "/invoices",
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ section: string }> }) {
  const { section } = await ctx.params;
  const suffix = SECTIONS[section];
  if (suffix === undefined) redirect("/");
  const hint = req.cookies.get(LAST_BUSINESS_COOKIE)?.value;
  let biz: string | undefined;
  try {
    const { data } = await listBusinesses();
    biz = data.find((b) => b.id === hint)?.id;
    if (!biz) {
      const live = data.filter((b) => b.livemode === "live");
      if (live.length === 1) biz = live[0]!.id;
    }
  } catch {
    // Engine unreachable: trust a well-formed hint; the page reports the error itself.
    if (hint && BUSINESS_ID.test(hint)) biz = hint;
  }
  redirect(biz ? `/businesses/${encodeURIComponent(biz)}${suffix}` : "/");
}
