/**
 * Cross-origin policy (W7) — the API half. Sibling of `platform/security-headers.ts`;
 * both are gated by `pnpm verify:security` (§I here, §C there).
 *
 * ── THE POLICY, WRITTEN DOWN ─────────────────────────────────────────────────────
 * Exactly three origins may make a cross-origin request to this API, and they are the
 * three this deployment already names in its own configuration:
 *
 *   DASHBOARD_BASE_URL   the operator dashboard
 *   PORTAL_BASE_URL      the buyer-facing portal / hosted checkout
 *   WEBHOOK_BASE_URL     this API's own public origin
 *
 * Every other origin — and a request carrying no `Origin` at all — is granted nothing.
 * No credentials are advertised to anybody, ever. See "why no credentials" below.
 *
 * ── WHY AN ALLOWLIST AT ALL, GIVEN THE DASHBOARD IS A BFF ────────────────────────
 * Today no browser needs this. The dashboard and the storefront are ONE Next
 * application that calls us from its own server (there is no `NEXT_PUBLIC_*` API base
 * anywhere in `dashboard/`), and the operator API is authenticated by a Bearer key held
 * server-side. Until now that meant the policy was true only BY ABSENCE — nobody had
 * registered a CORS plugin — which is an undocumented property one `origin: true` away
 * from gone. This file makes the grant explicit and finite, so relaxing it is an edit
 * somebody reviews rather than a default somebody inherits.
 *
 * ── HOW THE MATCH IS DONE, AND WHY IT IS SPELLED THIS WAY ────────────────────────
 * Exact string equality against a `Set` of normalised origins. Not a substring test,
 * not `endsWith`, not a regex, not a suffix rule — those are SR-2026-008 Finding 1,
 * where `https://tmbilling.test.evil.example` and `https://evil.example/tmbilling.test`
 * both pass a check that "contains" the allowed name. An origin is scheme + host +
 * port and nothing else, so `new URL(...).origin` is what the configured value is
 * reduced to: a trailing slash, a path, or a stray `:443` can no longer be the
 * difference between a working deployment and an open one.
 *
 * The allowlist is derived from configuration that is REQUIRED to be right for other
 * reasons — the dashboard URL is where sign-in redirects land, the portal URL is what
 * goes in buyer email — so it cannot quietly drift into naming a host nobody operates.
 * A variable that is unset simply contributes no origin: an empty allowlist grants
 * nothing, which is exactly the behaviour this service had before this file existed.
 * That is the failure direction to want. Compare SR-2026-008 Finding 2, where the whole
 * policy hung on one variable matching one exact string and an unset value disabled it
 * silently, in production.
 *
 * `Origin: null` is not special-cased to be allowed, and must never be: browsers send
 * it from sandboxed iframes, `file://` documents and cross-origin redirects, so
 * treating it as "no origin, therefore trusted" (Finding 3) grants precisely the
 * callers you cannot identify. It is simply not in the Set, so it falls through with
 * everything else.
 *
 * ── WHY NO `Access-Control-Allow-Credentials` ────────────────────────────────────
 * That header is what turns a granted origin from an annoyance into account access, and
 * here it would grant nothing anyway: the only cookie this API sets is the dashboard
 * session (`api/auth-routes.ts`), and it is `SameSite=Lax`, which browsers refuse to
 * attach to a cross-site XHR no matter what CORS says. Advertising it would be a
 * control that does nothing — while standing ready to do something the day the cookie's
 * SameSite attribute is loosened for an unrelated reason. If a genuine credentialed
 * cross-origin flow ever appears, adding it is one line and the argument belongs in the
 * review of that line.
 *
 * ── WHAT A DISALLOWED ORIGIN GETS ────────────────────────────────────────────────
 * A completely normal response with no CORS headers on it — never a 403. Enforcement is
 * the browser's job; refusing the request instead would break every legitimate
 * non-browser caller that happens to send an `Origin` (curl, a proxy, another service),
 * and would leak which origins are on the list. The preflight is the same: we only
 * answer an `OPTIONS` ourselves when the origin is allowed, so an unknown origin sees
 * the ordinary 404 this API has always returned for a method that has no route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "@/platform/config";

/**
 * Methods a browser may be granted. `HEAD`/`OPTIONS` ride along with `GET` in the CORS
 * spec's "simple" set; the other five are the ones `api/routes.ts` actually registers.
 */
const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";

