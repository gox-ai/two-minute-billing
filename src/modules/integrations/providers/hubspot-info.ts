import type { IntegrationInfo } from "../types";

/** HubSpot's directory entry. The sync itself lives in `modules/hubspot`. */
export const hubspotInfo: IntegrationInfo = {
  key: "hubspot",
  label: "HubSpot",
  kind: "sync",
  category: "crm",
  blurb:
    "Sync customers, subscriptions and products in both directions. Show billing data on HubSpot records.",
  icon: { monogram: "HS", src: "/logos/hubspot.svg" },
  connect: { method: "oauth" },
};
