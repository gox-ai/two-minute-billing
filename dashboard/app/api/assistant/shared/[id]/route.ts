import { relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Another member's shared conversation, read only. 404 when it is not shared with this member. */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(`/shared/${encodeURIComponent(id)}`);
}
