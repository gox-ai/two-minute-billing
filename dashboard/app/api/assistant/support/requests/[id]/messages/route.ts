import { jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The member replies in the thread. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(
    `/support/requests/${encodeURIComponent(id)}/messages`,
    jsonInit("POST", await req.text()),
  );
}