/**
 * Request headers a browser may send, enumerated rather than echoed back from
 * `Access-Control-Request-Headers`. Echoing is the lazy shape of this header and it
 * makes the allowlist infinite in the one dimension nobody checks.
 *
 * `idempotency-key` is here because every API write takes one; a preflight without it
 * would let a caller reach exactly the routes that must never be retried blindly.
 */
const ALLOWED_HEADERS = "authorization, content-type, idempotency-key";

/**
 * Response headers a browser may READ. Without this a cross-origin caller can see the
 * status and nothing else — including the rate-limit budget it is supposed to back off
 * against, and `idempotent-replayed`, which is how a client tells "your write happened"
 * from "your write happened twice ago".
 */
const EXPOSED_HEADERS =
  "idempotent-replayed, request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset";

/** Ten minutes. Long enough to matter, short enough that tightening this file takes effect the same day. */
const MAX_AGE = "600";

/**
 * Reduce a configured base URL to a bare origin. Returns null for an unset value and
 * THROWS for a malformed one: a URL nobody can parse is a deployment mistake, and the
 * boot that refuses to start is cheaper than the origin that silently never matches.
 */
function toOrigin(raw: string | undefined, name: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${name} is not a valid URL (${JSON.stringify(raw)}) — it must be an absolute origin like https://app.example.com`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an http(s) URL, got ${url.protocol}//`);
  }
  return url.origin;
}

/**
 * The allowlist, resolved once at module load — the same three names on every request,
 * so no request can be answered against a different policy than the one an operator
 * could read off the config.
 *
 * `WEBHOOK_BASE_URL` is this API's own origin, and a page served from it would be
 * same-origin and never send a preflight at all; it is on the list because it is a
 * stated origin of this deployment and because the API is reachable under it through a
 * proxy that may not be the origin the page was loaded from. It grants nothing extra
 * that the other two do not already grant.
 */
export function resolveAllowedOrigins(from: {
  DASHBOARD_BASE_URL?: string | undefined;
  PORTAL_BASE_URL?: string | undefined;
  WEBHOOK_BASE_URL?: string | undefined;
}): ReadonlySet<string> {
  return new Set(
    [
      toOrigin(from.DASHBOARD_BASE_URL, "DASHBOARD_BASE_URL"),
      toOrigin(from.PORTAL_BASE_URL, "PORTAL_BASE_URL"),
      toOrigin(from.WEBHOOK_BASE_URL, "WEBHOOK_BASE_URL"),
    ].filter((o): o is string => o !== null),
  );
}

/**
 * Taken apart into `resolveAllowedOrigins` above so `verify:security` §I can assert the
 * matching rule against the REAL production values without a deployment that has them
 * set — the bypass shapes that matter (a registrable domain ending in an allowed name, a
 * path that contains one, `null`) are properties of the rule, not of one environment.
 */
export const ALLOWED_ORIGINS: ReadonlySet<string> = resolveAllowedOrigins(config);

/** Exact-match, case-sensitive. An origin is a normalised token, not a name to be interpreted. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin !== undefined && ALLOWED_ORIGINS.has(origin);
}

/**
 * Attach the cross-origin policy to every response on this instance.
 *
 * An `onRequest` hook, not `onSend`: the preflight has to be ANSWERED, not decorated,
 * and answering it before routing is what lets an `OPTIONS` succeed on a path that only
 * registers `POST`. Headers set here survive onto the error and not-found envelopes
 * too, which is the same trap `security-headers.ts` documents at length — a policy that
 * only ships on the happy path is a policy the interesting responses do not have.
 */
export function registerCors(app: FastifyInstance): void {
  app.addHook("onRequest", (req: FastifyRequest, reply: FastifyReply, done) => {
    const origin = req.headers.origin;

    // Set whenever the request carries an Origin — including one we refuse. The
    // response body for `evil.example` and for the dashboard is byte-identical, so a
    // shared cache that ignored Vary would happily hand our Allow-Origin header to the
    // caller we just declined.
    if (origin !== undefined) reply.header("vary", "Origin");

    if (!isAllowedOrigin(origin)) return done();

    reply.header("access-control-allow-origin", origin!);
    reply.header("access-control-expose-headers", EXPOSED_HEADERS);

    // The preflight, answered here and terminated here. `access-control-request-method`
    // is what distinguishes it from a plain OPTIONS request.
    if (req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined) {
      reply.header("access-control-allow-methods", ALLOWED_METHODS);
      reply.header("access-control-allow-headers", ALLOWED_HEADERS);
      reply.header("access-control-max-age", MAX_AGE);
      void reply.code(204).send();
      return;
    }

    done();
  });
}
