/**
 * OAuth 2.1 authorization server for the MCP server.
 *
 * Public clients only (no client secret), PKCE S256 required, authorization code grant plus
 * rotating refresh tokens. Clients come from dynamic registration (`tmc_…`) or a client ID
 * metadata document (the client id IS an https URL we fetch). A grant is backed by a
 * read-only API key whose permission map is the approving member's own read permissions, so
 * a connected app can never read more than the person who connected it.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { hashApiKey } from "@/platform/api-key";
import { publicId } from "@/platform/ids";
import { outboundFetch } from "@/platform/outbound";
import { createLogger } from "@/platform/logger";
import {
  apiKeys,
  businesses,
  oauthClients,
  oauthGrants,
  oauthRequests,
  oauthTokens,
  organizations,
} from "@db/schema";
import { createApiKey, revokeApiKey, type AuthContext } from "@/modules/tenancy/service";
import { PERMISSIONS, type KeyPermissionMap } from "@/modules/auth/permissions";

const log = createLogger("oauth");

export const MCP_SCOPE = "mcp:read";
export const CODE_TTL_MS = 10 * 60_000;
export const REQUEST_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_S = 3600;
export const REFRESH_TTL_MS = 30 * 86_400_000;
const CIMD_TTL_MS = 60 * 60_000;
const CIMD_MAX_BYTES = 64 * 1024;

export class OAuthError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "unsupported_grant_type"
      | "invalid_scope"
      | "access_denied",
    message: string,
  ) {
    super(message);
  }
}

const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
export const ACCESS_PREFIX = "tmo_at_";
const REFRESH_PREFIX = "tmo_rt_";
const CODE_PREFIX = "tmo_cd_";

export function isOAuthAccessToken(raw: string): boolean {
  return raw.startsWith(ACCESS_PREFIX);
}

/** S256: BASE64URL(SHA256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

// ── redirect URIs ──────────────────────────────────────────────────────────────

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https anywhere, or http on a loopback host (native clients, RFC 8252). No fragments. */
export function redirectUriShapeOk(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK.has(u.hostname);
}

/** Exact match, except that a loopback redirect may use any port (RFC 8252 §7.3). */
export function redirectAllowed(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (r.protocol !== "http:" || !LOOPBACK.has(r.hostname)) return false;
  return registered.some((reg) => {
    try {
      const g = new URL(reg);
      return (
        g.protocol === "http:" &&
        g.hostname === r.hostname &&
        g.pathname === r.pathname &&
        g.search === r.search
      );
    } catch {
      return false;
    }
  });
}

// ── clients ────────────────────────────────────────────────────────────────────

export interface OAuthClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
}

export async function registerClient(input: {
  redirect_uris?: unknown;
  client_name?: unknown;
}): Promise<OAuthClient> {
  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
    throw new OAuthError("invalid_request", "redirect_uris must list 1 to 10 URIs.");
  }
  for (const u of uris) {
    if (typeof u !== "string" || u.length > 500 || !redirectUriShapeOk(u)) {
      throw new OAuthError(
        "invalid_request",
        "Each redirect URI must be https, or http on localhost, with no fragment.",
      );
    }
  }
  const name =
    typeof input.client_name === "string" && input.client_name.trim()
      ? input.client_name.trim().slice(0, 100)
      : null;
  const clientId = publicId("tmc");
  await systemDb.insert(oauthClients).values({
    clientId,
    kind: "dcr",
    clientName: name,
    redirectUris: uris as string[],
  });
  return { clientId, clientName: name, redirectUris: uris as string[] };
}

/** A fetcher for client metadata documents; replaced in tests. */
export type MetadataFetcher = (url: string) => Promise<unknown>;

async function fetchMetadataDocument(url: string): Promise<unknown> {
  const res = await outboundFetch(url, {
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status !== 200) throw new Error(`metadata document answered ${res.status}`);
  const text = await res.text();
  if (text.length > CIMD_MAX_BYTES) throw new Error("metadata document too large");
  return JSON.parse(text);
}

let metadataFetcher: MetadataFetcher = fetchMetadataDocument;
export function setMetadataFetcherForTests(f: MetadataFetcher | null): void {
  metadataFetcher = f ?? fetchMetadataDocument;
}

function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === "https:" && u.pathname !== "/" && !u.hash;
  } catch {
    return false;
  }
}

