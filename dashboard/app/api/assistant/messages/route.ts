import { NextRequest, NextResponse } from "next/server";
import { assistantFetch } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

/** Ask the assistant: the API's server-sent events pass straight through to the panel. */
export async function POST(req: NextRequest) {
  const res = await assistantFetch("/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await req.text(),
    signal: req.signal,
  });
  if (!res) return NextResponse.json({ error: { message: "Sign in again." } }, { status: 401 });
  if (!res.ok || !res.body) {
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(res.body, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  });
}
