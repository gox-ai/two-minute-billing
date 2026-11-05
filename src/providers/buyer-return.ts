import type { PaymentProvider } from "./types";

/** The storefront route that turns a gateway's form POST back into a GET of the real page. */
export const GATEWAY_RETURN_PATH = "/gateway-return";

/**
 * The return URL to hand this adapter. A gateway that sends the buyer back with a form
 * POST (`capabilities.buyerReturnByPost`) gets our bounce on the same origin, carrying the
 * real page as `next`; every other gateway gets the URL unchanged. Only path, query and
 * hash travel in `next`, so the bounce can never be pointed at another site.
 */
export function gatewayReturnUrl(
  adapter: Pick<PaymentProvider, "capabilities">,
  url: string,
): string;
export function gatewayReturnUrl(
  adapter: Pick<PaymentProvider, "capabilities">,
  url: string | undefined,
): string | undefined;
export function gatewayReturnUrl(
  adapter: Pick<PaymentProvider, "capabilities">,
  url: string | undefined,
): string | undefined {
  if (!url || !adapter.capabilities.buyerReturnByPost) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return url;
  const next = `${u.pathname}${u.search}${u.hash}`;
  return `${u.origin}${GATEWAY_RETURN_PATH}?next=${encodeURIComponent(next)}`;
}
