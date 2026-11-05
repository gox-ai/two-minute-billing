/**
 * The bounce for gateways that return the buyer with a form POST (`GATEWAY_RETURN_PATH`
 * in src/providers/buyer-return.ts). A cross-site POST carries no SameSite=Lax cookie,
 * so the storefront session is lost on it; a 303 turns it into a top-level GET of
 * `next`, which does carry the cookie. The body is never read: the return leg
 * completes from our own stash and the engine, not from what the gateway posted.
 */
import { gatewayReturnTarget } from "@/lib/gateway-return";

export const dynamic = "force-dynamic";

function bounce(req: Request): Response {
  // Relative Location: resolved against the host the buyer used, whatever proxy is in front.
  return new Response(null, {
    status: 303,
    headers: {
      Location: gatewayReturnTarget(new URL(req.url).searchParams.get("next")),
      "Cache-Control": "no-store",
    },
  });
}

export function GET(req: Request) {
  return bounce(req);
}

export function POST(req: Request) {
  return bounce(req);
}
