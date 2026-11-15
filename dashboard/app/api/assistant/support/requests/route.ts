import { jsonInit, relayJson } from "@/lib/assistant-proxy";

export const dynamic = "force-dynamic";

/** The member's support requests, with how many have an unread reply. */
export async function GET() {
  return relayJson("/support/requests");
}

/** Send a request Billy drafted. The browser's Idempotency-Key goes through unchanged. */
export async function POST(req: Request) {
  const key = req.headers.get("idempotency-key");
  const init = jsonInit("POST", await req.text());
  init.headers = {
    ...(init.headers as Record<string, string>),
    ...(key ? { "idempotency-key": key } : {}),
  };
  return relayJson("/support/requests", init);
}
