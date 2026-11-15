import { relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(`/support/requests/${encodeURIComponent(id)}`);
}
