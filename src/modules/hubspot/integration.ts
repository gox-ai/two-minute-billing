import { hubspotInfo } from "@/modules/integrations/providers/hubspot-info";
import type { SyncIntegration } from "@/modules/integrations/types";
import { getConnection } from "./connections";
import { queueHubSpotSync } from "./sink";

/** HubSpot as seen by the integrations module: its event hook and its directory status. */
export const hubspotIntegration: SyncIntegration = {
  info: hubspotInfo,
  onEvent: queueHubSpotSync,
  async status(organizationId, businessId) {
    const conn = await getConnection(organizationId, businessId);
    if (!conn || conn.status === "disconnected") return { status: "not_connected", summary: null };
    if (conn.status === "reauth_required") return { status: "reauth_required", summary: null };
    return { status: "active", summary: conn.hubDomain ?? `Hub ${conn.portalId}` };
  },
};
