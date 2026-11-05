import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { encryptCredentials } from "@/platform/secrets";
import { assertPublicUrl, OutboundTargetError } from "@/platform/outbound";
import { integrationConnections } from "@db/schema";
import { pushIntegration } from "./registry";
import type { PushIntegration } from "./types";

export type IntegrationConnection = typeof integrationConnections.$inferSelect;

/** A connect/update the operator can fix by changing what they sent. Routes map it to a 400. */
export class IntegrationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationValidationError";
  }
}

function requirePush(key: string): PushIntegration {
  const integration = pushIntegration(key);
  if (!integration) throw new IntegrationValidationError(`No such push integration: ${key}`);
  return integration;
}

/**
 * EVERY declared credential, not one: a partner that needs a key AND an account id collects a
 * 401 per event when either is missing. A replace is wholesale — the envelope is one value.
 */
function checkCredentials(integration: PushIntegration, creds: Record<string, unknown>): void {
  const missing = integration.connect.credentials
    .filter((c) => typeof creds[c.key] !== "string" || (creds[c.key] as string).trim() === "")
    .map((c) => c.label);
  if (missing.length) {
    throw new IntegrationValidationError(`${integration.label} needs ${missing.join(" and ")}`);
  }
}

/** Only the declared settings are kept; a blank one is dropped so the default applies. */
function cleanConfig(integration: PushIntegration, config: Record<string, unknown> | undefined) {
  const allowed = new Set((integration.connect.fields ?? []).map((f) => f.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config ?? {})) {
    if (!allowed.has(k)) throw new IntegrationValidationError(`Unknown setting: ${k}`);
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  return out;
}

export async function getIntegrationConnection(
  organizationId: string,
  businessId: string,
  provider: string,
): Promise<IntegrationConnection | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.businessId, businessId),
          eq(integrationConnections.provider, provider),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function listIntegrationConnections(
  organizationId: string,
  businessId: string,
): Promise<IntegrationConnection[]> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.businessId, businessId)),
  );
}

/**
 * Connect (or reconnect) a business to a push integration. One row per business and provider:
 * reconnecting reuses the disconnected row, so its delivery history stays attached.
 */
export async function connectIntegration(input: {
  organizationId: string;
  business: { id: string; livemode: string };
  provider: string;
  credentials: Record<string, unknown>;
  config?: Record<string, unknown>;
}): Promise<IntegrationConnection> {
  const integration = requirePush(input.provider);
  checkCredentials(integration, input.credentials);
  const config = cleanConfig(integration, input.config);
  const apiBase = integration.connect.defaultUrl;
  try {
    await assertPublicUrl(apiBase);
  } catch (e) {
    if (e instanceof OutboundTargetError)
      throw new IntegrationValidationError("The partner address is not a public URL");
    throw e;
  }
  return withTenant(input.organizationId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.businessId, input.business.id),
          eq(integrationConnections.provider, integration.key),
        ),
      )
      .limit(1)
      .for("update");
    if (existing?.status === "active") {
      throw new IntegrationValidationError(`${integration.label} is already connected`);
    }
    const values = {
      status: "active",
      enabled: true,
      credentialsEnc: encryptCredentials(input.credentials),
      config,
      connectedAt: new Date(),
      disconnectedAt: null,
      updatedAt: new Date(),
    };
    if (existing) {
      const [row] = await tx
        .update(integrationConnections)
        .set(values)
        .where(eq(integrationConnections.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await tx
      .insert(integrationConnections)
      .values({
        ...values,
        organizationId: input.organizationId,
        businessId: input.business.id,
        publicId: publicId("icn"),
        provider: integration.key,
        livemode: input.business.livemode,
        apiBase,
      })
      .returning();
    return row!;
  });
}

/** Pause/resume, replace the credentials (all of them), or change settings. */
export async function updateIntegration(
  organizationId: string,
  businessId: string,
  provider: string,
  patch: {
    enabled?: boolean;
    credentials?: Record<string, unknown>;
    config?: Record<string, unknown>;
  },
): Promise<IntegrationConnection | null> {
  const integration = requirePush(provider);
  if (patch.credentials) checkCredentials(integration, patch.credentials);
  const config = patch.config !== undefined ? cleanConfig(integration, patch.config) : undefined;
  return withTenant(organizationId, async (tx) => {
    const set: Partial<typeof integrationConnections.$inferInsert> = { updatedAt: new Date() };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.credentials) set.credentialsEnc = encryptCredentials(patch.credentials);
    if (config !== undefined) set.config = config;
    const [row] = await tx
      .update(integrationConnections)
      .set(set)
      .where(
        and(
          eq(integrationConnections.businessId, businessId),
          eq(integrationConnections.provider, provider),
          eq(integrationConnections.status, "active"),
        ),
      )
      .returning();
    return row ?? null;
  });
}

/**
 * Disconnect: credentials cleared, row and history kept. Pending deliveries are settled
 * `skipped`, because nothing can send them without credentials.
 */
export async function disconnectIntegration(
  organizationId: string,
  businessId: string,
  provider: string,
): Promise<IntegrationConnection | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .update(integrationConnections)
      .set({
        status: "disconnected",
        credentialsEnc: null,
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(integrationConnections.businessId, businessId),
          eq(integrationConnections.provider, provider),
          eq(integrationConnections.status, "active"),
        ),
      )
      .returning();
    if (row) {
      await tx.execute(sql`
        update integration_deliveries set status = 'skipped', last_error = 'The integration was disconnected'
        where connection_id = ${row.id} and status = 'pending'`);
    }
    return row ?? null;
  });
}
