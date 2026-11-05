import { redirect } from "next/navigation";
import { listBusinesses } from "@/lib/api";

/**
 * Where a sign-in lands when nothing asked for a page: the business home when the org has
 * exactly one live business, else the org home. Only sign-in goes through
 * here, so `/` stays reachable for adding a second business.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  let target = "/";
  try {
    const businesses = await listBusinesses();
    const visible = businesses.data.filter((b) => b.livemode === "live");
    if (visible.length === 1) target = `/businesses/${encodeURIComponent(visible[0]!.id)}`;
  } catch {
    // The org home renders the API error itself.
  }
  redirect(target);
}
