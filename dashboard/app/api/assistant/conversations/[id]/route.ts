import { NextResponse } from "next/server";
import { assistantFetch, jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function relay(method: "GET" | "DELETE", { params }: Ctx) {
  const { id } = await params;
  const res = await assistantFetch(`/conversations/${encodeURIComponent(id)}`, { method });
  if (!res) return NextResponse.json({ error: { message: "Sign in again." } }, { status: 401 });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
}

export const GET = (_req: Request, ctx: Ctx) => relay("GET", ctx);
export const DELETE = (_req: Request, ctx: Ctx) => relay("DELETE", ctx);

/** Rename, archive, pin or share the member's own conversation. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(`/conversations/${encodeURIComponent(id)}`, jsonInit("PATCH", await req.text()));
}
