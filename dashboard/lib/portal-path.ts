/** `to` (a `/portal…` path) with `s=<session>` added, other params kept. Server and client. */
export function withPortalSession(to: string, session: string | null | undefined): string {
  if (!session) return to;
  const url = new URL(to, "http://portal.invalid");
  url.searchParams.set("s", session);
  return `${url.pathname}${url.search}${url.hash}`;
}
