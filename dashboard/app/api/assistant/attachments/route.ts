import { jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

/** Upload a screenshot (base64 JSON). The API checks the type and the 10 MB limit. */
export async function POST(req: Request) {
  return relayJson("/attachments", jsonInit("POST", await req.text()));
}
