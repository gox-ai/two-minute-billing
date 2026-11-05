import { headers } from "next/headers";

/**
 * Pass the caller's `X-Forwarded-For` (and `User-Agent`) through to the engine, unchanged.
 *
 * WHY THIS EXISTS. The dashboard is a BFF: the browser talks to Next, and Next opens a
 * SECOND connection to the engine over `127.0.0.1`. That second connection is a hop the
 * engine cannot see through — its socket peer is the Next process on the same box — so
 * every dashboard-originated request arrived carrying no forwarded chain at all and
 * `req.ip` resolved to the loopback address. That is what put **`127.0.0.1` on every
 * dashboard audit row in production**, and it is not fixed by `TRUST_PROXY_HOPS`: a hop
 * count can only choose how much of a header to believe, and there was no header.
 *
 * VERBATIM, NEVER APPENDED — this is the load-bearing rule.
 *   client → nginx → dashboard(:4101) → engine(:4001)
 * nginx sets `X-Forwarded-For: $proxy_add_x_forwarded_for`, i.e. it APPENDS the real peer,
 * so the last entry of what we receive is the one nginx wrote and the only one not
 * supplied by the caller. Forwarding the header untouched leaves the engine's
 * `TRUST_PROXY_HOPS=1` exactly correct: it trusts one hop (our loopback socket) and reads
 * the last entry — the true client. Append our own address here and that last entry
 * becomes `127.0.0.1` again, which is the bug we started with. The topology is stated
 * ONCE, in the engine's hop count (`deploy/README.md` § 8); this file must not restate it.
 *
 * Forged values are therefore harmless: a caller who sends `X-Forwarded-For: 9.9.9.9` gets
 * `9.9.9.9, <real peer>` after nginx, and the engine still reads the real peer.
 *
 * Absent header → `{}` (local development, where the browser reaches Next directly). The
 * engine then falls back to the socket peer, which is what it does today.
 *
 * `headers()` throws outside a request scope (module init, a build-time render); that is
 * an absence too, not a failure.
 */
export async function forwardedFor(): Promise<Record<string, string>> {
  try {
    const h = await headers();
    const chain = h.get("x-forwarded-for");
    // The browser's own User-Agent, for the same reason: without it the engine records the
    // Next server's, so sessions, trusted browsers and security emails all read "Unknown
    // browser". Descriptive only — nothing authorizes on it.
    const ua = h.get("user-agent");
    return {
      ...(chain ? { "x-forwarded-for": chain } : {}),
      ...(ua ? { "user-agent": ua.slice(0, 500) } : {}),
    };
  } catch {
    return {};
  }
}
