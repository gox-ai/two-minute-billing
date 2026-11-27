# oauth — OAuth 2.1 authorization server for the MCP server

> Source: `src/modules/oauth/` · Routes: `src/api/oauth-routes.ts` · Schema: `db/schema/oauth.ts`
> Layer: tooling (see docs/architecture/architecture.json)

## Purpose
Lets AI clients that connect by signing in (the Claude and ChatGPT apps) reach `/mcp` without
an API key. A member approves on the dashboard's consent page and selects one business; the
client gets a short-lived access token and a rotating refresh token.

## Responsibilities
- Discovery: protected resource metadata (RFC 9728) and authorization server metadata
  (RFC 8414), at the origin root with the issuer's path appended for a prefixed deployment.
- Clients: dynamic registration (`tmc_…`, RFC 7591) and client ID metadata documents (the
  client id is an https URL; fetched with the outbound guard, 5 s, 64 KB, no redirects).
- Authorize: public clients, PKCE S256 only, exact redirect match (loopback: any port),
  `iss` on every redirect (RFC 9207). Errors before the redirect is trusted are shown, never
  redirected.
- Consent (`/auth/oauth/*`, session only): the member sees the client and selects a business
  of their organization; approving creates a read-only `api` key whose map is the member's own
  read permissions plus `mcp`, a grant and a single-use code.
- Tokens: code → access (1 h) + refresh (30 days); refresh rotates. A reused code or refresh
  token ends the grant (RFC 9700). RFC 7009 revoke.

## Data model
`oauth_clients`, `oauth_requests` — platform tables, system connection only (no app grant).
`oauth_grants`, `oauth_tokens` — tenant rows behind RLS. Only HMAC hashes of codes and tokens.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `registerClient` / `resolveClient` | DCR, and CIMD fetch + cache (1 h) |
| `createAuthorizationRequest` / `approveRequest` / `denyRequest` | The consent round trip |
| `exchangeCode` / `refreshTokens` / `revokeToken` / `revokeGrant` | Tokens |
| `authenticateOAuthAccess` | Access token → the auth context of the grant's key |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource[/*]` | Resource metadata |
| `GET /.well-known/oauth-authorization-server[/*]` | AS metadata |
| `POST /oauth/register` · `GET /oauth/authorize` · `POST /oauth/token` · `POST /oauth/revoke` | OAuth |
| `GET /auth/oauth/requests/:id` · `POST …/approve` · `POST …/deny` | Consent (member) |
| `GET /auth/oauth/grants` · `DELETE /auth/oauth/grants/:id` | Connected apps |

## Invariants & gotchas
- An access token's audience is `/mcp`. `authenticate` accepts it only on `/mcp`, `/mcp/:biz`
  (its own business) and on in-process tool calls that carry the per-process secret header
  (`platform/inner-call.ts`) for its business. Never directly on `/v1`.
- Revoking the grant's API key (Settings → Developer) ends the grant too.
- The issuer is `MCP_PUBLIC_URL`, else `ADVERTISED_API_URL`, else the request origin. A dedicated
  MCP host (`https://mcp.example.com`) must set `MCP_PUBLIC_URL`: connectors refuse metadata
  that names another origin, and the API's own host then never appears to a connector. The
  host's proxy forwards only `/mcp`, `/.well-known/oauth-*` and `/oauth/`.

## Changelog
- **2026-11-27** — Issuer fallback: `MCP_PUBLIC_URL`, else `ADVERTISED_API_URL`, else the request origin, now
  normalised (a default port in the Host header no longer makes the issuer differ from the resource URLs).
- **2026-11-07** — `MCP_PUBLIC_URL`: a dedicated public host for the MCP server and its OAuth.
  Gate: `verify:mcp-oauth` § I.
- **2026-11-06** — Created (0503, feat/mcp-server). Gate: `verify:mcp-oauth` (42 checks, incl.
  the official MCP SDK OAuth client end to end).
