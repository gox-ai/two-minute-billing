/**
 * OAuth 2.1 for the MCP server, end to end over real HTTP.
 *
 *  - § A discovery: the 401 points at the resource metadata; AS metadata advertises S256,
 *        CIMD, public clients and `iss`
 *  - § B registration and authorize: bad redirects refused; PKCE required; loopback any port
 *  - § C consent: session only; a business of the member's org only; answered once
 *  - § D tokens: PKCE checked; the token works at /mcp, pinned to its business, and nowhere
 *        else (not /v1, not another business, not with a forged inner-call header)
 *  - § E refresh rotates; a reused refresh token or code ends the grant
 *  - § F a client metadata document (CIMD) client
 *  - § G connected apps: listed, revoked; RFC 7009 revoke
 *  - § H the official MCP SDK OAuth client, end to end
 *  - § I a dedicated MCP host (MCP_PUBLIC_URL): every advertised URL uses it
 *
 *   pnpm verify:mcp-oauth
 */
import { createHash, randomBytes } from "node:crypto";
import { buildApp } from "@/index";
import { closeDb, systemDb } from "@/platform/db";
import { config } from "@/platform/config";
import { eq } from "drizzle-orm";
import { apiKeys, oauthGrants } from "@db/schema";
import { signup } from "@/modules/auth/service";
import { createBusiness, createOrganization, listApiKeys } from "@/modules/tenancy/service";
import { createCustomer } from "@/modules/customers/service";
import { setMetadataFetcherForTests } from "@/modules/oauth/service";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");

