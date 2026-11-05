import { eq, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { hubspotConnections } from "@db/schema";
import type { Connection } from "../client";

export class HubSpotAppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "hubspot_app_error",
  ) {
    super(message);
    this.name = "HubSpotAppError";
  }
}

/** HubSpot object type (id, singular or plural, any case) → the `hubspot_links.remote_type` it links as. */
export function remoteTypeOf(
  objectType: string | undefined | null,
): "contact" | "company" | "deal" | null {
  switch ((objectType ?? "").trim().toLowerCase()) {
    case "0-1":
    case "contact":
    case "contacts":
      return "contact";
    case "0-2":
    case "company":
    case "companies":
      return "company";
    case "0-3":
    case "deal":
    case "deals":
      return "deal";
    default:
      return null;
  }
}

/**
 * The connection a HubSpot request is for. Several businesses may share one portal: the one
 * whose links hold the record wins; otherwise the portal's only active connection; otherwise
 * the request is ambiguous and refused.
 *
 * Cross-tenant by nature (a portal id is all HubSpot tells us), so it reads through the raw
 * `db` — two narrow selects of ids — and loads the winner under its own tenant.
 */
export async function resolvePortalConnection(
  portalId: string | number | undefined | null,
  record?: { remoteType: string; remoteId: string } | null,
): Promise<Connection> {
  const portal = portalId == null ? "" : String(portalId).trim();
  if (!/^\d+$/.test(portal))
    throw new HubSpotAppError("Missing HubSpot portal id", 400, "missing_portal");

  const candidates = (await systemDb.execute(sql`
    SELECT organization_id, id FROM hubspot_connections
    WHERE portal_id = ${portal} AND status = 'active'
  `)) as unknown as Array<{ organization_id: string; id: string }>;
  if (candidates.length === 0)
    throw new HubSpotAppError(
      "This HubSpot portal is not connected to Two Minute Billing",
      404,
      "portal_not_connected",
    );

  let pick = candidates.length === 1 ? candidates[0]! : null;
  if (candidates.length > 1 && record) {
    const owners = (await systemDb.execute(sql`
      SELECT DISTINCT connection_id FROM hubspot_links
      WHERE connection_id IN (${sql.join(
        candidates.map((c) => sql`${c.id}::uuid`),
        sql`, `,
      )})
        AND remote_type = ${record.remoteType} AND remote_id = ${record.remoteId}
    `)) as unknown as Array<{ connection_id: string }>;
    if (owners.length === 1)
      pick = candidates.find((c) => c.id === owners[0]!.connection_id) ?? null;
  }
  if (!pick)
    throw new HubSpotAppError(
      "Several businesses are connected to this HubSpot portal and none has this record linked yet. Sync the record from the business it belongs to first.",
      409,
      "ambiguous_portal",
    );

  const conn = await withTenant(pick.organization_id, async (tx) => {
    const [row] = await tx
      .select()
      .from(hubspotConnections)
      .where(eq(hubspotConnections.id, pick.id))
      .limit(1);
    return row ?? null;
  });
  if (!conn || conn.status !== "active")
    throw new HubSpotAppError(
      "This HubSpot portal is not connected to Two Minute Billing",
      404,
      "portal_not_connected",
    );
  return conn;
}
