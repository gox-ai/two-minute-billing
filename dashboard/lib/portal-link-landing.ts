/**
 * Where a portal entry link lands on a GET (Phase 4b). Fails CLOSED: only a peek that
 * succeeded and named a non-email link may be spent on a page load. Everything else (an
 * email link, a rate-limited peek, a network error) goes to the click-to-continue page,
 * whose POST decides — so a mail scanner can never spend an emailed link.
 *
 * No imports, so the engine's unit tests can check it directly.
 */
export function portalLinkLanding(peek: { link_kind?: string } | null): "exchange" | "continue" {
  return peek && peek.link_kind && peek.link_kind !== "email" ? "exchange" : "continue";
}