export async function resolveClient(clientId: string): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 500) return null;
  const [row] = await systemDb
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  const fresh =
    row &&
    (row.kind === "dcr" || (row.fetchedAt && Date.now() - row.fetchedAt.getTime() < CIMD_TTL_MS));
  if (row && fresh) {
    return { clientId, clientName: row.clientName, redirectUris: row.redirectUris };
  }
  if (!isCimdClientId(clientId)) return null;
  let doc: Record<string, unknown>;
  try {
    doc = (await metadataFetcher(clientId)) as Record<string, unknown>;
  } catch (e) {
    log.warn("client metadata document fetch failed", {
      event: "oauth_cimd_fetch_failed",
      clientId,
      error: String(e),
    });
    return null;
  }
  const uris = doc?.redirect_uris;
  if (
    doc?.client_id !== clientId ||
    !Array.isArray(uris) ||
    uris.length === 0 ||
    !uris.every((u) => typeof u === "string" && redirectUriShapeOk(u))
  ) {
    return null;
  }
  const name = typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : null;
  await systemDb
    .insert(oauthClients)
    .values({
      clientId,
      kind: "cimd",
      clientName: name,
      redirectUris: uris as string[],
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: { clientName: name, redirectUris: uris as string[], fetchedAt: new Date() },
    });
  return { clientId, clientName: name, redirectUris: uris as string[] };
}

// ── authorization requests ─────────────────────────────────────────────────────

export async function createAuthorizationRequest(input: {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string;
  resource: string | null;
}): Promise<string> {
  const id = publicId("oar");
  await systemDb.insert(oauthRequests).values({
    publicId: id,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    state: input.state,
    codeChallenge: input.codeChallenge,
    scope: input.scope,
    resource: input.resource,
    expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
  });
  return id;
}

