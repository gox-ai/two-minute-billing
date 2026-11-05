import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { config } from "@/platform/config";
import { decryptSecret, encryptSecret } from "@/platform/secrets";
import { createLogger } from "@/platform/logger";
import { writeAuditLog } from "@/modules/audit/service";
import { hubspotConnections, hubspotLinks, hubspotSyncQueue } from "@db/schema";
import {
  exchangeCode,
  hubspotEnabled,
  REQUIRED_SCOPES,
  revokeRefreshToken,
  tokenInfo,
} from "./oauth";
import type { Connection } from "./client";
import { mergeSettings, parseSettings } from "./settings";

const log = createLogger("hubspot.connections");

export class HubSpotConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubSpotConnectionError";
  }
}

export async function getConnection(
  organizationId: string,
  businessId: string,
): Promise<Connection | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(hubspotConnections)
      .where(eq(hubspotConnections.businessId, businessId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * Finish an install: trade the code for tokens, learn the portal, and store the connection.
 * Reconnecting to a DIFFERENT portal drops the old links — they name records that portal
 * does not have.
 */
export async function connectHubSpot(input: {
  organizationId: string;
  businessId: string;
  code: string;
  apiBase?: string;
}): Promise<Connection> {
  if (!hubspotEnabled())
    throw new HubSpotConnectionError("HubSpot is not configured on this deployment");
  const apiBase = input.apiBase ?? config.HUBSPOT_API_BASE;
  const tokens = await exchangeCode(input.code, apiBase);
  const info = await tokenInfo(tokens.accessToken, apiBase);

  const missing = REQUIRED_SCOPES.filter((s) => !info.scopes.includes(s));
  if (info.scopes.length > 0 && missing.length > 0) {
    await revokeRefreshToken(tokens.refreshToken, apiBase);
    throw new HubSpotConnectionError(`HubSpot did not grant: ${missing.join(", ")}`);
  }

  const values = {
    portalId: info.portalId,
    hubDomain: info.hubDomain,
    installedBy: info.user,
    scopes: info.scopes,
    accessTokenEnc: encryptSecret(tokens.accessToken),
    refreshTokenEnc: encryptSecret(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
    status: "active",
    apiBase,
    lastError: null,
    connectedAt: new Date(),
    disconnectedAt: null,
  };

  const conn = await withTenant(input.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(hubspotConnections)
      .where(eq(hubspotConnections.businessId, input.businessId))
      .limit(1);
    if (existing && existing.portalId !== info.portalId) {
      await tx.delete(hubspotLinks).where(eq(hubspotLinks.connectionId, existing.id));
      await tx.delete(hubspotSyncQueue).where(eq(hubspotSyncQueue.connectionId, existing.id));
    }
    // A new portal waits for the merchant to review settings and start the first sync; the
    // portal we already synced keeps its state.
    const initialSync =
      existing && existing.portalId === info.portalId && existing.initialSync !== "pending"
        ? existing.initialSync
        : "pending";
    const [row] = existing
      ? await tx
          .update(hubspotConnections)
          .set({ ...values, initialSync })
          .where(eq(hubspotConnections.id, existing.id))
          .returning()
      : await tx
          .insert(hubspotConnections)
          .values({
            ...values,
            initialSync,
            organizationId: input.organizationId,
            businessId: input.businessId,
            publicId: publicId("hsc"),
          })
          .returning();
    // Tokens are never recorded; the portal and the granted scopes are.
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "integration.hubspot.connect",
        resourceType: "hubspot_connection",
        resourceId: row!.publicId,
        before: existing ? { status: existing.status, portal_id: existing.portalId } : null,
        after: {
          status: row!.status,
          portal_id: row!.portalId,
          hub_domain: row!.hubDomain,
          scopes: row!.scopes,
        },
      },
      tx,
    );
    return row!;
  });
  log.info("hubspot connected", {
    event: "hubspot_connected",
    connection: conn.publicId,
    portal: conn.portalId,
  });
  return conn;
}

/**
 * Autosync and preferences. `settings` is a partial, deep-merged per section and validated
 * whole. Turning off "several customers per company" once on is refused: the links it made
 * cannot be split back apart.
 */
export async function updateConnection(
  organizationId: string,
  businessId: string,
  patch: { autosync?: boolean; settings?: unknown },
): Promise<Connection | null> {
  return withTenant(organizationId, async (tx) => {
    const set: Partial<typeof hubspotConnections.$inferInsert> = {};
    if (patch.autosync !== undefined) set.autosync = patch.autosync;
    if (patch.settings !== undefined) {
      const [row] = await tx
        .select({ settings: hubspotConnections.settings })
        .from(hubspotConnections)
        .where(eq(hubspotConnections.businessId, businessId))
        .limit(1);
      if (!row) return null;
      const current = parseSettings(row.settings);
      const merged = mergeSettings(current, patch.settings);
      if (!merged.success) {
        throw new HubSpotConnectionError(
          merged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      if (
        current.customers.multipleCustomersPerCompany &&
        !merged.data.customers.multipleCustomersPerCompany
      ) {
        throw new HubSpotConnectionError(
          "You cannot disable links from several customers to one company. To start again, disconnect HubSpot and connect it again.",
        );
      }
      if (merged.data.invoices.enabled && !merged.data.invoices.objectType) {
        throw new HubSpotConnectionError(
          "We could not enable invoice sync. No HubSpot object is selected for invoices. Select the object, then enable the sync.",
        );
      }
      set.settings = merged.data;
    }
    if (Object.keys(set).length === 0) {
      const [row] = await tx
        .select()
        .from(hubspotConnections)
        .where(eq(hubspotConnections.businessId, businessId))
        .limit(1);
      return row ?? null;
    }
    const [row] = await tx
      .update(hubspotConnections)
      .set(set)
      .where(eq(hubspotConnections.businessId, businessId))
      .returning();
    return row ?? null;
  });
}

/** Revoke at HubSpot, clear the tokens, keep links and history for a reconnect. */
export async function disconnectHubSpot(
  organizationId: string,
  businessId: string,
): Promise<Connection | null> {
  const conn = await getConnection(organizationId, businessId);
  if (!conn || conn.status === "disconnected") return conn;
  if (conn.refreshTokenEnc)
    await revokeRefreshToken(decryptSecret(conn.refreshTokenEnc), conn.apiBase);
  return withTenant(organizationId, async (tx) => {
    await tx.delete(hubspotSyncQueue).where(eq(hubspotSyncQueue.connectionId, conn.id));
    const [row] = await tx
      .update(hubspotConnections)
      .set({
        status: "disconnected",
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
        disconnectedAt: new Date(),
      })
      .where(eq(hubspotConnections.id, conn.id))
      .returning();
    if (row) {
      await writeAuditLog(
        {
          organizationId,
          businessId,
          action: "integration.hubspot.disconnect",
          resourceType: "hubspot_connection",
          resourceId: row.publicId,
          before: { status: conn.status, portal_id: conn.portalId },
          after: { status: row.status, portal_id: row.portalId },
        },
        tx,
      );
    }
    return row ?? null;
  });
}

/**
 * Leave `pending`: the merchant has reviewed the settings. Returns null unless this call made
 * the transition, so a double click queues one first sync.
 */
export async function startFirstSync(
  organizationId: string,
  businessId: string,
): Promise<Connection | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .update(hubspotConnections)
      .set({ initialSync: "queued" })
      .where(
        and(
          eq(hubspotConnections.businessId, businessId),
          eq(hubspotConnections.status, "active"),
          eq(hubspotConnections.initialSync, "pending"),
        ),
      )
      .returning();
    return row ?? null;
  });
}
