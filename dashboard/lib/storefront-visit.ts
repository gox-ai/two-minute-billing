import { after } from "next/server";
import { forwardedFor } from "./forwarded-for";
import { readStorefrontToken, type StorefrontSurface } from "./storefront-session";

const BASE = process.env.TMBILLING_API_URL ?? "http://localhost:4000";
/** A beacon event is a few short fields. */
const MAX_BODY_BYTES = 2048;

/** Global Privacy Control or Do Not Track: nothing leaves this server. */
function refused(h: Headers): boolean {
  return h.get("sec-gpc")?.trim() === "1" || h.get("dnt")?.trim() === "1";
}

/**
 * The headers the engine derives its words from. The user agent is parsed and dropped there.
 * The caller's chain goes along (see `forwardedFor`) only so the engine's rate limit sees the
 * real client; the engine stores no address for a visit.
 */
function visitorHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  const ua = h.get("user-agent");
  const country = h.get("cf-ipcountry");
  if (ua) out["user-agent"] = ua.slice(0, 500);
  if (country) out["cf-ipcountry"] = country.slice(0, 2);
  return out;
}

async function send(surface: StorefrontSurface, token: string, h: Headers, body: string) {
  try {
    await fetch(`${BASE}/${surface}/v1/visits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(await forwardedFor()),
        ...visitorHeaders(h),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Analytics only.
  }
}

/** `POST /<surface>/visit`: the page's beacon, sent on with the session cookie's token. Always 204. */
export async function forwardVisitBeacon(surface: StorefrontSurface, req: Request) {
  try {
    if (!refused(req.headers)) {
      const token = await readStorefrontToken(surface);
      const body = await req.text();
      if (token && body && body.length <= MAX_BODY_BYTES)
        await send(surface, token, req.headers, body);
    }
  } catch {
    // Analytics only.
  }
  return new Response(null, { status: 204 });
}

/**
 * The checkout entry link was opened: record where the buyer came from (the Referer's host
 * and the link's UTM tags) after the redirect is sent. The entry URL is the only place they
 * exist; the page the buyer lands on has a clean URL.
 */
export function recordCheckoutEntry(req: Request, token: string): void {
  if (refused(req.headers)) return;
  const url = new URL(req.url);
  const self = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let referrer: string | null = null;
  try {
    const r = req.headers.get("referer");
    const host = r ? new URL(r).hostname.toLowerCase() : null;
    referrer =
      host && host.length <= 253 && host !== self?.replace(/:\d+$/, "").toLowerCase() ? host : null;
  } catch {
    referrer = null;
  }
  const body = JSON.stringify({
    kind: "entry",
    referrer_host: referrer,
    utm_source: url.searchParams.get("utm_source")?.slice(0, 200) ?? null,
    utm_medium: url.searchParams.get("utm_medium")?.slice(0, 200) ?? null,
    utm_campaign: url.searchParams.get("utm_campaign")?.slice(0, 200) ?? null,
  });
  const headers = new Headers(req.headers);
  after(() => send("checkout", token, headers, body));
}
