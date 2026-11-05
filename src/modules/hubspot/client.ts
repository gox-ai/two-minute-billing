import { eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { isShuttingDown } from "@/platform/shutdown";
import { decryptSecret, encryptSecret } from "@/platform/secrets";
import { createLogger } from "@/platform/logger";
import { hubspotConnections } from "@db/schema";
import { HubSpotAuthError, refreshTokens } from "./oauth";

const log = createLogger("hubspot.client");

export type Connection = typeof hubspotConnections.$inferSelect;

const TIMEOUT_MS = 20_000;
/** Refresh this long before expiry, so a request never races the token's last second. */
const REFRESH_SKEW_MS = 60_000;
const MAX_429_WAITS = 3;

export class HubSpotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Worth another attempt later: 429, 5xx, a timeout. A 4xx is the request's own fault. */
    readonly retryable: boolean,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "HubSpotApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** At most `max` requests in any `ms` window. */
export class RateWindow {
  private stamps: number[] = [];
  constructor(
    private max: number,
    private ms: number,
  ) {}
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.stamps.length > 0 && this.stamps[0]! <= now - this.ms) this.stamps.shift();
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      await sleep(this.stamps[0]! + this.ms - now + 1);
    }
  }
}

/**
 * Per connection, under HubSpot's limits with headroom: search allows 5/s per account,
 * the app ~110 per 10s. Shared by every client of the connection in this process.
 * Only HubSpot's own host is paced; a local stand-in has no limits.
 */
const pacers = new Map<string, { all: RateWindow; search: RateWindow }>();

async function pace(conn: Connection, path: string): Promise<void> {
  if (!new URL(conn.apiBase).hostname.endsWith("hubapi.com")) return;
  let p = pacers.get(conn.id);
  if (!p) {
    p = { all: new RateWindow(90, 10_000), search: new RateWindow(4, 1_000) };
    pacers.set(conn.id, p);
  }
  if (/\/search(?:\?|$)/.test(path)) await p.search.take();
  await p.all.take();
}

/**
 * HubSpot's refusal of a value another record already holds in a unique property:
 * "Cannot set PropertyValueCoordinates{…, propertyName=X, …} on N. M already has that value."
 * Returns the property name, or null for any other error.
 */
export function duplicateUniqueProperty(err: unknown): string | null {
  if (!(err instanceof HubSpotApiError) || err.status !== 400) return null;
  const m = /propertyName=([^,}\s]+)[\s\S]*already has that value/.exec(err.message);
  return m?.[1] ?? null;
}

/** A sync-log note naming the properties a write had to leave out. */
export function droppedNote(dropped: string[]): string | undefined {
  if (dropped.length === 0) return undefined;
  return `Left out ${dropped.join(", ")}: another HubSpot record already holds that value in a unique property`;
}

/** HubSpot's error body: `{ status, message, category, errors: [{ message }] }`. */
function describe(body: unknown, status: number): string {
  const b = body as { message?: string; errors?: Array<{ message?: string }> } | null;
  const first = b?.errors?.find((e) => e?.message)?.message;
  return (first ?? b?.message ?? `HubSpot answered ${status}`).slice(0, 500);
}

/** One connection's authenticated API. Not shared across connections or processes. */
export class HubSpotClient {
  private accessToken: string | null;
  /** One refresh at a time: concurrent pushes share the same client. */
  private refreshing: Promise<string> | null = null;

  constructor(private conn: Connection) {
    this.accessToken = conn.accessTokenEnc ? decryptSecret(conn.accessTokenEnc) : null;
  }

  get connection(): Connection {
    return this.conn;
  }

  private async ensureToken(force = false): Promise<string> {
    const expires = this.conn.tokenExpiresAt?.getTime() ?? 0;
    if (!force && this.accessToken && expires - REFRESH_SKEW_MS > Date.now())
      return this.accessToken;
    if (!this.conn.refreshTokenEnc || this.conn.status === "disconnected")
      throw new HubSpotAuthError("HubSpot is not connected", true);
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    let tokens;
    try {
      tokens = await refreshTokens(decryptSecret(this.conn.refreshTokenEnc!), this.conn.apiBase);
    } catch (err) {
      if (err instanceof HubSpotAuthError && err.revoked) await this.markReauthRequired();
      throw err;
    }
    const [row] = await withTenant(this.conn.organizationId, (tx) =>
      tx
        .update(hubspotConnections)
        .set({
          accessTokenEnc: encryptSecret(tokens.accessToken),
          refreshTokenEnc: encryptSecret(tokens.refreshToken),
          tokenExpiresAt: tokens.expiresAt,
        })
        .where(eq(hubspotConnections.id, this.conn.id))
        .returning(),
    );
    if (row) this.conn = row;
    this.accessToken = tokens.accessToken;
    return tokens.accessToken;
  }

  private async markReauthRequired(): Promise<void> {
    log.warn("hubspot grant revoked", {
      event: "hubspot_reauth_required",
      connection: this.conn.publicId,
    });
    await withTenant(this.conn.organizationId, (tx) =>
      tx
        .update(hubspotConnections)
        .set({
          status: "reauth_required",
          lastError: "HubSpot access was revoked. Connect HubSpot again.",
        })
        .where(eq(hubspotConnections.id, this.conn.id)),
    );
  }

  /**
   * Write `properties`, leaving out any HubSpot refuses because another record already holds
   * the value in a unique property — one duplicate must not cost the record its other fields
   * or its link. Returns what was actually written and what was left out.
   */
  async writeProperties<T = unknown>(
    method: "POST" | "PATCH",
    path: string,
    properties: Record<string, string>,
  ): Promise<{ result: T | null; written: Record<string, string>; dropped: string[] }> {
    const written = { ...properties };
    const dropped: string[] = [];
    for (;;) {
      try {
        const result = await this.request<T>(method, path, { properties: written });
        return { result, written, dropped };
      } catch (err) {
        const prop = duplicateUniqueProperty(err);
        if (!prop || !(prop in written) || dropped.length >= 20) throw err;
        delete written[prop];
        dropped.push(prop);
        // Nothing left to update; a create still goes ahead with what remains.
        if (method === "PATCH" && Object.keys(written).length === 0)
          return { result: null, written, dropped };
      }
    }
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let token = await this.ensureToken();
    let refreshed = false;
    for (let waits = 0; ;) {
      let res: Response;
      await pace(this.conn, path);
      try {
        res = await fetch(new URL(path, this.conn.apiBase), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          // A 3xx is answered as an error below; following it would carry the token elsewhere.
          redirect: "manual",
        });
      } catch (err) {
        throw new HubSpotApiError(`We could not reach HubSpot: ${(err as Error).message}`, 0, true);
      }

      if (res.status === 401 && !refreshed) {
        // An access token revoked early; one refresh decides whether the grant is dead.
        refreshed = true;
        token = await this.ensureToken(true);
        continue;
      }
      // While draining, a 429 back-off would outlast the drain: hand the record back instead.
      if (res.status === 429 && waits < MAX_429_WAITS && !isShuttingDown()) {
        waits += 1;
        const after = Number(res.headers.get("retry-after"));
        await sleep(
          Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * waits, 10_000),
        );
        continue;
      }

      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (res.ok) return parsed as T;
      throw new HubSpotApiError(
        describe(parsed, res.status),
        res.status,
        res.status === 429 || res.status >= 500,
        parsed,
      );
    }
  }
}
