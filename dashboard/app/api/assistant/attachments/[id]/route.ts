import { relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(`/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
}
