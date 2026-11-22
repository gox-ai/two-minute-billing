import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { getNotificationPreferences, listNotifications } from "@/lib/api/notifications";

export const dynamic = "force-dynamic";

/**
 * The bell's list for the signed-in member (BFF: the session cookie stays server-side).
 * An empty first page with no filter says whether the member is set up, for the empty state.
 */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const unread = sp.get("unread") === "1";
  const business = sp.get("business") || undefined;
  const cursor = sp.get("cursor") || undefined;
  try {
    const page = await listNotifications({ unread, business, cursor, limit: 30 });
    let setUp: boolean | null = null;
    if (!unread && !business && !cursor && page.data.length === 0) {
      setUp = await getNotificationPreferences().then(
        (p) => p.set_up,
        () => null,
      );
    }
    return NextResponse.json({ ...page, set_up: setUp });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
