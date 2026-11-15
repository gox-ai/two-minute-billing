import { jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(`/support/requests/${encodeURIComponent(id)}/read`, jsonInit("POST", "{}"));
}