export async function getPendingRequest(id: string) {
  const [row] = await systemDb
    .select()
    .from(oauthRequests)
    .where(
      and(
        eq(oauthRequests.publicId, id),
        isNull(oauthRequests.decidedAt),
        gt(oauthRequests.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (!row) return null;
  const client = await resolveClient(row.clientId);
  return client ? { request: row, client } : null;
}

/** Claim the request for a decision, once. Null when it was already decided or expired. */
async function claimRequest(id: string) {
  const [row] = await systemDb
    .update(oauthRequests)
    .set({ decidedAt: new Date() })
    .where(
      and(
        eq(oauthRequests.publicId, id),
        isNull(oauthRequests.decidedAt),
        gt(oauthRequests.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return row ?? null;
}

function redirectWith(base: string, params: Record<string, string | null | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

/** The read-only map a member's own permissions allow, plus MCP. */
export function readMapFor(memberPermissions: Iterable<string>): KeyPermissionMap {
  const held = new Set(memberPermissions);
  const map: KeyPermissionMap = {};
  for (const p of PERMISSIONS) {
    if (p.mode === "read" && !p.operatorOnly && held.has(p.key)) map[p.resource] = "read";
  }
  map.mcp = "read";
  return map;
}

export async function approveRequest(input: {
  id: string;
  issuer: string;
  organizationId: string;
  userId: string;
  memberPermissions: Iterable<string>;
  business: { id: string; livemode: string };
}): Promise<string> {
  const req = await claimRequest(input.id);
  if (!req)
    throw new OAuthError("invalid_request", "This request expired or was already answered.");
  const client = await resolveClient(req.clientId);
  const name = `${client?.clientName ?? "AI assistant"} (connected app)`.slice(0, 100);
  const { apiKey } = await createApiKey(
    input.organizationId,
    input.business.livemode === "live" ? "live" : "test",
    "api",
    "read",
    name,
    null,
    readMapFor(input.memberPermissions),
  );
  const code = token(CODE_PREFIX);
  await withTenant(input.organizationId, async (tx) => {
    const [grant] = await tx
      .insert(oauthGrants)
      .values({
        publicId: publicId("ogr"),
        organizationId: input.organizationId,
        businessId: input.business.id,
        userId: input.userId,
        apiKeyId: apiKey.id,
        clientId: req.clientId,
        clientName: client?.clientName ?? null,
        scope: req.scope,
      })
      .returning();
    await tx.insert(oauthTokens).values({
      organizationId: input.organizationId,
      grantId: grant!.id,
      kind: "code",
      tokenHash: hashApiKey(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
    });
  });
  return redirectWith(req.redirectUri, { code, state: req.state, iss: input.issuer });
}

export async function denyRequest(id: string, issuer: string): Promise<string> {
  const req = await claimRequest(id);
  if (!req)
    throw new OAuthError("invalid_request", "This request expired or was already answered.");
  return redirectWith(req.redirectUri, { error: "access_denied", state: req.state, iss: issuer });
}

// ── tokens ─────────────────────────────────────────────────────────────────────

type TokenRow = typeof oauthTokens.$inferSelect & {
  grant: typeof oauthGrants.$inferSelect;
};

async function findToken(raw: string, kind: "code" | "refresh"): Promise<TokenRow | null> {
  const [row] = await systemDb
    .select({ t: oauthTokens, g: oauthGrants })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .where(and(eq(oauthTokens.tokenHash, hashApiKey(raw)), eq(oauthTokens.kind, kind)))
    .limit(1);
  return row ? { ...row.t, grant: row.g } : null;
}

/** Revoke a grant and the key behind it. Every token of the grant stops working. */
export async function revokeGrant(organizationId: string, grantId: string): Promise<void> {
  const [g] = await withTenant(organizationId, (tx) =>
    tx
      .update(oauthGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
      .returning(),
  );
  if (!g) return;
  const [k] = await withTenant(organizationId, (tx) =>
    tx
      .select({ publicId: apiKeys.publicId })
      .from(apiKeys)
      .where(eq(apiKeys.id, g.apiKeyId))
      .limit(1),
  );
  if (k) await revokeApiKey(organizationId, k.publicId);
}

/** Marks a token used, once. False when someone used it first (a replay). */
async function consumeOnce(organizationId: string, tokenId: string): Promise<boolean> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .update(oauthTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthTokens.id, tokenId), isNull(oauthTokens.usedAt)))
      .returning({ id: oauthTokens.id }),
  );
  return rows.length === 1;
}

async function issuePair(organizationId: string, grantId: string, scope: string) {
  const access = token(ACCESS_PREFIX);
  const refresh = token(REFRESH_PREFIX);
  await withTenant(organizationId, (tx) =>
    tx.insert(oauthTokens).values([
      {
        organizationId,
        grantId,
        kind: "access",
        tokenHash: hashApiKey(access),
        expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
      },
      {
        organizationId,
        grantId,
        kind: "refresh",
        tokenHash: hashApiKey(refresh),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    ]),
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope,
  };
}

export async function exchangeCode(input: {
  code?: string;
  client_id?: string;
  redirect_uri?: string;
  code_verifier?: string;
}) {
  if (!input.code || !input.client_id || !input.redirect_uri || !input.code_verifier) {
    throw new OAuthError(
      "invalid_request",
      "code, client_id, redirect_uri and code_verifier are required.",
    );
  }
  const row = await findToken(input.code, "code");
  if (!row) throw new OAuthError("invalid_grant", "The code is not valid.");
  const org = row.organizationId;
  if (row.usedAt) {
    // A code used twice means it leaked: end the grant it produced (RFC 9700 §4.10).
    await revokeGrant(org, row.grantId);
    throw new OAuthError("invalid_grant", "The code was already used.");
  }
  if (row.expiresAt.getTime() < Date.now())
    throw new OAuthError("invalid_grant", "The code expired.");
  if (row.grant.revokedAt) throw new OAuthError("invalid_grant", "The grant was revoked.");
  if (row.grant.clientId !== input.client_id)
    throw new OAuthError("invalid_grant", "The code belongs to another client.");
  if (row.redirectUri !== input.redirect_uri)
    throw new OAuthError("invalid_grant", "redirect_uri does not match the request.");
  if (!row.codeChallenge || !pkceMatches(input.code_verifier, row.codeChallenge)) {
    throw new OAuthError("invalid_grant", "code_verifier does not match the code challenge.");
  }
  if (!(await consumeOnce(org, row.id))) {
    await revokeGrant(org, row.grantId);
    throw new OAuthError("invalid_grant", "The code was already used.");
  }
  return issuePair(org, row.grantId, row.grant.scope);
}

export async function refreshTokens(input: { refresh_token?: string; client_id?: string }) {
  if (!input.refresh_token || !input.client_id) {
    throw new OAuthError("invalid_request", "refresh_token and client_id are required.");
  }
  const row = await findToken(input.refresh_token, "refresh");
  if (!row) throw new OAuthError("invalid_grant", "The refresh token is not valid.");
  const org = row.organizationId;
  if (row.grant.clientId !== input.client_id)
    throw new OAuthError("invalid_grant", "The refresh token belongs to another client.");
  if (row.usedAt) {
    // A rotated refresh token came back: someone holds a copy. End the grant.
    await revokeGrant(org, row.grantId);
    log.warn("refresh token reused; grant revoked", {
      event: "oauth_refresh_reuse",
      grant: row.grantId,
    });
    throw new OAuthError("invalid_grant", "The refresh token was already used.");
  }
  if (row.expiresAt.getTime() < Date.now() || row.grant.revokedAt) {
    throw new OAuthError("invalid_grant", "The refresh token expired or the grant was revoked.");
  }
  if (!(await consumeOnce(org, row.id))) {
    await revokeGrant(org, row.grantId);
    throw new OAuthError("invalid_grant", "The refresh token was already used.");
  }
  return issuePair(org, row.grantId, row.grant.scope);
}

/** RFC 7009. Unknown tokens are not an error. A refresh token ends its grant. */
export async function revokeToken(raw: string): Promise<void> {
  if (!raw) return;
  const [row] = await systemDb
    .select({ t: oauthTokens })
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, hashApiKey(raw)))
    .limit(1);
  if (!row) return;
  if (row.t.kind === "refresh") return revokeGrant(row.t.organizationId, row.t.grantId);
  await withTenant(row.t.organizationId, (tx) =>
    tx
      .update(oauthTokens)
      .set({ expiresAt: new Date(0) })
      .where(eq(oauthTokens.id, row.t.id)),
  );
}

export interface OAuthAccess {
  ctx: AuthContext;
  businessPublicId: string;
}

/** Resolve an access token to the context of the read-only key behind its grant. */
export async function authenticateOAuthAccess(raw: string): Promise<OAuthAccess | null> {
  const [row] = await systemDb
    .select({
      organization: organizations,
      apiKey: apiKeys,
      businessPublicId: businesses.publicId,
    })
    .from(oauthTokens)
    .innerJoin(oauthGrants, eq(oauthTokens.grantId, oauthGrants.id))
    .innerJoin(apiKeys, eq(oauthGrants.apiKeyId, apiKeys.id))
    .innerJoin(organizations, eq(oauthGrants.organizationId, organizations.id))
    .innerJoin(businesses, eq(oauthGrants.businessId, businesses.id))
    .where(
      and(
        eq(oauthTokens.tokenHash, hashApiKey(raw)),
        eq(oauthTokens.kind, "access"),
        gt(oauthTokens.expiresAt, sql`now()`),
        isNull(oauthGrants.revokedAt),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    businessPublicId: row.businessPublicId,
    ctx: {
      organization: row.organization,
      apiKeyId: row.apiKey.id,
      apiKeyPublicId: row.apiKey.publicId,
      keyLivemode: row.apiKey.livemode as AuthContext["keyLivemode"],
      apiKeyKind: row.apiKey.kind as AuthContext["apiKeyKind"],
      apiKeyScope: row.apiKey.scope as AuthContext["apiKeyScope"],
      apiKeyPermissions: row.apiKey.permissions ?? null,
    },
  };
}
