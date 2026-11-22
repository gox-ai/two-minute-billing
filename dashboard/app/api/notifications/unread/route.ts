import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { getUnreadCount } from "@/lib/api/notifications";

export const dynamic = "force-dynamic";

/** The bell's count, polled once a minute while the tab is visible. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  try {
    const r = await getUnreadCount();
    return NextResponse.json({ count: r.count, destructive: r.destructive });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
