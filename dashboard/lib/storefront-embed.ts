/**
 * Embedded storefront (a business's allowed website frames our checkout or portal).
 *
 * `proxy.ts` sets EMBED_HEADER on the request when the page is framed by the session's own
 * `embed_origin`, or when the browser holds EMBED_COOKIE in this partition (the server actions
 * inside that frame). `storefront-session.ts` reads it to write the session cookies as
 * `SameSite=None; Secure; Partitioned`: a `Lax` cookie never reaches a cross-site frame.
 */
export const EMBED_HEADER = "x-tmb-embed";
/** The verified website, on a framed page load only (the proxy confirmed it with the API). */
export const EMBED_ORIGIN_HEADER = "x-tmb-embed-origin";
/** A marker, not a credential: it says only that this partition belongs to an embed. */
export const EMBED_COOKIE = "tmb_embed";

const CREDENTIAL = /^(cstk|pstk|cosess|psess)_[A-Za-z0-9_-]{1,128}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** The credential a framed storefront URL carries: the entry token, else the `?s=` session. */
export function embedCredential(url: URL): string | null {
  const [, surface, step, token] = url.pathname.split("/");
  const fromPath =
    (surface === "checkout" || surface === "portal") && (step === "s" || step === "continue")
      ? token
      : null;
  const c = fromPath ? decodeURIComponent(fromPath) : url.searchParams.get("s");
  return c && CREDENTIAL.test(c) ? c : null;
}

/** Ask the API which website may frame this page. Any failure answers null: not framed. */
export async function fetchFrameAncestor(apiBase: string, credential: string) {
  try {
    const res = await fetch(
      `${apiBase}/storefront/v1/frame_ancestor?credential=${encodeURIComponent(credential)}`,
      { cache: "no-store", signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { frame_ancestor?: unknown };
    const o = body.frame_ancestor;
    return typeof o === "string" && ORIGIN.test(o) ? o : null;
  } catch {
    return null;
  }
}
