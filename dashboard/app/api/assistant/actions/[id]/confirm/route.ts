import { jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Confirm a proposed change. A money change needs `confirm_money: true`. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.text()) || "{}";
  return relayJson(`/actions/${encodeURIComponent(id)}/confirm`, jsonInit("POST", body));
}
