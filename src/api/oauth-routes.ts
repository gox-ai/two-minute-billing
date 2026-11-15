/**
 * OAuth 2.1 for the MCP server: discovery, client registration, authorize, token, revoke,
 * and the signed-in member's consent and connected-app routes.
 *
 * Flow: the client discovers us from the 401 on /mcp → registers (or presents a metadata URL
 * as its client id) → sends the member to /oauth/authorize → we park the request and send the
 * member to the dashboard's consent page → the member selects a business and approves → the
 * dashboard calls /auth/oauth/requests/:id/approve → we redirect to the client with a code →
 * the client exchanges it, with its PKCE verifier, at /oauth/token.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@/platform/db";
import { apiKeys, businesses, oauthGrants } from "@db/schema";
import { permissionsOf } from "@/modules/auth/service";
import { newApiKeyRefusedFor } from "@/modules/auth/org-two-factor";
import { getBusinessByPublicId, listBusinesses } from "@/modules/tenancy/service";
import { consumePublicRateLimit } from "@/platform/rate-limit";
import {
  MCP_SCOPE,
  OAuthError,
  approveRequest,
  createAuthorizationRequest,
  denyRequest,
  exchangeCode,
  getPendingRequest,
  redirectAllowed,
  refreshTokens,
  registerClient,
  resolveClient,
  revokeGrant,
  revokeToken,
} from "@/modules/oauth/service";
import { dashboardOrigin, issuerFor, issuerParts } from "@/modules/oauth/issuer";
import { refusedByOrgTwoFactor, requireMemberPermission } from "./auth-routes";
import { parseRequest } from "./strict-params";
import { badRequest } from "./helpers";

function oauthError(reply: FastifyReply, e: unknown) {
  if (!(e instanceof OAuthError)) throw e;
  const status = e.code === "invalid_client" ? 401 : 400;
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .send({ error: e.code, error_description: e.message });
}

/** Resource metadata for a resource at `publicPath` (the path as the client sees it). */
export function protectedResourceMetadata(req: FastifyRequest, publicPath: string) {
  const { origin } = issuerParts(req);
  return {
    resource: `${origin}${publicPath}`,
    authorization_servers: [issuerFor(req)],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Two Minute Billing",
  };
}

/** Throttle the anonymous endpoints per client address. */
async function throttled(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: "oauth_register" | "oauth_authorize" | "oauth_token",
) {
  const rl = await consumePublicRateLimit({
    scope,
    keys: [{ kind: "ip", value: req.ip, limit: scope === "oauth_token" ? 60 : 20 }],
  });
  if (rl.allowed) return false;
  reply
    .code(429)
    .header("retry-after", String(rl.retryAfterSeconds))
    .send({ error: "slow_down", error_description: "Too many requests. Wait, then try again." });
  return true;
}

