import { jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Helpful / not helpful on one answer. */
export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(
    `/messages/${encodeURIComponent(id)}/feedback`,
    jsonInit("PUT", await req.text()),
  );
}
