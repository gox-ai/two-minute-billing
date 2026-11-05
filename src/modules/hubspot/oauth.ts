import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";

const log = createLogger("hubspot.oauth");

/**
 * Must equal `requiredScopes` in `hubspot-app/src/app/app-hsmeta.json`: HubSpot refuses an
 * install whose `scope` omits a required one. `verify:hubspot-sync` checks the two agree.
 */
export const REQUIRED_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.contacts.read",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.schemas.companies.read",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
  "crm.schemas.deals.read",
  "crm.objects.products.read",
  "crm.objects.products.write",
] as const;

export const OPTIONAL_SCOPES = [
  "crm.objects.line_items.read",
  "crm.objects.line_items.write",
  "crm.objects.owners.read",
  "automation",
  // Invoice sync: a public app cannot write HubSpot's own invoice object, so invoices go to a
  // custom object. Enterprise-only, hence optional: other portals install without them.
  "crm.objects.custom.read",
  "crm.objects.custom.write",
  "crm.schemas.custom.read",
] as const;

/** What invoice sync needs. A connection made before these were requested must reconnect. */
export const INVOICE_SCOPES = [
  "crm.objects.custom.read",
  "crm.objects.custom.write",
  "crm.schemas.custom.read",
] as const;

/** Scopes from `INVOICE_SCOPES` the grant lacks. An empty grant list is unknown, not a refusal. */
export function missingInvoiceScopes(granted: readonly string[]): string[] {
  if (granted.length === 0) return [];
  return INVOICE_SCOPES.filter((s) => !granted.includes(s));
}

const TIMEOUT_MS = 15_000;

export const hubspotEnabled = (): boolean =>
  Boolean(config.HUBSPOT_CLIENT_ID && config.HUBSPOT_CLIENT_SECRET && config.HUBSPOT_REDIRECT_URI);

export class HubSpotAuthError extends Error {
  constructor(
    message: string,
    /** True when the grant itself is dead (revoked, uninstalled) — reconnecting is the fix. */
    readonly revoked = false,
  ) {
    super(message);
    this.name = "HubSpotAuthError";
  }
}

/** Everything but `state`, which the dashboard owns. All of it is public. */
export function authorizeUrlBase(): string | null {
  if (!hubspotEnabled()) return null;
  const u = new URL("/oauth/authorize", config.HUBSPOT_AUTH_BASE);
  u.searchParams.set("client_id", config.HUBSPOT_CLIENT_ID!);
  u.searchParams.set("redirect_uri", config.HUBSPOT_REDIRECT_URI!);
  u.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
  u.searchParams.set("optional_scope", OPTIONAL_SCOPES.join(" "));
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

async function tokenRequest(apiBase: string, params: Record<string, string>): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(new URL("/oauth/v1/token", apiBase), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.HUBSPOT_CLIENT_ID!,
        client_secret: config.HUBSPOT_CLIENT_SECRET!,
        ...params,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never follow: a 307/308 would resend the client secret to the new host.
      redirect: "manual",
    });
  } catch (err) {
    log.error(err, { event: "hubspot_token_unreachable", grant: params.grant_type });
    throw new HubSpotAuthError("We could not reach HubSpot");
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    log.warn("hubspot token request refused", {
      event: "hubspot_token_refused",
      grant: params.grant_type,
      status: res.status,
      detail,
    });
    // 400 on a refresh is `BAD_REFRESH_TOKEN`: the app was uninstalled or the grant revoked.
    throw new HubSpotAuthError(
      "HubSpot refused the authorization",
      params.grant_type === "refresh_token" && res.status === 400,
    );
  }
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token || !body.refresh_token)
    throw new HubSpotAuthError("HubSpot returned no token");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 1800) * 1000),
  };
}

/** Our configured redirect URI, never the caller's — HubSpot re-checks it against the app. */
export function exchangeCode(code: string, apiBase = config.HUBSPOT_API_BASE): Promise<TokenSet> {
  return tokenRequest(apiBase, {
    grant_type: "authorization_code",
    redirect_uri: config.HUBSPOT_REDIRECT_URI!,
    code,
  });
}

export function refreshTokens(refreshToken: string, apiBase: string): Promise<TokenSet> {
  return tokenRequest(apiBase, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export interface TokenInfo {
  portalId: string;
  hubDomain: string | null;
  user: string | null;
  scopes: string[];
}

/** Which portal a fresh token belongs to — the connection is keyed on it. */
export async function tokenInfo(accessToken: string, apiBase: string): Promise<TokenInfo> {
  const res = await fetch(
    new URL(`/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`, apiBase),
    { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" },
  );
  if (!res.ok) throw new HubSpotAuthError(`We could not read the HubSpot token (${res.status})`);
  const b = (await res.json()) as {
    hub_id?: number | string;
    hub_domain?: string;
    user?: string;
    scopes?: string[];
  };
  if (b.hub_id == null) throw new HubSpotAuthError("HubSpot token names no portal");
  return {
    portalId: String(b.hub_id),
    hubDomain: b.hub_domain ?? null,
    user: b.user ?? null,
    scopes: Array.isArray(b.scopes) ? b.scopes : [],
  };
}

/** Best effort: a token HubSpot already forgot is a successful disconnect. */
export async function revokeRefreshToken(refreshToken: string, apiBase: string): Promise<void> {
  try {
    const res = await fetch(
      new URL(`/oauth/v1/refresh-tokens/${encodeURIComponent(refreshToken)}`, apiBase),
      { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" },
    );
    if (!res.ok && res.status !== 404)
      log.warn("hubspot revoke refused", { event: "hubspot_revoke_refused", status: res.status });
  } catch (err) {
    log.error(err, { event: "hubspot_revoke_unreachable" });
  }
}
