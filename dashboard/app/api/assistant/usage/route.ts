import { NextResponse } from "next/server";
import { assistantFetch } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

/** The included-use figure for the bar under the composer (null with an own key or no allowance). */
export async function GET() {
  const res = await assistantFetch("/status");
  if (!res?.ok) return NextResponse.json({ allowance: null });
  const s = (await res.json()) as {
    allowance?: { used_percent: number; renews_at: string } | null;
  };
  return NextResponse.json({ allowance: s.allowance ?? null });
}
