import { forwardedFor } from "./forwarded-for";
import { readStorefrontToken, type StorefrontSurface } from "./storefront-session";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";
/** A report is a few short fields; anything larger is not one of ours. */
const MAX_BODY_BYTES = 8_192;

/**
 * `POST /<surface>/client-error`: the browser's error report, sent on to the engine with the
 * session cookie's token (the browser never holds it). Answers 204 whatever happens: the
 * sender is a beacon, and a failure here must never reach the buyer.
 */
export async function forwardBuyerErrorReport(
  surface: StorefrontSurface,
  req: Request,
): Promise<Response> {
  try {
    const token = await readStorefrontToken(surface);
    const body = await req.text();
    if (token && body && body.length <= MAX_BODY_BYTES) {
      const res = await fetch(`${BASE}/${surface}/v1/client_errors`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(await forwardedFor()),
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok && res.status !== 429)
        console.warn("[buyer-error-report] engine refused a report", surface, res.status);
    }
  } catch {
    // Telemetry only.
  }
  return new Response(null, { status: 204 });
}
