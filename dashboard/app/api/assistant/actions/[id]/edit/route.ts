import { jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Before Confirm: change the fields of a change Billy prepared (`{fields}`, `{note}`). Passed through as sent. */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  return relayJson(`/actions/${encodeURIComponent(id)}/edit`, jsonInit("POST", await req.text()));
}
