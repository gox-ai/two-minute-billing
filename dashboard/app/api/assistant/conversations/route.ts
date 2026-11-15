import { NextRequest, NextResponse } from "next/server";
import { assistantFetch } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

/** The query the engine reads; anything else is dropped. */
const PASSED = ["business", "q", "archived", "limit", "starting_after"] as const;

export async function GET(req: NextRequest) {
  const qs = new URLSearchParams();
  for (const k of PASSED) {
    const v = req.nextUrl.searchParams.get(k);
    if (v) qs.set(k, v);
  }
  const res = await assistantFetch(`/conversations${qs.size ? `?${qs}` : ""}`);
  if (!res) return NextResponse.json({ error: { message: "Sign in again." } }, { status: 401 });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}
