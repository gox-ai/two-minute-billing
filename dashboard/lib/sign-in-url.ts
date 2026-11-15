import "server-only";
import { headers } from "next/headers";
import { REDIRECT_PARAM, safeRedirectTo } from "@/lib/redirect-to";

/**
 * The sign-in URL for a visitor whose session is missing or expired, carrying the page they
 * were on, with its query, so signing in returns them to the same tab and filters. The page
 * comes from `x-tmb-path` and `x-tmb-search`, which `proxy.ts` sets (and overwrites) on every
 * request that has a session cookie; a server
 * action posts to its page's URL, so it carries that page too. Use as
 * `redirect(await signInUrl())`.
 */
export async function signInUrl(): Promise<string> {
  const h = await headers();
  const path = h.get("x-tmb-path");
  const dest = safeRedirectTo(path ? path + (h.get("x-tmb-search") ?? "") : null);
  return dest ? `/login?${REDIRECT_PARAM}=${encodeURIComponent(dest)}` : "/login";
}
