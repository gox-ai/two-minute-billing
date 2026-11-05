import { redirect } from "next/navigation";
import { portalExchange, portalPeek } from "@/lib/portal-api";
import { portalLinkLanding } from "@/lib/portal-link-landing";
import { rememberPortalBusiness, setStorefrontToken } from "@/lib/storefront-session";

/**
 * Portal entry. The URL in the operator's minted link points here and nowhere else.
 *
 * It does two things, and the second is what 0193 added: it SPENDS the single-use entry
 * credential for a session token, then puts that session token — not the one from the
 * URL — into an HttpOnly cookie and redirects to a clean `/portal`.
 *
 * So the value in the link is dead the moment it is used, and the value that survives
 * was never in a URL, an email or a page. Once accessed, the entry URL cannot be reused,
 * so it must never be persisted. Full reasoning in `lib/storefront-session.ts`.
 *
 * A route handler rather than a page: there is nothing to render, and responding with a
 * redirect means the token-bearing URL never becomes a document — so it never becomes a
 * `Referer`, and browsers do not keep it as a separate back-button entry.
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // An emailed link is never spent on a page load: mail scanners load links before the
  // customer does. It goes to a page whose button spends it (Phase 4b). API links, opened
  // by an integration that already knows the user, keep the direct exchange.
  // Fails closed: a failed peek (rate limit, error) is treated like an email link.
  if (portalLinkLanding(await portalPeek(token)) === "continue")
    redirect(`/portal/continue/${encodeURIComponent(token)}`);
  const session = await portalExchange(token);

  // A spent, expired or unknown link lands on `/portal` with no cookie, which renders
  // the "invalid or has expired" card the page already has. Deliberately the SAME
  // destination as success: a distinct error URL would be a free oracle telling anyone
  // sweeping for live links which of their guesses hit.
  // Remembering the business on failure too lets that card carry the business's own
  // message; the redirect target is unchanged either way.
  if (session.business) await rememberPortalBusiness(session.business);
  if (session.ok) await setStorefrontToken("portal", session.token);
  // `forward_url` is one of the engine's closed set of `/portal…` paths, never off-site.
  redirect(
    session.ok && session.forwardUrl?.startsWith("/portal") ? session.forwardUrl : "/portal",
  );
}