export async function registerOAuthRoutes(app: FastifyInstance) {
  // ── discovery ────────────────────────────────────────────────────────────────
  app.get("/.well-known/oauth-protected-resource", async (req) =>
    protectedResourceMetadata(req, `${issuerParts(req).path}/mcp`),
  );
  app.get("/.well-known/oauth-protected-resource/*", async (req) => {
    const rest = (req.params as { "*": string })["*"] ?? "";
    return protectedResourceMetadata(req, `/${rest.replace(/^\/+/, "")}`);
  });
  const asMetadata = async (req: FastifyRequest) => {
    const issuer = issuerFor(req);
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [MCP_SCOPE],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  };
  // At the root, and with the issuer's path appended (RFC 8414 §3) for a prefixed deployment.
  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/oauth-authorization-server/*", asMetadata);

  // The token and revocation endpoints take form bodies (RFC 6749), and JSON as well.
  await app.register(async (form) => {
    form.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    form.post("/oauth/token", async (req, reply) => {
      if (await throttled(req, reply, "oauth_token")) return;
      const b = (req.body ?? {}) as Record<string, string | undefined>;
      reply.header("cache-control", "no-store").header("pragma", "no-cache");
      try {
        if (b.grant_type === "authorization_code") return await exchangeCode(b);
        if (b.grant_type === "refresh_token") return await refreshTokens(b);
        throw new OAuthError(
          "unsupported_grant_type",
          "grant_type must be authorization_code or refresh_token.",
        );
      } catch (e) {
        return oauthError(reply, e);
      }
    });

    form.post("/oauth/revoke", async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string | undefined>;
      await revokeToken(typeof b.token === "string" ? b.token : "");
      return reply.code(200).send({});
    });
  });

  // ── registration (RFC 7591) ─────────────────────────────────────────────────
  app.post("/oauth/register", async (req, reply) => {
    if (await throttled(req, reply, "oauth_register")) return;
    try {
      const c = await registerClient((req.body ?? {}) as Record<string, unknown>);
      return reply
        .code(201)
        .header("cache-control", "no-store")
        .send({
          client_id: c.clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: c.clientName,
          redirect_uris: c.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
    } catch (e) {
      if (e instanceof OAuthError) {
        return reply
          .code(400)
          .send({ error: "invalid_client_metadata", error_description: e.message });
      }
      throw e;
    }
  });

  // ── authorize ────────────────────────────────────────────────────────────────
  app.get("/oauth/authorize", async (req, reply) => {
    if (await throttled(req, reply, "oauth_authorize")) return;
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const issuer = issuerFor(req);
    // Until the client and redirect are known good, errors are shown, never redirected.
    const show = (msg: string) =>
      reply
        .code(400)
        .type("text/plain; charset=utf-8")
        .send(`We could not start the connection. ${msg}`);
    const client = q.client_id ? await resolveClient(q.client_id) : null;
    if (!client)
      return show("The application is not registered, or its metadata could not be read.");
    if (!q.redirect_uri || !redirectAllowed(client.redirectUris, q.redirect_uri)) {
      return show("The redirect address is not registered for this application.");
    }
    const back = (error: string, description: string) => {
      const u = new URL(q.redirect_uri!);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (q.state) u.searchParams.set("state", q.state);
      u.searchParams.set("iss", issuer);
      return reply.redirect(u.toString(), 302);
    };
    if (q.response_type !== "code")
      return back("unsupported_response_type", "response_type must be code.");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back("invalid_request", "PKCE with code_challenge_method S256 is required.");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
      return back("invalid_request", "code_challenge must be a base64url SHA-256 digest.");
    }
    const scopes = (q.scope ?? MCP_SCOPE).split(" ").filter(Boolean);
    if (scopes.some((s) => s !== MCP_SCOPE))
      return back("invalid_scope", `The only scope is ${MCP_SCOPE}.`);
    if (q.resource && !q.resource.startsWith(`${issuer}/mcp`)) {
      return back("invalid_target", "resource must be this server's MCP address.");
    }
    if (q.state && q.state.length > 500) return back("invalid_request", "state is too long.");
    const id = await createAuthorizationRequest({
      clientId: client.clientId,
      redirectUri: q.redirect_uri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge,
      scope: MCP_SCOPE,
      resource: q.resource ?? null,
    });
    return reply.redirect(`${dashboardOrigin()}/oauth/consent/${id}`, 302);
  });

  // ── the member's side (dashboard session only) ───────────────────────────────
  app.get(
    "/auth/oauth/requests/:id",
    { preHandler: requireMemberPermission("mcp:use") },
    async (req, reply) => {
      const pending = await getPendingRequest((req.params as { id: string }).id);
      if (!pending) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message:
              "We could not find this connection request. It expired or was already answered. Start again from the application.",
          },
        });
      }
      const member = req.member!;
      const list = (await listBusinesses(member.organizationId)).filter(
        (b) => b.status === "active",
      );
      return {
        object: "oauth_request",
        id: pending.request.publicId,
        client_name: pending.client.clientName,
        client_id: pending.client.clientId,
        redirect_host: new URL(pending.request.redirectUri).host,
        scope: pending.request.scope,
        expires_at: pending.request.expiresAt,
        businesses: list.map((b) => ({ id: b.publicId, name: b.name, livemode: b.livemode })),
      };
    },
  );

  const decideBody = z.object({ business: z.string().min(1).max(100) });
  app.post(
    "/auth/oauth/requests/:id/approve",
    { preHandler: requireMemberPermission("mcp:connect") },
    async (req, reply) => {
      const member = req.member!;
      if (await refusedByOrgTwoFactor(member, reply)) return;
      if (await newApiKeyRefusedFor(member.userId, member.organizationId)) {
        return reply.code(403).send({
          error: {
            type: "two_factor_setup_required",
            message:
              "Your organization requires two-factor authentication. Set it up to connect an application.",
          },
        });
      }
      const parsed = parseRequest(decideBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const biz = await getBusinessByPublicId(member.organizationId, parsed.data.business);
      if (!biz || biz.status !== "active") {
        return reply.code(400).send({
          error: {
            type: "invalid_request_error",
            message: "Select a business of this organization.",
          },
        });
      }
      try {
        const redirect_to = await approveRequest({
          id: (req.params as { id: string }).id,
          issuer: issuerFor(req),
          organizationId: member.organizationId,
          userId: member.userId,
          memberPermissions: permissionsOf(member),
          business: { id: biz.id, livemode: biz.livemode },
        });
        return { object: "oauth_decision", redirect_to };
      } catch (e) {
        if (e instanceof OAuthError) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  app.post(
    "/auth/oauth/requests/:id/deny",
    { preHandler: requireMemberPermission("mcp:connect") },
    async (req, reply) => {
      try {
        const redirect_to = await denyRequest((req.params as { id: string }).id, issuerFor(req));
        return { object: "oauth_decision", redirect_to };
      } catch (e) {
        if (e instanceof OAuthError) {
          return reply
            .code(400)
            .send({ error: { type: "invalid_request_error", message: e.message } });
        }
        throw e;
      }
    },
  );

  // Connected apps: every grant in the organization that is still active.
  app.get(
    "/auth/oauth/grants",
    { preHandler: requireMemberPermission("api_keys:view") },
    async (req) => {
      const orgId = req.member!.organizationId;
      const rows = await withTenant(orgId, (tx) =>
        tx
          .select({
            g: oauthGrants,
            biz: businesses.publicId,
            bizName: businesses.name,
            lastUsed: apiKeys.lastUsedAt,
          })
          .from(oauthGrants)
          .innerJoin(businesses, eq(oauthGrants.businessId, businesses.id))
          .innerJoin(apiKeys, eq(oauthGrants.apiKeyId, apiKeys.id))
          .where(and(isNull(oauthGrants.revokedAt), isNull(apiKeys.revokedAt)))
          .orderBy(desc(oauthGrants.createdAt)),
      );
      return {
        object: "list",
        data: rows.map((r) => ({
          id: r.g.publicId,
          client_name: r.g.clientName,
          client_id: r.g.clientId,
          business: r.biz,
          business_name: r.bizName,
          scope: r.g.scope,
          created_at: r.g.createdAt,
          last_used_at: r.lastUsed,
        })),
      };
    },
  );

  app.delete(
    "/auth/oauth/grants/:id",
    { preHandler: requireMemberPermission("mcp:connect") },
    async (req, reply) => {
      const orgId = req.member!.organizationId;
      const [g] = await withTenant(orgId, (tx) =>
        tx
          .select({ id: oauthGrants.id })
          .from(oauthGrants)
          .where(eq(oauthGrants.publicId, (req.params as { id: string }).id))
          .limit(1),
      );
      if (!g) {
        return reply.code(404).send({
          error: {
            type: "invalid_request_error",
            message: "We could not find this connected app.",
          },
        });
      }
      await revokeGrant(orgId, g.id);
      return { object: "oauth_grant", id: (req.params as { id: string }).id, revoked: true };
    },
  );
}