const owner = await signup({
  email: `oauth-${uniq}@example.com`,
  password: "Heron-Lattice-50217",
  organizationName: `OAuth ${uniq}`,
});
const cookie = `tmb_session=${owner.token}`;
const orgId = owner.user.organizationId;
const biz = await createBusiness({
  organizationId: orgId,
  name: `OAuth Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const biz2 = await createBusiness({
  organizationId: orgId,
  name: `OAuth Biz2 ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
const other = await createOrganization({ name: `OAuth Other ${uniq}` });
const foreignBiz = await createBusiness({
  organizationId: other.organization.id,
  name: `Foreign ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
await createCustomer({
  organizationId: orgId,
  businessId: biz.id,
  email: `buyer-${uniq}@example.com`,
  firstName: "Larkfield",
});

const verifier = () => randomBytes(32).toString("base64url");
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url");
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

const mcp = (
  token: string | null,
  url: string,
  method = "tools/list",
  params: Record<string, unknown> = {},
  extra: Record<string, string> = {},
) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });

const register = (redirect_uris: string[], client_name = "Verify Client") =>
  app.inject({ method: "POST", url: "/oauth/register", payload: { redirect_uris, client_name } });

const authorize = (q: Record<string, string>) =>
  app.inject({ method: "GET", url: `/oauth/authorize?${qs(q)}` });

const consentId = (location: string) => location.split("/oauth/consent/")[1] ?? "";

const approve = (id: string, business: string, withCookie = true) =>
  app.inject({
    method: "POST",
    url: `/auth/oauth/requests/${id}/approve`,
    headers: withCookie ? { cookie } : {},
    payload: { business },
  });

const token = (body: Record<string, string>) =>
  app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: qs(body),
  });

/** Register, authorize, approve, exchange: the whole happy path. */
async function connect(redirect = "https://client.example.com/cb", business = biz.publicId) {
  const reg = (await register([redirect])).json() as { client_id: string };
  const v = verifier();
  const a = await authorize({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: redirect,
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "mcp:read",
  });
  const id = consentId(String(a.headers.location));
  const decided = (await approve(id, business)).json() as { redirect_to: string };
  const code = new URL(decided.redirect_to).searchParams.get("code")!;
  const t = await token({
    grant_type: "authorization_code",
    code,
    client_id: reg.client_id,
    redirect_uri: redirect,
    code_verifier: v,
  });
  return {
    client: reg.client_id,
    code,
    v,
    redirect,
    tokens: t.json() as Record<string, string>,
    decided,
  };
}

// ── § A · discovery ──────────────────────────────────────────────────────────────
let issuer = "";
{
  const r = await mcp(null, `/mcp/${biz.publicId}`);
  const www = String(r.headers["www-authenticate"] ?? "");
  const metaUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1] ?? "";
  ok(
    "A1 no credential → 401 naming the resource metadata",
    r.statusCode === 401 &&
      metaUrl.includes("/.well-known/oauth-protected-resource/") &&
      metaUrl.endsWith(`/mcp/${biz.publicId}`),
  );
  const prm = await app.inject({ method: "GET", url: new URL(metaUrl).pathname });
  const p = prm.json();
  issuer = p.authorization_servers?.[0] ?? "";
  ok(
    "A2 resource metadata names the resource and the issuer",
    !!issuer && p.resource === `${issuer}/mcp/${biz.publicId}`,
  );
  const as = (
    await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })
  ).json();
  ok(
    "A3 AS metadata: S256, CIMD, public clients, iss",
    as.issuer === issuer &&
      JSON.stringify(as.code_challenge_methods_supported) === '["S256"]' &&
      as.client_id_metadata_document_supported === true &&
      as.token_endpoint_auth_methods_supported.includes("none") &&
      as.authorization_response_iss_parameter_supported === true,
  );
}

// ── § B · registration and authorize ─────────────────────────────────────────────
{
  ok(
    "B1 an http redirect to a public host is refused",
    (await register(["http://evil.example.com/cb"])).statusCode === 400,
  );
  const good = await register(["https://client.example.com/cb", "http://127.0.0.1/callback"]);
  const c = good.json();
  ok(
    "B2 a valid registration → 201 with a public client",
    good.statusCode === 201 &&
      c.client_id?.startsWith("tmc_") &&
      c.token_endpoint_auth_method === "none",
  );
  const v = verifier();
  const base = {
    response_type: "code",
    client_id: c.client_id,
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
    state: "xyz",
  };
  const wrongRedirect = await authorize({
    ...base,
    redirect_uri: "https://attacker.example.com/cb",
  });
  ok(
    "B3 an unregistered redirect is shown an error, never redirected",
    wrongRedirect.statusCode === 400 && !wrongRedirect.headers.location,
  );
  const noPkce = await authorize({
    response_type: "code",
    client_id: c.client_id,
    redirect_uri: "https://client.example.com/cb",
    state: "xyz",
  });
  const loc = String(noPkce.headers.location ?? "");
  ok(
    "B4 no PKCE → back to the client with invalid_request, state and iss",
    noPkce.statusCode === 302 &&
      loc.includes("error=invalid_request") &&
      loc.includes("state=xyz") &&
      loc.includes("iss="),
  );
  const plain = await authorize({
    ...base,
    redirect_uri: "https://client.example.com/cb",
    code_challenge_method: "plain",
  });
  ok(
    "B5 the plain PKCE method is refused",
    String(plain.headers.location).includes("error=invalid_request"),
  );
  const loop = await authorize({ ...base, redirect_uri: "http://127.0.0.1:53682/callback" });
  ok(
    "B6 a loopback redirect may use any port",
    loop.statusCode === 302 && String(loop.headers.location).includes("/oauth/consent/oar_"),
  );
  const badScope = await authorize({
    ...base,
    redirect_uri: "https://client.example.com/cb",
    scope: "admin",
  });
  ok(
    "B7 an unknown scope → invalid_scope",
    String(badScope.headers.location).includes("error=invalid_scope"),
  );
}

// ── § C · consent ────────────────────────────────────────────────────────────────
{
  const reg = (await register(["https://client.example.com/cb"], "Consent Client")).json();
  const v = verifier();
  const a = await authorize({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: "https://client.example.com/cb",
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
    state: "s",
  });
  const id = consentId(String(a.headers.location));
  const anon = await app.inject({ method: "GET", url: `/auth/oauth/requests/${id}` });
  ok("C1 the request needs a signed-in member", anon.statusCode === 401);
  const view = await app.inject({
    method: "GET",
    url: `/auth/oauth/requests/${id}`,
    headers: { cookie },
  });
  const vb = view.json();
  ok(
    "C2 the member sees the client and their businesses",
    view.statusCode === 200 &&
      vb.client_name === "Consent Client" &&
      vb.redirect_host === "client.example.com" &&
      vb.businesses.some((b: { id: string }) => b.id === biz.publicId),
  );
  ok(
    "C3 another organization's business is not offered",
    !vb.businesses.some((b: { id: string }) => b.id === foreignBiz.publicId),
  );
  const foreign = await approve(id, foreignBiz.publicId);
  ok("C4 approving for another organization's business → 400", foreign.statusCode === 400);
  const yes = await approve(id, biz.publicId);
  const to = new URL(yes.json().redirect_to);
  ok(
    "C5 approve → redirect with code, state and iss",
    to.searchParams.get("code")?.startsWith("tmo_cd_") === true &&
      to.searchParams.get("state") === "s" &&
      to.searchParams.get("iss") === issuer,
  );
  ok("C6 a request is answered once", (await approve(id, biz.publicId)).statusCode === 400);
  const wrongVerifier = await token({
    grant_type: "authorization_code",
    code: to.searchParams.get("code")!,
    client_id: reg.client_id,
    redirect_uri: "https://client.example.com/cb",
    code_verifier: verifier(),
  });
  ok(
    "C7 a wrong PKCE verifier → invalid_grant",
    wrongVerifier.statusCode === 400 && wrongVerifier.json().error === "invalid_grant",
  );
}

// ── § D · tokens and their reach ─────────────────────────────────────────────────
const c1 = await connect();
{
  ok(
    "D1 exchange → access and refresh tokens",
    !!c1.tokens.access_token?.startsWith("tmo_at_") &&
      !!c1.tokens.refresh_token?.startsWith("tmo_rt_") &&
      Number(c1.tokens.expires_in) > 0,
  );
  const at = c1.tokens.access_token!;
  const listed = await mcp(at, "/mcp");
  ok(
    "D2 the token lists tools at bare /mcp",
    listed.statusCode === 200 && (listed.json().result?.tools ?? []).length > 10,
  );
  const who = await mcp(at, "/mcp", "tools/call", { name: "get_business", arguments: {} });
  ok(
    "D3 bare /mcp is pinned to the granted business",
    who.json().result?.content?.[0]?.text.includes(biz.publicId),
  );
  const search = await mcp(at, `/mcp/${biz.publicId}`, "tools/call", {
    name: "search_customers",
    arguments: { query: `buyer-${uniq}` },
  });
  ok(
    "D4 a tool reads data through the routes",
    search.json().result?.content?.[0]?.text.includes(`buyer-${uniq}`),
  );
  ok(
    "D5 another business of the same org → 401",
    (await mcp(at, `/mcp/${biz2.publicId}`)).statusCode === 401,
  );
  const direct = await app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}/customers`,
    headers: { authorization: `Bearer ${at}` },
  });
  ok("D6 the token cannot call /v1 directly", direct.statusCode === 401);
  const forged = await app.inject({
    method: "GET",
    url: `/v1/businesses/${biz.publicId}/customers`,
    headers: { authorization: `Bearer ${at}`, "x-tmb-inner-call": "0".repeat(64) },
  });
  ok("D7 a forged inner-call header does not help", forged.statusCode === 401);
  const [g] = await systemDb
    .select({ key: apiKeys })
    .from(oauthGrants)
    .innerJoin(apiKeys, eq(oauthGrants.apiKeyId, apiKeys.id))
    .where(eq(oauthGrants.organizationId, orgId))
    .limit(1);
  const map = g?.key.permissions ?? {};
  ok(
    "D8 the grant's key is read-only, mapped from the member, with mcp",
    g?.key.scope === "read" &&
      Object.values(map).every((x) => x === "read") &&
      map.mcp === "read" &&
      map.invoices === "read",
  );
}

// ── § E · refresh rotation and replay ────────────────────────────────────────────
{
  const r1 = await token({
    grant_type: "refresh_token",
    refresh_token: c1.tokens.refresh_token!,
    client_id: c1.client,
  });
  const t2 = r1.json();
  ok(
    "E1 refresh → a new pair",
    r1.statusCode === 200 && t2.refresh_token !== c1.tokens.refresh_token,
  );
  ok("E2 the new access token works", (await mcp(t2.access_token, "/mcp")).statusCode === 200);
  const reuse = await token({
    grant_type: "refresh_token",
    refresh_token: c1.tokens.refresh_token!,
    client_id: c1.client,
  });
  ok(
    "E3 a reused refresh token → invalid_grant",
    reuse.statusCode === 400 && reuse.json().error === "invalid_grant",
  );
  ok(
    "E4 …and the grant is ended: the new token stops working",
    (await mcp(t2.access_token, "/mcp")).statusCode === 401,
  );

  const c2 = await connect();
  const again = await token({
    grant_type: "authorization_code",
    code: c2.code,
    client_id: c2.client,
    redirect_uri: c2.redirect,
    code_verifier: c2.v,
  });
  ok("E5 a code used twice → invalid_grant", again.statusCode === 400);
  ok(
    "E6 …and the tokens it produced stop working",
    (await mcp(c2.tokens.access_token!, "/mcp")).statusCode === 401,
  );
  const wrongClient = await connect();
  const stolen = await token({
    grant_type: "refresh_token",
    refresh_token: wrongClient.tokens.refresh_token!,
    client_id: "tmc_someoneelse",
  });
  ok("E7 a refresh token presented by another client → invalid_grant", stolen.statusCode === 400);
}

// ── § F · a client metadata document client ──────────────────────────────────────
{
  const cid = "https://cimd.example.com/oauth/client.json";
  setMetadataFetcherForTests(async (url) =>
    url === cid
      ? {
          client_id: cid,
          client_name: "Metadata Client",
          redirect_uris: ["https://cimd.example.com/cb"],
        }
      : { client_id: "https://somewhere.else/x", redirect_uris: ["https://cimd.example.com/cb"] },
  );
  const v = verifier();
  const a = await authorize({
    response_type: "code",
    client_id: cid,
    redirect_uri: "https://cimd.example.com/cb",
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
  });
  ok(
    "F1 a CIMD client reaches consent",
    a.statusCode === 302 && String(a.headers.location).includes("/oauth/consent/"),
  );
  const view = await app.inject({
    method: "GET",
    url: `/auth/oauth/requests/${consentId(String(a.headers.location))}`,
    headers: { cookie },
  });
  ok("F2 consent shows the document's client name", view.json().client_name === "Metadata Client");
  const mismatch = await authorize({
    response_type: "code",
    client_id: "https://cimd.example.com/other.json",
    redirect_uri: "https://cimd.example.com/cb",
    code_challenge: challengeOf(v),
    code_challenge_method: "S256",
  });
  ok("F3 a document whose client_id differs from its URL is refused", mismatch.statusCode === 400);
  setMetadataFetcherForTests(null);
}

// ── § G · connected apps and revocation ──────────────────────────────────────────
{
  const keep = await connect();
  const drop = await connect();
  const list = await app.inject({ method: "GET", url: "/auth/oauth/grants", headers: { cookie } });
  const rows = list.json().data as Array<{ id: string; business: string; client_id: string }>;
  const target = rows.find((r) => r.client_id === drop.client);
  ok(
    "G1 connected apps are listed with their business",
    list.statusCode === 200 && !!target && rows.every((r) => r.business === biz.publicId),
  );
  ok(
    "G1b a connected app's key is not in the API keys list",
    (await listApiKeys(orgId)).every((k) => !/\(connected app\)$/.test(k.name ?? "")),
  );
  const del = await app.inject({
    method: "DELETE",
    url: `/auth/oauth/grants/${target?.id}`,
    headers: { cookie },
  });
  ok(
    "G2 disconnecting an app ends its token",
    del.statusCode === 200 && (await mcp(drop.tokens.access_token!, "/mcp")).statusCode === 401,
  );
  ok(
    "G3 another connected app keeps working",
    (await mcp(keep.tokens.access_token!, "/mcp")).statusCode === 200,
  );
  const c4 = await connect();
  await app.inject({
    method: "POST",
    url: "/oauth/revoke",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: qs({ token: c4.tokens.refresh_token! }),
  });
  ok(
    "G4 revoking the refresh token (RFC 7009) ends the grant",
    (await mcp(c4.tokens.access_token!, "/mcp")).statusCode === 401,
  );
}

// ── § H · the official MCP SDK OAuth client ──────────────────────────────────────
{
  const injectFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    // Play the reverse proxy: a prefixed issuer (`https://host/api`) reaches the app without it.
    const prefix = new URL(issuer).pathname.replace(/\/+$/, "");
    const path =
      prefix && u.pathname.startsWith(`${prefix}/`) ? u.pathname.slice(prefix.length) : u.pathname;
    const body = init?.body;
    const r = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: path + u.search,
      headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: u.host },
      ...(typeof body === "string"
        ? { payload: body }
        : body instanceof URLSearchParams
          ? { payload: body.toString() }
          : {}),
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(r.headers)) if (v !== undefined) headers.set(k, String(v));
    const empty = r.statusCode === 202 || r.statusCode === 204 || r.statusCode === 302;
    return new Response(empty ? null : r.body, { status: r.statusCode, headers });
  };
  const store: { client?: unknown; tokens?: unknown; verifier?: string; authUrl?: URL } = {};
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return "http://127.0.0.1:47123/callback";
    },
    get clientMetadata() {
      return {
        client_name: "SDK Client",
        redirect_uris: ["http://127.0.0.1:47123/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => store.client as never,
    saveClientInformation: (c) => void (store.client = c),
    tokens: () => store.tokens as never,
    saveTokens: (t) => void (store.tokens = t),
    redirectToAuthorization: (u) => void (store.authUrl = u),
    saveCodeVerifier: (v) => void (store.verifier = v),
    codeVerifier: () => store.verifier!,
  };
  const serverUrl = `${issuer}/mcp/${biz.publicId}`;
  const first = await auth(provider, { serverUrl, fetchFn: injectFetch });
  ok(
    "H1 the SDK discovers, registers and asks for authorization",
    first === "REDIRECT" && !!store.authUrl,
  );
  const a = await injectFetch(store.authUrl!);
  const id = consentId(String(a.headers.get("location")));
  const decided = (await approve(id, biz.publicId)).json() as { redirect_to: string };
  const code = new URL(decided.redirect_to).searchParams.get("code")!;
  const second = await auth(provider, { serverUrl, authorizationCode: code, fetchFn: injectFetch });
  ok(
    "H2 the SDK exchanges the code",
    second === "AUTHORIZED" && !!(store.tokens as { access_token?: string })?.access_token,
  );
  const client = new Client({ name: "verify-oauth", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(serverUrl), {
      authProvider: provider,
      fetch: injectFetch,
    }),
  );
  const { tools } = await client.listTools();
  ok("H3 the SDK client lists tools with its OAuth token", tools.length > 10);
  await client.close();
}

// ── § I · a dedicated MCP host ───────────────────────────────────────────────────
{
  const cfg = config as { MCP_PUBLIC_URL?: string; WEBHOOK_BASE_URL?: string };
  const before = { mcp: cfg.MCP_PUBLIC_URL, webhook: cfg.WEBHOOK_BASE_URL };
  cfg.WEBHOOK_BASE_URL = "https://api-internal.example.com";
  cfg.MCP_PUBLIC_URL = "https://mcp.example.com/";
  const r = await mcp(null, `/mcp/${biz.publicId}`);
  const www = String(r.headers["www-authenticate"] ?? "");
  const p = (
    await app.inject({
      method: "GET",
      url: `/.well-known/oauth-protected-resource/mcp/${biz.publicId}`,
    })
  ).json();
  const as = (
    await app.inject({ method: "GET", url: "/.well-known/oauth-authorization-server" })
  ).json();
  const seen = JSON.stringify([www, p, as]);
  ok(
    "I1 MCP_PUBLIC_URL names the resource, the issuer and every endpoint",
    www.includes(
      `resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp/${biz.publicId}"`,
    ) &&
      p.resource === `https://mcp.example.com/mcp/${biz.publicId}` &&
      p.authorization_servers?.[0] === "https://mcp.example.com" &&
      as.issuer === "https://mcp.example.com" &&
      as.token_endpoint === "https://mcp.example.com/oauth/token" &&
      as.authorization_endpoint === "https://mcp.example.com/oauth/authorize",
  );
  ok("I2 the API's own host never appears to a connector", !seen.includes("api-internal"));
  cfg.MCP_PUBLIC_URL = before.mcp;
  cfg.WEBHOOK_BASE_URL = before.webhook;
}

await app.close();
let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
await closeDb();
process.exit(failed ? 1 : 0);
